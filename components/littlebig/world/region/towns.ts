// Town street plans (R1; v2 R2 rewrite, refined): one generator per settlement style, each in the
// town's own AXIS frame — f along its main axis (from its back gate inward; a waterfront town's axis
// points out to the water, an alpine village's up its slope), s to the right of it, metres on its pad —
// so build.ts maps them through the settlement's chart. Pure.
//
// A plan is a graph laid out by hand per style, so every crossing is placed, not found: the network
// (network.ts) turns it into lanes. Its streets are smooth curves: chains through the junctions, each
// junction with the tangent its street passes it at and a straight guide either side (so its arms run
// true through its patch), joined by biarcs (two circular arcs sharing a tangent, the turn split so the
// tighter arc is as wide as it can be), a dead end's last metres straight into its turning circle (the
// U-turn's swing-out), then faired (geo.ts fairLine) wherever a stretch still turns tighter than
// FAIR_R. A few avenues (the metro's) are centripetal Catmull-Rom splines through arc points, and some
// streets straight legs with true arc corners (filletPoly). What every plan honours (checkPlan and
// region.spec check it):
//   - junctions are T's, crossroads or Y's whose arms leave ≥ 86° apart and run straight through
//     their patch (a street passing a junction is given its tangent there; a branch leaves square to
//     it): the network's patches stay small (≈ 4.8–5.0 m on 5 m streets, the curb corner and a car's
//     turn), so a junction is a street corner, not a plaza (the critic's rule: radius ≤ 0.6 × the
//     widest carriageway + 2 m, spec'd);
//   - ≥ 6 m of street between two junctions' patches (spec'd), a dead end's turning circle inside the
//     pad (END_INSET); no bend tighter than ~6 m;
//   - gates on the pad's rim toward the bearings the town's roads leave for (the first exit at its
//     back), a MAIN street (≥ 14 m) in from the first gate;
//   - the streets FILL the pad (T1 builds on every frontage): ≥ 60 % of the pad within 9 m of a street
//     centreline (spec'd);
//   - organic: no plan is its own mirror image (planSymmetry: the street network reflected about any
//     axis lies ≥ 4 m from itself somewhere), no two of its blocks congruent within 1 m (planFaces,
//     faceDistance), no two towns alike within 6 m however turned or flipped (planDistance) — all
//     spec'd; closes (dead ends) leave from T-junctions; and distinct by style and by town (V2 §3, R2):
//       harbour (port pebble): fore street in from the back gate bending down to the market cross
//         (the square), market hill on down to the pier head on the quay; the high street across the
//         slope to the junction under the flank gate's top road; church lane curling from the cross
//         down onto the quay's west end; the harbour (the quay street) along the sea wall and up its
//         east end to the high street; net loft lane closing off it on the slope;
//       fishing village (puffin bay): the lane in from the gate to chapel row's corner, down onto the
//         quay, along the water, back up the harbour road; chapel row across between them; the cliff
//         lane out to the headland's turning circle;
//       bay village (driftwood): the top street arching across the back from gate to gate over its
//         crown, the high street dropping from the crown to the pier head, the strand along the
//         waterfront from the net lofts' turning circle round the boatyard corner up boat lane;
//       farm village (millbrook): strung along its winding lane from the back gate through the
//         crossroads, where the barn and orchard lanes run out to the yards (dead ends), on to the green,
//         where the lane runs on as the west road and the top road leaves square to it;
//       green village (clover): the road in to the crossroads at the green's foot, green lane bowing
//         along it to the second junction and on out as the long lane; church lane up the green's west
//         side to the church on the rise, a farm lane west, pond lane up its east side to the duck pond;
//       alpine village (snowberry): the high street climbing its slope in switchbacks — three
//         terraces of different lengths along the contours, joined by hairpins at alternate ends, the
//         chapel steps slanting up between them, the chapel square at the top;
//       resort (coral cove): the palm avenue in from the bridge along the hotel row, round up sunset
//         hill to the promenade's east end, the beach promenade along the crescent past the pier head
//         to the lido's turning circle; the beach walk from the hotel row down to the pier head;
//       metro (far haven): a fan of curving avenues round its harbour (ferry street and park row arcs
//         round a point out in the bay, market street round its own centre west of it, so its blocks
//         differ), the radial streets square to every avenue they cross, the boulevard from the pier
//         head inland and on out to the back gate, the airport road leaving on the diagonal, the
//         crescent sweeping round the east, the school lane closing off park row, the harbour front
//         and quay parade along the docks.

import { fairLine } from './geo';
import type { NodePlace, SettlementStyle, YardKind } from './types';

export interface PlanNode {
  s: number;
  f: number;
  place: NodePlace;
  /** 'roundabout' for the nodes on a one-way loop (entries yield to it). */
  control?: 'roundabout';
}

export interface PlanEdge {
  a: number;
  b: number;
  /** (s, f) samples ≤ 0.5 m apart, from node a's centre to node b's. */
  pts: number[];
  kind: 'street' | 'lane';
  name: string;
  oneWay?: boolean;
  /** Carriageway width override (m): a boulevard. */
  width?: number;
}

export interface TownPlan {
  nodes: PlanNode[];
  edges: PlanEdge[];
  /** The exit (gate) node for each requested exit bearing, in order (a metro's docks: its pier head). */
  exits: number[];
  /** The town's open square / green (T1 keeps it free). */
  square?: { s: number; f: number; r: number };
  /** Waterfront towns: the quay (or promenade) edge along the water ((s, f) interleaved), and where the pier leaves it. */
  quay?: number[];
  /** (node: the plan node at the pier's root, a street's end on the quay, or −1 when it leaves the quay street's side) */
  pier?: { node: number; s: number; f: number };
  /**
   * v2 (R2 refine 2): what each dead end is for (the critic: every lane ended in the same disc, a
   * lollipop): a farmyard, a boatyard, the chalets' yard… T1 rings the turning circle with buildings of
   * that kind (types.ts Settlement.yards).
   */
  yards?: Array<{ node: number; kind: YardKind }>;
}

export interface TownSpecIn {
  style: Exclude<SettlementStyle, 'capital'>;
  name: string;
  padR: number;
  /** Exit bearings relative to the axis (rad, 0 = +f, +π/2 = +s). The first is the back gate. */
  exits: number[];
  /** 0..1 per-town variation (bends, offsets). */
  vary: number;
  /** Which of its style's shapes and name pools (an index; two towns of one style differ). */
  variant?: number;
  /** The pad's seaward cut (Settlement.cut): the quay or promenade line f m out along the axis, a bite of radius r. */
  cut?: { f: number; r: number };
}

/** Distance (m) a gate node sits inside the pad edge. */
export const GATE_INSET = 0.5;
/** A dead end's centre lies at least this far inside the pad edge (its turning circle + sidewalk). */
export const END_INSET = 7.3;
/** v2 (R2 refine 2): a lane's dead end (its smaller turning circle, network.ts LANE_TURN_R 4.6 + a 1 m sidewalk). */
export const END_INSET_LANE = 6.2;
/** Straight run (m) out of a gate or into a dead end. */
const LEAD = 6;
/** Every town's main street: in from its gate to its first junction (m). */
export const MAIN = 14;
/**
 * A waterfront street's centreline lies this far inside the quay line: half its carriageway, its
 * sidewalk and a 0.9 m quay apron (bollards, the coping), all paved (Region.surface: 'plaza').
 */
export const QUAY_SET = 5.2;
/** v2 (R2 refine 2): the resort's promenade centreline this far inside the beach's crest (its sidewalk's edge 0.5 m from the sand). */
export const PROM_SET = 4.2;
/** Junction arms leave at least this far apart (rad): small patches (see the header). */
export const ARM_GAP = (86 * Math.PI) / 180;

type P = [number, number];

/** Polyline through control points with every corner rounded by a circular arc of radius r (or radii[i] at corner i; ≤ 0.5 m samples). */
/** A junction's arms keep 6 m straight (its patch then stays a street corner, ≈ 4.8–5 m), down to KEEP_SOFT where a corner beside it would otherwise turn tighter than KEEP_R. */
const KEEP_SOFT = 4.5;
const KEEP_R = 6.6;

export function filletPoly(ctrl: P[], r: number, radii?: number[], share = false, halfEnds = false, keep?: number[]): number[] {
  const out: number[] = [ctrl[0][0], ctrl[0][1]];
  // (share: a leg between two corners is split between them by what each needs, not half each: a
  // switchback's wide turn beside a slight one; v2 R2. keep[i]: metres of straight vertex i keeps on
  // either side, counted as its need: a junction's arms run straight out of its patch)
  const need = (i: number) => {
    if (keep && keep[i] > 0) return keep[i];
    if (i <= 0 || i >= ctrl.length - 1) return 0;
    const [ax, az] = ctrl[i - 1];
    const [bx, bz] = ctrl[i];
    const [cx, cz] = ctrl[i + 1];
    const l1 = Math.hypot(bx - ax, bz - az);
    const l2 = Math.hypot(cx - bx, cz - bz);
    if (l1 < 1e-6 || l2 < 1e-6) return 0;
    const ph = Math.atan2(Math.abs((bx - ax) * (cz - bz) - (bz - az) * (cx - bx)), (bx - ax) * (cx - bx) + (bz - az) * (cz - bz));
    return (radii?.[i] ?? r) * Math.tan(ph / 2);
  };
  const capOf = (i: number, j: number, L: number, phi: number) => {
    if (!share) return L * 0.5;
    // (a node's keep is absolute: the corner takes what is left of the leg; a junction's 6 m gives way to
    // 4.5 m only as far as the corner needs to stay ≥ KEEP_R round)
    if (keep && keep[j] > 0) {
      const hard = Math.max(0, L - keep[j]);
      if (keep[j] <= KEEP_SOFT) return hard;
      return Math.max(hard, Math.min(Math.max(0, L - KEEP_SOFT), KEEP_R * Math.tan(phi / 2)));
    }
    const a = need(i);
    const b = need(j);
    return a + b <= L ? a : (L * a) / (a + b);
  };
  const lineTo = (x: number, z: number) => {
    const lx = out[out.length - 2];
    const lz = out[out.length - 1];
    const L = Math.hypot(x - lx, z - lz);
    if (L < 1e-6) return;
    const n = Math.max(1, Math.ceil(L / 0.5));
    for (let k = 1; k <= n; k++) out.push(lx + ((x - lx) * k) / n, lz + ((z - lz) * k) / n);
  };
  for (let i = 1; i < ctrl.length - 1; i++) {
    const [ax, az] = ctrl[i - 1];
    const [bx, bz] = ctrl[i];
    const [cx, cz] = ctrl[i + 1];
    const l1 = Math.hypot(bx - ax, bz - az);
    const l2 = Math.hypot(cx - bx, cz - bz);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const ux = (bx - ax) / l1,
      uz = (bz - az) / l1;
    const wx = (cx - bx) / l2,
      wz = (cz - bz) / l2;
    const cr = ux * wz - uz * wx;
    const phi = Math.atan2(Math.abs(cr), ux * wx + uz * wz);
    if (phi < 1e-4) {
      lineTo(bx, bz);
      continue;
    }
    // cut back t along both legs (at most half of either; the first and last legs, which end at no
    // other corner, all but 1 m), the radius to match
    const ri = radii?.[i] ?? r;
    // (halfEnds: the end legs too only by half: a street leaving a junction runs straight half its guide)
    const t = Math.min(ri * Math.tan(phi / 2), i === 1 && !halfEnds ? l1 - 1 : capOf(i, i - 1, l1, phi), i === ctrl.length - 2 && !halfEnds ? l2 - 1 : capOf(i, i + 1, l2, phi));
    const rr = t / Math.tan(phi / 2);
    const sx = bx - ux * t,
      sz = bz - uz * t;
    lineTo(sx, sz);
    // the centre on the inside of the turn: cr > 0 turns from +s toward +f (counter-clockwise)
    const side = cr > 0 ? 1 : -1;
    const ox = sx - uz * rr * side;
    const oz = sz + ux * rr * side;
    const a0 = Math.atan2(sz - oz, sx - ox);
    const sw = side * phi;
    const n = Math.max(2, Math.ceil((rr * phi) / 0.5));
    for (let k = 1; k <= n; k++) {
      const q = a0 + (sw * k) / n;
      out.push(ox + Math.cos(q) * rr, oz + Math.sin(q) * rr);
    }
  }
  const last = ctrl[ctrl.length - 1];
  lineTo(last[0], last[1]);
  return out;
}

const unit = (x: number, z: number): P => {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
};
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
/** A point on the circle of radius ρ round the pad centre at axis bearing a (0 = +f, π/2 = +s). */
const rim = (a: number, rho: number): P => [Math.sin(a) * rho, Math.cos(a) * rho];
/** Where the ray from p along unit d leaves the circle of radius ρ round the pad centre. */
const rayRim = (p: P, d: P, rho: number): P => {
  const b = p[0] * d[0] + p[1] * d[1];
  const t = -b + Math.sqrt(Math.max(0, b * b - (p[0] * p[0] + p[1] * p[1]) + rho * rho));
  return add(p, d, t);
};
const add = (p: P, d: P, k: number): P => [p[0] + d[0] * k, p[1] + d[1] * k];
/** The direction d turned by `deg` degrees (positive: from +f toward +s, clockwise in the axis frame as drawn with +f up). */
const turn = (d: P, deg: number): P => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [d[0] * c + d[1] * s, -d[0] * s + d[1] * c];
};
/** Right of a travel direction (s to the right of f): +f → +s. */
const right = (d: P): P => [d[1], -d[0]];
const left = (d: P): P => [-d[1], d[0]];
const neg = (d: P): P => [-d[0], -d[1]];

/**
 * The circular arc (radius r, points ~1.5 m apart, both tangent points included) rounding the corner
 * where the line through A along u meets the line through B along w (u, w: the travel directions in
 * and out of the corner).
 */
