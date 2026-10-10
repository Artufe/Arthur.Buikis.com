import { describe, expect, it } from 'vitest';
import { deterministicMath as D, nativeMath as N } from '../deterministic-math';

/** Inputs spread over each function's domain (fixed, so the fingerprint is too). */
function inputs(lo: number, hi: number, n = 20000): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo + ((hi - lo) * ((i * 0.6180339887498949) % 1)));
  return out;
}

const UNARY: [string, number, number][] = [
  ['sin', -1e4, 1e4],
  ['cos', -1e4, 1e4],
  ['tan', -40, 40],
  ['asin', -1, 1],
  ['acos', -1, 1],
  ['atan', -1e3, 1e3],
  ['exp', -700, 700],
  ['log', 1e-300, 1e300],
  ['log10', 1e-10, 1e10],
  ['log1p', -0.9, 50],
  ['expm1', -30, 30],
  ['sinh', -20, 20],
  ['cosh', -20, 20],
  ['asinh', -1e4, 1e4],
  ['acosh', 1, 1e4],
  ['atanh', -0.99, 0.99],
];

const rel = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(b), 1e-300));

describe('deterministic Math (tests/deterministic-math.ts)', () => {
  it('is installed in place of the engine functions', () => {
    expect(Math.sin).toBe(D.sin);
    expect(Math.pow).toBe(D.pow);
    expect(N.sin).not.toBe(D.sin);
  });

  it('agrees with the engine to a few ulp', () => {
    for (const [k, lo, hi] of UNARY) {
      let worst = 0;
      for (const x of inputs(lo, hi)) {
        const d = D[k](x);
        const n = N[k](x);
        // (near a zero of the function compare absolutely: sin near kπ, log near 1, …)
        worst = Math.max(worst, Math.abs(n) < 1e-6 ? Math.abs(d - n) / 1e-6 : rel(d, n));
      }
      expect(worst, k).toBeLessThan(k === 'tan' || k === 'log1p' || k === 'expm1' || k.endsWith('h') ? 1e-13 : 2e-15);
    }
    let worst = 0;
    for (const y of inputs(-1e3, 1e3, 4000)) for (const x of [-7, -0.5, 0.25, 3]) worst = Math.max(worst, Math.abs(D.atan2(y, x) - N.atan2(y, x)));
    expect(worst).toBeLessThan(1e-15);
    worst = 0;
    for (const x of inputs(1e-3, 50, 4000)) for (const y of [-3.7, -1, -0.5, 0.37, 2, 2.2, 7.5]) worst = Math.max(worst, rel(D.pow(x, y), N.pow(x, y)));
    expect(worst).toBeLessThan(1e-13);
  });

  it('keeps the exact special values', () => {
    expect(Object.is(Math.sin(-0), -0)).toBe(true);
    expect(Math.cos(0)).toBe(1);
    expect(Math.exp(0)).toBe(1);
    expect(Math.log(1)).toBe(0);
    expect(Math.acos(1)).toBe(0);
    expect(Math.atan2(0, -1)).toBe(N.atan2(0, -1));
    expect(Math.atan2(Infinity, Infinity)).toBe(N.atan2(Infinity, Infinity));
    expect(Math.pow(2, 10)).toBe(1024);
    expect(Math.pow(-2, 3)).toBe(-8);
    expect(Math.pow(2, -3)).toBe(0.125);
    expect(Math.pow(0, 0)).toBe(1);
    expect(Math.pow(1, Infinity)).toBeNaN();
    expect(Math.pow(-8, 1 / 3)).toBeNaN();
    expect(Math.log10(1000)).toBe(3);
    expect(Math.log(0)).toBe(-Infinity);
    expect(Math.log(-1)).toBeNaN();
    expect(Math.exp(-Infinity)).toBe(0);
    expect(Math.sin(Infinity)).toBeNaN();
  });

  it('returns the same bits on every machine', () => {
    // A hash of every output above. It must not depend on the machine: if this fails on one
    // machine and passes on another, a replacement leaked a platform-dependent operation.
    const f = new Float64Array(1);
    const w = new Uint32Array(f.buffer);
    let h = 0x811c9dc5;
    const mix = (x: number) => {
      f[0] = x;
      h = Math.imul(h ^ w[0], 0x01000193);
      h = Math.imul(h ^ w[1], 0x01000193);
    };
    for (const [k, lo, hi] of UNARY) for (const x of inputs(lo, hi, 4000)) mix(D[k](x));
    for (const y of inputs(-1e3, 1e3, 2000)) for (const x of [-7, 0.25]) mix(D.atan2(y, x));
    for (const x of inputs(1e-3, 50, 2000)) for (const y of [-3.7, 2.2]) mix(D.pow(x, y));
    expect((h >>> 0).toString(16)).toBe('de306fa');
  });
});
