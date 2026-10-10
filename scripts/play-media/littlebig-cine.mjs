#!/usr/bin/env node
// LITTLEBIG trailer footage: renders a job file frame by frame in headless Chromium (WebGL2 on Metal
// ANGLE) through window.__littlebig (core/debug.ts), the sim advancing 1/fps per frame, with a free
// cinematic camera (cine) or the game's own (a ride, the bird chase). Run against the dev server.
//
//   node scripts/play-media/littlebig-cine.mjs job.json --draft            # 960x600, every 2nd frame
//   node scripts/play-media/littlebig-cine.mjs job.json --out /tmp/shot/   # the final frames
//   flags: --out dir · --draft · --only a-b[,c] · --dpr n · --blur n · --url http://localhost:3000
//
// Writes <out>/f_000.jpg … (JPEG q95; the head handles first: f_<handles> is the job's frame 0),
// cine.json (per frame: the sim time, the camera's world position and its clearance over roofs and
// terrain; frames under 0.5 m, inside or about to clip, are printed as WARNING lines), sheet.jpg
// (contact sheet) and preview.mp4 (x264 CRF 18, yuv420p, +faststart; at fps/2 for a draft). The
// WebGL canvas itself is captured (no HTML overlays).
//
// Job JSON (every field but camera.keys optional):
//   out       output folder (default docs/littlebig/shots/cine/<job file name>/, gitignored; --out wins)
//   t0        sim time (s) set before setup (default 0). Frame 0 is at t0 when setup doesn't advance
//             time (its advance/step calls move frame 0 later); cine.json records every frame's.
//   seconds   length from frame 0 (default 3); fps (default 30)
//   size      "WxH" (default "1920x1200", 16:10: the trailer crops the central 1920x1080 band)
//   dpr       1 or 2 (default 2): render at size × dpr, downscaled to size (canvas 'high' filtering)
//   blur      sub-frames averaged per frame for motion blur (default 8; 1 = off), spread over
//   shutter   the open fraction of a frame (default 0.5, a 180° shutter); the shutter opens at the
//             frame's time. (The bird integrates in steps ≤ 1/120 s, so blur shifts its course a hair.)
//             Defaults cost ~0.7 s per frame (M-series, 1920x1200); dpr 2 blur 4 ~0.25 s, dpr 1
//             blur 1 ~0.03 s. Fast overlays (the cloud crossing) step visibly under blur: use 1 there.
//   q         quality preset (default "high")
//   params    { "key": value } p.* overrides at boot (e.g. { "sky.timeScale": 0 })
//   setup     hook calls in order before frame 0, each [method, ...args]:
//             [["setView", {"lat": 12, "lon": 40, "alt": 60, "heading": 90, "pitch": -20}], ["fly"],
//              ["advance", 2, 30], ["ride", "car:3"], ["birdInput", {"climb": 0.4}]]
//             An argument "$ctx" passes the game context: an exact bird start is
//             ["ctx.services.camera.director.restore", "$ctx", {version: 1, mode: "bird", flight, logDistance}]
//   hide      scene object names to hide for the whole shot, e.g. ["air:contrails", "lighthouse beam"]
//   bird      input timeline [{ "t": 0, "steer": 0, "climb": 0, "flap": false, "dive": false }],
//             t from frame 0, each held until the next (missing fields 0 / false)
//   handles   extra frames rendered before frame 0 and after the last (default 0)
//   camera    { "mode": "cine" (default if keys) | "game" (leave the game's camera: explore, a ride's
//               chase, the bird's), "lag": 0.3, "near": cap on the near plane (m; default 3 % of the
//               height over the terrain: set ~0.3 to film something a few metres off from high up),
//               "keys": [...] }
//     keys    [{ "t": 0,                                       (s from frame 0)
//                 eye: "eye": [x,y,z] world | "eyeGeo": {lat, lon, alt} (alt m over terrain/sea) |
//                      "eyeFrom": { "id": "car:3" | "bird" | …, "offset": [right, up, back] (m) }
//                 look: "look": [x,y,z] | "lookGeo": {lat, lon, alt} | "lookAt": id (+ "lookOffset":
//                      [right, up, back] m; negative back looks ahead of it)
//                 "fov": 40 (vertical deg; held from the previous key when missing), "roll": 0 (deg,
//                 + banks right), "up": [x,y,z] (held from here on; default the radial up: give one to
//                 look straight down), "ease": true|false }]
//             Eye and look each follow a centripetal Catmull-Rom spline through their keys (no
//             loops or cusps), timed by a monotone cubic through the key times: velocity is
//             continuous through keys, and an eased key is a stop (zero speed there). The first and
//             last keys ease unless "ease": false (then the move carries on at its end speed through
//             the handles). Keys on a moving id (eyeFrom, lookAt) are re-solved every sub-frame at
//             that moment, in the target's level frame (radial up, its heading smoothed over
//             camera.lag s so turns swing the camera round instead of snapping it).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = {};
let jobFile = null;
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) {
    jobFile = argv[i];
    continue;
  }
  const k = argv[i].slice(2);
  flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
