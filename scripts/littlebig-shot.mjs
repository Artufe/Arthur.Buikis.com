#!/usr/bin/env node
// LITTLEBIG visual-review tool. Drives /planet/?shot=1 in headless Chromium (WebGL2 on Metal ANGLE)
// through window.__littlebig for deterministic screenshots, sequences, the scripted dive, perf and
// boot timings. Needs the dev server (default http://localhost:3047, or --url).
//
//   node scripts/littlebig-shot.mjs --shot orbit,city,clouds,rooftops,street,horizon,night,dusk --out docs/littlebig/shots/F0/
//   node scripts/littlebig-shot.mjs --view 20,10,16,45,-30 --t 120 --out a.png     lat,lon,alt,heading,pitch (deg; pitch optional)
//   node scripts/littlebig-shot.mjs --shot street --seq 8 --interval 0.25 --out seq/   frame sequence (sim time steps)
//   node scripts/littlebig-shot.mjs --dive 48 --out dive/                            scripted orbit → street descent
//   node scripts/littlebig-shot.mjs --shot city --perf 240 --size 1280x800          frame-time JSON (serial CPU+GPU ms)
//   node scripts/littlebig-shot.mjs --dive 120 --perf 1 --size 1280x800              per-frame cost along the descent
//   node scripts/littlebig-shot.mjs --boot                                            startup timeline per stage
//   node scripts/littlebig-shot.mjs --list                                            named shots
//   node scripts/littlebig-shot.mjs --leak 10 --close-at 300,ready                    window open/close leak check
//
// Flags: --size WxH (default 1600x1000) · --q low|high (default high) · --p key=value (repeatable,
// param overrides) · --cold (unique shader sources: first-visit compile cost) · --t <s> sim time · --warm N rAFs before each capture (default 6) · --jpg ·
// --headed · --url. Console errors and warnings from the page are always printed.
// --leak N: opens and closes the floating window N times on the home page, alternating between
// closing after each --close-at value (ms after open, or `ready` = once the world is built: the
// close-mid-build case is the one that leaks if anything does), then checks for runaway timers,
// listener growth and engines that are never garbage-collected.

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

const base = (flags.url ?? 'http://localhost:3047').replace(/\/$/, '');
const [W, H] = String(flags.size ?? '1600x1000').split('x').map(Number);
const q = flags.q ?? 'high';
const warm = Number(flags.warm ?? 6);
const ext = flags.jpg ? 'jpg' : 'png';

const search = new URLSearchParams({ shot: '1', q });
if (flags.cold) search.set('cold', '1'); // defeat shader caches: first-visit compile timings
for (const kv of multi.p) {
  const s = String(kv);
  const i = s.indexOf('=');
  search.set(`p.${s.slice(0, i)}`, s.slice(i + 1));
}

const browser = await chromium.launch({
  headless: !flags.headed,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', ...(flags.leak ? ['--js-flags=--expose-gc'] : [])],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const flushLogs = () => {
  if (logs.length) console.log(logs.splice(0).slice(0, 60).join('\n'));
};

const rafs = (n) =>
  page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

const outPath = (label, forceDir) => {
  const outArg = flags.out ?? 'docs/littlebig/shots/';
  const isDir = forceDir || outArg.endsWith('/') || (fs.existsSync(outArg) && fs.statSync(outArg).isDirectory());
  const dir = isDir ? outArg : path.dirname(outArg);
  fs.mkdirSync(dir, { recursive: true });
  return isDir ? path.join(dir, `${label}.${ext}`) : outArg;
};
const snap = async (file) => {
  await page.screenshot({ path: file, type: ext === 'jpg' ? 'jpeg' : 'png', quality: ext === 'jpg' ? 90 : undefined });
  console.log(file);
};

if (flags.leak) {
  try {
    await leakCheck(Number(flags.leak === true ? 10 : flags.leak), String(flags['close-at'] ?? '300,ready').split(','));
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    flushLogs();
    await browser.close();
  }
  process.exit();
}

async function leakCheck(n, closeAts) {
  await page.addInitScript(() => {
    // Count timer activity and keep weak handles on every engine's renderer.
    const st = window.setTimeout.bind(window);
    window.__lbTimeouts = 0;
    window.setTimeout = (fn, ms, ...a) => {
      window.__lbTimeouts++;
      return st(fn, ms, ...a);
    };
    window.__lbRenderers = [];
    setInterval(() => {
      const h = window.__littlebig;
      if (h && !h.__lbSeen) {
        h.__lbSeen = true;
        window.__lbRenderers.push(new WeakRef(h.ctx.renderer));
      }
    }, 5);
  });
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: 180_000 });
  await page.waitForTimeout(1500);
  const cdp = await page.context().newCDPSession(page);
  const listeners = async () => {
    const out = {};
    for (const expr of ['window', 'document']) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      const { listeners: l } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      out[expr] = l.length;
    }
    return out;
  };
  const timerRate = () =>
    page.evaluate(async () => {
      const a = window.__lbTimeouts;
      await new Promise((r) => setTimeout(r, 1000));
      return window.__lbTimeouts - a - 1;
    });
  // One warm-up cycle first: the window host's own lazy modules (and the site's) attach their
  // listeners on first use; the baseline is taken after it.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('planet:open')));
  await page.waitForFunction(() => window.__littlebig?.ready === true, null, { timeout: 120_000, polling: 20 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('planet:close')));
  await page.waitForTimeout(1500);
  const before = await listeners();
  const rateBefore = await timerRate();
  for (let i = 0; i < n; i++) {
    const at = closeAts[i % closeAts.length];
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('planet:open')));
    if (at === 'ready') await page.waitForFunction(() => window.__littlebig?.ready === true, null, { timeout: 60_000, polling: 20 });
    else await page.waitForTimeout(Number(at));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('planet:close')));
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1500);
  const rate = await timerRate();
  const gc = await page.evaluate(async () => {
    for (let k = 0; k < 6; k++) {
      window.gc?.();
      await new Promise((r) => setTimeout(r, 100));
    }
    return { tracked: window.__lbRenderers.length, alive: window.__lbRenderers.filter((w) => w.deref()).length, hook: !!window.__littlebig };
  });
  const after = await listeners();
  const res = { cycles: n, closeAt: closeAts, timeoutsPerSecondBefore: rateBefore, timeoutsPerSecondAfter: rate, enginesTracked: gc.tracked, enginesAlive: gc.alive, hookLeft: gc.hook, listenersBefore: before, listenersAfter: after };
  console.log(JSON.stringify(res, null, 2));
  if (rate > rateBefore + 5 || gc.alive > 0 || gc.hook || after.window > before.window || after.document > before.document) {
    console.error('LEAK suspected');
    process.exitCode = 1;
  }
}

