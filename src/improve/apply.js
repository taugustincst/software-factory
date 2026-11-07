import { run as exec } from '../util.js';
import { readProposal, saveProposal, setStatus, appendAudit } from './store.js';

/**
 * Human decisions and applying. An approved proposal becomes an ordinary factory run, so the
 * change goes through spec → plan → build → test → review → ship like any other and lands as
 * its own commit on its own factory/ branch. Reverting is `git revert` of that commit.
 */

/** The factory run request an approved proposal turns into. */
export function proposalRequest(p) {
  return [
    `# ${p.title}`,
    '',
    `Improvement proposal ${p.id} from the factory's self-improvement loop (approved by ${p.approval?.by ?? 'a human'}).`,
    '',
    '## Change',
    p.change,
    '',
    '## Targets',
    ...p.targets.map((t) => `- \`${t}\``),
    '',
    '## Evidence',
    ...p.claims.map((c) => `- ${c.text} (fact \`${c.fact}\` = ${c.value})`),
    '',
    '## Why',
    p.lesson,
    '',
    'Keep the change to the targets above. Do not weaken any test, gate or guard to make this pass.',
  ].join('\n');
}

async function load(dir, id) {
  const p = await readProposal(dir, id);
  if (!p) throw Object.assign(new Error(`proposal ${id} not found`), { status: 404 });
  return p;
}

const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });

/** Tj's approval (or rejection). Always-human and everything else alike are allowed here. */
export async function decideProposal(dir, id, { approve, by = 'human', reason = '' }) {
  const p = await load(dir, id);
  if (!['open', 'recommended', 'needs-evidence'].includes(p.status)) throw conflict(`proposal ${id} is ${p.status}`);
  if (approve) {
    p.approval = { by, mode: 'human', at: new Date().toISOString(), reason };
    setStatus(p, 'approved', reason || 'approved', by);
  } else {
    setStatus(p, 'rejected', reason || 'rejected', by);
  }
  await saveProposal(dir, p);
  await appendAudit(dir, {
    proposal: id,
    title: p.title,
    risk: p.risk,
    outcome: approve ? 'human-approved' : 'human-rejected',
    by,
    reason,
    evidence: p.claims,
    decider: p.decision,
  });
  return p;
}

/**
 * Start applying an approved proposal: `launch({ request })` starts a factory run and
 * returns its id (the dashboard spawns a detached run; the CLI runs it inline).
 */
export async function startApply(dir, id, launch) {
  const p = await load(dir, id);
  if (p.status !== 'approved') throw conflict(`proposal ${id} is ${p.status}; only approved proposals can be applied`);
  const runId = await launch({ request: proposalRequest(p), proposalId: id });
  p.apply = { runId, startedAt: new Date().toISOString() };
  setStatus(p, 'applying', `factory run ${runId} started`, p.approval?.by ?? null);
  await saveProposal(dir, p);
  return p;
}

/** Revert an applied proposal's commit with `git revert` (needs a clean working tree). */
export async function revertProposal(dir, id, { by = 'human' } = {}) {
  const p = await load(dir, id);
  if (p.status !== 'applied' || !p.apply?.commit)
    throw conflict(`proposal ${id} is ${p.status}; only applied proposals with a commit can be reverted`);
  if (!/^[0-9a-f]{40}$/.test(p.apply.commit)) throw conflict('recorded commit is not a full SHA');
  const status = await exec(['git', 'status', '--porcelain'], { cwd: dir });
  if (status.stdout.trim()) throw conflict('working tree has uncommitted changes; commit or stash them before reverting');
  const r = await exec(['git', 'revert', '--no-edit', p.apply.commit], { cwd: dir });
  if (r.code !== 0) {
    await exec(['git', 'revert', '--abort'], { cwd: dir });
    throw conflict(`git revert failed: ${r.stderr.trim().slice(-500)}`);
  }
  const head = (await exec(['git', 'rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  p.apply.revertCommit = head;
  setStatus(p, 'reverted', `reverted by ${head.slice(0, 7)}`, by);
  await saveProposal(dir, p);
  await appendAudit(dir, { proposal: id, title: p.title, outcome: 'reverted', by, commit: p.apply.commit, revertCommit: head });
  return p;
}
