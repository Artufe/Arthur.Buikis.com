// Boot-time CPU bakes of the small tiling detail maps the board and skin shaders use.
// Baked (not procedural in-shader) so they are mip-mapped: high-frequency detail that isn't
// filtered crawls under TAA. Deterministic (seeded), so every boot looks the same.

import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three/webgpu';

/** Physical tile sizes (m) the shaders scale their coordinates by. */
export const TILE = {
  wax: 0.22,
  beads: 0.11,
  noise: 1.0,
  skin: 0.045,
};

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toTexture(data: Uint8Array, size: number) {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Periodic value noise on a `period`-cell lattice, smooth (quintic), in [0, 1]. */
function makePeriodicNoise(seed: number, period: number) {
  const rnd = mulberry32(seed);
  const lat = new Float32Array(period * period);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  return (u: number, v: number) => {
    const x = u * period;
    const y = v * period;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const a = lat[y0 * period + x0];
    const b = lat[y0 * period + x1];
    const c = lat[y1 * period + x0];
    const d = lat[y1 * period + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function fbm(noises: Array<(u: number, v: number) => number>, u: number, v: number) {
  let s = 0;
  let amp = 0.5;
  let tot = 0;
  for (let i = 0; i < noises.length; i++) {
    s += noises[i](u, v) * amp;
    tot += amp;
    amp *= 0.5;
  }
  return s / tot;
}

/** Height field → packed normal (RG), with wraparound differences. */
function packNormals(h: Float32Array, size: number, strength: number, out: Uint8Array) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size;
      const xr = (x + 1) % size;
      const yd = (y - 1 + size) % size;
      const yu = (y + 1) % size;
      const dx = (h[y * size + xr] - h[y * size + xl]) * strength;
      const dy = (h[yu * size + x] - h[yd * size + x]) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      out[i] = Math.round((-dx / len) * 127.5 + 127.5);
      out[i + 1] = Math.round((-dy / len) * 127.5 + 127.5);
    }
  }
}

/**
 * RGBA noise: R = broad fbm, G = medium fbm (different seed), B = cellular (F1, 0 at cell
 * centres), A = fine grain. One tile = TILE.noise metres.
 */
export function bakeNoise(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const r = [makePeriodicNoise(11, 4), makePeriodicNoise(12, 8), makePeriodicNoise(13, 16), makePeriodicNoise(14, 32)];
  const g = [makePeriodicNoise(21, 8), makePeriodicNoise(22, 16), makePeriodicNoise(23, 32), makePeriodicNoise(24, 64)];
  const a = [makePeriodicNoise(31, 64), makePeriodicNoise(32, 128)];
  const rnd = mulberry32(99);
  const cells = 12;
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) {
    pts[i * 2] = rnd();
    pts[i * 2 + 1] = rnd();
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const cx = Math.floor(u * cells);
      const cy = Math.floor(v * cells);
      let best = 9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const gy = cy + oy;
          const wx = ((gx % cells) + cells) % cells;
          const wy = ((gy % cells) + cells) % cells;
          const px = (gx + pts[(wy * cells + wx) * 2]) / cells;
          const py = (gy + pts[(wy * cells + wx) * 2 + 1]) / cells;
          const dd = Math.hypot(px - u, py - v) * cells;
          if (dd < best) best = dd;
        }
      }
      const i = (y * size + x) * 4;
      data[i] = Math.round(fbm(r, u, v) * 255);
      data[i + 1] = Math.round(fbm(g, u, v) * 255);
      data[i + 2] = Math.round(Math.min(1, best) * 255);
      data[i + 3] = Math.round(fbm(a, u, v) * 255);
    }
  }
  return toTexture(data, size);
}

/**
 * Surf wax: rubbed-in bumps of 2–7 mm over a thin base coat, patchy coverage.
 * RG = normal, B = wax height (0..1), A = coverage (0 = bare glass).
 */
export function bakeWax(size = 512) {
  const h = new Float32Array(size * size);
  const rnd = mulberry32(7);
  const pxPerM = size / TILE.wax;
  const count = 2600;
  for (let n = 0; n < count; n++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const rad = (0.0012 + 0.0026 * Math.pow(rnd(), 1.6)) * pxPerM;
    const amp = 0.45 + 0.55 * rnd();
    // Rubbed bumps are slightly elongated along the rubbing direction.
    const ang = rnd() * Math.PI;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const el = 1 + 0.6 * rnd();
    const R = Math.ceil(rad * el) + 1;
    for (let oy = -R; oy <= R; oy++) {
      for (let ox = -R; ox <= R; ox++) {
        const lx = (ox * ca + oy * sa) / el;
        const ly = -ox * sa + oy * ca;
        const q = (lx * lx + ly * ly) / (rad * rad);
        if (q >= 1) continue;
        const bump = amp * Math.pow(1 - q, 1.5);
        const x = ((Math.floor(cx) + ox) % size + size) % size;
        const y = ((Math.floor(cy) + oy) % size + size) % size;
        const k = y * size + x;
        // Wax piles up: soft max, not a sum.
        h[k] = h[k] + bump - h[k] * bump * 0.55;
      }
    }
  }
  const cov = [makePeriodicNoise(41, 3), makePeriodicNoise(42, 6), makePeriodicNoise(43, 12)];
  const fine = [makePeriodicNoise(44, 64), makePeriodicNoise(45, 128)];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      const c = fbm(cov, x / size, y / size);
      const coverage = Math.min(1, Math.max(0, (c - 0.3) / 0.35));
      h[k] = (h[k] * 0.85 + fbm(fine, x / size, y / size) * 0.15) * (0.35 + 0.65 * coverage);
      data[k * 4 + 2] = Math.round(Math.min(1, h[k]) * 255);
      data[k * 4 + 3] = Math.round(coverage * 255);
    }
  }
  packNormals(h, size, 2.6, data);
  return toTexture(data, size);
}

