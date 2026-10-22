# {{factory.title}}

{{factory.description}}. Built from the [software-factory](https://github.com/taugustincst/software-factory) `node-service` template.

**Stack:** Node 24, TypeScript (strict), Fastify, Zod validation, Postgres 16 with Drizzle ORM and committed migrations, self-hosted session auth (argon2id), OpenTelemetry tracing (opt-in), Vitest with coverage gates, Docker.

## Quick start

```bash
npm install
cp .env.example .env
npm run db:up          # Postgres 16 via Docker Compose
npm run db:migrate     # apply the committed migrations in drizzle/
npm run dev            # http://127.0.0.1:3000/healthz
```

## Commands

| Task | Command |
|---|---|
| Dev server (watch) | `npm run dev` |
| Lint + format check | `npm run lint` |
| Type check | `npm run typecheck` |
| Tests + coverage (80% gate) | `npm test` |
| Build | `npm run build` |
| Start local Postgres | `npm run db:up` |
| Apply DB migrations | `npm run db:migrate` |
| Generate a migration after changing `src/db/schema.ts` | `npm run db:generate` |
| Container | `docker build -t {{factory.name}} .` |
| Deploy (opt-in, manual) | Actions → Deploy → Run workflow (see Deploy) |

Tests run against a real Postgres — CI provides an ephemeral one as a service container and runs `npm run db:migrate` before the suite; locally they use `DATABASE_URL` (default: the Compose database).

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz`, `/readyz` | Liveness, readiness |
| GET/POST | `/v1/tasks` | List, create (`{ "title": "…" }`) |
| GET/PATCH/DELETE | `/v1/tasks/:id` | Read, update, delete |
| POST | `/v1/auth/register`, `/v1/auth/login`, `/v1/auth/logout` | Email + password auth; sets an httpOnly session cookie |
| GET | `/v1/me` | Protected example: current user (requires the session cookie) |
| GET | `/v1/admin` | RBAC example: requires the `admin` role |

The task resource is an example of the patterns to follow: Zod schemas at the boundary, strict objects, consistent error bodies, and a store interface (`TaskStore` in `src/tasks.ts`) backed by Postgres via Drizzle.

## Auth

Self-hosted session auth in `src/auth.ts` + `src/routes/auth.ts`: rate-limited credential endpoints (@fastify/rate-limit, 10 attempts / 15 min / IP), argon2id password hashes (@node-rs/argon2), random session tokens — the cookie carries the raw token, the database stores only an HMAC of it keyed by `SESSION_SECRET`. Registration always creates role `user`; promote in the database to make an admin. Protect a route with the `requireAuth` preHandler, and add `requireRole('admin')` after it for role checks (see `/v1/me` and `/v1/admin`). Set a real `SESSION_SECRET` in production — the app refuses to start in production with the dev default. A bearer-token API variant is deliberately not implemented: browser clients get the safer httpOnly-cookie flow, and one auth pattern keeps the template auditable. OAuth/OIDC can replace the register/login handlers later while keeping the session layer.

## Observability

OpenTelemetry tracing is built in but **off by default** — with no `OTEL_*` env set the service starts no SDK, opens no exporter connection and behaves exactly as before. To turn it on, point it at any OTLP/HTTP collector:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318   # base URL; /v1/traces is appended
OTEL_SERVICE_NAME=node-service                      # optional; labels this service's spans
```

Run a local collector, for example:

```bash
docker run --rm -p 4318:4318 otel/opentelemetry-collector-contrib:latest
```

Vendor backends that accept OTLP (Grafana Cloud, Honeycomb, …) work the same way — just change the endpoint (and add their auth header via the standard `OTEL_EXPORTER_OTLP_HEADERS` env var); there is no vendor SDK in the codebase. Set `OTEL_SDK_DISABLED=true` to force tracing off even when an endpoint is configured.

While a request is being traced, the structured logs carry `trace_id` and `span_id` fields (via the logger mixin in `src/app.ts`), so a log line can be correlated with its trace. Spans only contain routes, methods and status codes — never add headers, request bodies or other sensitive data as span attributes.

## Deploy

Production deploys are **opt-in and manual**. `.github/workflows/deploy.yml` builds the Docker image and pushes it to GHCR (`ghcr.io/<owner>/{{factory.name}}`, tagged with the commit SHA and `latest`), but it has no automatic trigger: it only runs when you start it from Actions → Deploy → Run workflow, and only when the repository variable `DEPLOY_ENABLED` is set to `true` (Settings → Secrets and variables → Actions → Variables). Nothing deploys on push or merge.

`docker-compose.prod.yml` is the production example for a single Lightsail/VPS host: the published app image plus Postgres 16, with the app applying the committed migrations before it starts. The app only listens on `127.0.0.1:3000` — terminate TLS with a reverse proxy on the host.

1. Provision a Lightsail instance (or any VPS) and install Docker with the Compose plugin.
2. Copy `docker-compose.prod.yml` to the server and create a `.env` beside it — secrets live only in that file, never in git:

   ```bash
   POSTGRES_PASSWORD=<random, URL-safe>
   SESSION_SECRET=<at least 32 random characters>
   # optional overrides: POSTGRES_USER, POSTGRES_DB, SESSION_TTL_HOURS, LOG_LEVEL
   # optional tracing: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME
   ```

   Keep the Postgres password URL-safe (or URL-encode it): it is interpolated into `DATABASE_URL`.

3. Make the GHCR package public, or run `docker login ghcr.io` on the server with a read-only token.
4. Ship a release: run the Deploy workflow in GitHub, then on the server:

   ```bash
   docker compose -f docker-compose.prod.yml pull
   docker compose -f docker-compose.prod.yml up -d
   ```

5. Put Caddy (or another reverse proxy) in front for TLS, e.g. `example.com { reverse_proxy 127.0.0.1:3000 }`, and point DNS at the host.

To roll back, point the app image in `docker-compose.prod.yml` at the previous release's `sha-…` tag and `up -d` again.

## Building features

In Claude Code: `/factory <what you want>` runs spec → plan → build → test → review → ship in-session. Or label a GitHub issue `factory` to have the pipeline open a PR (see `.github/workflows/factory.yml`).

## Project layout

```
src/config.ts      env parsing (single source of configuration)
src/app.ts         app factory: plugins, error handling, routes
src/routes/        HTTP handlers, validation at the edge
src/auth.ts        session auth: argon2id passwords, session store, guards
src/db/            Drizzle schema, client factory, migration runner
src/tracing.ts     OpenTelemetry setup: env-gated, off by default
src/server.ts      process entry: tracing init, listen + graceful shutdown
drizzle/           committed SQL migrations (generated by drizzle-kit)
docker-compose.yml local Postgres 16 for development
docker-compose.prod.yml   production example: GHCR app image + Postgres (see Deploy)
test/              Vitest tests using app.inject (no network)
docs/specs/        specs, plans and reviews per change
```
