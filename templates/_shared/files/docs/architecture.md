# Architecture — {{factory.title}}

Starter architecture doc, scaffolded by the software factory. Replace the TODO sections with the real layout as the project takes shape; keep it current — agents and new contributors plan from this file.

## Structure

_TODO — map the tree: entry points, the main modules and what each owns, where tests live, and where configuration comes from (environment variables, see `.env.example`)._

## Commands

The command contract is `factory.json` (`commands`: install, lint, typecheck, test, coverage, build, dev where applicable). CI, the Claude Code slash commands and the pipeline gates run the same commands.

## Design decisions

_TODO — record the decisions a newcomer cannot infer from the code, one short entry each: what was chosen, what was rejected, and why. Longer-lived decisions belong in specs under `docs/specs/`._

## Data and boundaries

_TODO — the data stores, the external services, and the trust boundaries between them. The security view of the same picture lives in `docs/threat-model.md`._
