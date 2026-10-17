import { parseArgs } from 'node:util';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, color, which, run } from '../util.js';
import { scaffold, listTemplates } from '../scaffold.js';
import { installClaudeKit } from '../claude-kit.js';
import { runPipeline, shipRun } from '../pipeline/runner.js';
import { claudeExecutor, mockExecutor } from '../pipeline/executors.js';
import { listRuns, RUN_ID_RE } from '../pipeline/store.js';
import { STAGES } from '../pipeline/stages.js';

const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const HELP = `${color.bold('factory')} ${VERSION} — automated software factory

Usage
  factory new <name> --template <id> [options]   Scaffold a project with CI, security and the Claude kit
  factory templates                              List templates
  factory install-claude [dir] [--force]         Add agents, commands, skills and guard hooks to any repo
  factory run --spec <file> | --request <text>   Run spec → plan → build → test → review → ship
  factory ship --run-id <id> [--issue <n>]        Push and open a PR for a run that passed (CI ship job)
  factory runs [--dir <dir>]                     List pipeline runs
  factory dashboard [--dir <dir>] [--port 4545]  Open the pipeline dashboard
  factory upgrade [--dir <dir>] [--dry-run]      Merge current template changes into an existing project
  factory doctor                                 Check required tools

new options
  --template, -t <id>     static-html | fullstack | node-service | python-service
  --dir <path>            Target directory (default ./<name>)
  --description <text>    One-line description
  --owner <github-user>   For CODEOWNERS and links (default: your-github-user)
  --no-install            Skip dependency install
  --no-git                Skip git init and first commit
  --no-claude             Skip the Claude Code kit

run options
  --dir <path>            Repository to work in (default .)
  --spec <file>           Request/spec text from a file (an issue body works)
  --request <text>        Request text inline
  --stages <list>         Subset, e.g. spec,plan (default: all: ${STAGES.map((s) => s.id).join(',')})
  --executor <name>       claude (default) | mock (offline demo, no API calls)
  --model <name>          Claude model for agent stages
  --review-model <name>   Different model for the review stage (a second pair of eyes)
  --max-attempts <n>      Attempts per stage before failing (default 3)
  --max-review-loops <n>  Times a rejected review may send work back to build (default 2)
  --budget-multiplier <x> Scale per-stage spend caps (default 1)
  --max-run-usd <usd>     Stop the run when total agent spend reaches this cap (default 15; 0 disables)
  --ship                  Push the branch and open a pull request with gh
  --no-commit             Leave changes uncommitted
  --no-install            Skip the install command
  --allow-dirty           Start with uncommitted changes (only the run's own changes are committed)
  --issue <n>             Issue number to close from the PR
  --run-id <id>           Use a specific run id (used by the dashboard)
  --pause-after <stage>   Stop after this stage passes, saving the run as paused (e.g. spec)
  --resume <run-id>       Resume a paused run from its next stage (no --spec/--request needed)

upgrade options
  --dir <path>            Project to upgrade (default .)
  --dry-run               Report what would change without writing anything
`;

function fail(msg) {
  process.stderr.write(`${color.red('error')} ${msg}\n`);
  process.exit(1);
}

async function cmdNew(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      template: { type: 'string', short: 't' },
      dir: { type: 'string' },
      description: { type: 'string' },
      owner: { type: 'string' },
      'no-install': { type: 'boolean' },
      'no-git': { type: 'boolean' },
      'no-claude': { type: 'boolean' },
    },
  });
  const name = positionals[0];
  if (!name) fail('usage: factory new <name> --template <id>');
  if (!values.template) fail(`--template is required. Run "factory templates" to see options.`);
  const result = await scaffold({
    template: values.template,
    name,
    dir: values.dir,
    description: values.description,
    owner: values.owner,
    install: !values['no-install'],
    git: !values['no-git'],
    claude: !values['no-claude'],
    log: (m) => process.stdout.write(`${color.dim('•')} ${m}\n`),
  });
  const rel = path.relative(process.cwd(), result.target) || '.';
  const c = result.template.commands;
  process.stdout.write(
    `\n${color.green('✓')} Created ${color.bold(name)} from ${result.template.id} in ${rel}\n\n` +
      `Next:\n  cd ${rel}\n` +
      (result.steps.install === 'ok' || !c.install ? '' : `  ${c.install}\n`) +
      (c.dev ? `  ${c.dev}          # run locally\n` : '') +
      `  ${c.test}          # tests\n` +
      `  claude              # then try /factory <feature idea>\n\n` +
      `Push to GitHub:  gh repo create ${result.vars.owner === 'your-github-user' ? '' : `${result.vars.owner}/`}${name} --private --source . --push\n`,
  );
}

