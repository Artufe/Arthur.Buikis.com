import { test, expect } from '@playwright/test';

// /about (and /building) render elements with a bare `reveal` class,
// which globals.css holds at opacity 0 until something adds `vis`. The
// RevealObserver in the root layout is responsible for adding it.

test('about timeline reveals on load', async ({ page }) => {
  await page.goto('/about/');
  const first = page.locator('.tl-item').first();
  await expect(first).toHaveClass(/\bvis\b/);
  await expect(first).toHaveCSS('opacity', '1');
});

test('scrolling reveals the rest of the about page', async ({ page }) => {
  await page.goto('/about/');
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(80);
  }
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.reveal:not(.vis)').length))
    .toBe(0);
});

test('reveal elements reached by client-side navigation still reveal', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'About' }).click();
  await expect(page.locator('.tl-item').first()).toHaveClass(/\bvis\b/);
});
