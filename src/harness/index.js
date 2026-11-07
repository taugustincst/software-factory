import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanText } from '../../claude-kit/.claude/hooks/lib/patterns.mjs';
import { TOOLS } from './tools.js';
import { scopeFor, allows } from './scopes.js';

export { scopeFor, deriveScope, writeRefusal, ROLES, STAGE_ROLES } from './scopes.js';
export { TOOLS, TOOL_NAMES } from './tools.js';

export const DEFAULT_EXEC = ['lint', 'typecheck', 'test', 'build', 'coverage'];

/** Validate `value` against the small JSON Schema subset the tools use. Returns an error string or null. */
export function validateInput(schema, value, at = 'input') {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${at} must be an object`;
    for (const k of schema.required ?? []) if (!(k in value)) return `${at}.${k} is required`;
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (!sub) {
        if (schema.additionalProperties === false) return `${at}.${k} is not a known field`;
        continue;
      }
      const err = validateInput(sub, v, `${at}.${k}`);
      if (err) return err;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${at} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${at} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at} is too long`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${at} has an invalid format`;
    if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`;
    return null;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${at} must be an integer`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} is below ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} is above ${schema.maximum}`;
    return null;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${at} must be a boolean`;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${at} needs at least ${schema.minItems} items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items`;
    for (let i = 0; i < value.length; i++) {
      const err = validateInput(schema.items, value[i], `${at}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  return null;
}

const CONTENT_KEYS = new Set(['content', 'old', 'new']);

/** Audit-safe copy of a tool input: content fields become length+hash, secrets are redacted. */
export function auditInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === 'string' && (CONTENT_KEYS.has(k) || v.length > 300)) {
      out[k] = `<${Buffer.byteLength(v)} bytes sha1:${createHash('sha1').update(v).digest('hex').slice(0, 12)}>`;
    } else if (typeof v === 'string') {
      const found = scanText(v);
      out[k] = found.length ? `[redacted: ${found.map((f) => f.id).join(', ')}]` : v;
    } else out[k] = v;
  }
  return out;
}

/**
 * Create a harness bound to one repository and one role.
 *   root       repository root (the sandbox)
 *   role/scope role name (scope derived) or an explicit scope (e.g. from deriveScope)
 *   commands   factory.json commands, for run_command
 *   exec       names run_command may run (default DEFAULT_EXEC)
 *   auditFile  JSONL file every call is appended to (null = no audit)
 * Returns { scope, tools, call(name, input) → { ok, text } , stats() }.
 */
export function createHarness({
  root,
  role,
  scope,
  artifactDir = null,
  commands = {},
  exec = DEFAULT_EXEC,
  auditFile = null,
  commandTimeoutMs = 15 * 60_000,
}) {
  const s = scope ?? scopeFor(role, { artifactDir });
  const tools = TOOLS.filter((t) => allows(s, t.capability));
  const h = { root: path.resolve(root), scope: s, commands, execAllowed: exec, commandTimeoutMs };
  const counts = { calls: 0, refused: 0 };

  async function audit(entry) {
    if (!auditFile) return;
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.appendFile(auditFile, `${JSON.stringify(entry)}\n`);
  }

  async function call(name, input = {}) {
    const started = Date.now();
    counts.calls++;
    const tool = TOOLS.find((t) => t.name === name);
    let result;
    if (!tool) result = { ok: false, text: `unknown tool: ${name}`, refused: true };
    else if (!allows(s, tool.capability))
      result = { ok: false, text: `role ${s.role} may not use ${name} (needs ${tool.capability})`, refused: true };
    else {
      const err = validateInput(tool.inputSchema, input);
      if (err) result = { ok: false, text: err, refused: true };
      else {
        try {
          result = { ok: true, text: String(await tool.handler(h, input)) };
        } catch (e) {
          result = { ok: false, text: e.message, refused: e.code === 'SANDBOX' };
        }
      }
    }
    if (result.refused) counts.refused++;
    await audit({
      at: new Date().toISOString(),
      role: s.role,
      tool: name,
      ok: result.ok,
      refused: Boolean(result.refused),
      ms: Date.now() - started,
      input: auditInput(input),
      error: result.ok ? null : result.text.slice(0, 500),
    });
    return result;
  }

  return { scope: s, tools, call, stats: () => ({ ...counts }) };
}

/** Summarize a harness audit file: { calls, refused, byTool: {name: n}, refusedBy: {"role:tool": n} }. */
export function summarizeAudit(file) {
  const out = { calls: 0, refused: 0, byTool: {}, refusedBy: {} };
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    out.calls++;
    out.byTool[e.tool] = (out.byTool[e.tool] ?? 0) + 1;
    if (e.refused) {
      out.refused++;
      const k = `${e.role}:${e.tool}`;
      out.refusedBy[k] = (out.refusedBy[k] ?? 0) + 1;
    }
  }
  return out;
}
