// Where a descent touches down (pure, no three.js). Used by the scripted dive (camera/dive.ts: its
// landing pose) and by the interactive zoom / fly-to (camera/index.ts: the touchdown resolver).
//
// A landing is a spot on the pavement (sidewalk, corner, plaza or park path, never a carriageway)
// plus a view heading, scored on what the first street-level frame will show:
//   - nothing in the face: no pole, trunk or crown within 4 m inside ±30–35° of the view, no facade
//     closer than a few metres ahead, room to the side;
//   - a long view: clear distance down the street before the first building;
//   - light: the spot and the street ahead in sun, not in a tower's shadow;
//   - life (dive only): building mass in view, the clock tower visible, poles kept off the view
//     axis, the view turned 7–13° off the street axis so the street recedes diagonally;
//   - for the interactive resolver: close to where the zoom was heading and turning the view little.
//
// Camera "solids" are vertical cylinders [x, z, r, h0, h1] (heights above the plateau) built from
// the plan's features: lamp poles and their heads reaching over the road, tree trunks and crowns
// (crowns come down to eye height), shelters, flags. CityIndex.obstacles only has the 2D discs FPV
// collides with; a camera flying at 4 m also has to miss a lamp head and a crown.

import { EYE_HEIGHT } from '../world/config';
import { planFrame } from '../world/city/frame';
import { sampleAt } from '../world/city/path';
import type { Building, CityIndex, CityPlan } from '../world/city/types';
import { v3, type Vec3 } from '../world/sphere';

const DEG = Math.PI / 180;
/** The dive's landing: no pole within this half-angle of the view axis (rad). */
const POLE_HALF = 8 * DEG;
/** The dive's landing: the eye at least this far from the kerb (m; the middle of a 2.2 m sidewalk is 1.1). */
const KERB_MIN = 0.95;
/** The dive's landing: this far (m) from either end of a zebra crossing. */
const CROSS_CLEAR = 5;
/** Stride of the solids array. */
export const SOLID = 5;

/** Signed distance (m) from plan (x, z) to building b's footprint (negative inside). */
export function buildingDistance(b: Building, x: number, z: number): number {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const dx = x - b.x;
  const dz = z - b.z;
  const qx = Math.abs(dx * c + dz * s) - b.w / 2;
  const qz = Math.abs(-dx * s + dz * c) - b.d / 2;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}

/** The camera's solids for a plan: vertical cylinders [x, z, r, h0, h1] (m above the plateau). */
export function cameraSolids(plan: CityPlan): Float64Array {
  const out: number[] = [];
  const add = (x: number, z: number, r: number, h0: number, h1: number) => out.push(x, z, r, h0, h1);
  for (const f of plan.features) {
    switch (f.kind) {
      case 'streetlight': {
        // pole, and the head on its arm 1.25 m out over the road (local +x = (cos a, sin a))
        add(f.x, f.z, 0.2, 0, 5.3);
        add(f.x + Math.cos(f.angle) * 0.75, f.z + Math.sin(f.angle) * 0.75, 0.75, 4.6, 5.5);
        break;
      }
      case 'tree': {
        const size = Math.max(2.5, Math.min(10, f.size ?? 5));
        add(f.x, f.z, Math.max(0.3, f.r ?? 0.4), 0, size * 0.4);
        add(f.x, f.z, size * 0.42, size * 0.28, size * 1.02);
        break;
      }
      case 'lamp':
        add(f.x, f.z, 0.22, 0, 3.7);
        break;
      case 'flag':
        add(f.x, f.z, 0.2, 0, 7.5);
        break;
      case 'bus-stop':
        add(f.x, f.z, Math.max(1.1, f.r ?? 0), 0, 2.8);
        break;
      case 'fountain':
        add(f.x, f.z, f.r ?? 1.6, 0, 2.4);
        break;
      case 'bench':
        add(f.x, f.z, f.r ?? 0.5, 0, 1.0);
        break;
      default:
        if ((f.r ?? 0) > 0) add(f.x, f.z, f.r!, 0, 1.5);
        else if (f.kind === 'hydrant') add(f.x, f.z, 0.2, 0, 0.8);
    }
  }
  return Float64Array.from(out);
}

/** The solids whose discs reach into the plan box [x0, x1] × [z0, z1], into out (grown as needed); returns it. */
export function solidsIn(solids: Float64Array, x0: number, z0: number, x1: number, z1: number, out: { a: Float64Array; n: number }): Float64Array {
  let n = 0;
  for (let i = 0; i < solids.length; i += SOLID) {
    const r = solids[i + 2];
    if (solids[i] + r < x0 || solids[i] - r > x1 || solids[i + 1] + r < z0 || solids[i + 1] - r > z1) continue;
    if (n + SOLID > out.a.length) {
      const g = new Float64Array(out.a.length * 2 + SOLID * 16);
      g.set(out.a);
      out.a = g;
    }
    for (let k = 0; k < SOLID; k++) out.a[n + k] = solids[i + k];
    n += SOLID;
  }
  out.n = n;
  return out.a.subarray(0, n);
}