function cornerArc(A: P, u: P, B: P, w: P, r: number): P[] {
  const [ux, uz] = unit(u[0], u[1]);
  const [wx, wz] = unit(w[0], w[1]);
  const cr = ux * wz - uz * wx;
  if (Math.abs(cr) < 1e-6) return [];
  // the corner vertex V = A + u·a = B + w·b
  const a = ((B[0] - A[0]) * wz - (B[1] - A[1]) * wx) / cr;
  const V: P = [A[0] + ux * a, A[1] + uz * a];
  const phi = Math.atan2(Math.abs(cr), ux * wx + uz * wz);
  const tt = r * Math.tan(phi / 2);
  const T1: P = [V[0] - ux * tt, V[1] - uz * tt];
  const side = cr > 0 ? 1 : -1;
  const C: P = [T1[0] - uz * r * side, T1[1] + ux * r * side];
  const a0 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
  const n = Math.max(2, Math.ceil((r * phi) / 1.5));
  const out: P[] = [];
  for (let q = 0; q <= n; q++) {
    const ang = a0 + (side * phi * q) / n;
    out.push([C[0] + Math.cos(ang) * r, C[1] + Math.sin(ang) * r]);
  }
  return out;
}

/** A small deterministic jitter per town (−1 … 1). */
function jitter(name: string, vary: number) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return (k: number) => {
    let x = Math.imul(h ^ (k * 2654435761), 1597334677) ^ Math.floor(vary * 1e6);
    x = Math.imul(x ^ (x >>> 15), 2246822519);
    x ^= x >>> 13;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  };
}

/**
 * A centripetal Catmull-Rom curve through `pts` (closed if `loop`), sampled ≤ ~0.4 m; `knots[i]` is the
 * output sample index of control point i.
 */
function catmull(pts: P[], loop: boolean): { line: number[]; knots: number[] } {
  const n = pts.length;
  const get = (i: number): P => {
    if (loop) return pts[((i % n) + n) % n];
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  const line: number[] = [pts[0][0], pts[0][1]];
  const knots = [0];
  const segs = loop ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const p0 = get(k - 1),
      p1 = get(k),
      p2 = get(k + 1),
      p3 = get(k + 2);
    const d = (a: P, b: P) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0,
      t1 = t0 + d(p0, p1),
      t2 = t1 + d(p1, p2),
      t3 = t2 + d(p2, p3);
    const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(2, Math.ceil(L / 0.35));
    for (let q = 1; q <= m; q++) {
      const t = t1 + ((t2 - t1) * q) / m;
      const lerp = (a: P, b: P, ta: number, tb: number): P => {
        const u = (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
      };
      const A1 = lerp(p0, p1, t0, t1),
        A2 = lerp(p1, p2, t1, t2),
        A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2),
        B2 = lerp(A2, A3, t1, t3);
      const C = lerp(B1, B2, t1, t2);
      line.push(C[0], C[1]);
    }
    knots.push(line.length / 2 - 1);
  }
  return { line, knots };
}

/**
 * One item of a street's course: a node id, a shaping point, or a node the street passes with a given
 * travel direction (`t`, unit): straight for `g` m (default 5) either side of it, so the junction's
 * arms run true through its patch (a branch leaving it gets `dirA` square to `t`).
 */
type Item = number | P | { n: number; t: P; g?: number } | { p: P; t: P; pin?: boolean } | { n: number; auto: true; g?: number };

interface ChainOpts {
  kind: 'street' | 'lane';
  /** A name, or a name per edge (its index along the chain and its midpoint). */
  name: string | ((i: number, s: number, f: number) => string);
  oneWay?: boolean;
  width?: number;
  /** Straight leads (m) out of the first item and into the last (a gate, a dead end, a T): two extra control points along the end segment. */
  leadA?: number;
  leadB?: number;
  /** Direction of the lead at the start / end (default: toward the next / from the previous item; dirB is the travel direction INTO the end). */
  dirA?: P;
  dirB?: P;
  loop?: boolean;
  /**
   * Lay the street as straight legs between its items with every corner rounded by a circular arc of
   * this radius (filletPoly), not as a spline: exact radii, straight runs through its junctions.
   */
  fillet?: number;
  /**
   * v2 (R2 refine): lay it as cubic Hermite curves between its items, each leaving and arriving along
   * the item's tangent (a node's `t`, a shaping point's `{ p, t }`, else the direction from the item
   * before to the one after), a node with `g` running straight g m either side: a bend is shaped by
   * where it passes and which way it points there, not by a fixed radius.
   */
  hermite?: boolean;
}

/**
 * A biarc from a (leaving along unit ta) to b (arriving along unit tb): two circular arcs meeting at a
 * common tangent (equal tangent lengths), sampled ≤ `step` m apart, a excluded, b included. A straight
 * segment when both tangents lie along the chord; an S of two opposite arcs when they lie on one side.
 */
function biarc(a: P, ta: P, b: P, tb: P, step: number, out: number[]): void {
  const vx = b[0] - a[0], vz = b[1] - a[1];
  const vv = vx * vx + vz * vz;
  if (vv < 1e-12) return;
  const tx = ta[0] + tb[0], tz = ta[1] + tb[1];
  const vt = vx * tx + vz * tz;
  const c = 2 * (1 - (ta[0] * tb[0] + ta[1] * tb[1]));
  let d: number;
  if (Math.abs(c) < 1e-9) {
    // parallel tangents: straight if along the chord, else an S whose joint is the chord's midpoint
    const vta = vx * ta[0] + vz * ta[1];
    if (Math.abs(vta * vta - vv) < 1e-9 * Math.max(1, vv)) {
      const L = Math.sqrt(vv);
      const nn = Math.max(1, Math.ceil(L / step));
      for (let q = 1; q <= nn; q++) out.push(a[0] + (vx * q) / nn, a[1] + (vz * q) / nn);
      return;
    }
    d = vv / (4 * Math.max(1e-9, vta));
  } else d = (-vt + Math.sqrt(vt * vt + c * vv)) / c;
  // (the tangent lengths split so the tighter of the two arcs is as wide as it can be: the equal split
  // puts most of an uneven turn on one arc)
  const vta = vx * ta[0] + vz * ta[1], vtb = vx * tb[0] + vz * tb[1];
  const ct = 1 - (ta[0] * tb[0] + ta[1] * tb[1]);
  const radius = (p: P, t: P, q: P) => {
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const cr = Math.abs(t[0] * dz - t[1] * dx);
    return cr < 1e-12 ? Infinity : (dx * dx + dz * dz) / (2 * cr);
  };
  let best = { d1: d, d2: d, r: -1 };
  for (const f of [1, 0.35, 0.5, 0.7, 0.85, 1.2, 1.45, 1.8, 2.4, 3.2]) {
    const d1 = d * f;
    const den = 2 * vtb + 2 * d1 * ct;
    if (Math.abs(den) < 1e-12) continue;
    const d2 = (vv - 2 * d1 * vta) / den;
    if (!(d2 > 1e-6)) continue;
    const q0: P = [a[0] + ta[0] * d1, a[1] + ta[1] * d1], q1: P = [b[0] - tb[0] * d2, b[1] - tb[1] * d2];
    const jj: P = [q0[0] + ((q1[0] - q0[0]) * d1) / (d1 + d2), q0[1] + ((q1[1] - q0[1]) * d1) / (d1 + d2)];
    const tj0 = unit(q1[0] - q0[0], q1[1] - q0[1]);
    const r = Math.min(radius(a, ta, jj), radius(jj, tj0, b));
    if (r > best.r * (f === 1 ? 1 : 1.03)) best = { d1, d2, r };
  }
  const q0: P = [a[0] + ta[0] * best.d1, a[1] + ta[1] * best.d1], q1: P = [b[0] - tb[0] * best.d2, b[1] - tb[1] * best.d2];
  const j: P = [q0[0] + ((q1[0] - q0[0]) * best.d1) / (best.d1 + best.d2), q0[1] + ((q1[1] - q0[1]) * best.d1) / (best.d1 + best.d2)];
  const tj = unit(q1[0] - q0[0], q1[1] - q0[1]);
  arcTo(a, ta, j, step, out);
  arcTo(j, tj, b, step, out);
}
/** The circular arc from p (tangent unit t) through to q, sampled ≤ step m (p excluded, q included). */
function arcTo(p: P, t: P, q: P, step: number, out: number[]): void {
  const dx = q[0] - p[0], dz = q[1] - p[1];
  const ll = dx * dx + dz * dz;
  // signed curvature: the circle through p tangent to t that passes q
  const cr = t[0] * dz - t[1] * dx;
  if (ll < 1e-12) return;
  if (Math.abs(cr) < 1e-9 * Math.sqrt(ll)) {
    const L = Math.sqrt(ll);
    const nn = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= nn; k++) out.push(p[0] + (dx * k) / nn, p[1] + (dz * k) / nn);
    return;
  }
  const kappa = (2 * cr) / ll;
  const r = 1 / kappa;
  // centre: p + r · (left normal of t) (left = (−t_z, t_x) in (s, f))
  const cx = p[0] - t[1] * r, cz = p[1] + t[0] * r;
  const a0 = Math.atan2(p[1] - cz, p[0] - cx);
  let a1 = Math.atan2(q[1] - cz, q[0] - cx);
  // sweep in the direction of travel (counter-clockwise when kappa > 0)
  let sw = a1 - a0;
  if (kappa > 0) while (sw < 0) sw += Math.PI * 2;
  else while (sw > 0) sw -= Math.PI * 2;
  const R0 = Math.abs(r);
  const nn = Math.max(1, Math.ceil((Math.abs(sw) * R0) / step));
  for (let k = 1; k <= nn; k++) {
    const ang = a0 + (sw * k) / nn;
    out.push(cx + Math.cos(ang) * R0, cz + Math.sin(ang) * R0);
  }
  void a1;
  a1 = 0;
}

/** The circumradius (m) of three points. */
function circR(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
  const ar = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
  return ar > 1e-9 ? (ab * bc * ca) / (2 * ar) : Infinity;
}

/** Streets turn no tighter than this (m, as region.spec measures: samples 2 m apart), with a margin. */
const FAIR_R = 6.7;
/** Fair a street line (≈ 0.35 m samples) where it turns tighter than FAIR_R (geo.ts fairLine). */
const fair = (line: number[], pinned: boolean[]) => fairLine(line, pinned, FAIR_R, 0.35);

