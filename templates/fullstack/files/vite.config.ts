import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true, sourcemap: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  test: {
    root: '.',
    coverage: {
      provider: 'v8',
      include: ['web/src/**', 'server/**'],
      exclude: ['server/index.ts', 'web/src/main.tsx', '**/*.test.*'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
    projects: [
      { extends: true, test: { name: 'web', environment: 'jsdom', include: ['web/**/*.test.tsx'], setupFiles: ['web/src/test-setup.ts'] } },
      { extends: true, test: { name: 'server', environment: 'node', include: ['server/**/*.test.ts'] } },
    ],
  },
});