/** Distance from a point at height h to a vertical cylinder (≤ 0 inside). */
function cylDist(dh: number, r: number, h0: number, h1: number, h: number): number {
  const d = dh - r;
  const g = h < h0 ? h0 - h : h > h1 ? h - h1 : 0;
  if (g <= 0) return d;
  return d > 0 ? Math.hypot(d, g) : g;
}

/**
 * 3D clearance (m) from an eye at plan (x, z), h m above the plateau, to the nearest camera solid or
 * building box (≤ 0 inside one). `near` is scratch for buildingsNear.
 */
export function clearanceAt(index: CityIndex, solids: Float64Array, x: number, z: number, h: number, near: number[], reach = 12): number {
  let best = reach;
  for (let i = 0; i < solids.length; i += SOLID) {
    const dx = solids[i] - x;
    const dz = solids[i + 1] - z;
    if (Math.abs(dx) > best + solids[i + 2] || Math.abs(dz) > best + solids[i + 2]) continue;
    const d = cylDist(Math.hypot(dx, dz), solids[i + 2], solids[i + 3], solids[i + 4], h);
    if (d < best) best = d;
  }
  const n = index.buildingsNear(x, z, best, near);
  for (let k = 0; k < n; k++) {
    const b = index.plan.buildings[near[k]];
    const d = cylDist(buildingDistance(b, x, z), 0, -1, b.h, h);
    if (d < best) best = d;
  }
  return best;
}

/**
 * True if a solid at eye level sits within `dist` m of the eye (x, z) inside ±`half` of the plan
 * heading (hx, hz): it would fill the frame (a pole as a black bar, a crown as a green wall).
 */
export function coneBlocked(solids: Float64Array, x: number, z: number, hx: number, hz: number, eye: number, dist: number, half: number, len = solids.length): boolean {
  for (let i = 0; i < len; i += SOLID) {
    if (solids[i + 4] < eye - 1.2 || solids[i + 3] > eye + 1.4) continue;
    const dx = solids[i] - x;
    const dz = solids[i + 1] - z;
    const r = solids[i + 2];
    const hyp = Math.hypot(dx, dz);
    if (hyp - r > dist) continue;
    if (hyp <= r) return true;
    const along = dx * hx + dz * hz;
    if (along <= -r) continue;
    const lat = Math.abs(-dx * hz + dz * hx);
    const ang = Math.atan2(lat, along) - Math.asin(Math.min(1, r / hyp));
    if (ang < half) return true;
  }
  return false;
}

/**
 * Smallest clearance margin (m; ≥ 0 = passes) along a planned glide: n samples of plan (xs, zs) and
 * eye height hs (m above the plateau), the last one the touchdown. Every camera solid and facade
 * must stay 1.5 m away in flight, 0.6 m once the eye is at walking height (≤ 2.4 m: walking passes
 * poles that close) and in the last 3 m to the spot; near the start, only the room it already
 * has. `near` is scratch. Returns early (with a margin below it) once the margin drops under
 * `stopBelow`.
 */
export function glideMargin(index: CityIndex, solids: Float64Array, xs: ArrayLike<number>, zs: ArrayLike<number>, hs: ArrayLike<number>, n: number, near: number[], stopBelow = -Infinity): number {
  let margin = Infinity;
  const ex = xs[n - 1];
  const ez = zs[n - 1];
  // Where the camera already is counts as fine: near the start a path need only keep the room it
  // has (and gain 0.5 m per metre it moves away).
  const c0 = Math.max(0.3, clearanceAt(index, solids, xs[0], zs[0], hs[0], near, 3) - 0.1);
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const z = zs[i];
    const h = hs[i];
    const lift = h - index.groundH(x, z);
    const needH = 0.6 + 0.9 * Math.min(1, Math.max(0, (lift - 2.4) / 1.5));
    const needT = 0.6 + 0.9 * Math.min(1, Math.hypot(x - ex, z - ez) / 3);
    const need = Math.min(needH, needT, c0 + 0.5 * Math.hypot(x - xs[0], z - zs[0]));
    const m = clearanceAt(index, solids, x, z, h, near, need + 1) - need;
    if (m < margin) {
      margin = m;
      if (m < stopBelow) return m; // already worse than a path in hand
    }
  }
  return margin;
}

export interface LandingQuery {
  /** Search centre (plan) and radius (m). */
  cx: number;
  cz: number;
  radius: number;
  /** Preferred plan heading (atan2(dx, −dz)), or NaN for none. */
  heading: number;
  /** World unit vector toward the sun (lighting score). */
  sun: Vec3;
  /** The scripted dive's landing: stricter rules, liveliness, whole-city search. */
  dive: boolean;
  /**
   * Interactive: the eye height (m above the plateau) the glide from (cx, cz) starts at. Spots whose
   * glide would pass a building taller than the descending eye are marked down (the camera would
   * have to climb over it or graze its wall on the way in).
   */
  fromAlt?: number;
  /** Interactive: what the zoom aimed at (plan). The landing turns to face it (within ~30°). */
  aimX?: number;
  aimZ?: number;
}

export interface Landing {
  x: number;
  z: number;
  /** Plan heading (atan2(dx, −dz)). */
  heading: number;
  score: number;
}

interface Kerb {
  cd: number;
  queue: number;
  rx: number;
  rz: number;
}

