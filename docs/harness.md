# Harness: the factory's own tool layer

Status: Phase 1 implemented in `src/harness/`. Directed by Tj on 2026-11-06: "Ensure the factory has a powerful harness like yours accessible by models and agent and sub agents so it can do real work."

Until now, pipeline stages relied on Claude Code's built-in tools, with allow-lists limiting them. The harness gives the factory a tool layer it owns:

- every capability is a named tool with a schema;
- each role gets a scope, and the harness enforces it, not the prompt;
- every call runs inside the target repo and is written to an audit log.

## Tools (Phase 1)

| Tool          | Capability  | Input                               | Notes                                                                                                    |
| ------------- | ----------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `read_file`   | `read`      | `path`, `offset?`, `limit?` (lines) | Text only; 2 MB cap; returns numbered lines.                                                             |
| `list_files`  | `read`      | `path?`, `pattern?` (glob)          | Skips `.git/` and `node_modules/`; 2,000-entry cap.                                                      |
| `search`      | `read`      | `pattern` (regex), `path?`, `glob?` | JavaScript regex over text files; 200-match cap.                                                         |
| `write_file`  | `write`     | `path`, `content`                   | Creates parent folders; 1 MB cap.                                                                        |
| `edit_file`   | `write`     | `path`, `old`, `new`, `replaceAll?` | `old` must match exactly once unless `replaceAll`.                                                       |
| `run_command` | `exec`      | `name`                              | Runs a **named `factory.json` command** (e.g. `test`), never free text; names limited by `harness.exec`. |
| `git_status`  | `git-read`  | —                                   | Porcelain v1.                                                                                            |
| `git_diff`    | `git-read`  | `staged?`, `path?`, `base?`         | `base` must be a ref name (`[\w./-]+`), never an option.                                                 |
| `git_log`     | `git-read`  | `n?` (≤ 100)                        | One line per commit.                                                                                     |
| `git_commit`  | `git-write` | `message`, `paths[]`                | Stages only the listed paths; no `--amend`, no hooks bypass.                                             |

Tools are defined once in `src/harness/tools.js`. Each one has a `name`, a `description`, an `inputSchema` (JSON Schema), a `capability` and a handler. Input is validated against the schema before the handler runs, and anything outside the schema is refused.

## Role scopes

A scope is a set of capabilities, plus an optional `writeRoots` list that confines `write` to path prefixes. It is defined in `src/harness/scopes.js`.

| Role          | Capabilities                | `writeRoots`             | Used by                                               |
| ------------- | --------------------------- | ------------------------ | ----------------------------------------------------- |
| `decision`    | read, git-read              | —                        | decider, code-reviewer's judging, Inspector reasoning |
| `author`      | read, git-read, write       | the run's artifact dir   | spec and plan stages                                  |
| `reviewer`    | read, git-read, exec, write | the run's artifact dir   | review stage (writes REVIEW.md only)                  |
| `generative`  | read, git-read, write       | `.factory/improvements/` | improver drafting proposals                           |
| `implementer` | read, git-read, write, exec | repo root                | build and test stages                                 |
| `steward`     | read, git-read, write       | `.factory/improvements/` | Steward                                               |
| `inspector`   | read, git-read, exec        | —                        | Inspector (never writes)                              |
| `shipper`     | read, git-read, git-write   | —                        | reserved for the ship stage                           |

Writes to these paths are refused for every role:

- `.git/`;
- the run store (`.factory/runs/`);
- the audit log itself (`.factory/improvements/audit.jsonl`);
- anything `isProtectedPath` in `patterns.mjs` refuses: secrets, `.env*`, keys.

**Sub-agents** get `deriveScope(parent, requested)`, the intersection of the two. A child never gets a capability or write root its parent lacks. A requested write root is kept only if it lies inside one of the parent's roots. The `spawn_subagent` tool uses this in a later phase.

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

## Phase 2 (planned)

- **`spawn_subagent`** (`spawn` capability) runs a nested agent with a derived scope and a budget slice.
- **`open_pr`** for the `shipper` role, which would replace the ship stage's direct `gh` call.
- **Per-role native-tool removal:** once the harness tools are proven in real runs, stages can drop Claude Code's built-in write and shell tools, so only the harness can change files.
