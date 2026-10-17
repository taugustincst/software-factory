import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { KIT_DIR } from '../src/util.js';
import { installClaudeKit } from '../src/claude-kit.js';
import { tmp } from './helpers.js';

const CLAUDE_DIR = path.join(KIT_DIR, '.claude');
const PIPELINE_CREW = [
  'spec-writer',
  'planner',
  'implementer',
  'test-engineer',
  'code-reviewer',
  'security-auditor',
  'release-manager',
];
const KNOWLEDGE_CREW = ['architect', 'scribe', 'sorter', 'seeker', 'connector', 'librarian', 'transcriber', 'postman'];
const KNOWLEDGE_SKILLS = [
  'contact-sync',
  'create-agent',
  'deadline-radar',
  'deep-clean',
  'defrag',
  'email-triage',
  'inbox-triage',
  'manage-agent',
  'meeting-prep',
  'onboarding',
  'tag-garden',
  'transcribe',
  'vault-audit',
  'weekly-agenda',
];

const frontmatter = (file) => {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, `${path.basename(file)} has frontmatter`);
  return m[1];
};

test('the merged harness: both crews present, every agent has a name and a tool allow-list', async () => {
  const files = (await fs.readdir(path.join(CLAUDE_DIR, 'agents'))).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files.map((f) => f.replace(/\.md$/, '')).sort(), [...PIPELINE_CREW, ...KNOWLEDGE_CREW].sort());
  for (const f of files) {
    const fm = frontmatter(path.join(CLAUDE_DIR, 'agents', f));
    assert.match(fm, new RegExp(`^name: ${f.replace(/\.md$/, '')}$`, 'm'), `${f} names itself`);
    assert.match(fm, /^tools: .+/m, `${f} declares its tool allow-list`);
  }
  for (const skill of KNOWLEDGE_SKILLS) {
    assert.ok(existsSync(path.join(CLAUDE_DIR, 'skills', skill, 'SKILL.md')), `knowledge skill ${skill} installed`);
  }
});

test('the dispatcher routes skills-first, caps chains at 3, and the registry lists every agent', () => {
  const dispatcher = readFileSync(path.join(CLAUDE_DIR, 'DISPATCHER.md'), 'utf8');
  assert.match(dispatcher, /Skills first, agents second/);
  assert.match(dispatcher, /Max depth 3/);
  assert.match(dispatcher, /### Suggested next agent/);
  const registry = readFileSync(path.join(CLAUDE_DIR, 'references', 'agents-registry.md'), 'utf8');
  for (const name of [...PIPELINE_CREW, ...KNOWLEDGE_CREW]) {
    assert.match(registry, new RegExp(`\\|\\s*${name}\\s*\\|`), `registry lists ${name}`);
  }
});

test('every pipeline agent hands off to a real next agent (or the end of the chain)', () => {
  for (const name of PIPELINE_CREW) {
    const text = readFileSync(path.join(CLAUDE_DIR, 'agents', `${name}.md`), 'utf8');
    const section = text.split('### Suggested next agent')[1];
    assert.ok(section, `${name} has a dispatcher handoff section`);
    const next = section
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0]
      .replace(/\.$/, '')
      .toLowerCase();
    if (next === 'none') continue;
    assert.ok(existsSync(path.join(CLAUDE_DIR, 'agents', `${next}.md`)), `${name} suggests ${next}, which must be a real agent`);
  }
});

test('installClaudeKit installs the harness: crew agents, dispatcher, registry and provenance', async () => {
  const dir = tmp();
  await installClaudeKit(dir, { projectName: 'Demo' });
  for (const f of [
    'agents/architect.md',
    'agents/postman.md',
    'skills/inbox-triage/SKILL.md',
    'DISPATCHER.md',
    'references/agents-registry.md',
    'harness/README.md',
    'harness/UPSTREAM.md',
    'harness/crew/DISPATCHER.md',
  ]) {
    assert.ok(existsSync(path.join(dir, '.claude', f)), f);
  }
});
