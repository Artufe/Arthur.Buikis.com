// /play capture: timeline of breaking along the reef line (stage/faceHeight per z over time).
import { chromium } from '@playwright/test';
const [t0 = '30', t1 = '130', dt = '0.5'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
await page.goto('http://localhost:3001/surf/?shot=1&q=low', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => !!window.__goldenline, null, { timeout: 180000, polling: 250 });
const rows = await page.evaluate(({ t0, t1, dt }) => {
  const g = window.__goldenline;
  const oc = g.ctx.services.ocean;
  const w = { stage: 0, dirX: 0, dirZ: 0, peelX: 0, peelZ: 0, peelSpeed: 0, crestDistance: 0, faceHeight: 0, hollowness: 0 };
  const zs = []; for (let z = -110; z <= 40; z += 10) zs.push(z);
  const reefX = (z) => -96 - (30 - z) * 44 / 140;
  g.camera(-90, 3, 0, Math.PI / 2, 0);
  g.setTime(t0);
  g.step(2, 1 / 60);
  const out = [];
  for (let t = t0; t <= t1; t += dt) {
    let line = '';
    for (const z of zs) {
      // scan a few x shoreward of the reef edge, keep the most developed breaker
      let best = 0, fh = 0;
      for (let dx = -10; dx <= 30; dx += 5) {
        oc.wave(reefX(z) + dx, z, w);
        if (w.stage > best) { best = w.stage; fh = w.faceHeight; }
      }
      line += best >= 0.99 ? (fh > 2 ? '#' : fh > 1 ? '+' : '.') : best > 0.5 ? '~' : ' ';
    }
    out.push(`${t.toFixed(1).padStart(6)} |${line}|`);
    g.step(Math.round(dt * 60), 1 / 60);
  }
  return ['  z:   ' + zs.map((z) => String(Math.abs(z) % 100).slice(-1)).join(''), ...out];
}, { t0: Number(t0), t1: Number(t1), dt: Number(dt) });
console.log(rows.join('\n'));
await browser.close();
