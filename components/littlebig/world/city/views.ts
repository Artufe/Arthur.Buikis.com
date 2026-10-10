// Sight lines for the plan's viewpoints (pure, boot-time). A coarse "skyline" of everything that
// stands up in the city — roofs (plus their props), tree crowns, lamp heads, flags, shelters — so a
// viewpoint can be tested for what it will actually show:
//   - dusk: a clear line to the visible horizon within ±1.5° of the setting sun (terrain beyond the
//     plateau included), so the disc really touches the horizon in frame — trees and hills may
//     stand beside it;
//   - horizon / rooftops: no lamp head or crown beside the eye, the clock tower unoccluded.
// Heights are metres above the plateau; elevations are seen from an eye on the curved plateau.

import type { Planet } from '../planet';
import type { Building, Feature, PathSample, Viewpoint } from './types';
import { K } from '../../core/debug-kit';
import type { ShotViewInputs, ShotViewName } from './shot-views';

// Review tooling (the debug chunk): engine modules come through the kit, not imports (core/kit.ts).
const { CITY_PLAN_RADIUS, CITY_SURFACE_R, CURB_H, EYE_HEIGHT, PLATEAU_HEIGHT, ROAD_H, getPlanet, eveningTimeAt, sunDirection, latLonFromDir, v3, planFrame, planToDir, obbDistance, sampleAt, setShotViewSolver } = K;

const DEG = Math.PI / 180;
const CELL = 6;
const HALF = 120;
const DIM = Math.ceil((2 * HALF) / CELL);

/** A vertical cylinder that stands up: x, z, radius, top (m above the plateau). */
type Post = [number, number, number, number];

/** Tops of the things a camera could see or hit near street level, by feature kind. */
export function featurePosts(f: Feature): Post[] {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  switch (f.kind) {
    case 'streetlight':
      // pole, and the head on its arm ~1 m out over the road (lamp head 4.9 m up, hood to ~5.1)
      return [[f.x, f.z, 0.15, 5.2], [f.x + c * 1.0, f.z + s * 1.0, 0.6, 5.3]];
    case 'tree': {
      const size = Math.max(2.5, Math.min(10, f.size ?? 5));
      return [[f.x, f.z, size * 0.42, size * 1.02]];
    }
    case 'lamp':
      return [[f.x, f.z, 0.3, 3.9]];
    case 'flag':
      return [[f.x + c * 0.6, f.z + s * 0.6, 0.75, 7.0]];
    case 'bus-stop':
      return [[f.x, f.z, 1.4, 2.8]];
    case 'statue':
      return [[f.x, f.z, 0.8, 3.6]];
    case 'fountain':
      return [[f.x, f.z, 1.6, 2.6]];
    case 'cafe-table':
      return [[f.x, f.z, 1.0, 2.5]];
    default:
      return [];
  }
}

export class Skyline {
  private bCells: number[][] = [];
  private pCells: number[][] = [];
  private posts: Post[] = [];

  constructor(private buildings: Building[], features: Feature[]) {
    for (let i = 0; i < DIM * DIM; i++) {
      this.bCells.push([]);
      this.pCells.push([]);
    }
    buildings.forEach((b, id) => {
      const r = Math.hypot(b.w, b.d) / 2;
      this.span(b.x, b.z, r, (k) => this.bCells[k].push(id));
    });
    for (const f of features) {
      for (const p of featurePosts(f)) {
        const id = this.posts.length;
        this.posts.push(p);
        this.span(p[0], p[1], p[2], (k) => this.pCells[k].push(id));
      }
    }
  }