try {
  const t0 = Date.now();
  await page.goto(`${base}/planet/?${search}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__littlebig, null, { timeout: 180_000, polling: 100 });
  const tHook = Date.now() - t0;
  await page.waitForFunction(() => window.__littlebig?.ready === true, null, { timeout: 120_000, polling: 100 });
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(2)}s (hook after ${(tHook / 1000).toFixed(2)}s)`);
  if (flags.t !== undefined) await page.evaluate((t) => window.__littlebig.setTime(t), Number(flags.t));

  if (flags.boot) {
    const boot = await page.evaluate(() => window.__littlebig.boot());
    for (const b of boot) console.log(`${String(b.ms).padStart(8)} ms  @${String(b.at).padStart(6)}  ${b.stage}`);
  }
  if (flags.list) {
    const list = await page.evaluate(() => window.__littlebig.shots());
    for (const s of list) console.log(`${s.name.padEnd(10)} ${s.about}`);
  }

  // ── dive ──
  if (flags.dive) {
    const n = Math.max(2, Number(flags.dive === true ? 48 : flags.dive));
    const glide = Number(flags.interval ?? 1 / 30);
    if (flags.perf) {
      const res = await page.evaluate(async ({ n, glide }) => {
        const h = window.__littlebig;
        h.loop(false);
        await new Promise((r) => setTimeout(r, 30));
        const gl = h.ctx.renderer.getContext();
        const px = new Uint8Array(4);
        const ts = [];
        let calls = 0;
        for (let i = 0; i < n + 10; i++) {
          const u = Math.max(0, i - 10) / (n - 1);
          const a = performance.now();
          h.dive(u, glide);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (i >= 10) ts.push(performance.now() - a);
          calls = Math.max(calls, h.ctx.renderer.info.render.calls);
        }
        h.loop(true);
        const so = ts.slice().sort((a, b) => a - b);
        const median = so[so.length >> 1];
        return { frames: n, median, p95: so[Math.floor(so.length * 0.95)], max: so[so.length - 1], hitches: ts.filter((t) => t > median + 6).length, maxDrawCalls: calls };
      }, { n, glide });
      console.log(JSON.stringify({ dive: true, size: `${W}x${H}`, q, ...res }, null, 2));
    } else {
      for (let i = 0; i < n; i++) {
        await page.evaluate(({ u, glide, i }) => window.__littlebig.dive(u, i === 0 ? 0 : glide), { u: i / (n - 1), glide, i });
        await rafs(Math.max(2, Math.round(warm / 2)));
        await snap(outPath(`dive_${String(i).padStart(3, '0')}`, true));
      }
    }
  }

  // ── shots / custom view ──
  const names = flags.shot ? String(flags.shot).split(',') : flags.view ? ['view'] : [];
  for (const name of names) {
    if (name === 'view') {
      const [lat, lon, alt, heading, pitch] = String(flags.view).split(',').map(Number);
      const v = { lat, lon, alt, heading: heading || 0 };
      if (Number.isFinite(pitch)) v.pitch = pitch;
      await page.evaluate((v) => window.__littlebig.setView(v), v);
    } else {
      const ok = await page.evaluate((n) => window.__littlebig.shot(n), name);
      if (!ok) throw new Error(`unknown shot "${name}" (try --list)`);
    }
    if (flags.t !== undefined) await page.evaluate((t) => window.__littlebig.setTime(t), Number(flags.t));

    if (flags.perf) {
      const frames = Number(flags.perf === true ? 240 : flags.perf);
      const res = await page.evaluate((f) => window.__littlebig.perf(f), frames);
      const state = await page.evaluate(() => window.__littlebig.state());
      console.log(JSON.stringify({ shot: name, size: `${W}x${H}`, q, alt: +state.alt.toFixed(2), ...res }, null, 2));
      continue;
    }
    if (flags.seq) {
      const n = Number(flags.seq);
      const interval = Number(flags.interval ?? 0.25);
      for (let i = 0; i < n; i++) {
        if (i > 0) await page.evaluate((s) => window.__littlebig.step(1 / 60, Math.max(1, Math.round(s * 60))), interval);
        await rafs(Math.max(2, warm));
        await snap(outPath(`${name}_${String(i).padStart(3, '0')}`, true));
      }
      continue;
    }
    await rafs(warm);
    await snap(outPath(name, names.length > 1));
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  flushLogs();
  await browser.close();
}
