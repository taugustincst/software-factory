import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toMatchObject({ PORT: 3000, NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });

  it('coerces numeric values', () => {
    expect(loadConfig({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadConfig({ PORT: '99999' })).toThrow(/Invalid configuration: PORT/);
  });
});
