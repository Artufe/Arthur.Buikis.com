// Polyline helpers for plan-space paths (roads, lanes, connectors, sidewalks). Pure.
// Builders allocate (boot time only); samplers are zero-alloc (per frame).

import type { PathSample, Polyline } from './types';

/** Max distance between consecutive samples (m). BRIEF §5: ≤ 1 m. */
export const MAX_STEP = 1.0;

/**
 * Build a Polyline from raw points (x, z interleaved), subdividing any segment longer than
 * `step` and dropping duplicate points. `closed` appends the first point at the end.
 */
export function polyline(raw: ArrayLike<number>, closed = false, step = MAX_STEP): Polyline {
  const out: number[] = [];
  const n = raw.length >> 1;
  const count = closed ? n + 1 : n;
  for (let k = 0; k < count; k++) {
    const i = k % n;
    const x = raw[i * 2];
    const z = raw[i * 2 + 1];
    if (out.length) {
      const px = out[out.length - 2];
      const pz = out[out.length - 1];
      const d = Math.hypot(x - px, z - pz);
      if (d < 1e-6) continue;
      const parts = Math.ceil(d / step - 1e-9);
      for (let p = 1; p < parts; p++) out.push(px + ((x - px) * p) / parts, pz + ((z - pz) * p) / parts);
    }
    out.push(x, z);
  }
  return finish(out, closed);
}

function finish(pts: number[], closed: boolean): Polyline {
  const n = pts.length >> 1;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  return { pts: Float64Array.from(pts), s, length: n ? s[n - 1] : 0, closed };
}

/** Points of a circular arc (centre, radius, start/end angle in plan radians, any direction). */
export function arcPoints(cx: number, cz: number, r: number, a0: number, a1: number, step = MAX_STEP * 0.5): number[] {
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / step) + 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / (n - 1);
    out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
  }
  return out;
}

/** Centripetal-ish Catmull-Rom through control points (x, z interleaved). */
export function catmullRom(ctrl: ArrayLike<number>, closed = false, step = MAX_STEP * 0.5): number[] {
  const n = ctrl.length >> 1;
  const P = (i: number, c: 0 | 1) => {
    if (closed) i = ((i % n) + n) % n;
    else i = Math.max(0, Math.min(n - 1, i));
    return ctrl[i * 2 + c];
  };
  const out: number[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const len = Math.hypot(P(i + 1, 0) - P(i, 0), P(i + 1, 1) - P(i, 1));
    const k = Math.max(2, Math.ceil(len / step));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const t2 = t * t;
      const t3 = t2 * t;
      for (const c of [0, 1] as const) {
        const p0 = P(i - 1, c);
        const p1 = P(i, c);
        const p2 = P(i + 1, c);
        const p3 = P(i + 2, c);
        out.push(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
      }
    }
  }
  if (!closed) out.push(P(n - 1, 0), P(n - 1, 1));
  return out;
}

/**
 * Cubic Hermite from (x0, z0) leaving along unit (tx0, tz0) to (x1, z1) arriving along unit
 * (tx1, tz1). Tangent length defaults to 0.55 × chord, which gives near-circular quarter turns.
 */
export function hermitePoints(
  x0: number, z0: number, tx0: number, tz0: number,
  x1: number, z1: number, tx1: number, tz1: number,
  step = MAX_STEP * 0.5, tangentScale = 0.55,
): number[] {
  const chord = Math.hypot(x1 - x0, z1 - z0);
  const m = chord * tangentScale * 2;
  const n = Math.max(2, Math.ceil((chord * 1.3) / step) + 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    out.push(h00 * x0 + h10 * m * tx0 + h01 * x1 + h11 * m * tx1, h00 * z0 + h10 * m * tz0 + h01 * z1 + h11 * m * tz1);
  }
  return out;
}

/** Copy reversed. */
export function reversed(pl: Polyline): Polyline {
  const n = pl.pts.length >> 1;
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(pl.pts[i * 2], pl.pts[i * 2 + 1]);
  return finish(out, pl.closed);
}

/**
 * Offset laterally by `d` metres to the RIGHT of the travel direction (negative = left), using
 * mitred per-vertex normals, then resample to ≤ MAX_STEP.
 */
