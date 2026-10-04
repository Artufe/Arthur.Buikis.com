// Road-graph builder: turns a sketch (node positions + edge centrelines) into the full contract
// data: trimmed centrelines, lanes, turn connectors with conflicts, intersection outlines with
// rounded corners, and the pedestrian graph (sidewalks, corners, crossings). Pure, deterministic.
//
// A2 can feed it a richer sketch (or replace it); the stub plan (stub.ts) uses it as-is.

import { endTangent, hermitePoints, nearestOn, offset, polyline, reversed, sampleAt, startTangent, trim } from './path';
import { CROSSING_SETBACK, VEHICLE_CLEARANCE } from './types';
import type {
  Connector,
  Intersection,
  Lane,
  Polyline,
  RoadEdge,
  RoadKind,
  RoadNode,
  Turn,
  WalkEdge,
  WalkKind,
  WalkNode,
} from './types';

export interface SketchNode {
  x: number;
  z: number;
  control?: RoadNode['control'];
}

export interface SketchEdge {
  a: number;
  b: number;
  /** Raw centreline from node a's centre to node b's centre (x, z interleaved, ≥ 2 points). */
  points: number[];
  kind: RoadKind;
  /** Carriageway width (m). Default 6.5. */
  width?: number;
  /** Lanes per direction. Default 1. */
  lanesPerDir?: number;
  /** Sidewalk width per side (m). Default 1.8. */
  sidewalk?: number;
  /** m/s. Default 9. */
  speed?: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  lanes: Lane[];
  connectors: Connector[];
  intersections: Intersection[];
  walkNodes: WalkNode[];
  walkEdges: WalkEdge[];
}

const KIND_RANK: Record<RoadKind, number> = { ring: 4, avenue: 3, street: 2, lane: 1, rural: 2 };
/** Zebra strip extent along the road (m). */
const CROSSING_WIDTH = 2.4;
/** Extra patch radius (m) for the rounded curb corners at junctions (smaller = tighter corners, less apron). */
const FILLET = 0.6;

/**
 * Radius (m) of a dead end's turning circle (its carriageway), centred on the node. The arm's
 * centreline is trimmed where its curbs meet that circle: RoadNode.radius = √(ρ² − half²).
 */
export function turningRadius(half: number): number {
  return Math.max(5.4, half + 2.6);
}

