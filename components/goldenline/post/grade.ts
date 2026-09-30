// Colour grade (scene-referred white balance + saturation before AgX, a gentle display-referred
// contrast curve after it), vignette and film grain. The grain is luminance-weighted (strongest in
// the mids, absent in clipped highlights and deep blacks), triangular-distributed and re-seeded per
// frame from a uniform, so frozen screenshots stay deterministic.

import { Vector3 } from 'three/webgpu';
import { Fn, dot, float, fract, mix, screenCoordinate, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';

const LUMA = vec3(0.2126, 0.7152, 0.0722);

const hash12 = (p: TSLNode): TSLNode => {
  let p3: TSLNode = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  p3 = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
};

export class Grade {
  /** Per-channel gain applied in linear light (white balance). */
  readonly gain = uniform(new Vector3(1, 1, 1));
  readonly saturation = uniform(1.0);
  readonly contrast = uniform(0.0);
  /** Display-referred saturation after AgX (AgX base is deliberately desaturated; "punchy" ~1.3). */
  readonly punch = uniform(1.25);
  readonly vignette = uniform(0.2);
  readonly grain = uniform(0.028);
  readonly frame = uniform(0);

  /** Before tonemapping. */
  scene(c: TSLNode): TSLNode {
    return Fn(() => {
      const col = vec4(c);
      const g = col.rgb.mul(this.gain);
      const l = dot(g, LUMA);
      return vec4(mix(vec3(l), g, this.saturation).max(0), col.a);
    })();
  }

  /** After tonemapping (display-referred, 0-1). */
  display(c: TSLNode): TSLNode {
    return Fn(() => {
      const col = vec4(c);
      let rgb: TSLNode = col.rgb.clamp(0, 1);
      const l0 = dot(rgb, LUMA);
      rgb = mix(vec3(l0), rgb, this.punch).clamp(0, 1);
      // soft S-curve around mid-grey; contrast 0 = identity
      const s = rgb.mul(rgb).mul(rgb.mul(-2).add(3));
      rgb = mix(rgb, s, this.contrast);
      // vignette: cos^4-ish falloff, aspect-aware
      const d = screenUV.sub(0.5).mul(vec2(1.0, 0.72));
      const v = float(1).sub(d.dot(d).mul(this.vignette).mul(2.2)).clamp(0, 1);
      rgb = rgb.mul(v);
      // grain
      // Hoskins "hash without sine": fract(sin()) is row-correlated at pixel-scale inputs on GPUs
      const p = screenCoordinate.xy.add(vec2(this.frame.mul(113.7), this.frame.mul(71.3)));
      const h1 = hash12(p);
      const h2 = hash12(p.add(vec2(57.3, 19.1)));
      const n = h1.add(h2).sub(1);
      const l = dot(rgb, LUMA);
      const amt = smoothstep(0.0, 0.25, l).mul(smoothstep(1.0, 0.7, l)).mul(0.75).add(0.25);
      rgb = rgb.add(n.mul(this.grain).mul(amt));
      return vec4(rgb, 1);
    })();
  }
}
