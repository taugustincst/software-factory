import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { Task } from './api';

const task = (over: Partial<Task> = {}): Task => ({
  id: crypto.randomUUID(),
  title: 'Review lab results for SYN-000123',
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const { status = 200, body } = handler(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init);
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
  });
}

describe('App', () => {
  it('lists tasks from the API', async () => {
    mockFetch(() => ({ body: { data: [task(), task({ title: 'Second', done: true })] } }));
    render(<App />);
    expect(await screen.findByText('Review lab results for SYN-000123')).toBeInTheDocument();
    expect(screen.getByText('1 open of 2')).toBeInTheDocument();
  });

  it('adds a task', async () => {
    const created = task({ title: 'New one' });
    mockFetch((url, init) =>
      init?.method === 'POST' ? { status: 201, body: { data: created } } : { body: { data: [] } },
    );
    render(<App />);
    await userEvent.type(await screen.findByLabelText('New task'), 'New one');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('New one')).toBeInTheDocument();
    expect(screen.getByLabelText('New task')).toHaveValue('');
  });

  it('disables Add for blank input', async () => {
    mockFetch(() => ({ body: { data: [] } }));
    render(<App />);
    await userEvent.type(await screen.findByLabelText('New task'), '   ');
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('toggles and deletes a task', async () => {
    const t = task();
    mockFetch((url, init) => {
      if (init?.method === 'PATCH') return { body: { data: { ...t, done: true } } };
      if (init?.method === 'DELETE') return { status: 204 };
      return { body: { data: [t] } };
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => {
      expect(screen.getByRole('checkbox')).toBeChecked();
    });
    await userEvent.click(screen.getByRole('button', { name: `Delete ${t.title}` }));
    await waitFor(() => {
      expect(screen.queryByText(t.title)).not.toBeInTheDocument();
    });
  });

  it('shows an error when loading fails', async () => {
    mockFetch(() => ({ status: 500, body: { error: 'internal_error' } }));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tasks.');
  });

  it('shows an error when adding fails', async () => {
    mockFetch((url, init) => (init?.method === 'POST' ? { status: 400, body: { error: 'bad' } } : { body: { data: [] } }));
    render(<App />);
    await userEvent.type(await screen.findByLabelText('New task'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add the task.');
  });
});
