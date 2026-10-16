import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { run as exec, slugify, tail } from '../util.js';
import { loadProject } from './project.js';
import { selectStages } from './stages.js';
import { gates, gatePassed, describeFailures, snapshot, VERDICT_RE } from './gates.js';
import { newRunId, saveRun, appendLog, readRun } from './store.js';
import { acquireRunLock } from './lock.js';

export { RunLockError, liveRunLock, readRunLock } from './lock.js';

export function titleFromRequest(request) {
  const first =
    String(request)
      .trim()
      .split('\n')
      .find((l) => l.trim()) ?? 'Change';
  return (
    first
      .replace(/^(#+|[-*+]|\d+[.)])\s+/, '')
      .trim()
      .slice(0, 80) || 'Change'
  );
}

const now = () => new Date().toISOString();

/**
 * Keep .factory/ (run state, logs, guard settings) out of git without touching tracked files.
 * Uses git's own paths, so it works in subfolders of a repo and in worktrees (where .git is a file).
 */
async function excludeFactoryDir(dir) {
  const ex = await exec(['git', 'rev-parse', '--git-path', 'info/exclude'], { cwd: dir });
  if (ex.code !== 0) return false;
  const prefix = (await exec(['git', 'rev-parse', '--show-prefix'], { cwd: dir })).stdout.trim();
  const entry = `/${prefix}.factory/`;
  const exclude = path.resolve(dir, ex.stdout.trim());
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  const text = existsSync(exclude) ? await fs.readFile(exclude, 'utf8') : '';
  if (!text.split('\n').includes(entry)) await fs.appendFile(exclude, `${text.endsWith('\n') || !text ? '' : '\n'}${entry}\n`);
  return true;
}

function uniqueArtifactDir(dir, date, slug, runId) {
  const base = path.join(dir, 'docs', 'specs', `${date}-${slug}`);
  return existsSync(base) ? `${base}-${runId.slice(-4)}` : base;
}

/**
 * Run the factory pipeline under the per-repo run lock (see lock.js). The lock is
 * taken before anything is read or written and released in a finally, so it is
 * freed on success, on a failed gate and on a thrown error alike. A second live
 * run is rejected with RunLockError instead of contaminating this run's commit.
 */
export async function runPipeline(opts) {
  const runId = opts.runId ?? newRunId();
  const lock = await acquireRunLock(path.resolve(opts.dir), runId);
  try {
    return await runPipelineLocked({ ...opts, runId });
  } finally {
    await lock.release();
  }
}

/**
 * Run the factory pipeline: setup → spec → plan → build → test → review → ship.
 * Each agent stage is retried with gate feedback up to `maxAttempts`; a review that
 * requests changes rewinds to build (up to `maxReviewLoops` times).
 */
async function runPipelineLocked({
  dir,
  request,
  executor,
  stages: stageIds,
  maxAttempts = 3,
  maxReviewLoops = 2,
  ship = false,
  commit = true,
  install = true,
  issue = null,
  allowDirty = false,
  runId = newRunId(),
  commandTimeoutMs = 15 * 60_000,
  onEvent = () => {},
}) {
  dir = path.resolve(dir);
  const project = await loadProject(dir);
  const title = titleFromRequest(request);
  const slug = slugify(title);
  const date = runId.slice(0, 8);
  const artifactDir = uniqueArtifactDir(dir, date, slug, runId);
  const rel = (p) => path.relative(dir, p).split(path.sep).join('/');
  const stages = selectStages(stageIds);

  const state = {
    id: runId,
    title,
    request: request.slice(0, 20000),
    status: 'running',
    executor: executor.name,
    project: { name: project.name, template: project.template, commands: project.commands },
    artifactDir: rel(artifactDir),
    issue,
    ship,
    branch: null,
    prUrl: null,
    costUsd: 0,
    reviewLoops: 0,
    startedAt: now(),
    finishedAt: null,
    error: null,
    stages: stages.map((s) => ({ id: s.id, title: s.title, agent: s.agent ?? null, status: 'pending', attempts: [] })),
    events: [],
  };

  const save = async (msg) => {
    if (msg) state.events.push({ at: now(), msg });
    await saveRun(dir, state);
    onEvent(state, msg);
  };
  const finish = async (status, error = null) => {
    state.status = status;
    state.error = error;
    state.finishedAt = now();
    await save(status === 'passed' ? 'Run passed every gate' : `Run ${status}${error ? `: ${error}` : ''}`);
    return state;
  };

  const isGit = await excludeFactoryDir(dir);
  // Only the factory's own work may end up in its commit, so start from a clean tree.
  const baseline = isGit ? await snapshot(dir) : new Map();
  if (baseline.size > 0 && !allowDirty) {
    await save('Working tree has uncommitted changes');
    return finish(
      'failed',
      `working tree has ${baseline.size} uncommitted change(s); commit or stash them, or pass --allow-dirty`,
    );
  }
  await fs.mkdir(artifactDir, { recursive: true });
  await save(`Run started with ${executor.name} executor: ${title}`);

  const ctx = {
    dir,
    runId,
    request,
    title,
    project,
    rel,
    artifactDir,
    artifacts: {
      spec: path.join(artifactDir, 'SPEC.md'),
      plan: path.join(artifactDir, 'PLAN.md'),
      review: path.join(artifactDir, 'REVIEW.md'),
    },
    commandTimeoutMs,
    baseline,
    log: null,
    attemptStartedMs: null,
    snapshotBefore: null,
  };

  if (install && project.commands.install) {
    await save(`Installing dependencies: ${project.commands.install}`);
    const r = await exec(project.commands.install, { cwd: dir, timeoutMs: commandTimeoutMs });
    await appendLog(dir, runId, 'setup-1.log', `$ ${project.commands.install}\n${r.stdout}\n${r.stderr}\n`);
    if (r.code !== 0) return finish('failed', `install failed (exit ${r.code}); see setup-1.log`);
  }

  const feedbackFor = {};
  let i = 0;
  while (i < stages.length) {
    const stage = stages[i];
    const sState = state.stages[i];

    if (stage.deterministic) {
      sState.status = 'running';
      await save(`Stage ${stage.id} started`);
      const attempt = { n: sState.attempts.length + 1, startedAt: now(), log: `${stage.id}-${sState.attempts.length + 1}.log` };
      sState.attempts.push(attempt);
      const result = await shipStage({ ctx, state, ship, commit, issue, logName: attempt.log });
      Object.assign(attempt, { finishedAt: now(), ok: gatePassed(result.checks), gate: result.checks, summary: result.summary });
      sState.status = attempt.ok ? 'passed' : 'failed';
      await save(`Stage ${stage.id} ${sState.status}`);
      if (!attempt.ok) return finish('failed', describeFailures(result.checks).split('\n')[0]);
      i++;
      continue;
    }

    let passed = false;
    let rewind = false;
    let lastChecks = [];
    for (let n = 1; n <= maxAttempts && !passed; n++) {
      const logName = `${stage.id}-${sState.attempts.length + 1}.log`;
      const attempt = { n: sState.attempts.length + 1, startedAt: now(), log: logName, feedback: feedbackFor[stage.id] ?? null };
      sState.attempts.push(attempt);
      sState.status = 'running';
      await save(`Stage ${stage.id} attempt ${attempt.n} started (${stage.agent})`);

      ctx.attemptStartedMs = Date.now();
      ctx.snapshotBefore = await snapshot(dir);
      const prompt = stage.prompt(ctx, feedbackFor[stage.id]);
      await appendLog(dir, runId, logName, `# prompt\n${prompt}\n\n# agent output\n`);
      const result = await executor.run({
        stage,
        prompt,
        dir,
        ctx,
        onData: (d) => appendLog(dir, runId, logName, d).catch(() => {}),
      });
      state.costUsd += result.costUsd ?? 0;
      attempt.costUsd = result.costUsd ?? 0;
      attempt.summary = String(result.summary ?? '').slice(0, 4000);
      attempt.error = result.error;

      ctx.log = (line) => appendLog(dir, runId, logName, `${line}\n`).catch(() => {});
      await appendLog(dir, runId, logName, `\n# gate\n`);
      const checks = await gates[stage.id](ctx);
      attempt.gate = checks;
      attempt.finishedAt = now();
      attempt.ok = gatePassed(checks);
      lastChecks = checks;
      await appendLog(
        dir,
        runId,
        logName,
        checks
          .map((c) => `${c.ok ? 'PASS' : c.severity === 'warn' ? 'WARN' : 'FAIL'} ${c.name}${c.detail ? `\n${c.detail}` : ''}`)
          .join('\n') + '\n',
      );

      if (attempt.ok) {
        passed = true;
        sState.status = 'passed';
        delete feedbackFor[stage.id];
        await save(`Stage ${stage.id} passed its gate`);
        break;
      }
      const failures = describeFailures(checks);
      feedbackFor[stage.id] = [result.error ? `Agent error: ${result.error}` : '', failures].filter(Boolean).join('\n\n');
      await save(`Stage ${stage.id} attempt ${attempt.n} failed its gate`);
      // A reviewer rejecting the code will not change its mind on retry; the code has to change.
      if (stage.retryFrom && existsSync(ctx.artifacts.review)) {
        rewind = true;
        break;
      }
    }

    if (passed) {
      i++;
      continue;
    }

    const target = stage.retryFrom ? stages.findIndex((s) => s.id === stage.retryFrom) : -1;
    if (rewind && target >= 0 && state.reviewLoops < maxReviewLoops) {
      state.reviewLoops++;
      const review = existsSync(ctx.artifacts.review) ? await fs.readFile(ctx.artifacts.review, 'utf8') : '';
      feedbackFor[stage.retryFrom] =
        `The code review requested changes. Address every BLOCKER and MAJOR finding.\n\n${tail(review, 8000)}\n\n${describeFailures(lastChecks)}`;
      for (let j = target; j <= i; j++) state.stages[j].status = 'pending';
      sState.status = 'pending';
      await save(`Review requested changes; rewinding to ${stage.retryFrom} (loop ${state.reviewLoops}/${maxReviewLoops})`);
      i = target;
      continue;
    }

    sState.status = 'failed';
    return finish('failed', `${stage.id} gate failed: ${describeFailures(lastChecks).split('\n')[0]}`);
  }

  return finish('passed');
}

function prBody(ctx, state, spec, review, issue) {
  const section = (md, h) =>
    md.match(new RegExp(`^##\\s+${h}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im'))?.[1]?.trim() ?? '';
  const gateRows = state.stages
    .filter((s) => s.attempts.length)
    .map((s) => {
      const last = s.attempts[s.attempts.length - 1];
      return `| ${s.title} | ${s.status === 'passed' || last.ok ? '✅' : '⏳'} | ${s.attempts.length} | ${(last.gate ?? []).filter((c) => c.ok).length}/${(last.gate ?? []).length} |`;
    });
  return [
    `## Summary`,
    section(spec, 'Problem') || ctx.title,
    ``,
    `## Acceptance criteria`,
    section(spec, 'Acceptance Criteria') || '_see spec_',
    ``,
    `## Factory gates`,
    `| Stage | Gate | Attempts | Checks passed |`,
    `|---|---|---|---|`,
    ...gateRows,
    ``,
    `Review verdict: ${review.match(VERDICT_RE)?.[1] ?? 'n/a'} · review loops: ${state.reviewLoops} · agent cost: $${state.costUsd.toFixed(2)}`,
    ``,
    `Spec, plan and review: \`${state.artifactDir}/\``,
    issue ? `\nCloses #${issue}` : '',
    ``,
    `---`,
    `Built by [software-factory](https://github.com/taugustincst/software-factory) run \`${state.id}\`. A human must review and merge.`,
  ].join('\n');
}

async function shipStage({ ctx, state, ship, commit, issue, logName }) {
  const checks = [];
  const log = (s) => appendLog(ctx.dir, state.id, logName, `${s}\n`);
  const git = async (...args) => {
    const r = await exec(['git', ...args], { cwd: ctx.dir });
    await log(`$ git ${args.join(' ')} → ${r.code}\n${r.stdout}${r.stderr}`);
    return r;
  };

  if (!commit)
    return {
      checks: [{ name: 'commit', ok: true, severity: 'warn', detail: 'skipped (--no-commit)' }],
      summary: 'commit skipped',
    };
  if ((await git('rev-parse', '--is-inside-work-tree')).code !== 0) {
    return {
      checks: [{ name: 'git repository', ok: true, severity: 'warn', detail: 'not a git repo; nothing to commit' }],
      summary: 'not a git repo',
    };
  }

  const branch = `factory/${slugify(ctx.title, 30)}-${state.id.slice(-4)}`;
  const current = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  if (current !== branch) {
    const sw = await git('switch', '-c', branch);
    checks.push({ name: `branch ${branch}`, ok: sw.code === 0, severity: 'error', detail: sw.stderr.trim() });
    if (sw.code !== 0) return { checks, summary: 'could not create branch' };
  }
  state.branch = branch;

  // Stage only this directory, and with --allow-dirty only files the run changed.
  if (ctx.baseline?.size) {
    const after = await snapshot(ctx.dir);
    const changed = [...after.keys()].filter((f) => after.get(f) !== ctx.baseline.get(f));
    if (changed.length) await git('add', '-A', '--', ...changed);
  } else {
    await git('add', '-A', '--', '.');
  }
  const subject = `feat: ${ctx.title.charAt(0).toLowerCase()}${ctx.title.slice(1)}`.slice(0, 72);
  const body = `Spec, plan and review: ${state.artifactDir}/\nFactory run: ${state.id}${issue ? `\n\nCloses #${issue}` : ''}`;
  const c = await git('commit', '-m', subject, '-m', body);
  checks.push({
    name: 'commit created',
    ok: c.code === 0,
    severity: 'error',
    detail: c.code === 0 ? subject : tail(c.stdout + c.stderr, 1500),
  });
  if (c.code !== 0 || !ship) return { checks, summary: c.code === 0 ? `committed on ${branch}` : 'commit failed' };

  const push = await git('push', '-u', 'origin', branch);
  checks.push({ name: 'pushed to origin', ok: push.code === 0, severity: 'error', detail: tail(push.stderr, 1500) });
  if (push.code !== 0) return { checks, summary: 'push failed' };

  const spec = existsSync(ctx.artifacts.spec) ? await fs.readFile(ctx.artifacts.spec, 'utf8') : '';
  const review = existsSync(ctx.artifacts.review) ? await fs.readFile(ctx.artifacts.review, 'utf8') : '';
  const bodyFile = path.join(ctx.dir, '.factory', 'runs', state.id, 'PR.md');
  await fs.writeFile(bodyFile, prBody(ctx, state, spec, review, issue));
  const pr = await exec(['gh', 'pr', 'create', '--title', subject, '--body-file', bodyFile, '--head', branch], { cwd: ctx.dir });
  await log(`$ gh pr create → ${pr.code}\n${pr.stdout}${pr.stderr}`);
  const url = pr.stdout.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
  state.prUrl = url;
  checks.push({
    name: 'pull request opened',
    ok: pr.code === 0 && Boolean(url),
    severity: 'error',
    detail: url ?? tail(pr.stderr, 1500),
  });
  return { checks, summary: url ? `PR: ${url}` : 'PR creation failed' };
}

/**
 * Ship a run that already passed review (e.g. `factory run --no-commit` in a read-only CI job,
 * then `factory ship` in a separate job that holds the write token).
 */
export async function shipRun({ dir, runId, issue = null, push = true, onEvent = () => {} }) {
  dir = path.resolve(dir);
  const state = await readRun(dir, runId);
  if (!state) throw new Error(`run ${runId} not found in ${dir}/.factory/runs`);
  if (state.status !== 'passed') throw new Error(`run ${runId} has status "${state.status}"; only passed runs can ship`);
  const review = state.stages.find((s) => s.id === 'review');
  if (!review || review.status !== 'passed') throw new Error(`run ${runId} has no passed review stage`);

  const artifactDir = path.join(dir, state.artifactDir);
  const ctx = {
    dir,
    title: state.title,
    artifactDir,
    artifacts: {
      spec: path.join(artifactDir, 'SPEC.md'),
      plan: path.join(artifactDir, 'PLAN.md'),
      review: path.join(artifactDir, 'REVIEW.md'),
    },
    baseline: new Map(),
  };
  let sState = state.stages.find((s) => s.id === 'ship');
  if (!sState) {
    sState = { id: 'ship', title: 'Ship', agent: null, status: 'pending', attempts: [] };
    state.stages.push(sState);
  }
  const attempt = { n: sState.attempts.length + 1, startedAt: now(), log: `ship-${sState.attempts.length + 1}.log` };
  sState.attempts.push(attempt);
  sState.status = 'running';
  state.ship = push;
  issue = issue ?? state.issue;
  const result = await shipStage({ ctx, state, ship: push, commit: true, issue, logName: attempt.log });
  Object.assign(attempt, { finishedAt: now(), ok: gatePassed(result.checks), gate: result.checks, summary: result.summary });
  sState.status = attempt.ok ? 'passed' : 'failed';
  if (!attempt.ok) {
    state.status = 'failed';
    state.error = describeFailures(result.checks).split('\n')[0];
  }
  state.events.push({ at: now(), msg: `Ship ${sState.status}${state.prUrl ? `: ${state.prUrl}` : ''}` });
  await saveRun(dir, state);
  onEvent(state);
  return state;
}
