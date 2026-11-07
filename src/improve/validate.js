/**
 * The citation gate. A proposal passes only if every claim cites a fact that exists in the
 * evidence pack and states that fact's value exactly. The model reasons over evidence; it
 * never supplies a number of its own. Returns { ok, errors, proposal } with a normalized copy.
 */

export const KINDS = ['kit-prompt', 'gate', 'template', 'efficiency', 'docs'];

const TARGET_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w@.+-]+(?:\/[\w@.+*-]+)*$/;

export function validateProposal(p, evidence) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['proposal is not an object'], proposal: null };
  const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!str(p.title, 140)) errors.push('title: 1-140 characters required');
  if (!KINDS.includes(p.kind)) errors.push(`kind: must be one of ${KINDS.join(', ')}`);
  if (!str(p.lesson, 4000)) errors.push('lesson: required (why this keeps happening)');
  if (!str(p.change, 8000)) errors.push('change: required (what to change)');
  const targets = Array.isArray(p.targets) ? p.targets : [];
  if (targets.length === 0 || targets.length > 20) errors.push('targets: 1-20 repo-relative paths required');
  for (const t of targets)
    if (typeof t !== 'string' || !TARGET_RE.test(t)) errors.push(`targets: "${t}" is not a repo-relative path`);

  const claims = Array.isArray(p.claims) ? p.claims : [];
  if (claims.length === 0) errors.push('claims: at least one evidence-backed claim is required');
  for (const [i, c] of claims.entries()) {
    const fact = evidence.facts[c?.fact];
    if (!str(c?.text, 500)) errors.push(`claims[${i}].text: required`);
    if (!fact) {
      errors.push(`claims[${i}]: cites "${c?.fact}", which is not in the evidence pack`);
      continue;
    }
    if (c.value !== fact.value) errors.push(`claims[${i}]: says ${c.fact} = ${c.value}, the evidence says ${fact.value}`);
  }

  if (p.kind === 'efficiency') {
    const s = p.expectedSavings;
    const base = evidence.facts[s?.fact];
    if (!base) errors.push('expectedSavings: an efficiency proposal must name the measured cost or duration fact it reduces');
    else if (!['usd', 'seconds'].includes(base.unit)) errors.push(`expectedSavings: ${s.fact} is not a cost or duration fact`);
    else {
      const amount = base.unit === 'usd' ? s.usd : s.seconds;
      if (typeof amount !== 'number' || amount <= 0 || amount > base.value)
        errors.push(`expectedSavings: must be a positive ${base.unit} amount no larger than the measured ${base.value}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    proposal: {
      title: String(p.title ?? '').trim(),
      kind: p.kind,
      targets: [...new Set(targets)].sort(),
      lesson: String(p.lesson ?? '').trim(),
      change: String(p.change ?? '').trim(),
      claims: claims.map((c) => ({ text: String(c?.text ?? ''), fact: c?.fact, value: c?.value })),
      expectedSavings: p.expectedSavings ?? null,
    },
  };
}
