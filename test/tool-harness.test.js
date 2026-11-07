import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createHarness,
  scopeFor,
  deriveScope,
  writeRefusal,
  validateInput,
  auditInput,
  summarizeAudit,
  ROLES,
  TOOLS,
} from '../src/harness/index.js';
import { resolveInside } from '../src/harness/sandbox.js';
import { globToRegExp } from '../src/harness/tools.js';
import { handleMessage, serve } from '../src/harness/mcp-server.js';
import { runPipeline } from '../src/pipeline/runner.js';
import { mockExecutor, harnessArgs } from '../src/pipeline/executors.js';
import { STAGES } from '../src/pipeline/stages.js';
import { fixtureRepo, tmp } from './helpers.js';

const repo = () => {
  const { dir, git } = fixtureRepo();
  mkdirSync(path.join(dir, 'docs', 'specs', 'x'), { recursive: true });
  return { dir, git, audit: path.join(dir, '.factory', 'runs', '20261106-000000-abcd', 'harness.jsonl') };
};

test('sandbox: refuses absolute paths, NUL, .. escapes and symlink escapes', () => {
  const { dir } = repo();
  assert.equal(resolveInside(dir, 'src/index.js').rel, 'src/index.js');
  assert.equal(resolveInside(dir, 'src/../src/index.js').rel, 'src/index.js');
  for (const bad of ['/etc/passwd', '../outside', 'src/../../x', 'a\0b', 'C:\\x', ''])
    assert.throws(() => resolveInside(dir, bad), { code: 'SANDBOX' }, JSON.stringify(bad));
  const outside = tmp('sf-out-');
  writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  symlinkSync(outside, path.join(dir, 'link'));
  assert.throws(() => resolveInside(dir, 'link/secret.txt'), /outside the repository/);
  assert.throws(
    () => resolveInside(dir, 'link/new-file.txt'),
    /outside the repository/,
    'not-yet-existing file under an escaping link',
  );
});

test('scopes: every role is defined, decision is read-only, inspector never writes', () => {
  for (const role of Object.keys(ROLES)) assert.ok(scopeFor(role, { artifactDir: 'docs/specs/x' }).capabilities.includes('read'));
  assert.deepEqual(scopeFor('decision').capabilities, ['read', 'git-read']);
  assert.ok(!scopeFor('inspector').capabilities.includes('write'));
  assert.deepEqual(scopeFor('author', { artifactDir: 'docs/specs/x' }).writeRoots, ['docs/specs/x']);
  assert.throws(() => scopeFor('root'), /unknown harness role/);
});

test('writeRefusal: roots, protected paths and factory state', () => {
  const author = scopeFor('author', { artifactDir: 'docs/specs/x' });
  assert.equal(writeRefusal(author, 'docs/specs/x/SPEC.md'), null);
  assert.match(writeRefusal(author, 'src/index.js'), /may only write under: docs\/specs\/x/);
  assert.match(writeRefusal(author, 'docs/specs/xy/SPEC.md'), /may only write under/, 'prefix must be a whole segment');
  const impl = scopeFor('implementer');
  assert.equal(writeRefusal(impl, 'src/new.js'), null);
  assert.match(writeRefusal(impl, '.env'), /env files/);
  assert.match(writeRefusal(impl, '.git/config'), /factory state|\.git/);
  assert.match(writeRefusal(impl, '.factory/runs/x/run.json'), /factory state/);
  assert.match(writeRefusal(impl, '.factory/improvements/audit.jsonl'), /factory state/);
  assert.match(writeRefusal(scopeFor('decision'), 'docs/a.md'), /cannot write/);
  assert.equal(writeRefusal(scopeFor('steward'), '.factory/improvements/p-1.json'), null);
  assert.match(writeRefusal(scopeFor('steward'), 'src/pipeline/gates.js'), /may only write under/);
});

test('deriveScope: a sub-agent never exceeds its parent', () => {
  const parent = scopeFor('author', { artifactDir: 'docs/specs/x' });
  const child = deriveScope(parent, {
    capabilities: ['read', 'write', 'exec', 'git-write'],
    writeRoots: ['docs/specs/x/notes', 'src'],
  });
  assert.deepEqual(child.capabilities, ['read', 'write']);
  assert.deepEqual(child.writeRoots, ['docs/specs/x/notes']);
  assert.deepEqual(deriveScope(parent, { writeRoots: null }).writeRoots, ['docs/specs/x'], 'cannot widen to anywhere');
  const impl = scopeFor('implementer');
  assert.deepEqual(
    deriveScope(impl, { writeRoots: ['src'] }).writeRoots,
    ['src'],
    'a child of an unrestricted parent can be narrowed',
  );
  assert.deepEqual(deriveScope(scopeFor('decision'), { capabilities: ['write'] }).capabilities, []);
});