export function buildRoadGraph(sketchNodes: SketchNode[], sketchEdges: SketchEdge[]): RoadGraph {
  const nodes: RoadNode[] = sketchNodes.map((n, id) => ({
    id,
    x: n.x,
    z: n.z,
    edges: [],
    radius: 0,
    kind: 'end',
    control: n.control ?? 'none',
  }));
  const raw = sketchEdges.map((e) => polyline(e.points));
  sketchEdges.forEach((e, id) => {
    nodes[e.a].edges.push(id);
    nodes[e.b].edges.push(id);
  });

  // Departure direction of edge `id` from node `n` (taken a few metres out, so curves read right).
  const depCache = new Map<number, { x: number; z: number }>();
  const departure = (id: number, n: number) => {
    const key = id * 4096 + n;
    let d = depCache.get(key);
    if (!d) depCache.set(key, (d = departureRaw(id, n)));
    return d;
  };
  const departureRaw = (id: number, n: number) => {
    const pl = raw[id];
    const fromA = sketchEdges[id].a === n;
    const s = Math.min(6, pl.length * 0.3);
    const p = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
    sampleAt(pl, fromA ? s : pl.length - s, p);
    const dx = p.x - nodes[n].x;
    const dz = p.z - nodes[n].z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  };

  // Node radius: enough for the widest arm plus its sidewalks and a corner radius, and enough that
  // adjacent arms' curbs do not overlap at the trim line.
  for (const n of nodes) {
    n.kind = n.edges.length >= 3 ? 'junction' : n.edges.length === 2 ? 'bend' : 'end';
    n.edges.sort((p, q) => {
      const dp = departure(p, n.id);
      const dq = departure(q, n.id);
      return Math.atan2(dp.z, dp.x) - Math.atan2(dq.z, dq.x);
    });
    let halfMax = 0;
    for (const id of n.edges) halfMax = Math.max(halfMax, (sketchEdges[id].width ?? 6.5) / 2 + (sketchEdges[id].sidewalk ?? 1.8));
    let minGap = Math.PI;
    if (n.edges.length > 1) {
      for (let i = 0; i < n.edges.length; i++) {
        const d0 = departure(n.edges[i], n.id);
        const d1 = departure(n.edges[(i + 1) % n.edges.length], n.id);
        let a = Math.atan2(d1.z, d1.x) - Math.atan2(d0.z, d0.x);
        if (a <= 0) a += Math.PI * 2;
        minGap = Math.min(minGap, a);
      }
    }
    if (n.kind === 'bend') n.radius = 0.6; // bends: nearly continuous, tiny patch
    else if (n.kind === 'end') {
      const half = (sketchEdges[n.edges[0]].width ?? 6.5) / 2;
      const rho = turningRadius(half);
      n.radius = Math.sqrt(rho * rho - half * half);
    } else n.radius = Math.max(halfMax + FILLET, halfMax / Math.tan(Math.max(0.35, minGap) / 2) + FILLET);
    if (n.edges.length >= 3 && n.control === 'none') n.control = 'yield';
  }

  // Edges: trim centrelines to the node patches.
  const edges: RoadEdge[] = sketchEdges.map((e, id) => {
    const pl = raw[id];
    const ra = nodes[e.a].radius;
    const rb = nodes[e.b].radius;
    const centre = trimByRadius(pl, nodes[e.a], ra, nodes[e.b], rb);
    return {
      id,
      a: e.a,
      b: e.b,
      kind: e.kind,
      centre,
      width: e.width ?? 6.5,
      sidewalk: e.sidewalk ?? 1.8,
      lanesAB: [],
      lanesBA: [],
      speed: e.speed ?? 9,
    };
  });

  // Lanes.
  const lanes: Lane[] = [];
  for (const e of edges) {
    const per = sketchEdges[e.id].lanesPerDir ?? 1;
    const lw = e.width / (2 * per);
    for (let k = 0; k < per; k++) {
      const off = lw * (k + 0.5);
      const abPath = offset(e.centre, off);
      const ab: Lane = { id: lanes.length, edge: e.id, dir: 1, from: e.a, to: e.b, offset: off, path: abPath, next: [], prev: [], stopS: abPath.length, crossingAtEnd: -1, crossingAtStart: -1 };
      lanes.push(ab);
      e.lanesAB.push(ab.id);
      const baPath = reversed(offset(e.centre, -off));
      const ba: Lane = { id: lanes.length, edge: e.id, dir: -1, from: e.b, to: e.a, offset: -off, path: baPath, next: [], prev: [], stopS: baPath.length, crossingAtEnd: -1, crossingAtStart: -1 };
      lanes.push(ba);
      e.lanesBA.push(ba.id);
    }
  }

  // Connectors: every arriving lane to every departing lane on another arm (U-turn only at ends).
  // Multi-lane: inner lanes turn left / go straight, outer lanes turn right / go straight.
  const connectors: Connector[] = [];
  for (const n of nodes) {
    const arriving = lanes.filter((l) => l.to === n.id);
    const leaving = lanes.filter((l) => l.from === n.id);
    for (const a of arriving) {
      for (const b of leaving) {
        const sameEdge = a.edge === b.edge;
        if (sameEdge && n.kind !== 'end') continue;
        const ta = endTangent(a.path);
        const tb = startTangent(b.path);
        const turn = classifyTurn(ta, tb, sameEdge);
        const per = sketchEdges[a.edge].lanesPerDir ?? 1;
        const ia = laneIndex(edges[a.edge], a.id);
        const ib = laneIndex(edges[b.edge], b.id);
        if (per > 1 || (sketchEdges[b.edge].lanesPerDir ?? 1) > 1) {
          if (turn === 'left' && (ia !== 0 || ib !== 0)) continue;
          if (turn === 'right' && (ia !== per - 1 || ib !== (sketchEdges[b.edge].lanesPerDir ?? 1) - 1)) continue;
          if (turn === 'straight' && ia !== ib) continue;
        }
        const pa = a.path.pts;
        const pb = b.path.pts;
        const x0 = pa[pa.length - 2];
        const z0 = pa[pa.length - 1];
        const x1 = pb[0];
        const z1 = pb[1];
        const pts = turn === 'uturn' ? uturnPoints(x0, z0, ta, x1, z1, n, turningRadius(edges[a.edge].width / 2) - 1.6) : hermitePoints(x0, z0, ta.x, ta.z, x1, z1, tb.x, tb.z);
        // Pin exact endpoints (lane continuity is an invariant).
        pts[0] = x0;
        pts[1] = z0;
        pts[pts.length - 2] = x1;
        pts[pts.length - 1] = z1;
        const major = KIND_RANK[edges[a.edge].kind] + KIND_RANK[edges[b.edge].kind];
        const priority = major * 4 + (turn === 'straight' ? 3 : turn === 'right' ? 2 : turn === 'left' ? 1 : 0);
        const c: Connector = { id: connectors.length, node: n.id, fromLane: a.id, toLane: b.id, turn, path: polyline(pts), conflicts: [], priority };
        connectors.push(c);
        a.next.push(c.id);
        b.prev.push(c.id);
      }
    }
  }
  // Conflicts: connectors at the same node that cross, merge into the same lane, or pass closer than
  // VEHICLE_CLEARANCE (two buses side by side), so yielding alone guarantees no overlap. Only traffic
  // (stage 2) needs them, so they are computed per node on first read, off the first-frame path.
  const byNode = new Map<number, Connector[]>();
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
        const q = list[j];
        if (p.fromLane === q.fromLane) continue; // diverging from the same lane: car-following handles it
        // (Tested on every other sample, with a margin over the decimation error: conservative.)
        if (p.toLane === q.toLane || (boxGap(p.path, q.path) < VEHICLE_CLEARANCE + 0.2 && (pathsCross(p.path, q.path) || minPathDistance(p.path, q.path, VEHICLE_CLEARANCE + 0.2) < VEHICLE_CLEARANCE + 0.2))) {
          out[i].push(q.id);
          out[j].push(p.id);
        }
      }
    }
    list.forEach((c, i) => (conflicts[c.id] = Object.freeze(out[i].sort((a, b) => a - b)) as number[]));
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

  // Intersection outlines and the walk graph.
  const intersections: Intersection[] = [];
  const walkNodes: WalkNode[] = [];
  const walkEdges: WalkEdge[] = [];
  const addWalkNode = (x: number, z: number) => {
    const w: WalkNode = { id: walkNodes.length, x, z, edges: [] };
    walkNodes.push(w);
    return w.id;
  };
  const addWalkEdge = (a: number, b: number, kind: WalkKind, path: Polyline, width: number, road?: number, laneIds?: number[]) => {
    const e: WalkEdge = { id: walkEdges.length, a, b, kind, path, width };
    if (road !== undefined) {
      e.road = road;
      e.lanes = laneIds;
    }
    walkEdges.push(e);
    walkNodes[a].edges.push(e.id);
    walkNodes[b].edges.push(e.id);
    return e.id;
  };

  // Zebra crossings sit CROSSING_SETBACK out along each arm of a junction / dead end (never at
  // plain bends), so the strip stays clear of the intersection patch and every turn connector.
  // Crossing centre point and right-of-a→b vector per edge end, or null when the edge is too short.
  const crossAt = (e: RoadEdge, end: 'a' | 'b') => {
    if (nodes[end === 'a' ? e.a : e.b].kind === 'bend') return null;
    const L = e.centre.length;
    if (L < 2 * CROSSING_SETBACK + 3) return null;
    const p = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
    sampleAt(e.centre, end === 'a' ? CROSSING_SETBACK : L - CROSSING_SETBACK, p);
    return { x: p.x, z: p.z, rx: -p.tz, rz: p.tx };
  };

  // Sidewalks: side +1 = right of a→b, side −1 = left. Walk nodes at both patch ends (corners join
  // there) and at the crossing points (crossings join there); the sidewalk is split at the latter.
  const swEnds = new Map<string, number>(); // `${edge}:${side}:${a|b}` → walk node at the patch edge
  const swCross = new Map<string, number>(); // `${edge}:${side}:${a|b}` → walk node at the crossing
  const near = { dist: 0, s: 0 };
  const sp = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  for (const e of edges) {
    if (e.sidewalk <= 0) continue;
    const ca = crossAt(e, 'a');
    const cb = crossAt(e, 'b');
    for (const side of [1, -1] as const) {
      const off = side * (e.width / 2 + e.sidewalk / 2);
      const path = offset(e.centre, off);
      const L = path.length;
      const cuts: Array<{ s: number; key?: string }> = [{ s: 0, key: `${e.id}:${side}:a` }];
      if (ca) cuts.push({ s: (nearestOn(path, ca.x + ca.rx * off, ca.z + ca.rz * off, near), near.s), key: `x${e.id}:${side}:a` });
      if (cb) cuts.push({ s: (nearestOn(path, cb.x + cb.rx * off, cb.z + cb.rz * off, near), near.s), key: `x${e.id}:${side}:b` });
      cuts.push({ s: L, key: `${e.id}:${side}:b` });
      let prev = -1;
      let prevS = 0;
      for (const c of cuts) {
        sampleAt(path, c.s, sp);
        const id = addWalkNode(sp.x, sp.z);
        if (c.key!.startsWith('x')) swCross.set(c.key!.slice(1), id);
        else swEnds.set(c.key!, id);
        if (prev >= 0) addWalkEdge(prev, id, 'sidewalk', trim(path, prevS, c.s), e.sidewalk);
        prev = id;
        prevS = c.s;
      }
    }
  }

  for (const n of nodes) {
    const arms = n.edges.map((id) => {
      const e = edges[id];
      const atA = e.a === n.id;
      const pl = e.centre;
      const p = pl.pts;
      const px = atA ? p[0] : p[p.length - 2];
      const pz = atA ? p[1] : p[p.length - 1];
      const t = atA ? startTangent(pl) : endTangent(pl);
      const ux = atA ? t.x : -t.x; // outward from the node
      const uz = atA ? t.z : -t.z;
      const rx = -uz; // right of outward
      const rz = ux;
      const half = e.width / 2;
      // Sidewalk node ids: right-of-outward and left-of-outward.
      const sideR = atA ? 1 : -1;
      const end = atA ? 'a' : 'b';
      return {
        e,
        px,
        pz,
        ux,
        uz,
        rx,
        rz,
        half,
        walkR: swEnds.get(`${e.id}:${sideR}:${end}`),
        walkL: swEnds.get(`${e.id}:${-sideR}:${end}`),
      };
    });
    // Outline: for each arm L curb, R curb, then a fillet to the next arm's L curb.
    const out: number[] = [];
    if (arms.length === 1) {
      // Dead end: a turning circle of radius ρ round the node; the arm's curbs meet it at the trim line.
      const a = arms[0];
      const rho = turningRadius(a.half);
      const lx = a.px - a.rx * a.half;
      const lz = a.pz - a.rz * a.half;
      const rx = a.px + a.rx * a.half;
      const rz = a.pz + a.rz * a.half;
      out.push(lx, lz, rx, rz);
      // The long way round from the right curb to the left one.
      let t0 = Math.atan2(rz - n.z, rx - n.x);
      let t1 = Math.atan2(lz - n.z, lx - n.x);
      const ang = Math.atan2(a.uz, a.ux);
      const away = ang + Math.PI;
      // Pick the direction whose midpoint lies away from the arm.
      let d = t1 - t0;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      if (Math.cos(t0 + d / 2 - away) < 0) d += d > 0 ? -2 * Math.PI : 2 * Math.PI;
      const steps = Math.max(12, Math.ceil((Math.abs(d) * rho) / 0.7));
      for (let k = 1; k < steps; k++) {
        const t = t0 + (d * k) / steps;
        out.push(n.x + Math.cos(t) * rho, n.z + Math.sin(t) * rho);
      }
      // Its sidewalk ring (a 'corner' walk edge from the right sidewalk round to the left one).
      if (a.walkR !== undefined && a.walkL !== undefined) {
        const wa = walkNodes[a.walkR];
        const wb = walkNodes[a.walkL];
        const ra = Math.hypot(wa.x - n.x, wa.z - n.z);
        const rb = Math.hypot(wb.x - n.x, wb.z - n.z);
        t0 = Math.atan2(wa.z - n.z, wa.x - n.x);
        t1 = Math.atan2(wb.z - n.z, wb.x - n.x);
        let dw = t1 - t0;
        dw -= Math.round(dw / (2 * Math.PI)) * 2 * Math.PI;
        if (Math.cos(t0 + dw / 2 - away) < 0) dw += dw > 0 ? -2 * Math.PI : 2 * Math.PI;
        const pts: number[] = [];
        const ns = Math.max(12, Math.ceil((Math.abs(dw) * (rho + a.e.sidewalk / 2)) / 0.7));
        for (let k = 0; k <= ns; k++) {
          const f = k / ns;
          // ease from the sidewalk node's radius onto the ring and back
          const ring = rho + a.e.sidewalk / 2;
          const e = Math.min(1, Math.min(f, 1 - f) * 5);
          const rr = (k === 0 ? ra : k === ns ? rb : (ra * (1 - f) + rb * f) * (1 - e) + ring * e);
          const t = t0 + dw * f;
          pts.push(n.x + Math.cos(t) * rr, n.z + Math.sin(t) * rr);
        }
        pts[0] = wa.x;
        pts[1] = wa.z;
        pts[pts.length - 2] = wb.x;
        pts[pts.length - 1] = wb.z;
        addWalkEdge(a.walkR, a.walkL, 'corner', polyline(pts), a.e.sidewalk);
      }
    } else {
      for (let i = 0; i < arms.length; i++) {
        const a = arms[i];
        const b = arms[(i + 1) % arms.length];
        const lx = a.px - a.rx * a.half;
        const lz = a.pz - a.rz * a.half;
        const rx = a.px + a.rx * a.half;
        const rz = a.pz + a.rz * a.half;
        out.push(lx, lz, rx, rz);
        const bx = b.px - b.rx * b.half;
        const bz = b.pz - b.rz * b.half;
        const f = cornerPoints(rx, rz, a.ux, a.uz, bx, bz, b.ux, b.uz);
        for (let k = 2; k < f.length - 2; k += 2) out.push(f[k], f[k + 1]);
        // Corner sidewalk (walk edge) around the same corner, offset outward by half a sidewalk.
        if (a.walkR !== undefined && b.walkL !== undefined && arms.length > 1) {
          const wa = walkNodes[a.walkR];
          const wb = walkNodes[b.walkL];
          const cp = cornerPoints(wa.x, wa.z, a.ux, a.uz, wb.x, wb.z, b.ux, b.uz);
          addWalkEdge(a.walkR, b.walkL, 'corner', polyline(cp), Math.min(a.e.sidewalk, b.e.sidewalk));
        }
      }
    }
    if (signedArea(out) < 0) reversePairs(out);
    intersections.push({ node: n.id, outline: Float64Array.from(out) });

    // Crossings CROSSING_SETBACK out along each arm (not at plain bends), and their lane data.
    for (const a of arms) {
      const end = a.e.a === n.id ? 'a' : 'b';
      const sideR = end === 'a' ? 1 : -1;
      const wr = swCross.get(`${a.e.id}:${sideR}:${end}`);
      const wl = swCross.get(`${a.e.id}:${-sideR}:${end}`);
      const c = crossAt(a.e, end);
      if (wl === undefined || wr === undefined || !c) continue;
      const pl = walkNodes[wl];
      const pr = walkNodes[wr];
      const laneIds = [...a.e.lanesAB, ...a.e.lanesBA];
      const laneS = laneIds.map((lid) => {
        const l = lanes[lid];
        nearestOn(l.path, c.x + c.rx * l.offset, c.z + c.rz * l.offset, near);
        return near.s;
      });
      const id = addWalkEdge(wl, wr, 'crossing', polyline([pl.x, pl.z, pr.x, pr.z]), CROSSING_WIDTH, a.e.id, laneIds);
      walkEdges[id].laneS = laneS;
      laneIds.forEach((lid, i) => {
        const l = lanes[lid];
        if (l.to === n.id) {
          l.crossingAtEnd = id;
          l.stopS = Math.max(0, laneS[i] - CROSSING_WIDTH / 2 - 1.0);
        } else l.crossingAtStart = id;
      });
    }
  }

  return { nodes, edges, lanes, connectors, intersections, walkNodes, walkEdges };
}

