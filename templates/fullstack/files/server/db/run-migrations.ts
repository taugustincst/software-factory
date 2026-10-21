// CLI entry for `npm run db:migrate`: apply committed migrations, then exit.
import { loadConfig } from '../config.js';
import { createDb } from './index.js';
import { runMigrations } from './migrate.js';

const handle = createDb(loadConfig().DATABASE_URL);
try {
  await runMigrations(handle);
} finally {
  await handle.close();
}
