import { loadAgentPrompt } from '../pipeline/executors.js';
import { createHarness } from '../harness/index.js';

/**
 * An agent loop over a plain chat API, so the factory can use LLMs beyond Claude Code.
 * The model's only tools are the factory harness's tools for the stage's role: it reads,
 * writes and runs commands through the same scoped, sandboxed, audited layer as every
 * other agent, and nothing else. Two wire formats cover most providers:
 *   anthropic  POST {baseUrl}/v1/messages
 *   openai     POST {baseUrl}/chat/completions   (OpenAI, Gemini, OpenRouter, Groq, Ollama, vLLM, LM Studio…)
 */

const RETRYABLE = new Set([401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

class ProviderError extends Error {
  constructor(message, { unavailable = false } = {}) {
    super(message);
    this.unavailable = unavailable;
  }
}

async function post(fetchImpl, url, headers, body, signal) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new ProviderError('request aborted');
    throw new ProviderError(`network error: ${err.message}`, { unavailable: true });
  }
  const text = await res.text();
  if (!res.ok)
    throw Object.assign(
      new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`, { unavailable: RETRYABLE.has(res.status) }),
      { status: res.status },
    );
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('response is not JSON', { unavailable: true });
  }
}

/** Anthropic Messages API, one turn. Returns { text, calls: [{ id, name, args }], usage, raw }. */
export const anthropicWire = {
  tools: (tools) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
  start: (system, prompt) => ({ system, messages: [{ role: 'user', content: prompt }] }),
  async turn({ fetchImpl, provider, model, key, state, tools, maxTokens, signal }) {
    const headers = { 'anthropic-version': '2023-06-01' };
    if (key) headers['x-api-key'] = key;
    const body = { model, max_tokens: maxTokens, system: state.system, messages: state.messages, tools };
    const r = await post(fetchImpl, `${provider.baseUrl}/v1/messages`, headers, body, signal);
    state.messages.push({ role: 'assistant', content: r.content ?? [] });
    const blocks = r.content ?? [];
    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
      usage: { input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 },
    };
  },
  results: (state, results) =>
    state.messages.push({
      role: 'user',
      content: results.map((x) => ({ type: 'tool_result', tool_use_id: x.id, content: x.text, is_error: !x.ok })),
    }),
};

/** OpenAI-compatible chat completions, one turn. */
export const openaiWire = {
  tools: (tools) =>
    tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
  start: (system, prompt) => ({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  }),
  async turn({ fetchImpl, provider, model, key, state, tools, maxTokens, signal }) {
    const headers = key ? { authorization: `Bearer ${key}` } : {};
    const body = { model, messages: state.messages, tools, tool_choice: 'auto', max_tokens: maxTokens };
    const r = await post(fetchImpl, `${provider.baseUrl}/chat/completions`, headers, body, signal);
    const msg = r.choices?.[0]?.message ?? {};
    state.messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    });
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      calls: (msg.tool_calls ?? []).map((c) => {
        let args;
        try {
          args = JSON.parse(c.function?.arguments || '{}');
        } catch {
          args = { __invalid: c.function?.arguments };
        }
        return { id: c.id, name: c.function?.name, args };
      }),
      usage: { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 },
    };
  },
  results: (state, results) => {
    for (const x of results) state.messages.push({ role: 'tool', tool_call_id: x.id, content: x.text });
  },
};

const WIRES = { anthropic: anthropicWire, openai: openaiWire };

/** USD for token usage at a provider's price (USD per million tokens), or null if unpriced. */
export function priceOf(provider, usage) {
  if (!provider.price) return null;
  return (usage.input * provider.price.input + usage.output * provider.price.output) / 1e6;
}

/**
 * An executor (same interface as claudeExecutor) that runs a stage on an API provider.
 * `env` supplies keys (process.env by default); `fetchImpl` is injectable for tests.
 */
export function apiExecutor({
  provider,
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
  budgetMultiplier = 1,
  timeoutMs = 45 * 60_000,
}) {
  const wire = WIRES[provider.type];
  if (!wire) throw new Error(`provider ${provider.name} has no API wire format (${provider.type})`);
  const modelName = model ?? provider.model;
  return {
    name: provider.name,
    available() {
      if (!modelName) return `no model named for ${provider.name} (use "${provider.name}:<model>")`;
      if (provider.apiKeyEnv && !env[provider.apiKeyEnv]) return `${provider.apiKeyEnv} is not set`;
      return null;
    },
    async run({ stage, prompt, dir, ctx, onData }) {
      const unavailable = this.available();
      if (unavailable) return { ok: false, unavailable: true, error: unavailable, costUsd: 0, summary: '' };
      const harness = ctx?.harness ?? (ctx?.harnessConfig ? createHarness(ctx.harnessConfig) : null);
      if (!harness)
        return {
          ok: false,
          error: `${provider.name}: API providers work through the factory harness, and none was provided`,
          costUsd: 0,
          summary: '',
        };
      const system =
        (await loadAgentPrompt(dir, stage.agent)) +
        `\n\nYou are running inside the software factory on ${provider.name} (${modelName}). Your tools are the factory harness's: ` +
        `paths are repository-relative, writes are confined to what your role allows, and every call is audited. ` +
        `When the task is done, reply with a short summary and no tool call.`;
      const state = wire.start(system, prompt);
      const tools = wire.tools(harness.tools);
      const cap = (stage.budgetUsd ?? 2) * budgetMultiplier;
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(ctx?.signal ? [ctx.signal] : [])]);
      const usage = { input: 0, output: 0 };
      let toolCalls = 0;
      const maxTurns = provider.maxTurns ?? 40;
      const key = provider.apiKeyEnv ? env[provider.apiKeyEnv] : null;
      const result = (fields) => {
        const cost = priceOf(provider, usage);
        return {
          costUsd: cost ?? 0,
          unpriced: cost === null,
          turns: undefined,
          provider: provider.name,
          model: modelName,
          usage: { ...usage },
          ...fields,
        };
      };
      for (let turn = 1; turn <= maxTurns; turn++) {
        let r;
        try {
          r = await wire.turn({
            fetchImpl,
            provider,
            model: modelName,
            key,
            state,
            tools,
            maxTokens: provider.maxTokens ?? 8192,
            signal,
          });
        } catch (err) {
          // Before the model touched anything, a dead provider is a reason to try the next one.
          return result({
            ok: false,
            unavailable: Boolean(err.unavailable) && toolCalls === 0,
            error: `${provider.name}: ${err.message}`,
            summary: '',
            turns: turn,
          });
        }
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        if (r.text?.trim()) onData?.(`${r.text.trim()}\n`);
        if (!r.calls.length) return result({ ok: true, summary: r.text, turns: turn });
        const outs = [];
        for (const c of r.calls) {
          toolCalls++;
          const target = c.args?.path ?? c.args?.name ?? c.args?.pattern ?? '';
          onData?.(`→ ${c.name}${target ? `: ${String(target).slice(0, 200)}` : ''}\n`);
          const res =
            c.args?.__invalid !== undefined
              ? { ok: false, text: 'tool arguments were not valid JSON' }
              : await harness.call(c.name, c.args);
          if (!res.ok) onData?.(`  ✗ ${res.text.slice(0, 300)}\n`);
          outs.push({ id: c.id, ok: res.ok, text: res.text.slice(0, 100_000) });
        }
        wire.results(state, outs);
        const spent = priceOf(provider, usage);
        if (spent !== null && spent >= cap)
          return result({ ok: false, error: `stage spend cap reached ($${cap}) on ${provider.name}`, summary: '', turns: turn });
      }
      return result({
        ok: false,
        error: `${provider.name}: stopped after ${maxTurns} turns without finishing`,
        summary: '',
        turns: maxTurns,
      });
    },
  };
}
