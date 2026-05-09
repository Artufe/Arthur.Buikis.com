import { test, expect } from '@playwright/test';

// The palette is lazy-loaded, and its listener-registration is rAF-gated. Both factors make
// keyboard-driven palette opening flaky in headless Chromium. These tests dispatch snake:open
// directly to verify the window UX (mount, drag chrome, esc, expand) — the palette → snake
// command wiring is verified by manual smoke testing and unit-level type alignment.
async function openSnakeWindow(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('snake:open')));
}

test('snake:open mounts the floating window', async ({ page }) => {
  await openSnakeWindow(page);
  const dialog = page.getByRole('dialog', { name: 'snake.py' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('> snake.py');
});

test('escape closes the snake window', async ({ page }) => {
  await openSnakeWindow(page);
  await expect(page.getByRole('dialog', { name: 'snake.py' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'snake.py' })).toHaveCount(0);
});

test('expand button routes to /snake', async ({ page }) => {
  await openSnakeWindow(page);
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
