import { expect, test } from '@playwright/test';

test('app loads and the tasks example works through the UI', async ({ page }) => {
  const title = `E2E smoke task ${Date.now().toString()}`;

  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.getByPlaceholder('Add a task')).toBeVisible();

  // Create through the real UI -> API -> Postgres path.
  await page.getByPlaceholder('Add a task').fill(title);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const item = page.locator('li', { hasText: title });
  await expect(item).toBeVisible();

  // Toggle done, then delete; each step round-trips the API. A plain click
  // (not check()) drives the React controlled checkbox, and the class
  // assertion waits for the server-round-tripped state to render.
  await item.getByRole('checkbox').click();
  await expect(item).toHaveClass('done');
  await item.getByRole('button', { name: `Delete ${title}` }).click();
  await expect(page.locator('li', { hasText: title })).toHaveCount(0);
});
