import { describe, expect, it } from 'vitest';
import { radiusProfile, VISUAL_R } from './snake-mesh';

describe('snake radius profile', () => {
  it('has a slimmer neck, a full body and a tapered tail', () => {
    expect(radiusProfile(0, 10)).toBeCloseTo(0.8 * VISUAL_R);
    expect(radiusProfile(2, 10)).toBeCloseTo(VISUAL_R);
    expect(radiusProfile(10, 10)).toBeCloseTo(0.18 * VISUAL_R);
  });

  it('only narrows along the tail', () => {
    let last = Infinity;
    for (let s = 5; s <= 10; s += 0.25) {
      const r = radiusProfile(s, 10);
      expect(r).toBeLessThanOrEqual(last + 1e-12);
      last = r;
    }
  });
});
