import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** End the connection pool. Call when the owning process or app shuts down. */
  close: () => Promise<void>;
}

/** Create a Postgres connection pool + Drizzle client for the given URL. */
export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, { max: 10 });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}
