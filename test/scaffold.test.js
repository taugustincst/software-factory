import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scaffold, listTemplates, render, NAME_RE } from '../src/scaffold.js';
import { tmp } from './helpers.js';

function* files(dir) {
  for (const n of readdirSync(dir)) {
    if (n === '.git' || n === 'node_modules') continue;
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

test('lists the four templates with commands', async () => {
  const ids = (await listTemplates()).map((t) => t.id);
  assert.deepEqual(ids, ['fullstack', 'node-service', 'python-service', 'static-html']);
  for (const t of await listTemplates()) {
    assert.ok(t.commands.lint && t.commands.test, `${t.id} needs lint and test commands`);
    assert.ok(t.title && t.stack, `${t.id} needs title and stack`);
  }
});

test('render replaces factory tokens and leaves GitHub expressions alone', () => {
  const out = render('name: {{factory.name}} ref: ${{ github.ref }}', { name: 'x' }, 'f');
  assert.equal(out, 'name: x ref: ${{ github.ref }}');
  assert.throws(() => render('{{factory.missing}}', {}, 'f.yml'), /no value/);
});

test('project names are validated', () => {
  for (const ok of ['ab', 'my-app', 'clinic-portal-2']) assert.ok(NAME_RE.test(ok), ok);
  for (const bad of ['A', 'My App', '-x', 'x-', '../etc', 'a/b', 'a']) assert.ok(!NAME_RE.test(bad), bad);
});

for (const template of ['static-html', 'fullstack', 'node-service', 'python-service']) {
  test(`scaffolds ${template} with every token rendered`, async () => {
    const dir = path.join(tmp(), 'demo-app');
    const { target } = await scaffold({ template, name: 'demo-app', dir, owner: 'octo', install: false, git: true });
    for (const f of files(target)) {
      const text = readFileSync(f, 'utf8');
      assert.ok(!text.includes('{{factory.'), `unrendered token in ${path.relative(target, f)}`);
    }
    const cfg = JSON.parse(readFileSync(path.join(target, 'factory.json'), 'utf8'));
    assert.equal(cfg.template, template);
    assert.ok(cfg.commands.test);
    for (const must of [
      '.gitignore',
      '.github/workflows/ci.yml',
      '.github/workflows/factory.yml',
      '.github/workflows/codeql.yml',
      '.github/dependabot.yml',
      'SECURITY.md',
      'CLAUDE.md',
      '.claude/settings.json',
      '.claude/agents/planner.md',
      'README.md',
    ]) {
      assert.ok(existsSync(path.join(target, must)), `${template} missing ${must}`);
    }
    assert.match(readFileSync(path.join(target, '.github/CODEOWNERS'), 'utf8'), /@octo/);
    const log = execFileSync('git', ['log', '--oneline'], { cwd: target, encoding: 'utf8' });
    assert.match(log, /chore: scaffold demo-app/);
  });
}

test('refuses a non-empty target directory', async () => {
  const dir = tmp();
  await assert.rejects(
    scaffold({ template: 'static-html', name: 'demo-app', dir: path.dirname(dir), install: false, git: false }),
    /not empty/,
  );
});

test('rejects unknown templates', async () => {
  await assert.rejects(
    scaffold({ template: 'cobol', name: 'demo-app', dir: tmp(), install: false, git: false }),
    /unknown template/,
  );
});
