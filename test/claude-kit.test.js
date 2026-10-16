import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { installClaudeKit, mergeSettings } from '../src/claude-kit.js';
import { tmp } from './helpers.js';

test('installs agents, commands, skills, hooks and CLAUDE.md into an empty repo', async () => {
  const dir = tmp();
  const r = await installClaudeKit(dir, { projectName: 'Demo' });
  for (const f of [
    'agents/spec-writer.md',
    'agents/code-reviewer.md',
    'commands/factory.md',
    'skills/tdd/SKILL.md',
    'hooks/guard-bash.mjs',
    'settings.json',
    'FACTORY.md',
  ]) {
    assert.ok(existsSync(path.join(dir, '.claude', f)), f);
  }
  assert.match(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /@\.claude\/FACTORY\.md/);
  assert.ok(r.written.length > 20);
});

test('keeps existing files, merges settings, appends the CLAUDE.md import once', async () => {
  const dir = tmp();
  mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'agents', 'planner.md'), 'my planner');
  writeFileSync(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(make:*)'] }, model: 'opus' }),
  );
  writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\n');

  const r = await installClaudeKit(dir);
  assert.equal(readFileSync(path.join(dir, '.claude', 'agents', 'planner.md'), 'utf8'), 'my planner');
  assert.ok(r.skipped.includes(path.join('.claude', 'agents', 'planner.md')));
  const settings = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.ok(settings.permissions.allow.includes('Bash(make:*)'));
  assert.ok(settings.permissions.allow.includes('Bash(npm test:*)'));
  assert.ok(settings.hooks.PreToolUse.length >= 2);

  await installClaudeKit(dir);
  const md = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(md.match(/@\.claude\/FACTORY\.md/g).length, 1);
  const again = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(JSON.stringify(again.hooks), JSON.stringify(settings.hooks), 'hooks are not duplicated on reinstall');
});

test('mergeSettings dedupes permissions and hooks', () => {
  const hook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] };
  const out = mergeSettings(
    { permissions: { deny: ['A'] }, hooks: { PreToolUse: [hook] } },
    { permissions: { deny: ['A', 'B'] }, hooks: { PreToolUse: [hook] } },
  );
  assert.deepEqual(out.permissions.deny, ['A', 'B']);
  assert.equal(out.hooks.PreToolUse.length, 1);
});
