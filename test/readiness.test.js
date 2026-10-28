import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SIGNALS, PILLARS, POINTS_BY_LEVEL } from '../src/readiness/signals.js';
import { scoreRepo, orgReadiness, levelForScore, LEVEL_THRESHOLDS } from '../src/readiness/score.js';
import { aggregateOutcomes } from '../src/readiness/outcomes.js';
import { tmp } from './helpers.js';

function write(dir, rel, body) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body);
}

test('points are derived from level: L1=1, L2=2, L3=4, L4=8, L5=16', () => {
  assert.deepEqual(POINTS_BY_LEVEL, { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 });
  for (const s of SIGNALS) assert.equal(s.points, POINTS_BY_LEVEL[s.level], `${s.id} points must derive from its level`);
});

test('the catalog covers all eight pillars with 45-55 signals', () => {
  assert.ok(SIGNALS.length >= 45 && SIGNALS.length <= 55, `catalog has ${SIGNALS.length} signals`);
  assert.equal(new Set(SIGNALS.map((s) => s.id)).size, SIGNALS.length, 'signal ids are unique');
  for (const num of Object.keys(PILLARS)) {
    assert.ok(
      SIGNALS.some((s) => s.pillar === Number(num)),
      `pillar ${num} has signals`,
    );
  }
  for (const level of [1, 2, 3]) {
    assert.ok(SIGNALS.filter((s) => s.level === level).length >= 5, `level ${level} is densely covered`);
  }
});

test('level thresholds are the AMM cumulative cut-offs', () => {
  assert.deepEqual(LEVEL_THRESHOLDS, { 1: 5, 2: 19, 3: 36, 4: 60, 5: 100 });
  const cases = [
    [0, 0],
    [4, 0],
    [5, 1],
    [18, 1],
    [19, 2],
    [35, 2],
    [36, 3],
    [59, 3],
    [60, 4],
    [99, 4],
    [100, 5],
    [250, 5],
  ];
  for (const [score, level] of cases) assert.equal(levelForScore(score), level, `score ${score}`);
});

test('an empty repo scores zero, level 0, and is not agent-ready', async () => {
  const report = await scoreRepo(tmp('sf-empty-'));
  assert.equal(report.score, 0);
  assert.equal(report.level, 0);
  assert.equal(report.agentReady, false);
  assert.equal(report.remediation.length, SIGNALS.length, 'every signal is missing in an empty repo');
});

test('a rich fixture repo passes the named signals', async () => {
  const dir = tmp('sf-rich-');
  write(dir, 'package.json', JSON.stringify({ name: 'rich', scripts: { lint: 'eslint .', test: 'vitest run' }, prettier: {} }));
  write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
  write(
    dir,
    'eslint.config.js',
    "import js from '@eslint/js';\nexport default [js.configs.recommended, { rules: { eqeqeq: 'error' } }];\n",
  );
  write(dir, '.githooks/pre-commit', '#!/bin/sh\nnpm run lint\n');
  write(dir, '.github/workflows/ci.yml', 'steps:\n  - run: npm ci\n  - run: npm run lint\n  - run: npm test\n');
  write(dir, '.github/workflows/codeql.yml', 'steps:\n  - uses: github/codeql-action/init@v4\n');
  write(dir, '.github/dependabot.yml', 'version: 2\nupdates: []\n');
  write(dir, 'README.md', '# Rich\n\nSetup: npm ci, then npm test.\n');
  write(
    dir,
    'AGENTS.md',
    '# Agents\n\n## Setup\nInstall with npm ci.\n\n## Architecture\nThe structure is a CLI in src/ with tests alongside.\n\n## Commands\nRun the test suite before pushing.\n\n## Troubleshooting\nIf a test fails, read the gate output first.\n'.padEnd(
      500,
      ' ',
    ),
  );
  write(dir, 'docs/threat-model.md', '# Threat model\n\nSTRIDE: Spoofing — x. Tampering — y.\n');
  write(
    dir,
    'factory.json',
    JSON.stringify({ name: 'rich', commands: { install: 'npm ci', lint: 'npm run lint', test: 'npm test' } }),
  );
  write(dir, 'src/index.test.js', "import { test } from 'node:test';\ntest('x', () => {});\n");
  write(dir, 'src/other.test.js', "import { test } from 'node:test';\ntest('y', () => {});\n");
  for (const agent of ['a', 'b', 'c', 'd', 'e']) write(dir, `.claude/agents/${agent}.md`, `# ${agent}\n`);
  write(dir, '.claude/DISPATCHER.md', '# Dispatcher\n');

  const report = await scoreRepo(dir);
  const passed = new Set(report.results.filter((r) => r.pass).map((r) => r.signal.id));
  for (const id of [
    'lint-config',
    'formatter-config',
    'lint-command',
    'typecheck-strict',
    'precommit-hooks',
    'reproducible-install',
    'ci-runs-tests',
    'multiple-suites',
    'agents-md',
    'threat-model',
    'codeql',
    'dependabot',
    'multi-agent-orchestration',
    'strict-lint-rules',
  ]) {
    assert.ok(passed.has(id), `rich fixture should pass ${id}`);
  }
  assert.ok(report.score > 0);
  // Per-pillar earned/missing partition the catalog for that pillar.
  for (const [num, pillar] of Object.entries(report.pillars)) {
    const total = SIGNALS.filter((s) => s.pillar === Number(num)).length;
    assert.equal(pillar.earned.length + pillar.missing.length, total, `pillar ${num} partitions its signals`);
  }
});

