import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { summarizeAudit } from '../harness/index.js';

/**
 * The deterministic evidence layer. It reads run records (and their harness audit logs
 * and review files) and produces facts: { id, value, unit, runs, label }. Every number a
 * proposal may cite comes from here; models reason over these facts and never add any.
 */

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'x';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const secs = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 1000) : 0);

/** BLOCKER/MAJOR finding lines from a REVIEW.md, normalized so recurrences match across runs. */
export function reviewFindings(md) {
  const out = new Set();
  for (const line of String(md ?? '').split('\n')) {
    if (!/^\s*[-*]\s/.test(line) || !/\b(BLOCKER|MAJOR)\b/.test(line)) continue;
    const norm = line
      .replace(/\b(BLOCKER|MAJOR)\b[:\]]*/, '')
      .replace(/`[^`]*`/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\b[\w./-]+\.(js|ts|py|md|json|tsx|jsx)(:\d+)?\b/g, '')
      .replace(/\d+/g, '')
      .replace(/[^a-z ]+/gi, ' ')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 8)
      .join(' ');
    if (norm.length >= 8) out.add(norm);
  }
  return [...out];
}

/** Per-run observations, before aggregation. */
export function runObservations(dir, run) {
  const obs = {
    id: run.id,
    status: run.status,
    costUsd: run.costUsd ?? 0,
    reviewLoops: run.reviewLoops ?? 0,
    stages: {},
    gateFails: new Set(),
    providers: {},
    fallbacks: 0,
  };
  for (const s of run.stages ?? []) {
    const attempts = s.attempts ?? [];
    const st = { attempts: attempts.length, cost: 0, retryCost: 0, seconds: 0, failed: s.status === 'failed' };
    attempts.forEach((a, i) => {
      st.cost += a.costUsd ?? 0;
      if (i > 0) st.retryCost += a.costUsd ?? 0;
      st.seconds += secs(a.startedAt, a.finishedAt);
      if (a.provider) obs.providers[a.provider] = (obs.providers[a.provider] ?? 0) + (a.costUsd ?? 0);
      obs.fallbacks += a.skipped?.length ?? 0;
      for (const c of a.gate ?? [])
        if (!c.ok && c.severity !== 'warn') obs.gateFails.add(`${s.id}:${slug(c.name.split(':')[0])}`);
    });
    obs.stages[s.id] = st;
  }
  obs.harness = dir ? summarizeAudit(path.join(dir, '.factory', 'runs', run.id, 'harness.jsonl')) : { refusedBy: {} };
  const review = dir && run.artifactDir ? path.join(dir, run.artifactDir, 'REVIEW.md') : null;
  obs.findings = review && existsSync(review) ? reviewFindings(readFileSync(review, 'utf8')) : [];
  obs.inspectorHolds = (run.inspection?.findings ?? []).filter((f) => !f.ok && f.level === 'hold').map((f) => f.check);
  obs.postReleaseFail = ['failure', 'timed_out', 'startup_failure'].includes(run.postRelease?.conclusion);
  return obs;
}

/**
 * Build the evidence pack from run records (newest first, as listRuns returns them).
 * Returns { generatedAt, runCount, facts: { [id]: fact }, patterns: [factId], window }.
 */
export function buildEvidence(runs, { dir = null, recurrenceMin = 3, now = new Date() } = {}) {
  const facts = {};
  const add = (id, unit, label, runId, by = 1) => {
    const f = (facts[id] ??= { id, value: 0, unit, label, runs: [] });
    f.value = round(f.value + by, unit === 'usd' ? 2 : unit === 'seconds' ? 0 : 2);
    if (runId && !f.runs.includes(runId)) f.runs.push(runId);
  };
  const finished = runs.filter((r) => r && r.status !== 'running');
  const observations = finished.map((r) => runObservations(dir, r));

  for (const o of observations) {
    add('runs:total', 'count', 'finished runs', o.id);
    add(`runs:${o.status}`, 'count', `${o.status} runs`, o.id);
    if (o.reviewLoops) add('review-loops', 'count', 'review rewinds to build', o.id, o.reviewLoops);
    for (const [stage, st] of Object.entries(o.stages)) {
      if (st.attempts > 1) add(`retries:${stage}`, 'count', `extra ${stage} attempts beyond the first`, o.id, st.attempts - 1);
      if (st.retryCost > 0) add(`retry-cost:${stage}`, 'usd', `USD spent on extra ${stage} attempts`, o.id, st.retryCost);
      if (st.cost > 0) add(`cost:${stage}`, 'usd', `USD spent in ${stage}`, o.id, st.cost);
      if (st.seconds > 0) add(`duration:${stage}`, 'seconds', `seconds spent in ${stage}`, o.id, st.seconds);
      if (st.failed) add(`stage-fail:${stage}`, 'count', `runs that failed at ${stage}`, o.id);
    }
    for (const g of o.gateFails) add(`gate-fail:${g}`, 'count', `runs where the ${g.replace(':', ' gate check ')} failed`, o.id);
    for (const [k, n] of Object.entries(o.harness.refusedBy ?? {}))
      add(`harness-refused:${k}`, 'count', `harness refusals for ${k.replace(':', ' calling ')}`, o.id, n);
    for (const f of o.findings) add(`review-finding:${slug(f)}`, 'count', `runs whose review raised: "${f}"`, o.id);
    for (const c of o.inspectorHolds) add(`inspector-hold:${c}`, 'count', `runs the Inspector held on ${c}`, o.id);
    for (const [p, usd] of Object.entries(o.providers)) {
      add(`provider-runs:${p}`, 'count', `runs that used ${p}`, o.id);
      if (usd > 0) add(`cost-provider:${p}`, 'usd', `USD spent on ${p}`, o.id, usd);
    }
    if (o.fallbacks) add('provider-fallbacks', 'count', 'times the router skipped an unavailable provider', o.id, o.fallbacks);
    if (o.postReleaseFail) add('post-release-fail', 'count', 'shipped runs followed by a failing main-branch CI', o.id);
  }

  const passed = observations.filter((o) => o.status === 'passed');
  const totalCost = round(observations.reduce((s, o) => s + o.costUsd, 0));
  if (observations.length)
    facts['cost:total'] = {
      id: 'cost:total',
      value: totalCost,
      unit: 'usd',
      label: 'total agent USD',
      runs: observations.map((o) => o.id),
    };
  if (passed.length) {
    facts['cost-per-passed-run'] = {
      id: 'cost-per-passed-run',
      value: round(totalCost / passed.length),
      unit: 'usd',
      label: 'total USD ÷ passed runs',
      runs: passed.map((o) => o.id),
    };
    // Trend: the newer half of the window against the older half.
    const half = Math.floor(observations.length / 2);
    if (half >= 1) {
      const per = (os) => {
        const p = os.filter((o) => o.status === 'passed').length;
        return p ? round(os.reduce((s, o) => s + o.costUsd, 0) / p) : null;
      };
      const recent = per(observations.slice(0, half));
      const earlier = per(observations.slice(half));
      if (recent !== null)
        facts['cost-per-passed-run:recent'] = {
          id: 'cost-per-passed-run:recent',
          value: recent,
          unit: 'usd',
          label: `cost per passed run, newest ${half} runs`,
          runs: observations.slice(0, half).map((o) => o.id),
        };
      if (earlier !== null)
        facts['cost-per-passed-run:earlier'] = {
          id: 'cost-per-passed-run:earlier',
          value: earlier,
          unit: 'usd',
          label: 'cost per passed run, older runs',
          runs: observations.slice(half).map((o) => o.id),
        };
    }
  }

  const RECURRING = /^(?:(?:gate-fail|review-finding|harness-refused|stage-fail|inspector-hold):|post-release-fail$)/;
  const patterns = Object.values(facts)
    .filter((f) => RECURRING.test(f.id) && f.runs.length >= recurrenceMin)
    .sort((a, b) => b.runs.length - a.runs.length || a.id.localeCompare(b.id))
    .map((f) => f.id);

  return {
    generatedAt: now.toISOString(),
    runCount: observations.length,
    recurrenceMin,
    facts,
    patterns,
    window: observations.map((o) => o.id),
  };
}

/** Deterministic priority for a proposal: recurrence × (1 + cost cited) × recency, 0-100. */
export function evidenceScore(proposal, evidence) {
  const cited = (proposal.claims ?? []).map((c) => evidence.facts[c.fact]).filter(Boolean);
  if (!cited.length || !evidence.runCount) return 0;
  const recurrence = Math.max(...cited.map((f) => f.runs.length)) / evidence.runCount;
  const usd = cited.filter((f) => f.unit === 'usd').reduce((s, f) => s + f.value, 0);
  const newest = new Set(evidence.window.slice(0, Math.max(1, Math.ceil(evidence.window.length / 3))));
  const recency = cited.some((f) => f.runs.some((r) => newest.has(r))) ? 1 : 0.5;
  return Math.round(Math.min(100, 100 * recurrence * recency * (1 + Math.min(usd, 10) / 10)));
}
