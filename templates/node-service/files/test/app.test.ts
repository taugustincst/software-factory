import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }));
});
afterEach(async () => {
  await app.close();
});

describe('health', () => {
  it('reports ok with security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reports ready', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.json()).toEqual({ status: 'ready' });
  });
});

describe('tasks', () => {
  const create = (body: unknown) => app.inject({ method: 'POST', url: '/v1/tasks', payload: body as object });

  it('creates, reads, updates and deletes a task', async () => {
    const created = await create({ title: 'Call back patient SYN-000123' });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ data: { id: string } }>().data;

    const read = await app.inject({ method: 'GET', url: `/v1/tasks/${id}` });
    expect(read.json()).toMatchObject({ data: { id, done: false } });

    const updated = await app.inject({ method: 'PATCH', url: `/v1/tasks/${id}`, payload: { done: true } });
    expect(updated.json()).toMatchObject({ data: { done: true } });

    const list = await app.inject({ method: 'GET', url: '/v1/tasks' });
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(1);

    expect((await app.inject({ method: 'DELETE', url: `/v1/tasks/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/tasks/${id}` })).statusCode).toBe(404);
  });

  it('rejects an empty title', async () => {
    const res = await create({ title: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed' });
  });

  it('rejects unknown fields', async () => {
    const res = await create({ title: 'ok', admin: true });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed id', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tasks/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown ids on update and delete', async () => {
    const id = crypto.randomUUID();
    expect((await app.inject({ method: 'PATCH', url: `/v1/tasks/${id}`, payload: { done: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/tasks/${id}` })).statusCode).toBe(404);
  });

  it('returns a generic error for unexpected failures', async () => {
    app.get('/boom', () => {
      throw new Error('secret internals');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
  });
});
