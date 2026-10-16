// Shared guardrail patterns. Used by the Claude Code hooks in this folder and by
// the factory pipeline's review gate, so there is one source of truth.
// Zero dependencies: this file is copied into every project that installs the kit.

/** Credentials that must never land in a repo. */
export const SECRET_PATTERNS = [
  { id: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-key', re: /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'stripe-live-key', re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  {
    id: 'generic-assigned-secret',
    // password = "hunter2hunter2", api_key: 'abcd...'. Ignores obvious placeholders.
    re: /\b(api[_-]?key|secret|password|passwd|token|client[_-]?secret)\b["']?\s*[:=]\s*["'](?!(?:changeme|example|placeholder|your[-_]|xxx|<|\$\{|\{\{))[^"'\s]{12,}["']/i,
  },
];

/**
 * US Social Security numbers. Real-format SSNs are treated as PHI and blocked.
 * Synthetic test data should use ranges the SSA never issues: area 000, 666 or 900-999,
 * group 00, or serial 0000. Those pass.
 */
const SSN_RE = /\b(\d{3})-(\d{2})-(\d{4})\b/g;

export function findRealisticSsns(text) {
  const hits = [];
  for (const m of text.matchAll(SSN_RE)) {
    const [, area, group, serial] = m;
    const a = Number(area);
    const synthetic = a === 0 || a === 666 || a >= 900 || group === '00' || serial === '0000';
    if (!synthetic) hits.push(m[0]);
  }
  return hits;
}

/** Scan text. Returns [{ id, match }] with matches redacted for safe logging. */
export function scanText(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings = [];
  for (const { id, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) findings.push({ id, match: redact(m[0]) });
  }
  for (const ssn of findRealisticSsns(text)) {
    findings.push({ id: 'ssn-phi', match: redact(ssn) });
  }
  return findings;
}

export function redact(s) {
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${'*'.repeat(6)}`;
}

// ---------------------------------------------------------------------------------------------
// Shell command guard. Commands are tokenized like a POSIX shell (quotes, escapes, operators),
// split into simple commands, and each is checked by rule functions. This is linear-time and
// sees through `sudo`, `env`, `bash -c "…"`, git global options and refspec syntax.
// It is a safety net against accidents and casual prompt injection, not a sandbox: code run
// through an interpreter (`node -e`, `python -c`) is not inspected. Isolation comes from running
// the pipeline in CI or a container.
// ---------------------------------------------------------------------------------------------

const MAX_COMMAND = 100_000;
const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n'];

/** Split a shell string into words and operators. Quotes are removed; `$VAR` text is kept literally. */
export function tokenize(input) {
  const tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  const push = () => {
    if (has) tokens.push({ word: cur });
    cur = '';
    has = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      if (input[i + 1] !== '\n') {
        cur += input[i + 1];
        has = true;
      }
      i++;
      continue;
    }
    if (ch === '#' && !has) {
      while (i < input.length && input[i] !== '\n') i++;
      i--;
      continue;
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op) {
      push();
      tokens.push({ op });
      i += op.length - 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '`') {
      push();
      continue;
    }
    cur += ch;
    has = true;
  }
  push();
  return tokens;
}

/** Group tokens into simple commands: [{ words, pipeTo }] where pipeTo is the next command in a pipe. */
function simpleCommands(tokens) {
  const cmds = [];
  let words = [];
  for (const t of tokens) {
    if (t.word !== undefined) {
      words.push(t.word);
      continue;
    }
    cmds.push({ words, op: t.op });
    words = [];
  }
  cmds.push({ words, op: null });
  return cmds.filter((c) => c.words.length).map((c, i, all) => ({ ...c, next: all[i + 1] }));
}

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'exec', 'time', 'nohup', 'nice', 'xargs', 'builtin']);