  private span(x: number, z: number, r: number, fn: (k: number) => void) {
    const i0 = this.cell(x - r), i1 = this.cell(x + r), j0 = this.cell(z - r), j1 = this.cell(z + r);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * DIM + i);
  }

  private cell(v: number) {
    return Math.max(0, Math.min(DIM - 1, Math.floor((v + HALF) / CELL)));
  }

  /** Height of the tallest thing standing at (x, z) (roofs + 2 m of props, crowns, lamp heads), or 0. */
  topAt(x: number, z: number): number {
    const k = this.cell(z) * DIM + this.cell(x);
    let h = 0;
    for (const id of this.bCells[k]) {
      const b = this.buildings[id];
      if (b.h + 2 > h && obbDistance(b, x, z) <= 0) h = b.h + 2;
    }
    for (const id of this.pCells[k]) {
      const p = this.posts[id];
      if (p[3] > h && (x - p[0]) ** 2 + (z - p[1]) ** 2 <= p[2] * p[2]) h = p[3];
    }
    return h;
  }

  /** Closest horizontal distance from (x, z) to a post standing above `minTop` (lamp heads, crowns, flags), minus its radius. */
  postClearance(x: number, z: number, reach: number, minTop: number): number {
    let best = Infinity;
    this.span(x, z, reach, (k) => {
      for (const id of this.pCells[k]) {
        const p = this.posts[id];
        if (p[3] < minTop) continue;
        best = Math.min(best, Math.hypot(x - p[0], z - p[1]) - p[2]);
      }
    });
    return best;
  }

  /**
   * Like postClearance, but only for posts whose centre lies within ±halfDeg of plan direction
   * (dx, dz) from (x, z): what will stand in the middle of a view.
   */
  coneClearance(x: number, z: number, dx: number, dz: number, halfDeg: number, reach: number, minTop: number): number {
    let best = Infinity;
    const cosH = Math.cos(halfDeg * DEG);
    this.span(x, z, reach, (k) => {
      for (const id of this.pCells[k]) {
        const p = this.posts[id];
        if (p[3] < minTop) continue;
        const ox = p[0] - x;
        const oz = p[1] - z;
        const d = Math.hypot(ox, oz);
        if (d > 1e-6 && (ox * dx + oz * dz) / d < cosH) continue;
        best = Math.min(best, d - p[2]);
      }
    });
    return best;
  }

  /**
   * Lamp heads (posts at least `minTop` high and ≤ 0.7 m across) between minDeg and maxDeg off plan
   * direction (dx, dz), dMin–dMax m away: a lamp standing in the frame but off its middle.
   */
  lampsInView(x: number, z: number, dx: number, dz: number, minDeg: number, maxDeg: number, dMin: number, dMax: number, minTop: number): number {
    let n = 0;
    const cMin = Math.cos(maxDeg * DEG);
    const cMax = Math.cos(minDeg * DEG);
    this.span(x, z, dMax, (k) => {
      for (const id of this.pCells[k]) {
        const p = this.posts[id];
        if (p[3] < minTop || p[3] > 6 || p[2] > 0.7) continue;
        const ox = p[0] - x;
        const oz = p[1] - z;
        const d = Math.hypot(ox, oz);
        if (d < dMin || d > dMax) continue;
        const c = (ox * dx + oz * dz) / d;
        if (c >= cMin && c <= cMax) n++;
      }
    });
    return n;
  }

  /**
   * Building mass framing a view along (dx, dz), per side: Σ h / (6 + d) for buildings 8–40° off
   * its axis, 3–50 m away; writes { left, right }.
   */
  frameMass(x: number, z: number, dx: number, dz: number, out: { left: number; right: number }): { left: number; right: number } {
    out.left = 0;
    out.right = 0;
    const c8 = Math.cos(8 * DEG);
    const c40 = Math.cos(40 * DEG);
    for (const b of this.buildings) {
      const ox = b.x - x;
      const oz = b.z - z;
      const d = Math.hypot(ox, oz);
      if (d > 50 || d < 3) continue;
      const c = (ox * dx + oz * dz) / d;
      if (c > c8 || c < c40) continue;
      // right of (dx, dz) is (−dz, dx)
      if (ox * -dz + oz * dx > 0) out.right += b.h / (6 + d);
      else out.left += b.h / (6 + d);
    }
    return out;
  }

  /** Signed distance to the nearest building footprint within reach (Infinity if none). */
  buildingClearance(x: number, z: number, reach: number): number {
    let best = Infinity;
    this.span(x, z, reach, (k) => {
      for (const id of this.bCells[k]) best = Math.min(best, obbDistance(this.buildings[id], x, z));
    });
    return best;
  }

  /**
   * Is the straight line from eye (x0, z0, h0) to target (x1, z1, h1) clear of everything taller
   * than the line (sampled every 0.75 m, skipping `skipEnd` m at the target end)?
   */
  lineClear(x0: number, z0: number, h0: number, x1: number, z1: number, h1: number, skipEnd = 0): boolean {
    const L = Math.hypot(x1 - x0, z1 - z0);
    for (let s = 1.5; s < L - skipEnd; s += 1) {
      const t = s / L;
      const top = this.topAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      // the line's height above the plateau at s, with the plateau's curvature (drop s(L−s)/2R)
      const lineH = h0 + (h1 - h0) * t + (s * (L - s)) / (2 * CITY_SURFACE_R);
      if (top > lineH) return false;
    }
    return true;
  }
}

