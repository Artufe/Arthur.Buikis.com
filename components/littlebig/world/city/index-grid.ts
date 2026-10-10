// CityIndex: zero-alloc spatial queries over a CityPlan (uniform grid). Pure.
// Used by A1 (where trees may go), A4 (camera / FPV collision), B2 (people avoid buildings) and
// validate.ts (the plan invariants).

import { AREA_H, CURB_H, PLATEAU_HEIGHT, ROAD_H } from '../config';
import type { Vec3 } from '../sphere';
import { planToDir } from './frame';
import { hyp } from '../hyp';
import type { Building, CityIndex, CityPlan, Feature, GroundClass } from './types';

const CELL = 8;

// Zero allocation (BRIEF §1): no Math.hypot here (V8's builtin allocates an array of its arguments
// on every call); world/hyp.ts is V8's own algorithm, bit for bit, so every result is unchanged
// (the inlined copies below, marked hyp(…), are the same expression). The hot queries (classifyQ / collideQ) also keep
// doubles off non-inlined call boundaries (V8 boxes such arguments and return values): inputs come
// in through the index's Float64Array `q`, the helpers they call take objects or integers.


/** Default collision radius of a point feature (Feature.r overrides). */
const FEATURE_R: Record<string, number> = { streetlight: 0.2, lamp: 0.2, hydrant: 0.18, tree: 0.4, flag: 0.15, bench: 0.5, 'bus-stop': 0.6, fountain: 1.6, planter: 0.5, 'cafe-table': 0.45, statue: 0.8 };
export function featureRadius(f: Feature): number {
  return f.r ?? FEATURE_R[f.kind] ?? 0;
}

export interface CityIndexOptions {
  /**
   * The planet's surface, for groundH outside the plan (terrain height relative to the plateau).
   * An object, not a closure: the index is cached for the page's lifetime, and a closure created
   * where the minifier inlines the caller (the engine's `world` getter) captured the engine's whole
   * scope, so production kept the first engine alive after its window closed.
   */
  terrain?: { surfaceAt(dir: Vec3): number };
}

/** Signed distance from (x, z) to building b's footprint (negative inside). */
export function obbDistance(b: Building, x: number, z: number): number {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const dx = x - b.x;
  const dz = z - b.z;
  // local coordinates: lx along local +x = (c, s), lz along local +z = (−s, c)
  const lx = dx * c + dz * s;
  const lz = -dx * s + dz * c;
  const qx = Math.abs(lx) - b.w / 2;
  const qz = Math.abs(lz) - b.d / 2;
  const ox = Math.max(qx, 0);
  const oz = Math.max(qz, 0);
  return hyp(ox, oz) + Math.min(Math.max(qx, qz), 0);
}

/**
 * The stadium's wall: a superellipse (|x/A|^2.6 + |z/B|^2.6 = 1) set 0.4 m inside its plan box,
 * sampled as a 32-gon in the building's LOCAL frame (x along local +x, z along local +z), x, z
 * interleaved. city/buildings.ts builds the mesh from exactly this ring (scaled by k for the stands).
 */
export function stadiumRing(b: Building, k = 1, n = 32): number[] {
  const A = b.w / 2 - 0.4;
  const B = b.d / 2 - 0.4;
  const ex = 2.6;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push(Math.sign(c) * Math.pow(Math.abs(c), 2 / ex) * A * k, Math.sign(s) * Math.pow(Math.abs(s), 2 / ex) * B * k);
  }
  return out;
}

/** Local positions (x, z) of the stadium's four floodlight masts (collision posts, r 0.3). */
export function stadiumMasts(b: Building): number[] {
  const mx = b.w / 2 - 0.9;
  const mz = b.d / 2 - 0.9;
  return [-mx, -mz, mx, -mz, mx, mz, -mx, mz];
}

const rings = new WeakMap<Building, number[]>();
const _dir: Vec3 = { x: 0, y: 0, z: 0 };
const _cp = { x: 0, z: 0, d: 0 };
/**
 * Closest point (local frame) on a closed local ring to local (lx, lz), and the signed distance
 * (negative inside). Writes into _cp.
 */
