// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makeIdlers } from '../people/idlers';
import { makeLooks, makeTraits, PeopleSim } from '../people/sim';
import { getCityIndex, getCityPlan } from '../world/city';
import { SEED } from '../world/config';
import { createTrafficSim, KINDS, type TrafficSim } from './sim';

const DT = 1 / 60;
const plan = getCityPlan();
const index = getCityIndex();

type Box = { x: number; z: number; ux: number; uz: number; hl: number; hw: number };

/** Oriented body boxes in plan space: centre, unit axis, half extents. */
function boxes(sim: TrafficSim): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < sim.n; i++) {
    const k = KINDS[sim.kind[i]];
    const dx = sim.fx[i] - sim.rx[i];
    const dz = sim.fz[i] - sim.rz[i];
    const l = Math.hypot(dx, dz) || 1;
    out.push({ x: (sim.fx[i] + sim.rx[i]) / 2, z: (sim.fz[i] + sim.rz[i]) / 2, ux: dx / l, uz: dz / l, hl: k.len / 2, hw: k.width / 2 });
  }
  return out;
}

/** Separating-axis test for two oriented rectangles, shrunk by `pad` on every side. */
function overlap(a: Box, b: Box, pad: number) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [ax, az] of [
    [a.ux, a.uz],
    [-a.uz, a.ux],
    [b.ux, b.uz],
    [-b.uz, b.ux],
  ]) {
    const ra = (a.hl - pad) * Math.abs(a.ux * ax + a.uz * az) + (a.hw - pad) * Math.abs(-a.uz * ax + a.ux * az);
    const rb = (b.hl - pad) * Math.abs(b.ux * ax + b.uz * az) + (b.hw - pad) * Math.abs(-b.uz * ax + b.ux * az);
    if (Math.abs(dx * ax + dz * az) > ra + rb) return false;
  }
  return true;
}

/**
 * Invariant checks every few steps: no two bodies overlap, every body corner (5 cm in) stays on the
 * carriageway (so a bus's tail never swings over a kerb where people wait), and no body is ever on
 * a zebra with a walker on it.
 */
function checker(sim: TrafficSim, busy: Uint8Array) {
  const r = { overlap: '', offRoad: 0, zebra: 0, zebraAt: '' };
  return {
    r,
    check(k: number) {
      const bx = boxes(sim);
      for (let i = 0; i < bx.length; i++) {
        const a = bx[i];
        for (let j = i + 1; j < bx.length; j++) if (!r.overlap && overlap(a, bx[j], 0.05)) r.overlap = `t=${(k * DT).toFixed(1)} ${i}(seg ${sim.seg[i]}) × ${j}(seg ${sim.seg[j]})`;
        for (let q = 0; q < 4; q++) {
          const l = q & 1 ? a.hl - 0.05 : 0.05 - a.hl;
          const w = q & 2 ? a.hw - 0.05 : 0.05 - a.hw;
          const c = index.classify(a.x + a.ux * l - a.uz * w, a.z + a.uz * l + a.ux * w);
          if (c !== 'road' && c !== 'intersection') r.offRoad++;
        }
        const g = sim.seg[i];
        if (g >= sim.nLanes) continue;
        const lane = plan.lanes[g];
        for (const x of [lane.crossingAtEnd, lane.crossingAtStart]) {
          if (x < 0 || !busy[x]) continue;
          const we = plan.walkEdges[x];
          const at = we.laneS![we.lanes!.indexOf(g)];
          if (sim.s[i] > at - we.width / 2 && sim.s[i] - KINDS[sim.kind[i]].len < at + we.width / 2 && !r.zebra++) r.zebraAt = `t=${(k * DT).toFixed(1)} ${KINDS[sim.kind[i]].name}${i} lane ${g} s ${sim.s[i].toFixed(2)} v ${sim.v[i].toFixed(2)} x ${x} at ${at.toFixed(2)}`;
        }
      }
    },
  };
}

