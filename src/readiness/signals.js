/**
 * Autonomy Maturity Model (AMM) signal catalog.
 *
 * Every signal is binary (present / absent, no partial credit), automatable
 * and fast: a signal is a file-existence or file-content probe over the repo
 * tree — never a build, a test run or a network call. See
 * docs/autonomy-maturity.md for the model, the scoring math and the full
 * table (generated from this catalog).
 *
 * Anchoring rule: signals probe the repo's own installed/working paths
 * (`.claude/agents`, `.github/workflows`, root configs). Content that a repo
 * merely *ships* for other repos (this repo's `templates/` and `claude-kit/`
 * source trees) does not count toward its own score — the factory repo is
 * scored as a codebase, not by the artifacts it generates.
 */

import { PILLARS, POINTS_BY_LEVEL, sig } from './model.js';
import { isTestFile, anyTsconfigStrict, tsconfigStrict } from './context.js';
import { EXTENDED_SIGNALS } from './signals-extended.js';

export { PILLARS, POINTS_BY_LEVEL };
export { buildContext } from './context.js';

const CORE_SIGNALS = [
  // ── Pillar 1: Style & Validation ─────────────────────────────────────────
  sig(
    'lint-config',
    1,
    1,
    'Linter configuration present',
    'Add an eslint.config.js (or Ruff/equivalent config) at the repo root.',
    (ctx) =>
      ctx.hasAny([
        'eslint.config.js',
        'eslint.config.mjs',
        '.eslintrc',
        '.eslintrc.json',
        '.eslintrc.js',
        'setup.cfg',
        '.flake8',
      ]) || /\[tool\.ruff/.test(ctx.pyproject),
  ),
  sig(
    'formatter-config',
    1,
    1,
    'Formatter configuration present',
    'Add a formatter config (.prettierrc.json, or Ruff format for Python).',
    async (ctx) =>
      ctx.hasAny(['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js']) ||
      Boolean(ctx.pkg?.prettier) ||
      /\[tool\.ruff/.test(ctx.pyproject) ||
      /ruff format/.test(Object.values(ctx.commands).join(' ')),
  ),
  sig(
    'lint-command',
    1,
    1,
    'Lint command declared',
    'Declare a lint command in factory.json (or package.json scripts / pyproject tooling).',
    (ctx) => Boolean(ctx.commands.lint || ctx.scripts.lint || /\[tool\.ruff/.test(ctx.pyproject)),
  ),
  sig(
    'typecheck-strict',
    1,
    3,
    'Strict type checking (tsconfig strict / mypy strict / typecheck gate)',
    'Enable strict mode (tsconfig "strict": true or mypy strict) and wire a typecheck command.',
    async (ctx) =>
      (await anyTsconfigStrict(ctx)) ||
      /strict\s*=\s*true/.test(ctx.pyproject) ||
      Boolean(ctx.commands.typecheck && tsconfigStrict(ctx)),
  ),
  sig(
    'precommit-hooks',
    1,
    3,
    'Pre-commit hooks run checks before commit',
    'Add .githooks/pre-commit (and set core.hooksPath) or a pre-commit framework config.',
    (ctx) => ctx.hasAny(['.githooks/pre-commit', '.pre-commit-config.yaml', '.pre-commit-config.yml', '.husky/pre-commit']),
  ),

  // ── Pillar 2: Build System ───────────────────────────────────────────────
  sig(
    'manifest',
    2,
    1,
    'Dependency manifest present (package.json / pyproject.toml)',
    'Add a package.json or pyproject.toml declaring the project and its dependencies.',
    (ctx) => ctx.hasAny(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile']),
  ),
  sig(
    'install-command',
    2,
    1,
    'Install command declared',
    'Declare an install command in factory.json (e.g. npm ci, uv sync).',
    (ctx) => Boolean(ctx.commands.install || ctx.scripts.prepare || ctx.has('Makefile')),
  ),
  sig(
    'build-or-dev-command',
    2,
    2,
    'Build or dev command declared',
    'Declare a build or dev command in factory.json / package.json scripts.',
    (ctx) => Boolean(ctx.commands.build || ctx.commands.dev || ctx.scripts.build || ctx.scripts.dev),
  ),
  sig(
    'dockerfile',
    2,
    2,
    'Dockerfile present for a reproducible runtime image',
    'Add a Dockerfile that builds the project runtime image.',
    (ctx) => ctx.has('Dockerfile'),
  ),
  sig(
    'reproducible-install',
    2,
    3,
    'CI installs reproducibly from the lockfile (npm ci / uv sync --locked)',
    'Make CI install with npm ci (or uv sync --locked) so builds use the locked dependency set.',
    (ctx) =>
      /npm ci\b/.test(ctx.workflowText) ||
      /uv sync --locked/.test(ctx.workflowText) ||
      /pnpm install --frozen-lockfile/.test(ctx.workflowText),
  ),

  // ── Pillar 3: Testing ────────────────────────────────────────────────────
  sig('test-files', 3, 1, 'Test files exist', 'Add tests next to the code (e.g. *.test.*, test_*.py, e2e specs).', (ctx) =>
    ctx.files.some(isTestFile),
  ),
  sig('test-command', 3, 1, 'Test command declared', 'Declare a test command in factory.json / package.json scripts.', (ctx) =>
    Boolean(ctx.commands.test || ctx.scripts.test || /\[tool\.pytest/.test(ctx.pyproject)),
  ),
  sig(
    'ci-runs-tests',
    3,
    2,
    'CI runs the test suite',
    'Run the test command in the CI workflow on push and pull requests.',
    (ctx) => /(npm test|npm run test|pytest|node --test|vitest|go test|cargo test)/.test(ctx.workflowText),
  ),
  sig(
    'multiple-suites',
    3,
    1,
    'More than one test file (suite breadth)',
    'Grow the suite beyond a single test file so regressions are caught in more than one area.',
    (ctx) => ctx.files.filter(isTestFile).length >= 2,
  ),
  sig(
    'coverage-command',
    3,
    2,
    'Coverage command declared',
    'Declare a coverage command in factory.json (e.g. vitest run --coverage, pytest --cov).',
    (ctx) => Boolean(ctx.commands.coverage) || /coverage|--cov/.test(ctx.scripts.test ?? '') || /--cov/.test(ctx.pyproject),
  ),
  sig(
    'coverage-threshold',
    3,
    3,
    'Coverage threshold enforced',
    'Set coverage thresholds (Vitest coverage.thresholds or pytest --cov-fail-under) so coverage cannot silently drop.',
    async (ctx) => {
      if (/--cov-fail-under=\d+/.test(ctx.pyproject) || /--cov-fail-under=\d+/.test(Object.values(ctx.commands).join(' ')))
        return true;
      // Only test-runner config files count — a doc mentioning thresholds is not a gate.
      for (const f of ctx.files) {
        if (!/(^|\/)(vitest|vite|jest)\.config\.[a-z]+$/.test(f) || f.startsWith('templates/')) continue;
        if (/thresholds\s*:/.test(await ctx.text(f))) return true;
      }
      return false;
    },
  ),
  sig(
    'e2e-tests',
    3,
    3,
    'End-to-end tests exist (Playwright/Cypress config or e2e specs)',
    'Add an e2e suite (Playwright or Cypress) covering the main user flow.',
    (ctx) =>
      ctx.hasAny(['playwright.config.js', 'playwright.config.ts', 'cypress.config.js', 'cypress.config.ts']) ||
      ctx.files.some((f) => f.startsWith('e2e/') && /\.(spec|test)\./.test(f)),
  ),

  // ── Pillar 4: Documentation & Instructions ───────────────────────────────
  sig('readme', 4, 1, 'README present', 'Add a README.md describing the project.', (ctx) => ctx.has('README.md')),
  sig(
    'agents-md',
    4,
    2,
    'AGENTS.md gives agents setup, commands and architecture',
    'Add an AGENTS.md with setup, build/test/lint commands, architecture pointers and troubleshooting.',
    async (ctx) => {
      const body = await ctx.text('AGENTS.md');
      return (
        body.length >= 400 && /test/i.test(body) && /(setup|install)/i.test(body) && /(architecture|structure|layout)/i.test(body)
      );
    },
  ),
  sig(
    'contributing',
    4,
    1,
    'Contributing guide present',
    'Add CONTRIBUTING.md with the workflow, commands and definition of done.',
    (ctx) => ctx.has('CONTRIBUTING.md'),
  ),
  sig(
    'architecture-doc',
    4,
    2,
    'Architecture documentation present',
    'Add docs/architecture.md describing the structure and the key design decisions.',
    (ctx) => ctx.hasAny(['docs/architecture.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md']),
  ),
  sig(
    'spec-docs',
    4,
    3,
    'Spec / ADR documents exist (spec-driven development)',
    'Keep specs or ADRs in the repo (e.g. docs/specs/<date>-<slug>/SPEC.md or docs/adr/).',
    (ctx) => ctx.files.some((f) => /^docs\/(specs|adr|decisions)\//.test(f) && f.endsWith('.md') && !f.endsWith('README.md')),
  ),
  sig(
    'api-docs',
    4,
    3,
    'API documentation present (OpenAPI spec or API docs)',
    'Publish an OpenAPI spec (openapi.yaml/json) or docs/api documentation for the service surface.',
    (ctx) =>
      ctx.hasAny(['openapi.yaml', 'openapi.yml', 'openapi.json', 'docs/openapi.yaml', 'docs/openapi.json']) ||
      ctx.hasPrefix('docs/api/'),
  ),
];

export const SIGNALS = [...CORE_SIGNALS, ...EXTENDED_SIGNALS];
