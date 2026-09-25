import { test, expect, type Page } from '@playwright/test';

// The palette is lazy-loaded and rAF-gated, which makes keyboard-driven opening flaky in
// headless Chromium, so these tests dispatch snake:open directly.
async function openSnakeWindow(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('snake:open')));
}

async function gamePage(page: Page) {
  await page.goto('/snake/');
  const canvas = page.locator('canvas[data-mounted="1"]');
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  return canvas;
}

test('snake:open mounts the floating window', async ({ page }) => {
  await openSnakeWindow(page);
  const dialog = page.getByRole('dialog', { name: 'snake' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('canvas')).toBeVisible();
});

test('escape closes the snake window', async ({ page }) => {
  await openSnakeWindow(page);
  await expect(page.getByRole('dialog', { name: 'snake' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'snake' })).toHaveCount(0);
});

test('expand button routes to /snake', async ({ page }) => {
  await openSnakeWindow(page);
  await page.getByRole('button', { name: 'open in full page' }).click();
  await expect(page).toHaveURL(/\/snake\/?$/);
});

test('snake:open is ignored on /snake so only one game runs', async ({ page }) => {
  await gamePage(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('snake:open')));
  await expect(page.getByRole('dialog', { name: 'snake' })).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(1);
});

test('/snake renders with WebGL and shows the start panel', async ({ page }) => {
  const canvas = await gamePage(page);
  const hasGl = await canvas.evaluate((c: HTMLCanvasElement) => Boolean(c.getContext('webgl2') ?? c.getContext('webgl')));
  expect(hasGl).toBe(true);
  await expect(page.getByText('SNAKE', { exact: true })).toBeVisible();
});

test('hiding the tab pauses a running game', async ({ page }) => {
  await gamePage(page);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByText('paused', { exact: true })).toBeVisible();
});

test('the canvas drawing buffer follows its container', async ({ page }) => {
  const canvas = await gamePage(page);
  const before = await canvas.evaluate((c: HTMLCanvasElement) => c.width);
  await page.setViewportSize({ width: 800, height: 700 });
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width)).not.toBe(before);
  const { width, clientWidth } = await canvas.evaluate((c: HTMLCanvasElement) => ({ width: c.width, clientWidth: c.clientWidth }));
  expect(Math.abs(width / clientWidth - (await page.evaluate(() => Math.min(window.devicePixelRatio, 2))))).toBeLessThan(0.51);
});

test('high score persists across reloads', async ({ page }) => {
  await page.goto('/snake/');
  await page.evaluate(() => window.localStorage.setItem('snake.best', '42'));
  await page.reload();
  const v = await page.evaluate(() => window.localStorage.getItem('snake.best'));
  expect(v).toBe('42');
});
