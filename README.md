# software-factory

An automated software factory: start projects that already follow best practices, give Claude Code a disciplined engineering team, and turn an issue into a reviewed pull request through a gated agent pipeline.

```
                         ┌──────────────────────────── factory run / label an issue "factory" ────────────────────────────┐
  idea / issue  ──▶  Spec ──gate──▶ Plan ──gate──▶ Build ──gate──▶ Test ──gate──▶ Review ──gate──▶ Ship ──▶ pull request
                     spec-writer    planner        implementer     test-engineer  code-reviewer    branch, commit,
                                                       ▲                               │           push, gh pr create
                                                       └──── REQUEST_CHANGES rewinds ──┘
```

It has three parts that work alone or together:

| Part                  | What you get                                                                                                                                                  | Entry point                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Project templates** | New repos with strict linting, typed code, tests with coverage gates, CI, CodeQL, secret scanning, Dependabot, release automation, PR/issue templates, Docker | `factory new`                      |
| **Claude Code kit**   | 7 subagents, 8 slash commands, 5 skills and guard hooks that make Claude work spec-first, test-first, and safely                                              | `factory install-claude`           |
| **Agent pipeline**    | Spec → plan → build → test → review → ship, with deterministic quality gates, retries with feedback, a live dashboard, and a GitHub Action                    | `factory run`, `factory dashboard` |

## Install

