// GPU side of the breaker state: the per-frame data texture (tracker.ts), the ray-label field
// (rays.ts) and the profile keyframes (profile.ts), plus the TSL accessors both the ribbon mesh
// and the ocean's vertex hook use.

import { ClampToEdgeWrapping, Data3DTexture, DataTexture, FloatType, LinearFilter, NearestFilter, RGBAFormat, RedFormat } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../../core/contracts';
import { FIELD } from '../swell';
import { BLEND_BACK, BLEND_FRONT, DPHI, NJ, NK, NP, PHI0, U_BACK, U_FRONT, type ProfileTables } from './profile';
import { RAYS, type Rays } from './rays';
import { DATA_H, DATA_W, GLOBAL_ROW, G_CAM, G_TIME, ROWS } from './tracker';

const { clamp, float, floor, int, ivec2, min, mix, smoothstep, texture, texture3D, textureLoad, vec2, vec3 } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

export interface BreakGPU {
  dataTex: DataTexture;
  labelTex: DataTexture;
  profA: Data3DTexture;
  profB: Data3DTexture;
  profC: Data3DTexture;
  dispose(): void;
}

export function createBreakGPU(data: Float32Array, rays: Rays, prof: ProfileTables): BreakGPU {
  const dataTex = new DataTexture(data, DATA_W, DATA_H, RGBAFormat, FloatType);
  dataTex.magFilter = NearestFilter;
  dataTex.minFilter = NearestFilter;
  dataTex.generateMipmaps = false;
  dataTex.needsUpdate = true;

  const labelTex = new DataTexture(rays.label, FIELD.nx, FIELD.nz, RedFormat, FloatType);
  labelTex.magFilter = LinearFilter;
  labelTex.minFilter = LinearFilter;
  labelTex.wrapS = ClampToEdgeWrapping;
  labelTex.wrapT = ClampToEdgeWrapping;
  labelTex.generateMipmaps = false;
  labelTex.needsUpdate = true;

  const mk = (arr: Float32Array) => {
    const t = new Data3DTexture(arr, NJ, NK, NP);
    t.format = RGBAFormat;
    t.type = FloatType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.wrapR = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const profA = mk(prof.a);
  const profB = mk(prof.b);
  const profC = mk(prof.c);
  return {
    dataTex,
    labelTex,
    profA,
    profB,
    profC,
    dispose() {
      dataTex.dispose();
      labelTex.dispose();
      profA.dispose();
      profB.dispose();
      profC.dispose();
    },
  };
}

/** Slot header: (first ray, last ray, crest n, active). `slot` is an int node. */
export const slotHeader = (g: BreakGPU, slot: TSLNode) => textureLoad(g.dataTex, ivec2(slot, int(GLOBAL_ROW)));
/** (tMod, dt, phase0, 0). */
export const globals = (g: BreakGPU) => textureLoad(g.dataTex, ivec2(int(G_TIME), int(GLOBAL_ROW)));
/** Per slot: (camera column in its fan, fan 0 reef / 1 shore, label0, dLabel). */
export const slotCam = (g: BreakGPU, slot: TSLNode) => textureLoad(g.dataTex, ivec2(slot.add(G_CAM), int(GLOBAL_ROW)));

/** Row `row` of slot `slot` at fractional ray column `col`, linearly interpolated. */
export function slotRow(g: BreakGPU, slot: TSLNode, row: number, col: TSLNode) {
  const c = clamp(col, 0, DATA_W - 1.001);
  const c0 = int(floor(c));
  const f = c.sub(floor(c));
  const y = slot.mul(ROWS).add(row);
  const a = textureLoad(g.dataTex, ivec2(c0, y));
  const b = textureLoad(g.dataTex, ivec2(c0.add(1), y));
  return mix(a, b, f);
}

/** Two adjacent raw columns (for along-crest differences): the texel at int column `c0`. */
export const slotTexel = (g: BreakGPU, slot: TSLNode, row: number, c0: TSLNode) => textureLoad(g.dataTex, ivec2(c0, slot.mul(ROWS).add(row)));

/** Ray label (m) at a rest point (vec2). */
export function labelAtGPU(g: BreakGPU, xz: TSLNode) {
  const uv = xz.sub(vec2(FIELD.x0, FIELD.z0)).div(vec2(FIELD.nx * FIELD.texel, FIELD.nz * FIELD.texel));
  return texture(g.labelTex, uv).level(0).x;
}

/** Label → fractional ray column. */
export const labelToCol = (label: TSLNode) => label.sub(RAYS.z0).div(RAYS.dz);

/** Profile keyframe lookups at point j (float, exact texel), stage φ, plunge κ. */
export function profileUVW(j: TSLNode, phi: TSLNode, kappa: TSLNode) {
  const u = j.add(0.5).div(NJ);
  const v = clamp(phi.sub(PHI0).div(DPHI), 0, NK - 1).add(0.5).div(NK);
  const w = clamp(kappa, 0, 1).mul(NP - 1).add(0.5).div(NP);
  return vec3(u, v, w);
}
export const profA = (g: BreakGPU, uvw: TSLNode) => texture3D(g.profA, uvw).level(0);
export const profB = (g: BreakGPU, uvw: TSLNode) => texture3D(g.profB, uvw).level(0);
export const profC = (g: BreakGPU, uvw: TSLNode) => texture3D(g.profC, uvw).level(0);

/** TSL mirror of profile.ts blendW (edges in ascending order; reversed smoothstep is UB on Metal). */
export function blendWGPU(sigma: TSLNode) {
  const back = smoothstep(U_BACK, BLEND_BACK, sigma);
  const front = float(1).sub(smoothstep(BLEND_FRONT, U_FRONT, sigma));
  return min(back, front);
}