/** A plan under construction: nodes placed by hand, streets as smooth curves through them. */
class Plan {
  nodes: PlanNode[] = [];
  edges: PlanEdge[] = [];
  /** The travel tangent a hermite chain gave each node it passed (v2 R2 refine: branches leave square to it). */
  tans = new Map<number, P>();
  tan(n: number): P {
    return this.tans.get(n) ?? [0, 1];
  }
  node(p: P, place: NodePlace = 'junction', control?: 'roundabout'): number {
    this.nodes.push({ s: p[0], f: p[1], place, control });
    return this.nodes.length - 1;
  }
  at(i: number): P {
    return [this.nodes[i].s, this.nodes[i].f];
  }
  /**
   * A street through `items` (node ids, shaping points, nodes with a tangent), one smooth curve, split
   * into an edge at every node on it. Returns the edge ids in order.
   */
  chain(items0: Item[], o0: ChainOpts): number[] {
    // (a street out of a gate runs straight in along the radial for a few metres: the region road
    // carries straight on out of the pad from it)
    const o: ChainOpts = { ...o0 };
    const gate = (it: Item | undefined) => typeof it === 'number' && this.nodes[it].place === 'town-gate';
    if (!o.loop && gate(items0[0]) && !o.dirA) {
      const p = this.at(items0[0] as number);
      o.dirA = unit(-p[0], -p[1]);
      // (a hermite street's lead is its own: 3 m unless it says; the others ≥ 5)
      o.leadA = o.hermite ? o.leadA ?? 3 : Math.max(o.leadA ?? 0, 5);
    }
    if (!o.loop && gate(items0[items0.length - 1]) && !o.dirB) {
      const p = this.at(items0[items0.length - 1] as number);
      o.dirB = unit(p[0], p[1]);
      o.leadB = o.hermite ? o.leadB ?? 3 : Math.max(o.leadB ?? 0, 5);
    }
    if (o.fillet) return this.polyChain(items0, o);
    if (o.hermite) return this.hermiteChain(items0, o);
    const pts: P[] = [];
    const isNode: number[] = [];
    items0.forEach((it, i) => {
      if (typeof it === 'number') {
        pts.push(this.at(it));
        isNode.push(it);
      } else if (Array.isArray(it)) {
        pts.push(it);
        isNode.push(-1);
      } else {
        if (!('t' in it) || !('n' in it)) throw new Error('towns: a {p, t} / auto item needs a hermite chain');
        const p = this.at(it.n);
        const g = it.g ?? 6;
        const first = i === 0 && !o.loop;
        const last = i === items0.length - 1 && !o.loop;
        // (two guide points each side: the spline is exactly straight to g / 2 and nearly so to g)
        if (!first) {
          pts.push(add(p, it.t, -g), add(p, it.t, -g / 2));
          isNode.push(-1, -1);
        }
        pts.push(p);
        isNode.push(it.n);
        if (!last) {
          pts.push(add(p, it.t, g / 2), add(p, it.t, g));
          isNode.push(-1, -1);
        }
      }
    });
    if (!o.loop) {
      // straight leads: points at half and full lead along the end direction
      const lead = (end: 0 | 1, m: number, dirIn?: P) => {
        if (!(m > 0)) return;
        const k = end === 0 ? 0 : pts.length - 1;
        const nb = end === 0 ? pts[1] : pts[pts.length - 2];
        const p = pts[k];
        const d = dirIn ? unit(dirIn[0], dirIn[1]) : unit(nb[0] - p[0], nb[1] - p[1]);
        // (a lead points from the end inward; dirB is the travel direction INTO the end)
        const dd: P = end === 0 ? d : dirIn ? [-d[0], -d[1]] : d;
        const span = Math.hypot(nb[0] - p[0], nb[1] - p[1]);
        const L = Math.min(m, span * 0.6);
        const q1 = add(p, dd, L * 0.5);
        const q2 = add(p, dd, L);
        if (end === 0) {
          pts.splice(1, 0, q1, q2);
          isNode.splice(1, 0, -1, -1);
        } else {
          pts.splice(pts.length - 1, 0, q2, q1);
          isNode.splice(isNode.length - 1, 0, -1, -1);
        }
      };
      lead(0, o.leadA ?? 0, o.dirA);
      lead(1, o.leadB ?? 0, o.dirB);
    }
    const { line, knots } = catmull(pts, !!o.loop);
    const at: Array<{ k: number; node: number }> = [];
    isNode.forEach((nd, i) => {
      if (nd >= 0) at.push({ k: knots[i], node: nd });
    });
    if (o.loop) at.push({ k: knots[knots.length - 1], node: at[0].node });
    const ids: number[] = [];
    for (let i = 0; i + 1 < at.length; i++) {
      const p0 = at[i], p1 = at[i + 1];
      const seg = line.slice(p0.k * 2, p1.k * 2 + 2);
      const mid = (seg.length >> 2) * 2;
      const name = typeof o.name === 'string' ? o.name : o.name(i, seg[mid], seg[mid + 1]);
      // pin the ends exactly on the nodes
      const a = this.at(p0.node), b = this.at(p1.node);
      seg[0] = a[0];
      seg[1] = a[1];
      seg[seg.length - 2] = b[0];
      seg[seg.length - 1] = b[1];
      this.edges.push({ a: p0.node, b: p1.node, pts: seg, kind: o.kind, name, oneWay: o.oneWay || undefined, width: o.width });
      ids.push(this.edges.length - 1);
    }
    return ids;
  }
  /** chain() with `hermite` (see ChainOpts.hermite). */
  private hermiteChain(items0: Item[], o: ChainOpts): number[] {
    const pts: P[] = [];
    const tans: Array<P | null> = [];
    const isNode: number[] = [];
    // (v2 R2 refine 2: a shaping point with `pin` holds the curve to its next pinned point against the
    // fairing: a promenade along its beach's arc)
    const pinPt: boolean[] = [];
    const push = (p: P, t: P | null, nd: number, pin = false) => {
      pts.push(p);
      tans.push(t ? unit(t[0], t[1]) : null);
      isNode.push(nd);
      pinPt.push(pin);
    };
    items0.forEach((it, i) => {
      const first = i === 0;
      const last = i === items0.length - 1;
      if (typeof it === 'number') {
        const p = this.at(it);
        // (a gate's or an end's lead: straight along dirA / dirB)
        if (first && o.dirA) {
          push(p, o.dirA, it);
          if (o.leadA) push(add(p, unit(o.dirA[0], o.dirA[1]), o.leadA), o.dirA, -1);
        } else if (last && o.dirB) {
          if (o.leadB) push(add(p, unit(o.dirB[0], o.dirB[1]), -o.leadB), o.dirB, -1);
          push(p, o.dirB, it);
        } else if ((first || last) && this.nodes[it].place === 'end') {
          // (a dead end: the street runs straight into (out of) its turning circle for its last 6.6 m,
          // the U-turn's swing-out and its patch: network.ts sizes an end's patch so both swings fit)
          // (into an end: along the line from the last point laid, a guide's included; out of one: toward the next item)
          const nb = items0[first ? 1 : i - 1];
          const q = !first && pts.length ? pts[pts.length - 1] : nb === undefined ? p : typeof nb === 'number' ? this.at(nb) : Array.isArray(nb) ? nb : 'p' in nb ? nb.p : this.at(nb.n);
          const t0 = first ? unit(q[0] - p[0], q[1] - p[1]) : unit(p[0] - q[0], p[1] - q[1]);
          let t = t0;
          const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
          let L = Math.min(6.6, dist * 0.5);
          // (into an end after a point laid with a tangent, a guide's: the lead turned so the way there is
          // one circular arc — the chord to the lead's start bisects the two tangents)
          const tq = !first ? tans[tans.length - 1] : null;
          if (tq) {
            // (a damped fixed point: the reflected tangent averaged in)
            const solve = (len: number): { t: P; r: number } => {
              let tt = t0;
              for (let it = 0; it < 12; it++) {
                const bs = add(p, tt, -len);
                const c = unit(bs[0] - q[0], bs[1] - q[1]);
                const dotc = c[0] * tq[0] + c[1] * tq[1];
                const tr = unit(2 * dotc * c[0] - tq[0], 2 * dotc * c[1] - tq[1]);
                tt = unit(tt[0] + tr[0], tt[1] + tr[1]);
              }
              const bs = add(p, tt, -len);
              const dx = bs[0] - q[0], dz = bs[1] - q[1];
              const cr = Math.abs(tq[0] * dz - tq[1] * dx);
              return { t: tt, r: cr < 1e-9 ? Infinity : (dx * dx + dz * dz) / (2 * cr) };
            };
            // (a short run in: the lead as long as the arc before it stays ≥ 6.4 m, up to the full 6.6 m
            // the U-turn's swing-out needs, never under the half-way default)
            let best = solve(L);
            if (L < 6.6) {
              for (let len = Math.min(6.6, dist * 0.75); len > L + 0.05; len -= 0.2) {
                const s = solve(len);
                if (s.r >= 6.4) {
                  best = s;
                  L = len;
                  break;
                }
              }
            }
            t = best.t;
          }
          if (first) {
            push(p, t, it);
            push(add(p, t, L), t, -1);
          } else {
            push(add(p, t, -L), t, -1);
            push(p, t, it);
          }
        } else push(p, null, it);
      } else if (Array.isArray(it)) push(it, null, -1);
      else if ('p' in it) push(it.p, it.t, -1, !!it.pin);
      else if ('auto' in it) {
        // (a node passed on the line from the item before to the item after)
        const p = this.at(it.n);
        const pos = (x: Item | undefined): P => (x === undefined ? p : typeof x === 'number' ? this.at(x) : Array.isArray(x) ? x : 'p' in x ? x.p : this.at(x.n));
        const a = pos(items0[i - 1]), b = pos(items0[i + 1]);
        const t = unit(unit(p[0] - a[0], p[1] - a[1])[0] + unit(b[0] - p[0], b[1] - p[1])[0], unit(p[0] - a[0], p[1] - a[1])[1] + unit(b[0] - p[0], b[1] - p[1])[1]);
        const g = it.g ?? 5;
        if (!first && g > 0) push(add(p, t, -g), t, -1);
        push(p, t, it.n);
        if (!last && g > 0) push(add(p, t, g), t, -1);
      } else {
        const p = this.at(it.n);
        const g = it.g ?? 5;
        if (!first && g > 0) push(add(p, unit(it.t[0], it.t[1]), -g), it.t, -1);
        push(p, it.t, it.n);
        if (!last && g > 0) push(add(p, unit(it.t[0], it.t[1]), g), it.t, -1);
      }
    });
    const n = pts.length;
    const T: P[] = pts.map((p, i) => {
      const t = tans[i];
      if (t) return t;
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      return unit(b[0] - a[0], b[1] - a[1]);
    });
    const line: number[] = [pts[0][0], pts[0][1]];
    const knots = [0];
    // (samples on a node's straight guide run, or on a node, are pinned for the fairing below)
    const pinned: boolean[] = [true];
    const straight = (i: number) => {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const cx = (b[0] - a[0]) / L, cz = (b[1] - a[1]) / L;
      return T[i][0] * cx + T[i][1] * cz > 0.9999 && T[i + 1][0] * cx + T[i + 1][1] * cz > 0.9999;
    };
    for (let i = 0; i + 1 < n; i++) {
      const a = pts[i], b = pts[i + 1];
      const pin = (straight(i) && (isNode[i] >= 0 || isNode[i + 1] >= 0)) || (pinPt[i] && pinPt[i + 1]);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      // (tangents scaled to the chord, and for the turn between them as a Bézier arc's are: a straight
      // segment where both point along it, a true circular arc where the ends lie on one)
      const ta = T[i], tb = T[i + 1];
      // (a biarc: circular arcs, the turn shared between them)
      const from = line.length;
      biarc(a, ta, b, tb, 0.35, line);
      if (line.length === from) line.push(b[0], b[1]);
      line[line.length - 2] = b[0];
      line[line.length - 1] = b[1];
      const added = (line.length - from) / 2;
      for (let q = 1; q <= added; q++) pinned.push(pin || (q === added && isNode[i + 1] >= 0));
      void L;
      knots.push(line.length / 2 - 1);
    }
    fair(line, pinned);
    const at: Array<{ k: number; node: number }> = [];
    isNode.forEach((nd, i) => {
      if (nd < 0) return;
      at.push({ k: knots[i], node: nd });
      if (!this.tans.has(nd)) this.tans.set(nd, T[i]);
    });
    const ids: number[] = [];
    for (let i = 0; i + 1 < at.length; i++) {
      const p0 = at[i], p1 = at[i + 1];
      const seg = line.slice(p0.k * 2, p1.k * 2 + 2);
      const mid = (seg.length >> 2) * 2;
      const name = typeof o.name === 'string' ? o.name : o.name(i, seg[mid], seg[mid + 1]);
      this.edges.push({ a: p0.node, b: p1.node, pts: seg, kind: o.kind, name, oneWay: o.oneWay || undefined, width: o.width });
      ids.push(this.edges.length - 1);
    }
    return ids;
  }
  /** chain() with `fillet`: straight legs and true arcs (see ChainOpts.fillet). */
  private polyChain(items1: Item[], o: ChainOpts): number[] {
    // (a loop: round to its first node again, which then ends the line with its back guide)
    const items0 = o.loop ? [...items1, items1[0]] : items1;
    const pts: P[] = [];
    const isNode: number[] = [];
    const keep: number[] = [];
    const push = (p: P, nd: number) => {
      pts.push(p);
      isNode.push(nd);
      // (a junction's arms run ≥ 4.5 m straight out of it (≈ its patch, 4.6–5.6 m), a gate's 3, a dead end's 2)
      keep.push(nd >= 0 ? (this.nodes[nd].place === 'end' ? 2 : this.nodes[nd].place === 'town-gate' ? 3 : 6) : 0);
    };
    items0.forEach((it, i) => {
      if (typeof it === 'number') push(this.at(it), it);
      else if (Array.isArray(it)) push(it, -1);
      else {
        if (!('t' in it) || !('n' in it)) throw new Error('towns: a {p, t} / auto item needs a hermite chain');
        const p = this.at(it.n);
        const g = it.g ?? 8;
        // (a guide point each side: the corner there takes at most half the guide, so the street runs
        // straight ≥ g / 2 from the node)
        if (i > 0) push(add(p, it.t, -g), -1);
        push(p, it.n);
        if (i < items0.length - 1) push(add(p, it.t, g), -1);
      }
    });
    if (o.leadA && o.dirA) {
      pts.splice(1, 0, add(pts[0], unit(o.dirA[0], o.dirA[1]), o.leadA));
      isNode.splice(1, 0, -1);
      keep.splice(1, 0, 0);
      keep[0] = Math.max(keep[0], o.leadA * 0.6);
    }
    if (o.leadB && o.dirB) {
      pts.splice(pts.length - 1, 0, add(pts[pts.length - 1], unit(o.dirB[0], o.dirB[1]), -o.leadB));
      isNode.splice(isNode.length - 1, 0, -1);
      keep.splice(keep.length - 1, 0, 0);
      keep[keep.length - 1] = Math.max(keep[keep.length - 1], o.leadB * 0.6);
    }
    // (a guide point is a corner like any other: legs are shared by need, a node keeping its straight)
    const line = filletPoly(pts, o.fillet!, undefined, true, true, keep);
    // the node samples: each node is a collinear vertex (or an end), so the line passes it exactly
    const at: Array<{ k: number; node: number }> = [];
    let from = 0;
    isNode.forEach((nd, i) => {
      if (nd < 0) return;
      const [x, z] = pts[i];
      let best = -1, bd = Infinity;
      for (let q = from; q < line.length / 2; q++) {
        const d = Math.hypot(line[q * 2] - x, line[q * 2 + 1] - z);
        if (d < bd) {
          bd = d;
          best = q;
        }
        if (d < 1e-6) break;
      }
      at.push({ k: best, node: nd });
      from = best;
    });
    const ids: number[] = [];
    for (let i = 0; i + 1 < at.length; i++) {
      const p0 = at[i], p1 = at[i + 1];
      const seg = line.slice(p0.k * 2, p1.k * 2 + 2);
      const mid = (seg.length >> 2) * 2;
      const name = typeof o.name === 'string' ? o.name : o.name(i, seg[mid], seg[mid + 1]);
      const a = this.at(p0.node), b = this.at(p1.node);
      seg[0] = a[0];
      seg[1] = a[1];
      seg[seg.length - 2] = b[0];
      seg[seg.length - 1] = b[1];
      this.edges.push({ a: p0.node, b: p1.node, pts: seg, kind: o.kind, name, oneWay: o.oneWay || undefined, width: o.width });
      ids.push(this.edges.length - 1);
    }
    return ids;
  }
  /** The plan, mirrored across its axis (s → −s) when m < 0: each style is laid out one way round. */
  finish(exits: number[], extra: Omit<TownPlan, 'nodes' | 'edges' | 'exits'>, m = 1): TownPlan {
    if (m < 0) {
      for (const n of this.nodes) n.s = -n.s;
      for (const e of this.edges) for (let i = 0; i < e.pts.length; i += 2) e.pts[i] = -e.pts[i];
      if (extra.square) extra.square = { ...extra.square, s: -extra.square.s };
      if (extra.pier) extra.pier = { ...extra.pier, s: -extra.pier.s };
      if (extra.quay) {
        const q: number[] = [];
        for (let i = extra.quay.length - 2; i >= 0; i -= 2) q.push(-extra.quay[i], extra.quay[i + 1]);
        extra.quay = q;
      }
    }
    return { nodes: this.nodes, edges: this.edges, exits, ...extra };
  }
}

