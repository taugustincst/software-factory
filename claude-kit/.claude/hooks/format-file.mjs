#!/usr/bin/env node
// PostToolUse(Write|Edit|MultiEdit): format the touched file with the project's own formatter.
// Never blocks; formatting is a convenience, CI is the enforcer.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readHookInput } from './lib/io.mjs';

const input = await readHookInput();
const filePath = input?.tool_input?.file_path;
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
if (!filePath || !existsSync(filePath)) process.exit(0);

const ext = path.extname(filePath).toLowerCase();
const prettierExts = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.css', '.html', '.yml', '.yaml']);

function run(cmd, args) {
  spawnSync(cmd, args, { cwd: projectDir, stdio: 'ignore', timeout: 20_000 });
}

if (prettierExts.has(ext)) {
  const local = path.join(projectDir, 'node_modules', '.bin', process.platform === 'win32' ? 'prettier.cmd' : 'prettier');
  if (existsSync(local)) run(local, ['--write', '--log-level', 'silent', filePath]);
} else if (ext === '.py') {
  const r = spawnSync('ruff', ['--version'], { stdio: 'ignore' });
  if (r.status === 0) {
    run('ruff', ['format', '--quiet', filePath]);
    run('ruff', ['check', '--fix', '--quiet', filePath]);
  }
}
process.exit(0);
