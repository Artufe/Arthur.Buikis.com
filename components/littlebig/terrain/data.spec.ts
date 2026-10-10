import { describe, expect, it } from 'vitest';
import { getPlanet } from '../world/planet';
import { icosphere } from '../world/icosphere';
import { R } from '../world/config';
import { Biome, facePoint, terrainData } from './data';
import { dominantBiome, faceColor } from './colors';
import { GRAZING_SHADOW_FRAGMENT } from './shader-ext';
import { ShaderChunk } from 'three';

describe('terrain data', () => {
  const t = terrainData(getPlanet(), 6);

  it('orders faces hierarchically: the 64 facets under each detail-3 face lie inside it (ground-cover buckets)', () => {
    const ico3 = icosphere(3);
    const p = { x: 0, y: 0, z: 0 };
    for (let b = 0; b < ico3.triangleCount; b += 37) {
      const v = [0, 1, 2].map((k) => ico3.indices[b * 3 + k]);
      const c = [0, 1, 2].map((a) => v.reduce((s, vi) => s + ico3.positions[vi * 3 + a], 0));
      const cl = Math.hypot(c[0], c[1], c[2]);
      const rad = Math.max(...v.map((vi) => Math.acos((ico3.positions[vi * 3] * c[0] + ico3.positions[vi * 3 + 1] * c[1] + ico3.positions[vi * 3 + 2] * c[2]) / cl)));
      for (let f = b * 64; f < b * 64 + 64; f++) {
        facePoint(t, f, 1 / 3, 1 / 3, p);
        const l = Math.hypot(p.x, p.y, p.z);
        const ang = Math.acos(Math.min(1, (p.x * c[0] + p.y * c[1] + p.z * c[2]) / (l * cl)));
        expect(ang).toBeLessThanOrEqual(rad + 1e-6);
      }
    }
  });

  it('puts facePoint on the rendered facet (corners at R + height)', () => {
    const p = { x: 0, y: 0, z: 0 };
    const f = 12345;
    const vi = t.ico.indices[f * 3 + 1];
    facePoint(t, f, 1, 0, p);
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(R + t.heights[vi], 4);
  });

  it('patches three’s shadow chunk (the grazing-light acne fix still applies)', () => {
    expect(GRAZING_SHADOW_FRAGMENT).not.toBe(ShaderChunk.lights_fragment_begin);
    expect(GRAZING_SHADOW_FRAGMENT).toContain('lbSh');
  });
});

describe('terrain facet colours', () => {
  const t = terrainData(getPlanet(), 6);
  it('colours a facet by its dominant corner biome, never the corner mean (no olive bands)', () => {
    const I = t.ico.indices;
    let checked = 0;
    for (let f = 0; f < t.ico.triangleCount && checked < 50; f++) {
      const bs = [t.biome[I[f * 3]], t.biome[I[f * 3 + 1]], t.biome[I[f * 3 + 2]]];
      const beach = bs.filter((b) => b === Biome.Beach).length;
      const grass = bs.filter((b) => b === Biome.Grass || b === Biome.Meadow).length;
      if (beach !== 2 || grass !== 1) continue;
      expect(dominantBiome(t, f)).toBe(Biome.Beach);
      const c: [number, number, number] = [0, 0, 0];
      faceColor(t, f, 0, c);
      // Sand stays warm: red well above blue, red ≥ green·0.95 (a sand/grass mean is greener).
      expect(c[0]).toBeGreaterThan(c[2] + 0.2);
      expect(c[0]).toBeGreaterThan(c[1] * 0.95);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
