# software-factory

Node ESM CLI with zero runtime dependencies. Read docs/architecture.md before changing structure.

- Commands: `npm run lint`, `npm test` (node:test), `npm run smoke [template]` (slow: installs and checks generated projects).
- Templates under `templates/*/files/` are not linted or formatted by this repo; they are verified by `npm run smoke`. Any change there needs a green smoke run with a clean git tree.
- Guard rules live only in `claude-kit/.claude/hooks/lib/patterns.mjs`; hooks and the review gate both import it. Every rule change needs positive and negative test cases.
- Never use `shell: true` with values from users or agents. Shell strings are only for `factory.json` commands, which the repo owner controls.
- Keep the dashboard local-only: 127.0.0.1 binding, Host check, Origin check on POST, CSP, no innerHTML.
- Conventional Commits, feature branches, PRs to main.
