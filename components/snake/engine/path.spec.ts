import { describe, expect, it } from 'vitest';
import { advancePath, arcAt, trimPath } from './path';
import { SAMPLE_SPACING } from './types';

describe('path', () => {
  it('lays samples every SAMPLE_SPACING along the travelled segment', () => {
    const start = [{ x: 0, z: 0 }];
    const { path, carry } = advancePath(start, 0, { x: 0, z: 0 }, { x: 1, z: 0 });
    // 1.0 of travel → 6 new samples at 0.15..0.90, carry 0.1
    expect(path).toHaveLength(7);
    expect(carry).toBeCloseTo(0.1);
    expect(path[0].x).toBeCloseTo(0.9);
    expect(path[1].x).toBeCloseTo(0.75);
    expect(path[6]).toEqual({ x: 0, z: 0 });
  });

  it('carries leftover travel across short steps', () => {
    let path = [{ x: 0, z: 0 }];
    let carry = 0;
    ({ path, carry } = advancePath(path, carry, { x: 0, z: 0 }, { x: 0.1, z: 0 }));
    expect(path).toHaveLength(1);
    ({ path, carry } = advancePath(path, carry, { x: 0.1, z: 0 }, { x: 0.2, z: 0 }));
    expect(path).toHaveLength(2);
    expect(path[0].x).toBeCloseTo(SAMPLE_SPACING);
    expect(carry).toBeCloseTo(0.05);
  });

  it('reports arc distance and trims to the kept length', () => {
    expect(arcAt(0.05, 3)).toBeCloseTo(0.05 + 3 * SAMPLE_SPACING);
    const path = Array.from({ length: 50 }, (_, i) => ({ x: i * SAMPLE_SPACING, z: 0 }));
    const kept = trimPath(path, 0, 1.0);
    expect(kept.length).toBe(Math.floor(1.0 / SAMPLE_SPACING) + 1);
    expect(trimPath(path.slice(0, 1), 0, 1.0)).toHaveLength(1);
  });
});
