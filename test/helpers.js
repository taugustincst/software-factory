import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
