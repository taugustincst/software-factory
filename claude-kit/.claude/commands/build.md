---
description: Implement the current PLAN.md test-first, keeping lint and tests green
argument-hint: [spec folder, defaults to the newest in docs/specs]
---

Find the spec folder: `$ARGUMENTS` if given, otherwise the most recent folder in `docs/specs/`.

Use the **implementer** subagent to execute every unchecked task in its `PLAN.md`, in order. After the subagent finishes, run the `lint`, `typecheck` (if defined) and `test` commands from `factory.json` yourself and report the results. If anything fails, send the output back to the implementer and repeat until green or until three attempts fail, then stop and show me the failure.
