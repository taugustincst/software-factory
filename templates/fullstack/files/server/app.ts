import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { PostgresAuthStore, type AuthStore } from './auth.js';
import type { Config } from './config.js';
import { createDb, type DbHandle } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { taskRoutes } from './routes/tasks.js';
import { PostgresTaskStore, type TaskStore } from './tasks.js';
import { traceLogFields } from './tracing.js';

export interface BuildAppOptions {
  clientDir?: string;
  /** Inject a store (tests pass one backed by a shared test database). Otherwise one is created from config. */
  store?: TaskStore;
  /** Inject an auth store (tests). Otherwise one is created from config, sharing the task store's pool. */
  authStore?: AuthStore;
}

export function buildApp(
  config: Config,
  { clientDir, store: injectedStore, authStore: injectedAuthStore }: BuildAppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
      // Correlate each log line with the active trace, when tracing is on.
      mixin: () => traceLogFields(),
    },
    bodyLimit: 1_048_576,
    genReqId: () => crypto.randomUUID(),
  });

  void app.register(helmet);
  // Not global: only the auth routes opt in (see routes/auth.ts), so normal
  // API traffic is never throttled by default.
  void app.register(rateLimit, { global: false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_failed',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    return reply.status(status).send({ error: status >= 500 ? 'internal_error' : (error as Error).message });
  });

  let store = injectedStore;
  let authStore = injectedAuthStore;
  if (!store || !authStore) {
    const handle: DbHandle = createDb(config.DATABASE_URL);
    store ??= new PostgresTaskStore(handle.db);
    authStore ??= new PostgresAuthStore(handle.db);
    app.addHook('onClose', async () => {
      await handle.close();
    });
  }

  app.get('/api/healthz', () => ({ status: 'ok' }));
  void app.register(taskRoutes, { prefix: '/api/tasks', store });
  void app.register(authRoutes, { prefix: '/api', store: authStore, config });

  // In production the API also serves the built client, with SPA fallback for client routes.
  if (clientDir && existsSync(clientDir)) {
    void app.register(fastifyStatic, { root: path.resolve(clientDir) });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.status(404).send({ error: 'not_found' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
