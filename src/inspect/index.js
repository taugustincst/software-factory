import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { run as exec, tail } from '../util.js';
import { scanText } from '../../claude-kit/.claude/hooks/lib/patterns.mjs';
import { changedFiles } from '../pipeline/gates.js';

/**
 * The Inspector: owns release quality. It re-checks a release candidate itself instead of
 * trusting earlier summaries, and returns a verdict — ship, ship-with-notes or hold — where
 * every finding names its check, and the file or number behind it. It never writes code.
 */

export const CHECKS = [
  'gates-passed',
  'lint',
  'typecheck',
  'test',
  'coverage-delta',
  'secrets',
  'risky-diff',
  'version-changelog',
  'template-conformance',
  'model-review',
];

export const DEFAULT_RUBRIC = Object.freeze({
  'gates-passed': 'hold',
  lint: 'hold',
  typecheck: 'hold',
  test: 'hold',
  'coverage-delta': 'note',
  secrets: 'hold',
  'risky-diff': 'note',
  'version-changelog': 'note',
  'template-conformance': 'hold',
  'model-review': 'hold',
});

/** Resolve inspector settings from factory.json: { rubric, coverageDropMax, analyze, model, warnings }. */
export function resolveInspector(cfg = {}) {
  const warnings = [];
  const ins = cfg.inspector ?? {};
  const rubric = { ...DEFAULT_RUBRIC };
  for (const [k, v] of Object.entries(ins.rubric ?? {})) {
    if (!CHECKS.includes(k)) warnings.push(`inspector.rubric: unknown check "${k}"`);
    else if (!['hold', 'note', 'off'].includes(v)) warnings.push(`inspector.rubric.${k}: "${v}" is not hold | note | off`);
    else rubric[k] = v;
  }
  const drop = ins.coverageDropMax;
  const coverageDropMax = typeof drop === 'number' && drop >= 0 && drop <= 100 ? drop : 1;
  if (drop !== undefined && coverageDropMax !== drop) warnings.push('inspector.coverageDropMax: must be 0-100; using 1');
  const model = typeof ins.model === 'string' && /^[\w.:@/-]{1,100}$/.test(ins.model) ? ins.model : null;
  return { rubric, coverageDropMax, analyze: ins.analyze !== false, model, warnings };
}

