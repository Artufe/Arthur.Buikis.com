// Baked, tileable noise for the state kernels (generated once by compute at init): evaluating
// Voronoi lace and value noise per texel per frame cost several ms on the M3; sampling a baked
// texture costs a tap.
//
//   lace   1024², period 32 lace units: R = coarse filament distance (two Voronoi networks
//          unioned with meandering veins), G = fine filament distance. 0 on a filament.
//   value  256², 64 cells across: RGBA = four independent smooth value noises in [0, 1].

import type { WebGPURenderer } from 'three/webgpu';
import type { TSLNode } from '../core/contracts';
import { makeTex } from './field';
import { Fn, abs, dot, float, floor, fract, globalId, ivec2, min, mix, mod, sin, smoothstep, sqrt, textureStore, vec2, vec4, baseTex } from './tsl';

export const LACE_N = 1024;
export const LACE_PERIOD = 32;
const VALUE_N = 256;
const VALUE_CELLS = 64;

const hash2 = (c: TSLNode, k: number) => fract(sin(vec2(dot(c, vec2(127.1 + k, 311.7)), dot(c, vec2(269.5, 183.3 + k)))).mul(43758.5453));
const hash1 = (c: TSLNode, k: number) => fract(sin(dot(c, vec2(12.9898 + k, 78.233))).mul(43758.5453));

type Per = number | [number, number];
const per2 = (p: Per) => (typeof p === 'number' ? vec2(p, p) : vec2(p[0], p[1]));

/** Periodic value noise in [-1, 1] with `period` lattice cells (per axis). */
function pnoise(p: TSLNode, period: Per, k: number) {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2).add(3)).toVar();
  const pv = per2(period);
  const w = (o: TSLNode) => mod(o.add(pv.mul(64)), pv);
  const a = hash1(w(i), k);
  const b = hash1(w(i.add(vec2(1, 0))), k);
  const c = hash1(w(i.add(vec2(0, 1))), k);
  const d = hash1(w(i.add(vec2(1, 1))), k);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y).mul(2).sub(1);
}

/** Periodic Voronoi F2 - F1. */
function pcell(p: TSLNode, period: Per, k: number) {
  const pv = per2(period);
  const ip = floor(p).toVar();
  const fp = fract(p).toVar();
  const f1 = float(8).toVar();
  const f2 = float(8).toVar();
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const c = mod(ip.add(vec2(x, y)).add(pv.mul(64)), pv);
      const d = vec2(x, y).add(hash2(c, k)).sub(fp);
      const dd = sqrt(dot(d, d));
      const lt = dd.lessThan(f1);
      f2.assign(lt.select(f1, min(f2, dd)));
      f1.assign(lt.select(dd, f1));
    }
  }
  return f2.sub(f1);
}

export function createNoise(renderer: WebGPURenderer) {
  const lace = makeTex(LACE_N, 'lace');
  const value = makeTex(VALUE_N, 'value');
  const P = LACE_PERIOD;
  const laceKernel = Fn(() => {
    const s = ivec2(globalId.xy);
    // q in lace units, [0, P). All noise below is periodic in P (or a divisor of it).
    const q = vec2(s).add(0.5).mul(P / LACE_N).toVar();
    const w1 = vec2(pnoise(q.mul(0.5), P / 2, 1), pnoise(q.mul(0.5).add(vec2(0, 7)), P / 2, 2));
    const w2 = vec2(pnoise(q.mul(1), P, 3), pnoise(q.mul(1).add(vec2(5, 0)), P, 4));
    const warp = w1.mul(0.95).add(w2.mul(0.38));
    // Stretch along z (longshore) a little by using fewer cells per period in z.
    const p = vec2(q.x, q.y.mul(0.75)).add(warp).toVar();
    const eA = pcell(p, [P, P * 0.75], 5);
    const eB = pcell(p.mul(2), [P * 2, P * 1.5], 6).mul(1.1);
    const patchy = smoothstep(-0.2, 0.5, pnoise(q.mul(0.25), P / 4, 7));
    const rv = abs(pnoise(p, [P, P * 0.75], 8).add(pnoise(p.mul(2), [P * 2, P * 1.5], 9).mul(0.35)));
    const gap = smoothstep(0.1, 0.45, pnoise(p.mul(2), [P * 2, P * 1.5], 10)).mul(0.5);
    const coarse = min(min(eA.add(gap), eB.add(float(1).sub(patchy).mul(0.7))), rv.mul(2.8).add(0.04));
    const fine = pcell(q.mul(3).add(vec2(17, 4)), P * 3, 11);
    textureStore(lace, s, vec4(coarse, fine, 0, 1)).toWriteOnly();
  })().compute([LACE_N / 8, LACE_N / 8, 1], [8, 8, 1]).setName('gl.state.bakeLace');

  const valueKernel = Fn(() => {
    const s = ivec2(globalId.xy);
    const q = vec2(s).add(0.5).mul(VALUE_CELLS / VALUE_N).toVar();
    const n = (k: number) => pnoise(q, VALUE_CELLS, k).mul(0.5).add(0.5);
    textureStore(value, s, vec4(n(21), n(22), n(23), n(24))).toWriteOnly();
  })().compute([VALUE_N / 8, VALUE_N / 8, 1], [8, 8, 1]).setName('gl.state.bakeValue');

  // The far field (40 cm texels) samples the lace ~5x minified; a 4x4 box-filtered copy keeps
  // it from aliasing (and crawling as the foam drifts).
  const laceFar = makeTex(LACE_N / 4, 'laceFar');
  const laceSrc = baseTex(lace);
  const downKernel = Fn(() => {
    const s = ivec2(globalId.xy);
    const acc = vec4(0).toVar();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) acc.addAssign(laceSrc.load(s.mul(4).add(ivec2(x, y))));
    textureStore(laceFar, s, acc.mul(1 / 16)).toWriteOnly();
  })().compute([LACE_N / 32, LACE_N / 32, 1], [8, 8, 1]).setName('gl.state.bakeLaceFar');
  renderer.compute([laceKernel, valueKernel]);
  renderer.compute(downKernel);

  const laceT = baseTex(lace);
  const laceFarT = baseTex(laceFar);
  const valueT = baseTex(value);
  return {
    /** (coarse, fine) filament distance at lace-unit position q. */
    lace: (q: TSLNode) => laceT.sample(q.mul(1 / P)).level(0).xy,
    /** The same, box-filtered for sampling at >= 4 lace texels per sample. */
    laceFar: (q: TSLNode) => laceFarT.sample(q.mul(1 / P)).level(0).xy,
    /** Smooth value noise in [-1, 1] at frequency-scaled position p (1 cell per unit). Channel 0-3. */
    value: (p: TSLNode, ch: 0 | 1 | 2 | 3) => {
      const v = valueT.sample(p.mul(1 / VALUE_CELLS)).level(0);
      return (ch === 0 ? v.x : ch === 1 ? v.y : ch === 2 ? v.z : v.w).mul(2).sub(1);
    },
    /** All four channels of the value noise in [-1, 1]. */
    value4: (p: TSLNode) => valueT.sample(p.mul(1 / VALUE_CELLS)).level(0).mul(2).sub(1),
    dispose() {
      laceKernel.dispose();
      valueKernel.dispose();
      downKernel.dispose();
      laceFar.dispose();
      lace.dispose();
      value.dispose();
    },
  };
}

export type Noise = ReturnType<typeof createNoise>;
