// The BRIEF §5 city invariants as a reusable checker. Returns a list of human-readable violations
// (empty = valid). Specs call it on whatever plan is current; A2 reuses it for the real plan.

import { CITY_PLAN_RADIUS } from '../config';
import { pointInPolygon } from './graph';
import { buildingCorners, createCityIndex, featureRadius, obbDistance } from './index-grid';
import { maxGap } from './path';
import { type Building, type CityPlan, type Polyline, VEHICLE_CLEARANCE } from './types';

/** Distance below which two points count as the same (m). */
const JOIN_EPS = 1e-6;

export function validatePlan(plan: CityPlan, opts: { maxRadius?: number } = {}): string[] {
  const errs: string[] = [];
  const maxR = opts.maxRadius ?? CITY_PLAN_RADIUS;
  if (plan.radius > maxR + 1e-9) errs.push(`plan.radius ${plan.radius.toFixed(1)} exceeds the plateau (${maxR.toFixed(1)})`);

  // 1. Everything inside the plateau.
  const inside = (x: number, z: number, what: string, pad = 0) => {
    if (Math.hypot(x, z) + pad > maxR) errs.push(`${what} leaves the plateau at (${x.toFixed(1)}, ${z.toFixed(1)})`);
  };
  for (const e of plan.edges) {
    const p = e.centre.pts;
    for (let i = 0; i < p.length; i += 2) inside(p[i], p[i + 1], `edge ${e.id}`, e.width / 2 + e.sidewalk);
  }
  for (const b of plan.buildings) {
    const c = buildingCorners(b);
    for (let i = 0; i < c.length; i += 2) inside(c[i], c[i + 1], `building ${b.id}`);
  }
  for (const a of plan.areas) for (let i = 0; i < a.outline.length; i += 2) inside(a.outline[i], a.outline[i + 1], `area ${a.id}`);

  // 2. Paths sampled ≤ 1 m.
  const gap = (pl: Polyline, what: string) => {
    const g = maxGap(pl);
    if (g > 1.0 + 1e-6) errs.push(`${what} has a ${g.toFixed(2)} m gap between samples`);
  };
  plan.edges.forEach((e) => gap(e.centre, `edge ${e.id} centre`));
  plan.lanes.forEach((l) => gap(l.path, `lane ${l.id}`));
  plan.connectors.forEach((c) => gap(c.path, `connector ${c.id}`));
  plan.walkEdges.forEach((w) => gap(w.path, `walk edge ${w.id}`));

  // 3. Lanes continuous through intersections.
  const pt = (pl: Polyline, end: boolean) => {
    const n = pl.pts.length;
    return end ? [pl.pts[n - 2], pl.pts[n - 1]] : [pl.pts[0], pl.pts[1]];
  };
  for (const l of plan.lanes) {
    if (!l.next.length) errs.push(`lane ${l.id} has no outgoing connector (dead end)`);
    if (!l.prev.length) errs.push(`lane ${l.id} has no incoming connector`);
  }
  for (const c of plan.connectors) {
    const a = pt(plan.lanes[c.fromLane].path, true);
    const b = pt(c.path, false);
    const d = pt(c.path, true);
    const e = pt(plan.lanes[c.toLane].path, false);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > JOIN_EPS) errs.push(`connector ${c.id} does not start at lane ${c.fromLane}'s end`);
    if (Math.hypot(d[0] - e[0], d[1] - e[1]) > JOIN_EPS) errs.push(`connector ${c.id} does not end at lane ${c.toLane}'s start`);
  }

  // 4. Every road edge reachable from every other (the lane graph is strongly connected).
  if (plan.lanes.length) {
    const reach = (forward: boolean) => {
      const seen = new Uint8Array(plan.lanes.length);
      const stack = [0];
      seen[0] = 1;
      while (stack.length) {
        const l = plan.lanes[stack.pop()!];
        for (const cid of forward ? l.next : l.prev) {
          const c = plan.connectors[cid];
          const n = forward ? c.toLane : c.fromLane;
          if (!seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      return seen;
    };
    const f = reach(true);
    const b = reach(false);
    const unreachable = plan.lanes.filter((l) => !f[l.id] || !b[l.id]).map((l) => l.id);
    if (unreachable.length) errs.push(`lanes not strongly connected: ${unreachable.slice(0, 10).join(', ')}${unreachable.length > 10 ? '…' : ''}`);
  }

  // 5. No building intersects a road, sidewalk, intersection patch or another building.
  for (const b of plan.buildings) {
    for (const e of plan.edges) {
      const clear = e.width / 2 + e.sidewalk;
      const d = obbPolylineDistance(b, e.centre);
      if (d < clear - 1e-6) errs.push(`building ${b.id} intersects edge ${e.id} (${d.toFixed(2)} m < ${clear.toFixed(2)} m)`);
    }
    for (const n of plan.nodes) {
      if (obbDistance(b, n.x, n.z) < n.radius - 1e-6) errs.push(`building ${b.id} intersects intersection ${n.id}`);
    }
  }
  for (let i = 0; i < plan.buildings.length; i++) {
    for (let j = i + 1; j < plan.buildings.length; j++) {
      if (obbOverlap(plan.buildings[i], plan.buildings[j])) errs.push(`buildings ${i} and ${j} overlap`);
    }
  }

  // 5b. No building on a walk edge (corner sidewalks, footpaths, crossings), no feature inside a
  // building (0.3 m clear of its collision disc) or on a carriageway / intersection.
  for (const b of plan.buildings) {
    for (const w of plan.walkEdges) {
      const d = obbPolylineDistance(b, w.path);
      if (d < w.width / 2 - 1e-6) errs.push(`building ${b.id} intersects walk edge ${w.id} (${w.kind})`);
    }
  }
  const index = createCityIndex(plan);
  plan.features.forEach((f, i) => {
    const r = featureRadius(f);
    for (const b of plan.buildings) if (obbDistance(b, f.x, f.z) < r + 0.3) errs.push(`feature ${i} (${f.kind}) is inside or against building ${b.id}`);
    const c = index.classify(f.x, f.z);
    if (c === 'road' || c === 'intersection') errs.push(`feature ${i} (${f.kind}) stands on the ${c}`);
  });

  // 5c. Turn connectors stay inside their intersection patch (lane ends lie on its edge), clear of
  // every zebra strip, and pass non-conflicting connectors with a bus-width margin.
  const outlineOf = new Map(plan.intersections.map((x) => [x.node, x.outline]));
  for (const c of plan.connectors) {
    const o = outlineOf.get(c.node);
    if (!o) continue;
    const p = c.path.pts;
    for (let i = 0; i < p.length; i += 2) {
      if (!pointInPolygon(o, p[i], p[i + 1]) && polygonDistance(o, p[i], p[i + 1]) > 0.15) {
        errs.push(`connector ${c.id} leaves intersection ${c.node}'s patch`);
        break;
      }
    }
  }
  for (const w of plan.walkEdges) {
    if (w.kind !== 'crossing') continue;
    for (const c of plan.connectors) {
      if (polylineDistance(c.path, w.path) < w.width / 2) errs.push(`connector ${c.id} crosses zebra strip ${w.id}`);
    }
    w.lanes?.forEach((lid, i) => {
      const l = plan.lanes[lid];
      const s = w.laneS?.[i];
      if (s === undefined) errs.push(`crossing ${w.id} has no laneS for lane ${lid}`);
      else if (l.crossingAtEnd === w.id && l.stopS > s - w.width / 2 - 0.3) errs.push(`lane ${lid}'s stop line is on crossing ${w.id}`);
    });
  }
  const byNode = new Map<number, typeof plan.connectors>();
  for (const c of plan.connectors) {
    let l = byNode.get(c.node);
    if (!l) byNode.set(c.node, (l = []));
    l.push(c);
  }
  for (const list of byNode.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i];
        const q = list[j];
        if (p.fromLane === q.fromLane || p.conflicts.includes(q.id)) continue;
        const d = polylineDistance(p.path, q.path);
        if (d < VEHICLE_CLEARANCE) errs.push(`connectors ${p.id} and ${q.id} pass ${d.toFixed(2)} m apart without a conflict`);
      }
    }
  }

  // 6. The pedestrian graph is connected (people can reach every sidewalk).
  if (plan.walkNodes.length) {
    const seen = new Uint8Array(plan.walkNodes.length);
    const stack = [0];
    seen[0] = 1;
    while (stack.length) {
      const w = plan.walkNodes[stack.pop()!];
      for (const eid of w.edges) {
        const e = plan.walkEdges[eid];
        const o = e.a === w.id ? e.b : e.a;
        if (!seen[o]) {
          seen[o] = 1;
          stack.push(o);
        }
      }
    }
    const lost = seen.reduce((n, v) => n + (v ? 0 : 1), 0);
    if (lost) errs.push(`${lost} walk nodes unreachable from walk node 0`);
  }
  return errs;
}

