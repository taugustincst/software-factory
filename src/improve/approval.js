import { RISK_LEVELS } from './config.js';

/**
 * Computed risk and the approval regime. Risk comes from fixed tables over a proposal's
 * kind and targets; no model output can lower it. `always-human` is unreachable by `auto`.
 */

const ALWAYS_HUMAN = [
  /^src\/pipeline\/gates\.js$/,
  /^claude-kit\/\.claude\/hooks\//,
  /^\.claude\/hooks\//,
  /^\.claude\/settings(\.local)?\.json$/,
  /^src\/harness\//,
  /^src\/improve\/approval\.js$/,
  /^src\/inspect\//,
  /^\.github\//,
  /^\.githooks\//,
  /(^|\/)release-please[^/]*$/,
  /(^|\/)\.release-please-manifest\.json$/,
  /(^|\/)CHANGELOG\.md$/i,
  /(^|\/)SECURITY\.md$/i,
  /^docs\/threat-model\.md$/,
  /(^|\/)factory\.json$/,
  /^schema\//,
  /(^|\/)package(-lock)?\.json$/,
];
const LOW = [/^docs\//, /^(claude-kit\/)?\.claude\/(agents|commands|skills)\/.+\.md$/, /^[^/]+\.md$/];
const KIND_RISK = { docs: 'low', 'kit-prompt': 'low', template: 'medium', efficiency: 'medium', gate: 'always-human' };

const rank = (r) => RISK_LEVELS.indexOf(r);
const max = (a, b) => (rank(a) >= rank(b) ? a : b);

export function targetRisk(target) {
  const t = String(target).replace(/\\/g, '/').replace(/^\.\//, '');
  if (ALWAYS_HUMAN.some((re) => re.test(t))) return 'always-human';
  if (LOW.some((re) => re.test(t))) return 'low';
  return 'medium';
}

/** The proposal's risk class: the highest of its kind's class and every target's class. */
export function computeRisk(proposal) {
  let risk = KIND_RISK[proposal.kind] ?? 'medium';
  for (const t of proposal.targets ?? []) risk = max(risk, targetRisk(t));
  return risk;
}

/**
 * What the regime does with a proposal the citation gate accepted:
 *   { action: 'apply' | 'await-human' | 'reject', by, reason }
 * `decision` is the decider's { verdict, score, reasoning }.
 */
export function approvalAction(proposal, decision, approval) {
  const risk = computeRisk(proposal);
  if (decision?.verdict === 'reject') return { action: 'reject', by: 'decider', risk, reason: 'the decision model rejected it' };
  if (approval.mode !== 'auto')
    return { action: 'await-human', by: null, risk, reason: 'approval mode is required: Tj approves every proposal' };
  if (risk === 'always-human')
    return { action: 'await-human', by: null, risk, reason: 'always-human class: auto mode cannot approve it at any ceiling' };
  if (rank(risk) > rank(approval.autoMaxRisk))
    return { action: 'await-human', by: null, risk, reason: `risk ${risk} is above the auto ceiling (${approval.autoMaxRisk})` };
  if (decision?.verdict !== 'approve')
    return { action: 'await-human', by: null, risk, reason: `the decision model said ${decision?.verdict ?? 'nothing'}` };
  return { action: 'apply', by: 'auto', risk, reason: `auto mode, risk ${risk} ≤ ${approval.autoMaxRisk}, decider approved` };
}
