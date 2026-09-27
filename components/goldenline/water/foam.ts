// Multi-layer foam from the surface-state coverage/age (plus optional Jacobian sources):
//   fresh  — a lumpy, bubbly sheet: clumps at ~40 cm and ~10 cm with small holes, raised relief
//   ageing — the sheet tears into a lace network (warped Voronoi walls at two scales)
//   old    — thin filaments and specks that dissolve as coverage drops
// The fine structure is sampled in the state's drift frame (rest XZ − drift·t), so it moves with
// the coverage field it textures. Relief is a small world-space bump, so the low sun rakes
// across the clumps.

import type { Texture } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';

const { float, length, max, mix, normalize, pow, smoothstep, step, texture, vec2, vec3, saturate } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

export interface FoamLayer {
  /** Opacity of the foam layer (0-1). */
  alpha: TSLNode;
  /** Diffuse albedo. */
  albedo: TSLNode;
  /** Shading normal of the foam (bumped). */
  normal: TSLNode;
  /** 0-1 freshness (1 = just formed), for the bubble cloud under it. */
  fresh: TSLNode;
  /** Bubble-rim glint mask. */
  glint: TSLNode;
}

export interface FoamInput {
  tex: Texture;
  /** Drift-frame XZ (m). */
  xz: TSLNode;
  /** Screen derivatives of xz (computed in uniform control flow, before any branch). */
  dx: TSLNode;
  dy: TSLNode;
  cov: TSLNode;
  age: TSLNode;
  /** Surface normal it sits on. */
  N: TSLNode;
  gain: TSLNode;
}

/**
 * Branch-safe (gradient samples only): call it inside If(coverage > 0). The relief normal comes
 * from forward differences of the density texture in world space (two extra taps).
 */
export function foamLayer(i: FoamInput): FoamLayer {
  const xz = i.xz;
  const S1 = 2.6;
  const S2 = 0.65;
  const cr = 0.8;
  const sr = 0.6;
  const rot = (v: TSLNode) => vec2(v.x.mul(cr).sub(v.y.mul(sr)), v.x.mul(sr).add(v.y.mul(cr)));
  const uv1 = xz.div(S1).toVar();
  const uv2 = rot(xz).div(S2).toVar();
  const g1x = i.dx.div(S1);
  const g1y = i.dy.div(S1);
  const g2x = rot(i.dx).div(S2);
  const g2y = rot(i.dy).div(S2);
  // texture channels: x hole field (coarse), y bubbles, z fbm density (mean 0.5), w hole field (fine)
  const f1 = texture(i.tex, uv1).grad(g1x, g1y).toVar();
  const f2 = texture(i.tex, uv2).grad(g2x, g2y).toVar();
  const cov = saturate(i.cov);
  const age = saturate(i.age);
  const fresh = float(1).sub(smoothstep(0.0, 0.55, age)).toVar();
  // Holes open where the hole field is below t: dense fresh foam keeps only pinholes, ageing and
  // thinning grow them until only lace, then specks, remain.
  const t = float(0.72).sub(cov.mul(0.55)).add(age.mul(0.22)).add(f1.z.sub(0.5).mul(0.25)).toVar();
  const coarse = smoothstep(t, t.add(0.07), f1.x);
  const tf = t.mul(0.8);
  const fine = smoothstep(tf, tf.add(0.1), f2.w.mul(0.6).add(f1.x.mul(0.4)));
  // Far away the structure is sub-pixel (and the mips average the hole field): fade to the
  // mean coverage the threshold would leave.
  const fp = max(length(i.dx), length(i.dy));
  const far = smoothstep(0.04, 0.3, fp).toVar();
  const mean = float(1).sub(smoothstep(0.1, 0.95, t));
  const a0 = mix(coarse.mul(fine), mean, far);
  const alpha = a0.mul(smoothstep(0.02, 0.12, cov)).mul(mix(float(0.8), float(1), fresh)).mul(i.gain.min(1)).toVar();
  // Bubbles shade it: rims bright, cores a touch darker; old lace is greyer and thinner.
  const bub = mix(f2.y.mul(0.3).add(0.72), float(0.87), far);
  // Old, thin lace lets the water through: greyer and a little teal; fresh foam is white.
  const tint = mix(vec3(0.62, 0.74, 0.74), vec3(0.93, 0.93, 0.92), fresh.mul(0.8).add(alpha.mul(0.2)));
  const albedo = tint.mul(bub).mul(i.gain.max(1).min(2)).toVar();
  // Relief: clumps a few cm high on fresh foam, rounded lips at the hole edges, flatter lace.
  // World gradient from forward differences of the coarse tile (4 cm steps).
  const e = 0.04;
  const hAt = (s: TSLNode) => s.z.mul(0.045).add(smoothstep(t, t.add(0.35), s.x).mul(0.02));
  const h0 = hAt(f1);
  const fx1 = texture(i.tex, uv1.add(vec2(e / S1, 0))).grad(g1x, g1y);
  const fz1 = texture(i.tex, uv1.add(vec2(0, e / S1))).grad(g1x, g1y);
  const k = alpha.mul(fresh.mul(0.6).add(0.4)).mul(far.oneMinus()).div(e);
  const hx = hAt(fx1).sub(h0).mul(k);
  const hz = hAt(fz1).sub(h0).mul(k);
  const normal = normalize(i.N.add(vec3(hx.negate(), 0, hz.negate()))).toVar();
  // Bubble rims catch the sun as tiny glints (sub-pixel far away: the mips average them out).
  const glint = pow(f2.y, 10).mul(alpha).mul(far.oneMinus());
  return { alpha, albedo, normal, fresh, glint };
}

/** Debug ramp: coverage along x, age along z, over a 10 m square at (−22…−12, 9…19). */
export function foamTestRamp(rest: TSLNode) {
  const inside = step(-22, rest.x).mul(step(rest.x, -12)).mul(step(9, rest.y)).mul(step(rest.y, 19));
  const cov = saturate(rest.x.add(22).div(10)).mul(inside);
  const age = saturate(rest.y.sub(9).div(10));
  return { cov, age };
}
