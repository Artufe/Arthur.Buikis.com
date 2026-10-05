#!/usr/bin/env node
// LITTLEBIG /play clip frames: the scripted dive (orbit → cloud layer → a downtown street), rendered
// frame by frame at 30 fps through window.__littlebig in headless Chromium (WebGL2 on Metal ANGLE),
// with the world moving (each frame advances the sim by 1/30 s), then a hold on the landing (camera
// still, life going on), plus a pre-roll on the opening globe for the loop's dissolve.
//
//   node scripts/play-media/littlebig-clip.mjs --t0 4.75 --hold 2 --out /tmp/lb-clip/
//   node scripts/play-media/littlebig-clip.mjs --t0 4.75 --only 300 --fmt png --size 1600x1000 --out /tmp/lb-poster/
//
// Writes <out>/pre_000..pre_<P−1> (the globe, sim t0 − P/30 … t0 − 1/30, camera at the dive's start)
// and <out>/f_000..f_<N−1>: f_000..f_300 the dive (sim t0 … t0 + 10 s, exactly `littlebig-shot.mjs
// --dive 301 --t t0`), then hold × 30 frames on the landing. The pre-roll is rendered first and the
// dive starts from its own setTime(t0) (a time jump re-places people and traffic from t alone), so
// the dive is the one littlebig-scan.mjs scored. `--only a-b,c` saves just those f_ frames (all are
// still simulated). Flags: --size (1280x800) · --fmt jpg|png (jpg q95) · --pre 15 · --q high ·
// --url http://localhost:3047 · --p key=value (param overrides).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = {};
const ps = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  if (k === 'p') ps.push(String(v));
  else flags[k] = v;
}
const t0 = Number(flags.t0 ?? 4.75);
const hold = Number(flags.hold ?? 2);
const pre = Number(flags.pre ?? 15);
const [W, H] = String(flags.size ?? '1280x800').split('x').map(Number);
const fmt = flags.fmt === 'png' ? 'png' : 'jpg';
const out = String(flags.out ?? 'docs/littlebig/shots/C1/clip/');
fs.mkdirSync(out, { recursive: true });
const only = flags.only
  ? String(flags.only).split(',').map((r) => {
      const [a, b] = r.split('-').map(Number);
      return [a, Number.isFinite(b) ? b : a];
    })
  : null;
const keep = (i) => !only || only.some(([a, b]) => i >= a && i <= b);

const search = new URLSearchParams({ shot: '1', q: String(flags.q ?? 'high') });
for (const kv of ps) search.set(`p.${kv.slice(0, kv.indexOf('='))}`, kv.slice(kv.indexOf('=') + 1));

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${String(flags.url ?? 'http://localhost:3047').replace(/\/$/, '')}/planet/?${search}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__littlebig?.ready === true, null, { timeout: 180000, polling: 100 });

const rafs = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const snap = async (name) => {
  const file = path.join(out, `${name}.${fmt}`);
  await rafs(3);
  await page.screenshot({ path: file, type: fmt === 'png' ? 'png' : 'jpeg', quality: fmt === 'png' ? undefined : 95 });
};

const diveSeconds = await page.evaluate(() => window.__littlebig.diveSeconds);
const N = Math.round(diveSeconds * 30) + 1;
const glide = diveSeconds / (N - 1);
const nHold = Math.round(hold * 30);
console.log(`t0 ${t0}: ${pre} pre-roll + ${N} dive + ${nHold} hold frames, ${W}x${H} ${fmt}`);

if (pre > 0 && !only) {
  await page.evaluate((t) => window.__littlebig.setTime(t), t0 - pre * glide);
  for (let p = 0; p < pre; p++) {
    await page.evaluate(({ p, glide }) => window.__littlebig.dive(0, p ? glide : 0), { p, glide });
    await snap(`pre_${String(p).padStart(3, '0')}`);
  }
}
await page.evaluate((t) => window.__littlebig.setTime(t), t0);
for (let i = 0; i < N + nHold; i++) {
  await page.evaluate(({ u, g }) => window.__littlebig.dive(u, g), { u: Math.min(1, i / (N - 1)), g: i ? glide : 0 });
  if (keep(i)) await snap(`f_${String(i).padStart(3, '0')}`);
}
console.log(out);
await browser.close();
