// Boot-time CPU bakes for the beach: tileable sand detail tiles (slope-encoded so mip filtering
// averages them correctly), the coarse far-field heightfield beyond the 1 m base bake, and the
// reef mask. Everything here runs once in init(); nothing is per-frame.

import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
} from 'three/webgpu';
import { CHANNEL, REEF, TERRAIN_BOUNDS } from '../world/layout';
import { terrainHeight } from '../world/terrain-shape';
import { fbm } from '../world/noise';
import { shoreX } from '../world/layout';

// ── Periodic gradient noise (tileable) ──

function ihash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
const u01 = (x: number, y: number, s: number) => ihash(x, y, s) / 4294967295;

function grad(ix: number, iy: number, s: number, dx: number, dy: number) {
  const a = u01(ix, iy, s) * Math.PI * 2;
  return Math.cos(a) * dx + Math.sin(a) * dy;
}

/** Perlin noise in ~[-1, 1], periodic with period (px, py) lattice cells. */
export function pnoise(x: number, y: number, px: number, py: number, s = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const ax = ((x0 % px) + px) % px;
  const ay = ((y0 % py) + py) % py;
  const bx = (ax + 1) % px;
  const by = (ay + 1) % py;
  const n00 = grad(ax, ay, s, fx, fy);
  const n10 = grad(bx, ay, s, fx - 1, fy);
  const n01 = grad(ax, by, s, fx, fy - 1);
  const n11 = grad(bx, by, s, fx - 1, fy - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.414;
}

/** Periodic fBm over a unit tile: `base` lattice cells per tile at the first octave. */
function pfbm(u: number, v: number, base: number, oct: number, s: number) {
  let sum = 0;
  let amp = 0.5;
  let f = base;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * pnoise(u * f, v * f, f, f, s + i * 31);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ── Tile packing ──

/**
 * Pack a periodic height tile (metres) into RGBA8: R,G = dh/du, dh/dv (m/m) mapped from
 * [-slopeRange, slopeRange]; B = height normalised to [0, 1] of `amp`; A = `extra` (0-1).
 */
function packSlopes(h: Float32Array, n: number, texel: number, amp: number, slopeRange: number, extra: Float32Array) {
  const out = new Uint8Array(n * n * 4);
  const k = 0.5 / slopeRange;
  for (let j = 0; j < n; j++) {
    const jm = ((j - 1 + n) % n) * n;
    const jp = ((j + 1) % n) * n;
    const jr = j * n;
    for (let i = 0; i < n; i++) {
      const im = (i - 1 + n) % n;
      const ip = (i + 1) % n;
      const sx = (h[jr + ip] - h[jr + im]) / (2 * texel);
      const sz = (h[jp + i] - h[jm + i]) / (2 * texel);
      const o = (jr + i) * 4;
      out[o] = Math.round(clamp01(0.5 + sx * k) * 255);
      out[o + 1] = Math.round(clamp01(0.5 + sz * k) * 255);
      out[o + 2] = Math.round(clamp01(h[jr + i] / amp) * 255);
      out[o + 3] = Math.round(clamp01(extra[jr + i]) * 255);
    }
  }
  return out;
}

function tileTexture(data: Uint8Array, n: number) {
  const tex = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface SandTile {
  texture: DataTexture;
  /** Tile edge length (m). */
  size: number;
  /** Slope encoding range: decoded slope = (texel - 0.5) * 2 * slopeRange. */
  slopeRange: number;
  /** Height encoding: decoded height (m) = B * amp. */
  amp: number;
}

/**
 * Aeolian wind ripples on dry sand: asymmetric (gentle stoss, steep lee), sinuous crests that
 * fade in and out so they terminate and fork the way real ripple fields do. Tile u runs along
 * the wind, so crests run along v.
 */
export function bakeDryRipples(n = 512): SandTile {
  const size = 2.56;
  const waves = 26; // λ ≈ 9.8 cm
  const amp = 0.007;
  const slopeRange = 0.6;
  const h = new Float32Array(n * n);
  const ex = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const v = j / n;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      // Low-frequency warp only: long, gently sinuous crests (a high-frequency warp gives worms).
      const warp = 1.5 * pfbm(u, v, 2, 3, 11) + 0.35 * pnoise(u * 3, v * 5, 3, 5, 5);
      const phase = u * waves + warp * 1.4;
      const t = phase - Math.floor(phase);
      const c = 0.72; // crest position: long stoss slope, short lee face
      const prof = t < c ? Math.sin((Math.PI / 2) * (t / c)) ** 2 : Math.cos((Math.PI / 2) * ((t - c) / (1 - c))) ** 2;
      const a = smooth(-0.35, 0.45, pfbm(u, v, 4, 2, 23));
      const pits = 0.06 * pfbm(u, v, 48, 2, 91);
      const k = j * n + i;
      h[k] = amp * (0.12 + 0.88 * a) * (0.1 + 0.9 * prof) + amp * pits;
      // Cavity: troughs gather darker, coarser grains (a real ripple-field colour cue).
      ex[k] = clamp01(0.5 + 0.5 * (1 - prof) * a);
    }
  }
  return { texture: tileTexture(packSlopes(h, n, size / n, amp * 1.1, slopeRange, ex), n), size, slopeRange, amp: amp * 1.1 };
}

/**
 * Wave-formed vortex ripples on the seabed: symmetric, peaked crests over rounded troughs,
 * parallel to the incoming swell crests (tile u runs along the swell direction).
 */
export function bakeWaveRipples(n = 512): SandTile {
  const size = 4;
  const waves = 7; // λ ≈ 57 cm
  const amp = 0.035;
  const slopeRange = 0.6;
  const h = new Float32Array(n * n);
  const ex = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const v = j / n;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const warp = 0.9 * pfbm(u, v, 2, 3, 7) + 0.25 * pnoise(u * 3, v * 5, 3, 5, 3);
      const phase = u * waves + warp;
      const s = Math.abs(Math.sin(Math.PI * phase));
      const prof = 1 - Math.pow(s, 0.75);
      const a = 0.35 + 0.65 * smooth(-0.4, 0.4, pfbm(u, v, 3, 2, 41));
      const k = j * n + i;
      h[k] = amp * a * prof + 0.004 * pfbm(u, v, 24, 2, 17);
      ex[k] = clamp01(0.35 + 0.65 * (1 - prof));
    }
  }
  return { texture: tileTexture(packSlopes(h, n, size / n, amp * 1.15, slopeRange, ex), n), size, slopeRange, amp: amp * 1.15 };
}

