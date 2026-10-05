// v2: the registries behind ctx.services.track and ctx.services.labels (contracts.ts). Owners
// register in init() and unregister in dispose(); the camera and the UI read.

import { Vector3 } from 'three';
import type { LBContext, LabelService, TrackKind, TrackPose, TrackService, Trackable, WorldLabel } from './contracts';
import { R } from '../world/config';

export function createTrackService(ctx: LBContext): TrackService {
  const all: Trackable[] = [];
  const byId = new Map<string, Trackable>();
  const lists = new Map<string, readonly Trackable[]>();
  let version = 0;
  const pose: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
  const o = new Vector3();
  const d = new Vector3();
  const tmp = new Vector3();

  return {
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
      const tPlanet = disc > 0 ? -b - Math.sqrt(disc) : Infinity;
      // World size of one CSS px at unit distance.
      const pxWorld = (2 * Math.tan(((cam.fov * Math.PI) / 180) / 2)) / h;
      let best: Trackable | null = null;
      let bestT = Infinity;
      let bestMiss = Infinity;
      for (const t of all) {
        if (!t.pose(ctx, pose)) continue;
        tmp.copy(pose.pos).sub(o);
        const along = tmp.dot(d);
        if (along <= 0.5 || along > tPlanet + t.radius) continue;
        const miss = Math.sqrt(Math.max(0, tmp.lengthSq() - along * along));
        const r = Math.max(t.radius, minPx * pxWorld * along);
        if (miss > r) continue;
        // Prefer the nearest along the ray; between near-equals, the one hit more centrally.
        const rel = miss / r;
        if (along < bestT - 2 || (along < bestT + 2 && rel < bestMiss)) {
          best = t;
          bestT = along;
          bestMiss = rel;
        }
      }
      return best;
    },
  };
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
