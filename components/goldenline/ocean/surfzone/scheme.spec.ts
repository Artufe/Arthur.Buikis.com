import { describe, expect, it } from 'vitest';
import { G, createGrid, createScratch, stableDt, step, volume, type SWGrid } from './scheme';

/** The base scheme (no infiltration, no breaking model) unless asked: the analytic cases test the numerics. */
const run = (g: SWGrid, t: number, manning = 0, cfl = 0.4, each?: (g: SWGrid) => void, soak = 0, breaking = 0) => {
  const s = createScratch(g);
  let time = 0;
  while (time < t) {
    const dt = Math.min(stableDt(g, cfl), t - time);
    step(g, dt, manning, s, soak, breaking);
    time += dt;
    each?.(g);
  }
};

const maxAbs = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

/** Stoker's wet-bed dam break: middle depth and shock speed for depths hL > hR. */
function stoker(hL: number, hR: number) {
  const f = (hm: number) => 2 * (Math.sqrt(G * hL) - Math.sqrt(G * hm)) - (hm - hR) * Math.sqrt((G * (hm + hR)) / (2 * hm * hR));
  let lo = hR;
  let hi = hL;
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (lo + hi);
    if (f(m) > 0) lo = m;
    else hi = m;
  }
  const hm = 0.5 * (lo + hi);
  const um = 2 * (Math.sqrt(G * hL) - Math.sqrt(G * hm));
  return { hm, S: (hm * um) / (hm - hR) };
}

