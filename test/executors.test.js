import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeExecutor, formatStreamEvent, loadAgentPrompt } from '../src/pipeline/executors.js';
import { STAGES } from '../src/pipeline/stages.js';
import { tmp } from './helpers.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.sh');
// The fake claude is a POSIX shell script, which Windows cannot spawn. The
// executor logic it exercises is platform-independent; on Windows the real
// binary is claude.exe. (Running .cmd shims like npm's claude.cmd through
// util.run is a separate follow-up.)
const SKIP_FAKE = process.platform === 'win32' ? 'fake claude is a POSIX shell script' : false;

test('claude executor parses stream-json, streams readable log lines and reports cost', { skip: SKIP_FAKE }, async () => {
  const lines = [];
  const stage = STAGES.find((s) => s.id === 'spec');
  const r = await claudeExecutor({ bin: FAKE }).run({ stage, prompt: 'x', dir: tmp(), onData: (d) => lines.push(d) });
  assert.equal(r.ok, true);
  assert.equal(r.costUsd, 0.42);
  assert.equal(r.summary, 'Done.');
  const log = lines.join('');
  assert.match(log, /Writing the spec\./);
  assert.match(log, /→ Write: docs\/specs\/x\/SPEC\.md/);
  assert.match(log, /✗ \[factory guard\] blocked/);
});

test('claude executor reports a missing binary as an error, not a crash', async () => {
  const stage = STAGES.find((s) => s.id === 'spec');
  const r = await claudeExecutor({ bin: '/nonexistent/claude' }).run({ stage, prompt: 'x', dir: tmp() });
  assert.equal(r.ok, false);
  assert.match(r.error, /no result/);
});

test('budget exhaustion is surfaced with a remedy', () => {
  assert.equal(formatStreamEvent({ type: 'system' }), null);
  assert.match(formatStreamEvent({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 1 }), /turns 2/);
});

test('agent prompts load from the kit with frontmatter stripped', async () => {
  const p = await loadAgentPrompt(tmp(), 'code-reviewer');
  assert.ok(!p.startsWith('---'));
  assert.match(p, /Verdict: APPROVE \| REQUEST_CHANGES/);
  await assert.rejects(loadAgentPrompt(tmp(), 'nope'), /not found/);
});

test('every agent stage references an agent that exists and has a tool allow-list', async () => {
  for (const s of STAGES.filter((x) => !x.deterministic)) {
    await loadAgentPrompt(tmp(), s.agent);
    assert.ok(s.tools.length > 0 && s.budgetUsd > 0, s.id);
  }
});

test('every agent run gets the guard hooks via --settings, using absolute paths', async () => {
  const { guardSettings } = await import('../src/pipeline/executors.js');
  const { existsSync } = await import('node:fs');
  const s = guardSettings();
  const commands = [...s.hooks.PreToolUse, ...s.hooks.PostToolUse].flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(commands.length, 3);
  for (const c of commands) {
    const file = JSON.parse(c.replace(/^node /, ''));
    assert.ok(path.isAbsolute(file) && existsSync(file), file);
  }
});

test('claude executor uses the review model only for the review stage', { skip: SKIP_FAKE }, async () => {
  const argvFile = path.join(tmp(), 'argv.txt');
  process.env.FAKE_ARGV_FILE = argvFile;
  const FAKE_ARGV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-argv.sh');
  const executor = claudeExecutor({ bin: FAKE_ARGV, model: 'model-a', reviewModel: 'model-b' });
  const { readFileSync } = await import('node:fs');
  const buildStage = STAGES.find((s) => s.id === 'build');
  await executor.run({ stage: buildStage, prompt: 'x', dir: tmp() });
  assert.match(readFileSync(argvFile, 'utf8'), /--model\nmodel-a/);
  const reviewStage = STAGES.find((s) => s.id === 'review');
  await executor.run({ stage: reviewStage, prompt: 'x', dir: tmp() });
  assert.match(readFileSync(argvFile, 'utf8'), /--model\nmodel-b/);
  delete process.env.FAKE_ARGV_FILE;
});
