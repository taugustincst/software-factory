import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * The improvement backlog: .factory/improvements/
 *   proposals/<id>.json   one file per proposal, with its state and history
 *   audit.jsonl           every approval decision, human or automatic (append-only)
 *   digest.json           the Steward's latest improvement & efficiency digest
 *   work/<pass>/          evidence pack and model output for one Steward pass
 */

export const PROPOSAL_ID_RE = /^P-[0-9a-f]{8}$/;
export const STATUSES = [
  'open',
  'recommended',
  'needs-evidence',
  'approved',
  'applying',
  'applied',
  'failed',
  'rejected',
  'retired',
  'reverted',
];
export const ACTIVE = new Set(['open', 'recommended', 'needs-evidence', 'approved', 'applying']);

export const improvementsDir = (dir) => path.join(dir, '.factory', 'improvements');
const proposalsDir = (dir) => path.join(improvementsDir(dir), 'proposals');

export function fingerprint(p) {
  const key = JSON.stringify([p.kind, [...(p.targets ?? [])].sort(), [...new Set((p.claims ?? []).map((c) => c.fact))].sort()]);
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(tmp, file);
}

export async function readProposal(dir, id) {
  if (!PROPOSAL_ID_RE.test(id)) throw new Error(`invalid proposal id: ${id}`);
  const file = path.join(proposalsDir(dir), `${id}.json`);
  return existsSync(file) ? JSON.parse(await fs.readFile(file, 'utf8')) : null;
}

export async function saveProposal(dir, p) {
  if (!PROPOSAL_ID_RE.test(p.id)) throw new Error(`invalid proposal id: ${p.id}`);
  p.updatedAt = new Date().toISOString();
  await writeAtomic(path.join(proposalsDir(dir), `${p.id}.json`), p);
  return p;
}

/** All proposals, best first: active before closed, then by score. */
export async function listProposals(dir) {
  const base = proposalsDir(dir);
  if (!existsSync(base)) return [];
  const files = (await fs.readdir(base)).filter((f) => PROPOSAL_ID_RE.test(f.replace(/\.json$/, '')) && f.endsWith('.json'));
  const all = (
    await Promise.all(
      files.map((f) =>
        fs
          .readFile(path.join(base, f), 'utf8')
          .then(JSON.parse)
          .catch(() => null),
      ),
    )
  ).filter(Boolean);
  return all.sort(
    (a, b) =>
      Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id),
  );
}

export function setStatus(p, status, note, by = null) {
  if (!STATUSES.includes(status)) throw new Error(`unknown proposal status: ${status}`);
  p.status = status;
  (p.history ??= []).push({ at: new Date().toISOString(), status, note, by });
  return p;
}

/**
 * Add a validated proposal to the backlog, or refresh the matching one. A proposal matches
 * an existing one with the same fingerprint that is still active or was rejected (a
 * rejected idea is not re-raised just because its evidence recurs).
 * Returns { proposal, created }.
 */
export async function upsertProposal(dir, validated, { score, newestRun, passId }) {
  const fp = fingerprint(validated);
  const existing = (await listProposals(dir)).find(
    (p) => p.fingerprint === fp && (ACTIVE.has(p.status) || p.status === 'rejected'),
  );
  if (existing) {
    Object.assign(existing, { claims: validated.claims, score, lastEvidenceRun: newestRun, lastPass: passId });
    existing.seen = (existing.seen ?? 1) + 1;
    (existing.history ??= []).push({
      at: new Date().toISOString(),
      status: existing.status,
      note: `evidence refreshed in pass ${passId}`,
    });
    return { proposal: await saveProposal(dir, existing), created: false };
  }
  const now = new Date().toISOString();
  const p = {
    id: `P-${randomBytes(4).toString('hex')}`,
    fingerprint: fp,
    ...validated,
    risk: null,
    score,
    status: 'open',
    seen: 1,
    createdAt: now,
    lastEvidenceRun: newestRun,
    lastPass: passId,
    decision: null,
    approval: null,
    apply: null,
    history: [{ at: now, status: 'open', note: `drafted in pass ${passId}` }],
  };
  return { proposal: await saveProposal(dir, p), created: true };
}

/** Append one decision record to the audit log. */
export async function appendAudit(dir, entry) {
  const file = path.join(improvementsDir(dir), 'audit.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export async function readAudit(dir) {
  const file = path.join(improvementsDir(dir), 'audit.jsonl');
  if (!existsSync(file)) return [];
  return (await fs.readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function writeDigest(dir, digest) {
  await writeAtomic(path.join(improvementsDir(dir), 'digest.json'), digest);
}

export async function readDigest(dir) {
  const file = path.join(improvementsDir(dir), 'digest.json');
  return existsSync(file) ? JSON.parse(await fs.readFile(file, 'utf8')) : null;
}

export function newPassId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${randomBytes(2).toString('hex')}`;
}
export const PASS_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
