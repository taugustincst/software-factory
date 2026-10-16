# Handoff: software-factory

**From:** claude-bf session (built v0.1) · **To:** muse · **Date:** 2026-10-15 · **Owner:** Taylor (@taugustincst)

Repo: https://github.com/taugustincst/software-factory · `main` @ `61466e2` · read `README.md` and `docs/architecture.md` first.

## What this is

A Node CLI (`factory`, zero runtime deps) with three parts:

1. **Templates** (`templates/`): `static-html`, `fullstack`, `node-service`, `python-service`, plus `_shared` GitHub/security files. `factory new`.
2. **Claude Code kit** (`claude-kit/.claude/`): 7 subagents, 8 commands, 5 skills, guard hooks. `factory install-claude`.
3. **Agent pipeline** (`src/pipeline/`): spec → plan → build → test → review → ship with deterministic gates, feedback retries, review→build rewinds, per-stage spend caps, local dashboard (`src/dashboard/`), and a split-job GitHub workflow (`templates/_shared/files/.github/workflows/factory.yml`).

## Current state

| Area                 | State                                                                                    | Evidence                                            |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Unit tests           | 68/68 pass **locally**                                                                   | `npm test`                                          |
| Templates            | All 4 lint/typecheck/test/build clean, clean tree, mock pipeline passes inside each      | `npm run smoke`                                     |
| Live pipeline        | 2 real Claude runs passed first try ($1.44 static-html, $1.29 node-service, ~5 min each) | Local only, not reproducible from repo              |
| Independent review   | 11 findings (6 major), all fixed with regression tests                                   | `test/regressions.test.js`, `test/patterns.test.js` |
| **GitHub CI**        | **RED on main** (see P0-1)                                                               | Actions runs #1–#3                                  |
| **Release workflow** | **Failing** (see P0-3)                                                                   | Actions run 38844583429                             |

## Open work, in priority order

### P0: make `main` green

1. **Unit tests need a git identity.** Four tests in `test/scaffold.test.js` fail on GitHub runners because `scaffold()` commits without `user.name`/`user.email`.
   - Repro: `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm test`.
   - Fix: set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` in `test/helpers.js` (`process.env`) before the tests run.
   - Optionally also make `scaffold()` pass `-c user.name=… -c user.email=…` fallbacks when no identity is configured, so `factory new` works on fresh machines.
2. **Concurrent runs in one repo contaminate each other.** Two runs at once: run A's commit included run B's spec files, and B failed with "no source changes".
   - Reachable via the dashboard.
   - Fix: a lockfile at `.factory/lock` (holding pid and run id) acquired in `runPipeline` and released in `finish()`. The dashboard should return 409 while it's held.
   - Better long-term: run each run in its own `git worktree`.
   - Add a regression test using two `runPipeline` calls with `mockExecutor({ delayMs: 300 })`.
3. **Release workflow is blocked by a repository setting**: "GitHub Actions is not permitted to create or approve pull requests."
   - Taylor enables it under Settings → Actions → General → Workflow permissions.
   - Document this in the README and in the template's `release.yml` header comment, since every generated repo hits it.
4. **Deprecated action majors.** GitHub warns "Node.js 20 is deprecated" for the `@v4` actions.
   - Bump checkout, setup-node, upload/download-artifact, codeql and release-please to current majors in `.github/workflows/*` and `templates/_shared/files/.github/workflows/*` plus the template `ci.yml` files.
   - Dependabot PR #1 already proposes the factory's own bumps. It fails only because of P0-1, so rebase it after that fix.
   - Re-run `actionlint` locally after the bumps; the CI `workflows` job does the same.

### P1: trust and cost

5. **Run-level spend cap.** Add `--max-run-usd` (default ~$15); `runPipeline` stops when `state.costUsd` reaches it. Worst case today is about $100 (3 attempts per stage plus 2 review loops).
6. **The GitHub issue flow has never run for real**: authorize → build (`--no-commit`, patch artifact) → ship (`factory ship`). Do one test on a throwaway generated repo. It needs the `ANTHROPIC_API_KEY` secret, a `factory` label and the Actions PR permission (P0-3).
7. **API key exposure in the CI agent job.** The agent can run `node`/`npx` alongside `ANTHROPIC_API_KEY`. Options:
   - a spend-capped, dedicated key (document this)
   - egress restriction (for example step-security/harden-runner in block mode, allowing only api.anthropic.com and the registries)
8. **Retry and rewind loops are only proven with the mock.** Write a live test request that's likely to fail its first gate. Easiest: a pre-seeded failing test in a fixture repo.

### P2: depth

- Quality gates are structural. Ideas: make "tests added" an error for the build/test stages, enforce coverage from `factory.json`, and add an optional second-model reviewer.
- Optional human checkpoint: `--pause-after spec` writes the spec and exits; `factory run --resume <id>` continues.
- Templates lack a database and migrations, auth, Playwright end-to-end tests, OpenTelemetry, and a deploy target.
- Add `factory upgrade` (a three-way merge of template changes into existing projects).
- Add a cancel button to the dashboard, and run detail for the launcher log.
- Windows support is untested.

## Environment gotchas (from the build session)

- **Tag pushes are blocked** by the session git proxy. That's why `FACTORY_PACKAGE` in `src/scaffold.js` pins a commit SHA (`8b6723f…`) rather than `v0.1.0`. After a release, bump that pin in a follow-up commit, since a commit can't contain its own SHA.
- **The `gh` token in the build session was invalid.** Repo access came through the session's add_repo attachment. Don't rely on `gh` there.
- **npm 10 breaks on two things:** Vitest 4.1.x (an `edgesOut` arborist crash, so templates use Vitest 5), and `npx github:…#<sha>` ("GitFetcher requires an Arborist"). npm 11 / Node 24 is fine, and the generated workflows use Node 24.
- **TypeScript is pinned `~6.0`** because typescript-eslint 8.71 doesn't support TS 7 yet.
- **Claude Code ignores `.claude/settings.json` in untrusted workspaces**, including every CI checkout. The executor therefore injects guard hooks with `--settings` (`guardSettings()` in `src/pipeline/executors.js`); this was verified live. Don't remove it.
- **Headless output:** `claude -p --output-format stream-json --verbose`. The final `{"type":"result"}` line has `total_cost_usd`, `is_error`, `subtype` and `terminal_reason` (`budget_exhausted` when the cap is hit).
- **Each headless invocation costs about $0.12** before doing any work (system prompt cache creation), so stage budgets under $0.50 are pointless.
- **`pkill -f <pattern>`** in a compound shell command can kill the shell itself; kill dashboards by port (`ss -ltnp`) instead.

## Conventions to keep

- Gates are code, not prompts. Never accept an agent's claim of success.
- Guard rules live only in `claude-kit/.claude/hooks/lib/patterns.mjs`. Every rule change needs positive and negative tests.
- No `shell: true` with agent- or user-supplied strings. Shell strings are only for `factory.json` commands.
- Any template change needs `npm run smoke <template>` green with a clean tree, plus `actionlint` on the rendered workflows.
- Use Conventional Commits and feature branches. A human merges.

## Suggested first hour

1. Fix P0-1 and run `npm test` under `GIT_CONFIG_GLOBAL=/dev/null`.
2. Fix P0-2 with its regression test.
3. Commit on a branch and open a PR. CI should go green apart from Release (P0-3, which needs Taylor).
4. Rebase Dependabot PR #1, or do the P0-4 action bumps by hand.
5. Ask Taylor to enable the Actions PR permission, then re-run Release.
