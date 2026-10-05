// Town street plans (R1): one generator per settlement style, each in the town's own AXIS frame —
// f along its main axis (from its gate inward; a harbour's axis points out to sea), s to the right
// of it, metres on its pad — so build.ts maps them through the settlement's chart. Pure.
//
// What every plan honours (the network turns these into drivable lanes, network.ts):
//   - every street leaves a junction, and runs into a dead end, STRAIGHT for LEAD m (the turn
//     connectors are fillets between the lanes' ends: a street that already bends inside a
//     junction's patch would skew its arms), and curves no tighter than 7 m in between;
//   - junctions are ≥ 14 m apart along a street (their patches are ~5.4 m; edges keep ≥ 2.5 m),
//     their arms ≥ 75° apart; a dead end's turning circle (≈ 6.9 m with its sidewalk) lies inside
//     the pad;
//   - one gate (the first exit) on the pad edge behind the town, f = −(padR − 0.5), and a MAIN
//     street (14 m) in from it to the first junction; a farm village or a harbour may take a second
//     gate (the through road); the metro's exits leave its grid at the requested bearings;
//   - every town has a loop or a square (V2 §3: "a main street, a loop or square, side streets"),
//     and the shapes differ by town, not only by style (the signature spec): a farm village's
//     crossroads with green street up to the loop round the village green, or its fork with two
//     streets round the green to a lane on to the fields; an alpine village's high street climbing
//     past a lane to the one-way loop round the chapel; a harbour's main street down to the pier
//     head on the quay, the quay street along the water and round the harbour block; a resort's
//     one-way promenade round its gardens with a close of villas; the metro's 3 × 3 block grid
//     round its central circus. Lane names come from a pool per town.

import type { NodePlace, SettlementStyle } from './types';

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
}

export interface TownPlan {
  nodes: PlanNode[];
  edges: PlanEdge[];
  /** The exit (gate) node for each requested exit bearing, in order. */
  exits: number[];
  /** The town's open square / green (T1 keeps it free). */
  square?: { s: number; f: number; r: number };
  /** Harbours: the quay line along the water ((s, f) interleaved), and where the pier leaves it. */
  quay?: number[];
  pier?: { node: number; s: number; f: number };
}

export interface TownSpecIn {
  style: Exclude<SettlementStyle, 'capital'>;
  name: string;
  padR: number;
  /**
   * Exit bearings relative to the axis (rad, 0 = +f, +π/2 = +s). The first is the gate, at π. A farm
   * takes a second at 0 or ±π/2 (that lane becomes a street out to a second gate); the metro takes
   * any; the other styles one.
   */
  exits: number[];
  /** 0..1 per-town variation (bends, offsets). */
  vary: number;
  /** Which of its style's shapes and name pools (an index; two towns of one style differ). */
  variant?: number;
}

/** Distance (m) a gate node sits inside the pad edge. */
export const GATE_INSET = 0.5;
/** A dead end's centre lies at least this far inside the pad edge (its turning circle + sidewalk). */
export const END_INSET = 7.3;
/** Straight run (m) out of a junction and into a dead end. */
const LEAD = 7;
/** Every town's main street: in from its gate to its first junction (m). */
export const MAIN = 14;

type P = [number, number];

/** Polyline through control points with every corner rounded by a circular arc of radius r (or radii[i] at corner i; ≤ 0.5 m samples). */
export function filletPoly(ctrl: P[], r: number, radii?: number[]): number[] {
  const out: number[] = [ctrl[0][0], ctrl[0][1]];
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
    const ux = (bx - ax) / l1, uz = (bz - az) / l1;
    const wx = (cx - bx) / l2, wz = (cz - bz) / l2;
    const cr = ux * wz - uz * wx;
    const phi = Math.atan2(Math.abs(cr), ux * wx + uz * wz);
    if (phi < 1e-4) {
      lineTo(bx, bz);
      continue;
    }
    // cut back t along both legs (at most half of either; the first and last legs, which end at no
    // other corner, all but 1 m), the radius to match
    const ri = radii?.[i] ?? r;
    const t = Math.min(ri * Math.tan(phi / 2), i === 1 ? l1 - 1 : l1 * 0.5, i === ctrl.length - 2 ? l2 - 1 : l2 * 0.5);
    const rr = t / Math.tan(phi / 2);
    const sx = bx - ux * t, sz = bz - uz * t;
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

/**
 * A street from a (leaving along unit da) to b (arriving along unit db): straight for LEAD m out of
 * a and into b, a fillet of radius rf where it bends between.
 */
function lead(a: P, da: P, b: P, db: P, rf = 9, la = LEAD, lb = LEAD): number[] {
  const a1: P = [a[0] + da[0] * la, a[1] + da[1] * la];
  const b1: P = [b[0] - db[0] * lb, b[1] - db[1] * lb];
  return filletPoly([a, a1, b1, b], rf);
}

/** Straight samples from a to b. */
function seg(a: P, b: P): number[] {
  return filletPoly([a, b], 0);
}

/** An arc round (cs, cf) radius r from angle a0 to a1 (rad, in the (s, f) plane), ≤ 0.5 m samples. */
function arcPts(cs: number, cf: number, r: number, a0: number, a1: number): number[] {
  const out: number[] = [];
  const n = Math.max(6, Math.ceil((Math.abs(a1 - a0) * r) / 0.5));
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    out.push(cs + Math.cos(a) * r, cf + Math.sin(a) * r);
  }
  return out;
}

