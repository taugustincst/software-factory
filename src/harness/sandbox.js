import { promises as fs, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';

/**
 * Path confinement for harness tools. Every path an agent passes is repo-relative;
 * it must stay inside the root after `..` is resolved and after symlinks in its
 * nearest existing ancestor are followed. Returns { abs, rel } (rel is POSIX).
 */
export function resolveInside(root, p) {
  if (typeof p !== 'string' || p.length === 0) throw sandboxError('path is required');
  if (p.includes('\0')) throw sandboxError('path contains a NUL byte');
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) throw sandboxError(`absolute paths are not allowed: ${p}`);
  const realRoot = realpathSync(root);
  const abs = path.resolve(realRoot, p);
  const rel = path.relative(realRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw sandboxError(`path leaves the repository: ${p}`);
  // Follow symlinks in the deepest part of the path that exists.
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const r = path.relative(realRoot, real);
      if (r.startsWith('..') || path.isAbsolute(r)) throw sandboxError(`path resolves outside the repository: ${p}`);
      break;
    } catch (err) {
      if (err.code === 'SANDBOX') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return { abs, rel: rel.split(path.sep).join('/') || '.' };
}

/** Refuse writing through an existing symlink (it may point anywhere). */
export function assertNotSymlink(abs) {
  try {
    if (lstatSync(abs).isSymbolicLink()) throw sandboxError('refusing to write through a symlink');
  } catch (err) {
    if (err.code === 'SANDBOX') throw err;
  }
}

export function sandboxError(message) {
  return Object.assign(new Error(message), { code: 'SANDBOX' });
}

/**
 * Read a file as UTF-8 text, refusing binaries and files over `max` bytes. One file handle
 * is opened and both the size check and the read go through it, so the file cannot be
 * swapped between the check and the read.
 */
export async function readText(abs, max) {
  const fh = await fs.open(abs, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw sandboxError('not a regular file');
    if (st.size > max) throw sandboxError(`file is ${st.size} bytes; the cap is ${max}`);
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.includes(0)) throw sandboxError('binary file');
    return data.toString('utf8');
  } finally {
    await fh.close();
  }
}
