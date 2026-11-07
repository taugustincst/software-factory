import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveProviders, parseRoute, chainFor, checkBaseUrl } from '../src/providers/config.js';
import { apiExecutor, priceOf } from '../src/providers/api.js';
import { routedExecutor, providerReport } from '../src/providers/router.js';
import { runPipeline } from '../src/pipeline/runner.js';
import { STAGES } from '../src/pipeline/stages.js';
import { createHarness, summarizeAudit } from '../src/harness/index.js';
import { buildEvidence } from '../src/improve/evidence.js';
import { fixtureRepo } from './helpers.js';

const SPEC_MD = (title) =>
  `# ${title}\n\n## Problem\nx\n\n## Users\nDevelopers.\n\n## Requirements\n- R1: The change is implemented.\n\n` +
  `## Acceptance Criteria\n- [ ] AC1 (R1): Given the app, when used, then it works.\n\n## Non-Functional\nNone.\n\n## Out of Scope\nNone.\n\n## Open Questions\nNone.\n`;

/**
 * A fake LLM server speaking both wire formats. Behaviour by model name:
 *   good   writes the spec the prompt asks for, then finishes
 *   weak   writes an incomplete spec (fails the gate), then finishes
 *   rogue  tries to write outside its scope, then finishes
 *   broken returns HTTP 400
 */
const seen = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const b = JSON.parse(body);
  seen.push({ url: req.url, headers: req.headers, body: b });
  const anthropic = req.url === '/v1/messages';
  const msgs = b.messages;
  const firstUser = anthropic ? msgs[0].content : msgs.find((m) => m.role === 'user').content;
  const specPath = String(firstUser).match(/Save it to `([^`]+SPEC\.md)`/)?.[1] ?? 'docs/specs/x/SPEC.md';
  const followUp = anthropic ? msgs.length > 1 : msgs.some((m) => m.role === 'tool');
  const send = (o, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (b.model === 'broken') return send({ error: 'bad request' }, 400);
  if (b.model === 'down') return send({ error: 'overloaded' }, 503);
  const call =
    b.model === 'rogue'
      ? { name: 'write_file', args: { path: 'src/evil.js', content: 'x' } }
      : { name: 'write_file', args: { path: specPath, content: b.model === 'weak' ? '# nope\n' : SPEC_MD('Fake spec') } };
  if (anthropic) {
    if (followUp)
      return send({
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 100 },
      });
    return send({
      content: [
        { type: 'text', text: 'Writing the spec.' },
        { type: 'tool_use', id: 'tu_1', name: call.name, input: call.args },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 2000, output_tokens: 300 },
    });
  }
  if (followUp)
    return send({
      choices: [{ message: { role: 'assistant', content: 'Done.' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    });
  return send({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 2000, completion_tokens: 300 },
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const BASE = `http://127.0.0.1:${server.address().port}`;

const providers = {
  fake: { type: 'openai', baseUrl: `${BASE}`, apiKeyEnv: 'FAKE_KEY', price: { input: 3, output: 15 } },
  fakeant: { type: 'anthropic', baseUrl: BASE, apiKeyEnv: 'FAKE_KEY' },
  dead: { type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKeyEnv: null },
  nokey: { type: 'openai', baseUrl: BASE, apiKeyEnv: 'NOT_SET_ANYWHERE_KEY' },
};
const ENV = { FAKE_KEY: 'test-key-123' };

function repoWith(config) {
  const r = fixtureRepo();
  const file = path.join(r.dir, 'factory.json');
  const cfg = { ...JSON.parse(readFileSync(file, 'utf8')), ...config };
  writeFileSync(file, JSON.stringify(cfg));
  r.git('commit', '-qam', 'config');
  return { ...r, cfg };
}

