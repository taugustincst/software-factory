# {{factory.title}}

{{factory.description}}. Built from the [software-factory](https://github.com/taugustincst/software-factory) `python-service` template.

**Stack:** Python 3.13, FastAPI, Pydantic v2 settings and models, Postgres 16 with SQLAlchemy 2 and Alembic migrations, self-hosted session auth (argon2id), OpenTelemetry tracing (opt-in), uv, pytest with coverage gate, Ruff (lint + format, incl. bandit rules), mypy strict, Docker.

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
| Deploy (opt-in, manual) | Actions → Deploy → Run workflow (see Deploy) |

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

Self-hosted session auth in `src/app/auth.py`: rate-limited credential endpoints (in-memory limiter, 10 attempts / 15 min / IP), argon2id password hashes (argon2-cffi), random session tokens — the cookie carries the raw token, the database stores only an HMAC of it keyed by `SESSION_SECRET`. Protect a route with the `get_current_user` dependency (`CurrentUser`), and use `Depends(require_role("admin"))` for role checks (see `/v1/me` and `/v1/admin`). Registration always creates role `user`; promote in the database to make an admin. Set a real `SESSION_SECRET` in production — the app refuses to start in production with the dev default.

## Observability

OpenTelemetry tracing is built in but **off by default** — with no `OTEL_*` env set the service starts no SDK, opens no exporter connection and behaves exactly as before. To turn it on, point it at any OTLP/HTTP collector:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318   # base URL; /v1/traces is appended
OTEL_SERVICE_NAME=python-service                    # optional; labels this service's spans
```

Run a local collector, for example:

```bash
docker run --rm -p 4318:4318 otel/opentelemetry-collector-contrib:latest
```

Vendor backends that accept OTLP (Grafana Cloud, Honeycomb, …) work the same way — just change the endpoint (and add their auth header via the standard `OTEL_EXPORTER_OTLP_HEADERS` env var); there is no vendor SDK in the codebase. Set `OTEL_SDK_DISABLED=true` to force tracing off even when an endpoint is configured.

Every log line carries `trace_id=` and `span_id=` fields (`-` outside a span), so a line emitted while a request is being traced can be correlated with its trace. Spans only contain routes, methods and status codes — never add headers, request bodies or other sensitive data as span attributes.

## Deploy

Production deploys are **opt-in and manual**. `.github/workflows/deploy.yml` builds the Docker image and pushes it to GHCR (`ghcr.io/<owner>/{{factory.name}}`, tagged with the commit SHA and `latest`), but it has no automatic trigger: it only runs when you start it from Actions → Deploy → Run workflow, and only when the repository variable `DEPLOY_ENABLED` is set to `true` (Settings → Secrets and variables → Actions → Variables). Nothing deploys on push or merge.

`docker-compose.prod.yml` is the production example for a single Lightsail/VPS host: the published app image plus Postgres 16, with the app applying the committed migrations (the `db-migrate` console script) before it starts. The app only listens on `127.0.0.1:8000` — terminate TLS with a reverse proxy on the host.

1. Provision a Lightsail instance (or any VPS) and install Docker with the Compose plugin.
2. Copy `docker-compose.prod.yml` to the server and create a `.env` beside it — secrets live only in that file, never in git:

   ```bash
   POSTGRES_PASSWORD=<random, URL-safe>
   SESSION_SECRET=<at least 32 random characters>
   # optional overrides: POSTGRES_USER, POSTGRES_DB, SESSION_TTL_HOURS, LOG_LEVEL, CORS_ORIGINS
   # optional tracing: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME
   ```

   Keep the Postgres password URL-safe (or URL-encode it): it is interpolated into `DATABASE_URL`.

3. Make the GHCR package public, or run `docker login ghcr.io` on the server with a read-only token.
4. Ship a release: run the Deploy workflow in GitHub, then on the server:

   ```bash
   docker compose -f docker-compose.prod.yml pull
   docker compose -f docker-compose.prod.yml up -d
   ```

5. Put Caddy (or another reverse proxy) in front for TLS, e.g. `example.com { reverse_proxy 127.0.0.1:8000 }`, and point DNS at the host.

To roll back, point the app image in `docker-compose.prod.yml` at the previous release's `sha-…` tag and `up -d` again.

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
src/app/telemetry.py OpenTelemetry setup: env-gated, off by default
alembic/            Alembic environment + committed migrations
docker-compose.yml  local Postgres 16 for development
docker-compose.prod.yml   production example: GHCR app image + Postgres (see Deploy)
tests/              pytest with TestClient against a real Postgres
docs/specs/         specs, plans and reviews per change
```
