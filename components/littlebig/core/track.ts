// v2: the registries behind ctx.services.track and ctx.services.labels (contracts.ts). Owners
// register in init() and unregister in dispose(); the camera and the UI read.

import { Vector3 } from 'three';
import type { LBContext, LabelService, TrackKind, TrackPose, TrackService, Trackable, WorldLabel } from './contracts';
import { CITY_PLAN_RADIUS, PLATEAU_HEIGHT, R } from '../world/config';
import { fromSphere } from '../world/city/frame';

export function createTrackService(ctx: LBContext): TrackService {
  const all: Trackable[] = [];
  const byId = new Map<string, Trackable>();
  const lists = new Map<string, readonly Trackable[]>();
  let version = 0;
  const pose: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
  const o = new Vector3();
  const d = new Vector3();
  const tmp = new Vector3();
  const seg0 = new Vector3();
  const seg1 = new Vector3();
  const mpt = new Vector3();
  const planXZ = { x: 0, z: 0 };
  let roofCeil = -1;

  /**
   * (D1f r2) How far (m) the ray o + s·d runs before it enters a building or the terrain (Infinity:
   * not within tMax). Marched in ≤ 0.5 m steps where something could stand (bigger above every roof
   * and peak); a start inside a building (a camera grazing a wall) ignores that building. Zero-alloc;
   * ~0.02–0.1 ms, and only run when the ray has hit a candidate.
   */
  function firstHit(tMax: number): number {
    const world = ctx.world;
    if (!world?.planet) return Infinity;
    const idx = world.cityIndex;
    if (roofCeil < 0) {
      let top = 0;
      if (idx) for (const b of idx.plan.buildings) top = Math.max(top, b.h);
      roofCeil = PLATEAU_HEIGHT + top + 0.5;
    }
    // (Nothing on the planet stands higher: the tallest roof, the snowy peaks.)
    const ceil = Math.max(roofCeil, 46);
    let s = 0.3;
    let inside = true;
    for (let k = 0; k < 4000 && s < tMax; k++) {
      mpt.copy(o).addScaledVector(d, s);
      const r = mpt.length();
      const h = r - R;
      if (h > ceil + 0.5) {
        // Above everything: heading away from the planet nothing more can be hit, else skip down.
        if (mpt.dot(d) >= 0) return Infinity;
        s += Math.max(0.5, h - ceil);
        inside = false;
        continue;
      }
      mpt.divideScalar(r);
      fromSphere(mpt, planXZ);
      const city = idx && planXZ.x * planXZ.x + planXZ.z * planXZ.z < CITY_PLAN_RADIUS * CITY_PLAN_RADIUS;
      let hit = false;
      // (The plateau is flat under the city — its ground hides nothing standing on it, and the lower
      // half of a far walker's minimum disc is ground: only roofs count there; the terrain outside.)
      if (city) {
        const roof = idx.roofAt(planXZ.x, planXZ.z);
        hit = roof > 0 && h - PLATEAU_HEIGHT < roof;
      } else hit = h < world.planet.surfaceAt(mpt) - 0.3;
      if (hit && !inside) return s;
      if (!hit) inside = false;
      s += city ? 0.5 : 1.5;
    }
    return Infinity;
  }

  const service: TrackService = {
    get version() {
      return version;
    },
    register(t) {
      if (byId.has(t.id) && process.env.NODE_ENV !== 'production') console.warn(`[littlebig] trackable ${t.id} registered twice`);
      all.push(t);
      byId.set(t.id, t);
      lists.clear();
      version++;
      return () => {
        const i = all.indexOf(t);
        if (i < 0) return;
        all.splice(i, 1);
        if (byId.get(t.id) === t) byId.delete(t.id);
        lists.clear();
        version++;
      };
    },
    list(kind?: TrackKind) {
      const key = kind ?? '*';
      let l = lists.get(key);
      if (!l) lists.set(key, (l = kind ? all.filter((t) => t.kind === kind) : all.slice()));
      return l;
    },
    get: (id) => byId.get(id),
    pick(px, py, minPx = 14) {
      const cam = ctx.camera;
      const w = ctx.canvas.clientWidth || 1;
      const h = ctx.canvas.clientHeight || 1;
      o.copy(cam.position);
      d.set((px / w) * 2 - 1, -(py / h) * 2 + 1, 0.5).unproject(cam).sub(o).normalize();
      // Where the ray meets the planet (sea-level sphere lifted by a little terrain): nothing behind it.
      const b = o.dot(d);
      const c = o.lengthSq() - (R + 1) * (R + 1);
      const disc = b * b - c;
      // (D1f r2: only in front — looking up from the street both meet points lie behind the camera,
      // and a negative distance here rejected every plane and balloon in the sky.)
      const tNear = disc > 0 ? -b - Math.sqrt(disc) : -1;
      const tPlanet = tNear > 0 ? tNear : Infinity;
      // World size of one CSS px at unit distance.
      const pxWorld = (2 * Math.tan(((cam.fov * Math.PI) / 180) / 2)) / h;
      let best = nearest(minPx, pxWorld, tPlanet, Infinity);
      // (D1f r2) Nothing through a wall: the first building or hill the ray enters hides whatever
      // lies beyond it (a click on a blank facade rode a walker 97 m behind it, and the cursor
      // turned to a pointer over walls). Marched only when the ray has hit something.
      if (best) {
        const hit = firstHit(Math.min(tPlanet, bestF + 0.5));
        if (bestF > hit + 0.3) best = nearest(minPx, pxWorld, tPlanet, hit + 0.3);
      }
      return best;
    },
  };

  let bestF = Infinity;
  /**
   * The trackable the ray (o, d) hits that is nearest by its front, whose front is within maxFront
   * (m along the ray); its front in bestF.
   */
  function nearest(minPx: number, pxWorld: number, tPlanet: number, maxFront: number): Trackable | null {
    let best: Trackable | null = null;
    bestF = Infinity;
    let bestMiss = Infinity;
    let bestDirect = false;
    for (const t of all) {
      if (!t.pose(ctx, pose)) continue;
      // (D1f) Someone's eyes are their anchor, but the whole body is clickable: a capsule from the
      // top of the head down to the feet (a sphere round the eyes missed the legs, and a click on
      // a walker in front of a truck rode the truck). People get a wider minimum disc too.
      const mp = t.kind === 'person' ? Math.max(minPx, 18) : minPx;
      let r: number;
      let along: number;
      let miss: number;
      let body: number;
      if (t.view === 'eyes') {
        const cr = t.radius * 0.42;
        body = cr;
        seg0.copy(pose.pos).addScaledVector(pose.up, t.radius * 0.2);
        seg1.copy(pose.pos).addScaledVector(pose.up, -(t.radius * 1.72 - cr));
        closestOnSegment(o, d, seg0, seg1, tmp);
        tmp.sub(o);
        along = tmp.dot(d);
        miss = Math.sqrt(Math.max(0, tmp.lengthSq() - along * along));
        r = Math.max(cr, mp * pxWorld * Math.max(0, along));
      } else {
        tmp.copy(pose.pos).sub(o);
        along = tmp.dot(d);
        miss = Math.sqrt(Math.max(0, tmp.lengthSq() - along * along));
        r = Math.max(t.radius, mp * pxWorld * Math.max(0, along));
        body = t.radius;
      }
      if (along <= 0.5 || along > tPlanet + r) continue;
      if (miss > r) continue;
      // A hit on the body itself beats one on a disc only widened to the minimum size (in a crowd
      // the near walker's wide disc covered the one just behind); then the nearest by its front (a
      // big body's centre lies metres behind its near side, so a walker in front of a truck is
      // nearer than the truck); between near-equals, the one hit more centrally.
      const direct = miss <= body;
      const front = along - Math.min(r, 1.2);
      if (front > maxFront) continue;
      const rel = miss / r;
      if ((direct && !bestDirect) || (direct === bestDirect && (front < bestF - 0.5 || (front < bestF + 0.5 && rel < bestMiss)))) {
        best = t;
        bestF = front;
        bestMiss = rel;
        bestDirect = direct;
      }
    }
    return best;
  }
  return service;
}

