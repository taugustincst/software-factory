# Spec: Autonomy Maturity Model — readiness scoring, outcome metrics, and the Level 4 gate

Status: implemented (2026-10-28). Source model: Factory.ai's white paper
_The Software Factory Autonomy Maturity Model_, adopted at the repo owner's
direction. Normative implementation doc: `docs/autonomy-maturity.md`.

## Problem

The factory enforced strict quality gates on the projects it generates, but
had no way to measure any repository — including itself — against a maturity
model. Concretely, before this change:

- There was no readiness score: no binary-signal assessment across the
  model's Eight Pillars, no maturity level, and no Organizational Readiness
  figure (the share of repos at Level 3+, the model's headline metric).
- The pipeline already recorded cost, duration, attempts and review loops
  for every run in `.factory/runs/<id>/run.json`, but nothing aggregated
  those records into the model's lagging outcome metrics (cycle time,
  autonomy ratio, cost per change).
- Measured by hand against the model, this repo sat at Level 2 (31 points):
  it had no `AGENTS.md`, no threat model, no pre-commit hooks and no secret
  scanning workflow, even though its own templates were expected to ship
  most of those. The tool did not practise what it scaffolded.
- Even after the scoring and floor-raising work landed (47 points,
  Level 3), the repo had no coverage gate on its own suite, no dependency
  audit in CI, no CI failure diagnostics, and no spec documents — the four
  cheapest honest gaps between Level 3 and Level 4.

## Requirements

- R1: A readiness engine under `src/readiness/` that scores a repository
  with binary signals only (present or absent, no partial credit, no
  builds, test runs or network calls; one tree walk per repo).
- R2: Signals organised by the Eight Pillars (1 Style & Validation,
  2 Build System, 3 Testing, 4 Documentation & Instructions, 5 Dev
  Environment & Remote Execution, 6 Code Quality, 7 Debugging &
  Observability, 8 Security & Governance) and by maturity level, with
  points per level L1 = 1, L2 = 2, L3 = 4, L4 = 8, L5 = 16.
- R3: A repo's level is derived from its cumulative score against the
  thresholds L1 ≥ 5, L2 ≥ 19, L3 ≥ 36, L4 ≥ 60, L5 ≥ 100. Level 3 is the
  agent-ready bar. Scoring several repos also reports Organizational
  Readiness = repos at Level 3+ ÷ repos scored.
- R4: Signal probes anchor to a repo's own installed/working paths.
  Content shipped for other repos (this repo's `templates/` and
  `claude-kit/` trees) does not count toward the repo's own score, and the
  scorer never matches its own probe patterns in `src/readiness/`.
- R5: `factory readiness [dir ...] [--json] [--fail-below <0-5>]` prints
  per-repo score, level, agent-ready status, per-pillar scores and a
  prioritised remediation list (failed signals by level, then points),
  and exits 1 when `--fail-below` is given and any repo is under it.
- R6: `factory outcomes [--dir <dir>] [--json]` aggregates pipeline run
  records into cycle time (mean and median), autonomy ratio (passed runs
  whose every stage passed first-try with zero review loops, over
  completed runs), total cost, cost per change and total review loops.
  Metrics a run record does not contain (incident MTTR, change shelf-life)
  are reported as null with a note, never estimated.
- R7: The factory repo's own floor is raised with real artifacts, not
  scorer changes: root `AGENTS.md`, `CONTRIBUTING.md`, `.env.example`,
  a `.githooks/pre-commit` hook, a gitleaks secret-scanning workflow, and
  a STRIDE threat model at `docs/threat-model.md`.
- R8: Every scaffolded project starts at Level 3+ (the model's Scale
  step): the `_shared` scaffold gains `AGENTS.md`, `docs/threat-model.md`,
  a `docs/architecture.md` starter and `.githooks/pre-commit`, delivered
  intact by the scaffolder (executable bit preserved on the hook).
