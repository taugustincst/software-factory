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
    assert.equal(migrations.length, 2, `${template} needs the initial + auth migrations`);
    assert.match(readFileSync(path.join(target, 'drizzle', migrations[0]), 'utf8'), /CREATE TABLE "tasks"/);
    // P2 phase 3: the second migration adds the auth tables, and the auth
    // module + routes ship in the scaffold.
    assert.match(readFileSync(path.join(target, 'drizzle', migrations[1]), 'utf8'), /CREATE TABLE "users"/);
    assert.match(readFileSync(path.join(target, 'drizzle', migrations[1]), 'utf8'), /CREATE TABLE "sessions"/);
    const authBase = template === 'fullstack' ? 'server' : 'src';
    for (const must of [`${authBase}/auth.ts`, `${authBase}/routes/auth.ts`]) {
      assert.ok(existsSync(path.join(target, must)), `${template} missing ${must}`);
    }
    assert.match(readFileSync(path.join(target, authBase, 'db', 'schema.ts'), 'utf8'), /passwordHash/);
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
  const migrations = readdirSync(path.join(target, 'alembic', 'versions'))
    .filter((f) => f.endsWith('.py'))
    .sort();
  assert.equal(migrations.length, 2, 'python-service needs the initial + auth migrations');
  assert.match(
    readFileSync(path.join(target, 'alembic', 'versions', migrations[0]), 'utf8'),
    /create_table\(\s*\n?\s*"tasks"/,
    'initial migration must create the tasks table',
  );
  // P2 phase 3: the second migration adds the auth tables, and the auth module ships.
  assert.match(
    readFileSync(path.join(target, 'alembic', 'versions', migrations[1]), 'utf8'),
    /create_table\(\s*\n?\s*"users"/,
    'auth migration must create the users table',
  );
  assert.ok(existsSync(path.join(target, 'src/app/auth.py')), 'python-service missing src/app/auth.py');
  assert.match(readFileSync(path.join(target, 'pyproject.toml'), 'utf8'), /"argon2-cffi/);
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

for (const [template, configFile, specs] of [
  ['fullstack', 'playwright.config.ts', ['e2e/smoke.spec.ts', 'e2e/auth.spec.ts']],
  ['static-html', 'playwright.config.js', ['e2e/smoke.spec.js']],
]) {
  test(`${template} scaffolds Playwright e2e (P2 phase 4)`, async () => {
    const dir = path.join(tmp(), 'e2e-app');
    const { target } = await scaffold({ template, name: 'e2e-app', dir, owner: 'octo', install: false, git: true });
    const cfg = JSON.parse(readFileSync(path.join(target, 'factory.json'), 'utf8'));
    assert.equal(cfg.commands.e2e, 'npm run e2e', `${template} factory.json needs an e2e command`);
    assert.ok(existsSync(path.join(target, configFile)), `${template} missing ${configFile}`);
    for (const spec of specs) {
      assert.ok(existsSync(path.join(target, spec)), `${template} missing ${spec}`);
    }
    const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
    assert.ok(pkg.devDependencies['@playwright/test'], `${template} must depend on @playwright/test`);
    assert.equal(pkg.scripts.e2e, template === 'fullstack' ? 'npm run build && playwright test' : 'playwright test');
    const ci = readFileSync(path.join(target, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /playwright install --with-deps chromium/, `${template} CI must install the Playwright browser`);
    assert.match(ci, /npm run e2e/, `${template} CI must run the e2e suite`);
    assert.ok(
      ci.indexOf('playwright install') < ci.indexOf('npm run e2e'),
      `${template} CI must install the browser before running e2e`,
    );
    assert.match(ci, /upload-artifact/, `${template} CI must upload Playwright artifacts on failure`);
    assert.match(readFileSync(path.join(target, '.gitignore'), 'utf8'), /playwright-report\//);
    // Generated Playwright output is not source: formatters/linters that run
    // after an e2e run (the pipeline re-runs the gates) must ignore it.
    assert.match(readFileSync(path.join(target, '.prettierignore'), 'utf8'), /^playwright-report$/m);
    assert.match(readFileSync(path.join(target, '.prettierignore'), 'utf8'), /^test-results$/m);
    if (template === 'static-html') {
      // Vitest's default globs would collect the Playwright specs — including
      // the copies in the .factory upgrade base snapshot — and fail on them.
      const vitest = readFileSync(path.join(target, 'vitest.config.js'), 'utf8');
      assert.match(vitest, /'e2e\/\*\*'/, 'static-html vitest config must exclude e2e/');
      assert.match(vitest, /'\.factory\/\*\*'/, 'static-html vitest config must exclude .factory/');
    }
  });
}

test('service templates ship no Playwright (P2 phase 4 is UI-only)', async () => {
  for (const template of ['node-service', 'python-service']) {
    const dir = path.join(tmp(), 'no-e2e-app');
    const { target } = await scaffold({ template, name: 'no-e2e-app', dir, owner: 'octo', install: false, git: true });
    const cfg = JSON.parse(readFileSync(path.join(target, 'factory.json'), 'utf8'));
    assert.equal(cfg.commands.e2e, undefined, `${template} must not define an e2e command`);
    assert.ok(!existsSync(path.join(target, 'e2e')), `${template} must not scaffold an e2e/ directory`);
    const manifest = template === 'python-service' ? 'pyproject.toml' : 'package.json';
    assert.doesNotMatch(readFileSync(path.join(target, manifest), 'utf8'), /playwright/i);
  }
});

for (const [template, base, entry, testFile] of [
  ['node-service', 'src', 'src/server.ts', 'test/tracing.test.ts'],
  ['fullstack', 'server', 'server/index.ts', 'server/tracing.test.ts'],
]) {
  test(`${template} scaffolds OpenTelemetry tracing (P2 phase 5)`, async () => {
    const dir = path.join(tmp(), 'otel-app');
    const { target } = await scaffold({ template, name: 'otel-app', dir, owner: 'octo', install: false, git: true });
    assert.ok(existsSync(path.join(target, base, 'tracing.ts')), `${template} missing ${base}/tracing.ts`);
    assert.ok(existsSync(path.join(target, testFile)), `${template} missing ${testFile}`);
    const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
    for (const dep of [
      '@opentelemetry/api',
      '@opentelemetry/sdk-node',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/instrumentation-http',
      '@fastify/otel',
      '@opentelemetry/sdk-trace-base',
    ]) {
      assert.ok(pkg.dependencies[dep], `${template} must depend on ${dep}`);
    }
    // Off by default: the entry starts tracing (a no-op without the env),
    // the endpoint only appears commented out in .env.example, and the
    // logger correlates trace ids via the mixin in the app factory.
    assert.match(readFileSync(path.join(target, entry), 'utf8'), /initTracing\(\)/);
    assert.match(readFileSync(path.join(target, '.env.example'), 'utf8'), /# OTEL_EXPORTER_OTLP_ENDPOINT=/);
    assert.match(readFileSync(path.join(target, base, 'app.ts'), 'utf8'), /traceLogFields/);
    assert.match(readFileSync(path.join(target, 'README.md'), 'utf8'), /## Observability/);
    assert.match(readFileSync(path.join(target, 'README.md'), 'utf8'), /off by default/i);
  });
}

test('python-service scaffolds OpenTelemetry tracing (P2 phase 5)', async () => {
  const dir = path.join(tmp(), 'otel-app');
  const { target } = await scaffold({
    template: 'python-service',
    name: 'otel-app',
    dir,
    owner: 'octo',
    install: false,
    git: true,
  });
  assert.ok(existsSync(path.join(target, 'src/app/telemetry.py')), 'python-service missing src/app/telemetry.py');
  assert.ok(existsSync(path.join(target, 'tests/test_telemetry.py')), 'python-service missing tests/test_telemetry.py');
  const pyproject = readFileSync(path.join(target, 'pyproject.toml'), 'utf8');
  for (const dep of ['opentelemetry-sdk', 'opentelemetry-exporter-otlp-proto-http', 'opentelemetry-instrumentation-fastapi']) {
    assert.match(pyproject, new RegExp(`"${dep}`), `pyproject must depend on ${dep}`);
  }
  assert.match(readFileSync(path.join(target, 'src/app/config.py'), 'utf8'), /otel_exporter_otlp_endpoint/);
  assert.match(readFileSync(path.join(target, 'src/app/main.py'), 'utf8'), /configure_telemetry/);
  assert.match(readFileSync(path.join(target, '.env.example'), 'utf8'), /# OTEL_EXPORTER_OTLP_ENDPOINT=/);
  assert.match(readFileSync(path.join(target, 'README.md'), 'utf8'), /## Observability/);
});

test('static-html ships no OpenTelemetry (P2 phase 5 is service-only)', async () => {
  const dir = path.join(tmp(), 'no-otel-app');
  const { target } = await scaffold({
    template: 'static-html',
    name: 'no-otel-app',
    dir,
    owner: 'octo',
    install: false,
    git: true,
  });
  assert.doesNotMatch(readFileSync(path.join(target, 'package.json'), 'utf8'), /opentelemetry/i);
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
