// V1 (v2): the region's transit graph as the sim reads it (transit/sim.ts). Pure, boot-time: built
// once from R1's lanes and connectors (world/region/types.ts), the town crossings (crossings.ts) and
// the rendered road surface (index.ts passes it; specs use the paths' own heights). A generator, so
// the system can slice it across frames (buildNetSliced); specs build it in one go (buildNet).
//
// Segments: lanes 0..nL−1, then connectors nL..nL+nC−1. Per segment: its path, the surface height
// per sample, and a speed profile every metre (lane speed, lateral acceleration A_LAT in curves,
// braked back at B_CURVE so a car slows into a bend instead of at it). Per lane: its stop line and the
// crossings at either end. Per connector: its conflicts with their zones (R1's list plus every pair
// whose bus-sized bodies can touch through the turn), and which kinds may take it (buses never turn
// round in a dead end, trucks not in a lane's small circle), pruned so every kind can always go on.
//
// Bodies: a vehicle is a box centred on its path halfway between its axles, along the chord between
// them, so through a tight turn its ends swing out (as a bus's do) rather than cutting the kerb. Three
// things follow, all swept at boot:
//   - kerbs (`over`): how far each kind's body reaches over a town's walks; a town turn that would
//     carry a car over its corner walk (a bend whose path cuts inside it) is bowed out to the turn's
//     outside first, and trucks and buses keep off the turns and streets they would (KERB_TOL);
//   - stop lines: a lane's is set back from the junction until no body turning through it (bus-sized
//     where buses may turn) can touch a bus-wide body waiting at it;
//   - single file: where a kind's body could touch an oncoming one of its size or smaller anywhere
//     along a two-way edge, that lane is single file for it (sim.ts): mostly buses and trucks on the
//     towns' bends and the hairpins, and cars on the tightest narrow lanes.
// A lane a kind may not wait in (its stop line < the body + 0.2 m from its start, or single file for
// it) can still be driven through: the sim grants the turn into it together with the turn out of it (a
// chain), so nobody waits with a tail in a junction, nor stops where it meets oncoming traffic. `hops`
// bounds how many such lanes follow each other (a truck's and a bus's run to a few, CHAIN_OF).

import { armsOf, outlineOf, polyDist, type Arm } from '../roads/ground';
import { KINDS, type VehicleKind } from '../traffic/sim';
import { R } from '../world/config';
import { chartAt, minRadius } from '../world/region/network';
import { wnearest, wsample, wsampleOut } from '../world/region/path';
import type { RConnector, Region, RegionRoadKind, RTurn, WPath } from '../world/region/types';
import { dirToChart, v3, type Chart, type Vec3 } from '../world/sphere';
import { CROSS_STOP, townCrossings, type TransitCrossing } from './crossings';

/** Lateral acceleration in curves (m/s²) and the braking that shapes the speed profile (m/s²). */
const A_LAT = 2.8;
const B_CURVE = 1.6;
/** Centreline distance (m) inside which two connectors' vehicles could touch. */
const ZONE_R = 3.4;
/**
 * Clearance (m) a body needs from an oncoming one on a curve, else its lane is single file. Judged on
 * the painted bodies (BODY_HW: a car's wheels sit under its body, its KINDS width is the parking box),
 * so two cars pass on the narrowest town lanes and a truck or a bus still waits for the oncoming.
 */
const PASS = 0.05;
/** Two cars may brush their boxes by this much (m) on the tightest town bends: the corners are rounded 0.22 m. */
const PASS_CAR = -0.08;
/** Half-width (m) of each kind's body (traffic/mesh.ts: car 1.72, compact 1.58 wide; truck, bus as KINDS). */
export const BODY_HW = [0.88, 0.81, 1.05, 1.2] as const;
/** Clearance (m) between a turning body and a truck-wide one waiting at a stop line. */
const SWING = 0.08;
const WAIT_HW = 1.05;
/** A swing whose clear stop line leaves at least this (m) moves the lane's stop line back to it. */
const SET_MIN = 6;
/**
 * How far (m) a truck's or a bus's body box may reach over a town street's kerb (walks, corners): the
 * townsfolk keep their centres KERB + 0.05 = 0.38 m back from it (townsfolk/net.ts), 0.22 m round.
 */
export const KERB_TOL = 0.15;
/** Longest chain of lanes it may not wait in (connectors granted at once). */
export const CHAIN_MAX = 12;
/**
 * The same by kind: a truck keeps to streets it can stop in every few turns (a long run through a city's
 * short core streets needs them all clear at once, and starves), the others up to CHAIN_MAX.
 */
export const CHAIN_OF = [CHAIN_MAX, CHAIN_MAX, 3, 3] as const;

/** True if plan point (x, z) lies inside polygon o (x, z pairs). */
function inPoly(x: number, z: number, o: number[]): boolean {
  let inside = false;
  for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2)
    if (o[i + 1] > z !== o[j + 1] > z && x < ((o[j] - o[i]) * (z - o[i + 1])) / (o[j + 1] - o[i + 1]) + o[i]) inside = !inside;
  return inside;
}

/**
 * How far (m) a world point lies past the carriageway of segment g (lanes, then connectors: 0 on it): for
 * a lane, past its street's kerbs (−1 beyond the street's ends); for a turn, outside its junction's
 * paved outline (roads/ground, the corner walks' inner edge) and the kerbs of the streets meeting there.
 * Boot-time and spec use.
 */
