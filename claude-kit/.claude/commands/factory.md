---
description: Run the whole factory loop in this session — spec, plan, build, test, review, ship — until every gate passes
argument-hint: <feature request>
---

Run the full software-factory pipeline for this request:

$ARGUMENTS

Stages, each delegated to its subagent, each followed by its gate. Do not advance until the gate passes.

| Stage  | Subagent                         | Gate                                                                                   |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------- |
| spec   | spec-writer                      | SPEC.md has Problem, Requirements, Acceptance Criteria (`- [ ]` items), Out of Scope   |
| plan   | planner                          | PLAN.md has Tasks (`- [ ]` items), Test Strategy, Risks; every AC is covered by a task |
| build  | implementer                      | `lint` and `typecheck` from factory.json pass; the diff contains source changes        |
| test   | test-engineer                    | `test` from factory.json passes; every AC has a test in the evidence table             |
| review | code-reviewer + security-auditor | `Verdict: APPROVE` and no BLOCKER                                                      |
| ship   | release-manager                  | branch pushed and PR opened                                                            |

Loop rules:

- When a gate fails, give the subagent the exact failure output and run it again. Three failed attempts at one stage: stop and ask me.
- A review with REQUEST_CHANGES sends the findings back to **build**, then re-runs test and review. Two full review loops without approval: stop and ask me.
- After the spec stage, if the spec has Open Questions other than "None", stop and ask me before planning.
- Keep a running checklist of stages in your replies so I can see progress.