if (!jobFile) {
  console.error('usage: node scripts/play-media/littlebig-cine.mjs job.json [--draft] [--out dir] [--only a-b] [--dpr n] [--blur n]');
  process.exit(1);
}
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
const draft = !!flags.draft;
const fps = Number(job.fps ?? 30);
const [W, H] = draft ? [960, 600] : String(job.size ?? '1920x1200').split('x').map(Number);
const dpr = draft ? 1 : Number(flags.dpr ?? job.dpr ?? 2);
const blur = draft ? 1 : Math.min(64, Math.max(1, Math.round(Number(flags.blur ?? job.blur ?? 8))));
const shutter = Number(job.shutter ?? 0.5);
const handles = Math.round(Number(job.handles ?? 0));
const body = Math.round(Number(job.seconds ?? 3) * fps);
const N = handles + body + handles;
const pad = Math.max(3, String(N - 1).length);
const out = String(flags.out ?? job.out ?? `docs/littlebig/shots/cine/${path.basename(jobFile, '.json')}/`);
const only = flags.only
  ? String(flags.only).split(',').map((r) => {
      const [a, b] = r.split('-').map(Number);
      return [a, Number.isFinite(b) ? b : a];
    })
  : null;
const keep = (j) => (!only || only.some(([a, b]) => j >= a && j <= b)) && (!draft || j % 2 === 0);
const cam = job.camera ?? {};
const cine = (cam.mode ?? (cam.keys?.length ? 'cine' : 'game')) === 'cine';
if (cine && !cam.keys?.length) throw new Error('camera.mode "cine" needs camera.keys');

fs.mkdirSync(out, { recursive: true });
if (!only) for (const f of fs.readdirSync(out)) if (/^f_\d+\.jpg$/.test(f)) fs.unlinkSync(path.join(out, f));