const WALK_KINDS_DIVE: Record<string, number> = { sidewalk: 1, corner: 1, plaza: 1 };
const PAVED: Record<string, number> = { sidewalk: 1, plaza: 1 };
/** The dive's view turns off the pavement line: toward the road (+) and away from it (−). */
const DIVE_TURNS = [0, 7 * DEG, 13 * DEG];
const NO_TURN = [0];
const ZONE_W: Partial<Record<string, number>> = { residential: 0.5, downtown: 1.2 };
/** Where the dive stands across a pavement: share of the way from its centre line to the building side. */
const ACROSS_DIVE = [0.55, 1];
const WALK_KINDS_LIVE: Record<string, number> = { sidewalk: 1, corner: 1, plaza: 1 };

/** Everything the scorer needs, with scratch (one per caller, reused). */
export class LandingFinder {
  private readonly near: number[] = [];
  /** Solids within reach of the position being scored (the view-cone test only needs those). */
  private local = new Float64Array(SOLID * 32);
  private nLocal = 0;
  private readonly frame = { up: v3(), ax: v3(), az: v3() };
  private readonly road = { edge: -1, dist: 0, s: 0 };
  private readonly rs = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  private readonly tower: Building | null;

  constructor(
    readonly plan: CityPlan,
    readonly index: CityIndex,
    readonly solids: Float64Array = cameraSolids(plan),
  ) {
    this.tower = plan.buildings.find((b) => b.landmark === 'clocktower') ?? null;
    const poles: number[] = [];
    for (let i = 0; i < solids.length; i += SOLID) {
      if (solids[i + 2] <= 0.3 && solids[i + 3] <= 0.5 && solids[i + 4] >= 3.4) for (let k = 0; k < SOLID; k++) poles.push(solids[i + k]);
    }
    this.poles = Float64Array.from(poles);
    const ends: number[] = [];
    for (const w of plan.walkEdges) {
      if (w.kind !== 'crossing') continue;
      const n = w.path.pts.length;
      ends.push(w.path.pts[0], w.path.pts[1], w.path.pts[n - 2], w.path.pts[n - 1]);
    }
    this.crossEnds = Float64Array.from(ends);
    const n = plan.buildings.length;
    this.bb = new Float64Array(n * 7);
    plan.buildings.forEach((b, i) => {
      this.bb.set([b.x, b.z, Math.cos(b.angle), Math.sin(b.angle), b.w / 2, b.d / 2, b.h], i * 7);
    });
  }

  /** Both ends of every zebra crossing (x, z interleaved). */
  private readonly crossEnds: Float64Array;
  /** Thin solids taller than the eye (streetlight, lamp and flag poles). */
  private readonly poles: Float64Array;
  /** Buildings as [x, z, cos, sin, half w, half d, h] (ray tests without trig). */
  private readonly bb: Float64Array;

  /**
   * Cast a plan ray from (x, z) along unit (dx, dz): the entry distance of the first building it
   * meets (≤ max), skipping buildings whose roof is below `h + t·rise` at entry (a ray climbing at
   * `rise` per metre: the sun ray; 0 for a level view at eye height, which every roof is above).
   */
  ray(x: number, z: number, dx: number, dz: number, max: number, h = 0, rise = 0): number {
    const B = this.bb;
    let best = max;
    for (let i = 0; i < B.length; i += 7) {
      const ox = x - B[i];
      const oz = z - B[i + 1];
      const c = B[i + 2];
      const sn = B[i + 3];
      const hw = B[i + 4];
      const hd = B[i + 5];
      const rad = hw + hd;
      // quick reject: box behind, or farther than the best hit
      const along = -(ox * dx + oz * dz);
      if (along < -rad || along - rad > best) continue;
      if (Math.abs(ox * dz - oz * dx) > rad) continue;
      const lx = ox * c + oz * sn;
      const lz = -ox * sn + oz * c;
      const ux = dx * c + dz * sn;
      const uz = -dx * sn + dz * c;
      let t0 = 0;
      let t1 = best;
      if (Math.abs(ux) < 1e-9) {
        if (lx < -hw || lx > hw) continue;
      } else {
        let a = (-hw - lx) / ux;
        let b = (hw - lx) / ux;
        if (a > b) [a, b] = [b, a];
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
      }
      if (Math.abs(uz) < 1e-9) {
        if (lz < -hd || lz > hd) continue;
      } else {
        let a = (-hd - lz) / uz;
        let b = (hd - lz) / uz;
        if (a > b) [a, b] = [b, a];
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
      }
      if (t0 > t1) continue;
      if (B[i + 6] <= h + t0 * rise) continue;
      best = t0;
    }
    return best;
  }

  /** The sun in the plan at (x, z): writes [dirX, dirZ, tanElevation]; false below the horizon. */
  private sunAt(sun: Vec3, x: number, z: number, out: number[]): boolean {
    planFrame(x, z, this.frame);
    const f = this.frame;
    const su = sun.x * f.up.x + sun.y * f.up.y + sun.z * f.up.z;
    const sx = sun.x * f.ax.x + sun.y * f.ax.y + sun.z * f.ax.z;
    const sz = sun.x * f.az.x + sun.y * f.az.y + sun.z * f.az.z;
    const l = Math.hypot(sx, sz) || 1;
    out[0] = sx / l;
    out[1] = sz / l;
    out[2] = su / l;
    return su > 0.03;
  }

