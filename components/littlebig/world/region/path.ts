// World-space polyline helpers for the region (types.ts WPath). Builders allocate (boot only);
// wsample / wnearest are zero-alloc (per frame).

import { R } from '../config';
import type { Vec3 } from '../sphere';
import type { WPath } from './types';

/** Max distance between consecutive samples (m). */
export const W_STEP = 1.0;

/** A point on a path: world position, unit direction, height, unit tangent (travel), and the segment it fell in. */
export interface WSample {
  x: number;
  y: number;
  z: number;
  /** Unit direction (the local up). */
  dx: number;
  dy: number;
  dz: number;
  h: number;
  /** Unit travel tangent (horizontal: orthogonal to the up). */
  tx: number;
  ty: number;
  tz: number;
  /** Index of the segment start sample (a hint for the next lookup). */
  i: number;
}

export const wsampleOut = (): WSample => ({ x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, h: 0, tx: 1, ty: 0, tz: 0, i: 0 });

/**
 * Build a WPath from raw unit directions (xyz interleaved) and heights, subdividing (slerp + linear
 * height) any segment longer than `step` metres and dropping duplicates. `closed` joins the end to
 * the start.
 */
export function wpath(dirs: ArrayLike<number>, hs: ArrayLike<number>, closed = false, step = W_STEP): WPath {
  const n = hs.length;
  const D: number[] = [];
  const H: number[] = [];
  const count = closed ? n + 1 : n;
  for (let k = 0; k < count; k++) {
    const i = k % n;
    const x = dirs[i * 3], y = dirs[i * 3 + 1], z = dirs[i * 3 + 2], h = hs[i];
    if (D.length) {
      const j = D.length - 3;
      const px = D[j], py = D[j + 1], pz = D[j + 2], ph = H[H.length - 1];
      const r0 = R + ph, r1 = R + h;
      const d = Math.hypot(x * r1 - px * r0, y * r1 - py * r0, z * r1 - pz * r0);
      if (d < 1e-6) continue;
      const parts = Math.ceil(d / step - 1e-9);
      for (let p = 1; p < parts; p++) {
        const f = p / parts;
        let ix = px + (x - px) * f, iy = py + (y - py) * f, iz = pz + (z - pz) * f;
        const l = Math.hypot(ix, iy, iz) || 1;
        ix /= l;
        iy /= l;
        iz /= l;
        D.push(ix, iy, iz);
        H.push(ph + (h - ph) * f);
      }
    }
    D.push(x, y, z);
    H.push(h);
  }
  return finish(D, H, closed);
}

function finish(D: ArrayLike<number>, H: ArrayLike<number>, closed: boolean): WPath {
  const n = H.length;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const r0 = R + H[i - 1], r1 = R + H[i];
    s[i] = s[i - 1] + Math.hypot(D[i * 3] * r1 - D[i * 3 - 3] * r0, D[i * 3 + 1] * r1 - D[i * 3 - 2] * r0, D[i * 3 + 2] * r1 - D[i * 3 - 1] * r0);
  }
  return { dir: Float64Array.from(D), h: Float64Array.from(H), s, length: n ? s[n - 1] : 0, closed };
}

/** Number of samples. */
export const wcount = (p: WPath) => p.h.length;

/** Copy reversed. */
export function wreverse(p: WPath): WPath {
  const n = p.h.length;
  const D = new Float64Array(n * 3);
  const H = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    D[i * 3] = p.dir[j * 3];
    D[i * 3 + 1] = p.dir[j * 3 + 1];
    D[i * 3 + 2] = p.dir[j * 3 + 2];
    H[i] = p.h[j];
  }
  return finish(D, H, p.closed);
}

/** Unit travel tangent at sample i (central difference, made horizontal). Writes out[0..2]. */
function tangentAt(p: WPath, i: number, out: number[]): void {
  const n = p.h.length;
  const a = Math.max(0, i - 1);
  const b = Math.min(n - 1, i + 1);
  let tx = p.dir[b * 3] - p.dir[a * 3];
  let ty = p.dir[b * 3 + 1] - p.dir[a * 3 + 1];
  let tz = p.dir[b * 3 + 2] - p.dir[a * 3 + 2];
  const ux = p.dir[i * 3], uy = p.dir[i * 3 + 1], uz = p.dir[i * 3 + 2];
  const d = tx * ux + ty * uy + tz * uz;
  tx -= ux * d;
  ty -= uy * d;
  tz -= uz * d;
  const l = Math.hypot(tx, ty, tz) || 1;
  out[0] = tx / l;
  out[1] = ty / l;
  out[2] = tz / l;
}

/**
 * Offset laterally by `off` metres to the RIGHT of travel (seen from above: right = tangent × up),
 * keeping heights. Resampled to ≤ step.
 */
export function woffset(p: WPath, off: number, step = W_STEP, ramp = 0): WPath {
  const n = p.h.length;
  const D: number[] = [];
  const t = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    tangentAt(p, i, t);
    // `ramp` > 0: the offset eases in from 0 over the first and last `ramp` metres
    let o = off;
    if (ramp > 0) {
      const e = Math.min(p.s[i], p.length - p.s[i]) / ramp;
      o *= e >= 1 ? 1 : e * e * (3 - 2 * e);
    }
    const ux = p.dir[i * 3], uy = p.dir[i * 3 + 1], uz = p.dir[i * 3 + 2];
    // right = t × up
    const rx = t[1] * uz - t[2] * uy;
    const ry = t[2] * ux - t[0] * uz;
    const rz = t[0] * uy - t[1] * ux;
    const k = o / (R + p.h[i]);
    let x = ux + rx * k, y = uy + ry * k, z = uz + rz * k;
    const l = Math.hypot(x, y, z);
    x /= l;
    y /= l;
    z /= l;
    D.push(x, y, z);
  }
  return wpath(D, p.h, false, step);
}

