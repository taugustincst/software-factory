import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  cookieSecure,
  credentialsSchema,
  hashPassword,
  hashSessionToken,
  readSessionCookie,
  serializeClearedCookie,
  serializeSessionCookie,
  startSession,
  verifyDummyPassword,
  verifyPassword,
  type AuthStore,
  type PublicUser,
} from '../auth.js';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: PublicUser;
  }
}

interface AuthPluginOptions {
  store: AuthStore;
  config: Config;
}

function unauthorized(reply: FastifyReply): void {
  reply.status(401).send({ error: 'unauthorized' });
}

/** preHandler factory: resolve the session cookie to `req.user`, or 401. */
export function requireAuth({ store, config }: AuthPluginOptions) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = readSessionCookie(req.headers.cookie);
    const user = token
      ? await store.getSessionUser(hashSessionToken(config.SESSION_SECRET, token))
      : undefined;
    if (!user) {
      unauthorized(reply);
      return;
    }
    req.user = user;
  };
}

/**
 * preHandler factory: require a role. Chain after requireAuth:
 * `preHandler: [requireAuth(opts), requireRole('admin')]`.
 */
export function requireRole(role: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user) {
      unauthorized(reply);
      return;
    }
    if (req.user.role !== role) {
      reply.status(403).send({ error: 'forbidden' });
    }
  };
}

async function setSessionCookie(reply: FastifyReply, userId: string, opts: AuthPluginOptions): Promise<void> {
  const token = await startSession(opts.store, opts.config, userId);
  const maxAge = opts.config.SESSION_TTL_HOURS * 3600;
  // NOTE: never return or await a FastifyReply — it is thenable, and awaiting
  // it deadlocks the handler (the reply only resolves once it is sent).
  reply.header('set-cookie', serializeSessionCookie(token, maxAge, cookieSecure(opts.config)));
}

export const authRoutes: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const auth = requireAuth(opts);

  app.post('/auth/register', async (req, reply) => {
    const { email, password } = credentialsSchema.parse(req.body);
    if (await opts.store.getUserByEmail(email)) {
      return reply.status(409).send({ error: 'email_taken' });
    }
    const user = await opts.store.createUser(email, await hashPassword(password));
    await setSessionCookie(reply, user.id, opts);
    return reply.status(201).send({ data: { id: user.id, email: user.email, role: user.role } });
  });

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = credentialsSchema.parse(req.body);
    const user = await opts.store.getUserByEmail(email);
    const ok = user ? await verifyPassword(user.passwordHash, password) : await verifyDummyPassword(password);
    if (!user || !ok) {
      return reply.status(401).send({ error: 'invalid_credentials' });
    }
    await setSessionCookie(reply, user.id, opts);
    return { data: { id: user.id, email: user.email, role: user.role } };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = readSessionCookie(req.headers.cookie);
    if (token) await opts.store.deleteSession(hashSessionToken(opts.config.SESSION_SECRET, token));
    return reply
      .header('set-cookie', serializeClearedCookie(cookieSecure(opts.config)))
      .status(204)
      .send();
  });

  // Protected example route: any signed-in user. Copy this pattern (or add
  // requireRole, as on /admin below) to protect a real resource.
  app.get('/me', { preHandler: auth }, (req) => ({ data: req.user }));

  // RBAC example: only the `admin` role passes requireRole('admin').
  app.get('/admin', { preHandler: [auth, requireRole('admin')] }, (req) => ({
    data: { status: 'admin_ok', user: req.user },
  }));
  await Promise.resolve();
};
