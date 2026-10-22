import { expect, test } from '@playwright/test';

test('page loads and the list works end to end', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.getByText('Nothing here yet.')).toBeVisible();

  // Add through the real form.
  await page.getByPlaceholder('Add an item').fill('Order supplies');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('#list li span')).toHaveText('Order supplies');
  await expect(page.locator('#count')).toHaveText('1 open of 1');

  // The item persists to localStorage across a reload.
  await page.reload();
  await expect(page.locator('#list li span')).toHaveText('Order supplies');

  // Toggle done, then delete.
  await page.locator('#list li input[type="checkbox"]').check();
  await expect(page.locator('#list li')).toHaveClass('done');
  await page.getByRole('button', { name: 'Delete Order supplies' }).click();
  await expect(page.locator('#list li')).toHaveCount(0);
  await expect(page.getByText('Nothing here yet.')).toBeVisible();
});
