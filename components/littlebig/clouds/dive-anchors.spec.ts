import '../core/kit-fill'; // before the review tooling (core/kit.ts)
import { describe, expect, it } from 'vitest';
import type { LBContext } from '../core/contracts';
import { DIVE_SECONDS, DIVE_T0, diveAt } from '../core/shots';
import { getCityIndex, getCityPlan } from '../world/city';
import { SEED } from '../world/config';
import { getPlanet } from '../world/planet';
import { addScaled3, dirFromLatLon, dot3, normalize3, v3 } from '../world/sphere';
import { DIVE_CROSS_T, DIVE_CROSSINGS } from './dive-anchors';

describe('precomputed dive crossings', () => {
  const ctx = { world: { city: getCityPlan(), cityIndex: getCityIndex(), planet: getPlanet(SEED) } } as unknown as LBContext;
  /** Where the live scripted dive crosses altSea (the computation the table replaces). */
  const crossing = (altSea: number): number[] | null => {
    const planet = ctx.world.planet;
    let prev = diveAt(ctx, 0);
    let prevDir = dirFromLatLon(prev.lat, prev.lon);
    let prevH = prev.alt + planet.surfaceAt(prevDir);
    for (let i = 1; i <= 400; i++) {
      const cur = diveAt(ctx, i / 400);
      const dir = dirFromLatLon(cur.lat, cur.lon);
      const h = cur.alt + planet.surfaceAt(dir);
      if (prevH >= altSea && h < altSea) {
        const t = (prevH - altSea) / Math.max(1e-6, prevH - h);
        const at = normalize3(v3(), addScaled3(v3(), prevDir, addScaled3(v3(), dir, prevDir, -1), t));
        const d = addScaled3(v3(), dir, prevDir, -1);
        addScaled3(d, d, at, -dot3(d, at));
        const tr = normalize3(d);
        return [at.x, at.y, at.z, tr.x, tr.y, tr.z];
      }
      prev = cur;
      prevDir = dir;
      prevH = h;
    }
    return null;
  };

  it('the clip crosses 43 m at DIVE_CROSS_T (sim time)', () => {
    const planet = ctx.world.planet;
    const h = (u: number) => {
      const v = diveAt(ctx, u);
      return v.alt + planet.surfaceAt(dirFromLatLon(v.lat, v.lon));
    };
    let lo = 0;
    let hi = 1;
    for (let i = 1; i <= 400; i++) {
      if (h(i / 400) < 43) {
        lo = (i - 1) / 400;
        hi = i / 400;
        break;
      }
    }
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      if (h(m) >= 43) lo = m;
      else hi = m;
    }
    const t = DIVE_T0 + lo * DIVE_SECONDS;
    expect(Math.abs(t - DIVE_CROSS_T), `fresh DIVE_CROSS_T: ${t.toFixed(3)}`).toBeLessThan(0.01);
  });

  it('match the live dive (re-paste the printed table into dive-anchors.ts if the dive moved)', () => {
    const fresh: Record<string, number[] | null> = {};
    for (const k of Object.keys(DIVE_CROSSINGS)) fresh[k] = crossing(Number(k));
    const table = JSON.stringify(fresh);
    for (const [k, v] of Object.entries(DIVE_CROSSINGS)) {
      const f = fresh[k];
      expect(f, `no crossing at ${k} m; fresh table: ${table}`).not.toBeNull();
      for (let i = 0; i < 6; i++) expect(Math.abs(f![i] - v[i]), `fresh table: ${table}`).toBeLessThan(1e-9);
    }
  });
});
