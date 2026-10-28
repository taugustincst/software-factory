# Specs

One folder per change: `YYYYMMDD-<slug>/` containing `SPEC.md` (what and why), `PLAN.md` (how, and test evidence) and `REVIEW.md` (pre-merge review). Written by `/spec`, `/plan`, `/review` in Claude Code, or by `factory run`.

Specs in this repo are records of real work: a spec describes a change as it was actually built, in the format the pipeline's spec gate enforces (`## Problem`, numbered `R<n>` requirements, checklist acceptance criteria with `AC<n>` ids, `## Out of Scope`).
