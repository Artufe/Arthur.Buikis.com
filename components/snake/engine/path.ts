import { SAMPLE_SPACING, type Vec2 } from './types';

/**
 * Lays new samples along the straight segment `from → to`. `path` is newest first and
 * path[0] sits `carry` behind `from`; the result keeps the same invariant relative to `to`.
 */
export function advancePath(
  path: Vec2[],
  carry: number,
  from: Vec2,
  to: Vec2,
): { path: Vec2[]; carry: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len === 0) return { path, carry };
  const ux = dx / len;
  const uz = dz / len;
  let c = carry + len;
  const fresh: Vec2[] = []; // oldest first
  while (c >= SAMPLE_SPACING) {
    c -= SAMPLE_SPACING;
    fresh.push({ x: to.x - ux * c, z: to.z - uz * c });
  }
  if (fresh.length === 0) return { path, carry: c };
  return { path: [...fresh.reverse(), ...path], carry: c };
}

/** Arc distance from the head to path[i]. */
export function arcAt(carry: number, i: number): number {
  return carry + i * SAMPLE_SPACING;
}

/** Keeps the samples that lie within `keepArc` of the head (always at least one). */
export function trimPath(path: Vec2[], carry: number, keepArc: number): Vec2[] {
  const count = Math.max(1, Math.floor((keepArc - carry) / SAMPLE_SPACING) + 1);
  return path.length > count ? path.slice(0, count) : path;
}
