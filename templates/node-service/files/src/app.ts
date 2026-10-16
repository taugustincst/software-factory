import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { taskRoutes } from './routes/tasks.js';
import { TaskStore } from './tasks.js';

export function buildApp(config: Config): FastifyInstance {
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

  void app.register(healthRoutes);
  void app.register(taskRoutes, { prefix: '/v1/tasks', store: new TaskStore() });
  return app;
}
