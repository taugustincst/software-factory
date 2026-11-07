import http from 'node:http';
import { promises as fs, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../util.js';
import { listRuns, readRun, readLog, newRunId, RUN_ID_RE, LOG_NAME_RE } from '../pipeline/store.js';
import { liveRunLock } from '../pipeline/lock.js';
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

// A bare hostname, IPv4 address, or bracketed IPv6 address, optionally with :port.
const HOST_RE =
  /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/i;
const BIND_RE = /^(?:[0-9a-f:.]+|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The Host headers (and Origins) the dashboard accepts. Always the two local names on
 * `port`; plus each explicitly allowed host. An allowed host with no port gets `port`.
 * Entries are lowercased because Host matching is case-insensitive.
 */
export function resolveAllowedHosts(port, allowHosts = []) {
  const set = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  for (const raw of allowHosts) {
    const h = String(raw).trim().toLowerCase();
    const m = HOST_RE.exec(h);
    if (!m) throw new Error(`--allow-host "${raw}" is not a host or host:port`);
    if (m[1] !== undefined && (Number(m[1]) < 1 || Number(m[1]) > 65535))
      throw new Error(`--allow-host "${raw}" has an invalid port`);
    set.add(m[1] === undefined ? `${h}:${port}` : h);
  }
  return set;
}

/**
 * Resolve the bind address and extra allowed hosts from CLI flags, falling back to
 * FACTORY_DASHBOARD_HOST / FACTORY_DASHBOARD_ALLOW_HOST (comma-separated). Flags win.
 */
export function dashboardNetwork({ host, allowHost } = {}, env = {}) {
  const list = allowHost?.length ? allowHost : [env.FACTORY_DASHBOARD_ALLOW_HOST ?? ''];
  return {
    host: host ?? (env.FACTORY_DASHBOARD_HOST || '127.0.0.1'),
    allowHosts: list
      .flatMap((h) => String(h).split(','))
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

/**
 * Validate the bind address. Loopback needs nothing else; any other address needs at
 * least one --allow-host, so exposing the server is always a deliberate, named choice.
 */
export function checkBindHost(host, allowHosts = []) {
  if (!BIND_RE.test(host)) throw new Error(`--host "${host}" is not an address`);
  if (!LOOPBACK.has(host.toLowerCase()) && allowHosts.length === 0)
    throw new Error(`--host ${host} is not loopback: also pass --allow-host <name[:port]> for the address you will open`);
}

/**
 * Dashboard server. By default it binds to 127.0.0.1 and is local-only. It rejects
 * Host headers outside the allow list (DNS rebinding) and cross-origin POSTs (CSRF),
 * because starting a run executes agents in the repo. `allowHosts` opts specific
 * extra names in (e.g. a Tailscale address); the same checks apply to them.
 */
export function createDashboard({ dir, port, allowHosts = [], spawnRun = defaultSpawnRun, signalRun = defaultSignalRun }) {
  const allowedHosts = resolveAllowedHosts(port, allowHosts);
  const hostAllowed = (h) => allowedHosts.has(String(h ?? '').toLowerCase());
  const originAllowed = (o) => {
    if (!o) return false;
    const m = /^https?:\/\/([^/]+)$/i.exec(o);
    return m !== null && hostAllowed(m[1]);
  };

  return http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host)) return send(res, 421, { error: 'unexpected Host header' });
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
        if (!RUN_ID_RE.test(parts[2]) || (parts[4] !== 'launcher.txt' && !LOG_NAME_RE.test(parts[4])))
          return send(res, 400, { error: 'bad path' });
        const text = await readLog(dir, parts[2], parts[4]);
        return text === null ? send(res, 404, { error: 'not found' }) : send(res, 200, text, 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const origin = req.headers.origin;
        if (!originAllowed(origin)) return send(res, 403, { error: 'cross-origin request refused' });
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
          return send(res, 415, { error: 'use application/json' });
        const body = await readJson(req);
        const request = typeof body.request === 'string' ? body.request.trim() : '';
        if (request.length < 10 || request.length > 20000)
          return send(res, 400, { error: 'request must be 10-20000 characters' });
        const executor = body.executor === 'mock' ? 'mock' : 'claude';
        // One run at a time per repo: refuse while a live run holds the lock
        // (stale locks do not count — runPipeline clears them on acquisition).
        // The check races with the detached child actually starting, but the
        // child's own lock acquisition in runPipeline is the backstop.
        const holder = await liveRunLock(dir);
        if (holder)
          return send(res, 409, { error: `a factory run is already in progress: run ${holder.runId} (pid ${holder.pid})` });
        const id = newRunId();
        spawnRun({ dir, id, request, executor, ship: body.ship === true });
        return send(res, 202, { id });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'cancel' && parts.length === 4) {
        if (!RUN_ID_RE.test(parts[2])) return send(res, 400, { error: 'bad run id' });
        const origin = req.headers.origin;
        if (!originAllowed(origin)) return send(res, 403, { error: 'cross-origin request refused' });
        const result = await signalRun({ dir, id: parts[2] });
        return send(res, result.status, result.body);
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' });
    }
  });
}

/**
 * Cancel a running run: SIGTERM to the process holding the repo lock for this
 * run id. The CLI turns that into a cooperative abort (state saved as
 * 'cancelled', lock released); nothing here edits run state directly.
 */
async function defaultSignalRun({ dir, id }) {
  const run = await readRun(dir, id);
  if (!run) return { status: 404, body: { error: 'not found' } };
  if (run.status !== 'running') return { status: 409, body: { error: `run is ${run.status}, not running` } };
  const holder = await liveRunLock(dir);
  if (!holder || holder.runId !== id) return { status: 409, body: { error: 'no live process holds the lock for this run' } };
  try {
    process.kill(holder.pid, 'SIGTERM');
  } catch {
    return { status: 409, body: { error: 'the run process is already gone' } };
  }
  return { status: 202, body: { id, signalledPid: holder.pid } };
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

export async function startDashboard({ dir, port = 4545, host = '127.0.0.1', allowHosts = [], ...rest }) {
  checkBindHost(host, allowHosts);
  const server = createDashboard({ dir, port, allowHosts, ...rest });
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () =>
      resolve({ server, url: `http://${urlHost}:${port}`, allowedHosts: [...resolveAllowedHosts(port, allowHosts)] }),
    );
  });
}
