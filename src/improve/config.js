/**
 * The embedded roles' configuration, read from factory.json with defaults. Unknown or
 * invalid values fall back to the safe default (never to a looser one) and are reported.
 */

export const RISK_LEVELS = ['low', 'medium', 'always-human'];

export const DEFAULTS = Object.freeze({
  models: { generative: null, decision: null },
  improvement: {
    afterRun: 'evidence',
    recurrenceMin: 3,
    maxProposalsPerRun: 3,
    staleAfterRuns: 10,
    maxUsdPerPass: 2,
    approval: { mode: 'required', autoMaxRisk: 'low' },
  },
});

const pick = (value, allowed, fallback, name, warnings) => {
  if (value === undefined) return fallback;
  if (allowed.includes(value)) return value;
  warnings.push(`${name}: "${value}" is not one of ${allowed.join(' | ')}; using "${fallback}"`);
  return fallback;
};

const posInt = (value, fallback, name, warnings, max = 1000) => {
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && value >= 1 && value <= max) return value;
  warnings.push(`${name}: must be an integer 1-${max}; using ${fallback}`);
  return fallback;
};

/** Resolve { models, improvement, warnings } from a parsed factory.json (or {}). */
export function resolveConfig(cfg = {}) {
  const warnings = [];
  const d = DEFAULTS.improvement;
  const imp = cfg.improvement ?? {};
  const appr = imp.approval ?? {};
  const mode = pick(appr.mode, ['required', 'auto'], d.approval.mode, 'improvement.approval.mode', warnings);
  // The auto ceiling can never reach always-human: those classes are unreachable by design.
  const autoMaxRisk = pick(
    appr.autoMaxRisk,
    ['low', 'medium'],
    d.approval.autoMaxRisk,
    'improvement.approval.autoMaxRisk',
    warnings,
  );
  const usd = imp.maxUsdPerPass;
  const maxUsdPerPass =
    usd === undefined
      ? d.maxUsdPerPass
      : typeof usd === 'number' && usd >= 0 && usd <= 100
        ? usd
        : (warnings.push('improvement.maxUsdPerPass: must be 0-100; using 2'), d.maxUsdPerPass);
  const model = (v, name) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string' && /^[\w.:@/-]{1,100}$/.test(v)) return v;
    warnings.push(`models.${name}: not a model name; using the executor default`);
    return null;
  };
  return {
    models: { generative: model(cfg.models?.generative, 'generative'), decision: model(cfg.models?.decision, 'decision') },
    improvement: {
      afterRun: pick(imp.afterRun, ['evidence', 'analyze', 'off'], d.afterRun, 'improvement.afterRun', warnings),
      recurrenceMin: posInt(imp.recurrenceMin, d.recurrenceMin, 'improvement.recurrenceMin', warnings, 100),
      maxProposalsPerRun: posInt(imp.maxProposalsPerRun, d.maxProposalsPerRun, 'improvement.maxProposalsPerRun', warnings, 20),
      staleAfterRuns: posInt(imp.staleAfterRuns, d.staleAfterRuns, 'improvement.staleAfterRuns', warnings),
      maxUsdPerPass,
      approval: { mode, autoMaxRisk },
    },
    warnings,
  };
}
