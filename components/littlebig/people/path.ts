// Allocation-free walk graph sampling, shared by simulation and placement.
import type { PathSample, Polyline } from '../world/city/types';

/** Scratch shapes of their own (see the header: zero-alloc). */
export class SL {
  s = 0;
  l = 0;
  d = 0;
  /** Inputs of nearestIn: the query point and the arc length to search up to. */
  x = 0;
  z = 0;
  sMax = 0;
}
export class Sample implements PathSample {
  x = 0;
  z = 0;
  tx = 0;
  tz = 0;
  i = 0;
  /** Input of sampleIn: the arc length. */
  s = 0;
}
const SL0 = new SL();
const SM0 = new Sample();
/** Nearest point on a polyline from sample index lo while s ≤ sMax: arc length and signed lateral offset (right of a→b). */
export function nearestSL(pl: Polyline, x: number, z: number, out: { s: number; l: number; d: number }, lo = 0, sMax = Infinity): void {
  SL0.x = x;
  SL0.z = z;
  SL0.sMax = sMax;
  nearestIn(pl, SL0, lo);
  out.s = SL0.s;
  out.l = SL0.l;
  out.d = SL0.d;
}

/** nearestSL with its inputs in `out` (x, z, sMax): doubles never cross a call boundary in the hot loop. */
export function nearestIn(pl: Polyline, out: SL, lo: number): void {
  const p = pl.pts;
  const S = pl.s;
  const x = out.x;
  const z = out.z;
  const sMax = out.sMax;
  let best = Infinity;
  for (let i = lo; i < (p.length >> 1) - 1 && S[i] <= sMax; i++) {
    const x0 = p[i * 2];
    const z0 = p[i * 2 + 1];
    const dx = p[i * 2 + 2] - x0;
    const dz = p[i * 2 + 3] - z0;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
    const qx = x - x0 - dx * t;
    const qz = z - z0 - dz * t;
    const d2 = qx * qx + qz * qz;
    if (d2 < best) {
      best = d2;
      out.s = S[i] + t * (S[i + 1] - S[i]);
      out.l = (qz * dx - qx * dz) / Math.sqrt(l2); // right of (dx, dz) is (−dz, dx)
    }
  }
  out.d = Math.sqrt(best);
}

/** Point and unit tangent at arc length s (clamped; loops wrap). The zero-alloc twin of world/city/path sampleAt. */
export function samplePath(pl: Polyline, s: number, out: PathSample): void {
  SM0.s = s;
  SM0.i = out.i;
  sampleIn(pl, SM0);
  out.x = SM0.x;
  out.z = SM0.z;
  out.tx = SM0.tx;
  out.tz = SM0.tz;
  out.i = SM0.i;
}

/** samplePath with its input in out.s. */
export function sampleIn(pl: Polyline, out: Sample): void {
  const S = pl.s;
  const P = pl.pts;
  const n = P.length >> 1;
  const L = pl.length;
  let s = out.s;
  s = pl.closed && L > 0 ? ((s % L) + L) % L : s < 0 ? 0 : s > L ? L : s;
  let i = out.i | 0;
  if (i < 0 || i > n - 2) i = 0;
  if (S[i] > s || S[i + 1] < s) {
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
  }
  const t = (s - S[i]) / (S[i + 1] - S[i] || 1);
  const x0 = P[i * 2];
  const z0 = P[i * 2 + 1];
  const dx = P[i * 2 + 2] - x0;
  const dz = P[i * 2 + 3] - z0;
  const l = Math.sqrt(dx * dx + dz * dz) || 1;
  out.x = x0 + dx * t;
  out.z = z0 + dz * t;
  out.tx = dx / l;
  out.tz = dz / l;
  out.i = i;
}
