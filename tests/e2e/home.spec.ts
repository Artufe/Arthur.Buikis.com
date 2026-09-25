import { test, expect } from '@playwright/test';

test('home page renders the hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /Arthur\s*Buikis/i })).toBeVisible();
  await expect(page.getByText(/whoami --verbose/)).toBeVisible();
});

test('theme toggle flips the html theme class', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const wasDark = ((await html.getAttribute('class')) ?? '').includes('dark');
  await page.getByRole('button', { name: /toggle theme/i }).click();
  if (wasDark) await expect(html).not.toHaveClass(/\bdark\b/);
  else await expect(html).toHaveClass(/\bdark\b/);
});
