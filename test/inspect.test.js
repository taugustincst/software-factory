import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  resolveInspector,
  parseCoverage,
  verdictOf,
  inspect,
  parseModelReview,
  latestMainCi,
  DEFAULT_RUBRIC,
} from '../src/inspect/index.js';
import { reinspect, postReleaseWatch } from '../src/cli/inspect.js';
import { runPipeline, shipRun } from '../src/pipeline/runner.js';
import { mockExecutor } from '../src/pipeline/executors.js';
import { createHarness } from '../src/harness/index.js';
import { readAudit } from '../src/improve/store.js';
import { buildEvidence } from '../src/improve/evidence.js';
import { readRun, saveRun } from '../src/pipeline/store.js';
import { fixtureRepo } from './helpers.js';

const REQUEST = '# Add a visits cleanup job\n\nRemove stale rows nightly.';

function withConfig(extra) {
  const r = fixtureRepo();
  const file = path.join(r.dir, 'factory.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...extra }));
  r.git('commit', '-qam', 'config');
  return r;
}

/** A build that also adds a destructive migration. */
const migrationBuild = {
  async build(ctx) {
    for (const [p, c] of [
      ['factory-mock/CHANGE.md', 'x\n'],
      ['factory-mock/change.test.md', 'x\n'],
      ['migrations/001_cleanup.sql', 'DROP TABLE visits;\n'],
    ])
      await ctx.harness.call('write_file', { path: p, content: c });
  },
};

test('settings: defaults, overrides, warnings', () => {
  const d = resolveInspector({});
  assert.deepEqual(d.rubric, DEFAULT_RUBRIC);
  assert.equal(d.analyze, true);
  assert.equal(d.rubric['gates-passed'], 'hold');
  const c = resolveInspector({
    inspector: {
      rubric: { 'risky-diff': 'hold', bogus: 'hold', lint: 'maybe' },
      coverageDropMax: -1,
      analyze: false,
      model: 'm-1',
    },
  });
  assert.equal(c.rubric['risky-diff'], 'hold');
  assert.equal(c.rubric.lint, 'hold', 'invalid level keeps the default');
  assert.equal(c.coverageDropMax, 1);
  assert.equal(c.analyze, false);
  assert.equal(c.model, 'm-1');
  assert.equal(c.warnings.length, 3);
});

test('coverage parsing and verdicts', () => {
  assert.equal(parseCoverage('coverage lines: 92.55% (threshold 89%) ok'), 92.55);
  assert.equal(parseCoverage('# all files | 88.10 | 70 | 80 |'), 88.1);
  assert.equal(parseCoverage('Lines        : 75.5% ( 100/132 )'), 75.5);
  assert.equal(parseCoverage('TOTAL   120   10   91%'), 91);
  assert.equal(parseCoverage('nothing here'), null);
  assert.equal(verdictOf([{ ok: true, level: 'hold' }]), 'ship');
  assert.equal(verdictOf([{ ok: false, level: 'note' }]), 'ship-with-notes');
  assert.equal(
    verdictOf([
      { ok: false, level: 'note' },
      { ok: false, level: 'hold' },
    ]),
    'hold',
  );
  assert.deepEqual(parseModelReview('```json\n{"verdict":"hold","notes":["x"]}\n```'), { verdict: 'hold', notes: ['x'] });
  assert.equal(parseModelReview('{"verdict":"yes"}'), null);
  assert.equal(parseModelReview('junk'), null);
});

test('default run: the Inspector re-verifies and ships, with its harness calls recorded', async () => {
  const { dir } = fixtureRepo();
  const s = await runPipeline({ dir, request: REQUEST, executor: mockExecutor() });
  assert.equal(s.status, 'passed', s.error);
  assert.equal(s.inspection.verdict, 'ship');
  const checks = Object.fromEntries(s.inspection.findings.map((f) => [f.check, f]));
  for (const c of [
    'gates-passed',
    'lint',
    'test',
    'secrets',
    'risky-diff',
    'version-changelog',
    'template-conformance',
    'model-review',
  ])
    assert.ok(checks[c]?.ok, c);
  assert.deepEqual(s.inspection.notes, ['mock inspector: change matches the spec']);
  const att = s.stages.find((x) => x.id === 'inspect').attempts[0];
  assert.equal(att.harness.role, 'inspector');
  assert.equal(att.harness.calls, 2, 'lint and test re-run through the harness');
});

test('a risky diff ships with notes by default, and is held when the rubric says hold', async () => {
  const noted = fixtureRepo();
  const a = await runPipeline({ dir: noted.dir, request: REQUEST, executor: mockExecutor({ script: migrationBuild }) });
  assert.equal(a.status, 'passed', a.error);
  assert.equal(a.inspection.verdict, 'ship-with-notes');
  assert.match(
    a.inspection.findings.find((f) => f.check === 'risky-diff').detail,
    /migrations\/001_cleanup\.sql: database migration[\s\S]*DROP TABLE/,
  );

  const { dir, git } = withConfig({ inspector: { rubric: { 'risky-diff': 'hold' } } });
  const held = await runPipeline({ dir, request: REQUEST, executor: mockExecutor({ script: migrationBuild }) });
  assert.equal(held.status, 'held');
  assert.match(held.error, /Inspector hold \(risky-diff\)/);
  assert.equal(held.stages.find((x) => x.id === 'ship').status, 'pending', 'ship never ran');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'nothing was committed');
  assert.ok(buildEvidence([held]).facts['inspector-hold:risky-diff'], 'a hold becomes evidence for the Steward');

  // Shipping past a hold: refused without a reason; with one, it is audited.
  await assert.rejects(shipRun({ dir, runId: held.id, push: false }), /held by the Inspector/);
  await assert.rejects(
    shipRun({ dir, runId: held.id, push: false, overrideHold: 'x' }),
    /held by the Inspector/,
    'a reason is required',
  );
  await assert.rejects(
    shipRun({ dir, runId: held.id, push: false, overrideHold: 'steward says fine', by: 'steward' }),
    /only a human/,
  );
  const shipped = await shipRun({ dir, runId: held.id, push: false, overrideHold: 'reviewed the migration by hand' });
  assert.equal(shipped.status, 'passed');
  assert.equal(shipped.inspection.override.reason, 'reviewed the migration by hand');
  const audit = (await readAudit(dir)).find((e) => e.kind === 'inspector-override');
  assert.equal(audit.run, held.id);
  assert.equal(audit.findings[0].check, 'risky-diff');
});

