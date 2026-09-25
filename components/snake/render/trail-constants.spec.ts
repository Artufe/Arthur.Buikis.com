import { describe, expect, it } from 'vitest';
import { TRAIL_HOLD, TRAIL_LIFE, trailShape } from './trail-constants';

describe('trail shape', () => {
  it('holds full width, then narrows smoothly to nothing', () => {
    expect(trailShape(0)).toBe(1);
    expect(trailShape(TRAIL_HOLD)).toBe(1);
    expect(trailShape((TRAIL_HOLD + TRAIL_LIFE) / 2)).toBeCloseTo(0.5);
    expect(trailShape(TRAIL_LIFE)).toBe(0);
    expect(trailShape(TRAIL_LIFE + 5)).toBe(0);
  });

  it('never grows back', () => {
    let last = 1;
    for (let a = 0; a <= TRAIL_LIFE; a += 0.1) {
      const v = trailShape(a);
      expect(v).toBeLessThanOrEqual(last + 1e-12);
      last = v;
    }
  });
});
