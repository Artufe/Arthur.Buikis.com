import { describe, expect, it } from 'vitest';
import { comboRate, silenceBounds, slitherMix, SnakeSound } from './sound';

describe('sound helpers', () => {
  it('finds the audible region of a buffer', () => {
    const data = new Float32Array([0, 0, 0.0001, 0.5, -0.2, 0.3, 0.00001, 0]);
    expect(silenceBounds(data)).toEqual({ start: 3, end: 6 });
  });

  it('treats an all-silent buffer as fully audible (never an empty loop)', () => {
    expect(silenceBounds(new Float32Array(10))).toEqual({ start: 0, end: 10 });
  });

  it('raises eat pitch with the combo, capped at +30%', () => {
    expect(comboRate(1)).toBe(1);
    expect(comboRate(2)).toBeCloseTo(1.06);
    expect(comboRate(50)).toBeCloseTo(1.3);
  });

  it('slither follows speed and goes silent when not moving', () => {
    expect(slitherMix(5, false)).toEqual({ gain: 0, rate: 1 });
    expect(slitherMix(5, true).gain).toBeCloseTo(0.22);
    expect(slitherMix(11, true).gain).toBeCloseTo(0.52);
    expect(slitherMix(11, true).rate).toBeCloseTo(1.2);
  });

  it('is a silent no-op where Web Audio is unavailable', async () => {
    const s = new SnakeSound('light');
    expect(s.isMuted()).toBe(true);
    await expect(s.setMuted(false)).resolves.toBeUndefined();
    expect(() => s.play('eat')).not.toThrow();
    expect(() => s.setMotion(8, true)).not.toThrow();
    s.dispose();
  });
});
