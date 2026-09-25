import type { Vec2 } from './types';

export const TAU = Math.PI * 2;

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  const r = ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return r <= -Math.PI ? Math.PI : r;
}

/** Signed shortest rotation from `from` to `to`. */
export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function headingToward(from: Vec2, to: Vec2): number | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (dx * dx + dz * dz < 1e-6) return null;
  return Math.atan2(dz, dx);
}

export type DirKeys = { up: boolean; down: boolean; left: boolean; right: boolean };

/** Screen-relative 8-way heading: up = -z, right = +x. */
export function headingFromKeys(k: DirKeys): number | null {
  const x = (k.right ? 1 : 0) - (k.left ? 1 : 0);
  const z = (k.down ? 1 : 0) - (k.up ? 1 : 0);
  if (x === 0 && z === 0) return null;
  return Math.atan2(z, x);
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