- R9: A coverage gate for this repo's own suite, using Node's built-in
  test coverage with zero new dependencies. Scope is the factory's own
  source (`src/`, plus `bin/` whose entry shim runs in child processes and
  contributes no in-process rows); template and kit trees are excluded —
  they are verified by `npm run smoke`, not this gate. Thresholds are set
  a few points below measured coverage (measured 2026-10-28 on Node
  24.22.1: 92.41% lines, 79.34% branches, 90.78% functions; thresholds:
  89 / 76 / 87) and enforced by `scripts/coverage.js`, declared as the
  `coverage` command in `factory.json` and the `test:coverage` npm
  script, and run in CI. The enforcer fails closed (no summary, no pass)
  and behaves identically on Node 22 and 24, unlike the runner's native
  `--test-coverage-*` threshold flags, which landed later than the
  coverage reporter.
- R10: A dependency audit in CI that gates the surface consumers actually
  install: `npm audit --omit=dev --audit-level=high`. The factory ships
  zero runtime dependencies, so the production tree is the consumer
  surface (verified locally: 0 vulnerabilities); dev-only tooling is
  lockfile-pinned and Dependabot-managed and is not the gate.
- R11: CI uploads diagnostic artifacts on failure (`if: failure()`):
  the coverage report and npm debug logs from the Linux test job.
- R12: The work is documented as it was built: this spec,
  `docs/autonomy-maturity.md` (model, full signal table, DMASI loop,
  measured baseline for this repo and all four templates), the README's
  AMM section and the `docs/architecture.md` structure tree.
- R13: Zero runtime dependencies are added anywhere; all new code uses
  Node built-ins; lint (eslint + prettier) and the full unit suite pass.

## Acceptance Criteria

- [x] AC1: `node bin/factory.js readiness .` in this repo reported
      47 points / Level 3 after the scoring and floor-raising work, and
      reports ≥ 60 / Level 4 with the coverage, audit, artifacts and spec
      gates in place (Pillar 3 +6, Pillar 4 +4, Pillar 7 +2, Pillar 8 +2).
- [x] AC2: All four freshly scaffolded templates score Level 3+
      (measured: static-html 82, fullstack 99, node-service 95,
      python-service 95 — all Level 4).
- [x] AC3: A minimal empty repo scores Level 0 and is not agent-ready;
      level boundaries at 5 / 19 / 36 / 60 / 100 are unit-tested.
- [x] AC4: `npm run test:coverage` passes locally with the thresholds of
      R9, and the same script exits 1 when a threshold is raised above
      the measured value (verified at 99% lines).
- [x] AC5: `npm audit --omit=dev --audit-level=high` exits 0 locally
      with 0 vulnerabilities, and the audit, coverage and failure-artifact
      steps are present in `.github/workflows/ci.yml` (Linux test job;
      coverage on the Node 24 leg).
- [x] AC6: `factory outcomes` on a repo with no runs prints a clean
      empty state; on fabricated run records it computes the autonomy
      ratio, cycle times and cost per change exactly (unit-tested), with
      MTTR and shelf-life as null plus a note.
- [x] AC7: `npm run lint` is green and `npm test` passes in full
      (119 tests after the readiness work, including new scorer, outcomes
      and scaffold tests).
- [x] AC8: A scaffolded project contains `AGENTS.md`,
      `docs/threat-model.md`, `docs/architecture.md` and
      `.githooks/pre-commit` with its executable bit intact
      (asserted by the scaffold test suite for all four templates).

## Out of Scope

- Weakening, special-casing or hardcoding any signal probe to make this
  repo pass. Gaps that need a tooling or dogfooding decision stay missing
  and are named in `docs/autonomy-maturity.md` (e.g. `typecheck-strict`
  for a plain-JS repo, `model-routing` configuration, devcontainers,
  SBOM / release provenance, error tracking, dead-code tooling).
- Implementing incident MTTR or change shelf-life measurement; the run
  record does not contain the data, and this spec forbids estimating it.
- Remote execution, multi-provider model routing and other Level 5
  process capabilities beyond honest measurement of what exists.
- Running the coverage gate on Windows CI (the suite already runs there;
  coverage enforcement lives on the Linux Node 24 leg), and adding any
  third-party coverage, audit or SBOM tooling.
- Publishing a release from this branch; versioning stays with
  release-please on merge.
