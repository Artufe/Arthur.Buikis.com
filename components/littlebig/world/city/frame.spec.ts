import { describe, expect, it } from 'vitest';
import { fromSphere, planBasis, planFrame, toSphere } from './frame';
import { v3 } from '../sphere';

describe('city chart frames', () => {
  it('planBasis instances land on their mapped footprint (no chart-distortion overlap)', () => {
    // A 14 × 10 m house at r ≈ 85 m, rotated off the chart axes: the worst case for sin θ/θ.
    const x = 60;
    const z = -60;
    const a = 0.7;
    const w = 14;
    const d = 10;
    const B = { up: v3(), ax: v3(), az: v3() };
    const U = { up: v3(), ax: v3(), az: v3() };
    planBasis(x, z, B);
    planFrame(x, z, U);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const p0 = toSphere(x, z, 0);
    let worstBasis = 0;
    let worstUnit = 0;
    for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      // Plan corner, mapped exactly.
      const want = { x: x + u * w * c - v * d * s, z: z + u * w * s + v * d * c };
      // Instance corner from the matrix columns (basis), and from unit tangents (the old way).
      for (const [F, unit] of [[B, false], [U, true]] as const) {
        const cx = F.ax.x * c + F.az.x * s, cy = F.ax.y * c + F.az.y * s, cz = F.ax.z * c + F.az.z * s;
        const ex = -F.ax.x * s + F.az.x * c, ey = -F.ax.y * s + F.az.y * c, ez = -F.ax.z * s + F.az.z * c;
        const got = fromSphere({ x: p0.x + cx * u * w + ex * v * d, y: p0.y + cy * u * w + ey * v * d, z: p0.z + cz * u * w + ez * v * d });
        const err = Math.hypot(got.x - want.x, got.z - want.z);
        if (unit) worstUnit = Math.max(worstUnit, err);
        else worstBasis = Math.max(worstBasis, err);
      }
    }
    // What is left is the linear map's second-order term (≈ 7 cm at the corners of a 14 × 10 m box,
    // a few mm for a 5 m one); unit tangents are off by the full sin θ/θ shrink (≈ 30 cm).
    expect(worstBasis).toBeLessThan(0.08);
    expect(worstUnit).toBeGreaterThan(worstBasis * 3);
  });
});
