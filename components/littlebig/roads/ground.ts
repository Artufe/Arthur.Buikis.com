// The region's paved ground (v2, H1): every road edge's carriageway, verges or sidewalks with kerbs,
// junction patches with rounded corners (the capital's own outline rule, world/city/graph.ts),
// turning circles at every dead end (a farmyard, a boatyard, a cobbled square, a car park by what
// the end is for), the gate plazas (a paved disc and forecourt flush with the capital's turnaround,
// the ring, its planted island), town squares and greens, quay aprons, the runways with their paint,
// taxiways and aprons. Paint goes into its own Geo (drawn with a polygon offset).
//
// Heights: every surface lies on the RENDERED ground (the terrain facet under it, mesh.ts, or a
// walled quay's deck) plus its layer: paving PAVE < asphalt ASPH < paint < sidewalk WALK. Layers
// overlap freely (a square's paving runs under the sidewalks round it, a plaza's under its ring):
// the higher one wins in depth, 2+ cm apart, so nothing needs cutting out and nothing z-fights.
// Pieces of the same layer that overlap (a roundabout's ring under its junction patches) share uv
// and param, so their pixels are identical. Bridges hold their deck height over the water.

import { Color } from 'three';
import { K } from '../city/geo';
import { PALETTE } from '../render/palette';
import { CURB_H, R, ROAD_H } from '../world/config';
import { CITY_CHART } from '../world/city/frame';
import { cornerPoints } from '../world/city/graph';
import { GATE_CIRCLE_R } from '../world/city/layout';
import { chartAt, U_INSET } from '../world/region/network';
import { wpath, wsample, wsampleOut } from '../world/region/path';
import type { Airport, GatePlaza, Region, REdge, RNode, Settlement, WPath } from '../world/region/types';
import { chartToDir, dirToChart, v3, type Chart, type Vec3 } from '../world/sphere';
import { band, fill, Geo, offsetDir, pathFrame, plan, ribbon, ring, set, vtx, type HeightFn, type Lat, type UvFn } from './geom';
import type { MeshHeight } from './mesh';
import { padDist, padHeight } from '../world/region/pad';

export const PAVE = 0.03;
export const ASPH = ROAD_H;
export const PAINT = ROAD_H + 0.008;
export const WALK = ROAD_H + CURB_H;
const KERB = 0.18;

const col = (h: string) => new Color(h);
export const C = {
  asphalt: PALETTE.road.asphalt.clone().lerp(col('#747882'), 0.3),
  runway: PALETTE.road.asphalt.clone().lerp(col('#2E3140'), 0.3),
  shoulder: col('#ADB295'),
  sidewalk: PALETTE.road.sidewalk.clone(),
  kerb: col('#F4F1EA'),
  curb: col('#B9B4AA'),
  yellow: PALETTE.road.marking.clone(),
  white: col('#F7F5EE'),
  plaza: col('#EAD9B8'),
  setts: col('#D9BBA6'),
  lawn: col('#74C24B'),
  rim: col('#E6DCC8'),
  earth: col('#B59E78'),
  rut: col('#8E7A5A'),
  straw: col('#E0BE6A'),
  gravel: col('#D2C9B2'),
  concrete: col('#D3CFC6'),
  quay: col('#CDC5B5'),
};

export interface Build {
  region: Region;
  /** The rendered ground (m above sea level) under unit q: the terrain facet, or a walled quay's deck. */
  ground(q: Vec3): number;
  G: Geo;
  P: Geo;
  /** Night point lights out (the airfields'): position xyz, tint rgb, size, per light. */
  lights?: number[];
  tick(): Promise<void>;
}

/** An edge's end at a node, in the node's chart: curb points, outward unit u, right r = (−uz, ux). */
export interface Arm {
  e: REdge;
  /** The node is the edge's a end (its centreline runs out of the node). */
  atA: boolean;
  px: number;
  pz: number;
  ux: number;
  uz: number;
  half: number;
}

const _w = wsampleOut();
const dot = (a: Vec3, w: { dx: number; dy: number; dz: number }) => a.x * w.dx + a.y * w.dy + a.z * w.dz;

export function armsOf(region: Region, c: Chart, n: RNode): Arm[] {
  return n.edges.map((id) => {
    const e = region.edges[id];
    const p = e.centre;
    const last = p.h.length - 1;
    const atA = e.a === n.id;
    // (its end segment: the tangent the ribbons' end cross-sections are square to, so a patch's and a
    // corner sidewalk's ends meet them exactly)
    const i0 = atA ? 0 : last;
    const i1 = atA ? 1 : last - 1;
    const a = dirToChart(c, v3(p.dir[i0 * 3], p.dir[i0 * 3 + 1], p.dir[i0 * 3 + 2]));
    const b = dirToChart(c, v3(p.dir[i1 * 3], p.dir[i1 * 3 + 1], p.dir[i1 * 3 + 2]));
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { e, atA, px: a.x, pz: a.z, ux: (b.x - a.x) / l, uz: (b.z - a.z) / l, half: e.width / 2 };
  });
}

/** The fillet (m) where a lane without walks meets its turning circle, and a car park's gravel rim (m). */
const FILLET = 1.5;
export const RIM = 1.2;

/**
 * A node's paved outline in its chart (the capital's rule): per arm its left and right curb points
 * (tucked TUCK m into the arm), then the rounded corner to the next arm's left curb; a dead end is
 * the arm's curbs and the turning circle the long way round (a lane without walks: in from its
 * curbs down its edges to a FILLET m fillet each side, which starts the circle).
 */
