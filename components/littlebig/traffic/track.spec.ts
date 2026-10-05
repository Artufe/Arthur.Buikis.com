// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getCityIndex, getCityPlan } from '../world/city';
import { CITY_SURFACE_R, ROAD_H, SEED } from '../world/config';
import { roadNames } from './names';
import { createTrafficSim, FLEET, KINDS } from './sim';
import { stopsByLane, vehicleCards, vehicleDetail, vehiclePose } from './track';

const plan = getCityPlan();
const index = getCityIndex();
// traffic/index.ts: the sim's seed and the per-vehicle variants (taxi, police, ice-cream van, liveries)
const SIM_SEED = SEED ^ 0x7aff1c;
function variants(sim: ReturnType<typeof createTrafficSim>) {
  const vari = new Float32Array(sim.n);
  const count = new Int32Array(KINDS.length);
  for (let i = 0; i < sim.n; i++) {
    const k = sim.kind[i];
    const j = count[k]++;
    if (KINDS[k].name === 'truck') vari[i] = 1 + (j % 3);
    for (const [vk, vj, vv] of [[0, 2, 1], [0, 13, 1], [0, 7, 2], [1, 4, 3]]) if (vk === k && vj === j) vari[i] = vv;
  }
  return vari;
}
const v = () => ({ x: 0, y: 0, z: 0 });

describe('the fleet as trackables', () => {
  it('has stable, unique ids and the same cards in two sims', { timeout: 30000 }, () => {
    const a = createTrafficSim(plan, SIM_SEED, FLEET, index);
    const b = createTrafficSim(plan, SIM_SEED, FLEET, index);
    const ca = vehicleCards(a, variants(a), SEED);
    expect(vehicleCards(b, variants(b), SEED)).toEqual(ca);
    expect(new Set(ca.map((c) => c.id)).size).toBe(a.n);
    for (const kind of ['car', 'truck', 'bus'] as const) {
      const ids = ca.filter((c) => c.kind === kind).map((c) => c.id);
      expect(ids).toEqual(ids.map((_, n) => `${kind}:${n}`));
    }
    expect(ca.filter((c) => c.kind === 'bus').length).toBe(FLEET[3]);
    for (const c of ca) {
      expect(c.label).toBe(c.label.toLowerCase());
      expect(c.sub).toBe(c.sub.toLowerCase());
    }
    expect(ca.some((c) => c.label.startsWith('taxi'))).toBe(true);
    expect(ca.some((c) => c.label === 'police car')).toBe(true);
    expect(ca.some((c) => c.label === 'the ice-cream van')).toBe(true);
    // every driver a different name
    const drivers = ca.filter((c) => c.kind !== 'bus' && c.label !== 'the ice-cream van').map((c) => c.sub.replace(/^officer /, '').split(',')[0]);
    expect(new Set(drivers).size).toBe(drivers.length);
  });

  it('names every road, the avenues apart', () => {
    const names = roadNames(plan);
    expect(names.every((n) => /^[a-z][a-z .-]+$/.test(n))).toBe(true);
    const avenues = new Set(plan.edges.filter((e) => e.kind === 'avenue').map((e) => names[e.id]));
    expect(avenues.size).toBeGreaterThanOrEqual(4);
  });

  it('keeps every chase pose finite, on the road, upright, over a long drive', { timeout: 30000 }, () => {
    const sim = createTrafficSim(plan, SIM_SEED, FLEET, index);
    const stops = stopsByLane(plan);
    const out = { pos: v(), fwd: v(), up: v(), speed: 0 };
    let bad = 0;
    let details = 0;
    const stopNames = new Set<string>();
    for (let k = 0; k < 60 * 300; k++) {
      sim.step(1 / 60, null, null);
      if (k % 30) continue;
      for (let i = 0; i < sim.n; i++) {
        vehiclePose(sim, i, (k % 11) / 11, out);
        const r = Math.hypot(out.pos.x, out.pos.y, out.pos.z) - CITY_SURFACE_R - ROAD_H - KINDS[sim.kind[i]].height / 2;
        const fl = Math.hypot(out.fwd.x, out.fwd.y, out.fwd.z);
        const ul = Math.hypot(out.up.x, out.up.y, out.up.z);
        const fu = out.fwd.x * out.up.x + out.fwd.y * out.up.y + out.fwd.z * out.up.z;
        if (!(Math.abs(r) < 1e-6 && Math.abs(fl - 1) < 1e-6 && Math.abs(ul - 1) < 1e-6 && Math.abs(fu) < 1e-3 && out.speed >= 0 && Number.isFinite(out.speed))) bad++;
      }
      if (k % 300 === 0) {
        for (let i = 0; i < sim.n; i++) {
          const d = vehicleDetail(sim, plan, i, stops);
          expect(d).toMatch(/^(stopped|\d+ km\/h) · (on|turning) [a-z]/);
          expect(d).not.toMatch(/undefined|NaN/);
          expect(d.split(' · ').length).toBeLessThanOrEqual(3);
          // a bus always says where it stops next, never the road it is on or turning onto
          if (KINDS[sim.kind[i]].name === 'bus') {
            expect(d).toMatch(/ · next stop: [a-z]/);
            const stop = d.split('next stop: ')[1];
            const road = / · (?:on|turning (?:left|right) onto) ([a-z .'-]+?)(?: · |$)/.exec(d)?.[1] ?? '';
            expect(stop.replace(/^the /, '')).not.toBe(road.replace(/^the /, ''));
            stopNames.add(stop);
          }
          details++;
        }
      }
    }
    expect(bad).toBe(0);
    expect(details).toBeGreaterThan(0);
    expect(stopNames.size).toBeGreaterThanOrEqual(4); // not 'next stop: ring road' on every card
  });
});