test('fix and re-inspect clears a hold without any override', async () => {
  const { dir } = withConfig({ inspector: { rubric: { 'risky-diff': 'hold' } } });
  const held = await runPipeline({ dir, request: REQUEST, executor: mockExecutor({ script: migrationBuild }) });
  assert.equal(held.status, 'held');
  rmSync(path.join(dir, 'migrations'), { recursive: true });
  const again = await reinspect({ dir, runId: held.id });
  assert.equal(again.inspection.verdict, 'ship');
  assert.equal(again.status, 'passed');
  assert.match(again.events.at(-1).msg, /hold cleared/);
});

test('the model Inspector can hold; it cannot clear a deterministic hold', async () => {
  const holdModel = { inspect: async () => ({ summary: '{"verdict":"hold","notes":["spec AC2 is not implemented"]}' }) };
  const a = fixtureRepo();
  const held = await runPipeline({ dir: a.dir, request: REQUEST, executor: mockExecutor({ script: holdModel }) });
  assert.equal(held.status, 'held');
  assert.match(held.inspection.findings.find((f) => f.check === 'model-review').detail, /AC2 is not implemented/);

  const shipModel = { ...migrationBuild, inspect: async () => ({ summary: '{"verdict":"ship","notes":[]}' }) };
  const b = withConfig({ inspector: { rubric: { 'risky-diff': 'hold' } } });
  const still = await runPipeline({ dir: b.dir, request: REQUEST, executor: mockExecutor({ script: shipModel }) });
  assert.equal(still.status, 'held', 'a model "ship" does not clear the deterministic hold');

  const c = withConfig({ inspector: { analyze: false } });
  const noModel = await runPipeline({ dir: c.dir, request: REQUEST, executor: mockExecutor({ script: holdModel }) });
  assert.equal(noModel.status, 'passed', 'analyze: false skips the model');
  assert.ok(!noModel.inspection.findings.some((f) => f.check === 'model-review'));
});

