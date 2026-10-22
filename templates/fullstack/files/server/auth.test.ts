import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { hashPassword, hashSessionToken, PostgresAuthStore } from './auth.js';
import { loadConfig } from './config.js';
import { createDb, type DbHandle } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { sessions, users } from './db/schema.js';

// Same real-Postgres rule as app.test.ts (server project): CI service container or local Compose DB.
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://app:app@127.0.0.1:5432/app';

let app: FastifyInstance;
let handle: DbHandle;

beforeAll(async () => {
  handle = createDb(databaseUrl);
  await runMigrations(handle);
});

beforeEach(async () => {
  await handle.db.delete(sessions);
  await handle.db.delete(users);
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test', DATABASE_URL: databaseUrl }), {
    authStore: new PostgresAuthStore(handle.db),
  });
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await handle.close();
});

const register = (body: unknown) =>
  app.inject({ method: 'POST', url: '/api/auth/register', payload: body as object });
const login = (body: unknown) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: body as object });

function sessionCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error('missing set-cookie header');
  expect(header).toMatch(/^session=/);
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Lax');
  return header.split(';')[0] ?? header;
}

describe('auth', () => {
  it('registers, sets an httpOnly session cookie, and serves /api/me', async () => {
    const res = await register({ email: 'Clinician@Example.org', password: 'correct horse battery' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ data: { email: 'clinician@example.org', role: 'user' } });
    expect(JSON.stringify(res.json())).not.toContain('password');
    const cookie = sessionCookie(res.headers['set-cookie']);

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ data: { email: 'clinician@example.org', role: 'user' } });
  });

  it('rejects duplicate registration and weak or malformed credentials', async () => {
    await register({ email: 'a@example.org', password: 'long-enough-1' });
    expect((await register({ email: 'a@example.org', password: 'long-enough-1' })).statusCode).toBe(409);
    expect((await register({ email: 'b@example.org', password: 'short' })).statusCode).toBe(400);
    expect((await register({ email: 'not-an-email', password: 'long-enough-1' })).statusCode).toBe(400);
  });

  it('logs in with the right password and rejects the wrong one', async () => {
    await register({ email: 'a@example.org', password: 'long-enough-1' });
    const wrong = await login({ email: 'a@example.org', password: 'wrong-password' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'invalid_credentials' });
    expect((await login({ email: 'ghost@example.org', password: 'long-enough-1' })).statusCode).toBe(401);

    const ok = await login({ email: 'a@example.org', password: 'long-enough-1' });
    expect(ok.statusCode).toBe(200);
    const cookie = sessionCookie(ok.headers['set-cookie']);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('requires auth for /api/me and revokes the session at logout', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const res = await register({ email: 'a@example.org', password: 'long-enough-1' });
    const cookie = sessionCookie(res.headers['set-cookie']);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const store = new PostgresAuthStore(handle.db);
    const user = await store.createUser('old@example.org', await hashPassword('long-enough-1'));
    const config = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test', DATABASE_URL: databaseUrl });
    const token = 'expired-token-value';
    await store.createSession(
      user.id,
      hashSessionToken(config.SESSION_SECRET, token),
      '2000-01-01T00:00:00.000Z',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `session=${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('enforces the admin role on /api/admin', async () => {
    const res = await register({ email: 'user@example.org', password: 'long-enough-1' });
    const userCookie = sessionCookie(res.headers['set-cookie']);
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin', headers: { cookie: userCookie } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin' })).statusCode).toBe(401);

    // Registration always creates role `user`; promote directly in the DB to model an admin.
    const store = new PostgresAuthStore(handle.db);
    const admin = await store.createUser('admin@example.org', await hashPassword('long-enough-1'));
    await handle.db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id));
    const loginRes = await login({ email: 'admin@example.org', password: 'long-enough-1' });
    const adminCookie = sessionCookie(loginRes.headers['set-cookie']);
    const okAdmin = await app.inject({ method: 'GET', url: '/api/admin', headers: { cookie: adminCookie } });
    expect(okAdmin.statusCode).toBe(200);
    expect(okAdmin.json()).toMatchObject({ data: { status: 'admin_ok' } });
  });
});
