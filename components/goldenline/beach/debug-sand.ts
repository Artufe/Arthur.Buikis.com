// A small CPU-written stand-in for state.sand() used only while the surface-state system is a
// stub, so footprint shading (rims, self-shadowing) can be tuned before A5 lands. Same channel
// layout as the contract: (wetness, depression m, displaced mass m, freshly-smoothed).

import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three/webgpu';
import { float, max, min, smoothstep, texture, uniform, vec4 } from 'three/tsl';
import { Vector2 } from 'three/webgpu';
import type { TSLNode } from '../core/contracts';

const N = 512;
const SIZE = 12.8; // m, 2.5 cm texels

// Foot outline as ellipses in foot space (a = along heading, b = lateral, metres).
const FOOT = [
  { a: -0.085, b: 0.0, ra: 0.05, rb: 0.037, depth: 1.0 }, // heel
  { a: -0.02, b: 0.017, ra: 0.06, rb: 0.022, depth: 0.55 }, // outer arch
  { a: 0.05, b: 0.004, ra: 0.045, rb: 0.047, depth: 0.9 }, // ball
  { a: 0.112, b: -0.028, ra: 0.018, rb: 0.016, depth: 0.8 }, // big toe
  { a: 0.105, b: -0.004, ra: 0.012, rb: 0.01, depth: 0.6 },
  { a: 0.098, b: 0.014, ra: 0.011, rb: 0.009, depth: 0.55 },
  { a: 0.089, b: 0.029, ra: 0.01, rb: 0.008, depth: 0.5 },
  { a: 0.078, b: 0.041, ra: 0.009, rb: 0.007, depth: 0.45 },
];

export function createDebugSand() {
  const data = new Float32Array(N * N * 4);
  const tex = new DataTexture(data, N, N, RGBAFormat, FloatType);
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  const center = uniform(new Vector2(0, 0));
  let cx = 0;
  let cz = 0;

  const clear = (x: number, z: number) => {
    data.fill(0);
    cx = x;
    cz = z;
    (center.value as Vector2).set(x, z);
    tex.needsUpdate = true;
  };

  /** Press one bare footprint (right foot when side > 0) centred at (x, z), heading (dx, dz). */
  const footprint = (x: number, z: number, dx: number, dz: number, side: number, depth = 0.022) => {
    const texel = SIZE / N;
    const i0 = Math.floor((x - cx) / texel + N / 2);
    const j0 = Math.floor((z - cz) / texel + N / 2);
    const r = Math.ceil(0.2 / texel);
    for (let j = j0 - r; j <= j0 + r; j++) {
      if (j < 0 || j >= N) continue;
      for (let i = i0 - r; i <= i0 + r; i++) {
        if (i < 0 || i >= N) continue;
        const px = cx + (i + 0.5 - N / 2) * texel - x;
        const pz = cz + (j + 0.5 - N / 2) * texel - z;
        const a = px * dx + pz * dz;
        const b = (px * -dz + pz * dx) * side;
        // Signed distance-ish to the union of ellipses (negative inside), and local depth.
        let sd = 1e9;
        let dep = 0;
        for (let k = 0; k < FOOT.length; k++) {
          const e = FOOT[k];
          const qa = (a - e.a) / e.ra;
          const qb = (b - e.b) / e.rb;
          const q = Math.sqrt(qa * qa + qb * qb);
          const s = (q - 1) * Math.min(e.ra, e.rb);
          if (s < sd) sd = s;
          const w = Math.max(0, 1 - q * q);
          if (w * e.depth > dep) dep = w * e.depth;
        }
        const inside = 1 - Math.min(1, Math.max(0, (sd + 0.004) / 0.01));
        const press = depth * Math.max(inside * 0.55, Math.sqrt(dep)) * inside;
        // Displaced sand heaps up just outside the outline, more at the toe (push-off).
        const toe = 0.6 + 0.8 * Math.max(0, a / 0.13);
        const rim = 0.0075 * toe * Math.exp(-(((sd - 0.013) / 0.011) ** 2));
        const o = (j * N + i) * 4;
        data[o + 1] = Math.max(data[o + 1], press);
        data[o + 2] = data[o + 2] * (1 - inside) + rim * (1 - inside);
      }
    }
    tex.needsUpdate = true;
  };

  /** TSL: (xz) => vec4 with the same layout as state.sand(). */
  const sand = (xz: TSLNode): TSLNode => {
    const uv = xz.sub(center).div(SIZE).add(0.5);
    const s = texture(tex).sample(uv).level(float(0));
    const e = min(min(uv.x, float(1).sub(uv.x)), min(uv.y, float(1).sub(uv.y)));
    const fade = smoothstep(0.0, 0.03, max(e, 0));
    return vec4(0, s.y.mul(fade), s.z.mul(fade), 0);
  };

  const height = (xz: TSLNode): TSLNode => {
    const s = sand(xz);
    return s.z.sub(s.y);
  };

  return { texture: tex, clear, footprint, sand, height, texel: SIZE / N, dispose: () => tex.dispose() };
}
