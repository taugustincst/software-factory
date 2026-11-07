import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyProvider, verifyProviders, routedModels } from '../src/providers/verify.js';
import { resolveProviders } from '../src/providers/config.js';

const seen = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
  const send = (o, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? '';
  if (!String(auth).includes('good-key')) return send({ error: 'invalid key' }, 401);
  if (req.method === 'GET' && (req.url === '/models' || req.url === '/v1/models'))
    return send({ data: [{ id: 'm-tools' }, { id: 'm-chatty' }] });
  const b = JSON.parse(body);
  if (req.url === '/chat/completions') {
    if (b.model === 'm-chatty') return send({ choices: [{ message: { role: 'assistant', content: 'pong!' } }] });
    return send({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"ok":true}' } }],
          },
        },
      ],
    });
  }
  if (req.url === '/v1/messages') return send({ content: [{ type: 'tool_use', id: 't1', name: 'ping', input: { ok: true } }] });
  return send({ error: 'not found' }, 404);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const BASE = `http://127.0.0.1:${server.address().port}`;
const P = (extra) => ({ name: 'fake', type: 'openai', baseUrl: BASE, apiKeyEnv: 'FAKE_KEY', ...extra });

test('free check: endpoint, key, routed models', async () => {
  const r = await verifyProvider(P(), { env: { FAKE_KEY: 'good-key' }, models: ['m-tools', 'm-missing'] });
  assert.equal(r.status, 'failed', 'a routed model that is not listed fails the check');
  assert.deepEqual(
    r.checks.map((c) => [c.name, c.ok]),
    [
      ['endpoint and key', true],
      ['model m-tools', true],
      ['model m-missing', false],
    ],
  );
  assert.equal(seen.at(-1).headers.authorization, 'Bearer good-key');
  const ok = await verifyProvider(P(), { env: { FAKE_KEY: 'good-key' }, models: ['m-tools'] });
  assert.equal(ok.status, 'ok');
});

test('missing key is skipped with exactly what is needed; a refused key fails', async () => {
  const r = await verifyProvider(P(), { env: {} });
  assert.equal(r.status, 'skipped');
  assert.equal(r.needs, 'FAKE_KEY exported in the environment');
  const bad = await verifyProvider(P(), { env: { FAKE_KEY: 'wrong' } });
  assert.equal(bad.status, 'failed');
  assert.match(bad.checks[0].detail, /key was refused/);
  const down = await verifyProvider(P({ baseUrl: 'http://127.0.0.1:9' }), { env: { FAKE_KEY: 'good-key' } });
  assert.match(down.checks[0].detail, /unreachable/);
});

test('deep check: the model must actually call the tool', async () => {
  const env = { FAKE_KEY: 'good-key' };
  const yes = await verifyProvider(P(), { env, models: ['m-tools'], deep: true });
  assert.equal(yes.status, 'ok');
  const call = seen.find((s) => s.url === '/chat/completions' && s.body.model === 'm-tools');
  assert.deepEqual(call.body.tool_choice, { type: 'function', function: { name: 'ping' } });
  assert.equal(call.body.max_tokens, 64, 'a few tokens, not a run');
  const no = await verifyProvider(P(), { env, models: ['m-chatty'], deep: true });
  assert.equal(no.status, 'failed');
  assert.match(no.checks.at(-1).detail, /without calling the tool/);
  const ant = await verifyProvider(
    { name: 'fa', type: 'anthropic', baseUrl: BASE, apiKeyEnv: 'FAKE_KEY' },
    { env, models: ['m-tools'], deep: true },
  );
  assert.equal(ant.status, 'ok');
  const antCall = seen.find((s) => s.url === '/v1/messages');
  assert.equal(antCall.headers['x-api-key'], 'good-key');
  assert.equal(antCall.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(antCall.body.tool_choice, { type: 'tool', name: 'ping' });
});

test('claude-code and mock providers', async () => {
  const none = await verifyProvider({ name: 'claude', type: 'claude-code' }, { whichImpl: async () => null });
  assert.equal(none.status, 'skipped');
  assert.match(none.needs, /Claude Code CLI/);
  const runs = [];
  const runImpl = async (argv) => {
    runs.push(argv);
    if (argv[1] === '--version') return { code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ is_error: false, result: 'ok', total_cost_usd: 0.11 }), stderr: '' };
  };
  const deep = await verifyProvider(
    { name: 'claude', type: 'claude-code' },
    { whichImpl: async () => '/usr/bin/claude', runImpl, deep: true, models: ['m-x'] },
  );
  assert.equal(deep.status, 'ok');
  assert.match(deep.checks[1].detail, /replied "ok" \(\$0\.1100\)/);
  assert.deepEqual(runs[1].slice(runs[1].indexOf('--max-budget-usd'), runs[1].indexOf('--max-budget-usd') + 4), [
    '--max-budget-usd',
    '0.5',
    '--model',
    'm-x',
  ]);
  const capped = await verifyProvider(
    { name: 'claude', type: 'claude-code' },
    {
      whichImpl: async () => 'x',
      deep: true,
      runImpl: async (a) =>
        a[1] === '--version'
          ? { code: 0, stdout: 'v', stderr: '' }
          : { code: 1, stdout: JSON.stringify({ is_error: true, errors: ['Reached maximum budget'] }), stderr: '' },
    },
  );
  assert.equal(capped.checks[1].detail, 'Reached maximum budget');
  assert.equal((await verifyProvider({ name: 'mock', type: 'mock' })).status, 'ok');
});

