// /play capture: one-boot batch capture for GOLDENLINE preview media. See docs/play-media.md.
// node scripts/play-media/gl-media.mjs --url http://localhost:3001 --size 1600x1000 --q ultra --jobs jobs.json --out dir/
// jobs.json: [{ name, shot? | from:[x,y,z], lookAt:[x,y,z], absY? | cam:[x,y,z,yaw,pitch],
//              t?, advance?, seq?, interval?, warm?, jpg? }]
// The page boots once; every job sets camera + time, then captures a still or a stepped sequence.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const next = argv[i + 1];
  flags[a.slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
}
const base = flags.url ?? 'http://localhost:3001';
const [W, H] = String(flags.size ?? '1600x1000').split('x').map(Number);
const q = flags.q ?? 'ultra';
const jobs = JSON.parse(fs.readFileSync(flags.jobs, 'utf8'));
const outDir = flags.out ?? './';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: !flags.headed,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const rafs = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

try {
  const t0 = Date.now();
  const search = new URLSearchParams({ shot: '1', q });
  await page.goto(`${base}/surf/?${search}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => !!window.__goldenline, null, { timeout: 180_000, polling: 250 });
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const job of jobs) {
    const warm = job.warm ?? 45;
    const ext = job.jpg ? 'jpg' : 'png';
    if (job.shot) {
      const ok = await page.evaluate((n) => window.__goldenline.shot(n), job.shot);
      if (!ok) throw new Error(`unknown shot ${job.shot}`);
    } else if (job.from) {
      await page.evaluate(({ from, lookAt, absY }) => {
        const g = window.__goldenline;
        const [x, y0, z] = from;
        const y = absY ? y0 : g.ctx.services.terrain.height(x, z) + y0;
        const dx = lookAt[0] - x, dy = lookAt[1] - y, dz = lookAt[2] - z;
        g.camera(x, y, z, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      }, job);
    } else if (job.cam) {
      await page.evaluate((c) => window.__goldenline.camera(c[0], c[1], c[2], c[3], c[4] ?? 0), job.cam);
    }
    // after camera(): the lock stops the player rig from resetting the lens every frame
    await page.evaluate((fov) => { const c = window.__goldenline.ctx.camera; if (c.fov !== fov) { c.fov = fov; c.updateProjectionMatrix(); } }, job.fov ?? 72);
    if (job.t !== undefined) await page.evaluate((t) => window.__goldenline.setTime(t), job.t);
    if (job.advance) await page.evaluate((s) => window.__goldenline.step(Math.round(s * 60), 1 / 60), job.advance);

    const n = job.seq ?? 1;
    const interval = job.interval ?? 0.25;
    const dir = n > 1 ? path.join(outDir, job.name) : outDir;
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      if (i > 0) await page.evaluate((s) => window.__goldenline.step(Math.round(s * 60), 1 / 60), interval);
      await rafs(n > 1 ? Math.max(8, Math.round(warm / 3)) : warm);
      const file = n > 1 ? path.join(dir, `${String(i).padStart(4, '0')}.${ext}`) : path.join(dir, `${job.name}.${ext}`);
      await page.screenshot({ path: file, type: ext === 'jpg' ? 'jpeg' : 'png', quality: ext === 'jpg' ? 95 : undefined });
      if (n === 1 || i % 30 === 0) console.log(file, (await page.evaluate(() => window.__goldenline.ctx.time.t)).toFixed(3));
    }
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (logs.length) console.log(logs.slice(0, 30).join('\n'));
  await browser.close();
}
