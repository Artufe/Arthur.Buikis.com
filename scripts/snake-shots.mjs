#!/usr/bin/env node
// Captures every dev-hook scene of the snake game, in both themes, at three sizes.
// usage: node scripts/snake-shots.mjs <out-dir> [base-url]    (needs `pnpm dev` running)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const OUT = process.argv[2];
const BASE = process.argv[3] ?? 'http://localhost:3000';
if (!OUT) {
  console.error('usage: node scripts/snake-shots.mjs <out-dir> [base-url]');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const SCENES = ['idle', 'mid-run', 'trail-fade', 'golden', 'death', 'gameover'];
const THEMES = ['light', 'dark'];
const TARGETS = [
  { name: 'desktop', path: '/snake/', context: { viewport: { width: 1440, height: 900 } } },
  {
    name: 'mobile',
    path: '/snake/',
    context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  },
  { name: 'window', path: '/', window: true, context: { viewport: { width: 1440, height: 900 } } },
];

const browser = await chromium.launch({
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const problems = [];
for (const theme of THEMES) {
  for (const target of TARGETS) {
    const context = await browser.newContext(target.context);
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('theme', t);
      } catch {}
    }, theme);
    const page = await context.newPage();
    const tag = `${theme}/${target.name}`;
    page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`${tag} console: ${m.text()}`));
    await page.goto(BASE + target.path, { waitUntil: 'networkidle' });
    if (target.window) await page.evaluate(() => window.dispatchEvent(new CustomEvent('snake:open')));
    await page.waitForSelector('canvas[data-mounted="1"]', { timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.__snake), null, { timeout: 30_000 });
    for (const scene of SCENES) {
      await page.evaluate((s) => window.__snake.setScene(s), scene);
      await page.waitForTimeout(800);
      const file = join(OUT, `${theme}-${target.name}-${scene}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
    await context.close();
  }
}
await browser.close();
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