const _e = new Vector3();
const _w = new Vector3();
/**
 * The point of segment a → b closest to the ray o + s·d (unit d, s ≥ 0), into out.
 */
export function closestOnSegment(o: Vector3, d: Vector3, a: Vector3, b: Vector3, out: Vector3): Vector3 {
  _e.subVectors(b, a);
  _w.subVectors(o, a);
  const bb = d.dot(_e);
  const cc = _e.lengthSq();
  const p = d.dot(_w);
  const q = _e.dot(_w);
  const den = cc - bb * bb;
  let u = den > 1e-9 ? (q - p * bb) / den : 0;
  u = Math.min(1, Math.max(0, u));
  // The ray's own nearest parameter to that point, clamped in front; then the segment's to it.
  const s = Math.max(0, u * bb - p);
  if (cc > 1e-12) {
    _w.copy(o).addScaledVector(d, s).sub(a);
    u = Math.min(1, Math.max(0, _w.dot(_e) / cc));
  }
  return out.copy(a).addScaledVector(_e, u);
}

export function createLabelService(): LabelService {
  const all: WorldLabel[] = [];
  let version = 0;
  let cached: readonly WorldLabel[] = [];
  let cachedAt = -1;
  return {
    get version() {
      return version;
    },
    add(l) {
      all.push(l);
      version++;
      return () => {
        const i = all.indexOf(l);
        if (i < 0) return;
        all.splice(i, 1);
        version++;
      };
    },
    list() {
      if (cachedAt !== version) {
        cached = all.slice();
        cachedAt = version;
      }
      return cached;
    },
  };
}
