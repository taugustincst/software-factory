import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHarness, scopeFor, summarizeAudit } from '../src/harness/index.js';
import { executorSpawner } from '../src/harness/spawn.js';
import { runPipeline } from '../src/pipeline/runner.js';
import { mockExecutor, harnessArgs } from '../src/pipeline/executors.js';
import { STAGES } from '../src/pipeline/stages.js';
import { fixtureRepo, tmp } from './helpers.js';

const POSIX = process.platform !== 'win32';

/** A repo with a local bare origin, and a fake `gh` that records its argv and body file. */
function shippableRepo() {
  const r = fixtureRepo();
  const remote = tmp('sf-remote-');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  r.git('remote', 'add', 'origin', remote);
  const bin = tmp('sf-bin-');
  const gh = path.join(bin, 'gh');
  const record = path.join(bin, 'gh-calls.txt');
  writeFileSync(
    gh,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${record}"\nwhile [ $# -gt 0 ]; do if [ "$1" = "--body-file" ]; then cat "$2" > "${record}.body"; fi; shift; done\n` +
      `echo "https://github.com/acme/widgets/pull/42"\n`,
  );
  chmodSync(gh, 0o755);
  return { ...r, remote, gh, record };
}

test('git_push: shipper only, factory/ branches only, to origin', { skip: !POSIX }, async () => {
  const { dir, git, remote } = shippableRepo();
  git('switch', '-q', '-c', 'factory/add-x-abcd');
  const s = createHarness({ root: dir, role: 'shipper' });
  assert.deepEqual((await s.call('git_push', { branch: 'factory/add-x-abcd' })).ok, true);
  assert.match(execFileSync('git', ['--git-dir', remote, 'branch', '--list'], { encoding: 'utf8' }), /factory\/add-x-abcd/);
  for (const bad of ['main', 'release/1.0', '--force', 'factory/../main', 'factory/'])
    assert.match((await s.call('git_push', { branch: bad })).text, /only factory\/ branches/, bad);
  assert.match(
    (await createHarness({ root: dir, role: 'implementer' }).call('git_push', { branch: 'factory/add-x-abcd' })).text,
    /may not use git_push/,
  );
});

test('open_pr: body by file, factory/ head only, URL returned, failures surfaced', { skip: !POSIX }, async () => {
  const { dir, gh, record } = shippableRepo();
  const s = createHarness({ root: dir, role: 'shipper', ghBin: gh });
  const r = await s.call('open_pr', {
    title: 'feat: add x',
    body: '## Summary\nbody text',
    head: 'factory/add-x-abcd',
    draft: true,
  });
  assert.equal(r.text, 'https://github.com/acme/widgets/pull/42');
  const argv = readFileSync(record, 'utf8');
  assert.match(argv, /^pr\ncreate\n--title\nfeat: add x\n--body-file\n/);
  assert.match(argv, /--head\nfactory\/add-x-abcd\n--draft\n/);
  assert.equal(readFileSync(`${record}.body`, 'utf8'), '## Summary\nbody text', 'the body travels by file');
  assert.match((await s.call('open_pr', { title: 'feat: x', body: 'b', head: 'main' })).text, /only from factory\/ branches/);
  assert.match(
    (await s.call('open_pr', { title: 'feat: x', body: 'b', head: 'factory/x', base: '--repo=evil/x' })).text,
    /not a branch name/,
  );
  const failing = path.join(tmp(), 'gh');
  writeFileSync(failing, '#!/bin/sh\necho "auth required" >&2\nexit 4\n');
  chmodSync(failing, 0o755);
  assert.match(
    (
      await createHarness({ root: dir, role: 'shipper', ghBin: failing }).call('open_pr', {
        title: 'feat: x',
        body: 'b',
        head: 'factory/x',
      })
    ).text,
    /exit 4[\s\S]*auth required/,
  );
  const quiet = path.join(tmp(), 'gh');
  writeFileSync(quiet, '#!/bin/sh\necho ok\n');
  chmodSync(quiet, 0o755);
  assert.match(
    (
      await createHarness({ root: dir, role: 'shipper', ghBin: quiet }).call('open_pr', {
        title: 'feat: x',
        body: 'b',
        head: 'factory/x',
      })
    ).text,
    /no PR URL/,
  );
});

