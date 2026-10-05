import { test, expect, type Page } from '@playwright/test';

// Like snake.spec: the palette is lazy and rAF-gated, so open the window through its bus event,
// except in the one test that checks the palette command itself.
async function home(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

test('the palette command "visit planet" opens the window and mounts the canvas', async ({ page }) => {
  await home(page);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('input[aria-label="Command palette"]');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill('visit planet');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'littlebig' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('canvas[data-littlebig]')).toBeVisible({ timeout: 20_000 });
});

test('↗ expands the window to /planet/, with the nav hidden and a back link', async ({ page }) => {
  await home(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('planet:open')));
  await expect(page.getByRole('dialog', { name: 'littlebig' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'open in full page' }).click();
  await expect(page).toHaveURL(/\/planet\/?$/, { timeout: 20_000 });
  await expect(page.locator('canvas[data-littlebig]')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole('dialog', { name: 'littlebig' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  // Visible and pointing home. (Not clicked: software WebGL in headless CI keeps the main thread
  // too busy for Playwright's click to settle.)
  const back = page.getByRole('link', { name: '← back to site' });
  await expect(back).toBeVisible();
  expect(await back.getAttribute('href')).toBe('/');
});