export function kerbGauge(region: Region): (g: number, x: number, y: number, z: number) => number {
  const nL = region.lanes.length;
  const near = { dist: 0, s: 0 };
  const u = v3();
  const outl = new Map<number, { c: Chart; o: number[]; A: Arm[] }>();
  const junction = (id: number) => {
    let j = outl.get(id);
    if (!j) {
      const n = region.nodes[id];
      const c = chartAt(n.dir, R + n.h);
      const A = armsOf(region, c, n);
      j = { c, o: outlineOf(n, A), A };
      outl.set(id, j);
    }
    return j;
  };
  /** How far (m) world point (x, y, z) lies past the carriageway of segment g (0: on it). */
  return (g: number, x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z);
    u.x = x / l;
    u.y = y / l;
    u.z = z / l;
    if (g < nL) {
      const e = region.edges[region.lanes[g].edge];
      const d = wnearest(e.centre, u, near);
      // (past the street's end: in the junction, the turns' business, −1)
      return near.s < 0.05 || near.s > e.centre.length - 0.05 ? -1 : Math.max(0, d - e.width / 2);
    }
    const j = junction(region.connectors[g - nL].node);
    const pc = dirToChart(j.c, u);
    if (inPoly(pc.x, pc.z, j.o)) return 0;
    let d = polyDist(pc.x, pc.z, j.o);
    // (out along an arm: on its street while within its kerbs, the street's own centreline)
    for (const a of j.A) {
      const ax = pc.x - a.px, az = pc.z - a.pz;
      if (ax * a.ux + az * a.uz < -0.1) continue;
      d = Math.min(d, Math.max(0, wnearest(a.e.centre, u, near) - a.half));
    }
    return d;
  };
}

/** How far (m) a car's body may reach over a kerb before its turn is bowed out (the bodies' rounded corners). */
const CAR_KERB = 0.05;

/** Path p moved sideways by A·sin(π s/L) (side +1: to its right), its ends where they were. */
function bow(p: WPath, A: number, side: number): WPath {
  const n = p.h.length;
  const dir = new Float64Array(n * 3);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const ux = p.dir[i * 3], uy = p.dir[i * 3 + 1], uz = p.dir[i * 3 + 2];
    let tx = p.dir[b * 3] - p.dir[a * 3], ty = p.dir[b * 3 + 1] - p.dir[a * 3 + 1], tz = p.dir[b * 3 + 2] - p.dir[a * 3 + 2];
    const d = tx * ux + ty * uy + tz * uz;
    tx -= ux * d;
    ty -= uy * d;
    tz -= uz * d;
    const tl = Math.hypot(tx, ty, tz) || 1;
    // (right: forward × up)
    const rx = (ty * uz - tz * uy) / tl, ry = (tz * ux - tx * uz) / tl, rz = (tx * uy - ty * ux) / tl;
    const o = (side * A * Math.sin((Math.PI * p.s[i]) / (p.length || 1))) / (R + p.h[i]);
    const x = ux + rx * o, y = uy + ry * o, z = uz + rz * o;
    const l = Math.hypot(x, y, z);
    dir[i * 3] = x / l;
    dir[i * 3 + 1] = y / l;
    dir[i * 3 + 2] = z / l;
    if (i > 0) s[i] = s[i - 1] + Math.hypot(dir[i * 3] - dir[i * 3 - 3], dir[i * 3 + 1] - dir[i * 3 - 2], dir[i * 3 + 2] - dir[i * 3 - 1]) * (R + (p.h[i] + p.h[i - 1]) / 2);
  }
  return { dir, h: p.h, s, length: s[n - 1], closed: false };
}

export const TURN_W: Record<RTurn, number> = { straight: 1, right: 0.75, left: 0.6, uturn: 0.05 };
const KIND_W: Record<RegionRoadKind, number> = { highway: 1.2, road: 1.1, ring: 1.2, street: 1, access: 0.5, lane: 0.3 };

export interface Net {
  region: Region;
  nL: number;
  nC: number;
  nS: number;
  /** Per segment: path, length, the road surface height per path sample, speed limit per metre. */
  path: WPath[];
  len: Float64Array;
  hs: Float32Array[];
  prof: Float32Array[];
  /** Per segment: the fastest entry (m/s) from which every point of it can still be braked for. */
  entry: Float64Array;
  /** Per connector: its lanes. */
  from: Int32Array;
  to: Int32Array;
  /** Per lane: stop line (front bumper), crossings at its end / start (−1) and their arc lengths. */
  stopS: Float64Array;
  xEnd: Int32Array;
  xEndS: Float64Array;
  xStart: Int32Array;
  xStartS: Float64Array;
  crossings: TransitCrossing[];
  /**
   * Conflicts per connector (CSR): cf[cfOff[c] .. cfOff[c+1]), zone start on c near h (front), and the
   * zone end on h near c: a holder of h is out of it once its rear is past cfZE (the paths' zone) AND
   * its front past cfZF (the bodies' sweeps, bus-sized: a smaller body touches no later than a bus with
   * its front at the same place).
   */
  cfOff: Int32Array;
  cf: Int32Array;
  cfZS: Float32Array;
  cfZE: Float32Array;
  cfZF: Float32Array;
  /** ok[k·nC + c]: kind k may take connector c. wait[k·nL + l]: kind k can wait in lane l. hops: connectors to such a lane. */
  ok: Uint8Array;
  wait: Uint8Array;
  hops: Uint8Array;
  /** The other lane of a two-way edge (−1), and single[k·nL + l]: kind k meets nobody oncoming on lane l. */
  opp: Int32Array;
  single: Uint8Array;
  /**
   * Swings: a truck (k = 2) or bus (3) turning through connector c would touch a body waiting at the
   * stop line of lane swLane[j] for j in [swOff[(k − 2)·(nC + 1) + c], … + 1): it must wait at swX[j]
   * instead while one does (sim.ts).
   */
  swOff: Int32Array;
  swLane: Int32Array;
  swX: Float32Array;
  /**
   * Start swings: kind class k (0 cars, 1 trucks, 2 buses) turning through c would touch a body whose
   * rear is within ssY[j] m of the start of lane ssLane[j] (another lane leaving that junction), for j
   * in [ssOff[k·(nC + 1) + c], … + 1): its grant waits until no rear is (sim.ts).
   */
  ssOff: Int32Array;
  ssLane: Int32Array;
  ssY: Float32Array;
  /**
   * Keep clear (m) at the start of each lane: the longest start swing over it (a truck's or a bus's only
   * as far as a bus can still wait there). Nobody queues with a rear inside it (it is taken off the
   * lane's room), so a turn hardly ever waits on a queue.
   */
  keep: Float32Array;
  /**
   * The same for a truck: every truck's and bus's start swing in full (a truck waits nowhere a big turn
   * swings over its rear, so two trucks never wait on each other's swings across a junction).
   */
  keepT: Float32Array;
  /** over[k·nS + g]: how far (m) kind k's body reaches past the kerb on town segment g (walks, corners). */
  over: Float32Array;
  /** Base liking of a connector (turn × road kind of its exit). */
  like: Float64Array;
  /** Settlement index of each lane's edge (−1 open road) and component of each lane. */
  laneTown: Int16Array;
  laneComp: Int8Array;
  /** Per segment bounding circle on the sphere: centre (unit dir) and radius (m), for the player obstacle. */
  bc: Float64Array;
  br: Float64Array;
}

