import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildEvidence, reviewFindings, evidenceScore } from '../src/improve/evidence.js';
import { validateProposal } from '../src/improve/validate.js';
import { computeRisk, approvalAction, targetRisk } from '../src/improve/approval.js';
import { resolveConfig } from '../src/improve/config.js';
import { parseDecisions } from '../src/improve/roles.js';
import {
  upsertProposal,
  listProposals,
  readAudit,
  readDigest,
  readProposal,
  saveProposal,
  setStatus,
  fingerprint,
} from '../src/improve/store.js';
import { stewardPass } from '../src/improve/steward.js';
import { decideProposal, startApply, revertProposal, proposalRequest } from '../src/improve/apply.js';
import { applyInline } from '../src/cli/improve.js';
import { runPipeline } from '../src/pipeline/runner.js';
import { mockExecutor } from '../src/pipeline/executors.js';
import { summarizeAudit } from '../src/harness/index.js';
import { fixtureRepo } from './helpers.js';

// --- synthetic run records -------------------------------------------------------------
const attempt = (ok, cost, failed = []) => ({
  ok,
  costUsd: cost,
  startedAt: '2026-11-06T10:00:00Z',
  finishedAt: '2026-11-06T10:01:00Z',
  gate: [...failed.map((name) => ({ name, ok: false, severity: 'error' })), { name: 'advice', ok: false, severity: 'warn' }],
});
const runRec = (id, status, buildAttempts, extra = {}) => ({
  id,
  status,
  costUsd: buildAttempts.reduce((s, a) => s + a.costUsd, 0),
  reviewLoops: 0,
  stages: [{ id: 'build', status: status === 'failed' ? 'failed' : 'passed', attempts: buildAttempts }],
  ...extra,
});
const RUNS = [
  runRec('20261106-040000-aaaa', 'passed', [attempt(false, 1, ['lint: npm run lint']), attempt(true, 1)]),
  runRec('20261106-030000-bbbb', 'passed', [attempt(false, 2, ['lint: npm run lint']), attempt(true, 1)], { reviewLoops: 1 }),
  runRec('20261106-020000-cccc', 'failed', [attempt(false, 1, ['lint: npm run lint', 'test: npm test'])]),
  runRec('20261106-010000-dddd', 'passed', [attempt(true, 1)]),
];

test('evidence: facts, values, runs and recurring patterns', () => {
  const ev = buildEvidence(RUNS, { recurrenceMin: 3 });
  assert.equal(ev.runCount, 4);
  assert.deepEqual(ev.facts['gate-fail:build:lint'].runs.length, 3);
  assert.equal(ev.facts['gate-fail:build:lint'].value, 3);
  assert.equal(ev.facts['gate-fail:build:test'].value, 1);
  assert.equal(ev.facts['retries:build'].value, 2);
  assert.equal(ev.facts['retry-cost:build'].value, 2);
  assert.equal(ev.facts['cost:total'].value, 7);
  assert.equal(ev.facts['cost-per-passed-run'].value, 2.33);
  assert.equal(ev.facts['review-loops'].value, 1);
  assert.equal(ev.facts['runs:failed'].value, 1);
  assert.equal(ev.facts['stage-fail:build'].value, 1);
  assert.deepEqual(ev.patterns, ['gate-fail:build:lint'], 'warn-severity checks and one-offs are not patterns');
  assert.ok(ev.facts['cost-per-passed-run:recent'] && ev.facts['cost-per-passed-run:earlier']);
  assert.equal(buildEvidence([], {}).runCount, 0);
});

test('evidence: review findings normalize so recurrences match', () => {
  const a = reviewFindings('## Findings\n- BLOCKER: `src/a.js:12` Missing input validation on the export route\n- MINOR: style');
  const b = reviewFindings('- **MAJOR** src/b.js:40 missing input validation on the export route (3 places)');
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
});

const evidence = buildEvidence(RUNS, { recurrenceMin: 3 });
const good = {
  title: 'Tell the implementer to run lint before finishing',
  kind: 'kit-prompt',
  targets: ['.claude/agents/implementer.md'],
  lesson: 'Lint fails in the build gate on most runs.',
  change: 'Add a step: run lint and fix before reporting done.',
  claims: [{ text: 'lint failed in 3 runs', fact: 'gate-fail:build:lint', value: 3 }],
};

