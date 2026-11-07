import { createHarness } from './index.js';

/**
 * Sub-agent spawning. A spawner runs one sub-agent on an executor (Claude Code, an API
 * provider or the mock) with a derived scope — never wider than its parent's — and a slice
 * of the parent's budget. The sub-agent is harness-only: the scoped factory tools are the
 * only tools it has, whatever its executor.
 *
 *   executorSpawner({ executor, dir, baseConfig, onData }) → spawner({ scope, task, budgetUsd, depth })
 *
 * `baseConfig` is the parent's harness config (root, commands, exec, auditFile, …); the
 * child's config is that plus its own scope, depth and budget, so a nested spawn can only
 * narrow further.
 */
export const SUBAGENT_STAGE = Object.freeze({
  id: 'subagent',
  title: 'Sub-agent',
  agent: 'factory-subagent',
  harnessOnly: true,
  tools: [],
});

export function executorSpawner({ executor, dir, baseConfig, onData, signal }) {
  const spawner = async ({ scope, task, budgetUsd, depth }) => {
    const harnessConfig = {
      ...baseConfig,
      role: undefined,
      scope,
      depth,
      budgetUsd: budgetUsd / 2, // a grandchild gets at most half of what its parent was given
    };
    const harness = createHarness({ ...harnessConfig, spawner });
    const stage = { ...SUBAGENT_STAGE, role: scope.role, budgetUsd };
    const prompt =
      `${task}\n\n` +
      `You are a sub-agent (role ${scope.role}, depth ${depth}). Your tools are the factory harness's, scoped to: ` +
      `${scope.capabilities.join(', ')}${scope.writeRoots ? `; writes only under ${scope.writeRoots.join(', ') || '(nowhere)'}` : ''}. ` +
      `Do the task, then reply with a short summary of what you found or changed.`;
    try {
      const r = await executor.run({ stage, prompt, dir, ctx: { harness, harnessConfig, signal, rel: (p) => p }, onData });
      return { ok: Boolean(r.ok), summary: r.summary ?? '', costUsd: r.costUsd ?? 0, error: r.error ?? null };
    } catch (err) {
      return { ok: false, summary: '', costUsd: 0, error: err.message };
    }
  };
  return spawner;
}
