// Minimal helpers for Claude Code hook scripts.
// Contract: hook input arrives as JSON on stdin. Exit 0 = allow, exit 2 = block
// (stderr is shown to Claude so it can correct course).

export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function block(message) {
  process.stderr.write(`[factory guard] ${message}\n`);
  process.exit(2);
}

export function allow() {
  process.exit(0);
}
