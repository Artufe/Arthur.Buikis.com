// Offline planner: simulates the real engine + autopilot for many seeds and ranks clip windows.
// node scripts/play-media/snake-planner.mjs [seedFrom] [seedTo]
import { createRequire } from 'node:module';
import * as E from './snake-engine.mjs';
const require = createRequire(import.meta.url);
const { makePilot } = require('./snake-autopilot.cjs');

const DT = E.SIM_DT;
const RUN = 32; // seconds simulated per seed
const FADE = 0.6;
const MIN_PRE = 5; // the crossfade source must start after this (camera settled, trail laid)

export function simulate(seed, pilotOpts, seconds = RUN) {
  const pilot = makePilot(E, pilotOpts);
  let s = E.applyInput(E.createInitialState({ seed, best: 0 }), { type: 'start' });
  const rec = [];
  // camera focus replica (CameraRig.update, playing, no shake)
  let fx = 0, fz = 0;
  const vx = { v: 0 }, vz = { v: 0 };
  const sd = (cur, target, st, smooth, dt) => {
    const omega = 2 / smooth;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = cur - target;
    const temp = (st.v + omega * change) * dt;
    st.v = (st.v - omega * temp) * decay;
    return target + (change + temp) * decay;
  };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const h = pilot(s);
    if (h !== null) s = E.applyInput(s, { type: 'steer', heading: h });
    const r = E.step(s, DT);
    s = r.state;
    let gx = s.head.x + Math.cos(s.heading) * 3.5;
    let gz = s.head.z + Math.sin(s.heading) * 3.5;
    const gr = Math.hypot(gx, gz);
    if (gr > 11) { gx = (gx / gr) * 11; gz = (gz / gr) * 11; }
    const nf = s.food.find((f) => f.kind === 'golden') ?? s.food[0];
    if (nf) {
      const d = Math.hypot(nf.pos.x - gx, nf.pos.z - gz);
      const w = 0.5 * Math.max(0, 1 - d / 24);
      gx += (nf.pos.x - gx) * w;
      gz += (nf.pos.z - gz) * w;
    }
    fx = sd(fx, gx, vx, 0.35, DT);
    fz = sd(fz, gz, vz, 0.35, DT);
    rec.push({
      t: (i + 1) * DT,
      x: s.head.x, z: s.head.z, hd: s.heading, fx, fz,
      len: s.bodyLength, score: s.score, speed: s.speed,
      ev: r.events.map((e) => (e.type === 'eat' ? `eat:${e.food.kind}` : e.type === 'spawn' ? `spawn:${e.food.kind}` : e.type)),
      dead: s.status === 'gameover',
    });
    if (s.status === 'gameover') break;
  }
  return rec;
}

export function rankWindows(rec, { Lmin = 6.5, Lmax = 9 } = {}) {
  const deathAt = rec.find((r) => r.dead)?.t ?? Infinity;
  const at = (t) => rec[Math.min(rec.length - 1, Math.max(0, Math.round(t / DT) - 1))];
  const evList = [];
  for (const r of rec) for (const e of r.ev) evList.push([r.t, e]);
  const out = [];
  for (let t0 = MIN_PRE + FADE; t0 < 26; t0 += 1 / 30) {
    for (let L = Lmin; L <= Lmax; L += 1 / 30) {
      if (t0 + L + 1 > deathAt || t0 + L + 0.1 > rec.length * DT) continue;
      // seam: frames [t0+L-F, t0+L) blend toward [t0-F, t0)
      let dh = 0, df = 0, dang = 0, n = 0;
      for (let u = 0; u <= FADE; u += 0.1) {
        const a = at(t0 - FADE + u), b = at(t0 + L - FADE + u);
        dh += Math.hypot(a.x - b.x, a.z - b.z);
        df += Math.hypot(a.fx - b.fx, a.fz - b.fz);
        dang += Math.abs(E.angleDiff(a.hd, b.hd));
        n++;
      }
      dh /= n; df /= n; dang /= n;
      const evs = [];
      for (const [t, e] of evList) if (t >= t0 && t < t0 + L) evs.push([+(t - t0).toFixed(2), e]);
      const eats = evs.filter(([u, e]) => e.startsWith('eat') && u > 0.3 && u < L - FADE - 0.3);
      const golden = eats.some(([, e]) => e === 'eat:golden');
      const goldenSpawnSeen = evs.some(([u, e]) => e === 'spawn:golden' && u < L - FADE - 1);
      const score = dh * 1.0 + df * 0.5 + dang * 3 - eats.length * 1.6 - (golden ? 4 : 0) - (goldenSpawnSeen ? 1 : 0);
      out.push({ t0: +t0.toFixed(3), L: +L.toFixed(3), dh: +dh.toFixed(2), df: +df.toFixed(2), dang: +dang.toFixed(2), eats: eats.length, golden, score: +score.toFixed(2), evs, len0: +at(t0).len.toFixed(1), score0: at(t0).score });
    }
  }
  out.sort((a, b) => a.score - b.score);
  return { deathAt, best: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const from = Number(process.argv[2] ?? 1);
  const to = Number(process.argv[3] ?? 200);
  const all = [];
  let deaths = 0;
  for (let seed = from; seed <= to; seed++) {
    const rec = simulate(seed);
    const { deathAt, best } = rankWindows(rec);
    if (deathAt < RUN) deaths++;
    if (best[0]) all.push({ seed, deathAt: +deathAt.toFixed(2), ...best[0] });
  }
  all.sort((a, b) => a.score - b.score);
  console.log(`seeds ${from}..${to}: ${deaths} died within ${RUN}s`);
  for (const c of all.slice(0, 15)) console.log(JSON.stringify({ ...c, evs: c.evs.map(([u, e]) => `${u}:${e}`).join(' ') }));
}
