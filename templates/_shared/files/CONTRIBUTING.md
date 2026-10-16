# Contributing

## Workflow
1. Open an issue describing the problem and desired outcome (or label it `factory` to have the agent pipeline build it).
2. Branch from `main`: `feat/<slug>`, `fix/<slug>`.
3. For features, write the spec first in `docs/specs/<date>-<slug>/SPEC.md` (`/spec` in Claude Code does this).
4. Test first. Run the commands in `factory.json` before pushing; CI runs the same ones.
5. Open a PR with a Conventional Commits title (`feat: add visit export`). A code-owner review is required to merge.

## Commands
See `factory.json` → `commands`. Typical: `install`, `lint`, `typecheck`, `test`, `build`.

## Definition of done
Every acceptance criterion has a test; lint, typecheck and tests pass; no secrets or real personal data; new config is documented; the PR describes risk and rollback.
