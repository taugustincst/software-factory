# AGENTS.md — software-factory

Instructions for any agent (Claude Code, the factory pipeline, or a human contributor) working in this repository.

## Setup

```bash
npm ci                # install dev dependencies (the factory itself has zero runtime dependencies)
git config core.hooksPath .githooks   # enable the pre-commit hook (lint on staged changes)
```

Requires Node >= 20.11. Optional tools are checked by `node bin/factory.js doctor` (git, the Claude Code CLI, `gh`, `uv`, docker).

## Commands

```bash
npm run lint          # eslint + prettier --check (must be green before committing)
npm test              # node:test suite (~119 tests, fast, no network)
npm run test:coverage # coverage gate for src/ + bin/ (thresholds 89/76/87, enforced in CI)
npm run smoke         # slow end-to-end check: scaffolds every template and runs the pipeline in it
node bin/factory.js readiness .        # Autonomy Maturity Model score for this repo
node bin/factory.js outcomes           # outcome metrics from .factory/runs (cycle time, autonomy ratio, cost)
node bin/factory.js templates          # list the scaffold templates
```

`factory.json` is the command contract for this repo: `install` (`npm ci`), `lint`, `test`. CI, the pipeline gates and the slash commands all run the same commands, so "green locally" means "green in CI".

## Architecture

Read `docs/architecture.md` before changing the structure. The short version:

- `bin/factory.js` — CLI entry; `src/cli/index.js` — argument parsing and commands.
- `src/scaffold.js` — template rendering (`{{factory.*}}` tokens) and project creation.
- `src/pipeline/` — the spec → plan → build → test → review → ship loop: `stages.js` (definitions), `gates.js` (deterministic checks), `executors.js` (claude / mock), `runner.js` (attempts, feedback, review rewinds), `store.js` (`.factory/runs/<id>/run.json`).
- `src/readiness/` — the Autonomy Maturity Model: `signals.js` + `signals-extended.js` (binary signal catalog), `context.js` (repo-tree probes), `score.js` (scoring, levels, org readiness), `outcomes.js` (run-outcome aggregation). See `docs/autonomy-maturity.md`.
- `claude-kit/.claude/` — the agents, commands, skills and guard hooks installed into generated projects. Guard rules live only in `claude-kit/.claude/hooks/lib/patterns.mjs`; every rule change needs positive and negative cases in `test/patterns.test.js`.
- `templates/<id>/files/` — project skeletons; `templates/_shared/files/` is copied into every scaffold. Template files are not linted by this repo; they are verified by `npm run smoke`.

## Working rules

- Zero runtime dependencies: Node built-ins only, in `src/` and in generated templates' factory code.
- Never use `shell: true` with values from users or agents. Shell strings are only for `factory.json` commands, which the repo owner controls.
- Keep the dashboard local-only: 127.0.0.1 binding, Host check, Origin check on POST, strict CSP, no `innerHTML`.
- Conventional Commits, feature branches, pull requests to `main`.
- Threat model: `docs/threat-model.md` (STRIDE). Do not weaken a guard hook, gate or workflow permission without updating it.

## Troubleshooting

- **`npm run lint` fails on a template file**: template trees under `templates/**/files/` are excluded from this repo's lint/format on purpose; if you edited one, verify with `npm run smoke <template>` instead of formatting it here.
- **A pipeline run is stuck or a repo is locked**: runs write state to `.factory/runs/<id>/run.json` and hold a lock via `src/pipeline/lock.js`. Inspect the run's logs under `.factory/runs/<id>/` before deleting anything; a `running` status with no live process means the previous run died — the next run reports it.
- **`factory readiness` scores lower than expected**: run it with `--json` and read the per-signal results; each failing signal names a one-line remediation in `docs/autonomy-maturity.md`. The scorer probes this repo's own installed paths — content under `templates/` and `claude-kit/` is shipped product, not this repo's own setup, and does not count.
- **Smoke is slow**: it installs every template for real. Run a single template with `npm run smoke <id>` while iterating.
