import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * One pipeline run at a time per repository. Two runs share the working tree, the
 * current branch and the spec folders, so a second run's files end up in the first
 * run's commit (and the second then fails with "no source changes"). runPipeline
 * therefore takes this lock before it touches anything.
 *
 * The lock is a JSON file at <repo>/.factory/lock holding { pid, runId, acquiredAt }.
 * .factory/ is gitignored and also written to .git/info/exclude by the runner, so
 * the lock can never be committed.
 *
 * Stale handling: there is no TTL. A lock is stale only when its pid is no longer
 * alive (checked with kill(pid, 0)) or its contents are not a lock this module
 * could have written — locks are published atomically (temp file + hard link), so
 * a live run's lock is never seen half-written. A stale lock is removed and
 * acquisition retried; a lock held by a live pid — including this process, for
 * in-process concurrent calls — always blocks.
 */

export class RunLockError extends Error {
  constructor(holder) {
    super(
      `another factory run is already running in this repository: run ${holder?.runId ?? 'unknown'} ` +
        `(pid ${holder?.pid ?? 'unknown'}${holder?.acquiredAt ? `, since ${holder.acquiredAt}` : ''}). ` +
        'Wait for it to finish before starting another run.',
    );
    this.name = 'RunLockError';
    this.holder = holder ?? null;
    this.status = 409;
  }
}

export function lockPath(dir) {
  return path.join(dir, '.factory', 'lock');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

function parseLock(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !Number.isInteger(data.pid) || typeof data.runId !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/** The lock holder recorded on disk, or null when there is no (readable) lock. */
export async function readRunLock(dir) {
  const file = lockPath(dir);
  if (!existsSync(file)) return null;
  return parseLock(await fs.readFile(file, 'utf8').catch(() => ''));
}

/** The lock holder if a run is genuinely in progress: lock present and its pid alive. */
export async function liveRunLock(dir) {
  const holder = await readRunLock(dir);
  return holder && pidAlive(holder.pid) ? holder : null;
}

/**
 * Acquire the run lock for `runId`, or throw RunLockError naming the live holder.
 * Returns { path, release } — release() removes the lock only if it is still this
 * run's (same runId and pid), so a run never deletes a successor's lock.
 */
export async function acquireRunLock(dir, runId) {
  const file = lockPath(dir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, runId, acquiredAt: new Date().toISOString() }, null, 2) + '\n';

  for (let attempt = 0; attempt < 3; attempt++) {
    // Publish atomically: write a temp file, then hard-link it into place.
    // link() fails with EEXIST instead of overwriting, and the lock is never
    // observed partially written.
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await fs.writeFile(tmp, payload);
    try {
      await fs.link(tmp, file);
      return {
        path: file,
        async release() {
          const current = await readRunLock(dir);
          if (current && current.runId === runId && current.pid === process.pid) {
            await fs.unlink(file).catch(() => {});
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }

    const holder = await readRunLock(dir);
    if (holder && pidAlive(holder.pid)) throw new RunLockError(holder);
    if (!holder && !existsSync(file)) continue; // It vanished between link and read; retry.
    // Stale (dead pid, or unreadable contents — not a lock this module published,
    // see header): remove and retry. If two contenders race here, link() decides
    // the winner and the loser re-reads a live lock above.
    await fs.unlink(file).catch(() => {});
  }
  throw new RunLockError(await readRunLock(dir));
}