  /** True if plan (x, z) at height h is in sunlight (no roof between it and the sun). */
  lit(sun: Vec3, x: number, z: number, h: number): boolean {
    const s = _sun;
    if (!this.sunAt(sun, x, z, s)) return false;
    return this.ray(x, z, s[0], s[1], 60, h, s[2]) >= 60;
  }

  /** Clear distance (m, ≤ max) along plan heading (hx, hz) at eye height before a building. */
  viewLength(x: number, z: number, hx: number, hz: number, max: number): number {
    return this.ray(x, z, hx, hz, max);
  }

  /**
   * The near carriageway at (x, z), into this.kerb: `cd` = distance (m) from the kerb (nearest road
   * centreline minus half its width; 9 with no road within 8 m), (rx, rz) the road's nearest
   * centreline point, and `queue` 0..1 = how deep the spot sits in the zone where the lanes on its
   * side queue for their stop line (vehicles parked beside the lens for a minute). Heading-free, so
   * one call serves every heading and every offset across the pavement (cd grows by the offset).
   */
  private kerbAt(x: number, z: number): void {
    const k = this.kerb;
    k.cd = 9;
    k.queue = 0;
    k.rx = x;
    k.rz = z;
    if (this.index.nearestRoad(x, z, 8, this.road) < 0) return;
    const e = this.plan.edges[this.road.edge];
    k.cd = this.road.dist - e.width / 2;
    sampleAt(e.centre, this.road.s, this.rs);
    k.rx = this.rs.x;
    k.rz = this.rs.z;
    // Right of a→b ⇒ the lanes on our side run a→b (right-hand traffic), else b→a.
    const ab = (x - this.rs.x) * -this.rs.tz + (z - this.rs.z) * this.rs.tx > 0;
    const lanes = ab ? e.lanesAB : e.lanesBA;
    const sL = ab ? this.road.s : e.centre.length - this.road.s;
    for (let i = 0; i < lanes.length; i++) {
      // The outermost lane (next to the kerb) counts fully.
      const d = this.plan.lanes[lanes[i]].stopS - sL;
      const w = d < -4 || d > 34 ? 0 : d < 0 ? (d + 4) / 4 : d < 22 ? 1 : 1 - (d - 22) / 12;
      k.queue = Math.max(k.queue, w * (i === lanes.length - 1 ? 1 : 0.6));
    }
  }
  private readonly kerb: Kerb = { cd: 9, queue: 0, rx: 0, rz: 0 };
  private diveBonus = 0;
  /** The dive spot being scored (prepDive): its kerb, and the poles within 23 m of it. */
  private readonly dk: Kerb = { cd: 9, queue: 0, rx: 0, rz: 0 };
  private lPoles = new Float64Array(SOLID * 16);
  private nPoles = 0;

  /**
   * Per-spot part of the dive's rules (heading-free, so once per spot): the kerb (`hint`: a walk
   * sample's kerb with cd already offset, else measured here) at least KERB_MIN away, clear of
   * both ends of every zebra (people wait there and cross at the lens), and the poles near it
   * gathered for poleOnAxis. False if the spot is unusable.
   */
  private prepDive(x: number, z: number, hint: Kerb | null): boolean {
    if (hint) Object.assign(this.dk, hint);
    else {
      this.kerbAt(x, z);
      Object.assign(this.dk, this.kerb);
    }
    if (this.dk.cd < KERB_MIN) return false;
    const ce = this.crossEnds;
    for (let i = 0; i < ce.length; i += 2) if ((ce[i] - x) ** 2 + (ce[i + 1] - z) ** 2 < CROSS_CLEAR * CROSS_CLEAR) return false;
    const s = this.poles;
    let n = 0;
    for (let i = 0; i < s.length; i += SOLID) {
      if (Math.abs(s[i] - x) > 23 || Math.abs(s[i + 1] - z) > 23) continue;
      if (n + SOLID > this.lPoles.length) {
        const g = new Float64Array(this.lPoles.length * 2);
        g.set(this.lPoles);
        this.lPoles = g;
      }
      for (let k = 0; k < SOLID; k++) this.lPoles[n + k] = s[i + k];
      n += SOLID;
    }
    this.nPoles = n;
    return true;
  }

  /**
   * True if a pole (streetlight, lamp, flag: thin and taller than the eye) stands within `max` m
   * ahead inside ±`half` of the view axis: a dark bar splitting the frame.
   */
  poleOnAxis(x: number, z: number, hx: number, hz: number, half: number, max = 22, s = this.poles, len = s.length): boolean {
    for (let i = 0; i < len; i += SOLID) {
      const r = s[i + 2];
      const dx = s[i] - x;
      const dz = s[i + 1] - z;
      const along = dx * hx + dz * hz;
      if (along < 0.5 || along > max) continue;
      const ang = Math.atan2(Math.abs(-dx * hz + dz * hx), along) - Math.asin(Math.min(1, r / Math.hypot(dx, dz)));
      if (ang < half) return true;
    }
    return false;
  }

