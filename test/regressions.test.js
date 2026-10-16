// Regression tests for issues found in the independent pre-release review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runPipeline, shipRun } from '../src/pipeline/runner.js';
import { mockExecutor } from '../src/pipeline/executors.js';
import { gates, gatePassed, changedFiles, VERDICT_RE } from '../src/pipeline/gates.js';
import { scaffold } from '../src/scaffold.js';
import { fixtureRepo, tmp } from './helpers.js';

const REQUEST = '# Add export\n\nExport visits.';

function monorepo() {
  const { dir, git } = fixtureRepo();
  const pkg = path.join(dir, 'packages', 'api');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'factory.json'), JSON.stringify({ commands: { test: 'node -e 0' } }));
  writeFileSync(path.join(pkg, 'index.js'), 'export {};\n');
  git('add', '-A');
  git('commit', '-qm', 'pkg');
  return { root: dir, pkg, git };
}

test('changedFiles is relative to --dir in a monorepo and handles non-ASCII names', async () => {
  const { pkg } = monorepo();
  writeFileSync(path.join(pkg, 'café.js'), 'x');
  writeFileSync(path.join(pkg, '..', '..', 'outside.js'), 'x');
  assert.deepEqual(await changedFiles(pkg), ['café.js']);
});

test('secret scan finds secrets in subfolder runs and non-ASCII files', async () => {
  const { pkg } = monorepo();
  const executor = mockExecutor({
    script: {
      async build() {
        writeFileSync(path.join(pkg, 'café.js'), 'const password = "Sup3rS3cretValue!";\n');
      },
    },
  });
  const state = await runPipeline({ dir: pkg, request: REQUEST, executor, maxReviewLoops: 0 });
  assert.equal(state.status, 'failed');
  const gate = state.stages.find((s) => s.id === 'review').attempts.at(-1).gate;
  assert.match(gate.find((c) => /secrets/.test(c.name)).detail, /café\.js: generic-assigned-secret/);
});

test('a no-op build fails in a subfolder run, and .factory/ is never committed', async () => {
  const { pkg, git } = monorepo();
  const noop = await runPipeline({
    dir: pkg,
    request: REQUEST,
    executor: mockExecutor({ script: { async build() {} } }),
    maxAttempts: 1,
  });
  assert.equal(noop.status, 'failed');
  assert.ok(noop.stages.find((s) => s.id === 'build').attempts[0].gate.some((c) => c.name === 'source changes' && !c.ok));

  git('checkout', '-q', '--', '.');
  git('clean', '-qfd');
  const ok = await runPipeline({ dir: pkg, request: '# Second change\n\nok', executor: mockExecutor() });
  assert.equal(ok.status, 'passed', ok.error);
  const committed = git('show', '--name-only', '--format=', 'HEAD');
  assert.doesNotMatch(committed, /\.factory/);
  assert.match(committed, /packages\/api\/factory-mock\/CHANGE\.md/);
});

