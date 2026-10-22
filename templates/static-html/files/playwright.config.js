import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
const baseURL = `http://127.0.0.1:${PORT}`;

// End-to-end smoke: a real Chromium loads the single-file app served by the
// same static server as `npm run dev` (scripts/serve.js). Once per machine,
// install the browser with `npx playwright install chromium`, then `npm run e2e`.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/serve.js ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
