#!/usr/bin/env node
// PreToolUse(Bash): refuse destructive or history-rewriting shell commands.
import { checkCommand } from './lib/patterns.mjs';
import { readHookInput, block, allow } from './lib/io.mjs';

const input = await readHookInput();
const command = input?.tool_input?.command ?? '';
const hits = checkCommand(command);

if (hits.length > 0) {
  const reasons = hits.map((h) => `${h.id}: ${h.why}`).join('; ');
  block(`Blocked command (${reasons}). Choose a safer alternative or ask the user to run it.`);
}
allow();