export function outlineOf(n: RNode, A: Arm[], tuck = 0.06): number[] {
  const out: number[] = [];
  const curb = (a: Arm, side: number) => [a.px + a.ux * tuck - a.uz * side * a.half, a.pz + a.uz * tuck + a.ux * side * a.half];
  if (A.length === 1) {
    const a = A[0];
    const rho = n.turnR || Math.max(5.4, a.half + 2.6);
    const F = a.e.sidewalk ? 0 : FILLET;
    // the fillet on side sd (+1 right): from the lane's edge round to the circle (centre C: F off the
    // edge, rho + F from the node)
    const fil = (sd: number) => {
      const lx = -a.uz * sd, lz = a.ux * sd;
      const bx = a.px + lx * (a.half + F), bz = a.pz + lz * (a.half + F);
      const bu = bx * a.ux + bz * a.uz;
      const t = -bu + Math.sqrt(Math.max(0, bu * bu - bx * bx - bz * bz + (rho + F) ** 2));
      const cx = bx + a.ux * t, cz = bz + a.uz * t;
      const a0 = Math.atan2(-lz, -lx);
      let d = Math.atan2(-cz, -cx) - a0;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      const f: number[] = [];
      for (let k = 0; k <= 6; k++) f.push(cx + Math.cos(a0 + (d * k) / 6) * F, cz + Math.sin(a0 + (d * k) / 6) * F);
      return f;
    };
    const R1 = F ? fil(1) : curb(a, 1);
    const L1 = F ? fil(-1) : curb(a, -1);
    out.push(...curb(a, -1), ...curb(a, 1), ...(F ? R1 : []));
    const t0 = Math.atan2(R1.at(-1)!, R1.at(-2)!);
    const d = turnSweep(t0, Math.atan2(L1.at(-1)!, L1.at(-2)!), Math.atan2(a.uz, a.ux) + Math.PI);
    const steps = Math.max(12, Math.ceil((Math.abs(d) * rho) / 0.7));
    for (let k = 1; k < steps; k++) out.push(Math.cos(t0 + (d * k) / steps) * rho, Math.sin(t0 + (d * k) / steps) * rho);
    if (F) for (let k = L1.length - 2; k >= 0; k -= 2) out.push(L1[k], L1[k + 1]);
    return out;
  }
  for (let i = 0; i < A.length; i++) {
    const a = A[i];
    const b = A[(i + 1) % A.length];
    out.push(...curb(a, -1), ...curb(a, 1));
    // (the corner itself between the untucked curb points: exactly the corner sidewalk's inner edge)
    const [rx, rz] = [a.px - a.uz * a.half, a.pz + a.ux * a.half];
    const f = cornerPoints(rx, rz, a.ux, a.uz, b.px + b.uz * b.half, b.pz - b.ux * b.half, b.ux, b.uz);
    out.push(...(tuck ? f : f.slice(2, -2)));
  }
  return out;
}

/** How far (m) the carriageway may sit under its design height where the rendered facet dips below it. */
const SLACK = 0.02;

/**
 * A node patch's surface: the rendered ground + ASPH, held no lower than SLACK under its design height,
 * which blends the arms' end heights by inverse square distance to each arm's end line (so along an
 * arm's end it is exactly that arm's height, and the patch meets every carriageway without a step).
 */
function patchHeight(b: Build, c: Chart, A: Arm[]): HeightFn {
  // each arm's end height: its centreline's end sample nearer the node
  const hs = A.map((a) => {
    const p = a.e.centre;
    const n = p.h.length - 1;
    const q0 = dirToChart(c, v3(p.dir[0], p.dir[1], p.dir[2]));
    const q1 = dirToChart(c, v3(p.dir[n * 3], p.dir[n * 3 + 1], p.dir[n * 3 + 2]));
    return Math.hypot(q0.x - a.px, q0.z - a.pz) < Math.hypot(q1.x - a.px, q1.z - a.pz) ? p.h[0] : p.h[n];
  });
  return (q) => {
    const p = dirToChart(c, q);
    let sw = 0, sh = 0;
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      // distance to the arm's end line (curb to curb, across its outward unit u)
      const ax = p.x - a.px, az = p.z - a.pz;
      const along = ax * a.ux + az * a.uz;
      const across = Math.max(0, Math.abs(-ax * a.uz + az * a.ux) - a.half);
      const d2 = along * along + across * across;
      if (d2 < 1e-8) return Math.max(b.ground(q) + ASPH, hs[i] - SLACK);
      sw += 1 / d2;
      sh += hs[i] / d2;
    }
    return Math.max(b.ground(q) + ASPH, sh / sw - SLACK);
  };
}

/** The signed sweep (rad) from angle t0 to t1 the way whose middle faces `away`. */
function turnSweep(t0: number, t1: number, away: number): number {
  let d = t1 - t0;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  if (Math.cos(t0 + d / 2 - away) < 0) d += d > 0 ? -2 * Math.PI : 2 * Math.PI;
  return d;
}

/** A walled quay's apron: its height over the deck (1.2 cm under the walks), how far back it may run to the quay street, and its depth where none runs behind (m). */
export const QUAY_H = WALK - 0.012;
const QUAY_REACH = 16;
const QUAY_BACK = 6.5;

/** Over how far (m) a town street's walk narrows to nothing along the country road it meets. */
const TAPER = 4.5;

/** How wide (m) the grass between two parting arms is where their gore's paving ends. */
const GORE = 1.4;

/** Plan point of chart c on arm a, t m out from its node, d m right of its outward travel. */
function armPt(c: Chart, a: Arm, t: number, d: number): [number, number] {
  const p = a.e.centre;
  const rt = v3();
  const w = pathFrame(p, a.atA ? t : p.length - t, rt);
  const q = offsetDir(v3(w.dx, w.dy, w.dz), rt, a.atA ? d : -d, w.h, v3());
  const r = dirToChart(c, q);
  return [r.x, r.z];
}

/** Plan distance from (x, z) to the polyline pl (x, z pairs). */
export function polyDist(x: number, z: number, pl: ArrayLike<number>): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pl.length; i += 2) {
    const ax = pl[i], az = pl[i + 1], ux = pl[i + 2] - ax, uz = pl[i + 3] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / (ux * ux + uz * uz || 1)));
    best = Math.min(best, Math.hypot(ax + ux * t - x, az + uz * t - z));
  }
  return best;
}

/** True if plan point (x, z) lies inside polygon o (x, z pairs). */
function inPoly(x: number, z: number, o: number[]): boolean {
  let inside = false;
  for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) {
    if (o[i + 1] > z !== o[j + 1] > z && x < ((o[j] - o[i]) * (z - o[i + 1])) / (o[j + 1] - o[i + 1]) + o[i]) inside = !inside;
  }
  return inside;
}

/**
 * Whether a plan point of town s (its chart) lies within `m` m of one of its carriageways or junctions
 * (m < 0: that far into it): where a square's paving, run out under the walks, stops (−0.3), or a
 * quay's at the sidewalks' level (behind the kerb, 0.2).
 */