export interface NetOpts {
  /** The rendered road surface (m above sea level) at unit `d` of segment g, s along it, given the path's design height h. */
  surface?: (d: Vec3, h: number, g: number, s: number) => number;
}

/** Build the net in one go (specs). */
export function buildNet(region: Region, opts: NetOpts = {}): Net {
  const g = netSteps(region, opts);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Build the net a slice at a time (the system's init: `tick` is ctx.yield). */
export async function buildNetSliced(region: Region, opts: NetOpts, tick: () => Promise<void>): Promise<Net> {
  const g = netSteps(region, opts);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    await tick();
  }
}

export function* netSteps(region: Region, opts: NetOpts): Generator<void, Net> {
  const lanes = region.lanes;
  const conns = region.connectors;
  const nL = lanes.length;
  const nC = conns.length;
  const nS = nL + nC;
  const K = KINDS.length;
  const BUS = KINDS[3];
  const path: WPath[] = [];
  for (const l of lanes) path.push(l.path);
  for (const c of conns) path.push(c.path);

  // ── kerbs: how far (m) a kind's body reaches past the carriageway's edge, over a town street's walks
  // or round a junction's or a bend's corner (the sim's pose: centred on the path between the axles,
  // square to the chord between them; a turn runs on into the lanes either side of it) ──
  const past = kerbGauge(region);
  const wq = wsampleOut();
  const ax2 = new Float64Array(9);
  /** World point d m along segment g into ax2[o..o+2] (a turn's d past its ends: on along its lanes). */
  const at3 = (g: number, d: number, o: number) => {
    let p = path[g];
    if (g >= nL) {
      const c = conns[g - nL];
      if (d < 0) {
        p = path[c.fromLane];
        d += p.length;
      } else if (d > p.length) {
        d -= p.length;
        p = path[c.toLane];
      }
    }
    wq.i = 0;
    wsample(p, d, wq);
    ax2[o] = wq.x;
    ax2[o + 1] = wq.y;
    ax2[o + 2] = wq.z;
  };
  const walked = (g: number) => {
    if (g < nL) {
      const e = region.edges[lanes[g].edge];
      return e.settlement >= 1 && e.sidewalk > 0;
    }
    const n = region.nodes[conns[g - nL].node];
    return n.settlement >= 1 && n.kind !== 'end';
  };
  /** The furthest kind k's body (its sides and ends) reaches past the kerb anywhere on segment g. */
  const bodyOver = (g: number, k: number) => {
    const wb = KINDS[k].wheelbase, hl = KINDS[k].len / 2, hw = BODY_HW[k];
    const L = path[g].length;
    let worst = 0;
    // (a lane: both axles on it; a turn: from the rear axle at its start to the front axle at its end)
    const d0 = g < nL ? wb / 2 : -wb / 2, d1 = g < nL ? L - wb / 2 : L + wb / 2;
    for (let d = d0; d <= d1 + 1e-6; d += 0.5) {
      at3(g, d + wb / 2, 0);
      at3(g, d - wb / 2, 3);
      at3(g, d, 6);
      const cx = ax2[6], cy = ax2[7], cz = ax2[8];
      let ax = ax2[0] - ax2[3], ay = ax2[1] - ax2[4], az = ax2[2] - ax2[5];
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      const cl = Math.hypot(cx, cy, cz);
      // (the side: up × along)
      const nx = (cy * az - cz * ay) / cl, ny = (cz * ax - cx * az) / cl, nz = (cx * ay - cy * ax) / cl;
      for (let a = -1; a <= 1; a += 0.5)
        for (let sd = -1; sd <= 1; sd += 2)
          worst = Math.max(worst, past(g, cx + ax * hl * a + nx * hw * sd, cy + ay * hl * a + ny * hw * sd, cz + az * hl * a + nz * hw * sd));
    }
    return worst;
  };
  // (a town turn whose path cuts inside its corner, so a car would ride over the corner walk, bows out
  // to the turn's outside — a sine, nothing at its ends — until a car's body clears the kerb)
  for (let c = 0; c < nC; c++) {
    const cn = conns[c];
    if (!walked(nL + c) || (cn.turn !== 'left' && cn.turn !== 'right')) continue;
    let o = bodyOver(nL + c, 0);
    let best = o;
    let bp = cn.path;
    // (the inside of a left turn is to its left: R1's turns are named for the side they turn to)
    for (let A = 0, it = 0; o > CAR_KERB && it < 6; it++) {
      A += o + 0.02;
      path[nL + c] = bow(cn.path, A, cn.turn === 'left' ? -1 : 1);
      o = bodyOver(nL + c, 0);
      if (o < best) {
        best = o;
        bp = path[nL + c];
      } else break;
    }
    path[nL + c] = bp;
  }
  const len = Float64Array.from(path, (p) => p.length);
  const from = Int32Array.from(conns, (c) => c.fromLane);
  const to = Int32Array.from(conns, (c) => c.toLane);
  const q = wsampleOut();
  const tmp = v3();

  // ── heights: the road as drawn ──
  const hs = path.map((p, g) => {
    const out = new Float32Array(p.h.length);
    for (let i = 0; i < out.length; i++) {
      tmp.x = p.dir[i * 3];
      tmp.y = p.dir[i * 3 + 1];
      tmp.z = p.dir[i * 3 + 2];
      out[i] = opts.surface ? opts.surface(tmp, p.h[i], g, p.s[i]) : p.h[i];
    }
    return out;
  });
  yield;

  // ── speed profiles ──
  const speedOf = (g: number) => (g < nL ? lanes[g].speed : Math.min(lanes[from[g - nL]].speed, lanes[to[g - nL]].speed));
  const prof: Float32Array[] = [];
  const entry = new Float64Array(nS);
  const P = new Float64Array(6);
  for (let g = 0; g < nS; g++) {
    const p = path[g];
    const n = Math.max(1, Math.ceil(p.length)) + 1;
    const v = new Float32Array(n);
    const vmax = speedOf(g);
    // curvature from the turn between chords 1 m either side of each metre
    for (let k = 0; k < n; k++) {
      const s = Math.min(k, p.length);
      q.i = 0;
      wsample(p, s - 1, q);
      P[0] = q.x;
      P[1] = q.y;
      P[2] = q.z;
      wsample(p, s + 1, q);
      P[3] = q.x;
      P[4] = q.y;
      P[5] = q.z;
      wsample(p, s, q);
      const ax = q.x - P[0], ay = q.y - P[1], az = q.z - P[2];
      const bx = P[3] - q.x, by = P[4] - q.y, bz = P[5] - q.z;
      const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
      let kap = 0;
      if (la > 0.2 && lb > 0.2) {
        // (in the tangent plane: grades are not curves)
        const cr = (ay * bz - az * by) * q.dx + (az * bx - ax * bz) * q.dy + (ax * by - ay * bx) * q.dz;
        kap = Math.abs(Math.asin(Math.max(-1, Math.min(1, cr / (la * lb))))) / ((la + lb) / 2);
      }
      v[k] = kap > 1e-4 ? Math.min(vmax, Math.sqrt(A_LAT / kap)) : vmax;
    }
    // connectors: their tightest point all along (the capital's rule), never under a crawl
    if (g >= nL) {
      let m = vmax;
      for (let k = 0; k < n; k++) m = Math.min(m, v[k]);
      v.fill(Math.max(2.8, m));
    }
    for (let k = n - 2; k >= 0; k--) v[k] = Math.min(v[k], Math.sqrt(v[k + 1] * v[k + 1] + 2 * B_CURVE));
    prof.push(v);
    let e = Infinity;
    for (let k = 0; k < n; k++) e = Math.min(e, Math.sqrt(v[k] * v[k] + 2 * B_CURVE * k));
    entry[g] = e;
  }
  yield;

  // ── crossings: per lane, its stop line short of the one at its end ──
  const crossings = townCrossings(region);
  const stopS = Float64Array.from(lanes, (l) => l.path.length);
  const xEnd = new Int32Array(nL).fill(-1);
  const xStart = new Int32Array(nL).fill(-1);
  const xEndS = new Float64Array(nL);
  const xStartS = new Float64Array(nL);
  for (const x of crossings) {
    x.lanes.forEach((id, k) => {
      const l = lanes[id];
      const at = x.laneS[k];
      if (l.to === x.node) {
        xEnd[id] = x.id;
        xEndS[id] = at;
        stopS[id] = Math.max(0, at - x.width / 2 - CROSS_STOP);
      } else {
        xStart[id] = x.id;
        xStartS[id] = at;
      }
    });
  }

  // ── bodies in their node's chart (2D) ──
  const charts = region.nodes.map((nd) => chartAt(nd.dir, R + nd.h));
  const o2 = { x: 0, z: 0 };
  const toChart = (c: Chart, x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z) || 1;
    tmp.x = x / l;
    tmp.y = y / l;
    tmp.z = z / l;
    return dirToChart(c, tmp, o2);
  };
  const flat = conns.map((c) => {
    const p = path[nL + c.id];
    const out = new Float64Array(p.h.length * 2);
    for (let i = 0; i < p.h.length; i++) {
      const o = toChart(charts[c.node], p.dir[i * 3], p.dir[i * 3 + 1], p.dir[i * 3 + 2]);
      out[i * 2] = o.x;
      out[i * 2 + 1] = o.z;
    }
    return out;
  });
  /** The point `d` m along lane a → connector c → lane b (d < 0 back into a, > its length on into b) into q. */
  const along = (c: number, d: number) => {
    const L = len[nL + c];
    q.i = 0;
    if (d < 0) wsample(path[from[c]], Math.max(0, len[from[c]] + d), q);
    else if (d > L) wsample(path[to[c]], Math.min(len[to[c]], d - L), q);
    else wsample(path[nL + c], d, q);
  };
  const STEP = 0.5;
  /** Poses (cx, cz, ux, uz) in the node's chart of a body of kind k whose front runs along connector c from 0 to its length + the body. */
  const sweep = (c: number, k: VehicleKind) => {
    const ch = charts[conns[c].node];
    const oh = (k.len - k.wheelbase) / 2;
    const out: number[] = [];
    for (let s = 0; s <= len[nL + c] + k.len; s += STEP) {
      along(c, s - oh);
      const f = toChart(ch, q.x, q.y, q.z);
      const fx = f.x, fz = f.z;
      along(c, s - oh - k.wheelbase);
      const r = toChart(ch, q.x, q.y, q.z);
      const dx = fx - r.x, dz = fz - r.z;
      const l = Math.hypot(dx, dz) || 1;
      along(c, s - oh - k.wheelbase / 2);
      const m = toChart(ch, q.x, q.y, q.z);
      out.push(m.x, m.z, dx / l, dz / l);
    }
    return out;
  };
  const turnR = (c: number) => region.nodes[conns[c].node].turnR;
  // bus-sized (the zones), truck and car-sized (the stop lines)
  const sw: number[][][] = [[], [], [], []];
  for (let c = 0; c < nC; c++) {
    for (const k of [0, 2, 3]) sw[k].push(sweep(c, KINDS[k]));
    if ((c & 15) === 15) yield;
  }
  sw[1] = sw[0];

  // ── stop lines: set back from the junction until no car-sized body turning through it touches a
  // truck-wide one waiting there; for a truck's or a bus's turn, where it would still touch, the
  // stop line it needs (the sim moves it back only while one turns: swings) ──
  const byNode: number[][] = region.nodes.map(() => []);
  for (const c of conns) byNode[c.node].push(c.id);
  const W = new Float64Array(4);
  const swingL: number[][][] = [[], [], [], []];
  const swingX: number[][][] = [[], [], [], []];
  for (const k of [2, 3]) for (let c = 0; c < nC; c++) {
    swingL[k].push([]);
    swingX[k].push([]);
  }
  for (const l of lanes) {
    const n = l.to;
    const ch = charts[n];
    const p = l.path;
    // the waiting box (a truck-wide body as long as a bus) with its front at x
    const box = (x: number) => {
      q.i = 0;
      wsample(p, Math.max(0, x - 4), q);
      const c = toChart(ch, q.x, q.y, q.z);
      W[0] = c.x;
      W[1] = c.z;
      wsample(p, Math.max(0, x - 0.5), q);
      const a = toChart(ch, q.x, q.y, q.z);
      const ax = a.x, az = a.z;
      wsample(p, Math.max(0, x - 7.5), q);
      const b = toChart(ch, q.x, q.y, q.z);
      const dx = ax - b.x, dz = az - b.z;
      const ll = Math.hypot(dx, dz) || 1;
      W[2] = dx / ll;
      W[3] = dz / ll;
    };
    /** Where the front of a vehicle waiting on l must stay for kind k turning through c not to touch it. */
    const clear = (c: number, k: number, x: number) => {
      const S = sw[k][c];
      const K0 = KINDS[k];
      // (a U-turn back past its own lane's line: from once its rear is off that lane)
      const j0 = from[c] === l.id ? 4 * Math.ceil(K0.len / STEP) : 0;
      // (while its rear axle is still on the turn: once both are on the exit lane it is passing, the
      // single-file sweep's business)
      const last = Math.min(S.length, 4 * (Math.floor((len[nL + c] + K0.len - (K0.len - K0.wheelbase) / 2 + 1) / STEP) + 1));
      for (let it = 0; it < 80 && x > 0; it++) {
        box(x);
        let hit = false;
        for (let j = j0; j < last && !hit; j += 4) hit = gap2(S, j, K0.len / 2, K0.width / 2, W, 0, 4, WAIT_HW) < SWING;
        if (!hit) return x;
        x -= 0.25;
      }
      return Math.max(0, x);
    };
    let x = stopS[l.id];
    // (a U-turn too: it comes back past the line it left from)
    const other = (c: number) => from[c] !== l.id || conns[c].turn === 'uturn';
    for (const c of byNode[n]) if (other(c)) x = clear(c, 0, x);
    // (where a truck's or a bus's swing still leaves room for a truck to wait, the line is painted
    // there for everyone: nobody ever waits in a swing; the rest are swings it waits for, sim.ts)
    const xk2: number[] = [];
    let xs = x;
    for (const c of byNode[n]) {
      if (!other(c)) continue;
      for (const k of [2, 3]) {
        const xk = k === 3 && conns[c].turn === 'uturn' ? x : clear(c, k, x);
        xk2.push(xk);
        if (xk >= SET_MIN) xs = Math.min(xs, xk);
      }
    }
    stopS[l.id] = xs;
    let j = 0;
    for (const c of byNode[n]) {
      if (!other(c)) continue;
      for (const k of [2, 3]) {
        const xk = xk2[j++];
        if (xk < xs - 1e-6) {
          swingL[k][c].push(l.id);
          swingX[k][c].push(xk);
        }
      }
    }
  }
  yield;
  // start swings: a truck-wide body in the first metres of each other lane leaving the node
  const ssOff = new Int32Array(3 * (nC + 1));
  const ssLane: number[] = [];
  const ssY: number[] = [];
  for (let kc = 0; kc < 3; kc++) {
    const k = kc === 0 ? 0 : kc + 1;
    const K0 = KINDS[k];
    for (let c = 0; c < nC; c++) {
      ssOff[kc * (nC + 1) + c] = ssLane.length;
      const node = conns[c].node;
      const ch = charts[node];
      const S = sw[k][c];
      for (const d of conns) {
        // (the lanes leaving this node: each once, from any connector into it)
        if (d.node !== node || d.toLane === to[c] || d.id !== lanes[d.toLane].prev[0]) continue;
        const D = path[d.toLane];
        // (the furthest metre of its first 10 the body touches: a rear short of it may be touched)
        let y = 0;
        for (let p = 0; p < Math.min(10, D.length - 1); p += 0.25) {
          q.i = 0;
          wsample(D, p + 0.5, q);
          const m = toChart(ch, q.x, q.y, q.z);
          W[0] = m.x;
          W[1] = m.z;
          wsample(D, p + 1, q);
          const a = toChart(ch, q.x, q.y, q.z);
          const ax = a.x, az = a.z;
          wsample(D, p, q);
          const b = toChart(ch, q.x, q.y, q.z);
          const dx = ax - b.x, dz = az - b.z;
          const ll = Math.hypot(dx, dz) || 1;
          W[2] = dx / ll;
          W[3] = dz / ll;
          let hit = false;
          for (let j = 0; j < S.length && !hit; j += 4) hit = gap2(S, j, K0.len / 2, K0.width / 2, W, 0, 0.5, WAIT_HW) < SWING;
          if (hit) y = p + 1;
        }
        if (y > 0) {
          ssLane.push(d.toLane);
          ssY.push(y);
        }
      }
      ssOff[kc * (nC + 1) + c + 1] = ssLane.length;
    }
    yield;
  }
  // (a car's start swings in full; a truck's or a bus's as far as a bus can still wait on the lane)
  const keep = new Float32Array(nL);
  const keepBig = new Float32Array(nL);
  for (let e = 0; e < ssOff[nC]; e++) keep[ssLane[e]] = Math.max(keep[ssLane[e]], ssY[e]);
  for (let e = ssOff[nC]; e < ssLane.length; e++) keepBig[ssLane[e]] = Math.max(keepBig[ssLane[e]], ssY[e]);
  const keepT = new Float32Array(nL);
  for (let l = 0; l < nL; l++) {
    keepT[l] = Math.max(keep[l], keepBig[l]);
    keep[l] = Math.max(keep[l], Math.min(keepBig[l], stopS[l] - KINDS[3].len - 0.3));
  }

  // ── conflicts with zones: R1's, then bodies that touch ──
  const cfl: number[][] = conns.map((c) => c.conflicts.slice());
  const zs = new Map<number, number>();
  const ze = new Map<number, number>();
  const zf = new Map<number, number>();
  for (const h of conns) {
    const A = flat[h.id];
    const hp = path[nL + h.id];
    for (const c of cfl[h.id]) {
      const B = flat[c];
      let first = -1;
      let last = 0;
      for (let k = 0; k < A.length >> 1; k++) {
        if (distTo(B, A[k * 2], A[k * 2 + 1]) < ZONE_R) {
          if (first < 0) first = hp.s[k];
          last = hp.s[k];
        }
      }
      if (first < 0) first = last = hp.length;
      zs.set(h.id * nC + c, Math.max(0, first - 0.6));
      ze.set(h.id * nC + c, conns[c].toLane === h.toLane ? hp.length : Math.min(hp.length, last + 0.6));
    }
  }
  // bodies: a bus-sized box swept along both (approach and exit lanes included) touches the other's:
  // the zones from the touching poses (first front position on one, last rear position on the other)
  const hl = BUS.len / 2 + 0.1;
  const hw = BUS.width / 2 + 0.15;
  const reach = 4 * (hl * hl + hw * hw);
  // each sweep's bounds (its centres), to skip pairs that never come near
  const bb = sw[3].map((A) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < A.length; i += 4) {
      x0 = Math.min(x0, A[i]);
      x1 = Math.max(x1, A[i]);
      z0 = Math.min(z0, A[i + 1]);
      z1 = Math.max(z1, A[i + 1]);
    }
    return [x0, x1, z0, z1];
  });
  const R2 = 2 * Math.sqrt(hl * hl + hw * hw);
  for (const list of byNode) {
    for (const a of list)
      for (const b of list) {
        if (b <= a || from[a] === from[b]) continue;
        const ba = bb[a], bq = bb[b];
        if (ba[0] > bq[1] + R2 || bq[0] > ba[1] + R2 || ba[2] > bq[3] + R2 || bq[2] > ba[3] + R2) continue;
        const A = sw[3][a];
        const Bp = sw[3][b];
        let aF = 1e9, aL = -1e9, bF = 1e9, bL = -1e9;
        for (let i = 0; i < A.length; i += 4)
          for (let j = 0; j < Bp.length; j += 4) {
            const dx = Bp[j] - A[i], dz = Bp[j + 1] - A[i + 1];
            if (dx * dx + dz * dz > reach || gap2(A, i, hl, hw, Bp, j, hl, hw) >= 0) continue;
            const sa = (i / 4) * STEP;
            const sb = (j / 4) * STEP;
            aF = Math.min(aF, sa);
            aL = Math.max(aL, sa);
            bF = Math.min(bF, sb);
            bL = Math.max(bL, sb);
          }
        if (aF > 1e8) continue;
        if (!cfl[a].includes(b)) {
          cfl[a].push(b);
          cfl[b].push(a);
          ze.set(a * nC + b, -1e9);
          ze.set(b * nC + a, -1e9);
        }
        zs.set(a * nC + b, Math.min(zs.get(a * nC + b) ?? 1e9, Math.max(0, aF - 0.6)));
        zs.set(b * nC + a, Math.min(zs.get(b * nC + a) ?? 1e9, Math.max(0, bF - 0.6)));
        zf.set(a * nC + b, aL + 0.6);
        zf.set(b * nC + a, bL + 0.6);
      }
    yield;
  }
  const cfOff = new Int32Array(nC + 1);
  for (let c = 0; c < nC; c++) cfOff[c + 1] = cfOff[c] + cfl[c].length;
  const cf = new Int32Array(cfOff[nC]);
  const cfZS = new Float32Array(cfOff[nC]);
  const cfZE = new Float32Array(cfOff[nC]);
  const cfZF = new Float32Array(cfOff[nC]);
  for (let c = 0; c < nC; c++)
    cfl[c].forEach((h, k) => {
      const j = cfOff[c] + k;
      cf[j] = h;
      cfZS[j] = zs.get(c * nC + h)!;
      cfZE[j] = ze.get(h * nC + c)!;
      cfZF[j] = zf.get(h * nC + c) ?? -1e9;
    });

  // ── single file: sweep each kind along each lane against oncoming bodies ──
  const opp = new Int32Array(nL).fill(-1);
  const single = new Uint8Array(K * nL);
  /** Body poses every 0.5 m along a lane (both axles on it): centre xyz, axis xyz (unnormalised), for kinds 0, 2, 3. */
  const poseCache = new Map<number, Float64Array>();
  const posesOf = (l: number, k: number) => {
    let P2 = poseCache.get(l * 4 + k);
    if (P2) return P2;
    const p = path[l];
    const wbk = KINDS[k].wheelbase;
    const n = Math.max(0, Math.floor((p.length - wbk) / 0.5) + 1);
    P2 = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) {
      const c = wbk / 2 + i * 0.5;
      q.i = 0;
      wsample(p, c + wbk / 2, q);
      P2[i * 6 + 3] = q.x;
      P2[i * 6 + 4] = q.y;
      P2[i * 6 + 5] = q.z;
      wsample(p, c - wbk / 2, q);
      P2[i * 6 + 3] -= q.x;
      P2[i * 6 + 4] -= q.y;
      P2[i * 6 + 5] -= q.z;
      wsample(p, c, q);
      P2[i * 6] = q.x;
      P2[i * 6 + 1] = q.y;
      P2[i * 6 + 2] = q.z;
    }
    poseCache.set(l * 4 + k, P2);
    return P2;
  };
  /** Can a body of kind ka on lane la touch one of kind kb coming the other way on lane lb? */
  const meets = (la: number, ka: number, lb: number, kb: number) => {
    const A = posesOf(la, ka);
    const B = posesOf(lb, kb);
    const KA = KINDS[ka], KB = KINDS[kb];
    const pass = ka < 2 && kb < 2 ? PASS_CAR : PASS;
    const r = KA.len / 2 + BODY_HW[ka] + KB.len / 2 + BODY_HW[kb] + pass;
    for (let i = 0; i < A.length; i += 6)
      for (let j = 0; j < B.length; j += 6) {
        const dx = B[j] - A[i], dy = B[j + 1] - A[i + 1], dz = B[j + 2] - A[i + 2];
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        if (boxGap(A, i, KA.len / 2, BODY_HW[ka], B, j, KB.len / 2, BODY_HW[kb]) < pass) return true;
      }
    return false;
  };
  for (const e of region.edges) {
    if (e.oneWay || !e.lanesAB.length || !e.lanesBA.length) continue;
    const a = e.lanesAB[0];
    const b = e.lanesBA[0];
    opp[a] = b;
    opp[b] = a;
    // (a gentle edge never: a bus's ends swing ~hl²/2ρ, under 0.3 m past ρ 27 m)
    if (minRadius(e.centre, 2) > 28) continue;
    for (const [l, o] of [[a, b], [b, a]])
      for (let k = 0; k < K; k++) {
        // (against its own size and smaller: a car never meets a truck where the truck is single file;
        // a compact is a car for this)
        if (k === 1) {
          single[nL + l] = single[l];
          continue;
        }
        let hit = false;
        for (let m = 0; m <= k && !hit; m++) if (m !== 1) hit = meets(l, k, o, m);
        single[k * nL + l] = hit ? 1 : 0;
      }
    yield;
  }

  // ── kerbs: how far (m) each kind's body reaches past the carriageway's edge, over a town street's
  // walks or a junction's corner, on each lane and turn (the body's sides and ends, every metre) ──
  const over = new Float32Array(K * nS);
  {
    for (let g = 0; g < nS; g++) {
      // (town streets with walks, and the junctions and bends they meet at: where people are)
      if (!walked(g)) continue;
      for (const k of [0, 2, 3]) over[k * nS + g] = bodyOver(g, k);
      over[nS + g] = over[g];
      if (g % 64 === 0) yield;
    }
  }

  // ── who may go where ──
  const edgeOf = (l: number) => region.edges[lanes[l].edge];
  const ok = new Uint8Array(K * nC);
  const wait = new Uint8Array(K * nL);
  const hops = new Uint8Array(K * nL).fill(255);
  for (let k = 0; k < K; k++) {
    // (a compact keeps a car's rules: the route tables are by class, sim.ts and routes.ts)
    const Kd = KINDS[k === 1 ? 0 : k];
    // (a lane it would meet oncoming traffic on is no place to wait either: it drives through)
    for (let l = 0; l < nL; l++) wait[k * nL + l] = stopS[l] - (k === 2 ? keepT : keep)[l] >= Kd.len + 0.2 && !single[k * nL + l] ? 1 : 0;
    // (a delivery truck keeps to the streets it can pass oncoming traffic on: only the buses take the
    // narrow lanes, the whole run at once, sim.ts)
    // (nor a truck or a bus into a turn or a street its body would reach over the walks on, KERB_TOL)
    const kerb = (c: RConnector) => k >= 2 && (over[k * nS + nL + c.id] > KERB_TOL || over[k * nS + c.toLane] > KERB_TOL);
    for (const c of conns) ok[k * nC + c.id] = (k === 3 && c.turn === 'uturn') || (k === 2 && ((c.turn === 'uturn' && turnR(c.id) < 5) || single[2 * nL + c.toLane])) || kerb(c) ? 0 : 1;
    // prune to a fixed point: a lane that cannot be left (or not within CHAIN_MAX lanes to a waitable
    // one) is closed, and so are the turns into it
    for (let changed = true; changed; ) {
      changed = false;
      hops.fill(255, k * nL, (k + 1) * nL);
      for (let l = 0; l < nL; l++) if (wait[k * nL + l]) hops[k * nL + l] = 0;
      for (let it = 0; it < CHAIN_MAX; it++)
        for (let l = 0; l < nL; l++) {
          if (hops[k * nL + l] === 0) continue;
          for (const c of lanes[l].next) if (ok[k * nC + c]) hops[k * nL + l] = Math.min(hops[k * nL + l], hops[k * nL + to[c]] + 1);
        }
      for (const c of conns) {
        if (!ok[k * nC + c.id]) continue;
        const t = c.toLane;
        const open = lanes[t].next.some((x) => ok[k * nC + x]);
        if (!open || hops[k * nL + t] >= CHAIN_OF[k]) {
          ok[k * nC + c.id] = 0;
          changed = true;
        }
      }
    }
  }

  const like = Float64Array.from(conns, (c) => TURN_W[c.turn] * KIND_W[edgeOf(c.toLane).kind]);
  const laneTown = Int16Array.from(lanes, (l) => edgeOf(l.id).settlement);
  const compOfNode = new Int8Array(region.nodes.length).fill(-1);
  region.components.forEach((ns, ci) => ns.forEach((n) => (compOfNode[n] = ci)));
  const laneComp = Int8Array.from(lanes, (l) => compOfNode[l.from]);

  // bounding circles (for the player as an obstacle)
  const bc = new Float64Array(nS * 3);
  const br = new Float64Array(nS);
  for (let g = 0; g < nS; g++) {
    const p = path[g];
    q.i = 0;
    wsample(p, p.length / 2, q);
    bc[g * 3] = q.dx;
    bc[g * 3 + 1] = q.dy;
    bc[g * 3 + 2] = q.dz;
    let r = 0;
    for (let i = 0; i < p.h.length; i++) r = Math.max(r, Math.acos(Math.min(1, p.dir[i * 3] * q.dx + p.dir[i * 3 + 1] * q.dy + p.dir[i * 3 + 2] * q.dz)) * R);
    br[g] = r;
  }

  const swOff = new Int32Array(2 * (nC + 1));
  const swLane: number[] = [];
  const swX: number[] = [];
  for (const k of [2, 3])
    for (let c = 0; c < nC; c++) {
      swOff[(k - 2) * (nC + 1) + c] = swLane.length;
      swLane.push(...swingL[k][c]);
      swX.push(...swingX[k][c]);
      swOff[(k - 2) * (nC + 1) + c + 1] = swLane.length;
    }

  return { region, nL, nC, nS, path, len, hs, prof, entry, from, to, stopS, xEnd, xEndS, xStart, xStartS, crossings, cfOff, cf, cfZS, cfZE, cfZF, ok, wait, hops, opp, single, swOff, swLane: Int32Array.from(swLane), swX: Float32Array.from(swX), ssOff, ssLane: Int32Array.from(ssLane), ssY: Float32Array.from(ssY), keep, keepT, over, like, laneTown, laneComp, bc, br };
}