/** The part of p between arc lengths s0 < s1 (interpolated ends). */
export function wtrim(p: WPath, s0: number, s1: number): WPath {
  const D: number[] = [];
  const H: number[] = [];
  const o = wsampleOut();
  wsample(p, s0, o);
  D.push(o.dx, o.dy, o.dz);
  H.push(o.h);
  for (let i = 0; i < p.h.length; i++) {
    if (p.s[i] <= s0 + 1e-6 || p.s[i] >= s1 - 1e-6) continue;
    D.push(p.dir[i * 3], p.dir[i * 3 + 1], p.dir[i * 3 + 2]);
    H.push(p.h[i]);
  }
  wsample(p, s1, o);
  D.push(o.dx, o.dy, o.dz);
  H.push(o.h);
  return wpath(D, H, false);
}

/** Join paths end to start (duplicate joints dropped). */
export function wjoin(parts: WPath[]): WPath {
  const D: number[] = [];
  const H: number[] = [];
  for (const p of parts) for (let i = 0; i < p.h.length; i++) {
    D.push(p.dir[i * 3], p.dir[i * 3 + 1], p.dir[i * 3 + 2]);
    H.push(p.h[i]);
  }
  return wpath(D, H, false);
}

/**
 * Sample at arc length s (clamped; wraps on a closed path): position, direction, height, tangent.
 * `out.i` is used as a search hint (pass the previous result back for O(1) along a path). Zero-alloc.
 */
export function wsample(p: WPath, s: number, out: WSample): WSample {
  const n = p.h.length;
  const S = p.s;
  if (p.closed && p.length > 0) s = ((s % p.length) + p.length) % p.length;
  s = s < 0 ? 0 : s > p.length ? p.length : s;
  let i = out.i >= 0 && out.i < n - 1 ? out.i : 0;
  if (S[i] > s) {
    if (i > 0 && S[i - 1] <= s) i--;
    else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (S[m] <= s) lo = m;
        else hi = m;
      }
      i = lo;
    }
  } else if (i < n - 2 && S[i + 1] < s) {
    if (S[i + 2] >= s) i++;
    else {
      let lo = i, hi = n - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (S[m] <= s) lo = m;
        else hi = m;
      }
      i = lo;
    }
  }
  if (n < 2) i = 0;
  const j = Math.min(n - 1, i + 1);
  const seg = S[j] - S[i];
  const f = seg > 1e-9 ? (s - S[i]) / seg : 0;
  const ax = p.dir[i * 3], ay = p.dir[i * 3 + 1], az = p.dir[i * 3 + 2];
  const bx = p.dir[j * 3], by = p.dir[j * 3 + 1], bz = p.dir[j * 3 + 2];
  let dx = ax + (bx - ax) * f, dy = ay + (by - ay) * f, dz = az + (bz - az) * f;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= l;
  dy /= l;
  dz /= l;
  const h = p.h[i] + (p.h[j] - p.h[i]) * f;
  const r = R + h;
  out.dx = dx;
  out.dy = dy;
  out.dz = dz;
  out.h = h;
  out.x = dx * r;
  out.y = dy * r;
  out.z = dz * r;
  // Tangent: the segment direction made horizontal at the sample.
  let tx = bx - ax, ty = by - ay, tz = bz - az;
  if (j === i && i > 0) {
    tx = ax - p.dir[i * 3 - 3];
    ty = ay - p.dir[i * 3 - 2];
    tz = az - p.dir[i * 3 - 1];
  }
  const d = tx * dx + ty * dy + tz * dz;
  tx -= dx * d;
  ty -= dy * d;
  tz -= dz * d;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  out.tx = tx / tl;
  out.ty = ty / tl;
  out.tz = tz / tl;
  out.i = i;
  return out;
}

/**
 * Nearest point of p to unit direction q, measured on the surface (chord at radius R + h): writes
 * { dist (m), s }. Linear scan; boot-time and spec use. Returns dist.
 */
export function wnearest(p: WPath, q: Vec3, out: { dist: number; s: number }): number {
  let best = Infinity;
  let bs = 0;
  const n = p.h.length;
  for (let i = 0; i < n - 1; i++) {
    const ax = p.dir[i * 3], ay = p.dir[i * 3 + 1], az = p.dir[i * 3 + 2];
    const ex = p.dir[i * 3 + 3] - ax, ey = p.dir[i * 3 + 4] - ay, ez = p.dir[i * 3 + 5] - az;
    const ll = ex * ex + ey * ey + ez * ez;
    let t = ll > 0 ? ((q.x - ax) * ex + (q.y - ay) * ey + (q.z - az) * ez) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + ex * t - q.x, cy = ay + ey * t - q.y, cz = az + ez * t - q.z;
    const d = Math.sqrt(cx * cx + cy * cy + cz * cz) * (R + p.h[i]);
    if (d < best) {
      best = d;
      bs = p.s[i] + (p.s[i + 1] - p.s[i]) * t;
    }
  }
  out.dist = best;
  out.s = bs;
  return best;
}

/** Largest gap between consecutive samples (m): ≤ W_STEP for every path the region builds. */
export function wmaxGap(p: WPath): number {
  let g = 0;
  for (let i = 1; i < p.s.length; i++) g = Math.max(g, p.s[i] - p.s[i - 1]);
  return g;
}

/** World position of sample i into out. */
export function wpos(p: WPath, i: number, out: Vec3): Vec3 {
  const r = R + p.h[i];
  out.x = p.dir[i * 3] * r;
  out.y = p.dir[i * 3 + 1] * r;
  out.z = p.dir[i * 3 + 2] * r;
  return out;
}
