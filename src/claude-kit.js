import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { KIT_DIR } from './util.js';

const IMPORT_LINE = '@.claude/FACTORY.md';

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Merge two Claude Code settings objects: union permission lists, append hooks without duplicates. */
export function mergeSettings(existing, incoming) {
  const out = structuredClone(existing ?? {});
  for (const key of ['allow', 'deny', 'ask']) {
    const a = existing?.permissions?.[key] ?? [];
    const b = incoming?.permissions?.[key] ?? [];
    if (a.length || b.length) {
      out.permissions ??= {};
      out.permissions[key] = [...new Set([...a, ...b])];
    }
  }
  for (const [event, groups] of Object.entries(incoming?.hooks ?? {})) {
    out.hooks ??= {};
    const current = out.hooks[event] ?? [];
    const known = new Set(current.flatMap((g) => (g.hooks ?? []).map((h) => h.command)));
    for (const group of groups) {
      const fresh = (group.hooks ?? []).filter((h) => !known.has(h.command));
      if (fresh.length) current.push({ ...group, hooks: fresh });
    }
    out.hooks[event] = current;
  }
  if (incoming?.$schema && !out.$schema) out.$schema = incoming.$schema;
  return out;
}

/**
 * Install the Claude Code kit (.claude/ agents, commands, skills, hooks, settings) into a repo.
 * Existing files are kept unless `force`; settings.json is merged; CLAUDE.md gets an import line.
 * Returns { written, skipped, merged }.
 */
export async function installClaudeKit(targetDir, { force = false, projectName } = {}) {
  const srcRoot = path.join(KIT_DIR, '.claude');
  const dstRoot = path.join(targetDir, '.claude');
  const result = { written: [], skipped: [], merged: [] };

  for await (const src of walk(srcRoot)) {
    const rel = path.relative(srcRoot, src);
    const dst = path.join(dstRoot, rel);
    const relOut = path.join('.claude', rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });

    if (rel === 'settings.json' && existsSync(dst) && !force) {
      const existing = JSON.parse(await fs.readFile(dst, 'utf8'));
      const incoming = JSON.parse(await fs.readFile(src, 'utf8'));
      await fs.writeFile(dst, `${JSON.stringify(mergeSettings(existing, incoming), null, 2)}\n`);
      result.merged.push(relOut);
      continue;
    }
    if (existsSync(dst) && !force) {
      result.skipped.push(relOut);
      continue;
    }
    await fs.copyFile(src, dst);
    if (src.endsWith('.mjs')) await fs.chmod(dst, 0o755);
    result.written.push(relOut);
  }

  const claudeMd = path.join(targetDir, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    const title = projectName ?? path.basename(path.resolve(targetDir));
    await fs.writeFile(
      claudeMd,
      `# ${title}\n\nProject notes for Claude. Add architecture, domain terms and gotchas here.\n\n${IMPORT_LINE}\n`,
    );
    result.written.push('CLAUDE.md');
  } else {
    const text = await fs.readFile(claudeMd, 'utf8');
    if (!text.includes(IMPORT_LINE)) {
      await fs.appendFile(claudeMd, `\n${IMPORT_LINE}\n`);
      result.merged.push('CLAUDE.md');
    } else {
      result.skipped.push('CLAUDE.md');
    }
  }
  return result;
}
