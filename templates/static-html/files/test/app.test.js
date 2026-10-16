import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** Load the page in jsdom with its inline script running, optionally with pre-existing storage. */
function load(stored) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    beforeParse(window) {
      if (stored !== undefined) window.localStorage.setItem('{{factory.name}}:items', stored);
    },
  });
  const { document } = dom.window;
  const add = (title) => {
    const input = document.getElementById('title');
    input.value = title;
    input.dispatchEvent(new dom.window.Event('input'));
    document.getElementById('add').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  };
  const items = () => [...document.querySelectorAll('#list li span')].map((s) => s.textContent);
  return { dom, document, add, items };
}

describe('{{factory.title}}', () => {
  it('starts empty', () => {
    const { document, items } = load();
    expect(items()).toEqual([]);
    expect(document.getElementById('empty').hidden).toBe(false);
  });

  it('adds items and clears the input', () => {
    const { document, add, items } = load();
    add('Order supplies');
    add('Call vendor');
    expect(items()).toEqual(['Order supplies', 'Call vendor']);
    expect(document.getElementById('title').value).toBe('');
    expect(document.getElementById('count').textContent).toBe('2 open of 2');
  });

  it('ignores blank input', () => {
    const { add, items } = load();
    add('   ');
    expect(items()).toEqual([]);
  });

  it('renders user text as text, not HTML', () => {
    const { document, add } = load();
    add('<img src=x onerror="window.pwned=1">');
    expect(document.querySelector('#list img')).toBeNull();
  });

  it('toggles and deletes', () => {
    const { dom, document, add, items } = load();
    add('One');
    const box = document.querySelector('#list input[type=checkbox]');
    box.checked = true;
    box.dispatchEvent(new dom.window.Event('change'));
    expect(document.querySelector('#list li').className).toBe('done');
    document.querySelector('#list li button').click();
    expect(items()).toEqual([]);
  });

  it('persists to and restores from localStorage', () => {
    const first = load();
    first.add('Persisted');
    const saved = first.dom.window.localStorage.getItem('{{factory.name}}:items');
    expect(load(saved).items()).toEqual(['Persisted']);
  });

  it('survives corrupt storage', () => {
    expect(load('{not json').items()).toEqual([]);
  });
});