function townHit(region: Region, s: Settlement, m = -0.3): (x: number, z: number) => boolean {
  const c = s.chart;
  const streets = s.streets.map((id) => {
    const e = region.edges[id];
    const pl: number[] = [];
    for (let i = 0; i < e.centre.h.length; i += 2) {
      const p = dirToChart(c, v3(e.centre.dir[i * 3], e.centre.dir[i * 3 + 1], e.centre.dir[i * 3 + 2]));
      pl.push(p.x, p.z);
    }
    return { pl, w: e.width / 2 + m, b: bbox(pl) };
  });
  const outlines = s.nodes.map((id) => {
    const n = region.nodes[id];
    const nc = chartAt(n.dir, R + n.h);
    const o = outlineOf(n, armsOf(region, nc, n));
    for (let i = 0; i < o.length; i += 2) {
      const p = dirToChart(c, chartToDir(nc, o[i], o[i + 1]));
      o[i] = p.x;
      o[i + 1] = p.z;
    }
    return { o, oc: [...o, o[0], o[1]], b: bbox(o) };
  });
  // (each bounding box first: a ray's step is near one or two of them)
  const near = (b: number[], x: number, z: number, m: number) => x > b[0] - m && x < b[2] + m && z > b[1] - m && z < b[3] + m;
  return (x, z) =>
    streets.some((st) => near(st.b, x, z, st.w) && polyDist(x, z, st.pl) < st.w) ||
    outlines.some((t) => near(t.b, x, z, Math.max(0, m)) && (inPoly(x, z, t.o) || (m > 0 && polyDist(x, z, t.oc) < m)));
}

/** The plan bounding box (x0, z0, x1, z1) of points (x, z pairs). */
function bbox(p: number[]): number[] {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 2) {
    b[0] = Math.min(b[0], p[i]);
    b[1] = Math.min(b[1], p[i + 1]);
    b[2] = Math.max(b[2], p[i]);
    b[3] = Math.max(b[3], p[i + 1]);
  }
  return b;
}

/** How far (m, ≤ max) from (x, z) along unit (dx, dz), from r0 on, `hit` first holds (1 m steps, then halving to 3 cm). */
function reachOut(x: number, z: number, dx: number, dz: number, r0: number, max: number, hit: (x: number, z: number) => boolean): number {
  let r = r0;
  while (r < max && !hit(x + dx * r, z + dz * r)) r += 1;
  if (r >= max) return max;
  for (let h = 0.5; h > 0.02; h /= 2) if (r - h > r0 && hit(x + dx * (r - h), z + dz * (r - h))) r -= h;
  return r;
}

/** A point 2 cm from (x, z) along (dx, dz): a path's lead-in, so its end frame is square to that direction. */
const lead = (x: number, z: number, dx: number, dz: number) => [x + dx * 0.02, z + dz * 0.02];

/**
 * What a dead end is for (Settlement.yards, else its node's place: 'square', 'viewpoint', 'airport',
 * 'end', 'pier'), which dresses it; '' for any other node.
 */
export function deadEnd(region: Region, n: RNode): string {
  if (n.kind !== 'end') return '';
  for (const y of region.settlements[n.settlement]?.yards ?? []) if (y.node === n.id) return y.kind;
  return n.place;
}

/** A dead end's surface by what it is for (asphalt if absent), and its island's top (none if absent). */
const SURFACE: Record<string, Color> = { farm: C.earth, chalet: C.gravel, villa: C.gravel, lookout: C.gravel, boat: C.concrete, market: C.setts, square: C.setts };
const ISLE: Record<string, Color> = { chalet: C.setts, villa: C.lawn, school: C.lawn, airport: C.lawn, boat: C.concrete, lookout: C.lawn, market: C.lawn };

/** A WPath through plan points of chart c (heights unused: surfaces take theirs from the ground). */
export function chartPath(c: Chart, pts: ArrayLike<number>, h = 0): WPath {
  const dirs: number[] = [];
  const hs: number[] = [];
  const q = v3();
  for (let i = 0; i < pts.length; i += 2) {
    chartToDir(c, pts[i], pts[i + 1], q);
    dirs.push(q.x, q.y, q.z);
    hs.push(h);
  }
  return wpath(dirs, hs);
}

/** The rendered ground under unit q: the terrain facet (mesh.ts), or a walled quay's solid deck over the ramp under it. */
export function groundOf(region: Region, mh: MeshHeight): (q: Vec3) => number {
  const walled = region.settlements.filter((s) => s.wall);
  return (q) => {
    let h = mh.at(q);
    for (const s of walled) {
      if (q.x * s.dir.x + q.y * s.dir.y + q.z * s.dir.z < Math.cos((s.padR + 2) / R)) continue;
      const p = dirToChart(s.chart, q);
      if (padDist(s, p.x, p.z) <= 0.05) h = Math.max(h, padHeight(s, p.x, p.z));
    }
    return h;
  };
}

