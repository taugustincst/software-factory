---
name: secure-coding
description: Secure coding checklist (OWASP Top 10, secrets, input validation, safe logging) to apply while writing code that handles user input, auth, files, HTTP, databases or personal data.
---

# Secure coding checklist

Apply while writing, not just in review.

**Input.** Validate at every boundary with a schema (zod for TypeScript, pydantic for Python). Reject unknown fields. Bound sizes and lengths.

**Injection.** Parameterised queries only. No shell strings built from input; use argument arrays (`spawn(cmd, [args])`, `subprocess.run([...])`). No `eval`, `new Function`, or `pickle` on untrusted data. Render HTML through the framework's escaping (React JSX, Jinja autoescape); never set `innerHTML` from data.

**Files and URLs.** Resolve paths and confirm they stay inside the allowed root (path traversal). Allow-list hosts for outbound requests built from input (SSRF).

**Auth.** Every non-public route checks authentication and authorisation on the server, including ownership of the object requested (IDOR). Deny by default.

**Secrets.** From environment variables only, documented in `.env.example` with fake values. Never in code, tests, logs, error messages, or URLs.

**Logging.** Structured logs with request IDs. Never log tokens, passwords, full request bodies, or personal/patient data. Errors returned to clients are generic; details go to the server log.

**HTTP.** Security headers (helmet or equivalent), strict CORS allow-list, CSRF protection for cookie sessions, rate limits on auth endpoints, request body size limits.

**Dependencies.** Add only what you need, from well-maintained packages. Lockfiles committed. Dependabot and CodeQL stay on.
