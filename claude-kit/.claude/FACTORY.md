# Engineering standards (software-factory)

These standards apply to every change in this repository, whether made by a person, Claude, or the factory pipeline.

## Workflow

- Every feature starts as a spec in `docs/specs/<date>-<slug>/SPEC.md`, then a `PLAN.md`, then code. Use `/spec`, `/plan`, `/build`, `/test`, `/review`, `/ship`, or `/factory` to run all of them.
- Work on a branch (`feat/…`, `fix/…`). Never commit or push to `main`. Never force-push shared branches.
- Commits and PR titles follow Conventional Commits (see the `conventional-commits` skill).
- A change is done only when it meets the `definition-of-done` skill.

## Commands

`factory.json` lists the canonical `install`, `lint`, `typecheck`, `test` and `build` commands. CI runs exactly these. Run them before saying something works.

## Code

- Test first (`tdd` skill). Never weaken or delete a test to make it pass.
- Validate input at boundaries; follow the `secure-coding` skill.
- Configuration via environment variables, documented in `.env.example`. No secrets in the repo, ever.
- Test and demo data is synthetic (`synthetic-data` skill). No real patient or personal data anywhere.
- Prefer the existing patterns in this codebase over new abstractions or dependencies.

## Agent harness

This project runs on the factory's agent harness (see `.claude/DISPATCHER.md`): two crews under one dispatcher — the pipeline crew (spec-writer, planner, implementer, test-engineer, code-reviewer, security-auditor, release-manager) and the knowledge crew from My Brain Is Full — Crew (architect, scribe, sorter, seeker, connector, librarian, transcriber, postman). Route work skills-first, then agents, per the dispatcher; chain with `### Suggested next agent` handoffs, at most 3 agents per request, never the same agent twice. The registry of who does what is `.claude/references/agents-registry.md`.

## Guardrails

Hooks in `.claude/hooks/` block destructive shell commands, writes to secret files, and content that looks like credentials or real SSNs. If a hook blocks you, change the approach; do not try to get around it.
