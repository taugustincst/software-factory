// Tracing is imported and started before the app modules load, so the
// OpenTelemetry auto-instrumentation can patch http/Fastify as they are
// imported. With no OTEL_* env set, initTracing() is a no-op.
import { initTracing, shutdownTracing } from './tracing.js';

initTracing();

const { loadConfig } = await import('./config.js');
const { buildApp } = await import('./app.js');

const config = loadConfig();
const app = buildApp(config);

const shutdown = (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  app.close().then(
    () => {
      void shutdownTracing().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    },
    (err: unknown) => {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    },
  );
};
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

await app.listen({ host: config.HOST, port: config.PORT });
