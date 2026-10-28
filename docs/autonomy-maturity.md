# Autonomy Maturity Model (AMM) — as implemented here

The factory implements the Autonomy Maturity Model from Factory.ai's white paper _The Software Factory Autonomy Maturity Model_ as a runnable scorer: `factory readiness` measures any repo against the model, and `factory outcomes` aggregates the lagging outcome metrics from pipeline runs. This document is the normative description of the implementation; the catalog in `src/readiness/signals.js` and `src/readiness/signals-extended.js` is the source of truth for the signal table below.

## The model

A repo's readiness for autonomous agent work is assessed across **eight pillars**:

1. Style & Validation
2. Build System
3. Testing
4. Documentation & Instructions
5. Dev Environment & Remote Execution
6. Code Quality
7. Debugging & Observability
8. Security & Governance

Each pillar is measured by **binary signals** — a signal is either present or absent, with no partial credit. Every signal is automatable and fast (the full scan of a repo takes well under five minutes; in practice, under a second): a signal is a file-existence or file-content probe, never a build, a test run or a network call.

### Scoring

A passed signal earns points by its maturity level: **L1 = 1, L2 = 2, L3 = 4, L4 = 8, L5 = 16**. The repo score is the sum over all passed signals. Levels are cumulative thresholds on that score:

| Level | Score | Meaning                                           |
| ----- | ----- | ------------------------------------------------- |
| 0     | 0–4   | Not yet on the ladder                             |
| 1     | ≥ 5   | Foundations present                               |
| 2     | ≥ 19  | Repeatable basics                                 |
| 3     | ≥ 36  | **Agent-ready**: the minimum production-grade bar |
| 4     | ≥ 60  | Advanced autonomy support                         |
| 5     | ≥ 100 | Fully autonomous operation                        |

The headline organisational metric is **Organizational Readiness = the percentage of active repos at Level 3 or above**. `factory readiness dir1 dir2 …` prints it for the scored set.

### Outcome metrics (lagging indicators)

Readiness signals are leading indicators; the model pairs them with outcome metrics, aggregated by `factory outcomes` from `.factory/runs/<id>/run.json` records (see `src/readiness/outcomes.js`):

- **Cycle time** — mean and median of `finishedAt − startedAt` over completed runs.
- **Autonomy ratio** — passed runs whose every stage passed on its first attempt with zero review loops, divided by completed runs.
- **Cost per change** — total agent spend divided by passed runs.
- **Incident MTTR** — _not recorded in `run.json`_; reported as `null` with a note, never estimated. The same applies to change shelf-life.

### The improvement loop: DMASI

1. **Define** — the signal catalog and thresholds (this document).
2. **Measure** — `factory readiness` per repo; `factory outcomes` for lagging metrics; track Organizational Readiness over time.
3. **Analyze** — read the remediation list (failed signals sorted by level, then points): the cheapest wins first.
4. **Scale** — bake the fixes into the templates so new repos start at Level 3+. The `_shared` scaffold files (AGENTS.md, threat model, architecture starter, pre-commit hook, guard hooks, factory workflow) are exactly this step.
5. **Integrate** — gate on it: `factory readiness --fail-below 3` in CI keeps repos from silently dropping below the agent-ready bar.

## Signal catalog

51 signals. Probes anchor to the repo's own installed/working paths (`.claude/agents`, `.github/workflows`, root configs). Content a repo merely ships for other repos — this repo's `templates/` and `claude-kit/` trees — does not count toward its own score, and the scorer never matches its own probe patterns in `src/readiness/`. Two definition notes:

- `typecheck-strict` requires an actual strict configuration (tsconfig `"strict": true`, mypy `strict = true`, or a declared typecheck command backed by a tsconfig). This repository is plain JavaScript with no tsconfig, so it honestly fails this signal; the fix is a deliberate tooling decision, not a scorer tweak.
- `model-routing` requires routing to be _configured in the repo_ (factory.json, workflow env or agent settings). The factory CLI supports `--review-model`, but no repo configures routing by default yet, so every current repo fails it — it is a genuine Level 5 gap, listed below.

### Pillar 1: Style & Validation

| Signal             | Level | Points | What counts as present                                                |
| ------------------ | ----- | ------ | --------------------------------------------------------------------- |
| `lint-config`      | L1    | 1      | Linter configuration present                                          |
| `formatter-config` | L1    | 1      | Formatter configuration present                                       |
| `lint-command`     | L1    | 1      | Lint command declared                                                 |
| `typecheck-strict` | L3    | 4      | Strict type checking (tsconfig strict / mypy strict / typecheck gate) |
| `precommit-hooks`  | L3    | 4      | Pre-commit hooks run checks before commit                             |

