// Boot-time sprite atlas for the spray (2 × 2 variants, 128² each): billowy whitewater puffs.
// R = density (the sprite's opacity), G = self-shading as if lit from above (a cauliflower's
// sunny tops and dim undersides), B = thinness (1 at the ragged edges: those glow when backlit).

import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, UnsignedByteType } from 'three/webgpu';

const N = 128;
export const SPRAY_ATLAS = 2; // variants per side

function hash(i: number, j: number, s: number) {
  let h = Math.imul(i * 374761393 + j * 668265263 + s * 2246822519, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x: number, y: number, s: number) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j, s);
  const b = hash(i + 1, j, s);
  const c = hash(i, j + 1, s);
  const d = hash(i + 1, j + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, s: number) {
  let f = 0;
  let a = 0.5;
  for (let o = 0; o < 5; o++) {
    f += a * vnoise(x, y, s + o * 17);
    x *= 2.03;
    y *= 2.03;
    a *= 0.5;
  }
  return f;
}

export function bakeSprayAtlas(): DataTexture {
  const W = N * SPRAY_ATLAS;
  const data = new Uint8Array(W * W * 4);
  const dens = new Float32Array(N * N);
  for (let v = 0; v < SPRAY_ATLAS * SPRAY_ATLAS; v++) {
    const ox = (v % SPRAY_ATLAS) * N;
    const oy = Math.floor(v / SPRAY_ATLAS) * N;
    // A puff: a cluster of soft balls (cauliflower lobes), eroded by fbm at the edge.
    const nb = 7 + v * 2;
    const bx = new Float32Array(nb);
    const by = new Float32Array(nb);
    const br = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const a = hash(b, v, 3) * Math.PI * 2;
      const rr = 0.42 * Math.sqrt(hash(b, v, 5));
      bx[b] = Math.cos(a) * rr;
      by[b] = Math.sin(a) * rr * 0.85 + 0.05;
      br[b] = 0.22 + 0.2 * hash(b, v, 7);
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const px = (x + 0.5) / N * 2 - 1;
        const py = (y + 0.5) / N * 2 - 1;
        let d = 0;
        for (let b = 0; b < nb; b++) {
          const dx = px - bx[b];
          const dy = py - by[b];
          const q = (dx * dx + dy * dy) / (br[b] * br[b]);
          d += Math.exp(-q * 1.6);
        }
        const n = fbm(px * 3 + v * 7.1, py * 3 + v * 3.3, 11 + v);
        // [look] A long, soft radial falloff and no saturated plateau: a hard rim and a flat
        // interior read as discs on big sprites.
        const rr = Math.min(1, Math.hypot(px, py) / 0.98);
        const t = Math.min(1, Math.max(0, (rr - 0.2) / 0.78));
        const edge = 1 - t * t * (3 - 2 * t);
        dens[y * N + x] = Math.max(0, Math.min(1, (d * 0.8 + (n - 0.5) * 1.1 - 0.28) * 1.15)) * edge * edge;
      }
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const D = dens[y * N + x];
        // Self-shading: density integrated toward the light (above, y decreasing in texture rows).
        let occ = 0;
        for (let k = 1; k <= 12; k++) {
          const yy = y - k * 3;
          if (yy < 0) break;
          occ += dens[yy * N + x] * 0.12;
        }
        const lit = Math.exp(-occ * 1.8);
        const o = ((oy + y) * W + ox + x) * 4;
        data[o] = Math.round(D * 255);
        data[o + 1] = Math.round((0.25 + 0.75 * lit) * 255);
        data[o + 2] = Math.round(Math.max(0, 1 - D * 1.6) * 255);
        data[o + 3] = 255;
      }
    }
  }
  const t = new DataTexture(data, W, W, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
