// The towns' buildings as solids (v2-BF): height-aware walls and roofs, and the bird flown into a town
// house bonks off it and recovers, never inside it.

import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { BIRD, BirdFlight, type BirdEnv } from '../camera/bird/flight';
import { R } from '../world/config';
import { getPlanet } from '../world/planet';
import { getRegion } from '../world/region';
import { chartToDir, dirToChart, v3 } from '../world/sphere';
import { type Item, planTowns, type Site, T } from './plan';
import { townSolids } from './solids';

const planet = getPlanet();
const sites = planTowns(getRegion(), (d) => planet.heightAt(d));
const towns = townSolids(sites);

/** Distance (m) from chart point (x, z) to an item's footprint (negative inside). */
function sd(i: Item, x: number, z: number): number {
  const ca = Math.cos(i.a), sa = Math.sin(i.a);
  const u = (x - i.x) * ca + (z - i.z) * sa, v = -(x - i.x) * sa + (z - i.z) * ca;
  const qu = Math.abs(u) - i.w / 2, qv = Math.abs(v) - i.d / 2;
  return Math.hypot(Math.max(qu, 0), Math.max(qv, 0)) + Math.min(Math.max(qu, qv), 0);
}

/** The biggest houses and blocks of the first few towns. */
const samples: Array<[Site, Item]> = [];
for (const s of sites.filter((x) => x.style !== 'airport').slice(0, 4)) {
  const b = s.items.filter((i) => i.t <= T.mid && i.h > 5).sort((p, q) => q.w * q.d - p.w * p.d);
  for (const it of b.slice(0, 3)) samples.push([s, it]);
}

describe('town solids', () => {
  it('a body beside a house under its roof is pushed out of its walls; over its roof it is not; the roof is under it', () => {
    expect(samples.length).toBeGreaterThanOrEqual(6);
    const d = v3();
    const q = { x: 0, z: 0 };
    for (const [s, it] of samples) {
      chartToDir(s.chart, it.x, it.z, d);
      expect(towns.near(d)).toBe(true);
      // The roof (its top as the bird meets it) is under a body over it, none under one below it.
      const top = towns.roofAt(d, it.y + it.h + 3, 0);
      expect(top).toBeGreaterThan(it.y + it.h - 1);
      expect(top).toBeLessThan(it.y + it.h + 1.5);
      expect(towns.roofAt(d, it.y + 1, 0)).toBeLessThan(it.y + 1);
      // Inside the footprint at mid height: pushed out to the body's radius off it.
      const out = v3();
      expect(towns.solid(d, it.y + it.h * 0.5, 0.4, out)).toBe(true);
      dirToChart(s.chart, out, q);
      expect(sd(it, q.x, q.z)).toBeGreaterThan(0.4 - 0.02);
      // Over its roof: no wall.
      expect(towns.solid(d, top + 0.1, 0.4, out)).toBe(false);
    }
    // Far from every town: nothing there.
    const far = v3(0, -1, 0);
    expect(towns.near(far) || towns.roofAt(far, 999, 1) === -Infinity).toBe(true);
  });

  it('the bird flown into a town house bonks off it and recovers, never inside it', { timeout: 30_000 }, () => {
    const env: BirdEnv = {
      floor: (dir, h) => Math.max(planet.surfaceAt(dir), towns.roofAt(dir, h + BIRD.step, BIRD.bodyR * 0.5)),
      wall: (dir, h, r, o) => towns.solid(dir, h + BIRD.step, r, o),
      ceiling: 120,
    };
    let crashes = 0;
    const q = { x: 0, z: 0 };
    const d = v3();
    for (const [s, it] of samples.slice(0, 6)) {
      // 3 m out from the front face (local −z, onto its street), half way up, flying at it head on.
      const ca = Math.cos(it.a), sa = Math.sin(it.a);
      const fx = it.x + sa * (it.d / 2 + 3), fz = it.z - ca * (it.d / 2 + 3);
      chartToDir(s.chart, fx, fz, d);
      const p = new Vector3(d.x, d.y, d.z).multiplyScalar(R + it.y + it.h * 0.5);
      chartToDir(s.chart, it.x, it.z, d);
      const toward = new Vector3(d.x, d.y, d.z).multiplyScalar(R + it.y + it.h * 0.5).sub(p);
      const b = new BirdFlight();
      b.reset(p, toward, 7);
      let inside = Infinity;
      let crashAt = -1;
      let endAt = -1;
      let down = false;
      for (let i = 0; i < 60 * 5; i++) {
        // (Hold a climb into it so it meets the wall, not the ground: then hands off.)
        b.step(1 / 60, { steer: 0, climb: b.crashes ? 0 : 0.3, flap: false, dive: false }, env);
        dirToChart(s.chart, b.pos.clone().normalize(), q);
        if (b.pos.length() - R < topOfNear(it)) inside = Math.min(inside, sd(it, q.x, q.z));
        if (b.crashes > 0 && crashAt < 0) crashAt = i;
        if (crashAt >= 0 && endAt < 0 && b.crash === 0) {
          endAt = i;
          down = b.grounded;
        }
        expect(Number.isFinite(b.pos.x + b.speed)).toBe(true);
      }
      crashes += b.crashes;
      expect(b.crashes, `${s.id}`).toBeGreaterThanOrEqual(1);
      expect(inside, `${s.id}`).toBeGreaterThan(BIRD.bodyR - 0.05);
      // (Righted in the air, ~1.7 s; a house is low: mostly it falls, lands dazed and stands, ~2.4 s.)
      expect(endAt, `${s.id}: recovered`).toBeGreaterThan(crashAt);
      expect((endAt - crashAt) / 60, `${s.id}: recovery (s)`).toBeLessThan(down ? 2.8 : 2.2);
    }
    expect(crashes).toBeGreaterThan(0);
  });
});

/** The wall's top for the "never inside" check (under its roof's eaves). */
const topOfNear = (it: Item) => it.y + it.h - 0.2;