/** Drop wrappers (sudo, env FOO=1, nice …) and leading VAR=value assignments. */
function unwrap(words) {
  let w = [...words];
  for (;;) {
    if (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    else if (w[0] === 'env') {
      w = w.slice(1);
      while (w.length && (w[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w = w.slice(1);
    } else if (WRAPPERS.has(w[0])) {
      w = w.slice(1);
      while (w.length && w[0].startsWith('-')) w = w.slice(w[0] === '-u' || w[0] === '-n' ? 2 : 1);
    } else return w;
  }
}

const baseName = (p) => String(p).split('/').pop();
const shortFlags = (args) => args.filter((a) => /^-[A-Za-z]+$/.test(a)).join('');
const PROTECTED_BRANCHES = /^(main|master|production|prod|release|trunk)$/;
const DANGEROUS_RM_TARGETS = new Set([
  '/',
  '/*',
  '~',
  '~/',
  '~/*',
  '$HOME',
  '${HOME}',
  '$HOME/',
  '${HOME}/',
  '$HOME/*',
  '*',
  '.',
  './',
  '..',
  '../',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const PAGERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'strings', 'xxd', 'od', 'hexdump', 'nl', 'tac']);

/** Strip git's global options (-C dir, -c k=v, --git-dir=…) and return [subcommand, ...args]. */
function gitArgs(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    i +=
      args[i] === '-C' || args[i] === '-c' || args[i] === '--git-dir' || args[i] === '--work-tree' || args[i] === '--namespace'
        ? 2
        : 1;
  }
  return args.slice(i);
}

function checkGit(args, hit) {
  const [sub, ...rest] = gitArgs(args);
  const flags = shortFlags(rest);
  if (sub === 'push') {
    const positional = rest.filter((a) => !a.startsWith('-'));
    const refspecs = positional.slice(1);
    if (rest.includes('--force') || /f/.test(flags) || refspecs.some((r) => r.startsWith('+')) || rest.includes('--mirror')) {
      hit('force-push', 'force push rewrites shared history (use --force-with-lease on your own branch)');
    }
    const dest = (r) =>
      r
        .replace(/^\+/, '')
        .split(':')
        .pop()
        .replace(/^refs\/heads\//, '');
    if (refspecs.some((r) => PROTECTED_BRANCHES.test(dest(r))) || rest.includes('--all')) {
      hit('push-protected', 'direct push to a protected branch; open a pull request instead');
    }
  }
  if ((sub === 'reset' && rest.includes('--hard')) || (sub === 'clean' && (/f/.test(flags) || rest.includes('--force')))) {
    hit('reset-hard', 'discards uncommitted work irrecoverably');
  }
  if (
    (sub === 'commit' || sub === 'push' || sub === 'merge' || sub === 'rebase') &&
    (rest.includes('--no-verify') || (sub === 'commit' && /n/.test(flags)))
  ) {
    hit('no-verify', 'skips commit/push hooks');
  }
  if (sub === 'checkout' && rest.includes('--') && rest.includes('.') && rest.length <= 3) {
    // `git checkout -- .` discards every unstaged change.
    hit('reset-hard', 'discards uncommitted work irrecoverably');
  }
}

function checkSimple(cmd, hit, depth) {
  const words = unwrap(cmd.words);
  if (!words.length) return;
  const name = baseName(words[0]);
  const args = words.slice(1);

  if (name === 'rm') {
    const flags = shortFlags(args);
    const recursive = /[rR]/.test(flags) || args.includes('--recursive');
    const force = /f/.test(flags) || args.includes('--force');
    if (
      recursive &&
      force &&
      args.some((a) => DANGEROUS_RM_TARGETS.has(a) || /^\/(bin|boot|etc|home|lib|opt|root|sbin|srv|usr|var)\/?$/.test(a))
    ) {
      hit('rm-root', 'recursive delete of root, home, the working tree or everything');
    }
  }
  if (name === 'git') checkGit(args, hit);
  if ((name === 'curl' || name === 'wget') && cmd.op === '|' && cmd.next) {
    const target = unwrap(cmd.next.words);
    if (target.length && (SHELLS.has(baseName(target[0])) || /^python[0-9.]*$|^node$|^perl$|^ruby$/.test(baseName(target[0])))) {
      hit('pipe-to-shell', 'piping a download straight into an interpreter');
    }
  }
  if (name === 'chmod' && args.some((a) => /^0?777$|^a\+rwx$/.test(a))) hit('chmod-777', 'world-writable permissions');
  if (PAGERS.has(name) && args.some((a) => !a.startsWith('-') && isEnvFile(baseName(a)))) {
    hit('read-env', 'printing an env file exposes secrets to the transcript');
  }
  if (/^mkfs/.test(name) || (name === 'dd' && args.some((a) => /^of=\/dev\//.test(a))))
    hit('disk-wipe', 'disk-level destructive operation');

  // Look inside `bash -c "…"` and `eval …` once or twice; deeper nesting is refused outright.
  const inner = SHELLS.has(name) ? args[args.indexOf('-c') + 1] : name === 'eval' ? args.join(' ') : undefined;
  if (inner !== undefined && (SHELLS.has(name) ? args.includes('-c') : true)) {
    if (depth >= 3) hit('nested-shell', 'deeply nested shell invocations are not allowed');
    else for (const c of simpleCommands(tokenize(inner))) checkSimple(c, hit, depth + 1);
  }
}

export function checkCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  if (command.length > MAX_COMMAND) return [{ id: 'too-long', why: `command longer than ${MAX_COMMAND} characters` }];
  const hits = new Map();
  const hit = (id, why) => hits.set(id, { id, why });
  for (const cmd of simpleCommands(tokenize(command))) checkSimple(cmd, hit, 0);
  return [...hits.values()];
}

function isEnvFile(base) {
  return /^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base);
}

/** Files agents must not write. Paths are repo-relative with forward slashes. */
export function isProtectedPath(relPath) {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const lower = p.toLowerCase();
  const base = lower.split('/').pop();
  if (isEnvFile(base) || base === '.envrc') return 'env files hold secrets; edit .env.example instead';
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(base)) {
    return 'key material must not be written by an agent';
  }
  if (['.npmrc', '.pypirc', '.netrc', '.git-credentials', '.dockercfg'].includes(base) || lower.endsWith('.docker/config.json')) {
    return 'credential files must not be written by an agent';
  }
  if (lower === '.git' || lower.startsWith('.git/') || lower.includes('/.git/') || lower.endsWith('/.git'))
    return 'never write inside .git';
  if (/(^|\/)(package-lock\.json|uv\.lock|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|cargo\.lock)$/.test(lower)) {
    return 'lockfiles are generated; run the package manager instead';
  }
  return null;
}
