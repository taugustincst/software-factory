import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startDashboard, resolveAllowedHosts, checkBindHost, dashboardNetwork } from '../src/dashboard/server.js';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { runPipeline } from '../src/pipeline/runner.js';
import { mockExecutor } from '../src/pipeline/executors.js';
import { fixtureRepo } from './helpers.js';

const { dir } = fixtureRepo();
const spawned = [];
const port = 40000 + Math.floor(Math.random() * 20000);
const { server, url } = await startDashboard({ dir, port, spawnRun: (args) => spawned.push(args) });
after(() => server.close());

const state = await runPipeline({
  dir,
  request: '# Demo run\n\nSomething small.',
  executor: mockExecutor(),
  stages: ['spec', 'plan'],
});

test('serves the UI with security headers', async () => {
  const r = await fetch(`${url}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Factory Floor/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('lists runs and returns run detail and logs', async () => {
  const runs = await (await fetch(`${url}/api/runs`)).json();
  assert.equal(runs[0].id, state.id);
  assert.equal(runs[0].request, undefined, 'list omits the request body');
  const detail = await (await fetch(`${url}/api/runs/${state.id}`)).json();
  assert.equal(detail.stages[0].id, 'spec');
  const log = await fetch(`${url}/api/runs/${state.id}/logs/spec-1.log`);
  assert.equal(log.status, 200);
  assert.match(await log.text(), /# prompt/);
});

test('rejects path traversal and malformed ids', async () => {
  assert.equal((await fetch(`${url}/api/runs/${state.id}/logs/..%2F..%2Frun.json`)).status, 400);
  assert.equal((await fetch(`${url}/api/runs/../../etc`)).status, 404);
  assert.equal((await fetch(`${url}/api/runs/not-an-id`)).status, 400);
});

test('rejects foreign Host headers (DNS rebinding)', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/runs', headers: { Host: 'evil.example:80' } }, (res) =>
      resolve(res.statusCode),
    );
  });
  assert.equal(status, 421);
});

test('POST requires same origin and JSON, validates input, then starts a run', async () => {
  const body = JSON.stringify({ request: 'Add a dark mode toggle to settings', executor: 'mock' });
  const post = (headers, b = body) => fetch(`${url}/api/runs`, { method: 'POST', headers, body: b });
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 403, 'no Origin');
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain', Origin: url })).status, 415);
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: url }, '{"request":"hi"}')).status, 400);
  const ok = await post({ 'Content-Type': 'application/json', Origin: url });
  assert.equal(ok.status, 202);
  const { id } = await ok.json();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].id, id);
  assert.equal(spawned[0].executor, 'mock');
  assert.equal(spawned[0].ship, false);
});

test('POST returns 409 while a live run holds the lock, and starts nothing', async () => {
  const lockFile = path.join(dir, '.factory', 'lock');
  mkdirSync(path.dirname(lockFile), { recursive: true });
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, runId: '20261015-101010-aaaa', acquiredAt: new Date().toISOString() }),
  );
  try {
    const before = spawned.length;
    const res = await fetch(`${url}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ request: 'Add a dark mode toggle to settings', executor: 'mock' }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /20261015-101010-aaaa/);
    assert.equal(spawned.length, before, 'no run was spawned');
  } finally {
    rmSync(lockFile, { force: true });
  }
});

test('serves the launcher log for a run, and only that .txt name', async () => {
  const file = path.join(dir, '.factory', 'runs', state.id, 'launcher.txt');
  writeFileSync(file, 'launcher booted the run\n');
  const ok = await fetch(`${url}/api/runs/${state.id}/logs/launcher.txt`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /launcher booted the run/);
  assert.equal((await fetch(`${url}/api/runs/${state.id}/logs/notes.txt`)).status, 400);
});

test('cancel refuses finished or unknown runs (default signaler)', async () => {
  const post = (id) =>
    fetch(`${url}/api/runs/${id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
    });
  assert.equal((await post(state.id)).status, 409, 'a passed run cannot be cancelled');
  assert.equal((await post('20260101-000000-abcd')).status, 404);
  assert.equal((await fetch(`${url}/api/runs/${state.id}/cancel`, { method: 'POST', headers: {} })).status, 403, 'no Origin');
});

test('cancel signals the run process through the injected signaler', async () => {
  const signalled = [];
  const port2 = 40000 + Math.floor(Math.random() * 20000);
  const dash = await startDashboard({
    dir,
    port: port2,
    spawnRun: () => {},
    signalRun: async ({ id }) => {
      signalled.push(id);
      return { status: 202, body: { id, signalledPid: 4242 } };
    },
  });
  try {
    const res = await fetch(`${dash.url}/api/runs/${state.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: dash.url },
    });
    assert.equal(res.status, 202);
    assert.deepEqual(signalled, [state.id]);
  } finally {
    dash.server.close();
  }
});

const getStatus = (p, host, path_ = '/api/runs') =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: p, path: path_, headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });

