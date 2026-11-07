import { isProtectedPath } from '../../claude-kit/.claude/hooks/lib/patterns.mjs';

/**
 * Role scopes. A scope is a set of capabilities plus, for `write`, an optional list of
 * repo-relative path prefixes it is confined to (null = anywhere not protected).
 * `{artifactDir}` is substituted with the run's artifact folder.
 */
export const CAPABILITIES = ['read', 'git-read', 'write', 'exec', 'git-write', 'pr', 'spawn'];

export const ROLES = {
  decision: { capabilities: ['read', 'git-read'], writeRoots: [] },
  author: { capabilities: ['read', 'git-read', 'write', 'spawn'], writeRoots: ['{artifactDir}'] },
  reviewer: { capabilities: ['read', 'git-read', 'exec', 'write', 'spawn'], writeRoots: ['{artifactDir}'] },
  generative: { capabilities: ['read', 'git-read', 'write'], writeRoots: ['.factory/improvements'] },
  implementer: { capabilities: ['read', 'git-read', 'write', 'exec', 'spawn'], writeRoots: null },
  steward: { capabilities: ['read', 'git-read', 'write'], writeRoots: ['.factory/improvements'] },
  inspector: { capabilities: ['read', 'git-read', 'exec'], writeRoots: [] },
  shipper: { capabilities: ['read', 'git-read', 'git-write', 'pr'], writeRoots: [] },
};

/** Which role each pipeline stage runs under. */
export const STAGE_ROLES = {
  spec: 'author',
  plan: 'author',
  build: 'implementer',
  test: 'implementer',
  review: 'reviewer',
  inspect: 'inspector',
  ship: 'shipper',
  improve: 'generative',
  decide: 'decision',
  steward: 'steward',
};

// Never writable by any role: run state and the decision audit trail are evidence.
const ALWAYS_DENIED = [
  /^\.git(\/|$)/,
  /^\.factory\/runs(\/|$)/,
  /^\.factory\/improvements\/audit\.jsonl$/,
  /^\.factory\/harness(\/|$)/,
];

const norm = (p) =>
  String(p)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');

/** Build a concrete scope for a role. */
export function scopeFor(role, { artifactDir = null } = {}) {
  const def = ROLES[role];
  if (!def) throw new Error(`unknown harness role: ${role}`);
  const writeRoots =
    def.writeRoots === null
      ? null
      : def.writeRoots
          .map((r) => (r === '{artifactDir}' ? artifactDir : r))
          .filter((r) => r !== null)
          .map(norm);
  return { role, capabilities: [...def.capabilities], writeRoots };
}

/**
 * A sub-agent's scope: the intersection of what the parent holds and what is asked for.
 * A child never gains a capability or a write root outside its parent's.
 */
export function deriveScope(parent, requested = {}) {
  const want = requested.capabilities ?? parent.capabilities;
  const capabilities = want.filter((c) => parent.capabilities.includes(c));
  let writeRoots;
  const asked = requested.writeRoots === undefined ? parent.writeRoots : requested.writeRoots;
  if (parent.writeRoots === null) writeRoots = asked === null ? null : asked.map(norm);
  else if (asked === null) writeRoots = [...parent.writeRoots];
  else writeRoots = asked.map(norm).filter((r) => parent.writeRoots.some((p) => r === p || r.startsWith(`${p}/`)));
  return { role: requested.role ?? `${parent.role}/sub`, capabilities, writeRoots };
}

export function allows(scope, capability) {
  return scope.capabilities.includes(capability);
}

/** Reason a write to repo-relative `rel` is refused under `scope`, or null if allowed. */
export function writeRefusal(scope, rel) {
  const p = norm(rel);
  if (!allows(scope, 'write')) return `role ${scope.role} cannot write files`;
  if (ALWAYS_DENIED.some((re) => re.test(p))) return `${p} is factory state; no role may write it`;
  const prot = isProtectedPath(p);
  if (prot) return prot;
  if (scope.writeRoots !== null && !scope.writeRoots.some((r) => p === r || p.startsWith(`${r}/`)))
    return `role ${scope.role} may only write under: ${scope.writeRoots.join(', ') || '(nowhere)'}`;
  return null;
}