### Pillar 2: Build System

| Signal                 | Level | Points | What counts as present                                                 |
| ---------------------- | ----- | ------ | ---------------------------------------------------------------------- |
| `manifest`             | L1    | 1      | Dependency manifest present (package.json / pyproject.toml)            |
| `install-command`      | L1    | 1      | Install command declared                                               |
| `build-or-dev-command` | L2    | 2      | Build or dev command declared                                          |
| `dockerfile`           | L2    | 2      | Dockerfile present for a reproducible runtime image                    |
| `reproducible-install` | L3    | 4      | CI installs reproducibly from the lockfile (npm ci / uv sync --locked) |

### Pillar 3: Testing

| Signal               | Level | Points | What counts as present                                          |
| -------------------- | ----- | ------ | --------------------------------------------------------------- |
| `test-files`         | L1    | 1      | Test files exist                                                |
| `test-command`       | L1    | 1      | Test command declared                                           |
| `ci-runs-tests`      | L2    | 2      | CI runs the test suite                                          |
| `multiple-suites`    | L1    | 1      | More than one test file (suite breadth)                         |
| `coverage-command`   | L2    | 2      | Coverage command declared                                       |
| `coverage-threshold` | L3    | 4      | Coverage threshold enforced                                     |
| `e2e-tests`          | L3    | 4      | End-to-end tests exist (Playwright/Cypress config or e2e specs) |

### Pillar 4: Documentation & Instructions

| Signal             | Level | Points | What counts as present                                  |
| ------------------ | ----- | ------ | ------------------------------------------------------- |
| `readme`           | L1    | 1      | README present                                          |
| `agents-md`        | L2    | 2      | AGENTS.md gives agents setup, commands and architecture |
| `contributing`     | L1    | 1      | Contributing guide present                              |
| `architecture-doc` | L2    | 2      | Architecture documentation present                      |
| `spec-docs`        | L3    | 4      | Spec / ADR documents exist (spec-driven development)    |
| `api-docs`         | L3    | 4      | API documentation present (OpenAPI spec or API docs)    |

### Pillar 5: Dev Environment & Remote Execution

| Signal                      | Level | Points | What counts as present                                                      |
| --------------------------- | ----- | ------ | --------------------------------------------------------------------------- |
| `env-example`               | L1    | 1      | .env.example documents required environment variables                       |
| `ci-workflow`               | L1    | 1      | CI workflow present (hosted remote execution)                               |
| `setup-instructions`        | L1    | 1      | Setup instructions documented (README or AGENTS.md)                         |
| `pipeline-workflow`         | L2    | 2      | Agent pipeline workflow present (factory.yml)                               |
| `devcontainer`              | L4    | 8      | Dev container / Codespaces configuration present                            |
| `multi-agent-orchestration` | L5    | 16     | Multi-agent orchestration installed (>=5 agents plus a dispatcher/pipeline) |

### Pillar 6: Code Quality

| Signal                 | Level | Points | What counts as present                                                      |
| ---------------------- | ----- | ------ | --------------------------------------------------------------------------- |
| `codeowners`           | L1    | 1      | CODEOWNERS assigns review ownership                                         |
| `pr-template`          | L1    | 1      | Pull request template present                                               |
| `conventional-commits` | L2    | 2      | Conventional Commits enforced or documented                                 |
| `strict-lint-rules`    | L3    | 4      | Strict lint rule set (recommended + extra rules, or a broad Ruff selection) |
| `dead-code-tool`       | L4    | 8      | Dead-code / dependency-cruft tool configured (knip, depcheck, vulture, …)   |
| `model-routing`        | L5    | 16     | Model routing configured (different models per stage, e.g. a review model)  |

### Pillar 7: Debugging & Observability

| Signal               | Level | Points | What counts as present                                             |
| -------------------- | ----- | ------ | ------------------------------------------------------------------ |
| `health-endpoint`    | L1    | 1      | Health endpoint implemented                                        |
| `otel-dependency`    | L1    | 1      | OpenTelemetry dependency declared                                  |
| `structured-logging` | L2    | 2      | Structured logging in application code (pino / logging)            |
| `debugging-docs`     | L2    | 2      | Troubleshooting / debugging guidance documented                    |
| `otel-code`          | L3    | 4      | Tracing code present (tracing/telemetry module wired into the app) |
| `error-tracking`     | L3    | 4      | Error tracking integrated (Sentry or equivalent)                   |
| `ci-artifacts`       | L2    | 2      | CI uploads diagnostic artifacts on failure                         |

### Pillar 8: Security & Governance

