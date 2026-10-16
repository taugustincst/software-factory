import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../claude-kit/.claude/hooks');
const runHook = (name, input, env = {}) =>
  spawnSync(process.execPath, [path.join(HOOKS, name)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/repo', ...env },
  });

test('guard-bash blocks with exit 2 and explains why', () => {
  const r = runHook('guard-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /force-push/);
});

test('guard-bash allows safe commands', () => {
  assert.equal(runHook('guard-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'npm test' } }).status, 0);
});

test('guard-bash tolerates empty or malformed input', () => {
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'guard-bash.mjs')], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('guard-files blocks writes to .env', () => {
  const r = runHook('guard-files.mjs', { tool_name: 'Write', tool_input: { file_path: '/repo/.env', content: 'A=1' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /env files/);
});

test('guard-files blocks secrets in Edit and MultiEdit content', () => {
  const edit = runHook('guard-files.mjs', {
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'const k = "AKIAABCDEFGHIJKLMNOP";' },
  });
  assert.equal(edit.status, 2);
  const multi = runHook('guard-files.mjs', {
    tool_name: 'MultiEdit',
    tool_input: { file_path: '/repo/test/fx.json', edits: [{ old_string: 'a', new_string: '{"ssn": "123-45-6789"}' }] },
  });
  assert.equal(multi.status, 2);
  assert.match(multi.stderr, /ssn-phi/);
});

test('guard-files allows synthetic data and normal files', () => {
  const r = runHook('guard-files.mjs', {
    tool_name: 'Write',
    tool_input: { file_path: '/repo/test/patients.json', content: '{"ssn": "900-12-3456", "mrn": "SYN-000123"}' },
  });
  assert.equal(r.status, 0, r.stderr);
});

test('format-file never blocks', () => {
  assert.equal(runHook('format-file.mjs', { tool_input: { file_path: '/nonexistent/file.ts' } }).status, 0);
});
