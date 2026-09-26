// The rendered ground height as a TSL function, shared by the terrain vertex stage and every
// prop that has to sit exactly on it (shells, seaweed, grass): the B-spline base plus the dry-sand
// macro undulation. Ripples and grain are normal-only, so props don't need them.

import type { DataTexture } from 'three/webgpu';
import { smoothstep, texture } from 'three/tsl';
import type { GLContext, TSLNode } from '../core/contracts';
import { FAR_TEXEL, type SandTile } from './bake';
import { makeBaseHeight } from './height';

export interface Ground {
  /** vec3(height, dh/dx, dh/dz) of the smooth base surface. */
  baseHG(xz: TSLNode): TSLNode;
  base(xz: TSLNode): TSLNode;
  /** Dry-sand undulation (m) for a point whose base height is h0. */
  dryDetail(xz: TSLNode, h0: TSLNode): TSLNode;
  height(xz: TSLNode): TSLNode;
}

export function makeGround(ctx: GLContext, near: DataTexture, far: DataTexture, macro: SandTile): Ground {
  const t = ctx.services.terrain;
  const baseHG = makeBaseHeight({ near, nearBounds: t.bounds, nearTexel: t.texel, far, farTexel: FAR_TEXEL });
  const base = (xz: TSLNode): TSLNode => baseHG(xz).x;
  const tMacro = texture(macro.texture);
  const dryDetail = (xz: TSLNode, h0: TSLNode): TSLNode =>
    tMacro.sample(xz.div(macro.size)).b.sub(0.5).mul(0.07).mul(smoothstep(1.4, 2.2, h0));
  return {
    baseHG,
    base,
    dryDetail,
    height(xz) {
      const h0 = base(xz);
      return h0.add(dryDetail(xz, h0));
    },
  };
}
