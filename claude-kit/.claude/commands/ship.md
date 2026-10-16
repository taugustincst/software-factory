---
description: Commit on a feature branch, push, and open a pull request
argument-hint: [spec folder, defaults to the newest in docs/specs]
---

Find the spec folder: `$ARGUMENTS` if given, otherwise the most recent folder in `docs/specs/`.

Preconditions, check each and stop with the reason if one fails:

- `REVIEW.md` exists and says `Verdict: APPROVE`.
- The `lint` and `test` commands from `factory.json` pass right now.
- `git status` shows no files that look like secrets or build output.

Then use the **release-manager** subagent to draft the commit message and PR description. Create a branch named `feat/<slug>` (or `fix/<slug>`) if you are on `main`, commit with the Conventional Commits message, push with `git push -u origin <branch>`, and open the PR with `gh pr create --title ... --body-file ...`. Never push to main and never merge. Give me the PR link.
