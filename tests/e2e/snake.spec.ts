import { test, expect } from '@playwright/test';

test('command palette opens the snake floating window', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('/');
  await page.fill('input[aria-label="Command palette"]', 'snake');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'snake.py' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('> snake.py');
});

test('escape closes the snake window', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('/');
  await page.fill('input[aria-label="Command palette"]', 'snake');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'snake.py' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'snake.py' })).toHaveCount(0);
});

test('expand button routes to /snake', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('/');
  await page.fill('input[aria-label="Command palette"]', 'snake');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'open in full page' }).click();
  await expect(page).toHaveURL(/\/snake\/?$/);
});

test('/snake mounts a canvas', async ({ page }) => {
  await page.goto('/snake/');
  const canvas = page.locator('canvas[data-mounted="1"]');
  await expect(canvas).toBeVisible({ timeout: 10_000 });
});

test('high score persists across reloads', async ({ page }) => {
  await page.goto('/snake/');
  await page.evaluate(() => window.localStorage.setItem('snake.best', '42'));
  await page.reload();
  const v = await page.evaluate(() => window.localStorage.getItem('snake.best'));
  expect(v).toBe('42');
});
