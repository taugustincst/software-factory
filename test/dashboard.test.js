import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startDashboard } from '../src/dashboard/server.js';
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
