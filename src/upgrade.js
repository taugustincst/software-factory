import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './util.js';
import { scaffold } from './scaffold.js';
import { collectTree, sha256, snapshotDir, readBaseMeta, SKIP_FILES } from './upgrade-base.js';

export { collectTree, snapshotDir, readBaseMeta, writeBaseSnapshot } from './upgrade-base.js';

const readOrNull = async (abs) => (existsSync(abs) ? fs.readFile(abs) : null);
const isBinary = (buf) => buf.includes(0);

async function writeOut(abs, buf) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
}

/**
 * Three-way merge of a new template render into a project.
 *   base = what the factory originally produced, current = the project's
 *   files (user edits included), fresh = the new render.
 * Unmodified files fast-forward; files changed on both sides go through
 * `git merge-file`; true conflicts are reported (markers in the file for
 * text, a `<file>.factory-new` copy for binaries). Lockfiles are never
 * touched — they belong to the project's package manager.
 */
export async function mergeUpgrade({ dir, baseDir, newDir, dryRun = false }) {
  const base = await collectTree(baseDir);
  const fresh = await collectTree(newDir);
  const report = { updated: [], added: [], merged: [], conflicts: [], kept: [], removed: [], unchanged: 0, dryRun };
  const eq = (a, b) => a !== null && b !== null && sha256(a) === sha256(b);
  const tmp = await fs.mkdtemp(path.join(tmpdir(), 'factory-merge-'));

  try {
    for (const rel of [...new Set([...base.keys(), ...fresh.keys()])].sort()) {
      const curAbs = path.join(dir, rel);
      const cur = await readOrNull(curAbs);
      const baseBuf = base.has(rel) ? await fs.readFile(base.get(rel)) : null;
      const newBuf = fresh.has(rel) ? await fs.readFile(fresh.get(rel)) : null;

      if (baseBuf && !newBuf) {
        // Removed from the template.
        if (cur === null) continue;
        if (eq(cur, baseBuf)) {
          if (!dryRun) await fs.rm(curAbs);
          report.removed.push(rel);
        } else {
          report.kept.push(`${rel} (removed upstream, modified locally)`);
        }
        continue;
      }
      if (!baseBuf && newBuf) {
        // New in the template.
        if (cur === null) {
          if (!dryRun) await writeOut(curAbs, newBuf);
          report.added.push(rel);
        } else if (eq(cur, newBuf)) {
          report.unchanged++;
        } else {
          if (!dryRun) await writeOut(`${curAbs}.factory-new`, newBuf);
          report.conflicts.push(`${rel} (already exists with different content; new version at ${rel}.factory-new)`);
        }
        continue;
      }
      // Present in both base and new render.
      if (eq(newBuf, baseBuf)) {
        report.unchanged++;
        continue;
      }
      if (cur === null) {
        report.kept.push(`${rel} (deleted locally, changed upstream)`);
        continue;
      }
      if (eq(cur, baseBuf)) {
        if (!dryRun) await writeOut(curAbs, newBuf);
        report.updated.push(rel);
        continue;
      }
      if (eq(cur, newBuf)) {
        report.unchanged++;
        continue;
      }
      // Changed on both sides.
      if (isBinary(cur) || isBinary(baseBuf) || isBinary(newBuf)) {
        if (!dryRun) await writeOut(`${curAbs}.factory-new`, newBuf);
        report.conflicts.push(`${rel} (binary changed on both sides; new version at ${rel}.factory-new)`);
        continue;
      }
      const files = { cur: path.join(tmp, 'cur'), base: path.join(tmp, 'base'), fresh: path.join(tmp, 'fresh') };
      await fs.writeFile(files.cur, cur);
      await fs.writeFile(files.base, baseBuf);
      await fs.writeFile(files.fresh, newBuf);
      const r = await run([
        'git',
        'merge-file',
        '-p',
        '-L',
        `${rel} (yours)`,
        '-L',
        `${rel} (base)`,
        '-L',
        `${rel} (template)`,
        files.cur,
        files.base,
        files.fresh,
      ]);
      if (r.code === 0) {
        if (!dryRun) await writeOut(curAbs, Buffer.from(r.stdout, 'utf8'));
        report.merged.push(rel);
      } else if (r.stdout.includes('<<<<<<<')) {
        if (!dryRun) await writeOut(curAbs, Buffer.from(r.stdout, 'utf8'));
        report.conflicts.push(`${rel} (${r.code} merge conflict${r.code === 1 ? '' : 's'}; markers left in the file)`);
      } else {
        if (!dryRun) await writeOut(`${curAbs}.factory-new`, newBuf);
        report.conflicts.push(`${rel} (merge failed; new version at ${rel}.factory-new)`);
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return report;
}

/**
 * Find the merge base for a project: its .factory/upgrade snapshot when one
 * exists, otherwise the tree of the commit that first added factory.json —
 * which is the scaffold commit in any factory-made repo. Materializes the
 * git tree into a temp dir (text files only; templates ship no binaries).
 */
export async function prepareBase({ dir }) {
  if (existsSync(snapshotDir(dir))) {
    const meta = await readBaseMeta(dir);
    return { baseDir: snapshotDir(dir), source: `snapshot from ${meta?.at ?? 'scaffold time'}`, cleanup: async () => {} };
  }
  const log = await run(['git', 'log', '--diff-filter=A', '--format=%H', '--', 'factory.json'], { cwd: dir });
  const commits = log.stdout.trim().split('\n').filter(Boolean);
  if (!commits.length) {
    throw new Error(
      'no upgrade base found: this project has no .factory/upgrade snapshot and its git history has no commit that added factory.json. ' +
        'Upgrade needs the original scaffold state to merge against; re-scaffold with the current factory (which records a snapshot), or restore the original history.',
    );
  }
  const commit = commits[commits.length - 1];
  const baseDir = await fs.mkdtemp(path.join(tmpdir(), 'factory-base-'));
  const listing = await run(['git', 'ls-tree', '-r', '--name-only', '-z', commit], { cwd: dir });
  for (const rel of listing.stdout.split('\0').filter(Boolean)) {
    if (rel.startsWith('.factory/') || SKIP_FILES.has(path.basename(rel))) continue;
    const show = await run(['git', 'show', `${commit}:${rel}`], { cwd: dir });
    if (show.code !== 0 || show.stdout.includes('\0')) continue; // unreadable or binary: left out of the base
    await writeOut(path.join(baseDir, rel), Buffer.from(show.stdout, 'utf8'));
  }
  return {
    baseDir,
    source: `scaffold commit ${commit.slice(0, 7)}`,
    cleanup: () => fs.rm(baseDir, { recursive: true, force: true }),
  };
}

/**
 * Render the project's template at the current factory version into a temp
 * dir. The project's own values are reused (name and template from
 * factory.json; description and owner recovered from its files), and the
 * render is installed so postCreate formatting matches what a fresh
 * scaffold would produce — otherwise every file would differ by formatting.
 */
export async function renderNewTemplate({ dir }) {
  const cfg = JSON.parse(await fs.readFile(path.join(dir, 'factory.json'), 'utf8'));
  let description;
  let owner;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    description = pkg.description || undefined;
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    owner = repo?.match(/github\.com[:/]([^/]+)\//)?.[1];
  } catch {
    /* not a node project */
  }
  if (!description) {
    try {
      const py = await fs.readFile(path.join(dir, 'pyproject.toml'), 'utf8');
      description = py.match(/^description\s*=\s*"([^"]+)"/m)?.[1];
    } catch {
      /* no pyproject either */
    }
  }
  if (!owner) {
    try {
      const co = await fs.readFile(path.join(dir, 'CODEOWNERS'), 'utf8');
      owner = co.match(/@([A-Za-z0-9][\w-]*)/)?.[1];
    } catch {
      /* no CODEOWNERS */
    }
  }
  const tmpNew = await fs.mkdtemp(path.join(tmpdir(), 'factory-render-'));
  const target = path.join(tmpNew, cfg.name);
  const result = await scaffold({
    template: cfg.template,
    name: cfg.name,
    dir: target,
    description,
    owner: owner ?? 'your-github-user',
    install: true,
    git: false,
    claude: true,
  });
  if (result.steps.install !== 'ok') {
    await fs.rm(tmpNew, { recursive: true, force: true });
    throw new Error('rendering the current template failed at its install step; the upgrade cannot produce a faithful render');
  }
  return { newDir: target, cleanup: () => fs.rm(tmpNew, { recursive: true, force: true }) };
}
