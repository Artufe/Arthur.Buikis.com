import { describe, expect, it } from 'vitest';
import { CLOUD_MAX, CLOUD_MIN, R, SEED } from '../world/config';
import { dirFromLatLon } from '../world/sphere';
import { CITY_AXIS, CITY_CLEAR, cityAngle, coverageMap, layoutClouds, PUFF_MAX, PUFF_MIN } from './layout';

describe('cloud layout', () => {
  const layout = layoutClouds({ seed: SEED, clusters: 30 });

  it('is deterministic', () => {
    const again = layoutClouds({ seed: SEED, clusters: 30 });
    expect(Array.from(again.puffs)).toEqual(Array.from(layout.puffs));
  });

  it('keeps the scatter put when anchors move (its own seeded stream)', () => {
    const a = layoutClouds({ seed: SEED, clusters: 30, anchors: [{ dir: dirFromLatLon(14, 17), radius: 12, base: CLOUD_MIN + 1 }] });
    const b = layoutClouds({ seed: SEED, clusters: 30, anchors: [{ dir: dirFromLatLon(-30, 120), radius: 12, base: CLOUD_MIN + 1 }] });
    const key = (c: { dir: { x: number; y: number; z: number } }) => `${c.dir.x.toFixed(6)},${c.dir.y.toFixed(6)},${c.dir.z.toFixed(6)}`;
    const free = layout.clusters.map(key);
    // Every scatter cluster that survives in a layout with an anchor is one of the anchor-free ones.
    for (const l of [a, b]) {
      const kept = l.clusters.slice(1).map(key);
      expect(kept.length).toBeGreaterThanOrEqual(28);
      for (const k of kept) expect(free).toContain(k);
    }
  });

  it('keeps every puff in the cloud layer and in the puff size range', () => {
    expect(layout.clusters.length).toBe(30);
    for (let i = 0; i < layout.count; i++) {
      const [x, y, z, r] = layout.puffs.subarray(i * 4, i * 4 + 4);
      const h = Math.hypot(x, y, z) - R;
      const base = layout.clusters[layout.cluster[i]].base;
      expect(r).toBeGreaterThanOrEqual(PUFF_MIN);
      expect(r).toBeLessThanOrEqual(PUFF_MAX);
      expect(base).toBeGreaterThanOrEqual(CLOUD_MIN - 2);
      expect(h).toBeLessThanOrEqual(CLOUD_MAX + 4);
      expect(h + r).toBeLessThanOrEqual(CLOUD_MAX + 14); // crowns may tower a little
    }
  });

  it('leaves the middle of the city clear, so it reads from orbit', () => {
    for (let i = 0; i < layout.count; i++) {
      const [x, y, z, r] = layout.puffs.subarray(i * 4, i * 4 + 4);
      const len = Math.hypot(x, y, z);
      const ang = cityAngle({ x: x / len, y: y / len, z: z / len });
      expect(ang * len - r).toBeGreaterThan(CITY_CLEAR * len * 0.6);
    }
    // Shadow coverage over the plateau (≈ 0.56 rad cap) stays light, even with a dive anchor in it.
    const withAnchor = layoutClouds({ seed: SEED, clusters: 30, anchors: [{ dir: dirFromLatLon(14, 17), radius: 12, base: CLOUD_MIN + 1 }] });
    const W = 256;
    const H = 128;
    const map = coverageMap(withAnchor, W, H);
    let sum = 0;
    let n = 0;
    for (let v = 0; v < H; v++) {
      const lat = ((v + 0.5) / H - 0.5) * Math.PI;
      for (let u = 0; u < W; u++) {
        const lon = ((u + 0.5) / W - 0.5) * 2 * Math.PI;
        const d = { x: Math.cos(lat) * Math.sin(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.cos(lon) };
        if (d.x * CITY_AXIS.x + d.y * CITY_AXIS.y + d.z * CITY_AXIS.z < Math.cos(0.56)) continue;
        sum += map[v * W + u] / 255;
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
    expect(sum / n).toBeLessThan(0.15);
  });

  it('builds a bare cloudlet from its extra puffs only, and caps a lowered crown', () => {
    const d = dirFromLatLon(-20, 140);
    const l = layoutClouds({
      seed: SEED,
      clusters: 30,
      anchors: [
        { dir: d, radius: 8, base: CLOUD_MIN + 1, top: CLOUD_MAX - 2 },
        { dir: dirFromLatLon(-20, 150), radius: 4, base: 40.9, bare: true, extra: [{ dir: dirFromLatLon(-20, 150), alt: 43.3, r: 2 }, { dir: dirFromLatLon(-20.4, 150), alt: 42, r: 1.8 }] },
      ],
    });
    const [body, cloudlet] = l.clusters;
    expect(cloudlet.count).toBe(2);
    expect(cloudlet.top).toBeCloseTo(45.3, 5);
    for (let i = body.first; i < body.first + body.count; i++) {
      const [x, y, z, r] = l.puffs.subarray(i * 4, i * 4 + 4);
      expect(Math.hypot(x, y, z) - R + r).toBeLessThanOrEqual(CLOUD_MAX - 2 + 1e-4);
    }
  });
});