const unit = (x: number, z: number): P => {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
};

/** Build a plan from node and edge lists. */
class PlanBuilder {
  nodes: PlanNode[] = [];
  edges: PlanEdge[] = [];
  node(s: number, f: number, place: NodePlace = 'junction', control?: 'roundabout'): number {
    this.nodes.push({ s, f, place, control });
    return this.nodes.length - 1;
  }
  edge(a: number, b: number, pts: number[], kind: 'street' | 'lane', name: string, oneWay = false): number {
    // pin the ends exactly on the nodes
    pts[0] = this.nodes[a].s;
    pts[1] = this.nodes[a].f;
    pts[pts.length - 2] = this.nodes[b].s;
    pts[pts.length - 1] = this.nodes[b].f;
    this.edges.push({ a, b, pts, kind, name, oneWay: oneWay || undefined });
    return this.edges.length - 1;
  }
  at(i: number): P {
    return [this.nodes[i].s, this.nodes[i].f];
  }
}

export function planTown(t: TownSpecIn): TownPlan {
  switch (t.style) {
    case 'farm':
      return farm(t);
    case 'alpine':
      return alpine(t);
    case 'harbour':
      return harbour(t);
    case 'resort':
      return resort(t);
    case 'metro':
      return metro(t);
  }
}

/** Lane names, per town from a pool (two villages of one style never share a street name). */
const POOL = {
  farm: ['barn lane', 'mill lane', 'orchard lane', 'hay lane', 'dairy lane', 'pond lane', 'apple lane', 'goose lane', 'tractor lane', 'clover lane'],
  alpine: ['chalet lane', 'pine lane', 'cowbell lane', 'edelweiss lane', 'sledge lane', 'cheese lane'],
} as const;
const pick2 = (pool: readonly string[], k: number): [string, string] => [pool[(k * 2) % pool.length], pool[(k * 2 + 1) % pool.length]];

/** A one-way ring (counter-clockwise from above) round (cs, cf), radius r, through nodes at the given plan angles (rad, increasing). */
function ring(b: PlanBuilder, cs: number, cf: number, r: number, angles: number[], name: string, places: NodePlace[]): number[] {
  const ids = angles.map((a, i) => b.node(cs + Math.cos(a) * r, cf + Math.sin(a) * r, places[i], 'roundabout'));
  for (let i = 0; i < ids.length; i++) {
    const a0 = angles[i];
    let a1 = angles[(i + 1) % ids.length];
    if (a1 <= a0) a1 += Math.PI * 2;
    b.edge(ids[i], ids[(i + 1) % ids.length], arcPts(cs, cf, r, a0, a1), 'lane', name, true);
  }
  return ids;
}

/**
 * Farm villages, two shapes (`variant`), so two farm villages never look alike:
 *   0 — the green: in from the gate to a crossroads; a lane out to the fields one way, the other
 *       on to a second gate (or the fields); north, green street to a one-way loop round the
 *       village green (a pond, a maypole: T1's);
 *   1 — the lens: in from the gate to a fork; two streets bow round the green and meet again at
 *       the top, where a lane runs on to the fields.
 */
