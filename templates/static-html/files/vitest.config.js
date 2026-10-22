import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // e2e/ holds Playwright specs; Vitest must never collect them. The same
    // goes for the factory upgrade base snapshot under .factory/, which
    // mirrors the whole project (specs included) for three-way merges.
    exclude: [...configDefaults.exclude, 'e2e/**', '.factory/**'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
