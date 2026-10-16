import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
const app = buildApp(config, config.NODE_ENV === 'production' ? { clientDir } : {});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