/**
 * Swash-zone texture: lumpy cm-scale relief of settled grains, faint meandering backwash rills
 * running shore-normal, the thin curved crest lines stranded by old run-ups, scattered
 * pinholes (air escaping as the film drains) and a few flat shell chips. Tile u runs shore-normal.
 */
export function bakeSwash(n = 512): SandTile {
  const size = 2;
  const amp = 0.003;
  const slopeRange = 0.35;
  const h = new Float32Array(n * n);
  const ex = new Float32Array(n * n);
  const cells = 64;
  for (let j = 0; j < n; j++) {
    const v = j / n;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      // Rills: narrow grooves along u, meandering in v.
      const rw = pnoise(u * 3, v * 22 + 1.8 * pfbm(u, v, 3, 2, 13), 3, 22, 61);
      const rill = Math.exp(-((rw / 0.12) ** 2)) * smooth(-0.2, 0.4, pfbm(u, v, 2, 2, 62));
      // Stranded swash lines: thin crests along v, wavy.
      const lp = u * 5 + 0.8 * pfbm(u, v, 2, 3, 29);
      const line = Math.exp(-(((lp - Math.floor(lp) - 0.5) / 0.035) ** 2)) * smooth(0.0, 0.5, pfbm(u, v, 3, 2, 30));
      // Pinholes: one candidate per cell, a few percent of cells.
      const cx = Math.floor(u * cells);
      const cy = Math.floor(v * cells);
      let pit = 0;
      if (u01(cx, cy, 77) > 0.955) {
        const ox = (cx + 0.2 + 0.6 * u01(cx, cy, 78)) / cells;
        const oy = (cy + 0.2 + 0.6 * u01(cx, cy, 79)) / cells;
        const d = Math.hypot(u - ox, v - oy) * size;
        pit = Math.exp(-((d / 0.0009) ** 2));
      }
      const lump = pfbm(u, v, 40, 3, 3);
      const sx = Math.floor(u * 90);
      const sy = Math.floor(v * 90);
      const chip = u01(sx, sy, 81) > 0.972 ? smooth(0.45, 0.2, Math.hypot(u * 90 - sx - 0.5, v * 90 - sy - 0.5)) : 0;
      const k = j * n + i;
      h[k] = amp * (0.35 * lump - 0.45 * rill + 0.35 * line - 0.8 * pit + 0.45 * chip) + amp;
      ex[k] = clamp01(0.62 + 0.3 * chip - 0.1 * rill - 0.6 * pit + 0.08 * line);
    }
  }
  return { texture: tileTexture(packSlopes(h, n, size / n, amp * 2, slopeRange, ex), n), size, slopeRange, amp: amp * 2 };
}

