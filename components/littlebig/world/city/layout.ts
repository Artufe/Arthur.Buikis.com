// The city's street sketch (pure, seeded): a hand-drawn pentagonal plaza loop, five avenues
// swirling out from its corners (each with its own curve and length), an oval ring road a little
// off-centre that they meet at right angles, and short cul-de-sacs off the ring into the houses
// where the residential band is deep. graph.ts turns the sketch into lanes, connectors, patches and
// the walk graph; plan.ts fills the blocks.
//
// Plan space: +x east, +z south (types.ts). Plan angles increase clockwise seen from above.

import { CITY_PLAN_RADIUS } from '../config';
import { Rng } from '../rng';
import type { SketchEdge, SketchNode } from './graph';

export interface Layout {
  nodes: SketchNode[];
  edges: SketchEdge[];
  /** Rotation of the plaza pentagon (rad). */
  rot: number;
  /** Node ids: the plaza loop's corners (increasing angle) and the avenue ring junctions. */
  corners: number[];
  ringNodes: number[];
  /** Cul-de-sacs: their ring junction and their dead-end node. */
  culs: Array<{ ring: number; end: number }>;
  /** Plan angles (about the plan origin) of the park and stadium arcs in the outer band. */
  parkPhi: number;
  parkHalf: number;
  stadiumPhi: number;
  stadiumHalf: number;
}