/**
 * The rounded curb corner between two arms of a junction: from arm a's right curb end (rx, rz)
 * heading back into the patch (−a.u) to arm b's left curb end heading out along b.u. Shared with
 * blocks.ts and the renderer so curbs, corner sidewalks and block outlines agree exactly.
 */
export function cornerPoints(rx: number, rz: number, aux: number, auz: number, bx: number, bz: number, bux: number, buz: number): number[] {
  return hermitePoints(rx, rz, -aux, -auz, bx, bz, bux, buz, 0.5, 0.4);
}

function trimByRadius(pl: Polyline, na: RoadNode, ra: number, nb: RoadNode, rb: number): Polyline {
  // First s where the curve leaves node a's disc, last s where it is outside node b's disc.
  const n = pl.pts.length >> 1;
  let s0 = 0;
  for (let i = 0; i < n; i++) {
    if (Math.hypot(pl.pts[i * 2] - na.x, pl.pts[i * 2 + 1] - na.z) >= ra) {
      s0 = refine(pl, i - 1, i, na, ra);
      break;
    }
  }
  let s1 = pl.length;
  for (let i = n - 1; i >= 0; i--) {
    if (Math.hypot(pl.pts[i * 2] - nb.x, pl.pts[i * 2 + 1] - nb.z) >= rb) {
      s1 = refine(pl, i + 1, i, nb, rb);
      break;
    }
  }
  if (s1 - s0 < 1) throw new Error('road edge too short for its node patches');
  return trim(pl, s0, s1);
}

