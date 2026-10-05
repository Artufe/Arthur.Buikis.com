// The region's road graph builder (R1): node and edge specs (raw world-space centrelines from node
// centre to node centre) → trimmed centrelines, lanes, turn connectors with lazy conflicts, bridge
// records. The world-space twin of world/city/graph.ts: small things (departure angles, turn
// curves, conflict tests) are done in a chart round each node, where the exponential map is exact
// to well under a centimetre over a junction's few metres. Pure, deterministic, boot-time.
//
// Geometry a vehicle can drive (V1 rides these, so a kink is a car snapping in place):
//   - every turn connector is a true circular-arc FILLET between its two lane ends (straight, arc,
//     straight), never tighter than RHO_MIN; a roundabout's circulating connector is the ring's own arc;
//   - a dead end's U-turn swings out on a fillet, follows the turning circle (lane centre turnR −
//     U_INSET) with the island on its left, and swings back in on the mirror fillet;
//   - each node's patch radius (where its arms' centrelines are trimmed) is SEARCHED: the smallest
//     radius, from the curb geometry up, at which every connector at the node meets RHO_MIN.

import { R } from '../config';
import { turningRadius } from '../city/graph';
import { hermitePoints } from '../city/path';
import { VEHICLE_CLEARANCE } from '../city/types';
import { chartToDir, dirToChart, tangentFrame, v3, type Chart, type Vec3 } from '../sphere';
import { woffset, wpath, wreverse, wtrim } from './path';
import type { Bridge, NodePlace, RConnector, REdge, RegionRoadKind, RLane, RNode, RTurn, WPath } from './types';

export interface NodeSpec {
  dir: Vec3;
  h: number;
  control?: RNode['control'];
  place: NodePlace;
  settlement?: number;
  gate?: number;
}

export interface EdgeSpec {
  a: number;
  b: number;
  /** Raw centreline from node a's centre to node b's centre (heights = road surface). */
  raw: WPath;
  kind: RegionRoadKind;
  width: number;
  sidewalk: number;
  speed: number;
  oneWay?: boolean;
  settlement?: number;
  name: string;
  /** Bridge spans on the RAW centreline's arc length. */
  bridges?: Array<[number, number]>;
  /** For bridge records: the lowest deck over water and its clearance, per span. */
  bridgeInfo?: Array<{ deckMin: number; clearance: number }>;
}

export interface Network {
  nodes: RNode[];
  edges: REdge[];
  bridges: Bridge[];
  /**
   * Lanes and turn connectors, built on first call (off the terrain's first-frame path: the carve
   * needs only the centrelines). Reading an edge's lanesAB / lanesBA builds them too.
   */
  transit(): { lanes: RLane[]; connectors: RConnector[] };
}

/** Rank of a road kind for priorities (higher = major). */
const RANK: Record<RegionRoadKind, number> = { ring: 5, highway: 4, road: 3, access: 2, street: 2, lane: 1 };
/** Extra patch radius for rounded curb corners at junctions (m). */
const FILLET = 0.6;
/** Shoulder (m) beyond the carriageway of a road without sidewalks, counted in junction radii. */
const SHOULDER = 0.6;
/** Tightest turn a connector may make (m, lane centre). Cars are 4 m long. */
export const RHO_MIN = 4;
/** A U-turn's lane centre runs this far inside the turning circle's carriageway edge (m). */
export const U_INSET = 1.5;
/** Radius of a U-turn's swing-out and swing-in fillets (m). */
const U_FILLET = 3.8;
/** Largest patch radius the search may reach (m). */
const R_MAX = 11;

/** A chart centred on unit direction `d` at radius r (+x east, +z south), like createChart. */
export function chartAt(d: Vec3, r: number): Chart {
  const e = v3();
  const n = v3();
  tangentFrame(d, e, n);
  return { origin: v3(d.x, d.y, d.z), east: e, south: v3(-n.x, -n.y, -n.z), radius: r };
}

/** Right of a travel tangent in a node chart (+x east, +z south: seen from above, clockwise). */
const rightX = (tz: number) => -tz;
const rightZ = (tx: number) => tx;

