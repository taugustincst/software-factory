import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', () => ({ status: 'ready' }));
  await Promise.resolve();
};
