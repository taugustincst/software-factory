import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeUpgrade, prepareBase } from '../src/upgrade.js';
import { scaffold } from '../src/scaffold.js';
import { tmp } from './helpers.js';

async function tree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}
const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8');
const has = (root, rel) => existsSync(path.join(root, rel));

test('mergeUpgrade fast-forwards, merges, conflicts, adds and removes by the three-way rules', async () => {
  const baseDir = await tree(path.join(tmp(), 'base'), {
    'updated.txt': 'v1\n',
    'kept.txt': 'v1\n',
    'merge.txt': 'a\nb\nc\nd\n',
    'conflict.txt': 'one\ntwo\nthree\n',
    'removed.txt': 'gone in v2\n',
    'removed-modified.txt': 'gone in v2\n',
    'same.txt': 'unchanged\n',
  });
  const freshDir = await tree(path.join(tmp(), 'fresh'), {
    'updated.txt': 'v2\n',
    'kept.txt': 'v1\n',
    'merge.txt': 'a\nb\nc\nD2\n',
    'conflict.txt': 'one\nTWO-upstream\nthree\n',
    'same.txt': 'unchanged\n',
    'added.txt': 'brand new\n',
  });
  const dir = await tree(path.join(tmp(), 'proj'), {
    'updated.txt': 'v1\n',
    'kept.txt': 'v1 + user edit\n',
    'merge.txt': 'a\nB-user\nc\nd\n',
    'conflict.txt': 'one\ntwo-user\nthree\n',
    'removed.txt': 'gone in v2\n',
    'removed-modified.txt': 'gone in v2 + user edit\n',
    'same.txt': 'unchanged\n',
  });

  const report = await mergeUpgrade({ dir, baseDir, newDir: freshDir });
  assert.deepEqual(report.updated, ['updated.txt']);
  assert.equal(await read(dir, 'updated.txt'), 'v2\n');
  assert.deepEqual(report.added, ['added.txt']);
  assert.deepEqual(report.merged, ['merge.txt']);
  assert.equal(await read(dir, 'merge.txt'), 'a\nB-user\nc\nD2\n', 'both sides\u2019 edits survive a clean merge');
  assert.equal(report.conflicts.length, 1);
  assert.match(report.conflicts[0], /^conflict\.txt/);
  assert.match(await read(dir, 'conflict.txt'), /<<<<<<<[\s\S]*two-user[\s\S]*TWO-upstream[\s\S]*>>>>>>>/);
  assert.deepEqual(report.removed, ['removed.txt']);
  assert.equal(has(dir, 'removed.txt'), false);
  assert.ok(
    report.kept.some((k) => k.startsWith('removed-modified.txt')),
    'modified file removed upstream is kept',
  );
  assert.equal(await read(dir, 'kept.txt'), 'v1 + user edit\n', 'upstream-unchanged files keep user edits');
});

test('mergeUpgrade dry-run reports without writing', async () => {
  const baseDir = await tree(path.join(tmp(), 'base'), { 'a.txt': 'v1\n' });
  const freshDir = await tree(path.join(tmp(), 'fresh'), { 'a.txt': 'v2\n', 'b.txt': 'new\n' });
  const dir = await tree(path.join(tmp(), 'proj'), { 'a.txt': 'v1\n' });
  const report = await mergeUpgrade({ dir, baseDir, newDir: freshDir, dryRun: true });
  assert.deepEqual(report.updated, ['a.txt']);
  assert.deepEqual(report.added, ['b.txt']);
  assert.equal(await read(dir, 'a.txt'), 'v1\n');
  assert.equal(has(dir, 'b.txt'), false);
});

test('scaffold records an upgrade base snapshot in .factory/upgrade', async () => {
  const dir = path.join(tmp(), 'proj');
  await scaffold({ template: 'static-html', name: 'snap-demo', dir, install: false, git: true, claude: false });
  const meta = JSON.parse(await fs.readFile(path.join(dir, '.factory', 'upgrade', 'base.json'), 'utf8'));
  assert.equal(meta.template, 'static-html');
  assert.ok(has(dir, '.factory/upgrade/base/index.html'), 'snapshot holds the rendered tree');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  assert.equal(git('status', '--porcelain').trim(), '', 'the snapshot is git-ignored, not an untracked change');
});

test('prepareBase recovers the base from the scaffold commit when no snapshot exists', async () => {
  const dir = path.join(tmp(), 'proj');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  await fs.mkdir(dir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await tree(dir, { 'factory.json': '{"name":"x","template":"static-html"}\n', 'code.txt': 'original\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: scaffold x');
  await fs.writeFile(path.join(dir, 'code.txt'), 'user rewrite\n');

  const { baseDir, source, cleanup } = await prepareBase({ dir });
  try {
    assert.match(source, /scaffold commit/);
    assert.equal(await read(baseDir, 'code.txt'), 'original\n', 'base is the scaffold-time content, not the user edit');
  } finally {
    await cleanup();
  }
});
