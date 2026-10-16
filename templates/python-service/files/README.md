# {{factory.title}}

{{factory.description}}. Built from the [software-factory](https://github.com/taugustincst/software-factory) `python-service` template.

**Stack:** Python 3.13, FastAPI, Pydantic v2 settings and models, uv, pytest with coverage gate, Ruff (lint + format, incl. bandit rules), mypy strict, Docker.

## Quick start

```bash
uv sync
cp .env.example .env
uv run uvicorn app.main:app --reload     # http://127.0.0.1:8000/healthz, docs at /docs
```

## Commands

| Task | Command |
|---|---|
| Lint + format check | `uv run ruff check . && uv run ruff format --check .` |
| Type check | `uv run mypy` |
| Tests + coverage (85% gate) | `uv run pytest` |
| Container | `docker build -t {{factory.name}} .` |

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz`, `/readyz` | Liveness, readiness |
| GET/POST | `/v1/tasks` | List, create (`{ "title": "…" }`) |
| GET/PATCH/DELETE | `/v1/tasks/{id}` | Read, update, delete |

`/docs` (OpenAPI UI) is disabled when `APP_ENV=production`.

## Building features

In Claude Code: `/factory <what you want>`. Or label a GitHub issue `factory` and the pipeline opens a PR.

## Layout

```
src/app/config.py   settings from env
src/app/main.py     app factory: middleware, error handling, routers
src/app/tasks.py    example resource (models, store, router)
tests/              pytest with TestClient (no network)
docs/specs/         specs, plans and reviews per change
```
