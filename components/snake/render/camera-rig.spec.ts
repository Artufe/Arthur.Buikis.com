import { describe, expect, it } from 'vitest';
import { playFocusGoal, smoothDamp } from './camera-rig';

describe('camera rig helpers', () => {
  it('looks ahead of the head', () => {
    const g = playFocusGoal({ x: 0, z: 0 }, 0);
    expect(g.x).toBeCloseTo(3.5);
    expect(g.z).toBeCloseTo(0);
  });

  it('clamps the focus so the view stays on the arena', () => {
    const g = playFocusGoal({ x: 0, z: 18 }, Math.PI / 2);
    expect(Math.hypot(g.x, g.z)).toBeCloseTo(11);
  });

  it('smoothDamp converges without overshoot and holds still at dt = 0', () => {
    const st = { v: 0 };
    let x = 0;
    for (let i = 0; i < 240; i++) {
      x = smoothDamp(x, 10, st, 0.35, 1 / 60);
      expect(x).toBeLessThanOrEqual(10 + 1e-9);
    }
    expect(x).toBeCloseTo(10, 2);
    expect(smoothDamp(3, 10, { v: 0 }, 0.35, 0)).toBe(3);
  });
});
