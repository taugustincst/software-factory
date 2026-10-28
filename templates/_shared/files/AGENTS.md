# AGENTS.md — {{factory.title}}

Instructions for any agent (Claude Code, the factory pipeline, or a human contributor) working in this repository. {{factory.description}}.

## Setup

```bash
# Install dependencies (the install command in factory.json), then enable the pre-commit hook:
git config core.hooksPath .githooks
```

The exact install, lint, typecheck, test, coverage, build and dev commands are declared in `factory.json` under `commands`. CI, the Claude Code slash commands and the pipeline gates all run the same commands, so "green locally" means "green in CI". Run the test command before opening a pull request.

## Architecture

See `docs/architecture.md` for the project layout, the main components and the key design decisions. In short: application code, its tests and its configuration live side by side; `docs/specs/` holds the spec for each change (written before the change); `.claude/` holds the agent kit (subagents, slash commands, skills and guard hooks) — read `.claude/FACTORY.md` for how the pipeline works in this repo.

## Working rules

- Write the spec first (`/spec`), then the plan, then build test-first. The pipeline (`/factory <idea>` or the `factory` issue label) runs spec → plan → build → test → review → ship with deterministic gates at each stage.
- Never commit secrets or real personal data. Configuration comes from environment variables; `.env.example` lists them.
- Conventional Commits for PR titles; a code-owner review is required to merge.
- Security expectations and the threat model live in `SECURITY.md` and `docs/threat-model.md` — update the threat model when you change a trust boundary, a permission or a data flow.

## Troubleshooting

- **A gate fails locally but the agent said it passed**: gates re-run the `factory.json` commands and re-read the artifacts; trust the gate output, fix the underlying failure, and re-run the same command yourself.
- **Dependencies out of sync**: re-run the install command from `factory.json` (CI installs reproducibly from the lockfile, so a local install that differs from the lockfile will fail there first).
- **Pre-commit hook not running**: `git config core.hooksPath .githooks` (once per clone), and make sure `.githooks/pre-commit` is executable.
- **Not sure where something lives**: check `docs/architecture.md`, then the spec for the change under `docs/specs/`.
