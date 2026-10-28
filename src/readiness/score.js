import path from 'node:path';
import { buildContext, PILLARS, POINTS_BY_LEVEL, SIGNALS } from './signals.js';

export { POINTS_BY_LEVEL };

/** Cumulative score thresholds per level (Autonomy Maturity Model). */
export const LEVEL_THRESHOLDS = { 1: 5, 2: 19, 3: 36, 4: 60, 5: 100 };

/** The "agent-ready" bar: Level 3 is the minimum production-grade level. */
export const AGENT_READY_LEVEL = 3;

export function levelForScore(score) {
  let level = 0;
  for (const [lvl, threshold] of Object.entries(LEVEL_THRESHOLDS)) {
    if (score >= threshold) level = Number(lvl);
  }
  return level;
}

/**
 * Score one repository against the signal catalog.
 * Returns { dir, name, score, level, agentReady, pillars, results, remediation }.
 */
export async function scoreRepo(dir) {
  const ctx = await buildContext(dir);
  const results = [];
  for (const signal of SIGNALS) {
    // A probe that cannot run counts as absent, never as an error. Checks may
    // be sync or async, so normalise through Promise.resolve().
    const pass = await Promise.resolve()
      .then(() => signal.check(ctx))
      .then(Boolean)
      .catch(() => false);
    results.push({ signal, pass });
  }
  const pillars = {};
  for (const [num, name] of Object.entries(PILLARS)) {
    pillars[num] = { name, score: 0, earned: [], missing: [] };
  }
  let score = 0;
  for (const { signal, pass } of results) {
    const pillar = pillars[signal.pillar];
    if (pass) {
      score += signal.points;
      pillar.score += signal.points;
      pillar.earned.push(signal.id);
    } else {
      pillar.missing.push(signal.id);
    }
  }
  const level = levelForScore(score);
  const remediation = results
    .filter((r) => !r.pass)
    .map((r) => r.signal)
    .sort((a, b) => a.level - b.level || b.points - a.points || a.id.localeCompare(b.id));
  return {
    dir: ctx.dir,
    name: ctx.factoryJson.name ?? path.basename(ctx.dir),
    score,
    level,
    agentReady: level >= AGENT_READY_LEVEL,
    pillars,
    results,
    remediation,
  };
}

/** Headline organisational metric: the share of active repos at Level 3+. */
export function orgReadiness(reports) {
  const total = reports.length;
  const ready = reports.filter((r) => r.agentReady).length;
  return { total, ready, pct: total === 0 ? 0 : Math.round((ready / total) * 1000) / 10 };
}
