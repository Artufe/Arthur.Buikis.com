// /play capture: gl-media.mjs + per-frame camera keyframes. See docs/play-media.md.
// node scripts/play-media/gl-media-ashore.mjs --url http://localhost:3001 --size 1280x800 --q ultra --jobs jobs.json --out dir/
// jobs.json: [{ name, t, advance, seq, interval?=1/30, settle?=20, fov?=72, absY?,
//              keys: [{ f, from:[x,y,z], lookAt:[x,y,z] }, ...],   // piecewise-linear in frame index
//              capture?: [frame indices] | from?: first captured frame (default: all), jpg?=true,
//              ffSettle?=3 (rAFs after each non-captured frame's step, so async readbacks land as in a full run) }]
// Aborts the job if the WebGPU device is lost (the GPU is shared): resume with `from` in a new boot.
// Each key is resolved to an absolute position + yaw/pitch (y = terrain(x,z) + y unless absY), then
// position, yaw and pitch are interpolated linearly per frame: constant velocity, no terrain bobbing.
// setTime + advance run in one evaluate (no rAF between them), so the surf-zone spin-up is deterministic.
// Frame i: set camera(i), step `interval` of sim at 1/60, `settle` rAFs (time frozen) for TRAA, screenshot.
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
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
let deviceLost = false;
page.on('console', (m) => { if (/Device Lost|external Instance reference/i.test(m.text())) deviceLost = true; });

const rafs = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

try {
  const t0 = Date.now();
  const search = new URLSearchParams({ shot: '1', q });
  await page.goto(`${base}/surf/?${search}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => !!window.__goldenline, null, { timeout: 180_000, polling: 250 });
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const job of jobs) {
    const jt = Date.now();
    const n = job.seq ?? 1;
    const interval = job.interval ?? 1 / 30;
    const settle = job.settle ?? 20;
    const fov = job.fov ?? 72;
    const ext = job.jpg === false ? 'png' : 'jpg';
    const capture = new Set(job.capture ?? Array.from({ length: n }, (_, i) => i).filter((i) => i >= (job.from ?? 0)));
    const ffSettle = job.ffSettle ?? 3;
    const dir = path.join(outDir, job.name);
    fs.mkdirSync(dir, { recursive: true });

    // Resolve keys → absolute pose (x, y, z, yaw, pitch).
    const keys = await page.evaluate(({ keys, absY }) => {
      const g = window.__goldenline;
      return keys.map((k) => {
        const [x, y0, z] = k.from;
        const y = absY ? y0 : g.ctx.services.terrain.height(x, z) + y0;
        const dx = k.lookAt[0] - x, dy = k.lookAt[1] - y, dz = k.lookAt[2] - z;
        return { f: k.f, x, y, z, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
      });
    }, { keys: job.keys, absY: !!job.absY });
    keys.sort((a, b) => a.f - b.f);
    const pose = (i) => {
      let a = keys[0], b = keys[keys.length - 1];
      for (let k = 0; k < keys.length - 1; k++) if (i >= keys[k].f && i <= keys[k + 1].f) { a = keys[k]; b = keys[k + 1]; break; }
      const u = b.f === a.f ? 0 : Math.min(1, Math.max(0, (i - a.f) / (b.f - a.f)));
      const L = (p, q) => p + (q - p) * u;
      return { x: L(a.x, b.x), y: L(a.y, b.y), z: L(a.z, b.z), yaw: L(a.yaw, b.yaw), pitch: L(a.pitch, b.pitch) };
    };
    const setCam = (p) => page.evaluate(({ p, fov }) => {
      const g = window.__goldenline;
      g.camera(p.x, p.y, p.z, p.yaw, p.pitch);
      const c = g.ctx.camera;
      if (c.fov !== fov) { c.fov = fov; c.updateProjectionMatrix(); }
    }, { p, fov });

    await setCam(pose(0));
    await page.evaluate(({ t, adv }) => {
      const g = window.__goldenline;
      g.setTime(t);
      g.step(Math.round(adv * 60), 1 / 60);
    }, { t: job.t, adv: job.advance ?? 0 });

    const log = [];
    for (let i = 0; i < n; i++) {
      const p = pose(i);
      if (i > 0) {
        await setCam(p);
        await page.evaluate((s) => window.__goldenline.step(Math.round(s * 60), 1 / 60), interval);
      }
      const tNow = await page.evaluate(() => window.__goldenline.ctx.time.t);
      log.push({ i, t: +tNow.toFixed(4), ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +v.toFixed(5)])) });
      if (!capture.has(i)) { if (ffSettle) await rafs(ffSettle); continue; }
      await rafs(settle);
      if (deviceLost) throw new Error(`WebGPU device lost before capturing frame ${i}; resume with "from": ${i}`);
      const file = path.join(dir, `${String(i).padStart(4, '0')}.${ext}`);
      await page.screenshot({ path: file, type: ext === 'jpg' ? 'jpeg' : 'png', quality: ext === 'jpg' ? 95 : undefined });
      if (job.check?.includes(i)) { // TRAA convergence check: same state, `settle` vs settle + checkSettle rAFs
        await page.screenshot({ path: file.replace(`.${ext}`, '_a.png'), type: 'png' });
        await rafs(job.checkSettle ?? 60);
        await page.screenshot({ path: file.replace(`.${ext}`, '_b.png'), type: 'png' });
      }
      if (capture.size < 40 || i % 15 === 0) console.log(file, tNow.toFixed(3), `cam ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} yaw ${(p.yaw * 180 / Math.PI).toFixed(2)} pitch ${(p.pitch * 180 / Math.PI).toFixed(2)}`);
    }
    fs.writeFileSync(path.join(dir, `cameras${job.from ? '-from' + job.from : ''}.json`), JSON.stringify({ job, keys, frames: log }, null, 1));
    console.log(`job ${job.name}: ${((Date.now() - jt) / 1000).toFixed(1)}s`);
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (logs.length) console.log(logs.slice(0, 30).join('\n'));
  await browser.close();
}
