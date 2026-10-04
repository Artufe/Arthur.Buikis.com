import { describe, expect, it } from 'vitest';
import { getCityIndex, getCityPlan } from '../world/city';
import { fromSphere } from '../world/city/frame';
import { getPlanet } from '../world/planet';
import { terrainData } from '../terrain/data';
import { CROWN_GAP_FOREST, CROWN_R, NatureFlag, NatureKind, scatterNature } from './scatter';

describe('nature scatter', () => {
  const planet = getPlanet();
  const terrain = terrainData(planet, 6);
  const city = getCityPlan();
  const cityIndex = getCityIndex();
  const input = { terrain, city, cityIndex, cityDir: planet.cityDir };
  const s = scatterNature(input);

  it('is deterministic (the same trees every visit)', () => {
    const again = scatterNature(input);
    expect(again.count).toBe(s.count);
    expect(Array.from(again.pos.subarray(0, s.count * 3))).toEqual(Array.from(s.pos.subarray(0, s.count * 3)));
    expect(Array.from(again.kind.subarray(0, s.count))).toEqual(Array.from(s.kind.subarray(0, s.count)));
  });

  it('plants a living world: forests, palms, bushes, rocks', () => {
    const n = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < s.count; i++) n[s.kind[i]]++;
    expect(n[NatureKind.Blob0] + n[NatureKind.Blob1] + n[NatureKind.Conifer]).toBeGreaterThan(1500);
    expect(n[NatureKind.Palm]).toBeGreaterThan(10);
    expect(n[NatureKind.Bush]).toBeGreaterThan(200);
    expect(n[NatureKind.Rock]).toBeGreaterThan(100);
    expect(s.count).toBeLessThan(12000);
  });

  it('never merges two crowns (centres at least the forest gap × the radii sum apart)', () => {
    const idx: number[] = [];
    for (let i = 0; i < s.count; i++) if (CROWN_R[s.kind[i]] > 0) idx.push(i);
    const cell = new Map<string, number[]>();
    const key = (x: number, y: number, z: number) => `${Math.floor(x / 8)},${Math.floor(y / 8)},${Math.floor(z / 8)}`;
    for (const i of idx) {
      const k = key(s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]);
      (cell.get(k) ?? cell.set(k, []).get(k)!).push(i);
    }
    let worst = Infinity;
    for (const i of idx) {
      const x = s.pos[i * 3], y = s.pos[i * 3 + 1], z = s.pos[i * 3 + 2];
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (let c = -1; c <= 1; c++) {
            for (const j of cell.get(key(x + a * 8, y + b * 8, z + c * 8)) ?? []) {
              if (j <= i) continue;
              const d = Math.hypot(s.pos[j * 3] - x, s.pos[j * 3 + 1] - y, s.pos[j * 3 + 2] - z);
              worst = Math.min(worst, d / (CROWN_R[s.kind[i]] * s.w[i] + CROWN_R[s.kind[j]] * s.w[j]));
            }
          }
    }
    // City trees are A2's placement (checked against each other there); the scatter keeps clear of them.
    expect(worst).toBeGreaterThanOrEqual(Math.min(CROWN_GAP_FOREST, 0.55) - 1e-6);
  });

  it('renders every city tree feature, and keeps its own scatter off the city plan except on free, clear ground', () => {
    const features = city.features.filter((f) => f.kind === 'tree').length;
    let cityTrees = 0;
    const q = { x: 0, z: 0 };
    const p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < s.count; i++) {
      if (s.face[i] < 0) {
        cityTrees++;
        continue;
      }
      p.x = s.pos[i * 3];
      p.y = s.pos[i * 3 + 1];
      p.z = s.pos[i * 3 + 2];
      fromSphere(p, q);
      if (Math.hypot(q.x, q.z) < city.radius) {
        expect(s.flags[i] & NatureFlag.City).toBeTruthy();
        expect(cityIndex.classify(q.x, q.z)).toBe('free');
        expect(cityIndex.isClear(q.x, q.z, 1.2)).toBe(true);
      }
    }
    expect(cityTrees).toBe(features);
  });

  it('never stands in the sea', () => {
    const d = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < s.count; i++) {
      if (s.face[i] < 0) continue;
      const x = s.pos[i * 3], y = s.pos[i * 3 + 1], z = s.pos[i * 3 + 2];
      const l = Math.hypot(x, y, z);
      d.x = x / l;
      d.y = y / l;
      d.z = z / l;
      expect(planet.heightAt(d)).toBeGreaterThan(0);
    }
  });
});
