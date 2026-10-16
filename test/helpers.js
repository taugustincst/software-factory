import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Git identity for child processes (scaffold() makes a first commit, the pipeline
// commits on a branch). CI runners and fresh machines have no global git config,
// so default one here — this module is imported by the test files that shell out
// to git. Values already set in the environment always win.
process.env.GIT_AUTHOR_NAME ??= 'Test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'Test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

export function tmp(prefix = 'sf-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A tiny git repo with a factory.json whose commands always succeed (or fail on demand). */
export function fixtureRepo({ commands } = {}) {
  const dir = tmp('sf-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(
    path.join(dir, 'factory.json'),
    JSON.stringify({ name: 'fixture', template: 'test', commands: commands ?? { lint: 'node -e 0', test: 'node -e 0' } }),
  );
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'index.js'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git: (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }) };
}
