# Contributing

## Workflow

1. Open an issue describing the problem and desired outcome.
2. Branch from `main`: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`.
3. For features, write the spec first (the pipeline's spec stage does this for factory runs).
4. Test first where practical. Run the commands in `factory.json` before pushing; CI runs the same ones.
5. Open a PR with a Conventional Commits title (`feat: add visit export`). A code-owner review is required to merge.

## Commands

See `factory.json` → `commands` and `AGENTS.md` for the full list: `npm ci`, `npm run lint`, `npm test`, `npm run smoke`.

## Definition of done

Every acceptance criterion has a test; lint and tests pass; no secrets or real personal data in the change; new configuration is documented; the PR describes risk and rollback. Changes to readiness signals are documented in `docs/autonomy-maturity.md` in the same PR.
