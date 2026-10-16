import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = buildApp(config);

const shutdown = (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  app.close().then(
    () => process.exit(0),
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
