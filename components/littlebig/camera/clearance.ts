// Static world clearance shared by ride, transition and bird cameras.
// Owns its scratch vectors and spatial grid; queries allocate only when the solids change.
import { Vector3 } from 'three';
import type { LBContext } from '../core/contracts';
import { CITY_PLAN_RADIUS, PLATEAU_HEIGHT, R } from '../world/config';
import { fromSphere, planToDir } from '../world/city/frame';
import { footprintDistance } from '../world/city/index-grid';
import type { Building } from '../world/city/types';
import { v3 } from '../world/sphere';
import { SOLID, solidsIn } from './landing';
const TOWER_BERTH = 2.4;
export function createClearance(solids: () => Float64Array | null) {
  const plan = { x: 0, z: 0 };
  const planOut = { x: 0, z: 0 };
  const near: number[] = [];
  const vA = v3();
  const tD = new Vector3();
  const tJ = new Vector3();
  /** Inside the capital's plan (plan coords in `plan`). */
  function inCity(dir: Vector3, pad = 0): boolean {
    fromSphere(dir, plan);
    return plan.x * plan.x + plan.z * plan.z < (CITY_PLAN_RADIUS + pad) ** 2;
  }

  // ── The city's camera solids (lamp heads, crowns, poles) on a grid, built on first use ──
  const GRID = 6;
  const GRID_HALF = Math.ceil((CITY_PLAN_RADIUS + 12) / GRID);
  const GRID_N = GRID_HALF * 2;
  let gridSolids: Float64Array | null = null;
  let gridStart: Int32Array | null = null;
  let gridItems: Int32Array | null = null;

  function buildGrid(all: Float64Array) {
    const counts = new Int32Array(GRID_N * GRID_N + 1);
    const each = (fn: (cell: number, k: number) => void) => {
      for (let k = 0; k < all.length; k += SOLID) {
        const r = all[k + 2] + 1;
        const x0 = Math.max(0, Math.floor((all[k] - r) / GRID) + GRID_HALF);
        const x1 = Math.min(GRID_N - 1, Math.floor((all[k] + r) / GRID) + GRID_HALF);
        const z0 = Math.max(0, Math.floor((all[k + 1] - r) / GRID) + GRID_HALF);
        const z1 = Math.min(GRID_N - 1, Math.floor((all[k + 1] + r) / GRID) + GRID_HALF);
        for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) fn(gz * GRID_N + gx, k);
      }
    };
    each((c) => counts[c + 1]++);
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const items = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, GRID_N * GRID_N);
    each((c, k) => (items[fill[c]++] = k));
    gridSolids = all;
    gridStart = counts;
    gridItems = items;
  }

  /**
   * Top (m above the plateau) of the highest camera solid whose disc, widened by `pad`, contains
   * plan (x, z), or −1. Zero-alloc after the first call.
   */
  function solidTop(x: number, z: number, pad: number, crownExtra = 0): number {
    const all = solids();
    if (!all) return -1;
    if (gridSolids !== all) buildGrid(all);
    const gx = Math.floor(x / GRID) + GRID_HALF;
    const gz = Math.floor(z / GRID) + GRID_HALF;
    if (gx < 0 || gz < 0 || gx >= GRID_N || gz >= GRID_N) return -1;
    const c = gz * GRID_N + gx;
    const S = gridSolids!;
    let top = -1;
    for (let i = gridStart![c]; i < gridStart![c + 1]; i++) {
      const k = gridItems![i];
      const r = S[k + 2] + pad;
      const dx = S[k] - x;
      const dz = S[k + 1] - z;
      if (dx * dx + dz * dz < r * r) {
        // (Crowns — the wide solids — may ask for some extra headroom.)
        const t = S[k + 4] + (S[k + 2] >= 1.2 ? crownExtra : 0);
        if (t > top) top = t;
      }
    }
    return top;
  }

  /** Terrain or water, and the roof directly under (m above sea level). */
  function hardFloor(ctx: LBContext, dir: Vector3): number {
    let f = ctx.world.planet.surfaceAt(dir);
    if (inCity(dir, 20)) {
      const roof = ctx.world.cityIndex.roofAt(plan.x, plan.z);
      if (roof > 0) f = Math.max(f, PLATEAU_HEIGHT + roof);
    }
    return f;
  }

  /** Push a low body out of facades taller than it (city only). */
  function wall(ctx: LBContext, dir: Vector3, h: number, r: number, o: Vector3): boolean {
    if (!inCity(dir, 8)) return false;
    const idx = ctx.world.cityIndex;
    const n = idx.buildingsNear(plan.x, plan.z, r, near);
    let tall = false;
    for (let i = 0; i < n; i++) {
      if (PLATEAU_HEIGHT + idx.plan.buildings[near[i]].h > h - 0.3) {
        tall = true;
        break;
      }
    }
    if (!tall || !idx.collide(plan.x, plan.z, r, planOut)) return false;
    planToDir(planOut.x, planOut.z, vA);
    o.set(vA.x, vA.y, vA.z);
    return true;
  }

  /** (D1f r4) The top of a building's roof (m above the plateau): a spire, a gable or a dome over its walls. */
  function roofTop(b: Building): number {
    switch (b.roof) {
      case 'spire':
        return b.h + 3;
      case 'gable':
      case 'hip':
      case 'dome':
        return b.h + 2.5;
      case 'stepped':
        return b.h + 1.5;
      default:
        return b.h + 0.6;
    }
  }

  /** (D1f r4) The extra berth (m) the bird keeps off a slender tall building: the clock tower, the church, a thin tower. */
  function towerBerth(b: Building): number {
    return b.landmark === 'clocktower' || b.landmark === 'church' || (b.h > 18 && Math.max(b.w, b.d) < 10) ? TOWER_BERTH : 0;
  }

  /** (D1f r4) The highest roof top (m above the plateau) within r of plan (x, z), or 0. */
  function roofNear(ctx: LBContext, x: number, z: number, r: number): number {
    const idx = ctx.world.cityIndex;
    const n = idx.buildingsNear(x, z, r, near);
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, roofTop(idx.plan.buildings[near[i]]));
    return top;
  }

  /**
   * (D1f r4) The bird's walls: wall() by the roofs' real tops, and for its look-ahead (r > 1.5 m) a
   * slender tall building keeps TOWER_BERTH more — it flew at the clock tower's face 2 m off and
   * skimmed its spire.
   */
  function birdWall(ctx: LBContext, dir: Vector3, h: number, r: number, o: Vector3): boolean {
    const wide = r > 1.5;
    if (!inCity(dir, 8 + (wide ? TOWER_BERTH : 0))) return false;
    const px = plan.x;
    const pz = plan.z;
    const idx = ctx.world.cityIndex;
    const B = idx.plan.buildings;
    const n = idx.buildingsNear(px, pz, r + (wide ? TOWER_BERTH : 0), near);
    let tall = false;
    let tower = -1;
    let push = 0;
    for (let i = 0; i < n; i++) {
      const b = B[near[i]];
      if (PLATEAU_HEIGHT + roofTop(b) <= h - 0.3) continue;
      const d = footprintDistance(b, px, pz);
      if (d < r) tall = true;
      else if (wide) {
        const ex = towerBerth(b);
        if (ex > 0 && d < r + ex && r + ex - d > push) {
          push = r + ex - d;
          tower = near[i];
        }
      }
    }
    if (tall && idx.collide(px, pz, r, planOut)) {
      planToDir(planOut.x, planOut.z, vA);
      o.set(vA.x, vA.y, vA.z);
      return true;
    }
    if (tower < 0) return false;
    const b = B[tower];
    const dx = px - b.x;
    const dz = pz - b.z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) return false;
    planToDir(px + (dx / L) * push, pz + (dz / L) * push, vA);
    o.set(vA.x, vA.y, vA.z);
    return true;
  }

  /**
   * Fraction of the segment a → b clear of buildings, hills, crowns and lamp heads (the countryside's
   * trees too), from a (the chase / shoulder / bird occlusion). The first 0.8 m is skipped: a walker
   * under a tree, a car beside a lamp post.
   */
  function free(ctx: LBContext, a: Vector3, b: Vector3): number {
    const len = a.distanceTo(b);
    if (len < 0.5) return 1;
    const n = Math.min(24, Math.max(4, Math.ceil(len / 1.2)));
    // The camera solids near the segment, once (city only).
    let local = 0;
    const all = solids();
    if (all && (inCity(a, 12) || inCity(b, 12))) {
      fromSphere(tD.copy(a).normalize(), plan);
      const ax = plan.x;
      const az = plan.z;
      fromSphere(tD.copy(b).normalize(), plan);
      solidsIn(all, Math.min(ax, plan.x) - 1, Math.min(az, plan.z) - 1, Math.max(ax, plan.x) + 1, Math.max(az, plan.z) + 1, localSolids);
      local = localSolids.n;
    }
    const L = localSolids.a;
    const nat = local === 0 && !inCity(a, 0) ? ctx.services.nature : undefined;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      tD.lerpVectors(a, b, t);
      const h = tD.length() - R;
      tD.normalize();
      if (hardFloor(ctx, tD) > h - 0.4) return Math.max(0, (i - 1) / n);
      if (t * len < 0.8) continue;
      // The countryside's trees (trunk discs from nature; crowns up to ~9 m over a ~2 m radius).
      if (local === 0 && nat && h - ctx.world.planet.surfaceAt(tD) < 9.5) {
        vA.x = tD.x;
        vA.y = tD.y;
        vA.z = tD.z;
        if (nat.collide(vA, 2, vA)) return Math.max(0, (i - 1) / n);
      }
      if (local === 0) continue;
      fromSphere(tD, plan);
      const hp = h - PLATEAU_HEIGHT;
      for (let k = 0; k < local; k += SOLID) {
        if (hp < L[k + 3] - 0.35 || hp > L[k + 4] + 0.35) continue;
        const r = L[k + 2] + 0.35;
        const dx = L[k] - plan.x;
        const dz = L[k + 1] - plan.z;
        if (dx * dx + dz * dz < r * r) return Math.max(0, (i - 1) / n);
      }
    }
    return 1;
  }
  const localSolids = { a: new Float64Array(SOLID * 32), n: 0 };

  /**
   * (D1f r2) True when a camera at world p would be within `berth` m of a building not 3.5 m under it,
   * inside (or within 0.45 m of) a pole, lamp head or crown — by their real heights: passing under a
   * crown is fine — or within 1 m of the terrain (outside the city).
   */
  function nearBlocked(ctx: LBContext, p: Vector3, berth: number): boolean {
    const h = p.length() - R;
    tJ.copy(p).normalize();
    if (!inCity(tJ, 4)) return h < ctx.world.planet.surfaceAt(tJ) + 1;
    const idx = ctx.world.cityIndex;
    const n = idx.buildingsNear(plan.x, plan.z, berth, near);
    // (A facade taller than the lens, or a roof less than 3.5 m under it: skimming a roof, it
    // filled the bottom of the frame.)
    for (let i = 0; i < n; i++) if (PLATEAU_HEIGHT + idx.plan.buildings[near[i]].h > h - 3.5) return true;
    if (h < PLATEAU_HEIGHT + 0.6) return true;
    const all = solids();
    if (!all) return false;
    if (gridSolids !== all) buildGrid(all);
    const gx = Math.floor(plan.x / GRID) + GRID_HALF;
    const gz = Math.floor(plan.z / GRID) + GRID_HALF;
    if (gx < 0 || gz < 0 || gx >= GRID_N || gz >= GRID_N) return false;
    const c = gz * GRID_N + gx;
    const S = gridSolids!;
    const hp = h - PLATEAU_HEIGHT;
    for (let i = gridStart![c]; i < gridStart![c + 1]; i++) {
      const k = gridItems![i];
      if (hp < S[k + 3] - 0.4 || hp > S[k + 4] + 0.4) continue;
      const r = S[k + 2] + 0.45;
      const dx = S[k] - plan.x;
      const dz = S[k + 1] - plan.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /** (D1f r2) True when no building or hill stands between a and b (poles and crowns don't count). */
  function sight(ctx: LBContext, a: Vector3, b: Vector3): boolean {
    const len = a.distanceTo(b);
    const n = Math.min(80, Math.max(2, Math.ceil(len / 0.5)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (t * len < 0.6 || (1 - t) * len < 0.6) continue;
      tJ.lerpVectors(a, b, t);
      const h = tJ.length() - R;
      tJ.normalize();
      if (hardFloor(ctx, tJ) > h + 0.05) return false;
    }
    return true;
  }


  return { plan, inCity, solidTop, hardFloor, wall, roofTop, roofNear, birdWall, free, nearBlocked, sight };
}
