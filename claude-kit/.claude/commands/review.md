---
description: Independent code review of the current change, with a verdict, into REVIEW.md
argument-hint: [spec folder, defaults to the newest in docs/specs]
---

Find the spec folder: `$ARGUMENTS` if given, otherwise the most recent folder in `docs/specs/`.

Run two reviews in parallel:

1. The **code-reviewer** subagent writes `REVIEW.md` next to the spec.
2. The **security-auditor** subagent audits the same diff.

Merge any security finding rated HIGH or CRITICAL into REVIEW.md as a BLOCKER (and set the verdict to REQUEST_CHANGES). Show me the verdict and the BLOCKER and MAJOR findings.