export async function buildGround(b: Build): Promise<void> {
  const { region, G, P } = b;
  const at = (k: number): HeightFn => (q) => b.ground(q) + k;
  const asph = at(ASPH);
  const pave = at(PAVE);
  const paint = at(PAINT);
  /** An island of radius r round chart c's origin: a kerb up from the asphalt, a stone rim, its top. */
  const island = (c: Chart, r: number, top: Color, kind: number) => {
    const isl = chartPath(c, circle(r, 0, 0, Math.max(24, Math.round(r * 10))));
    set(G, C.curb, K.plain);
    band(G, isl, 0, isl.length, 0, at(ASPH - 0.03), at(WALK + 0.05), -1);
    set(G, C.rim, K.plain);
    ring(G, c, r - 0.35, r, 0, Math.PI * 2, at(WALK + 0.05));
    set(G, top, kind, 1);
    ring(G, c, 0, r - 0.35, 0, Math.PI * 2, at(WALK + 0.03));
  };

  // ── Sidewalk strip along p (side +1: to the right of travel, between dc and dout > dc; a taper's
  //    dout varies), its slab CURB_H over the road surface `base` (the curb face from the asphalt up,
  //    the back face from the ground) ──
  const walk = (p: WPath, s0: number, s1: number, dc: number, dout: Lat, side: 1 | -1, base: HeightFn, caps = true, top0 = C.sidewalk) => {
    const D = (s: number) => (typeof dout === 'number' ? dout : dout(s));
    const k = typeof dout === 'number' ? dc + KERB * side : (s: number) => dc + side * Math.min(KERB, Math.abs(D(s) - dc));
    const lo = (a: Lat, c: Lat) => (side > 0 ? [a, c] : [c, a]) as [Lat, Lat];
    const top: HeightFn = (q, s, d) => base(q, s, d) + CURB_H;
    // (a car park's gravel rim: the roofs' gravel speckle)
    set(G, top0, top0 === C.sidewalk ? K.sidewalk : K.roof);
    ribbon(G, p, s0, s1, ...lo(k, dout), 1, top);
    set(G, C.kerb, K.plain);
    ribbon(G, p, s0, s1, ...lo(dc, k), 1, top);
    set(G, C.curb, K.plain);
    band(G, p, s0, s1, dc, (q, s, d) => base(q, s, d) - 0.03, top, side > 0 ? -1 : 1);
    band(G, p, s0, s1, dout, at(-0.06), top, side);
    if (!caps) return;
    // end caps: short faces across the strip (hidden where it meets the next strip)
    for (const [s, f] of [[s0, -1], [s1, 1]] as const) {
      const r = v3();
      const w = pathFrame(p, s, r);
      const up = v3(w.dx, w.dy, w.dz);
      const nrm = v3(w.tx * f, w.ty * f, w.tz * f);
      const ids: number[] = [];
      for (const d of [dc, D(s)]) {
        const q = offsetDir(up, r, d, w.h, v3());
        ids.push(vtx(G, q, b.ground(q) - 0.06, d, 0, nrm), vtx(G, q, top(q, s, d), d, 0.2, nrm));
      }
      if (f > 0 === D(s) > dc) G.quadIdx(ids[0], ids[1], ids[3], ids[2]);
      else G.quadIdx(ids[0], ids[2], ids[3], ids[1]);
    }
  };

  // ── Edges ──
  const gateOf = (e: REdge) => (e.kind === 'ring' ? region.gates[region.nodes[e.a].gate] : undefined);
  const plazaUv = (g: GatePlaza): UvFn => {
    const c = chartAt(g.dir, R + g.h);
    const uv: [number, number] = [0, 0];
    return (q) => {
      const p = dirToChart(c, q);
      uv[0] = p.x;
      uv[1] = p.z;
      return uv;
    };
  };
  // where a town street meets a country road its walks taper along the road (the node pass below):
  // the road's shoulder on that side starts where the taper ends (edge id, end, side → its length)
  const taper = new Map<string, number>();
  for (const n of region.nodes) {
    const A = n.edges.length > 1 ? armsOf(region, chartAt(n.dir, R + n.h), n) : [];
    A.forEach((a, i) => {
      const bb = A[(i + 1) % A.length];
      if (a.e.sidewalk || bb.e.sidewalk) for (const [m, sd] of [[a, 1], [bb, -1]] as const) if (!m.e.sidewalk) taper.set(`${m.e.id}${m.atA}${m.atA ? sd : -sd}`, Math.min(TAPER, m.e.centre.length / 3));
    });
  }
  await b.tick();
  for (const e of region.edges) {
    const p = e.centre;
    const L = p.length;
    const half = e.width / 2;
    const spans = e.bridges.map((i) => region.bridges[i]);
    // the carriageway lies on the rendered ground, but never more than 2 cm under its design height
    // (the path: a facet across a crest or a bank's edge dips below the carved bed), and on a span
    // exactly at the deck
    const road: HeightFn = (q, s) => {
      const h = wsample(p, s, _w).h;
      const span = spans.some((sp) => s > sp.s0 - 1.5 && s < sp.s1 + 1.5);
      return span ? h : Math.max(b.ground(q) + ASPH, h - SLACK);
    };
    const g = gateOf(e);
    // (night from high up, cityPatch's strand: a fine warm thread down the open road, the lamps'
    // sparks strung along it; a little wider through the towns. The capital's width read as tubes.)
    set(G, C.asphalt, K.asphalt, g ? -(g.r + 2) : e.settlement >= 0 ? half * 0.45 : 0.45);
    ribbon(G, p, 0, L, -half, half, Math.max(2, Math.ceil(e.width / 1.7)), road, g ? plazaUv(g) : undefined);
    if (e.sidewalk > 0) {
      walk(p, 0, L, half, half + e.sidewalk, 1, road);
      walk(p, 0, L, -half, -half - e.sidewalk, -1, road);
    } else if (!g) {
      // soft verges: a dusty shoulder that slopes from the asphalt's edge under the grass
      set(G, C.shoulder, K.plain);
      // (none on a span, nor on a gate plaza's paving: from where the centreline leaves its disc, fading
      // in from nothing over 3 m)
      const off = (nd: RNode, end: boolean) => {
        const g = region.gates[nd.gate];
        let s = 0;
        while (g && s < L && Math.acos(Math.min(1, dot(g.dir, wsample(p, end ? L - s : s, _w)))) * R < g.r) s += 0.25;
        return s;
      };
      const offA = off(region.nodes[e.a], false), offB = off(region.nodes[e.b], true);
      for (const side of [1, -1]) {
        // (and from where a town street's walk tapering along it ends)
        const s0 = Math.max(offA, taper.get(`${e.id}true${side}`) ?? 0);
        const to = L - Math.max(offB, taper.get(`${e.id}false${side}`) ?? 0);
        const runs: Array<[number, number]> = [];
        let from = s0;
        for (const sp of [...spans].sort((x, y) => x.s0 - y.s0)) {
          if (sp.s0 - from > 0.5) runs.push([from, sp.s0]);
          from = sp.s1;
        }
        if (to - from > 0.5) runs.push([from, to]);
        const fade = (s: number) => Math.min(1, s0 > 0 ? (s - s0) / 3 + 0.02 : 1, to < L ? (to - s) / 3 + 0.02 : 1);
        for (const [r0, r1] of runs) {
          const lo = side > 0 ? half : -half - 0.75;
          const hi = side > 0 ? half + 0.75 : -half;
          // (inner edge just under the asphalt's, outer edge 5 cm under the grass; by a plaza, all of it
          // but the inner edge under the grass, so it emerges from the asphalt's edge)
          ribbon(G, p, r0, r1, lo, hi, 2, (q, s, d) => {
            const f = Math.min(1, (Math.abs(d) - half) / 0.75 / fade(s));
            return (road(q, s, d) - 0.012) * (1 - f) + (b.ground(q) - 0.05) * f;
          });
        }
      }
    }
    // paint
    const kind = e.kind;
    if (kind !== 'lane' && kind !== 'ring' && L > 3) {
      const cutA = region.nodes[e.a].kind === 'bend' ? 0 : 1.2;
      const cutB = region.nodes[e.b].kind === 'bend' ? 0 : 1.2;
      const paintRd: HeightFn = (q, s, d) => road(q, s, d) + PAINT - ASPH;
      set(P, C.yellow, K.plain, 7);
      if (!e.oneWay) {
        const dash = kind === 'highway' ? 3 : 2.2;
        for (let s = cutA + 0.6; s + dash < L - cutB; s += dash * 2) ribbon(P, p, s, s + dash, -0.075, 0.075, 1, paintRd);
      }
      if (kind === 'road' || kind === 'highway') {
        // (edge lines don't let the night glow through: from orbit the road is one strand, not a tube)
        set(P, C.white, K.plain, 0);
        for (const side of [1, -1]) ribbon(P, p, cutA, L - cutB, side * (half - 0.3) - 0.06, side * (half - 0.3) + 0.06, 1, paintRd);
      }
    }
    await b.tick();
  }

  // ── Nodes: junction patches, gores, turning circles (dressed by what the dead end is for) ──
  for (const n of region.nodes) {
    const c = chartAt(n.dir, R + n.h);
    const A = armsOf(region, c, n);
    const o = outlineOf(n, A);
    const end = deadEnd(region, n);
    const g = n.gate >= 0 ? region.gates[n.gate] : undefined;
    const surface = SURFACE[end];
    const asphalt = () => set(G, C.asphalt, K.asphalt, -(g ? g.r + 2 : n.settlement >= 0 ? 2 : 1));
    // (gravel and beaten earth: the roofs' gravel speckle)
    if (surface) set(G, surface, end === 'boat' || end === 'market' || end === 'square' ? K.tiles : K.roof, end === 'market' || end === 'square' ? 2 : 0);
    else asphalt();
    const uvOf = g ? plazaUv(g) : undefined;
    const patch = patchHeight(b, c, A);
    const under: HeightFn = (q, s, d) => patch(q, s, d) - 0.004;
    if (end === 'farm') {
      // the farmyard: beaten earth from the turning circle out to the barns' doors (Yard.r + 0.6), its
      // edge wandering and sinking into the grass; wheel ruts round the U-turn, straw under the bales
      const yr = n.turnR + A[0].e.sidewalk + 0.6;
      const pts: number[] = [];
      for (let k = 0; k <= 40; k++) {
        const t = (k / 40) * Math.PI * 2;
        const r = yr + 0.35 * Math.sin(3 * t + n.id) + 0.2 * Math.sin(5 * t + 2 * n.id);
        pts.push(Math.cos(t) * r, Math.sin(t) * r);
      }
      fill(G, c, pts.slice(0, -2), under);
      const rim = chartPath(c, pts, n.h);
      ribbon(G, rim, 0, rim.length, -0.9, 0, 2, (q, s, d) => (patch(q, s, d) - 0.004) * (1 + d / 0.9) - (b.ground(q) - 0.05) * (d / 0.9));
      set(P, C.rut, K.plain);
      // (round the far side, the way the U-turn goes: none across the yard's mouth)
      const away = Math.atan2(A[0].uz, A[0].ux);
      for (const r of [-0.72, 0.72]) ring(P, c, n.turnR - U_INSET + r - 0.16, n.turnR - U_INSET + r + 0.16, away + 0.8, away + Math.PI * 2 - 0.8, (q, s, d) => patch(q, s, d) + PAINT - ASPH - 0.004);
      set(G, C.straw, K.plain);
      ring(G, c, 0, n.turnR - 2.9, 0, Math.PI * 2, at(ASPH + 0.02));
    } else fill(G, c, o, surface ? under : patch, uvOf);
    // a planted (or cobbled) island in the turning circle, clear of the U-turn's swept path
    const isle = ISLE[end];
    if (isle) island(c, n.turnR - 2.9, isle, isle === C.lawn ? K.lawn : K.tiles);
    if (A.length === 1) {
      const a = A[0];
      if (end === 'viewpoint') {
        // a car park: bays painted round the far side of the circle
        set(P, C.white, K.plain, 7);
        const rho = n.turnR || 5.4;
        const away = Math.atan2(a.uz, a.ux);
        for (let k = 0; k < 24; k++) {
          const t = (k / 24) * Math.PI * 2;
          if (Math.abs(Math.atan2(Math.sin(t - away), Math.cos(t - away))) < 1.0) continue;
          const pts = [Math.cos(t) * (rho - 2.3), Math.sin(t) * (rho - 2.3), Math.cos(t) * (rho - 0.25), Math.sin(t) * (rho - 0.25)];
          const ln = chartPath(c, pts, n.h);
          ribbon(P, ln, 0, ln.length, -0.06, 0.06, 1, (q, s, d) => patch(q, s, d) + PAINT - ASPH);
        }
      }
      const rim = a.e.sidewalk || (end === 'viewpoint' ? RIM : 0);
      if (rim) {
        // along the outline from the right curb round the circle to the left curb, the walk outside it
        // (a farmyard's: only a kerb return round each corner of its mouth; a car park's: a kerbed
        // gravel rim from fillet to fillet)
        const oo = outlineOf(n, A, 0);
        const path = chartPath(c, a.e.sidewalk ? [oo[2], oo[3], ...lead(oo[2], oo[3], -a.ux, -a.uz), ...oo.slice(4), ...lead(oo[0], oo[1], -a.ux, -a.uz), oo[0], oo[1]] : oo.slice(4), n.h);
        const cw = turnSweep(Math.atan2(oo[3], oo[2]), Math.atan2(oo[1], oo[0]), Math.atan2(a.uz, a.ux) + Math.PI) > 0;
        // (clockwise from above: the centre lies to the right of travel, the walk on the left)
        const sw = cw ? -rim : rim;
        const L = path.length;
        if (end === 'farm') for (const [s0, s1] of [[0, 1.7], [L - 1.7, L]]) walk(path, s0, s1, 0, sw, cw ? -1 : 1, patch);
        else walk(path, 0, L, 0, sw, cw ? -1 : 1, patch, !a.e.sidewalk, a.e.sidewalk ? C.sidewalk : C.gravel);
      }
    } else {
      for (let i = 0; i < A.length; i++) {
        const a = A[i];
        const bb = A[(i + 1) % A.length];
        const sw = Math.max(a.e.sidewalk, bb.e.sidewalk);
        const rx = a.px - a.uz * a.half, rz = a.pz + a.ux * a.half;
        if (sw <= 0) {
          // a gore: two arms leaving at a shallow angle overlap at the node and part beyond it, a
          // sliver of grass between them; pave between their centrelines out to where it is GORE wide
          const T = Math.min(16, a.e.centre.length / 2, bb.e.centre.length / 2);
          const ca: number[] = [], cb: number[] = [];
          for (let t = 0; t <= T; t += 0.5) ca.push(...armPt(c, a, t, 0)), cb.push(...armPt(c, bb, t, 0));
          if (polyDist(rx, rz, cb) >= bb.half) continue;
          let k = 2;
          while (k < ca.length && Math.min(polyDist(...armPt(c, a, k * 0.25, a.half), cb) - bb.half, polyDist(...armPt(c, bb, k * 0.25, -bb.half), ca) - a.half) < GORE) k += 2;
          const poly = ca.slice(0, k + 2);
          for (let j = k; j >= 0; j -= 2) poly.push(cb[j], cb[j + 1]);
          asphalt();
          fill(G, c, poly, at(ASPH - 0.012), uvOf);
          continue;
        }
        const bx = bb.px + bb.uz * bb.half, bz = bb.pz - bb.ux * bb.half;
        if (Math.hypot(bx - rx, bz - rz) > 0.05) {
          const f = cornerPoints(rx, rz, a.ux, a.uz, bx, bz, bb.ux, bb.uz);
          // (square to both arms' ends: a 2 cm lead-in and lead-out, so the corner meets their walks exactly)
          const path = chartPath(c, [rx, rz, ...lead(rx, rz, -a.ux, -a.uz), ...f.slice(2, -2), ...lead(bx, bz, -bb.ux, -bb.uz), bx, bz], n.h);
          walk(path, 0, path.length, 0, -sw, -1, patch, false);
        }
        // where a town street meets a country road, its walk runs on along the country road's kerb line
        // and eases into its kerb line over TAPER m (no square end standing in the verge): a's right side, bb's left
        for (const [m, sd] of [[a, 1], [bb, -1]] as const) {
          if (m.e.sidewalk > 0) continue;
          const p = m.e.centre, L = p.length, T = Math.min(TAPER, L / 3);
          const side = (m.atA ? sd : -sd) as 1 | -1;
          const at0 = m.atA ? 0 : L;
          const w = (s: number) => side * (m.half + sw * (0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.abs(s - at0) / T))));
          walk(p, m.atA ? 0 : L - T, m.atA ? T : L, side * m.half, w, side, (q, s) => Math.max(b.ground(q) + ASPH, wsample(p, s, _w).h - SLACK), false);
        }
      }
    }
    await b.tick();
  }

  // ── Gate plazas: a paved disc flush with the capital's turnaround, the ring, the planted island ──
  for (const g of region.gates) {
    const c = chartAt(g.dir, R + g.h);
    const ringW = 5;
    set(G, C.sidewalk, K.sidewalk);
    ring(G, c, 0, g.r, 0, Math.PI * 2, pave);
    // the forecourt between the city's turning circle and the plaza: the two discs' hull, both cusps
    const cc = dirToChart(c, chartToDir(CITY_CHART, g.cityX, g.cityZ));
    const d = Math.hypot(cc.x, cc.z);
    const th = Math.atan2(cc.z, cc.x);
    const r1 = GATE_CIRCLE_R;
    const phi = Math.acos(Math.max(-1, Math.min(1, (g.r - r1) / d)));
    for (const sg of [1, -1]) {
      // the plaza's arc from the touch point to its tangent point, then the city circle's back to the touch
      const pts: number[] = [];
      for (let k = 0; k <= 10; k++) pts.push(Math.cos(th + (sg * phi * k) / 10) * g.r, Math.sin(th + (sg * phi * k) / 10) * g.r);
      for (let k = 0; k <= 10; k++) {
        const a = th + sg * phi + (sg * (Math.PI - phi) * k) / 10;
        pts.push(cc.x + Math.cos(a) * r1, cc.z + Math.sin(a) * r1);
      }
      fill(G, c, pts, pave);
    }
    set(G, C.asphalt, K.asphalt, -(g.r + 2));
    ring(G, c, g.island - 0.1, g.ring + ringW / 2, 0, Math.PI * 2, asph, plazaUv(g));
    island(c, g.island, C.lawn, K.lawn);
    // paint: the ring's edge lines (white), broken at its entries
    set(P, C.white, K.plain, 7);
    const edge = chartPath(c, circle(g.ring + ringW / 2 - 0.35, 0, 0, 96), g.h);
    const inner = chartPath(c, circle(g.island + 0.3, 0, 0, 72), g.h);
    ribbon(P, inner, 0, inner.length, -0.06, 0.06, 1, paint);
    const entries = g.nodes.map((id) => {
      const q = dirToChart(c, region.nodes[id].dir);
      return Math.atan2(q.z, q.x);
    });
    for (let s = 0; s + 0.9 < edge.length; s += 1.8) {
      const w = wsample(edge, s + 0.45, _w);
      const q = dirToChart(c, v3(w.dx, w.dy, w.dz));
      const a = Math.atan2(q.z, q.x);
      // dashed past the entries (give way), solid between them
      const nearEntry = entries.some((e) => Math.abs(Math.atan2(Math.sin(a - e), Math.cos(a - e))) * g.ring < 3.4);
      ribbon(P, edge, s, s + (nearEntry ? 0.9 : 1.8), -0.06, 0.06, 1, paint);
    }
    await b.tick();
  }

  // ── Town squares and greens: paved out under the walks round them (a ray from the square's middle every
  //    1.4° to 0.3 m into the nearest carriageway or junction; r + 9 m where it opens onto the pad) ──
  for (const s of region.settlements) {
    if (!s.square || s.style === 'capital') continue;
    const sq = s.square;
    const c = s.chart;
    const hit = townHit(region, s);
    // (a square that is really a turning circle is paved as its node)
    if (s.nodes.some((id) => region.nodes[id].kind === 'end' && region.nodes[id].place === 'square')) continue;
    const pts: number[] = [];
    for (let k = 0; k < 256; k++) {
      const a = (k / 256) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // (out to a street up to r + 22 m away, closing its block; r + 9 m where the square opens onto the pad)
      let r = reachOut(sq.x, sq.z, ca, sa, 0, sq.r + 22, hit);
      if (r >= sq.r + 22) r = sq.r + 9;
      pts.push(sq.x + ca * r, sq.z + sa * r);
    }
    await b.tick();
    if (s.style === 'farm') set(G, C.lawn, K.lawn);
    else set(G, C.plaza, K.tiles, 0);
    fill(G, c, pts, pave);
    await b.tick();
  }

  // ── Walled quays: the paved deck at the sidewalks' level (one promenade with the quay street's walk,
  //    no step), from the coping back to the street's kerb every metre along the wall, up to QUAY_REACH;
  //    QUAY_BACK where no street runs behind (over the stone the terrain wears behind the wall) ──
  for (const s of region.settlements) {
    const w = s.wall;
    if (!w) continue;
    const hit = townHit(region, s, 0.2);
    const n = w.line.length / 2;
    // (a strip per metre: each a convex quad, as fill() clips; the back line steps where a ray misses)
    const f: number[] = [];
    for (let i = 0; i + 1 < n; i++) {
      const x0 = w.line[i * 2], z0 = w.line[i * 2 + 1], dx = w.line[i * 2 + 2] - x0, dz = w.line[i * 2 + 3] - z0;
      const m = Math.max(1, Math.ceil(Math.hypot(dx, dz)));
      for (let k = 0; k <= m - (i + 2 < n ? 1 : 0); k++) {
        const x = x0 + (dx * k) / m, z = z0 + (dz * k) / m;
        let r = reachOut(x, z, -w.nx, -w.nz, w.coping, QUAY_REACH, hit);
        if (r >= QUAY_REACH) r = QUAY_BACK;
        f.push(x - w.nx * w.coping, z - w.nz * w.coping, x - w.nx * r, z - w.nz * r);
      }
    }
    set(G, C.quay, K.tiles, 0);
    for (let i = 0; i + 7 < f.length; i += 4) fill(G, s.chart, [f[i], f[i + 1], f[i + 4], f[i + 5], f[i + 6], f[i + 7], f[i + 2], f[i + 3]], at(QUAY_H));
    await b.tick();
  }

  // ── Airports: the runway and its paint, the taxiway, the apron ──
  for (const a of region.airports) {
    airport(b, a);
    await b.tick();
  }
}