export function offset(pl: Polyline, d: number): Polyline {
  const n = pl.pts.length >> 1;
  const out: number[] = [];
  const p = pl.pts;
  for (let i = 0; i < n; i++) {
    let ax: number, az: number, bx: number, bz: number;
    const iPrev = i > 0 ? i - 1 : pl.closed ? n - 2 : -1;
    const iNext = i < n - 1 ? i + 1 : pl.closed ? 1 : -1;
    if (iPrev >= 0) {
      ax = p[i * 2] - p[iPrev * 2];
      az = p[i * 2 + 1] - p[iPrev * 2 + 1];
    } else {
      ax = p[iNext * 2] - p[i * 2];
      az = p[iNext * 2 + 1] - p[i * 2 + 1];
    }
    if (iNext >= 0) {
      bx = p[iNext * 2] - p[i * 2];
      bz = p[iNext * 2 + 1] - p[i * 2 + 1];
    } else {
      bx = ax;
      bz = az;
    }
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;
    // right normals of each segment: (−tz, tx)
    const n1x = -az / la;
    const n1z = ax / la;
    const n2x = -bz / lb;
    const n2z = bx / lb;
    let mx = n1x + n2x;
    let mz = n1z + n2z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const cos = Math.max(0.5, mx * n1x + mz * n1z); // mitre limit 2×
    out.push(p[i * 2] + (mx * d) / cos, p[i * 2 + 1] + (mz * d) / cos);
  }
  return polyline(out, false);
}

/** Sub-polyline between arc lengths s0 < s1 (exact endpoints). */
export function trim(pl: Polyline, s0: number, s1: number): Polyline {
  const a: PathSample = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  const out: number[] = [];
  sampleAt(pl, s0, a);
  out.push(a.x, a.z);
  const n = pl.pts.length >> 1;
  for (let i = 0; i < n; i++) if (pl.s[i] > s0 + 1e-6 && pl.s[i] < s1 - 1e-6) out.push(pl.pts[i * 2], pl.pts[i * 2 + 1]);
  sampleAt(pl, s1, a);
  out.push(a.x, a.z);
  return polyline(out, false);
}

/**
 * Position and unit tangent at arc length s (clamped to [0, length], or wrapped when closed).
 * Pass the previous out.i as a hint for O(1) sequential lookups. Zero-alloc.
 */
export function sampleAt(pl: Polyline, s: number, out: PathSample): PathSample {
  const n = pl.pts.length >> 1;
  const S = pl.s;
  if (pl.closed && pl.length > 0) s = ((s % pl.length) + pl.length) % pl.length;
  else s = Math.max(0, Math.min(pl.length, s));
  let i = Math.max(0, Math.min(n - 2, out.i | 0));
  if (S[i] > s || S[i + 1] < s) {
    // Walk from the hint if close, else binary search.
    if (S[i + 1] < s && i + 3 < n && S[i + 3] >= s) {
      while (S[i + 1] < s) i++;
    } else {
      let lo = 0;
      let hi = n - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (S[mid] <= s) lo = mid;
        else hi = mid - 1;
      }
      i = lo;
    }
  }
  const seg = S[i + 1] - S[i] || 1;
  const t = (s - S[i]) / seg;
  const x0 = pl.pts[i * 2];
  const z0 = pl.pts[i * 2 + 1];
  const dx = pl.pts[i * 2 + 2] - x0;
  const dz = pl.pts[i * 2 + 3] - z0;
  const l = Math.hypot(dx, dz) || 1;
  out.x = x0 + dx * t;
  out.z = z0 + dz * t;
  out.tx = dx / l;
  out.tz = dz / l;
  out.i = i;
  return out;
}

/** Closest point on the polyline to (x, z): writes dist and s into out, returns dist. Zero-alloc. */
export function nearestOn(pl: Polyline, x: number, z: number, out: { dist: number; s: number }): number {
  const n = pl.pts.length >> 1;
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i < n - 1; i++) {
    const x0 = pl.pts[i * 2];
    const z0 = pl.pts[i * 2 + 1];
    const dx = pl.pts[i * 2 + 2] - x0;
    const dz = pl.pts[i * 2 + 3] - z0;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
    const px = x0 + dx * t - x;
    const pz = z0 + dz * t - z;
    const d2 = px * px + pz * pz;
    if (d2 < best) {
      best = d2;
      bestS = pl.s[i] + t * (pl.s[i + 1] - pl.s[i]);
    }
  }
  out.dist = Math.sqrt(best);
  out.s = bestS;
  return out.dist;
}

/** First / last point helpers. */
export const first = (pl: Polyline) => ({ x: pl.pts[0], z: pl.pts[1] });
export const last = (pl: Polyline) => ({ x: pl.pts[pl.pts.length - 2], z: pl.pts[pl.pts.length - 1] });

/** Unit tangent at the start / end. */
export function startTangent(pl: Polyline): { x: number; z: number } {
  const dx = pl.pts[2] - pl.pts[0];
  const dz = pl.pts[3] - pl.pts[1];
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}
export function endTangent(pl: Polyline): { x: number; z: number } {
  const n = pl.pts.length;
  const dx = pl.pts[n - 2] - pl.pts[n - 4];
  const dz = pl.pts[n - 1] - pl.pts[n - 3];
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}

/** Max distance between consecutive samples (for specs). */
export function maxGap(pl: Polyline): number {
  let m = 0;
  for (let i = 1; i < pl.s.length; i++) m = Math.max(m, pl.s[i] - pl.s[i - 1]);
  return m;
}
