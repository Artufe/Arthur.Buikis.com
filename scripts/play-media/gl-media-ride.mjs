// /play capture: gl-media.mjs extended with a `ride` job: plays the game's own surf demo
// (surf.demo = 1, the closed-loop scripted ride in components/goldenline/surf/demos.ts) through the
// player's first-person camera, stepping the sim deterministically 1/30 s per output frame
// (2 x 1/60 updates, like the game at 60 Hz sampled every other frame), settling TAA with frozen
// rAFs before each capture. Not part of the site.
//
// node scripts/play-media/gl-media-ride.mjs --url http://localhost:3001 --size 1280x800 --q ultra --jobs jobs.json --out dir/
// jobs.json: [{ name, ride: { demo?: 1, start: <sim t of first frame>, frames: N, every?: 1,
//                             settle?: 20, reduced?: true, log?: true } }]
//   Frames land at <out>/<name>/NNNN.jpg (index = frame number in the window, q95), plus
//   <out>/<name>/log.json (per frame: sim t, mode, demo phase, board, speed, camera pose, fov).
// Still/sequence jobs from gl-media.mjs (shot/from/cam/t/advance/seq) are kept unchanged.
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

/** One output frame: 1/30 s of sim as two 1/60 updates (renders once). Returns the frame's state. */
const stepFrame = () => page.evaluate(() => {
  const g = window.__goldenline;
  g.step(2, 1 / 60);
  const S = window.__surf;
  const rig = g.ctx.services.player;
  const c = g.ctx.camera;
  const st = S?.ride?.state;
  return {
    t: +g.ctx.time.t.toFixed(4), mode: rig.mode, phase: S?.player?.phase ?? '',
    board: [rig.boardPosition.x, rig.boardPosition.y, rig.boardPosition.z].map((v) => +v.toFixed(3)),
    speed: st ? +st.speed.toFixed(2) : 0, tube: st ? +st.tube.toFixed(2) : 0,
    cam: [c.position.x, c.position.y, c.position.z].map((v) => +v.toFixed(3)),
    rot: [c.rotation.x, c.rotation.y, c.rotation.z].map((v) => +v.toFixed(4)), fov: +c.fov.toFixed(2),
  };
});

try {
  const t0 = Date.now();
  const search = new URLSearchParams({ shot: '1', q });
  // The dev server sometimes answers a 500 while it recompiles: retry the boot.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${base}/surf/?${search}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForFunction(() => !!window.__goldenline, null, { timeout: 180_000, polling: 250 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`boot attempt ${attempt} failed (${e.message.split('\n')[0]}), retrying`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const job of jobs) {
    if (job.ride) {
      const r = job.ride;
      const every = r.every ?? 1;
      const settle = r.settle ?? 20;
      const dir = path.join(outDir, job.name);
      fs.mkdirSync(dir, { recursive: true });
      // Resume: skip the frames already on disk (the sim is deterministic, so pre-rolling to the
      // first missing frame reproduces it exactly; each capture settles TAA on its own).
      let from = r.from ?? 0;
      if (r.resume) while (from < r.frames && fs.existsSync(path.join(dir, `${String(from).padStart(4, '0')}.jpg`))) from++;
      if (from >= r.frames) { console.log(`${job.name}: all ${r.frames} frames present`); continue; }
      // Reduced motion (the game's own path): no head-spring shake, no FOV kick, no bob.
      await page.evaluate((on) => { window.__goldenline.ctx.reducedMotion = !!on; }, r.reduced);
      // Start the demo: the surf system picks surf.demo up on its next update (it sets t, teleports
      // the player into the lineup and releases any locked camera). Zero-dt rAFs don't advance it.
      await page.evaluate((d) => { window.__goldenline.setParam('surf.demo', 0); }, 0);
      await rafs(2);
      await page.evaluate((d) => window.__goldenline.setParam('surf.demo', d), r.demo ?? 1);
      await rafs(3);
      const startT = await page.evaluate(() => window.__goldenline.ctx.time.t);
      console.log(`${job.name}: demo ${r.demo ?? 1} started at t=${startT.toFixed(3)}, pre-roll to ${r.start}`);
      // Pre-roll with exactly the same per-frame stepping as the capture (no rAFs, no captures).
      let s = null;
      let pre = 0;
      const firstT = r.start + from / 30;
      while ((await page.evaluate(() => window.__goldenline.ctx.time.t)) < firstT - 1 / 30 + 1e-4) {
        s = await stepFrame();
        pre++;
      }
      console.log(`  pre-rolled ${pre} frames → t=${s?.t}; capturing ${from}..${r.frames - 1}`);
      const logFile = path.join(outDir, `${job.name}-log.json`);
      const log = r.resume && fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')).filter((e) => e.i < from) : [];
      for (let i = from; i < r.frames; i++) {
        s = await stepFrame();
        log.push({ i, ...s });
        if (i % every !== 0) continue;
        await rafs(settle);
        const file = path.join(dir, `${String(i).padStart(4, '0')}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 95 });
        fs.writeFileSync(logFile, JSON.stringify(log));
        if (i % 15 === 0) console.log(`  ${file} t=${s.t} ${s.mode}/${s.phase} v=${s.speed} tube=${s.tube}`);
      }
      continue;
    }

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
