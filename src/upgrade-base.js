import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * The upgrade base: a pristine copy of the template tree a project was
 * scaffolded (or last upgraded) from. `factory upgrade` three-way merges
 * base → project (user edits) → new render (template changes), so it needs
 * the base contents, not just hashes. The snapshot lives in .factory/upgrade/
 * (git-ignored, machine-local); projects without one fall back to recovering
 * the base from the scaffold commit in git history (see upgrade.js).
 */

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.factory']);
export const SKIP_FILES = new Set(['package-lock.json', 'uv.lock', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const snapshotDir = (dir) => path.join(dir, '.factory', 'upgrade', 'base');
export const snapshotMetaFile = (dir) => path.join(dir, '.factory', 'upgrade', 'base.json');

/** Map of POSIX relative path → absolute path for every mergeable file under root. */
export async function collectTree(root) {
  const out = new Map();
  async function walk(d, rel) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path.join(d, e.name), r);
      } else if (e.isFile() && !SKIP_FILES.has(e.name)) {
        out.set(r, path.join(d, e.name));
      }
    }
  }
  if (root && existsSync(root)) await walk(root, '');
  return out;
}

/** Replace the base snapshot for `dir` with the tree at `sourceDir` (may be `dir` itself). */
export async function writeBaseSnapshot(dir, sourceDir, meta) {
  const dest = snapshotDir(dir);
  const tree = await collectTree(sourceDir);
  await fs.rm(dest, { recursive: true, force: true });
  for (const [rel, abs] of tree) {
    const d = path.join(dest, rel);
    await fs.mkdir(path.dirname(d), { recursive: true });
    await fs.copyFile(abs, d);
  }
  await fs.mkdir(path.dirname(snapshotMetaFile(dir)), { recursive: true });
  await fs.writeFile(snapshotMetaFile(dir), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function readBaseMeta(dir) {
  try {
    return JSON.parse(await fs.readFile(snapshotMetaFile(dir), 'utf8'));
  } catch {
    return null;
  }
}