/**
 * Water beads on a waxed/glassed deck: non-overlapping drops of 0.4–3 mm radius.
 * RG = normal, B = drop mask (soft 1 px edge), A = per-drop random id (drops dry in id order).
 */
export function bakeBeads(size = 512) {
  const data = new Uint8Array(size * size * 4);
  const occ = new Float32Array(size * size);
  const hgt = new Float32Array(size * size);
  const idm = new Float32Array(size * size);
  const rnd = mulberry32(5);
  const pxPerM = size / TILE.beads;
  const tries = 5000;
  for (let n = 0; n < tries; n++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const rad = (0.0008 + 0.0028 * Math.pow(rnd(), 1.8)) * pxPerM;
    const R = Math.ceil(rad) + 2;
    // Reject overlaps (sample a few points of the footprint).
    let clash = false;
    for (let oy = -R; oy <= R && !clash; oy += 2) {
      for (let ox = -R; ox <= R; ox += 2) {
        if (ox * ox + oy * oy > (rad + 1.5) * (rad + 1.5)) continue;
        const x = ((Math.floor(cx) + ox) % size + size) % size;
        const y = ((Math.floor(cy) + oy) % size + size) % size;
        if (occ[y * size + x] > 0) {
          clash = true;
          break;
        }
      }
    }
    if (clash) continue;
    const id = rnd();
    for (let oy = -R; oy <= R; oy++) {
      for (let ox = -R; ox <= R; ox++) {
        const fx = Math.floor(cx) + ox + 0.5 - cx;
        const fy = Math.floor(cy) + oy + 0.5 - cy;
        const q = Math.hypot(fx, fy) / rad;
        if (q > 1.05) continue;
        const x = ((Math.floor(cx) + ox) % size + size) % size;
        const y = ((Math.floor(cy) + oy) % size + size) % size;
        const k = y * size + x;
        occ[k] = Math.max(occ[k], Math.min(1, (1.05 - q) / 0.12));
        hgt[k] = Math.max(hgt[k], rad * 0.55 * Math.max(0, 1 - q * q));
        idm[k] = id;
      }
    }
  }
  packNormals(hgt, size, 0.9, data);
  for (let k = 0; k < size * size; k++) {
    data[k * 4 + 2] = Math.round(occ[k] * 255);
    data[k * 4 + 3] = Math.round(idm[k] * 255);
  }
  return toTexture(data, size);
}

/**
 * Skin micro-relief for triplanar projection: fine cross-hatched lines, pores, soft mottling.
 * RG = relief normal, B = mottling (albedo variation), A = salt/dry patch noise.
 */
export function bakeSkin(size = 512) {
  const h = new Float32Array(size * size);
  const rnd = mulberry32(17);
  const n1 = [makePeriodicNoise(51, 24), makePeriodicNoise(52, 48)];
  const n2 = [makePeriodicNoise(53, 20), makePeriodicNoise(54, 40)];
  const mott = [makePeriodicNoise(55, 4), makePeriodicNoise(56, 8), makePeriodicNoise(57, 16)];
  const salt = [makePeriodicNoise(58, 3), makePeriodicNoise(59, 6), makePeriodicNoise(60, 12), makePeriodicNoise(61, 48)];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Two families of shallow furrows (skin "lines"), warped so they read organic.
      const w1 = fbm(n1, u, v) * 2.2;
      const w2 = fbm(n2, u, v) * 2.2;
      // Even multiples of PI per tile so the furrows wrap seamlessly.
      const l1 = Math.abs(Math.sin((u * 32 + v * 24) * Math.PI + w1 * 3));
      const l2 = Math.abs(Math.sin((u * -20 + v * 28) * Math.PI + w2 * 3));
      const furrow = Math.pow(1 - l1, 6) * 0.6 + Math.pow(1 - l2, 6) * 0.5;
      h[y * size + x] = 0.6 - furrow * 0.5;
      const k = (y * size + x) * 4;
      data[k + 1] = Math.round(fbm(mott, u, v) * 255);
      data[k + 3] = Math.round(fbm(salt, u, v) * 255);
    }
  }
  // Pores: tiny pits.
  const pores = new Float32Array(size * size);
  for (let n = 0; n < 5200; n++) {
    const cx = Math.floor(rnd() * size);
    const cy = Math.floor(rnd() * size);
    const rad = 0.8 + rnd() * 1.1;
    const R = Math.ceil(rad);
    for (let oy = -R; oy <= R; oy++) {
      for (let ox = -R; ox <= R; ox++) {
        const q = (ox * ox + oy * oy) / (rad * rad);
        if (q >= 1) continue;
        const x = (cx + ox + size) % size;
        const y = (cy + oy + size) % size;
        const k = y * size + x;
        const p = 1 - q;
        h[k] -= 0.22 * p;
        pores[k] = Math.max(pores[k], p);
      }
    }
  }
  // RG = tangent-space normal of the relief (mip-mapped, so it never crawls), B = mottling.
  const mottle = new Uint8Array(size * size);
  for (let k = 0; k < size * size; k++) mottle[k] = data[k * 4 + 1];
  packNormals(h, size, 0.35, data);
  for (let k = 0; k < size * size; k++) data[k * 4 + 2] = mottle[k];
  void pores;
  return toTexture(data, size);
}
