// CityIndex: zero-alloc spatial queries over a CityPlan (uniform grid). Pure.
// Used by A1 (where trees may go), A4 (camera / FPV collision), B2 (people avoid buildings) and
// validate.ts (the plan invariants).

import { AREA_H, CURB_H, ROAD_H } from '../config';
import { pointInPolygon } from './graph';
import type { Building, CityIndex, CityPlan, Feature, GroundClass } from './types';

const CELL = 8;

/** Default collision radius of a point feature (Feature.r overrides). */
const FEATURE_R: Record<string, number> = { streetlight: 0.2, tree: 0.4, flag: 0.15, bench: 0.5, 'bus-stop': 0.6, fountain: 1.6 };
export function featureRadius(f: Feature): number {
  return f.r ?? FEATURE_R[f.kind] ?? 0;
}

export interface CityIndexOptions {
  /** Terrain height relative to the plateau (m) at a plan point outside the plan (groundH there). */
  terrainH?(x: number, z: number): number;
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
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0);
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
  return Math.hypot(x0 + dx * t - px, z0 + dz * t - pz);
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

  const cellAt = (x: number, z: number) => cells[cellOf(z) * dim + cellOf(x)];

  const inIntersection = (x: number, z: number, c: Cell, pad: number) => {
    for (const id of c.node) {
      const n = plan.nodes[id];
      const d = Math.hypot(x - n.x, z - n.z);
      if (d > n.radius + 3 + pad) continue;
      if (pad > 0 ? d < n.radius + pad : pointInPolygon(plan.intersections[id].outline, x, z)) return true;
    }
    return false;
  };

  const classify = (x: number, z: number): GroundClass => {
    if (Math.hypot(x, z) > plan.radius) return 'outside';
    const c = cellAt(x, z);
    for (const id of c.b) if (obbDistance(plan.buildings[id], x, z) <= 0) return 'building';
    if (inIntersection(x, z, c, 0)) return 'intersection';
    let side = false;
    for (const sid of c.seg) {
      const e = plan.edges[segEdge[sid]];
      const d = segDist(x, z, segPts[sid * 4], segPts[sid * 4 + 1], segPts[sid * 4 + 2], segPts[sid * 4 + 3]);
      if (d <= e.width / 2) return 'road';
      if (d <= e.width / 2 + e.sidewalk) side = true;
    }
    if (side) return 'sidewalk';
    for (const wid of c.walk) {
      const o = wid * 5;
      if (segDist(x, z, walkSeg[o], walkSeg[o + 1], walkSeg[o + 2], walkSeg[o + 3]) <= walkSeg[o + 4]) return 'sidewalk';
    }
    for (const id of c.area) {
      const a = plan.areas[id];
      if (pointInPolygon(a.outline, x, z)) return a.kind === 'plaza' ? 'plaza' : a.kind === 'park' ? 'park' : a.kind === 'garden' ? 'garden' : 'free';
    }
    return 'free';
  };

  const isClear = (x: number, z: number, r: number): boolean => {
    if (Math.hypot(x, z) + r > plan.radius) return false;
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
          if (Math.hypot(x - n.x, z - n.z) < n.radius + r) return false;
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
      if (b.h > h && obbDistance(b, x, z) <= 0) h = b.h;
    }
    return h;
  };

  const buildingsNear = (x: number, z: number, r: number, out: number[]): number => {
    stamp = (stamp + 1) >>> 0;
    if (stamp === 0) {
      bStamp.fill(0);
      stamp = 1;
    }
    let n = 0;
    out.length = 0;
    const i0 = cellOf(x - r), i1 = cellOf(x + r), j0 = cellOf(z - r), j1 = cellOf(z + r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = cells[j * dim + i];
        for (const id of c.b) {
          if (bStamp[id] === stamp) continue;
          bStamp[id] = stamp;
          if (obbDistance(plan.buildings[id], x, z) <= r) out[n++] = id;
        }
      }
    }
    return n;
  };

  const near: number[] = [];
  const maxRoofNear = (x: number, z: number, r: number): number => {
    const n = buildingsNear(x, z, r, near);
    let h = 0;
    for (let i = 0; i < n; i++) h = Math.max(h, plan.buildings[near[i]].h);
    return h;
  };

  const collide = (x: number, z: number, r: number, out: { x: number; z: number }): boolean => {
    let moved = false;
    // A few relaxation passes handle corners between two buildings.
    for (let pass = 0; pass < 3; pass++) {
      const n = buildingsNear(x, z, r, near);
      let any = false;
      // Point obstacles (discs): push out radially.
      const i0 = cellOf(x - r - 2), i1 = cellOf(x + r + 2), j0 = cellOf(z - r - 2), j1 = cellOf(z + r + 2);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          for (const oid of cells[j * dim + i].obs) {
            const ox = obstacles[oid * 3];
            const oz = obstacles[oid * 3 + 1];
            const rr = obstacles[oid * 3 + 2] + r;
            const dx = x - ox;
            const dz = z - oz;
            const d = Math.hypot(dx, dz);
            if (d >= rr) continue;
            const k = d > 1e-9 ? (rr - d) / d : 0;
            x += d > 1e-9 ? dx * k : rr;
            z += d > 1e-9 ? dz * k : 0;
            any = true;
            moved = true;
          }
        }
      }
      for (let k = 0; k < n; k++) {
        const b = plan.buildings[near[k]];
        const c = Math.cos(b.angle);
        const s = Math.sin(b.angle);
        const dx = x - b.x;
        const dz = z - b.z;
        const lx = dx * c + dz * s;
        const lz = -dx * s + dz * c;
        const hw = b.w / 2;
        const hd = b.d / 2;
        // closest point on the box (local)
        const cx = Math.max(-hw, Math.min(hw, lx));
        const cz = Math.max(-hd, Math.min(hd, lz));
        let nx = lx - cx;
        let nz = lz - cz;
        let d = Math.hypot(nx, nz);
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
          d = 0;
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
          const d = Math.hypot(x0 + dx * t - x, z0 + dz * t - z);
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

  const groundH = (x: number, z: number): number => {
    switch (classify(x, z)) {
      case 'road':
      case 'intersection':
        return ROAD_H;
      case 'sidewalk':
      case 'building':
        return ROAD_H + CURB_H;
      case 'plaza':
      case 'park':
      case 'garden':
        return AREA_H;
      case 'free': {
        // 'free' also covers lots / water / field areas; any area is drawn at AREA_H.
        const c = cellAt(x, z);
        for (const id of c.area) if (pointInPolygon(plan.areas[id].outline, x, z)) return AREA_H;
        return 0;
      }
      default:
        return opts.terrainH ? opts.terrainH(x, z) : 0;
    }
  };

  return { plan, classify, isClear, roofAt, maxRoofNear, buildingsNear, collide, nearestRoad, groundH, obstacles };
}
