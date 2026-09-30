#!/usr/bin/env node
// GOLDENLINE visual-review tool. Drives /surf/?shot=1 in headless Chromium (WebGPU on Metal)
// through window.__goldenline for deterministic screenshots, frame sequences and perf runs.
// Needs the dev server on :3000 (or --url).
//
//   node scripts/goldenline-shot.mjs --shot beach-sun --out /tmp/x.png
//   node scripts/goldenline-shot.mjs --shot beach-sun,lineup --out shots/        (one file per shot)
//   node scripts/goldenline-shot.mjs --cam -100,0.6,-60,1.7,0 --t 40 --out a.png
//   node scripts/goldenline-shot.mjs --shot lineup --seq 8 --interval 0.25 --out seq/   (motion review)
//   node scripts/goldenline-shot.mjs --shot beach-sun --perf 10 --size 1280x720       (prints JSON; `serial` = CPU+GPU ms per frame, no overlap)
//   node scripts/goldenline-shot.mjs --shot beach-sun --p ocean.swellHeight=1.8 --p post.bloom=0
//   node scripts/goldenline-shot.mjs --list
//   node scripts/goldenline-shot.mjs --boot                                   (startup timeline per stage)
//
// Flags: --size WxH (default 2560x1440) --q low|medium|high|ultra (default high) --warm N rAFs
// before capture (default 45, lets TAA converge) --jpg (quality 92, for committed milestone shots)
// --headed. Console errors and warnings from the page are always printed.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = {};
const multi = { p: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const next = argv[i + 1];
  const v = next === undefined || next.startsWith('--') ? true : (i++, next);
  if (k in multi) multi[k].push(v);
  else flags[k] = v;
}

const base = flags.url ?? 'http://localhost:3000';
const [W, H] = String(flags.size ?? '2560x1440').split('x').map(Number);
const q = flags.q ?? 'high';
const warm = Number(flags.warm ?? 45);
const ext = flags.jpg ? 'jpg' : 'png';

const search = new URLSearchParams({ shot: '1', q });
if (flags.t !== undefined) search.set('t', String(flags.t));
for (const kv of multi.p) {
  const [k, v] = String(kv).split('=');
  search.set(`p.${k}`, v);
}

const browser = await chromium.launch({
  headless: !flags.headed,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const flushLogs = () => {
  if (logs.length) console.log(logs.splice(0).slice(0, 40).join('\n'));
};

try {
  const t0 = Date.now();
  await page.goto(`${base}/surf/?${search}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => !!window.__goldenline, null, { timeout: 180_000, polling: 250 });
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (flags.boot) {
    const boot = await page.evaluate(() => window.__goldenline.boot());
    for (const b of boot) console.log(`${String(b.ms).padStart(7)} ms  ${b.stage}`);
    if (!flags.shot && !flags.cam) process.exit(0);
  }

  if (flags.list) {
    console.log(await page.evaluate(() => window.__goldenline.shots().join('\n')));
    process.exit(0);
  }

  const rafs = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

  const shots = flags.shot ? String(flags.shot).split(',') : [null];
  for (const name of shots) {
    if (name) {
      const ok = await page.evaluate((n) => window.__goldenline.shot(n), name);
      if (!ok) throw new Error(`unknown shot "${name}"`);
    } else if (flags.cam) {
      const [x, y, z, yaw, pitch] = String(flags.cam).split(',').map(Number);
      await page.evaluate(([x, y, z, yaw, pitch]) => window.__goldenline.camera(x, y, z, yaw, pitch ?? 0), [x, y, z, yaw, pitch]);
    }
    if (flags.t !== undefined) await page.evaluate((t) => window.__goldenline.setTime(t), Number(flags.t));
    if (flags.advance) await page.evaluate((s) => window.__goldenline.step(Math.round(s * 60), 1 / 60), Number(flags.advance));

    const label = name ?? 'cam';
    const outArg = flags.out ?? `goldenline-${label}.${ext}`;
    const isDir = outArg.endsWith('/') || shots.length > 1 || flags.seq;
    const dir = isDir ? outArg : path.dirname(outArg);
    fs.mkdirSync(dir, { recursive: true });

    if (flags.perf) {
      const secs = Number(flags.perf);
      await page.evaluate(() => { window.__goldenline.freeze(false); });
      await rafs(30);
      await page.evaluate(() => window.__goldenline.resetPerf());
      await page.waitForTimeout(secs * 1000);
      const perf = await page.evaluate(() => window.__goldenline.perf());
      // serial CPU+GPU frame cost (no vsync quantisation, no overlap): the M3 proxy budget number
      const serial = await page.evaluate(() => window.__goldenline.serialPerf ? window.__goldenline.serialPerf(180) : null);
      console.log(JSON.stringify({ shot: label, size: `${W}x${H}`, q, ...perf, serial }, null, 2));
      await page.evaluate(() => window.__goldenline.freeze(true));
      continue;
    }

    if (flags.seq) {
      const n = Number(flags.seq);
      const interval = Number(flags.interval ?? 0.25);
      for (let i = 0; i < n; i++) {
        if (i > 0) await page.evaluate((s) => window.__goldenline.step(Math.round(s * 60), 1 / 60), interval);
        await rafs(Math.max(8, Math.round(warm / 3)));
        const file = path.join(dir, `${label}_${String(i).padStart(3, '0')}.${ext}`);
        await page.screenshot({ path: file, type: ext === 'jpg' ? 'jpeg' : 'png', quality: ext === 'jpg' ? 92 : undefined });
        console.log(file);
      }
      continue;
    }

    await rafs(warm);
    const file = isDir ? path.join(dir, `${label}.${ext}`) : outArg;
    await page.screenshot({ path: file, type: ext === 'jpg' ? 'jpeg' : 'png', quality: ext === 'jpg' ? 92 : undefined });
    console.log(file);
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  flushLogs();
  await browser.close();
}
