import { describe, expect, it } from 'vitest';
import { easeOutBack } from './food';

describe('food spawn easing', () => {
  it('starts at 0, overshoots, and lands at 1', () => {
    expect(easeOutBack(0)).toBeCloseTo(0);
    expect(easeOutBack(1)).toBeCloseTo(1);
    expect(Math.max(...[0.6, 0.7, 0.8].map(easeOutBack))).toBeGreaterThan(1);
  });
});
