// Sight lines for the plan's viewpoints (pure, boot-time). A coarse "skyline" of everything that
// stands up in the city — roofs (plus their props), tree crowns, lamp heads, flags, shelters — so a
// viewpoint can be tested for what it will actually show:
//   - dusk: a clear line to the visible horizon within ±4° of the setting sun (terrain beyond the
//     plateau included), so the disc really touches the horizon in frame;
//   - horizon / rooftops: no lamp head or crown beside the eye, the clock tower unoccluded.
// Heights are metres above the plateau; elevations are seen from an eye on the curved plateau.

import { CITY_SURFACE_R, CURB_H, EYE_HEIGHT, PLATEAU_HEIGHT, ROAD_H } from '../config';
import type { Planet } from '../planet';
import { eveningTimeAt, sunDirection } from '../sun';
import { latLonFromDir, v3 } from '../sphere';
import { planFrame, planToDir } from './frame';
import { obbDistance } from './index-grid';
import type { Building, Feature, Viewpoint } from './types';

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
}

/**
 * The dusk viewpoint: a sidewalk spot whose view toward the setting sun (at the shot's own time
 * there) has an unbroken horizon within ±4°, framed with the disc within ±10° of the centre (30–70 %
 * of the frame width) and turned toward the street's run so it recedes into the sunset.
 */
export function pickDusk(sky: Skyline, planet: Planet | null, spots: WalkSpot[], planR: number, roomy: (x: number, z: number) => boolean): Viewpoint | null {
  const sun = { x: 0, z: 0 };
  const mass = { left: 0, right: 0 };
  const ranked: Array<{ s: WalkSpot; score: number; sx: number; sz: number }> = [];
  for (const s of spots) {
    duskSunDir(s.x, s.z, sun);
    // quick reject: a building or crown within 40 m on the sun's own line
    let open = true;
    for (let d = 1; d < 40 && open; d += 1) {
      const h = sky.topAt(s.x + sun.x * d, s.z + sun.z * d);
      if (h > 0.3 && elevation(h, d) > -DUSK_DIP) open = false;
    }
    if (!open) continue;
    // a street running into the sunset, framed by buildings on BOTH sides
    const align = Math.abs(s.tx * sun.x + s.tz * sun.z);
    sky.frameMass(s.x, s.z, sun.x, sun.z, mass);
    const frame = Math.min(1.5, Math.min(mass.left, mass.right)) * 3 + Math.min(2, mass.left + mass.right);
    ranked.push({ s, score: align * 2 + frame + (s.straight ? 0.8 : 0) + Math.min(2, sky.postClearance(s.x, s.z, 4, 1)) * 0.15, sx: sun.x, sz: sun.z });
  }
  ranked.sort((a, b) => b.score - a.score);
  for (const r of ranked) {
    const { s, sx, sz } = r;
    if (!roomy(s.x, s.z)) continue;
    if (!horizonClear(sky, planet, s.x, s.z, sx, sz, 4, planR)) continue;
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
    return { x: s.x, z: s.z, heading: Math.atan2(vx, -vz) };
  }
  return null;
}