function farm(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const b = new PlanBuilder();
  const [laneA, laneB] = pick2(POOL.farm, t.variant ?? 0);
  const lens = (t.variant ?? 0) % 2 === 1;
  const G = b.node(0, -(P - GATE_INSET), 'town-gate');
  // (the green's crossroads sits further in: its angled side lanes need the length)
  const jf = -(P - GATE_INSET - (lens ? MAIN : MAIN + 2.5));
  const J = b.node(0, jf, 'junction');
  b.edge(G, J, seg(b.at(G), b.at(J)), 'street', `${t.name} street`);
  const exits = [G];
  const e = P - END_INSET;
  if (!lens) {
    // the crossroads' side arms, angled a little forward (longer, and ≥ 75° off green street): a
    // lane out to the fields, the other a second gate if asked
    const second = t.exits[1];
    const sideOf = second === undefined ? 0 : Math.sin(second) >= 0 ? 1 : -1;
    const th = 12 * (Math.PI / 180);
    /** Distance from the crossroads along the arm to the circle of radius r round the centre. */
    const reach = (r: number) => -jf * Math.sin(th) + Math.sqrt((jf * Math.sin(th)) ** 2 - jf * jf + r * r);
    for (const side of [1, -1]) {
      const ux = side * Math.cos(th);
      const uz = Math.sin(th);
      if (side === sideOf) {
        const L = reach(P - GATE_INSET);
        const g = b.node(ux * L, jf + uz * L, 'town-gate');
        b.edge(J, g, seg(b.at(J), b.at(g)), 'street', `${t.name} road`);
        exits.push(g);
      } else {
        const L = reach(e);
        const E = b.node(ux * L, jf + uz * L, 'end');
        b.edge(J, E, seg(b.at(J), b.at(E)), 'lane', side > 0 ? laneA : laneB);
      }
    }
    // green street up to the loop round the green
    const rr = 6.5;
    const L0 = jf + MAIN;
    const ids = ring(b, 0, L0 + rr, rr, [-Math.PI / 2, Math.PI / 2], 'the green', ['junction', 'bend']);
    b.edge(J, ids[0], seg(b.at(J), b.at(ids[0])), 'street', 'green street');
    return { nodes: b.nodes, edges: b.edges, exits, square: { s: 0, f: L0 + rr, r: rr - 2.65 } };
  }
  // the lens: two streets run out round the green from the fork and meet again at the top junction
  const top = jf + 13;
  const T = b.node(0, top, 'junction');
  const bow = 14;
  for (const side of [1, -1]) b.edge(J, T, filletPoly([[0, jf], [side * bow, jf], [side * bow, top], [0, top]], 7), 'street', side > 0 ? `${t.name} green east` : `${t.name} green west`);
  const E = b.node(0, e, 'end');
  b.edge(T, E, seg(b.at(T), b.at(E)), 'lane', laneA);
  return { nodes: b.nodes, edges: b.edges, exits, square: { s: 0, f: (jf + top) / 2, r: 3.6 } };
}

/**
 * Alpine village: the high street climbs in past a lane to the chapel square, a one-way loop round
 * the chapel (its west corner the porch's: T1 keeps the chapel's door on it).
 */
function alpine(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const b = new PlanBuilder();
  const [laneA] = pick2(POOL.alpine, t.variant ?? 0);
  const e = P - END_INSET;
  const G = b.node(0, -(P - GATE_INSET), 'town-gate');
  const f1 = -(P - GATE_INSET - MAIN);
  const J1 = b.node(0, f1, 'junction');
  b.edge(G, J1, seg(b.at(G), b.at(J1)), 'street', `${t.name} high street`);
  const L1 = b.node(Math.sqrt(e * e - f1 * f1), f1, 'end');
  b.edge(J1, L1, seg(b.at(J1), b.at(L1)), 'lane', laneA);
  // the chapel loop at the top of the high street: south (the street in), north, west
  const rr = 7.5;
  const cf = f1 + MAIN + rr;
  const ids = ring(b, 0, cf, rr, [-Math.PI / 2, Math.PI / 2, Math.PI], 'chapel square', ['square', 'bend', 'bend']);
  b.edge(J1, ids[0], seg(b.at(J1), b.at(ids[0])), 'street', `${t.name} high street`);
  return { nodes: b.nodes, edges: b.edges, exits: [G], square: { s: 0, f: cf, r: rr - 2.65 } };
}

/**
 * Harbour: the main street runs in from the back gate to a crossroads and on down the harbour street
 * to the quay, where the pier carries straight on out to sea from its end (the pier head); the
 * quay street runs along the water from the pier head and up round the harbour block back to the
 * crossroads; the back street leaves the crossroads the other way, for the flank gate (a through
 * road) or a turning circle, past the harbour square's block open to the quay.
 */