/** Minimum distance between a building footprint and a polyline (0 if they intersect). */
export function obbPolylineDistance(b: Building, pl: Polyline): number {
  const corners = buildingCorners(b);
  const p = pl.pts;
  let best = Infinity;
  const reach = Math.hypot(b.w, b.d) / 2;
  for (let i = 0; i < p.length - 2; i += 2) {
    // Cheap reject.
    const mx = (p[i] + p[i + 2]) / 2;
    const mz = (p[i + 1] + p[i + 3]) / 2;
    const half = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / 2;
    if (Math.hypot(mx - b.x, mz - b.z) - half - reach > best) continue;
    best = Math.min(best, Math.max(0, obbDistance(b, p[i], p[i + 1])), Math.max(0, obbDistance(b, p[i + 2], p[i + 3])));
    for (let k = 0; k < 8; k += 2) {
      best = Math.min(best, segPointDist(corners[k], corners[k + 1], p[i], p[i + 1], p[i + 2], p[i + 3]));
    }
    // Segment crossing the box: both endpoints outside but crossing an edge.
    for (let k = 0; k < 8; k += 2) {
      const k2 = (k + 2) % 8;
      if (segIntersect(p[i], p[i + 1], p[i + 2], p[i + 3], corners[k], corners[k + 1], corners[k2], corners[k2 + 1])) return 0;
    }
  }
  return best;
}

