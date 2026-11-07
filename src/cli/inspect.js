import { parseArgs } from 'node:util';
import path from 'node:path';
import { color } from '../util.js';
import { loadProject } from '../pipeline/project.js';
import { readRun, saveRun, listRuns, RUN_ID_RE } from '../pipeline/store.js';
import { createHarness, DEFAULT_EXEC } from '../harness/index.js';
import { inspect, resolveInspector, latestMainCi } from '../inspect/index.js';

const out = (s) => process.stdout.write(s);

/**
 * Re-inspect a run against the current working tree (deterministic checks). A held run whose
 * re-inspection no longer holds goes back to passed, so the fix-and-reinspect path never
 * needs an override.
 */
export async function reinspect({ dir, runId }) {
  dir = path.resolve(dir);
  const state = await readRun(dir, runId);
  if (!state) throw new Error(`run ${runId} not found in ${dir}/.factory/runs`);
  const project = await loadProject(dir);
  const settings = resolveInspector(project.config);
  const harness = createHarness({
    root: dir,
    role: 'inspector',
    commands: project.commands,
    exec: project.config?.harness?.exec ?? DEFAULT_EXEC,
    auditFile: path.join(dir, '.factory', 'runs', runId, 'harness.jsonl'),
  });
  const previous = (await listRuns(dir)).find((r) => r.id !== runId && typeof r.inspection?.coverage === 'number');
  const r = await inspect({
    ctx: { dir, harness },
    run: state,
    project,
    settings,
    previousCoverage: previous?.inspection.coverage ?? null,
  });
  const at = new Date().toISOString();
  state.inspection = {
    ...(state.inspection ?? {}),
    verdict: r.verdict,
    findings: r.findings,
    coverage: r.coverage,
    at,
    reinspected: true,
  };
  state.events.push({ at, msg: `Re-inspected: ${r.verdict}` });
  if (state.status === 'held' && r.verdict !== 'hold') {
    state.status = 'passed';
    state.error = null;
    state.events.push({ at, msg: 'Inspector hold cleared by re-inspection' });
  }
  await saveRun(dir, state);
  return state;
}

/** Post-release watch: attribute the latest main-branch CI result to the newest shipped run. */
export async function postReleaseWatch({ dir, branch = 'main', gh }) {
  dir = path.resolve(dir);
  const shipped = (await listRuns(dir)).find((r) => r.status === 'passed' && r.prUrl);
  if (!shipped) return { run: null, ci: null, note: 'no shipped run to watch' };
  const ci = await latestMainCi({ dir, branch, gh });
  if (!ci) return { run: shipped.id, ci: null, note: `no completed CI run on ${branch}` };
  if (new Date(ci.at) < new Date(shipped.finishedAt))
    return { run: shipped.id, ci, note: `latest ${branch} CI predates run ${shipped.id}; nothing to attribute yet` };
  shipped.postRelease = { branch, conclusion: ci.conclusion, url: ci.url, sha: ci.sha, checkedAt: new Date().toISOString() };
  shipped.events.push({ at: shipped.postRelease.checkedAt, msg: `Post-release ${branch} CI: ${ci.conclusion}` });
  await saveRun(dir, shipped);
  return {
    run: shipped.id,
    ci,
    note: ci.conclusion === 'success' ? 'release is healthy' : `release ${shipped.id} is followed by a failing ${branch} CI`,
  };
}

export async function cmdInspect(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: '.' },
      'run-id': { type: 'string' },
      'post-release': { type: 'boolean' },
      branch: { type: 'string', default: 'main' },
      json: { type: 'boolean' },
    },
  });
  if (values['post-release']) {
    const r = await postReleaseWatch({ dir: values.dir, branch: values.branch });
    if (values.json) return out(`${JSON.stringify(r, null, 2)}\n`);
    const icon = r.ci?.conclusion === 'success' ? color.green('✓') : r.ci ? color.red('✗') : color.dim('•');
    return out(`${icon} ${r.note}${r.ci ? `\n  ${r.ci.name}: ${r.ci.conclusion}  ${r.ci.url}` : ''}\n`);
  }
  if (!values['run-id'] || !RUN_ID_RE.test(values['run-id']))
    throw new Error('usage: factory inspect --run-id <id> | --post-release');
  const state = await reinspect({ dir: values.dir, runId: values['run-id'] });
  if (values.json) return out(`${JSON.stringify(state.inspection, null, 2)}\n`);
  const v = state.inspection.verdict;
  out(
    `Inspector verdict: ${v === 'ship' ? color.green(v) : v === 'hold' ? color.red(v) : color.yellow(v)}  (run ${state.id} is ${state.status})\n`,
  );
  for (const f of state.inspection.findings)
    out(
      `${f.ok ? color.green('✓') : f.level === 'hold' ? color.red('✗') : color.yellow('!')} ${f.check} [${f.level}] ${String(f.detail).split('\n')[0]}\n`,
    );
}

export const INSPECT_HELP = `
inspect commands (the Inspector: release quality)
  factory inspect --run-id <id>        Re-inspect a run against the working tree; clears a hold that no longer applies
  factory inspect --post-release       Attribute the latest main-branch CI result to the newest shipped run [--branch]
  factory ship --run-id <id> --override-hold "<reason>"   Ship a held run anyway (human only, audited)
`;
