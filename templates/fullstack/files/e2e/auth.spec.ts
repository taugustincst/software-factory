import { expect, test } from '@playwright/test';

// The Phase 3 session auth, exercised the way a user hits it: the protected
// /api/me route rejects anonymous calls, registering through the form opens
// the protected account panel, the httpOnly cookie survives a reload, and
// signing out (or never signing in) keeps the panel closed. The account is
// synthetic and unique per run, so the spec is repeatable against one database.
test('protected route is blocked signed out and reachable after register/login', async ({ page }) => {
  const email = `e2e-${Date.now().toString()}@example.test`;
  const password = '<redacted>';

  const signedInAs = page.getByText(`Signed in as ${email} (user)`);

  // Signed out: the API rejects /api/me and the app shows the auth form.
  const anonymous = await page.request.get('/api/me');
  expect(anonymous.status()).toBe(401);
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByText('Signed in as')).toHaveCount(0);

  // Register through the real form (the API sets the session cookie).
  await page.getByRole('button', { name: 'Need an account? Register' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(signedInAs).toBeVisible();
  const afterRegister = await page.request.get('/api/me');
  expect(afterRegister.status()).toBe(200);

  // The cookie persists across a reload; signing out closes the panel again.
  await page.reload();
  await expect(signedInAs).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed in as')).toHaveCount(0);
  const afterLogout = await page.request.get('/api/me');
  expect(afterLogout.status()).toBe(401);

  // Log back in with the same credentials (a reload resets the form to login mode).
  await page.reload();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(signedInAs).toBeVisible();
});