test('inspect() directly: earlier gates, secrets, version/changelog, conformance', async () => {
  const { dir } = fixtureRepo();
  const harness = createHarness({ root: dir, role: 'inspector', commands: {}, exec: [] });
  const project = { commands: {}, config: {}, inferred: false };
  const settings = resolveInspector({});
  const run = {
    stages: [
      { id: 'spec', status: 'passed', attempts: [{ ok: true }] },
      { id: 'review', status: 'failed', attempts: [{ ok: false }] },
    ],
  };
  const key = 'ghp_' + 'A'.repeat(36);
  writeFileSync(path.join(dir, 'config.js'), `export const token = '${key}';\n`);
  writeFileSync(path.join(dir, 'CHANGELOG.md'), '## 1.0.1\n');
  writeFileSync(path.join(dir, 'factory.json'), '{ not json');
  const r = await inspect({ ctx: { dir, harness }, run, project, settings });
  const by = Object.fromEntries(r.findings.map((f) => [f.check, f]));
  assert.equal(r.verdict, 'hold');
  assert.match(by['gates-passed'].detail, /review \(failed\)/);
  assert.equal(by.secrets.ok, false);
  assert.doesNotMatch(by.secrets.detail, /AAAAAAAAAAAA/, 'the secret itself is redacted');
  assert.match(by['version-changelog'].detail, /CHANGELOG changed without a version bump/);
  assert.match(by['template-conformance'].detail, /does not parse/);
});

test('coverage delta compares against the last inspected run', async () => {
  const { dir } = fixtureRepo();
  mkdirSync(path.join(dir, 'tools'), { recursive: true });
  const harness = createHarness({
    root: dir,
    role: 'inspector',
    commands: { coverage: 'node -e "console.log(\'coverage lines: 80.5%\')"' },
    exec: ['coverage'],
  });
  const project = { commands: { coverage: 'x' }, config: {} };
  const r = await inspect({ ctx: { dir, harness }, run: null, project, settings: resolveInspector({}), previousCoverage: 85 });
  const f = r.findings.find((x) => x.check === 'coverage-delta');
  assert.equal(r.coverage, 80.5);
  assert.equal(f.ok, false);
  assert.match(f.detail, /80\.5% vs 85%/);
  const ok = await inspect({ ctx: { dir, harness }, run: null, project, settings: resolveInspector({}), previousCoverage: 81 });
  assert.equal(ok.findings.find((x) => x.check === 'coverage-delta').ok, true);
});

test('post-release watch attributes main CI to the newest shipped run', async () => {
  const { dir, git } = fixtureRepo();
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  const s = await runPipeline({ dir, request: REQUEST, executor: mockExecutor() });
  s.prUrl = 'https://github.com/acme/widgets/pull/9';
  await saveRun(dir, s);
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(' '));
    return {
      code: 0,
      stdout: JSON.stringify({
        workflow_runs: [
          {
            conclusion: 'failure',
            html_url: 'https://github.com/acme/widgets/actions/runs/1',
            head_sha: 'abc',
            updated_at: new Date(Date.now() + 60_000).toISOString(),
            name: 'CI',
          },
        ],
      }),
      stderr: '',
    };
  };
  const r = await postReleaseWatch({ dir, gh });
  assert.match(calls[0], /^api repos\/acme\/widgets\/actions\/runs\?branch=main&status=completed/);
  assert.equal(r.ci.conclusion, 'failure');
  assert.match(r.note, /followed by a failing main CI/);
  const saved = await readRun(dir, s.id);
  assert.equal(saved.postRelease.conclusion, 'failure');
  assert.equal(buildEvidence([saved]).facts['post-release-fail'].value, 1, 'a bad release becomes Steward evidence');
  await assert.rejects(latestMainCi({ dir, branch: '--evil', gh }), /invalid branch/);
});
