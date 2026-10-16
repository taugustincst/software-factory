import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

let app: FastifyInstance | undefined;
const make = (opts?: { clientDir?: string }) => (app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }), opts));
afterEach(async () => {
  await app?.close();
});

describe('api', () => {
  it('health check', async () => {
    const res = await make().inject({ method: 'GET', url: '/api/healthz' });
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('task lifecycle', async () => {
    const a = make();
    const created = await a.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Synthetic task' } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ data: { id: string } }>().data;
    expect((await a.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { done: true } })).json()).toMatchObject({
      data: { done: true },
    });
    expect((await a.inject({ method: 'GET', url: '/api/tasks' })).json<{ data: unknown[] }>().data).toHaveLength(1);
    expect((await a.inject({ method: 'DELETE', url: `/api/tasks/${id}` })).statusCode).toBe(204);
    expect((await a.inject({ method: 'GET', url: `/api/tasks/${id}` })).statusCode).toBe(404);
  });

  it('validates input', async () => {
    const a = make();
    expect((await a.inject({ method: 'POST', url: '/api/tasks', payload: { title: '' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/tasks/nope' })).statusCode).toBe(400);
    const id = crypto.randomUUID();
    expect((await a.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { done: true } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'DELETE', url: `/api/tasks/${id}` })).statusCode).toBe(404);
  });

  it('hides internals on unexpected errors', async () => {
    const a = make();
    a.get('/api/boom', () => {
      throw new Error('internals');
    });
    expect((await a.inject({ method: 'GET', url: '/api/boom' })).json()).toEqual({ error: 'internal_error' });
  });

  it('serves the client with SPA fallback but 404s unknown API routes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'client-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
    const a = make({ clientDir: dir });
    expect((await a.inject({ method: 'GET', url: '/some/client/route' })).body).toContain('<title>app</title>');
    expect((await a.inject({ method: 'GET', url: '/api/missing' })).statusCode).toBe(404);
  });
});

describe('config', () => {
  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });
});
