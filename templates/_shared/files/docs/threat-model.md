# Threat model — {{factory.title}}

Starter threat model for this project, scaffolded by the software factory. Fill in the project-specific rows when the first feature lands, and review it whenever a trust boundary, a permission or a data flow changes. Method: STRIDE per element.

## System and trust boundaries

- What this system does: {{factory.description}}.
- Who uses it: _TODO — list the actor types (anonymous visitors, signed-in users, operators, the factory agent pipeline)._
- What it stores: _TODO — list the data classes (accounts, content, secrets, logs) and where they live._
- Trust boundaries: _TODO — e.g. browser ↔ API, API ↔ database, CI ↔ repository, agent job ↔ ship job in `.github/workflows/factory.yml`._

Inherited from the factory scaffold:

- The agent pipeline runs code with a dedicated, spend-capped `ANTHROPIC_API_KEY`; the agent job in `factory.yml` has read-only permissions and no write token, and a separate ship job (no agent) opens the PR.
- Guard hooks under `.claude/hooks/` block destructive commands and secret-like content during agent sessions. They are a safety net, not a sandbox.
- Secrets come from environment variables only (see `.env.example`); CodeQL, a gitleaks secret scan and Dependabot run in CI.

## STRIDE

| Category | Threat (adapt to this project) | Mitigations | Residual risk |
| --- | --- | --- | --- |
| Spoofing | An attacker impersonates a user or a service identity. | _TODO — e.g. session auth with hashed credentials, short-lived tokens._ | |
| Tampering | Input or a prompt-injected instruction modifies data or code it should not. | _TODO — e.g. server-side validation, least-privilege agent stages, deterministic pipeline gates, code-owner review._ | |
| Repudiation | An actor denies an action and there is no record. | _TODO — e.g. application audit log, pipeline run records under `.factory/runs/`._ | |
| Information disclosure | Secrets, personal data or logs leak through responses, artifacts or the dashboard. | _TODO — e.g. secret scanning in CI, synthetic test data only, private-repo-only log uploads._ | |
| Denial of service | Traffic, a runaway agent run or a costly query exhausts budget or capacity. | _TODO — e.g. rate limits, per-stage spend caps, `--max-run-usd`, request timeouts._ | |
| Elevation of privilege | A low-privilege actor reaches admin functions or a write token. | _TODO — e.g. authorization checks on every route, patch/ship split in `factory.yml`, branch protection on `main`._ | |

## Review triggers

Revisit this model when: authentication or authorization changes; a new data class or external integration is added; workflow permissions change; or the project starts handling regulated data.
