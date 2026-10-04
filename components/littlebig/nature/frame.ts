// Instance placement on the sphere (A1 nature).

import type { Matrix4 } from 'three';

/**
 * Instance matrix for a thing standing at (x, y, z) with local +Y along the unit `up`, turned by
 * `yaw` about it, scaled w (local x) × h (y) × d (local z, default w).
 */
export function composeUp(m: Matrix4, x: number, y: number, z: number, ux: number, uy: number, uz: number, yaw: number, w: number, h: number, d = w): Matrix4 {
  // A tangent: east (Y × up), falling back to +X near the poles.
  let ex = uz, ey = 0, ez = -ux;
  let el = Math.hypot(ex, ey, ez);
  if (el < 1e-6) {
    ex = 1;
    ey = 0;
    ez = 0;
    el = 1;
  }
  ex /= el;
  ey /= el;
  ez /= el;
  // north = up × east
  const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rx = ex * c + nx * s, ry = ey * c + ny * s, rz = ez * c + nz * s;
  // forward = right × up (so (right, up, forward) is right-handed)
  const fx = ry * uz - rz * uy, fy = rz * ux - rx * uz, fz = rx * uy - ry * ux;
  m.set(rx * w, ux * h, fx * d, x, ry * w, uy * h, fy * d, y, rz * w, uz * h, fz * d, z, 0, 0, 0, 1);
  return m;
}

/** The yaw (composeUp's convention) that turns local +X along the tangent direction (tx, ty, tz). */
export function yawAlong(ux: number, uy: number, uz: number, tx: number, ty: number, tz: number): number {
  let ex = uz, ez = -ux;
  const el = Math.hypot(ex, ez);
  if (el < 1e-6) return Math.atan2(tz, tx);
  ex /= el;
  ez /= el;
  const nx = uy * ez, ny = uz * ex - ux * ez, nz = -uy * ex;
  return Math.atan2(tx * nx + ty * ny + tz * nz, tx * ex + tz * ez);
}
