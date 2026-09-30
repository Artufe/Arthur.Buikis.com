// Shared TSL helpers for the pier's materials: hashes, cellular noise, the reflected-light
// caustic pattern and the uniforms every pier material reads.

import { Color } from 'three/webgpu';
import { abs, dot, exp, float, floor, fract, length, max, min, mix, pow, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';

/** Dave Hoskins' hash22 (sin-free, stable across GPUs). */
export function hash22(p: TSLNode): TSLNode {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973)));
  const q = p3.add(dot(p3, p3.yzx.add(33.33)));
  return fract(q.xx.add(q.yz).mul(q.zy));
}

export function hash12(p: TSLNode): TSLNode {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const q = p3.add(dot(p3, p3.yzx.add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
}

/**
 * Animated Voronoi: returns vec2(F2 - F1, F1). Feature points orbit inside their cells, so the
 * cell walls (where caustic light focuses) wobble and merge like real caustics.
 */
export function voronoiEdge(p: TSLNode, t: TSLNode): TSLNode {
  const cell = floor(p);
  const f = fract(p);
  let f1: TSLNode = float(8);
  let f2: TSLNode = float(8);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const o = vec2(i, j);
      const h = hash22(cell.add(o));
      const pt = o.add(0.5).add(sin(h.mul(6.2831).add(t.mul(h.yx.mul(0.6).add(0.7)))).mul(0.42));
      const d = length(pt.sub(f));
      // Running two-smallest without branches.
      f2 = min(f2, max(f1, d));
      f1 = min(f1, d);
    }
  }
  return vec2(f2.sub(f1), f1);
}

/**
 * Caustic web (mean ≈ 1) at water-plane coordinates p (m), time t, blurred by `blur` 0..1
 * (distance from the water spreads the focus out).
 */
export function causticPattern(p: TSLNode, t: TSLNode, blur: TSLNode): TSLNode {
  const a = voronoiEdge(p.mul(1.35), t.mul(1.1)).x;
  const b = voronoiEdge(p.mul(2.9).add(vec2(3.7, 1.3)), t.mul(1.7)).x;
  // Soft, wide bands (reflected caustics are always out of focus a metre or more from the water).
  const width = mix(float(0.15), float(0.4), blur);
  const la = float(1).sub(smoothstep(0, width, a));
  const lb = float(1).sub(smoothstep(0, width.mul(1.2), b));
  const web = pow(la.mul(0.6).add(lb.mul(0.4)), float(1.3)).mul(2.0).add(0.3);
  return mix(web, float(1), blur.mul(0.45).add(0.12));
}

/** Uniforms shared by every pier material; the system copies params into them each frame. */
export function createPierUniforms() {
  return {
    time: uniform(0),
    /** Sun colour × intensity (linear), what a sunlit white Lambert surface gets per π. */
    sunRadiance: uniform(new Color(3, 2.2, 1.4)),
    /** Diffuse light bounced up from the water (sky reflection + upwelling), linear. */
    bounceWater: uniform(new Color(0.25, 0.5, 0.72)),
    waterY: uniform(0),
    bleach: uniform(1),
    spray: uniform(1),
    caustics: uniform(1),
    bounce: uniform(1),
    aniso: uniform(0.35),
    normalK: uniform(1),
    growth: uniform(1),
    barnacles: uniform(1),
  };
}

export type PierUniforms = ReturnType<typeof createPierUniforms>;

/** Height falloff of light reflected up off the water onto the structure. */
export function reflectFalloff(h: TSLNode): TSLNode {
  return exp(h.mul(-0.22)).mul(0.8).add(0.2);
}

export const saturateAbs = (x: TSLNode) => abs(x).min(1);
