// A scripted writer for reviewing the state system in isolation (`state.debugScene`): a footprint
// trail on dry sand and one on saturated sand, a foam patch in the water, a moving wake source
// and paddle-stroke rings, then a swash-style smoothing sweep over part of both trails. Times are
// relative to the frame the toggle turns on. Zero-alloc.

import { SPLAT_FOAM, SPLAT_FOOTPRINT, SPLAT_SMOOTH, SPLAT_WAKE, SPLAT_WET, type SurfaceStateService, type TerrainService } from '../core/contracts';

export const DEBUG_SITES = {
  dry: { x: 41.5, z: 4, steps: 26 },
  /** x is re-found at start: where the live terrain is ~0.2 m above the water (saturated sand). */
  wet: { x: 7.5, z: 6, steps: 18 },
  foam: { x: -16, z: 14 },
  wake: { x: -9, z0: -18, z1: 34 },
};
const STRIDE = 0.72;
const CADENCE = 0.38;
const SMOOTH_AT = 66;
const SWASH_AT = 40;

export class DebugScene {
  private t0 = -1;
  private last = -1;

  reset(terrain: TerrainService) {
    this.t0 = -1;
    this.last = -1;
    const w = DEBUG_SITES.wet;
    for (let x = 30; x > -20; x -= 0.1) {
      if (terrain.height(x, w.z) < 0.22) {
        w.x = x + 0.2;
        break;
      }
    }
  }

  update(state: SurfaceStateService, t: number, dt: number) {
    if (this.t0 < 0) this.t0 = t;
    const a = this.last;
    const b = t - this.t0;
    this.last = b;
    // Footprints, stamped as their time comes (a walking pace) so the trail forms in order.
    trail(state, DEBUG_SITES.dry.x, DEBUG_SITES.dry.z, DEBUG_SITES.dry.steps, 0.022, a, b);
    trail(state, DEBUG_SITES.wet.x, DEBUG_SITES.wet.z, DEBUG_SITES.wet.steps, 0.02, a, b);

    // A dense whitewater-like foam patch, once.
    if (a < 0 && b >= 0) {
      const f = DEBUG_SITES.foam;
      state.splat(SPLAT_FOAM, f.x, f.z, 4.2, 1);
      state.splat(SPLAT_FOAM, f.x + 3.1, f.z - 2.2, 3.1, 1);
      state.splat(SPLAT_FOAM, f.x - 2.6, f.z + 2.9, 3.4, 1);
      state.splat(SPLAT_FOAM, f.x + 1.2, f.z + 4.4, 2.2, 0.9);
      state.splat(SPLAT_FOAM, f.x - 4.1, f.z - 1.8, 2.5, 0.85);
    }

    // A board-speed wake source crossing the frame, then paddle-stroke rings.
    const w = DEBUG_SITES.wake;
    const wt = b - 1;
    const speed = 5;
    const span = (w.z1 - w.z0) / speed;
    if (wt >= 0 && wt < span && dt > 0) {
      state.splat(SPLAT_WAKE, w.x, w.z0 + wt * speed, 0.45, 0.035, 0, speed);
      state.splat(SPLAT_FOAM, w.x, w.z0 + wt * speed - 0.4, 0.35, 0.35 * dt * 60 * 0.08);
    }
    for (let k = 0; k < 6; k++) {
      const at = 2 + k * 1.1;
      if (a < at && b >= at) {
        const side = k & 1 ? 0.45 : -0.45;
        state.splat(SPLAT_WAKE, w.x - 6 + side, 6 + k * 0.9, 0.22, 0.03, 0, 0);
      }
    }

    // A swash run-up over the far half of the wet trail: wet film + smoothing.
    if (a < SWASH_AT && b >= SWASH_AT) {
      for (let i = 0; i < 6; i++) {
        state.splat(SPLAT_WET, DEBUG_SITES.wet.x - 0.4, DEBUG_SITES.wet.z - 3.4 - i * 0.6, 1.3, 1);
        state.splat(SPLAT_SMOOTH, DEBUG_SITES.wet.x - 0.4, DEBUG_SITES.wet.z - 3.4 - i * 0.6, 1.3, 1);
      }
    }
    // Erase the far half of the dry trail with a smoothing sweep (wind or a raked path).
    if (a < SMOOTH_AT && b >= SMOOTH_AT) {
      const d = DEBUG_SITES.dry;
      // The trail runs from d.z to d.z - steps * 0.36 m; erase its far half.
      for (let i = 0; i < 8; i++) state.splat(SPLAT_SMOOTH, d.x + 0.2, d.z - 4.9 - i * 0.7, 1.1, 1);
    }
  }
}

function trail(state: SurfaceStateService, x0: number, z0: number, steps: number, depth: number, a: number, b: number) {
  for (let i = 0; i < steps; i++) {
    const at = 0.2 + i * CADENCE;
    if (a < at && b >= at) {
      const side = i & 1 ? 1 : -1;
      // Walking toward -Z with a slight curve; feet 17 cm apart.
      const z = z0 - i * STRIDE * 0.5;
      const x = x0 + side * 0.085 + Math.sin(i * 0.11) * 0.5;
      const hx = Math.cos(i * 0.11) * 0.028 + side * 0.06;
      state.splat(SPLAT_FOOTPRINT, x, z, 0.135, depth, hx, -1);
    }
  }
}
