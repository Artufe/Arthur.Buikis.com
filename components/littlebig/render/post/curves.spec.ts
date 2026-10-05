import { describe, expect, it } from 'vitest';
import { R } from '../../world/config';
import { bloomFar, inkFade, nightInView, tiltAmount } from './curves';

const deg = (d: number) => Math.cos((d * Math.PI) / 180);

describe('post curves', () => {
  it('tilt-shift is a mid-altitude effect only (BRIEF §3)', () => {
    expect(tiltAmount(1.7)).toBe(0); // street
    expect(tiltAmount(380)).toBe(0); // orbit
    expect(tiltAmount(40)).toBe(1); // cloud layer
    expect(tiltAmount(16)).toBeGreaterThan(0.3); // rooftops: a hint, not a smear
    expect(tiltAmount(16)).toBeLessThanOrEqual(0.5);
    expect(tiltAmount(120)).toBeGreaterThan(0.3); // the city view
    expect(tiltAmount(120)).toBeLessThanOrEqual(0.6);
    expect(tiltAmount(0)).toBe(0);
    expect(tiltAmount(Number.NaN)).toBe(0);
  });

  it('ink fades with distance but never vanishes over the town', () => {
    expect(inkFade(2)).toBeGreaterThan(0.99);
    expect(inkFade(120)).toBeGreaterThan(0.75);
    expect(inkFade(380)).toBeLessThan(0.3);
    expect(inkFade(380)).toBeGreaterThan(0.2);
  });

  it('the orbit bloom setting belongs to orbit', () => {
    expect(bloomFar(1.7)).toBe(0);
    expect(bloomFar(400)).toBe(1);
    let prev = 0;
    for (let a = 2; a < 420; a *= 1.2) {
      const f = bloomFar(a);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('the bloom pyramid runs only while lit windows can be in view, and fades in smoothly', () => {
    const street = R + 3.7;
    const orbit = R + 380;
    expect(nightInView(street, deg(10), R)).toBe(0); // near noon at street level
    expect(nightInView(street, deg(90 - 15), R)).toBe(0); // golden hour: the visible ground is lit
    expect(nightInView(street, deg(180), R)).toBe(1); // midnight
    expect(nightInView(orbit, deg(0), R, 0)).toBe(0); // over the sub-solar point: the cap stays lit
    expect(nightInView(orbit, deg(45), R, 0)).toBe(1); // the terminator is in the disc
    // Monotonic in the sun angle: no flicker as the day turns.
    let prev = 0;
    for (let a = 0; a <= 180; a += 0.25) {
      const k = nightInView(street, deg(a), R);
      expect(k).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(k - prev).toBeLessThan(0.05);
      prev = k;
    }
  });
});