test('config: presets, overrides, validation, route parsing and precedence', () => {
  const d = resolveProviders({});
  assert.equal(d.configured, false);
  assert.deepEqual(
    d.routing.default.map((r) => r.route),
    ['claude'],
    'default stays Claude Code',
  );
  for (const n of ['claude', 'anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'ollama', 'mock'])
    assert.ok(d.providers[n], n);
  const c = resolveProviders({
    providers: {
      openai: { price: { input: 2, output: 8 } },
      corp: { type: 'openai', baseUrl: 'https://llm.corp.example/v1/', apiKeyEnv: 'CORP_KEY' },
      leaky: { type: 'openai', baseUrl: 'https://x.example', apiKey: 'sk-literal' },
      plain: { type: 'openai', baseUrl: 'http://llm.example' },
      BadName: { type: 'openai' },
      weird: { type: 'carrier-pigeon' },
    },
    routing: {
      default: ['claude', 'openai:gpt-4.1'],
      stages: { spec: ['corp:m1', 'nobody:x'] },
      roles: { decision: ['ollama:llama3.1:8b'] },
      escalateOnRetry: true,
    },
  });
  assert.deepEqual(c.providers.openai.price, { input: 2, output: 8 });
  assert.equal(c.providers.corp.baseUrl, 'https://llm.corp.example/v1');
  assert.equal(c.providers.leaky.apiKey, undefined, 'a literal key is never kept');
  assert.ok(!c.providers.plain, 'plain http to a remote host is refused');
  assert.ok(c.warnings.some((w) => /keys never go in factory\.json/.test(w)));
  assert.ok(c.warnings.some((w) => /unknown provider "nobody"/.test(w)));
  assert.equal(c.warnings.length, 5);
  assert.deepEqual(parseRoute('ollama:llama3.1:8b'), { provider: 'ollama', model: 'llama3.1:8b', route: 'ollama:llama3.1:8b' });
  assert.equal(parseRoute('Not A Route'), null);
  const spec = STAGES.find((s) => s.id === 'spec');
  assert.deepEqual(
    chainFor(c.routing, spec, 'author').map((r) => r.route),
    ['corp:m1'],
  );
  assert.deepEqual(
    chainFor(c.routing, { id: 'decide' }, 'decision').map((r) => r.route),
    ['ollama:llama3.1:8b'],
  );
  assert.deepEqual(
    chainFor(c.routing, { id: 'build' }, 'implementer').map((r) => r.route),
    ['claude', 'openai:gpt-4.1'],
  );
  assert.equal(c.routing.escalateOnRetry, true);
  assert.equal(checkBaseUrl('http://localhost:11434/v1'), null);
  assert.match(checkBaseUrl('https://user:pw@x.example'), /credentials/);
});

test('pricing: USD per million tokens, null when unpriced', () => {
  assert.equal(priceOf({ price: { input: 3, output: 15 } }, { input: 1_000_000, output: 100_000 }), 4.5);
  assert.equal(priceOf({}, { input: 5, output: 5 }), null);
});

test('an OpenAI-compatible model does a pipeline stage through the harness', async () => {
  const { dir } = repoWith({ providers, routing: { default: ['mock'], stages: { spec: ['fake:good'] } } });
  const executor = routedExecutor({ config: JSON.parse(readFileSync(path.join(dir, 'factory.json'), 'utf8')), env: ENV });
  const state = await runPipeline({ dir, request: '# Add CSV export\n\nVisits as CSV.', executor });
  assert.equal(state.status, 'passed', state.error);
  const spec = state.stages.find((s) => s.id === 'spec').attempts[0];
  assert.equal(spec.provider, 'fake');
  assert.equal(spec.model, 'good');
  assert.equal(spec.costUsd, (3000 * 3 + 400 * 15) / 1e6, 'priced from reported usage');
  assert.equal(spec.harness.calls, 1, 'the model wrote the spec through the harness');
  assert.equal(state.stages.find((s) => s.id === 'build').attempts[0].provider, 'mock', 'other stages use their own route');
  const req = seen.find((s) => s.url === '/chat/completions' && s.body.model === 'good');
  assert.equal(req.headers.authorization, 'Bearer test-key-123');
  assert.ok(req.body.tools.some((t) => t.function.name === 'write_file'));
  assert.ok(!req.body.tools.some((t) => t.function.name === 'run_command'), 'the author role has no exec tool');
  const ev = buildEvidence([state]);
  assert.ok(ev.facts['cost-provider:fake'].value > 0);
  assert.equal(ev.facts['provider-runs:mock'].value, 1);
});

test('an Anthropic Messages model works the same way', async () => {
  const { dir } = fixtureRepo();
  const harness = createHarness({ root: dir, role: 'author', artifactDir: 'docs/specs/x' });
  const ex = apiExecutor({ provider: { name: 'fakeant', ...providers.fakeant }, model: 'good', env: ENV });
  const stage = STAGES.find((s) => s.id === 'spec');
  const r = await ex.run({ stage, prompt: 'Save it to `docs/specs/x/SPEC.md` please', dir, ctx: { harness } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.summary, 'Done.');
  assert.ok(existsSync(path.join(dir, 'docs/specs/x/SPEC.md')));
  assert.equal(r.unpriced, true);
  const calls = seen.filter((s) => s.url === '/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'test-key-123');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.ok(calls[0].body.tools.every((t) => t.input_schema?.type === 'object'));
  const toolResult = calls[1].body.messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'tu_1');
  assert.equal(toolResult.is_error, false);
});

test('scope still holds for other LLMs: a model writing outside its role is refused', async () => {
  const { dir } = fixtureRepo();
  const audit = path.join(dir, '.factory', 'a.jsonl');
  const harness = createHarness({ root: dir, role: 'author', artifactDir: 'docs/specs/x', auditFile: audit });
  const ex = apiExecutor({ provider: { name: 'fake', ...providers.fake }, model: 'rogue', env: ENV });
  const r = await ex.run({ stage: STAGES[0], prompt: 'x', dir, ctx: { harness } });
  assert.equal(r.ok, true, 'the model finished; its bad call was refused');
  assert.ok(!existsSync(path.join(dir, 'src/evil.js')));
  assert.equal(summarizeAudit(audit).refusedBy['author:write_file'], 1);
  const back = seen
    .filter((s) => s.body.model === 'rogue')
    .at(-1)
    .body.messages.find((m) => m.role === 'tool');
  assert.match(back.content, /may only write under/, 'the refusal is returned to the model');
});

test('fallback: an unreachable, unkeyed or overloaded provider is skipped before any work', async () => {
  const { dir } = repoWith({
    providers,
    routing: { default: ['mock'], stages: { spec: ['nokey:x', 'dead:x', 'fake:down', 'fake:good'] } },
  });
  const executor = routedExecutor({ config: JSON.parse(readFileSync(path.join(dir, 'factory.json'), 'utf8')), env: ENV });
  const state = await runPipeline({ dir, request: '# Fallback demo\n\nx', executor, stages: ['spec'] });
  assert.equal(state.status, 'passed', state.error);
  const a = state.stages[0].attempts[0];
  assert.equal(a.provider, 'fake');
  assert.equal(a.skipped.length, 3);
  assert.match(a.skipped[0], /NOT_SET_ANYWHERE_KEY is not set/);
  assert.match(a.skipped[1], /network error/);
  assert.match(a.skipped[2], /HTTP 503/);
  assert.equal(buildEvidence([state]).facts['provider-fallbacks'].value, 3);
});

test('no silent fallback on a real error, and a clear error when nothing is available', async () => {
  const { dir } = fixtureRepo();
  const cfg = { providers, routing: { default: ['fake:broken', 'fake:good'] } };
  const ex = routedExecutor({ config: cfg, env: ENV });
  const harness = createHarness({ root: dir, role: 'author', artifactDir: 'docs/specs/x' });
  const r = await ex.run({ stage: STAGES[0], prompt: 'x', dir, ctx: { harness } });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 400/);
  assert.equal(r.provider, 'fake');
  const none = routedExecutor({ config: { providers, routing: { default: ['nokey:x', 'dead:x'] } }, env: {} });
  const r2 = await none.run({ stage: STAGES[0], prompt: 'x', dir, ctx: { harness } });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /no provider available for spec/);
});

test('escalateOnRetry: a retry after a failed gate moves down the chain', async () => {
  const { dir } = repoWith({
    providers,
    routing: { default: ['mock'], stages: { spec: ['fake:weak', 'fake:good'] }, escalateOnRetry: true },
  });
  const executor = routedExecutor({ config: JSON.parse(readFileSync(path.join(dir, 'factory.json'), 'utf8')), env: ENV });
  const state = await runPipeline({ dir, request: '# Escalation demo\n\nx', executor, stages: ['spec'] });
  assert.equal(state.status, 'passed', state.error);
  const [a1, a2] = state.stages[0].attempts;
  assert.equal(a1.model, 'weak');
  assert.equal(a1.ok, false);
  assert.equal(a2.model, 'good');
  assert.equal(a2.ok, true);
});

test('--provider override and the spend cap', async () => {
  const { dir } = fixtureRepo();
  assert.throws(() => routedExecutor({ config: {}, override: 'Bad Route' }), /not "<provider>"/);
  assert.throws(() => routedExecutor({ config: {}, override: 'nobody:x' }), /unknown provider/);
  const ex = routedExecutor({ config: { providers }, override: 'fake:good', env: ENV });
  assert.deepEqual(
    ex.chain(STAGES[2]).map((r) => r.route),
    ['fake:good'],
  );
  const pricey = { name: 'fake', ...providers.fake, price: { input: 100000, output: 100000 } };
  const harness = createHarness({ root: dir, role: 'author', artifactDir: 'docs/specs/x' });
  const r = await apiExecutor({ provider: pricey, model: 'good', env: ENV }).run({
    stage: STAGES[0],
    prompt: 'Save it to `docs/specs/x/SPEC.md`',
    dir,
    ctx: { harness },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /stage spend cap reached/);
  const noModel = apiExecutor({ provider: { name: 'fake', ...providers.fake }, env: ENV });
  assert.match(noModel.available(), /no model named/);
});

test('providers report: availability by key presence and CLI', async () => {
  const r = await providerReport({ config: { providers }, env: ENV, whichImpl: async () => null });
  const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
  assert.equal(by.claude.available, false, 'no Claude Code CLI');
  assert.equal(by.fake.available, true);
  assert.equal(by.fake.key, 'FAKE_KEY set');
  assert.equal(by.nokey.available, false);
  assert.equal(by.ollama.key, 'none needed');
  assert.equal(by.fake.priced, true);
});