/**
 * Separation (m) of two 2D oriented boxes (centre x, z and unit axis at a[i..i+3], b[j..j+3]; half
 * length, half width): > 0 apart, < 0 overlapping.
 */
function gap2(a: ArrayLike<number>, i: number, ahl: number, ahw: number, b: ArrayLike<number>, j: number, bhl: number, bhw: number): number {
  const dx = b[j] - a[i];
  const dz = b[j + 1] - a[i + 1];
  const r = ahl + ahw + bhl + bhw;
  if (dx * dx + dz * dz > r * r) return 1;
  let sep = -Infinity;
  for (let k = 0; k < 4; k++) {
    const P = k < 2 ? a : b;
    const o = k < 2 ? i : j;
    const ax = k & 1 ? -P[o + 3] : P[o + 2];
    const az = k & 1 ? P[o + 2] : P[o + 3];
    const ra = ahl * Math.abs(a[i + 2] * ax + a[i + 3] * az) + ahw * Math.abs(-a[i + 3] * ax + a[i + 2] * az);
    const rb = bhl * Math.abs(b[j + 2] * ax + b[j + 3] * az) + bhw * Math.abs(-b[j + 3] * ax + b[j + 2] * az);
    sep = Math.max(sep, Math.abs(dx * ax + dz * az) - ra - rb);
  }
  return sep;
}

