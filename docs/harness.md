# Harness: the factory's own tool layer

Status: Phases 1 and 2 implemented in `src/harness/`. Directed by Tj on 2026-11-06: "Ensure the factory has a powerful harness like yours accessible by models and agent and sub agents so it can do real work."

Until now, pipeline stages relied on Claude Code's built-in tools, with allow-lists limiting them. The harness gives the factory a tool layer it owns:

- every capability is a named tool with a schema;
- each role gets a scope, and the harness enforces it, not the prompt;
- every call runs inside the target repo and is written to an audit log.

## Tools (Phase 1)

| Tool             | Capability  | Input                                                | Notes                                                                                                      |
| ---------------- | ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `read_file`      | `read`      | `path`, `offset?`, `limit?` (lines)                  | Text only; 2 MB cap; returns numbered lines.                                                               |
| `list_files`     | `read`      | `path?`, `pattern?` (glob)                           | Skips `.git/` and `node_modules/`; 2,000-entry cap.                                                        |
| `search`         | `read`      | `pattern` (regex), `path?`, `glob?`                  | JavaScript regex over text files; 200-match cap.                                                           |
| `write_file`     | `write`     | `path`, `content`                                    | Creates parent folders; 1 MB cap.                                                                          |
| `edit_file`      | `write`     | `path`, `old`, `new`, `replaceAll?`                  | `old` must match exactly once unless `replaceAll`.                                                         |
| `run_command`    | `exec`      | `name`                                               | Runs a **named `factory.json` command** (e.g. `test`), never free text; names limited by `harness.exec`.   |
| `git_status`     | `git-read`  | —                                                    | Porcelain v1.                                                                                              |
| `git_diff`       | `git-read`  | `staged?`, `path?`, `base?`                          | `base` must be a ref name (`[\w./-]+`), never an option.                                                   |
| `git_log`        | `git-read`  | `n?` (≤ 100)                                         | One line per commit.                                                                                       |
| `git_commit`     | `git-write` | `message`, `paths[]`                                 | Stages only the listed paths; no `--amend`, no hooks bypass.                                               |
| `git_push`       | `pr`        | `branch`                                             | Pushes a `factory/…` branch to `origin` with upstream. Any other branch, a force push or a tag is refused. |
| `open_pr`        | `pr`        | `title`, `body`, `head`, `base?`, `draft?`           | `gh pr create` from a `factory/…` head. The body travels by file, never argv. Returns the PR URL.          |
| `spawn_subagent` | `spawn`     | `task`, `capabilities?`, `writeRoots?`, `budgetUsd?` | Runs a harness-only sub-agent with a derived scope and a budget slice. Returns its summary.                |

Tools are defined once in `src/harness/tools.js`. Each one has a `name`, a `description`, an `inputSchema` (JSON Schema), a `capability` and a handler. Input is validated against the schema before the handler runs, and anything outside the schema is refused.

## Role scopes

A scope is a set of capabilities, plus an optional `writeRoots` list that confines `write` to path prefixes. It is defined in `src/harness/scopes.js`.

| Role          | Capabilities                       | `writeRoots`             | Used by                                               |
| ------------- | ---------------------------------- | ------------------------ | ----------------------------------------------------- |
| `decision`    | read, git-read                     | —                        | decider, code-reviewer's judging, Inspector reasoning |
| `author`      | read, git-read, write, spawn       | the run's artifact dir   | spec and plan stages                                  |
| `reviewer`    | read, git-read, exec, write, spawn | the run's artifact dir   | review stage (writes REVIEW.md only)                  |
| `generative`  | read, git-read, write              | `.factory/improvements/` | improver drafting proposals                           |
| `implementer` | read, git-read, write, exec, spawn | repo root                | build and test stages                                 |
| `steward`     | read, git-read, write              | `.factory/improvements/` | Steward                                               |
| `inspector`   | read, git-read, exec               | —                        | Inspector (never writes)                              |
| `shipper`     | read, git-read, git-write, pr      | —                        | ship stage: push and open the PR                      |