const RISKY = [
  { id: 'migration', re: /(^|\/)(migrations?|drizzle|alembic|prisma\/migrations)\/|\.sql$/i, why: 'database migration' },
  {
    id: 'auth',
    re: /(^|\/|[-_.])(auth|login|session|passwords?|tokens?|permissions?|rbac|acl|oauth|jwt)([-_./]|$)/i,
    why: 'authentication or authorization code',
  },
  { id: 'workflow', re: /^\.github\/(workflows|actions)\//, why: 'CI workflow or permissions' },
  { id: 'guard', re: /(^|\/)\.claude\/(hooks|settings(\.local)?\.json)/, why: 'agent guard hooks or settings' },
];
const DESTRUCTIVE =
  /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;|rm\s+-rf\s+[/~$]|fs\.rmSync?\(|shutil\.rmtree\(|git\s+push\s+--force)\b/i;

/** Added lines in the working tree's diff against HEAD, plus the contents of untracked files. */
async function addedText(dir, files) {
  const diff = await exec(['git', 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', '.'], { cwd: dir });
  const added = diff.stdout
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  const tracked = new Set((await exec(['git', 'ls-files', '-z'], { cwd: dir })).stdout.split('\0').filter(Boolean));
  for (const f of files) {
    if (tracked.has(f)) continue;
    const abs = path.join(dir, f);
    try {
      const st = await fs.stat(abs);
      if (st.isFile() && st.size < 1024 * 1024) added.push(...(await fs.readFile(abs, 'utf8')).split('\n'));
    } catch {
      /* deleted or unreadable */
    }
  }
  return added;
}

/** Parse a line-coverage percentage from coverage output (c8/nyc/node:test/coverage.py styles). */
export function parseCoverage(text) {
  const s = String(text ?? '');
  const m =
    s.match(/coverage lines:\s*([\d.]+)%/i) ??
    s.match(/^\s*(?:#\s*)?all files\s*\|\s*([\d.]+)/im) ??
    s.match(/^\s*Lines\s*:\s*([\d.]+)%/im) ??
    s.match(/^TOTAL\s+\d+\s+\d+\s+([\d.]+)%/m);
  return m ? Number(m[1]) : null;
}

/**
 * Inspect a release candidate.
 *   ctx: { dir, harness (inspector scope), artifactDir? } — commands run through the harness.
 *   run: the run record (earlier stages' outcomes), or null when inspecting a bare tree.
 *   previousCoverage: the last inspected coverage %, for the delta check.
 * Returns { verdict, findings: [{ check, level, ok, detail }], coverage }.
 */
export async function inspect({ ctx, run = null, project, settings, previousCoverage = null }) {
  const { rubric } = settings;
  const findings = [];
  const add = (check, ok, detail) => {
    const level = rubric[check] ?? 'note';
    if (level !== 'off') findings.push({ check, level, ok: Boolean(ok), detail });
  };

  // 1. Every earlier gate actually ran and passed — from the record, not from a summary.
  if (run && rubric['gates-passed'] !== 'off') {
    const earlier = run.stages.filter((s) => !['inspect', 'ship'].includes(s.id));
    const bad = earlier.filter((s) => s.status !== 'passed' || !s.attempts.length || !s.attempts.at(-1).ok);
    add(
      'gates-passed',
      bad.length === 0,
      bad.length ? `not passed: ${bad.map((s) => `${s.id} (${s.status})`).join(', ')}` : `${earlier.length} stage gates passed`,
    );
  }

  // 2. Re-run the project's own checks through the harness (inspector scope: read + exec).
  for (const check of ['lint', 'typecheck', 'test']) {
    if (rubric[check] === 'off' || !project.commands[check]) continue;
    const r = await ctx.harness.call('run_command', { name: check });
    const exit = Number(r.text.match(/^exit (\d+)/m)?.[1] ?? 1);
    add(check, r.ok && exit === 0, r.ok ? (exit === 0 ? `${project.commands[check]} → exit 0` : tail(r.text, 3000)) : r.text);
  }

  let coverage = null;
  if (rubric['coverage-delta'] !== 'off' && project.commands.coverage) {
    const r = await ctx.harness.call('run_command', { name: 'coverage' });
    coverage = parseCoverage(r.text);
    if (coverage === null)
      add('coverage-delta', false, 'coverage command ran but no line-coverage % could be read from its output');
    else if (previousCoverage === null)
      add('coverage-delta', true, `line coverage ${coverage}% (no earlier inspection to compare)`);
    else {
      const drop = Math.round((previousCoverage - coverage) * 100) / 100;
      add(
        'coverage-delta',
        drop <= settings.coverageDropMax,
        `line coverage ${coverage}% vs ${previousCoverage}% (change ${-drop >= 0 ? '+' : ''}${-drop} points; max drop ${settings.coverageDropMax})`,
      );
    }
  }

  // 3. The diff itself.
  const files = (await changedFiles(ctx.dir)) ?? [];
  const relevant = files.filter((f) => !f.startsWith('.factory/'));
  const added = await addedText(ctx.dir, relevant);
  if (rubric.secrets !== 'off') {
    const hits = scanText(added.join('\n'));
    add(
      'secrets',
      hits.length === 0,
      hits.length
        ? `possible secrets in the diff: ${hits.map((h) => `${h.id} (${h.match})`).join(', ')}`
        : 'no secrets found in added lines',
    );
  }
  if (rubric['risky-diff'] !== 'off') {
    const risky = [];
    for (const f of relevant) for (const r of RISKY) if (r.re.test(f)) risky.push(`${f}: ${r.why}`);
    const destructive = added.filter((l) => DESTRUCTIVE.test(l)).slice(0, 5);
    for (const l of destructive) risky.push(`destructive operation: ${l.trim().slice(0, 160)}`);
    add(
      'risky-diff',
      risky.length === 0,
      risky.length ? risky.join('\n') : `${relevant.length} changed file(s), none in a risky class`,
    );
  }
  if (rubric['version-changelog'] !== 'off') {
    const pkgChanged = relevant.includes('package.json') && added.some((l) => /^\s*"version"\s*:/.test(l));
    const clChanged = relevant.some((f) => /(^|\/)CHANGELOG\.md$/i.test(f));
    const ok = pkgChanged === clChanged;
    add(
      'version-changelog',
      ok,
      ok
        ? pkgChanged
          ? 'version and CHANGELOG changed together'
          : 'no version change'
        : pkgChanged
          ? 'package.json version changed without a CHANGELOG entry'
          : 'CHANGELOG changed without a version bump',
    );
  }
  if (rubric['template-conformance'] !== 'off') {
    const file = path.join(ctx.dir, 'factory.json');
    let detail = 'factory.json present and valid';
    let ok = true;
    if (!existsSync(file)) {
      ok = !project.inferred ? false : true;
      detail = project.inferred ? 'no factory.json (commands inferred)' : 'factory.json is missing';
    } else {
      try {
        const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!cfg.commands || typeof cfg.commands.test !== 'string') {
          ok = false;
          detail = 'factory.json has no commands.test';
        }
      } catch (err) {
        ok = false;
        detail = `factory.json does not parse: ${err.message}`;
      }
    }
    add('template-conformance', ok, detail);
  }

  return { verdict: verdictOf(findings), findings, coverage };
}

/** hold if any hold-level check failed; ship-with-notes if any note-level check failed; else ship. */
export function verdictOf(findings) {
  if (findings.some((f) => !f.ok && f.level === 'hold')) return 'hold';
  if (findings.some((f) => !f.ok && f.level === 'note')) return 'ship-with-notes';
  return 'ship';
}

/** Findings as gate checks for the run record and dashboard (hold → error, note → warn). */
export function asChecks(findings) {
  return findings.map((f) => ({
    name: `${f.check} [${f.level}]`,
    ok: f.ok,
    severity: f.level === 'hold' ? 'error' : 'warn',
    detail: f.detail,
  }));
}

/** Pull the model Inspector's JSON verdict out of its final message. */
export function parseModelReview(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  try {
    const o = JSON.parse(fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    if (!['ship', 'ship-with-notes', 'hold'].includes(o.verdict)) return null;
    return {
      verdict: o.verdict,
      notes: (Array.isArray(o.notes) ? o.notes : []).map((n) => String(n).slice(0, 500)).slice(0, 20),
    };
  } catch {
    return null;
  }
}

export const INSPECT_STAGE = {
  id: 'inspect',
  title: 'Inspect',
  agent: 'factory-inspector',
  role: 'inspector',
  harnessOnly: true,
  tools: [],
  budgetUsd: 0.75,
  prompt: (ctx, findings) =>
    `You are the factory's Inspector, in charge of release quality. The deterministic checks below already ran. ` +
    `Look at the actual change (git_diff, git_status, read_file) and the spec at \`${ctx.rel(ctx.artifacts.spec)}\`, and judge whether it is fit to ship: ` +
    `does it do what the spec asks, is anything risky or half-finished, would you put your name on it? You can run the project's checks (run_command) but you cannot write.\n\n` +
    `Deterministic findings:\n${findings.map((f) => `- ${f.ok ? 'OK' : 'FAIL'} ${f.check} [${f.level}]: ${String(f.detail).split('\n')[0]}`).join('\n')}\n\n` +
    `Reply with only: {"verdict":"ship|ship-with-notes|hold","notes":["each note names the file, check or number it is about"]}. ` +
    `You may add concerns; you cannot clear a deterministic hold.`,
};

/** Mock Inspector: ships, with one canned note, so offline runs exercise the model path. */
export async function mockInspect() {
  return { summary: JSON.stringify({ verdict: 'ship', notes: ['mock inspector: change matches the spec'] }) };
}

/** Post-release watch: the latest completed CI run on `branch`, via `gh api`. */
export async function latestMainCi({
  dir,
  branch = 'main',
  gh = (args) => exec(['gh', ...args], { cwd: dir, timeoutMs: 60_000 }),
}) {
  if (!/^(?!-)[\w./-]{1,100}$/.test(branch)) throw new Error(`invalid branch: ${branch}`);
  const remote = (await exec(['git', 'remote', 'get-url', 'origin'], { cwd: dir })).stdout.trim();
  const m = remote.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) throw new Error('origin is not a GitHub repository');
  const r = await gh(['api', `repos/${m[1]}/${m[2]}/actions/runs?branch=${branch}&status=completed&per_page=5`]);
  if (r.code !== 0) throw new Error(`gh api failed: ${tail(r.stderr, 300)}`);
  const run = JSON.parse(r.stdout).workflow_runs?.[0];
  return run ? { conclusion: run.conclusion, url: run.html_url, sha: run.head_sha, at: run.updated_at, name: run.name } : null;
}
