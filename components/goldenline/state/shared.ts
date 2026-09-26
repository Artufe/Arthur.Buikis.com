// TSL building blocks shared by the state kernels: the tunables' shape, exact terrain height (for
// the static bake and debug views), value noise for brushes, the global drift, Catmull-Rom.

import { Fn, clamp, dot, float, floor, fract, ivec2, max, min, mix, sin, smoothstep, vec2, baseTex } from './tsl';
import type { TerrainService, TSLNode } from '../core/contracts';

export interface Tunables {
  /** Foam lifetime scale (s). */
  foamLife: TSLNode;
  /** 0-1: how strongly ageing foam breaks up into lace. */
  lace: TSLNode;
  /** Surf-zone longshore current (m/s, toward +Z) and channel rip (m/s, seaward). */
  surfCurrent: TSLNode;
  rip: TSLNode;
  /** 1 = advect foam by the spatially varying part of the drift field. */
  advect: TSLNode;
  /** Wake wave speed (m/s) and damping (1/s). */
  wakeSpeed: TSLNode;
  wakeDamping: TSLNode;
  /** 0-0.9: fraction of the stable maximum biharmonic dispersion. */
  wakeDispersion: TSLNode;
  /** Damp-sand drying time (s), standing-film drain time (s), swash-band wetness floor. */
  dryTime: TSLNode;
  filmTime: TSLNode;
  swashFloor: TSLNode;
  /** Footprint refill time on saturated sand (s). */
  refillWet: TSLNode;
  /** Material-coordinate origin for the lace pattern (total drift, m) and sim time (s). */
  laceOrigin: TSLNode;
  time: TSLNode;
  dt: TSLNode;
  /** Per-frame random vec4 for stochastic rounding. */
  seed: TSLNode;
}

/** smoothstep with falling edges (a > b): 1 at x <= b, 0 at x >= a. Reversed edges are undefined on Metal. */
export const rev = (a: number, b: number, x: TSLNode) => float(1).sub(smoothstep(b, a, x));

/** Bilinear base terrain height (m) from the baked R32F heightfield, via textureLoad (no float filtering needed). */
export function makeTerrainHeight(terrain: TerrainService) {
  const [minX, minZ, maxX, maxZ] = terrain.bounds;
  const t = terrain.texel;
  const w = Math.round((maxX - minX) / t);
  const h = Math.round((maxZ - minZ) / t);
  const tex = baseTex(terrain.heightTexture);
  return Fn(([p]: [TSLNode]) => {
    const f = p.sub(vec2(minX, minZ)).div(t).sub(0.5).toVar();
    const i = clamp(floor(f), vec2(0, 0), vec2(w - 2, h - 2)).toVar();
    const a = clamp(f.sub(i), 0, 1).toVar();
    const c = ivec2(i).toVar();
    const h00 = tex.load(c).x;
    const h10 = tex.load(c.add(ivec2(1, 0))).x;
    const h01 = tex.load(c.add(ivec2(0, 1))).x;
    const h11 = tex.load(c.add(ivec2(1, 1))).x;
    return mix(mix(h00, h10, a.x), mix(h01, h11, a.x), a.y);
  });
}

/** Cheap 2D value noise in [-1, 1]. */
export const vnoise = Fn(([p]: [TSLNode]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2).add(3)).toVar();
  const h = (q: TSLNode) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453));
  const a = h(i);
  const b = h(i.add(vec2(1, 0)));
  const c = h(i.add(vec2(0, 1)));
  const d = h(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y).mul(2).sub(1);
}).setLayout({ name: 'gl_state_vnoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

/** Global drift (m/s) applied exactly by whole-texel shifts: a gentle longshore set plus Stokes drift. */
export const GLOBAL_DRIFT = { x: 0.035, z: 0.07 };

/** Catmull-Rom (9 bilinear taps) at world-texel coordinate q (texel centres at k + 0.5), repeat-wrapped. */
export function catmullRom(base: TSLNode, q: TSLNode, n: number) {
  const inv = 1 / n;
  const t1 = floor(q.sub(0.5)).add(0.5).toVar();
  const f = q.sub(t1).toVar();
  const w0 = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5));
  const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
  const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5));
  const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
  const w12 = w1.add(w2).toVar();
  const t0 = t1.sub(1).mul(inv).toVar();
  const t3 = t1.add(2).mul(inv).toVar();
  const t12 = t1.add(w2.div(w12)).mul(inv).toVar();
  const s = (x: TSLNode, y: TSLNode) => base.sample(vec2(x, y)).level(0);
  const w0v = w0.toVar();
  const w3v = w3.toVar();
  let r = s(t0.x, t0.y).mul(w0v.x.mul(w0v.y));
  r = r.add(s(t12.x, t0.y).mul(w12.x.mul(w0v.y)));
  r = r.add(s(t3.x, t0.y).mul(w3v.x.mul(w0v.y)));
  r = r.add(s(t0.x, t12.y).mul(w0v.x.mul(w12.y)));
  r = r.add(s(t12.x, t12.y).mul(w12.x.mul(w12.y)));
  r = r.add(s(t3.x, t12.y).mul(w3v.x.mul(w12.y)));
  r = r.add(s(t0.x, t3.y).mul(w0v.x.mul(w3v.y)));
  r = r.add(s(t12.x, t3.y).mul(w12.x.mul(w3v.y)));
  r = r.add(s(t3.x, t3.y).mul(w3v.x.mul(w3v.y)));
  // Limiter: clamp to the four nearest texels, so the kernel's negative lobes can't ring at sharp
  // foam edges (unclamped, the overshoot is carried along as striations).
  const c00 = s(t1.x.mul(inv), t1.y.mul(inv));
  const c10 = s(t1.x.add(1).mul(inv), t1.y.mul(inv));
  const c01 = s(t1.x.mul(inv), t1.y.add(1).mul(inv));
  const c11 = s(t1.x.add(1).mul(inv), t1.y.add(1).mul(inv));
  const lo = min(min(c00, c10), min(c01, c11));
  const hi = max(max(c00, c10), max(c01, c11));
  return clamp(r, lo, hi);
}

