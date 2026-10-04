// /play capture: sand height probe for re-framing the ashore scene. See docs/play-media.md.
import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 320, height: 200 } });
await p.goto('http://localhost:3001/surf/?shot=1&q=low', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__goldenline, null, { timeout: 180000, polling: 250 });
console.log(await p.evaluate(() => window.__goldenline.ctx.services.terrain.height(14, 26)));
await b.close();
