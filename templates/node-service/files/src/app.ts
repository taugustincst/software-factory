import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { createDb, type DbHandle } from './db/index.js';
import { healthRoutes } from './routes/health.js';
import { taskRoutes } from './routes/tasks.js';
import { PostgresTaskStore, type TaskStore } from './tasks.js';

export interface BuildAppOptions {
  /** Inject a store (tests pass one backed by a shared test database). Otherwise one is created from config. */
  store?: TaskStore;
}

export function buildApp(config: Config, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log credentials or request bodies that may hold personal data.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
    },
    bodyLimit: config.BODY_LIMIT_BYTES,
    genReqId: () => crypto.randomUUID(),
  });

  void app.register(helmet);

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

  let store = options.store;
  if (!store) {
    const handle: DbHandle = createDb(config.DATABASE_URL);
    store = new PostgresTaskStore(handle.db);
    app.addHook('onClose', async () => {
      await handle.close();
    });
  }

  void app.register(healthRoutes);
  void app.register(taskRoutes, { prefix: '/v1/tasks', store });
  return app;
}
