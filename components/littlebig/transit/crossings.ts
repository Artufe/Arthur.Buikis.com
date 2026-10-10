// V1 (v2): where the townsfolk cross the town streets (core/contracts.ts TownCrossing). Pure, cached
// per region, deterministic: transit/sim.ts stops for them, townsfolk/ (T2) walks over them.
//
// One crossing across each town street end at a junction, the capital's rule (world/city/graph.ts):
// its centre line CROSS_SETBACK out from the junction's patch edge, CROSS_W wide, square to the street,
// from kerb to kerb (the carriageway's edges, ±width/2: the sidewalks start there). Only on streets
// long enough that the lane arriving at it can still hold a car waiting short of it (CROSS_MIN), so
// no turn into a street is ever closed by a crossing. Dead ends, bends and the gate roundabouts (no
// sidewalks) get none.

import type { TownCrossing } from '../core/contracts';
import { R } from '../world/config';
import { wnearest, wsample, wsampleOut } from '../world/region/path';
import type { Region } from '../world/region/types';
import { v3, type Vec3 } from '../world/sphere';

/** Distance (m) from the junction's patch edge to the crossing's centre line, and its walk width (m). */
export const CROSS_SETBACK = 2.0;
export const CROSS_W = 2.4;
/** A vehicle waits with its front this far (m) short of a crossing's strip (stopS = laneS − W/2 − this). */
export const CROSS_STOP = 1.0;
/** Shortest street (m, centreline) that gets crossings: L − 4.2 still holds a 4 m car short of one. */
export const CROSS_MIN = 9;

/** A town crossing with where it is on the network (V1's own fields beyond the contract). */
export interface TransitCrossing extends TownCrossing {
  /** The street (REdge id) and the junction (RNode id) it sits by. */
  readonly edge: number;
  readonly node: number;
  /** Unit direction of its centre (on the street's centreline). */
  readonly c: Vec3;
}

const cache = new WeakMap<Region, TransitCrossing[]>();

/** Every town crossing, ids in order (cached per region). */
export function townCrossings(region: Region): TransitCrossing[] {
  let out = cache.get(region);
  if (out) return out;
  out = [];
  const q = wsampleOut();
  const near = { dist: 0, s: 0 };
  const at = (o: number, out: Vec3) => {
    // the centre point moved `o` m to the right of a → b, on the sphere at its height
    const k = o / (R + q.h);
    const rx = q.ty * q.dz - q.tz * q.dy;
    const ry = q.tz * q.dx - q.tx * q.dz;
    const rz = q.tx * q.dy - q.ty * q.dx;
    const x = q.dx + rx * k, y = q.dy + ry * k, z = q.dz + rz * k;
    const l = Math.hypot(x, y, z);
    out.x = x / l;
    out.y = y / l;
    out.z = z / l;
    return out;
  };
  for (const e of region.edges) {
    if (e.settlement < 1 || e.sidewalk <= 0 || (e.kind !== 'street' && e.kind !== 'lane')) continue;
    const L = e.centre.length;
    if (L < CROSS_MIN) continue;
    for (const end of [e.a, e.b]) {
      if (region.nodes[end].kind !== 'junction' || (e.a === e.b && end === e.b)) continue;
      q.i = 0;
      wsample(e.centre, end === e.a ? CROSS_SETBACK : L - CROSS_SETBACK, q);
      const half = e.width / 2;
      const lanes = [...e.lanesAB, ...e.lanesBA];
      const laneS = lanes.map((id) => {
        const l = region.lanes[id];
        wnearest(l.path, at(l.offset, v3()), near);
        return near.s;
      });
      out.push({ id: out.length, settlement: e.settlement, a: at(half, v3()), b: at(-half, v3()), width: CROSS_W, lanes, laneS, edge: e.id, node: end, c: v3(q.dx, q.dy, q.dz) });
    }
  }
  cache.set(region, out);
  return out;
}
