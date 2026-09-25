import { describe, expect, it } from 'vitest';
import { angleDiff, headingFromKeys, headingToward, smoothstep, wrapAngle } from './math';
import { nextRandom } from './rng';

describe('math', () => {
  it('wraps angles into (-PI, PI]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5);
  });

  it('angleDiff takes the shortest way round', () => {
    expect(angleDiff(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6);
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(-0.2);
  });

  it('maps keys to screen-relative headings', () => {
    const none = { up: false, down: false, left: false, right: false };
    expect(headingFromKeys(none)).toBeNull();
    expect(headingFromKeys({ ...none, up: true })).toBeCloseTo(-Math.PI / 2);
    expect(headingFromKeys({ ...none, right: true })).toBeCloseTo(0);
    expect(headingFromKeys({ ...none, down: true, left: true })).toBeCloseTo((3 * Math.PI) / 4);
    expect(headingFromKeys({ ...none, up: true, down: true })).toBeNull();
  });

  it('points from one point toward another, or null when they coincide', () => {
    expect(headingToward({ x: 0, z: 0 }, { x: 0, z: -5 })).toBeCloseTo(-Math.PI / 2);
    expect(headingToward({ x: 1, z: 1 }, { x: 1, z: 1 })).toBeNull();
  });

  it('smoothstep clamps and eases', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
  });

  it('rng is deterministic and in [0, 1)', () => {
    const a = nextRandom(42);
    const b = nextRandom(42);
    expect(a).toEqual(b);
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(1);
    expect(nextRandom(a.seed).value).not.toBe(a.value);
  });
});
