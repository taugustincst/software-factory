# {{factory.title}}

{{factory.description}}. Built from the [software-factory](https://github.com/taugustincst/software-factory) `python-service` template.

**Stack:** Python 3.13, FastAPI, Pydantic v2 settings and models, Postgres 16 with SQLAlchemy 2 and Alembic migrations, self-hosted session auth (argon2id), uv, pytest with coverage gate, Ruff (lint + format, incl. bandit rules), mypy strict, Docker.

## Quick start

```bash
uv sync
cp .env.example .env
docker compose up -d db                  # Postgres 16 via Docker Compose
uv run db-migrate                        # apply the committed migrations in alembic/versions/
uv run uvicorn app.main:app --reload     # http://127.0.0.1:8000/healthz, docs at /docs
```

## Commands

| Task | Command |
|---|---|
| Lint + format check | `uv run ruff check . && uv run ruff format --check .` |
| Type check | `uv run mypy` |
| Tests + coverage (85% gate) | `uv run pytest` |
| Start local Postgres | `docker compose up -d db` |
| Apply DB migrations | `uv run db-migrate` |
| Generate a migration after changing `src/app/db.py` | `uv run alembic revision --autogenerate -m "<change>"` |
| Container | `docker build -t {{factory.name}} .` |

Tests run against a real Postgres — CI provides an ephemeral one as a service container and runs `uv run db-migrate` before the suite; locally they use `DATABASE_URL` (default: the Compose database).

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz`, `/readyz` | Liveness, readiness |
| GET/POST | `/v1/tasks` | List, create (`{ "title": "…" }`) |
| GET/PATCH/DELETE | `/v1/tasks/{id}` | Read, update, delete |
| POST | `/v1/auth/register`, `/v1/auth/login`, `/v1/auth/logout` | Email + password auth; sets an httpOnly session cookie |
| GET | `/v1/me` | Protected example: current user (requires the session cookie) |
| GET | `/v1/admin` | RBAC example: requires the `admin` role |

`/docs` (OpenAPI UI) is disabled when `APP_ENV=production`.

The task resource is an example of the patterns to follow: Pydantic schemas at the boundary, strict models, consistent error bodies, and a store interface (`TaskStore` in `src/app/tasks.py`) backed by Postgres via SQLAlchemy.

## Auth

Self-hosted session auth in `src/app/auth.py`: argon2id password hashes (argon2-cffi), random session tokens — the cookie carries the raw token, the database stores only an HMAC of it keyed by `SESSION_SECRET`. Protect a route with the `get_current_user` dependency (`CurrentUser`), and use `Depends(require_role("admin"))` for role checks (see `/v1/me` and `/v1/admin`). Registration always creates role `user`; promote in the database to make an admin. Set a real `SESSION_SECRET` in production — the app refuses to start in production with the dev default.

## Building features

In Claude Code: `/factory <what you want>`. Or label a GitHub issue `factory` and the pipeline opens a PR.

## Layout

```
src/app/config.py   settings from env (incl. DATABASE_URL)
src/app/main.py     app factory: middleware, error handling, routers
src/app/db.py       SQLAlchemy models, engine/session factories
src/app/migrate.py  migration runner (the db-migrate console script)
src/app/tasks.py    example resource (models, store, router)
src/app/auth.py     session auth: argon2id passwords, session store, guards
alembic/            Alembic environment + committed migrations
docker-compose.yml  local Postgres 16 for development
tests/              pytest with TestClient against a real Postgres
docs/specs/         specs, plans and reviews per change
```
