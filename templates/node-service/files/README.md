# {{factory.title}}

{{factory.description}}. Built from the [software-factory](https://github.com/taugustincst/software-factory) `node-service` template.

**Stack:** Node 24, TypeScript (strict), Fastify, Zod validation, Vitest with coverage gates, Docker.

## Quick start

```bash
npm install
cp .env.example .env
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
| Container | `docker build -t {{factory.name}} .` |

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz`, `/readyz` | Liveness, readiness |
| GET/POST | `/v1/tasks` | List, create (`{ "title": "…" }`) |
| GET/PATCH/DELETE | `/v1/tasks/:id` | Read, update, delete |

The task resource is an example of the patterns to follow: Zod schemas at the boundary, strict objects, consistent error bodies, and a store interface you can back with a database.

## Building features

In Claude Code: `/factory <what you want>` runs spec → plan → build → test → review → ship in-session. Or label a GitHub issue `factory` to have the pipeline open a PR (see `.github/workflows/factory.yml`).

## Project layout

```
src/config.ts      env parsing (single source of configuration)
src/app.ts         app factory: plugins, error handling, routes
src/routes/        HTTP handlers, validation at the edge
src/server.ts      process entry: listen + graceful shutdown
test/              Vitest tests using app.inject (no network)
docs/specs/        specs, plans and reviews per change
```
