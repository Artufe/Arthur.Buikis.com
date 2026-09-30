// Wave rays over the break, baked at boot from the ocean's swell field (train 0, the groundswell).
//
// A ray starts offshore at x = RAYS.x0 (label = its start z) and follows the refracted wave
// direction shoreward in 1 m steps until it reaches the beach. Along it we keep everything the
// breaker needs as 1-D arrays, so the per-frame crest search is a binary search, not a field fetch:
//
//   S    train-0 phase (monotone along the ray): crest n sits where S = phase + 2πn
//   Qh   cumulative max of K/h along the ray, with h the raw seabed depth lightly smoothed (5 m):
//        a wave of offshore amplitude a has broken once 2·a·Qh > γ_b, so the onset is a binary
//        search on Qh. (The swell field's own Q uses the 7 m-smoothed depth and a relaxation
//        length, which lets set waves overshoot the breaking index by ~2× before they "break".)
//   h    the smoothed still-water depth the swell is shaped from; hr the raw depth (exact seabed)
//
// The label field (ray label per swell-field texel) maps any rest point back to its ray, which
// is how the ocean's vertex hook finds the breaker a vertex belongs to.

import { FIELD, GAMMA_BREAK, type SwellField } from '../swell';
import { shoreX } from '../../world/layout';

export const RAYS = {
  /** Offshore start line and the first ray's label (start z). */
  x0: -214,
  z0: -300,
  /** Label spacing (m) and count. */
  dz: 1.5,
  n: 336,
  /** Arc step (m) and max samples per ray. */
  ds: 1,
  nm: 288,
};

const NC = FIELD.nx * FIELD.nz;

export interface Rays {
  nr: number;
  nm: number;
  /** Label of ray r = label0 + r·dLabel (the ray's start z). */
  label0: number;
  dLabel: number;
  /** Per ray: last valid sample, first nearshore sample (within 38 m of the shore). */
  mEnd: Int32Array;
  mNear: Int32Array;
  /** Per ray: reef-break plunge intensity 0-1 (how hollow waves throw here). */
  plunge: Float32Array;
  /** Per sample (ray-major, nm per ray). */
  px: Float32Array;
  pz: Float32Array;
  dx: Float32Array;
  dz: Float32Array;
  k: Float32Array;
  S: Float64Array;
  K: Float32Array;
  tau: Float32Array;
  Qh: Float32Array;
  h: Float32Array;
  hr: Float32Array;
  /** Label field on the swell grid (m, = ray start z), for the GPU hook and CPU lookups. */
  label: Float32Array;
}

/** Bilinear fetch of channel `c` of layer `layer` of the swell field at world (x, z). */
function fieldAt(f: SwellField, layer: number, c: number, x: number, z: number) {
  let u = (x - FIELD.x0) / FIELD.texel - 0.5;
  let v = (z - FIELD.z0) / FIELD.texel - 0.5;
  u = u < 0 ? 0 : u > FIELD.nx - 1.001 ? FIELD.nx - 1.001 : u;
  v = v < 0 ? 0 : v > FIELD.nz - 1.001 ? FIELD.nz - 1.001 : v;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const D = f.data;
  const base = layer * NC * 4;
  const a = base + (j * FIELD.nx + i) * 4 + c;
  const r = FIELD.nx * 4;
  return (D[a] * (1 - fu) + D[a + 4] * fu) * (1 - fv) + (D[a + r] * (1 - fu) + D[a + r + 4] * fu) * fv;
}

export function bakeRays(field: SwellField, terrainHeight: (x: number, z: number) => number): Rays {
  const NR = RAYS.n;
  const NM = RAYS.nm;
  const n = NR * NM;
  const R: Rays = {
    nr: NR,
    nm: NM,
    label0: RAYS.z0,
    dLabel: RAYS.dz,
    mEnd: new Int32Array(NR),
    mNear: new Int32Array(NR),
    plunge: new Float32Array(NR),
    px: new Float32Array(n),
    pz: new Float32Array(n),
    dx: new Float32Array(n),
    dz: new Float32Array(n),
    k: new Float32Array(n),
    S: new Float64Array(n),
    K: new Float32Array(n),
    tau: new Float32Array(n),
    Qh: new Float32Array(n),
    h: new Float32Array(n),
    hr: new Float32Array(n),
    label: new Float32Array(NC),
  };
  for (let r = 0; r < NR; r++) {
    let x = RAYS.x0;
    let z = RAYS.z0 + r * RAYS.dz;
    let qMax = 0;
    let sPrev = -1e30;
    let m = 0;
    let end = NM - 1;
    let near = NM - 1;
    for (; m < NM; m++) {
      const o = r * NM + m;
      let kx = fieldAt(field, 0, 2, x, z);
      let kz = fieldAt(field, 0, 3, x, z);
      const kl = Math.hypot(kx, kz) || 1e-6;
      kx /= kl;
      kz /= kl;
      const mx = kx;
      const mz = kz;
      R.px[o] = x;
      R.pz[o] = z;
      R.dx[o] = kx;
      R.dz[o] = kz;
      R.k[o] = kl;
      // Keep S strictly increasing so the crest search is well defined.
      let S = fieldAt(field, 0, 0, x, z);
      if (S <= sPrev) S = sPrev + 1e-4;
      sPrev = S;
      R.S[o] = S;
      R.K[o] = fieldAt(field, 0, 1, x, z);
      R.tau[o] = fieldAt(field, 1, 0, x, z);
      R.h[o] = fieldAt(field, 1, 3, x, z);
      R.hr[o] = -terrainHeight(x, z);
      if (near === NM - 1 && x - shoreX(z) > -38) near = m;
      // Stop at the beach or at the field edge.
      if (R.hr[o] < 0.05 || x > FIELD.x0 + FIELD.nx * FIELD.texel - 4 || z < FIELD.z0 + 4 || z > FIELD.z0 + FIELD.nz * FIELD.texel - 4) {
        end = m;
        break;
      }
      x += mx * RAYS.ds;
      z += mz * RAYS.ds;
    }
    R.mEnd[r] = Math.min(end, NM - 1);
    // Breaking history on the lightly smoothed raw depth.
    for (let q = 0; q <= R.mEnd[r]; q++) {
      let hs = 0;
      let wsum = 0;
      for (let e = -2; e <= 2; e++) {
        const qq = q + e < 0 ? 0 : q + e > R.mEnd[r] ? R.mEnd[r] : q + e;
        hs += R.hr[r * NM + qq];
        wsum++;
      }
      const he = Math.max(hs / wsum, 0.08);
      qMax = Math.max(qMax, R.K[r * NM + q] / he);
      R.Qh[r * NM + q] = qMax;
    }
    R.mNear[r] = Math.min(near, R.mEnd[r]);
    // Pad past the end so interpolation never reads garbage.
    for (let q = R.mEnd[r] + 1; q < NM; q++) {
      const o = r * NM + q;
      const p = r * NM + R.mEnd[r];
      R.px[o] = R.px[p];
      R.pz[o] = R.pz[p];
      R.dx[o] = R.dx[p];
      R.dz[o] = R.dz[p];
      R.k[o] = R.k[p];
      R.S[o] = R.S[p] + (q - R.mEnd[r]) * 1e-4;
      R.K[o] = R.K[p];
      R.tau[o] = R.tau[p];
      R.Qh[o] = R.Qh[p];
      R.h[o] = R.h[p];
      R.hr[o] = R.hr[p];
    }
    R.plunge[r] = plungeOf(R, r);
  }
  bakeLabels(field, R);
  return R;
}

