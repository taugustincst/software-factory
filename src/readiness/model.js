/**
 * Autonomy Maturity Model constants: the eight pillars, the points earned
 * per maturity level, and the signal factory used by both catalog files
 * (signals.js for pillars 1-4, signals-extended.js for pillars 5-8).
 */

export const PILLARS = {
  1: 'Style & Validation',
  2: 'Build System',
  3: 'Testing',
  4: 'Documentation & Instructions',
  5: 'Dev Environment & Remote Execution',
  6: 'Code Quality',
  7: 'Debugging & Observability',
  8: 'Security & Governance',
};

/** Points earned for a passed signal, by its maturity level. */
export const POINTS_BY_LEVEL = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };

export function sig(id, pillar, level, title, remediation, check) {
  return { id, pillar, level, points: POINTS_BY_LEVEL[level], title, remediation, check };
}
