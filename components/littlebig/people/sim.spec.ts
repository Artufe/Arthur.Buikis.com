// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createTrafficSim } from '../traffic/sim';
import { getCityIndex, getCityPlan } from '../world/city';
import { SEED } from '../world/config';
import { makeIdlers } from './idlers';
import { BODY_R, makeLooks, makeTraits, nearestSL, PeopleSim, Pose } from './sim';

const WALKERS = 230;

function build() {
  const plan = getCityPlan();
  const index = getCityIndex();
  const idlers = makeIdlers(plan, index, SEED, WALKERS);
  const looks = makeLooks(SEED, WALKERS + idlers.length);
  const sim = new PeopleSim(plan, index, SEED, makeTraits(SEED, looks, WALKERS), idlers, [3, 17, 40, 77, 120, 151, 199]);
  const n = plan.walkEdges.length;
  return { plan, index, sim, idlers, busy: new Uint8Array(n), blocked: new Uint8Array(n) };
}

describe('people sim', () => {
  it('is deterministic in t', () => {
    const a = build();
    const b = build();
    a.sim.placeAt(37.5, null, null);
    b.sim.placeAt(37.5, null, null);
    expect(Array.from(a.sim.x)).toEqual(Array.from(b.sim.x));
    expect(Array.from(a.sim.z)).toEqual(Array.from(b.sim.z));
  });

  it('keeps people on their paths, out of props, buildings and each other over a long walk', { timeout: 30000 }, () => {
    const { plan, index, sim, idlers, busy, blocked } = build();
    sim.placeAt(0, null, null);
    const dt = 1 / 60;
    const near = { s: 0, l: 0, d: 0 };
    let worstOverlap = 0;
    let overlapFrames = 0;
    let worstObstacle = 0;
    let worstOff = 0;
    let inBuilding = 0;
    let offKerb = 0;
    let crossed = 0;
    const travelled = new Float64Array(sim.n);
    const steps = 60 * 90;
    for (let k = 0; k < steps; k++) {
      sim.step(dt, k * dt, busy, blocked, 0, 0, false);
      for (const c of busy) crossed += c;
      if (k % 6) continue;
      let frameOverlap = false;
      for (let i = 0; i < sim.n; i++) {
        travelled[i] += Math.hypot(sim.x[i] - sim.px[i], sim.z[i] - sim.pz[i]) * 6;
        for (let j = i + 1; j < sim.n; j++) {
          const d = Math.hypot(sim.x[i] - sim.x[j], sim.z[i] - sim.z[j]);
          if (d < 2 * BODY_R) {
            worstOverlap = Math.max(worstOverlap, 2 * BODY_R - d);
            if (2 * BODY_R - d > 0.08) frameOverlap = true;
          }
        }
        for (const o of sim.obstacles) {
          const d = Math.hypot(sim.x[i] - o.x, sim.z[i] - o.z) - o.r - BODY_R;
          if (d < 0) worstObstacle = Math.max(worstObstacle, -d);
        }
        if (index.classify(sim.x[i], sim.z[i]) === 'building') inBuilding++;
        const e = plan.walkEdges[sim.edge[i]];
        nearestSL(e.path, sim.x[i], sim.z[i], near);
        // (a crossing's kerb ends open onto the pavement: there only offKerb below counts)
        if (e.kind !== 'crossing' || sim.onRoad(i)) worstOff = Math.max(worstOff, near.d - e.width / 2);
        const cl = index.classify(sim.x[i], sim.z[i]);
        if ((cl === 'road' || cl === 'intersection' || cl === 'water') && e.kind !== 'crossing') offKerb++;
      }
      if (frameOverlap) overlapFrames++;
    }
    const still = Array.from(travelled).filter((d) => d < 10).length;
    if (process.env.LB_DEBUG) console.log({ worstOverlap, overlapFrames, worstObstacle, worstOff, offKerb, inBuilding, crossed, still, idlers: idlers.length, sitters: idlers.filter((p) => p.pose !== Pose.Stand).length });
    expect(inBuilding).toBe(0);
    expect(worstObstacle).toBeLessThan(0.12);
    expect(offKerb).toBe(0);
    // corner cuts at path joints and the crowd parting for someone squeezing off a crossing, never
    // onto the road (offKerb)
    expect(worstOff).toBeLessThan(1.25);
    expect(worstOverlap).toBeLessThan(0.16);
    expect(overlapFrames).toBeLessThan(6);
    expect(still).toBeLessThan(sim.n * 0.05);
    expect(crossed).toBeGreaterThan(0);
  });

  it('never steps onto a crossing a car is committed to, under bursty traffic', { timeout: 30000 }, () => {
    const { plan, index, sim, busy, blocked } = build();
    // (the placement's settle writes the zebras' starting state into busy: someone it left out on a
    // crossing is on it already at t = 0, not stepping onto it under a car)
    sim.placeAt(0, busy, blocked);
    const n = plan.walkEdges.length;
    // fake traffic: each crossing blocked ~60 % of the time, in bursts of a few seconds
    const period = Float64Array.from(plan.walkEdges, (e) => 4 + (e.id % 6));
    const prev = new Uint8Array(n);
    const dt = 1 / 60;
    let risen = 0;
    let underCar = 0;
    let dogsOnRoad = 0;
    for (let k = 0; k < 60 * 120; k++) {
      const t = k * dt;
      for (let e = 0; e < n; e++) blocked[e] = (t + e * 1.7) % period[e] < 0.6 * period[e] ? 1 : 0;
      prev.set(busy);
      sim.step(dt, t, busy, blocked, 0, 0, false);
      for (let e = 0; e < n; e++) {
        if (!prev[e] && busy[e]) risen++;
        if (!prev[e] && busy[e] && blocked[e]) {
          underCar++;
        }
      }
      for (let d = 0; d < sim.dOwner.length; d++) {
        const o = sim.dOwner[d];
        const cl = index.classify(sim.dx[d], sim.dz[d]);
        // a dog on the carriageway while its owner waits at the kerb or walks the sidewalk
        if ((cl === 'road' || cl === 'intersection') && !(plan.walkEdges[sim.edge[o]].kind === 'crossing' && (sim.commit[o] || sim.onRoad(o) || sim.u[o] > 2))) dogsOnRoad++;
      }
    }
    if (process.env.LB_DEBUG) console.log({ risen, underCar, dogsOnRoad });
    expect(underCar).toBe(0);
    expect(risen).toBeGreaterThan(60); // people still get across
    expect(dogsOnRoad).toBe(0);
  });
});

