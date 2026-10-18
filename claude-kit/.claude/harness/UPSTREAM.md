# Upstream provenance

The knowledge crew in this kit comes from **My Brain Is Full — Crew**:

- Source: https://github.com/taugustincst/My-Brain-Is-Full-Crew
- Imported at commit: `238ae8c` (feat(codex): use gpt-5.5 models (#41))
- Imported on: 2026-10-17
- License: MIT (© 2025 Christian Di Maio and contributors) — full text in `LICENSE` beside this file

What was taken, and how:

- `dist/claude-code/` build output (the source repo's own Claude Code adapter): 8 agents → `.claude/agents/`, 14 skills → `.claude/skills/`, references → `.claude/references/`.
- The agent registry was extended, not replaced: the pipeline crew's 7 rows were added to the upstream table.
- The dispatcher (`.claude/DISPATCHER.md`) is an adaptation of the upstream `DISPATCHER.md`: protocol preserved, routing tables rewritten for the merged harness.
- A verbatim snapshot of the upstream source layout (dispatcher, source-format agents and skills, references, orchestra scripts, hook sources, MCP server definitions, plugin manifest) is kept in `crew/` for reference and re-sync diffs. It is not installed anywhere else and is excluded from this repo's formatter.
