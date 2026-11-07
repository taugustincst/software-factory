import { run, which, tail } from '../util.js';
import { resolveProviders } from './config.js';

/**
 * Live provider verification: `factory providers --verify`. For each provider it checks
 * what can be checked without spending anything (the endpoint answers, the key is accepted,
 * the routed models exist), and with `deep` one tiny tool-calling round trip (a few tokens)
 * to prove the model can drive the harness. Providers that cannot be checked here say
 * exactly what is missing — a key, the CLI — instead of passing silently.
 */

const PING_TOOL = {
  name: 'ping',
  description: 'Reply to a connectivity check.',
  inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
};

async function getJson(fetchImpl, url, headers, signal) {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal });
  } catch (err) {
    return { ok: false, detail: `unreachable: ${err.message}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, detail: 'response is not JSON' };
  }
}

async function postJson(fetchImpl, url, headers, body, signal) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    return { ok: false, detail: `unreachable: ${err.message}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, detail: 'response is not JSON' };
  }
}

/** The models each provider is routed to, from the routing chains. */
export function routedModels(routing) {
  const out = {};
  const chains = [routing.default, ...Object.values(routing.stages), ...Object.values(routing.roles)];
  for (const chain of chains) for (const r of chain) (out[r.provider] ??= new Set()).add(r.model ?? null);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].filter(Boolean)]));
}

/**
 * Verify one provider. Returns { name, type, status: ok | failed | skipped, checks, needs }.
 * `needs` names what Tj must supply for a skipped provider (an env var, the CLI).
 */
export async function verifyProvider(
  p,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    models = [],
    deep = false,
    whichImpl = which,
    runImpl = run,
    timeoutMs = 20_000,
  } = {},
) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const done = (status, needs = null) => ({ name: p.name, type: p.type, status, checks, needs });

  if (p.type === 'mock') {
    add('offline mock', true, 'always available');
    return done('ok');
  }

  if (p.type === 'claude-code') {
    if (!(await whichImpl('claude')))
      return done('skipped', 'the Claude Code CLI on PATH (npm install -g @anthropic-ai/claude-code), signed in');
    const v = await runImpl(['claude', '--version'], { timeoutMs });
    add('claude --version', v.code === 0, v.code === 0 ? v.stdout.trim() : tail(v.stderr, 300));
    if (v.code !== 0) return done('failed');
    if (deep) {
      const r = await runImpl(
        [
          'claude',
          '-p',
          'Reply with exactly: ok',
          '--output-format',
          'json',
          '--max-budget-usd',
          // Claude Code's own system prompt dominates the first turn; a few cents is too tight.
          '0.5',
          ...(models[0] ? ['--model', models[0]] : []),
        ],
        { timeoutMs: 120_000 },
      );
      let parsed = null;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        /* reported below */
      }
      const ok = r.code === 0 && parsed && !parsed.is_error;
      add(
        'one-line prompt',
        Boolean(ok),
        ok
          ? `replied "${String(parsed.result).trim().slice(0, 40)}" ($${(parsed.total_cost_usd ?? 0).toFixed(4)})`
          : parsed?.is_error
            ? parsed.errors?.join('; ') || parsed.subtype || 'error'
            : tail(r.stderr || r.stdout, 300),
      );
      if (!ok) return done('failed');
    }
    return done('ok');
  }

  // API providers.
  if (p.apiKeyEnv && !env[p.apiKeyEnv]) return done('skipped', `${p.apiKeyEnv} exported in the environment`);
  const key = p.apiKeyEnv ? env[p.apiKeyEnv] : null;
  const signal = AbortSignal.timeout(timeoutMs);
  const anthropic = p.type === 'anthropic';
  const headers = anthropic
    ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
    : key
      ? { authorization: `Bearer ${key}` }
      : {};
  const list = await getJson(fetchImpl, `${p.baseUrl}${anthropic ? '/v1/models' : '/models'}`, headers, signal);
  if (!list.ok) {
    add(
      'endpoint and key',
      false,
      list.status === 401 || list.status === 403 ? `the key was refused (${list.detail})` : list.detail,
    );
    return done('failed');
  }
  const ids = (list.body.data ?? list.body.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
  add('endpoint and key', true, `${ids.length} model(s) listed`);
  for (const m of models)
    add(
      `model ${m}`,
      ids.length === 0 || ids.includes(m),
      ids.includes(m) ? 'listed' : ids.length ? 'not in the provider’s model list' : 'provider lists no models; not checked',
    );

  if (deep) {
    const model = models[0] ?? p.model ?? ids[0];
    if (!model) {
      add('tool call', false, 'no model to try; route one (e.g. "openai:gpt-4.1-mini")');
      return done('failed');
    }
    const prompt = 'Connectivity check: call the ping tool with ok=true. Do nothing else.';
    const r = anthropic
      ? await postJson(
          fetchImpl,
          `${p.baseUrl}/v1/messages`,
          headers,
          {
            model,
            max_tokens: 64,
            messages: [{ role: 'user', content: prompt }],
            tools: [{ name: PING_TOOL.name, description: PING_TOOL.description, input_schema: PING_TOOL.inputSchema }],
            tool_choice: { type: 'tool', name: 'ping' },
          },
          signal,
        )
      : await postJson(
          fetchImpl,
          `${p.baseUrl}/chat/completions`,
          headers,
          {
            model,
            max_tokens: 64,
            messages: [{ role: 'user', content: prompt }],
            tools: [
              {
                type: 'function',
                function: { name: PING_TOOL.name, description: PING_TOOL.description, parameters: PING_TOOL.inputSchema },
              },
            ],
            tool_choice: { type: 'function', function: { name: 'ping' } },
          },
          signal,
        );
    if (!r.ok) {
      add(`tool call on ${model}`, false, r.detail);
      return done('failed');
    }
    const called = anthropic
      ? (r.body.content ?? []).some((b) => b.type === 'tool_use' && b.name === 'ping')
      : (r.body.choices?.[0]?.message?.tool_calls ?? []).some((c) => c.function?.name === 'ping');
    add(
      `tool call on ${model}`,
      called,
      called ? 'the model called the harness-style tool' : 'the model answered without calling the tool',
    );
    if (!called) return done('failed');
  }
  return done(checks.every((c) => c.ok) ? 'ok' : 'failed');
}

/**
 * Verify the providers that matter: every provider the routing uses, plus any whose key is
 * present (or all of them with `all`). Returns { results, routed, needs, ok }.
 */
export async function verifyProviders({
  config = {},
  env = process.env,
  only = null,
  all = false,
  deep = false,
  fetchImpl,
  whichImpl,
  runImpl,
} = {}) {
  const { providers, routing } = resolveProviders(config);
  const models = routedModels(routing);
  const names = Object.keys(providers).filter((n) => {
    if (only) return n === only;
    if (all) return true;
    const p = providers[n];
    return models[n] !== undefined || (p.apiKeyEnv && env[p.apiKeyEnv]);
  });
  if (only && !providers[only]) throw new Error(`unknown provider "${only}"`);
  const results = [];
  for (const n of names)
    results.push(await verifyProvider(providers[n], { env, fetchImpl, whichImpl, runImpl, deep, models: models[n] ?? [] }));
  const routed = new Set(Object.keys(models));
  return {
    results,
    routed: [...routed],
    needs: results
      .filter((r) => r.status === 'skipped')
      .map((r) => ({ provider: r.name, routed: routed.has(r.name), needs: r.needs })),
    ok: results.filter((r) => routed.has(r.name)).every((r) => r.status !== 'failed'),
  };
}
