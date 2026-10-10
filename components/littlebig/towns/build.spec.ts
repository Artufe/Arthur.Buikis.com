import { describe, expect, it } from 'vitest';
import { Geo } from '../city/geo';
import { getPlanet } from '../world/planet';
import { getRegion } from '../world/region';
import { dirToChart, v3 } from '../world/sphere';
import { buildSite, liftLoop } from './build';
import { walls } from './index';
import { planTowns, siteDir, T } from './plan';

describe('towns build (T1)', () => {
  it('turns every site into finite geometry', () => {
    const planet = getPlanet();
    for (const site of planTowns(getRegion(), (d) => planet.heightAt(d))) {
      const g = new Geo(1 << 15);
      g.facades = [];
      const job = buildSite(g, site, () => 0);
      while (!job.next().done);
      expect(g.n, site.id).toBeGreaterThan(1000);
      for (let i = 0; i < g.n * 3; i++) if (!Number.isFinite(g.pos[i])) throw new Error(`${site.id}: a vertex is not finite`);
      const loop = liftLoop(site);
      if (loop) for (const v of loop) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('towns walls (T1)', () => {
  it('pushes a walker out of every building it stands in', () => {
    const planet = getPlanet();
    const sites = planTowns(getRegion(), (d) => planet.heightAt(d));
    const hit = walls(sites);
    const q = { x: 0, z: 0 }, out = v3();
    for (const s of sites) {
      for (const b of s.items.filter((i) => i.t < T.tree).slice(0, 8)) {
        // at its centre, and just inside a corner
        for (const [u, v] of [[0, 0], [b.w / 2 - 0.1, b.d / 2 - 0.1]]) {
          const d = siteDir(s, b.x + u * Math.cos(b.a) - v * Math.sin(b.a), b.z + u * Math.sin(b.a) + v * Math.cos(b.a));
          expect(hit(d, 0.4, out), s.id).toBe(true);
          dirToChart(s.chart, out, q);
          const ca = Math.cos(b.a), sa = Math.sin(b.a), lu = (q.x - b.x) * ca + (q.z - b.z) * sa, lv = (q.z - b.z) * ca - (q.x - b.x) * sa;
          expect(Math.hypot(Math.max(0, Math.abs(lu) - b.w / 2), Math.max(0, Math.abs(lv) - b.d / 2)), s.id).toBeGreaterThan(0.38);
        }
      }
    }
  });
});
