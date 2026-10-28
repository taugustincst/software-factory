/**
 * Autonomy Maturity Model signal catalog, pillars 5-8 (see signals.js for
 * pillars 1-4 and docs/autonomy-maturity.md for the model). Every signal is
 * binary, automatable and a pure file/content probe over the context built
 * by context.js.
 */

import { sig } from './model.js';

export const EXTENDED_SIGNALS = [
  // ── Pillar 5: Dev Environment & Remote Execution ─────────────────────────
  sig(
    'env-example',
    5,
    1,
    '.env.example documents required environment variables',
    'Add a .env.example listing every environment variable the project needs (no real values).',
    (ctx) => ctx.hasAny(['.env.example', '.env.sample', '.env.template']),
  ),
  sig(
    'ci-workflow',
    5,
    1,
    'CI workflow present (hosted remote execution)',
    'Add a CI workflow under .github/workflows/ so checks run remotely on every change.',
    (ctx) => ctx.workflows.length > 0,
  ),
  sig(
    'setup-instructions',
    5,
    1,
    'Setup instructions documented (README or AGENTS.md)',
    'Document the exact setup steps in README.md or AGENTS.md.',
    async (ctx) => {
      const body = `${await ctx.text('README.md')}\n${await ctx.text('AGENTS.md')}`;
      return /(npm ci|npm install|uv sync|pip install|setup|install)/i.test(body);
    },
  ),
  sig(
    'pipeline-workflow',
    5,
    2,
    'Agent pipeline workflow present (factory.yml)',
    'Add .github/workflows/factory.yml so the agent pipeline can run remotely from an issue label or dispatch.',
    (ctx) => ctx.has('.github/workflows/factory.yml'),
  ),
  sig(
    'devcontainer',
    5,
    4,
    'Dev container / Codespaces configuration present',
    'Add .devcontainer/devcontainer.json so the environment is reproducible for humans and agents.',
    (ctx) => ctx.hasAny(['.devcontainer/devcontainer.json', '.devcontainer.json']),
  ),
  sig(
    'multi-agent-orchestration',
    5,
    5,
    'Multi-agent orchestration installed (>=5 agents plus a dispatcher/pipeline)',
    'Install an agent kit with >=5 subagents and a dispatcher, or define a multi-stage pipeline workflow.',
    async (ctx) => {
      const agents = ctx.countPrefix('.claude/agents/', '.md');
      const dispatcher = ctx.hasAny(['.claude/DISPATCHER.md', '.claude/FACTORY.md']);
      return (agents >= 5 && dispatcher) || ctx.has('.github/workflows/factory.yml');
    },
  ),

  // ── Pillar 6: Code Quality ───────────────────────────────────────────────
  sig(
    'codeowners',
    6,
    1,
    'CODEOWNERS assigns review ownership',
    'Add .github/CODEOWNERS so every path has a review owner.',
    (ctx) => ctx.hasAny(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']),
  ),
  sig(
    'pr-template',
    6,
    1,
    'Pull request template present',
    'Add .github/PULL_REQUEST_TEMPLATE.md so PRs describe change, risk and testing.',
    (ctx) => ctx.hasAny(['.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md']),
  ),
  sig(
    'conventional-commits',
    6,
    2,
    'Conventional Commits enforced or documented',
    'Enforce Conventional Commits PR titles (pr-title workflow) or document them in CONTRIBUTING.md.',
    async (ctx) =>
      ctx.has('.github/workflows/pr-title.yml') ||
      /conventional commits/i.test(await ctx.text('CONTRIBUTING.md')) ||
      /release-please/.test(ctx.workflowText),
  ),
  sig(
    'strict-lint-rules',
    6,
    3,
    'Strict lint rule set (recommended + extra rules, or a broad Ruff selection)',
    'Turn on the recommended rule set plus stricter rules (eslint recommended/custom rules, tseslint strict, or a broad Ruff select list).',
    async (ctx) => {
      if (/select\s*=\s*\[[^\]]{20,}\]/.test(ctx.pyproject)) return true;
      for (const f of ['eslint.config.js', 'eslint.config.mjs']) {
        const body = await ctx.text(f);
        if (/recommended/.test(body) && /(rules\s*:|strict|eqeqeq)/.test(body)) return true;
      }
      return false;
    },
  ),
  sig(
    'dead-code-tool',
    6,
    4,
    'Dead-code / dependency-cruft tool configured (knip, depcheck, vulture, …)',
    'Add a dead-code check (knip, depcheck, vulture) to the lint pipeline.',
    (ctx) =>
      /knip|depcheck|vulture|ts-prune/.test(JSON.stringify(ctx.pkg ?? {})) ||
      /knip|depcheck|vulture|ts-prune/.test(ctx.pyproject) ||
      /knip|depcheck|vulture|ts-prune/.test(ctx.workflowText),
  ),
  sig(
    'model-routing',
    6,
    5,
    'Model routing configured (different models per stage, e.g. a review model)',
    'Configure model routing in repo config (factory.json models, workflow env or agent settings) — e.g. a separate review model.',
    async (ctx) => {
      const haystacks = [JSON.stringify(ctx.factoryJson), ctx.workflowText, await ctx.text('.claude/settings.json')];
      return haystacks.some((h) => /review[-_ ]?model|modelRouting|models\s*:/.test(h));
    },
  ),

  // ── Pillar 7: Debugging & Observability ──────────────────────────────────
  sig(
    'health-endpoint',
    7,
    1,
    'Health endpoint implemented',
    'Expose a /healthz (or /health) endpoint so deploys and monitors can probe the service.',
    async (ctx) => {
      for (const prefix of ['src/', 'server/', 'app/', 'scripts/']) {
        if (await ctx.anyText(/\/healthz|\/health\b/, prefix)) return true;
      }
      return false;
    },
  ),
  sig(
    'otel-dependency',
    7,
    1,
    'OpenTelemetry dependency declared',
    'Add the OpenTelemetry SDK/exporter dependencies for the stack.',
    (ctx) => /opentelemetry/i.test(JSON.stringify(ctx.pkg ?? {})) || /opentelemetry/i.test(ctx.pyproject),
  ),
  sig(
    'structured-logging',
    7,
    2,
    'Structured logging in application code (pino / logging)',
    'Use a structured logger (pino for Node services, the logging module for Python) instead of ad-hoc console output.',
    async (ctx) => {
      // Fastify services configure the built-in pino logger inline (`logger: { … }`)
      // rather than importing pino, so that configuration counts as well.
      const re = /from ['"]pino['"]|import logging|getLogger\(|winston|logger\s*:\s*\{/;
      for (const prefix of ['src/', 'server/']) {
        if (await ctx.anyText(re, prefix)) return true;
      }
      return false;
    },
  ),
  sig(
    'debugging-docs',
    7,
    2,
    'Troubleshooting / debugging guidance documented',
    'Document troubleshooting steps in AGENTS.md, README.md or docs/.',
    async (ctx) => {
      const body = `${await ctx.text('AGENTS.md')}\n${await ctx.text('README.md')}`;
      return /troubleshoot|debugging/i.test(body);
    },
  ),
  sig(
    'otel-code',
    7,
    3,
    'Tracing code present (tracing/telemetry module wired into the app)',
    'Add a tracing/telemetry module (OpenTelemetry SDK setup) and import it at startup.',
    (ctx) => ctx.files.some((f) => /(^|\/)(tracing|telemetry)\.(ts|js|py)$/.test(f) && !f.startsWith('templates/')),
  ),
  sig(
    'error-tracking',
    7,
    3,
    'Error tracking integrated (Sentry or equivalent)',
    'Integrate an error tracker (e.g. Sentry) so production failures are reported with context.',
    async (ctx) =>
      /@sentry\/|sentry_sdk|bugsnag|rollbar/i.test(JSON.stringify(ctx.pkg ?? {})) ||
      /sentry|bugsnag|rollbar/i.test(ctx.pyproject) ||
      (await ctx.anyText(/@sentry\/|sentry_sdk|bugsnag|rollbar/i, 'src/')) ||
      (await ctx.anyText(/@sentry\/|sentry_sdk|bugsnag|rollbar/i, 'server/')),
  ),
  sig(
    'ci-artifacts',
    7,
    2,
    'CI uploads diagnostic artifacts on failure',
    'Upload test/playwright artifacts in CI on failure (actions/upload-artifact with if: failure()).',
    (ctx) => /upload-artifact/.test(ctx.workflowText),
  ),

  // ── Pillar 8: Security & Governance ──────────────────────────────────────
  sig(
    'security-policy',
    8,
    1,
    'SECURITY.md policy present',
    'Add SECURITY.md with a private vulnerability-reporting path.',
    (ctx) => ctx.has('SECURITY.md'),
  ),
  sig(
    'dependabot',
    8,
    1,
    'Dependabot (or Renovate) keeps dependencies updated',
    'Add .github/dependabot.yml (or a Renovate config) for every ecosystem in the repo.',
    (ctx) => ctx.hasAny(['.github/dependabot.yml', '.github/dependabot.yaml', 'renovate.json', '.renovaterc.json']),
  ),
  sig(
    'codeql',
    8,
    2,
    'CodeQL static analysis workflow present',
    'Add a CodeQL workflow scanning on push, pull requests and a schedule.',
    (ctx) =>
      ctx.files.some((f) => f.startsWith('.github/workflows/') && /codeql/.test(f)) || /codeql-action/.test(ctx.workflowText),
  ),
  sig(
    'secret-scan',
    8,
    2,
    'Secret scanning in CI (gitleaks or equivalent)',
    'Add a gitleaks (or equivalent) secret-scan workflow on push and pull requests.',
    (ctx) => /gitleaks|trufflehog|secretlint/i.test(ctx.workflowText),
  ),
  sig(
    'threat-model',
    8,
    3,
    'Threat model documented (STRIDE)',
    'Add docs/threat-model.md with a STRIDE table for the system and its trust boundaries.',
    async (ctx) => {
      const body = await ctx.text('docs/threat-model.md');
      return /STRIDE/i.test(body) && /spoofing/i.test(body) && /tampering/i.test(body);
    },
  ),
  sig(
    'audit-in-ci',
    8,
    2,
    'Dependency audit runs in CI (npm audit / pip-audit / osv)',
    'Run a dependency audit in CI (npm audit, pip-audit or osv-scanner) and fail on high severity.',
    (ctx) => /npm audit|pip-audit|osv-scanner/.test(ctx.workflowText),
  ),
  sig(
    'guard-hooks',
    8,
    3,
    'Agent guard hooks installed (.claude/hooks)',
    'Install guard hooks under .claude/hooks/ that block destructive commands and secret-like content for agent sessions.',
    (ctx) => ctx.countPrefix('.claude/hooks/', '') >= 1,
  ),
  sig(
    'sbom',
    8,
    3,
    'SBOM generated in CI / release',
    'Generate an SBOM (e.g. actions/attest-build-provenance, syft or cyclonedx) in CI or the release workflow.',
    (ctx) => /sbom|syft|cyclonedx|attest-build-provenance/i.test(ctx.workflowText),
  ),
  sig(
    'release-provenance',
    8,
    5,
    'Signed release provenance / attestations configured',
    'Configure build provenance attestations (actions/attest-build-provenance or SLSA) for releases.',
    (ctx) => /attest-build-provenance|slsa-github-generator|cosign/i.test(ctx.workflowText),
  ),
];
