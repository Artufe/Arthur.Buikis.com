// /play capture: ASCII map of breaking (wave().stage/faceHeight) over XZ at given times.
import { chromium } from '@playwright/test';
const times = process.argv.slice(2).map(Number);
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
await page.goto('http://localhost:3001/surf/?shot=1&q=low', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => !!window.__goldenline, null, { timeout: 180000, polling: 250 });
for (const T of times) {
  const rows = await page.evaluate((T) => {
    const g = window.__goldenline;
    const oc = g.ctx.services.ocean;
    const w = { stage: 0, dirX: 0, dirZ: 0, peelX: 0, peelZ: 0, peelSpeed: 0, crestDistance: 0, faceHeight: 0, hollowness: 0 };
    const s = { height: 0, nx: 0, ny: 0, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 0 };
    g.camera(-90, 3, 0, Math.PI / 2, 0);
    g.setTime(T - 1); g.step(60, 1 / 60);
    const out = [];
    // rows: x from -200 (top, sea) to 0 (bottom, shore); cols: z from 120 (left) to -140 (right) — as seen from the beach facing the sea
    for (let x = -200; x <= 10; x += 5) {
      let line = '';
      for (let z = 120; z >= -140; z -= 4) {
        if (Math.abs(z - 48) < 2 && x > -110 && x < 34) { line += '='; continue; }
        oc.wave(x, z, w);
        const b = oc.sample(x, z, s).breaking;
        const dry = s.depth <= 0.05;
        line += dry ? ':' : b > 0.5 ? '@' : w.stage >= 0.99 && Math.abs(w.crestDistance) < 4 ? '#' : w.stage > 0.3 && Math.abs(w.crestDistance) < 4 ? '~' : '.';
      }
      out.push(`${String(x).padStart(5)} ${line}`);
    }
    return [`t=${T}  cols z=120 (left) .. -140 (right), '=' pier`, ...out];
  }, T);
  console.log(rows.join('\n'));
}
await browser.close();
