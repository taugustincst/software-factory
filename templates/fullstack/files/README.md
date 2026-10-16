# {{factory.title}}

{{factory.description}}. Built from the [software-factory](https://github.com/taugustincst/software-factory) `fullstack` template.

**Stack:** React 19 + Vite (client), Fastify + Zod (API), TypeScript strict throughout, Vitest projects for web (jsdom + Testing Library) and server, coverage gates, single Docker image serving both.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev      # web http://localhost:5173  (proxies /api → :3000)
```

## Commands

| Task | Command |
|---|---|
| Dev (API + web, hot reload) | `npm run dev` |
| Lint + format check | `npm run lint` |
| Type check | `npm run typecheck` |
| Tests + coverage | `npm test` |
| Production build | `npm run build && npm start` |
| Container | `docker build -t {{factory.name}} .` |

## Layout

```
web/                 Vite root: index.html, src/ (React app, API client, tests)
server/              Fastify API: config, app factory, routes, tests
dist/client, dist/server   build output; the server serves the client in production
docs/specs/          specs, plans and reviews per change
```

## Building features

In Claude Code: `/factory <what you want>`. Or label a GitHub issue `factory` and the pipeline opens a PR.
