// The ocean surface's vertex hook: under a breaker ribbon the clipmap surface is pushed down out
// of the way, so the ribbon (breaker profile, curl, bore) is the only surface there. Outside the
// ribbon's footprint the hook adds nothing. The ribbon's own edges meet the unmodified swell
// (it sits a few cm lower at its outermost edge), so the hand-over is seamless.

import * as TSL from 'three/tsl';
import type { TSLNode } from '../../core/contracts';
import type { SurfaceHook } from '../surface';
import { swellTrainGPU, type SwellGPU } from '../swell-gpu';
import { U_BACK, U_FRONT } from './profile';
import { labelAtGPU, labelToCol, slotHeader, slotRow, type BreakGPU } from './gpu';
import { REEF_SLOTS, SHORE_SLOTS } from './tracker';
import { SHORE_RAYS } from './rays';

const { abs, cos, float, floor, int, max, mix, round, select, sin, smoothstep, vec2, vec3 } = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

/** How far (× H) a hidden vertex drops: below any part of the breaker's lower envelope. */
export const HIDE_DEPTH = 1.4;

export interface HideHook {
  hook: SurfaceHook;
  /** 0/1 debug: disable hiding. */
  uEnabled: TSLNode;
}

export function createHideHook(swell: SwellGPU, g: BreakGPU, uEnabled: TSLNode): HideHook {
  const hook: SurfaceHook = ({ rest, spacing }) => {
    const out = float(0).toVar();
    const t0 = swellTrainGPU(swell, 0, rest);
    const theta = t0.theta.toVar();
    const n = round(theta.div(Math.PI * 2)).toVar();
    // Reef slots index the reef fan by the baked ray label; shore slots index the shore fan by
    // the along-shore coordinate (its rays are straight, normal to the mean shoreline).
    const colReef = labelToCol(labelAtGPU(g, rest));
    const sx = sin(rest.y.div(85)).mul(4).add(sin(rest.y.div(31).add(1.3)).mul(2));
    const sl = cos(rest.y.div(85)).mul(4 / 85).add(cos(rest.y.div(31).add(1.3)).mul(2 / 31));
    const colShore = rest.y.add(rest.x.sub(sx).mul(sl)).sub(SHORE_RAYS.z0).div(SHORE_RAYS.dz);
    const check = (slotF: TSLNode, col: TSLNode) => {
      const slot = int(slotF).toVar();
      const hdr = slotHeader(g, slot).toVar();
      const valid = hdr.w.greaterThan(0.5).and(abs(hdr.z.sub(n)).lessThan(0.5)).and(col.greaterThanEqual(hdr.x)).and(col.lessThanEqual(hdr.y));
      TSL.If(valid.and(uEnabled.greaterThan(0.5)), () => {
        const r0 = slotRow(g, slot, 0, col);
        const r1 = slotRow(g, slot, 1, col);
        const H = max(r0.w, 0.1);
        // Distance ahead of the crest measured exactly as the ribbon lays out its rest points
        // (straight along the crest's wave direction), not by phase: k changes over the reef.
        const sn = rest.sub(vec2(r0.x, r0.y)).dot(vec2(r1.x, r1.y)).div(H);
        // Only where the ribbon can dip below the swell (the face, trough and landing zone ahead
        // of the crest) does the surface need to go deep; behind the crest the ribbon is above it.
        // Ramps are kept ≥ 2 clipmap cells wide, or the coarse rings would bleed a trench outside.
        const cell = spacing.div(H);
        const front = smoothstep(-0.8, 0.2, sn).mul(float(1).sub(smoothstep(float(U_FRONT).sub(cell.mul(3).add(1.6)), float(U_FRONT).sub(cell.mul(0.5).add(0.3)), sn)));
        const back = smoothstep(float(U_BACK).add(cell.mul(0.5).add(0.3)), float(U_BACK).add(cell.mul(3).add(1.2)), sn);
        const depthF = mix(float(0.12), H.mul(HIDE_DEPTH), front).mul(back);
        out.assign(max(out, depthF.mul(smoothstep(0.0, 0.25, r0.z))));
      });
    };
    check(n.sub(floor(n.div(REEF_SLOTS)).mul(REEF_SLOTS)), colReef);
    check(n.sub(floor(n.div(SHORE_SLOTS)).mul(SHORE_SLOTS)).add(REEF_SLOTS), colShore);
    return { d: vec3(0, out.negate(), 0) };
  };
  void select;
  return { hook, uEnabled };
}