  /**
   * Distance (m, ≤ max) from (x, z) to the nearest carriageway or junction patch, marched along 12
   * rays (exact near corners, where the nearest centreline says little). Stage 2 only: ~150
   * classify calls.
   */
  kerbDist(x: number, z: number, max = 3.2): number {
    let best = max;
    for (let k = 0; k < 12; k++) {
      const dx = Math.cos((k * Math.PI) / 6);
      const dz = Math.sin((k * Math.PI) / 6);
      for (let d = 0.25; d < best; d += 0.25) {
        const c = this.index.classify(x + dx * d, z + dz * d);
        if (c === 'road' || c === 'intersection') {
          best = d;
          break;
        }
      }
    }
    return best;
  }

  /** Nearest facade (m, ≤ 8) to plan (x, z). */
  private sideRoom(x: number, z: number): number {
    const B = this.bb;
    let side = 8;
    for (let i = 0; i < B.length; i += 7) {
      const dx = x - B[i];
      const dz = z - B[i + 1];
      if (Math.abs(dx) > side + B[i + 4] + B[i + 5] || Math.abs(dz) > side + B[i + 4] + B[i + 5]) continue;
      const qx = Math.abs(dx * B[i + 2] + dz * B[i + 3]) - B[i + 4];
      const qz = Math.abs(-dx * B[i + 3] + dz * B[i + 2]) - B[i + 5];
      const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
      if (d < side) side = d;
    }
    return side;
  }

  /**
   * The cheap part of a spot's score (view length, side room, sun on the spot, distance and turn):
   * −Infinity if unusable. `side` and `litSpot` are per position (computed by the caller).
   */
  private coarse(x: number, z: number, heading: number, q: LandingQuery, side: number, litSpot: number): number {
    const hx = Math.sin(heading);
    const hz = -Math.cos(heading);
    if (q.dive) {
      // The poster frame (prepDive ran for this spot): no pole splitting the centre, not looking
      // out over a junction's empty asphalt; the road on the left (the kerb lane's cars drive away
      // down the street, oncoming ones keep to the far lane; B2's walkers keep right, so oncoming
      // ones pass out along the kerb), standing well off the kerb lane and away from its queue.
      const kb = this.dk;
      if (this.poleOnAxis(x, z, hx, hz, POLE_HALF, 22, this.lPoles, this.nPoles)) return -Infinity;
      const left = -(kb.rx - x) * hz + (kb.rz - z) * hx < 0;
      this.diveBonus = Math.min(1, (kb.cd - KERB_MIN) / 1.2) * 1.2 - kb.queue * 3 + (left ? 0.6 : 0);
    }
    const L = this.viewLength(x, z, hx, hz, q.dive ? 90 : 60);
    if (L < (q.dive ? 26 : 6)) return q.dive ? -Infinity : -6 + L * 0.2;
    // The frame's sides: a facade close ahead-left or ahead-right fills half the first frame.
    const c18 = Math.cos(18 * DEG);
    const s18 = Math.sin(18 * DEG);
    const Ll = this.viewLength(x, z, hx * c18 + hz * s18, hz * c18 - hx * s18, 40);
    const Lr = this.viewLength(x, z, hx * c18 - hz * s18, hz * c18 + hx * s18, 40);
    const Lmax = q.dive ? 70 : 50;
    // (The dive wants a street canyon — facades both sides — so only a facade right in front counts.)
    let sc = q.dive ? (Math.min(L, Lmax) / Lmax) * 2.4 : (0.7 * Math.min(L, Lmax) / Lmax + 0.15 * (Math.min(Ll, 40) + Math.min(Lr, 40)) / 40) * 1.6;
    const sideMin = Math.min(Ll, Lr);
    const sideNeed = q.dive ? 5 : 10;
    if (sideMin < sideNeed) sc -= (1 - sideMin / sideNeed) * 1.2;
    sc += Math.min(1, (side - 0.9) / 3) * (q.dive ? 1.0 : 0.5);
    sc += litSpot * (q.dive ? 1.6 : 0.8);
    if (coneBlocked(this.local, x, z, hx, hz, EYE_HEIGHT + 0.2, 4, (q.dive ? 30 : 35) * DEG, this.nLocal)) {
      if (q.dive) return -Infinity;
      sc -= 8;
    }
    if (q.dive && (this.index.classify(x + hx * 4, z + hz * 4) === 'intersection' || this.index.classify(x + hx * 8, z + hz * 8) === 'intersection')) return -Infinity;
    // (The dive's clock tower is scored here, so views of it make the cut for the full score.)
    if (q.dive) sc += this.diveBonus + (this.tower && this.towerVisible(x, z, hx, hz) ? 1.3 : 0);
    if (!q.dive) {
      const gl = Math.hypot(x - q.cx, z - q.cz);
      sc -= gl * 0.07;
      if (q.fromAlt !== undefined && gl > 1) {
        // The glide in: three parallel rays (±1.3 m) along a conservative straight descent.
        const dx = (x - q.cx) / gl;
        const dz = (z - q.cz) / gl;
        const h0 = q.fromAlt * 0.55;
        const rise = (EYE_HEIGHT - h0) / gl;
        for (const off of [-1.3, 0, 1.3]) {
          if (this.ray(q.cx - dz * off, q.cz + dx * off, dx, dz, gl - 0.3, h0, rise) < gl - 0.3) {
            sc -= 4;
            break;
          }
        }
      }
      if (Number.isFinite(q.heading)) {
        let dh = heading - q.heading;
        dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
        sc -= Math.abs(dh) * 0.6;
      }
      if (q.aimX !== undefined && q.aimZ !== undefined) {
        // Land facing what the zoom aimed at: its bearing within ~30° of the view, not underfoot,
        // not far behind the spot.
        const ax = q.aimX - x;
        const az = q.aimZ - z;
        const ad = Math.hypot(ax, az);
        if (ad > 3) {
          const off = Math.abs(Math.atan2(ax * hz - az * hx, ax * hx + az * hz));
          if (off > 25 * DEG) sc -= (off - 25 * DEG) * 5;
        }
        if (ad > 35) sc -= (ad - 35) * 0.05;
      }
    }
    return sc;
  }