test('runs work inside a git worktree', async () => {
  const { dir } = fixtureRepo();
  const wt = path.join(tmp(), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', wt], { cwd: dir });
  const state = await runPipeline({ dir: wt, request: REQUEST, executor: mockExecutor() });
  assert.equal(state.status, 'passed', state.error);
});

test('a stale REVIEW.md from an earlier run does not pass the gate', async () => {
  const { dir } = fixtureRepo();
  const artifactDir = path.join(dir, 'docs', 'specs', 'old');
  mkdirSync(artifactDir, { recursive: true });
  const review = path.join(artifactDir, 'REVIEW.md');
  writeFileSync(review, 'Verdict: APPROVE\n');
  utimesSync(review, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const ctx = {
    dir,
    artifactDir,
    artifacts: { review },
    project: { commands: { test: 'node -e 0' } },
    rel: (p) => path.relative(dir, p),
    attemptStartedMs: Date.now(),
  };
  const checks = await gates.review(ctx);
  assert.ok(!gatePassed(checks));
  assert.ok(checks.some((c) => /written in this attempt/.test(c.name) && !c.ok));
});

test('the unedited template verdict line is not an approval', () => {
  assert.equal('Verdict: APPROVE | REQUEST_CHANGES'.match(VERDICT_RE), null);
  assert.equal('Verdict: APPROVE'.match(VERDICT_RE)[1], 'APPROVE');
  assert.equal('**Verdict:** REQUEST_CHANGES'.match(VERDICT_RE)[1], 'REQUEST_CHANGES');
});

test('read-only stages may not modify source files', async () => {
  const { dir } = fixtureRepo();
  const executor = mockExecutor({
    script: {
      async spec(ctx) {
        await mockExecutor().run({ stage: { id: 'spec', agent: 'spec-writer' }, ctx });
        writeFileSync(path.join(dir, 'src', 'index.js'), 'export const x = 2; // sneaky\n');
      },
    },
  });
  const state = await runPipeline({ dir, request: REQUEST, executor, stages: ['spec'], maxAttempts: 1 });
  assert.equal(state.status, 'failed');
  const c = state.stages[0].attempts[0].gate.find((x) => x.name === 'only spec-folder files changed');
  assert.equal(c.ok, false);
  assert.match(c.detail, /src\/index\.js/);
});

test('refuses a dirty tree; with allowDirty commits only what the run changed', async () => {
  const { dir, git } = fixtureRepo();
  writeFileSync(path.join(dir, 'src', 'wip.js'), 'my unfinished work\n');
  const refused = await runPipeline({ dir, request: REQUEST, executor: mockExecutor() });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /uncommitted/);

  const ok = await runPipeline({ dir, request: '# Another\n\nok', executor: mockExecutor(), allowDirty: true });
  assert.equal(ok.status, 'passed', ok.error);
  const committed = git('show', '--name-only', '--format=', 'HEAD');
  assert.doesNotMatch(committed, /wip\.js/);
  assert.match(git('status', '--porcelain'), /wip\.js/);
});

test('plan coverage only counts the Tasks section', async () => {
  const dir = tmp();
  const artifactDir = path.join(dir, 's');
  mkdirSync(artifactDir);
  const spec = path.join(artifactDir, 'SPEC.md');
  const plan = path.join(artifactDir, 'PLAN.md');
  writeFileSync(spec, '## Acceptance Criteria\n- [ ] AC1: a\n- [ ] AC2: b\n');
  writeFileSync(plan, '## Tasks\n- [ ] T1 — covers: AC1\n\n## Test Strategy\nx\n\n## Risks\n- AC2 might be hard\n');
  const checks = await gates.plan({ dir, artifactDir, artifacts: { spec, plan }, rel: (p) => path.relative(dir, p) });
  assert.match(checks.find((c) => /covered/.test(c.name)).detail, /AC2/);
});

test('two runs with the same title on the same day get separate spec folders', async () => {
  const { dir, git } = fixtureRepo();
  const a = await runPipeline({ dir, request: REQUEST, executor: mockExecutor(), stages: ['spec'], commit: false });
  git('add', '-A');
  git('commit', '-qm', 'a');
  const b = await runPipeline({ dir, request: REQUEST, executor: mockExecutor(), stages: ['spec'], commit: false });
  assert.notEqual(a.artifactDir, b.artifactDir);
});

test('shipRun commits a run that passed with --no-commit, and refuses failed runs', async () => {
  const { dir, git } = fixtureRepo();
  const state = await runPipeline({ dir, request: REQUEST, executor: mockExecutor(), commit: false });
  assert.equal(state.status, 'passed');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  const shipped = await shipRun({ dir, runId: state.id, push: false });
  assert.equal(shipped.status, 'passed', shipped.error);
  assert.match(git('rev-parse', '--abbrev-ref', 'HEAD'), /^factory\//);

  const bad = fixtureRepo({ commands: { test: 'node -e "process.exit(1)"' } });
  const failed = await runPipeline({ dir: bad.dir, request: REQUEST, executor: mockExecutor(), maxAttempts: 1 });
  await assert.rejects(shipRun({ dir: bad.dir, runId: failed.id }), /only passed runs/);
});

test('scaffold rejects descriptions and owners that would break generated files', async () => {
  const base = { template: 'static-html', name: 'demo-app', install: false, git: false };
  await assert.rejects(scaffold({ ...base, dir: tmp(), description: 'Visit "export" API' }), /description/);
  await assert.rejects(scaffold({ ...base, dir: tmp(), description: 'a <script>' }), /description/);
  await assert.rejects(scaffold({ ...base, dir: tmp(), owner: 'bad owner\n* @evil' }), /owner/);
  await scaffold({ ...base, dir: tmp(), owner: 'my-org/platform-team', description: "Clinic's visit export (v2)" });
});
