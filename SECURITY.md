# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security → Advisories), not in public issues. Expect an acknowledgement within 3 business days.

## Practices in this repository

- Dependencies are watched by Dependabot; CodeQL and a gitleaks secret scan run on every pull request.
- Secrets are read from environment variables and never committed. See `.env.example`.
- Test and demo data is synthetic. Real patient or personal data must never be committed, logged or pasted into issues.
- Claude Code guard hooks (`.claude/hooks/`) block destructive commands and secret-like content during AI-assisted work.
