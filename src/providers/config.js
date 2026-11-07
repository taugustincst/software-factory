/**
 * Providers and routing: which LLMs the factory may use, and which one each stage or role
 * tries first, second, third. Configured in factory.json; keys only ever come from the
 * environment variable a provider names, never from the file.
 *
 *   "providers": { "<name>": { "type": "claude-code" | "anthropic" | "openai" | "mock", "baseUrl", "apiKeyEnv", "price": { "input", "output" }, "maxTurns", "maxTokens" } },
 *   "routing":   { "default": ["claude"], "stages": { "<stage>": ["openai:gpt-4.1-mini", "claude"] }, "roles": { "<role>": [...] }, "escalateOnRetry": false }
 *
 * A route is "<provider>" or "<provider>:<model>" (the model may itself contain ':').
 */

export const TYPES = ['claude-code', 'anthropic', 'openai', 'mock'];

/** Built-in providers. A factory.json entry with the same name overrides fields. */
export const PRESETS = Object.freeze({
  claude: { type: 'claude-code' },
  anthropic: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  gemini: { type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' },
  openrouter: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  groq: { type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  ollama: { type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: null },
  mock: { type: 'mock' },
});

const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROUTE_RE = /^([a-z][a-z0-9-]{0,30})(?::([\w.:@/-]{1,100}))?$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** https anywhere; plain http only to this machine (a local model server). */
export function checkBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.username || u.password) return 'credentials in the URL are not allowed; use apiKeyEnv';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return 'must be https (plain http is allowed only for localhost)';
}

export function parseRoute(route) {
  const m = ROUTE_RE.exec(String(route ?? '').trim());
  return m ? { provider: m[1], model: m[2] ?? null, route: m[0] } : null;
}

const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000;

/** Resolve { providers, routing, warnings } from a parsed factory.json. Invalid input falls back safely. */
export function resolveProviders(cfg = {}) {
  const warnings = [];
  const providers = {};
  for (const [name, preset] of Object.entries(PRESETS)) providers[name] = { name, ...preset };
  for (const [name, raw] of Object.entries(cfg.providers ?? {})) {
    if (!NAME_RE.test(name)) {
      warnings.push(`providers.${name}: names are lowercase letters, digits and dashes`);
      continue;
    }
    if (raw?.apiKey !== undefined)
      warnings.push(`providers.${name}.apiKey: keys never go in factory.json; set apiKeyEnv and export the key — ignored`);
    const p = { ...(providers[name] ?? {}), name };
    const type = raw?.type ?? p.type;
    if (!TYPES.includes(type)) {
      warnings.push(`providers.${name}.type: must be one of ${TYPES.join(', ')}`);
      continue;
    }
    p.type = type;
    if (raw?.baseUrl !== undefined) {
      const why = checkBaseUrl(raw.baseUrl);
      if (why) {
        warnings.push(`providers.${name}.baseUrl: ${why}`);
        continue;
      }
      p.baseUrl = String(raw.baseUrl).replace(/\/+$/, '');
    }
    if (raw?.apiKeyEnv !== undefined) {
      if (raw.apiKeyEnv === null || ENV_RE.test(raw.apiKeyEnv)) p.apiKeyEnv = raw.apiKeyEnv;
      else warnings.push(`providers.${name}.apiKeyEnv: must be an environment variable name like OPENAI_API_KEY`);
    }
    if (raw?.price !== undefined) {
      if (num(raw.price?.input) && num(raw.price?.output)) p.price = { input: raw.price.input, output: raw.price.output };
      else warnings.push(`providers.${name}.price: { input, output } in USD per million tokens`);
    }
    if (raw?.model !== undefined) p.model = String(raw.model);
    for (const k of ['maxTurns', 'maxTokens']) {
      if (raw?.[k] === undefined) continue;
      if (Number.isInteger(raw[k]) && raw[k] >= 1 && raw[k] <= (k === 'maxTurns' ? 200 : 64000)) p[k] = raw[k];
      else warnings.push(`providers.${name}.${k}: out of range`);
    }
    if (['anthropic', 'openai'].includes(p.type) && !p.baseUrl) {
      warnings.push(`providers.${name}.baseUrl: required for type ${p.type}`);
      continue;
    }
    providers[name] = p;
  }

  const chain = (list, where) => {
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || !list.length) {
      warnings.push(`${where}: a non-empty list of routes`);
      return undefined;
    }
    const out = [];
    for (const r of list) {
      const parsed = parseRoute(r);
      if (!parsed) warnings.push(`${where}: "${r}" is not "<provider>" or "<provider>:<model>"`);
      else if (!providers[parsed.provider]) warnings.push(`${where}: unknown provider "${parsed.provider}"`);
      else out.push(parsed);
    }
    return out.length ? out : undefined;
  };
  const r = cfg.routing ?? {};
  const routing = {
    default: chain(r.default, 'routing.default') ?? [parseRoute('claude')],
    stages: {},
    roles: {},
    escalateOnRetry: r.escalateOnRetry === true,
  };
  for (const [k, v] of Object.entries(r.stages ?? {})) {
    const c = chain(v, `routing.stages.${k}`);
    if (c) routing.stages[k] = c;
  }
  for (const [k, v] of Object.entries(r.roles ?? {})) {
    const c = chain(v, `routing.roles.${k}`);
    if (c) routing.roles[k] = c;
  }
  return { providers, routing, warnings, configured: Boolean(cfg.providers || cfg.routing) };
}

/** The route chain for a stage: stage-specific, then role, then default. */
/**
 * The two model families. Every role that writes is generative; every role that judges is
 * decision. `routing.roles.generative` / `.decision` therefore cover the whole pipeline,
 * not just the improvement loop, unless a stage or its exact role has its own route.
 */
export const ROLE_FAMILY = Object.freeze({
  author: 'generative',
  implementer: 'generative',
  generative: 'generative',
  steward: 'generative',
  reviewer: 'decision',
  inspector: 'decision',
  decision: 'decision',
});

/** The route chain for a stage: stage-specific, then exact role, then model family, then default. */
export function chainFor(routing, stage, role) {
  const family = role ? ROLE_FAMILY[String(role).split('/')[0]] : undefined;
  return (
    routing.stages[stage.id] ??
    (role ? routing.roles[role] : undefined) ??
    (family && family !== role ? routing.roles[family] : undefined) ??
    routing.default
  );
}
