import { describe, expect, it } from 'vitest';
import { BODY_R } from '../engine/types';
import { radiusProfile } from './snake-mesh';

describe('snake radius profile', () => {
  it('has a slimmer neck, a full body and a tapered tail', () => {
    expect(radiusProfile(0, 10)).toBeCloseTo(0.8 * BODY_R);
    expect(radiusProfile(2, 10)).toBeCloseTo(BODY_R);
    expect(radiusProfile(10, 10)).toBeCloseTo(0.18 * BODY_R);
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