function ringClosest(ring: number[], lx: number, lz: number): typeof _cp {
  let best = Infinity;
  let inside = false;
  const n = ring.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[j * 2], az = ring[j * 2 + 1], bx = ring[i * 2], bz = ring[i * 2 + 1];
    if (az > lz !== bz > lz && lx < ((ax - bx) * (lz - bz)) / (az - bz) + bx) inside = !inside;
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((lx - ax) * dx + (lz - az) * dz) / l2));
    const qx = ax + dx * t, qz = az + dz * t;
    const d = (qx - lx) * (qx - lx) + (qz - lz) * (qz - lz);
    if (d < best) {
      best = d;
      _cp.x = qx;
      _cp.z = qz;
    }
  }
  _cp.d = inside ? -Math.sqrt(best) : Math.sqrt(best);
  return _cp;
}

/**
 * Signed distance (m, negative inside) from plan (x, z) to the building's VISIBLE wall: its plan box,
 * except the stadium, whose wall is the superellipse inside its box (stadiumRing). Use this for
 * collision and camera clearance; obbDistance (the box) stays the placement / validation shape.
 */
export function footprintDistance(b: Building, x: number, z: number): number {
  if (b.landmark !== 'stadium') return obbDistance(b, x, z);
  let ring = rings.get(b);
  if (!ring) rings.set(b, (ring = stadiumRing(b)));
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const dx = x - b.x;
  const dz = z - b.z;
  return ringClosest(ring, dx * c + dz * s, -dx * s + dz * c).d;
}

/** Footprint corners (x, z interleaved, positive winding). */
export function buildingCorners(b: Building): number[] {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const hw = b.w / 2;
  const hd = b.d / 2;
  const out: number[] = [];
  for (const [u, v] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) out.push(b.x + u * c - v * s, b.z + u * s + v * c);
  return out;
}

function segDist(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return hyp(x0 + dx * t - px, z0 + dz * t - pz);
}

