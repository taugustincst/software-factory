import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run, tail } from '../util.js';
import { scanText } from '../../claude-kit/.claude/hooks/lib/patterns.mjs';

/**
 * Gates are deterministic checks run after each stage. A gate never trusts the agent's
 * own claim of success: it reads files and runs the project's real commands.
 * Each check: { name, ok, severity: 'error' | 'warn', detail }.
 */

const check = (name, ok, detail = '', severity = 'error') => ({ name, ok: Boolean(ok), severity, detail });

async function readIf(file) {
  return existsSync(file) ? fs.readFile(file, 'utf8') : null;
}

function hasHeading(md, heading) {
  return new RegExp(`^##\\s+${heading}\\b`, 'im').test(md);
}

function section(md, heading) {
  const m = md.match(new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'im'));
  return m ? m[1] : '';
}

async function commandCheck(ctx, key, { required = false } = {}) {
  const cmd = ctx.project.commands[key];
  if (!cmd)
    return check(
      `${key} command`,
      !required,
      required ? `no "${key}" command in factory.json` : 'not configured, skipped',
      required ? 'error' : 'warn',
    );
  const r = await run(cmd, { cwd: ctx.dir, timeoutMs: ctx.commandTimeoutMs, signal: ctx.signal });
  ctx.log?.(`$ ${cmd} → exit ${r.code}`);
  return check(`${key}: ${cmd}`, r.code === 0, r.code === 0 ? 'passed' : tail(`${r.stdout}\n${r.stderr}`, 4000));
}

/**
 * Files with uncommitted changes (incl. untracked) under `dir`, as `dir`-relative POSIX paths.
 * Uses -z so paths are never quoted or escaped, and resolves git's repo-root-relative paths,
 * so it works when `dir` is a package inside a monorepo. Returns null outside a git repo.
 */
export async function changedFiles(dir) {
  const top = await run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const r = await run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { cwd: dir });
  if (r.code !== 0) return null;
  const entries = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const xy = entries[i].slice(0, 2);
    out.push(entries[i].slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') i++; // next entry is the rename/copy source
  }
  const realDir = await fs.realpath(dir);
  return out
    .map((p) => path.relative(realDir, path.join(root, p)).split(path.sep).join('/'))
    .filter((p) => p && !p.startsWith('../'));
}

/** Content fingerprints of every changed file, to detect what a stage touched. */
export async function snapshot(dir) {
  const files = await changedFiles(dir);
  const map = new Map();
  for (const f of files ?? []) {
    const full = path.join(dir, f);
    const buf = existsSync(full) && (await fs.stat(full)).isFile() ? await fs.readFile(full) : null;
    map.set(f, buf ? createHash('sha1').update(buf).digest('hex') : 'deleted');
  }
  return map;
}

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/;

/** Did the run's diff add or change any test file? Shared by the build and test gates. */
export function testsTouched(files) {
  return (files ?? []).some((f) => TEST_FILE_RE.test(f));
}

/** Read-only stages (spec, plan, review) may only write inside the spec folder. */
async function onlyArtifactsChanged(ctx) {
  if (!ctx.snapshotBefore) return check('only spec-folder files changed', true, 'no baseline', 'warn');
  const after = await snapshot(ctx.dir);
  const prefix = `${ctx.rel(ctx.artifactDir)}/`;
  const touched = [...new Set([...after.keys(), ...ctx.snapshotBefore.keys()])].filter(
    (f) => !f.startsWith(prefix) && !f.startsWith('.factory/') && after.get(f) !== ctx.snapshotBefore.get(f),
  );
  return check(
    'only spec-folder files changed',
    touched.length === 0,
    touched.length ? `this stage must not modify: ${touched.join(', ')}` : '',
  );
}

/** The artifact must have been written during this attempt, not left over from an earlier run. */
async function fresh(ctx, file) {
  if (!ctx.attemptStartedMs) return check('written in this attempt', true, '', 'warn');
  const { mtimeMs } = await fs.stat(file);
  return check(
    `${path.basename(file)} written in this attempt`,
    mtimeMs >= ctx.attemptStartedMs - 2000,
    mtimeMs >= ctx.attemptStartedMs - 2000 ? '' : 'file is stale: the agent did not write it this attempt',
  );
}

export const VERDICT_RE = /^\s*\**Verdict\**\s*:?\s*\**\s*(APPROVE|REQUEST_CHANGES)\b\**\s*\.?\s*$/im;