test('citation gate: accepts cited claims, rejects uncited, unknown or wrong numbers', () => {
  assert.equal(validateProposal(good, evidence).ok, true);
  const bad = (patch) => validateProposal({ ...good, ...patch }, evidence);
  assert.match(bad({ claims: [] }).errors.join(), /at least one/);
  assert.match(
    bad({ claims: [{ text: 'x', fact: 'gate-fail:build:made-up', value: 9 }] }).errors.join(),
    /not in the evidence pack/,
  );
  assert.match(bad({ claims: [{ text: 'x', fact: 'gate-fail:build:lint', value: 5 }] }).errors.join(), /the evidence says 3/);
  assert.match(bad({ targets: ['../etc/passwd'] }).errors.join(), /not a repo-relative path/);
  assert.match(bad({ targets: ['/abs'] }).errors.join(), /not a repo-relative path/);
  assert.match(bad({ kind: 'rewrite-everything' }).errors.join(), /kind/);
  const eff = { ...good, kind: 'efficiency' };
  assert.match(validateProposal(eff, evidence).errors.join(), /expectedSavings/);
  assert.equal(validateProposal({ ...eff, expectedSavings: { fact: 'retry-cost:build', usd: 1.5 } }, evidence).ok, true);
  assert.match(
    validateProposal({ ...eff, expectedSavings: { fact: 'retry-cost:build', usd: 50 } }, evidence).errors.join(),
    /no larger than/,
  );
  assert.match(
    validateProposal({ ...eff, expectedSavings: { fact: 'gate-fail:build:lint', usd: 1 } }, evidence).errors.join(),
    /not a cost or duration/,
  );
  assert.equal(validateProposal(null, evidence).ok, false);
});

test('computed risk: tables decide, kind and targets combine upward', () => {
  assert.equal(targetRisk('docs/guide.md'), 'low');
  assert.equal(targetRisk('.claude/agents/implementer.md'), 'low');
  assert.equal(targetRisk('claude-kit/.claude/agents/planner.md'), 'low');
  assert.equal(targetRisk('templates/node-service/files/src/app.ts'), 'medium');
  assert.equal(targetRisk('src/pipeline/runner.js'), 'medium');
  for (const t of [
    'src/pipeline/gates.js',
    'claude-kit/.claude/hooks/lib/patterns.mjs',
    '.claude/hooks/x.mjs',
    '.claude/settings.json',
    '.github/workflows/ci.yml',
    'factory.json',
    'src/harness/scopes.js',
    'docs/threat-model.md',
    'SECURITY.md',
    'CHANGELOG.md',
  ])
    assert.equal(targetRisk(t), 'always-human', t);
  assert.equal(computeRisk(good), 'low');
  assert.equal(
    computeRisk({ ...good, targets: [...good.targets, 'src/pipeline/gates.js'] }),
    'always-human',
    'one sensitive target lifts the whole proposal',
  );
  assert.equal(computeRisk({ ...good, kind: 'gate', targets: ['docs/a.md'] }), 'always-human', 'a gate proposal is always human');
  assert.equal(computeRisk({ ...good, kind: 'template', targets: ['docs/a.md'] }), 'medium');
});

test('approval regime: required waits; auto applies only within the ceiling; always-human never auto', () => {
  const approve = { verdict: 'approve', score: 80 };
  const required = { mode: 'required', autoMaxRisk: 'medium' };
  const autoLow = { mode: 'auto', autoMaxRisk: 'low' };
  const autoMed = { mode: 'auto', autoMaxRisk: 'medium' };
  assert.equal(approvalAction(good, approve, required).action, 'await-human');
  assert.equal(approvalAction(good, approve, autoLow).action, 'apply');
  const tmpl = { ...good, kind: 'template', targets: ['templates/x/files/a.ts'] };
  assert.equal(approvalAction(tmpl, approve, autoLow).action, 'await-human');
  assert.equal(approvalAction(tmpl, approve, autoMed).action, 'apply');
  const gate = { ...good, targets: ['src/pipeline/gates.js'] };
  assert.equal(approvalAction(gate, approve, autoMed).action, 'await-human');
  assert.match(approvalAction(gate, approve, autoMed).reason, /always-human/);
  assert.equal(approvalAction(good, { verdict: 'needs-evidence' }, autoLow).action, 'await-human');
  assert.equal(approvalAction(good, { verdict: 'reject' }, autoLow).action, 'reject');
});

