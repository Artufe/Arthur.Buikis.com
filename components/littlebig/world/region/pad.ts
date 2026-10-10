// A settlement pad's surface (types.ts Settlement: grade, upHeading, cut). Pure, zero-alloc.

import { R } from '../config';
import { dirToChart, type Vec3 } from '../sphere';
import type { Settlement } from './types';

/** Pad surface height (m above sea level) at plan (x, z) in the settlement's chart (+x east, +z south). */
export function padHeight(s: Settlement, x: number, z: number): number {
  if (!s.grade) return s.h;
  return s.h + s.grade * (x * Math.sin(s.upHeading) - z * Math.cos(s.upHeading));
}

const _q = { x: 0, z: 0 };
/** Pad surface height at unit direction `dir` (its plane extended beyond the pad: callers test `onPad`). */
export function padHeightAt(s: Settlement, dir: Vec3): number {
  if (!s.grade) return s.h;
  const q = dirToChart(s.chart, dir, _q);
  return padHeight(s, q.x, q.z);
}

/**
 * Signed distance (m, plan) from (x, z) to the pad's edge: < 0 inside the pad (the disc minus its cut's
 * bite), > 0 outside.
 */
export function padDist(s: Settlement, x: number, z: number): number {
  const d = Math.hypot(x, z) - s.padR;
  if (!s.cut) return d;
  // the axis toward the water: (sin heading, −cos heading) in plan
  const ax = Math.sin(s.heading), az = -Math.cos(s.heading);
  const f = x * ax + z * az;
  if (!Number.isFinite(s.cut.r)) return Math.max(d, f - s.cut.f);
  const bx = ax * (s.cut.f + s.cut.r), bz = az * (s.cut.f + s.cut.r);
  return Math.max(d, s.cut.r - Math.hypot(x - bx, z - bz));
}

/** True if unit `dir` is on the settlement's pad (inside its edge by `inset` m). */
export function onPad(s: Settlement, dir: Vec3, inset = 0): boolean {
  if (Math.acos(Math.min(1, dir.x * s.dir.x + dir.y * s.dir.y + dir.z * s.dir.z)) * R > s.padR + 1) return false;
  const q = dirToChart(s.chart, dir, _q);
  return padDist(s, q.x, q.z) <= -inset;
}

/**
 * v2 (R2 refine): signed distance (m, plan) from (x, z) to the pad's cut line (the quay or promenade
 * edge): > 0 seaward of it, < 0 inland. NaN when the pad has no cut.
 */
export function cutDist(s: Settlement, x: number, z: number): number {
  if (!s.cut) return NaN;
  const ax = Math.sin(s.heading), az = -Math.cos(s.heading);
  const f = x * ax + z * az;
  if (!Number.isFinite(s.cut.r)) return f - s.cut.f;
  const bx = ax * (s.cut.f + s.cut.r), bz = az * (s.cut.f + s.cut.r);
  return s.cut.r - Math.hypot(x - bx, z - bz);
}