/** Arc length where the segment between samples i (inside) and j (outside) crosses radius r. */
function refine(pl: Polyline, i: number, j: number, c: { x: number; z: number }, r: number): number {
  if (i < 0 || i >= pl.s.length) return pl.s[j];
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 30; k++) {
    const m = (lo + hi) / 2;
    const x = pl.pts[i * 2] + (pl.pts[j * 2] - pl.pts[i * 2]) * m;
    const z = pl.pts[i * 2 + 1] + (pl.pts[j * 2 + 1] - pl.pts[i * 2 + 1]) * m;
    if (Math.hypot(x - c.x, z - c.z) < r) lo = m;
    else hi = m;
  }
  return pl.s[i] + (pl.s[j] - pl.s[i]) * hi;
}

function classifyTurn(ta: { x: number; z: number }, tb: { x: number; z: number }, sameEdge: boolean): Turn {
  if (sameEdge) return 'uturn';
  const cross = ta.x * tb.z - ta.z * tb.x; // > 0: tb is clockwise from ta seen from above = a right turn
  const dot = ta.x * tb.x + ta.z * tb.z;
  if (dot > 0.7) return 'straight';
  if (dot < -0.8) return 'uturn';
  return cross > 0 ? 'right' : 'left';
}

function laneIndex(e: RoadEdge, laneId: number): number {
  const i = e.lanesAB.indexOf(laneId);
  return i >= 0 ? i : e.lanesBA.indexOf(laneId);
}