test('config: defaults, safe fallbacks, and the auto ceiling cannot reach always-human', () => {
  const d = resolveConfig({});
  assert.deepEqual(d.improvement.approval, { mode: 'required', autoMaxRisk: 'low' });
  assert.equal(d.improvement.afterRun, 'evidence');
  assert.deepEqual(d.models, { generative: null, decision: null });
  const c = resolveConfig({
    improvement: { approval: { mode: 'yolo', autoMaxRisk: 'always-human' }, recurrenceMin: 0 },
    models: { generative: 'claude-x', decision: 'rm -rf /' },
  });
  assert.equal(c.improvement.approval.mode, 'required');
  assert.equal(c.improvement.approval.autoMaxRisk, 'low');
  assert.equal(c.improvement.recurrenceMin, 3);
  assert.equal(c.models.generative, 'claude-x');
  assert.equal(c.models.decision, null);
  assert.equal(c.warnings.length, 4);
});

test('decider output parsing: bare, fenced, and junk', () => {
  const d = parseDecisions(
    'Here you go:\n```json\n{"decisions":[{"id":"P-00000001","verdict":"approve","score":150,"reasoning":"ok"},{"id":"x","verdict":"maybe"}]}\n```',
  );
  assert.deepEqual(d, [{ id: 'P-00000001', verdict: 'approve', score: 100, duplicateOf: null, reasoning: 'ok' }]);
  assert.equal(parseDecisions('{"decisions":[{"id":"P-1","verdict":"reject"}]}')[0].score, null);
  assert.deepEqual(parseDecisions('no json here'), []);
  assert.deepEqual(parseDecisions('{"nope": true}'), []);
});

test('store: dedupe by fingerprint; a rejected idea is not re-raised', async () => {
  const { dir } = fixtureRepo();
  const v = validateProposal(good, evidence).proposal;
  const a = await upsertProposal(dir, v, { score: 50, newestRun: 'r', passId: 'p1' });
  assert.equal(a.created, true);
  assert.equal(a.proposal.fingerprint, fingerprint(v));
  const b = await upsertProposal(dir, v, { score: 60, newestRun: 'r', passId: 'p2' });
  assert.equal(b.created, false);
  assert.equal(b.proposal.id, a.proposal.id);
  assert.equal(b.proposal.seen, 2);
  await decideProposal(dir, a.proposal.id, { approve: false, reason: 'not now' });
  const c = await upsertProposal(dir, v, { score: 70, newestRun: 'r', passId: 'p3' });
  assert.equal(c.created, false);
  assert.equal(c.proposal.status, 'rejected');
  assert.equal((await listProposals(dir)).length, 1);
  assert.equal((await readAudit(dir))[0].outcome, 'human-rejected');
  await assert.rejects(readProposal(dir, '../../etc'), /invalid proposal id/);
  assert.ok(evidenceScore(v, evidence) > 0);
});