| Signal               | Level | Points | What counts as present                                    |
| -------------------- | ----- | ------ | --------------------------------------------------------- |
| `security-policy`    | L1    | 1      | SECURITY.md policy present                                |
| `dependabot`         | L1    | 1      | Dependabot (or Renovate) keeps dependencies updated       |
| `codeql`             | L2    | 2      | CodeQL static analysis workflow present                   |
| `secret-scan`        | L2    | 2      | Secret scanning in CI (gitleaks or equivalent)            |
| `threat-model`       | L3    | 4      | Threat model documented (STRIDE)                          |
| `audit-in-ci`        | L2    | 2      | Dependency audit runs in CI (npm audit / pip-audit / osv) |
| `guard-hooks`        | L3    | 4      | Agent guard hooks installed (.claude/hooks)               |
| `sbom`               | L3    | 4      | SBOM generated in CI / release                            |
| `release-provenance` | L5    | 16     | Signed release provenance / attestations configured       |

## Measured baseline (2026-10-28)

Measured with `node bin/factory.js readiness` on this repo, and on the four templates scaffolded fresh with `--no-install --no-git`:

| Repo                         | Score | Level | Agent-ready |
| ---------------------------- | ----- | ----- | ----------- |
| software-factory (this repo) | 61    | 4     | yes         |
| template: static-html        | 82    | 4     | yes         |
| template: fullstack          | 99    | 4     | yes         |
| template: node-service       | 95    | 4     | yes         |
| template: python-service     | 95    | 4     | yes         |

Per-pillar breakdown for this repo (61 points):

| Pillar                               | Score | Missing signals                                                                 |
| ------------------------------------ | ----- | ------------------------------------------------------------------------------- |
| 1 Style & Validation                 | 7     | typecheck-strict                                                                |
| 2 Build System                       | 6     | build-or-dev-command, dockerfile                                                |
| 3 Testing                            | 11    | e2e-tests                                                                       |
| 4 Documentation & Instructions       | 10    | api-docs                                                                        |
| 5 Dev Environment & Remote Execution | 3     | pipeline-workflow, devcontainer, multi-agent-orchestration                      |
| 6 Code Quality                       | 8     | dead-code-tool, model-routing                                                   |
| 7 Debugging & Observability          | 4     | health-endpoint, otel-dependency, structured-logging, otel-code, error-tracking |
| 8 Security & Governance              | 12    | guard-hooks, sbom, release-provenance                                           |

Reading the baseline:

- **This repo (L4, 61)** reached Level 4 with four real gates, not scorer changes (spec: `docs/specs/20261028-autonomy-maturity-readiness/SPEC.md`): a coverage gate on its own suite (Node's built-in coverage scoped to `src/` + `bin/`; measured 92.41% lines / 79.34% branches / 90.78% functions on Node 24.22.1, thresholds 89 / 76 / 87 enforced by `scripts/coverage.js` via the `coverage` command in `factory.json` and run in CI), a CI dependency audit of the production surface (`npm audit --omit=dev --audit-level=high` — the factory ships zero runtime dependencies, so that is the tree consumers install), CI failure diagnostics (coverage report + npm logs uploaded with `if: failure()`), and spec documents under `docs/specs/`. It is a plain-JS CLI with no service runtime, so it legitimately has no Dockerfile, health endpoint or tracing; its weakest pillars are dev environment and observability. Its multi-agent orchestration signal fails under the anchoring rule: the kit source under `claude-kit/` is shipped product, and this repo does not install the kit into itself (no root `.claude/`), nor does it run its own `factory.yml`. Both are deliberate dogfooding decisions, not scorer bugs.
- **Generated projects (L4)** start above the L3 bar by construction — the Scale step working as intended. They inherit strict lint/typecheck, coverage thresholds, the agent kit with guard hooks, the pipeline workflow, threat-model and AGENTS.md starters, and (for the service templates) OpenTelemetry tracing and health endpoints.
- **What blocks Level 5 everywhere**: model routing is not configured by default, releases carry no provenance attestations or SBOM, there is no devcontainer, no error tracking, and no dead-code tooling. Level 5 also expects the outcome metrics to be _watched_, which is an operational practice, not a repo artifact.

## Deployment and governance notes

- Run `factory readiness .` in this repo after changing `src/readiness/` or the templates; a template change that drops a scaffold below Level 3 is a regression.
- Signal changes are model changes: update this document's table (regenerate it from the catalog in `src/readiness/signals.js` + `signals-extended.js`) in the same PR.
- Do not weaken a signal to make a repo pass. If a signal is genuinely mis-specified for a stack, fix the definition, say why here, and re-measure every baseline row.
- `factory outcomes` is only as honest as the run records: it reads `.factory/runs/` and invents nothing. Repos with no runs report the empty state.