export function planTown(t: TownSpecIn): TownPlan {
  switch (t.style) {
    case 'farm':
      return (t.variant ?? 0) % 2 === 0 ? farmLane(t) : greenVillage(t);
    case 'alpine':
      return alpine(t);
    case 'harbour':
      return (t.variant ?? 0) % 3 === 0 ? harbour(t) : (t.variant ?? 0) % 3 === 1 ? fishing(t) : bay(t);
    case 'resort':
      return resort(t);
    case 'metro':
      return metro(t);
  }
}

/** Lane names, per town from a pool (two villages of one style never share a street name). */
const POOL = {
  farm: ['barn lane', 'orchard lane', 'hay lane', 'dairy lane', 'pond lane', 'apple lane', 'goose lane', 'tractor lane', 'clover lane', 'mill lane'],
  alpine: ['chalet lane', 'pine lane', 'cowbell lane', 'edelweiss lane', 'sledge lane', 'cheese lane'],
  harbour: ['net loft lane', 'rope walk', 'anchor lane', 'gull lane', 'crab lane', 'lobster lane', 'tar lane', 'shell lane'],
} as const;
const pick2 = (pool: readonly string[], k: number): [string, string] => [pool[(k * 2) % pool.length], pool[(k * 2 + 1) % pool.length]];

/** The quay polyline along a straight cut at f = fq across the pad (inset at its ends), ≤ 1 m samples. */
function quayLine(P: number, fq: number): number[] {
  const w = Math.sqrt(Math.max(0, P * P - fq * fq)) - 0.6;
  const n = Math.max(2, Math.ceil((2 * w) / 1));
  const out: number[] = [];
  for (let k = 0; k <= n; k++) out.push(-w + (2 * w * k) / n, fq);
  return out;
}

/** Clamp an exit bearing to the back half's window [π − w, π + w] (a back gate). */
const backAngle = (a: number, w: number) => Math.PI + clamp(wrapA(a - Math.PI), -w, w);

/**
 * Harbour (variant 0: port pebble), laid out with its second road's gate on +s (finish mirrors it).
 * Fore street comes in from the back gate on the diagonal, climbs over the hill's shoulder to the
 * market cross (a crossroads) and runs down to the pier head on the quay; the high street leaves the
 * cross the other way, curving out along the slope past the school close to the second gate; church
 * lane curls from the cross down onto the quay's west end; the quay street runs the waterfront from
 * the fish market's turning circle past the pier head to the east corner, where harbour hill climbs
 * back up to the high street. Two blocks of unlike shape (the west a curved wedge, the east a long
 * trapezoid), dead ends at the fish market and the school.
 */
function harbour(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const j = jitter(t.name, t.vary);
  const k = P / 32;
  const fq = t.cut?.f ?? P * 0.72;
  const fQ = fq - QUAY_SET;
  const two = t.exits.length > 1;
  const m = two && Math.sin(t.exits[1]) < 0 ? -1 : 1;
  const ex = t.exits.map((a) => a * m);
  const X = (s: number, f: number): P => [s * k, f * k];
  const g = new Plan();
  // gates: the first within 65° of straight back (toward −s), the second on the +s rim toward its
  // bearing (75–148° off the axis)
  const a0 = two ? Math.PI + clamp(wrapA(ex[0] - Math.PI), -0.35, 1.12) : backAngle(ex[0], 0.6);
  const G0 = g.node(rim(a0, P - GATE_INSET), 'town-gate');
  const a1 = two ? clamp(Math.abs(wrapA(ex[1])), 0.42 * Math.PI, 0.82 * Math.PI) : 0.7 * Math.PI;
  const G1 = two ? g.node(rim(a1, P - GATE_INSET), 'town-gate') : g.node(rim(a1, P - END_INSET), 'end');
  // three terraces stepping up the hill from the water: the harbour (the quay street), fore street,
  // the high street (gate to gate across the back), joined by church lane (west, down from the high
  // street to the quay), market hill (from the pier head up to the market cross, on up as the steps to
  // the high street) and harbour hill (the quay's east end sweeping up round into fore street)
  const J0 = g.node(X(-15, -17), 'junction');
  const J6 = g.node(X(3.5 + 0.4 * j(1), -21.5), 'junction');
  // (the market cross square below the pier head: market hill straight down from the quay)
  const M = g.node(X(5, -1), 'square');
  const GJ = 6;
  const Q = g.node([5 * k, fQ], 'pier');
  const g0 = g.at(G0), g1 = g.at(G1), j0 = g.at(J0), j6 = g.at(J6);
  const mid = (a: P, b: P, c: P) => unit(unit(b[0] - a[0], b[1] - a[1])[0] + unit(c[0] - b[0], c[1] - b[1])[0], unit(b[0] - a[0], b[1] - a[1])[1] + unit(c[0] - b[0], c[1] - b[1])[1]);
  const tJ0 = mid(g0, j0, j6);
  const tJ6 = mid(j0, j6, g1);
  // (church lane leaves the high street square to it and runs straight on down through fore street's
  // end, square to that too: no S between two junctions 17 m apart)
  const tl = left(tJ0);
  const J5 = g.node(add(j0, tl, 17 * k), 'junction');
  const j5 = g.at(J5);
  const fc = fQ - 7;
  const sc = j5[0] + ((fc - j5[1]) * tl[0]) / tl[1];
  // (the gates' leads turned toward the streets they open onto: the roads outside carry on along them)
  g.chain([G0, { n: J0, t: tJ0, g: GJ }, { n: J6, t: tJ6, g: GJ }, G1], { kind: 'street', name: (i) => (i < 2 ? 'high street' : 'top road'), hermite: true, dirA: turn(unit(-g0[0], -g0[1]), 30), leadA: 3, dirB: turn(unit(g1[0], g1[1]), two ? -25 : 0), leadB: 3 });
  // church lane down from the high street past fore street's end to the quay; the quay along the
  // water past the pier head; harbour hill up from its east end, sweeping round into fore street
  const xe = Math.min(19.5 * k, Math.sqrt(Math.max(0, (P - 4.5) ** 2 - (fQ - 7.5) ** 2)));
  const tM: P = [1, 0];
  // (church lane and fore street are lanes: the terraces' second order under the high street and the
  // harbour; harbour hill sweeps down the east side round an 8 m bend into fore street's line)
  const m0 = g.at(M);
  const CB = 8 * k;
  g.chain([{ n: J0, t: tl, g: GJ }, { n: J5, t: tl, g: GJ }, { p: [sc, fc], t: tl }, { p: [sc + 7, fQ], t: [1, 0] }, { n: Q, t: [1, 0], g: GJ }], { kind: 'lane', name: 'church lane', hermite: true });
  g.chain([{ n: Q, t: [1, 0], g: GJ }, { p: [xe - 7.5, fQ], t: [1, 0] }, { p: [xe, fQ - 7.5], t: [0, -1] }, { p: [xe - CB, m0[1]], t: [-1, 0] }, { n: M, t: neg(tM), g: GJ }], { kind: 'street', name: 'harbour hill', hermite: true });
  g.chain([{ n: M, t: neg(tM), g: GJ }, { n: J5, t: neg(tJ0), g: GJ }], { kind: 'lane', name: 'fore street', hermite: true });
  // market hill from the pier head up to the market cross, on up the steps to the high street
  g.chain([{ n: Q, t: [0, -1], g: GJ }, { n: M, t: right(tM), g: GJ }], { kind: 'street', name: 'market hill', hermite: true });
  g.chain([{ n: M, t: right(tM), g: GJ }, { n: J6, t: right(tJ6), g: GJ }], { kind: 'lane', name: 'the steps', hermite: true });
  const q0 = g.at(Q);
  return g.finish(two ? [G0, G1] : [G0], { square: { s: 11 * k, f: fQ - 9.5, r: 3.6 }, quay: quayLine(P, fq), pier: { node: Q, s: q0[0], f: fq } }, m);
}

/**
 * Fishing village (harbour variant 1: puffin bay): the village lane winds down from its gate past
 * chapel row's corner to the west end of the little quay, runs the length of the water and climbs back
 * up the harbour road to chapel row (one loop round the harbour, the boats moored along its quay, the
 * pier out from its middle); the cliff lane runs on up from chapel row's end to the headland. Laid out
 * with the gate on −s (finish mirrors it).
 */
function fishing(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const k = P / 26;
  const fq = t.cut?.f ?? P * 0.7;
  const fQ = fq - QUAY_SET;
  const g = new Plan();
  const m = Math.sin(backAngle(t.exits[0], 0.8)) <= 0 ? 1 : -1;
  const ga = backAngle(t.exits[0] * m, 0.8);
  const X = (s: number, f: number): P => [s * k, f * k];
  const [laneA, laneB] = pick2(POOL.harbour, (t.variant ?? 0) + 2);
  const G0 = g.node(rim(ga, P - GATE_INSET), 'town-gate');
  // the village lane runs down the slope from the gate on the diagonal, through the crossing where the
  // chapel row climbs off west and the rope walk drops east, to the slip on the quay; the quay runs
  // west under the chapel row's foot and east round the harbour's end up onto the cliff
  // (straight in from the gate to the crossing, every junction's arms straight for GJ m: its patch a
  // street corner)
  const GJ = 6.5;
  const g0 = g.at(G0);
  const t1 = unit(-g0[0], -g0[1]);
  const J1 = g.node(add(g0, t1, 15.5 * k), 'junction');
  const Q = g.node([0, fQ], 'pier');
  const j1 = g.at(J1), q0 = g.at(Q);
  g.chain([G0, { n: J1, t: t1, g: GJ }, { n: Q, t: [0, 1], g: GJ }], { kind: 'street', name: `${t.name} lane`, hermite: true });
  // the chapel row: off west, curving up the slope and round onto the quay's west end; the quay past
  // the slip and round the harbour's end up onto the cliff
  const xw = -Math.min(13.5 * k, Math.sqrt(Math.max(0, (P - 4.2) ** 2 - (fQ - 7) ** 2)));
  const xe = Math.min(13.5 * k, Math.sqrt(Math.max(0, (P - 4.2) ** 2 - (fQ - 7) ** 2)));
  const CL = g.node(X(17, -2.5), 'end');
  g.chain([{ n: J1, t: left(t1), g: GJ }, { p: [xw, fQ - 7], t: [0, 1] }, { p: [xw + 7, fQ], t: [1, 0] }, { n: Q, t: [1, 0], g: GJ }], { kind: 'lane', name: 'chapel row', hermite: true });
  g.chain([{ n: Q, t: [1, 0], g: GJ }, { p: [xe - 7, fQ], t: [1, 0] }, { p: [xe, fQ - 7], t: [0, -1] }, CL], { kind: 'lane', name: 'cliff lane', hermite: true });
  // the rope walk: straight down the slope east from the crossing to the boatyard
  const RW = g.node(add(j1, right(t1), 16.5 * k), 'end');
  g.chain([{ n: J1, t: right(t1), g: GJ }, RW], { kind: 'lane', name: 'rope walk', hermite: true });
  void laneA;
  void laneB;
  return g.finish([G0], { square: { s: 7 * k, f: 1 * k, r: 3.4 }, quay: quayLine(P, fq), pier: { node: Q, s: q0[0], f: fq }, yards: [{ node: RW, kind: 'boat' }, { node: CL, kind: 'lookout' }] }, m);
}

/**
 * Bay village (harbour variant 2: driftwood), laid out with its second gate on −s (finish mirrors it):
 * the top street arches across the back of the village from gate to gate, the high street drops
 * from its crown straight down to the pier head, and the strand runs the waterfront from the net
 * lofts' turning circle past the pier to the boatyard, where boat lane climbs the east side to its
 * turning circle under the hill.
 */
function bay(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const j = jitter(t.name, t.vary);
  const k = P / 26;
  const fq = t.cut?.f ?? P * 0.7;
  const fQ = fq - QUAY_SET;
  const two = t.exits.length > 1;
  const m = two && Math.sin(t.exits[1]) > 0 ? -1 : 1;
  const ex = t.exits.map((a) => a * m);
  const X = (s: number, f: number): P => [s * k, f * k];
  const g = new Plan();
  // gates on the back rim toward their bearings (the second on −s)
  const a0 = clamp(Math.abs(wrapA(ex[0])), 0.62 * Math.PI, 0.86 * Math.PI);
  const G0 = g.node(rim(a0, P - GATE_INSET), 'town-gate');
  const a1 = two ? -clamp(Math.abs(wrapA(ex[1])), 0.62 * Math.PI, 0.86 * Math.PI) : -0.75 * Math.PI;
  const G1 = two ? g.node(rim(a1, P - GATE_INSET), 'town-gate') : g.node(rim(a1, P - END_INSET), 'end');
  // the back lane: in from the west gate along the hill behind the village, past the high street's head
  // and the east road's corner, round down boat lane to the boatyard and back west along the strand,
  // past the pier head, round up the west side to the net lofts
  const Q = g.node([-4.5 * k, fQ], 'pier');
  const g1 = g.at(G1), q1 = g.at(Q), g0 = g.at(G0);
  // (on the line from the west gate to the pier head; the east one on the line from the east gate, the
  // back lane square to both, its bend between their straight arms)
  const fJ = -8 * k;
  const GJ = 6;
  const J2 = g.node([g1[0] + ((q1[0] - g1[0]) * (fJ - g1[1])) / (q1[1] - g1[1]), fJ], 'junction');
  const J = g.node(X(6 + 0.3 * j(1), -8.5), 'junction');
  const j2 = g.at(J2), jj = g.at(J);
  const tJ = unit(jj[0] - g0[0], jj[1] - g0[1]);
  const tB = right(tJ);
  // (boat lane: straight off the junction, round a 7 m bend to run north up the east side)
  const CB = 7;
  const xe = jj[0] + GJ * tB[0] + CB * (1 - tB[1]);
  const fe = jj[1] + GJ * tB[1] + CB * tB[0];
  const xw = -Math.min(18 * k, Math.sqrt(Math.max(0, (P - 4.3) ** 2 - (fQ - 7) ** 2)));
  const WE = g.node(X(-18.6, -1), 'end');
  const CR = 7;
  // the high street: in from the west gate straight down through the back lane's corner to the pier head
  const tU = unit(q1[0] - g1[0], q1[1] - g1[1]);
  g.chain([G1, { n: J2, t: tU, g: GJ }, { n: Q, t: [0, 1], g: GJ }], { kind: 'street', name: 'high street', hermite: true, dirA: tU, leadA: 3 });
  // the back lane: off east along the hill behind the village, past the east road's corner, round down
  // boat lane to the boatyard and back west along the strand past the pier head, round up the west side
  // to the net lofts
  g.chain([{ n: J2, t: right(tU), g: GJ }, { n: J, t: tB, g: GJ }], { kind: 'lane', name: 'back lane', hermite: true });
  g.chain([{ n: J, t: tB, g: GJ }, { p: [xe, fe], t: [0, 1] }, { p: [xe, fQ - CR], t: [0, 1] }, { p: [xe - CR, fQ], t: [-1, 0] }, { n: Q, t: [-1, 0], g: GJ }], { kind: 'street', name: 'the strand', hermite: true });
  g.chain([{ n: Q, t: [-1, 0], g: GJ }, { p: [xw + CR, fQ], t: [-1, 0] }, { p: [xw, fQ - CR], t: [0, -1] }, WE], { kind: 'lane', name: 'net loft lane', hermite: true });
  // the east road in from its gate, straight to the back lane
  g.chain([G0, { n: J, t: tJ, g: GJ }], { kind: 'street', name: 'top street', hermite: true });
  void j2;
  const q0 = g.at(Q);
  return g.finish(two ? [G0, G1] : [G0], { square: { s: q0[0] + 9.5 * k, f: fQ - 9, r: 3.2 }, quay: quayLine(P, fq), pier: { node: Q, s: q0[0], f: fq }, yards: [{ node: WE, kind: 'boat' }] }, m);
}

