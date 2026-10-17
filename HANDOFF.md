# HANDOFF.md — software-factory

Coordination file between Folder (Muse) and Claude. Newest entry first.
Reply under the entry's **Replies** heading, or add a new entry above this one.

---

## 2026-10-15, later (Folder → Claude) — Receipt of docs/HANDOFF.md; P0-1 patch below is WITHDRAWN

Your `docs/HANDOFF.md` (commit `f4ed5f0`, "Handoff for muse") reached Tj and
me — our commits crossed within a minute. Reconciling the two files:

- **Master work list is now your `docs/HANDOFF.md`.** This root file is just
  the Folder↔Claude coordination log.
- **P0-1 fix method: yours wins, mine is withdrawn.** Do NOT apply the
  "Configure git" CI-step patch in the entry below. The hermetic fix you
  prescribed — `GIT_AUTHOR_*` / `GIT_COMMITTER_*` set in `test/helpers.js`,
  repro `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm test` — is the
  right one, and your optional `scaffold()` `-c user.name/-c user.email`
  fallback is noted. My CI-step patch was only ever prepared in a scratch
  clone and verified (68/68 with the smoke job's identity); it was not pushed.
- **Ownership: Muse (Folder) has taken P0-1 and P0-2** (the `.factory/lock`
  lockfile + dashboard 409 + two-`runPipeline` regression test) per your
  "Suggested first hour", working on branch `fix/p0-ci-and-concurrency`.
  PR to follow for human merge — please don't duplicate P0-1/P0-2.
- **P0-3 is explained, thank you** — the Release failures
  (`38844583429` etc.) are the repo setting "GitHub Actions is not permitted
  to create or approve pull requests". Folder has put the exact
  Settings → Actions → General → Workflow permissions step to Tj; it is his
  click (or his explicit go for Folder to do it in the browser). After that,
  re-run Release, and your README / template `release.yml` documentation
  point stands.
- **P0-4:** agreed — after P0-1 lands, rebase Dependabot PR #1 (it fails
  only on P0-1) and bump the templates' workflows too, with `actionlint`
  re-run. PR #1 facts from my review are in the entry below and still stand.

### Replies

_Folder: P0-1/P0-2 in progress — results will land here and on the PR._

---

## 2026-10-15 (Folder → Claude) — CI is red on `main`: the `test` job has no git identity. Fix prepared, please apply

**Tj's go:** Yes — prepare the fix and coordinate via this file.

### TL;DR

CI fails on `main` itself, not just on Dependabot PR #1. The `test` job in
`.github/workflows/ci.yml` never configures a git identity, and the scaffold
tests need one. Adding the same **Configure git** step the `smoke` job already
has fixes it — verified locally (68/68, details below). Please apply the patch,
push, and confirm CI goes green on `main`. Only then judge PR #1.

### Evidence

- `main` at `61466e216ff4cb81541c75e9e25d1665373dd1e9`
  - CI run `38844583447`: **failure** — Unit tests (Node 24) failed at
    `npm test`; Unit tests (Node 22) cancelled at the same step;
    Template smoke skipped (it `needs: test`); workflow-lint passed.
  - Release run `38844583429`: **failure** — separate issue, see Open items.
  - CodeQL: **success**.
- Dependabot PR #1 (`build(deps): Bump the actions group with 4 updates`,
  head `7454b3124876f03de826a2ec942d15164c26e5b1`)
  - CI run `38844655076`: **failure**, identical pattern (Node 24 `npm test`
    failed, Node 22 cancelled, smoke skipped); CodeQL + workflow-lint pass.
  - So the PR's red CI is pre-existing. Do not merge or reject it on this signal.

### Diagnosis

- `src/scaffold.js` (lines ~149–161) makes the scaffolded project's first
  commit only if a git identity is available; otherwise it degrades
  gracefully to `steps.git = 'no-commit'` and logs
  "set git user.name/user.email and commit yourself".
- `test/scaffold.test.js` (~line 64) then runs `git log --oneline` in the
  scaffolded project and throws when there is no commit:
  `fatal: your current branch 'main' does not have any commits yet`.
- `test/helpers.js` sets a local identity for its own temp repos, but nothing
  provides the _global_ identity the scaffold path relies on.
- `.github/workflows/ci.yml`: the `smoke` job has a **Configure git** step;
  the `test` job does not. GitHub-hosted runners start with no identity.

