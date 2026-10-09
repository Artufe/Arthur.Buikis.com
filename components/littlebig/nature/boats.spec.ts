import { describe, expect, it } from 'vitest';
import { getPlanet } from '../world/planet';
import { terrainData } from '../terrain/data';
import { R } from '../world/config';
import { findLandmarks } from './landmarks';
import { boatCard, boatPose, findBoatLoops } from './boats';

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

  it('keeps every loop in open water (deep under the hull and a band round it) and clear of the others', () => {
    const d = { x: 0, y: 0, z: 0 };
    const depthAt = (l: (typeof loops)[number], th: number, grow: number) => {
      const x = l.c.x * R + l.e1.x * Math.cos(th) * (l.a + grow) + l.e2.x * Math.sin(th) * (l.b + grow);
      const y = l.c.y * R + l.e1.y * Math.cos(th) * (l.a + grow) + l.e2.y * Math.sin(th) * (l.b + grow);
      const z = l.c.z * R + l.e1.z * Math.cos(th) * (l.a + grow) + l.e2.z * Math.sin(th) * (l.b + grow);
      const m = Math.hypot(x, y, z);
      d.x = x / m;
      d.y = y / m;
      d.z = z / m;
      return -planet.heightAt(d);
    };
    for (const l of loops) {
      // (round 3 sailed the fishing boat over a sand shelf: a pale blob through its chase view)
      for (let s = 0; s < 64; s++) {
        const th = (s / 64) * Math.PI * 2;
        expect(depthAt(l, th, 0)).toBeGreaterThan(2.7);
        expect(depthAt(l, th, 5)).toBeGreaterThan(2);
        expect(depthAt(l, th, -Math.min(5, 0.7 * l.b))).toBeGreaterThan(2);
        expect(depthAt(l, th, 13)).toBeGreaterThan(0.8); // no islet beside it, under the chase camera
        expect(depthAt(l, th, 9.5)).toBeGreaterThan(0.8);
      }
      for (const o of loops) {
        if (o === l) continue;
        const sep = Math.acos(Math.min(1, o.c.x * l.c.x + o.c.y * l.c.y + o.c.z * l.c.z)) * R;
        expect(sep).toBeGreaterThan(o.a + l.a + 2);
      }
    }
  });

  it('makes every boat a trackable: the same ids and names every visit, a finite pose on the water', { timeout: 30000 }, () => {
    const again = findBoatLoops(planet, [
      { dir: planet.cityDir, dists: [96, 104, 112, 122, 134, 148], count: 3 },
      { dir: lh.dir, dists: [16, 22, 30, 40, 52], count: 2, fish: true },
    ]);
    expect(again).toEqual(loops);
    const cards = loops.map((_, i) => boatCard(loops, i));
    expect(new Set(cards.map((c) => c.label)).size).toBe(loops.length);
    expect(cards.find((c) => c.label === 'the salty pickle')).toBeTruthy();
    const v = () => ({ x: 0, y: 0, z: 0 });
    const out = { pos: v(), fwd: v(), up: v(), speed: 0 };
    const prev = v();
    const eye = { x: 0, y: 0, z: 0 };
    for (const l of loops) {
      for (let t = 0; t < 3600; t += 0.5) {
        boatPose(l, t, 0.22, eye, out);
        const r = Math.hypot(out.pos.x, out.pos.y, out.pos.z) - R;
        expect(r).toBeGreaterThan(0.3);
        expect(r).toBeLessThan(0.9);
        expect(Math.hypot(out.fwd.x, out.fwd.y, out.fwd.z)).toBeCloseTo(1, 6);
        expect(Math.abs(out.fwd.x * out.up.x + out.fwd.y * out.up.y + out.fwd.z * out.up.z)).toBeLessThan(1e-6);
        expect(out.speed).toBeGreaterThan(0.3);
        expect(out.speed).toBeLessThan(4);
        if (t > 0) expect(Math.hypot(out.pos.x - prev.x, out.pos.y - prev.y, out.pos.z - prev.z)).toBeLessThan(out.speed * 0.5 * 1.3 + 0.05);
        prev.x = out.pos.x;
        prev.y = out.pos.y;
        prev.z = out.pos.z;
      }
    }
  });
});
