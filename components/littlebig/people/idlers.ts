// People (B2): the ones who stay put. Bench and café sitters, bus-stop waiters, a little crowd
// round the fountain, and groups chatting on the plaza, the church square and the park lawn.
// Pure and seeded: the same people sit in the same places every visit.

import type { CityIndex, CityPlan, Feature } from '../world/city/types';
import { Rng } from '../world/rng';
import { featureObstacles, nearestSL, Pose, type Idler, type Obstacle } from './sim';

/** Seat top above the ground for benches, café chairs and the bus-shelter bench (city/props.ts). */
export const SEAT_H = 0.5;

export function makeIdlers(plan: CityPlan, index: CityIndex, seed: number, firstId: number): Idler[] {
  const rng = Rng.for(seed, 'people-idlers');
  const out: Idler[] = [];
  const obstacles: Obstacle[] = featureObstacles(plan.features);
  const near = { s: 0, l: 0, d: 0 };
  let id = firstId;
  // Crossing landings stay clear (2.5 m round both ends of every zebra's path), so a crossing can
  // always empty onto the pavement.
  const ends: number[] = [];
  for (const e of plan.walkEdges) {
    if (e.kind !== 'crossing') continue;
    const p = e.path.pts;
    ends.push(p[0], p[1], p[p.length - 2], p[p.length - 1]);
  }
  const atLanding = (x: number, z: number) => {
    for (let k = 0; k < ends.length; k += 2) if ((ends[k] - x) ** 2 + (ends[k + 1] - z) ** 2 < 2.5 * 2.5) return true;
    return false;
  };

  const local = (f: Feature, lx: number, lz: number) => {
    const c = Math.cos(f.angle);
    const s = Math.sin(f.angle);
    return { x: f.x + lx * c - lz * s, z: f.z + lx * s + lz * c };
  };
  const sit = (f: Feature, lx: number, lz: number, fx: number, fz: number, pose: Pose) => {
    const p = local(f, lx, lz);
    if (atLanding(p.x, p.z)) return;
    out.push({ x: p.x, z: p.z, h: index.groundH(f.x, f.z) + SEAT_H, fx, fz, pose, id: id++ });
  };
  /** Is a standing spot clear of paths, props, buildings and everyone already placed? */
  const standOk = (x: number, z: number, pathClear: number, skip: Obstacle | null = null) => {
    const k = index.classify(x, z);
    if (k === 'road' || k === 'intersection' || k === 'building' || k === 'water' || k === 'outside' || atLanding(x, z)) return false;
    for (const e of plan.walkEdges) {
      const dx = e.path.pts[0] - x;
      const dz = e.path.pts[1] - z;
      if (dx * dx + dz * dz > (e.path.length + 6) ** 2) continue;
      nearestSL(e.path, x, z, near);
      if (near.d < e.width / 2 + pathClear) return false;
    }
    for (const o of obstacles) if (o !== skip && Math.hypot(o.x - x, o.z - z) < o.r + 0.45) return false;
    for (const p of out) if (Math.hypot(p.x - x, p.z - z) < 0.62) return false;
    for (let b = 0; b < plan.buildings.length; b++) {
      const B = plan.buildings[b];
      const dx = x - B.x;
      const dz = z - B.z;
      const c = Math.cos(B.angle);
      const s = Math.sin(B.angle);
      const lx = Math.abs(dx * c + dz * s) - B.w / 2;
      const lz = Math.abs(-dx * s + dz * c) - B.d / 2;
      if (Math.max(lx, lz) < 0.5) return false;
    }
    return true;
  };
  const stand = (x: number, z: number, fx: number, fz: number) => {
    const l = Math.hypot(fx, fz) || 1;
    out.push({ x, z, h: index.groundH(x, z), fx: fx / l, fz: fz / l, pose: Pose.Stand, id: id++ });
  };
  /** A group of n people facing each other round (cx, cz). */
  const group = (cx: number, cz: number, n: number, pathClear: number): boolean => {
    const r = n === 2 ? 0.42 : 0.52;
    const a0 = rng.range(0, Math.PI * 2);
    const pts: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
      pts.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
    for (let k = 0; k < n; k++) if (!standOk(pts[k * 2], pts[k * 2 + 1], pathClear)) return false;
    for (let k = 0; k < n; k++) stand(pts[k * 2], pts[k * 2 + 1], cx - pts[k * 2], cz - pts[k * 2 + 1]);
    return true;
  };

  for (const f of plan.features) {
    const c = Math.cos(f.angle);
    const s = Math.sin(f.angle);
    if (f.kind === 'bench') {
      // faces local −z = (sin a, −cos a)
      const roll = rng.float();
      if (roll < 0.25) continue;
      if (roll < 0.6) sit(f, rng.range(-0.45, 0.45), -0.02, s, -c, Pose.Sit);
      else {
        sit(f, -0.42, -0.02, s, -c, Pose.Sit);
        sit(f, 0.42, -0.02, s, -c, Pose.Sit);
      }
    } else if (f.kind === 'cafe-table') {
      // chairs at local x = ±0.62 (backrests at ±0.8): sit on the front of the seat, facing the table
      const roll = rng.float();
      if (roll < 0.75) sit(f, -0.54, 0, c, s, Pose.Cafe);
      if (roll > 0.3) sit(f, 0.54, 0, -c, -s, Pose.Cafe);
    } else if (f.kind === 'bus-stop') {
      sit(f, rng.range(-0.5, 0.5), 0.3, s, -c, Pose.Sit);
      for (const lx of [-1.95, 2.3]) {
        const p = local(f, lx, -0.05 + rng.range(-0.15, 0.15));
        if (rng.float() < 0.7 && standOk(p.x, p.z, -10)) stand(p.x, p.z, s, -c);
      }
    } else if (f.kind === 'fountain') {
      // Life round the fountain, not a ring: three sit on the rim facing out, a kid leans in over
      // it, a pair chat with their backs to the water, two more stand watching the jet.
      const R0 = f.r ?? 1.6;
      const fo = obstacles.find((o) => o.x === f.x && o.z === f.z) ?? null;
      const a0 = rng.range(0, Math.PI * 2);
      const at = (a: number, r: number) => ({ x: f.x + Math.cos(a) * r, z: f.z + Math.sin(a) * r, cx: Math.cos(a), cz: Math.sin(a) });
      for (let k = 0; k < 3; k++) {
        const q = at(a0 + k * 1.25 + rng.range(-0.2, 0.2), R0 - 0.12);
        const feet = at(Math.atan2(q.cz, q.cx), R0 + 0.4);
        if (standOk(feet.x, feet.z, 0.15, fo)) out.push({ x: q.x, z: q.z, h: index.groundH(f.x, f.z) + 0.5, fx: q.cx, fz: q.cz, pose: Pose.Sit, id: id++ });
      }
      const kid = at(a0 + 4.1, R0 + 0.24);
      if (standOk(kid.x, kid.z, 0.3, fo)) out.push({ x: kid.x, z: kid.z, h: index.groundH(kid.x, kid.z), fx: -kid.cx, fz: -kid.cz, pose: Pose.Lean, id: id++ });
      const mid = at(a0 + 5.0, R0 + 0.5);
      for (const sd of [1, -1]) {
        // the pair: side by side along the rim, turned to each other
        const x = mid.x - mid.cz * sd * 0.34;
        const z = mid.z + mid.cx * sd * 0.34;
        if (standOk(x, z, 0.3, fo)) stand(x, z, mid.cz * sd + mid.cx * 0.3, -mid.cx * sd + mid.cz * 0.3);
      }
      for (const a of [a0 + 3.2, a0 + 3.75]) {
        const q = at(a + rng.range(-0.1, 0.1), R0 + 0.42);
        if (standOk(q.x, q.z, 0.35, fo)) stand(q.x, q.z, -q.cx, -q.cz);
      }
    } else if (f.kind === 'statue') {
      for (let k = 0; k < 2; k++) {
        const a = f.angle + Math.PI / 2 + rng.range(-0.6, 0.6);
        const x = f.x + Math.cos(a) * 1.9;
        const z = f.z + Math.sin(a) * 1.9;
        if (standOk(x, z, 0.3)) stand(x, z, f.x - x, f.z - z);
      }
    }
  }

  // Groups on the plaza and the park lawn.
  for (const a of plan.areas) {
    if (a.kind !== 'plaza' && a.kind !== 'park') continue;
    const o = a.outline;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < o.length; k += 2) {
      minX = Math.min(minX, o[k]);
      maxX = Math.max(maxX, o[k]);
      minZ = Math.min(minZ, o[k + 1]);
      maxZ = Math.max(maxZ, o[k + 1]);
    }
    const area = (maxX - minX) * (maxZ - minZ);
    const want = a.kind === 'plaza' ? Math.min(4, Math.round(area / 260)) : Math.min(4, Math.round(area / 500));
    let made = 0;
    for (let tries = 0; tries < 80 && made < want; tries++) {
      const x = rng.range(minX, maxX);
      const z = rng.range(minZ, maxZ);
      const k = index.classify(x, z);
      if (k !== a.kind) continue;
      if (group(x, z, rng.float() < 0.6 ? 2 : 3, 0.75)) made++;
    }
  }
  return out;
}