interface P2 {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

/**
 * The tightest radius (m) of the fillet between a lane end (a, travelling ta) and a lane start (b,
 * travelling tb): straight → Infinity; an arc of min(u, v) / tan(φ / 2) where u, v are the distances
 * to the tangent lines' intersection; 0 when no forward fillet exists (the intersection is behind).
 */
function filletRadius(a: P2, b: P2): number {
  const cr = a.tx * b.tz - a.tz * b.tx;
  const dt = a.tx * b.tx + a.tz * b.tz;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // (nearly parallel: within ~2°, the tangent lines meet far away or behind; treat it as an S)
  if (Math.abs(cr) < 0.035 && dt > 0) {
    // parallel: an S of two arcs over the lateral offset
    const lat = Math.abs(dx * -a.tz + dz * a.tx);
    const L = dx * a.tx + dz * a.tz;
    if (L <= 0) return 0;
    return lat < 1e-3 ? Infinity : (L * L + lat * lat) / (4 * lat);
  }
  const u = (dx * b.tz - dz * b.tx) / cr;
  const v = (a.tx * dz - a.tz * dx) / cr;
  if (u < -1e-6 || v < -1e-6) return 0;
  const phi = Math.atan2(Math.abs(cr), dt);
  return Math.min(u, v) / Math.tan(phi / 2);
}

/** Samples (x, z interleaved, ≤ 0.5 m) of the fillet from a to b (see filletRadius). */
function filletPoints(a: P2, b: P2): number[] {
  const cr = a.tx * b.tz - a.tz * b.tx;
  const dt = a.tx * b.tx + a.tz * b.tz;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.abs(cr) < 0.035 && dt > 0) return hermitePoints(a.x, a.z, a.tx, a.tz, b.x, b.z, b.tx, b.tz, 0.5, 0.5);
  const u = (dx * b.tz - dz * b.tx) / cr;
  const v = (a.tx * dz - a.tz * dx) / cr;
  if (u < -1e-6 || v < -1e-6) return hermitePoints(a.x, a.z, a.tx, a.tz, b.x, b.z, b.tx, b.tz, 0.5, 0.5);
  const phi = Math.atan2(Math.abs(cr), dt);
  const t = Math.min(u, v);
  const rho = t / Math.tan(phi / 2);
  const out: number[] = [a.x, a.z];
  // straight to the arc start A
  const ax = a.x + a.tx * (u - t);
  const az = a.z + a.tz * (u - t);
  line(out, ax, az);
  // the arc: centre on the turn's inside
  const side = cr > 0 ? 1 : -1; // > 0: a right turn (clockwise from above)
  const cx = ax + side * rightX(a.tz) * rho;
  const cz = az + side * rightZ(a.tx) * rho;
  const a0 = Math.atan2(az - cz, ax - cx);
  // Plan angle atan2(z, x) increases clockwise seen from above (+z south): a right (clockwise)
  // turn sweeps it upward round its centre, a left turn downward.
  const sw = side > 0 ? phi : -phi;
  const n = Math.max(2, Math.ceil((rho * phi) / 0.5));
  for (let k = 1; k <= n; k++) {
    const q = a0 + (sw * k) / n;
    out.push(cx + Math.cos(q) * rho, cz + Math.sin(q) * rho);
  }
  // straight to b
  line(out, b.x, b.z);
  return out;
}

/** Append a straight run (≤ 0.5 m steps) from the last point to (x, z). */
function line(out: number[], x: number, z: number) {
  const lx = out[out.length - 2];
  const lz = out[out.length - 1];
  const L = Math.hypot(x - lx, z - lz);
  if (L < 1e-6) return;
  const n = Math.max(1, Math.ceil(L / 0.5));
  for (let k = 1; k <= n; k++) out.push(lx + ((x - lx) * k) / n, lz + ((z - lz) * k) / n);
}

/**
 * Where a U-turn's swing-out fillet leaves a straight lane running at (p, t) toward the turning
 * circle (centre at the chart origin, lane-centre radius rc): the distance x along t from p, the
 * fillet centre, or null when the lane end is already inside the swing.
 */
function uSwing(p: P2, rc: number, rho: number): { x: number; cx: number; cz: number } | null {
  // fillet centre C = p + right(t)·ρ + t·x, externally tangent to the circle: |C| = rc + ρ
  const qx = p.x + rightX(p.tz) * rho;
  const qz = p.z + rightZ(p.tx) * rho;
  const qt = qx * p.tx + qz * p.tz;
  const disc = qt * qt - (qx * qx + qz * qz - (rc + rho) * (rc + rho));
  if (disc < 0) return null;
  const x = -qt - Math.sqrt(disc);
  if (x < -1e-6) return null;
  return { x: Math.max(0, x), cx: qx + p.tx * x, cz: qz + p.tz * x };
}

