// PierService: the walkable deck and steps, the railings as walls, and the piling list that the
// water systems (foam wakes, breaking waves) and the player (collision) read. CPU, zero-alloc.

import type { PierService } from '../core/contracts';
import { PIER } from '../world/layout';
import { DECK_TOP, HALF_W, POST, type PierPlan, STAIR } from './plan';

/** How far below a surface the feet may be and still be "on" it (step-up tolerance). */
const REACH = 0.9;
/** Body radius kept clear of the railing posts. */
const BODY = 0.28;

export function createPierService(plan: PierPlan): PierService {
  const n = plan.piles.length;
  const pilings = new Float32Array(n * 2);
  let rSum = 0;
  for (let i = 0; i < n; i++) {
    pilings[i * 2] = plan.piles[i].x;
    pilings[i * 2 + 1] = plan.piles[i].z;
    rSum += plan.piles[i].r;
  }
  const { x0: sx0, x1: sx1, bottom } = plan.stair;
  const sDrop = DECK_TOP - bottom;
  const deckHalf = POST.z - POST.s / 2 - BODY;
  const stairHalf = STAIR.halfW - BODY + 0.1;

  /** Height of the smooth line through the stair nosings at x (feet glide, the steps don't jolt). */
  const stairAt = (x: number) => DECK_TOP - ((x - sx0) / (sx1 - sx0)) * sDrop;

  return {
    surfaceAt(x, z, y) {
      const dz = Math.abs(z - PIER.z);
      if (x <= PIER.rootX && x >= PIER.tipX - 0.1 && dz <= HALF_W) {
        return y > DECK_TOP - REACH ? DECK_TOP : NaN;
      }
      if (x > sx0 && x < sx1 && dz <= STAIR.halfW) {
        const h = stairAt(x);
        return y > h - REACH ? h : NaN;
      }
      return NaN;
    },
    clampToDeck(x, z, y, out) {
      out[0] = x;
      out[1] = z;
      const dz = z - PIER.z;
      if (x <= PIER.rootX + 0.6 && x >= PIER.tipX - 1 && y > DECK_TOP - 0.6 && Math.abs(dz) < HALF_W + 0.6) {
        // At deck level: the railings are walls, and so is the tip rail. At the root only the
        // stair opening lets you through; the rest of the deck end is railed.
        if (x < PIER.tipX + 0.1 + BODY) out[0] = PIER.tipX + 0.1 + BODY;
        if (x > PIER.rootX - BODY && Math.abs(dz) > stairHalf) out[0] = PIER.rootX - BODY;
        const lim = out[0] > PIER.rootX ? stairHalf : deckHalf;
        out[1] = PIER.z + Math.min(lim, Math.max(-lim, dz));
        return;
      }
      if (x > sx0 && x < sx1 + 0.2 && y > bottom - 0.6 && y > stairAt(Math.min(x, sx1)) - 0.8 && Math.abs(dz) < STAIR.halfW + 0.2) {
        out[1] = PIER.z + Math.min(stairHalf, Math.max(-stairHalf, dz));
      }
    },
    pilings,
    pilingRadius: n ? rSum / n : 0.17,
  };
}
