export type Task = { id: string; title: string; done: boolean; createdAt: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export const api = {
  listTasks: () => request<{ data: Task[] }>('/tasks').then((r) => r.data),
  createTask: (title: string) =>
    request<{ data: Task }>('/tasks', { method: 'POST', body: JSON.stringify({ title }) }).then((r) => r.data),
  setDone: (id: string, done: boolean) =>
    request<{ data: Task }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }).then(
      (r) => r.data,
    ),
  deleteTask: (id: string) => request<undefined>(`/tasks/${id}`, { method: 'DELETE' }),
};
