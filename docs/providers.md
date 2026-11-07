# Providers: using other LLMs

Directed by Tj on 2026-11-06: "Make it so that the factory can grab other llms as needed."

By default every stage runs on Claude Code, exactly as before. Add `providers` and `routing` to `factory.json` and each stage or role can use a different LLM. The router falls back down a chain when one isn't available.

## Built-in providers

| Name         | Type          | Endpoint                                                                 | Key env              |
| ------------ | ------------- | ------------------------------------------------------------------------ | -------------------- |
| `claude`     | `claude-code` | the Claude Code CLI (headless), with its built-in tools plus the harness | —                    |
| `anthropic`  | `anthropic`   | `https://api.anthropic.com` (Messages API)                               | `ANTHROPIC_API_KEY`  |
| `openai`     | `openai`      | `https://api.openai.com/v1`                                              | `OPENAI_API_KEY`     |
| `gemini`     | `openai`      | `https://generativelanguage.googleapis.com/v1beta/openai`                | `GEMINI_API_KEY`     |
| `openrouter` | `openai`      | `https://openrouter.ai/api/v1`                                           | `OPENROUTER_API_KEY` |
| `groq`       | `openai`      | `https://api.groq.com/openai/v1`                                         | `GROQ_API_KEY`       |
| `ollama`     | `openai`      | `http://127.0.0.1:11434/v1` (a local model)                              | none                 |
| `mock`       | `mock`        | offline canned agents                                                    | none                 |

The `openai` type speaks the OpenAI-compatible chat-completions format. That covers vLLM, LM Studio, Together, Azure-style gateways and most self-hosted servers: add a provider with its `baseUrl`.

## Configuration

```json
{
  "providers": {
    "openai": { "price": { "input": 2, "output": 8 } },
    "corp": { "type": "openai", "baseUrl": "https://llm.corp.example/v1", "apiKeyEnv": "CORP_LLM_KEY" }
  },
  "routing": {
    "default": ["claude"],
    "stages": { "spec": ["openai:gpt-4.1-mini", "claude"], "review": ["anthropic:<model>", "claude"] },
    "roles": { "decision": ["ollama:llama3.1:8b", "claude"], "inspector": ["claude"] },
    "escalateOnRetry": false
  }
}
```

- **A route** is `"<provider>"` or `"<provider>:<model>"`. The model may itself contain `:`, as in `ollama:llama3.1:8b`.
- **Precedence:** `routing.stages.<stage>` first, then `routing.roles.<role>`, then `routing.default`.
  - Stages: spec, plan, build, test, review, inspect, improve, decide.
  - Roles: author, implementer, reviewer, inspector, generative, decision.
- **Fallback:** the first available route runs. A route is skipped when:
  - its key env var is unset;
  - the Claude Code CLI is missing;
  - the API fails on its first request (network error, 401/403/404/408/429/5xx).

  Fallback happens only before a model has done any work. A gate failure or a 400 never silently switches models.

- **`escalateOnRetry`:** a retry after a failed gate starts one step further down the chain. For example, try a cheap model first and a stronger one when it doesn't pass.
- **`price`** (USD per million tokens) lets the factory cost API runs from their reported usage, and enforces each stage's spend cap. Unpriced providers show $0.
- **`--provider <route>`** on `factory run`, `factory steward` or `factory improve apply` sends every stage to that one LLM.
- **`factory providers`** shows every provider, whether it is available here, and each stage's route.

## How other LLMs do real work

API providers run an agent loop whose only tools are the [factory harness](harness.md) tools for the stage's role. They read, write, edit, run named `factory.json` commands and use git through the same scoped, sandboxed, audited layer as everything else.

So a model from any vendor gets exactly its role's permissions: the author can write only in the spec folder, the decider is read-only, the inspector can run checks but never write. Refused calls go back to the model as tool errors and into the audit log.

Each attempt records which provider and model ran it, and which routes were skipped. The Steward's evidence layer turns that into facts:

- `cost-provider:<name>`
- `provider-runs:<name>`
- `provider-fallbacks`

So routing changes can be proposed with measured costs. Changing routing means editing `factory.json`, which is `always-human`.

## Safety

- **Keys never go in `factory.json`.** A provider names an environment variable (`apiKeyEnv`). A literal `apiKey` field is ignored with a warning, and the schema rejects it.
- **`baseUrl`** must be https. Plain http is allowed only to localhost, for a local model server. URLs with embedded credentials are refused.
- **Your code leaves the machine.** Sending a stage to a third-party API sends that model the prompt and whatever it reads through the harness. Route sensitive repositories only to providers you are allowed to share code with, or to a local model.