/** Eye height above the plateau for a person on a sidewalk. */
const EYE = ROAD_H + CURB_H + EYE_HEIGHT;
/** Elevation (rad) of a point h m above the plateau, d m away along the surface, seen from the eye. */
function elevation(h: number, d: number, eye = EYE): number {
  const R = CITY_SURFACE_R;
  const th = d / R;
  return Math.atan2((R + h) * Math.cos(th) - (R + eye), (R + h) * Math.sin(th));
}
/** The visible horizon's dip below the eye's horizontal (rad). */
export const DUSK_DIP = Math.acos(CITY_SURFACE_R / (CITY_SURFACE_R + EYE));

const _d = v3();
const _f = { up: v3(), ax: v3(), az: v3() };
/**
 * Plan direction (unit dx, dz) of the sun at the evening moment the dusk shot uses at (x, z): the
 * disc 1° above the visible horizon (core/shots.ts times it the same way).
 */
export function duskSunDir(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
  const ll = latLonFromDir(planToDir(x, z, _d));
  const t = eveningTimeAt(ll.lat, ll.lon, -(DUSK_DIP / DEG - 1));
  const sun = sunDirection(t, _d);
  planFrame(x, z, _f);
  const sx = sun.x * _f.ax.x + sun.y * _f.ax.y + sun.z * _f.ax.z;
  const sz = sun.x * _f.az.x + sun.y * _f.az.y + sun.z * _f.az.z;
  const l = Math.hypot(sx, sz) || 1;
  out.x = sx / l;
  out.z = sz / l;
  return out;
}

/**
 * Does the horizon show, unbroken, across ±halfDeg around plan direction (dx, dz) from (x, z)?
 * Nothing in the city (skyline) or the terrain beyond it may stand above the visible horizon there.
 */
export function horizonClear(sky: Skyline, planet: Planet | null, x: number, z: number, dx: number, dz: number, halfDeg: number, planR: number): boolean {
  const limit = -DUSK_DIP + 0.25 * DEG;
  for (let a = -halfDeg; a <= halfDeg + 1e-6; a += 1) {
    const c = Math.cos(a * DEG);
    const s = Math.sin(a * DEG);
    const rx = dx * c - dz * s;
    const rz = dx * s + dz * c;
    for (let d = 1; d < 140; d += d < 40 ? 0.5 : 2) {
      const px = x + rx * d;
      const pz = z + rz * d;
      let h: number;
      if (px * px + pz * pz < planR * planR) h = sky.topAt(px, pz);
      else if (planet) h = planet.surfaceAt(planToDir(px, pz, _d)) - PLATEAU_HEIGHT;
      else break;
      if (h > 0.3 && elevation(h, d) > limit) return false;
    }
  }
  return true;
}

/** A sidewalk spot and the street's direction there (for the dusk search). */
export interface WalkSpot {
  x: number;
  z: number;
  tx: number;
  tz: number;
  /** On a straight sidewalk (not a corner round a junction or turning circle). */
  straight: boolean;
  /** Distance to the nearest dead end's turning circle centre (m). */
  endDist?: number;
}