/**
 * Farm village (variant 0: millbrook): strung along its winding lane. In from the back gate, bending
 * one way to the crossroads where the farm lanes leave for the yards (one long, curling back, one
 * short), bending back the other way to the green, where the lane runs on as the through road and the
 * top road leaves square to it. Laid out bending right first (finish mirrors it).
 */
function farmLane(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const j = jitter(t.name, t.vary);
  const k = P / 26;
  const g = new Plan();
  // (the through road continues the lane toward the first of the two through exits by size of turn;
  // laid out with it on −s)
  const ex0 = t.exits.slice(1);
  const m = ex0.length && Math.sin(ex0[0]) > 0 ? -1 : 1;
  const ex = t.exits.map((a) => a * m);
  const [laneA, laneB] = pick2(POOL.farm, t.variant ?? 0);
  const X = (s: number, f: number): P => [s * k, f * k];
  const G0 = g.node(rim(backAngle(ex[0], 0.4), P - GATE_INSET), 'town-gate');
  const J1 = g.node(X(2.5 + 0.4 * j(1), -11.5), 'junction');
  const J2 = g.node(X(-3, 4.2), 'junction');
  const thr = ex.slice(1);
  const wE = thr.find((a) => Math.sin(a) < 0);
  const eE = thr.find((a) => Math.sin(a) >= 0);
  const GW = g.node(rim(wE !== undefined ? -clamp(Math.abs(wrapA(wE)), 0.26 * Math.PI, 0.42 * Math.PI) : -0.34 * Math.PI, wE !== undefined ? P - GATE_INSET : P - END_INSET), wE !== undefined ? 'town-gate' : 'end');
  const GE = g.node(rim(eE !== undefined ? clamp(Math.abs(wrapA(eE)), 0.2 * Math.PI, 0.36 * Math.PI) : 0.3 * Math.PI, eE !== undefined ? P - GATE_INSET : P - END_INSET), eE !== undefined ? 'town-gate' : 'end');
  const tJ1 = unit(0.12, 1);
  const tJ2 = unit(-0.65, 0.76);
  const gw = g.at(GW), ge = g.at(GE);
  // the lane: in from the gate through the crossroads and past the green, on as the west road
  g.chain([G0, { n: J1, t: tJ1, g: 5 }, { n: J2, t: tJ2, g: 5 }, GW], { kind: 'street', name: (i) => (i < 2 ? `${t.name} lane` : `${t.name} west road`), ...(g.nodes[GW].place === 'town-gate' ? { leadB: 3, dirB: unit(gw[0], gw[1]) } : {}), hermite: true });
  // the top road: square off the lane at the green, curving round to its gate
  g.chain([{ n: J2, t: right(tJ2), g: 5 }, GE], { kind: 'street', name: `${t.name} top road`, ...(g.nodes[GE].place === 'town-gate' ? { leadB: 3, dirB: unit(ge[0], ge[1]) } : {}), hermite: true });
  // farm lanes from the crossroads, square to the lane: the barn lane west, curling back toward the
  // gate's side; the orchard lane out east, climbing to the yard on the rise
  const DW = g.node(X(-15, -10.5), 'end');
  const DE = g.node(X(18, -4.5), 'end');
  g.chain([{ n: J1, t: left(tJ1), g: 6 }, DW], { kind: 'lane', name: laneA, hermite: true });
  g.chain([{ n: J1, t: turn(right(tJ1), 3.5), g: 5 }, DE], { kind: 'lane', name: laneB, hermite: true });
  const exits = [G0];
  for (const a of thr) exits.push(Math.sin(a) < 0 ? GW : GE);
  return g.finish(exits, { square: { s: -4 * k, f: 15.5 * k, r: 4 }, yards: [{ node: DW, kind: 'farm' }, { node: DE, kind: 'farm' }] }, m);
}

/**
 * Green village (farm variant 1: clover), laid out with its road out on +s (finish mirrors it): the road
 * in from the back gate comes up to the green's foot, where green lane runs along its south side to the
 * road out; the church lane climbs its west side and bends round to the church on the rise, the pond
 * lane its east side to the duck pond. The green is the village's open middle (T1 keeps it free), open
 * to the fields on the north; the houses face it and its lanes.
 */
function greenVillage(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const j = jitter(t.name, t.vary);
  const k = P / 28;
  const g = new Plan();
  const two = t.exits.length > 1;
  const m = two && Math.sin(t.exits[1]) < 0 ? -1 : 1;
  const ex = t.exits.map((a) => a * m);
  const X = (s: number, f: number): P => [s * k, f * k];
  const G0 = g.node(rim(backAngle(ex[0], 0.3), P - GATE_INSET), 'town-gate');
  const a1 = two ? clamp(Math.abs(wrapA(ex[1])), 0.32 * Math.PI, 0.62 * Math.PI) : 0.45 * Math.PI;
  const G1 = two ? g.node(rim(a1, P - GATE_INSET), 'town-gate') : g.node(rim(a1, P - END_INSET), 'end');
  // the village green, ringed by its lanes: the road in from the back gate meets green lane at the
  // green's foot (the farm lane runs off west to the farmyard there); green lane runs along its south
  // side to the road out; church lane climbs its west side round past the church at its head and down
  // its east side as pond lane, back to the road out
  const A = g.node(X(-3.5 + 0.5 * j(1), -8.5), 'junction');
  const B = g.node(X(15, -2.5), 'junction');
  const CH = g.node(X(3.5, 15), 'square');
  // (green lane meets the road out at B heading straight for the second gate: no bend in B's patch)
  const GJ = 6;
  const aa = g.at(A), bb = g.at(B), gg1 = g.at(G1);
  // (one even arc between A and B: B's tangent the mirror of A's about the chord, B placed so it heads
  // nearly straight for the second gate)
  const aA = Math.atan2(0.3, 1);
  const aB = 2 * Math.atan2(bb[1] - aa[1], bb[0] - aa[0]) - aA;
  void gg1;
  g.chain([{ n: A, t: [Math.cos(aA), Math.sin(aA)], g: GJ }, { n: B, t: [Math.cos(aB), Math.sin(aB)], g: GJ }], { kind: 'street', name: 'green lane', hermite: true });
  const tA = g.tan(A), tB = g.tan(B);
  // the road in: from the back gate up to the green's foot
  g.chain([G0, { n: A, t: left(tA), g: GJ }], { kind: 'street', name: `${t.name} road`, hermite: true });
  // the road out: on from green lane's east end, out to the second gate
  g.chain([{ n: B, t: tB, g: GJ }, G1], { kind: 'street', name: two ? 'long lane' : 'mill lane', hermite: true, ...(two ? { dirB: turn(unit(g.at(G1)[0], g.at(G1)[1]), -20), leadB: 3 } : { dirB: unit(g.at(G1)[0], g.at(G1)[1]), leadB: 2 }) });
  // round the green: church lane up its west side to the church, pond lane down its east side (an oval
  // round the green: unpinned, the fairing keeps its 1 m curvature smooth for the lanes' traffic lanes)
  const ov = (phi: number): Item => ({ p: X(3.5 - 10 * Math.cos(phi), 3 + 12 * Math.sin(phi)), t: unit(10 * Math.sin(phi), 12 * Math.cos(phi)) });
  g.chain([{ n: A, t: left(tA), g: GJ }, ov(0.4), ov(0.95), { n: CH, t: [1, 0], g: 0 }, ov(2.2), ov(2.75), { n: B, t: right(tB), g: GJ }], { kind: 'lane', name: (i) => (i === 0 ? 'church lane' : 'pond lane'), hermite: true });
  // the farm lane: west from the green's foot to the farmyard
  const [laneA] = pick2(POOL.farm, t.variant ?? 1);
  const BY = g.node(X(-20.5, -8), 'end');
  g.chain([{ n: A, t: neg(tA), g: GJ }, BY], { kind: 'lane', name: laneA, hermite: true });
  return g.finish(two ? [G0, G1] : [G0], { square: { s: 4.5 * k, f: 3 * k, r: 5.4 }, yards: [{ node: BY, kind: 'farm' }] }, m);
}

/**
 * Alpine village (snowberry): on its slope (the pad's plane rises along +f toward the peaks), the high
 * street climbs from the gate at its foot round onto the lower terrace, out to a hairpin at one end,
 * back along the long middle terrace to a wider hairpin at the other end, and along the top terrace
 * under the rock to the chapel square; the chapel steps climb straight up between the middle terrace
 * and the top one. Laid out with the first hairpin on +s (finish mirrors it).
 */
function alpine(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const j = jitter(t.name, t.vary);
  const g = new Plan();
  const m = Math.sin(t.exits[0]) >= 0 ? -1 : 1; // the first hairpin away from the gate's lean
  const ga = backAngle(t.exits[0] * m, 0.12);
  const k = P / 26;
  const X = (s: number, f: number): P => [s * k, f * k];
  const G0 = g.node(rim(ga, P - GATE_INSET), 'town-gate');
  // the terraces (along the contours, f const): 13 m between the lower and middle ones (a 6.5 m
  // hairpin), 16 between the middle and top ones (an 8 m hairpin, the chapel steps between)
  const f0 = -13.5 * k,
    f1 = 0,
    f2 = 17 * k;
  const r1 = (f1 - f0) / 2,
    r2 = (f2 - f1) / 2;
  const hx1 = 12 * k,
    hx2 = -12 * k;
  /** A hairpin's points round its centre (x, fc), radius r, on x's side, from its foot up to its head. */
  const pin = (x: number, fc: number, r: number, n: number): P[] => {
    const out: P[] = [];
    const sx = Math.sign(x);
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / n;
      out.push([x + sx * Math.cos(a) * r, fc + Math.sin(a) * r]);
    }
    return out;
  };
  const J1 = g.node([-6 * k + 0.3 * j(1), f1], 'junction');
  const J2 = g.node([g.at(J1)[0], f2], 'junction');
  const SQ = g.node([11 * k, f2 - 1 * k], 'square');
  const g0 = g.at(G0);
  // the high street round onto the lower terrace (a bend, r 7), along it, the first hairpin, the middle
  // terrace back past the steps' foot, the second hairpin, the top terrace to the steps' head
  const bend = cornerArc(add(g0, [0, 1], 3), [0, 1], [0, f0], [1, 0], 7 * k);
  g.chain([G0, ...bend, [hx1 - 4 * k, f0], ...pin(hx1, f0 + r1, r1, 12), { n: J1, t: [-1, 0], g: 4 }, ...pin(hx2, f1 + r2, r2, 14), { n: J2, t: [1, 0], g: 4 }], {
    kind: 'street',
    name: (i) => (i === 0 ? `${t.name} high street` : 'middle terrace'),
    leadA: 2.5,
    dirA: [0, 1],
  });
  g.chain([{ n: J2, t: [1, 0] }, SQ], { kind: 'street', name: 'top terrace', leadB: 3, dirB: [1, 0] });
  // the chapel steps straight up between the middle and top terraces (square to both)
  g.chain([{ n: J1, t: [0, 1] }, { n: J2, t: [0, 1] }], { kind: 'lane', name: 'chapel steps' });
  // chalet lane: down from the steps' foot (the middle terrace's crossing), round west along the
  // contour below it to the chalets at the village's foot
  const [laneA] = pick2(POOL.alpine, t.variant ?? 0);
  // (straight down ≥ 6.5 m, clear of the crossing's patch, round a 5 m bend and straight ≥ 5 m into
  // the chalets' turning circle: a lane curving into its dead end swells the circle)
  const CL = g.node(X(-16.8, -11.4), 'end');
  {
    const j1 = g.at(J1);
    g.chain([J1, [j1[0], -11.4 * k], CL], { kind: 'lane', name: laneA, fillet: 5 });
  }
  // (the first edge carries the high street, the lower terrace and the middle terrace's east half:
  // name the long climb by where it runs)
  g.edges[0].name = 'lower terrace';
  return g.finish([G0], { square: { s: g.at(SQ)[0], f: g.at(SQ)[1], r: 3.6 }, yards: [{ node: CL, kind: 'chalet' }] }, m);
}