describe('people with the real traffic', () => {
  // Every crossing landing can always empty: nobody stays on a carriageway long and no zebra is
  // held busy (stopping its cars) for long, against the live traffic sim, day-time crowd.
  it('never freezes on a zebra over 20 sim-minutes', { timeout: 120000 }, () => {
    const { plan, sim, busy, blocked } = build();
    const traffic = createTrafficSim(plan, SEED ^ 0x7aff1c, undefined, getCityIndex());
    const dt = 1 / 60;
    for (let k = 0; k < 20 * 60; k++) traffic.step(dt, null, k === 20 * 60 - 1 ? blocked : null);
    sim.placeAt(0, busy, blocked);
    const onRoad = new Float64Array(sim.n);
    const busyFor = new Float64Array(plan.walkEdges.length);
    let worstRoad = 0;
    let worstBusy = 0;
    for (let k = 0; k < 20 * 3600; k++) {
      traffic.step(dt, busy, blocked);
      sim.step(dt, k * dt, busy, blocked, 0, 0, false);
      for (let i = 0; i < sim.n; i++) worstRoad = Math.max(worstRoad, (onRoad[i] = sim.onRoad(i) ? onRoad[i] + dt : 0));
      for (let e = 0; e < busy.length; e++) worstBusy = Math.max(worstBusy, (busyFor[e] = busy[e] ? busyFor[e] + dt : 0));
    }
    if (process.env.LB_DEBUG) console.log({ worstRoad, worstBusy });
    expect(worstRoad).toBeLessThan(15);
    // a busy zebra is a union of little groups crossing on a 4.5-of-13 s walk window
    expect(worstBusy).toBeLessThan(26);
  });
});
