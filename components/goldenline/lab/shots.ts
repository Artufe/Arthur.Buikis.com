// Named camera shots for milestone screenshots and visual review. Shared registry:
// agents may APPEND shots (prefix the name with your area, e.g. 'pier-underdeck'), never
// edit or remove someone else's. `t` pins simulation time so a shot is reproducible.

import type { GLContext } from '../core/contracts';
import type { DebugHook } from '../core/debug';
import { PEAK, PIER, SPAWN } from '../world/layout';

export interface Shot {
  /** Camera position; `y` is metres above the terrain unless `absY` is set. */
  x: number;
  y: number;
  z: number;
  absY?: boolean;
  /** Either yaw/pitch (radians) or a look-at target. */
  yaw?: number;
  pitch?: number;
  lookAt?: [number, number, number];
  /** Simulation time (s) to jump to before the shot. */
  t?: number;
  /** Param overrides applied for this shot. */
  params?: Record<string, number | boolean>;
  note: string;
}

/** yaw such that forward points along (dx, dz). */
export const yawToward = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export const SHOTS: Record<string, Shot> = {
  'beach-sun': { x: SPAWN.x - 6, y: 1.68, z: SPAWN.z - 8, lookAt: [PEAK.x, 2, PEAK.z + 40], t: 30, note: 'M2 gate: standing on the sand, looking out at the break with the sun low ahead' },
  'pier-silhouette': { x: PIER.rootX - 12, y: 1.5, z: PIER.z - 14, lookAt: [PIER.tipX, 3, PIER.z + 6], t: 30, note: 'Pier silhouetted against the sun from the sand' },
  'wetsand-reflection': { x: 3, y: 1.1, z: PIER.z - 10, lookAt: [PIER.tipX * 0.6, 2, PIER.z + 4], t: 30, note: 'Low over wet sand: pier + sun reflected in the swash film' },
  'shorebreak': { x: 10, y: 1.6, z: 0, lookAt: [-12, 0.4, -6], t: 42, note: 'Shore break dumping, swash sheeting up the sand' },
  'lineup': { x: -104, y: 0.55, z: -62, absY: true, lookAt: [PEAK.x, 1.2, PEAK.z + 10], t: 36, note: 'Paddling eye line in the lineup, set approaching, backlit' },
  'pier-deck': { x: -70, y: PIER.deckHeight + 1.68, z: PIER.z, absY: true, lookAt: [-120, 0, -20], t: 30, note: 'Standing on the deck looking at the reef break' },
  'pier-under': { x: 12, y: 1.4, z: PIER.z + 0.4, lookAt: [-40, 1.2, PIER.z], t: 30, note: 'Under the pier: plank-gap light stripes, caustics on the deck underside' },
  'aerial': { x: 80, y: 70, z: -60, absY: true, lookAt: [-90, 0, 10], t: 30, note: 'Layout overview (debug only, not a beauty shot)' },
};

export function applyShot(ctx: GLContext, s: Shot, hook: DebugHook) {
  if (s.t !== undefined) hook.setTime(s.t);
  if (s.params) for (const k in s.params) ctx.params.set(k, s.params[k]);
  const y = s.absY ? s.y : ctx.services.terrain.height(s.x, s.z) + s.y;
  let yaw = s.yaw ?? 0;
  let pitch = s.pitch ?? 0;
  if (s.lookAt) {
    const dx = s.lookAt[0] - s.x;
    const dy = s.lookAt[1] - y;
    const dz = s.lookAt[2] - s.z;
    yaw = yawToward(dx, dz);
    pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
  hook.camera(s.x, y, s.z, yaw, pitch);
}
