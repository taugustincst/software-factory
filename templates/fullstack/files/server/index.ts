import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Tracing is imported and started before the app modules load, so the
// OpenTelemetry auto-instrumentation can patch http/Fastify as they are
// imported. With no OTEL_* env set, initTracing() is a no-op.
import { initTracing, shutdownTracing } from './tracing.js';

initTracing();

const { loadConfig } = await import('./config.js');
const { buildApp } = await import('./app.js');

const config = loadConfig();
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
const app = buildApp(config, config.NODE_ENV === 'production' ? { clientDir } : {});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.close().then(
      () => {
        void shutdownTracing().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      },
      () => process.exit(1),
    );
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
