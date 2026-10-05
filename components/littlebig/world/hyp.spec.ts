import { describe, expect, it } from 'vitest';
import { hyp, hyp3 } from './hyp';
import { Rng } from './rng';

describe('hyp / hyp3', () => {
  it('match Math.hypot bit for bit (the seeded sims depend on it)', () => {
    const rng = new Rng(7);
    const r = () => (rng.float() < 0.08 ? 0 : (rng.float() - 0.5) * Math.pow(10, rng.float() * 12 - 6));
    let bad = 0;
    for (let i = 0; i < 300000; i++) {
      const a = r();
      const b = r();
      const c = r();
      if (hyp(a, b) !== Math.hypot(a, b) || hyp3(a, b, c) !== Math.hypot(a, b, c)) bad++;
    }
    expect(bad).toBe(0);
    expect(hyp(0, -0)).toBe(0);
    expect(hyp3(3, -4, 12)).toBe(13);
  });
});
