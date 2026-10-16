---
name: conventional-commits
description: Write commit messages and PR titles in Conventional Commits format so changelogs and releases are generated automatically. Use whenever committing, naming a branch, or titling a pull request.
---

# Conventional Commits

Format: `type(scope): summary`

- **type**: `feat` (new behaviour), `fix` (bug fix), `perf`, `refactor` (no behaviour change), `test`, `docs`, `build` (deps, packaging), `ci`, `chore`, `revert`.
- **scope**: optional area, e.g. `api`, `ui`, `auth`.
- **summary**: imperative mood, lower case, no trailing period, at most 72 characters. "add visit export", not "Added visit export."
- **body**: why the change was made, wrapped at 72. What changed is in the diff.
- **footer**: `Closes #123`; `BREAKING CHANGE: <what breaks and how to migrate>` (also add `!` after the type: `feat(api)!: ...`).

Branches: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`. Never commit straight to `main`.

Releases: `feat` bumps minor, `fix`/`perf` bump patch, `!` bumps major. release-please reads these messages to write CHANGELOG.md and tag releases.
