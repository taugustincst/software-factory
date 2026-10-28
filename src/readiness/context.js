import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Scoring context for the Autonomy Maturity Model: one walk of the repo tree
 * (ignoring .git, node_modules, .factory, coverage, dist) plus cached text
 * accessors and parsed manifests, so every signal check in signals.js is a
 * pure, fast lookup. See docs/autonomy-maturity.md.
 */

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.factory', 'coverage', 'dist']);
const MAX_TEXT_BYTES = 512 * 1024;

async function walk(dir, base, out) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), base, out);
    } else out.push(path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/'));
  }
  return out;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Precompute everything signal checks need: the relative file set, a cached
 * text accessor, and the parsed manifests (factory.json, package.json,
 * pyproject.toml). One pass per repo; checks stay pure lookups.
 */
export async function buildContext(dir) {
  const root = path.resolve(dir);
  const files = existsSync(root) ? await walk(root, root, []) : [];
  const set = new Set(files);
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      cache.set(
        rel,
        (async () => {
          const file = path.join(root, rel);
          if (!existsSync(file)) return null;
          const stat = await fs.stat(file);
          if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
          return fs.readFile(file, 'utf8').catch(() => null);
        })(),
      );
    }
    return cache.get(rel);
  };
  const text = async (rel) => (await read(rel)) ?? '';
  const factoryJson = parseJson(await read('factory.json')) ?? {};
  const pkg = parseJson(await read('package.json'));
  const pyproject = await text('pyproject.toml');
  const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const workflowText = (await Promise.all(workflows.map((f) => read(f)))).filter(Boolean).join('\n');
  /** True when any file under `prefix` (relative dir, '' for all) matches `re`. Skips this repo's shipped template/kit trees. */
  async function anyText(re, prefix = '') {
    for (const rel of files) {
      if (prefix && !rel.startsWith(prefix)) continue;
      // Shipped template/kit trees are other repos' content, and the scorer
      // must never match its own probe patterns in src/readiness/.
      if (rel.startsWith('templates/') || rel.startsWith('claude-kit/') || rel.startsWith('src/readiness/')) continue;
      const body = await read(rel);
      if (body && re.test(body)) return true;
    }
    return false;
  }
  return {
    dir: root,
    files,
    set,
    has: (rel) => set.has(rel),
    hasAny: (rels) => rels.some((rel) => set.has(rel)),
    hasPrefix: (prefix) => files.some((f) => f.startsWith(prefix)),
    countPrefix: (prefix, suffix) => files.filter((f) => f.startsWith(prefix) && (!suffix || f.endsWith(suffix))).length,
    read,
    text,
    anyText,
    factoryJson,
    commands: factoryJson.commands ?? {},
    pkg,
    scripts: pkg?.scripts ?? {},
    pyproject,
    workflows,
    workflowText,
  };
}

const TEST_FILE =
  /(^|\/)(test|tests|__tests__|e2e|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.(py|go)$/;

function isTestFile(rel) {
  if (rel.startsWith('templates/') || rel.startsWith('claude-kit/')) return false;
  return TEST_FILE.test(rel);
}

function tsconfigStrict(ctx) {
  return ctx.files.filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f) && !f.startsWith('templates/')).some((f) => ctx.set.has(f));
}

async function anyTsconfigStrict(ctx) {
  for (const f of ctx.files) {
    if (!/(^|\/)tsconfig[^/]*\.json$/.test(f) || f.startsWith('templates/')) continue;
    if (/"strict"\s*:\s*true/.test(await ctx.text(f))) return true;
  }
  return false;
}

export { isTestFile, anyTsconfigStrict, tsconfigStrict };
