import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

for (const [template, schemaPath] of [
  ['node-service', 'src/db/schema.ts'],
  ['fullstack', 'server/db/schema.ts'],
]) {
  test(`${template} scaffolds the Postgres + Drizzle stack (P2 phase 1)`, async () => {
    const dir = path.join(tmp(), 'db-app');
    const { target } = await scaffold({ template, name: 'db-app', dir, owner: 'octo', install: false, git: true });
    const cfg = JSON.parse(readFileSync(path.join(target, 'factory.json'), 'utf8'));
    assert.equal(cfg.commands.migrate, 'npm run db:migrate', `${template} factory.json needs a migrate command`);
    for (const must of ['docker-compose.yml', 'drizzle.config.ts', schemaPath]) {
      assert.ok(existsSync(path.join(target, must)), `${template} missing ${must}`);
    }
    const migrations = readdirSync(path.join(target, 'drizzle')).filter((f) => f.endsWith('.sql'));
    assert.equal(migrations.length, 1, `${template} needs exactly one committed initial migration`);
    assert.match(readFileSync(path.join(target, 'drizzle', migrations[0]), 'utf8'), /CREATE TABLE "tasks"/);
    const ci = readFileSync(path.join(target, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /postgres:16/, `${template} CI needs an ephemeral Postgres service`);
    assert.match(ci, /npm run db:migrate/, `${template} CI must run migrations before tests`);
    const compose = readFileSync(path.join(target, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /postgres:16/, `${template} compose must pin Postgres 16`);
  });
}

test('python-service scaffolds the Postgres + SQLAlchemy/Alembic stack (P2 phase 2)', async () => {
  const dir = path.join(tmp(), 'db-app');
  const { target } = await scaffold({
    template: 'python-service',
    name: 'db-app',
    dir,
    owner: 'octo',
    install: false,
    git: true,
  });
  const cfg = JSON.parse(readFileSync(path.join(target, 'factory.json'), 'utf8'));
  assert.equal(cfg.commands.migrate, 'uv run db-migrate', 'python-service factory.json needs a migrate command');
  for (const must of ['docker-compose.yml', 'alembic.ini', 'alembic/env.py', 'src/app/db.py', 'src/app/migrate.py']) {
    assert.ok(existsSync(path.join(target, must)), `python-service missing ${must}`);
  }
  const migrations = readdirSync(path.join(target, 'alembic', 'versions')).filter((f) => f.endsWith('.py'));
  assert.equal(migrations.length, 1, 'python-service needs exactly one committed initial migration');
  assert.match(
    readFileSync(path.join(target, 'alembic', 'versions', migrations[0]), 'utf8'),
    /create_table\(\s*\n?\s*"tasks"/,
    'initial migration must create the tasks table',
  );
  const ci = readFileSync(path.join(target, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /postgres:16/, 'python-service CI needs an ephemeral Postgres service');
  assert.match(ci, /uv run db-migrate/, 'python-service CI must run migrations before tests');
  assert.ok(ci.indexOf('uv run db-migrate') < ci.indexOf('uv run pytest'), 'python-service CI must migrate before pytest');
  const compose = readFileSync(path.join(target, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /postgres:16/, 'python-service compose must pin Postgres 16');
  const pyproject = readFileSync(path.join(target, 'pyproject.toml'), 'utf8');
  for (const dep of ['sqlalchemy', 'alembic', 'psycopg']) {
    assert.match(pyproject, new RegExp(`"${dep}`), `pyproject must depend on ${dep}`);
  }
});

test('test helpers provide a default git identity without overriding the environment', () => {
  // helpers.js (imported above) sets these so git child processes work on
  // machines with no git config; values from the real environment would win.
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    assert.ok(process.env[key], `${key} is set`);
  }
});

test('scaffolds and commits on a machine with no git identity at all', async () => {
  // Hermetic child process: no GIT_* variables (helpers.js only patches this
  // process), no global/system git config, and an empty HOME.
  const script = path.join(tmp(), 'scaffold-child.mjs');
  const target = path.join(tmp(), 'fresh-app');
  writeFileSync(
    script,
    [
      `import { scaffold } from ${JSON.stringify(new URL('../src/scaffold.js', import.meta.url).href)};`,
      `import { execFileSync } from 'node:child_process';`,
      `const { steps } = await scaffold({ template: 'static-html', name: 'fresh-app', dir: process.argv[2], owner: 'octo', install: false, git: true, claude: false });`,
      `const author = execFileSync('git', ['log', '--format=%an <%ae>', '-1'], { cwd: process.argv[2], encoding: 'utf8' }).trim();`,
      `console.log(JSON.stringify({ gitStep: steps.git, author }));`,
      '',
    ].join('\n'),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: tmp('sf-empty-home-'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const out = execFileSync(process.execPath, [script, target], { encoding: 'utf8', env });
  const { gitStep, author } = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(gitStep, 'ok');
  assert.equal(author, 'software-factory <software-factory@localhost>');
});

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
