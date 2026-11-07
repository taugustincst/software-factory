import { parseArgs } from 'node:util';
import path from 'node:path';
import { color, which } from '../util.js';
import { loadProject } from '../pipeline/project.js';
import { runPipeline } from '../pipeline/runner.js';
import { claudeExecutor, mockExecutor } from '../pipeline/executors.js';
import { resolveConfig } from '../improve/config.js';
import { stewardPass } from '../improve/steward.js';
import { listProposals, readProposal, PROPOSAL_ID_RE } from '../improve/store.js';
import { decideProposal, startApply, revertProposal } from '../improve/apply.js';

const out = (s) => process.stdout.write(s);

/**
 * The executor for the improvement roles. Model routing: --improver-model / --decider-model
 * win, then factory.json models.generative / models.decision, then --model, then the default.
 */
export async function roleExecutor({ executor = 'claude', model, improverModel, deciderModel, config = {} }) {
  if (executor === 'mock') return mockExecutor();
  if (executor !== 'claude') throw new Error(`unknown executor "${executor}" (claude | mock)`);
  if (!(await which('claude')))
    throw new Error('Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code');
  const { models } = resolveConfig(config);
  const stageModels = {};
  const gen = improverModel ?? models.generative;
  const dec = deciderModel ?? models.decision;
  if (gen) stageModels.improve = gen;
  if (dec) stageModels.decide = dec;
  return claudeExecutor({ model, stageModels });
}

/**
 * The after-run hook `factory run` installs: the Steward's light pass per
 * improvement.afterRun ("evidence" = deterministic, "analyze" = with models, "off").
 */
export function afterRunHook({ dir, executor, config }) {
  const { improvement } = resolveConfig(config);
  if (improvement.afterRun === 'off') return null;
  return async () => {
    const { report } = await stewardPass({ dir, executor, analyze: improvement.afterRun === 'analyze' });
    if (report.created.length || report.autoApproved.length)
      out(`${color.dim('•')} Steward: ${report.created.length} new proposal(s), ${report.autoApproved.length} auto-approved\n`);
  };
}

/** Apply one approved proposal by running the pipeline inline. Returns the run state. */
export async function applyInline({ dir, id, executor, ship = false, onEvent }) {
  let state = null;
  await startApply(dir, id, async ({ request, proposalId }) => {
    // The run id is known only once runPipeline starts, so the proposal records it after.
    state = await runPipeline({ dir, request, executor, proposalId, ship, onEvent });
    return state.id;
  });
  await stewardPass({ dir, analyze: false }); // reconcile: applied or failed
  return state;
}

function printProposal(p, full = false) {
  const badge =
    { 'always-human': color.red('always-human'), medium: color.yellow('medium'), low: color.green('low') }[p.risk] ?? '–';
  out(`${color.bold(p.id)}  ${p.status.padEnd(14)} risk ${badge}  score ${p.score ?? '–'}  ${p.title}\n`);
  if (!full) return;
  out(`  kind: ${p.kind}   targets: ${p.targets.join(', ')}\n  lesson: ${p.lesson}\n  change: ${p.change}\n  evidence:\n`);
  for (const c of p.claims) out(`    - ${c.text} (${c.fact} = ${c.value})\n`);
  if (p.decision) out(`  decider: ${p.decision.verdict} (${p.decision.score ?? '–'}) — ${p.decision.reasoning}\n`);
  if (p.approval) out(`  approved by ${p.approval.by}: ${p.approval.reason}\n`);
  if (p.apply)
    out(
      `  apply: run ${p.apply.runId}${p.apply.branch ? ` on ${p.apply.branch}` : ''}${p.apply.commit ? ` @ ${p.apply.commit.slice(0, 7)}` : ''}\n`,
    );
  for (const h of p.history ?? []) out(`  ${color.dim(h.at)} ${h.status}: ${h.note}\n`);
}