test('default dashboard binds 127.0.0.1 and accepts only the local names', async () => {
  assert.equal(server.address().address, '127.0.0.1');
  assert.deepEqual([...resolveAllowedHosts(port)], [`127.0.0.1:${port}`, `localhost:${port}`]);
  assert.equal(await getStatus(port, `localhost:${port}`), 200);
  assert.equal(await getStatus(port, `factory.tail1234.ts.net:${port}`), 421, 'a tailnet name is not allowed by default');
  assert.equal(await getStatus(port, `100.64.0.7:${port}`), 421);
});

test('allow-host validation: ports are added, junk is refused', () => {
  const set = resolveAllowedHosts(4545, ['Factory.Tail1234.ts.net', '100.64.0.7:8080', '[fd7a:115c::1]']);
  assert.ok(set.has('factory.tail1234.ts.net:4545'), 'lowercased, default port appended');
  assert.ok(set.has('100.64.0.7:8080'), 'explicit port kept');
  assert.ok(set.has('[fd7a:115c::1]:4545'));
  for (const bad of ['http://x.example', 'a b', 'x.example/path', 'x.example:99999', '*', '-bad.example'])
    assert.throws(() => resolveAllowedHosts(4545, [bad]), /allow-host/, bad);
});

test('a non-loopback bind requires an explicit allow-host', async () => {
  assert.throws(() => checkBindHost('0.0.0.0'), /not loopback/);
  assert.throws(() => checkBindHost('100.64.0.7', []), /--allow-host/);
  assert.doesNotThrow(() => checkBindHost('100.64.0.7', ['100.64.0.7']));
  assert.doesNotThrow(() => checkBindHost('127.0.0.1'));
  assert.doesNotThrow(() => checkBindHost('::1'));
  assert.throws(() => checkBindHost('1.2.3.4;rm'), /not an address/);
  await assert.rejects(startDashboard({ dir, port: 40000 + Math.floor(Math.random() * 20000), host: '0.0.0.0' }), /not loopback/);
});

test('opt-in host: the named host gets reads and same-origin POSTs; others are still refused', async () => {
  const p2 = 40000 + Math.floor(Math.random() * 20000);
  const got = [];
  const name = 'factory.tail1234.ts.net';
  const dash = await startDashboard({ dir, port: p2, allowHosts: [name], spawnRun: (a) => got.push(a) });
  try {
    assert.equal(await getStatus(p2, `${name}:${p2}`), 200);
    assert.equal(await getStatus(p2, `${name.toUpperCase()}:${p2}`), 200, 'Host matching is case-insensitive');
    assert.equal(await getStatus(p2, `evil.example:${p2}`), 421);
    assert.equal(await getStatus(p2, `${name}:1`), 421, 'wrong port is a different origin');
    const post = (origin) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: p2,
            path: '/api/runs',
            method: 'POST',
            headers: { Host: `${name}:${p2}`, Origin: origin, 'Content-Type': 'application/json' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ request: 'Add a dark mode toggle to settings', executor: 'mock' }));
      });
    assert.equal(await post('https://evil.example'), 403);
    assert.equal(await post(`http://${name}.evil.example:${p2}`), 403, 'suffix tricks are refused');
    assert.equal(await post(`http://${name}:${p2}/x`), 403, 'origin with a path is malformed');
    assert.equal(await post('null'), 403);
    assert.equal(await post(`http://${name}:${p2}`), 202);
    assert.equal(got.length, 1);
    const r = await fetch(`${dash.url}/`);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/, 'CSP unchanged');
  } finally {
    dash.server.close();
  }
});

test('flags and env resolve the network settings; flags win, defaults stay local', () => {
  assert.deepEqual(dashboardNetwork({}, {}), { host: '127.0.0.1', allowHosts: [] });
  assert.deepEqual(
    dashboardNetwork({}, { FACTORY_DASHBOARD_HOST: '100.64.0.7', FACTORY_DASHBOARD_ALLOW_HOST: ' a.ts.net, 100.64.0.7 ,' }),
    { host: '100.64.0.7', allowHosts: ['a.ts.net', '100.64.0.7'] },
  );
  assert.deepEqual(
    dashboardNetwork(
      { host: '127.0.0.1', allowHost: ['b.ts.net'] },
      { FACTORY_DASHBOARD_HOST: '0.0.0.0', FACTORY_DASHBOARD_ALLOW_HOST: 'a.ts.net' },
    ),
    { host: '127.0.0.1', allowHosts: ['b.ts.net'] },
  );
  assert.equal(dashboardNetwork({}, { FACTORY_DASHBOARD_HOST: '' }).host, '127.0.0.1', 'empty env is the default');
});

test('UI is mobile-first: viewport, 16px inputs, 44px targets, no hover, no innerHTML', () => {
  const html = readFileSync(path.join(import.meta.dirname, '..', 'src', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(html, /textarea,\s*select \{\s*font: 16px/, 'inputs at 16px so iOS does not zoom');
  assert.match(html, /min-height: 44px;\s*min-width: 44px;/, 'buttons meet 44px');
  assert.doesNotMatch(html, /:hover/, 'nothing depends on hover');
  assert.doesNotMatch(html, /innerHTML/);
  assert.ok(html.indexOf('@media (min-width: 860px)') > html.indexOf('.run-item {'), 'desktop layout is the override');
});
