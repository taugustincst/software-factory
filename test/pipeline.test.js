import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runPipeline, titleFromRequest, liveRunLock } from '../src/pipeline/runner.js';
import { run as procRun } from '../src/util.js';
import { mockExecutor } from '../src/pipeline/executors.js';
import { listRuns, readRun } from '../src/pipeline/store.js';
import { fixtureRepo } from './helpers.js';

const REQUEST = '# Add CSV export\n\nFront desk needs to export visits as CSV.';

test('titleFromRequest uses the first heading or line', () => {
  assert.equal(titleFromRequest('# Add CSV export\n\nbody'), 'Add CSV export');
  assert.equal(titleFromRequest('\n\nfix the login bug please'), 'fix the login bug please');
  assert.equal(titleFromRequest('- add a footer\n- small'), 'add a footer');
});

test('happy path: every stage passes and the change is committed on a feature branch', async () => {
  const { dir, git } = fixtureRepo();
  const state = await runPipeline({ dir, request: REQUEST, executor: mockExecutor() });
  assert.equal(state.status, 'passed', state.error);
  assert.deepEqual(
    state.stages.map((s) => s.status),
    ['passed', 'passed', 'passed', 'passed', 'passed', 'passed'],
  );
  assert.match(state.branch, /^factory\/add-csv-export-[a-f0-9]{4}$/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), state.branch);
  assert.match(git('log', '-1', '--format=%s'), /^feat: add CSV export/);
  assert.ok(existsSync(path.join(dir, state.artifactDir, 'SPEC.md')));
  assert.equal(git('status', '--porcelain').trim(), '', 'run state is excluded from git and everything else committed');
  const saved = await readRun(dir, state.id);
  assert.equal(saved.status, 'passed');
  assert.equal((await listRuns(dir)).length, 1);
});

test('a failing gate feeds its failures back to the agent and retries', async () => {
  const { dir } = fixtureRepo();
  const prompts = [];
  const base = mockExecutor();
  const executor = {
    name: 'scripted',
    async run(args) {
      prompts.push({ stage: args.stage.id, prompt: args.prompt });
      if (args.stage.id === 'spec' && prompts.filter((p) => p.stage === 'spec').length === 1) {
        mkdirSync(path.dirname(args.ctx.artifacts.spec), { recursive: true });
        writeFileSync(args.ctx.artifacts.spec, '# Incomplete\n\n## Problem\nx\n');
        return { ok: true, summary: 'wrote a thin spec', costUsd: 0.01 };
      }
      return base.run(args);
    },
  };
  const state = await runPipeline({ dir, request: REQUEST, executor });
  assert.equal(state.status, 'passed', state.error);
  const spec = state.stages.find((s) => s.id === 'spec');
  assert.equal(spec.attempts.length, 2);
  assert.equal(spec.attempts[0].ok, false);
  const retry = prompts.filter((p) => p.stage === 'spec')[1].prompt;
  assert.match(retry, /Gate feedback/);
  assert.match(retry, /Acceptance Criteria/);
  assert.equal(state.costUsd, 0.01);
});

test('a rejected review rewinds to build with the findings, then passes', async () => {
  const { dir } = fixtureRepo();
  let reviews = 0;
  const buildPrompts = [];
  const executor = mockExecutor({
    script: {
      async build(ctx) {
        buildPrompts.push(ctx);
        writeFileSync(path.join(dir, 'src', `change-${buildPrompts.length}.js`), 'export const y = 2;\n');
      },
      async review(ctx) {
        reviews++;
        const verdict = reviews === 1 ? 'REQUEST_CHANGES' : 'APPROVE';
        const findings = reviews === 1 ? '- [BLOCKER] src/index.js:1 — missing input validation — validate x' : 'None.';
        writeFileSync(ctx.artifacts.review, `# Review\n\nVerdict: ${verdict}\n\n## Findings\n${findings}\n`);
      },
    },
  });
  const state = await runPipeline({ dir, request: REQUEST, executor });
  assert.equal(state.status, 'passed', state.error);
  assert.equal(state.reviewLoops, 1);
  assert.equal(reviews, 2);
  const build = state.stages.find((s) => s.id === 'build');
  assert.equal(build.attempts.length, 2);
  assert.match(build.attempts[1].feedback, /missing input validation/);
});

test('stops after maxReviewLoops when the reviewer never approves', async () => {
  const { dir } = fixtureRepo();
  const executor = mockExecutor({
    script: {
      async review(ctx) {
        writeFileSync(
          ctx.artifacts.review,
          '# Review\n\nVerdict: REQUEST_CHANGES\n\n## Findings\n- [BLOCKER] a.js:1 — bug — fix\n',
        );
      },
    },
  });
  const state = await runPipeline({ dir, request: REQUEST, executor, maxReviewLoops: 1 });
  assert.equal(state.status, 'failed');
  assert.equal(state.reviewLoops, 1);
  assert.match(state.error, /review gate failed/);
  assert.equal(state.stages.find((s) => s.id === 'ship').status, 'pending');
});

test('fails the run when tests keep failing, without committing', async () => {
  const { dir, git } = fixtureRepo({ commands: { lint: 'node -e 0', test: 'node -e "process.exit(1)"' } });
  const state = await runPipeline({ dir, request: REQUEST, executor: mockExecutor(), maxAttempts: 2 });
  assert.equal(state.status, 'failed');
  const t = state.stages.find((s) => s.id === 'test');
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts.length, 2);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
});

