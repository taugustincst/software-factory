import { useEffect, useState, type SubmitEvent } from 'react';
import { api, type Task, type User } from './api';

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listTasks()
      .then(setTasks)
      .catch(() => {
        setError('Could not load tasks.');
      })
      .finally(() => {
        setLoading(false);
      });
    // Protected-route example: /api/me only answers with a valid session cookie.
    api
      .me()
      .then((u) => {
        if (u && typeof u.email === 'string') setUser(u);
      })
      .catch(() => undefined);
  }, []);

  async function submitAuth(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const signedIn =
        authMode === 'login' ? await api.login(email, password) : await api.register(email, password);
      setUser(signedIn);
      setPassword('');
      setAuthError(null);
    } catch {
      setAuthError(authMode === 'login' ? 'Could not sign in.' : 'Could not create the account.');
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } catch {
      // The cookie may already be gone; clear local state either way.
    }
    setUser(null);
  }

  async function add(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const task = await api.createTask(trimmed);
      setTasks((t) => [...t, task]);
      setTitle('');
      setError(null);
    } catch {
      setError('Could not add the task.');
    }
  }

  async function toggle(task: Task) {
    try {
      const updated = await api.setDone(task.id, !task.done);
      setTasks((t) => t.map((x) => (x.id === updated.id ? updated : x)));
    } catch {
      setError('Could not update the task.');
    }
  }

  async function remove(task: Task) {
    try {
      await api.deleteTask(task.id);
      setTasks((t) => t.filter((x) => x.id !== task.id));
    } catch {
      setError('Could not delete the task.');
    }
  }

  const open = tasks.filter((t) => !t.done).length;

  return (
    <main className="app">
      <header>
        <h1>{'{{factory.title}}'}</h1>
        <p className="muted">{loading ? 'Loading…' : `${open} open of ${tasks.length}`}</p>
      </header>

      {user ? (
        <section className="account">
          <p>
            Signed in as {user.email} ({user.role})
          </p>
          <p className="muted">
            Protected example: this panel only renders when /api/me accepts your session.
          </p>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </section>
      ) : (
        <form onSubmit={(e) => void submitAuth(e)} className="auth">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
          <button type="submit" disabled={!email.trim() || password.length < 8}>
            {authMode === 'login' ? 'Sign in' : 'Create account'}
          </button>
          <button
            type="button"
            onClick={() => {
              setAuthMode(authMode === 'login' ? 'register' : 'login');
              setAuthError(null);
            }}
          >
            {authMode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
          </button>
          {authError && (
            <p role="alert" className="error">
              {authError}
            </p>
          )}
        </form>
      )}

      <form onSubmit={(e) => void add(e)} className="add">
        <label htmlFor="title" className="sr-only">
          New task
        </label>
        <input
          id="title"
          value={title}
          maxLength={200}
          placeholder="Add a task"
          onChange={(e) => {
            setTitle(e.target.value);
          }}
        />
        <button type="submit" disabled={!title.trim()}>
          Add
        </button>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <ul className="tasks">
        {tasks.map((task) => (
          <li key={task.id} className={task.done ? 'done' : undefined}>
            <label>
              <input type="checkbox" checked={task.done} onChange={() => void toggle(task)} />
              <span>{task.title}</span>
            </label>
            <button type="button" aria-label={`Delete ${task.title}`} onClick={() => void remove(task)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {!loading && tasks.length === 0 && <p className="muted">Nothing here yet.</p>}
    </main>
  );
}
