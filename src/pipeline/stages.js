/**
 * Pipeline stage definitions. Each agent stage names the subagent whose instructions become
 * its system prompt, the tools it may use, and the prompt that frames its task.
 * `retryFrom` says where to rewind when the gate fails after all attempts at this stage:
 * a rejected review goes back to build, then flows through test and review again.
 */

const READ = ['Read', 'Grep', 'Glob'];
const WRITE = ['Write', 'Edit', 'MultiEdit'];
// Shell access for building and testing. The kit's guard hook still screens every command.
const SHELL = [
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(uv:*)',
  'Bash(python:*)',
  'Bash(python3:*)',
  'Bash(pytest:*)',
  'Bash(ruff:*)',
  'Bash(mypy:*)',
  'Bash(make:*)',
  'Bash(ls:*)',
  'Bash(mkdir:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
];

const feedbackBlock = (feedback) =>
  feedback
    ? `\n\n## Gate feedback from the previous attempt\nThe last attempt did not pass its quality gate. Fix the root cause of each failure below; do not weaken tests or checks.\n\n${feedback}\n`
    : '';

const commandsBlock = (ctx) =>
  Object.entries(ctx.project.commands)
    .map(([k, v]) => `- ${k}: \`${v}\``)
    .join('\n') || '- (none configured)';

export const STAGES = [
  {
    id: 'spec',
    title: 'Spec',
    agent: 'spec-writer',
    tools: [...READ, 'Write'],
    budgetUsd: 1,
    prompt: (ctx, feedback) =>
      `Write the specification for this request.\n\n<request>\n${ctx.request}\n</request>\n\n` +
      `Save it to \`${ctx.rel(ctx.artifacts.spec)}\` using the exact section structure from your instructions. ` +
      `This is an unattended run: where something is ambiguous, choose the most reasonable interpretation, ` +
      `state the assumption under Open Questions, and continue.` +
      feedbackBlock(feedback),
  },
  {
    id: 'plan',
    title: 'Plan',
    agent: 'planner',
    tools: [...READ, 'Write'],
    budgetUsd: 1.5,
    prompt: (ctx, feedback) =>
      `Plan the implementation of \`${ctx.rel(ctx.artifacts.spec)}\`.\n\n` +
      `Write the plan to \`${ctx.rel(ctx.artifacts.plan)}\`. Every acceptance criterion ID (AC1, AC2…) must appear in at least one task's "covers".\n\n` +
      `Project commands (from factory.json):\n${commandsBlock(ctx)}` +
      feedbackBlock(feedback),
  },
  {
    id: 'build',
    title: 'Build',
    agent: 'implementer',
    tools: [...READ, ...WRITE, ...SHELL],
    budgetUsd: 6,
    prompt: (ctx, feedback) =>
      `Implement every unchecked task in \`${ctx.rel(ctx.artifacts.plan)}\` (spec: \`${ctx.rel(ctx.artifacts.spec)}\`), test-first.\n\n` +
      `Project commands (from factory.json). Lint, typecheck and build must pass before you finish:\n${commandsBlock(ctx)}` +
      feedbackBlock(feedback),
  },
  {
    id: 'test',
    title: 'Test',
    agent: 'test-engineer',
    tools: [...READ, ...WRITE, ...SHELL],
    budgetUsd: 3,
    prompt: (ctx, feedback) =>
      `Verify that every acceptance criterion in \`${ctx.rel(ctx.artifacts.spec)}\` is proven by an automated test, ` +
      `add missing tests and edge cases, make the suite pass, and append the "## Test Evidence" table to \`${ctx.rel(ctx.artifacts.plan)}\`.\n\n` +
      `Project commands:\n${commandsBlock(ctx)}` +
      feedbackBlock(feedback),
  },
  {
    id: 'review',
    title: 'Review',
    agent: 'code-reviewer',
    tools: [
      ...READ,
      'Write',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(npm audit:*)',
      // Verification commands only: the reviewer can run checks but has no Edit tool.
      'Bash(npm test:*)',
      'Bash(npm run lint:*)',
      'Bash(npm run typecheck:*)',
      'Bash(npx vitest:*)',
      'Bash(uv run:*)',
      'Bash(make test:*)',
      'Bash(make lint:*)',
    ],
    budgetUsd: 2,
    retryFrom: 'build',
    prompt: (ctx, feedback) =>
      `Review the uncommitted change in this repository against \`${ctx.rel(ctx.artifacts.spec)}\` and \`${ctx.rel(ctx.artifacts.plan)}\`. ` +
      `Include untracked files (see \`git status\`). Write your review to \`${ctx.rel(ctx.artifacts.review)}\`. ` +
      `Overwrite any previous review: judge the code as it is now.\n\n` +
      `Pipeline context: the change is intentionally uncommitted. After an APPROVE verdict the pipeline itself commits it ` +
      `to a feature branch and opens a pull request, so do not raise findings about branch or commit state. ` +
      `Run the project's checks yourself rather than trusting earlier reports:\n${commandsBlock(ctx)}` +
      (feedback ? `\n\nContext: an earlier gate reported:\n${feedback}` : ''),
  },
  {
    id: 'ship',
    title: 'Ship',
    deterministic: true,
  },
];

export function selectStages(ids) {
  if (!ids || ids.length === 0) return STAGES;
  const unknown = ids.filter((id) => !STAGES.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown stage(s): ${unknown.join(', ')}. Stages: ${STAGES.map((s) => s.id).join(', ')}`);
  return STAGES.filter((s) => ids.includes(s.id));
}
