// Small spherical helpers for the region builder (R1). Pure; the allocating ones are boot-time only.

import { R } from '../config';
import { headingVector, normalize3, v3, type Vec3 } from '../sphere';

export const DEG = Math.PI / 180;

export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const norm2pi = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
export const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Walk `m` sea-level metres from unit `from` along compass heading `hd` (the tangent frame of
 * world/sphere.ts, inlined: this runs for every terrain sample of the site searches).
 */
export function walk(from: Vec3, hd: number, m: number, out: Vec3 = v3()): Vec3 {
  const ux = from.x, uy = from.y, uz = from.z;
  // east = normalize(Y × up) (+X at the poles), north = up × east
  let ex: number, ey: number, ez: number;
  if (uy > 0.999999 || uy < -0.999999) {
    ex = 1 - ux * ux;
    ey = -ux * uy;
    ez = -ux * uz;
  } else {
    ex = uz;
    ey = 0;
    ez = -ux;
  }
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
  ex /= el;
  ey /= el;
  ez /= el;
  const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
  const ch = Math.cos(hd), sh = Math.sin(hd);
  const tx = nx * ch + ex * sh, ty = ny * ch + ey * sh, tz = nz * ch + ez * sh;
  const a = m / R;
  const c = Math.cos(a), s = Math.sin(a);
  const x = ux * c + tx * s, y = uy * c + ty * s, z = uz * c + tz * s;
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return out;
}

/** Great-circle distance (sea-level metres) between unit directions. */
export function arc(a: Vec3, b: Vec3): number {
  const cx = a.y * b.z - a.z * b.y, cy = a.z * b.x - a.x * b.z, cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), a.x * b.x + a.y * b.y + a.z * b.z) * R;
}

/** Unit tangent at `at` pointing toward `to` (along the great circle). */
export function towardTangent(to: Vec3, at: Vec3, out: Vec3 = v3()): Vec3 {
  const c = to.x * at.x + to.y * at.y + to.z * at.z;
  out.x = to.x - at.x * c;
  out.y = to.y - at.y * c;
  out.z = to.z - at.z * c;
  const l = Math.hypot(out.x, out.y, out.z);
  if (l < 1e-12) return headingVector(at, 0, out);
  out.x /= l;
  out.y /= l;
  out.z /= l;
  return out;
}

/** Unit tangent at `at` pointing AWAY from `from`. */
export function awayTangent(from: Vec3, at: Vec3, out: Vec3 = v3()): Vec3 {
  towardTangent(from, at, out);
  out.x = -out.x;
  out.y = -out.y;
  out.z = -out.z;
  return out;
}

export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const ang = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
  if (ang < 1e-9) return v3(a.x, a.y, a.z);
  const s = Math.sin(ang);
  const wa = Math.sin((1 - t) * ang) / s;
  const wb = Math.sin(t * ang) / s;
  return normalize3(v3(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb));
}

/** Distance (sea-level metres) from unit d to the chord segment a–b (unit directions). */
export function segDist(d: Vec3, a: Vec3, b: Vec3): number {
  const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
  const ll = ex * ex + ey * ey + ez * ez;
  let t = ll > 0 ? ((d.x - a.x) * ex + (d.y - a.y) * ey + (d.z - a.z) * ez) / ll : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a.x + ex * t - d.x, a.y + ey * t - d.y, a.z + ez * t - d.z) * R;
}

/** Walk `m` metres from unit p along unit tangent t (great circle). */
export function step(p: Vec3, t: Vec3, m: number, out: Vec3 = v3()): Vec3 {
  const a = m / R;
  out.x = p.x * Math.cos(a) + t.x * Math.sin(a);
  out.y = p.y * Math.cos(a) + t.y * Math.sin(a);
  out.z = p.z * Math.cos(a) + t.z * Math.sin(a);
  return normalize3(out);
}

/** Point on the chord a → b at fraction f, back on the sphere. */
export function lerpDir(a: Vec3, b: Vec3, f: number, out: Vec3 = v3()): Vec3 {
  out.x = a.x + (b.x - a.x) * f;
  out.y = a.y + (b.y - a.y) * f;
  out.z = a.z + (b.z - a.z) * f;
  return normalize3(out);
}

