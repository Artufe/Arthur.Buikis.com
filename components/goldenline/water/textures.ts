// Boot-time procedural textures for the water material (CPU, deterministic, tileable):
// - foam: R coarse lace (Voronoi cell walls, domain-warped), G bubbles (packed discs),
//         B soft density (fbm), A fine lace. Mipmapped, repeat-wrapped.
// - noise: four independent tileable fbm channels (slicks, macro variation).

import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';

function hash2(i: number, j: number, seed: number) {
  let h = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Periodic value noise (quintic interpolation) with integer period `p` at frequency `p` per tile. */
function vnoise(u: number, v: number, p: number, seed: number) {
  const x = u * p;
  const y = v * p;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(mod(xi, p), mod(yi, p), seed);
  const b = hash2(mod(xi + 1, p), mod(yi, p), seed);
  const c = hash2(mod(xi, p), mod(yi + 1, p), seed);
  const d = hash2(mod(xi + 1, p), mod(yi + 1, p), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(u: number, v: number, p0: number, oct: number, seed: number) {
  let s = 0;
  let w = 0.5;
  let norm = 0;
  let p = p0;
  for (let o = 0; o < oct; o++) {
    s += vnoise(u, v, p, seed + o * 17) * w;
    norm += w;
    w *= 0.5;
    p *= 2;
  }
  return s / norm;
}

/** Periodic Voronoi with `n` jittered cells per tile: returns [F1 distance, distance to the nearest cell wall] in cell units. */
function voronoi(u: number, v: number, n: number, seed: number, out: Float64Array) {
  const x = u * n;
  const y = v * n;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let md = 8;
  let mx = 0;
  let my = 0;
  let mi = 0;
  let mj = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ci = xi + i;
      const cj = yi + j;
      const px = ci + 0.15 + 0.7 * hash2(mod(ci, n), mod(cj, n), seed);
      const py = cj + 0.15 + 0.7 * hash2(mod(ci, n), mod(cj, n), seed + 101);
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < md) {
        md = d;
        mx = dx;
        my = dy;
        mi = ci;
        mj = cj;
      }
    }
  }
  // Distance to the closest bisector (cell wall), searched around the nearest cell.
  let me = 8;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const ci = mi + i;
      const cj = mj + j;
      if (ci === mi && cj === mj) continue;
      const px = ci + 0.15 + 0.7 * hash2(mod(ci, n), mod(cj, n), seed);
      const py = cj + 0.15 + 0.7 * hash2(mod(ci, n), mod(cj, n), seed + 101);
      const dx = px - x;
      const dy = py - y;
      const ex = dx - mx;
      const ey = dy - my;
      const el = Math.sqrt(ex * ex + ey * ey);
      if (el < 1e-6) continue;
      const e = ((mx + dx) * 0.5 * ex + (my + dy) * 0.5 * ey) / el;
      if (e < me) me = e;
    }
  }
  out[0] = Math.sqrt(md);
  out[1] = me;
}

export const FOAM_TEX = 512;

/** Ridged periodic fbm in [0, 1]: thin, branching filaments where the noise crosses its mean. */
function ridged(u: number, v: number, p0: number, oct: number, seed: number) {
  let s = 0;
  let w = 0.5;
  let norm = 0;
  let p = p0;
  for (let o = 0; o < oct; o++) {
    const n = 1 - Math.abs(vnoise(u, v, p, seed + o * 13) * 2 - 1);
    s += n * n * w;
    norm += w;
    w *= 0.55;
    p *= 2;
  }
  return s / norm;
}

export function bakeFoamTexture(): DataTexture {
  const N = FOAM_TEX;
  const data = new Uint8Array(N * N * 4);
  const vo = new Float64Array(2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const v = (j + 0.5) / N;
      // Strong two-level domain warp: foam cells are torn and stretched, never honeycombs.
      const w1u = (fbm(u, v, 3, 3, 11) - 0.5) * 0.22;
      const w1v = (fbm(u, v, 3, 3, 23) - 0.5) * 0.22;
      const wu = u + w1u + (fbm(u + w1u, v + w1v, 7, 2, 12) - 0.5) * 0.07;
      const wv = v + w1v + (fbm(u + w1u, v + w1v, 7, 2, 24) - 0.5) * 0.07;
      // Foam structure as a hole field: holes are warped discs of random radius at two scales
      // (6 and 15 per tile); h = distance to the nearest hole centre over that hole's radius
      // (0 at the centre, 1 on its rim). Thresholding h at a rising level grows the holes until
      // they merge: fresh sheet → lace → filaments → specks. Ridged filaments keep streaks alive.
      voronoi(wu, wv, 6, 5, vo);
      const cA = hash2(Math.floor(wu * 6), Math.floor(wv * 6), 81);
      const hA = vo[0] / (0.3 + 0.2 * cA);
      voronoi(wu + 0.37, wv + 0.11, 15, 7, vo);
      const cB = hash2(Math.floor((wu + 0.37) * 15), Math.floor((wv + 0.11) * 15), 83);
      const hB = vo[0] / (0.24 + 0.24 * cB);
      const fil = Math.pow(ridged(wu, wv, 6, 4, 61), 3);
      const hole = Math.min(hA, hB * 1.08) + fil * 0.45;
      const lace = Math.min(1, hole / 1.6);
      // Fine structure for close range (the tile is sampled again at 1/4 scale): small holes.
      const fu = u + (fbm(u, v, 8, 2, 41) - 0.5) * 0.08;
      const fv = v + (fbm(u, v, 8, 2, 43) - 0.5) * 0.08;
      voronoi(fu, fv, 20, 17, vo);
      const cF = hash2(Math.floor(fu * 20), Math.floor(fv * 20), 85);
      const fine = Math.min(1, (vo[0] / (0.28 + 0.2 * cF) + Math.pow(ridged(u, v, 16, 3, 71), 3) * 0.35) / 1.6);
      // Bubbles: packed discs of varying size, bright rim, darker core (how foam bubbles read).
      voronoi(u, v, 48, 9, vo);
      const r = 0.34 + 0.14 * hash2(Math.floor(u * 48), Math.floor(v * 48), 3);
      const t = Math.min(1, vo[0] / r);
      const bubble = t < 1 ? 0.55 + 0.45 * Math.pow(t, 3) : Math.max(0, 0.35 - (vo[0] - r) * 3);
      // [polish] z: a ridged web (thin branching filaments on a warped domain) — the lace of
      // ageing foam is a network of bubble walls around irregular holes, not a field of discs.
      const web = Math.pow(ridged(wu * 1.0 + 0.19, wv * 1.0 + 0.53, 5, 3, 91), 1.6);
      const dens = Math.min(1, web * 1.15);
      const o = (j * N + i) * 4;
      data[o] = Math.round(lace * 255);
      data[o + 1] = Math.round(Math.min(1, bubble) * 255);
      data[o + 2] = Math.round(dens * 255);
      data[o + 3] = Math.round(Math.min(1, fine) * 255);
    }
  }
  return finish(new DataTexture(data, N, N, RGBAFormat, UnsignedByteType), 'water.foam');
}

export const NOISE_TEX = 256;

export function bakeNoiseTexture(): DataTexture {
  const N = NOISE_TEX;
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const v = (j + 0.5) / N;
      const o = (j * N + i) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = Math.round(fbm(u, v, 4, 5, 200 + c * 50) * 255);
    }
  }
  return finish(new DataTexture(data, N, N, RGBAFormat, UnsignedByteType), 'water.noise');
}

function finish(t: DataTexture, name: string) {
  t.name = name;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
