#!/usr/bin/env node
// Coverage gate for the factory's own suite: runs node:test with the built-in
// coverage reporter, scoped to the factory's own source (src/ and bin/ — the
// templates and claude-kit trees are shipped content, covered by smoke, not by
// this gate), and fails if any measured metric drops below its threshold.
//
// Usage: node scripts/coverage.js --cov-fail-under=<lines> \
//          [--cov-fail-under-branches=<n>] [--cov-fail-under-functions=<n>]
//
// Thresholds are enforced here, in plain JS, instead of via the test runner's
// own --test-coverage-* flags: those flags landed later than the coverage
// reporter itself, and this wrapper behaves identically on Node 22 and 24
// (the CI matrix). Fails closed: no coverage summary, no pass.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FLAGS = {
  '--cov-fail-under': 'lines',
  '--cov-fail-under-branches': 'branches',
  '--cov-fail-under-functions': 'functions',
};
const thresholds = {};
for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg : arg.slice(0, eq);
  const value = eq === -1 ? NaN : Number(arg.slice(eq + 1));
  if (!(name in FLAGS) || !Number.isFinite(value) || value < 0 || value > 100) {
    process.stderr.write(
      `usage: coverage.js --cov-fail-under=<lines 0-100> [--cov-fail-under-branches=<n>] [--cov-fail-under-functions=<n>]\n`,
    );
    process.exit(2);
  }
  thresholds[FLAGS[name]] = value;
}
if (thresholds.lines === undefined) {
  process.stderr.write('coverage.js: --cov-fail-under=<lines> is required\n');
  process.exit(2);
}

const child = spawn(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=src/**/*.js',
    '--test-coverage-include=bin/*.js',
    'test/**/*.test.js',
  ],
  { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] },
);
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
const code = await new Promise((resolve) => {
  child.on('error', () => resolve(127));
  child.on('close', resolve);
});
if (code !== 0) process.exit(code ?? 1);

// The summary row: "all files | 92.41 | 79.34 | 90.78 |" (line, branch, funcs).
const summary = /all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(out);
if (!summary) {
  process.stderr.write('coverage.js: no coverage summary found in the test output; failing closed\n');
  process.exit(1);
}
const measured = { lines: Number(summary[1]), branches: Number(summary[2]), functions: Number(summary[3]) };
const failed = Object.entries(thresholds).filter(([metric, min]) => measured[metric] < min);
for (const [metric, min] of Object.entries(thresholds)) {
  process.stdout.write(
    `coverage ${metric}: ${measured[metric].toFixed(2)}% (threshold ${min}%) ${measured[metric] < min ? 'FAIL' : 'ok'}\n`,
  );
}
if (failed.length) {
  process.stderr.write(
    `coverage.js: below threshold: ${failed.map(([m, min]) => `${m} ${measured[m].toFixed(2)}% < ${min}%`).join(', ')}\n`,
  );
  process.exit(1);
}