/**
 * U-turn round a dead end's turning circle (origin, lane-centre radius rc), keeping the island on
 * the left: swing out (right fillet), round the circle, swing back in (right fillet) to b.
 */
function uturnPoints(a: P2, b: P2, rc: number): number[] | null {
  const s1 = uSwing(a, rc, U_FILLET);
  // the way back is the same construction run backwards from b (reverse travel, mirrored side)
  const rb: P2 = { x: b.x, z: b.z, tx: -b.tx, tz: -b.tz };
  const s2 = uSwingLeft(rb, rc, U_FILLET);
  if (!s1 || !s2) return null;
  const out: number[] = [a.x, a.z];
  const sx = a.x + a.tx * s1.x;
  const sz = a.z + a.tz * s1.x;
  line(out, sx, sz);
  // fillet 1: centre (cx, cz), right turn from (sx, sz) to the tangent point T1 on the circle
  const d1 = Math.hypot(s1.cx, s1.cz);
  const t1x = (s1.cx / d1) * rc;
  const t1z = (s1.cz / d1) * rc;
  arcTo(out, s1.cx, s1.cz, U_FILLET, Math.atan2(sz - s1.cz, sx - s1.cx), Math.atan2(t1z - s1.cz, t1x - s1.cx), 1);
  // round the circle with the island on the left (plan angle decreasing), to T2
  const d2 = Math.hypot(s2.cx, s2.cz);
  const t2x = (s2.cx / d2) * rc;
  const t2z = (s2.cz / d2) * rc;
  arcTo(out, 0, 0, rc, Math.atan2(t1z, t1x), Math.atan2(t2z, t2x), -1);
  // fillet 2: right turn from T2 to where the lane begins, then straight to b
  const ex = b.x - b.tx * s2.x;
  const ez = b.z - b.tz * s2.x;
  arcTo(out, s2.cx, s2.cz, U_FILLET, Math.atan2(t2z - s2.cz, t2x - s2.cx), Math.atan2(ez - s2.cz, ex - s2.cx), 1);
  line(out, b.x, b.z);
  return out;
}

/** uSwing for a lane run backwards (its fillet lies on the travel's LEFT). */
function uSwingLeft(p: P2, rc: number, rho: number): { x: number; cx: number; cz: number } | null {
  const qx = p.x - rightX(p.tz) * rho;
  const qz = p.z - rightZ(p.tx) * rho;
  const qt = qx * p.tx + qz * p.tz;
  const disc = qt * qt - (qx * qx + qz * qz - (rc + rho) * (rc + rho));
  if (disc < 0) return null;
  const x = -qt - Math.sqrt(disc);
  if (x < -1e-6) return null;
  return { x: Math.max(0, x), cx: qx + p.tx * x, cz: qz + p.tz * x };
}

/** Append an arc round (cx, cz) radius r from angle a0 to a1, sweeping in direction dir (+1: plan angle increasing). */
function arcTo(out: number[], cx: number, cz: number, r: number, a0: number, a1: number, dir: 1 | -1) {
  let sw = a1 - a0;
  if (dir > 0) while (sw < 0) sw += Math.PI * 2;
  else while (sw > 0) sw -= Math.PI * 2;
  const n = Math.max(1, Math.ceil((Math.abs(sw) * r) / 0.5));
  for (let k = 1; k <= n; k++) {
    const q = a0 + (sw * k) / n;
    out.push(cx + Math.cos(q) * r, cz + Math.sin(q) * r);
  }
}