function harbour(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const b = new PlanBuilder();
  const side = t.exits.length > 1 && Math.sin(t.exits[1]) < 0 ? -1 : 1; // the flank gate's side (+s or −s)
  const GA = b.node(0, -(P - GATE_INSET), 'town-gate');
  const mf = -(P - GATE_INSET - MAIN); // the crossroads
  const qf = P - 7.5; // the quay street: its seaward sidewalk leaves a ~3 m quay to the water
  const ts = 14; // the harbour block's outer street
  const M = b.node(0, mf, 'junction');
  const Q = b.node(0, qf, 'pier');
  b.edge(GA, M, seg(b.at(GA), b.at(M)), 'street', `${t.name} main street`);
  b.edge(M, Q, seg(b.at(M), b.at(Q)), 'street', 'harbour street');
  b.edge(M, Q, filletPoly([[0, mf], [-side * ts, mf], [-side * ts, qf], [0, qf]], 7), 'street', 'quay street');
  const exits = [GA];
  if (t.exits.length > 1) {
    // the back street runs out along the block and turns back for the gate on the pad's rear quarter,
    // so the through road leaves toward the land behind the town, not along the shore
    const cs = side * 11;
    const ux = side * 0.6, uz = -0.8;
    const qx = cs, qz = mf;
    const bq = qx * ux + qz * uz;
    const L = -bq + Math.sqrt(bq * bq - (qx * qx + qz * qz) + (P - GATE_INSET) ** 2);
    const GB = b.node(qx + ux * L, qz + uz * L, 'town-gate');
    b.edge(M, GB, filletPoly([[0, mf], [cs, mf], [qx + ux * L, qz + uz * L]], 7), 'street', 'back street');
    exits.push(GB);
  } else {
    // (a harbour at the end of its road: the back street runs out, a little forward, to the net
    // lofts' turning circle)
    const e = P - END_INSET;
    const ux = side * Math.cos(0.21), uz = Math.sin(0.21);
    const bq = mf * uz;
    const L = -bq + Math.sqrt(bq * bq - mf * mf + e * e);
    const E = b.node(ux * L, mf + uz * L, 'end');
    b.edge(M, E, seg(b.at(M), b.at(E)), 'street', 'back street');
  }
  // the quay: the pad's seaward edge, ±55° round the axis
  const quay: number[] = [];
  for (let k = -10; k <= 10; k++) {
    const a = (k / 10) * 0.96;
    quay.push(Math.sin(a) * (P - 0.6), Math.cos(a) * (P - 0.6));
  }
  // the harbour square: on the quay beside the pier head, in the block open to the water
  // (the pier leaves the quay street's seaward sidewalk straight on from the harbour street: the pier head)
  return { nodes: b.nodes, edges: b.edges, exits, square: { s: side * 9.5, f: qf - 4, r: 4 }, quay, pier: { node: Q, s: 0, f: qf + 4.3 } };
}

/**
 * Resort: in from the bridge to a one-way promenade round the villa gardens (counter-clockwise from
 * above, entries yield to it), with the beach outside it; a close of villas leaves its far side.
 */
function resort(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const b = new PlanBuilder();
  const G = b.node(0, -(P - GATE_INSET), 'town-gate');
  const af = -(P - GATE_INSET - MAIN);
  const rr = 6.5; // the promenade: round the gardens just in from the gate, the villa close beyond
  const ids = ring(b, 0, af + rr, rr, [-Math.PI / 2, Math.PI / 2], 'beach promenade', ['junction', 'junction']);
  b.edge(G, ids[0], seg(b.at(G), b.at(ids[0])), 'street', `${t.name} road`);
  const V = b.node(0, P - END_INSET, 'end');
  b.edge(ids[1], V, seg(b.at(ids[1]), b.at(V)), 'lane', 'villa close');
  return { nodes: b.nodes, edges: b.edges, exits: [G], square: { s: 0, f: af + rr, r: rr - 2.65 } };
}

/**
 * Metro: a 4 × 4 street grid (3 × 3 blocks, the central one the circus: an open round plaza), the
 * outer square's corners rounded; each requested exit runs out from the nearest outer junction to
 * the pad edge. An exit at bearing 0 (seaward) is the docks: the pier leaves the quay in front of it.
 */