  /** The expensive part: poles near the view axis, sun down the street, life in view (dive). */
  private fine(x: number, z: number, heading: number, q: LandingQuery, toward: number): number {
    const hx = Math.sin(heading);
    const hz = -Math.cos(heading);
    const eye = EYE_HEIGHT + 0.2;
    let sc = 0;
    // Poles and trunks near the view axis (a vertical bar through the frame).
    let pole = 0;
    const s = this.solids;
    const need = q.dive ? 3 : 1.6;
    for (let i = 0; i < s.length; i += SOLID) {
      if (s[i + 3] > eye + 1 || s[i + 4] < eye - 1) continue;
      const dx = s[i] - x;
      const dz = s[i + 1] - z;
      const along = dx * hx + dz * hz;
      if (along < 0.5 || along > 30) continue;
      const off = Math.abs(-dx * hz + dz * hx) - s[i + 2];
      if (off < need) pole += (1 - Math.max(0, off) / need) ** 2 * (1 - along / 32);
    }
    sc -= pole * (q.dive ? 2.2 : 1.6);
    const L = this.viewLength(x, z, hx, hz, 30);
    let litAhead = 0;
    for (let d = 5; d <= 25; d += 10) if (this.lit(q.sun, x + hx * Math.min(d, L), z + hz * Math.min(d, L), 0.3)) litAhead += 1 / 3;
    sc += litAhead * (q.dive ? 1.2 : 0.5);
    {
      let mass = 0;
      let massL = 0;
      for (const b of this.plan.buildings) {
        const dx = b.x - x;
        const dz = b.z - z;
        const dist = Math.hypot(dx, dz);
        if (dist < 6 || dist > 95) continue;
        const lat = -dx * hz + dz * hx;
        const ang = Math.atan2(Math.abs(lat), dx * hx + dz * hz);
        if (ang > 36 * DEG) continue;
        // (The dive: town, not the suburbs: houses count half, downtown a little more.)
        const m = (Math.min(b.h, 28) / 12) * Math.min(1.2, (b.w + b.d) / 2 / dist) * (q.dive ? ZONE_W[b.zone] ?? 1 : 1);
        mass += m;
        if (lat < 0) massL += m;
      }
      // The dive wants a street canyon: town on both sides of the frame, not half meadow.
      if (q.dive) sc += Math.min(1, mass / 2.5) * 1.6 + Math.min(1, Math.min(massL, mass - massL) / 0.7) * 1.6;
      else sc += Math.min(1, mass / 2.5) * 0.8;
      if (!q.dive && this.tower && this.towerVisible(x, z, hx, hz)) sc += 0.5;
    }
    if (q.dive) {
      // The street receding diagonally: turned 7–13° toward the carriageway.
      sc += toward > 5 * DEG && toward < 15 * DEG ? 0.5 : 0;
      // Lawn and verge in the lower frame read as the edge of town.
      for (let k = 0; k < 6; k++) {
        const a = ((k % 3) - 1) * 24 * DEG;
        const d = k < 3 ? 7 : 15;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const c = this.index.classify(x + (hx * ca - hz * sa) * d, z + (hz * ca + hx * sa) * d);
        if (c === 'free' || c === 'garden' || c === 'outside' || c === 'park') sc -= 0.3;
      }
    } else {
      // Unpaved ground ahead may hold the nature scatter's trees (they are not in the plan).
      const c = this.index.classify(x + hx * 3, z + hz * 3);
      if (c === 'free' || c === 'garden') sc -= 0.4;
    }
    return sc;
  }

  private gatherLocal(x: number, z: number) {
    const s = this.solids;
    let n = 0;
    for (let i = 0; i < s.length; i += SOLID) {
      const reach = 4.6 + s[i + 2];
      if (Math.abs(s[i] - x) > reach || Math.abs(s[i + 1] - z) > reach) continue;
      if (n + SOLID > this.local.length) {
        const g = new Float64Array(this.local.length * 2);
        g.set(this.local);
        this.local = g;
      }
      for (let k = 0; k < SOLID; k++) this.local[n + k] = s[i + k];
      n += SOLID;
    }
    this.nLocal = n;
  }

