# Architecture

```
bin/factory.js                CLI entry
src/cli/index.js              argument parsing and commands
src/scaffold.js               template rendering ({{factory.var}} tokens), project creation
src/claude-kit.js             installs claude-kit/ into a repo, merging settings.json
src/pipeline/
  project.js                  loads factory.json or infers commands (package.json, pyproject, Makefile)
  stages.js                   stage definitions: agent, tool allow-list, spend cap, prompt, rewind target
  gates.js                    deterministic checks per stage + secret/PHI scan of changed files
  executors.js                claude (headless Claude Code, stream-json) and mock executors
  runner.js                   the loop: attempts, feedback, review rewinds, ship
  store.js                    .factory/runs/<id>/run.json (atomic writes) and per-attempt logs
src/dashboard/                local HTTP server + single-page UI
claude-kit/.claude/           agents, commands, skills, hooks, settings, FACTORY.md
  hooks/lib/patterns.mjs      single source of truth for secret, PHI, command and path rules
templates/_shared/files/      files every project gets (GitHub config, security, docs)
templates/<id>/template.json  title, stack, vars, commands, postCreate
templates/<id>/files/         the project skeleton
scripts/smoke.js              end-to-end template + pipeline check (used in CI)
```

## Design decisions

**Gates are code, not prompts.** An agent saying "tests pass" counts for nothing. Each gate re-reads the artifact or re-runs the project's own command, so a stage passes only when an observer could verify it.

**`factory.json` is the single contract.** CI, the SessionStart hook, the slash commands and the gates all run the same `install`, `lint`, `typecheck`, `test` and `build` commands, so "green locally" and "green in CI" mean the same thing.

**Agents are files.** The pipeline's system prompts are the kit's subagent definitions. Edit `.claude/agents/code-reviewer.md` in a repo and both `/review` and `factory run` use your version (project copy first, kit fallback).

**Guards travel with the run.** Claude Code ignores a repository's `.claude/settings.json` until someone trusts that workspace interactively, which never happens in CI. The executor therefore passes the factory's own hooks by absolute path with `--settings` on every invocation.

**Least privilege per stage.** Spec, plan and review agents get read tools plus `Write` for their one artifact. Only build and test get a shell, and only through an allow-list. Review can read the diff but has no `Edit`.

**Feedback, not retries.** A failed attempt's gate output (failing test output, missing sections, uncovered ACs, review findings) is appended to the next prompt, so each retry is informed. A rejected review cannot be fixed by re-reviewing, so it rewinds to build.

**Zero runtime dependencies.** The factory uses only Node built-ins, which keeps `npx github:…` fast and leaves almost no supply-chain surface for a tool that runs agents with write access.

## Extending

**Add a template.** Create `templates/<id>/template.json` (`title`, `stack`, `vars.codeqlLanguage`, `vars.dependabotEcosystem`, `vars.releaseType`, `commands`, optional `postCreate`) and `templates/<id>/files/`. Use `{{factory.name}}`, `{{factory.title}}`, `{{factory.description}}`, `{{factory.owner}}`, `{{factory.year}}`. Store dotfiles that npm would strip as `_gitignore` / `_dockerignore`. Add it to the smoke matrix in `.github/workflows/ci.yml`, then run `npm run smoke <id>` until it is green with a clean tree.

**Add a gate check.** Add a `check(...)` to the stage in `src/pipeline/gates.js`. Use severity `warn` for advice and `error` for anything that should block. Cover it in `test/gates.test.js` or `test/pipeline.test.js`.

**Add a stage.** Add an entry to `STAGES` in `src/pipeline/stages.js` (agent, tools, budget, prompt) and a matching function in `gates`. Add the subagent to `claude-kit/.claude/agents/`.

**Add a guard rule.** Edit `claude-kit/.claude/hooks/lib/patterns.mjs` and add positive and negative cases to `test/patterns.test.js`. The same rules apply to the hooks and to the review gate's secret scan.
