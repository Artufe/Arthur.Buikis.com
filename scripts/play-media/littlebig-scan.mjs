#!/usr/bin/env node
// LITTLEBIG /play clip: scan the dive's start time T0. For each T0 it runs the whole scripted dive
// exactly as the clip renders it (setTime(T0), 301 frames at 30 fps, the world moving), then holds
// on the landing for --hold seconds (camera still, sim running), and scores the frames from u ≥ 0.88
// to the end of the hold: in screen space, how much of the frame the biggest vehicle and the biggest
// person cover, how close the nearest vehicle body comes to the eye, whether people near the lens
// walk at it, and how much life (people / cars) is in view on the landing frame; plus, on the low
// swoop before it (u 0.6–0.97), how close the camera passes over anyone in frame. Lower `bad` wins.
//
//   node scripts/play-media/littlebig-scan.mjs --t0 0 --t1 6 --dt 0.25 [--hold 2] [--url http://localhost:3047]
//
// The sims are chaotic (±0.25 s changes the landing), so re-scan whenever traffic or people change.
// (Grown from A4's docs/littlebig/shots/A4-G2fix/scan2.mjs.)
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const t0 = Number(flags.t0 ?? 0);
const t1 = Number(flags.t1 ?? 6);
const dt = Number(flags.dt ?? 0.25);
const hold = Number(flags.hold ?? 2);
const [W, H] = String(flags.size ?? '1280x800').split('x').map(Number);

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${(flags.url ?? 'http://localhost:3047').replace(/\/$/, '')}/planet/?shot=1&q=high`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__littlebig?.ready === true, null, { timeout: 180000, polling: 100 });

const rows = await page.evaluate(
  async ({ t0, t1, dt, hold }) => {
    const h = window.__littlebig;
    const ctx = h.ctx;
    const meshes = {};
    ctx.scene.traverse((o) => {
      if (o.name) meshes[o.name] = o;
    });
    const KIND = [
      ['car', 4.0, 1.9, 1.6],
      ['compact', 3.2, 1.75, 1.65],
      ['truck', 5.4, 2.1, 2.6],
      ['bus', 8.0, 2.4, 2.9],
    ];
    const V = ctx.camera.position.constructor;
    const p = new V();
    const eye = new V();
    const tmp = new V();
    // screen bbox of the points (those behind the lens clamped to its near side), clipped, as a frame fraction
    function frac(pts) {
      let x0 = 1, x1 = -1, y0 = 1, y1 = -1;
      for (const q of pts) {
        p.copy(q).applyMatrix4(ctx.camera.matrixWorldInverse);
        if (p.z > -0.05) p.z = -0.05;
        p.applyMatrix4(ctx.camera.projectionMatrix);
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      const cx0 = Math.max(-1, x0), cx1 = Math.min(1, x1), cy0 = Math.max(-1, y0), cy1 = Math.min(1, y1);
      return cx1 <= cx0 || cy1 <= cy0 ? 0 : ((cx1 - cx0) * (cy1 - cy0)) / 4;
    }
    const inFront = (x, y, z) => p.set(x, y, z).applyMatrix4(ctx.camera.matrixWorldInverse).z < 0;
    function measure() {
      eye.copy(ctx.camera.position);
      let vehFrac = 0, vehNear = 99, lifeV = 0, lifeP = 0;
      for (const [name, len, w, ht] of KIND) {
        const m = meshes[`traffic:${name}`];
        if (!m || !m.visible) continue;
        const a = m.instanceMatrix.array;
        for (let j = 0; j < m.count; j++) {
          const q = j * 16;
          const px = a[q + 12], py = a[q + 13], pz = a[q + 14];
          const ax = [0, 4, 8].map((o) => {
            const s = Math.hypot(a[q + o], a[q + o + 1], a[q + o + 2]) || 1;
            return [a[q + o] / s, a[q + o + 1] / s, a[q + o + 2] / s];
          });
          const pts = [];
          for (const fz of [-0.5, 0.5]) for (const fx of [-0.5, 0.5]) for (const fy of [0, 1]) {
            const ox = fx * w, oy = fy * ht, oz = fz * len;
            pts.push(new V(px + ax[0][0] * ox + ax[1][0] * oy + ax[2][0] * oz, py + ax[0][1] * ox + ax[1][1] * oy + ax[2][1] * oz, pz + ax[0][2] * ox + ax[1][2] * oy + ax[2][2] * oz));
          }
          const d = Math.max(0, eye.distanceTo(tmp.set(px, py, pz)) - Math.hypot(len, w) / 2);
          if (d > 45) continue;
          const f = pts.some((c) => inFront(c.x, c.y, c.z)) ? frac(pts) : 0;
          if (f > 0 && d >= 6) lifeV++;
          if (d > 30) continue;
          if (d < vehNear) vehNear = d;
          if (f > vehFrac) vehFrac = f;
        }
      }
      let pFrac = 0, pNear = 99;
      const people = [];
      const right = [ctx.camera.matrixWorld.elements[0], ctx.camera.matrixWorld.elements[1], ctx.camera.matrixWorld.elements[2]];
      for (const name of ['people', 'people:mid']) {
        const m = meshes[name];
        if (!m || !m.visible) continue;
        const a = m.instanceMatrix.array;
        const an = m.geometry.getAttribute('aAnim').array;
        for (let k = 0; k < m.count; k++) {
          const q = k * 16;
          const px = a[q + 12], py = a[q + 13], pz = a[q + 14];
          const L = Math.hypot(px, py, pz);
          const ux = px / L, uy = py / L, uz = pz / L;
          const d = eye.distanceTo(tmp.set(px, py, pz));
          if (d > 30 || !inFront(px + ux, py + uy, pz + uz)) continue;
          const pts = [];
          for (const s of [-0.3, 0.3]) for (const hh of [0, 1.75]) pts.push(new V(px + ux * hh + s * right[0], py + uy * hh + s * right[1], pz + uz * hh + s * right[2]));
          const f = frac(pts);
          if (f > 0 && d >= 4) lifeP++;
          if (d > 12) continue;
          people.push({ id: Math.floor(an[k * 4] + 1e-4), d, f });
          if (f > pFrac) pFrac = f;
          if (d < pNear) pNear = d;
        }
      }
      return { vehFrac, vehNear, pFrac, pNear, people, lifeV, lifeP };
    }
    // the low swoop (u 0.6–0.97): the nearest person whose head or feet are in frame (eye to head, m).
    // The camera sweeps low over the pavement, and anyone right under it pokes into the frame's edge
    // and dithers out (the people near-eye fade).
    const ndc = (x, y, z) => {
      p.set(x, y, z).applyMatrix4(ctx.camera.matrixWorldInverse);
      if (p.z > -0.05) return false;
      p.applyMatrix4(ctx.camera.projectionMatrix);
      return Math.abs(p.x) < 1.02 && Math.abs(p.y) < 1.02;
    };
    function swoop() {
      eye.copy(ctx.camera.position);
      let near = 99;
      for (const name of ['people', 'people:mid', 'people:far']) {
        const m = meshes[name];
        if (!m || !m.visible) continue;
        const a = m.instanceMatrix.array;
        for (let k = 0; k < m.count; k++) {
          const q = k * 16;
          const px = a[q + 12], py = a[q + 13], pz = a[q + 14];
          const L = Math.hypot(px, py, pz);
          const hx = px + (px / L) * 1.6, hy = py + (py / L) * 1.6, hz = pz + (pz / L) * 1.6;
          const d = eye.distanceTo(tmp.set(hx, hy, hz));
          if (d < near && (ndc(hx, hy, hz) || ndc(px, py, pz))) near = d;
        }
      }
      return near;
    }
    const r3 = (x) => +x.toFixed(3);
    const out = [];
    const N = Math.round(h.diveSeconds * 30) + 1;
    const glide = h.diveSeconds / (N - 1);
    for (let T = t0; T <= t1 + 1e-9; T += dt) {
      h.setTime(T);
      const worst = { vehFrac: 0, pFrac: 0, vehNear: 99, toward: 0, worstAt: 0 };
      let prev = null;
      let land = null;
      let lifeSum = 0, lifeN = 0;
      let swoopNear = 99;
      const nHold = Math.round(hold * 30);
      for (let i = 0; i < N + nHold; i++) {
        const u = Math.min(1, i / (N - 1));
        h.dive(u, i ? glide : 0);
        if (u >= 0.6 && u <= 0.97) swoopNear = Math.min(swoopNear, swoop());
        if (u < 0.88) continue;
        const m = measure();
        m.toward = 0;
        if (prev) {
          for (const q of m.people) {
            const w = prev.people.find((x) => x.id === q.id);
            if (w && q.d < w.d - 0.02 && q.d < 6) m.toward = Math.max(m.toward, q.f);
          }
        }
        const sev = m.vehFrac + m.pFrac + m.toward;
        if (sev > worst.vehFrac + worst.pFrac + worst.toward) worst.worstAt = i;
        worst.vehFrac = Math.max(worst.vehFrac, m.vehFrac);
        worst.pFrac = Math.max(worst.pFrac, m.pFrac);
        worst.vehNear = Math.min(worst.vehNear, m.vehNear);
        worst.toward = Math.max(worst.toward, m.toward);
        if (i === N - 1) land = m;
        if (i >= N - 1) {
          lifeSum += Math.min(m.lifeP, 12) * 0.08 + Math.min(m.lifeV, 4) * 0.15;
          lifeN++;
        }
        prev = m;
      }
      const life = lifeSum / Math.max(1, lifeN);
      const bad =
        land.vehFrac * 4 + land.pFrac * 5 + Math.max(0, 3 - land.vehNear) +
        worst.vehFrac * 3 + worst.pFrac * 4 + worst.toward * 4 + Math.max(0, 2 - worst.vehNear) + Math.max(0, 4 - swoopNear) * 0.5 - life;
      out.push({
        T: +T.toFixed(2),
        bad: r3(bad),
        land: { vehFrac: r3(land.vehFrac), vehNear: +land.vehNear.toFixed(2), pFrac: r3(land.pFrac), pNear: +land.pNear.toFixed(2), lifeP: land.lifeP, lifeV: land.lifeV },
        worst: { vehFrac: r3(worst.vehFrac), vehNear: +worst.vehNear.toFixed(2), pFrac: r3(worst.pFrac), toward: r3(worst.toward), at: worst.worstAt },
        life: r3(life),
        swoopNear: +swoopNear.toFixed(2),
      });
    }
    return out;
  },
  { t0, t1, dt, hold },
);
for (const r of rows) console.log(JSON.stringify(r));
console.log('best:', rows.slice().sort((a, b) => a.bad - b.bad).slice(0, 8).map((r) => `T=${r.T} bad=${r.bad}`).join('  '));
await browser.close();