export async function cmdSteward(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: '.' },
      executor: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      'improver-model': { type: 'string' },
      'decider-model': { type: 'string' },
      'no-analyze': { type: 'boolean' },
      apply: { type: 'boolean' },
      ship: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const dir = path.resolve(values.dir);
  const project = await loadProject(dir);
  const analyze = !values['no-analyze'];
  const executor =
    analyze || values.apply
      ? await roleExecutor({
          executor: values.executor,
          model: values.model,
          improverModel: values['improver-model'],
          deciderModel: values['decider-model'],
          config: project.config,
        })
      : null;
  const { digest, report } = await stewardPass({ dir, executor, analyze });
  const applied = [];
  if (values.apply) {
    // Apply what the regime approved automatically, one run at a time.
    for (const p of (await listProposals(dir)).filter((x) => x.status === 'approved' && x.approval?.by === 'auto')) {
      const state = await applyInline({ dir, id: p.id, executor, ship: Boolean(values.ship) });
      applied.push({ id: p.id, run: state?.id, status: state?.status });
    }
  }
  if (values.json) return out(`${JSON.stringify({ digest, report, applied }, null, 2)}\n`);
  const e = digest.efficiency;
  out(
    `${color.bold('Steward')} pass ${report.passId} over ${digest.runs} run(s) — approval ${digest.approval.mode}` +
      `${digest.approval.mode === 'auto' ? ` (auto ≤ ${digest.approval.autoMaxRisk})` : ''}\n` +
      `Cost per passed run: ${e.costPerPassedRun === null ? 'n/a' : `$${e.costPerPassedRun}`}` +
      `${e.trend.recent !== null && e.trend.earlier !== null ? ` (recent $${e.trend.recent} vs earlier $${e.trend.earlier})` : ''}` +
      `   retry waste $${e.retryWasteUsd}   review loops ${e.reviewLoops}\n` +
      `This pass: ${report.created.length} new, ${report.refreshed.length} refreshed, ${report.retired.length} retired, ` +
      `${report.rejectedDrafts.length} draft(s) failed the citation gate, ${report.autoApproved.length} auto-approved, spend $${digest.thisPass.spendUsd}\n`,
  );
  for (const err of report.errors) out(`${color.yellow('!')} ${err}\n`);
  for (const w of report.warnings) out(`${color.yellow('!')} ${w}\n`);
  if (digest.queued.length) out(`\nQueued:\n`);
  for (const q of digest.queued) out(`  ${q.id}  ${q.status.padEnd(14)} ${q.risk ?? '–'}  ${q.title}\n`);
  if (digest.watching.length)
    out(`\nWatching (recurring, no proposal yet):\n${digest.watching.map((w) => `  ${w.fact} — ${w.runs} runs`).join('\n')}\n`);
  for (const a of applied) out(`Applied ${a.id}: run ${a.run} ${a.status}\n`);
}

export async function cmdImprove(argv) {
  const [sub = 'list', ...rest] = argv[0]?.startsWith('-') ? ['list', ...argv] : argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: '.' },
      reason: { type: 'string', default: '' },
      executor: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      ship: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const dir = path.resolve(values.dir);
  const id = positionals[0];
  const needId = () => {
    if (!id || !PROPOSAL_ID_RE.test(id)) throw new Error(`usage: factory improve ${sub} <proposal id, e.g. P-1a2b3c4d>`);
    return id;
  };
  switch (sub) {
    case 'list': {
      const all = await listProposals(dir);
      if (values.json) return out(`${JSON.stringify(all, null, 2)}\n`);
      if (!all.length) return out('No proposals yet. Run "factory steward" after a few runs.\n');
      for (const p of all) printProposal(p);
      return;
    }
    case 'show': {
      const p = await readProposal(dir, needId());
      if (!p) throw new Error(`proposal ${id} not found`);
      return values.json ? out(`${JSON.stringify(p, null, 2)}\n`) : printProposal(p, true);
    }
    case 'approve':
    case 'reject': {
      const p = await decideProposal(dir, needId(), { approve: sub === 'approve', by: 'human', reason: values.reason });
      return out(`${p.id} ${p.status}\n`);
    }
    case 'apply': {
      const project = await loadProject(dir);
      const executor = await roleExecutor({ executor: values.executor, model: values.model, config: project.config });
      const state = await applyInline({ dir, id: needId(), executor, ship: Boolean(values.ship) });
      return out(`${id}: run ${state?.id} ${state?.status}${state?.branch ? ` on ${state.branch}` : ''}\n`);
    }
    case 'revert': {
      const p = await revertProposal(dir, needId(), { by: 'human' });
      return out(`${p.id} reverted (${p.apply.revertCommit.slice(0, 7)})\n`);
    }
    default:
      throw new Error(`unknown "factory improve ${sub}": list | show | approve | reject | apply | revert`);
  }
}

export const IMPROVE_HELP = `
steward options (factory steward: the Steward's cross-run review)
  --dir <path>            Repository (default .)
  --executor <name>       claude (default) | mock
  --improver-model <name> Generative model (default factory.json models.generative)
  --decider-model <name>  Decision model (default factory.json models.decision)
  --no-analyze            Deterministic only: evidence, re-score, retire, digest (no spend)
  --apply                 Then apply auto-approved proposals as factory runs, one at a time
  --json                  Print the digest and pass report as JSON

improve commands (the improvement backlog)
  factory improve [list]               Proposals, best first
  factory improve show <id>            Evidence, decision, approval and history
  factory improve approve <id>         Approve (Tj's call in required mode) [--reason]
  factory improve reject <id>          Reject [--reason]
  factory improve apply <id>           Run an approved proposal through the pipeline [--executor] [--ship]
  factory improve revert <id>          git revert an applied proposal's commit
`;

export { stewardPass };
