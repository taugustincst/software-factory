#!/usr/bin/env node
// SessionStart: tell Claude how this project is built and tested (from factory.json).
// Anything printed to stdout is added to the session context.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const file = path.join(dir, 'factory.json');
if (!existsSync(file)) process.exit(0);

try {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const cmds = Object.entries(cfg.commands ?? {})
    .map(([k, v]) => `- ${k}: \`${v}\``)
    .join('\n');
  process.stdout.write(
    `Project "${cfg.name ?? path.basename(dir)}" (template: ${cfg.template ?? 'custom'}).\n` +
      `Use these commands, they are what CI and the factory gates run:\n${cmds}\n`,
  );
} catch {
  // Malformed factory.json: stay silent rather than break the session.
}
process.exit(0);
