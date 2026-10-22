#!/usr/bin/env node
// End-to-end smoke test: scaffold each template, install, then run its real lint/typecheck/test/build,
// and finally run the agent pipeline (mock executor) inside the generated project.
// Usage: node scripts/smoke.js [template ...]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffold, listTemplates } from '../src/scaffold.js';
import { runPipeline } from '../src/pipeline/runner.js';
import { mockExecutor } from '../src/pipeline/executors.js';
import { run, color } from '../src/util.js';

const wanted = process.argv.slice(2);
const templates = (await listTemplates()).filter((t) => !wanted.length || wanted.includes(t.id));
const root = mkdtempSync(path.join(tmpdir(), 'factory-smoke-'));
let failed = 0;

for (const t of templates) {
  const dir = path.join(root, t.id);
  process.stdout.write(`\n${color.bold(t.id)}\n`);
  const { steps } = await scaffold({
    template: t.id,
    name: `smoke-${t.id}`,
    dir,
    install: true,
    git: true,
    log: (m) => process.stdout.write(`  · ${m}\n`),
  });
  if (steps.install !== 'ok') {
    failed++;
    process.stdout.write(`  ${color.red('✗')} install\n`);
    continue;
  }
  // `migrate` runs when a template defines it (DB templates): the ephemeral
  // Postgres from CI (DATABASE_URL) must be migrated before the test suite.
  // `e2e` runs when a template defines it (UI templates): Playwright browsers
  // are machine-level, not npm dependencies, so install Chromium into the
  // shared browser cache first (a no-op when the revision is already there).
  for (const key of ['lint', 'typecheck', 'migrate', 'test', 'build', 'e2e']) {
    const cmd = t.commands[key];
    if (!cmd) continue;
    if (key === 'e2e') await run('npx playwright install chromium', { cwd: dir });
    const started = Date.now();
    const r = await run(cmd, { cwd: dir });
    const ok = r.code === 0;
    if (!ok) failed++;
    process.stdout.write(
      `  ${ok ? color.green('✓') : color.red('✗')} ${key.padEnd(9)} ${color.dim(`${cmd} (${((Date.now() - started) / 1000).toFixed(1)}s)`)}\n`,
    );
    if (!ok) process.stdout.write(`${(r.stdout + r.stderr).slice(-3000)}\n`);
  }
  const clean = await run(['git', 'status', '--porcelain'], { cwd: dir });
  const dirty = clean.stdout.trim();
  if (dirty) {
    failed++;
    process.stdout.write(`  ${color.red('✗')} working tree not clean after checks:\n${dirty}\n`);
  } else {
    process.stdout.write(`  ${color.green('✓')} clean tree  ${color.dim('(scaffold + checks leave nothing uncommitted)')}\n`);
  }
  // Mock pipeline: proves the gates run this project's real commands end to end.
  const state = await runPipeline({
    dir,
    request: `# Smoke change for ${t.id}\n\nExercise the pipeline.`,
    executor: mockExecutor(),
    install: false,
  });
  const ok = state.status === 'passed';
  if (!ok) failed++;
  process.stdout.write(
    `  ${ok ? color.green('✓') : color.red('✗')} pipeline  ${color.dim(`mock run ${state.id} → ${state.status}${state.error ? `: ${state.error}` : ''}`)}\n`,
  );
}

if (!process.env.KEEP) rmSync(root, { recursive: true, force: true });
else process.stdout.write(`\nKept: ${root}\n`);
process.stdout.write(`\n${failed ? color.red(`${failed} check(s) failed`) : color.green('All templates passed')}\n`);
process.exit(failed ? 1 : 0);
