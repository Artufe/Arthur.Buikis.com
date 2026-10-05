import { test, expect, type Page } from '@playwright/test';

// Like snake.spec: the palette is lazy and rAF-gated, so open the window through its bus event,
// except in the one test that checks the palette command itself.
async function home(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

// The HUD mounts once the engine draws its first frame; software WebGL in headless CI is slow.
const BOOT = 90_000;

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
  const back = page.getByRole('link', { name: 'back to site' });
  await expect(back).toBeVisible();
  expect(await back.getAttribute('href')).toBe('/');
});

test('/planet shows the POP HUD: a dock of six real buttons, explore pressed, and the time button', async ({ page }) => {
  test.setTimeout(BOOT + 30_000);
  await page.goto('/planet/');
  const dock = page.getByRole('navigation', { name: 'ways to see the planet' });
  await expect(dock).toBeVisible({ timeout: BOOT });
  const modes = dock.getByRole('button');
  await expect(modes).toHaveCount(6);
  const explore = dock.getByRole('button', { name: 'explore the planet' });
  await expect(explore).toHaveAttribute('aria-pressed', 'true');
  await expect(explore).toHaveAttribute('aria-keyshortcuts', '1');
  await expect(page.getByRole('button', { name: /^fast-forward to (evening|morning)$/ })).toBeVisible();
  // The canvas keeps its keyboard: the HUD never takes focus on its own.
  expect(await page.evaluate(() => document.activeElement?.closest('.lbh') == null)).toBe(true);
});

test('at 360 px wide the HUD fits with no overflow, and every control is a 40 px touch target', async ({ page }) => {
  test.setTimeout(BOOT + 30_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/planet/');
  const dock = page.getByRole('navigation', { name: 'ways to see the planet' });
  await expect(dock).toBeVisible({ timeout: BOOT });
  const res = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.lbh-dock, .lbh-time, .lbh-hint, a[href="/"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left < 0 || r.right > vw || r.top < 0 || r.bottom > vh) out.push(`outside: ${el.className}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>('.lbh button:not(.lbh-tag)')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.width < 40 || r.height < 40)) out.push(`small: ${el.getAttribute('aria-label')} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return { scroll: document.documentElement.scrollWidth, vw, out };
  });
  expect(res.scroll).toBeLessThanOrEqual(res.vw);
  expect(res.out).toEqual([]);
});

test('the dock stands beside the planet in landscape and under it in portrait; the back link tabs first', async ({ page }) => {
  test.setTimeout(BOOT + 60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/planet/');
  const dock = page.getByRole('navigation', { name: 'ways to see the planet' });
  await expect(dock).toBeVisible({ timeout: BOOT });
  // Landscape: a rail on the right edge, vertically centred (the planet fills the height).
  let r = (await dock.boundingBox())!;
  expect(1280 - (r.x + r.width)).toBeLessThan(30);
  expect(r.height).toBeGreaterThan(r.width);
  expect(r.y).toBeGreaterThan(60);
  // Visually first, first in the tab order too: the back link precedes the canvas, the HUD and its world labels.
  const order = await page.evaluate(() => {
    const back = document.querySelector('a.lb-back');
    const later = [document.querySelector('canvas[data-littlebig]'), document.querySelector('.lbh')];
    return !!back && later.every((el) => !!el && (back.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  });
  expect(order).toBe(true);
  // Portrait: along the bottom.
  await page.setViewportSize({ width: 390, height: 844 });
  // (Software WebGL in headless CI keeps the main thread busy: the resize can take a while to land.)
  await expect.poll(async () => (await dock.boundingBox())!.width, { timeout: 30_000 }).toBeGreaterThan(200);
  r = (await dock.boundingBox())!;
  expect(844 - (r.y + r.height)).toBeLessThan(30);
});

test('the floating window gets the compact icon dock', async ({ page }) => {
  test.setTimeout(BOOT + 30_000);
  await home(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('planet:open')));
  const dialog = page.getByRole('dialog', { name: 'littlebig' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const dock = dialog.getByRole('navigation', { name: 'ways to see the planet' });
  await expect(dock).toBeVisible({ timeout: BOOT });
  await expect(dialog.locator('.lbh[data-compact]')).toHaveCount(1);
  await expect(dock.getByRole('button', { name: 'explore the planet' })).toHaveAttribute('aria-pressed', 'true');
});

test('shot mode hides the HUD unless ?hud=1', async ({ page }) => {
  test.setTimeout(2 * BOOT + 30_000);
  await page.goto('/planet/?shot=1&hud=1');
  await expect(page.getByRole('navigation', { name: 'ways to see the planet' })).toBeVisible({ timeout: BOOT });
  await expect(page.getByRole('link', { name: 'back to site' })).toBeVisible();
  await page.goto('/planet/?shot=1');
  // The engine is up and drawing (the HUD would have mounted by now), and there is none.
  await page.waitForFunction(() => (window.__littlebig?.ctx.time.frame ?? 0) > 2, null, { timeout: BOOT });
  await page.waitForTimeout(500);
  await expect(page.locator('.lbh')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'back to site' })).toHaveCount(0);
});
