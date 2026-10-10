// The city chart: plan (x, z) ⇄ the sphere. Pure, zero-alloc per call.
//
// Plan +x = east, +z = south at the city centre; arc length is measured on the plateau surface
// (radius CITY_SURFACE_R), so plan metres are surface metres along rays from the centre.
// Heights h are metres above the plateau (a road is h = 0).

import { CITY_LAT, CITY_LON, CITY_SURFACE_R } from '../config';
import { chartFrame, chartToDir, createChart, dirToChart, headingOf, normalize3, scale3, set3, v3, type Vec2, type Vec3 } from '../sphere';

export const CITY_CHART = createChart(CITY_LAT, CITY_LON, CITY_SURFACE_R);

/** Unit direction of plan point (x, z). */
export function planToDir(x: number, z: number, out: Vec3 = v3()): Vec3 {
  return chartToDir(CITY_CHART, x, z, out);
}

/** World position of plan point (x, z) at height h above the plateau. */
export function toSphere(x: number, z: number, h: number, out: Vec3 = v3()): Vec3 {
  chartToDir(CITY_CHART, x, z, out);
  return scale3(out, out, CITY_SURFACE_R + h);
}

const _d = v3();
/** Plan point under a world position or direction (any length). */
export function fromSphere(p: Vec3, out: Vec2 = { x: 0, z: 0 }): Vec2 {
  normalize3(_d, p);
  return dirToChart(CITY_CHART, _d, out);
}

/**
 * Orientation of the plan at (x, z): `up` (unit radial), `ax` / `az` (UNIT tangents along plan +x /
 * +z there). A thing at plan angle `a` (Building.angle) has local +x = ax·cos a + az·sin a.
 * Good for orienting small or round things (people, cars, lamps). For anything with a plan
 * FOOTPRINT (buildings, lots, benches) use planBasis(), or the rendered box is wider than the
 * footprint by up to 5 % (the chart's circumferential shrink).
 */
export function planFrame(x: number, z: number, out: { up: Vec3; ax: Vec3; az: Vec3 }): void {
  chartFrame(CITY_CHART, x, z, out.up, out.ax, out.az);
}

const _bp = v3();
const _bm = v3();
/**
 * The exponential map's Jacobian at plan (x, z), height h: `up` (unit radial) and `ax` / `az` =
 * world metres per plan metre along plan +x / +z (NOT normalised; |ax|, |az| ≤ 1 and they differ
 * off the centre lines). An instance whose footprint is w × d at plan angle a then matches its
 * mapped footprint when built from columns
 *   (ax·cos a + az·sin a)·w,   up·height,   (−ax·sin a + az·cos a)·d
 * at position toSphere(x, z, h), for a unit box centred on its base. (The matrix carries a slight
 * shear; three's instanced normals ignore it, which is invisible under toon shading.)
 */
export function planBasis(x: number, z: number, out: { up: Vec3; ax: Vec3; az: Vec3 }, h = 0): void {
  const k = 0.05;
  const r = (CITY_SURFACE_R + h) / (2 * k);
  chartToDir(CITY_CHART, x, z, out.up);
  chartToDir(CITY_CHART, x + k, z, _bp);
  chartToDir(CITY_CHART, x - k, z, _bm);
  set3(out.ax, (_bp.x - _bm.x) * r, (_bp.y - _bm.y) * r, (_bp.z - _bm.z) * r);
  chartToDir(CITY_CHART, x, z + k, _bp);
  chartToDir(CITY_CHART, x, z - k, _bm);
  set3(out.az, (_bp.x - _bm.x) * r, (_bp.y - _bm.y) * r, (_bp.z - _bm.z) * r);
}

const _f = { up: v3(), ax: v3(), az: v3() };
const _t = v3();
/** Compass heading (rad from north) at (x, z) of the plan direction `planHeading` = atan2(dx, −dz). */
export function planHeadingToWorld(x: number, z: number, planHeading: number): number {
  planFrame(x, z, _f);
  const dx = Math.sin(planHeading);
  const dz = -Math.cos(planHeading);
  set3(_t, _f.ax.x * dx + _f.az.x * dz, _f.ax.y * dx + _f.az.y * dz, _f.ax.z * dx + _f.az.z * dz);
  return headingOf(_f.up, _t);
}

/** Plan heading (atan2(dx, −dz)) at (x, z) of a world compass heading. Inverse of the above. */
export function worldHeadingToPlan(x: number, z: number, heading: number): number {
  // Sample the world heading of plan north and east here, then invert linearly (the chart is conformal at the
  // centre and nearly so on the plateau).
  const h0 = planHeadingToWorld(x, z, 0);
  return heading - h0;
}
