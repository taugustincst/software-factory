# Self-improvement: the factory that learns from its own runs

Status: design, with Phase 1 implemented across stacked PRs (see [Phasing](#phasing)). PR A (harness) and PR B (the improvement loop) are implemented. The Inspector (PR C) and multi-provider models (PR D, added by Tj on 2026-11-06: "make it so that the factory can grab other llms as needed") follow.
Directed by Tj on 2026-11-06 ("I want the factory to be self improving"). That directive came with six amendments:

1. Build an LLM into the loop.
2. Split it into a decision model and a generative model.
3. Make human approval opt-in or opt-out, and give the factory a real tool harness.
4. Put a model in charge of improvement and efficiency.
5. Put a model in charge of release quality.
6. Embed all of these in the factory.

## Principles

1. **Evidence owns the numbers.** A deterministic layer reads the run store and produces every fact: counts, costs, durations, gate failures and review verdicts. No model produces a number.
2. **Models reason over evidence; they never invent it.** Every claim in a proposal cites a fact ID from the evidence pack. A citation gate (code, not a prompt) rejects any proposal whose citations do not resolve, or whose cited numbers do not match.
3. **Proposals, never silent self-modification.** No code path edits the kit, templates or gates without an approval record. An approved proposal becomes an ordinary factory run, so it goes through the same gates, review, Inspector and commit as any other change.
4. **Risk is computed, not claimed.** A proposal's risk class comes from the files it targets and its kind, through a fixed table. A model cannot lower it.
5. **Quality outranks efficiency.** The Inspector can hold a release. The Steward cannot override a hold in any mode.
6. **Embedded, not bolted on.** The roles ship inside the factory: agent definitions in the kit, stages in the pipeline, configuration in `factory.json`. The provider stays configurable: the roles run through the executor abstraction, Claude in production and the mock in tests.

## The pieces

```
                 .factory/runs/<id>/run.json  +  harness.jsonl (tool-call audit)
                                │
                     ┌──────────▼───────────┐
                     │  Evidence layer      │  deterministic: facts with IDs
                     │  src/improve/        │  per run + cross-run patterns
                     │  evidence.js         │
                     └──────────┬───────────┘
                                │ evidence pack (JSON)
                ┌───────────────▼────────────────┐
                │ Generative model (improver)    │  drafts lessons + proposals,
                │ kit agent: factory-improver    │  each claim cites a fact ID
                └───────────────┬────────────────┘
                                │ draft proposals
                     ┌──────────▼───────────┐
                     │ Citation gate (code) │  rejects uncited or mismatched claims
                     └──────────┬───────────┘
                ┌───────────────▼────────────────┐
                │ Decision model (decider)       │  scores, dedupes, ranks;
                │ kit agent: factory-decider     │  approve / reject / needs-evidence
                └───────────────┬────────────────┘
                     ┌──────────▼───────────┐
                     │ Approval regime      │  required (default): Tj approves
                     │ src/improve/approval │  auto: decider may approve ≤ ceiling
                     └──────────┬───────────┘
                                │ approved
                     ┌──────────▼───────────┐
                     │ factory run          │  normal gated pipeline → commit/PR
                     └──────────────────────┘

  Steward (factory-steward): owns the whole loop — backlog, efficiency, cadence, digest.
  Inspector (factory-inspector): owns release quality — an `inspect` stage before ship.
  Harness (src/harness): the tool layer every role works through. See docs/harness.md.
```

### Evidence layer (`src/improve/evidence.js`)

The evidence layer builds a **fact** for each observation, with a stable ID, a value, and the runs it came from:

| Fact ID pattern                     | Value                                                |
| ----------------------------------- | ---------------------------------------------------- |
| `run:<id>:status`                   | passed / failed / cancelled / paused                 |
| `gate-fail:<stage>:<check>`         | number of runs where that check failed at least once |
| `retries:<stage>`                   | extra attempts beyond the first, summed across runs  |
| `retry-cost:<stage>`                | USD spent on those extra attempts                    |
| `review-loops`                      | review rewinds, summed                               |
| `review-finding:<normalized line>`  | runs whose REVIEW.md contained this finding line     |
| `cost:<stage>` / `duration:<stage>` | total USD / seconds per stage                        |
| `cost-per-passed-run`               | total USD ÷ passed runs, with a per-window trend     |
| `harness-refused:<role>:<tool>`     | tool calls the harness refused (scope violations)    |
| `inspector-hold:<check>`            | runs the Inspector held on that check                |
| `post-release-fail:<run>`           | main-branch CI failure attributed to a shipped run   |

Facts above `recurrenceMin` (default 3) are **patterns**, and patterns outrank one-off facts. The evidence pack is the only input the models get about the past.

### Retrospective, after every run

When a run finishes (passed, failed or cancelled), the runner calls the Steward's light pass:

- `improvement.afterRun: "evidence"` (default): deterministic only. It folds this run's facts into the backlog, re-scores open proposals, and spends nothing.
- `"analyze"`: also runs the improver and decider on this run (agent spend, capped by `improvement.maxUsdPerPass`).
- `"off"`: does nothing.

The pass is best-effort. Its failure is logged and never changes the run's status.

### Generative model: the improver

Kit agent `factory-improver`, on `models.generative`. Input: the evidence pack plus the run's logs and review comments, all read through the harness. Output: `proposals.json`, where each proposal has:

```json
{
  "title": "Tell the implementer to run lint before finishing",
  "kind": "kit-prompt | gate | template | efficiency | docs",
  "targets": ["claude-kit/.claude/agents/implementer.md"],
  "lesson": "Why this keeps happening, in plain words.",
  "change": "What to change, specific enough to become a factory run request.",
  "claims": [{ "text": "lint failed in the build gate on 4 of 6 runs", "fact": "gate-fail:build:lint", "value": 4 }],
  "expectedSavings": { "fact": "retry-cost:build", "usd": 1.8 }
}
```

### Citation gate (`src/improve/validate.js`)

It rejects a proposal when:

- it has no claims;
- a claim cites a fact that is not in the pack;
- a claim's `value` differs from the fact's value;
- a target path escapes the repo;
- an efficiency proposal has no `expectedSavings` tied to a measured cost or duration fact.

Rejections are recorded with their reasons, and each one is evidence in its own right (`improver-rejected`).

### Decision model: the decider

Kit agent `factory-decider`, on `models.decision`. It reads only (harness scope `decision`). For each validated proposal, it returns a verdict (`approve`, `reject` or `needs-evidence`), a 0–100 score, the duplicates it found, and its reasoning. It ranks by expected value against risk.

A deterministic tie-break score is also kept (recurrence × cost × recency), so ranking still works offline and the decider's ordering can be checked against it.

The decider **advises**. Whether its `approve` applies anything is the approval regime's call.

### Approval regime (`src/improve/approval.js`)

Configured in `factory.json`:

```json
"improvement": { "approval": { "mode": "required", "autoMaxRisk": "low" } }
```

- `required` (default, opt-in to automation): every proposal waits for Tj in the dashboard.
- `auto` (opt-out): a proposal self-applies when all of these hold:
  - the decider says `approve`;
  - the citation gate passed;
  - its computed risk is at or below `autoMaxRisk`.

**Computed risk** comes from fixed tables. The class is the highest of the class for the proposal's kind and the class for each target:

| Class          | Targets / kinds                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `low`          | `docs/**`, `*.md` outside security docs, kit agent/command/skill wording (`claude-kit/.claude/{agents,commands,skills}/**/*.md`); kinds `docs`, `kit-prompt`                                                                                                                                                         |
| `medium`       | `templates/**`, other source; kinds `template`, `efficiency`; anything unknown                                                                                                                                                                                                                                       |
| `always-human` | gates (`src/pipeline/gates.js`), guard rules and hooks (`claude-kit/.claude/hooks/**`), harness scopes (`src/harness/**`), approval and Inspector config (`src/improve/approval.js`, `src/inspect/**`), workflows (`.github/**`), release config, `SECURITY.md`, `docs/threat-model.md`, `factory.json`; kind `gate` |

`always-human` is unreachable by `auto` at any ceiling.

Every decision, human or automatic, appends an audit record to `.factory/improvements/audit.jsonl`. Each record holds the proposal, the decider's reasoning, the evidence and the outcome. The dashboard header always shows which mode is live, and switching modes is a single config edit.

**Applying** an approved proposal starts an ordinary `factory run`. Its request is built from the proposal's change, targets and cited evidence. The run goes through spec → … → review → inspect → ship and lands as its own commit on its own `factory/…` branch, plus a PR when `--ship` is on. Reverting is one command, `factory improve revert <id>`, which runs `git revert` on that commit. The dashboard flags auto-applied proposals with a revert button.

### The Steward (kit agent `factory-steward`)

The Steward owns the loop:

- **Backlog:** it collects proposals, dedupes them by fingerprint (kind + sorted targets + cited facts), ranks them and sequences them. It retires stale ones and records why, for example when the evidence has not recurred in `staleAfterRuns` runs. Every proposal always has a state:
  `open → recommended → approved → applied` (or `rejected`, `needs-evidence`, `retired`, `reverted`).
- **Efficiency:** it tracks cost and time per stage across runs: spend per run, retry waste, review loops, gate durations, model spend by stage, and cost per shipped run. From these it proposes efficiency changes with measured expected savings, for example:
  - routing cheap stages to a cheaper model;
  - reordering or parallelizing stages;
  - slimming templates;
  - tuning budget caps.
    These proposals cite before and after facts like any other proposal.
- **Cadence:** a light pass after each run (above), plus `factory steward` for a cross-run review. The review writes the improvement and efficiency digest (`.factory/improvements/digest.json`), which the dashboard shows. It covers what was applied, what is queued, what is being watched, and the cost-per-shipped-run trend.
- **Models:** the Steward decides on the decision model and drafts on the generative model.
- **Bounds:** harness scope `steward`. It can read everything in the run store, and can write only under `.factory/improvements/`. It applies only through the approval regime. Its actions are audit-logged, and its efficiency claims pass the same citation gate, so it cannot grade its own homework without numbers.

### The Inspector (kit agent `factory-inspector`, stage `inspect`)

The Inspector owns release quality. `inspect` is a pipeline stage between review and ship. It verifies the candidate independently instead of trusting earlier summaries. Through the harness (scope `inspector`: read and exec, never write) it re-checks:

- that every earlier gate actually ran and passed (from the run record);
- `lint`, `typecheck` and `test`, by running them again;
- the coverage delta against the base, when `commands.coverage` exists;
- the diff for risky changes: secrets (the shared `patterns.mjs` scan), migrations, auth code, destructive operations, workflow and permission changes;
- version and changelog consistency;
- template conformance: `factory.json` is valid and the commands still exist.

**Rubric:** `factory.json` → `inspector.rubric` maps each check to `hold`, `note` or `off`. The verdict is `ship`, `ship-with-notes` or `hold`, and every finding cites its check, file and number.

**Hold:** a held run does not ship.

- In `required` mode, only Tj can ship past a hold: `factory ship --run-id <id> --override-hold "<reason>"`.
- In `auto` mode the Steward cannot override a hold at all.

Holds and overrides are audit-logged.

**Post-release watch:** `factory inspect --post-release` checks the main branch's latest CI result after a ship (via `gh api`) and attributes any failure to the release. That becomes a `post-release-fail` fact. Inspector finds it, Steward fixes the system that allowed it.

The Inspector never writes code. A defect it finds goes back as a finding: to the pipeline (a held run) or to the Steward (evidence).

### Harness

The tool layer that every role and sub-agent uses: named, schema'd tools; scopes per role; a sandbox; an audit log. It is exposed to Claude Code as an MCP server. Full design: [harness.md](harness.md).

## Embedding (amendment 6)

- **Agent definitions:** the four roles ship in `claude-kit/.claude/agents/`: `factory-improver.md`, `factory-decider.md`, `factory-steward.md` and `factory-inspector.md`. `factory new` and `factory install-claude` install them, and `factory upgrade` merges updates three-way, the same as every other kit file.
- **Stages** live in the pipeline (`inspect`) and in `src/improve/`.
- **Configuration** lives in `factory.json`, under `models`, `improvement`, `inspector` and `harness`, validated by `schema/factory.schema.json`. `factory new` writes the defaults explicitly, so the settings are visible.
- **Version pin:** `.claude/factory-roles.json` records the factory version and a content hash of each role definition that installed them. `factory upgrade` refreshes it, so a project's embedded roles move only when the project upgrades. The dashboard shows the roles as part of the factory: Steward digest, Inspector verdicts, approval mode.
- **Embedded is not vendor-hardcoded.** The roles call the executor. `models.*` choose the model, and the mock executor supplies canned generation and canned verdicts, so CI stays offline.

## Configuration reference

```json
{
  "models": { "generative": null, "decision": null },
  "improvement": {
    "afterRun": "evidence",
    "recurrenceMin": 3,
    "maxProposalsPerRun": 3,
    "staleAfterRuns": 10,
    "maxUsdPerPass": 2,
    "approval": { "mode": "required", "autoMaxRisk": "low" }
  },
  "inspector": {
    "rubric": {
      "gates-passed": "hold",
      "lint": "hold",
      "typecheck": "hold",
      "test": "hold",
      "coverage-delta": "note",
      "secrets": "hold",
      "risky-diff": "note",
      "version-changelog": "note",
      "template-conformance": "hold"
    },
    "coverageDropMax": 1
  },
  "harness": { "exec": ["lint", "typecheck", "test", "build", "coverage"] }
}
```

A `null` model means the executor's default, which is also `--model`. CLI flags `--improver-model` and `--decider-model` override the config.

## Where the same two roles map elsewhere (future work)

The generative/decision split generalizes:

- spec-writer, planner and implementer are generative;
- code-reviewer, the gates and the Inspector are decision.

Routing every build stage to `models.generative` and every judging stage to `models.decision` is a natural next step. This work keeps that scope to the improvement loop and the Inspector.

## Phasing

| PR  | Contents                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | This design, `docs/harness.md`, and harness Phase 1: registry, core tools, role scopes, sandbox, audit, MCP server, and wiring into every pipeline stage plus the mock executor.                              |
| B   | The improvement loop: evidence layer, proposals store, improver/decider stages, citation gate, approval regime, Steward pass and `factory steward`/`factory improve`, dashboard, embedding and config schema. |
| C   | The Inspector: the `inspect` stage, rubric, hold and override, and post-release watch.                                                                                                                        |

Kept for a later phase:

- the harness `spawn_subagent` tool on the Claude executor (the scope-derivation code ships in Phase 1, with tests);
- routing build and review stages by model role.
