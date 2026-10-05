import { describe, expect, it } from 'vitest';
import { getPlanet } from '../world/planet';
import { terrainData } from '../terrain/data';
import { R } from '../world/config';
import { findLandmarks } from './landmarks';
import { findBoatLoops } from './boats';

describe('boat loops', () => {
  const planet = getPlanet();
  const lh = findLandmarks(planet, terrainData(planet, 6)).find((m) => m.kind === 'lighthouse')!;
  const loops = findBoatLoops(planet, [
    { dir: planet.cityDir, dists: [96, 104, 112, 122, 134, 148], count: 3 },
    { dir: lh.dir, dists: [16, 22, 30, 40, 52], count: 2, fish: true },
  ]);

  it('finds every boat, one of them the fishing boat', () => {
    expect(loops.length).toBe(5);
    expect(loops.filter((l) => l.kind === 'fish').length).toBe(1);
  });

  it('keeps every loop on water and clear of the others', () => {
    const d = { x: 0, y: 0, z: 0 };
    for (const l of loops) {
      for (let s = 0; s < 64; s++) {
        const th = (s / 64) * Math.PI * 2;
        const x = l.c.x * R + l.e1.x * Math.cos(th) * l.a + l.e2.x * Math.sin(th) * l.b;
        const y = l.c.y * R + l.e1.y * Math.cos(th) * l.a + l.e2.y * Math.sin(th) * l.b;
        const z = l.c.z * R + l.e1.z * Math.cos(th) * l.a + l.e2.z * Math.sin(th) * l.b;
        const m = Math.hypot(x, y, z);
        d.x = x / m;
        d.y = y / m;
        d.z = z / m;
        expect(planet.heightAt(d)).toBeLessThan(-0.6);
      }
      for (const o of loops) {
        if (o === l) continue;
        const sep = Math.acos(Math.min(1, o.c.x * l.c.x + o.c.y * l.c.y + o.c.z * l.c.z)) * R;
        expect(sep).toBeGreaterThan(o.a + l.a + 2);
      }
    }
  });
});
