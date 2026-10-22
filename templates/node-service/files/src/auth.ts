import { createHmac, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { sessions, users } from './db/schema.js';

/**
 * Self-hosted session auth: email + password (argon2id), random session
 * tokens in an httpOnly cookie, sessions stored server-side so they can be
 * revoked at logout. No third-party identity provider. To swap in OIDC
 * later, replace the register/login handlers and keep the session layer.
 */

export const SESSION_COOKIE = 'session';

export type Role = 'admin' | 'user';

export interface PublicUser {
  id: string;
  email: string;
  role: string;
}

interface UserRecord extends PublicUser {
  passwordHash: string;
}

export const credentialsSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'invalid email address'),
    password: z.string().min(8).max(128),
  })
  .strict();

/** Store interface for auth. Postgres is the implementation; routes only see this contract. */
export interface AuthStore {
  createUser(email: string, passwordHash: string): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord | undefined>;
  createSession(userId: string, tokenHash: string, expiresAt: string): Promise<void>;
  /** Resolve a session token hash to its user; expired sessions are deleted and return undefined. */
  getSessionUser(tokenHash: string): Promise<PublicUser | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
}

export class PostgresAuthStore implements AuthStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async createUser(email: string, passwordHash: string): Promise<UserRecord> {
    const rows = await this.#db
      .insert(users)
      .values({ id: crypto.randomUUID(), email, passwordHash, role: 'user' })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('user insert returned no row');
    return row;
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    const rows = await this.#db.select().from(users).where(eq(users.email, email));
    return rows[0];
  }

  async createSession(userId: string, tokenHash: string, expiresAt: string): Promise<void> {
    await this.#db.insert(sessions).values({ id: crypto.randomUUID(), userId, tokenHash, expiresAt });
  }

  async getSessionUser(tokenHash: string): Promise<PublicUser | undefined> {
    const now = new Date().toISOString();
    const rows = await this.#db
      .select({ id: users.id, email: users.email, role: users.role })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)));
    if (rows[0]) return rows[0];
    // Unknown or expired: remove a stale row if one exists, then report no session.
    await this.#db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return undefined;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.#db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }
}

/** Argon2id password hashing (@node-rs/argon2 ships prebuilt binaries; no native build step). */
export function hashPassword(password: string): Promise<string> {
  // @node-rs/argon2 hashes with argon2id by default; the produced hash
  // string starts with `$argon2id$` and records the parameters.
  return hash(password);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

let dummyHash: Promise<string> | undefined;
/** Verify against a real hash even for unknown emails, so login timing does not reveal which emails exist. */
export function verifyDummyPassword(password: string): Promise<boolean> {
  dummyHash ??= hashPassword('timing-equalizer-not-a-real-password');
  return dummyHash.then((h) => verifyPassword(h, password));
}

/** The cookie carries the raw token; the database stores only this HMAC, keyed by SESSION_SECRET. */
export function hashSessionToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionExpiry(ttlHours: number, from = new Date()): string {
  return new Date(from.getTime() + ttlHours * 3_600_000).toISOString();
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

export function serializeSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  return secure ? `${base}; Secure` : base;
}

export function serializeClearedCookie(secure: boolean): string {
  const base = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return secure ? `${base}; Secure` : base;
}

export function cookieSecure(config: Config): boolean {
  return config.NODE_ENV === 'production';
}

/** Create a session for a user and return the raw token to put in the cookie. */
export async function startSession(store: AuthStore, config: Config, userId: string): Promise<string> {
  const token = newSessionToken();
  await store.createSession(
    userId,
    hashSessionToken(config.SESSION_SECRET, token),
    sessionExpiry(config.SESSION_TTL_HOURS),
  );
  return token;
}