/**
 * The dusk viewpoint: a sidewalk spot whose view toward the setting sun (at the shot's own time
 * there) has an unbroken horizon within ±1.5° (the disc itself; silhouettes may frame it), framed with the disc within ±10° of the centre (30–70 %
 * of the frame width) and turned toward the street's run so it recedes into the sunset. Preferred:
 * a straight sidewalk along a street that runs into the sunset (not the rim of a turning circle),
 * a building line on at least one side and a streetlight in the frame, off its middle.
 */
export function pickDusk(sky: Skyline, planet: Planet | null, spots: WalkSpot[], planR: number, roomy: (x: number, z: number) => boolean): Viewpoint | null {
  const sun = { x: 0, z: 0 };
  const mass = { left: 0, right: 0 };
  const ranked: Array<{ s: WalkSpot; score: number; sx: number; sz: number; both: number }> = [];
  for (const s of spots) {
    duskSunDir(s.x, s.z, sun);
    // quick reject: a building or crown within 40 m on the sun's own line (horizonClear's limit)
    let open = true;
    for (let d = 1; d < 40 && open; d += 1) {
      const h = sky.topAt(s.x + sun.x * d, s.z + sun.z * d);
      if (h > 0.3 && elevation(h, d) > -DUSK_DIP + 0.25 * DEG) open = false;
    }
    if (!open) continue;
    // a street running into the sunset, framed by buildings on BOTH sides
    const align = Math.abs(s.tx * sun.x + s.tz * sun.z);
    sky.frameMass(s.x, s.z, sun.x, sun.z, mass);
    const frame = Math.min(1.5, Math.max(mass.left, mass.right)) * 2 + Math.min(1.5, Math.min(mass.left, mass.right)) * 1.5;
    const lamp = sky.lampsInView(s.x, s.z, sun.x, sun.z, 7, 30, 5, 28, 4) > 0;
    const street = s.straight && align > 0.7;
    // back from a turning circle, so its asphalt disc doesn't fill the foreground
    const back = Math.max(0, Math.min(1, ((s.endDist ?? 99) - 7) / 7)) * 3;
    ranked.push({ s, score: (street ? 4 : 0) + (lamp ? 1.5 : 0) + back + align * 2 + frame + Math.min(2, sky.postClearance(s.x, s.z, 4, 1)) * 0.15, sx: sun.x, sz: sun.z, both: Math.min(mass.left, mass.right) });
  }
  ranked.sort((a, b) => b.score - a.score);
  // v2 (R1): a street between buildings on both sides first (the gate avenues opened the plan's edge:
  // a sidewalk by the park lawn, with the countryside's rocks and the park's walls in the foreground,
  // started winning); anything else only if no such street sees the sun set
  // (and on a straight sidewalk along it, as v1 preferred)
  for (const pass of [0, 1]) for (const r of ranked) {
    const first = r.both >= 0.2 && r.s.straight;
    if ((pass === 0) !== first) continue;
    const { s, sx, sz } = r;
    if (!roomy(s.x, s.z)) continue;
    if (!horizonClear(sky, planet, s.x, s.z, sx, sz, 1.5, planR)) continue;
    // turn the view up to 10° toward the street's run (whichever way along it faces the sun)
    const sign = s.tx * sx + s.tz * sz >= 0 ? 1 : -1;
    const tx = s.tx * sign;
    const tz = s.tz * sign;
    const diff = Math.atan2(sx * tz - sz * tx, sx * tx + sz * tz);
    const off = Math.max(-10 * DEG, Math.min(10 * DEG, diff * 0.5));
    const c = Math.cos(off);
    const sn = Math.sin(off);
    const vx = sx * c - sz * sn;
    const vz = sx * sn + sz * c;
    // nothing standing in the middle of the view close by (a lamp pole a metre ahead splits it)
    if (sky.coneClearance(s.x, s.z, vx, vz, 14, 8, 1.5) < 8) continue;
    // v2 (R1): and nothing solid in the lower frame close by (planters, hedges, low walls a few metres
    // ahead fill a third of the picture as dark blocks against the sunset)
    if (sky.coneClearance(s.x, s.z, vx, vz, 36, 7, 0.3) < 6) continue;
    return { x: s.x, z: s.z, heading: Math.atan2(vx, -vz) };
  }
  return null;
}