/** A closed circle of plan points (x, z pairs, first repeated last) round (cx, cz). */
export function circle(r: number, cx: number, cz: number, n: number): number[] {
  const out: number[] = [];
  for (let k = 0; k <= n; k++) out.push(cx + Math.cos((k / n) * Math.PI * 2) * r, cz + Math.sin((k / n) * Math.PI * 2) * r);
  return out;
}

function airport(b: Build, a: Airport): void {
  const { G, P } = b;
  const c = chartAt(a.centre, R + a.h);
  // runway axis in plan: from ends[0] to ends[1]
  const e0 = dirToChart(c, a.ends[0]);
  const e1 = dirToChart(c, a.ends[1]);
  const ux = (e1.x - e0.x) / a.length, uz = (e1.z - e0.z) / a.length;
  const rx = -uz, rz = ux;
  const pt = (s: number, d: number) => [e0.x + ux * s + rx * d, e0.z + uz * s + rz * d];
  const rect = (s0: number, s1: number, d0: number, d1: number) => [...pt(s0, d0), ...pt(s1, d0), ...pt(s1, d1), ...pt(s0, d1)];
  const hw = a.width / 2;
  const ground = (k: number): HeightFn => (q) => b.ground(q) + k;
  const runwayUv: UvFn = (q) => {
    const p = plan(c, q);
    return [(p.x - e0.x) * ux + (p.z - e0.z) * uz, (p.x - e0.x) * rx + (p.z - e0.z) * rz];
  };
  const planUv: UvFn = (q) => {
    const p = plan(c, q);
    return [p.x, p.z];
  };
  // shoulders (concrete), then the runway, each end a turning bulb (planes backtrack: no parallel taxiway)
  const ends = [pt(-0.4, 0), pt(a.length + 0.4, 0)];
  set(G, C.concrete, K.tiles, 0);
  fill(G, c, rect(-2.2, a.length + 2.2, -hw - 0.7, hw + 0.7), ground(PAVE), planUv);
  for (const [x, z] of ends) ring(G, chartAt(chartToDir(c, x, z), c.radius), 0, hw + 2.7, 0, Math.PI * 2, ground(PAVE), planUv);
  set(G, C.runway, K.asphalt, hw);
  fill(G, c, rect(-1.5, a.length + 1.5, -hw, hw), ground(ASPH), runwayUv);
  for (const [x, z] of ends) ring(G, chartAt(chartToDir(c, x, z), c.radius), 0, hw + 2, 0, Math.PI * 2, ground(ASPH - 0.006), runwayUv);
  // the apron (a slab beside the runway round the terminal's disc) and the taxiway out to it
  const ap = dirToChart(c, a.apron);
  const side = Math.sign((ap.x - e0.x) * rx + (ap.z - e0.z) * rz) || 1;
  const along = (ap.x - e0.x) * ux + (ap.z - e0.z) * uz;
  const D = (d: number) => side * (hw + d);
  set(G, C.concrete, K.tiles, 0);
  // (inside the carve's flat disc: its last half metre is already the bank's facets; the slab along the
  // runway inside its flat strip, joined to the disc across the neck between them)
  ring(G, chartAt(a.apron, R + a.h), 0, a.apronR - 0.5, 0, Math.PI * 2, ground(PAVE + 0.004), planUv);
  fill(G, c, rect(along - 9.6, along + 9.6, D(0.7), D(4.2)), ground(PAVE + 0.004), planUv);
  fill(G, c, rect(along - 5, along + 5, D(4), D(9)), ground(PAVE + 0.004), planUv);
  // the taxiway: out from the runway's edge with a 1.5 m fillet each side (fans from its corners: fill
  // takes convex pieces); (x along the runway from the apron's foot, y out from the runway's edge)
  const L = (x: number, y: number) => pt(along + x, D(y));
  const taxi = ground(ASPH - 0.003);
  set(G, C.runway, K.asphalt, 1.6);
  fill(G, c, [...L(-1.6, -0.2), ...L(1.6, -0.2), ...L(1.6, 2.4), ...L(-1.6, 2.4)], taxi, runwayUv);
  for (const k of [-1, 1]) {
    for (let j = 0; j < 6; j++) {
      const f = (i: number) => L(k * (3.1 - 1.5 * Math.sin((i * Math.PI) / 12)), 1.5 - 1.5 * Math.cos((i * Math.PI) / 12));
      fill(G, c, [...L(k * 1.6, -0.2), ...L(k * 3.1, -0.2), ...f(j), ...f(j + 1)].slice(j ? 4 : 0).concat(j ? L(k * 1.6, -0.2) : []), taxi, runwayUv);
    }
  }
  // yellow (all the airfield's paint 2 cm over the asphalt: no fight with the facets under it): the
  // taxiway's line out onto the apron, parting each way along the runway to a stand with its stop
  // bar; the holding point (two dashed bars on the runway's side, two solid on the taxiway's)
  set(P, C.yellow, K.plain, 7);
  const paintAt = ground(ASPH + 0.02);
  for (const k of [-1, 1]) {
    const pts = [...L(0, 0.2)];
    for (let j = 0; j <= 8; j++) pts.push(...L(k * 1.5 * (1 - Math.cos((j * Math.PI) / 16)), 1.2 + 1.5 * Math.sin((j * Math.PI) / 16)));
    const ln = chartPath(c, [...pts, ...L(k * 8.6, 2.7)], a.h);
    ribbon(P, ln, 0, ln.length, -0.07, 0.07, 1, paintAt);
    fill(P, c, [...L(k * 8, 1.8), ...L(k * 8.15, 1.8), ...L(k * 8.15, 3.6), ...L(k * 8, 3.6)], paintAt);
  }
  for (const d of [0.4, 0.6, 0.85, 1.05]) {
    const dash = d < 0.7 ? 0.6 : 2.9;
    for (let x = -1.45; x < 1.45; x += dash) fill(P, c, rect(along + x, along + Math.min(1.45, x + (d < 0.7 ? 0.35 : 2.9)), D(d - 0.05), D(d + 0.05)), paintAt);
  }
  // night: edge lights (white; green over the landing threshold, red over the other), blue along the taxiway
  const light = (s: number, d: number, ...tint: number[]) => {
    const q = chartToDir(c, ...(pt(s, d) as [number, number]));
    const y = b.ground(q) + 0.25;
    b.lights?.push(q.x * (R + y), q.y * (R + y), q.z * (R + y), ...tint, 0.5);
  };
  for (let k = 0; k <= 10; k++) {
    const end = k % 10 ? -1 : k / 10;
    for (const sd of [-1, 1]) light((a.length * k) / 10, sd * (hw + 0.4), ...(end < 0 ? [0.9, 0.95, 1] : end === a.landEnd ? [0.35, 1, 0.45] : [1, 0.3, 0.25]));
  }
  for (const sd of [-1.9, 1.9]) for (const d of [0.9, 2.2]) light(along + sd, D(d), 0.3, 0.55, 1);
  // paint: edge lines, threshold bars, centreline dashes, the runway numbers
  set(P, C.white, K.plain, 7);
  for (const sd of [-1, 1]) fill(P, c, rect(0, a.length, sd * (hw - 0.35) - 0.07, sd * (hw - 0.35) + 0.07), paintAt);
  for (const end of [0, 1]) {
    const S = (s: number) => (end ? a.length - s : s);
    for (let k = 0; k < 6; k++) {
      const d = -hw + 0.55 + k * ((a.width - 1.1) / 5);
      if (Math.abs(d) < 0.4) continue;
      fill(P, c, rect(Math.min(S(0.6), S(3.4)), Math.max(S(0.6), S(3.4)), d - 0.17, d + 0.17), paintAt);
    }
    // the number: heading (deg / 10) of the landing direction over this threshold
    const hd = ((((a.heading * 180) / Math.PI + (end ? 180 : 0)) % 360) + 360) % 360;
    const num = String(Math.round(hd / 10) || 36).padStart(2, '0');
    digits(num, (x0, x1, y0, y1) => {
      // (digit space: x across the runway to the right of the landing direction, y along it)
      const sg = end ? -1 : 1;
      const sA = S(4.6 + y0), sB = S(4.6 + y1);
      fill(P, c, rect(Math.min(sA, sB), Math.max(sA, sB), sg * x0, sg * x1), paintAt);
    });
  }
  for (let s = 9; s + 2.4 < a.length - 9; s += 4.8) fill(P, c, rect(s, s + 2.4, -0.09, 0.09), paintAt);
}

