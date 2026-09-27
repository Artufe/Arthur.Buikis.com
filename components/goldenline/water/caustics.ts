// Caustics projected from the real surface. Sun rays refracted by the surface slope s(x) land on
// the seabed D metres below at x' = x + D·t(s(x)), where t is the ray's horizontal run per metre
// of depth. The light density there is 1/|det J|, J = I + D·M·H, with M = ∂t/∂s at the flat
// surface (CPU, per sun direction) and H the surface Hessian (finite differences of the FFT slope
// textures). det → 0 traces the bright focal network; the lod of each cascade grows with depth so
// deeper floors see softer, larger cells, as the sun's disc and forward scattering blur them.
// The same construction with the reflected ray drives the dancing light under the pier deck.

import { Vector3 } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { CASCADES, FFT_N } from '../ocean/spectrum';
import { PIER } from '../world/layout';
import { HESSIAN_MAX_LOD } from './hessian';
import { cascadeUV, depthFade } from './slopes';

const { Fn, If, abs, exp, float, length, log2, max, min, smoothstep, texture, vec2, vec3, cameraPosition, clamp } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode> & { cameraPosition: TSLNode };

export const WATER_IOR = 1.333;

const v = new Vector3();
const n = new Vector3();

/** Refract (or reflect) the travelling sun ray I through the surface with slope (sx, sz). Writes horizontal run per unit vertical travel. */
function rayRun(L: Vector3, sx: number, sz: number, reflectRay: boolean, out: Float64Array) {
  n.set(-sx, 1, -sz).normalize();
  v.copy(L).negate(); // travelling direction
  const cosi = -v.dot(n);
  if (reflectRay) {
    v.addScaledVector(n, 2 * cosi);
    out[0] = v.x / v.y;
    out[1] = v.z / v.y;
    return;
  }
  const eta = 1 / WATER_IOR;
  const k = 1 - eta * eta * (1 - cosi * cosi);
  const c2 = eta * cosi - Math.sqrt(Math.max(k, 0));
  v.multiplyScalar(eta).addScaledVector(n, c2);
  out[0] = v.x / -v.y;
  out[1] = v.z / -v.y;
}

const r0 = new Float64Array(2);
const rp = new Float64Array(2);
const rm = new Float64Array(2);

/**
 * Writes (t0.x, t0.z, M00, M01, M10, M11) for the refracted (reflect = false) or reflected ray,
 * M = ∂run/∂slope at the flat surface. Zero-alloc; call when the sun moves.
 */
export function rayMatrix(sunDir: Vector3, reflectRay: boolean, out: Float32Array) {
  const e = 1e-3;
  rayRun(sunDir, 0, 0, reflectRay, r0);
  out[0] = r0[0];
  out[1] = r0[1];
  rayRun(sunDir, e, 0, reflectRay, rp);
  rayRun(sunDir, -e, 0, reflectRay, rm);
  out[2] = (rp[0] - rm[0]) / (2 * e);
  out[4] = (rp[1] - rm[1]) / (2 * e);
  rayRun(sunDir, 0, e, reflectRay, rp);
  rayRun(sunDir, 0, -e, reflectRay, rm);
  out[3] = (rp[0] - rm[0]) / (2 * e);
  out[5] = (rp[1] - rm[1]) / (2 * e);
}

export interface CausticSources {
  /** The Hessian array texture (water/hessian.ts). */
  hess: unknown;
  /** vec4 uniforms: (t0.x, t0.z, _, _) and (M00, M01, M10, M11). */
  uRun: TSLNode;
  uM: TSLNode;
  uRunR: TSLNode;
  uMR: TSLNode;
  uStrength: TSLNode;
  uPierStrength: TSLNode;
  uMaxDepth: TSLNode;
  uBlur: TSLNode;
  sunDir: TSLNode;
  sunColor: TSLNode;
}

/** World Hessian (Hxx, Hxz, Hzz) of cascade c at rest point xz and mip `lod` (water/hessian.ts). */
function cascadeHessian(hess: unknown, xz: TSLNode, c: number, lod: TSLNode) {
  return texture(hess, cascadeUV(xz, c)).level(lod).depth(c).xyz;
}

/** det(I + D·M·H) for H = (Hxx, Hxz, Hzz). */
function detJ(M: TSLNode, H: TSLNode, D: TSLNode) {
  const j00 = float(1).add(D.mul(M.x.mul(H.x).add(M.y.mul(H.y))));
  const j01 = D.mul(M.x.mul(H.y).add(M.y.mul(H.z)));
  const j10 = D.mul(M.z.mul(H.x).add(M.w.mul(H.y)));
  const j11 = float(1).add(D.mul(M.z.mul(H.y).add(M.w.mul(H.z))));
  return j00.mul(j11).sub(j01.mul(j10));
}

