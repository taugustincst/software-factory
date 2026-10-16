import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const KIT_DIR = path.join(ROOT, 'claude-kit');

/**
 * Run a process and capture output. `command` may be a string (run through the shell,
 * for user-configured commands from factory.json) or [file, ...args] (no shell).
 */
export function run(command, { cwd, env, timeoutMs = 15 * 60_000, input, onData, onStdout, onStderr } = {}) {
  return new Promise((resolve) => {
    const useShell = typeof command === 'string';
    const [file, ...args] = useShell ? [command] : command;
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      onData?.(String(d));
      onStdout?.(String(d));
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      onData?.(String(d));
      onStderr?.(String(d));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function which(bin) {
  if (!/^[\w.-]+$/.test(bin)) throw new Error(`invalid binary name: ${bin}`);
  const r = await run(process.platform === 'win32' ? ['where', bin] : ['sh', '-c', `command -v ${bin}`]);
  return r.code === 0 ? r.stdout.trim().split('\n')[0] : null;
}

export function slugify(text, max = 40) {
  return (
    String(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'change'
  );
}

/** Last `n` characters of a string, for feeding failure output back to an agent. */
export function tail(text, n = 6000) {
  const s = String(text ?? '');
  return s.length > n ? `…(truncated)…\n${s.slice(-n)}` : s;
}

export const color = {
  enabled: process.stdout.isTTY && !process.env.NO_COLOR,
  wrap(code, s) {
    return this.enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
  },
  green(s) {
    return this.wrap(32, s);
  },
  red(s) {
    return this.wrap(31, s);
  },
  yellow(s) {
    return this.wrap(33, s);
  },
  dim(s) {
    return this.wrap(2, s);
  },
  bold(s) {
    return this.wrap(1, s);
  },
};
