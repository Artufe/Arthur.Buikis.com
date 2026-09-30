// TSL terrain height: the baked base heightfield (1 m, orchestrator bake) blended into the coarse
// far-field bake, both sampled with a cubic B-spline (C2, so normals derived from it never
// crease at texel boundaries), plus the GPU detail layers. Shared by the terrain vertex stage
// and anything that needs to sit on the rendered sand.

import type { DataTexture, Texture } from 'three/webgpu';
import { Fn, If, float, floor, max, min, mix, smoothstep, texture, vec2, vec3 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { FAR_BOUNDS } from './bake';

/**
 * Cubic B-spline sample of a float texture with 4 bilinear taps (GPU Gems 2, ch. 20), all
 * channels. `uv` in [0, 1]; `w`, `h` = texture size in texels (JS numbers).
 */
export function bspline(tex: Texture, uv: TSLNode, w: number, h: number): TSLNode {
  const size = vec2(w, h);
  const st = uv.mul(size).sub(0.5);
  const i = floor(st);
  const f = st.sub(i);
  const f2 = f.mul(f);
  const f3 = f2.mul(f);
  const w0 = f3.negate().add(f2.mul(3)).sub(f.mul(3)).add(1).div(6);
  const w1 = f3.mul(3).sub(f2.mul(6)).add(4).div(6);
  const w2 = f3.mul(-3).add(f2.mul(3)).add(f.mul(3)).add(1).div(6);
  const w3 = f3.div(6);
  const g0 = w0.add(w1);
  const g1 = w2.add(w3);
  // Texel-centre coordinates of the two bilinear taps per axis.
  const a = i.sub(1).add(w1.div(g0)).add(0.5).div(size);
  const b = i.add(1).add(w3.div(g1)).add(0.5).div(size);
  const t = texture(tex);
  const s00 = t.sample(vec2(a.x, a.y)).level(float(0));
  const s10 = t.sample(vec2(b.x, a.y)).level(float(0));
  const s01 = t.sample(vec2(a.x, b.y)).level(float(0));
  const s11 = t.sample(vec2(b.x, b.y)).level(float(0));
  return g0.y.mul(g0.x.mul(s00).add(g1.x.mul(s10))).add(g1.y.mul(g0.x.mul(s01).add(g1.x.mul(s11))));
}

export interface BaseHeightInputs {
  /** RGBA32F height + gradient (see bake.heightGradTexture). */
  near: Texture;
  nearBounds: [number, number, number, number];
  nearTexel: number;
  far: DataTexture;
  farTexel: number;
}

/**
 * (xz: vec2) => vec3(height, dh/dx, dh/dz): the base surface, near bake blended into the far bake
 * over the last 24 m before the near bounds.
 */
export function makeBaseHeight(inp: BaseHeightInputs) {
  const [nx0, nz0, nx1, nz1] = inp.nearBounds;
  const nw = Math.round((nx1 - nx0) / inp.nearTexel);
  const nh = Math.round((nz1 - nz0) / inp.nearTexel);
  const [fx0, fz0, fx1, fz1] = FAR_BOUNDS;
  const fw = Math.round((fx1 - fx0) / inp.farTexel);
  const fh = Math.round((fz1 - fz0) / inp.farTexel);
  // Only the blend band pays for both bakes; everywhere else one B-spline (4 taps).
  return (xz: TSLNode): TSLNode =>
    Fn(() => {
      const edge = min(min(xz.x.sub(nx0), float(nx1).sub(xz.x)), min(xz.y.sub(nz0), float(nz1).sub(xz.y)));
      const out = vec3(0, 0, 0).toVar();
      const nearHG = () => bspline(inp.near, xz.sub(vec2(nx0, nz0)).div(vec2(nx1 - nx0, nz1 - nz0)), nw, nh).xyz;
      const farHG = () => bspline(inp.far, xz.sub(vec2(fx0, fz0)).div(vec2(fx1 - fx0, fz1 - fz0)), fw, fh).xyz;
      If(edge.greaterThanEqual(28), () => {
        out.assign(nearHG());
      })
        .ElseIf(edge.lessThanEqual(4), () => {
          out.assign(farHG());
        })
        .Else(() => {
          out.assign(mix(farHG(), nearHG(), smoothstep(4, 28, edge)));
        });
      return out;
    })();
}

/** Fraction of `h` in a band: 1 inside [a, b], soft over `s` metres either side. */
export function band(h: TSLNode, a: number, b: number, s: number): TSLNode {
  return smoothstep(a - s, a + s, h).mul(float(1).sub(smoothstep(b - s, b + s, h)));
}

export const saturate01 = (x: TSLNode) => max(0, min(1, x));
