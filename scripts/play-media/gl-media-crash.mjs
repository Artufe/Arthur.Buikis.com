// /play capture: gl-media.mjs + per-frame camera keyframes (crash scene, v2). See docs/play-media.md.
// node scripts/play-media/gl-media-crash.mjs --url http://localhost:3001 --size 1280x800 --q ultra --jobs jobs.json --out dir/
// jobs.json: [{ name, cam0:[x,y,z,yawDeg,pitchDeg], cam1:[...], fov?, t, advance?, seq, interval?, settle?,
//              capture?:[frame indices] }]
// y is absolute. The camera is interpolated linearly in position, yaw and pitch from cam0 (frame 0)
// to cam1 (frame seq-1): constant velocity through every frame, handles included. For frame i the
// camera is set *before* that frame's sim step, so the sim and the render both see frame i's camera.
// Each captured frame gets `settle` rAFs (time frozen) for TAA to converge; uncaptured frames are
// only stepped (preview mode), which leaves the deterministic sim state unchanged.
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
const [W, H] = String(flags.size ?? '1280x800').split('x').map(Number);
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
let deviceLost = false; // shared GPU: a lost device renders black from then on, so stop at once
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
  if (/Device Lost|no longer exists/i.test(m.text())) deviceLost = true;
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const rafs = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const D2R = Math.PI / 180;
const lerp = (a, b, s) => a + (b - a) * s;
const camAt = (job, i) => {
  const n = job.seq ?? 1;
  const s = n > 1 ? i / (n - 1) : 0;
  return job.cam0.map((v, k) => lerp(v, job.cam1 ? job.cam1[k] : v, s));
};
const setCam = (c, fov) => page.evaluate(({ c, fov, D2R }) => {
  const g = window.__goldenline;
  g.camera(c[0], c[1], c[2], c[3] * D2R, c[4] * D2R);
  const cam = g.ctx.camera;
  if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
}, { c, fov, D2R });

try {
  const t0 = Date.now();
  const search = new URLSearchParams({ shot: '1', q });
  await page.goto(`${base}/surf/?${search}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => !!window.__goldenline, null, { timeout: 180_000, polling: 250 });
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const job of jobs) {
    const tj = Date.now();
    const fov = job.fov ?? 45;
    const n = job.seq ?? 1;
    const interval = job.interval ?? 1 / 30;
    const sub = Math.round(interval * 60);
    const settle = job.settle ?? 20;
    const capture = job.capture ? new Set(job.capture) : null;
    const dir = path.join(outDir, job.name);
    fs.mkdirSync(dir, { recursive: true });
    const meta = [];

    await setCam(camAt(job, 0), fov);
    await page.evaluate((t) => window.__goldenline.setTime(t), job.t);
    if (job.advance) await page.evaluate((s) => window.__goldenline.step(Math.round(s * 60), 1 / 60), job.advance);

    for (let i = 0; i < n; i++) {
      const c = camAt(job, i);
      if (i > 0) {
        await setCam(c, fov);
        await page.evaluate((k) => window.__goldenline.step(k, 1 / 60), sub);
      }
      const simT = await page.evaluate(() => window.__goldenline.ctx.time.t);
      meta.push({ i, t: +simT.toFixed(4), cam: c.map((v) => +v.toFixed(4)) });
      if (capture && !capture.has(i)) continue;
      await rafs(settle);
      if (deviceLost) throw new Error(`WebGPU device lost before frame ${i}`);
      const file = path.join(dir, `${String(i).padStart(4, '0')}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 95 });
      if (deviceLost) { fs.rmSync(file); throw new Error(`WebGPU device lost at frame ${i}`); }
      if (capture || i % 15 === 0) console.log(`${job.name} ${file} t=${simT.toFixed(3)} cam=${c.map((v) => v.toFixed(2)).join(',')} (${((Date.now() - tj) / 1000).toFixed(0)}s)`);
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ job, frames: meta }, null, 1));
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (logs.length) console.log(logs.slice(0, 30).join('\n'));
  await browser.close();
}
