export type Task = { id: string; title: string; done: boolean; createdAt: string };

export type User = { id: string; email: string; role: string };

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
  // Only claim a JSON body when there is one: Fastify rejects a POST that
  // declares application/json but sends an empty body (e.g. logout) with 400.
  if (init?.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export const api = {
  // Session auth: the API sets an httpOnly cookie; the browser sends it automatically.
  register: (email: string, password: string) =>
    request<{ data: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }).then((r) => r.data),
  login: (email: string, password: string) =>
    request<{ data: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }).then((r) => r.data),
  logout: () => request<undefined>('/auth/logout', { method: 'POST' }),
  /** The protected example route: resolves the current user, or null when signed out. */
  me: () =>
    request<{ data: User }>('/me')
      .then((r) => r.data)
      .catch(() => null),
  listTasks: () => request<{ data: Task[] }>('/tasks').then((r) => r.data),
  createTask: (title: string) =>
    request<{ data: Task }>('/tasks', { method: 'POST', body: JSON.stringify({ title }) }).then(
      (r) => r.data,
    ),
  setDone: (id: string, done: boolean) =>
    request<{ data: Task }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }).then(
      (r) => r.data,
    ),
  deleteTask: (id: string) => request<undefined>(`/tasks/${id}`, { method: 'DELETE' }),
};