  /** Full score of one spot and heading (higher is better; −Infinity = unusable). */
  score(x: number, z: number, heading: number, q: LandingQuery, toward = 0): number {
    if (this.index.collide(x, z, 0.55, _o)) return -Infinity;
    const side = this.sideRoom(x, z);
    if (side < 0.9) return -Infinity;
    this.gatherLocal(x, z);
    if (q.dive && !this.prepDive(x, z, null)) return -Infinity;
    const c = this.coarse(x, z, heading, q, side, this.lit(q.sun, x, z, EYE_HEIGHT + 0.2) ? 1 : 0);
    return c === -Infinity ? c : c + this.fine(x, z, heading, q, toward);
  }

  private towerVisible(x: number, z: number, hx: number, hz: number): boolean {
    const t = this.tower!;
    const dx = t.x - x;
    const dz = t.z - z;
    const D = Math.hypot(dx, dz);
    if (D < 10) return false;
    const ang = Math.atan2(Math.abs(-dx * hz + dz * hx), dx * hx + dz * hz);
    if (ang > 22 * DEG) return false;
    const top = t.h - 3; // the clock faces
    // A sight line climbing from the eye to the clock faces: blocked by any roof above it.
    // (Stop short of the tower's own box, corners included: it used to hide itself.)
    const len = D - Math.hypot(t.w, t.d) / 2 - 0.2;
    const rise = (top - EYE_HEIGHT) / D;
    if (this.ray(x, z, dx / D, dz / D, len, EYE_HEIGHT, rise) < len) return false;
    // ...or by a tree crown (the park's canopy hid it from a "tower view" at the park's edge).
    const s = this.solids;
    const ux = dx / D;
    const uz = dz / D;
    for (let i = 0; i < s.length; i += SOLID) {
      const ox = s[i] - x;
      const oz = s[i + 1] - z;
      const a = ox * ux + oz * uz;
      // (Crowns only: a thin pole in front of it hides a sliver, not the tower.)
      if (s[i + 2] < 0.5 || a < 0 || a > len || Math.abs(-ox * uz + oz * ux) > s[i + 2] * 0.8) continue;
      const hh = EYE_HEIGHT + a * rise;
      if (hh > s[i + 3] && hh < s[i + 4]) return false;
    }
    return true;
  }