/**
 * Grain-scale tile (~1 mm texels): lumpy grain relief and shell grit. R,G slopes; B = albedo
 * speckle (0.5 neutral: darker lithic grains and pink shell grit); A = sparse glint mask (the
 * few flat, mirror-like grain faces that catch the sun at grazing angles).
 */
export function bakeGrain(n = 512): SandTile {
  const size = 0.5;
  const amp = 0.0012;
  const slopeRange = 1.2;
  const h = new Float32Array(n * n);
  const packed = new Uint8Array(n * n * 4);
  const tex = size / n;
  for (let j = 0; j < n; j++) {
    const v = j / n;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const g = 0.6 * pfbm(u, v, 200, 2, 5) + 0.4 * pfbm(u, v, 400, 1, 9);
      h[j * n + i] = amp * (0.5 + 0.5 * g);
    }
  }
  const cells = 256;
  for (let j = 0; j < n; j++) {
    const jm = ((j - 1 + n) % n) * n;
    const jp = ((j + 1) % n) * n;
    const jr = j * n;
    const v = j / n;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const im = (i - 1 + n) % n;
      const ip = (i + 1) % n;
      const sx = (h[jr + ip] - h[jr + im]) / (2 * tex);
      const sz = (h[jp + i] - h[jm + i]) / (2 * tex);
      const cx = Math.floor(u * cells);
      const cy = Math.floor(v * cells);
      const r = u01(cx, cy, 101);
      // Speckle: 6% dark lithic grains, 8% pink/orange shell grit, rest neutral with slight value noise.
      let alb = 0.5 + 0.12 * pfbm(u, v, 128, 1, 55);
      if (r < 0.06) alb = 0.12 + 0.2 * u01(cx, cy, 102);
      else if (r > 0.92) alb = 0.78 + 0.2 * u01(cx, cy, 103);
      const glint = u01(cx, cy, 104) > 0.965 ? 1 : 0;
      const o = (jr + i) * 4;
      packed[o] = Math.round(clamp01(0.5 + (sx * 0.5) / slopeRange) * 255);
      packed[o + 1] = Math.round(clamp01(0.5 + (sz * 0.5) / slopeRange) * 255);
      packed[o + 2] = Math.round(clamp01(alb) * 255);
      packed[o + 3] = glint * 255;
    }
  }
  return { texture: tileTexture(packed, n), size, slopeRange, amp };
}

/**
 * Macro variation tile (~19 cm texels over 48 m): R = albedo drift, G = coarse shell-hash
 * patches, B = low undulation height (0-1), A = moisture mottling for the damp band.
 */
export function bakeMacro(n = 256): SandTile {
  const size = 48;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    const v = j / n;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const o = (j * n + i) * 4;
      data[o] = Math.round(clamp01(0.5 + 0.5 * pfbm(u, v, 5, 4, 201)) * 255);
      data[o + 1] = Math.round(smooth(0.1, 0.6, pfbm(u, v, 9, 3, 202)) * 255);
      data[o + 2] = Math.round(clamp01(0.5 + 0.5 * pfbm(u, v, 3, 4, 203)) * 255);
      data[o + 3] = Math.round(clamp01(0.5 + 0.6 * pfbm(u, v, 12, 3, 204)) * 255);
    }
  }
  return { texture: tileTexture(data, n), size, slopeRange: 1, amp: 1 };
}

// ── Far-field heightfield ──

/** Coarse bake of the same terrain function beyond the 1 m base bake (minX, minZ, maxX, maxZ). */
export const FAR_BOUNDS: [number, number, number, number] = [-1536, -2048, 1024, 2048];
export const FAR_TEXEL = 8;

/**
 * Height + gradient texture (RGBA32F: h, dh/dx, dh/dz, 0) from a row-major height grid, so the
 * terrain vertex stage gets its normal from the same 4 B-spline taps as its height.
 */