test('proposalRequest carries the change, targets and cited evidence', () => {
  const r = proposalRequest({ id: 'P-00000001', approval: { by: 'auto' }, ...good });
  assert.match(r, /^# Tell the implementer/);
  assert.match(r, /approved by auto/);
  assert.match(r, /`\.claude\/agents\/implementer\.md`/);
  assert.match(r, /fact `gate-fail:build:lint` = 3/);
  assert.match(r, /Do not weaken any test, gate or guard/);
});

// --- end to end, offline ---------------------------------------------------------------

/** Three mock runs whose build fails its gate once each (no change on attempt 1). */
async function repoWithRecurringBuildFailure({ improvement } = {}) {
  const { dir, git } = fixtureRepo();
  if (improvement) {
    const cfg = JSON.parse(readFileSync(path.join(dir, 'factory.json'), 'utf8'));
    writeFileSync(path.join(dir, 'factory.json'), JSON.stringify({ ...cfg, improvement }));
    git('commit', '-qam', 'config');
  }
  for (let i = 0; i < 3; i++) {
    const executor = mockExecutor({
      costPerAttempt: 0.5,
      script: {
        async build(ctx, n) {
          if (n === 1) return {}; // writes nothing: the build gate fails
          await ctx.harness.call('write_file', { path: `factory-mock/change-${ctx.runId}.md`, content: 'x\n' });
          await ctx.harness.call('write_file', { path: `factory-mock/change-${ctx.runId}.test.md`, content: 'x\n' });
        },
      },
    });
    const s = await runPipeline({ dir, request: `# Change number ${i + 1}\n\nSomething small.`, executor });
    assert.equal(s.status, 'passed', s.error);
  }
  return { dir, git };
}

test('steward (required mode): drafts from evidence, passes the citation gate, decider recommends, Tj decides', async () => {
  const { dir } = await repoWithRecurringBuildFailure();
  const { report, digest, evidence: ev } = await stewardPass({ dir, executor: mockExecutor(), analyze: true });
  assert.ok(
    ev.patterns.some((p) => p.startsWith('gate-fail:build:')),
    JSON.stringify(ev.patterns),
  );
  assert.equal(report.errors.length, 0, report.errors.join('; '));
  assert.ok(report.created.length >= 1);
  const [p] = await listProposals(dir);
  assert.equal(p.status, 'recommended');
  assert.equal(p.risk, 'low');
  assert.equal(p.decision.verdict, 'approve');
  assert.equal(p.approval, null, 'required mode: nothing approved automatically');
  const audit = await readAudit(dir);
  assert.equal(audit[0].outcome, 'awaiting-human');
  assert.equal(digest.approval.mode, 'required');
  assert.ok(digest.queued.some((q) => q.id === p.id));
  assert.equal(digest.efficiency.retryWasteUsd, 1.5);
  assert.deepEqual(await readDigest(dir), digest);
  // The models worked through the harness, in their own scopes.
  const h = summarizeAudit(path.join(dir, '.factory', 'improvements', 'harness.jsonl'));
  assert.equal(h.byTool.write_file, 1);
  assert.equal(h.refused, 0);
  // Tj approves; applying it is a normal factory run that lands as a commit.
  await decideProposal(dir, p.id, { approve: true, reason: 'yes' });
  const state = await applyInline({ dir, id: p.id, executor: mockExecutor() });
  assert.equal(state.status, 'passed', state.error);
  assert.equal(state.proposalId, p.id);
  const applied = await readProposal(dir, p.id);
  assert.equal(applied.status, 'applied');
  assert.match(applied.apply.commit, /^[0-9a-f]{40}$/);
  assert.equal(applied.apply.branch, state.branch);
  // Revert is one command.
  const reverted = await revertProposal(dir, p.id);
  assert.equal(reverted.status, 'reverted');
  assert.equal((await readAudit(dir)).at(-1).outcome, 'reverted');
});

test('steward (auto mode): approves low-risk proposals itself, audited; never above the ceiling', async () => {
  const { dir } = await repoWithRecurringBuildFailure({ improvement: { approval: { mode: 'auto', autoMaxRisk: 'low' } } });
  const { report } = await stewardPass({ dir, executor: mockExecutor(), analyze: true });
  assert.equal(report.autoApproved.length, report.created.length);
  const [p] = await listProposals(dir);
  assert.equal(p.status, 'approved');
  assert.equal(p.approval.by, 'auto');
  assert.equal((await readAudit(dir))[0].outcome, 'auto-approved');
  // A proposal touching a gate is never auto-approved, whatever the decider says.
  const gateDraft = {
    async improve(ctx) {
      const ev = JSON.parse(readFileSync(ctx.evidenceFile, 'utf8'));
      const id = ev.patterns[0];
      await ctx.harness.call('write_file', {
        path: ctx.rel(ctx.proposalsFile),
        content: JSON.stringify([
          {
            ...good,
            title: 'Loosen the build gate',
            targets: ['src/pipeline/gates.js'],
            claims: [{ text: 't', fact: id, value: ev.facts[id].value }],
          },
        ]),
      });
    },
  };
  const r2 = await stewardPass({ dir, executor: mockExecutor({ script: gateDraft }), analyze: true });
  const gateP = await readProposal(dir, r2.report.created[0]);
  assert.equal(gateP.risk, 'always-human');
  assert.equal(gateP.status, 'recommended');
  assert.equal(r2.report.autoApproved.length, 0);
});

test('steward: drafts that fail the citation gate are recorded, not filed', async () => {
  const { dir } = await repoWithRecurringBuildFailure();
  const liar = {
    async improve(ctx) {
      await ctx.harness.call('write_file', {
        path: ctx.rel(ctx.proposalsFile),
        content: JSON.stringify([
          { ...good, claims: [{ text: 'lint failed 99 times', fact: 'gate-fail:build:lint', value: 99 }] },
          'not an object',
        ]),
      });
    },
  };
  const { report, digest } = await stewardPass({ dir, executor: mockExecutor({ script: liar }), analyze: true });
  assert.equal(report.created.length, 0);
  assert.equal(report.rejectedDrafts.length, 2);
  assert.equal(digest.thisPass.rejectedDrafts, 2);
  assert.equal((await listProposals(dir)).length, 0);
});

test('steward: an improver that tries to write outside its scope is refused by the harness', async () => {
  const { dir } = await repoWithRecurringBuildFailure();
  const rogue = {
    async improve(ctx) {
      const r = await ctx.harness.call('write_file', { path: 'src/pipeline/gates.js', content: 'export const gates = {};' });
      assert.equal(r.ok, false);
    },
  };
  await stewardPass({ dir, executor: mockExecutor({ script: rogue }), analyze: true });
  assert.ok(!existsSync(path.join(dir, 'src', 'pipeline', 'gates.js')));
  assert.equal(summarizeAudit(path.join(dir, '.factory', 'improvements', 'harness.jsonl')).refusedBy['generative:write_file'], 1);
});

test('steward: deterministic pass retires proposals whose evidence stopped recurring, and reconciles applies', async () => {
  const { dir } = await repoWithRecurringBuildFailure({ improvement: { staleAfterRuns: 2 } });
  const ev = buildEvidence([], {});
  const stale = await upsertProposal(
    dir,
    { ...validateProposal(good, evidence).proposal, claims: [{ text: 'old', fact: 'gate-fail:spec:sections', value: 3 }] },
    { score: 1, newestRun: 'x', passId: 'p' },
  );
  assert.ok(ev);
  const applying = await upsertProposal(
    dir,
    { ...validateProposal(good, evidence).proposal, title: 'other', targets: ['docs/x.md'] },
    { score: 1, newestRun: 'x', passId: 'p' },
  );
  setStatus(applying.proposal, 'applying', 'test');
  applying.proposal.apply = { runId: (await import('../src/pipeline/store.js')).newRunId() };
  await saveProposal(dir, applying.proposal);
  const { report } = await stewardPass({ dir, analyze: false });
  assert.deepEqual(report.retired, [stale.proposal.id]);
  assert.equal((await readProposal(dir, stale.proposal.id)).status, 'retired');
  assert.equal(report.reconciled.length, 0, 'a run that does not exist yet is left applying');
  assert.equal(report.spendUsd, 0);
});

test('startApply only applies approved proposals', async () => {
  const { dir } = fixtureRepo();
  const { proposal } = await upsertProposal(dir, validateProposal(good, evidence).proposal, {
    score: 1,
    newestRun: 'x',
    passId: 'p',
  });
  await assert.rejects(
    startApply(dir, proposal.id, async () => 'x'),
    /only approved/,
  );
  await assert.rejects(revertProposal(dir, proposal.id), /only applied/);
  await assert.rejects(decideProposal(dir, 'P-ffffffff', { approve: true }), /not found/);
});

test('runPipeline runs the after-run hook; a failing hook never changes the run status', async () => {
  const { dir } = fixtureRepo();
  let seen = null;
  const ok = await runPipeline({
    dir,
    request: '# Hooked\n\nx',
    executor: mockExecutor(),
    stages: ['spec'],
    afterRun: async (s) => (seen = s.id),
  });
  assert.equal(seen, ok.id);
  const bad = await runPipeline({
    dir,
    request: '# Hooked again\n\nx',
    allowDirty: true,
    executor: mockExecutor(),
    stages: ['spec'],
    afterRun: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(bad.status, 'passed');
  assert.match(bad.events.at(-1).msg, /After-run improvement pass failed: boom/);
});

// --- dashboard, embedding, CLI ----------------------------------------------------------

test('dashboard: improvements API lists the backlog; actions need same origin and JSON', async () => {
  const { dir } = await repoWithRecurringBuildFailure();
  await stewardPass({ dir, executor: mockExecutor(), analyze: true });
  const { startDashboard } = await import('../src/dashboard/server.js');
  const spawned = [];
  const { startOnFreePort } = await import('./helpers.js');
  const { server, url } = await startOnFreePort(startDashboard, { dir, spawnRun: (a) => spawned.push(a) });
  try {
    const data = await (await fetch(`${url}/api/improvements`)).json();
    assert.equal(data.approval.mode, 'required');
    assert.ok(data.digest && data.digest.runs === 3);
    const [p] = data.proposals;
    const post = (id, action, headers = { 'Content-Type': 'application/json', Origin: url }) =>
      fetch(`${url}/api/improvements/${id}/${action}`, { method: 'POST', headers, body: '{"executor":"mock"}' });
    assert.equal((await post(p.id, 'approve', { 'Content-Type': 'application/json' })).status, 403, 'no Origin');
    assert.equal((await post(p.id, 'approve', { Origin: url })).status, 415);
    assert.equal((await post('P-bad', 'approve')).status, 400);
    assert.equal((await post(p.id, 'explode')).status, 404);
    assert.equal((await post(p.id, 'revert')).status, 409, 'not applied yet');
    const ok = await post(p.id, 'approve');
    assert.equal(ok.status, 202);
    const after = await ok.json();
    assert.equal(after.status, 'applying');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].proposalId, p.id);
    assert.equal(spawned[0].executor, 'mock');
    assert.match(spawned[0].request, new RegExp(p.title));
    assert.equal((await post(p.id, 'reject')).status, 409, 'cannot reject once applying');
    const audit = await readAudit(dir);
    assert.equal(audit.at(-1).outcome, 'human-approved');
  } finally {
    server.close();
  }
});

test('embedding: the kit ships the roles and pins them to the factory version', async () => {
  const { installClaudeKit, rolesPin, EMBEDDED_ROLES, ROLES_PIN } = await import('../src/claude-kit.js');
  const { tmp } = await import('./helpers.js');
  const dir = tmp();
  const r = await installClaudeKit(dir, { projectName: 'Demo' });
  assert.ok(r.written.includes(ROLES_PIN));
  for (const role of EMBEDDED_ROLES) assert.ok(existsSync(path.join(dir, '.claude', 'agents', `${role}.md`)), role);
  const pin = JSON.parse(readFileSync(path.join(dir, ROLES_PIN), 'utf8'));
  assert.deepEqual(pin, rolesPin());
  assert.equal(
    pin.factoryVersion,
    JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version,
  );
  for (const role of EMBEDDED_ROLES) assert.match(pin.roles[role], /^sha256:[0-9a-f]{16}$/);
  writeFileSync(path.join(dir, ROLES_PIN), '{"factoryVersion":"0.0.1","roles":{}}');
  assert.ok((await installClaudeKit(dir)).skipped.includes(ROLES_PIN), 'a plain re-install keeps the existing pin');
  await installClaudeKit(dir, { force: true });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ROLES_PIN), 'utf8')), rolesPin());
});