describe('traffic sim', () => {
  it('is deterministic', () => {
    const a = createTrafficSim(plan, SEED, undefined, index);
    const b = createTrafficSim(plan, SEED, undefined, index);
    for (let k = 0; k < 3600; k++) {
      a.step(DT, null, null);
      b.step(DT, null, null);
    }
    expect(Array.from(a.s)).toEqual(Array.from(b.s));
    expect(Array.from(a.seg)).toEqual(Array.from(b.seg));
  });

  it('runs an hour under heavy synthetic foot traffic: no overlaps, bodies on the carriageway, zebras respected, no gridlock', () => {
    const sim = createTrafficSim(plan, SEED, undefined, index);
    const nW = plan.walkEdges.length;
    const busy = new Uint8Array(nW);
    const blocked = new Uint8Array(nW);
    const busyLeft = new Float64Array(nW);
    const crossings = plan.walkEdges.filter((w) => w.kind === 'crossing');
    let r = 12345;
    const rand = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
    const ck = checker(sim, busy);
    const odo0 = Float64Array.from(sim.odo);
    let minPerMinute = Infinity;
    let vSum = 0;
    let busySum = 0;
    let samples = 0;
    for (let k = 0; k < 60 * 60 * 60; k++) {
      sim.step(DT, busy, blocked);
      // walkers: during each crossing's walk window (6 of every 13 s, like people/) one steps out
      // every ~5 s unless a car is committed to the zebra, and takes 3–6 s: each zebra is busy
      // ~40 % of the time, twice the real crowd's median (people/sim.ts: 23 %, busiest 45 %)
      for (const w of crossings) {
        if (busy[w.id]) {
          busyLeft[w.id] -= DT;
          if (busyLeft[w.id] <= 0) busy[w.id] = 0;
        } else if (!blocked[w.id] && (k * DT + w.id * 2.7) % 13 < 6 && rand() < 0.008) {
          busy[w.id] = 1;
          busyLeft[w.id] = 3 + rand() * 3;
        }
      }
      if (k % 30 === 0) {
        ck.check(k);
        for (let i = 0; i < sim.n; i++) vSum += sim.v[i];
        for (const w of crossings) busySum += busy[w.id];
        samples += sim.n;
      }
      if (k % 3600 === 3599) {
        for (let i = 0; i < sim.n; i++) {
          minPerMinute = Math.min(minPerMinute, sim.odo[i] - odo0[i]);
          odo0[i] = sim.odo[i];
        }
      }
    }
    if (process.env.LB_DEBUG) console.log({ ...ck.r, minPerMinute, meanV: vSum / samples, busy: (busySum / samples) * (sim.n / crossings.length) });
    expect(ck.r.overlap).toBe('');
    expect(ck.r.offRoad).toBe(0);
    expect(ck.r.zebra).toBe(0);
    expect(minPerMinute).toBeGreaterThan(40); // nothing is ever stuck
    expect(vSum / samples).toBeGreaterThan(3); // free flow ≈ 6.5 m/s
  }, 180_000);

  // ≥ 95 % of the fleet covers 20 m every minute (or yields to people on a zebra for a third of
  // it), the median vehicle 110 m (≈ 140–200 measured; 35 vehicles without people ≈ 240, a lone
  // car ≈ 380), and nobody stands still 30 s with every zebra at its junction clear.
  it('stays lively for 30 minutes with the real pedestrians (people/sim.ts)', () => {
    const W = 230;
    const idlers = makeIdlers(plan, index, SEED, W);
    const people = new PeopleSim(plan, index, SEED, makeTraits(SEED, makeLooks(SEED, W + idlers.length), W), idlers, [3, 17, 40, 77, 120, 151, 199]);
    const sim = createTrafficSim(plan, SEED ^ 0x7aff1c, undefined, index);
    const nW = plan.walkEdges.length;
    const busy = new Uint8Array(nW);
    const blocked = new Uint8Array(nW);
    for (let k = 0; k < 20 * 60; k++) sim.step(DT, null, k === 20 * 60 - 1 ? blocked : null); // the system's warm-up
    people.placeAt(0, busy, blocked);
    const ck = checker(sim, busy);
    const odo0 = Float64Array.from(sim.odo);
    const still = new Float64Array(sim.n);
    const heldT = new Float64Array(sim.n);
    const busyFor = new Float64Array(nW);
    let worstMinute = 1;
    let worstMedian = Infinity;
    const dist = new Float64Array(sim.n);
    let worstStill = 0;
    let worstBusy = 0;
    for (let k = 0; k < 30 * 3600; k++) {
      sim.step(DT, busy, blocked);
      people.step(DT, k * DT, busy, blocked, 0, 0, false);
      for (let w = 0; w < nW; w++) worstBusy = Math.max(worstBusy, (busyFor[w] = busy[w] ? busyFor[w] + DT : 0));
      // standing still with every zebra at its junction clear (walkers on a zebra excuse a wait)
      for (let i = 0; i < sim.n; i++) {
        const g = sim.seg[i];
        let held = false;
        if (g < sim.nLanes) {
          const l = plan.lanes[g];
          held = l.crossingAtEnd >= 0 && busy[l.crossingAtEnd] > 0;
          for (const c of l.next) {
            const x = plan.lanes[plan.connectors[c].toLane].crossingAtStart;
            held ||= x >= 0 && busy[x] > 0;
          }
        }
        still[i] = sim.v[i] > 0.05 || held ? 0 : still[i] + DT;
        if (held && sim.v[i] <= 0.05) heldT[i] += DT;
        worstStill = Math.max(worstStill, still[i]);
      }
      if (k % 30 === 0) ck.check(k);
      if (k % 3600 === 3599) {
        let moving = 0;
        for (let i = 0; i < sim.n; i++) {
          // moving, or held a third of the minute by people on a zebra at its junction (it yields)
          if (sim.odo[i] - odo0[i] > 20 || heldT[i] > 20) moving++;
          dist[i] = sim.odo[i] - odo0[i];
          odo0[i] = sim.odo[i];
          heldT[i] = 0;
        }
        worstMinute = Math.min(worstMinute, moving / sim.n);
        worstMedian = Math.min(worstMedian, dist.sort()[sim.n >> 1]);
      }
    }
    if (process.env.LB_DEBUG) console.log({ ...ck.r, worstMinute, worstMedian, worstStill, worstBusy });
    expect(ck.r.overlap).toBe('');
    expect(ck.r.offRoad).toBe(0);
    expect(ck.r.zebra).toBe(0);
    expect(worstStill).toBeLessThan(30);
    expect(worstMinute).toBeGreaterThanOrEqual(0.95);
    expect(worstMedian).toBeGreaterThan(110);
  }, 300_000);

  // The FPV player standing in the road (a long ring lane, then inside a junction): vehicles stop
  // short of the eye instead of driving through it, and the town keeps moving round it.
  it('stops for a player standing in a lane or a junction', () => {
    const sim = createTrafficSim(plan, SEED, undefined, index);
    const lane = plan.lanes.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    const conn = plan.connectors.find((c) => c.turn === 'straight' && plan.lanes[c.fromLane].path.length > 20)!;
    const spots = [lane.path, conn.path].map((p) => {
      const i = (p.pts.length >> 2) << 1;
      return [p.pts[i], p.pts[i + 1]];
    });
    for (const [x, z] of spots) {
      sim.reset();
      const odo0 = Float64Array.from(sim.odo);
      let minD = Infinity;
      let held = 0;
      for (let k = 0; k < 3 * 3600; k++) {
        sim.setObstacle(true, x, z);
        sim.step(DT, null, null);
        if (k % 10) continue;
        for (const b of boxes(sim)) {
          const dx = x - b.x;
          const dz = z - b.z;
          const u = Math.max(0, Math.abs(dx * b.ux + dz * b.uz) - b.hl);
          const w = Math.max(0, Math.abs(dz * b.ux - dx * b.uz) - b.hw);
          minD = Math.min(minD, Math.hypot(u, w));
        }
        if (k === 3 * 3600 - 10) for (let i = 0; i < sim.n; i++) held += sim.v[i] < 0.05 ? 1 : 0;
      }
      let moved = 0;
      for (let i = 0; i < sim.n; i++) moved += sim.odo[i] - odo0[i] > 100 ? 1 : 0;
      if (process.env.LB_DEBUG) console.log({ x, z, minD, held, moved });
      expect(minD).toBeGreaterThan(0.35); // the player's body radius: never inside a vehicle
      expect(moved).toBeGreaterThan(sim.n * 0.6);
    }
  }, 60_000);
});
