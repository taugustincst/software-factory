---
description: Prove every acceptance criterion with tests and add missing edge cases
argument-hint: [spec folder, defaults to the newest in docs/specs]
---

Find the spec folder: `$ARGUMENTS` if given, otherwise the most recent folder in `docs/specs/`.

Use the **test-engineer** subagent to map each acceptance criterion to a test, write what is missing, and run the full suite. Show me the AC → test evidence table it appends to `PLAN.md`.