/** Arc length on `p` where it leaves (or, from the end, enters) a ball of `r` m round node n. */
function trimAt(p: WPath, n: { dir: Vec3; h: number }, r: number, fromEnd: boolean): number {
  const cx = n.dir.x * (R + n.h), cy = n.dir.y * (R + n.h), cz = n.dir.z * (R + n.h);
  const N = p.h.length;
  const dist = (i: number) => {
    const rr = R + p.h[i];
    return Math.hypot(p.dir[i * 3] * rr - cx, p.dir[i * 3 + 1] * rr - cy, p.dir[i * 3 + 2] * rr - cz);
  };
  if (!fromEnd) {
    for (let i = 1; i < N; i++) {
      const d1 = dist(i);
      if (d1 >= r) {
        const d0 = dist(i - 1);
        const f = d1 > d0 ? (r - d0) / (d1 - d0) : 1;
        return p.s[i - 1] + (p.s[i] - p.s[i - 1]) * Math.max(0, Math.min(1, f));
      }
    }
    return p.length;
  }
  for (let i = N - 2; i >= 0; i--) {
    const d0 = dist(i);
    if (d0 >= r) {
      const d1 = dist(i + 1);
      const f = d0 > d1 ? (d0 - r) / (d0 - d1) : 0;
      return p.s[i] + (p.s[i + 1] - p.s[i]) * Math.max(0, Math.min(1, f));
    }
  }
  return 0;
}