test('embedding: the schema validates the roles config and factory new writes the defaults', async () => {
  const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'schema', 'factory.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.improvement.properties.approval.properties.mode.enum, ['required', 'auto']);
  assert.deepEqual(schema.properties.improvement.properties.approval.properties.autoMaxRisk.enum, ['low', 'medium']);
  assert.ok(schema.properties.models && schema.properties.harness);
  const src = readFileSync(path.join(import.meta.dirname, '..', 'src', 'scaffold.js'), 'utf8');
  assert.match(src, /improvement: structuredClone\(FACTORY_DEFAULTS\.improvement\)/);
});

async function capture(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let text = '';
  process.stdout.write = (s) => ((text += s), true);
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return text;
}

test('CLI: factory steward and factory improve list / show / approve / reject', async () => {
  const { cmdSteward, cmdImprove } = await import('../src/cli/improve.js');
  const { dir } = await repoWithRecurringBuildFailure();
  const human = await capture(() => cmdSteward(['--dir', dir, '--executor', 'mock']));
  assert.match(human, /Steward pass .* over 3 run\(s\) — approval required/);
  assert.match(human, /Queued:/);
  const json = JSON.parse(await capture(() => cmdSteward(['--dir', dir, '--executor', 'mock', '--json'])));
  assert.equal(json.digest.runs, 3);
  const [p] = await listProposals(dir);
  assert.match(await capture(() => cmdImprove(['list', '--dir', dir])), new RegExp(p.id));
  assert.match(await capture(() => cmdImprove(['--dir', dir])), new RegExp(p.id), 'list is the default');
  const shown = await capture(() => cmdImprove(['show', p.id, '--dir', dir]));
  assert.match(shown, /evidence:/);
  assert.match(shown, /decider: approve/);
  assert.match(await capture(() => cmdImprove(['reject', p.id, '--dir', dir, '--reason', 'later'])), /rejected/);
  await assert.rejects(cmdImprove(['show', 'nope', '--dir', dir]), /usage/);
  await assert.rejects(cmdImprove(['frobnicate', '--dir', dir]), /unknown "factory improve frobnicate"/);
  const quiet = await capture(() => cmdSteward(['--dir', dir, '--no-analyze']));
  assert.match(quiet, /spend \$0/);
});
