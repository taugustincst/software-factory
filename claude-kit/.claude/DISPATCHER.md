# Dispatcher — how the agent harness routes work

This project runs on the **software-factory agent harness**: two crews under one dispatcher protocol, adapted from [My Brain Is Full — Crew](https://github.com/taugustincst/My-Brain-Is-Full-Crew) (vendored under `.claude/harness/`; the upstream protocol text lives at `.claude/harness/crew/DISPATCHER.md`).

- The **pipeline crew** builds software: `spec-writer → planner → implementer → test-engineer → code-reviewer` (with `security-auditor` alongside review) `→ release-manager`.
- The **knowledge crew** manages project knowledge — notes, docs, inbox, email and calendar intelligence: `architect`, `scribe`, `sorter`, `seeker`, `connector`, `librarian`, `transcriber`, `postman`.

The single source of truth for who exists and what they take and return is `.claude/references/agents-registry.md`. Custom agents created with the `/create-agent` skill are registered there and are valid routing targets.

## Routing rules

**Skills first, agents second.** Check the skill tables before the agent tables.

- **Skills** handle complex, multi-step, or conversational flows. Invoke them via the **Skill tool**; they run in the main conversation context.
- **Agents** handle reactive, single-shot operations. Invoke them via the **Agent tool**; they run as subprocesses.
- Pass the user's message as-is in the Skill/Agent prompt.
- When a request matches a skill or agent, delegate — do not do the routed work inline. When nothing matches, handle the request directly (ordinary coding help needs no agent).

### Pipeline routing (software work)

| Intent                            | Route                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| New feature or change, end to end | `/factory` command, or `factory run` — the gated pipeline executes every stage           |
| Write or refine a spec            | `/spec` command → `spec-writer` agent                                                    |
| Plan an approved spec             | `/plan` command → `planner` agent                                                        |
| Implement an approved plan        | `/build` command → `implementer` agent                                                   |
| Write or fix tests                | `/test` command → `test-engineer` agent                                                  |
| Review a change                   | `/review` command → `code-reviewer` agent, with `security-auditor` for the security pass |
| Audit for vulnerabilities         | `/audit` command → `security-auditor` agent                                              |
| Ship an approved change           | `/ship` command → `release-manager` agent                                                |

The five factory skills support these flows and load on demand: `tdd`, `definition-of-done`, `conventional-commits`, `secure-coding`, `synthetic-data`.

### Knowledge routing (crew skills first)

| Skill                                                   | Use it for                                            |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `/onboarding`                                           | First-time setup of the knowledge vault/workspace     |
| `/create-agent`, `/manage-agent`                        | Create, edit, remove or list custom agents            |
| `/inbox-triage`                                         | Classify and file everything in the inbox             |
| `/email-triage`                                         | Scan, score and file unread email                     |
| `/meeting-prep`                                         | A complete brief before a meeting                     |
| `/weekly-agenda`, `/deadline-radar`                     | The week ahead; every deadline in one timeline        |
| `/transcribe`                                           | Turn recordings and transcripts into structured notes |
| `/vault-audit`, `/deep-clean`, `/defrag`, `/tag-garden` | Knowledge-base health, cleanup and structure          |
| `/contact-sync`                                         | Sync a person to contacts (requires the contacts MCP) |

Full trigger lists (including multilingual triggers) are in the vendored upstream dispatcher. If no crew skill matches, route to a crew agent by the registry's Input column: capture → `scribe`, filing → `sorter`, search → `seeker`, structure → `architect`, links → `connector`, health → `librarian`, transcripts → `transcriber`, email/calendar → `postman`.

The knowledge crew resolves note locations through `Meta/vault-map.md` when the project keeps a vault; each agent falls back to its default paths when there is none.

## Chaining — multi-agent routing

Agents do **not** communicate directly. The dispatcher orchestrates every call. When an agent detects work for another agent, it reports it in its output in a `### Suggested next agent` section; the dispatcher reads the output and decides whether to chain.

After an agent returns:

1. Did it produce work another agent owns (per the registry's Input/Output columns)?
2. Did it include a `### Suggested next agent` section? Validate the suggestion against the registry.
3. Did it include a `### Suggested new agent` section? Ask the user whether the `architect` should create a custom agent for the need.

### Call chain tracking

Maintain a call chain for each user request:

1. Start with an empty chain: `[]`
2. After each agent returns, append its name to the chain
3. When invoking the next agent, pass the chain and position, e.g. `"Call chain so far: [scribe, architect]. You are step 3 of max 3."`
4. After it returns, read its output and decide whether another agent is needed

### Anti-recursion rules

- **No duplicates**: never invoke the same agent twice in one user request
- **No circular chains**: if A suggests B and B is already in the chain, skip it
- **Max depth 3**: no more than 3 agents per user request
- **On overflow**: return results to the user and suggest the follow-up (e.g. _"The connector also found 5 orphan notes — say 'connect the notes' to handle that."_)

### Decision flow

```
USER MESSAGE → check SKILL routing first
           ↓
  Skill match? → INVOKE skill → read output → maybe chain (rules above) → RESPOND
           ↓ (no skill match)
  Check AGENT routing / registry → INVOKE agent
           ↓
     READ OUTPUT → suggestion valid + not in chain + depth < 3 → INVOKE next
                 → otherwise RESPOND to the user
```

## The pipeline and the dispatcher

`factory run` executes the pipeline deterministically — fixed stage order, quality gates, retries and the review rewind are the runner's job, not the dispatcher's. The stage agents still follow this protocol in their outputs: each ends with a `### Suggested next agent` handoff naming the next stage, which the runner's log makes visible and an interactive session can follow when running stages by hand (`/spec`, `/plan`, …). A rejected review suggests `implementer` — the same rewind the runner performs automatically.

## Guardrails

The guard hooks in `.claude/hooks/` and the standards in `.claude/FACTORY.md` bind every agent in both crews. A hook block is a stop sign, not an obstacle to route around. Routing never widens an agent's tool allow-list: an agent only gets the tools in its frontmatter.