test('ship stage pushes and opens the PR through the shipper harness, audited', { skip: !POSIX }, async () => {
  const { dir, gh, remote } = shippableRepo();
  const state = await runPipeline({
    dir,
    request: '# Add CSV export\n\nVisits as CSV.',
    executor: mockExecutor(),
    ship: true,
    ghBin: gh,
  });
  assert.equal(state.status, 'passed', state.error);
  assert.equal(state.prUrl, 'https://github.com/acme/widgets/pull/42');
  assert.match(
    execFileSync('git', ['--git-dir', remote, 'branch', '--list'], { encoding: 'utf8' }),
    new RegExp(state.branch.replace('/', '\\/')),
  );
  const lines = readFileSync(path.join(dir, '.factory', 'runs', state.id, 'harness.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const ship = lines.filter((l) => l.role === 'shipper');
  assert.deepEqual(
    ship.map((l) => [l.tool, l.ok]),
    [
      ['git_push', true],
      ['open_pr', true],
    ],
  );
  assert.match(ship[1].input.body, /^<\d+ bytes sha1:/, 'the PR body is hashed in the audit, not logged');
});

test('spawn_subagent: narrowed scope, budget slice, spend counted toward the run', async () => {
  const { dir } = fixtureRepo();
  let childScope = null;
  const executor = mockExecutor({
    costPerAttempt: 1,
    script: {
      async build(ctx) {
        const r = await ctx.harness.call('spawn_subagent', {
          task: 'Write the helper module for the CSV export.',
          capabilities: ['read', 'write', 'exec', 'git-write', 'pr'],
          writeRoots: ['src/csv', 'docs'],
          budgetUsd: 0.6,
        });
        assert.equal(r.ok, true, r.text);
        assert.match(r.text, /sub-agent finished \(role implementer\/sub, \$0\.25\)/);
        await ctx.harness.call('write_file', { path: 'factory-mock/CHANGE.md', content: 'x\n' });
        await ctx.harness.call('write_file', { path: 'factory-mock/change.test.md', content: 'x\n' });
      },
      async subagent(ctx) {
        childScope = ctx.harness.scope;
        assert.equal(
          (await ctx.harness.call('write_file', { path: 'src/csv/helper.js', content: 'export const csv = 1;\n' })).ok,
          true,
        );
        assert.equal(
          (await ctx.harness.call('write_file', { path: 'src/other.js', content: 'x' })).ok,
          false,
          'outside its narrowed roots',
        );
        return { summary: 'wrote src/csv/helper.js', costUsd: 0.25 };
      },
    },
  });
  const state = await runPipeline({ dir, request: '# Add CSV export\n\nVisits as CSV.', executor });
  assert.equal(state.status, 'passed', state.error);
  assert.equal(childScope.role, 'implementer/sub');
  assert.deepEqual(childScope.capabilities, ['read', 'write', 'exec'], 'git-write and pr are not the parent’s to give');
  assert.deepEqual(childScope.writeRoots, ['src/csv', 'docs']);
  assert.ok(existsSync(path.join(dir, 'src/csv/helper.js')));
  const build = state.stages.find((s) => s.id === 'build').attempts[0];
  assert.equal(build.harness.subagentUsd, 0.25);
  assert.equal(build.costUsd, 1.25, 'parent $1 + sub-agent $0.25');
  const audit = summarizeAudit(path.join(dir, '.factory', 'runs', state.id, 'harness.jsonl'));
  assert.equal(audit.byTool.spawn_subagent, 1);
  assert.equal(audit.refusedBy['implementer/sub:write_file'], 1);
});

test('spawn_subagent refusals: no spawner, depth limit, budget, read-only roles, narrow-only roots', async () => {
  const { dir } = fixtureRepo();
  const task = 'Look at the module and report back.';
  assert.match(
    (await createHarness({ root: dir, role: 'implementer', budgetUsd: 1 }).call('spawn_subagent', { task })).text,
    /not available/,
  );
  const fake = async () => ({ ok: true, summary: 'ok', costUsd: 0.4 });
  const deep = createHarness({ root: dir, role: 'implementer', spawner: fake, depth: 2, budgetUsd: 1 });
  assert.match((await deep.call('spawn_subagent', { task })).text, /nest only 2 level/);
  const broke = createHarness({ root: dir, role: 'implementer', spawner: fake, budgetUsd: 0 });
  assert.match((await broke.call('spawn_subagent', { task })).text, /no sub-agent budget/);
  const h = createHarness({ root: dir, role: 'implementer', spawner: fake, budgetUsd: 0.5 });
  assert.ok((await h.call('spawn_subagent', { task })).ok);
  assert.ok((await h.call('spawn_subagent', { task })).ok, 'the second slice comes from what is left');
  assert.match((await h.call('spawn_subagent', { task })).text, /no sub-agent budget/, '$0.80 spent of $0.50: stop');
  for (const role of ['decision', 'inspector', 'generative', 'steward', 'shipper'])
    assert.ok(!createHarness({ root: dir, role }).tools.some((t) => t.name === 'spawn_subagent'), role);
  let got;
  const author = createHarness({
    root: dir,
    role: 'author',
    artifactDir: 'docs/specs/x',
    spawner: async (a) => ((got = a), { ok: true, costUsd: 0 }),
    budgetUsd: 1,
  });
  await author.call('spawn_subagent', { task, writeRoots: ['src', 'docs/specs/x/notes'] });
  assert.deepEqual(got.scope.writeRoots, ['docs/specs/x/notes'], 'a child cannot reach outside its parent’s roots');
  assert.equal(got.depth, 1);
  assert.equal(got.budgetUsd, 0.5, 'default slice is half of what remains');
});

test('executorSpawner: the child runs harness-only on the same executor, and grandchildren get less', async () => {
  const { dir } = fixtureRepo();
  const seen = [];
  const executor = mockExecutor({
    script: {
      async subagent(ctx, n) {
        seen.push({
          depth: ctx.harnessConfig.depth,
          budget: ctx.harnessConfig.budgetUsd,
          tools: ctx.harness.tools.map((t) => t.name),
        });
        if (ctx.harnessConfig.depth === 1) await ctx.harness.call('spawn_subagent', { task: 'Nested task, check one file.' });
        void n;
        return { summary: `depth ${ctx.harnessConfig.depth} done`, costUsd: 0.1 };
      },
    },
  });
  const base = { root: dir, role: 'implementer', commands: {}, exec: [], budgetUsd: 2 };
  const spawner = executorSpawner({ executor, dir, baseConfig: base });
  const r = await spawner({ scope: scopeFor('implementer'), task: 'Top-level subtask, please.', budgetUsd: 1, depth: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(
    seen.map((s) => [s.depth, s.budget]),
    [
      [1, 0.5],
      [2, 0.125],
    ],
  );
  assert.ok(!seen[1].tools.includes('spawn_subagent'), 'the deepest level cannot spawn again');
});

test('harness.only makes chosen stages harness-only', async () => {
  const { dir, git } = fixtureRepo();
  const file = path.join(dir, 'factory.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), harness: { only: ['spec', 'review'] } }));
  git('commit', '-qam', 'harness only');
  const seenStages = [];
  const executor = mockExecutor();
  const wrapped = { name: 'mock', run: (a) => (seenStages.push([a.stage.id, Boolean(a.stage.harnessOnly)]), executor.run(a)) };
  const state = await runPipeline({ dir, request: '# Harness only\n\nx', executor: wrapped });
  assert.equal(state.status, 'passed', state.error);
  const m = Object.fromEntries(seenStages);
  assert.equal(m.spec, true);
  assert.equal(m.review, true);
  assert.equal(m.build, false);
  assert.equal(state.stages.find((s) => s.id === 'spec').attempts[0].harnessOnly, true);
});

test('MCP server: a Claude Code stage can spawn a sub-agent as its own harness-only claude -p', { skip: !POSIX }, async () => {
  const { dir } = fixtureRepo();
  mkdirSync(path.join(dir, 'docs', 'specs', 'x'), { recursive: true });
  const argvFile = path.join(tmp(), 'argv.txt');
  const fakeClaude = path.join(import.meta.dirname, 'fixtures', 'fake-claude-argv.sh');
  const cfg = {
    root: dir,
    role: 'implementer',
    commands: {},
    exec: [],
    auditFile: path.join(dir, '.factory', 'a.jsonl'),
    budgetUsd: 1,
    spawn: { executor: 'claude', bin: fakeClaude },
  };
  const { args } = await harnessArgs(
    dir,
    STAGES.find((s) => s.id === 'build'),
    cfg,
  );
  const mcp = JSON.parse(readFileSync(args[1], 'utf8')).mcpServers.factory;
  const child = spawn(mcp.command, mcp.args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, FAKE_ARGV_FILE: argvFile },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spawn_subagent', arguments: { task: 'Write one test file for the parser.', writeRoots: ['test'] } } })}\n`,
  );
  await new Promise((r) => child.on('close', r));
  const res = JSON.parse(out).result;
  assert.equal(res.isError, false, res.content[0].text);
  assert.match(res.content[0].text, /sub-agent finished \(role implementer\/sub, \$0\.01\)\nDone\./);
  const argv = readFileSync(argvFile, 'utf8').split('\n');
  const allowed = argv[argv.indexOf('--allowedTools') + 1].split(',');
  assert.ok(allowed.length > 0 && allowed.every((t) => t.startsWith('mcp__factory__')), 'the sub-agent is harness-only');
  assert.ok(argv.includes('--mcp-config'));
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '0.5');
  assert.equal(summarizeAudit(cfg.auditFile).costUsd, 0.01);
});
