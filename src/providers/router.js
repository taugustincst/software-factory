import { which } from '../util.js';
import { claudeExecutor, mockExecutor } from '../pipeline/executors.js';
import { STAGE_ROLES } from '../harness/index.js';
import { resolveProviders, chainFor, parseRoute } from './config.js';
import { apiExecutor } from './api.js';

/**
 * The routed executor: picks an LLM per stage (or role) from factory.json's routing, and
 * falls back down the chain when a provider is unavailable — no key, no CLI, the API is
 * down, rate-limited or refusing — before it has done any work. With escalateOnRetry, a
 * retry after a failed gate starts one step further down the chain (e.g. a cheaper model
 * first, a stronger one when it does not pass). Gate failures never cause silent fallback.
 */
export function routedExecutor({
  config = {},
  override = null,
  legacy = {},
  env = process.env,
  fetchImpl,
  budgetMultiplier = 1,
  whichImpl = which,
  mock = null,
  log = () => {},
} = {}) {
  const { providers, routing, warnings } = resolveProviders(config);
  for (const w of warnings) log(`providers: ${w}`);
  const overrideChain = override ? [parseRoute(override)].filter(Boolean) : null;
  if (override && !overrideChain.length) throw new Error(`--provider "${override}" is not "<provider>" or "<provider>:<model>"`);
  if (overrideChain && !providers[overrideChain[0].provider])
    throw new Error(`--provider: unknown provider "${overrideChain[0].provider}"`);
  const cache = new Map();
  let claudeBin;

  async function executorFor(route) {
    const p = providers[route.provider];
    const key = `${route.provider}:${route.model ?? ''}`;
    if (p.type === 'mock') return (mock ??= mockExecutor());
    if (p.type === 'claude-code') {
      claudeBin ??= (await whichImpl('claude')) ? 'claude' : null;
      if (!cache.has(key)) {
        // A routed model wins; otherwise the legacy flags (--model, --review-model, per-role models) apply.
        const model = route.model ?? p.model ?? legacy.model;
        const ex = claudeExecutor({
          model,
          reviewModel: route.model ? null : legacy.reviewModel,
          stageModels: route.model ? {} : (legacy.stageModels ?? {}),
          budgetMultiplier,
          bin: legacy.bin ?? 'claude',
        });
        ex.available = () => (claudeBin || legacy.bin ? null : 'the Claude Code CLI is not installed');
        cache.set(key, ex);
      }
      return cache.get(key);
    }
    if (!cache.has(key)) cache.set(key, apiExecutor({ provider: p, model: route.model, env, fetchImpl, budgetMultiplier }));
    return cache.get(key);
  }

  return {
    name: 'routed',
    routing,
    providers,
    chain: (stage) => overrideChain ?? chainFor(routing, stage, stage.role ?? STAGE_ROLES[stage.id]),
    async run(args) {
      const { stage, attempt = 1, onData } = args;
      const chain = this.chain(stage);
      const start = routing.escalateOnRetry && !overrideChain ? Math.min(attempt - 1, chain.length - 1) : 0;
      const skipped = [];
      for (let i = start; i < chain.length; i++) {
        const route = chain[i];
        const ex = await executorFor(route);
        const why = ex.available?.() ?? null;
        if (why) {
          skipped.push(`${route.route}: ${why}`);
          continue;
        }
        if (chain.length > 1 || skipped.length) onData?.(`[router] ${stage.id} → ${route.route}\n`);
        const r = await ex.run(args);
        if (r.unavailable) {
          skipped.push(`${route.route}: ${r.error}`);
          onData?.(`[router] ${route.route} unavailable (${r.error}); trying the next provider\n`);
          continue;
        }
        return {
          ...r,
          provider: r.provider ?? route.provider,
          model: r.model ?? route.model ?? null,
          route: route.route,
          skipped,
        };
      }
      return {
        ok: false,
        error: `no provider available for ${stage.id}: ${skipped.join('; ') || 'empty route chain'}`,
        costUsd: 0,
        summary: '',
        provider: null,
        skipped,
      };
    },
  };
}

/** Availability report for `factory providers`. */
export async function providerReport({ config = {}, env = process.env, whichImpl = which } = {}) {
  const { providers, routing, warnings, configured } = resolveProviders(config);
  const hasClaude = Boolean(await whichImpl('claude'));
  const rows = Object.values(providers).map((p) => ({
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl ?? null,
    key: p.apiKeyEnv
      ? env[p.apiKeyEnv]
        ? `${p.apiKeyEnv} set`
        : `${p.apiKeyEnv} missing`
      : p.type === 'openai'
        ? 'none needed'
        : null,
    available: p.type === 'mock' ? true : p.type === 'claude-code' ? hasClaude : !p.apiKeyEnv || Boolean(env[p.apiKeyEnv]),
    priced: Boolean(p.price),
  }));
  return { rows, routing, warnings, configured };
}