  /**
   * Candidate landings near (q.cx, q.cz), best first (at most `max`). Spots are sampled along the
   * pavement walk graph (a few across its width), each with headings along it (both ways for the
   * dive, the ones near q.heading interactively), some turned toward the carriageway. Two stages:
   * a cheap score for every candidate, then the full score for the best few. Allocates (a one-off
   * per descent / per plan).
   */
  find(q: LandingQuery, max: number): Landing[] {
    const plan = this.plan;
    const kinds = q.dive ? WALK_KINDS_DIVE : WALK_KINDS_LIVE;
    const step = q.dive ? 3 : 1.75;
    type Cand = Landing & { toward: number; side: number; lit: number; tx: number; tz: number; dir: number };
    const cand: Cand[] = [];
    const r2 = (q.radius + 2) ** 2;
    const eye = EYE_HEIGHT + 0.2;
    // Stage 1: every spot along the pavement, looking along it both ways.
    for (const w of plan.walkEdges) {
      if (!kinds[w.kind]) continue;
      const p = w.path;
      const np = p.pts.length >> 1;
      let next = 0;
      for (let i = 0; i < np - 1; i++) {
        if (p.s[i + 1] < next) continue;
        const x0 = p.pts[i * 2];
        const z0 = p.pts[i * 2 + 1];
        next = p.s[i] + step;
        if ((x0 - q.cx) ** 2 + (z0 - q.cz) ** 2 > r2) continue;
        const tl = Math.hypot(p.pts[i * 2 + 2] - x0, p.pts[i * 2 + 3] - z0) || 1;
        const tx = (p.pts[i * 2 + 2] - x0) / tl;
        const tz = (p.pts[i * 2 + 3] - z0) / tl;
        // The dive also stands across the pavement, toward its building side (away from the road).
        let away = 0;
        const hint = this.kerb;
        if (q.dive) {
          this.kerbAt(x0, z0);
          if (hint.cd < 9) away = (x0 - hint.rx) * -tz + (z0 - hint.rz) * tx > 0 ? 1 : -1;
        }
        const cd0 = hint.cd;
        const across = Math.max(0, w.width / 2 - 0.35);
        for (const o of away ? ACROSS_DIVE : NO_TURN) {
          const x = x0 - tz * away * across * o;
          const z = z0 + tx * away * across * o;
          if (q.dive) {
            // Along a sidewalk the kerb is parallel: the offset adds to the sample's distance;
            // corners and plazas measure it at the spot.
            hint.cd = cd0 + across * o;
            if (!this.prepDive(x, z, w.kind === 'sidewalk' ? hint : null)) continue;
          }
          if (o > 0 && !PAVED[this.index.classify(x, z)]) continue;
          if (this.index.collide(x, z, 0.55, _o)) continue;
          const side = this.sideRoom(x, z);
          if (side < 0.9) continue;
          const lit = this.lit(q.sun, x, z, eye) ? 1 : 0;
          this.gatherLocal(x, z);
          for (const dir of [1, -1]) {
            const h0 = Math.atan2(tx * dir, -tz * dir);
            if (!q.dive && Number.isFinite(q.heading)) {
              let d = h0 - q.heading;
              d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
              if (Math.abs(d) > Math.PI * 0.6) continue;
            }
            // The dive also tries the view turned toward the road (the street recedes diagonally,
            // the kerb's poles cross off the centre) and a little away from it. Plan heading grows
            // clockwise; the road is on the right of the view when −away·dir > 0.
            for (const o of q.dive ? DIVE_TURNS : NO_TURN) {
              const h = h0 - away * dir * o;
              const sc = this.coarse(x, z, h, q, side, lit);
              if (sc !== -Infinity) cand.push({ x, z, heading: h, score: sc, toward: o, side, lit, tx, tz, dir });
            }
            if (q.dive && this.tower) {
              // ...and the view turned onto the clock tower when it stands within 28° of the line.
              let d = Math.atan2(this.tower.x - x, -(this.tower.z - z)) - h0;
              d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
              if (Math.abs(d) > 2 * DEG && Math.abs(d) < 28 * DEG) {
                const sc = this.coarse(x, z, h0 + d, q, side, lit);
                if (sc !== -Infinity) cand.push({ x, z, heading: h0 + d, score: sc, toward: Math.abs(d), side, lit, tx, tz, dir });
              }
            }
          }
        }
      }
    }
    cand.sort((a, b) => b.score - a.score);
    // Stage 2: the best few, also turned toward the carriageway (the street recedes diagonally,
    // poles at the curb move off the view axis), with the full score.
    const offs = q.dive ? NO_TURN.slice(1) : [9 * DEG, -9 * DEG];
    const top: Cand[] = [];
    // The best few distinct spots (variants of one spot and its neighbours would crowd them out).
    const pool: Cand[] = [];
    for (const c of cand) {
      if (pool.length >= (q.dive ? 60 : 10)) break;
      if (q.dive && pool.some((k) => (k.x - c.x) ** 2 + (k.z - c.z) ** 2 < 9 && Math.abs(Math.sin((k.heading - c.heading) / 2)) < 0.2)) continue;
      pool.push(c);
    }
    for (const c of pool) {
      if (q.dive) {
        // Re-score with the kerb measured at the spot itself: near a junction the walk sample's
        // nearest road (the stage-1 hint) can be another edge than the spot's.
        this.gatherLocal(c.x, c.z);
        c.score = this.prepDive(c.x, c.z, null) ? this.coarse(c.x, c.z, c.heading, q, c.side, c.lit) : -Infinity;
        if (c.score === -Infinity) continue;
      }
      top.push(c);
      if (!offs.length && q.aimX === undefined) continue;
      let rs = 0;
      if (this.index.nearestRoad(c.x, c.z, 12, this.road) >= 0) {
        sampleAt(plan.edges[this.road.edge].centre, this.road.s, this.rs);
        rs = Math.sign((this.rs.x - c.x) * -c.tz + (this.rs.z - c.z) * c.tx) || 0;
      }
      this.gatherLocal(c.x, c.z);
      for (const o of offs) {
        // Plan heading grows clockwise (toward the right of the walking direction); the
        // carriageway is on the right when rs·dir > 0.
        const h = c.heading + (rs * c.dir >= 0 ? 1 : -1) * o;
        const sc = this.coarse(c.x, c.z, h, q, c.side, c.lit);
        if (sc !== -Infinity) top.push({ ...c, heading: h, score: sc, toward: o });
      }
      if (q.aimX !== undefined && q.aimZ !== undefined) {
        // Turned toward what the zoom aimed at (up to 45° off the pavement's line).
        let d = Math.atan2(q.aimX - c.x, -(q.aimZ - c.z)) - c.heading;
        d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
        if (Math.abs(d) > 4 * DEG) {
          const h = c.heading + Math.max(-45 * DEG, Math.min(45 * DEG, d));
          const sc = this.coarse(c.x, c.z, h, q, c.side, c.lit);
          if (sc !== -Infinity) top.push({ ...c, heading: h, score: sc, toward: Math.abs(d) });
        }
      }
    }
    for (const c of top) c.score += this.fine(c.x, c.z, c.heading, q, c.toward);
    top.sort((a, b) => b.score - a.score);
    // Keep spots spread out (not 20 variants of one corner).
    const keep: Landing[] = [];
    for (const c of top) {
      if (keep.length >= max || c.score === -Infinity) break;
      // The kerb, measured properly (near a corner the nearest centreline says little).
      if (q.dive && this.kerbDist(c.x, c.z, KERB_MIN) < KERB_MIN - 0.2) continue;
      if (keep.some((k) => Math.hypot(k.x - c.x, k.z - c.z) < (q.dive ? 3 : 1) && Math.abs(Math.sin((k.heading - c.heading) / 2)) < 0.2)) continue;
      keep.push({ x: c.x, z: c.z, heading: c.heading, score: c.score });
    }
    return keep;
  }
}

const _o = { x: 0, z: 0 };
const _sun = [0, 0, 0];