export const gates = {
  async spec(ctx) {
    const md = await readIf(ctx.artifacts.spec);
    if (md === null) return [check('SPEC.md exists', false, `expected ${ctx.rel(ctx.artifacts.spec)}`)];
    const acs = (section(md, 'Acceptance Criteria').match(/^\s*-\s+\[[ x]\]/gim) ?? []).length;
    const reqs = (section(md, 'Requirements').match(/^\s*-\s+R\d+/gim) ?? []).length;
    return [
      check('SPEC.md exists', true),
      await fresh(ctx, ctx.artifacts.spec),
      await onlyArtifactsChanged(ctx),
      ...['Problem', 'Requirements', 'Acceptance Criteria', 'Out of Scope'].map((h) => check(`has "## ${h}"`, hasHeading(md, h))),
      check('numbered requirements (R1, R2…)', reqs > 0, `${reqs} found`),
      check('acceptance criteria as checklist', acs > 0, `${acs} found`),
    ];
  },

  async plan(ctx) {
    const md = await readIf(ctx.artifacts.plan);
    if (md === null) return [check('PLAN.md exists', false, `expected ${ctx.rel(ctx.artifacts.plan)}`)];
    const tasks = (section(md, 'Tasks').match(/^\s*-\s+\[[ x]\]/gim) ?? []).length;
    const spec = (await readIf(ctx.artifacts.spec)) ?? '';
    const acIds = [...new Set(spec.match(/\bAC\d+\b/g) ?? [])];
    const tasksSection = section(md, 'Tasks');
    const uncovered = acIds.filter((id) => !new RegExp(`\\b${id}\\b`).test(tasksSection));
    return [
      check('PLAN.md exists', true),
      await fresh(ctx, ctx.artifacts.plan),
      await onlyArtifactsChanged(ctx),
      ...['Tasks', 'Test Strategy', 'Risks'].map((h) => check(`has "## ${h}"`, hasHeading(md, h))),
      check('tasks as checklist', tasks > 0, `${tasks} found`),
      check(
        'every acceptance criterion covered by a task',
        uncovered.length === 0,
        uncovered.length ? `not covered: ${uncovered.join(', ')}` : `${acIds.length} covered`,
      ),
    ];
  },

  async build(ctx) {
    const files = await changedFiles(ctx.dir);
    const docsPrefix = ctx.rel(ctx.artifactDir);
    const source = files?.filter((f) => !f.startsWith(docsPrefix) && !f.startsWith('.factory/')) ?? null;
    return [
      files === null
        ? check('source changes', true, 'not a git repo; cannot verify the diff', 'warn')
        : check(
            'source changes',
            source.length > 0,
            source.length ? `${source.length} file(s) changed` : 'no files changed outside the spec folder',
          ),
      files === null
        ? check('tests added or changed', true, 'not a git repo; cannot verify the diff', 'warn')
        : check(
            'tests added or changed',
            testsTouched(files),
            testsTouched(files) ? '' : 'no test files in the diff: new behavior ships with tests, not after them',
          ),
      await commandCheck(ctx, 'lint'),
      await commandCheck(ctx, 'typecheck'),
      await commandCheck(ctx, 'build'),
    ];
  },

  async test(ctx) {
    const files = (await changedFiles(ctx.dir)) ?? [];
    // Coverage enforcement comes from factory.json: when the project declares
    // a `coverage` command, its exit code carries the threshold (every
    // template ships one). A coverage run is a superset of a test run — same
    // suite, plus the threshold — so it stands in for the plain test check
    // rather than running the suite twice. Projects without one keep the
    // old behavior exactly.
    const suite = ctx.project.commands.coverage
      ? await commandCheck(ctx, 'coverage', { required: true })
      : await commandCheck(ctx, 'test', { required: true });
    return [
      suite,
      check(
        'tests added or changed',
        testsTouched(files),
        testsTouched(files) ? '' : 'no test files in the diff: new behavior ships with tests, not after them',
      ),
    ];
  },

  async review(ctx) {
    const md = await readIf(ctx.artifacts.review);
    const checks = [];
    if (md === null) {
      checks.push(check('REVIEW.md exists', false, `expected ${ctx.rel(ctx.artifacts.review)}`));
    } else {
      const verdict = md.match(VERDICT_RE)?.[1] ?? null;
      const blockers = md.split('\n').filter((l) => /^\s*([-*]|\d+\.)\s*\**\[BLOCKER\]/i.test(l));
      checks.push(check('REVIEW.md exists', true));
      checks.push(await fresh(ctx, ctx.artifacts.review));
      checks.push(await onlyArtifactsChanged(ctx));
      checks.push(
        check('verdict is APPROVE', verdict === 'APPROVE', verdict ? `verdict: ${verdict}` : 'no single-verdict "Verdict:" line'),
      );
      checks.push(check('no BLOCKER findings', blockers.length === 0, blockers.join('\n')));
    }
    checks.push(await secretScan(ctx));
    checks.push(await commandCheck(ctx, 'test', { required: true }));
    return checks;
  },
};

export async function secretScan(ctx) {
  const files = await changedFiles(ctx.dir);
  if (files === null) return check('no secrets or PHI in changed files', true, 'not a git repo; skipped', 'warn');
  const findings = [];
  let scanned = 0;
  for (const f of files) {
    const full = path.join(ctx.dir, f);
    if (!existsSync(full)) continue; // deleted
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    if (stat.size > 5_000_000) {
      findings.push(`${f}: too large to scan (${stat.size} bytes); review it manually or keep it out of the change`);
      continue;
    }
    const text = await fs.readFile(full, 'utf8').catch(() => null);
    if (text === null) {
      findings.push(`${f}: could not be read for scanning`);
      continue;
    }
    scanned++;
    for (const hit of scanText(text)) findings.push(`${f}: ${hit.id} (${hit.match})`);
  }
  return check('no secrets or PHI in changed files', findings.length === 0, findings.join('\n') || `${scanned} file(s) scanned`);
}

/** A gate passes when no error-severity check failed. */
export function gatePassed(checks) {
  return checks.every((c) => c.ok || c.severity === 'warn');
}

export function describeFailures(checks) {
  return checks
    .filter((c) => !c.ok && c.severity === 'error')
    .map((c) => `✗ ${c.name}${c.detail ? `\n${c.detail}` : ''}`)
    .join('\n\n');
}
