// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getCityIndex, getCityPlan } from '../world/city';
import { CITY_SURFACE_R, SEED } from '../world/config';
import { makeIdlers } from './idlers';
import { LookFlag, makeLooks, makeTraits, PeopleSim } from './sim';
import { createTrafficSim, KINDS } from '../traffic/sim';
import { FEM, MASC, nameAt } from '../traffic/names';
import { eyeToWorld, HeightFollower, kerbGlance, kerbWait, walkerCards, walkerEye, walkerNames, walkPlace, YAW_AMAX, YAW_VMAX, YawFollower, type PlanPose } from './track';

const N = 230;
function build() {
  const plan = getCityPlan();
  const index = getCityIndex();
  const idlers = makeIdlers(plan, index, SEED, N);
  const looks = makeLooks(SEED, N + idlers.length);
  const dogs = [3, 17, 40];
  for (const i of dogs) looks[i].flags |= LookFlag.Leash; // as people/index.ts marks its dog walkers
  const traits = makeTraits(SEED, looks, N);
  const sim = new PeopleSim(plan, index, SEED, traits, idlers, dogs);
  return { plan, looks, traits, sim };
}
const wrap = (a: number) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
const v = () => ({ x: 0, y: 0, z: 0 });

describe('walkers as trackables', () => {
  it('give every walker the same card on every visit, in the site voice', { timeout: 30000 }, () => {
    const a = build();
    const b = build();
    const na = walkerNames(a.looks, N, SEED);
    const cards = walkerCards(a.looks, a.traits, N, SEED);
    expect(walkerCards(b.looks, b.traits, N, SEED)).toEqual(cards);
    for (const c of cards) {
      expect(c.label).toBe(c.label.toLowerCase());
      expect(c.label).toMatch(/^[a-z]+, [a-z ,'.-]+$/);
      expect(c.sub.length).toBeGreaterThan(5);
    }
    // nobody in town shares a name, with each other or with a driver (traffic/track.ts: up to 40
    // vehicles, alternating the pools, counting down)
    const names = cards.map((c) => c.label.split(',')[0]);
    expect(names).toEqual(na);
    expect(new Set(names).size).toBe(N);
    const drivers = Array.from({ length: 40 }, (_, i) => nameAt(i & 1 ? MASC : FEM, SEED, i >> 1, true));
    expect(drivers.filter((d) => names.includes(d))).toEqual([]);
    // the low tier's walkers keep their names and cards
    expect(walkerNames(a.looks, 150, SEED)).toEqual(na.slice(0, 150));
    expect(walkerCards(a.looks, a.traits, 150, SEED)).toEqual(cards.slice(0, 150));
    // no two dogs share a name; no line under a card on more than 8 walkers, nor on two neighbours
    const dogs = cards.filter((c) => c.sub.startsWith('and ')).map((c) => c.sub);
    expect(new Set(dogs).size).toBe(dogs.length);
    const uses = new Map<string, number>();
    for (const c of cards) uses.set(c.sub, (uses.get(c.sub) ?? 0) + 1);
    expect(Math.max(...uses.values())).toBeLessThanOrEqual(8);
    for (let i = 1; i < N; i++) expect(cards[i].sub).not.toBe(cards[i - 1].sub);
    // dog walkers say so
    expect(cards[3].label).toMatch(/out with (her|his) dog/);
  });

  it('names where they walk', () => {
    const { plan } = build();
    const cache = new Map<number, string>();
    for (let e = 0; e < plan.walkEdges.length; e++) expect(walkPlace(plan, e, cache)).toMatch(/^[a-z][a-z .&-]+$/);
  });

  it('glances at the traffic smoothly, left first, and loops without a seam', () => {
    let last = kerbGlance(0);
    let maxStep = 0;
    for (let t = 1 / 120; t < 13; t += 1 / 120) {
      const g = kerbGlance(t);
      maxStep = Math.max(maxStep, Math.abs(g - last));
      last = g;
    }
    expect(maxStep).toBeLessThan(0.03); // ≤ 3.6 rad/s
    expect(Math.abs(kerbGlance(6.2) - kerbGlance(0))).toBeLessThan(1e-9);
    expect(kerbGlance(1)).toBeLessThan(-0.5); // near-lane traffic comes from the left
    expect(kerbGlance(3)).toBeGreaterThan(0.5);
  });

  it('eases the published forward: no snap, a speed and acceleration limit, little overshoot', () => {
    for (const step of [Math.PI / 2, Math.PI]) {
      const f = new YawFollower();
      f.reset(0);
      let last = 0;
      let lastV = 0;
      let maxV = 0;
      let maxA = 0;
      let over = 0;
      for (let k = 0; k < 240; k++) {
        const y = f.step(step, 1 / 60);
        const vel = (y - last) * 60;
        maxV = Math.max(maxV, Math.abs(vel));
        if (k > 0) maxA = Math.max(maxA, Math.abs(vel - lastV) * 60);
        over = Math.max(over, y - step);
        last = y;
        lastV = vel;
      }
      expect(maxV).toBeLessThan(YAW_VMAX + 0.01);
      expect(maxA).toBeLessThan(YAW_AMAX + 0.1);
      expect(over).toBeLessThan(0.1);
      expect(Math.abs(last - step)).toBeLessThan(0.01);
    }
    // a kerb step under the ridden walker: still a step, never a drop
    const hf = new HeightFollower();
    hf.reset(0.15);
    let hv = 0;
    let lastH = 0.15;
    for (let k = 0; k < 120; k++) {
      const h = hf.step(0, 1 / 60);
      hv = Math.max(hv, Math.abs(h - lastH) * 60);
      lastH = h;
    }
    expect(hv).toBeLessThan(0.55);
    expect(Math.abs(lastH)).toBeLessThan(0.005);
    // one big debug step lands where many small ones do
    const a = new YawFollower();
    const b = new YawFollower();
    a.reset(0);
    b.reset(0);
    a.step(1, 0.5);
    for (let k = 0; k < 30; k++) b.step(1, 0.5 / 30);
    expect(a.yaw).toBeCloseTo(b.yaw, 6);
  });

  it('keeps every eye pose finite, at eye height over the pavement, over a long walk; the ride never turns faster than 77°/s', { timeout: 30000 }, () => {
    const { plan, looks, sim } = build();
    sim.placeAt(0, null, null);
    const busy = new Uint8Array(plan.walkEdges.length);
    const blocked = new Uint8Array(plan.walkEdges.length);
    const e: PlanPose = { x: 0, z: 0, h: 0, fx: 0, fz: 0, speed: 0 };
    const out = { pos: v(), fwd: v(), up: v(), speed: 0 };
    const ridden = [0, 12, 17, 40, 77, 151, 199];
    const fol = ridden.map(() => new YawFollower());
    const lastYaw = new Float64Array(ridden.length).fill(NaN);
    let maxRate = 0;
    let bad = 0;
    let glanced = 0;
    const dt = 1 / 60;
    for (let k = 0; k < 60 * 150; k++) {
      sim.step(dt, k * dt, busy, blocked, 0, 0, false);
      ridden.forEach((i, j) => {
        walkerEye(sim, looks[i], i, 1, false, e);
        const w = kerbWait(sim, i);
        if (w > 0.5) glanced++;
        const y = fol[j].step(Math.atan2(e.fz, e.fx) + 0.6 * w * kerbGlance(k * dt), dt);
        if (!Number.isNaN(lastYaw[j])) maxRate = Math.max(maxRate, Math.abs(wrap(y - lastYaw[j])) / dt);
        lastYaw[j] = y;
      });
      if (k % 20) continue;
      for (let i = 0; i < sim.n; i++) {
        walkerEye(sim, looks[i], i, (k % 7) / 7, false, e);
        eyeToWorld(e, e.fx, e.fz, out);
        const r = Math.hypot(out.pos.x, out.pos.y, out.pos.z) - CITY_SURFACE_R;
        const fl = Math.hypot(out.fwd.x, out.fwd.y, out.fwd.z);
        const fu = out.fwd.x * out.up.x + out.fwd.y * out.up.y + out.fwd.z * out.up.z;
        const ok = Number.isFinite(r) && r > (looks[i].scale < 0.8 ? 0.8 : 1.3) && r < 2.0 && Math.abs(fl - 1) < 1e-6 && Math.abs(fu) < 1e-6 && Number.isFinite(out.speed);
        if (!ok) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(maxRate).toBeLessThan(YAW_VMAX + 0.01);
    expect(glanced).toBeGreaterThan(0); // somebody waited at a kerb (the glance ran)
  });

  it('keeps a camera berth round the ridden walker: nobody in the lens, no face-offs, still walking, clear of the cars', { timeout: 120000 }, () => {
    const { plan, looks, sim } = build();
    const index = getCityIndex();
    const traffic = createTrafficSim(plan, SEED ^ 0x7aff1c, undefined, index);
    const busy = new Uint8Array(plan.walkEdges.length);
    const blocked = new Uint8Array(plan.walkEdges.length);
    const e: PlanPose = { x: 0, z: 0, h: 0, fx: 0, fz: 0, speed: 0 };
    const dt = 1 / 60;
    for (let k = 0; k < 20 * 60; k++) traffic.step(dt, null, k === 20 * 60 - 1 ? blocked : null);
    const kids = looks.slice(0, N).flatMap((l, i) => (l.flags & LookFlag.Kid ? [i] : []));
    const stats = { worst: Infinity, close: 0, faces: 0, frames: 0, stand: 0, walked: 0, waits: 0, shortOfBack: 0, zebraGap: Infinity, car: Infinity };
    const RIDES = 16;
    // sixteen independent rides of 30 s (each from its own placement, every fourth a kid), against
    // the live traffic, as the eyes ride sees them; the first 1.2 s (the camera flying in) not counted
    for (let n = 0; n < RIDES; n++) {
      const r = n % 4 === 3 ? kids[(n >> 2) % kids.length] : (n * 37 + 2) % N;
      const kid = (looks[r].flags & LookFlag.Kid) !== 0;
      let t = 30 + r * 7.31;
      sim.placeAt(t, busy, blocked);
      sim.rider = r;
      sim.riderK = kid ? 1.3 : 1; // as people/index.ts
      const fol = new YawFollower();
      let still = 0;
      let px = sim.x[r];
      let pz = sim.z[r];
      for (let k = 0; k < 60 * 30; k++, t += dt) {
        traffic.step(dt, busy, blocked);
        sim.step(dt, t, busy, blocked, 0, 0, false);
        walkerEye(sim, looks[r], r, 1, false, e);
        const y = fol.step(Math.atan2(e.fz, e.fx) + 0.6 * kerbWait(sim, r) * kerbGlance(t), dt);
        if (k < 72) continue;
        stats.walked += Math.hypot(sim.x[r] - px, sim.z[r] - pz);
        px = sim.x[r];
        pz = sim.z[r];
        const sp = Math.hypot(sim.vx[r], sim.vz[r]);
        if (sp < 0.15) stats.stand++;
        // in the lens: within ±45° of where the view looks; a face: within ±35°, 1.8 m, looking back
        let near = Infinity;
        for (let j = 0; j < sim.n; j++) {
          if (j === r || !sim.on[j]) continue;
          const dx = sim.x[j] - e.x;
          const dz = sim.z[j] - e.z;
          const d = Math.hypot(dx, dz);
          if (d > 3) continue;
          const along = dx * Math.cos(y) + dz * Math.sin(y);
          if (along > d * Math.SQRT1_2) near = Math.min(near, d);
          if (along > d * 0.82 && d < 1.8 && -(sim.hx[j] * dx + sim.hz[j] * dz) > 0.8 * d) stats.faces++;
        }
        stats.worst = Math.min(stats.worst, near);
        if (near < 1) stats.close++;
        stats.frames++;
        // out on a zebra: whoever is ahead of it in line on the zebra
        const f = sim.info[sim.edge[r]];
        if (f.crossing && sim.commit[r] && sim.u[r] > (sim.dir[r] > 0 ? f.kerbA : f.kerbB)) {
          for (let j = 0; j < sim.n; j++) {
            if (j === r || sim.edge[j] !== sim.edge[r] || sim.dir[j] !== sim.dir[r]) continue;
            const a = sim.u[j] - sim.u[r];
            const d = Math.hypot(sim.x[j] - sim.x[r], sim.z[j] - sim.z[r]);
            if (a > 0 && a < 4 && d * d - a * a < 0.81) stats.zebraGap = Math.min(stats.zebraGap, d);
          }
        }
        // the nearest vehicle body (after the ride's first 2.5 s)
        for (let v = 0; v < traffic.n && k > 150; v++) {
          const K = KINDS[traffic.kind[v]];
          const ax = traffic.fx[v] - traffic.rx[v];
          const az = traffic.fz[v] - traffic.rz[v];
          const al = Math.hypot(ax, az) || 1;
          const qx = e.x - (traffic.fx[v] + traffic.rx[v]) / 2;
          const qz = e.z - (traffic.fz[v] + traffic.rz[v]) / 2;
          const lo = Math.abs((qx * ax + qz * az) / al) - K.len / 2;
          const la = Math.abs((-qx * az + qz * ax) / al) - K.width / 2;
          stats.car = Math.min(stats.car, Math.hypot(Math.max(0, lo), Math.max(0, la)));
        }
        // waiting at a kerb (settled for a second): 1.25 m back from the kerb line (or at the
        // crossing's start, if its landing is shorter)
        const kerb = sim.dir[r] > 0 ? f.kerbA : f.kerbB;
        still = f.crossing && !sim.commit[r] && sp < 0.05 && sim.u[r] < kerb ? still + dt : 0;
        if (still > 1) {
          stats.waits++;
          stats.shortOfBack = Math.max(stats.shortOfBack, Math.min(kerb, 1.25) - (kerb - sim.u[r]));
        }
      }
    }
    sim.rider = -1;
    sim.riderK = 1;
    const per = (x: number) => x / stats.frames;
    if (process.env.LB_DEBUG) console.log({ ...stats, close: per(stats.close), faces: per(stats.faces), stand: per(stats.stand), walked: stats.walked / RIDES });
    // (round 2's adults-only berth, measured the same way: someone within 1 m in the lens in ~2 %
    // of these frames, worst 0.54 m (following on a zebra), kids 0.74 m, standing 30 % of the time.
    // Now, over 96 such rides: 94 never closer than 1.0 m, the others ~0.8–0.9 m (a waiter at a
    // corner the view swings past); under 1 m in ~0.02 % of frames, a face looking into the lens
    // within 1.8 m in ~0.6 %, standing ~9 %, a car body ≥ ~1.0 m after the first seconds)
    expect(stats.worst).toBeGreaterThan(0.8);
    expect(per(stats.close)).toBeLessThan(0.003);
    expect(per(stats.faces)).toBeLessThan(0.025);
    expect(stats.zebraGap).toBeGreaterThan(1.3); // the berth holds across the carriageway (it follows at 1.8 m)
    expect(stats.car).toBeGreaterThan(1.0); // on the far side of the pavement from turning buses
    expect(per(stats.stand)).toBeLessThan(0.2); // it gives up on a long kerb wait
    expect(stats.walked / RIDES).toBeGreaterThan(24); // ≥ 0.8 m/s on average, kerbs included
    expect(stats.waits).toBeGreaterThan(0);
    expect(stats.shortOfBack).toBeLessThan(0.15);
  });

  it('lets the walker just ridden walk on out of the camera', { timeout: 30000 }, () => {
    const { plan, looks, sim } = build();
    const busy = new Uint8Array(plan.walkEdges.length);
    const blocked = new Uint8Array(plan.walkEdges.length);
    const e: PlanPose = { x: 0, z: 0, h: 0, fx: 0, fz: 0, speed: 0 };
    const dt = 1 / 60;
    sim.placeAt(12, busy, blocked);
    const r = 2;
    sim.rider = r;
    let t = 12;
    for (let k = 0; k < 60 * 4; k++, t += dt) sim.step(dt, t, busy, blocked, 0, 0, false);
    // the ride ends: the camera stays where the eye was, a still lens walkers keep clear of
    walkerEye(sim, looks[r], r, 1, false, e);
    const cx = e.x;
    const cz = e.z;
    sim.rider = -1;
    sim.free = r;
    for (let k = 0; k < 60 * 3; k++, t += dt) sim.step(dt, t, busy, blocked, cx, cz, true, 1.6, true);
    sim.free = -1;
    expect(Math.hypot(sim.x[r] - cx, sim.z[r] - cz)).toBeGreaterThan(1);
    // (unless it is waiting at a kerb, it is on its way)
    const f = sim.info[sim.edge[r]];
    if (!(f.crossing && !sim.commit[r])) expect(Math.hypot(sim.vx[r], sim.vz[r])).toBeGreaterThan(0.3);
  });

  it('places the same walkers at the same eyes in two sims', { timeout: 30000 }, () => {
    const a = build();
    const b = build();
    a.sim.placeAt(41.5, null, null);
    b.sim.placeAt(41.5, null, null);
    const ea: PlanPose = { x: 0, z: 0, h: 0, fx: 0, fz: 0, speed: 0 };
    const eb: PlanPose = { x: 0, z: 0, h: 0, fx: 0, fz: 0, speed: 0 };
    for (let i = 0; i < N; i += 7) {
      walkerEye(a.sim, a.looks[i], i, 0.5, false, ea);
      walkerEye(b.sim, b.looks[i], i, 0.5, false, eb);
      expect(eb).toEqual(ea);
    }
  });
});
