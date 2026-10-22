import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;
const baseURL = `http://127.0.0.1:${PORT.toString()}`;

// End-to-end tests run a real browser against the production build: the
// server serves the built client and the API on one port, backed by a real
// Postgres with the committed migrations applied. Before the first run:
//   npm run db:up        # local Postgres (CI provides one as a service)
//   npm run db:migrate
//   npx playwright install chromium
// Then `npm run e2e` builds the app and runs this suite.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // The suite shares one server and one database; run files sequentially.
  workers: 1,
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
    command: 'npm start',
    url: `${baseURL}/api/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Production refuses to boot with the public dev SESSION_SECRET, so e2e
      // uses a synthetic test-only secret (never a real credential).
      // DATABASE_URL is inherited: the CI service container or local Compose.
      SESSION_SECRET: '<MASKED_SECRET_004>',
      LOG_LEVEL: 'warn',
    },
  },
});