/**
 * How hollow a set wave throws on this ray: the seabed slope where it breaks (a steep ledge
 * throws a barrel, a gentle shelf spills). Evaluated at the depth a 3 m face breaks in.
 */
function plungeOf(R: Rays, r: number) {
  const hb = 3 / GAMMA_BREAK;
  const o = r * R.nm;
  let m = 0;
  for (; m < R.mEnd[r]; m++) if (R.hr[o + m] <= hb) break;
  if (m >= R.mEnd[r] - 2) return 0;
  // Depth drop over the 14 m before the break point: the reef front drops ~6 m there.
  const m0 = Math.max(0, m - 14);
  const slope = (R.hr[o + m0] - R.hr[o + m]) / Math.max(1, m - m0);
  return Math.min(1, Math.max(0, (slope - 0.05) / 0.3));
}

/**
 * Ray label (start z) of every swell-field texel: transported shoreward along the train-0
 * direction column by column (the same upstream step the swell bake uses), extrapolated as a
 * plane wave seaward of the start line.
 */
function bakeLabels(field: SwellField, R: Rays) {
  const NX = FIELD.nx;
  const NZ = FIELD.nz;
  const L = R.label;
  const D = field.data;
  const i0 = Math.max(1, Math.round((RAYS.x0 - FIELD.x0) / FIELD.texel - 0.5));
  // Seaward of (and on) the start column: straight rays along the local (≈ deep-water) direction,
  // so a texel's label is where its ray crosses x = RAYS.x0.
  for (let j = 0; j < NZ; j++) {
    const c = j * NX + i0;
    const t = D[c * 4 + 3] / Math.max(1e-3, D[c * 4 + 2]);
    const zc = FIELD.z0 + (j + 0.5) * FIELD.texel;
    for (let i = 0; i <= i0; i++) {
      const x = FIELD.x0 + (i + 0.5) * FIELD.texel;
      L[j * NX + i] = zc + t * (RAYS.x0 - x);
    }
  }
  for (let i = i0 + 1; i < NX; i++) {
    for (let j = 0; j < NZ; j++) {
      const c = j * NX + i;
      const kx = Math.max(D[c * 4 + 2], 0.2 * Math.hypot(D[c * 4 + 2], D[c * 4 + 3]));
      const kz = D[c * 4 + 3];
      let zu = j - kz / Math.max(kx, 1e-6);
      if (zu < 0) zu = 0;
      if (zu > NZ - 1) zu = NZ - 1;
      const j0 = Math.min(NZ - 2, Math.floor(zu));
      const f = zu - j0;
      L[c] = L[j0 * NX + i - 1] * (1 - f) + L[(j0 + 1) * NX + i - 1] * f;
    }
  }
}

/**
 * Ray label at world (xz[o], xz[o + 1]), bilinear on the label field, written to xz[o + 2]
 * (doubles travel in the array: see tracker.ts on V8 boxing).
 */
export function labelAt(R: Rays, xz: Float64Array, o: number) {
  let u = (xz[o] - FIELD.x0) / FIELD.texel - 0.5;
  let v = (xz[o + 1] - FIELD.z0) / FIELD.texel - 0.5;
  u = u < 0 ? 0 : u > FIELD.nx - 1.001 ? FIELD.nx - 1.001 : u;
  v = v < 0 ? 0 : v > FIELD.nz - 1.001 ? FIELD.nz - 1.001 : v;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const L = R.label;
  const a = j * FIELD.nx + i;
  xz[o + 2] = (L[a] * (1 - fu) + L[a + 1] * fu) * (1 - fv) + (L[a + FIELD.nx] * (1 - fu) + L[a + FIELD.nx + 1] * fu) * fv;
}

export const RAY_NM = RAYS.nm;
export const RAY_NR = RAYS.n;
