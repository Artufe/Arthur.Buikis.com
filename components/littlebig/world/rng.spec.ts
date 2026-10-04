import { describe, expect, it } from 'vitest';
import { hashSeed, Rng } from './rng';
import { createNoise3 } from './noise';

describe('rng', () => {
  it('is deterministic per seed and label, and independent across labels', () => {
    const a = Rng.for(42, 'trees');
    const b = Rng.for(42, 'trees');
    const c = Rng.for(42, 'cars');
    const sa = Array.from({ length: 8 }, () => a.float());
    expect(Array.from({ length: 8 }, () => b.float())).toEqual(sa);
    expect(Array.from({ length: 8 }, () => c.float())).not.toEqual(sa);
    expect(hashSeed(1, 'x')).not.toBe(hashSeed(2, 'x'));
  });

  it('stays in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      const f = r.float();
      expect(f >= 0 && f < 1).toBe(true);
      const n = r.int(3, 5);
      expect(n >= 3 && n <= 5 && Number.isInteger(n)).toBe(true);
    }
  });
});

describe('simplex noise', () => {
  it('is seeded, continuous and roughly in [-1, 1]', () => {
    const n = createNoise3(1);
    const m = createNoise3(1);
    const o = createNoise3(2);
    let min = Infinity;
    let max = -Infinity;
    let maxStep = 0;
    for (let i = 0; i < 5000; i++) {
      const x = i * 0.0137;
      const y = Math.sin(i) * 3;
      const z = i * -0.0071;
      const v = n.simplex3(x, y, z);
      expect(v).toBe(m.simplex3(x, y, z));
      min = Math.min(min, v);
      max = Math.max(max, v);
      maxStep = Math.max(maxStep, Math.abs(n.simplex3(x + 1e-3, y, z) - v));
    }
    expect(min).toBeGreaterThan(-1.05);
    expect(max).toBeLessThan(1.05);
    expect(max - min).toBeGreaterThan(1); // not flat
    expect(maxStep).toBeLessThan(0.02); // continuous
    expect(o.simplex3(0.3, 0.4, 0.5)).not.toBe(n.simplex3(0.3, 0.4, 0.5));
  });
});