describe('surf-zone shallow-water scheme', () => {
  it('keeps a lake at rest over an uneven bed with a dry island', () => {
    const g = createGrid(40, 30, 0.25, 0.5);
    for (let j = 0; j < g.nz; j++)
      for (let i = 0; i < g.nx; i++) {
        const k = i + j * g.nx;
        g.b[k] = 0.4 * Math.sin(i * 0.7) * Math.cos(j * 0.4) + (i > 30 && j > 20 ? 1.5 : 0) - 1;
        g.h[k] = Math.max(0, 0 - g.b[k]);
      }
    run(g, 5);
    expect(maxAbs(g.u)).toBeLessThan(1e-6);
    expect(maxAbs(g.v)).toBeLessThan(1e-6);
  });

  it('conserves mass in a closed basin', () => {
    const g = createGrid(60, 40, 0.25, 0.5);
    for (let j = 0; j < g.nz; j++)
      for (let i = 0; i < g.nx; i++) {
        const k = i + j * g.nx;
        g.b[k] = -1.5 + 0.01 * i;
        g.h[k] = -g.b[k] + 0.3 * Math.exp(-((i - 20) ** 2 + (j - 20) ** 2) / 30);
      }
    const v0 = volume(g);
    run(g, 8);
    expect(Math.abs(volume(g) - v0) / v0).toBeLessThan(1e-4);
  });

  it('moves a wet-bed dam-break bore at the Stoker speed', () => {
    const hL = 1;
    const hR = 0.1;
    const g = createGrid(1600, 1, 0.025, 1);
    for (let i = 0; i < g.nx; i++) g.h[i] = i * g.dx < 20 ? hL : hR;
    const t = 2;
    run(g, t);
    const { hm, S } = stoker(hL, hR);
    let front = 0;
    for (let i = g.nx - 1; i >= 0; i--)
      if (g.h[i] > 0.5 * (hm + hR)) {
        front = (i + 0.5) * g.dx;
        break;
      }
    const expected = 20 + S * t;
    expect(Math.abs(front - expected) / (S * t)).toBeLessThan(0.03);
    // The middle state sits at Stoker's depth.
    const mid = Math.round((20 + 0.5 * S * t) / g.dx);
    expect(Math.abs(g.h[mid] - hm) / hm).toBeLessThan(0.05);
  });

  it('floods a dry bed at close to the Ritter front speed, never negative', () => {
    const g = createGrid(1600, 1, 0.025, 1);
    for (let i = 0; i < g.nx; i++) g.h[i] = i * g.dx < 20 ? 1 : 0;
    let minH = 0;
    const t = 1.5;
    run(g, t, 0, 0.4, (s) => {
      for (let i = 0; i < s.nx; i++) if (s.h[i] < minH) minH = s.h[i];
    });
    let front = 0;
    for (let i = g.nx - 1; i >= 0; i--)
      if (g.h[i] > 1e-3) {
        front = (i + 0.5) * g.dx - 20;
        break;
      }
    const ritter = 2 * Math.sqrt(G * 1) * t;
    expect(front / ritter).toBeGreaterThan(0.8);
    expect(front / ritter).toBeLessThan(1.05);
    expect(minH).toBeGreaterThanOrEqual(0);
  });

  it('runs a bore up a beach with its momentum and drains it back', () => {
    // 1:8 beach face from a 1 m deep flat; still shoreline at x = 28 m.
    const g = createGrid(500, 1, 0.08, 1);
    for (let i = 0; i < g.nx; i++) {
      const x = (i + 0.5) * g.dx;
      g.b[i] = x < 20 ? -1 : -1 + (x - 20) / 8;
      g.h[i] = Math.max(0, -g.b[i]) + (x < 6 ? 0.45 : 0);
    }
    const shore = (s: SWGrid) => {
      for (let i = s.nx - 1; i >= 0; i--) if (s.h[i] > 0.005) return (i + 0.5) * s.dx;
      return 0;
    };
    let maxShore = 0;
    let bad = false;
    run(g, 25, 0.02, 0.4, (s) => {
      maxShore = Math.max(maxShore, shore(s));
      for (let i = 0; i < s.nx; i++) if (!(s.h[i] >= 0) || !Number.isFinite(s.u[i])) bad = true;
    });
    expect(bad).toBe(false);
    // Runs well up the face (vertical run-up ≈ 2× the bore height), then drains back down.
    expect((maxShore - 28) / 8).toBeGreaterThan(0.25);
    expect(shore(g)).toBeLessThan(maxShore - 0.5);
  });

  it('breaking dissipates without braking the uprush', () => {
    const runup = (breaking: number) => {
      const g = createGrid(500, 1, 0.08, 1);
      for (let i = 0; i < g.nx; i++) {
        const x = (i + 0.5) * g.dx;
        g.b[i] = x < 20 ? -1 : -1 + (x - 20) / 8;
        g.h[i] = Math.max(0, -g.b[i]) + (x < 6 ? 0.45 : 0);
      }
      const s = createScratch(g);
      let top = 0;
      for (let t = 0; t < 25; t += 0.004) {
        step(g, 0.004, 0.02, s, 0, breaking);
        for (let i = g.nx - 1; i >= 0; i--)
          if (g.h[i] > 0.005) {
            top = Math.max(top, (i + 0.5) * g.dx);
            break;
          }
      }
      return top;
    };
    // Breaking dissipates at the front but never brakes the uprush: the bore still runs well up
    // the face with its own momentum, no higher than it would unbroken.
    const withB = runup(1);
    const without = runup(0);
    expect(withB).toBeLessThanOrEqual(without + 0.05);
    expect(withB).toBeGreaterThan(without - 1);
    expect(withB).toBeGreaterThan(30);
  });

  it('soaks a swash film on the upper beach away within seconds', () => {
    // 1:7 face above a 1 m deep flat; a 2 cm film on the dry part of the face.
    const g = createGrid(240, 1, 0.25, 1);
    for (let i = 0; i < g.nx; i++) {
      const x = (i + 0.5) * g.dx;
      g.b[i] = x < 20 ? -1 : -1 + (x - 20) / 7;
      g.h[i] = Math.max(0, -g.b[i]) + (g.b[i] > 0.5 ? 0.02 : 0);
    }
    const s = createScratch(g);
    for (let n = 0; n < 8 * 118; n++) step(g, 1 / 118, 0.022, s);
    let film = 0;
    for (let i = 0; i < g.nx; i++) if (g.b[i] > 0.6) film = Math.max(film, g.h[i]);
    expect(film).toBeLessThan(0.003);
    // Without infiltration the same film is still there (sheet flow alone is slow).
    const g2 = createGrid(240, 1, 0.25, 1);
    for (let i = 0; i < g2.nx; i++) {
      const x = (i + 0.5) * g2.dx;
      g2.b[i] = x < 20 ? -1 : -1 + (x - 20) / 7;
      g2.h[i] = Math.max(0, -g2.b[i]) + (g2.b[i] > 0.5 ? 0.02 : 0);
    }
    const s2 = createScratch(g2);
    for (let n = 0; n < 8 * 118; n++) step(g2, 1 / 118, 0.022, s2, 0);
    let film2 = 0;
    for (let i = 0; i < g2.nx; i++) if (g2.b[i] > 0.6) film2 = Math.max(film2, g2.h[i]);
    expect(film2).toBeGreaterThan(0.01);
  });

  it('treats x and z alike (transpose symmetry)', () => {
    const n = 48;
    const a = createGrid(n, n, 0.25, 0.25);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = i + j * n;
        a.b[k] = -1 + 0.3 * Math.exp(-((i - 30) ** 2 + (j - 30) ** 2) / 40);
        a.h[k] = -a.b[k] + 0.4 * Math.exp(-((i - 18) ** 2 + (j - 22) ** 2) / 20);
      }
    const b = createGrid(n, n, 0.25, 0.25);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        b.b[j + i * n] = a.b[i + j * n];
        b.h[j + i * n] = a.h[i + j * n];
      }
    const sa = createScratch(a);
    const sb = createScratch(b);
    for (let s = 0; s < 120; s++) {
      step(a, 0.02, 0.02, sa, 0);
      step(b, 0.02, 0.02, sb, 0);
    }
    let err = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(a.h[i + j * n] - b.h[j + i * n]));
    expect(err).toBeLessThan(1e-4);
  });
});
