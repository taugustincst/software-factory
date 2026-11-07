import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { run as exec } from '../util.js';
import { loadProject } from '../pipeline/project.js';
import { listRuns, readRun } from '../pipeline/store.js';
import { createHarness, DEFAULT_EXEC } from '../harness/index.js';
import { resolveConfig } from './config.js';
import { buildEvidence, evidenceScore } from './evidence.js';
import { validateProposal } from './validate.js';
import { computeRisk, approvalAction } from './approval.js';
import { IMPROVE_STAGE, DECIDE_STAGE, parseDecisions } from './roles.js';
import {
  improvementsDir,
  listProposals,
  saveProposal,
  upsertProposal,
  setStatus,
  appendAudit,
  writeDigest,
  newPassId,
  ACTIVE,
} from './store.js';

const WINDOW = 50;

/** Agent context for an improvement-loop role: harness-scoped, rooted at the repo. */
function roleCtx({ dir, stage, project, auditFile, extra }) {
  const rel = (p) => path.relative(dir, p).split(path.sep).join('/');
  const harnessConfig = {
    root: dir,
    role: stage.role,
    commands: project.commands,
    exec: project.config?.harness?.exec ?? DEFAULT_EXEC,
    auditFile,
  };
  return { dir, rel, harnessConfig, harness: createHarness(harnessConfig), ...extra };
}