/** Minimum distance between two polylines (samples of each against segments of the other). */
export function polylineDistance(p: Polyline, q: Polyline): number {
  let best = Infinity;
  for (const [u, v] of [
    [p.pts, q.pts],
    [q.pts, p.pts],
  ]) {
    for (let i = 0; i < u.length; i += 2) {
      if (v.length === 2) best = Math.min(best, Math.hypot(u[i] - v[0], u[i + 1] - v[1]));
      for (let j = 0; j < v.length - 2; j += 2) best = Math.min(best, segPointDist(u[i], u[i + 1], v[j], v[j + 1], v[j + 2], v[j + 3]));
    }
  }
  return best;
}

/** Distance from a point to a closed polygon's boundary. */
function polygonDistance(poly: ArrayLike<number>, x: number, z: number): number {
  const n = poly.length >> 1;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    best = Math.min(best, segPointDist(x, z, poly[i * 2], poly[i * 2 + 1], poly[j * 2], poly[j * 2 + 1]));
  }
  return best;
}

function segPointDist(px: number, pz: number, x0: number, z0: number, x1: number, z1: number) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return Math.hypot(x0 + dx * t - px, z0 + dz * t - pz);
}

function segIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Separating-axis overlap test for two building footprints (touching counts as clear). */
export function obbOverlap(a: Building, b: Building): boolean {
  const ca = buildingCorners(a);
  const cb = buildingCorners(b);
  for (const ang of [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2]) {
    const ax = Math.cos(ang);
    const az = Math.sin(ang);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const pa = ca[k] * ax + ca[k + 1] * az;
      const pb = cb[k] * ax + cb[k + 1] * az;
      a0 = Math.min(a0, pa);
      a1 = Math.max(a1, pa);
      b0 = Math.min(b0, pb);
      b1 = Math.max(b1, pb);
    }
    if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
  }
  return true;
}
