import { useEffect, useState, type SubmitEvent } from 'react';
import { api, type Task } from './api';

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
  }, []);

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
