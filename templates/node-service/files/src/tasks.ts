import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './db/index.js';
import { tasks } from './db/schema.js';

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    done: z.boolean().default(false),
  })
  .strict();

export const updateTaskSchema = createTaskSchema.partial().strict();

export type Task = { id: string; title: string; done: boolean; createdAt: string };

type CreateTaskInput = z.infer<typeof createTaskSchema>;
type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/** Store interface for tasks. Postgres is the implementation; routes only see this contract. */
export interface TaskStore {
  list(): Promise<Task[]>;
  get(id: string): Promise<Task | undefined>;
  create(input: CreateTaskInput): Promise<Task>;
  update(id: string, patch: UpdateTaskInput): Promise<Task | undefined>;
  delete(id: string): Promise<boolean>;
}

export class PostgresTaskStore implements TaskStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async list(): Promise<Task[]> {
    return this.#db.select().from(tasks).orderBy(asc(tasks.createdAt), asc(tasks.id));
  }

  async get(id: string): Promise<Task | undefined> {
    const rows = await this.#db.select().from(tasks).where(eq(tasks.id, id));
    return rows[0];
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const task: Task = {
      id: crypto.randomUUID(),
      title: input.title,
      done: input.done,
      createdAt: new Date().toISOString(),
    };
    await this.#db.insert(tasks).values(task);
    return task;
  }

  async update(id: string, patch: UpdateTaskInput): Promise<Task | undefined> {
    const changes: Partial<{ title: string; done: boolean }> = {
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.done !== undefined && { done: patch.done }),
    };
    if (Object.keys(changes).length === 0) return this.get(id);
    const rows = await this.#db.update(tasks).set(changes).where(eq(tasks.id, id)).returning();
    return rows[0];
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.#db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
    return rows.length > 0;
  }
}
