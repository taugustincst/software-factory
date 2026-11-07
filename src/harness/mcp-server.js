#!/usr/bin/env node
/**
 * The harness as an MCP server (stdio, newline-delimited JSON-RPC 2.0), so Claude Code
 * agents call the factory's own scoped, audited tools. Zero dependencies.
 *
 *   node src/harness/mcp-server.js --config <file.json>
 *
 * The config file (written by the executor, never built from agent input) holds:
 *   { root, role, scope?, artifactDir?, commands, exec, auditFile }
 * Only tools the role's scope allows are listed; calls outside it are refused and audited.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHarness } from './index.js';

export const PROTOCOL_VERSION = '2025-06-18';

/** Handle one JSON-RPC message; returns the response object, or null for notifications. */
export async function handleMessage(harness, msg, { name = 'factory', version = '0' } = {}) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
        instructions: `Factory harness, role "${harness.scope.role}". Paths are repo-relative. Every call is audited.`,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: harness.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const r = await harness.call(msg.params?.name, msg.params?.arguments ?? {});
      return reply({ content: [{ type: 'text', text: r.text }], isError: !r.ok });
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

export function serve(harness, { input = process.stdin, output = process.stdout, info } = {}) {
  let buffer = '';
  let chain = Promise.resolve();
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      // Calls run one at a time, in order: tools touch the same working tree.
      chain = chain.then(async () => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
          return;
        }
        const res = await handleMessage(harness, msg, info).catch((e) => ({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          error: { code: -32603, message: e.message },
        }));
        if (res) output.write(`${JSON.stringify(res)}\n`);
      });
    }
  });
  return new Promise((resolve) => input.on('end', () => chain.then(resolve)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--config');
  if (i < 0 || !process.argv[i + 1]) {
    process.stderr.write('usage: mcp-server.js --config <file.json>\n');
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'));
  const harness = createHarness(cfg);
  await serve(harness, { info: { name: 'factory', version: cfg.version ?? '0' } });
}
