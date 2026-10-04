import { test, expect } from '@playwright/test';

test('the nav Play link opens /play, and a card opens its game in the same tab', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'play', exact: true }).click();
  await expect(page).toHaveURL(/\/play\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Two games, built with agents.' })).toBeVisible();
  await page.getByRole('link', { name: 'Play Snake' }).click();
  await expect(page).toHaveURL(/\/snake\/$/, { timeout: 20_000 }); // dev compiles /snake on first visit
});

test('a card clip loads once on screen and the toggle pauses it', async ({ page }) => {
  await page.goto('/play/');
  const card = page.locator('.play-card').nth(1); // GOLDENLINE: a single variant
  const video = card.locator('video');
  await expect(video).toHaveAttribute('src', '/play/goldenline.mp4');
  await card.getByRole('button', { name: 'Pause video' }).click();
  await expect(card.getByRole('button', { name: 'Play video' })).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('reduced motion shows posters and no video', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/play/');
  await expect(page.locator('.play-card img').first()).toBeVisible();
  await expect(page.locator('.play-card video')).toHaveCount(0);
  await context.close();
});
