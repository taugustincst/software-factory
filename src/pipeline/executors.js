import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { run, KIT_DIR } from '../util.js';

/** Load a subagent's instructions (frontmatter stripped), preferring the project's own copy. */
export async function loadAgentPrompt(dir, agent) {
  for (const base of [path.join(dir, '.claude', 'agents'), path.join(KIT_DIR, '.claude', 'agents')]) {
    const file = path.join(base, `${agent}.md`);
    if (existsSync(file)) {
      const text = await fs.readFile(file, 'utf8');
      return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    }
  }
  throw new Error(`agent definition not found: ${agent}.md`);
}

/** Turn one stream-json event from `claude -p` into a readable log line (or null to skip). */
export function formatStreamEvent(ev) {
  if (ev?.type === 'assistant') {
    return (ev.message?.content ?? [])
      .map((c) => {
        if (c.type === 'text' && c.text?.trim()) return c.text.trim();
        if (c.type === 'tool_use') {
          const i = c.input ?? {};
          const target = i.command ?? i.file_path ?? i.path ?? i.pattern ?? '';
          return `→ ${c.name}${target ? `: ${String(target).split('\n')[0].slice(0, 200)}` : ''}`;
        }
        return null;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (ev?.type === 'user') {
    const denied = (ev.message?.content ?? []).filter((c) => c.type === 'tool_result' && c.is_error);
    return denied.length
      ? denied
          .map((c) => `  ✗ ${String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300)}`)
          .join('\n')
      : null;
  }
  if (ev?.type === 'result')
    return `[result] ${ev.subtype ?? ''} · turns ${ev.num_turns ?? '?'} · $${(ev.total_cost_usd ?? 0).toFixed(3)}`;
  return null;
}

/**
 * Settings that wire the factory's own guard hooks (absolute paths) into every agent run.
 * Passed with --settings because Claude Code ignores a repo's .claude/settings.json in
 * workspaces nobody has trusted interactively, which includes every CI checkout.
 */
export function guardSettings() {
  const hook = (name) => ({ type: 'command', command: `node ${JSON.stringify(path.join(KIT_DIR, '.claude', 'hooks', name))}` });
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [hook('guard-bash.mjs')] },
        { matcher: 'Write|Edit|MultiEdit', hooks: [hook('guard-files.mjs')] },
      ],
      PostToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [hook('format-file.mjs')] }],
    },
  };
}

/**
 * Runs a stage with Claude Code in headless mode (`claude -p`, stream-json so logs are live).
 * Permissions: acceptEdits plus an explicit per-stage tool allow-list. Guard hooks are always
 * injected (see guardSettings). Spend is capped per stage with --max-budget-usd.
 */
export function claudeExecutor({ model, budgetMultiplier = 1, timeoutMs = 45 * 60_000, bin = 'claude' } = {}) {
  return {
    name: 'claude',
    async run({ stage, prompt, dir, onData }) {
      const system = await loadAgentPrompt(dir, stage.agent);
      const cap = (stage.budgetUsd ?? 2) * budgetMultiplier;
      const settingsFile = path.join(dir, '.factory', 'guard-settings.json');
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      await fs.writeFile(settingsFile, JSON.stringify(guardSettings(), null, 2));
      const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--append-system-prompt',
        system,
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        stage.tools.join(','),
        '--max-budget-usd',
        String(cap),
        '--settings',
        settingsFile,
      ];
      if (model) args.push('--model', model);

      let buffer = '';
      let result = null;
      const onChunk = (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'result') result = ev;
            const text = formatStreamEvent(ev);
            if (text) onData?.(`${text}\n`);
          } catch {
            // Partial or non-JSON line: ignore.
          }
        }
      };
      const r = await run([bin, ...args], { cwd: dir, timeoutMs, onStdout: onChunk, onStderr: (d) => onData?.(d) });
      onChunk('\n');

      const budgetHit = result?.terminal_reason === 'budget_exhausted' || result?.subtype === 'error_max_budget_usd';
      const ok = r.code === 0 && result && !result.is_error && !budgetHit;
      let error = null;
      if (!ok) {
        if (r.timedOut) error = 'stage timed out';
        else if (budgetHit) error = `stage spend cap reached ($${cap}); raise --budget-multiplier`;
        else if (!result) error = `claude produced no result (exit ${r.code}): ${r.stderr.slice(-500)}`;
        else error = `claude exited ${r.code}${result.subtype ? ` (${result.subtype})` : ''}`;
      }
      // The gate still runs after an error: partial work that meets the gate is accepted.
      return {
        ok: Boolean(ok),
        summary: result?.result ?? r.stderr.slice(-4000),
        costUsd: result?.total_cost_usd ?? 0,
        turns: result?.num_turns ?? null,
        error,
      };
    },
  };
}

/**
 * Offline executor for demos, CI of the factory itself, and tests. It writes artifacts
 * that satisfy each gate so the whole pipeline, dashboard and ship flow can be exercised
 * without an API key. `script` can override behaviour per stage and attempt.
 */
export function mockExecutor({ script = {}, delayMs = 0 } = {}) {
  const attempts = {};
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const defaults = {
    async spec(ctx) {
      await write(
        ctx.artifacts.spec,
        `# ${ctx.title}\n\n## Problem\n${ctx.request}\n\n## Users\nDevelopers.\n\n## Requirements\n- R1: The change described in the request is implemented.\n\n` +
          `## Acceptance Criteria\n- [ ] AC1 (R1): Given the app, when the feature is used, then it behaves as requested.\n\n` +
          `## Non-Functional\nNone.\n\n## Out of Scope\nEverything else.\n\n## Open Questions\nNone (mock run).\n`,
      );
    },
    async plan(ctx) {
      await write(
        ctx.artifacts.plan,
        `# Plan: ${ctx.title}\n\n## Approach\nMock plan.\n\n## Tasks\n- [ ] T1: implement — files: \`factory-mock/CHANGE.md\` — covers: AC1\n\n` +
          `## Test Strategy\nThe project's existing suite.\n\n## Risks\n- None → n/a\n\n## Rollback\nRevert the commit.\n`,
      );
    },
    async build(ctx) {
      await write(path.join(ctx.dir, 'factory-mock', 'CHANGE.md'), `Mock change for run ${ctx.runId}: ${ctx.title}\n`);
    },
    async test() {},
    async review(ctx) {
      await write(
        ctx.artifacts.review,
        `# Review: ${ctx.title}\n\nVerdict: APPROVE\n\n## Findings\nNone.\n\n## Summary\nMock review.\n`,
      );
    },
  };
  return {
    name: 'mock',
    async run({ stage, ctx, onData }) {
      attempts[stage.id] = (attempts[stage.id] ?? 0) + 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const fn = script[stage.id] ?? defaults[stage.id];
      onData?.(`[mock] ${stage.agent} attempt ${attempts[stage.id]}\n`);
      const out = (await fn?.(ctx, attempts[stage.id])) ?? {};
      return {
        ok: out.ok ?? true,
        summary: out.summary ?? `mock ${stage.id} done`,
        costUsd: 0,
        turns: 0,
        raw: '',
        error: out.error ?? null,
      };
    },
  };
}