/** 1 outside the pier deck's shadow at sea level point xz (the deck is nearly solid at an 11° sun). */
export function pierDeckLit(xz: TSLNode, sunDir: TSLNode) {
  const h = PIER.deckHeight - 0.12;
  const p = xz.add(vec2(sunDir.x, sunDir.z).mul(float(h).div(max(sunDir.y, 0.05))));
  const inX = smoothstep(PIER.tipX - 0.3, PIER.tipX + 0.3, p.x).mul(float(1).sub(smoothstep(PIER.rootX - 0.3, PIER.rootX + 0.3, p.x)));
  const inZ = float(1).sub(smoothstep(PIER.width / 2 - 0.12, PIER.width / 2 + 0.12, abs(p.y.sub(PIER.z))));
  return float(1).sub(inX.mul(inZ));
}

/**
 * The beach's seabed caustics hook: (worldPos, normal, albedo) → extra radiance. Returns the
 * modulation of the direct sun the seabed already receives, so its mean is ~0.
 */
export function createSeabedCaustics(src: CausticSources) {
  return (worldPos: TSLNode, normal: TSLNode, albedo: TSLNode): TSLNode =>
    Fn(() => {
      const out = vec3(0).toVar();
      const D = max(worldPos.y.negate(), 0).toVar();
      const dist = length(cameraPosition.sub(worldPos));
      If(D.greaterThan(0.02).and(D.lessThan(src.uMaxDepth)).and(dist.lessThan(180)).and(src.uStrength.greaterThan(0)), () => {
        const run = vec2(src.uRun.x, src.uRun.y);
        const xs = worldPos.xz.sub(run.mul(D)).toVar();
        // Blur: the sun disc and forward scattering widen the focus with depth; the pixel's own
        // footprint (a fraction of the distance) keeps far caustics from aliasing.
        const blur = max(D.mul(src.uBlur), dist.mul(0.0011)).toVar();
        const lodOf = (c: number) => clamp(log2(blur.div(CASCADES[c].L / FFT_N)), 0, HESSIAN_MAX_LOD);
        const H = cascadeHessian(src.hess, xs, 1, lodOf(1)).mul(depthFade(D, 1)).toVar();
        H.addAssign(cascadeHessian(src.hess, xs, 2, lodOf(2)).mul(depthFade(D, 2)));
        // capillaries only focus in the shallowest water
        If(D.lessThan(0.9), () => {
          H.addAssign(cascadeHessian(src.hess, xs, 3, lodOf(3)).mul(depthFade(D, 3)).mul(float(1).sub(smoothstep(0.2, 0.9, D)).mul(0.6)));
        });
        const det = detJ(src.uM, H, D);
        // Focus is a line; give it a width that grows with blur so it anti-aliases.
        const eps = float(0.06).add(blur.mul(1.5));
        const I = float(1).div(max(abs(det), eps));
        const m = min(I, 5).sub(1).mul(src.uStrength).toVar();
        const fade = smoothstep(0.02, 0.35, D).mul(exp(D.mul(-0.09))).mul(float(1).sub(smoothstep(110, 180, dist)));
        const lit = pierDeckLit(xs, src.sunDir);
        const NdL = max(normal.dot(src.sunDir), 0);
        out.assign(vec3(albedo).mul(vec3(src.sunColor)).mul(NdL.mul(1 / Math.PI)).mul(max(m, -0.75)).mul(fade).mul(lit));
      });
      return out;
    })();
}

/**
 * The pier's underside hook: (water point under the reflected sun ray) → pattern with mean ~1.
 * The reflected run is long (the sun is 11° up), so only metre-scale waves focus coherently.
 */
export function createPierCaustics(src: CausticSources) {
  return (worldPos: TSLNode): TSLNode =>
    Fn(() => {
      const xz = vec2(worldPos.x, worldPos.z).toVar();
      const h = float(3.2);
      const H = vec3(0).toVar();
      H.addAssign(cascadeHessian(src.hess, xz, 0, float(3.2)));
      H.addAssign(cascadeHessian(src.hess, xz, 1, float(2.2)).mul(0.9));
      H.addAssign(cascadeHessian(src.hess, xz, 2, float(3.5)).mul(0.5));
      const det = detJ(src.uMR, H, h);
      const I = float(1).div(max(abs(det), 0.22));
      return clamp(I.mul(0.8).add(0.2), 0.15, 3.5).sub(1).mul(src.uPierStrength).add(1);
    })();
}

