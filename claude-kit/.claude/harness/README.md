# The agent harness

This project's agent layer is the **software-factory harness**: the factory's pipeline crew and the knowledge crew from **My Brain Is Full — Crew**, merged under one dispatcher protocol.

| Piece                                                 | Where                                                  |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Dispatcher protocol (routing, chaining, chain limits) | `.claude/DISPATCHER.md`                                |
| Agent registry (both crews, single source of truth)   | `.claude/references/agents-registry.md`                |
| Agents (7 pipeline + 8 knowledge crew)                | `.claude/agents/`                                      |
| Skills (5 factory + 14 knowledge crew)                | `.claude/skills/`                                      |
| Guard hooks (the enforced safety layer)               | `.claude/hooks/`                                       |
| Vendored upstream snapshot + provenance               | `.claude/harness/crew/`, `.claude/harness/UPSTREAM.md` |

## How the merge works

- The knowledge crew's agents and skills were produced by the upstream repo's own Claude Code adapter (`scripts/build.sh --platform claude-code` in the source repo) — capabilities expanded to tool allow-lists, model tiers mapped (low → haiku, mid → sonnet, high → opus) — and installed here unchanged.
- The dispatcher was adapted: the protocol (skills first, delegate, `### Suggested next agent` chaining, call-chain tracking, max depth 3, no duplicates or circular chains) is upstream's; the routing tables cover both crews.
- The registry is upstream's table plus the pipeline crew's rows.
- The factory's guard hooks remain the only hooks wired in `.claude/settings.json`. The crew's hook sources are vendored under `crew/hooks/` for reference; upstream's notify/validate hooks are not enabled by default because the factory guards already cover file protection, and hook stacking changes pipeline behavior.

## Re-syncing from upstream

1. Clone `taugustincst/My-Brain-Is-Full-Crew` and note the new head commit.
2. Run `bash scripts/build.sh --platform claude-code` there (needs `jq`).
3. Copy `dist/claude-code/.claude/agents/*.md`, `dist/claude-code/.claude/skills/*` and the non-registry references over this kit's copies; re-apply the pipeline rows to `agents-registry.md`.
4. Refresh the `crew/` snapshot from the source tree and update `UPSTREAM.md` with the new commit.
5. Run the factory's `npm test` and `npm run smoke` — the harness tests check that every agent parses, the registry lists every agent, and the stage handoffs resolve.
