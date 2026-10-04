// /play capture: deterministic capture of snake preview frames. See docs/play-media.md.
// node scripts/play-media/snake-media.mjs --url http://localhost:3001 --theme dark --seed 246 \
//   --from 17.4 --to 27.0 --out <dir> [--size 1600x1000] [--rand 777] [--fmt jpg|png] [--only 206,214]
//   [--engine snake-engine.iife.js] [--pilot snake-autopilot.cjs]   (defaults: the sibling files)
// Boots /snake/, hides the site chrome + HUD with injected CSS, stops the game's own rAF loop, then
// drives the real renderer itself: the pure engine (bundled from components/snake/engine) and a
// scripted autopilot step at exactly 60 Hz, and every second step is drawn and screenshotted (30 fps).
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
const theme = flags.theme ?? 'dark';
const seed = Number(flags.seed ?? 246);
const randSeed = Number(flags.rand ?? 777);
const from = Number(flags.from ?? 17.4);
const to = Number(flags.to ?? 27.0);
const fmt = flags.fmt ?? 'jpg';
const only = flags.only ? String(flags.only).split(',').map(Number) : null; // capture only these frame indices
const [W, H] = String(flags.size ?? '1600x1000').split('x').map(Number);
const outDir = flags.out;
if (!outDir) throw new Error('--out required');
fs.mkdirSync(outDir, { recursive: true });
const here = path.dirname(new URL(import.meta.url).pathname);
const engineSrc = fs.readFileSync(flags.engine ?? path.join(here, 'snake-engine.iife.js'), 'utf8');
const pilotSrc = fs.readFileSync(flags.pilot ?? path.join(here, 'snake-autopilot.cjs'), 'utf8');

const browser = await chromium.launch({
  headless: !flags.headed,
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal'],
});
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
await context.addInitScript((t) => {
  try {
    localStorage.setItem('theme', t);
  } catch {}
}, theme);
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

try {
  await page.goto(`${base}/snake/`, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.addStyleTag({
    content: `
      html, body { overflow: hidden !important; }
      div[data-variant="page"] { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483000 !important; }
      div[data-variant="page"] > div:not([aria-hidden]) { display: none !important; }
      body * { visibility: hidden !important; }
      div[data-variant="page"], div[data-variant="page"] * { visibility: visible !important; }
      body { background: #000 !important; }
      nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }
    `,
  });
  await page.waitForSelector('canvas[data-mounted="1"]', { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__snake), null, { timeout: 30_000 });
  await page.waitForFunction(([w, h]) => { const c = document.querySelector('canvas[aria-label="snake game"]'); return c && c.width === w && c.height === h; }, [W, H], { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.addScriptTag({ content: engineSrc });
  await page.addScriptTag({ content: pilotSrc });

  const info = await page.evaluate(({ seed, randSeed }) => {
    const canvas = document.querySelector('canvas[aria-label="snake game"]');
    const key = Object.keys(canvas).find((k) => k.startsWith('__reactFiber$'));
    let fiber = canvas[key];
    let handle = null;
    const refs = [];
    while (fiber && !handle) {
      let h = fiber.memoizedState;
      while (h && typeof h === 'object' && 'next' in h) {
        const v = h.memoizedState;
        if (v && typeof v === 'object' && 'current' in v && v.current) {
          if (typeof v.current.frame === 'function' && typeof v.current.handleEvents === 'function') handle = v.current;
          else if (v.current.path && v.current.head) refs.push(v);
        }
        h = h.next;
      }
      if (!handle) { refs.length = 0; fiber = fiber.return; }
    }
    if (!handle) throw new Error('renderer handle not found');
    // Stop the game's own loop: freeze it, then make its next requestAnimationFrame a no-op.
    window.__snake.freeze(true);
    window.requestAnimationFrame = () => 0;
    const E = window.__eng;
    const mulberry = (a) => () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const cap = { handle, refs, E, i: 0, s: null, pilot: null, rand: mulberry(randSeed), eats: [] };
    cap.start = () => {
      Math.random = cap.rand;
      cap.s = E.applyInput(E.createInitialState({ seed, best: 0 }), { type: 'start' });
      cap.pilot = window.makePilot(E);
      cap.i = 0;
      handle.reset(cap.s);
    };
    cap.advance = (n, drawLast) => {
      let s = cap.s;
      for (let k = 1; k <= n; k++) {
        const h = cap.pilot(s);
        if (h !== null) s = E.applyInput(s, { type: 'steer', heading: h });
        const prev = s;
        const r = E.step(s, E.SIM_DT);
        s = r.state;
        cap.i++;
        if (r.events.length > 0) {
          handle.handleEvents(r.events, s);
          for (const e of r.events) cap.eats.push(`${(cap.i * E.SIM_DT).toFixed(2)}:${e.type}:${e.food ? e.food.kind : e.cause}`);
        }
        handle.frame({ prev, cur: s, alpha: 1, dt: E.SIM_DT, draw: drawLast && k === n });
      }
      cap.s = s;
      for (const r of refs) r.current = s; // keep the component's refs coherent (loop is stopped)
      return { i: cap.i, t: +(cap.i * E.SIM_DT).toFixed(4), status: s.status, score: s.score, len: +s.bodyLength.toFixed(2) };
    };
    window.__cap = cap;
    return { refs: refs.length, canvas: [canvas.width, canvas.height], dpr: devicePixelRatio };
  }, { seed, randSeed });
  console.log('setup', JSON.stringify(info));
  await page.waitForTimeout(300); // let the frozen loop run once more into the no-op rAF

  await page.evaluate(() => window.__cap.start());
  const startStep = Math.round(from * 60);
  const endStep = Math.round(to * 60);
  // pre-roll without drawing, then a few warm draws at the first capture step
  const st = await page.evaluate((n) => window.__cap.advance(n, true), startStep);
  console.log('pre-roll', JSON.stringify(st));
  await page.waitForTimeout(200);
  let k = 0;
  const t0 = Date.now();
  for (let step = startStep; step <= endStep; step += 2, k++) {
    if (step > startStep) {
      const r = await page.evaluate(() => window.__cap.advance(2, true));
      if (r.status !== 'playing') throw new Error(`status ${r.status} at ${r.t}`);
    }
    if (only && !only.includes(k)) continue;
    const file = path.join(outDir, `${String(k).padStart(4, '0')}.${fmt}`);
    await page.screenshot({ path: file, type: fmt === 'jpg' ? 'jpeg' : 'png', quality: fmt === 'jpg' ? 95 : undefined });
    if (k % 30 === 0) console.log(file, ((step) / 60).toFixed(3), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  console.log('events', JSON.stringify(await page.evaluate(() => window.__cap.eats)));
  console.log('frames', k);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (logs.length) console.log(logs.slice(0, 30).join('\n'));
  await browser.close();
}