/**
 * Round a turning circle: from the arriving lane's end (x0, z0; heading t, toward the node) out onto
 * a circle of radius rc round the node, the long way round the far side, and back into the leaving
 * lane's start (x1, z1). Right-hand traffic keeps the circle's centre on its left.
 */
function uturnPoints(x0: number, z0: number, t: { x: number; z: number }, x1: number, z1: number, c: { x: number; z: number }, rc: number): number[] {
  const rx = -t.z; // right of travel
  const rz = t.x;
  const prx = c.x + rx * rc, prz = c.z + rz * rc;
  const plx = c.x - rx * rc, plz = c.z - rz * rc;
  const a = hermitePoints(x0, z0, t.x, t.z, prx, prz, t.x, t.z, 0.5, 0.45);
  const th = Math.atan2(rz, rx);
  const arc: number[] = [];
  const n = Math.max(8, Math.ceil((Math.PI * rc) / 0.5));
  for (let k = 1; k < n; k++) {
    const q = th - (Math.PI * k) / n;
    arc.push(c.x + Math.cos(q) * rc, c.z + Math.sin(q) * rc);
  }
  const b = hermitePoints(plx, plz, -t.x, -t.z, x1, z1, -t.x, -t.z, 0.5, 0.45);
  return [...a, ...arc, ...b];
}

