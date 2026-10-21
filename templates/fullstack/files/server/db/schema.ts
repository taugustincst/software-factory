import { boolean, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/** Tasks table. The TypeScript row shape matches the `Task` type in src/tasks.ts. */
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  done: boolean('done').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