test('remediation is sorted by level ascending, then points descending', async () => {
  const report = await scoreRepo(tmp('sf-bare-'));
  const keys = report.remediation.map((s) => [s.level, -s.points]);
  const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(keys, sorted);
  assert.equal(report.remediation[0].level, 1, 'cheapest wins first');
});

test('orgReadiness computes the share of repos at Level 3+', () => {
  assert.deepEqual(orgReadiness([{ agentReady: true }, { agentReady: true }, { agentReady: false }, { agentReady: false }]), {
    total: 4,
    ready: 2,
    pct: 50,
  });
  assert.deepEqual(orgReadiness([{ agentReady: true }, { agentReady: false }, { agentReady: false }]), {
    total: 3,
    ready: 1,
    pct: 33.3,
  });
  assert.deepEqual(orgReadiness([]), { total: 0, ready: 0, pct: 0 });
});

const stage = (status, attempts) => ({ status, attempts: Array.from({ length: attempts }, () => ({})) });
const run = (over) => ({
  id: '20260101-000000-abcd',
  status: 'passed',
  costUsd: 0,
  startedAt: '2026-01-01T10:00:00Z',
  finishedAt: '2026-01-01T10:30:00Z',
  stages: [stage('passed', 1)],
  reviewLoops: 0,
  ...over,
});

test('aggregateOutcomes computes autonomy ratio, cycle time and cost per change', () => {
  const runs = [
    run({ costUsd: 2 }), // autonomous: passed, 1 attempt/stage, 0 review loops, 30 min
    run({ costUsd: 3, finishedAt: '2026-01-01T11:00:00Z', stages: [stage('passed', 2)], reviewLoops: 1 }), // passed but retried
    run({ status: 'failed', costUsd: 1, finishedAt: '2026-01-01T10:10:00Z', stages: [stage('failed', 3)] }), // completed, 10 min
    run({ status: 'running', costUsd: 0.5, finishedAt: null }), // not completed
  ];
  const m = aggregateOutcomes(runs);
  assert.equal(m.totalRuns, 4);
  assert.equal(m.completedRuns, 3);
  assert.equal(m.passedRuns, 2);
  assert.equal(m.autonomyRatio, 1 / 3);
  assert.equal(m.autonomousRuns, 1);
  assert.equal(m.meanCycleMinutes, (30 + 60 + 10) / 3);
  assert.equal(m.medianCycleMinutes, 30);
  assert.equal(m.totalCostUsd, 6.5);
  assert.equal(m.costPerChangeUsd, 6.5 / 2);
  assert.equal(m.totalReviewLoops, 1);
  assert.equal(m.mttrMinutes, null, 'MTTR is not recorded in run.json and must not be fabricated');
});

test('aggregateOutcomes handles empty and in-progress-only input', () => {
  const empty = aggregateOutcomes([]);
  assert.equal(empty.totalRuns, 0);
  assert.equal(empty.autonomyRatio, null);
  assert.equal(empty.costPerChangeUsd, null);
  assert.equal(empty.meanCycleMinutes, null);
  assert.equal(empty.medianCycleMinutes, null);
  const running = aggregateOutcomes([run({ status: 'running', finishedAt: null })]);
  assert.equal(running.completedRuns, 0);
  assert.equal(running.autonomyRatio, null);
});