Requires Node 20+ and git. The pipeline also needs [Claude Code](https://docs.claude.com/en/docs/claude-code) (`npm i -g @anthropic-ai/claude-code`); `--ship` needs the [GitHub CLI](https://cli.github.com).

```bash
npm install -g github:taugustincst/software-factory
factory doctor            # checks node, git, claude, gh, uv, docker
```

Or run it without installing: `npx github:taugustincst/software-factory <command>`. The factory itself has zero runtime dependencies.

## 1. Start a project

```bash
factory templates
factory new visit-export -t node-service --owner taugustincst --description "Visit export API"
cd visit-export && npm run dev
```

| Template         | Stack                                                                                               | Commands gated in CI                                       |
| ---------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `static-html`    | One self-contained `index.html`, vanilla JS, Vitest + jsdom, html-validate, GitHub Pages deploy     | lint, test                                                 |
| `fullstack`      | React 19 + Vite, Fastify + Zod API, TypeScript strict, Testing Library, one Docker image            | lint, typecheck, test (coverage ≥ 80%), build              |
| `node-service`   | Node 24, TypeScript strict, Fastify, Zod config and validation, Vitest, Docker                      | lint, typecheck, test (coverage ≥ 80%), build, `npm audit` |
| `python-service` | Python 3.13, FastAPI, Pydantic settings, uv, pytest, Ruff (incl. bandit rules), mypy strict, Docker | lint, typecheck, test (coverage ≥ 85%), `pip-audit`        |

Every generated project also gets:

- **CI** that runs exactly the commands in `factory.json`, plus a Docker build where relevant.
- **Security:** CodeQL (security-and-quality), gitleaks secret scanning, Dependabot for packages, Actions and Docker, `SECURITY.md`, non-root containers with health checks, security headers, request size limits, log redaction.
- **Workflow:** Conventional Commits PR-title check, release-please changelogs and tags, PR template with risk and rollback, issue forms, `CODEOWNERS`, `CONTRIBUTING.md`, MIT license.
- **The Claude Code kit** (below) and the **factory pipeline workflow** (`.github/workflows/factory.yml`).
- An example resource (tasks) showing the patterns to copy: schema validation at the edge, strict objects, consistent error bodies, a store interface, tests through the public API.
- A clean first commit. The scaffolder formats rendered files, so `lint` passes on day one.

**One setting to flip in each generated repo:** release-please opens the release PR with the default Actions token, which GitHub blocks until the repo allows it. In the new repo go to Settings → Actions → General → Workflow permissions, select **Read and write permissions** and check **Allow GitHub Actions to create and approve pull requests**. Without it the Release workflow fails with "GitHub Actions is not permitted to create or approve pull requests." The generated `release.yml` carries the same reminder in its header.

`factory.json` is the contract between the project, CI, Claude and the pipeline:

```json
{
  "name": "visit-export",
  "template": "node-service",
  "commands": {
    "install": "npm install",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "test": "npm test",
    "build": "npm run build"
  }
}
```

## 2. Give Claude Code a team

```bash
factory install-claude path/to/any/repo     # existing files are kept; settings.json is merged
```

| Kind      | Included                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagents | `spec-writer`, `planner`, `implementer`, `test-engineer`, `code-reviewer`, `security-auditor`, `release-manager`                                                                                                                                                                                                                                                    |
| Commands  | `/spec`, `/plan`, `/build`, `/test`, `/review` (code + security review in parallel), `/ship`, `/audit`, and `/factory` which runs the whole loop in-session until every gate passes                                                                                                                                                                                 |
| Skills    | `tdd`, `conventional-commits`, `secure-coding`, `synthetic-data`, `definition-of-done`                                                                                                                                                                                                                                                                              |
| Hooks     | Block destructive shell commands (force-push, push to main, `rm -rf /`, `curl \| sh`, `reset --hard`, `--no-verify`, printing `.env`); block writes to `.env`, keys, credential files (`.npmrc`, `.netrc`), `.git/`, lockfiles; block credentials and real-format SSNs in written content; auto-format edited files; load `factory.json` commands into each session |
| Standards | `.claude/FACTORY.md`, imported from `CLAUDE.md`                                                                                                                                                                                                                                                                                                                     |

The SSN guard treats any SSN-shaped value as PHI unless it uses a range the SSA never issues (area 000, 666 or 900–999, group 00, serial 0000). The `synthetic-data` skill teaches Claude to generate those, plus `SYN-` MRNs, `555-01xx` phones and `example.com` emails.

## 3. Run the pipeline

```bash
cd your-repo
factory run --request "Add a 'Clear completed' button that removes all done items"
factory run --spec issue.md --ship --issue 42      # push a branch and open a PR that closes #42
factory dashboard                                    # http://127.0.0.1:4545
```

| Stage  | Agent         | Gate (deterministic; never trusts the agent's own claim)                                                                                                                                                                                                                             |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| setup  | —             | Working tree is clean (or `--allow-dirty`), then `install` succeeds                                                                                                                                                                                                                  |
| spec   | spec-writer   | `SPEC.md` written this attempt, with Problem, numbered Requirements, checklist Acceptance Criteria, Out of Scope; nothing outside the spec folder changed                                                                                                                            |
| plan   | planner       | `PLAN.md` written this attempt, with Tasks, Test Strategy, Risks; **every AC ID appears in the Tasks section**; nothing outside the spec folder changed                                                                                                                              |
| build  | implementer   | Source files changed **and test files added or changed**; `lint`, `typecheck`, `build` pass                                                                                                                                                                                          |
| test   | test-engineer | The suite passes and tests were added or changed. When `factory.json` declares a `coverage` command (every template ships one carrying its threshold), that run — the full suite plus the coverage threshold — stands in for the plain `test` run instead of running the suite twice |
| review | code-reviewer | `REVIEW.md` written this attempt with a single `Verdict: APPROVE` line, no `[BLOCKER]` items, nothing outside the spec folder changed, **no secrets or PHI in any changed file**, tests still pass                                                                                   |
| ship   | —             | Feature branch `factory/<slug>-<id>`, Conventional Commit; with `--ship`: push and `gh pr create`                                                                                                                                                                                    |

Loop rules:

- A failed gate sends its exact failure output back to the same agent (default 3 attempts per stage).
- A review that requests changes **rewinds to build** with the findings, then re-runs test and review (default 2 loops).
- `--review-model <name>` runs the review stage on a different model than the one that wrote the code — a second pair of eyes instead of self-review.
- Every stage has a spend cap (`--max-budget-usd`); `--budget-multiplier` scales them. Cost is tracked per attempt and per run, and `--max-run-usd` (default $15, 0 disables) stops the run once total agent spend reaches it — retries and review rewinds cannot stack per-stage caps into an unbounded bill.
- Artifacts are committed with the change: `docs/specs/<date>-<slug>/SPEC.md`, `PLAN.md`, `REVIEW.md`. Run state and logs live in `.factory/runs/<id>/` (git-ignored).
- Nothing merges itself. The PR body carries the acceptance criteria, gate results, review verdict and cost for a human to approve.
- `--pause-after <stage>` stops the run once that stage's gate passes and saves it as `paused`, so a human can read the spec (or plan) before money is spent building. `factory run --resume <run-id>` continues the same run — same artifacts, history and cost — from the next stage. A resume refused for foreign uncommitted changes leaves the run paused.

`--executor mock` runs the whole flow offline (no API calls), which is how the factory's own CI tests every template end to end.

### From GitHub

Every generated repo includes `.github/workflows/factory.yml`. Add an `ANTHROPIC_API_KEY` secret and a `factory` label; labelling an issue runs the pipeline and comments the PR link back on the issue. Make that secret a **dedicated, spend-capped key** (its own Anthropic workspace with a monthly limit), never a personal or unbounded one: the agent runs code with the key in its environment, so the cap is what bounds a misbehaving run, and a dedicated key can be revoked without breaking anything else. The build job also runs step-security/harden-runner in audit mode, logging every outbound connection; the workflow header explains how to tighten it to a blocking allowlist once you have a green run's audit log. Use a `FACTORY_TOKEN` secret (fine-grained PAT or GitHub App token) if you want CI to run on factory PRs, because PRs opened with the default `GITHUB_TOKEN` do not trigger workflows.

The workflow treats issue text as untrusted input to an agent that can run code:

1. **authorize**: the person who applied the label must have write access.
2. **build**: runs `factory run --no-commit` with read-only repository permissions, no persisted git credentials and no write token. It uploads the reviewed change as a patch. Raw agent logs are uploaded only for private repositories.
3. **ship**: runs no agent. It applies the patch, then `factory ship` pushes the branch and opens the PR with the write token.
4. **report**: comments the result on the issue.

Issue text reaches scripts only through environment variables, never `${{ }}` interpolation.

### Dashboard

`factory dashboard` serves a local page showing every run, each stage's gate checks per attempt, live agent logs, events, cost, branch and PR link, plus a form to start new runs. A running run can be cancelled from its detail page (the CLI stops cooperatively, saves the run as `cancelled` and releases the repo lock; Ctrl-C or SIGTERM does the same for terminal runs), and the detail page also shows the launcher output for dashboard-started runs. It binds to 127.0.0.1 only, rejects foreign `Host` headers (DNS rebinding) and cross-origin POSTs (CSRF), and sends a strict CSP.

## Safety model

| Layer       | Control                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent tools | Per-stage allow-list in `acceptEdits` mode, never `bypassPermissions`. Spec and plan agents have no shell. The reviewer can only run git inspection and the project's check commands.                                                                                                                                                                    |
| Stage scope | Spec, plan and review may only write inside their spec folder. The gate fingerprints every changed file before and after the attempt, and fails the stage if anything else changed.                                                                                                                                                                      |
| Guard hooks | Injected into every pipeline run with `--settings`, because Claude Code ignores a repo's own settings in untrusted workspaces such as CI checkouts. Also installed in the repo for interactive use. Commands are parsed with a shell tokenizer that sees through quotes, `sudo`/`env`, `bash -c`, git global options and refspecs (`+branch`, `x:main`). |
| Gates       | Re-run real commands and re-read files; an agent's claim of success counts for nothing. Artifacts must be written in the current attempt.                                                                                                                                                                                                                |
| Secrets/PHI | Hook blocks credentials and real-format SSNs on write. The review gate scans every changed file (monorepo and non-ASCII paths included). gitleaks runs in CI.                                                                                                                                                                                            |
| Git         | Starts from a clean tree, works on a feature branch, commits only the run's changes, and never force-pushes or pushes to protected branches. A human merges.                                                                                                                                                                                             |
| CI          | Agent and write token never share a job; only collaborators with write access can trigger a run.                                                                                                                                                                                                                                                         |
| Spend       | Per-stage caps, plus attempt and review-loop limits.                                                                                                                                                                                                                                                                                                     |

The hooks are a safety net against mistakes and casual prompt injection, **not a sandbox**: build and test agents can run the project's toolchain (`npm`, `npx`, `node`, `uv`, `python`), and code run through an interpreter is not inspected. Isolation comes from where you run it. For untrusted requests, run the pipeline in CI (as the workflow above does) or a container, not on a workstation that holds credentials, and keep branch protection on `main` (required code-owner review and required CI).

## Commands

```
factory new <name> -t <template> [--dir] [--owner] [--description] [--no-install] [--no-git] [--no-claude]
factory templates
factory install-claude [dir] [--force]
factory run (--spec <file> | --request <text>) [--dir] [--stages spec,plan,…] [--executor claude|mock] [--model]
            [--max-attempts 3] [--max-review-loops 2] [--budget-multiplier 1] [--max-run-usd 15] [--ship] [--issue <n>] [--no-commit] [--no-install] [--allow-dirty]
            [--max-attempts 3] [--max-review-loops 2] [--budget-multiplier 1] [--ship] [--issue <n>] [--no-commit] [--no-install] [--allow-dirty]
            [--pause-after <stage>] [--resume <run-id>]
            [--model <name>] [--review-model <name>]
factory ship --run-id <id> [--issue <n>] [--no-push]
factory runs [--dir]
factory dashboard [--dir] [--port 4545]
factory doctor
```

## Developing the factory

```bash
npm ci
npm run lint && npm test     # unit tests: patterns, hooks, scaffolder, kit installer, gates, pipeline, executor, dashboard
npm run smoke                # scaffold every template, install, run its real checks, run the pipeline inside it
```

See [docs/architecture.md](docs/architecture.md) for how the pieces fit, and how to add a template, stage or gate.

## License

MIT