function metro(t: TownSpecIn): TownPlan {
  const P = t.padR;
  const b = new PlanBuilder();
  const a = 11; // inner lines
  const o = 33; // outer square
  const rc = 12; // outer corners
  const X: Record<string, number> = {};
  const key = (s: number, f: number) => `${s},${f}`;
  // interior crossroads and outer T junctions
  for (const s of [-a, a]) for (const f of [-a, a]) X[key(s, f)] = b.node(s, f, 'junction');
  for (const s of [-a, a]) for (const f of [-o, o]) X[key(s, f)] = b.node(s, f, 'junction');
  for (const f of [-a, a]) for (const s of [-o, o]) X[key(s, f)] = b.node(s, f, 'junction');
  const n = (s: number, f: number) => X[key(s, f)];
  const names = { s: ['west avenue', 'east avenue'], f: ['north street', 'south street'] };
  for (const [i, s] of [-a, a].entries()) {
    b.edge(n(s, -o), n(s, -a), seg([s, -o], [s, -a]), 'street', names.s[i]);
    b.edge(n(s, -a), n(s, a), seg([s, -a], [s, a]), 'street', names.s[i]);
    b.edge(n(s, a), n(s, o), seg([s, a], [s, o]), 'street', names.s[i]);
  }
  for (const [i, f] of [-a, a].entries()) {
    b.edge(n(-o, f), n(-a, f), seg([-o, f], [-a, f]), 'street', names.f[i]);
    b.edge(n(-a, f), n(a, f), seg([-a, f], [a, f]), 'street', names.f[i]);
    b.edge(n(a, f), n(o, f), seg([a, f], [o, f]), 'street', names.f[i]);
  }
  // the outer square: straight sides between its T junctions, corners rounded
  b.edge(n(-a, o), n(a, o), seg([-a, o], [a, o]), 'street', 'harbour front');
  b.edge(n(-a, -o), n(a, -o), seg([-a, -o], [a, -o]), 'street', 'park row');
  b.edge(n(-o, -a), n(-o, a), seg([-o, -a], [-o, a]), 'street', 'west row');
  b.edge(n(o, -a), n(o, a), seg([o, -a], [o, a]), 'street', 'east row');
  b.edge(n(a, o), n(o, a), filletPoly([[a, o], [o, o], [o, a]], rc), 'street', 'boulevard');
  b.edge(n(o, -a), n(a, -o), filletPoly([[o, -a], [o, -o], [a, -o]], rc), 'street', 'boulevard');
  b.edge(n(-a, -o), n(-o, -a), filletPoly([[-a, -o], [-o, -o], [-o, -a]], rc), 'street', 'boulevard');
  b.edge(n(-o, a), n(-a, o), filletPoly([[-o, a], [-o, o], [-a, o]], rc), 'street', 'boulevard');
  // exits: from the outer junction nearest each bearing straight out to the pad edge
  const outer: P[] = [
    [-a, o], [a, o], [o, a], [o, -a], [a, -o], [-a, -o], [-o, -a], [-o, a],
  ];
  const used = new Set<number>();
  const exits: number[] = [];
  let pier: TownPlan['pier'];
  t.exits.forEach((bearing, k) => {
    let best = -1;
    let bd = Infinity;
    outer.forEach(([s, f], i) => {
      if (used.has(i)) return;
      const ang = Math.atan2(s, f);
      const d = Math.abs(Math.atan2(Math.sin(ang - bearing), Math.cos(ang - bearing)));
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    used.add(best);
    const [s, f] = outer[best];
    const along = Math.abs(f) === o; // a line running in f
    if (k === 0 && along && f > 0) {
      // the docks: the pier leaves the quay right in front of this junction
      pier = { node: n(s, f), s, f: P - 0.6 };
      exits.push(n(s, f));
      return;
    }
    const es = along ? s : Math.sign(s) * (P - GATE_INSET);
    const ef = along ? Math.sign(f) * (P - GATE_INSET) : f;
    const g = b.node(es, ef, 'town-gate');
    b.edge(n(s, f), g, seg([s, f], [es, ef]), 'street', 'avenue');
    exits.push(g);
  });
  if (pier) b.nodes[pier.node].place = 'pier';
  const quay: number[] = [];
  for (let k = -10; k <= 10; k++) {
    const q = (k / 10) * 0.7;
    quay.push(Math.sin(q) * (P - 0.6), Math.cos(q) * (P - 0.6));
  }
  return { nodes: b.nodes, edges: b.edges, exits, square: { s: 0, f: 0, r: a - 4.6 }, quay, pier };
}

void unit;