test('a build that changes nothing fails its gate', async () => {
  const { dir } = fixtureRepo();
  const state = await runPipeline({
    dir,
    request: REQUEST,
    executor: mockExecutor({ script: { async build() {} } }),
    stages: ['spec', 'plan', 'build'],
    maxAttempts: 1,
  });
  assert.equal(state.status, 'failed');
  const gate = state.stages.find((s) => s.id === 'build').attempts[0].gate;
  assert.ok(gate.some((c) => c.name === 'source changes' && !c.ok));
});

test('secrets introduced by the build block the review gate', async () => {
  const { dir } = fixtureRepo();
  const executor = mockExecutor({
    script: {
      async build() {
        writeFileSync(path.join(dir, 'src', 'config.js'), 'export const key = "AKIAABCDEFGHIJKLMNOP";\n');
      },
    },
  });
  const state = await runPipeline({ dir, request: REQUEST, executor, maxReviewLoops: 0 });
  assert.equal(state.status, 'failed');
  const gate = state.stages.find((s) => s.id === 'review').attempts.at(-1).gate;
  assert.ok(gate.some((c) => /secrets/.test(c.name) && !c.ok && /aws-access-key/.test(c.detail)));
});

test('stage subsets and --no-commit', async () => {
  const { dir, git } = fixtureRepo();
  const state = await runPipeline({ dir, request: REQUEST, executor: mockExecutor(), stages: ['spec', 'plan'] });
  assert.equal(state.status, 'passed');
  assert.deepEqual(
    state.stages.map((s) => s.id),
    ['spec', 'plan'],
  );
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.ok(readFileSync(path.join(dir, state.artifactDir, 'PLAN.md'), 'utf8').includes('AC1'));
  await assert.rejects(runPipeline({ dir, request: REQUEST, executor: mockExecutor(), stages: ['deploy'] }), /unknown stage/);
});

test('install failure stops the run before any agent runs', async () => {
  const { dir } = fixtureRepo({ commands: { install: 'node -e "process.exit(3)"', test: 'node -e 0' } });
  let called = false;
  const state = await runPipeline({
    dir,
    request: REQUEST,
    executor: { name: 'x', run: async () => ((called = true), { ok: true }) },
  });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /install failed/);
  assert.equal(called, false);
});

test('run spend cap stops the run before further agent spend (--max-run-usd)', async () => {
  const { dir } = fixtureRepo();
  // $10 per attempt, $15 cap: spec ($10) and plan ($20 cumulative) run, then the
  // run must stop before build spends anything.
  const state = await runPipeline({
    dir,
    request: REQUEST,
    executor: mockExecutor({ costPerAttempt: 10 }),
    maxRunUsd: 15,
  });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /run spend cap reached/);
  assert.match(state.error, /--max-run-usd/);
  assert.equal(state.costUsd, 20);
  assert.equal(state.maxRunUsd, 15);
  const byId = Object.fromEntries(state.stages.map((s) => [s.id, s]));
  assert.equal(byId.spec.status, 'passed');
  assert.equal(byId.plan.status, 'passed');
  assert.equal(byId.build.status, 'failed');
  assert.equal(byId.build.attempts.length, 0, 'no build attempt may start once the cap is reached');
});

test('a run under its spend cap passes, and a disabled cap never stops a run', async () => {
  const under = fixtureRepo();
  const okState = await runPipeline({
    dir: under.dir,
    request: REQUEST,
    executor: mockExecutor({ costPerAttempt: 1 }),
    maxRunUsd: 15,
  });
  assert.equal(okState.status, 'passed', okState.error);
  assert.equal(okState.costUsd, 5, 'five agent stages at $1 each');

  const off = fixtureRepo();
  const offState = await runPipeline({
    dir: off.dir,
    request: REQUEST,
    executor: mockExecutor({ costPerAttempt: 100 }),
    maxRunUsd: null,
  });
  assert.equal(offState.status, 'passed', offState.error);
  assert.equal(offState.costUsd, 500);
  assert.equal(offState.maxRunUsd, null);
});

test('a run can be cancelled: state saved as cancelled and the lock released', async () => {
  const { dir } = fixtureRepo();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 150);
  const state = await runPipeline({
    dir,
    request: REQUEST,
    executor: mockExecutor({ delayMs: 500 }),
    signal: abort.signal,
  });
  clearTimeout(timer);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.error, 'cancelled by user');
  assert.ok(
    state.stages.every((s) => s.status !== 'passed' || s.id === 'spec') || state.stages.some((s) => s.status === 'pending'),
    'later stages never ran',
  );
  assert.equal(state.stages.filter((s) => s.attempts.length > 0).length, 1, 'only the in-flight stage was attempted');
  assert.equal(await liveRunLock(dir), null, 'the repo lock is released after a cancel');
  const saved = await readRun(dir, state.id);
  assert.equal(saved.status, 'cancelled');
});

test('util run kills the child process when the AbortSignal fires', async () => {
  const abort = new AbortController();
  const started = Date.now();
  const p = procRun(['node', '-e', 'setTimeout(() => {}, 30000)'], { signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(r.code, 130);
  assert.ok(Date.now() - started < 10000, 'returned promptly after abort, not at the 30s sleep or 15m timeout');
});