/**
 * Resort (coral cove), laid out with its gate on −s (finish mirrors it): the beach promenade follows the
 * crescent (the pad's bite; the beach below it) from the lido's turning circle past the pier, round
 * the east end and up sunset hill to the hotel row; the palm avenue comes in from the bridge on the
 * diagonal, crosses the hotel row at the fountain and runs on down to the pier; the hotel row's west
 * arm curls up to the villas' turning circle. One block (the grand hotels, between the promenade, the
 * avenue, the row and the hill), the rest open to the beach and the gardens.
 */
function resort(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const j = jitter(t.name, t.vary);
  const k = P / 25;
  const fc = t.cut?.f ?? P * 0.55;
  const rb = Number.isFinite(t.cut?.r ?? NaN) ? t.cut!.r : P * 1.5;
  const bc = fc + rb; // the bite's centre on the axis
  // (v2 R2 refine 2: the promenade hugs the beach, its sidewalk's outer edge 0.5 m from the sand: the
  // critic saw a round grassy island with a sand rim, the street too far behind the crest)
  const rp = rb + PROM_SET;
  const rh = rp + 17 * k; // the hotel row, concentric behind it (the beachfront hotels between)
  const X = (sv: number, fv: number): P => [sv * k, fv * k];
  /** The point at s on the circle of radius r round the bite's centre. */
  const onArc = (r: number, s: number): P => [s, bc - Math.sqrt(Math.max(0, r * r - s * s))];
  /** Along that circle toward +s. */
  const arcDir = (r: number, s: number): P => unit(1, s / Math.sqrt(Math.max(1e-6, r * r - s * s)));
  const g = new Plan();
  const m = Math.sin(t.exits[0]) <= 0 ? 1 : -1;
  // (the gate toward its bearing, within 35° of straight back: the palm avenue runs straight up to the
  // hotel row's west end)
  const ga0 = Math.PI + clamp(wrapA(t.exits[0] * m - Math.PI), -0.25, 0.4);
  const G0 = g.node(rim(ga0, P - GATE_INSET), 'town-gate');
  // (plan points scaled to a 28 m pad: the crescent fixed, the town behind it)
  const k2 = P / 28;
  const Y = (sv: number, fv: number): P => [sv * k2, fv * k2];
  const JW = g.node(Y(-19.5, -10.5), 'junction');
  const J3 = g.node(Y(1 + 0.3 * j(1), -8), 'junction');
  const JE = g.node(Y(18.5, -11), 'junction');
  // (the pier head square to the beach walk's foot: the walk straight down from the hotel row)
  const sP = g.at(J3)[0];
  const PB = g.node(onArc(rp, sP), 'square');
  const GJ = 6;
  const jw = g.at(JW), je = g.at(JE), pb = g.at(PB);
  // the beach promenade's two ends turn (right) round fillets of radius RC tangent to the beach's arc at
  // sA and sB; the lanes up the town's edges run straight from the hotel row's ends to them
  const sA = -16.5 * k2, sB = 16.5 * k2;
  const RC = 6.8;
  const cOf = (sv: number) => add(onArc(rp, sv), right(arcDir(rp, sv)), RC);
  /** The tangent from point a to the circle (c, RC): the circle on the right of travel (+1) or on its left (−1). */
  const tangentTo = (a: P, c: P, side: 1 | -1): P => {
    const dx = c[0] - a[0], dz = c[1] - a[1];
    const L = Math.hypot(dx, dz);
    const b = Math.asin(Math.min(1, RC / L)) * side;
    return [(dx * Math.cos(b) - dz * Math.sin(b)) / L, (dx * Math.sin(b) + dz * Math.cos(b)) / L];
  };
  const uW = tangentTo(jw, cOf(sA), 1);
  const uE = neg(tangentTo(je, cOf(sB), -1));
  // the palm avenue up from the bridge's gate to the hotel row's west end, on as lido lane round the
  // west edge of the town to the crescent's end
  const g0 = g.at(G0);
  const tW = uW;
  g.chain([G0, { n: JW, t: tW, g: 5 }], { kind: 'street', name: 'palm avenue', hermite: true, dirA: unit(jw[0] - g0[0], jw[1] - g0[1]), leadA: 2 });
  // the hotel row along the back of the beachfront hotels, concentric with the crescent but where it
  // leaves the palm avenue square to it and bends down to meet sunset hill
  const tE = left(uE);
  g.chain([{ n: JW, t: right(tW), g: GJ }, { n: J3, t: [1, 0], g: GJ }, { n: JE, t: tE, g: GJ }], { kind: 'street', name: 'hotel row', hermite: true });
  // the beach promenade: lido lane round the west edge onto the crescent, along the beach past the pier
  // head, round its east end and back down sunset hill along the east edge to the hotel row
  const prom: Item[] = [];
  const arcPt = (sv: number): Item => ({ p: onArc(rp, sv), t: arcDir(rp, sv), pin: true });
  for (let sv = sA + 3; sv < sP - 3.2; sv += 3) prom.push(arcPt(sv));
  prom.push(arcPt(sP - 2), { n: PB, t: arcDir(rp, sP), g: 2 }, arcPt(sP + 2));
  for (let sv = sP + 5; sv < sB - 2; sv += 3) prom.push(arcPt(sv));
  // (each end of the crescent a true corner: the lane up the edge of the town turns ~100° onto the
  // beach's arc; laid as a circular fillet so the promenade hugs the beach right up to it)
  /** A right-turn fillet of radius RC onto (or off) the beach's arc at sv: tangent there to the arc, and to travel direction u before it (entering) or after it (leaving). */
  const corner = (sv: number, u: P, entering: boolean): Item[] => {
    const pa = onArc(rp, sv), da = arcDir(rp, sv);
    const c = add(pa, right(da), RC);
    const tp = add(c, right(u), -RC);
    const [p0, p1] = entering ? [tp, pa] : [pa, tp];
    const a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
    let a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
    while (a1 > a0) a1 -= Math.PI * 2;
    const out: Item[] = [];
    const n = Math.max(2, Math.ceil(((a0 - a1) * RC) / 1.5));
    for (let q = entering ? 0 : 1; q <= (entering ? n - 1 : n); q++) {
      const a = a0 + ((a1 - a0) * q) / n;
      out.push({ p: [c[0] + Math.cos(a) * RC, c[1] + Math.sin(a) * RC], t: [Math.sin(a), -Math.cos(a)], pin: true });
    }
    return out;
  };
  g.chain([{ n: JW, t: tW, g: GJ }, ...corner(sA, uW, true), arcPt(sA), ...prom, arcPt(sB), ...corner(sB, uE, false), { n: JE, t: uE, g: GJ }], {
    kind: 'street',
    name: (i) => (i === 0 ? 'lido lane' : i === 1 ? 'beach promenade' : 'sunset hill'),
    hermite: true,
  });
  // the beach walk down from the hotel row's middle to the pier head
  g.chain([{ n: J3, t: [0, 1], g: GJ }, { n: PB, t: left(arcDir(rp, sP)), g: GJ }], { kind: 'lane', name: 'beach walk', hermite: true });
  // the villa lane: from the hotel row's east end round behind the hotels to its turning circle
  const VL = g.node(Y(2, -20.6), 'end');
  {
    const tv = left(tE);
    g.chain([{ n: JE, t: neg(tv), g: 5.5 }, { p: Y(10.5, -20), t: unit(-1, -0.1) }, VL], { kind: 'lane', name: 'villa lane', hermite: true });
  }
  void je;
  // quay: the promenade's edge along the beach (the bite's curve)
  const quay: number[] = [];
  // (v2 R2 refine 2: the crescent's ends where the bite meets the pad's rim, not the old chord estimate,
  // which ran the quay off the pad)
  const fi = (P * P - rb * rb + bc * bc) / (2 * bc);
  const hb = Math.asin(Math.min(0.999, Math.sqrt(Math.max(0, P * P - fi * fi)) / rb)) - 0.6 / rb;
  for (let q = 0; q <= 24; q++) {
    const a = -hb + (2 * hb * q) / 24;
    quay.push(Math.sin(a) * rb, bc - Math.cos(a) * rb);
  }
  // the pier: out from the beach walk's foot, across the sand and over the bay (the ferry's berth)
  const pr = Math.hypot(pb[0], pb[1] - bc) || 1;
  const pq: P = [pb[0] * (rb / pr), bc + (pb[1] - bc) * (rb / pr)];
  return g.finish([G0], { square: { s: -8 * k2, f: (pb[1] + jw[1]) / 2 + 1, r: 3.4 }, quay, pier: { node: PB, s: pq[0], f: pq[1] }, yards: [{ node: VL, kind: 'villa' }] }, m);
}

/** The metro's boulevard carriageway (m). */
const BOULEVARD_W = 7.6;

/**
 * Metro (far haven): a fan of curving avenues round its harbour. The avenues (ferry street, market
 * street, park row) are arcs round a point out in the bay (O, 36 m off the docks), so they visibly
 * arc (ferry and market street ≤ 70 m radius); the streets across them run on the fan's radial lines,
 * square to every avenue, unequally spaced (the blocks taper toward the water and differ: 17, 17 and
 * 22 m deep). Only the boulevard runs right down to the docks, to the pier head on the harbour front
 * (the dock blocks either side of it are the warehouses); the harbour front turns up at its east end into
 * the east avenue (its west end the fish market's turning circle); the boulevard curves on out of the fan to the back gate; the airport road
 * leaves the west avenue's head on the diagonal; the crescent sweeps round the east from the east
 * avenue's head down to park row. Laid out with the side road on −s (finish mirrors it).
 */
