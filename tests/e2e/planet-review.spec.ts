import { test, expect, type Page } from '@playwright/test';

// Software WebGL in headless CI renders a frame or two a second since the towns landed (~0.6 M
// triangles in view): a boot takes 60-90 s and a ride's ~2 s blend far longer.
test.setTimeout(240_000);
const SETTLE = { timeout: 60_000 };
const ready = (page: Page) => page.waitForFunction(() => window.__littlebig?.ready, null, { timeout: 90_000 });
async function open(page: Page) {
  await page.goto('/planet/');
  await ready(page);
}

test('planet smoke: keyboard activates HUD buttons without moving the camera; no hidden footer focus', async ({ page }) => {
  await open(page);
  await expect(page.locator('footer')).toHaveCount(0);
  const plane = page.getByRole('button', { name: 'follow a plane', exact: true });
  await expect(plane).toBeEnabled();
  await plane.focus();
  await page.keyboard.press('Space');
  await expect(plane).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__littlebig!.mode().mode), SETTLE).toBe('ride');
  const stop = page.getByRole('button', { name: 'stop riding (esc)', exact: true });
  await stop.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__littlebig!.mode().mode), SETTLE).toBe('explore');
  await plane.focus();
  await page.keyboard.press('Enter');
  await expect(plane).toHaveAttribute('aria-pressed', 'true');
});

test('planet smoke: short landscapes keep every dock target inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 320 });
  await open(page);
  for (const size of [{ width: 667, height: 320 }, { width: 568, height: 320 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.lbh-mode')];
      return buttons.every((e) => { const r = e.getBoundingClientRect(); return r.width >= 44 && r.height >= 40 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
    })).toBe(true);
  }
});

test('planet smoke: expanding a window preserves the selected ride and framing', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('planet:open')));
  await ready(page);
  await page.getByRole('button', { name: 'follow a plane', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__littlebig!.mode().blend), SETTLE).toBe(1);
  const before = await page.evaluate(() => window.__littlebig!.ctx.services.camera.snapshot!());
  await page.getByRole('button', { name: 'open in full page' }).click();
  await expect(page).toHaveURL(/\/planet\/?$/);
  await ready(page);
  const after = await page.evaluate(() => window.__littlebig!.ctx.services.camera.snapshot!());
  expect(after).toEqual(before);
});

test('planet smoke: context recovery preserves a ride on a fresh canvas', async ({ page }) => {
  test.setTimeout(360_000); // two boots
  await open(page);
  await page.getByRole('button', { name: 'follow a plane', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__littlebig!.mode().blend), SETTLE).toBe(1);
  const before = await page.evaluate(() => window.__littlebig!.ctx.services.camera.snapshot!());
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-littlebig]')!;
    canvas.dataset.beforeLoss = 'true';
    const ext = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), 300);
  });
  await expect(page.locator('canvas[data-before-loss]')).toHaveCount(0, { timeout: 30_000 });
  await ready(page);
  expect(await page.evaluate(() => window.__littlebig!.ctx.services.camera.snapshot!())).toEqual(before);
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  test('planet smoke: labels, compact details and rotating bird controls', async ({ page }) => {
    await open(page);
    await expect(page.locator('.lbh-active-name')).toBeVisible();
    await expect(page.locator('.lbh-active-name')).toHaveText('explore');
    await page.getByRole('button', { name: 'fly like a bird', exact: true }).tap();
    await expect(page.locator('.lbh-active-name')).toHaveText('bird');
    const labelInsideDock = () => page.evaluate(() => {
      const label = document.querySelector('.lbh-active-name')!.getBoundingClientRect();
      const dock = document.querySelector('.lbh-dock')!.getBoundingClientRect();
      return label.left >= dock.left && label.right <= dock.right && label.top >= dock.top && label.bottom <= dock.bottom;
    });
    await expect.poll(labelInsideDock).toBe(true);
    const timeButton = await page.locator('.lbh-time').boundingBox();
    expect(timeButton!.width).toBeGreaterThanOrEqual(44);
    expect(timeButton!.height).toBeGreaterThanOrEqual(44);
    const card = page.locator('.lbh-card:not([data-out])');
    const expanded = (await card.boundingBox())!.height;
    await page.getByRole('button', { name: 'hide details', exact: true }).tap();
    await expect(card.locator('.lbh-row')).toBeHidden();
    expect((await card.boundingBox())!.height).toBeLessThan(expanded);
    await page.getByRole('button', { name: 'show details', exact: true }).tap();
    await expect(card.locator('.lbh-row')).toBeVisible();
    await page.setViewportSize({ width: 667, height: 320 });
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.lbh-mode')].every((e) => {
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.width >= 44 && r.height >= 44;
    }))).toBe(true);
    await expect.poll(labelInsideDock).toBe(true);
    expect((await page.locator('.lbh-dock').boundingBox())!.height).toBeLessThan(190);
  });
});

test('planet smoke: all six modes, cycling rides and leaving them remain usable', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  // Deterministic street placement makes nearby people and traffic available.
  await page.evaluate(() => { window.__littlebig!.shot('street'); window.__littlebig!.ctx.debug.cameraLocked = false; });
  for (const label of ['follow a plane', 'ride a car or a bus', 'watch from space', "see through someone's eyes"]) {
    const button = page.getByRole('button', { name: label, exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(() => page.evaluate(() => window.__littlebig!.mode().mode), { message: label, ...SETTLE }).toBe('ride');
    const next = page.getByRole('button', { name: 'next ride', exact: true });
    if (await next.count()) await next.click();
    await page.getByRole('button', { name: 'stop riding (esc)', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__littlebig!.mode().mode), SETTLE).toBe('explore');
    await page.evaluate(() => { window.__littlebig!.shot('street'); window.__littlebig!.ctx.debug.cameraLocked = false; });
  }
  await page.getByRole('button', { name: 'fly like a bird', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__littlebig!.mode().mode), SETTLE).toBe('bird');
  await page.getByRole('button', { name: 'explore the planet', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__littlebig!.mode().mode), SETTLE).toBe('explore');
  expect(errors).toEqual([]);
});