/** Move proposals whose apply run has finished to applied or failed. */
async function reconcile(dir, proposals) {
  const changed = [];
  for (const p of proposals) {
    if (p.status !== 'applying' || !p.apply?.runId) continue;
    const run = await readRun(dir, p.apply.runId).catch(() => null);
    if (!run || run.status === 'running' || run.status === 'paused') continue;
    if (run.status === 'passed') {
      let commit = null;
      if (run.branch) {
        const r = await exec(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${run.branch}`], { cwd: dir });
        commit = r.code === 0 ? r.stdout.trim() : null;
      }
      Object.assign(p.apply, { branch: run.branch, commit, prUrl: run.prUrl ?? null, finishedAt: run.finishedAt });
      setStatus(p, 'applied', `run ${run.id} passed${run.branch ? ` on ${run.branch}` : ''}`);
    } else {
      setStatus(p, 'failed', `run ${run.id} ${run.status}${run.error ? `: ${run.error}` : ''}`);
    }
    await saveProposal(dir, p);
    changed.push(p.id);
  }
  return changed;
}

/**
 * One Steward pass over a repository's run store.
 *   analyze=false: deterministic only — evidence, reconcile, re-score, retire, digest. No spend.
 *   analyze=true:  also the generative model (draft) → citation gate → decision model (rank)
 *                  → approval regime. Needs an executor.
 * Never throws for a model failure: the pass report says what happened.
 */
export async function stewardPass({ dir, executor = null, analyze = false, now = new Date(), log = () => {} }) {
  dir = path.resolve(dir);
  const project = await loadProject(dir);
  const { improvement: cfg, warnings } = resolveConfig(project.config);
  const runs = (await listRuns(dir)).filter((r) => r.status !== 'running').slice(0, WINDOW);
  const evidence = buildEvidence(runs, { dir, recurrenceMin: cfg.recurrenceMin, now });
  const passId = newPassId(now);
  const work = path.join(improvementsDir(dir), 'work', passId);
  await fs.mkdir(work, { recursive: true });
  const evidenceFile = path.join(work, 'evidence.json');
  await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  const report = {
    passId,
    analyze,
    created: [],
    refreshed: [],
    retired: [],
    reconciled: [],
    rejectedDrafts: [],
    decided: [],
    autoApproved: [],
    spendUsd: 0,
    errors: [],
    warnings,
  };

  let proposals = await listProposals(dir);
  report.reconciled = await reconcile(dir, proposals);

  // Re-score what is open against current evidence; retire what has stopped recurring.
  const recent = new Set(evidence.window.slice(0, cfg.staleAfterRuns));
  for (const p of proposals.filter((x) => ['open', 'recommended', 'needs-evidence'].includes(x.status))) {
    p.score = evidenceScore(p, evidence);
    const facts = (p.claims ?? []).map((c) => evidence.facts[c.fact]).filter(Boolean);
    const stillSeen = facts.some((f) => f.runs.some((r) => recent.has(r)));
    if (evidence.runCount >= cfg.staleAfterRuns && !stillSeen) {
      setStatus(p, 'retired', `cited evidence has not recurred in the last ${cfg.staleAfterRuns} runs`, 'steward');
      report.retired.push(p.id);
    }
    await saveProposal(dir, p);
  }

  if (analyze && executor && evidence.runCount > 0) {
    const auditFile = path.join(improvementsDir(dir), 'harness.jsonl');
    const proposalsFile = path.join(work, 'proposals.json');
    proposals = await listProposals(dir);
    // 1. Generative model drafts.
    try {
      const ctx = roleCtx({
        dir,
        stage: IMPROVE_STAGE,
        project,
        auditFile,
        extra: {
          evidenceFile,
          proposalsFile,
          maxProposals: cfg.maxProposalsPerRun,
          open: proposals.filter((p) => ACTIVE.has(p.status)),
        },
      });
      const r = await executor.run({ stage: IMPROVE_STAGE, prompt: IMPROVE_STAGE.prompt(ctx), dir, ctx });
      report.spendUsd += r.costUsd ?? 0;
      if (!r.ok && r.error) report.errors.push(`improver: ${r.error}`);
    } catch (err) {
      report.errors.push(`improver: ${err.message}`);
    }
    let drafts = [];
    if (existsSync(proposalsFile)) {
      try {
        const parsed = JSON.parse(await fs.readFile(proposalsFile, 'utf8'));
        drafts = Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        report.errors.push(`improver output is not JSON: ${err.message}`);
      }
    }
    // 2. Citation gate, then backlog.
    const touched = [];
    for (const d of drafts.slice(0, cfg.maxProposalsPerRun)) {
      const v = validateProposal(d, evidence);
      if (!v.ok) {
        report.rejectedDrafts.push({ title: String(d?.title ?? '(untitled)').slice(0, 140), errors: v.errors });
        continue;
      }
      const { proposal, created } = await upsertProposal(dir, v.proposal, {
        score: evidenceScore(v.proposal, evidence),
        newestRun: evidence.window[0],
        passId,
      });
      proposal.risk = computeRisk(proposal);
      await saveProposal(dir, proposal);
      (created ? report.created : report.refreshed).push(proposal.id);
      touched.push(proposal);
    }
    await fs.writeFile(path.join(work, 'rejected.json'), `${JSON.stringify(report.rejectedDrafts, null, 2)}\n`);
    // 3. Decision model ranks what this pass drafted or refreshed — if budget remains.
    if (touched.length && report.spendUsd < cfg.maxUsdPerPass) {
      try {
        const ctx = roleCtx({ dir, stage: DECIDE_STAGE, project, auditFile, extra: { evidenceFile, proposals: touched } });
        const r = await executor.run({ stage: DECIDE_STAGE, prompt: DECIDE_STAGE.prompt(ctx), dir, ctx });
        report.spendUsd += r.costUsd ?? 0;
        const decisions = parseDecisions(r.summary);
        if (!decisions.length) report.errors.push('decider returned no usable decisions');
        const approval = cfg.approval;
        for (const p of touched) {
          const d = decisions.find((x) => x.id === p.id);
          if (!d) continue;
          p.decision = { ...d, at: new Date().toISOString() };
          if (d.score !== null) p.score = Math.round((p.score + d.score) / 2);
          const act = approvalAction(p, d, approval);
          p.risk = act.risk;
          if (act.action === 'apply') {
            p.approval = { by: 'auto', mode: approval.mode, at: new Date().toISOString(), reason: act.reason };
            setStatus(p, 'approved', act.reason, 'auto');
            report.autoApproved.push(p.id);
          } else if (act.action === 'reject' && approval.mode === 'auto') {
            setStatus(p, 'rejected', act.reason, 'decider');
          } else {
            setStatus(
              p,
              d.verdict === 'approve' ? 'recommended' : d.verdict === 'needs-evidence' ? 'needs-evidence' : 'open',
              `decider: ${d.verdict} (${d.score ?? '–'})`,
              'decider',
            );
          }
          await saveProposal(dir, p);
          await appendAudit(dir, {
            pass: passId,
            proposal: p.id,
            title: p.title,
            risk: p.risk,
            mode: approval.mode,
            decider: d,
            outcome:
              act.action === 'apply'
                ? 'auto-approved'
                : act.action === 'reject' && approval.mode === 'auto'
                  ? 'auto-rejected'
                  : 'awaiting-human',
            reason: act.reason,
            evidence: p.claims,
          });
          report.decided.push(p.id);
        }
      } catch (err) {
        report.errors.push(`decider: ${err.message}`);
      }
    }
  }

  const digest = await buildDigest(dir, { evidence, report, cfg, now });
  await writeDigest(dir, digest);
  await fs.writeFile(path.join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  log(
    `Steward pass ${passId}: ${report.created.length} new, ${report.refreshed.length} refreshed, ${report.retired.length} retired, ${report.autoApproved.length} auto-approved`,
  );
  return { evidence, report, digest };
}

/** The improvement & efficiency digest the dashboard shows. Numbers come from evidence only. */
export async function buildDigest(dir, { evidence, report, cfg, now = new Date() }) {
  const all = await listProposals(dir);
  const f = (id) => evidence.facts[id]?.value ?? null;
  const stageCost = Object.values(evidence.facts)
    .filter((x) => /^cost:(?!total$)/.test(x.id))
    .sort((a, b) => b.value - a.value)
    .map((x) => ({ stage: x.id.slice(5), usd: x.value }));
  const retryWaste = Object.values(evidence.facts)
    .filter((x) => x.id.startsWith('retry-cost:'))
    .reduce((s, x) => s + x.value, 0);
  const proposed = new Set(all.flatMap((p) => (p.claims ?? []).map((c) => c.fact)));
  const short = (p) => ({ id: p.id, title: p.title, status: p.status, risk: p.risk, score: p.score, by: p.approval?.by ?? null });
  return {
    at: now.toISOString(),
    pass: report.passId,
    approval: cfg.approval,
    runs: evidence.runCount,
    efficiency: {
      costPerPassedRun: f('cost-per-passed-run'),
      trend: { recent: f('cost-per-passed-run:recent'), earlier: f('cost-per-passed-run:earlier') },
      totalUsd: f('cost:total'),
      retryWasteUsd: Math.round(retryWaste * 100) / 100,
      reviewLoops: f('review-loops') ?? 0,
      costByStage: stageCost.slice(0, 6),
    },
    applied: all
      .filter((p) => ['applied', 'approved', 'applying'].includes(p.status))
      .slice(0, 10)
      .map(short),
    queued: all
      .filter((p) => ['open', 'recommended', 'needs-evidence'].includes(p.status))
      .slice(0, 10)
      .map(short),
    watching: evidence.patterns
      .filter((id) => !proposed.has(id))
      .map((id) => ({ fact: id, label: evidence.facts[id].label, runs: evidence.facts[id].runs.length })),
    thisPass: {
      analyze: report.analyze,
      created: report.created.length,
      refreshed: report.refreshed.length,
      retired: report.retired.length,
      rejectedDrafts: report.rejectedDrafts.length,
      autoApproved: report.autoApproved.length,
      spendUsd: Math.round(report.spendUsd * 100) / 100,
      errors: report.errors,
    },
    warnings: report.warnings,
  };
}