/**
 * v2 (R2 refine): fair a plan polyline (x, z interleaved, roughly even samples `step` m apart) where it
 * turns tighter than `rMin` (circumradius of samples ~2 m apart, as the specs measure): local smoothing
 * passes over the unpinned samples round each tight spot, the window growing while the spot stays
 * tight (a turn pressed against a pinned straight spreads along the free curve beyond). In place.
 */
export function fairLine(line: number[], pinned: ArrayLike<boolean>, rMin: number, step: number): void {
  const n = line.length / 2;
  const W = Math.max(2, Math.round(2 / Math.max(0.05, step)));
  // (tighter than rMin: the circumradius ab·bc·ca / 2·area, compared squared — no roots)
  const k2 = 4 * rMin * rMin;
  const tight = (i: number) => {
    const ax = line[(i - W) * 2], az = line[(i - W) * 2 + 1], bx = line[i * 2], bz = line[i * 2 + 1], cx = line[(i + W) * 2], cz = line[(i + W) * 2 + 1];
    const ab = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
    const bc = (cx - bx) * (cx - bx) + (cz - bz) * (cz - bz);
    const ca = (ax - cx) * (ax - cx) + (az - cz) * (az - cz);
    const ar = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    return ab * bc * ca < k2 * ar * ar;
  };
  let lo = n;
  let hi = -1;
  const touched = new Uint8Array(n);
  // (after the first sweep only the stretch already touched can have changed: its tight spots are
  // all that is looked at again)
  let s0 = W;
  let s1 = n - W - 1;
  for (let pass = 0; pass < 480; pass++) {
    const reach = W * (pass < 120 ? 2 : pass < 240 ? 4 : pass < 360 ? 8 : 14);
    let any = false;
    for (let i = s0; i <= s1; i++) {
      if (!tight(i)) continue;
      any = true;
      lo = Math.min(lo, i - reach);
      hi = Math.max(hi, i + reach);
      for (let q = Math.max(1, i - reach); q <= Math.min(n - 2, i + reach); q++) {
        if (pinned[q]) continue;
        line[q * 2] += 0.5 * ((line[q * 2 - 2] + line[q * 2 + 2]) / 2 - line[q * 2]);
        line[q * 2 + 1] += 0.5 * ((line[q * 2 - 1] + line[q * 2 + 3]) / 2 - line[q * 2 + 1]);
        touched[q] = 1;
      }
      i += W;
    }
    if (!any) break;
    s0 = Math.max(W, lo - W);
    s1 = Math.min(n - W - 1, hi + W);
  }
  // (the pass above holds pinned samples' positions only, so where it moved a curve next to a pinned
  // straight, or stopped at the edge of its window, it leaves a kink: fourth-difference passes over
  // just the stretch it touched, local and high-frequency only, turn those joints tangent-continuous
  // again without loosening the curve between)
  if (hi < 0) return;
  // (the free samples within a window of any the smoothing moved: the joints it can have kinked)
  const idx: number[] = [];
  for (let q = 2, near = -1e9; q < n - 2; q++) {
    if (touched[Math.min(n - 1, q + W)]) near = q + W;
    if (q - near > 2 * W || pinned[q]) continue;
    idx.push(q);
  }
  const fx = new Float64Array(n);
  const fz = new Float64Array(n);
  for (let pass = 0; pass < 240; pass++) {
    for (const q of idx) {
      fx[q] = line[q * 2 - 4] - 4 * line[q * 2 - 2] + 6 * line[q * 2] - 4 * line[q * 2 + 2] + line[q * 2 + 4];
      fz[q] = line[q * 2 - 3] - 4 * line[q * 2 - 1] + 6 * line[q * 2 + 1] - 4 * line[q * 2 + 3] + line[q * 2 + 5];
    }
    for (const q of idx) {
      line[q * 2] -= 0.1 * fx[q];
      line[q * 2 + 1] -= 0.1 * fz[q];
    }
  }
}
