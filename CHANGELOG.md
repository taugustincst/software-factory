# Changelog

## [0.4.0](https://github.com/taugustincst/software-factory/compare/v0.3.0...v0.4.0) (2026-10-28)


### Features

* **readiness:** implement the Autonomy Maturity Model — readiness + outcomes, Level 4 floor ([#27](https://github.com/taugustincst/software-factory/issues/27)) ([2eb452a](https://github.com/taugustincst/software-factory/commit/2eb452a57a0e4a1963e47fabccb5cc47f8d1fe79))


### Bug Fixes

* **hooks:** restore executable bit on the pre-commit hooks ([38cdc87](https://github.com/taugustincst/software-factory/commit/38cdc87d50ecd3a0da5206299c9a25712f6cd0b6))
* **hooks:** restore executable bit on the pre-commit hooks ([c5f330e](https://github.com/taugustincst/software-factory/commit/c5f330e3ef693fe7657bd5462243b6d26266317c))

## [0.3.0](https://github.com/taugustincst/software-factory/compare/v0.2.0...v0.3.0) (2026-10-22)


### Features

* OpenTelemetry tracing for the service templates (P2 phase 5) ([d6bc754](https://github.com/taugustincst/software-factory/commit/d6bc754c9bb268e685779c4874de65562b7b1d43))
* OpenTelemetry tracing for the service templates (P2 phase 5) ([bf48fd2](https://github.com/taugustincst/software-factory/commit/bf48fd2220db4072a7acc9dad95bbfd7dbb258bc))
* opt-in GHCR deploy stubs, prod compose and P2 docs (P2 phase 6) ([244ba4e](https://github.com/taugustincst/software-factory/commit/244ba4e5836e1a2a468bd66224f65619702699c5))
* opt-in GHCR deploy stubs, prod compose and P2 docs (P2 phase 6) ([994b2f9](https://github.com/taugustincst/software-factory/commit/994b2f9caf24d00ec87cc7359718f54f61131c93))
* Playwright e2e for the UI templates (P2 phase 4) ([cfbd57d](https://github.com/taugustincst/software-factory/commit/cfbd57d64256b5b04debdb33c87d41a8a5a97963))
* Playwright e2e for the UI templates (P2 phase 4) ([9a1003c](https://github.com/taugustincst/software-factory/commit/9a1003c9c0eb06c43964936f8fc1c3b163c7bf98))
* Postgres + Drizzle DB foundation for TS templates (P2 phase 1) ([39f753b](https://github.com/taugustincst/software-factory/commit/39f753b6c1acf9dae1b3ccde8fb0449556ddd855))
* Postgres + Drizzle DB foundation for TS templates (P2 phase 1) ([f075b6d](https://github.com/taugustincst/software-factory/commit/f075b6dbc7c3285512ba51bfd1ed47c7afcb3158))
* Postgres + SQLAlchemy/Alembic DB foundation for python-service (P2 phase 2) ([59559bf](https://github.com/taugustincst/software-factory/commit/59559bfb055adada7b56b2d560d3999057ee5676))
* Postgres + SQLAlchemy/Alembic DB foundation for python-service (P2 phase 2) ([70890c3](https://github.com/taugustincst/software-factory/commit/70890c3cf2012b1bc74d11ace6ad094fbdb99e88))
* rate-limit credential endpoints in service templates (CodeQL) ([304550c](https://github.com/taugustincst/software-factory/commit/304550c295395e618b9b6438f939d6d22d328013))
* session auth (argon2id) for service templates (P2 phase 3) ([c1cab89](https://github.com/taugustincst/software-factory/commit/c1cab89910543a6d25b520cab4fd84fb2b0c707d))
* session auth (argon2id) for service templates (P2 phase 3) ([576e1b9](https://github.com/taugustincst/software-factory/commit/576e1b97dfd92f21b81937308df24c9d9f274be0))


### Bug Fixes

* send a JSON content type only when the fullstack web client sends a body ([4274ede](https://github.com/taugustincst/software-factory/commit/4274eded98506298ee8babe8eceacaa2e8f8df08))
* template lint stays green after an e2e run (P2 phase 4) ([03dabca](https://github.com/taugustincst/software-factory/commit/03dabcad2f45eef9fc4562683aa91d3b2599617d))

## [0.2.0](https://github.com/taugustincst/software-factory/compare/v0.1.0...v0.2.0) (2026-10-18)


### Features

* **dashboard:** cancel running runs + launcher output in run detail (P2) ([07bc68d](https://github.com/taugustincst/software-factory/commit/07bc68db69a51c01fb69ebe9ca03f7c64a1d1806))
* **dashboard:** cancel running runs, show launcher output (P2) ([2bac4ae](https://github.com/taugustincst/software-factory/commit/2bac4aef2ab532ef5988e521239b2e9dbc2df9f3))
* factory upgrade — three-way merge of template changes (P2) ([570c5d3](https://github.com/taugustincst/software-factory/commit/570c5d31ae818ccd57f39774fde8d7abb67a0707))
* factory upgrade — three-way merge of template changes into existing projects (P2) ([c19a314](https://github.com/taugustincst/software-factory/commit/c19a3146fb5c48ea6efa1ee29fc5dde3b1e2be05))
* full merge of the Crew agent harness into the kit ([54d2ae9](https://github.com/taugustincst/software-factory/commit/54d2ae937a7959cf26c50580a5392c919eb5bccd))
* full merge of the Crew agent harness into the kit ([bb55833](https://github.com/taugustincst/software-factory/commit/bb558339aeb582ee869b4c8c34a5602017d1c52e))
* **gates:** tests-added error, coverage from factory.json, --review-model (P2) ([7cf467e](https://github.com/taugustincst/software-factory/commit/7cf467e09921d86cda60423221544e6121d9b9e3))
* **gates:** tests-added is an error, coverage enforced from factory.json, --review-model (P2) ([aebc93e](https://github.com/taugustincst/software-factory/commit/aebc93ec9fb4b9b9e9b5e5d1fab857507c2e946f))
* **pipeline:** --pause-after and --resume for human checkpoints (P2) ([5da98dd](https://github.com/taugustincst/software-factory/commit/5da98dde7d980991e051fe266fd79c8449a80ceb))
* **pipeline:** --pause-after and --resume for human checkpoints (P2) ([4da93b2](https://github.com/taugustincst/software-factory/commit/4da93b2857079b577cfd871b37b97c2047cb11db))
* **pipeline:** add a run-level spend cap, --max-run-usd (P1-5) ([8689c77](https://github.com/taugustincst/software-factory/commit/8689c770a682fcb970c5764716ad903ce814f175))
* **pipeline:** add a run-level spend cap, --max-run-usd (P1-5) ([52667d3](https://github.com/taugustincst/software-factory/commit/52667d316e8d48a22e3c2300d224d2668e0b8078))
* **templates:** audit CI agent egress + dedicated capped API key (P1-7) ([eeb991b](https://github.com/taugustincst/software-factory/commit/eeb991b670bceec9ff17befc908dcf7b7576ae52))
* **templates:** audit CI agent egress and require a dedicated capped API key (P1-7) ([94c6b20](https://github.com/taugustincst/software-factory/commit/94c6b202dac90f17b9412680011ae025a82fc075))


### Bug Fixes

* enforce LF checkouts via .gitattributes so lint passes on Windows ([2da9131](https://github.com/taugustincst/software-factory/commit/2da91315420f061f246abac99378858dc4970efc))

## 0.1.0 (2026-10-17)


### Features

* **pipeline:** reject concurrent runs with a per-repo lockfile ([1018bb8](https://github.com/taugustincst/software-factory/commit/1018bb8f6d2e7d95d5a93b89bf6743be66035db2))
* software factory with templates, Claude Code kit and gated agent pipeline ([8b6723f](https://github.com/taugustincst/software-factory/commit/8b6723fb6ef340ffa6e8159b4d936559796dd5fb))


### Bug Fixes

* git identity for tests/scaffold (P0-1) + per-repo run lockfile (P0-2) ([f818c3a](https://github.com/taugustincst/software-factory/commit/f818c3ae818d55d5171210f4d328f6120ed447de))
* **scaffold:** pin generated factory workflows to an immutable commit ([61466e2](https://github.com/taugustincst/software-factory/commit/61466e216ff4cb81541c75e9e25d1665373dd1e9))
* **scaffold:** work without a configured git identity ([b728882](https://github.com/taugustincst/software-factory/commit/b728882a2b3293fa2f6b1878eb6f98699624cbf5))