async function cmdTemplates() {
  for (const t of await listTemplates()) {
    process.stdout.write(`${color.bold(t.id.padEnd(16))} ${t.title}\n${' '.repeat(17)}${color.dim(t.stack)}\n`);
  }
}

async function cmdInstallClaude(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { force: { type: 'boolean' } } });
  const dir = path.resolve(positionals[0] ?? '.');
  if (!existsSync(dir)) fail(`no such directory: ${dir}`);
  const r = await installClaudeKit(dir, { force: values.force });
  process.stdout.write(
    `${color.green('✓')} Claude kit installed in ${dir}\n` +
      `  written: ${r.written.length}  merged: ${r.merged.join(', ') || 'none'}  kept existing: ${r.skipped.length}\n` +
      `Open Claude Code there and run /factory <feature>, or /spec, /plan, /build, /test, /review, /ship.\n`,
  );
}

function printProgress(state, msg) {
  if (!msg) return;
  const icon = /passed/.test(msg) ? color.green('✓') : /failed|rewinding/.test(msg) ? color.yellow('!') : color.dim('•');
  process.stdout.write(`${icon} ${msg}\n`);
}

async function cmdRun(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: '.' },
      spec: { type: 'string' },
      request: { type: 'string' },
      stages: { type: 'string' },
      executor: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      'review-model': { type: 'string' },
      'max-attempts': { type: 'string', default: '3' },
      'max-review-loops': { type: 'string', default: '2' },
      'budget-multiplier': { type: 'string', default: '1' },
      'max-run-usd': { type: 'string', default: '15' },
      ship: { type: 'boolean' },
      'no-commit': { type: 'boolean' },
      'no-install': { type: 'boolean' },
      'allow-dirty': { type: 'boolean' },
      issue: { type: 'string' },
      'run-id': { type: 'string' },
      'pause-after': { type: 'string' },
      resume: { type: 'string' },
    },
  });
  const request = values.spec ? await fs.readFile(values.spec, 'utf8') : values.request;
  if (!values.resume && !request?.trim()) fail('provide --spec <file> or --request "<text>" (or --resume <run-id>)');
  if (values['run-id'] && !RUN_ID_RE.test(values['run-id'])) fail('invalid --run-id');
  if (values.resume && !RUN_ID_RE.test(values.resume)) fail('invalid --resume run id');
  if (values['pause-after'] && !STAGES.some((s) => s.id === values['pause-after']))
    fail(`--pause-after must be a stage: ${STAGES.map((s) => s.id).join(', ')}`);
  const int = (k, min, max) => {
    const n = Number(values[k]);
    if (!Number.isInteger(n) || n < min || n > max) fail(`--${k} must be an integer from ${min} to ${max}`);
    return n;
  };

  let executor;
  if (values.executor === 'mock') executor = mockExecutor({ delayMs: Number(process.env.FACTORY_MOCK_DELAY_MS ?? 0) });
  else if (values.executor === 'claude') {
    if (!(await which('claude'))) fail('Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code');
    const mult = Number(values['budget-multiplier']);
    if (!(mult > 0 && mult <= 20)) fail('--budget-multiplier must be > 0 and ≤ 20');
    executor = claudeExecutor({ model: values.model, reviewModel: values['review-model'], budgetMultiplier: mult });
  } else fail(`unknown executor "${values.executor}" (claude | mock)`);

  // Ctrl-C / SIGTERM cancel the run cooperatively: the pipeline stops at its
  // next checkpoint, kills any in-flight agent/gate process, saves the run as
  // 'cancelled' and releases the repo lock. A second signal force-exits.
  const abort = new AbortController();
  let signals = 0;
  const onSignal = (sig) => {
    signals++;
    if (signals > 1) process.exit(130);
    process.stdout.write(`\n${sig} received; cancelling the run (again to force exit)\u2026\n`);
    abort.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const state = await runPipeline({
    dir: values.dir,
    signal: abort.signal,
    request,
    executor,
    stages: values.stages
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxAttempts: int('max-attempts', 1, 10),
    maxRunUsd: (() => {
      const cap = Number(values['max-run-usd']);
      if (!Number.isFinite(cap) || cap < 0 || cap > 100000) fail('--max-run-usd must be a number from 0 (disabled) to 100000');
      return cap === 0 ? null : cap;
    })(),
    pauseAfter: values['pause-after'] ?? null,
    resumeRunId: values.resume ?? null,
    maxReviewLoops: int('max-review-loops', 0, 5),
    ship: Boolean(values.ship),
    commit: !values['no-commit'],
    install: !values['no-install'],
    allowDirty: Boolean(values['allow-dirty']),
    issue: values.issue ? String(int('issue', 1, 1e9)) : null,
    runId: values['run-id'],
    onEvent: printProgress,
  });

  process.stdout.write(
    `\n${state.status === 'passed' ? color.green('PASSED') : state.status === 'paused' ? color.yellow('PAUSED') : color.red(state.status.toUpperCase())}  run ${state.id}` +
      `  cost $${state.costUsd.toFixed(2)}${state.branch ? `  branch ${state.branch}` : ''}${state.prUrl ? `\nPR: ${state.prUrl}` : ''}\n` +
      `Artifacts: ${state.artifactDir}/   Logs: .factory/runs/${state.id}/\n`,
  );
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `status=${state.status}\nrun_id=${state.id}\npr_url=${state.prUrl ?? ''}\nbranch=${state.branch ?? ''}\n`,
    );
  }
  process.exit(state.status === 'passed' || state.status === 'paused' ? 0 : 1);
}

