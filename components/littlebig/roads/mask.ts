// What the roads pave beyond Region.keepOut (v2, H1): the forecourt joining each gate plaza to the
// capital's turning circle (the two discs' hull). Pure, zero-alloc; the ground cover reads it.

import { R } from '../world/config';
import { CITY_CHART } from '../world/city/frame';
import { GATE_CIRCLE_R } from '../world/city/layout';
import type { Region } from '../world/region/types';
import { chartToDir, type Vec3 } from '../world/sphere';

const cache = new WeakMap<Region, Float64Array>();

/** True if unit q lies within `margin` m of a gate forecourt: the hull of the plaza disc and the city's turning circle. */
export function nearForecourt(region: Region, q: Vec3, margin: number): boolean {
  let f = cache.get(region);
  if (!f) {
    // per gate: plaza centre (unit), radius, city circle centre (unit), radius
    f = new Float64Array(region.gates.length * 8);
    region.gates.forEach((g, i) => {
      const c = chartToDir(CITY_CHART, g.cityX, g.cityZ);
      f!.set([g.dir.x, g.dir.y, g.dir.z, g.r, c.x, c.y, c.z, GATE_CIRCLE_R], i * 8);
    });
    cache.set(region, f);
  }
  for (let i = 0; i < f.length; i += 8) {
    const ax = f[i], ay = f[i + 1], az = f[i + 2], bx = f[i + 4], by = f[i + 5], bz = f[i + 6];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const l2 = ux * ux + uy * uy + uz * uz;
    let t = ((q.x - ax) * ux + (q.y - ay) * uy + (q.z - az) * uz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + ux * t - q.x, dy = ay + uy * t - q.y, dz = az + uz * t - q.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) * R < f[i + 3] + (f[i + 7] - f[i + 3]) * t + margin) return true;
  }
  return false;
}

/**
 * True if unit q lies in an airfield's clear zone, kept free of trees, bushes and rocks (low ground
 * cover stays): 14 m either side of a runway's centreline along its length, widening to 22 m over the
 * 60 m past each threshold (the approach and the climb-out).
 */
export function nearAirfield(region: Region, q: Vec3): boolean {
  for (const a of region.airports) {
    const e = a.ends[0], f = a.ends[1];
    const ux = f.x - e.x, uy = f.y - e.y, uz = f.z - e.z;
    const l2 = ux * ux + uy * uy + uz * uz;
    const t = ((q.x - e.x) * ux + (q.y - e.y) * uy + (q.z - e.z) * uz) / l2;
    const past = Math.max(-t, t - 1) * Math.sqrt(l2) * R;
    const dx = e.x + ux * t - q.x, dy = e.y + uy * t - q.y, dz = e.z + uz * t - q.z;
    if (past < 60 && Math.sqrt(dx * dx + dy * dy + dz * dz) * R < 14 + Math.max(0, past) * 0.14) return true;
  }
  return false;
}