function metro(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const j = jitter(t.name, t.vary);
  const k = P / 54;
  const fq = t.cut?.f ?? P * 0.8;
  const fW = fq - QUAY_SET; // the harbour front
  const g = new Plan();
  const isBack = (a: number) => Math.abs(wrapA(a - Math.PI)) <= 0.32;
  const sideEx = t.exits.slice(1).find((a) => !isBack(a));
  const m = sideEx !== undefined && Math.sin(sideEx) > 0 ? -1 : 1;
  const ex = t.exits.map((a) => a * m);
  const O: P = [3 * k, fW + 33 * k];
  const pol = (rho: number, deg: number): P => {
    const a = (deg * Math.PI) / 180;
    return [O[0] + Math.sin(a) * rho, O[1] - Math.cos(a) * rho];
  };
  /** Along an arc round O, toward +s. */
  const arcT = (deg: number): P => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  /** Along a radial, inland (away from O). */
  const radT = (deg: number): P => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];
  // (park row: a flatter arc round a centre farther out in the bay: its blocks deepen toward the sides)
  const r1 = 52.2 * k, r2 = r1 + 18.6 * k, r3 = r2 + 25 * k;
  const O3: P = O;
  const pol3 = (rho: number, deg: number): P => {
    const a = (deg * Math.PI) / 180;
    return [O3[0] + Math.sin(a) * rho, O3[1] - Math.cos(a) * rho];
  };
  // the radial lines: the west avenue, tram street, the boulevard, mint street, the east avenue
  const aWa = -41, aT = -22.5, aB = 0, aM = 21, aEa = 38.8;
  // (an avenue runs straight GA m either side of a crossing (park row GK), so the corners there are
  // the right angles they were laid at: a street corner's patch, not a plaza)
  const GA = 6.5, GK = 6;
  const C0 = g.node([O[0], fW], 'pier');
  const F = [aWa, aT, aB, aM, aEa].map((a) => g.node(pol(r1, a), 'junction'));
  // (market street curves round its own centre, west of the fan's: the blocks between it and ferry
  // street are deep in the west of the fan and shallow in the east, none the twin of another)
  const O2: P = [O[0] - 3.6 * k, O[1]];
  const onM = (a: number): P => {
    // the point on radial a (round O) at distance r2 from O2
    const d = radT(a);
    const ox = O[0] - O2[0], oz = O[1] - O2[1];
    const b = ox * d[0] + oz * d[1];
    const t = -b + Math.sqrt(Math.max(0, b * b - (ox * ox + oz * oz) + r2 * r2));
    return [O[0] + d[0] * t, O[1] + d[1] * t];
  };
  const angM = (q: P) => (Math.atan2(q[0] - O2[0], O2[1] - q[1]) * 180) / Math.PI;
  const M = [aWa, aT, aB, aM, aEa].map((a) => g.node(onM(a), 'junction'));
  // park row's junctions: where the radials meet it (its own arc round O3)
  const onK = (a: number): P => {
    // the point on radial a (round O) at distance r3 from O3
    let lo = r2 + 5 * k, hi = r2 + 40 * k;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      const q = pol(mid, a);
      if (Math.hypot(q[0] - O3[0], q[1] - O3[1]) < r3) lo = mid;
      else hi = mid;
    }
    return pol(lo, a);
  };
  const angK = (q: P) => (Math.atan2(q[0] - O3[0], O3[1] - q[1]) * 180) / Math.PI;
  const Kw = g.node(onK(aWa + 10.5), 'junction');
  const Kt = g.node(onK(aT), 'junction');
  const Kc = g.node(onK(aB + 1.5 * j(1)), 'junction');
  const Km = g.node(onK(aM), 'junction');
  // (the school lane's corner on park row, halfway round from tram street to the boulevard)
  const Ks = g.node(onK((aT + aB) / 2 - 0.5), 'junction');
  // the harbour front: from the west avenue's foot round along the docks to the pier head and on round
  // to the east avenue's foot (square onto ferry street at both: the avenues carry on up)
  // (the corners where the avenues' radial lines meet the docks' line)
  const toDocks = (a: number): P => {
    const q = pol(r1, a);
    const d = neg(radT(a));
    return add(q, d, (fW - q[1]) / d[1]);
  };
  // (the west end: the fish market's turning circle on the quay; the east end turns up the east avenue)
  const WE = g.node([-24.5 * k, fW], 'end');
  g.chain([WE, { n: C0, t: [1, 0], g: 7 }, toDocks(aEa), F[4]], { kind: 'street', name: (i) => (i === 0 ? 'harbour front' : 'quay parade'), fillet: 6.5 });
  void toDocks(aWa);
  // the avenues across the fan
  const arcPts = (rhoF: number | ((a: number) => number), a0: number, a1: number, clear = 4.5): P[] => {
    const out: P[] = [];
    const rhoOf = typeof rhoF === 'number' ? () => rhoF : rhoF;
    const rho = rhoOf((a0 + a1) / 2);
    const L = (Math.abs(a1 - a0) * Math.PI * rho) / 180;
    const n = Math.max(2, Math.round(L / 3.5));
    for (let i = 1; i < n; i++) {
      const u = i / n;
      if (u * L < clear || (1 - u) * L < clear) continue;
      out.push(pol(rhoOf(a0 + (a1 - a0) * u), a0 + (a1 - a0) * u));
    }
    return out;
  };
  const avenue = (rho: number | ((a: number) => number), nodes: number[], angs: number[], name: string) => {
    const items: Item[] = [];
    nodes.forEach((nd, i) => {
      items.push({ n: nd, t: arcT(angs[i]), g: GA });
      if (i + 1 < nodes.length) items.push(...arcPts(rho, angs[i], angs[i + 1], GA + 1.5));
    });
    g.chain(items, { kind: 'street', name });
  };
  avenue(r1, F, [aWa, aT, aB, aM, aEa], 'ferry street');
  {
    const items: Item[] = [];
    M.forEach((nd, i) => {
      const a = angM(g.at(nd));
      // (square across the radial street it crosses, though it curves round its own centre between)
      items.push({ n: nd, t: arcT([aWa, aT, aB, aM, aEa][i]), g: GA });
      if (i + 1 < M.length) {
        const a1 = angM(g.at(M[i + 1]));
        const L = (Math.abs(a1 - a) * Math.PI * r2) / 180;
        const n = Math.max(2, Math.round(L / 3.5));
        for (let q = 1; q < n; q++) if ((q / n) * L > GA + 1.5 && (1 - q / n) * L > GA + 1.5) {
          const aa = ((a + ((a1 - a) * q) / n) * Math.PI) / 180;
          items.push([O2[0] + Math.sin(aa) * r2, O2[1] - Math.cos(aa) * r2]);
        }
      }
    });
    g.chain(items, { kind: 'street', name: 'market street' });
  }
  {
    const ks = [Kw, Kt, Ks, Kc, Km];
    const items: Item[] = [];
    ks.forEach((nd, i) => {
      const a = angK(g.at(nd));
      items.push({ n: nd, t: arcT(a), g: GK });
      if (i + 1 < ks.length) {
        const a1 = angK(g.at(ks[i + 1]));
        const L = (Math.abs(a1 - a) * Math.PI * r3) / 180;
        const n = Math.max(2, Math.round(L / 3.5));
        for (let q = 1; q < n; q++) if ((q / n) * L > GK + 1.5 && (1 - q / n) * L > GK + 1.5) items.push(pol3(r3, a + ((a1 - a) * q) / n));
      }
    });
    g.chain(items, { kind: 'street', name: 'park row' });
  }
  // the streets up the radials (square to every avenue)
  const radial = (nodes: number[], a: number, name: string, width?: number) => g.chain(nodes.map((nd) => ({ n: nd, t: radT(a), g: 2.5 })), { kind: 'street', name, width });
  // (the west avenue stops at market street: park row's west end turns out of the city as the airport road)
  g.chain([{ n: F[0], t: radT(aWa), g: 2.5 }, { n: M[0], t: radT(aWa), g: 2.5 }], { kind: 'street', name: 'west avenue' });
  radial([F[1], M[1], Kt], aT, 'tram street');
  radial([C0, F[2], M[2], Kc], aB, 'the boulevard', BOULEVARD_W);
  radial([F[3], M[3], Km], aM, 'mint street');
  void radT;
  radial([F[4], M[4]], aEa, 'east avenue');
  // the school lane: off park row, out toward the back of the pad (square to park row)
  let SE = -1;
  {
    const ks = g.at(Ks);
    const out = unit(ks[0] - O3[0], ks[1] - O3[1]);
    SE = g.node(add(ks, out, 17.2 * k), 'end');
    g.chain([{ n: Ks, t: out, g: 5 }, SE], { kind: 'lane', name: 'school lane', hermite: true });
  }
  // the crescent: from the east avenue's head sweeping round the east and down to park row's end
  {
    // (round inside the pad's rim, its curb a metre in from the edge)
    const pm = g.at(M[4]), pk = g.at(Km);
    const am = Math.atan2(pm[0], pm[1]), ak = Math.atan2(pk[0], pk[1]);
    const mid = am + wrapA(ak - am) * 0.45;
    g.chain([{ n: M[4], t: radT(aEa), g: 5.5 }, rim(mid, P - 5.6), { n: Km, t: neg(arcT(angK(pk))), g: 5 }], { kind: 'street', name: 'the crescent', hermite: true });
  }
  // gates
  const exits: number[] = [C0];
  let back = -1;
  let side = -1;
  for (const b of ex.slice(1)) {
    if (isBack(b)) {
      if (back < 0) {
        back = g.node(rim(Math.PI + clamp(wrapA(b - Math.PI), -0.3, 0.3), P - GATE_INSET), 'town-gate');
        g.chain([{ n: Kc, t: radT(aB + 1.5 * j(1)), g: 9 }, back], { kind: 'street', name: 'the boulevard', width: BOULEVARD_W, fillet: 30 });
      }
      exits.push(back);
      continue;
    }
    if (side < 0) {
      // (straight on out of park row's west end along the fan's radial line: the airport road leaves
      // the city on the diagonal and the region road turns for the airport outside)
      const dK = radT(angK(g.at(Kw)));
      side = g.node(rayRim(g.at(Kw), dK, P - GATE_INSET), 'town-gate');
      // (all on the one line: its guide and the gate's lead must not overlap, or the street doubles back)
      const runK = Math.hypot(g.at(side)[0] - g.at(Kw)[0], g.at(side)[1] - g.at(Kw)[1]);
      g.chain([{ n: Kw, t: dK, g: Math.max(0.5, Math.min(6, runK - 5.5)) }, side], { kind: 'street', name: 'airport road', fillet: 22, dirB: dK, leadB: Math.min(5, runK * 0.45) });
      void b;
    }
    exits.push(side);
  }
  if (back < 0) {
    const pk = g.node([g.at(Kc)[0], -P + END_INSET], 'end');
    g.chain([{ n: Kc, t: radT(aB), g: 6 }, pk], { kind: 'street', name: 'park gate', width: BOULEVARD_W, fillet: 30 });
  }
  const quay = quayLine(P, fq);
  const sq = pol((r1 + r2) / 2, (aB + aM) / 2);
  return g.finish(exits, { square: { s: sq[0], f: sq[1], r: 4.2 }, quay, pier: { node: C0, s: g.at(C0)[0], f: fq }, yards: [{ node: WE, kind: 'market' }, { node: SE, kind: 'school' }] }, m);
}

/**
 * A plan's geometry problems (empty when it is sound): junction arms closer than `minGap` (rad,
 * measured 3 and 5 m out), nodes closer than the network needs along an edge, corners tighter than
 * 6.5 m. For the specs and the builder's debug log.
 */
export function checkPlan(plan: TownPlan, minGap = ARM_GAP): string[] {
  const out: string[] = [];
  const armPt = (e: PlanEdge, fromA: boolean, m: number): P => {
    const pts = e.pts;
    const n = pts.length / 2;
    let acc = 0;
    for (let k = 1; k < n; k++) {
      const i = fromA ? k : n - 1 - k;
      const j2 = fromA ? k - 1 : n - k;
      acc += Math.hypot(pts[i * 2] - pts[j2 * 2], pts[i * 2 + 1] - pts[j2 * 2 + 1]);
      if (acc >= m) return [pts[i * 2], pts[i * 2 + 1]];
    }
    return fromA ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[0], pts[1]];
  };
  plan.nodes.forEach((nd, id) => {
    // (at 3 m and at 5 m out, the patch's edge: a street curving inside a junction's patch skews its arms)
    for (const at of [3, 5]) {
      const angs: Array<{ a: number; e: string }> = [];
      for (const e of plan.edges) {
        for (const fromA of [true, false]) {
          if ((fromA ? e.a : e.b) !== id) continue;
          const q = armPt(e, fromA, at);
          angs.push({ a: Math.atan2(q[1] - nd.f, q[0] - nd.s), e: e.name });
        }
      }
      if (angs.length < 3) return;
      angs.sort((p, q) => p.a - q.a);
      for (let i = 0; i < angs.length; i++) {
        let gap = angs[(i + 1) % angs.length].a - angs[i].a;
        if (gap <= 0) gap += Math.PI * 2;
        if (gap < minGap) {
          out.push(`node ${id} (${nd.place}): ${angs[i].e} / ${angs[(i + 1) % angs.length].e} ${((gap * 180) / Math.PI).toFixed(0)}° at ${at} m`);
          return;
        }
      }
    }
  });
  for (const e of plan.edges) {
    const n = e.pts.length / 2;
    let L = 0;
    for (let k = 1; k < n; k++) L += Math.hypot(e.pts[k * 2] - e.pts[k * 2 - 2], e.pts[k * 2 + 1] - e.pts[k * 2 - 1]);
    // (centre to centre: each end's patch — a junction's ≈ its widest arm's lane offset + RHO_TOWN or
    // its curb corner, a dead end's turning circle ≈ 6 m, a gate's bend ≈ 0.6 m — and ≥ 6 m of street
    // between them; a bend between two streets needs nothing)
    const need = patchOf(plan, e.a) + patchOf(plan, e.b) + (patchOf(plan, e.a) > 1 || patchOf(plan, e.b) > 1 ? 6 : 0);
    if (L < need - 0.05) out.push(`edge ${e.name} short: ${L.toFixed(1)} m (needs ${need.toFixed(1)})`);
    // (the circumradius of samples 2 m apart along the street, as region.spec measures it)
    const S: number[] = [0];
    for (let q = 1; q < n; q++) S.push(S[q - 1] + Math.hypot(e.pts[q * 2] - e.pts[q * 2 - 2], e.pts[q * 2 + 1] - e.pts[q * 2 - 1]));
    let j2 = 0,
      k2 = 0;
    // (a lane's traffic lanes are measured 1 m apart in region.spec: so its centre here)
    const span = e.kind === 'lane' ? 1 : 2;
    for (let i = 0; i < n; i++) {
      while (j2 < n && S[j2] - S[i] < span) j2++;
      if (j2 >= n) break;
      k2 = Math.max(k2, j2);
      while (k2 < n && S[k2] - S[j2] < span) k2++;
      if (k2 >= n) break;
      const ax = e.pts[i * 2],
        az = e.pts[i * 2 + 1],
        bx = e.pts[j2 * 2],
        bz = e.pts[j2 * 2 + 1],
        cx = e.pts[k2 * 2],
        cz = e.pts[k2 * 2 + 1];
      const ab = Math.hypot(bx - ax, bz - az),
        bc = Math.hypot(cx - bx, cz - bz),
        ca = Math.hypot(ax - cx, az - cz);
      const ar = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
      // (a lane ≥ 4.7 m: its lane paths, 1.1 m either side, stay over region.spec's 3.5 m)
      if (ar > 1e-9 && (ab * bc * ca) / (2 * ar) < (e.kind === 'lane' ? 4.7 : 6.0)) {
        out.push(`edge ${e.name} tight: r ${((ab * bc * ca) / (2 * ar)).toFixed(1)} at ${bx.toFixed(1)},${bz.toFixed(1)}`);
        break;
      }
    }
  }
  return out;
}

/**
 * The network patch radius (m) a plan node will get, estimated as network.ts sizes it (ROAD widths in
 * build.ts: a street 5.0 m + 1.2 m sidewalks, a lane 4.4 + 1.0, the boulevard 7.6 + 1.2): a junction's
 * the widest arm's lane offset + RHO_TOWN (3.5) or its curb corner (half width + sidewalk + 0.6); a
 * dead end's ≈ 6 m (its U-turn's swing-out); a gate's bend 0.6; a bend between two streets 0.
 */
export function patchOf(plan: TownPlan, id: number): number {
  let n = 0;
  let r = 0;
  for (const e of plan.edges) {
    const k = (e.a === id ? 1 : 0) + (e.b === id ? 1 : 0);
    if (!k) continue;
    n += k;
    const w = e.width ?? (e.kind === 'street' ? 5.0 : 4.4);
    const sw = e.kind === 'street' ? 1.2 : 1.0;
    r = Math.max(r, w / 4 + 3.5, w / 2 + sw + 0.6);
  }
  if (plan.nodes[id].place === 'town-gate') return 0.6;
  // (a dead end's U-turn swing: a street's 6.1, a lane's 5.0 round its smaller circle)
  if (n === 1) return plan.edges.some((e) => (e.a === id || e.b === id) && e.kind === 'street') ? 6.1 : 5.05;
  return n >= 3 ? r : 0;
}

// ── Organic-ness metrics (region.spec; the critic's tests for "not a diagram") ──

/** All street samples of a plan, ~1 m apart (s, f interleaved). */
function samplesOf(plan: TownPlan, step = 1): number[] {
  const out: number[] = [];
  for (const e of plan.edges) {
    let acc = step;
    for (let i = 0; i < e.pts.length; i += 2) {
      if (i > 0) acc += Math.hypot(e.pts[i] - e.pts[i - 2], e.pts[i + 1] - e.pts[i - 1]);
      if (acc >= step || i === e.pts.length - 2) {
        out.push(e.pts[i], e.pts[i + 1]);
        acc = 0;
      }
    }
  }
  return out;
}

/**
 * How far the plan is from being its own mirror image (m): the smallest, over reflection axes through
 * its centroid every 2°, of the directed Hausdorff distance from the reflected street network to the
 * original (how far the worst reflected sample lies from any street). A symmetric racetrack scores ~0.
 */