// ── the review shots' viewpoints (moved from plan.ts: review tooling only, see shot-views.ts) ──

const skylines = new WeakMap<ShotViewInputs, Skyline>();

/** Solve one of the plan's review-shot viewpoints from its build state. */
export function solveShotViewpoint(name: ShotViewName, inp: ShotViewInputs): Viewpoint {
  const { seed, g, layout, buildings, features, walkEdges, parkPhi, keep, street, obstacleNear } = inp;
  const sp: PathSample = { x: 0, z: 0, tx: 0, tz: 0, i: 0 } as PathSample;
  const heading = (dx: number, dz: number) => Math.atan2(dx, -dz);
  const skyline = () => {
    let s = skylines.get(inp);
    if (!s) skylines.set(inp, (s = new Skyline(buildings, features)));
    return s;
  };
  const computeRooftops = (): Viewpoint => {
    const sky = skyline();
    // Rooftops (16 m, the shot pitches to −24°): far enough out (58–70 m) that the plateau's curve
    // drops the whole clock tower into frame, over open ground, with clear lines to its top, middle
    // and foot — a view in over downtown at the tower. Fallback: the old downtown-edge spot.
    const ra = layout.rot + Math.PI * 0.75;
    let rooftops: Viewpoint = { x: Math.cos(ra) * 30, z: Math.sin(ra) * 30, heading: heading(-Math.cos(ra), -Math.sin(ra)) };
    {
      const ct = buildings.find((b) => b.landmark === 'clocktower');
      if (ct) {
        const eye = 16.4;
        // nearest-to-64 m ring first; the first ring with a clear spot wins (over a road if possible)
        for (const D of [64, 62.5, 65.5, 61, 67, 59.5, 68.5, 58, 70]) {
          let found: Viewpoint | null = null;
          for (let a = 0; a < Math.PI * 2 && !(found && !keep.discClear(found.x, found.z, 1)); a += Math.PI / 60) {
            const x = ct.x + Math.cos(a) * D;
            const z = ct.z + Math.sin(a) * D;
            if (Math.hypot(x, z) > CITY_PLAN_RADIUS - 6) continue;
            if (sky.topAt(x, z) > 8 || sky.buildingClearance(x, z, 4) < 3) continue;
            const skip = ct.w / 2 + 0.6;
            if (!sky.lineClear(x, z, eye, ct.x, ct.z, ct.h, skip) || !sky.lineClear(x, z, eye, ct.x, ct.z, ct.h * 0.5, skip) || !sky.lineClear(x, z, eye, ct.x, ct.z, 3, skip)) continue;
            if (!found || !keep.discClear(x, z, 1)) found = { x, z, heading: heading(ct.x - x, ct.z - z) };
          }
          if (found) {
            rooftops = found;
            break;
          }
        }
      }
    }
    return rooftops;
  };
  const computeHorizon = (): Viewpoint => {
    const sky = skyline();
    // Horizon: on the ring's outer sidewalk where it runs past the park, looking along the ring. The
    // camera stands 6 m up, level with the lamp heads (4.6–5.5 m) and the crowns: keep its column
    // 3 m clear of every lamp head, crown and wall, and the first 14 m ahead clear of crowns.
    let horizon: Viewpoint = { x: 0, z: 0, heading: 0 };
    {
      const phi = parkPhi - 0.32;
      const tx0 = Math.cos(phi) * 62;
      const tz0 = Math.sin(phi) * 62;
      let bestH = Infinity;
      for (const e of g.edges) {
        if (e.kind !== 'ring') continue;
        for (let si = 0; si <= e.centre.length; si += 1) {
          sampleAt(e.centre, si, sp);
          const dPhi = Math.hypot(sp.x - tx0, sp.z - tz0);
          if (dPhi > 40) continue;
          const outward = Math.sign(sp.x * -sp.tz + sp.z * sp.tx) || 1;
          const along = sp.tx * -Math.sin(phi) + sp.tz * Math.cos(phi) > 0 ? 1 : -1;
          const dx = sp.tx * along;
          const dz = sp.tz * along;
          for (const k of [0.5, 0.3, 0.7]) {
            const hoff = outward * (e.width / 2 + e.sidewalk * k);
            const x = sp.x - sp.tz * hoff;
            const z = sp.z + sp.tx * hoff;
            if (sky.postClearance(x, z, 6, 3.5) < 3 || sky.buildingClearance(x, z, 4) < 3) continue;
            // nothing tall standing in the middle of the view for 10 m (a lamp head 4 m ahead fills a quarter of the frame)
            if (sky.coneClearance(x, z, dx, dz, 38, 11, 3.5) < 10) continue;
            const score = dPhi + Math.abs(k - 0.5) * 2;
            if (score < bestH) {
              bestH = score;
              horizon = { x, z, heading: heading(dx, dz) };
            }
          }
        }
      }
    }
    return horizon;
  };
  const computeDusk = (): Viewpoint => {
    const sky = skyline();
    // Dusk: a sidewalk spot whose view toward the setting sun (at the shot's own time there) shows an
    // unbroken horizon within ±1.5° of the disc (views.ts pickDusk); falls back to the most westward
    // open view.
    // v2 (R1): the dead ends are the gate avenues' turning circles, run out to the plateau rim: an open
    // view with no street in it, so spots within 20 m of them are skipped. The 'back from a turning
    // circle' preference still measures from where v1's cul-de-sacs ended (the same line, v1's length:
    // layout.ts), so the shot keeps v1's choice: the corner with the bus and the car into the sunset.
    const v1Ends: Array<{ x: number; z: number }> = layout.culs.map((c) => {
      const p0 = layout.nodes[c.ring];
      const e = layout.nodes[c.end];
      const l = Math.hypot(e.x - p0.x, e.z - p0.z) || 1;
      const L = Math.min(24, CITY_PLAN_RADIUS - Math.hypot(p0.x, p0.z) - 8.6);
      return { x: p0.x + ((e.x - p0.x) / l) * L, z: p0.z + ((e.z - p0.z) / l) * L };
    });
    const spots: WalkSpot[] = [];
    for (const w of walkEdges) {
      if (w.kind !== 'sidewalk' && w.kind !== 'corner') continue;
      for (let si = 0.5; si < w.path.length; si += 1) {
        sampleAt(w.path, si, sp);
        let gateDist = Infinity;
        for (const n of g.nodes) if (n.kind === 'end') gateDist = Math.min(gateDist, Math.hypot(sp.x - n.x, sp.z - n.z));
        if (gateDist < 20) continue;
        let endDist = Infinity;
        for (const n of v1Ends) endDist = Math.min(endDist, Math.hypot(sp.x - n.x, sp.z - n.z));
        spots.push({ x: sp.x, z: sp.z, tx: sp.tx, tz: sp.tz, straight: w.kind === 'sidewalk', endDist });
      }
    }
    const dusk: Viewpoint = pickDusk(sky, getPlanet(seed), spots, CITY_PLAN_RADIUS, (x, z) => !obstacleNear(x, z, 1.2)) ?? { ...street, heading: -Math.PI / 2 };
    return dusk;
  };
  return name === 'rooftops' ? computeRooftops() : name === 'horizon' ? computeHorizon() : computeDusk();
}

/** Let the plan's lazy rooftops / horizon / dusk getters resolve (called by core/shots.ts). */
export function registerShotViews(): void {
  setShotViewSolver(solveShotViewpoint);
}
