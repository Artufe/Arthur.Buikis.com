// Static world clearance shared by ride, transition and bird cameras.
// Owns its scratch vectors and spatial grid; queries allocate only when the solids change.
import { Vector3 } from 'three';
import type { LBContext } from '../core/contracts';
import { AREA_H, CITY_PLAN_RADIUS, PLATEAU_HEIGHT, R, ROAD_H } from '../world/config';
import type { SurfaceHit } from '../world/region/types';
import { fromSphere, planToDir } from '../world/city/frame';
import { footprintDistance } from '../world/city/index-grid';
import type { Building } from '../world/city/types';
import { v3 } from '../world/sphere';
import { SOLID, solidsIn } from './landing';
import { BIRD } from './bird/flight';
/** (v2-BF) A solid whose top is within this (m) over the bird's body is under it. */
const BIRD_STEP = BIRD.step;
/** (v2-BF) The countryside's crowns to the bird: a column this wide round each trunk (m), under TREE_H over the ground. */
const TREE_R = 0.9;
const TREE_H = 7;
/** (v2-BF) The capital's garden edges (hedges, picket fences, low walls; city/props.ts gardenEdge): their tallest top over the plateau, the band's half width round the run (m). */
const HEDGE_TOP = AREA_H + 1.25;
const HEDGE_BAND = 0.4;
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

  /** (D1f r4) The highest roof top (m above the plateau) within r of plan (x, z), or 0. */
  function roofNear(ctx: LBContext, x: number, z: number, r: number): number {
    const idx = ctx.world.cityIndex;
    const n = idx.buildingsNear(x, z, r, near);
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, roofTop(idx.plan.buildings[near[i]]));
    return top;
  }

  // ── v2-BF: the capital's garden edges, for the bird camera (sight line and placement): each garden's
  // four runs, 0.35 m in from its outline (city/props.ts gardenEdge), on a grid built on first use. ──
  let hedgeSeg: Float64Array | null = null;
  let hedgeStart: Int32Array | null = null;
  let hedgeItems: Int32Array | null = null;

  function buildHedges(ctx: LBContext) {
    const segs: number[] = [];
    for (const a of ctx.world.cityIndex.plan.areas) {
      const o = a.outline;
      if (a.kind !== 'garden' || o.length !== 8) continue;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const ax = o[i * 2], az = o[i * 2 + 1], bx = o[j * 2], bz = o[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.5) continue;
        const ix = (-(bz - az) / L) * 0.35;
        const iz = ((bx - ax) / L) * 0.35;
        segs.push(ax + ix, az + iz, bx + ix, bz + iz);
      }
    }
    const all = Float64Array.from(segs);
    const counts = new Int32Array(GRID_N * GRID_N + 1);
    const each = (fn: (cell: number, k: number) => void) => {
      for (let k = 0; k < all.length; k += 4) {
        const m = HEDGE_BAND + 1;
        const x0 = Math.max(0, Math.floor((Math.min(all[k], all[k + 2]) - m) / GRID) + GRID_HALF);
        const x1 = Math.min(GRID_N - 1, Math.floor((Math.max(all[k], all[k + 2]) + m) / GRID) + GRID_HALF);
        const z0 = Math.max(0, Math.floor((Math.min(all[k + 1], all[k + 3]) - m) / GRID) + GRID_HALF);
        const z1 = Math.min(GRID_N - 1, Math.floor((Math.max(all[k + 1], all[k + 3]) + m) / GRID) + GRID_HALF);
        for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) fn(gz * GRID_N + gx, k);
      }
    };
    each((c) => counts[c + 1]++);
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const items = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, GRID_N * GRID_N);
    each((c, k) => (items[fill[c]++] = k));
    hedgeSeg = all;
    hedgeStart = counts;
    hedgeItems = items;
  }

  /** A capital garden edge within r (≤ 1 m) of plan (x, z). */
  function hedgeNear(ctx: LBContext, x: number, z: number, r: number): boolean {
    if (!hedgeSeg) buildHedges(ctx);
    const gx = Math.floor(x / GRID) + GRID_HALF;
    const gz = Math.floor(z / GRID) + GRID_HALF;
    if (gx < 0 || gz < 0 || gx >= GRID_N || gz >= GRID_N) return false;
    const c = gz * GRID_N + gx;
    const S = hedgeSeg!;
    const rr = r + HEDGE_BAND;
    for (let i = hedgeStart![c]; i < hedgeStart![c + 1]; i++) {
      const k = hedgeItems![i];
      const sx = S[k + 2] - S[k];
      const sz = S[k + 3] - S[k + 1];
      const t = Math.max(0, Math.min(1, ((x - S[k]) * sx + (z - S[k + 1]) * sz) / (sx * sx + sz * sz)));
      const ex = S[k] + sx * t - x;
      const ez = S[k + 1] + sz * t - z;
      if (ex * ex + ez * ez < rr * rr) return true;
    }
    return false;
  }

  /**
   * (v2-BF) The top (m above sea level) of the hedges, garden fences and paddock rails within r (≤ 1 m)
   * of unit dir (the capital's gardens, the towns' gardens and paddocks), or −Infinity. Zero-alloc.
   */
  function hedgeTop(ctx: LBContext, dir: Vector3, r: number): number {
    if (inCity(dir, 0)) return hedgeNear(ctx, plan.x, plan.z, r) ? PLATEAU_HEIGHT + HEDGE_TOP : -Infinity;
    const towns = ctx.services.towns;
    if (!towns) return -Infinity;
    vA.x = dir.x;
    vA.y = dir.y;
    vA.z = dir.z;
    return towns.fenceTop(vA, r);
  }

  // ── v2-BF: what the bird meets. A solid whose top is within BIRD_STEP over the body's height is under
  // it (a floor it lands on, skims or bonks down onto); a taller one beside it is a wall. ──

  /**
   * (v2-BF) The top of a building as the bird meets it (m above the plateau): its walls and half its
   * roof's rise (a gable is met half way up its slope); a spire's tower is its walls (the spire is let
   * through).
   */
  function birdTop(b: Building): number {
    return b.roof === 'spire' ? b.h + 0.6 : b.h + (roofTop(b) - b.h) * 0.5;
  }

  /**
   * (v2-BF) The bird's floor (m above sea level) at unit dir for a body at height h: the terrain or the
   * water, and the roofs (the capital's, the towns'), lamp heads and crowns within r of it whose tops are
   * at most h + BIRD_STEP.
   */
  function birdFloor(ctx: LBContext, dir: Vector3, h: number, r: number): number {
    let f = ctx.world.planet.surfaceAt(dir);
    const top = h + BIRD_STEP;
    if (inCity(dir, 20)) {
      const px = plan.x;
      const pz = plan.z;
      const tp = top - PLATEAU_HEIGHT;
      const idx = ctx.world.cityIndex;
      // (The paving it stands on: the sidewalks are 0.2 m over the plateau, the road 5 cm. Standing on
      // the bare plateau the bird sank to its belly in a sidewalk, its legs gone: it read as lying on its side.)
      f = Math.max(f, PLATEAU_HEIGHT + idx.groundH(px, pz));
      const n = idx.buildingsNear(px, pz, r, near);
      for (let i = 0; i < n; i++) {
        const t = birdTop(idx.plan.buildings[near[i]]);
        if (t <= tp && PLATEAU_HEIGHT + t > f) f = PLATEAU_HEIGHT + t;
      }
      const all = solids();
      if (all) {
        if (gridSolids !== all) buildGrid(all);
        const gx = Math.floor(px / GRID) + GRID_HALF;
        const gz = Math.floor(pz / GRID) + GRID_HALF;
        if (gx >= 0 && gz >= 0 && gx < GRID_N && gz < GRID_N) {
          const c = gz * GRID_N + gx;
          const S = gridSolids!;
          for (let i = gridStart![c]; i < gridStart![c + 1]; i++) {
            const k = gridItems![i];
            const t = S[k + 4];
            if (t > tp || PLATEAU_HEIGHT + t <= f) continue;
            const rr = S[k + 2] + r;
            const dx = S[k] - px;
            const dz = S[k + 1] - pz;
            if (dx * dx + dz * dz < rr * rr) f = PLATEAU_HEIGHT + t;
          }
        }
      }
    } else {
      vA.x = dir.x;
      vA.y = dir.y;
      vA.z = dir.z;
      // The paving: a town street's asphalt and its sidewalks CURB_H over it (roads/ground.ts); out on
      // a country road, its asphalt ROAD_H over the ground. (On land only: a bridge's deck is not the
      // bird's floor out there.)
      const towns = ctx.services.towns;
      const pave = towns ? towns.pavingAt(vA, top) : -Infinity;
      if (pave > -Infinity) f = Math.max(f, pave);
      else if (f > 0) {
        const reg = ctx.world.planet.region;
        reg.surface(vA, surf);
        if (surf.cls === 'road' && surf.edge >= 0 && surf.roadDist <= reg.edges[surf.edge].width / 2) f += ROAD_H;
      }
      if (towns) f = Math.max(f, towns.roofAt(vA, top, r));
    }
    return f;
  }
  const surf: SurfaceHit = { cls: 'free', roadDist: 0, edge: -1, settlement: -1 };

  /**
   * (v2-BF) Push the bird's body (radius r, centre at h m above sea level) at unit dir out of what stands
   * beside it: the capital's facades and its poles, lamp heads and crowns at its height, the towns'
   * walls, the countryside's trunks and crowns low down (all taller than h + BIRD_STEP). Writes the
   * resolved unit dir into o; true if it moved. Zero-alloc.
   */
  function birdSolid(ctx: LBContext, dir: Vector3, h: number, r: number, o: Vector3): boolean {
    const top = h + BIRD_STEP;
    if (inCity(dir, 8 + r)) {
      let px = plan.x;
      let pz = plan.z;
      const tp = top - PLATEAU_HEIGHT;
      const hp = h - PLATEAU_HEIGHT;
      const idx = ctx.world.cityIndex;
      const B = idx.plan.buildings;
      let moved = false;
      // Facades: out along the footprint's gradient (a few passes for a corner between two).
      for (let pass = 0, any = true; pass < 3 && any; pass++) {
        any = false;
        const n = idx.buildingsNear(px, pz, r, near);
        for (let i = 0; i < n; i++) {
          const b = B[near[i]];
          if (birdTop(b) <= tp) continue;
          const d = footprintDistance(b, px, pz);
          if (d >= r) continue;
          const e = 0.05;
          let gx = footprintDistance(b, px + e, pz) - footprintDistance(b, px - e, pz);
          let gz = footprintDistance(b, px, pz + e) - footprintDistance(b, px, pz - e);
          const gl = Math.hypot(gx, gz);
          if (gl < 1e-9) {
            gx = px - b.x;
            gz = pz - b.z;
          }
          const k = (r - d) / (Math.hypot(gx, gz) || 1);
          px += gx * k;
          pz += gz * k;
          moved = any = true;
        }
      }
      // Poles, lamp heads and crowns: vertical cylinders, met where the body overlaps them in height.
      const all = solids();
      if (all) {
        if (gridSolids !== all) buildGrid(all);
        const gx = Math.floor(px / GRID) + GRID_HALF;
        const gz = Math.floor(pz / GRID) + GRID_HALF;
        if (gx >= 0 && gz >= 0 && gx < GRID_N && gz < GRID_N) {
          const c = gz * GRID_N + gx;
          const S = gridSolids!;
          for (let i = gridStart![c]; i < gridStart![c + 1]; i++) {
            const k = gridItems![i];
            if (S[k + 4] <= tp || S[k + 3] >= hp + r) continue;
            const rr = S[k + 2] + r;
            const dx = px - S[k];
            const dz = pz - S[k + 1];
            const d2 = dx * dx + dz * dz;
            if (d2 >= rr * rr) continue;
            const d = Math.sqrt(d2);
            if (d < 1e-6) {
              px += rr;
            } else {
              px = S[k] + (dx / d) * rr;
              pz = S[k + 1] + (dz / d) * rr;
            }
            moved = true;
          }
        }
      }
      if (!moved) return false;
      planToDir(px, pz, vA);
      o.set(vA.x, vA.y, vA.z);
      return true;
    }
    vA.x = dir.x;
    vA.y = dir.y;
    vA.z = dir.z;
    const towns = ctx.services.towns;
    if (towns && towns.near(vA)) {
      if (!towns.solid(vA, top, r, vA)) return false;
      o.set(vA.x, vA.y, vA.z);
      return true;
    }
    // The countryside's trees low down: a column round each trunk as wide as a crown (nature has no
    // heights; under ~7 m over the ground a body that close is in the crown or at the trunk).
    const nat = ctx.services.nature;
    if (!nat || h - ctx.world.planet.surfaceAt(dir) > TREE_H) return false;
    if (!nat.collide(vA, r + TREE_R, vA)) return false;
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
   * (v2-BF) The bird camera's occlusion: as free(), but only what truly stands between the bird and its
   * lens pulls the boom in. Thin solids (poles, lamp posts, flagpoles, hydrants, trunks: proxies under
   * 0.9 m across, drawn thinner) are looked past; the countryside's trees only where their crowns are
   * (2.5 … 9.5 m over the ground, not their trunks); the towns' buildings count too, and the hedges and
   * garden fences low down (the capital's gardens, the towns' gardens and paddocks). Zero-alloc.
   */
  function birdFree(ctx: LBContext, a: Vector3, b: Vector3): number {
    const len = a.distanceTo(b);
    if (len < 0.5) return 1;
    // (Finer than free(): a hedge is 0.7 m thick.)
    const n = Math.min(24, Math.max(6, Math.ceil(len / 0.4)));
    let local = 0;
    const all = solids();
    const city = inCity(a, 12) || inCity(b, 12);
    if (all && city) {
      fromSphere(tD.copy(a).normalize(), plan);
      const ax = plan.x;
      const az = plan.z;
      fromSphere(tD.copy(b).normalize(), plan);
      solidsIn(all, Math.min(ax, plan.x) - 1, Math.min(az, plan.z) - 1, Math.max(ax, plan.x) + 1, Math.max(az, plan.z) + 1, localSolids);
      local = localSolids.n;
    }
    const L = localSolids.a;
    const nat = city ? undefined : ctx.services.nature;
    const towns = city ? undefined : ctx.services.towns;
    tJ.copy(a).normalize();
    tD.copy(b).normalize();
    const nearTowns = !!towns && (towns.near(tJ) || towns.near(tD));
    // (The ground under the segment's low end, for the hedge test's reach.)
    const hfl = Math.min(ctx.world.planet.surfaceAt(tJ), ctx.world.planet.surfaceAt(tD)) + (city ? AREA_H : 0);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      tD.lerpVectors(a, b, t);
      const h = tD.length() - R;
      tD.normalize();
      // (A floor margin and a first stretch smaller than free()'s: the line starts on the bird, low.)
      if (hardFloor(ctx, tD) > h - 0.25) return Math.max(0, (i - 1) / n);
      if (t * len < 0.3) continue;
      if (nat) {
        const agl = h - ctx.world.planet.surfaceAt(tD);
        if (agl > 2.5 && agl < 9.5) {
          vA.x = tD.x;
          vA.y = tD.y;
          vA.z = tD.z;
          if (nat.collide(vA, 1.6, vA)) return Math.max(0, (i - 1) / n);
        }
      }
      if (nearTowns) {
        vA.x = tD.x;
        vA.y = tD.y;
        vA.z = tD.z;
        if (towns!.solid(vA, h, 0.2, vA)) return Math.max(0, (i - 1) / n);
      }
      // Hedges and garden fences (≤ 1.25 m), down where they can be in the way.
      // (Cleared by 0.3 m: the line starts on the bird's back, and its body and feet are to be seen too;
      // the lobes are uneven. Not within 0.35 m of the bird across the ground: standing against a
      // hedge, a line up over its back is not through the hedge.)
      if (h < hfl + 1.6 && tD.distanceTo(tJ) * R > 0.35 && hedgeTop(ctx, tD, 0) > h - 0.3) return Math.max(0, (i - 1) / n);
      if (local === 0) continue;
      fromSphere(tD, plan);
      const hp = h - PLATEAU_HEIGHT;
      for (let k = 0; k < local; k += SOLID) {
        if (L[k + 2] < 0.45) continue;
        if (hp < L[k + 3] - 0.2 || hp > L[k + 4] + 0.2) continue;
        const r = L[k + 2] + 0.2;
        const dx = L[k] - plan.x;
        const dz = L[k + 1] - plan.z;
        if (dx * dx + dz * dz < r * r) return Math.max(0, (i - 1) / n);
      }
    }
    return 1;
  }

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


  return { plan, inCity, solidTop, hardFloor, wall, roofTop, roofNear, birdFloor, birdSolid, hedgeTop, free, birdFree, nearBlocked, sight };
}
