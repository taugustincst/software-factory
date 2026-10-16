#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit): protect sensitive paths and keep secrets/PHI out of files.
import path from 'node:path';
import { scanText, isProtectedPath } from './lib/patterns.mjs';
import { readHookInput, block, allow } from './lib/io.mjs';

const input = await readHookInput();
const ti = input?.tool_input ?? {};
const filePath = ti.file_path ?? ti.path ?? '';
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

if (filePath) {
  const rel = path.isAbsolute(filePath) ? path.relative(projectDir, filePath) : filePath;
  const reason = isProtectedPath(rel);
  if (reason) block(`Refusing to write ${rel}: ${reason}.`);
}

const newText = [ti.content, ti.new_string, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string) : [])]
  .filter((s) => typeof s === 'string')
  .join('\n');

const findings = scanText(newText);
if (findings.length > 0) {
  const list = findings.map((f) => `${f.id} (${f.match})`).join(', ');
  block(
    `Content looks like it contains secrets or PHI: ${list}. ` +
      'Read secrets from environment variables, and use synthetic identifiers in test data ' +
      '(for SSNs use area 900-999, e.g. 900-12-3456).',
  );
}
allow();
