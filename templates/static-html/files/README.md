# {{factory.title}}

{{factory.description}}. Built from the [software-factory](https://github.com/taugustincst/software-factory) `static-html` template.

Everything ships in one self-contained `index.html` (markup, styles and script), so it can be opened from disk, emailed, or hosted anywhere. Tooling exists only to keep it correct.

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

## Commands

| Task | Command |
|---|---|
| Lint (ESLint on inline JS, html-validate, Prettier) | `npm run lint` |
| Tests (Vitest + jsdom, runs the real page) | `npm test` |
| End-to-end smoke (Playwright, real browser) | `npm run e2e` |

## End-to-end tests

Playwright (`e2e/`, `playwright.config.js`) serves `index.html` with the dev static server and drives a real Chromium through the core flow: page load, add an item, persistence across reload, toggle, delete. Once per machine, install the browser:

```bash
npx playwright install chromium
npm run e2e
```

In CI the browser is installed with `npx playwright install --with-deps chromium` and, on failure, the Playwright report and test results (traces/screenshots) are uploaded as the `playwright-artifacts` artifact.

## Conventions

- User data is rendered with `textContent`, never `innerHTML`.
- `localStorage` access is wrapped in try/catch; the app still works when storage is blocked.
- Use synthetic data in demos and tests.

## Deploy

`.github/workflows/pages.yml` publishes `index.html` to GitHub Pages on every push to `main` (enable Pages → Source: GitHub Actions once).

## Building features

In Claude Code: `/factory <what you want>`. Or label a GitHub issue `factory` and the pipeline opens a PR.
