import { z } from 'zod';

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    done: z.boolean().default(false),
  })
  .strict();

export const updateTaskSchema = createTaskSchema.partial().strict();

export type Task = { id: string; title: string; done: boolean; createdAt: string };

/** In-memory store. Swap for a real repository behind the same interface. */
export class TaskStore {
  readonly #tasks = new Map<string, Task>();

  list(): Task[] {
    return [...this.#tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.#tasks.get(id);
  }

  create(input: z.infer<typeof createTaskSchema>): Task {
    const task: Task = { id: crypto.randomUUID(), title: input.title, done: input.done, createdAt: new Date().toISOString() };
    this.#tasks.set(task.id, task);
    return task;
  }

  update(id: string, patch: z.infer<typeof updateTaskSchema>): Task | undefined {
    const current = this.#tasks.get(id);
    if (!current) return undefined;
    const next: Task = { ...current, ...(patch.title !== undefined && { title: patch.title }), ...(patch.done !== undefined && { done: patch.done }) };
    this.#tasks.set(id, next);
    return next;
  }

  delete(id: string): boolean {
    return this.#tasks.delete(id);
  }
}
