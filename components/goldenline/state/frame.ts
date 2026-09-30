// Per-frame doubles for the kernels and readers (clock, lace origin, drift remainders, window
// centres) live in one Float32Array behind a uniform array. In this app three's Vector fields are
// tagged, so writing a changing double into a Vector uniform allocates a heap number each time;
// typed-array stores never do.

import type { TSLNode } from '../core/contracts';
import { uniformArray, vec2 } from './tsl';

export const FC_FAR = 0; // (dfX, dfZ, centreX, centreZ)
export const FC_NEAR = 4;
export const FC_SAND = 8;
export const FC_TIME = 12;
export const FC_DT = 13;
export const FC_LACE = 14; // (x, z)

export class FrameConsts {
  readonly data = new Float32Array(16);
  readonly node: TSLNode = uniformArray(this.data as unknown as number[], 'float');
  el(i: number): TSLNode {
    return this.node.element(i);
  }
  vec2(i: number): TSLNode {
    return vec2(this.el(i), this.el(i + 1));
  }
}
