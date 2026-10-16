---
description: Write a testable spec for a feature into docs/specs/<date>-<slug>/SPEC.md
argument-hint: <feature idea, ticket text, or issue URL>
---

Use the **spec-writer** subagent to turn this request into a specification:

$ARGUMENTS

Save it to `docs/specs/<YYYYMMDD>-<kebab-slug>/SPEC.md` (today's date, slug from the title). If the request is an issue URL and `gh` is available, read the issue with `gh issue view` first.

When done, show me the Requirements and Acceptance Criteria and list any Open Questions I need to answer before planning.
