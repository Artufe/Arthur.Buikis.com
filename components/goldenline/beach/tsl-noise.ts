// Small TSL noise helpers for the beach materials (unrolled at graph-build time, no loops).

import { dot, float, floor, fract, length, min, select, sin, vec2, vec3 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';

export const hash22 = (p: TSLNode): TSLNode =>
  fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))).mul(43758.5453));

export const hash21 = (p: TSLNode): TSLNode => fract(sin(dot(p, vec2(41.3, 289.1))).mul(24634.6345));

/**
 * 2D Voronoi: vec3(F1, F2, cell hash 0-1) for `p` in cell units. `jitter` 0-1.
 */
export function voronoi2(p: TSLNode, jitter = 0.85): TSLNode {
  const ip = floor(p);
  const fp = fract(p);
  let f1: TSLNode = float(9);
  let f2: TSLNode = float(9);
  let id: TSLNode = float(0);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const c = ip.add(vec2(i, j));
      const o = hash22(c).mul(jitter).add((1 - jitter) * 0.5);
      const d = length(vec2(i, j).add(o).sub(fp));
      const closer = d.lessThan(f1);
      f2 = select(closer, f1, min(f2, d)).toVar();
      id = select(closer, hash21(c), id).toVar();
      f1 = min(f1, d).toVar();
    }
  }
  return vec3(f1, f2, id);
}