Writes to these paths are refused for every role:

- `.git/`;
- the run store (`.factory/runs/`);
- the audit log itself (`.factory/improvements/audit.jsonl`);
- anything `isProtectedPath` in `patterns.mjs` refuses: secrets, `.env*`, keys.

**Sub-agents** get `deriveScope(parent, requested)`, the intersection of the two. A child never gets a capability or write root its parent lacks. A requested write root is kept only if it lies inside one of the parent's roots. `spawn_subagent` uses it for every sub-agent.

## Sandbox

`resolveInside(root, p)` in `src/harness/sandbox.js` refuses:

- absolute paths;
- NUL bytes;
- any `..` that leaves the root;
- a path whose nearest existing ancestor resolves, after following symlinks, outside the real root (symlink escape);
- writing to an existing symlink.

Commands run with `cwd` set to the root. `run_command` takes no free text. Git tools build argv arrays, never shell strings, and refuse refs that start with `-`.

## Audit

Every call, allowed or refused, appends one JSON line to the audit file:

```json
{
  "at": "2026-11-06T…",
  "role": "implementer",
  "tool": "write_file",
  "ok": true,
  "ms": 3,
  "input": { "path": "src/x.js", "content": "<412 bytes sha1:…>" },
  "error": null
}
```

- Large or content fields are replaced with their length and hash.
- Strings pass through `redact()` from `patterns.mjs`, so secrets never reach the log.
- Pipeline runs log to `.factory/runs/<id>/harness.jsonl`; the improvement loop logs to `.factory/improvements/harness.jsonl`.
- The runner counts each attempt's calls and refusals into the run record (`attempt.harness = { calls, refused }`). The evidence layer reads those counts, so scope violations become facts.

## Transport: MCP

`src/harness/mcp-server.js` is a zero-dependency MCP server that speaks newline-delimited JSON-RPC 2.0 over stdio. It implements:

- `initialize`;
- `tools/list`, which returns only the tools the role's scope allows;
- `tools/call`;
- `ping`.

For every stage, the Claude executor does three things:

- writes the server config (root, role, write roots, commands, audit file) to `.factory/harness/<stage>.json`;
- writes an MCP config naming `factory` as that server;
- passes `--mcp-config`, and adds `mcp__factory__<tool>` to `--allowedTools` for exactly the scoped tools.

The config travels by file, never by argv. Claude Code's built-in tools stay allowed per stage as before. The harness adds a second, enforced path; it does not remove the first. The new improvement-loop and Inspector stages use the harness tools only.

## Mock parity

The mock executor writes its artifacts through `ctx.harness`, the same harness, scoped to the stage's role. Offline CI therefore exercises the registry, scopes, sandbox and audit log on every mock run. Tests call the harness directly for the refusal paths.

## Phase 2

- **Sub-agents.** `spawn_subagent` runs a `factory-subagent` on the same executor as its parent:
  - a Claude Code stage spawns a separate harness-only `claude -p` from its MCP server;
  - mock and API-provider stages spawn in process.

  Its scope comes from `deriveScope` (an intersection, never wider), and `spawn` is dropped at the deepest level, so nesting stops at 2. Its budget is a slice of the stage's sub-agent budget (the stage budget): by default half of what remains, and a grandchild gets at most half of its parent's slice. Sub-agent spend is written to the audit log and added to the attempt's and the run's cost (`attempt.harness.subagentUsd`).

- **Shipping through the harness.** The ship stage now pushes and opens its PR with `git_push` and `open_pr` under the `shipper` role. Both are audited, and only `factory/…` branches are allowed, so no agent can push `main`.
- **Harness-only stages.** In `factory.json`, `harness.only` set to `true` (every agent stage) or a list such as `["spec", "plan", "review"]` drops Claude Code's built-in tools for those stages, leaving the scoped harness tools as the only way to read or change anything. It defaults to off, so existing runs behave the same. Turn it on stage by stage as runs prove out. The improvement-loop, Inspector and sub-agent stages are always harness-only.