/** Circumradius of the plaza loop's corner nodes (m). */
const PLAZA_R = 23;
/** Mean ring centreline radius (m), about the ring's own (off-centre) centre. */
const RING_R = 59;
/** Number of avenues (and plaza corners). Five gives square-ish sector blocks at this scale. */
const ARMS = 5;
/** Cul-de-sac turning circle: carriageway radius (m) and its sidewalk. */
export const CUL_WIDTH = 5.5;
export const CUL_SIDEWALK = 1.6;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function buildLayout(seed: number): Layout {
  const rng = Rng.for(seed, 'city-layout');
  const rot = -0.55 + rng.range(-0.05, 0.05);
  // The ring: an oval (stretched along `oa`) round a centre nudged off the plaza, plus a wobble.
  const oa = rng.range(0, Math.PI);
  const a3 = rng.range(0, Math.PI * 2);
  const ox = rng.range(1.2, 2.2) * Math.cos(oa + 1.2);
  const oz = rng.range(1.2, 2.2) * Math.sin(oa + 1.2);
  const ringR = (phi: number) => RING_R + 3.4 * Math.cos(2 * (phi - oa)) + 1.1 * Math.sin(3 * phi + a3);
  const ringPt = (phi: number) => {
    const r = ringR(phi);
    return { x: ox + Math.cos(phi) * r, z: oz + Math.sin(phi) * r };
  };
  const ringNormal = (phi: number) => {
    const h = 1e-4;
    const a = ringPt(phi - h);
    const b = ringPt(phi + h);
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    let nx = -tz / l;
    let nz = tx / l;
    const p = ringPt(phi);
    if (nx * (p.x - ox) + nz * (p.z - oz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    return { x: nx, z: nz };
  };

  const nodes: SketchNode[] = [];
  const edges: SketchEdge[] = [];
  // Plaza corners, each nudged so the pentagon is hand-drawn rather than ruled.
  const corners: number[] = [];
  const cornerPhi: number[] = [];
  for (let k = 0; k < ARMS; k++) {
    const phi = rot + (k * Math.PI * 2) / ARMS + rng.range(-0.07, 0.07);
    const r = PLAZA_R + rng.range(-1.4, 1.4);
    corners.push(nodes.length);
    cornerPhi.push(phi);
    nodes.push({ x: Math.cos(phi) * r, z: Math.sin(phi) * r, control: 'yield' });
  }
  for (let k = 0; k < ARMS; k++) {
    const a = nodes[corners[k]];
    const b = nodes[corners[(k + 1) % ARMS]];
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const ml = Math.hypot(mx, mz) || 1;
    const bow = 1.1 + rng.range(-0.4, 0.6);
    edges.push({ a: corners[k], b: corners[(k + 1) % ARMS], points: quad(a.x, a.z, mx + (mx / ml) * bow, mz + (mz / ml) * bow, b.x, b.z), kind: 'street', width: 6.0, sidewalk: 2.2, speed: 6 });
  }

  // Avenues: each its own swirl (some nearly straight, some sweeping) and tangent lengths.
  const swirls = [0.04, 0.2, 0.33, 0.12, 0.42];
  for (let i = swirls.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [swirls[i], swirls[j]] = [swirls[j], swirls[i]];
  }
  // Ring angles are measured about the ring centre: aim each avenue at the ring along the corner's ray.
  const ringPhiOf = (x: number, z: number) => Math.atan2(z - oz, x - ox);
  const ringNodes: number[] = [];
  const ringPhi: number[] = [];
  for (let k = 0; k < ARMS; k++) {
    const c = nodes[corners[k]];
    const phi = ringPhiOf(c.x, c.z) + swirls[k] + rng.range(-0.03, 0.03);
    const p = ringPt(phi);
    ringNodes.push(nodes.length);
    ringPhi.push(phi);
    nodes.push({ x: p.x, z: p.z, control: 'yield' });
  }
  for (let k = 0; k < ARMS; k++) {
    const c = nodes[corners[k]];
    const e = nodes[ringNodes[k]];
    const n = ringNormal(ringPhi[k]);
    const cl = Math.hypot(c.x, c.z);
    const dx = c.x / cl;
    const dz = c.z / cl;
    const L = Math.hypot(e.x - c.x, e.z - c.z);
    const k0 = L * rng.range(0.28, 0.46);
    const k1 = L * rng.range(0.3, 0.48);
    edges.push({
      a: corners[k],
      b: ringNodes[k],
      points: cubic(c.x, c.z, c.x + dx * k0, c.z + dz * k0, e.x - n.x * k1, e.z - n.z * k1, e.x, e.z),
      kind: 'avenue',
      width: 6.5,
      sidewalk: 2.2,
      speed: 8,
    });
  }

  // The outer band: a park arc and the stadium (plan.ts fills them), placed against the ring.
  const parkPhi = Math.PI + rng.range(-0.1, 0.1);
  const parkHalf = 0.62;
  const stadiumPhi = -Math.PI / 4 + rng.range(-0.1, 0.1);
  const stadiumHalf = 0.3;
  const inArc = (phi: number, c: number, half: number) => Math.abs(wrap(phi - c)) < half;

  // Cul-de-sacs off the ring, outward, where the band to the plateau rim is deepest; clear of the
  // park and stadium arcs, of the avenue junctions and of each other.
  const culs: Array<{ ring: number; end: number }> = [];
  const culPhi: number[] = [];
  const cands: Array<{ phi: number; room: number }> = [];
  for (let i = 0; i < 72; i++) {
    const phi = (i / 72) * Math.PI * 2;
    const p = ringPt(phi);
    const pa = Math.atan2(p.z, p.x);
    if (inArc(pa, parkPhi, parkHalf + 0.18) || inArc(pa, stadiumPhi, stadiumHalf + 0.22)) continue;
    if (ringPhi.some((q) => Math.abs(wrap(q - phi)) * RING_R < 26)) continue;
    const room = CITY_PLAN_RADIUS - Math.hypot(p.x, p.z);
    if (room < 24.5) continue;
    cands.push({ phi, room: room + rng.range(0, 1.5) });
  }
  cands.sort((a, b) => b.room - a.room);
  for (const c of cands) {
    if (culPhi.length >= 3) break;
    if (culPhi.some((q) => Math.abs(wrap(q - c.phi)) < 0.85)) continue;
    culPhi.push(c.phi);
  }
  const culStart = new Map<number, number>();
  for (const phi of culPhi) {
    const p = ringPt(phi);
    const n = ringNormal(phi);
    const id = nodes.length;
    nodes.push({ x: p.x, z: p.z, control: 'yield' });
    culStart.set(phi, id);
    // Out along the normal, bending a little to one side, ending well inside the rim.
    const bend = rng.range(-0.25, 0.25);
    const room = CITY_PLAN_RADIUS - Math.hypot(p.x, p.z);
    const L = Math.min(24, room - 8.6);
    const ex = p.x + (n.x * Math.cos(bend) - n.z * Math.sin(bend)) * L;
    const ez = p.z + (n.z * Math.cos(bend) + n.x * Math.sin(bend)) * L;
    const end = nodes.length;
    nodes.push({ x: ex, z: ez });
    edges.push({ a: id, b: end, points: cubic(p.x, p.z, p.x + n.x * L * 0.45, p.z + n.z * L * 0.45, ex - (ex - p.x) * 0.25, ez - (ez - p.z) * 0.25, ex, ez), kind: 'lane', width: CUL_WIDTH, sidewalk: CUL_SIDEWALK, speed: 5 });
    culs.push({ ring: id, end });
  }

  // Ring arcs between consecutive ring junctions (avenues and cul-de-sacs).
  const ring = [...ringPhi.map((phi, k) => ({ phi: norm(phi), node: ringNodes[k] })), ...culPhi.map((phi) => ({ phi: norm(phi), node: culStart.get(phi)! }))].sort((a, b) => a.phi - b.phi);
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i].phi;
    let p1 = ring[(i + 1) % ring.length].phi;
    while (p1 <= p0) p1 += Math.PI * 2;
    const pts: number[] = [];
    const n = Math.ceil(((p1 - p0) * RING_R) / 0.9);
    for (let j = 0; j <= n; j++) {
      const p = ringPt(p0 + ((p1 - p0) * j) / n);
      pts.push(p.x, p.z);
    }
    edges.push({ a: ring[i].node, b: ring[(i + 1) % ring.length].node, points: pts, kind: 'ring', width: 7, sidewalk: 2.2, speed: 10 });
  }
  return { nodes, edges, rot, corners, ringNodes, culs, parkPhi, parkHalf, stadiumPhi, stadiumHalf };
}

function norm(a: number): number {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
}

function quad(x0: number, z0: number, cx: number, cz: number, x1: number, z1: number): number[] {
  const out: number[] = [];
  const n = Math.max(4, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.9));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * z0 + 2 * u * t * cz + t * t * z1);
  }
  return out;
}

function cubic(x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, x3: number, z3: number): number[] {
  const out: number[] = [];
  const n = Math.max(6, Math.ceil((Math.hypot(x3 - x0, z3 - z0) * 1.15) / 0.9));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(a * x0 + b * x1 + c * x2 + d * x3, a * z0 + b * z1 + c * z2 + d * z3);
  }
  return out;
}