export function createCityIndex(plan: CityPlan, opts: CityIndexOptions = {}): CityIndex {
  const R = plan.radius + 40;
  const dim = Math.ceil((2 * R) / CELL);
  const cellOf = (v: number) => Math.max(0, Math.min(dim - 1, Math.floor((v + R) / CELL)));
  type Cell = { b: number[]; seg: number[]; node: number[]; area: number[]; walk: number[]; obs: number[] };
  const cells: Cell[] = Array.from({ length: dim * dim }, () => ({ b: [], seg: [], node: [], area: [], walk: [], obs: [] }));
  const forBox = (x0: number, z0: number, x1: number, z1: number, fn: (c: Cell) => void) => {
    const i0 = cellOf(x0);
    const i1 = cellOf(x1);
    const j0 = cellOf(z0);
    const j1 = cellOf(z1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(cells[j * dim + i]);
  };

  // Buildings.
  plan.buildings.forEach((b, id) => {
    const r = Math.hypot(b.w, b.d) / 2;
    forBox(b.x - r, b.z - r, b.x + r, b.z + r, (c) => c.b.push(id));
  });
  // Road segments: flat list [edge, x0, z0, x1, z1].
  const segEdge: number[] = [];
  const segPts: number[] = [];
  const segS: number[] = [];
  for (const e of plan.edges) {
    const p = e.centre.pts;
    const ext = e.width / 2 + e.sidewalk;
    for (let i = 0; i < p.length - 2; i += 2) {
      const id = segEdge.length;
      segEdge.push(e.id);
      segPts.push(p[i], p[i + 1], p[i + 2], p[i + 3]);
      segS.push(e.centre.s[i >> 1]);
      forBox(Math.min(p[i], p[i + 2]) - ext, Math.min(p[i + 1], p[i + 3]) - ext, Math.max(p[i], p[i + 2]) + ext, Math.max(p[i + 1], p[i + 3]) + ext, (c) =>
        c.seg.push(id),
      );
    }
  }
  // Corner sidewalks (and any sidewalk walk edge): [x0, z0, x1, z1, halfWidth] per segment.
  const walkSeg: number[] = [];
  for (const w of plan.walkEdges) {
    if (w.kind !== 'sidewalk' && w.kind !== 'corner') continue;
    const p = w.path.pts;
    const hw = w.width / 2;
    for (let i = 0; i < p.length - 2; i += 2) {
      const id = walkSeg.length / 5;
      walkSeg.push(p[i], p[i + 1], p[i + 2], p[i + 3], hw);
      forBox(Math.min(p[i], p[i + 2]) - hw, Math.min(p[i + 1], p[i + 3]) - hw, Math.max(p[i], p[i + 2]) + hw, Math.max(p[i + 1], p[i + 3]) + hw, (c) => c.walk.push(id));
    }
  }
  // Point obstacles.
  const obs: number[] = [];
  for (const f of plan.features) {
    const r = featureRadius(f);
    if (r <= 0) continue;
    const id = obs.length / 3;
    obs.push(f.x, f.z, r);
    forBox(f.x - r, f.z - r, f.x + r, f.z + r, (c) => c.obs.push(id));
  }
  // The stadium's floodlight masts stand in its box corners, outside its rounded wall.
  for (const b of plan.buildings) {
    if (b.landmark !== 'stadium') continue;
    const m = stadiumMasts(b);
    const c = Math.cos(b.angle);
    const sn = Math.sin(b.angle);
    for (let i = 0; i < m.length; i += 2) {
      const x = b.x + m[i] * c - m[i + 1] * sn;
      const z = b.z + m[i] * sn + m[i + 1] * c;
      const id = obs.length / 3;
      obs.push(x, z, 0.3);
      forBox(x - 0.3, z - 0.3, x + 0.3, z + 0.3, (cl) => cl.obs.push(id));
    }
  }
  const obstacles = Float64Array.from(obs);
  plan.nodes.forEach((n, id) => {
    const r = n.radius + 3;
    forBox(n.x - r, n.z - r, n.x + r, n.z + r, (c) => c.node.push(id));
  });
  const areaBox = plan.areas.map((a) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < a.outline.length; i += 2) {
      x0 = Math.min(x0, a.outline[i]);
      x1 = Math.max(x1, a.outline[i]);
      z0 = Math.min(z0, a.outline[i + 1]);
      z1 = Math.max(z1, a.outline[i + 1]);
    }
    return [x0, z0, x1, z1];
  });
  plan.areas.forEach((_, id) => {
    const [x0, z0, x1, z1] = areaBox[id];
    forBox(x0, z0, x1, z1, (c) => c.area.push(id));
  });

  // Dedup stamps for multi-cell queries.
  const bStamp = new Uint32Array(plan.buildings.length);
  let stamp = 0;
  const nextStamp = () => {
    stamp = (stamp + 1) >>> 0;
    if (stamp === 0) {
      bStamp.fill(0);
      stamp = 1;
    }
    return stamp;
  };

  // Flat per-building and per-segment data for the hot loops (same values the plan objects give).
  const nB = plan.buildings.length;
  const bX = new Float64Array(nB);
  const bZ = new Float64Array(nB);
  const bC = new Float64Array(nB);
  const bS = new Float64Array(nB);
  const bHW = new Float64Array(nB);
  const bHD = new Float64Array(nB);
  const bRound = new Uint8Array(nB); // the stadium: its wall is the superellipse ring
  plan.buildings.forEach((b, id) => {
    bX[id] = b.x;
    bZ[id] = b.z;
    bC[id] = Math.cos(b.angle);
    bS[id] = Math.sin(b.angle);
    bHW[id] = b.w / 2;
    bHD[id] = b.d / 2;
    bRound[id] = b.landmark === 'stadium' ? 1 : 0;
  });
  const segHW = Float64Array.from(segEdge, (e) => plan.edges[e].width / 2);
  const segHS = Float64Array.from(segEdge, (e) => plan.edges[e].width / 2 + plan.edges[e].sidewalk);
  const cellIx = (v: number) => {
    const i = Math.floor((v + R) / CELL);
    return i < 0 ? 0 : i > dim - 1 ? dim - 1 : i;
  };
  const cellAt = (x: number, z: number) => cells[cellOf(z) * dim + cellOf(x)];

  /** Query inputs (x, z, r) for classifyQ / collideQ: see the note at the top of the file. */
  const q = new Float64Array(4);

  /** Point (q[0], q[1]) in polygon (graph.ts pointInPolygon, reading q). */
  const pip = (poly: ArrayLike<number>): boolean => {
    const x = q[0];
    const z = q[1];
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
  };

  /**
   * The area under (q[0], q[1]) in cell c, or -1. Water first (a pond lies inside the park polygon
   * it is cut into), lots last (courtyard beds, lanes and squares sit inside the block's lot).
   */
  const areaAtQ = (c: Cell): number => {
    let lot = -1;
    let other = -1;
    const ids = c.area;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      const a = plan.areas[id];
      if (a.kind === 'lot' ? lot >= 0 : other >= 0 && a.kind !== 'water') continue;
      if (!pip(a.outline)) continue;
      if (a.kind === 'water') return id;
      if (a.kind === 'lot') lot = id;
      else other = id;
    }
    return other >= 0 ? other : lot;
  };

  const classifyQ = (): GroundClass => {
    const x = q[0];
    const z = q[1];
    const mo = Math.max(Math.abs(x), Math.abs(z));
    if ((mo === 0 ? 0 : Math.sqrt((x / mo) * (x / mo) + (z / mo) * (z / mo)) * mo) > plan.radius) return 'outside'; // hyp(x, z)
    const c = cells[cellIx(z) * dim + cellIx(x)];
    // buildings (obbDistance ≤ 0: inside the box on both axes)
    const cb = c.b;
    for (let k = 0; k < cb.length; k++) {
      const id = cb[k];
      const dx = x - bX[id];
      const dz = z - bZ[id];
      const co = bC[id];
      const si = bS[id];
      if (Math.abs(dx * co + dz * si) - bHW[id] <= 0 && Math.abs(-dx * si + dz * co) - bHD[id] <= 0) return 'building';
    }
    // intersections
    const cn = c.node;
    for (let k = 0; k < cn.length; k++) {
      const n = plan.nodes[cn[k]];
      const dx = x - n.x;
      const dz = z - n.z;
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      if ((m === 0 ? 0 : Math.sqrt((dx / m) * (dx / m) + (dz / m) * (dz / m)) * m) > n.radius + 3) continue; // hyp(dx, dz)
      if (pip(plan.intersections[cn[k]].outline)) return 'intersection';
    }
    // roads and their sidewalks
    let side = false;
    const cs = c.seg;
    for (let k = 0; k < cs.length; k++) {
      const sid = cs[k];
      const x0 = segPts[sid * 4];
      const z0 = segPts[sid * 4 + 1];
      const sx = segPts[sid * 4 + 2] - x0;
      const sz = segPts[sid * 4 + 3] - z0;
      const l2 = sx * sx + sz * sz || 1;
      const t = Math.max(0, Math.min(1, ((x - x0) * sx + (z - z0) * sz) / l2));
      const ex = x0 + sx * t - x;
      const ez = z0 + sz * t - z;
      const m = Math.max(Math.abs(ex), Math.abs(ez));
      const d = m === 0 ? 0 : Math.sqrt((ex / m) * (ex / m) + (ez / m) * (ez / m)) * m; // hyp(ex, ez)
      if (d <= segHW[sid]) return 'road';
      if (d <= segHS[sid]) side = true;
    }
    if (side) return 'sidewalk';
    // corner sidewalks
    const cw = c.walk;
    for (let k = 0; k < cw.length; k++) {
      const o = cw[k] * 5;
      const x0 = walkSeg[o];
      const z0 = walkSeg[o + 1];
      const sx = walkSeg[o + 2] - x0;
      const sz = walkSeg[o + 3] - z0;
      const l2 = sx * sx + sz * sz || 1;
      const t = Math.max(0, Math.min(1, ((x - x0) * sx + (z - z0) * sz) / l2));
      const ex = x0 + sx * t - x;
      const ez = z0 + sz * t - z;
      const m = Math.max(Math.abs(ex), Math.abs(ez));
      const d = m === 0 ? 0 : Math.sqrt((ex / m) * (ex / m) + (ez / m) * (ez / m)) * m;
      if (d <= walkSeg[o + 4]) return 'sidewalk';
    }
    const a = areaAtQ(c);
    if (a < 0) return 'free';
    const kd = plan.areas[a].kind;
    return kd === 'plaza' ? 'plaza' : kd === 'park' ? 'park' : kd === 'garden' ? 'garden' : kd === 'lot' ? 'lot' : kd === 'water' ? 'water' : 'free';
  };

  const classify = (x: number, z: number): GroundClass => {
    q[0] = x;
    q[1] = z;
    return classifyQ();
  };

  const isClear = (x: number, z: number, r: number): boolean => {
    if (hyp(x, z) + r > plan.radius) return false;
    const i0 = cellOf(x - r), i1 = cellOf(x + r), j0 = cellOf(z - r), j1 = cellOf(z + r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = cells[j * dim + i];
        for (const id of c.b) if (obbDistance(plan.buildings[id], x, z) < r) return false;
        for (const sid of c.seg) {
          const e = plan.edges[segEdge[sid]];
          if (segDist(x, z, segPts[sid * 4], segPts[sid * 4 + 1], segPts[sid * 4 + 2], segPts[sid * 4 + 3]) < e.width / 2 + e.sidewalk + r) return false;
        }
        for (const id of c.node) {
          const n = plan.nodes[id];
          if (hyp(x - n.x, z - n.z) < n.radius + r) return false;
        }
        for (const wid of c.walk) {
          const o = wid * 5;
          if (segDist(x, z, walkSeg[o], walkSeg[o + 1], walkSeg[o + 2], walkSeg[o + 3]) < walkSeg[o + 4] + r) return false;
        }
      }
    }
    return true;
  };

  const roofAt = (x: number, z: number): number => {
    const c = cellAt(x, z);
    let h = 0;
    for (const id of c.b) {
      const b = plan.buildings[id];
      if (b.h > h && footprintDistance(b, x, z) <= 0) h = b.h;
    }
    return h;
  };

  /**
   * Buildings whose footprint (footprintDistance) comes within q[2] of (q[0], q[1]), into nearIds;
   * returns the count. Boxes inline (obbDistance with hyp); the stadium through footprintDistance.
   */
  const nearIds = new Int32Array(Math.max(1, nB));
  const nearQ = (): number => {
    const x = q[0];
    const z = q[1];
    const r = q[2];
    const st = nextStamp();
    let n = 0;
    const i0 = cellIx(x - r), i1 = cellIx(x + r), j0 = cellIx(z - r), j1 = cellIx(z + r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cb = cells[j * dim + i].b;
        for (let k = 0; k < cb.length; k++) {
          const id = cb[k];
          if (bStamp[id] === st) continue;
          bStamp[id] = st;
          let d: number;
          if (bRound[id]) d = footprintDistance(plan.buildings[id], x, z);
          else {
            const dx = x - bX[id];
            const dz = z - bZ[id];
            const co = bC[id];
            const si = bS[id];
            const qx = Math.abs(dx * co + dz * si) - bHW[id];
            const qz = Math.abs(-dx * si + dz * co) - bHD[id];
            const ox = Math.max(qx, 0);
            const oz = Math.max(qz, 0);
            const m = Math.max(ox, oz);
            d = (m === 0 ? 0 : Math.sqrt((ox / m) * (ox / m) + (oz / m) * (oz / m)) * m) + Math.min(Math.max(qx, qz), 0);
          }
          if (d <= r) nearIds[n++] = id;
        }
      }
    }
    return n;
  };

  const buildingsNear = (x: number, z: number, r: number, out: number[]): number => {
    q[0] = x;
    q[1] = z;
    q[2] = r;
    const n = nearQ();
    out.length = n;
    for (let i = 0; i < n; i++) out[i] = nearIds[i];
    return n;
  };

  const maxRoofNear = (x: number, z: number, r: number): number => {
    q[0] = x;
    q[1] = z;
    q[2] = r;
    const n = nearQ();
    let h = 0;
    for (let i = 0; i < n; i++) h = Math.max(h, plan.buildings[nearIds[i]].h);
    return h;
  };

  /** collide() with its inputs in q (x, z, r): see the note at the top of the file. */
  const collideQ = (out: { x: number; z: number }): boolean => {
    let x = q[0];
    let z = q[1];
    const r = q[2];
    let moved = false;
    // A few relaxation passes handle corners between two buildings.
    for (let pass = 0; pass < 3; pass++) {
      q[0] = x;
      q[1] = z;
      q[2] = r;
      const n = nearQ();
      let any = false;
      // Point obstacles (discs): push out radially.
      const i0 = cellIx(x - r - 2), i1 = cellIx(x + r + 2), j0 = cellIx(z - r - 2), j1 = cellIx(z + r + 2);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const co = cells[j * dim + i].obs;
          for (let k = 0; k < co.length; k++) {
            const oid = co[k];
            const ox = obstacles[oid * 3];
            const oz = obstacles[oid * 3 + 1];
            const rr = obstacles[oid * 3 + 2] + r;
            const dx = x - ox;
            const dz = z - oz;
            const m = Math.max(Math.abs(dx), Math.abs(dz));
            const d = m === 0 ? 0 : Math.sqrt((dx / m) * (dx / m) + (dz / m) * (dz / m)) * m; // hyp(dx, dz)
            if (d >= rr) continue;
            const kk = d > 1e-9 ? (rr - d) / d : 0;
            x += d > 1e-9 ? dx * kk : rr;
            z += d > 1e-9 ? dz * kk : 0;
            any = true;
            moved = true;
          }
        }
      }
      for (let k = 0; k < n; k++) {
        const id = nearIds[k];
        const c = bC[id];
        const s = bS[id];
        const dx = x - bX[id];
        const dz = z - bZ[id];
        const lx = dx * c + dz * s;
        const lz = -dx * s + dz * c;
        if (bRound[id]) {
          // the rounded wall: push out along the closest point's outward direction
          const b = plan.buildings[id];
          let ring = rings.get(b);
          if (!ring) rings.set(b, (ring = stadiumRing(b)));
          const cp = ringClosest(ring, lx, lz);
          if (cp.d >= r) continue;
          let nx = lx - cp.x;
          let nz = lz - cp.z;
          const l = hyp(nx, nz);
          if (l > 1e-9) {
            nx /= l;
            nz /= l;
            if (cp.d < 0) {
              nx = -nx;
              nz = -nz;
            }
          } else {
            const lc = hyp(lx, lz) || 1;
            nx = lx / lc;
            nz = lz / lc;
          }
          const push = r - cp.d;
          x += (nx * c - nz * s) * push;
          z += (nx * s + nz * c) * push;
          any = true;
          moved = true;
          continue;
        }
        const hw = bHW[id];
        const hd = bHD[id];
        // closest point on the box (local)
        const cx = Math.max(-hw, Math.min(hw, lx));
        const cz = Math.max(-hd, Math.min(hd, lz));
        let nx = lx - cx;
        let nz = lz - cz;
        const m = Math.max(Math.abs(nx), Math.abs(nz));
        const d = m === 0 ? 0 : Math.sqrt((nx / m) * (nx / m) + (nz / m) * (nz / m)) * m; // hyp(nx, nz)
        let push = 0;
        if (d > 1e-9) {
          if (d >= r) continue;
          push = r - d;
          nx /= d;
          nz /= d;
        } else {
          // Centre inside the box: push out through the nearest face.
          const px = hw - Math.abs(lx);
          const pz = hd - Math.abs(lz);
          if (px < pz) {
            nx = Math.sign(lx) || 1;
            nz = 0;
            push = px + r;
          } else {
            nx = 0;
            nz = Math.sign(lz) || 1;
            push = pz + r;
          }
        }
        // back to plan space
        x += (nx * c - nz * s) * push;
        z += (nx * s + nz * c) * push;
        any = true;
        moved = true;
      }
      if (!any) break;
    }
    out.x = x;
    out.z = z;
    return moved;
  };

  const collide = (x: number, z: number, r: number, out: { x: number; z: number }): boolean => {
    q[0] = x;
    q[1] = z;
    q[2] = r;
    return collideQ(out);
  };

  const nearestRoad = (x: number, z: number, maxDist: number, out: { edge: number; dist: number; s: number }): number => {
    out.edge = -1;
    out.dist = Infinity;
    out.s = 0;
    const i0 = cellOf(x - maxDist), i1 = cellOf(x + maxDist), j0 = cellOf(z - maxDist), j1 = cellOf(z + maxDist);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const sid of cells[j * dim + i].seg) {
          const x0 = segPts[sid * 4], z0 = segPts[sid * 4 + 1], x1 = segPts[sid * 4 + 2], z1 = segPts[sid * 4 + 3];
          const dx = x1 - x0;
          const dz = z1 - z0;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
          const d = hyp(x0 + dx * t - x, z0 + dz * t - z);
          if (d < out.dist && d <= maxDist) {
            out.dist = d;
            out.edge = segEdge[sid];
            out.s = segS[sid] + t * Math.sqrt(l2);
          }
        }
      }
    }
    return out.edge;
  };

  const areaH = plan.areas.map((a) => a.h ?? (a.kind === 'water' ? AREA_H + 0.02 : AREA_H));
  const groundH = (x: number, z: number): number => {
    switch (classify(x, z)) {
      case 'road':
      case 'intersection':
        return ROAD_H;
      case 'sidewalk':
      case 'building':
        return ROAD_H + CURB_H;
      case 'outside':
        return opts.terrain ? opts.terrain.surfaceAt(planToDir(x, z, _dir)) - PLATEAU_HEIGHT : 0;
      default: {
        q[0] = x;
        q[1] = z;
        const a = areaAtQ(cellAt(x, z));
        return a >= 0 ? areaH[a] : 0;
      }
    }
  };

  return { plan, classify, isClear, roofAt, maxRoofNear, buildingsNear, collide, nearestRoad, groundH, obstacles, q, classifyQ, collideQ };
}