/** Gap between two paths' bounding boxes (0 if they overlap): a cheap lower bound on their distance. */
function boxGap(p: Polyline, q: Polyline): number {
  const bp = bbox(p);
  const bq = bbox(q);
  const dx = Math.max(0, bp[0] - bq[2], bq[0] - bp[2]);
  const dz = Math.max(0, bp[1] - bq[3], bq[1] - bp[3]);
  return Math.hypot(dx, dz);
}
const boxes = new WeakMap<Polyline, number[]>();
function bbox(pl: Polyline): number[] {
  let b = boxes.get(pl);
  if (b) return b;
  b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pl.pts.length; i += 2) {
    b[0] = Math.min(b[0], pl.pts[i]);
    b[1] = Math.min(b[1], pl.pts[i + 1]);
    b[2] = Math.max(b[2], pl.pts[i]);
    b[3] = Math.max(b[3], pl.pts[i + 1]);
  }
  boxes.set(pl, b);
  return b;
}

function segIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pathsCross(p: Polyline, q: Polyline): boolean {
  // Every other sample (≤ 1 m chords of 0.5 m-sampled turn curves); the ends are always included.
  const a = decimated(p);
  const b = decimated(q);
  for (let i = 0; i < a.length - 2; i += 2) {
    for (let j = 0; j < b.length - 2; j += 2) {
      if (segIntersect(a[i], a[i + 1], a[i + 2], a[i + 3], b[j], b[j + 1], b[j + 2], b[j + 3])) return true;
    }
  }
  return false;
}