const search = new URLSearchParams({ shot: '1', q: String(job.q ?? 'high') });
if (dpr !== 1) search.set('dpr', String(dpr));
for (const [k, v] of Object.entries(job.params ?? {})) search.set(`p.${k}`, String(v));

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !m.text().includes('willReadFrequently') && console.log(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${String(flags.url ?? 'http://localhost:3000').replace(/\/$/, '')}/planet/?${search}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__littlebig?.ready === true, null, { timeout: 180000, polling: 100 });

  const info = await page.evaluate(install, { job, cine, fps, handles, blur, shutter, W, H });
  console.log(`${path.basename(jobFile)}: ${N} frames (${handles} + ${body} + ${handles}) ${W}x${H} dpr ${dpr} blur ${blur}, canvas ${info.canvas}, sim t ${info.t.toFixed(3)} at f_${String(handles).padStart(pad, '0')}${draft ? ' (draft)' : ''}`);

  const t0 = Date.now();
  let saved = 0;
  for (let j = 0; j < N; j++) {
    const data = await page.evaluate(({ j, cap }) => window.__cine.frame(j, cap), { j, cap: keep(j) });
    if (!data) continue;
    fs.writeFileSync(path.join(out, `f_${String(j).padStart(pad, '0')}.jpg`), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
    saved++;
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(`${saved} frames saved in ${secs.toFixed(1)} s: ${(secs / Math.max(1, saved)).toFixed(2)} s per saved frame, ${(secs / N).toFixed(2)} s per simulated frame`);
  const { times, eyes, clears } = await page.evaluate(() => window.__cine);
  fs.writeFileSync(path.join(out, 'cine.json'), JSON.stringify({ job: path.resolve(jobFile), fps, size: `${W}x${H}`, dpr, blur, shutter, draft, handles, frames: N, frame0: handles, simT: times, eye: eyes, clear: clears }));
  // Frames whose eye is inside or within 0.5 m of geometry, as ranges.
  const bad = [];
  clears.forEach((c, j) => {
    if (c === null || c >= 0.5) return;
    const r = bad.at(-1);
    if (r && r.b === j - 1) (r.b = j), (r.min = Math.min(r.min, c));
    else bad.push({ a: j, b: j, min: c });
  });
  for (const r of bad) console.log(`WARNING: eye inside or within 0.5 m of geometry at f_${String(r.a).padStart(pad, '0')}-f_${String(r.b).padStart(pad, '0')} (clearance down to ${r.min} m)`);
} finally {
  await browser.close();
}

const files = fs.readdirSync(out).filter((f) => /^f_\d+\.jpg$/.test(f)).sort();
if (files.length) {
  const step = Math.max(1, Math.ceil(files.length / 30));
  const pick = files.filter((_, i) => i % step === 0).map((f) => path.join(out, f));
  execFileSync('python3', [path.join(path.dirname(new URL(import.meta.url).pathname), 'snake-sheet.py'), path.join(out, 'sheet.jpg'), '6', '320', ...pick]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(draft ? fps / 2 : fps), '-pattern_type', 'glob', '-i', path.join(out, 'f_*.jpg'), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', path.join(out, 'preview.mp4')]);
}
console.log(out);

// ── In the page ──
function install({ job, cine, fps, handles, blur, shutter, W, H }) {
  const lb = window.__littlebig;
  const gl = lb.ctx.canvas;
  lb.loop(false);
  lb.setTime(Number(job.t0 ?? 0) - handles / fps);
  for (const [m, ...args] of job.setup ?? []) {
    const fn = m.split('.').reduce((o, k) => o?.[k], lb);
    if (typeof fn !== 'function') throw new Error(`setup: no hook method ${m}`);
    fn.apply(m.includes('.') ? lb[m.split('.')[0]] : lb, args.map((a) => (a === '$ctx' ? lb.ctx : a)));
  }
  const hide = new Set(job.hide ?? []);
  if (hide.size) lb.ctx.scene.traverse((o) => { if (hide.has(o.name)) o.visible = false; });
  const S = { t: -handles / fps, err: null };
  const bird = (job.bird ?? []).slice().sort((a, b) => a.t - b.t);
  const birdAt = (t) => {
    let k = null;
    for (const b of bird) if (b.t <= t + 1e-9) k = b;
    return k ?? bird[0];
  };
  const setBird = (t) => {
    const b = bird.length ? birdAt(t) : null;
    if (b) lb.birdInput({ steer: b.steer ?? 0, climb: b.climb ?? 0, flap: !!b.flap, dive: !!b.dive });
  };

  // Vector helpers on [x, y, z].
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.sqrt(dot(a, a));
  const nrm = (a) => {
    const l = len(a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // A moving target's level frame (radial up, heading smoothed over camera.lag s), re-solved per time.
  const lag = Number(job.camera?.lag ?? 0.3);
  const heads = new Map();
  const frameOf = (id) => {
    const w = lb.where(id);
    if (!w) throw new Error(`no target ${id} (unknown id, or no bird out)`);
    const up = nrm(w.pos);
    const tan = (f) => nrm(sub(f, up.map((u) => u * dot(f, up))));
    let f = tan(w.forward);
    const h = heads.get(id);
    if (h && lag > 0) {
      if (S.t > h.t) f = tan(add(h.f, sub(f, h.f), 1 - Math.exp(-(S.t - h.t) / lag)));
      else f = h.f;
    }
    if (!h || S.t >= h.t) heads.set(id, { t: S.t, f });
    return { pos: w.pos, up, f, r: cross(f, up) };
  };
  const at = (fr, o = [0, 0, 0]) => add(add(add(fr.pos, fr.r, o[0]), fr.up, o[1]), fr.f, -o[2]);
  const geo = (g) => lb.geo(g.lat, g.lon, g.alt ?? 0);
  const eyeOf = (k) => (k.eye ? k.eye : k.eyeGeo ? geo(k.eyeGeo) : k.eyeFrom ? at(frameOf(k.eyeFrom.id), k.eyeFrom.offset) : null);
  const lookOf = (k) => (k.look ? k.look : k.lookGeo ? geo(k.lookGeo) : k.lookAt ? at(frameOf(k.lookAt), k.lookOffset) : null);

  // Monotone cubic (Fritsch-Carlson) through (T, Y) with zero slope at eased keys; linear past the ends.
  const mono = (T, Y, E) => {
    const n = T.length;
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((Y[i + 1] - Y[i]) / Math.max(1e-9, T[i + 1] - T[i]));
    const m = Y.map((_, i) => {
      if (E[i] || n < 2) return 0;
      if (i === 0) return d[0];
      if (i === n - 1) return d[n - 2];
      if (d[i - 1] * d[i] <= 0) return 0;
      const h0 = T[i] - T[i - 1];
      const h1 = T[i + 1] - T[i];
      return (3 * h0 + 3 * h1) / ((2 * h1 + h0) / d[i - 1] + (h1 + 2 * h0) / d[i]);
    });
    return (t) => {
      if (n < 2) return Y[0];
      if (t <= T[0]) return Y[0] + m[0] * (t - T[0]);
      if (t >= T[n - 1]) return Y[n - 1] + m[n - 1] * (t - T[n - 1]);
      let i = 0;
      while (t > T[i + 1]) i++;
      const h = T[i + 1] - T[i];
      const s = (t - T[i]) / h;
      const s2 = s * s;
      const s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * Y[i] + (s3 - 2 * s2 + s) * h * m[i] + (-2 * s3 + 3 * s2) * Y[i + 1] + (s3 - s2) * h * m[i + 1];
    };
  };
  // Centripetal Catmull-Rom (Barry-Goldman) through P at knot u (u_i = Σ |ΔP|^½), phantom end points.
  const cr = (P) => {
    const n = P.length;
    const u = [0];
    for (let i = 1; i < n; i++) u.push(u[i - 1] + Math.max(1e-4, Math.sqrt(len(sub(P[i], P[i - 1])))));
    const Q = n > 1 ? [add(P[0], sub(P[0], P[1])), ...P, add(P[n - 1], sub(P[n - 1], P[n - 2]))] : [P[0], P[0], P[0]];
    const U = n > 1 ? [u[0] - (u[1] - u[0]), ...u, u[n - 1] + (u[n - 1] - u[n - 2])] : [-1, 0, 1];
    const lerp = (a, b, ta, tb, x) => add(a.map((v) => v * ((tb - x) / (tb - ta))), b, (x - ta) / (tb - ta));
    const seg = (i, x) => {
      // P[i] → P[i + 1] is Q[i + 1] → Q[i + 2]
      const [p0, p1, p2, p3] = [Q[i], Q[i + 1], Q[i + 2], Q[i + 3]];
      const [t0, t1, t2, t3] = [U[i], U[i + 1], U[i + 2], U[i + 3]];
      if (len(sub(p1, p2)) < 1e-6) return p1;
      const a1 = lerp(p0, p1, t0, t1, x);
      const a2 = lerp(p1, p2, t1, t2, x);
      const a3 = lerp(p2, p3, t2, t3, x);
      return lerp(lerp(a1, a2, t0, t2, x), lerp(a2, a3, t1, t3, x), t1, t2, x);
    };
    const val = (x) => {
      if (n < 2) return P[0];
      let i = 0;
      while (i < n - 2 && x > u[i + 1]) i++;
      return seg(i, Math.min(Math.max(x, u[i]), u[i + 1]));
    };
    return { u, at: (x) => {
      // Past the ends: on along the end tangent.
      if (n < 2 || (x >= u[0] && x <= u[n - 1])) return val(x);
      const e = x < u[0] ? u[0] : u[n - 1];
      const s = x < u[0] ? 1e-3 : -1e-3;
      return add(val(e), sub(val(e), val(e + s)), (x - e) / -s);
    } };
  };
  const keys = (job.camera?.keys ?? []).slice().sort((a, b) => a.t - b.t);
  const T = keys.map((k) => k.t);
  const E = keys.map((k, i) => k.ease ?? (i === 0 || i === keys.length - 1));
  const held = (f, d) => {
    let v = d;
    return keys.map((k) => (v = k[f] ?? v));
  };
  const fov = mono(T, held('fov', 40), E);
  const roll = mono(T, held('roll', 0), E);
  const ups = held('up', null);
  const track = (pts) => {
    const c = cr(pts);
    return c.at(mono(T, c.u, E)(S.t));
  };
  let last = null;
  const pose = () => {
    try {
      const i = Math.max(0, T.findLastIndex((t) => t <= S.t + 1e-9));
      last = { eye: track(keys.map(eyeOf)), look: track(keys.map(lookOf)), up: ups[i] ?? undefined, roll: roll(S.t), fov: fov(S.t), near: job.camera?.near };
    } catch (e) {
      S.err ??= String(e?.stack ?? e);
    }
    return last;
  };
  if (cine) {
    keys.forEach((k, i) => {
      if (!eyeOf(k) || !lookOf(k)) throw new Error(`camera.keys[${i}] needs an eye (eye|eyeGeo|eyeFrom) and a look (look|lookGeo|lookAt)`);
    });
    heads.clear();
  }
  setBird(S.t);
  lb.cine(cine ? pose : null);
  if (S.err) throw new Error(S.err);

  const outC = document.createElement('canvas');
  outC.width = W;
  outC.height = H;
  const oc = outC.getContext('2d');
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = 'high';
  oc.globalCompositeOperation = 'copy';
  // Motion blur: the downscaled sub-frames summed exactly, rounded once (an 8-bit running average bands skies).
  const sum = blur > 1 ? new Uint16Array(W * H * 4) : null;
  const times = [];
  const eyes = [];
  const clears = [];
  // The eye's clearance (m) over what stands under it or within 0.6 m round it: terrain, water, the
  // capital's roofs, lamp heads and crowns, the towns' roofs. Negative: inside (walls taller than the eye count).
  const dirn = lb.ctx.services.camera.director;
  const clearance = () => {
    const p = lb.ctx.view.eye;
    const pf = dirn?.probeFloor(p);
    if (!pf) return null;
    let top = pf.hard;
    if (Math.hypot(pf.x, pf.z) < 95) top = Math.max(top, pf.plateau + Math.max(lb.ctx.world.cityIndex.maxRoofNear(pf.x, pf.z, 0.6), pf.solid));
    const l = p.length();
    const towns = lb.ctx.services.towns;
    if (towns) top = Math.max(top, towns.roofAt({ x: p.x / l, y: p.y / l, z: p.z / l }, Infinity, 0.6));
    return Math.round((pf.h - top) * 100) / 100;
  };
  const dtSub = shutter / fps / blur;
  window.__cine = {
    times,
    eyes,
    clears,
    frame(j, cap) {
      const tf = (j - handles) / fps;
      for (let k = 0; k < blur; k++) {
        const tt = tf + k * dtSub;
        if (j === 0 && k === 0) lb.render();
        else {
          const dt = tt - S.t;
          setBird(tt);
          S.t = tt;
          lb.advance(dt, 1 / dt);
        }
        if (S.err) throw new Error(S.err);
        if (k === 0) {
          times.push(Math.round(lb.ctx.time.render * 1e4) / 1e4);
          eyes.push(lb.ctx.view.eye.toArray().map((v) => Math.round(v * 1e4) / 1e4));
          clears.push(clearance());
        }
        if (!cap) continue;
        oc.drawImage(gl, 0, 0, W, H);
        if (!sum) continue;
        const px = oc.getImageData(0, 0, W, H).data;
        if (k === 0) sum.set(px);
        else for (let p = 0; p < px.length; p++) sum[p] += px[p];
      }
      if (!cap) return null;
      if (sum) {
        const img = oc.createImageData(W, H);
        const d = img.data;
        for (let p = 0; p < d.length; p++) d[p] = sum[p] / blur; // (the clamped array rounds to nearest)
        oc.putImageData(img, 0, 0);
      }
      return outC.toDataURL('image/jpeg', 0.95);
    },
  };
  return { canvas: `${gl.width}x${gl.height}`, t: lb.ctx.time.render };
}