export function buildNetwork(nodeSpecs: NodeSpec[], edgeSpecs: EdgeSpec[]): Network {
  const nodes: RNode[] = nodeSpecs.map((n, id) => ({
    id,
    dir: v3(n.dir.x, n.dir.y, n.dir.z),
    h: n.h,
    edges: [],
    radius: 0,
    kind: 'end',
    control: n.control ?? 'none',
    place: n.place,
    settlement: n.settlement ?? -1,
    gate: n.gate ?? -1,
    turnR: 0,
  }));
  edgeSpecs.forEach((e, id) => {
    nodes[e.a].edges.push(id);
    nodes[e.b].edges.push(id);
  });
  const charts = nodes.map((n) => chartAt(n.dir, R + n.h));
  const tmp = v3();

  /**
   * The arm of edge `id` at node `n`, a chord distance r out: the centreline point (node chart) and
   * its departure tangent (away from the node).
   */
  const armAt = (id: number, n: number, r: number): P2 => {
    const p = edgeSpecs[id].raw;
    const s = trimAt(p, nodes[n], r, false);
    const c = charts[n];
    const pt = sampleChart(p, s, c);
    const p1 = sampleChart(p, Math.min(p.length, s + Math.min(0.6, p.length * 0.1)), c);
    let tx = p1.x - pt.x;
    let tz = p1.z - pt.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    return { x: pt.x, z: pt.z, tx, tz };
  };
  const sampleChart = (p: WPath, s: number, c: Chart) => {
    // linear search is fine: boot-time, few calls per node
    const S = p.s;
    let i = 0;
    while (i < S.length - 2 && S[i + 1] < s) i++;
    const j = Math.min(S.length - 1, i + 1);
    const f = S[j] > S[i] ? Math.max(0, Math.min(1, (s - S[i]) / (S[j] - S[i]))) : 0;
    tmp.x = p.dir[i * 3] + (p.dir[j * 3] - p.dir[i * 3]) * f;
    tmp.y = p.dir[i * 3 + 1] + (p.dir[j * 3 + 1] - p.dir[i * 3 + 1]) * f;
    tmp.z = p.dir[i * 3 + 2] + (p.dir[j * 3 + 2] - p.dir[i * 3 + 2]) * f;
    return dirToChart(c, tmp, { x: 0, z: 0 });
  };

  const halfOf = (e: EdgeSpec) => e.width / 2 + (e.sidewalk > 0 ? e.sidewalk : SHOULDER);
  const laneOff = (e: EdgeSpec) => (e.oneWay ? 0 : e.width / 4);

  /**
   * Lane ends at node n for patch radius r: every arriving lane's end and every leaving lane's start
   * (node chart), with the edge they belong to.
   */
  const laneEnds = (n: RNode, r: number) => {
    const inn: Array<P2 & { edge: number }> = [];
    const out: Array<P2 & { edge: number }> = [];
    for (const id of n.edges) {
      const e = edgeSpecs[id];
      const loopEdge = e.a === e.b;
      for (const fromA of loopEdge ? [true, false] : [e.a === n.id]) {
        const arm = fromA ? armAt(id, n.id, r) : armAtEnd(id, n.id, r);
        const o = laneOff(e);
        // arriving: travel −t, on its right; leaving: travel t, on its right
        const arrives = e.oneWay ? !fromA : true;
        const leaves = e.oneWay ? fromA : true;
        if (arrives) inn.push({ x: arm.x + rightX(-arm.tz) * o, z: arm.z + rightZ(-arm.tx) * o, tx: -arm.tx, tz: -arm.tz, edge: id });
        if (leaves) out.push({ x: arm.x + rightX(arm.tz) * o, z: arm.z + rightZ(arm.tx) * o, tx: arm.tx, tz: arm.tz, edge: id });
      }
    }
    return { inn, out };
  };
  const armAtEnd = (id: number, n: number, r: number): P2 => {
    const e = edgeSpecs[id];
    const p = e.raw;
    const s = trimAt(p, nodes[n], r, true);
    const ds = Math.min(0.6, p.length * 0.1);
    const c = charts[n];
    const pt = sampleChart(p, s, c);
    const p0 = sampleChart(p, Math.max(0, s - ds), c);
    let tx = p0.x - pt.x;
    let tz = p0.z - pt.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    return { x: pt.x, z: pt.z, tx, tz };
  };

  /** Classify a turn from travel tangent a to b. */
  const classify = (a: P2, b: P2, sameEdge: boolean): RTurn => {
    if (sameEdge) return 'uturn';
    const cr = a.tx * b.tz - a.tz * b.tx;
    const dt = a.tx * b.tx + a.tz * b.tz;
    if (dt > 0.7) return 'straight';
    if (dt < -0.8) return 'uturn';
    return cr > 0 ? 'right' : 'left';
  };

  // ── Patch radii ──
  for (const n of nodes) {
    n.kind = n.edges.length >= 3 ? 'junction' : n.edges.length === 2 ? 'bend' : 'end';
    if (n.edges.length >= 3 && n.control === 'none') n.control = 'yield';
    // departure order (plan angle, clockwise from above), taken a few metres out
    const dep = new Map<number, number>();
    for (const id of n.edges) {
      const e = edgeSpecs[id];
      const a = e.a === n.id ? armAt(id, n.id, Math.min(4, e.raw.length * 0.3)) : armAtEnd(id, n.id, Math.min(4, e.raw.length * 0.3));
      dep.set(id, Math.atan2(a.z, a.x));
    }
    n.edges.sort((p, r) => dep.get(p)! - dep.get(r)!);
    if (n.kind === 'end') {
      const e = edgeSpecs[n.edges[0]];
      const half = e.width / 2;
      n.turnR = turningRadius(half);
      const base = Math.sqrt(n.turnR * n.turnR - half * half);
      // the U-turn's swing-out starts where the lane ends: the lane must reach that far
      const rc = n.turnR - U_INSET;
      const o = laneOff(e);
      const need = Math.sqrt(Math.max(0, (rc + U_FILLET) ** 2 - (o + U_FILLET) ** 2)) + 0.15;
      // (a street that curves into its end needs a little more: search until both swings fit)
      let r = Math.max(base, need);
      for (; r < R_MAX; r += 0.25) {
        const { inn, out } = laneEnds(n, r);
        if (!inn.length || !out.length) break;
        const b = out[0];
        if (uSwing(inn[0], rc, U_FILLET) && uSwingLeft({ x: b.x, z: b.z, tx: -b.tx, tz: -b.tz }, rc, U_FILLET)) break;
      }
      n.radius = Math.min(r, R_MAX);
      continue;
    }
    // the curb geometry: adjacent arms' sidewalks must not overlap at the trim line
    let r0 = n.kind === 'bend' ? 0.6 : 0;
    if (n.kind === 'junction') {
      const angs = n.edges.map((id) => dep.get(id)!);
      for (let i = 0; i < angs.length; i++) {
        let gap = angs[(i + 1) % angs.length] - angs[i];
        if (gap <= 0) gap += Math.PI * 2;
        const h = Math.max(halfOf(edgeSpecs[n.edges[i]]), halfOf(edgeSpecs[n.edges[(i + 1) % angs.length]]));
        r0 = Math.max(r0, h + FILLET, h / Math.tan(Math.max(0.35, gap) / 2) + FILLET);
      }
      // a roundabout's ring nodes: the curb corner between the arm and the ring is all it needs
      if (n.control === 'roundabout') r0 = Math.min(r0, 4.2);
    }
    // the search: the smallest radius at which every connector here is a fillet ≥ RHO_MIN
    let r = r0;
    const dbg = typeof process !== 'undefined' && process.env.LB_NET_DEBUG === String(n.id);
    for (; r < R_MAX; r += 0.25) {
      const { inn, out } = laneEnds(n, r);
      if (dbg) for (const a of inn) for (const b of out) if (a.edge !== b.edge) console.log('[net]', n.id, 'r', r.toFixed(2), 'e', a.edge, '->', b.edge, classify(a, b, false), filletRadius(a, b).toFixed(2), JSON.stringify([a, b].map((q) => [q.x.toFixed(2), q.z.toFixed(2), q.tx.toFixed(2), q.tz.toFixed(2)])));
      let ok = true;
      for (const a of inn) {
        for (const b of out) {
          if (a.edge === b.edge) continue;
          // (two different arms leaving nearly together read as a U-turn: grow the patch until they part)
          if (classify(a, b, false) === 'uturn' && r < R_MAX - 0.5) {
            ok = false;
            break;
          }
          if (filletRadius(a, b) < RHO_MIN) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
      if (ok) break;
    }
    n.radius = Math.min(r, R_MAX);
  }

  // ── Edges: trim the raw centreline to the node patches (chord distance from the node's centre) ──
  const edges: REdge[] = [];
  const bridges: Bridge[] = [];
  edgeSpecs.forEach((e, id) => {
    const s0 = trimAt(e.raw, nodes[e.a], nodes[e.a].radius, false);
    const s1 = trimAt(e.raw, nodes[e.b], nodes[e.b].radius, true);
    const centre = wtrim(e.raw, s0, Math.max(s0 + 0.5, s1));
    const edge: REdge = {
      id,
      a: e.a,
      b: e.b,
      kind: e.kind,
      centre,
      width: e.width,
      sidewalk: e.sidewalk,
      oneWay: !!e.oneWay,
      lanesAB: [],
      lanesBA: [],
      speed: e.speed,
      settlement: e.settlement ?? -1,
      bridges: [],
      name: e.name,
    };
    (e.bridges ?? []).forEach(([b0, b1], k) => {
      const bid = bridges.length;
      bridges.push({ id: bid, edge: id, s0: Math.max(0, b0 - s0), s1: Math.min(centre.length, b1 - s0), deckMin: e.bridgeInfo?.[k]?.deckMin ?? 0, clearance: e.bridgeInfo?.[k]?.clearance ?? 0 });
      edge.bridges.push(bid);
    });
    edges.push(edge);
  });

  let built: { lanes: RLane[]; connectors: RConnector[] } | null = null;
  const laneIds: Array<{ ab: number[]; ba: number[] }> = edges.map(() => ({ ab: [], ba: [] }));
  for (const e of edges) {
    Object.defineProperty(e, 'lanesAB', { get: () => (transit(), laneIds[e.id].ab), enumerable: false });
    Object.defineProperty(e, 'lanesBA', { get: () => (transit(), laneIds[e.id].ba), enumerable: false });
  }
  const transit = () => (built ??= buildTransit());
  return { nodes, edges, bridges, transit };

  function buildTransit() {
    // Lanes.
    const lanes: RLane[] = [];
    for (const e of edges) {
      if (e.oneWay) {
        const p = e.centre;
        const l: RLane = { id: lanes.length, edge: e.id, dir: 1, from: e.a, to: e.b, offset: 0, path: p, stopS: p.length, next: [], prev: [], speed: e.speed };
        lanes.push(l);
        laneIds[e.id].ab.push(l.id);
        continue;
      }
      const off = e.width / 4;
      const ab = woffset(e.centre, off);
      const la: RLane = { id: lanes.length, edge: e.id, dir: 1, from: e.a, to: e.b, offset: off, path: ab, stopS: ab.length, next: [], prev: [], speed: e.speed };
      lanes.push(la);
      laneIds[e.id].ab.push(la.id);
      const ba = wreverse(woffset(e.centre, -off));
      const lb: RLane = { id: lanes.length, edge: e.id, dir: -1, from: e.b, to: e.a, offset: -off, path: ba, stopS: ba.length, next: [], prev: [], speed: e.speed };
      lanes.push(lb);
      laneIds[e.id].ba.push(lb.id);
    }

    // Connectors.
    const connectors: RConnector[] = [];
    const flat = new WeakMap<RConnector, Float64Array>(); // 2D samples in the node chart (conflicts)
    const end2 = (lane: RLane, atEnd: boolean, chart: Chart) => {
      const p = lane.path;
      const n = p.h.length;
      const i = atEnd ? n - 1 : 0;
      const a = dirToChart(chart, v3(p.dir[i * 3], p.dir[i * 3 + 1], p.dir[i * 3 + 2]), { x: 0, z: 0 });
      // the tangent over the last / first ~0.6 m (one sample can be a few cm long after a trim)
      let j = i;
      for (let k = 1; k < n; k++) {
        j = atEnd ? n - 1 - k : k;
        if (Math.abs(p.s[j] - p.s[i]) >= 0.5) break;
      }
      const b = dirToChart(chart, v3(p.dir[j * 3], p.dir[j * 3 + 1], p.dir[j * 3 + 2]), { x: 0, z: 0 });
      // travel tangent: arriving = b → a at the end; leaving = a → b at the start
      let tx = atEnd ? a.x - b.x : b.x - a.x;
      let tz = atEnd ? a.z - b.z : b.z - a.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      return { x: a.x, z: a.z, tx, tz, h: p.h[i], d: v3(p.dir[i * 3], p.dir[i * 3 + 1], p.dir[i * 3 + 2]) };
    };
    for (const n of nodes) {
      const chart = charts[n.id];
      const arriving = lanes.filter((l) => l.to === n.id);
      const leaving = lanes.filter((l) => l.from === n.id);
      const onRing = n.control === 'roundabout';
      for (const a of arriving) {
        for (const b of leaving) {
          const sameEdge = a.edge === b.edge;
          if (sameEdge && n.kind !== 'end') continue;
          const pa = end2(a, true, chart);
          const pb = end2(b, false, chart);
          const turn = classify(pa, pb, sameEdge);
          if (turn === 'uturn' && n.kind !== 'end') continue;
          const pts = (turn === 'uturn' ? uturnPoints(pa, pb, n.turnR - U_INSET) : null) ?? (turn === 'uturn' ? hermitePoints(pa.x, pa.z, pa.tx, pa.tz, pb.x, pb.z, pb.tx, pb.tz, 0.5, 0.5) : filletPoints(pa, pb));
          pts[0] = pa.x;
          pts[1] = pa.z;
          pts[pts.length - 2] = pb.x;
          pts[pts.length - 1] = pb.z;
          // Lift to the sphere; heights linear in 2D arc length; exact end samples.
          const m = pts.length >> 1;
          const L: number[] = [0];
          for (let i = 1; i < m; i++) L.push(L[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
          const D: number[] = [];
          const H: number[] = [];
          const tot = L[m - 1] || 1;
          for (let i = 0; i < m; i++) {
            if (i === 0) D.push(pa.d.x, pa.d.y, pa.d.z);
            else if (i === m - 1) D.push(pb.d.x, pb.d.y, pb.d.z);
            else {
              chartToDir(chart, pts[i * 2], pts[i * 2 + 1], tmp);
              D.push(tmp.x, tmp.y, tmp.z);
            }
            H.push(pa.h + (pb.h - pa.h) * (L[i] / tot));
          }
          const ea = edges[a.edge];
          const eb = edges[b.edge];
          // circulating = the ring's own edges, or any one-way edge through a roundabout node (a
          // promenade loop that IS the roundabout's ring)
          const ringIn = onRing && (ea.kind === 'ring' || ea.oneWay);
          const ringOut = onRing && (eb.kind === 'ring' || eb.oneWay);
          const major = RANK[ea.kind] + RANK[eb.kind];
          let priority = major * 4 + (turn === 'straight' ? 3 : turn === 'right' ? 2 : turn === 'left' ? 1 : 0);
          if (onRing) priority = ringIn ? 100 + (ringOut ? 3 : 2) : 10; // circulating traffic has way
          const c: RConnector = { id: connectors.length, node: n.id, fromLane: a.id, toLane: b.id, turn, path: wpath(D, H), conflicts: [], priority };
          flat.set(c, Float64Array.from(pts));
          connectors.push(c);
          a.next.push(c.id);
          b.prev.push(c.id);
        }
      }
    }

    // Conflicts, lazily per node (only traffic reads them): crossing, merging into one lane, or
    // passing closer than VEHICLE_CLEARANCE; diverging from one lane is car-following's job.
    const byNode = new Map<number, RConnector[]>();
    for (const c of connectors) {
      let l = byNode.get(c.node);
      if (!l) byNode.set(c.node, (l = []));
      l.push(c);
    }
    const conflicts: number[][] = [];
    const solve = (node: number) => {
      const list = byNode.get(node)!;
      const out = list.map(() => [] as number[]);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i];
          const r = list[j];
          if (p.fromLane === r.fromLane) continue;
          const a = flat.get(p)!;
          const b = flat.get(r)!;
          if (p.toLane === r.toLane || cross(a, b) || minDist(a, b) < VEHICLE_CLEARANCE + 0.2) {
            out[i].push(r.id);
            out[j].push(p.id);
          }
        }
      }
      list.forEach((c, i) => (conflicts[c.id] = Object.freeze(out[i].sort((x, y) => x - y)) as number[]));
    };
    for (const c of connectors) {
      Object.defineProperty(c, 'conflicts', {
        get() {
          if (!conflicts[c.id]) solve(c.node);
          return conflicts[c.id];
        },
        enumerable: false,
      });
    }

    return { lanes, connectors };
  }
}

function cross(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i + 3 < a.length; i += 2) {
    for (let j = 0; j + 3 < b.length; j += 2) {
      const ax = a[i], az = a[i + 1], bx = a[i + 2], bz = a[i + 3];
      const cx = b[j], cz = b[j + 1], dx = b[j + 2], dz = b[j + 3];
      const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
      const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
      const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

function minDist(a: Float64Array, b: Float64Array): number {
  let m = Infinity;
  for (let i = 0; i < a.length; i += 2) {
    for (let j = 0; j + 3 < b.length; j += 2) {
      const cx = b[j], cz = b[j + 1], ex = b[j + 2] - cx, ez = b[j + 3] - cz;
      const ll = ex * ex + ez * ez;
      let t = ll > 0 ? ((a[i] - cx) * ex + (a[i + 1] - cz) * ez) / ll : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(cx + ex * t - a[i], cz + ez * t - a[i + 1]);
      if (d < m) m = d;
    }
  }
  return m;
}

/**
 * The tightest radius (m) of a polyline in a world path: the circumradius of every three samples
 * spaced ≥ `span` m apart (specs: connectors, lanes, streets). Infinity for a straight path.
 */
export function minRadius(p: WPath, span = 1): number {
  const n = p.h.length;
  let best = Infinity;
  const P = (i: number, o: Vec3) => {
    const r = R + p.h[i];
    o.x = p.dir[i * 3] * r;
    o.y = p.dir[i * 3 + 1] * r;
    o.z = p.dir[i * 3 + 2] * r;
    return o;
  };
  const a = v3();
  const b = v3();
  const c = v3();
  let j = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && p.s[j] - p.s[i] < span) j++;
    if (j >= n) break;
    k = Math.max(k, j);
    while (k < n && p.s[k] - p.s[j] < span) k++;
    if (k >= n) break;
    P(i, a);
    P(j, b);
    P(k, c);
    // circumradius = |ab||bc||ca| / (2 |ab × ac|) on the horizontal (ignore height: grades are tiny)
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const bcx = c.x - b.x, bcy = c.y - b.y, bcz = c.z - b.z;
    const crx = aby * acz - abz * acy, cry = abz * acx - abx * acz, crz = abx * acy - aby * acx;
    const area2 = Math.hypot(crx, cry, crz);
    if (area2 < 1e-9) continue;
    const rr = (Math.hypot(abx, aby, abz) * Math.hypot(bcx, bcy, bcz) * Math.hypot(acx, acy, acz)) / (2 * area2);
    if (rr < best) best = rr;
  }
  return best;
}

/** Tarjan SCC over lanes (edges = connectors): the strongly connected sets of lane ids. */
export function laneSCCs(lanes: RLane[], connectors: RConnector[]): number[][] {
  const n = lanes.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const on = new Uint8Array(n);
  const stack: number[] = [];
  const out: number[][] = [];
  let idx = 0;
  // Iterative Tarjan.
  for (let s = 0; s < n; s++) {
    if (index[s] >= 0) continue;
    const work: Array<[number, number]> = [[s, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      if (top[1] === 0) {
        index[v] = low[v] = idx++;
        stack.push(v);
        on[v] = 1;
      }
      const nx = lanes[v].next;
      if (top[1] < nx.length) {
        const w = connectors[nx[top[1]]].toLane;
        top[1]++;
        if (index[w] < 0) work.push([w, 0]);
        else if (on[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          on[w] = 0;
          comp.push(w);
        } while (w !== v);
        out.push(comp);
      }
    }
  }
  return out;
}