async function cmdShip(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: '.' },
      'run-id': { type: 'string' },
      issue: { type: 'string' },
      'no-push': { type: 'boolean' },
    },
  });
  if (!values['run-id'] || !RUN_ID_RE.test(values['run-id'])) fail('--run-id <id> is required');
  if (values.issue && !/^[1-9]\d{0,9}$/.test(values.issue)) fail('--issue must be a positive integer');
  const state = await shipRun({
    dir: values.dir,
    runId: values['run-id'],
    issue: values.issue ?? null,
    push: !values['no-push'],
  });
  const ship = state.stages.find((s) => s.id === 'ship');
  const last = ship.attempts.at(-1);
  for (const c of last.gate)
    process.stdout.write(`${c.ok ? color.green('✓') : color.red('✗')} ${c.name}${c.ok ? '' : `\n${c.detail}`}\n`);
  process.stdout.write(`${state.prUrl ? `PR: ${state.prUrl}\n` : ''}`);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `status=${state.status}\npr_url=${state.prUrl ?? ''}\nbranch=${state.branch ?? ''}\n`,
    );
  }
  process.exit(ship.status === 'passed' ? 0 : 1);
}

async function cmdUpgrade(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: '.' },
      'dry-run': { type: 'boolean' },
    },
  });
  const dir = path.resolve(values.dir);
  const dryRun = Boolean(values['dry-run']);
  const { loadProject } = await import('../pipeline/project.js');
  const project = await loadProject(dir);
  if (project.inferred || !(await fs.stat(path.join(dir, 'factory.json')).catch(() => null))) {
    fail('no factory.json here — factory upgrade works on projects scaffolded by the factory');
  }
  // Merging on top of uncommitted work would make the result unattributable;
  // a dry run only reads, so it is allowed (and says so).
  const statusResult = await run(['git', 'status', '--porcelain', '--', '.', ':(exclude).factory'], { cwd: dir });
  const status = statusResult.code === 0 ? statusResult.stdout : null;
  if (status !== null && status.trim() && !dryRun) {
    fail('working tree has uncommitted changes; commit or stash them before upgrading (or use --dry-run to preview)');
  }
  if (status !== null && status.trim() && dryRun)
    process.stdout.write('note: previewing against a dirty tree; a real upgrade requires a clean tree\n');

  const { prepareBase, renderNewTemplate, mergeUpgrade, writeBaseSnapshot } = await import('../upgrade.js');
  process.stdout.write(`Rendering the current ${project.template} template…\n`);
  const rendered = await renderNewTemplate({ dir }).catch((e) => fail(e.message));
  try {
    const base = await prepareBase({ dir }).catch((e) => fail(e.message));
    try {
      process.stdout.write(`Merge base: ${base.source}\n`);
      const report = await mergeUpgrade({ dir, baseDir: base.baseDir, newDir: rendered.newDir, dryRun });
      const show = (label, items) => {
        if (items.length) process.stdout.write(`  ${label}: ${items.join(', ')}\n`);
      };
      process.stdout.write(
        `${dryRun ? 'Dry run' : 'Upgrade'} complete: ${report.updated.length} updated, ${report.added.length} added, ` +
          `${report.merged.length} merged, ${report.removed.length} removed, ${report.kept.length} kept, ` +
          `${report.conflicts.length} conflict(s), ${report.unchanged} unchanged\n`,
      );
      show('updated', report.updated);
      show('added', report.added);
      show('merged', report.merged);
      show('removed', report.removed);
      show('kept', report.kept);
      show('CONFLICTS', report.conflicts);
      if (!dryRun) {
        await writeBaseSnapshot(dir, rendered.newDir, {
          template: project.template,
          upgradedAt: new Date().toISOString(),
          at: new Date().toISOString(),
        });
        process.stdout.write('Review the changes and commit them; run the project checks before pushing.\n');
      }
      process.exit(report.conflicts.length ? 1 : 0);
    } finally {
      await base.cleanup();
    }
  } finally {
    await rendered.cleanup();
  }
}