const decim = new WeakMap<Polyline, number[]>();
function decimated(pl: Polyline): number[] {
  let d = decim.get(pl);
  if (d) return d;
  d = [];
  const n = pl.pts.length >> 1;
  for (let i = 0; i < n; i += 2) d.push(pl.pts[i * 2], pl.pts[i * 2 + 1]);
  if ((n - 1) % 2) d.push(pl.pts[(n - 1) * 2], pl.pts[(n - 1) * 2 + 1]);
  decim.set(pl, d);
  return d;
}

/**
 * Minimum distance between two polylines (each one's samples against the other's segments, so
 * 1 m sampling never hides a near pass). Returns early with a value < stop once one is found.
 */
function minPathDistance(p: Polyline, q: Polyline, stop: number): number {
  let best = Infinity;
  const dp = decimated(p);
  const dq = decimated(q);
  for (const [u, v] of [
    [dp, dq],
    [dq, dp],
  ]) {
    for (let i = 0; i < u.length; i += 2) {
      for (let j = 0; j < v.length - 2; j += 2) {
        const x0 = v[j];
        const z0 = v[j + 1];
        const dx = v[j + 2] - x0;
        const dz = v[j + 3] - z0;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((u[i] - x0) * dx + (u[i + 1] - z0) * dz) / l2));
        const d = Math.hypot(x0 + dx * t - u[i], z0 + dz * t - u[i + 1]);
        if (d < best) {
          best = d;
          if (best < stop) return best;
        }
      }
    }
  }
  return best;
}

export function signedArea(poly: ArrayLike<number>): number {
  let s = 0;
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  return s / 2;
}

function reversePairs(a: number[]) {
  const n = a.length >> 1;
  for (let i = 0; i < n >> 1; i++) {
    const j = n - 1 - i;
    const x = a[i * 2];
    const z = a[i * 2 + 1];
    a[i * 2] = a[j * 2];
    a[i * 2 + 1] = a[j * 2 + 1];
    a[j * 2] = x;
    a[j * 2 + 1] = z;
  }
}

/** Point-in-polygon (even-odd), polygon x, z interleaved. */
export function pointInPolygon(poly: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  const n = poly.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const zi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const zj = poly[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
