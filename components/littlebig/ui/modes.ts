// The dock's six modes and how each one picks something to ride (pure apart from the contract's
// pose() calls). The camera (D1) does the riding; this only chooses whom.

import type { CameraMode, LBContext, TrackKind, TrackPose, Trackable } from '../core/contracts';
import { limbClearance } from './label-math';
import { C, WORLD } from './theme';

export type ModeId = 'explore' | 'bird' | 'plane' | 'drive' | 'space' | 'people';

export interface ModeDef {
  id: ModeId;
  /** The number key. */
  key: string;
  /** Dock caption (lowercase site voice). */
  label: string;
  /** Button's accessible name. */
  aria: string;
  color: string;
  /** Kinds this mode rides, best first (explore and bird ride nothing). */
  kinds: readonly TrackKind[];
  /** The first kind wins outright whenever one is in sight (the station: "watch from the ISS"). */
  lead?: boolean;
}

export const MODES: readonly ModeDef[] = [
  { id: 'explore', key: '1', label: 'explore', aria: 'explore the planet', color: C.teal, kinds: [] },
  { id: 'bird', key: '2', label: 'bird', aria: 'fly like a bird', color: C.grass, kinds: [] },
  { id: 'plane', key: '3', label: 'plane', aria: 'follow a plane', color: C.sky, kinds: ['plane', 'balloon'] },
  { id: 'drive', key: '4', label: 'drive', aria: 'ride a car or a bus', color: C.mustard, kinds: ['bus', 'car', 'truck', 'train', 'ferry', 'boat'] },
  { id: 'space', key: '5', label: 'space', aria: 'watch from space', color: C.lilac, kinds: ['station', 'satellite'], lead: true },
  { id: 'people', key: '6', label: 'people', aria: "see through someone's eyes", color: C.coral, kinds: ['person'] },
];

const KIND_MODE = new Map<TrackKind, ModeId>();
for (const m of MODES) for (const k of m.kinds) KIND_MODE.set(k, m.id);

/** The dock button that lights up for a camera state. */
export function activeMode(mode: CameraMode, rideKind: TrackKind | undefined): ModeId {
  if (mode === 'bird') return 'bird';
  if (mode === 'ride' && rideKind) return KIND_MODE.get(rideKind) ?? 'explore';
  return 'explore';
}

export function modeOfKind(kind: TrackKind): ModeId | undefined {
  return KIND_MODE.get(kind);
}

/**
 * Ride candidates for a mode, best first: things drawn right now, scored by how close to the middle
 * of the view they are (and how near), preferring the mode's first kinds (a bus before a car); a
 * `lead` mode's first kind wins outright while it is in sight (the station before any satellite);
 * then the ones not drawn (LOD), in registration order, which the camera may still be able to ride.
 * The current ride is skipped.
 */
export function rideCandidates(ctx: LBContext, def: ModeDef, pose: TrackPose, skip: string | null, shownOnly = false): Trackable[] {
  const track = ctx.services.track;
  const eye = ctx.camera.position;
  const fwd = ctx.view.forward;
  const shown: Array<{ t: Trackable; s: number }> = [];
  const hidden: Trackable[] = [];
  for (let ki = 0; ki < def.kinds.length; ki++) {
    const list = track.list(def.kinds[ki]);
    for (const t of list) {
      if (t.id === skip) continue;
      if (!t.pose(ctx, pose)) {
        hidden.push(t);
        continue;
      }
      const dx = pose.pos.x - eye.x;
      const dy = pose.pos.y - eye.y;
      const dz = pose.pos.z - eye.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const cos = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d;
      // Behind the planet from here? (Sight line dips under the sea-level sphere.)
      const occluded = limbClearance(eye.x, eye.y, eye.z, pose.pos.x, pose.pos.y, pose.pos.z, WORLD.R) < 0;
      const lead = def.lead && ki === 0 && !occluded && cos > 0.35 ? -100 : 0;
      const s = (1 - cos) * 3 + Math.log(1 + d) * 0.35 + ki * 0.4 + (occluded ? 6 : 0) + lead;
      shown.push({ t, s });
    }
  }
  shown.sort((a, b) => a.s - b.s);
  const best = shown.map((x) => x.t);
  return shownOnly ? best : best.concat(hidden);
}
