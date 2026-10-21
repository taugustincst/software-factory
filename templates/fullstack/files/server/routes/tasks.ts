import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createTaskSchema, updateTaskSchema, type TaskStore } from '../tasks.js';

const params = z.object({ id: z.uuid() });

export const taskRoutes: FastifyPluginAsync<{ store: TaskStore }> = async (app, { store }) => {
  app.get('/', async () => ({ data: await store.list() }));

  app.get('/:id', async (req, reply) => {
    const { id } = params.parse(req.params);
    const task = await store.get(id);
    return task ? { data: task } : reply.status(404).send({ error: 'not_found' });
  });

  app.post('/', async (req, reply) => {
    const task = await store.create(createTaskSchema.parse(req.body));
    return reply.status(201).send({ data: task });
  });

  app.patch('/:id', async (req, reply) => {
    const { id } = params.parse(req.params);
    const task = await store.update(id, updateTaskSchema.parse(req.body));
    return task ? { data: task } : reply.status(404).send({ error: 'not_found' });
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = params.parse(req.params);
    return (await store.delete(id))
      ? reply.status(204).send()
      : reply.status(404).send({ error: 'not_found' });
  });
  await Promise.resolve();
};