/**
 * Separation (m) of two oriented boxes on the planet (centre xyz, axis xyz at A[ia..ia+5]; half length,
 * half width), in the tangent plane at their midpoint: > 0 apart, < 0 overlapping (by about that).
 */
export function boxGap(A: ArrayLike<number>, ia: number, ahl: number, ahw: number, B: ArrayLike<number>, ib: number, bhl: number, bhw: number): number {
  let ux = A[ia] + B[ib], uy = A[ia + 1] + B[ib + 1], uz = A[ia + 2] + B[ib + 2];
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const dx = B[ib] - A[ia], dy = B[ib + 1] - A[ia + 1], dz = B[ib + 2] - A[ia + 2];
  // each box's axis in the plane, and its side
  let ax = A[ia + 3], ay = A[ia + 4], az = A[ia + 5];
  let d = ax * ux + ay * uy + az * uz;
  ax -= ux * d;
  ay -= uy * d;
  az -= uz * d;
  let l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  ax /= l;
  ay /= l;
  az /= l;
  let bx = B[ib + 3], by = B[ib + 4], bz = B[ib + 5];
  d = bx * ux + by * uy + bz * uz;
  bx -= ux * d;
  by -= uy * d;
  bz -= uz * d;
  l = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
  bx /= l;
  by /= l;
  bz /= l;
  const asx = uy * az - uz * ay, asy = uz * ax - ux * az, asz = ux * ay - uy * ax;
  const bsx = uy * bz - uz * by, bsy = uz * bx - ux * bz, bsz = ux * by - uy * bx;
  let sep = -Infinity;
  for (let k = 0; k < 4; k++) {
    const vx = k === 0 ? ax : k === 1 ? asx : k === 2 ? bx : bsx;
    const vy = k === 0 ? ay : k === 1 ? asy : k === 2 ? by : bsy;
    const vz = k === 0 ? az : k === 1 ? asz : k === 2 ? bz : bsz;
    const ra = ahl * Math.abs(ax * vx + ay * vy + az * vz) + ahw * Math.abs(asx * vx + asy * vy + asz * vz);
    const rb = bhl * Math.abs(bx * vx + by * vy + bz * vz) + bhw * Math.abs(bsx * vx + bsy * vy + bsz * vz);
    sep = Math.max(sep, Math.abs(dx * vx + dy * vy + dz * vz) - ra - rb);
  }
  return sep;
}

/** Distance from (x, z) to a 2D polyline (x, z interleaved). */
function distTo(P: Float64Array, x: number, z: number): number {
  let m = Infinity;
  for (let j = 0; j + 3 < P.length; j += 2) {
    const cx = P[j], cz = P[j + 1], ex = P[j + 2] - cx, ez = P[j + 3] - cz;
    const ll = ex * ex + ez * ez;
    let t = ll > 0 ? ((x - cx) * ex + (z - cz) * ez) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ox = cx + ex * t - x, oz = cz + ez * t - z;
    const d = ox * ox + oz * oz;
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}
