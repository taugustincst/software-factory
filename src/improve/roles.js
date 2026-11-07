import { promises as fs } from 'node:fs';

/**
 * The improvement loop's two model roles, as pipeline-style stage definitions so they run
 * through the same executors (Claude in production, mock in tests) and the same harness.
 * Both are harness-only: their tools are the factory's scoped MCP tools and nothing else.
 */

export const IMPROVE_STAGE = {
  id: 'improve',
  title: 'Improve',
  agent: 'factory-improver',
  role: 'generative',
  harnessOnly: true,
  tools: [],
  budgetUsd: 1,
  prompt: (ctx) =>
    `You are the factory's generative model. Read the evidence pack at \`${ctx.rel(ctx.evidenceFile)}\` ` +
    `(facts with IDs, values and the runs they came from; \`patterns\` lists the recurring ones). ` +
    `You may also read run records and logs under \`.factory/runs/\` and the factory's agents, gates and templates.\n\n` +
    `Write at most ${ctx.maxProposals} improvement proposals as a JSON array to \`${ctx.rel(ctx.proposalsFile)}\` using the write_file tool. ` +
    `Each proposal: {"title", "kind" (kit-prompt | gate | template | efficiency | docs), "targets" (repo-relative paths), ` +
    `"lesson" (why this keeps happening), "change" (what to change, concrete enough to become a factory run request), ` +
    `"claims": [{"text", "fact" (a fact ID from the pack), "value" (that fact's exact value)}], ` +
    `and for efficiency proposals "expectedSavings": {"fact" (a usd or seconds fact), "usd" or "seconds"}}.\n\n` +
    `Rules: cite only facts that are in the pack and copy their values exactly — a validation gate rejects anything else. ` +
    `Prefer recurring patterns over one-offs. Do not propose weakening a test, gate or guard. If nothing is worth proposing, write [].` +
    (ctx.open?.length
      ? `\n\nAlready in the backlog (do not repeat these):\n${ctx.open.map((p) => `- ${p.title}`).join('\n')}`
      : ''),
};

export const DECIDE_STAGE = {
  id: 'decide',
  title: 'Decide',
  agent: 'factory-decider',
  role: 'decision',
  harnessOnly: true,
  tools: [],
  budgetUsd: 0.5,
  prompt: (ctx) =>
    `You are the factory's decision model. Judge each proposal below against the evidence pack at \`${ctx.rel(ctx.evidenceFile)}\` ` +
    `(read it; you may read anything in the repository, but you cannot write).\n\n` +
    `For each proposal decide: "approve" (evidence is strong, the change is safe and worth it), "reject" (wrong, risky, or not worth it), ` +
    `or "needs-evidence" (plausible but not yet proven). Score 0-100 by expected value against risk, note duplicates, and explain briefly.\n\n` +
    `Reply with only this JSON object:\n{"decisions":[{"id":"<proposal id>","verdict":"approve|reject|needs-evidence","score":0,"duplicateOf":null,"reasoning":"…"}]}\n\n` +
    `Proposals:\n${JSON.stringify(
      (ctx.proposals ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        kind: p.kind,
        targets: p.targets,
        risk: p.risk,
        lesson: p.lesson,
        change: p.change,
        claims: p.claims,
      })),
      null,
      2,
    )}`,
};

/** Pull the decider's JSON out of its final message (bare, or in a ```json fence). */
export function parseDecisions(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : parsed.decisions;
    if (!Array.isArray(list)) return [];
    return list
      .filter((d) => d && typeof d.id === 'string' && ['approve', 'reject', 'needs-evidence'].includes(d.verdict))
      .map((d) => ({
        id: d.id,
        verdict: d.verdict,
        score: Number.isFinite(d.score) ? Math.max(0, Math.min(100, Math.round(d.score))) : null,
        duplicateOf: typeof d.duplicateOf === 'string' ? d.duplicateOf : null,
        reasoning: String(d.reasoning ?? '').slice(0, 2000),
      }));
  } catch {
    return [];
  }
}

/** Agents the pipeline stages run as, for proposals that target a stage's instructions. */
export const STAGE_AGENTS = {
  spec: 'spec-writer',
  plan: 'planner',
  build: 'implementer',
  test: 'test-engineer',
  review: 'code-reviewer',
};

/**
 * Canned generation and canned verdicts for the mock executor, so the whole loop runs
 * offline. The mock improver drafts one kit-prompt proposal per recurring gate failure,
 * citing the real fact and value; the mock decider approves each with a fixed score.
 */
export const mockRoles = {
  async improve(ctx) {
    const evidence = JSON.parse(await fs.readFile(ctx.evidenceFile, 'utf8'));
    const out = [];
    for (const id of evidence.patterns) {
      const m = id.match(/^gate-fail:([a-z]+):(.+)$/);
      if (!m || !STAGE_AGENTS[m[1]]) continue;
      const f = evidence.facts[id];
      out.push({
        title: `Tell the ${STAGE_AGENTS[m[1]]} to satisfy the ${m[2]} check before finishing`,
        kind: 'kit-prompt',
        targets: [`.claude/agents/${STAGE_AGENTS[m[1]]}.md`],
        lesson: `The ${m[1]} gate's ${m[2]} check keeps failing, so agents finish before it passes.`,
        change: `Add an explicit step to ${STAGE_AGENTS[m[1]]}.md: run the ${m[2]} check and fix failures before reporting done.`,
        claims: [{ text: f.label, fact: id, value: f.value }],
      });
      if (out.length >= ctx.maxProposals) break;
    }
    const r = await ctx.harness.call('write_file', { path: ctx.rel(ctx.proposalsFile), content: JSON.stringify(out, null, 2) });
    if (!r.ok) throw new Error(r.text);
  },
  async decide(ctx) {
    return {
      summary: JSON.stringify({
        decisions: (ctx.proposals ?? []).map((p) => ({
          id: p.id,
          verdict: 'approve',
          score: 70,
          duplicateOf: null,
          reasoning: 'mock decider: evidence cited and recurring',
        })),
      }),
    };
  },
};
