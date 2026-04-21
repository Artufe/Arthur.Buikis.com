import { test, expect } from '@playwright/test';

test('home page renders in light mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Senior engineer/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /download_cv/i })).toBeVisible();
});

test('theme toggle switches to dark mode', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /toggle theme/i }).click();
  // Dark mode shows the $ whoami prompt line
  await expect(page.getByText(/whoami --verbose/)).toBeVisible();
});