/** Seven-segment strokes of a two-digit runway number, centred across the runway (x) and 2.4 m long (y). */
const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
function digits(num: string, out: (x0: number, x1: number, y0: number, y1: number) => void) {
  const w = 0.9, hgt = 2.4, t = 0.16;
  for (let i = 0; i < 2; i++) {
    const m = SEG[Number(num[i])] ?? 0;
    // (a 1 is its right-hand bar: drawn next to the other digit, not a digit's width away)
    const ox = i ? (m === 0x06 ? t - w + 0.1 : 0.1) : -1;
    // y runs along the runway away from the threshold: the top of the digit is the far end
    const segs: Array<[number, number, number, number]> = [
      [ox, ox + w, hgt - t, hgt], // a (top)
      [ox + w - t, ox + w, hgt / 2, hgt], // b
      [ox + w - t, ox + w, 0, hgt / 2], // c
      [ox, ox + w, 0, t], // d
      [ox, ox + t, 0, hgt / 2], // e
      [ox, ox + t, hgt / 2, hgt], // f
      [ox, ox + w, hgt / 2 - t / 2, hgt / 2 + t / 2], // g
    ];
    segs.forEach((sg, k) => {
      if (m & (1 << k)) out(sg[0], sg[1], sg[2], sg[3]);
    });
  }
}