export function planSymmetry(plan: TownPlan): number {
  const S = samplesOf(plan, 1);
  const n = S.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < S.length; i += 2) {
    cx += S[i];
    cz += S[i + 1];
  }
  cx /= n;
  cz /= n;
  // a coarse grid over the samples for nearest queries
  const CELL = 3;
  const grid = new Map<number, number[]>();
  const key = (x: number, z: number) => Math.floor(x / CELL) * 4099 + Math.floor(z / CELL);
  for (let i = 0; i < S.length; i += 2) {
    const kk = key(S[i], S[i + 1]);
    const b = grid.get(kk);
    if (b) b.push(i);
    else grid.set(kk, [i]);
  }
  const nearest = (x: number, z: number, cap: number) => {
    let best = cap;
    const r = Math.ceil(cap / CELL);
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    for (let a = -r; a <= r; a++)
      for (let b = -r; b <= r; b++) {
        const lst = grid.get((gx + a) * 4099 + gz + b);
        if (!lst) continue;
        for (const i of lst) best = Math.min(best, Math.hypot(S[i] - x, S[i + 1] - z));
      }
    return best;
  };
  let worstBest = Infinity;
  for (let deg = 0; deg < 180; deg += 2) {
    const a = (deg * Math.PI) / 180;
    const ux = Math.cos(a), uz = Math.sin(a);
    let h = 0;
    for (let i = 0; i < S.length && h < worstBest; i += 2) {
      const dx = S[i] - cx, dz = S[i + 1] - cz;
      const along = dx * ux + dz * uz;
      const rx = cx + 2 * along * ux - dx, rz = cz + 2 * along * uz - dz;
      h = Math.max(h, nearest(rx, rz, 12));
    }
    worstBest = Math.min(worstBest, h);
  }
  return worstBest;
}

/**
 * The plan's blocks: the bounded faces of its street graph (each a polygon of street samples, s, f
 * interleaved), with their areas (m²). Dead ends and the gate streets bound nothing.
 */
export function planFaces(plan: TownPlan): Array<{ poly: number[]; area: number }> {
  // half-edges: for each edge both directions; at each node sort outgoing by angle; walk faces by
  // taking, at each arrival, the next outgoing clockwise (the face on the left).
  type HE = { e: number; fwd: boolean; from: number; to: number; ang: number };
  const hes: HE[] = [];
  const angOf = (e: PlanEdge, fromA: boolean) => {
    const p = e.pts;
    const n = p.length / 2;
    const i0 = fromA ? 0 : n - 1;
    const i1 = fromA ? Math.min(n - 1, 4) : Math.max(0, n - 5);
    return Math.atan2(p[i1 * 2 + 1] - p[i0 * 2 + 1], p[i1 * 2] - p[i0 * 2]);
  };
  plan.edges.forEach((e, id) => {
    hes.push({ e: id, fwd: true, from: e.a, to: e.b, ang: angOf(e, true) });
    hes.push({ e: id, fwd: false, from: e.b, to: e.a, ang: angOf(e, false) });
  });
  const outOf = new Map<number, number[]>();
  hes.forEach((h, i) => {
    const l = outOf.get(h.from) ?? [];
    l.push(i);
    outOf.set(h.from, l);
  });
  for (const l of outOf.values()) l.sort((p, q) => hes[p].ang - hes[q].ang);
  const used = new Uint8Array(hes.length);
  const faces: Array<{ poly: number[]; area: number }> = [];
  for (let start = 0; start < hes.length; start++) {
    if (used[start]) continue;
    const poly: number[] = [];
    let cur = start;
    let guard = 0;
    let ok = true;
    while (!used[cur] && guard++ < 400) {
      used[cur] = 1;
      const h = hes[cur];
      const p = plan.edges[h.e].pts;
      const n = p.length / 2;
      for (let q = 0; q < n - 1; q++) {
        const i = h.fwd ? q : n - 1 - q;
        poly.push(p[i * 2], p[i * 2 + 1]);
      }
      // at h.to: the reverse half-edge's angle; take the next outgoing counter-clockwise from it
      const lst = outOf.get(h.to)!;
      const back = hes.findIndex((x) => x.e === h.e && x.fwd !== h.fwd);
      const bi = lst.indexOf(back);
      if (bi < 0) {
        ok = false;
        break;
      }
      cur = lst[(bi - 1 + lst.length) % lst.length];
    }
    if (!ok || cur !== start) continue;
    let area = 0;
    for (let i = 0; i < poly.length; i += 2) {
      const i2 = (i + 2) % poly.length;
      area += poly[i] * poly[i2 + 1] - poly[i2] * poly[i + 1];
    }
    area /= 2;
    // (the outer face winds the other way; dead-end spurs give degenerate tiny faces)
    if (area > 20) faces.push({ poly, area });
  }
  return faces;
}

/**
 * Directed shape distance between two blocks (m): the best, over rotations every 5° and a reflection,
 * of the Hausdorff distance between their outlines with centroids aligned. Two congruent blocks
 * score ~0.
 */
export function faceDistance(a: number[], b: number[]): number {
  const centre = (p: number[]) => {
    let x = 0, z = 0;
    for (let i = 0; i < p.length; i += 2) {
      x += p[i];
      z += p[i + 1];
    }
    return [x / (p.length / 2), z / (p.length / 2)];
  };
  const thin = (p: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < p.length; i += 4) out.push(p[i], p[i + 1]);
    return out;
  };
  const A = thin(a), B = thin(b);
  const [ax, az] = centre(A), [bx, bz] = centre(B);
  let best = Infinity;
  for (const refl of [1, -1]) {
    for (let deg = 0; deg < 360; deg += 5) {
      const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
      const T: number[] = [];
      for (let i = 0; i < B.length; i += 2) {
        const x = (B[i] - bx) * refl, z = B[i + 1] - bz;
        T.push(x * c - z * s, x * s + z * c);
      }
      let h = 0;
      const dir = (P1: number[], P2: number[], ox: number, oz: number) => {
        let hh = 0;
        for (let i = 0; i < P1.length; i += 2) {
          let m = Infinity;
          for (let q = 0; q < P2.length; q += 2) m = Math.min(m, Math.hypot(P1[i] - ox - P2[q], P1[i + 1] - oz - P2[q + 1]));
          hh = Math.max(hh, m);
        }
        return hh;
      };
      h = Math.max(dir(A, T, ax, az), (() => {
        let hh = 0;
        for (let q = 0; q < T.length; q += 2) {
          let m = Infinity;
          for (let i = 0; i < A.length; i += 2) m = Math.min(m, Math.hypot(A[i] - ax - T[q], A[i + 1] - az - T[q + 1]));
          hh = Math.max(hh, m);
        }
        return hh;
      })());
      best = Math.min(best, h);
    }
  }
  return best;
}

/**
 * How unlike two plans are (m): the best, over rotations every 5° and a reflection with centroids
 * aligned, of the symmetric Hausdorff distance between their street networks (samples ~1 m apart). Two
 * towns laid out alike score a metre or two; region.spec asks ≥ 6 m between any two.
 */
export function planDistance(a: TownPlan, b: TownPlan): number {
  const A = samplesOf(a, 1.5), B = samplesOf(b, 1.5);
  const cen = (S: number[]) => {
    let x = 0, z = 0;
    for (let i = 0; i < S.length; i += 2) {
      x += S[i];
      z += S[i + 1];
    }
    return [x / (S.length / 2), z / (S.length / 2)];
  };
  const [ax, az] = cen(A), [bx, bz] = cen(B);
  const CELL = 4;
  const gridOf = (S: number[], cx: number, cz: number) => {
    const g = new Map<number, number[]>();
    for (let i = 0; i < S.length; i += 2) {
      const x = S[i] - cx, z = S[i + 1] - cz;
      const key = Math.floor(x / CELL) * 4099 + Math.floor(z / CELL);
      const l = g.get(key);
      if (l) l.push(x, z);
      else g.set(key, [x, z]);
    }
    return g;
  };
  const GA = gridOf(A, ax, az), GB = gridOf(B, bx, bz);
  const near = (g: Map<number, number[]>, x: number, z: number, cap: number) => {
    let best = cap;
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    const r = Math.ceil(cap / CELL);
    for (let p = -r; p <= r; p++)
      for (let q = -r; q <= r; q++) {
        const l = g.get((gx + p) * 4099 + gz + q);
        if (l) for (let i = 0; i < l.length; i += 2) best = Math.min(best, Math.hypot(l[i] - x, l[i + 1] - z));
      }
    return best;
  };
  const CAP = 24;
  let best = Infinity;
  for (const m of [1, -1]) {
    for (let deg = 0; deg < 360; deg += 5) {
      const c = Math.cos((deg * Math.PI) / 180), sn = Math.sin((deg * Math.PI) / 180);
      let h = 0;
      for (let i = 0; i < B.length && h < best; i += 2) {
        const x = (B[i] - bx) * m, z = B[i + 1] - bz;
        h = Math.max(h, near(GA, x * c - z * sn, x * sn + z * c, CAP));
      }
      for (let i = 0; i < A.length && h < best; i += 2) {
        const x = A[i] - ax, z = A[i + 1] - az;
        // (the inverse turn, then the flip)
        const rx = x * c + z * sn, rz = -x * sn + z * c;
        h = Math.max(h, near(GB, rx * m, rz, CAP));
      }
      best = Math.min(best, h);
    }
  }
  return best;
}

/**
 * v2 (R2 refine): what the region's first build needs of a plan — its nodes, exits, square, quay and
 * pier, and each exit's street direction (a point 2 m back along the street from it) — as numbers, so
 * build.ts can bake it: the streets themselves are planned on the network's first read, off the
 * terrain's first-frame path (planning every town took ~10 ms of a cold page load).
 */
export interface PlanSkeleton {
  nodes: PlanNode[];
  exits: number[];
  square?: { s: number; f: number; r: number };
  quay?: number[];
  pier?: { node: number; s: number; f: number };
  /** Per exit: the point 2 m back along its street (plan s, f), or null when no street ends there. */
  exitBack: Array<[number, number] | null>;
  /** The streets' end nodes (a, b interleaved): the graph's shape before its streets are planned. */
  links: number[];
  /** v2 (R2 refine 2): the dead ends' yards, and whether the street into each is a lane. */
  yards: Array<{ node: number; kind: YardKind; lane: boolean }>;
}

const PLACE_CODES: readonly NodePlace[] = ['gate', 'roundabout', 'town-gate', 'square', 'end', 'pier', 'airport', 'junction', 'bend', 'viewpoint'];
const YARD_CODES: readonly YardKind[] = ['farm', 'boat', 'chalet', 'villa', 'market', 'school', 'lookout'];

/** A plan's skeleton as numbers (skeletonOf reads it back). */
export function planSkeleton(plan: TownPlan): number[] {
  const out: number[] = [plan.nodes.length];
  for (const n of plan.nodes) out.push(n.s, n.f, PLACE_CODES.indexOf(n.place), n.control === 'roundabout' ? 1 : 0);
  out.push(plan.edges.length);
  for (const e of plan.edges) out.push(e.a, e.b);
  out.push(plan.exits.length);
  for (const x of plan.exits) {
    out.push(x);
    let back: [number, number] | null = null;
    for (const e of plan.edges) {
      if (e.a !== x && e.b !== x) continue;
      const p = e.pts;
      const n = p.length / 2;
      const atB = e.b === x;
      let j = atB ? n - 1 : 0;
      const sg = atB ? -1 : 1;
      let L = 0;
      while (j + sg >= 0 && j + sg < n && L < 2) {
        L += Math.hypot(p[(j + sg) * 2] - p[j * 2], p[(j + sg) * 2 + 1] - p[j * 2 + 1]);
        j += sg;
      }
      back = [p[j * 2], p[j * 2 + 1]];
      break;
    }
    out.push(back ? 1 : 0, back ? back[0] : 0, back ? back[1] : 0);
  }
  out.push(plan.square ? 1 : 0, plan.square?.s ?? 0, plan.square?.f ?? 0, plan.square?.r ?? 0);
  out.push(plan.pier ? 1 : 0, plan.pier?.node ?? 0, plan.pier?.s ?? 0, plan.pier?.f ?? 0);
  out.push(plan.quay ? plan.quay.length : -1);
  if (plan.quay) out.push(...plan.quay);
  out.push(plan.yards?.length ?? 0);
  for (const y of plan.yards ?? []) out.push(y.node, YARD_CODES.indexOf(y.kind), plan.edges.some((e) => (e.a === y.node || e.b === y.node) && e.kind === 'lane') ? 1 : 0);
  return out;
}

/** Read a planSkeleton back. */
export function skeletonOf(a: ArrayLike<number>): PlanSkeleton {
  let k = 0;
  const nn = a[k++];
  const nodes: PlanNode[] = [];
  for (let i = 0; i < nn; i++) {
    const n: PlanNode = { s: a[k], f: a[k + 1], place: PLACE_CODES[a[k + 2]] };
    if (a[k + 3]) n.control = 'roundabout';
    nodes.push(n);
    k += 4;
  }
  const nl = a[k++];
  const links: number[] = [];
  for (let i = 0; i < nl * 2; i++) links.push(a[k++]);
  const ne = a[k++];
  const exits: number[] = [];
  const exitBack: Array<[number, number] | null> = [];
  for (let i = 0; i < ne; i++) {
    exits.push(a[k]);
    exitBack.push(a[k + 1] ? [a[k + 2], a[k + 3]] : null);
    k += 4;
  }
  const sk: PlanSkeleton = { nodes, exits, exitBack, links, yards: [] };
  if (a[k]) sk.square = { s: a[k + 1], f: a[k + 2], r: a[k + 3] };
  k += 4;
  if (a[k]) sk.pier = { node: a[k + 1], s: a[k + 2], f: a[k + 3] };
  k += 4;
  const nq = a[k++];
  if (nq >= 0) {
    sk.quay = Array.from({ length: nq }, (_, i) => a[k + i]);
    k += nq;
  }
  const ny = a[k++] ?? 0;
  for (let i = 0; i < ny; i++, k += 3) sk.yards.push({ node: a[k], kind: YARD_CODES[a[k + 1]], lane: !!a[k + 2] });
  return sk;
}