test('validateInput: required, types, bounds, unknown fields', () => {
  const t = (n) => TOOLS.find((x) => x.name === n).inputSchema;
  assert.equal(validateInput(t('read_file'), { path: 'a' }), null);
  assert.match(validateInput(t('read_file'), {}), /path is required/);
  assert.match(validateInput(t('read_file'), { path: 1 }), /must be a string/);
  assert.match(validateInput(t('read_file'), { path: 'a', limit: 0 }), /below/);
  assert.match(validateInput(t('read_file'), { path: 'a', extra: true }), /not a known field/);
  assert.match(validateInput(t('run_command'), { name: 'rm -rf /' }), /invalid format/);
  assert.match(validateInput(t('git_commit'), { message: 'feat: x', paths: [] }), /at least 1/);
  assert.match(validateInput(t('read_file'), null), /must be an object/);
});

test('glob matching', () => {
  assert.ok(globToRegExp('src/**/*.js').test('src/a/b/c.js'));
  assert.ok(globToRegExp('src/**/*.js').test('src/c.js'));
  assert.ok(!globToRegExp('*.js').test('src/c.js'));
  assert.ok(globToRegExp('docs/?.md').test('docs/a.md'));
});

test('read, list, search, write and edit work inside scope and are audited', async () => {
  const { dir, audit } = repo();
  const h = createHarness({ root: dir, role: 'implementer', auditFile: audit });
  assert.match((await h.call('read_file', { path: 'src/index.js' })).text, /^1\texport const x = 1;/);
  assert.match((await h.call('list_files', { pattern: 'src/**' })).text, /src\/index\.js/);
  assert.match((await h.call('search', { pattern: 'const x' })).text, /src\/index\.js:1:/);
  assert.equal((await h.call('search', { pattern: '(' })).ok, false, 'bad regex is an error, not a crash');
  assert.ok((await h.call('write_file', { path: 'src/new/a.js', content: 'export const a = 1;\n' })).ok);
  assert.ok((await h.call('edit_file', { path: 'src/new/a.js', old: 'a = 1', new: 'a = 2' })).ok);
  assert.equal(readFileSync(path.join(dir, 'src/new/a.js'), 'utf8'), 'export const a = 2;\n');
  const dup = await h.call('write_file', { path: 'src/d.js', content: 'x x' });
  assert.ok(dup.ok);
  assert.match((await h.call('edit_file', { path: 'src/d.js', old: 'x', new: 'y' })).text, /occurs 2 times/);
  assert.ok((await h.call('edit_file', { path: 'src/d.js', old: 'x', new: 'y', replaceAll: true })).ok);
  const sum = summarizeAudit(audit);
  assert.equal(sum.calls, 9);
  assert.equal(sum.byTool.write_file, 2);
  const lines = readFileSync(audit, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const w = lines.find((l) => l.tool === 'write_file');
  assert.match(w.input.content, /^<\d+ bytes sha1:[0-9a-f]{12}>$/, 'content is hashed, not logged');
  assert.equal(w.role, 'implementer');
});

test('refusals: wrong capability, out-of-scope write, protected path, unknown tool — all audited as refused', async () => {
  const { dir, audit } = repo();
  const d = createHarness({ root: dir, role: 'decision', auditFile: audit });
  assert.deepEqual(
    d.tools.map((t) => t.name),
    ['read_file', 'list_files', 'search', 'git_status', 'git_diff', 'git_log'],
    'decision lists read tools only',
  );
  assert.match((await d.call('write_file', { path: 'x.md', content: 'x' })).text, /may not use write_file/);
  assert.match((await d.call('run_command', { name: 'test' })).text, /may not use run_command/);
  const a = createHarness({ root: dir, role: 'author', artifactDir: 'docs/specs/x', auditFile: audit });
  assert.match((await a.call('write_file', { path: 'src/evil.js', content: 'x' })).text, /may only write under/);
  assert.ok(!existsSync(path.join(dir, 'src/evil.js')));
  const i = createHarness({ root: dir, role: 'implementer', auditFile: audit });
  assert.match((await i.call('write_file', { path: '.env', content: 'K=v' })).text, /env files/);
  assert.match((await i.call('write_file', { path: '../escape.txt', content: 'x' })).text, /leaves the repository/);
  assert.match((await i.call('nope', {})).text, /unknown tool/);
  const sum = summarizeAudit(audit);
  assert.equal(sum.refused, 6);
  assert.equal(sum.refusedBy['decision:write_file'], 1);
  assert.equal(sum.refusedBy['author:write_file'], 1);
});

test('run_command runs only named factory.json commands from the allow list', async () => {
  const { dir } = repo();
  const commands = { test: 'node -e "console.log(42)"', deploy: 'node -e "process.exit(3)"' };
  const h = createHarness({ root: dir, role: 'inspector', commands, exec: ['test'] });
  const r = await h.call('run_command', { name: 'test' });
  assert.ok(r.ok);
  assert.match(r.text, /exit 0\n[\s\S]*42/);
  assert.match((await h.call('run_command', { name: 'deploy' })).text, /not exec-able/);
  assert.match(
    (await createHarness({ root: dir, role: 'inspector', commands, exec: ['lint'] }).call('run_command', { name: 'test' })).text,
    /not exec-able/,
  );
  assert.match(
    (await createHarness({ root: dir, role: 'inspector', commands: {}, exec: ['test'] }).call('run_command', { name: 'test' }))
      .text,
    /no "test" command/,
  );
});

test('git tools: status, diff, log, and commit only the listed paths', async () => {
  const { dir, git } = repo();
  const h = createHarness({ root: dir, role: 'implementer' });
  assert.equal((await h.call('git_status')).text, '(clean)');
  writeFileSync(path.join(dir, 'src/index.js'), 'export const x = 2;\n');
  writeFileSync(path.join(dir, 'other.txt'), 'leave me\n');
  assert.match((await h.call('git_diff')).text, /-export const x = 1;\n\+export const x = 2;/);
  assert.match((await h.call('git_diff', { base: '--output=/tmp/x' })).text, /not a ref name/);
  assert.match(
    (await h.call('git_commit', { message: 'feat: x', paths: ['src/index.js'] })).text,
    /may not use git_commit/,
    'implementer has no git-write',
  );
  const s = createHarness({ root: dir, role: 'shipper' });
  assert.match((await s.call('git_commit', { message: 'feat: bump x', paths: ['src/index.js'] })).text, /feat: bump x/);
  assert.match(git('status', '--porcelain'), /\?\? other\.txt/, 'unlisted files stay uncommitted');
  assert.match((await h.call('git_log', { n: 2 })).text, /feat: bump x/);
});

test('auditInput hashes content and redacts secrets', () => {
  const key = 'sk-ant-api03-' + 'a'.repeat(90);
  const out = auditInput({ path: 'a.md', content: 'hello', message: `token ${key}`, n: 3 });
  assert.match(out.content, /^<5 bytes sha1:/);
  assert.doesNotMatch(JSON.stringify(out), /aaaaaaaaaa/);
  assert.equal(out.n, 3);
  assert.equal(out.path, 'a.md');
});

test('MCP server: initialize, tools/list scoped to role, tools/call, errors', async () => {
  const { dir } = repo();
  const h = createHarness({ root: dir, role: 'decision' });
  const init = await handleMessage(h, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await handleMessage(h, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handleMessage(h, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.every((t) => t.inputSchema.type === 'object'));
  assert.ok(!list.result.tools.some((t) => t.name === 'write_file'));
  const call = await handleMessage(h, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: 'src/index.js' } },
  });
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /export const x/);
  const denied = await handleMessage(h, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'write_file', arguments: { path: 'a', content: 'b' } },
  });
  assert.equal(denied.result.isError, true);
  assert.equal((await handleMessage(h, { jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
  assert.equal((await handleMessage(h, { id: 6 })).error.code, -32600);
});

test('MCP server over a stream: answers in order, survives bad JSON', async () => {
  const { dir } = repo();
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => (out += d));
  const done = serve(createHarness({ root: dir, role: 'decision' }), { input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n');
  input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await done;
  const msgs = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    msgs.map((m) => m.id),
    [1, null, 2],
  );
  assert.equal(msgs[1].error.code, -32700);
});

test('MCP server process starts from its config file and serves a real call', async () => {
  const { dir } = repo();
  const stage = STAGES.find((s) => s.id === 'review');
  const cfg = {
    root: dir,
    role: 'reviewer',
    artifactDir: 'docs/specs/x',
    commands: {},
    exec: [],
    auditFile: path.join(dir, '.factory', 'a.jsonl'),
  };
  const { args, tools } = await harnessArgs(dir, stage, cfg);
  assert.equal(args[0], '--mcp-config');
  assert.ok(tools.includes('mcp__factory__write_file') && tools.includes('mcp__factory__run_command'));
  assert.ok(!tools.includes('mcp__factory__git_commit'), 'reviewer cannot commit');
  const mcp = JSON.parse(readFileSync(args[1], 'utf8')).mcpServers.factory;
  const { spawn } = await import('node:child_process');
  const child = spawn(mcp.command, mcp.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'docs/specs/x/REVIEW.md', content: 'ok' } } })}\n`,
  );
  await new Promise((r) => child.on('close', r));
  assert.equal(JSON.parse(out).result.isError, false);
  assert.equal(readFileSync(path.join(dir, 'docs/specs/x/REVIEW.md'), 'utf8'), 'ok');
  assert.equal(summarizeAudit(cfg.auditFile).calls, 1);
});

test('pipeline: mock runs write through the harness and record per-attempt counts', async () => {
  const { dir } = fixtureRepo();
  const state = await runPipeline({ dir, request: '# Harness demo\n\nA small change.', executor: mockExecutor() });
  assert.equal(state.status, 'passed', state.error);
  const byStage = Object.fromEntries(
    state.stages.filter((s) => s.attempts[0]?.harness).map((s) => [s.id, s.attempts[0].harness]),
  );
  assert.deepEqual(byStage.spec, { role: 'author', calls: 1, refused: 0 });
  assert.deepEqual(byStage.build, { role: 'implementer', calls: 2, refused: 0 });
  assert.equal(byStage.review.role, 'reviewer');
  const audit = summarizeAudit(path.join(dir, '.factory', 'runs', state.id, 'harness.jsonl'));
  assert.equal(audit.calls, 5, 'spec, plan, two build files, review');
  assert.equal(audit.refused, 0);
});

test('pipeline: a stage that writes outside its scope is refused by the harness', async () => {
  const { dir } = fixtureRepo();
  const executor = mockExecutor({
    script: {
      async spec(ctx) {
        const r = await ctx.harness.call('write_file', { path: 'src/sneaky.js', content: 'x' });
        assert.equal(r.ok, false);
        await ctx.harness.call('write_file', { path: ctx.rel(ctx.artifacts.spec), content: '# nope' });
      },
    },
  });
  const state = await runPipeline({ dir, request: '# Scope demo\n\nTry to escape.', executor, stages: ['spec'], maxAttempts: 1 });
  assert.ok(!existsSync(path.join(dir, 'src', 'sneaky.js')));
  assert.equal(state.stages[0].attempts[0].harness.refused, 1);
});

test(
  'claude executor passes --mcp-config and the role-scoped harness tools',
  { skip: process.platform === 'win32' },
  async () => {
    const { dir } = repo();
    const argvFile = path.join(tmp(), 'argv.txt');
    process.env.FAKE_ARGV_FILE = argvFile;
    const { claudeExecutor } = await import('../src/pipeline/executors.js');
    const bin = path.join(import.meta.dirname, 'fixtures', 'fake-claude-argv.sh');
    const harnessConfig = { root: dir, role: 'author', artifactDir: 'docs/specs/x', commands: {}, exec: [], auditFile: null };
    const stage = STAGES.find((s) => s.id === 'spec');
    try {
      await claudeExecutor({ bin }).run({ stage, prompt: 'x', dir, ctx: { harnessConfig } });
      const argv = readFileSync(argvFile, 'utf8').split('\n');
      const allowed = argv[argv.indexOf('--allowedTools') + 1].split(',');
      assert.ok(argv.includes('--mcp-config'));
      assert.ok(allowed.includes('Read'), 'built-in tools stay allowed');
      assert.ok(allowed.includes('mcp__factory__write_file'));
      assert.ok(!allowed.includes('mcp__factory__run_command'), 'author has no exec');
      await claudeExecutor({ bin }).run({ stage: { ...stage, harnessOnly: true }, prompt: 'x', dir, ctx: { harnessConfig } });
      const only = readFileSync(argvFile, 'utf8').split('\n');
      assert.ok(only[only.indexOf('--allowedTools') + 1].split(',').every((t) => t.startsWith('mcp__factory__')));
      await claudeExecutor({ bin, stageModels: { spec: 'model-z' }, model: 'model-a' }).run({ stage, prompt: 'x', dir });
      assert.match(readFileSync(argvFile, 'utf8'), /--model\nmodel-z/, 'per-stage model wins');
      assert.ok(!readFileSync(argvFile, 'utf8').includes('--mcp-config'), 'no harness config, no MCP');
    } finally {
      delete process.env.FAKE_ARGV_FILE;
    }
  },
);