async function cmdRuns(argv) {
  const { values } = parseArgs({ args: argv, options: { dir: { type: 'string', default: '.' } } });
  const runs = await listRuns(path.resolve(values.dir));
  if (!runs.length) return process.stdout.write('No runs yet. Start one with: factory run --request "..."\n');
  for (const r of runs) {
    const stages = r.stages.map((s) => ({ passed: '●', failed: '✗', running: '◐', pending: '○' })[s.status] ?? '○').join('');
    process.stdout.write(`${r.id}  ${r.status.padEnd(8)} ${stages}  $${(r.costUsd ?? 0).toFixed(2)}  ${r.title}\n`);
  }
}

async function cmdDashboard(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { dir: { type: 'string', default: '.' }, port: { type: 'string', default: '4545' } },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be 1024-65535');
  const { startDashboard } = await import('../dashboard/server.js');
  const { url } = await startDashboard({ dir: path.resolve(values.dir), port });
  process.stdout.write(`Dashboard: ${url}  (Ctrl+C to stop)\n`);
}

async function cmdDoctor() {
  const tools = [
    ['node', ['node', '--version'], true, 'https://nodejs.org (v20+)'],
    ['git', ['git', '--version'], true, 'https://git-scm.com'],
    ['claude', ['claude', '--version'], false, 'npm install -g @anthropic-ai/claude-code (needed for factory run)'],
    ['gh', ['gh', '--version'], false, 'https://cli.github.com (needed for --ship)'],
    ['uv', ['uv', '--version'], false, 'https://docs.astral.sh/uv (python-service template)'],
    ['docker', ['docker', '--version'], false, 'https://docs.docker.com (container builds)'],
  ];
  let bad = false;
  for (const [name, cmd, required, hint] of tools) {
    const r = await run(cmd);
    const ok = r.code === 0;
    if (!ok && required) bad = true;
    process.stdout.write(
      `${ok ? color.green('✓') : required ? color.red('✗') : color.yellow('–')} ${name.padEnd(7)} ${ok ? r.stdout.split('\n')[0] : hint}\n`,
    );
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    bad = true;
    process.stdout.write(`${color.red('✗')} Node ${process.versions.node} is too old; need 20+\n`);
  }
  process.exit(bad ? 1 : 0);
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'new':
        return await cmdNew(rest);
      case 'templates':
        return await cmdTemplates();
      case 'install-claude':
        return await cmdInstallClaude(rest);
      case 'run':
        return await cmdRun(rest);
      case 'ship':
        return await cmdShip(rest);
      case 'runs':
        return await cmdRuns(rest);
      case 'upgrade':
        return await cmdUpgrade(rest);
      case 'dashboard':
        return await cmdDashboard(rest);
      case 'doctor':
        return await cmdDoctor();
      case '--version':
      case '-v':
        return process.stdout.write(`${VERSION}\n`);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return process.stdout.write(HELP);
      default:
        fail(`unknown command "${cmd}". Run "factory --help".`);
    }
  } catch (err) {
    fail(err.message);
  }
}
