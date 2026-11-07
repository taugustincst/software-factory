import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run, tail } from '../util.js';
import { resolveInside, assertNotSymlink, readText, sandboxError } from './sandbox.js';
import { writeRefusal, deriveScope, CAPABILITIES } from './scopes.js';
import { randomBytes } from 'node:crypto';

const READ_MAX = 2 * 1024 * 1024;
const WRITE_MAX = 1024 * 1024;
const LIST_MAX = 2000;
const MATCH_MAX = 200;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const REF_RE = /^(?!-)[\w./~^@{}-]{1,200}$/;
// Agents may push and open PRs only for the factory's own branches, never main or a release branch.
const FACTORY_BRANCH_RE = /^factory\/[a-z0-9][a-z0-9._-]{0,80}$/;

const str = (extra = {}) => ({ type: 'string', ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** Convert a simple glob (`*`, `**`, `?`) to a RegExp over POSIX paths. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

async function* walk(rootAbs, startAbs) {
  const stack = [startAbs];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) yield path.relative(rootAbs, abs).split(path.sep).join('/');
    }
  }
}

const git = async (h, args) => {
  const r = await run(['git', ...args], { cwd: h.root, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (exit ${r.code}): ${tail(r.stderr, 1500)}`);
  return r.stdout;
};

/**
 * The tool registry. Each tool: name, description, capability, inputSchema, handler(h, input).
 * `h` is the harness instance: { root, scope, commands, execAllowed }.
 */
export const TOOLS = [
  {
    name: 'read_file',
    capability: 'read',
    description: 'Read a UTF-8 text file in the repository. Returns numbered lines. Optional 1-based line offset and limit.',
    inputSchema: obj(
      {
        path: str({ maxLength: 1024 }),
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 5000 },
      },
      ['path'],
    ),
    async handler(h, { path: p, offset = 1, limit = 2000 }) {
      const { abs } = resolveInside(h.root, p);
      const lines = (await readText(abs, READ_MAX)).split('\n');
      return lines
        .slice(offset - 1, offset - 1 + limit)
        .map((l, i) => `${offset + i}\t${l}`)
        .join('\n');
    },
  },
  {
    name: 'list_files',
    capability: 'read',
    description: 'List files under a folder (default the repository root), optionally filtered by a glob such as "src/**/*.js".',
    inputSchema: obj({ path: str({ maxLength: 1024 }), pattern: str({ maxLength: 300 }) }),
    async handler(h, { path: p = '.', pattern }) {
      const { abs } = resolveInside(h.root, p);
      const rootAbs = resolveInside(h.root, '.').abs;
      const re = pattern ? globToRegExp(pattern) : null;
      const out = [];
      for await (const rel of walk(rootAbs, abs)) {
        if (re && !re.test(rel)) continue;
        out.push(rel);
        if (out.length >= LIST_MAX) {
          out.push(`… (stopped at ${LIST_MAX} entries)`);
          break;
        }
      }
      return out.join('\n') || '(no files)';
    },
  },
  {
    name: 'search',
    capability: 'read',
    description:
      'Search text files for a JavaScript regular expression. Returns path:line: text. Optional folder and glob filter.',
    inputSchema: obj(
      { pattern: str({ minLength: 1, maxLength: 500 }), path: str({ maxLength: 1024 }), glob: str({ maxLength: 300 }) },
      ['pattern'],
    ),
    async handler(h, { pattern, path: p = '.', glob }) {
      let re;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        throw sandboxError(`invalid regular expression: ${err.message}`);
      }
      const { abs } = resolveInside(h.root, p);
      const rootAbs = resolveInside(h.root, '.').abs;
      const g = glob ? globToRegExp(glob) : null;
      const out = [];
      for await (const rel of walk(rootAbs, abs)) {
        if (g && !g.test(rel)) continue;
        let text;
        try {
          text = await readText(path.join(rootAbs, rel), READ_MAX);
        } catch {
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
            if (out.length >= MATCH_MAX) return `${out.join('\n')}\n… (stopped at ${MATCH_MAX} matches)`;
          }
        }
      }
      return out.join('\n') || '(no matches)';
    },
  },
  {
    name: 'write_file',
    capability: 'write',
    description: 'Create or overwrite a text file (parent folders are created). Confined to the paths this role may write.',
    inputSchema: obj({ path: str({ maxLength: 1024 }), content: str({ maxLength: WRITE_MAX }) }, ['path', 'content']),
    async handler(h, { path: p, content }) {
      const { abs, rel } = resolveInside(h.root, p);
      const why = writeRefusal(h.scope, rel);
      if (why) throw sandboxError(why);
      assertNotSymlink(abs);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
      return `wrote ${rel} (${Buffer.byteLength(content)} bytes)`;
    },
  },
  {
    name: 'edit_file',
    capability: 'write',
    description: 'Replace exact text in a file. `old` must occur exactly once unless replaceAll is true.',
    inputSchema: obj(
      {
        path: str({ maxLength: 1024 }),
        old: str({ minLength: 1, maxLength: WRITE_MAX }),
        new: str({ maxLength: WRITE_MAX }),
        replaceAll: { type: 'boolean' },
      },
      ['path', 'old', 'new'],
    ),
    async handler(h, { path: p, old, new: next, replaceAll = false }) {
      const { abs, rel } = resolveInside(h.root, p);
      const why = writeRefusal(h.scope, rel);
      if (why) throw sandboxError(why);
      assertNotSymlink(abs);
      const text = await readText(abs, WRITE_MAX);
      const count = text.split(old).length - 1;
      if (count === 0) throw sandboxError('old text not found');
      if (count > 1 && !replaceAll) throw sandboxError(`old text occurs ${count} times; make it unique or pass replaceAll`);
      await fs.writeFile(abs, replaceAll ? text.split(old).join(next) : text.replace(old, () => next));
      return `edited ${rel} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? 's' : ''})`;
    },
  },
  {
    name: 'run_command',
    capability: 'exec',
    description:
      'Run one of the project commands from factory.json by name (e.g. "test", "lint"). Returns exit code and output tail.',
    inputSchema: obj({ name: str({ pattern: '^[a-z][a-z0-9-]{0,39}$' }) }, ['name']),
    async handler(h, { name }) {
      if (!h.execAllowed.includes(name))
        throw sandboxError(`command "${name}" is not exec-able; allowed: ${h.execAllowed.join(', ') || 'none'}`);
      const cmd = h.commands[name];
      if (!cmd) throw sandboxError(`factory.json has no "${name}" command`);
      const r = await run(cmd, { cwd: h.root, timeoutMs: h.commandTimeoutMs });
      return `$ ${cmd}\nexit ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${tail(`${r.stdout}\n${r.stderr}`, 12000)}`;
    },
  },
  {
    name: 'git_status',
    capability: 'git-read',
    description: 'Show the working tree status (porcelain, including untracked files).',
    inputSchema: obj({}),
    handler: async (h) => (await git(h, ['status', '--porcelain=v1', '--untracked-files=all'])) || '(clean)',
  },
  {
    name: 'git_diff',
    capability: 'git-read',
    description: 'Show a diff: working tree vs HEAD by default, staged changes with staged=true, or against a base ref.',
    inputSchema: obj({ staged: { type: 'boolean' }, path: str({ maxLength: 1024 }), base: str({ maxLength: 200 }) }),
    async handler(h, { staged = false, path: p, base }) {
      const args = ['diff', '--no-color', '--no-ext-diff'];
      if (staged) args.push('--cached');
      if (base) {
        if (!REF_RE.test(base)) throw sandboxError(`not a ref name: ${base}`);
        args.push(base);
      }
      args.push('--');
      if (p) args.push(resolveInside(h.root, p).rel);
      return tail(await git(h, args), 60000) || '(no differences)';
    },
  },
  {
    name: 'git_log',
    capability: 'git-read',
    description: 'Recent commits, one line each.',
    inputSchema: obj({ n: { type: 'integer', minimum: 1, maximum: 100 } }),
    handler: async (h, { n = 20 }) => (await git(h, ['log', '--oneline', '--no-color', `-n${n}`])) || '(no commits)',
  },
  {
    name: 'git_commit',
    capability: 'git-write',
    description: 'Commit the listed paths (only those) with a message. Never amends, never skips hooks.',
    inputSchema: obj(
      {
        message: str({ minLength: 3, maxLength: 5000 }),
        paths: { type: 'array', minItems: 1, maxItems: 500, items: str({ maxLength: 1024 }) },
      },
      ['message', 'paths'],
    ),
    async handler(h, { message, paths }) {
      const rels = paths.map((p) => resolveInside(h.root, p).rel);
      await git(h, ['add', '-A', '--', ...rels]);
      await git(h, ['commit', '-m', message, '--', ...rels]);
      return (await git(h, ['log', '--oneline', '-n1'])).trim();
    },
  },
  {
    name: 'git_push',
    capability: 'pr',
    description: 'Push a factory/ branch to origin (sets upstream). Other branches, force pushes and tags are refused.',
    inputSchema: obj({ branch: str({ maxLength: 100 }) }, ['branch']),
    async handler(h, { branch }) {
      if (!FACTORY_BRANCH_RE.test(branch)) throw sandboxError(`only factory/ branches can be pushed, not "${branch}"`);
      await git(h, ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
      return `pushed ${branch} to origin`;
    },
  },
  {
    name: 'open_pr',
    capability: 'pr',
    description: 'Open a pull request from a pushed factory/ branch (gh pr create). Returns the PR URL.',
    inputSchema: obj(
      {
        title: str({ minLength: 3, maxLength: 256 }),
        body: str({ maxLength: 60000 }),
        head: str({ maxLength: 100 }),
        base: str({ maxLength: 100 }),
        draft: { type: 'boolean' },
      },
      ['title', 'body', 'head'],
    ),
    async handler(h, { title, body, head, base, draft = false }) {
      if (!FACTORY_BRANCH_RE.test(head)) throw sandboxError(`pull requests come only from factory/ branches, not "${head}"`);
      if (base !== undefined && !REF_RE.test(base)) throw sandboxError(`not a branch name: ${base}`);
      // The body travels by file (never argv), from the harness's own state folder.
      const dir = path.join(h.root, '.factory', 'harness');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `pr-${randomBytes(4).toString('hex')}.md`);
      await fs.writeFile(file, body);
      const args = ['pr', 'create', '--title', title, '--body-file', file, '--head', head];
      if (base) args.push('--base', base);
      if (draft) args.push('--draft');
      const r = await run([h.ghBin, ...args], { cwd: h.root, timeoutMs: 120_000 });
      await fs.rm(file, { force: true });
      if (r.code !== 0) throw new Error(`gh pr create failed (exit ${r.code}): ${tail(r.stderr, 1500)}`);
      const url = r.stdout.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
      if (!url) throw new Error(`gh pr create printed no PR URL: ${tail(r.stdout, 500)}`);
      return url;
    },
  },
  {
    name: 'spawn_subagent',
    capability: 'spawn',
    description:
      'Hand a self-contained subtask to a sub-agent. It gets your scope or a narrower one (capabilities, writeRoots), ' +
      'never more, and a slice of your budget. Returns its summary. Use for focused work: research a module, write one test file.',
    inputSchema: obj(
      {
        task: str({ minLength: 10, maxLength: 8000 }),
        capabilities: { type: 'array', maxItems: CAPABILITIES.length, items: str({ maxLength: 20 }) },
        writeRoots: { type: 'array', maxItems: 20, items: str({ maxLength: 300 }) },
        budgetUsd: { type: 'number' },
      },
      ['task'],
    ),
    async handler(h, { task, capabilities, writeRoots, budgetUsd }) {
      if (!h.spawner) throw sandboxError('sub-agents are not available in this context');
      if (h.depth >= h.maxDepth) throw sandboxError(`sub-agents may nest only ${h.maxDepth} level(s) deep`);
      const remaining = h.budget.remainingUsd;
      if (!(remaining > 0)) throw sandboxError('no sub-agent budget left in this stage');
      const slice = Math.min(typeof budgetUsd === 'number' && budgetUsd > 0 ? budgetUsd : remaining / 2, remaining);
      const scope = deriveScope(h.scope, {
        role: `${h.scope.role}/sub`,
        capabilities: (capabilities ?? h.scope.capabilities).filter((c) => c !== 'spawn' || h.depth + 1 < h.maxDepth),
        ...(writeRoots ? { writeRoots: writeRoots.map((r) => String(r).replace(/\\/g, '/').replace(/\/+$/, '')) } : {}),
      });
      const r = await h.spawner({ scope, task, budgetUsd: Math.round(slice * 100) / 100, depth: h.depth + 1 });
      const cost = Math.max(0, Number(r.costUsd) || 0);
      h.budget.remainingUsd = Math.max(0, remaining - cost);
      return {
        text: `${r.ok ? 'sub-agent finished' : `sub-agent failed: ${r.error ?? 'unknown error'}`} (role ${scope.role}, $${cost.toFixed(2)})\n${r.summary ?? ''}`.trim(),
        costUsd: cost,
      };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