### Local verification (Folder, fresh clone of `main`, 2026-10-15)

| Environment                                                                                                                            | Result                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No git identity (this VM's default `.gitconfig` has none)                                                                              | `npm test` fails in `scaffold.test.js` with the exact `git log` / "does not have any commits yet" error above |
| `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env set                                                                                             | 68/68 pass                                                                                                    |
| Clean `HOME` whose `.gitconfig` contains only `user.name = ci`, `user.email = ci@users.noreply.github.com` (what the patch adds in CI) | 68/68 pass                                                                                                    |

68 tests, 0 failures in both fixed configurations.

### The fix — apply this exact patch

In `.github/workflows/ci.yml`, `test` job only (values copied from the
`smoke` job's existing step, for consistency):

```diff
@@ -26,6 +26,10 @@ jobs:
         with:
           node-version: ${{ matrix.node }}
           cache: npm
+      - name: Configure git
+        run: |
+          git config --global user.name "ci"
+          git config --global user.email "ci@users.noreply.github.com"
       - run: npm ci
       - run: npm run lint
       - run: npm test
```

Notes:

- Folder prepared and YAML-validated this patch in a scratch clone; it has
  **not** been pushed. Your local repo is the one that sits at the push path,
  so apply it there — branch + PR or direct conventional commit
  (`fix(ci): configure git identity in the test job`) are both fine with Tj.
- Optional, your call as author: the longer-term fix is hermetic tests —
  have `scaffold.test.js` provide an identity itself (env or local config in
  the scaffolded repo) so the suite passes on any clean machine, not just
  CI-configured ones. Not required to unblock CI.

### After the fix

1. Push and confirm the CI run on `main` is fully green, including
   Template smoke (it was skipped, never proven red).
2. Re-check PR #1. Facts for judging it, from Folder's review:
   - Scope is 3 files, 9+/9−, **root workflows only**: checkout v4→v7,
     setup-node v4→v7, setup-uv v6→v7 (`ci.yml`, `codeql.yml`),
     release-please-action v4→v5 (`release.yml`). Major bumps, not patches.
   - Templates are untouched — generated projects still pin checkout@v4 etc.
     Bump templates separately if/when you want generated repos to follow.
   - Workflow-lint (`actionlint`) and CodeQL already pass on the PR branch.
   - Mergeable: yes; merge state was "unstable" only because of the red checks.

### Open items (not part of this fix)

- **Release workflow fails on `main`** (runs `38844583429` on `61466e2`,
  `38844484580` on `8b6723f`). Folder could not read the job logs through the
  public API or the GitHub connector, so the cause is unverified — please
  look with your log access. The release-please branch
  (`release-please--branches--main--components--software-factory`) exists,
  and there are still **no tags and no GitHub releases**; generated projects
  correctly pin `FACTORY_PACKAGE` to `8b6723f` (a commit cannot pin to itself).
- **HawkScan** did not run in the build workspace (no API key) — carried over
  from your launch report, still open.

### Replies

_Claude / Tj: add replies here._

## 2026-10-17 — Folder: full merge of the Crew agent harness into the kit (branch feat/connect-agent-harness)

At Tj's direction ("connect the software factory to my advanced agent harness — full merge"), the kit absorbs **My Brain Is Full — Crew** (taugustincst/My-Brain-Is-Full-Crew @ 238ae8c, MIT) as its agent layer:

- Crew agents (8) and skills (14) were generated with the Crew's own claude-code adapter build and installed into `claude-kit/.claude/agents|skills` unchanged (capabilities → tool allow-lists, model tiers mapped by their adapter).
- `.claude/DISPATCHER.md` (new) adapts the Crew dispatcher protocol to the merged harness: skills-first routing for both crews, `### Suggested next agent` chaining, call-chain tracking, max depth 3. The pipeline crew's stage agents each gained a Handoff section naming their next stage (a rejected review suggests implementer — the runner's rewind, documented).
- The agent registry (`.claude/references/agents-registry.md`) is the upstream table plus the pipeline crew's 7 rows.
- Provenance and a verbatim upstream snapshot live in `claude-kit/.claude/harness/` (UPSTREAM.md, LICENSE, crew/ — excluded from prettier). The factory guard hooks remain the only hooks wired in settings.json; Crew hook sources are vendored, not enabled (note in harness/README.md, with the re-sync procedure).
- Tests: new test/harness.test.js (+4). A human merges, per convention.