test('verifyProviders: routed and keyed providers, the needs list, and the exit signal', async () => {
  const config = {
    providers: { fake: { type: 'openai', baseUrl: BASE, apiKeyEnv: 'FAKE_KEY' } },
    routing: { default: ['mock'], stages: { spec: ['fake:m-tools', 'openai:gpt-x'] } },
  };
  assert.deepEqual(routedModels(resolveProviders(config).routing), { mock: [], fake: ['m-tools'], openai: ['gpt-x'] });
  const v = await verifyProviders({ config, env: { FAKE_KEY: 'good-key' }, whichImpl: async () => null });
  assert.deepEqual(v.results.map((r) => [r.name, r.status]).sort(), [
    ['fake', 'ok'],
    ['mock', 'ok'],
    ['openai', 'skipped'],
  ]);
  assert.deepEqual(v.needs, [{ provider: 'openai', routed: true, needs: 'OPENAI_API_KEY exported in the environment' }]);
  assert.equal(v.ok, true, 'skipped is not failed');
  const bad = await verifyProviders({ config, env: { FAKE_KEY: 'wrong' }, whichImpl: async () => null });
  assert.equal(bad.ok, false);
  await assert.rejects(verifyProviders({ config, only: 'nobody' }), /unknown provider/);
  const all = await verifyProviders({ config: {}, env: {}, all: true, whichImpl: async () => null });
  assert.ok(all.results.length >= 8);
});

test('model families: routing.roles.generative / .decision cover the whole pipeline', async () => {
  const { chainFor } = await import('../src/providers/config.js');
  const { STAGES } = await import('../src/pipeline/stages.js');
  const { STAGE_ROLES } = await import('../src/harness/index.js');
  const { routing } = resolveProviders({
    routing: {
      default: ['claude'],
      roles: { generative: ['openai:gpt-x', 'claude'], decision: ['anthropic:judge'], reviewer: ['claude'] },
      stages: { test: ['mock'] },
    },
  });
  const route = (id, role) =>
    chainFor(routing, STAGES.find((s) => s.id === id) ?? { id }, role ?? STAGE_ROLES[id]).map((r) => r.route);
  assert.deepEqual(route('spec'), ['openai:gpt-x', 'claude'], 'author → generative');
  assert.deepEqual(route('build'), ['openai:gpt-x', 'claude'], 'implementer → generative');
  assert.deepEqual(route('test'), ['mock'], 'a stage route wins');
  assert.deepEqual(route('review'), ['claude'], 'an exact role route wins over the family');
  assert.deepEqual(route('inspect'), ['anthropic:judge'], 'inspector → decision');
  assert.deepEqual(route('decide'), ['anthropic:judge']);
  assert.deepEqual(route('subagent', 'implementer/sub'), ['openai:gpt-x', 'claude'], 'a sub-agent follows its parent’s family');
  assert.deepEqual(route('ship', 'shipper'), ['claude'], 'roles outside both families use the default');
});