export function heightGradTexture(hgt: Float32Array, w: number, h: number, texel: number): DataTexture {
  const data = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    const jm = Math.max(0, j - 1) * w;
    const jp = Math.min(h - 1, j + 1) * w;
    for (let i = 0; i < w; i++) {
      const im = Math.max(0, i - 1);
      const ip = Math.min(w - 1, i + 1);
      const o = (j * w + i) * 4;
      data[o] = hgt[j * w + i];
      data[o + 1] = (hgt[j * w + ip] - hgt[j * w + im]) / ((ip - im) * texel);
      data[o + 2] = (hgt[jp + i] - hgt[jm + i]) / (((jp - jm) / w) * texel);
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat, FloatType);
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function bakeFarHeight(): DataTexture {
  const [minX, minZ, maxX, maxZ] = FAR_BOUNDS;
  const w = Math.round((maxX - minX) / FAR_TEXEL);
  const h = Math.round((maxZ - minZ) / FAR_TEXEL);
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = minZ + (j + 0.5) * FAR_TEXEL;
    for (let i = 0; i < w; i++) data[j * w + i] = terrainHeight(minX + (i + 0.5) * FAR_TEXEL, z);
  }
  return heightGradTexture(data, w, h, FAR_TEXEL);
}

// ── Reef mask (mirrors the shelf test in world/seabed.ts) ──

export const AUX_TEXEL = 2;

/**
 * Dune vegetation cover 0-1 (creepers, grass mats, scrub): patchy on the foredune face, dense
 * behind it, with bare blowouts. Shared by the terrain shader (via the aux bake) and the GPU-placed
 * grass and creeper clumps, so geometry always grows where the ground is shaded green.
 */
export function vegetationCover(x: number, z: number) {
  const d = x - shoreX(z);
  if (d < 40) return 0;
  const n1 = fbm(x * 0.045, z * 0.045, 3);
  const n2 = fbm(x * 0.21, z * 0.21, 3);
  const zone = smooth(50, 64, d + 9 * n1);
  const cover = smooth(-0.22, 0.22, 0.85 * n2 + 0.5 * n1 + 0.9 * smooth(66, 110, d) - 0.12);
  return zone * cover;
}

/** R = reef shelf presence, G = channel, B = vegetation cover, A = 0, at AUX_TEXEL over TERRAIN_BOUNDS. */
export function bakeAux(): DataTexture {
  const [minX, minZ, maxX, maxZ] = TERRAIN_BOUNDS;
  const w = Math.round((maxX - minX) / AUX_TEXEL);
  const h = Math.round((maxZ - minZ) / AUX_TEXEL);
  const data = new Uint8Array(w * h * 4);
  const ex = REEF.b.x - REEF.a.x;
  const ez = REEF.b.z - REEF.a.z;
  const elen = Math.hypot(ex, ez);
  const ux = ex / elen;
  const uz = ez / elen;
  for (let j = 0; j < h; j++) {
    const z = minZ + (j + 0.5) * AUX_TEXEL;
    for (let i = 0; i < w; i++) {
      const x = minX + (i + 0.5) * AUX_TEXEL;
      // Mirrors world/seabed.ts (meandering edge, presence along the edge line).
      const px = x - REEF.a.x;
      const pz = z - REEF.a.z;
      const along = px * ux + pz * uz;
      const alongT = along / elen;
      const across = px * uz - pz * ux + 4.5 * fbm(along * 0.018, 3.7, 2);
      const endFade = smooth(-0.1, 0.03, alongT) * (1 - smooth(0.88, 1.06, alongT));
      // Slightly wider than the shelf itself so the top of the reef front is rock too.
      const onShelf = smooth(-12, -2, across) * (1 - smooth(REEF.width - 10, REEF.width + 14, across));
      const reef = onShelf * endFade;
      const ch = smooth(CHANNEL.zMin - 10, CHANNEL.zMin, z) * (1 - smooth(CHANNEL.zMax, CHANNEL.zMax + 12, z));
      const o = (j * w + i) * 4;
      data[o] = Math.round(clamp01(reef) * 255);
      data[o + 1] = Math.round(clamp01(ch) * 255);
      data[o + 2] = Math.round(clamp01(vegetationCover(x, z)) * 255);
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
