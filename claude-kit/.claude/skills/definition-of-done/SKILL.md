---
name: definition-of-done
description: The checklist a change must meet before it is called done or a PR is opened. Use before saying a task is complete, before committing, and before /ship.
---

# Definition of done

A change is done when all of these are true. If one is not, say which, rather than calling it done.

- [ ] Every acceptance criterion in the spec is met and has an automated test.
- [ ] `lint`, `typecheck` (if present) and `test` from `factory.json` pass locally.
- [ ] No new warnings in the test or build output.
- [ ] New configuration is read from env vars and documented in `.env.example` and the README.
- [ ] No secrets, personal data, or real patient data in code, fixtures, logs or commits.
- [ ] Public behaviour changes are documented (README, API docs, or CHANGELOG via the commit message).
- [ ] Error paths are handled and tested; failures produce actionable messages.
- [ ] The diff contains only what the task needs: no drive-by refactors, debug output, or commented-out code.
- [ ] Commit messages follow Conventional Commits; work is on a branch, not `main`.
- [ ] Review verdict is APPROVE with no open BLOCKERs.
