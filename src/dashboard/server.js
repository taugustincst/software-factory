import http from 'node:http';
import { promises as fs, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../util.js';
import { listRuns, readRun, readLog, newRunId, RUN_ID_RE, LOG_NAME_RE } from '../pipeline/store.js';
import { loadProject } from '../pipeline/project.js';

const INDEX = path.join(ROOT, 'src', 'dashboard', 'index.html');
const MAX_BODY = 64 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

/**
 * Local-only dashboard. Binds to 127.0.0.1, rejects foreign Host headers (DNS rebinding)
 * and cross-origin POSTs (CSRF), because starting a run executes agents in the repo.
 */
export function createDashboard({ dir, port, spawnRun = defaultSpawnRun }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  return http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, { error: 'unexpected Host header' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, await fs.readFile(INDEX, 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/project') {
        const p = await loadProject(dir);
        return send(res, 200, { name: p.name, template: p.template, commands: p.commands, dir });
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        const runs = await listRuns(dir);
        return send(
          res,
          200,
          runs.map(({ request: _request, events, ...summary }) => ({ ...summary, events: events.slice(-1) })),
        );
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts.length === 3) {
        if (!RUN_ID_RE.test(parts[2])) return send(res, 400, { error: 'bad run id' });
        const r = await readRun(dir, parts[2]);
        return r ? send(res, 200, r) : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'logs' && parts.length === 5) {
        if (!RUN_ID_RE.test(parts[2]) || !LOG_NAME_RE.test(parts[4])) return send(res, 400, { error: 'bad path' });
        const text = await readLog(dir, parts[2], parts[4]);
        return text === null ? send(res, 404, { error: 'not found' }) : send(res, 200, text, 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const origin = req.headers.origin;
        if (!origin || !allowedHosts.has(origin.replace(/^https?:\/\//, '')))
          return send(res, 403, { error: 'cross-origin request refused' });
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
          return send(res, 415, { error: 'use application/json' });
        const body = await readJson(req);
        const request = typeof body.request === 'string' ? body.request.trim() : '';
        if (request.length < 10 || request.length > 20000)
          return send(res, 400, { error: 'request must be 10-20000 characters' });
        const executor = body.executor === 'mock' ? 'mock' : 'claude';
        const id = newRunId();
        spawnRun({ dir, id, request, executor, ship: body.ship === true });
        return send(res, 202, { id });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' });
    }
  });
}

function defaultSpawnRun({ dir, id, request, executor, ship }) {
  // The request goes through a file, never argv: text starting with "-" would be read as a flag.
  const runFolder = path.join(dir, '.factory', 'runs', id);
  mkdirSync(runFolder, { recursive: true });
  const requestFile = path.join(runFolder, 'request.md');
  writeFileSync(requestFile, request);
  const args = [
    path.join(ROOT, 'bin', 'factory.js'),
    'run',
    '--dir',
    dir,
    '--spec',
    requestFile,
    '--executor',
    executor,
    '--run-id',
    id,
  ];
  if (ship) args.push('--ship');
  // Detached so a run survives the dashboard closing; launcher output is kept for debugging.
  const out = openSync(path.join(runFolder, 'launcher.txt'), 'a');
  const child = spawn(process.execPath, args, { cwd: dir, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  closeSync(out);
}

export function startDashboard({ dir, port = 4545, ...rest }) {
  const server = createDashboard({ dir, port, ...rest });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${port}` }));
  });
}
