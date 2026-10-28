/**
 * Outcome metrics (the lagging indicators of the Autonomy Maturity Model),
 * aggregated from pipeline run records (.factory/runs/<id>/run.json, as
 * returned by src/pipeline/store.js listRuns()).
 *
 * Pure function over run objects so it is trivially testable. Metrics the
 * run record does not capture (incident MTTR, change shelf-life) are
 * reported as null with an explanatory note — never fabricated.
 */

const COMPLETED = new Set(['passed', 'failed', 'cancelled']);

function minutesBetween(run) {
  const start = Date.parse(run.startedAt ?? '');
  const end = Date.parse(run.finishedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 60_000;
}

function isAutonomous(run) {
  if (run.status !== 'passed') return false;
  if ((run.reviewLoops ?? 0) !== 0) return false;
  const stages = run.stages ?? [];
  if (stages.length === 0) return false;
  return stages.every((s) => s.status === 'passed' && (s.attempts ?? []).length === 1);
}

export function aggregateOutcomes(runs) {
  const list = runs ?? [];
  const completed = list.filter((r) => COMPLETED.has(r.status));
  const passed = list.filter((r) => r.status === 'passed');
  const autonomous = completed.filter(isAutonomous);
  const cycles = completed.map(minutesBetween).filter((m) => m !== null);
  const totalCostUsd = list.reduce((sum, r) => sum + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);
  const sortedCycles = [...cycles].sort((a, b) => a - b);
  const median =
    sortedCycles.length === 0
      ? null
      : sortedCycles.length % 2 === 1
        ? sortedCycles[(sortedCycles.length - 1) / 2]
        : (sortedCycles[sortedCycles.length / 2 - 1] + sortedCycles[sortedCycles.length / 2]) / 2;
  return {
    totalRuns: list.length,
    completedRuns: completed.length,
    passedRuns: passed.length,
    autonomyRatio: completed.length === 0 ? null : autonomous.length / completed.length,
    autonomousRuns: autonomous.length,
    meanCycleMinutes: cycles.length === 0 ? null : cycles.reduce((a, b) => a + b, 0) / cycles.length,
    medianCycleMinutes: median,
    totalCostUsd,
    costPerChangeUsd: passed.length === 0 ? null : totalCostUsd / passed.length,
    totalReviewLoops: list.reduce((sum, r) => sum + (r.reviewLoops ?? 0), 0),
    mttrMinutes: null,
    notes:
      'Incident MTTR and change shelf-life are not recorded in run.json, so they are reported as null rather than estimated.',
  };
}
