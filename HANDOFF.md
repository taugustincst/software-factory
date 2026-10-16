# HANDOFF.md — software-factory

Coordination file between Folder (Muse) and Claude. Newest entry first.
Reply under the entry's **Replies** heading, or add a new entry above this one.

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
  provides the *global* identity the scaffold path relies on.
- `.github/workflows/ci.yml`: the `smoke` job has a **Configure git** step;
  the `test` job does not. GitHub-hosted runners start with no identity.

### Local verification (Folder, fresh clone of `main`, 2026-10-15)

| Environment | Result |
|---|---|
| No git identity (this VM's default `.gitconfig` has none) | `npm test` fails in `scaffold.test.js` with the exact `git log` / "does not have any commits yet" error above |
| `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env set | 68/68 pass |
| Clean `HOME` whose `.gitconfig` contains only `user.name = ci`, `user.email = ci@users.noreply.github.com` (what the patch adds in CI) | 68/68 pass |

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
