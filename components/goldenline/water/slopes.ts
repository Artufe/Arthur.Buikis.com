// Fragment-stage surface slopes for the water material. Mirrors ocean/surface.ts derivatives(),
// but with per-cascade weights (wind slicks damp the short cascades), a flow-advected capillary
// cascade (two-phase flow map, variance-preserving blend), and the slope variance the mip chain
// filtered away at this pixel (for the glitter roughness, see variance.ts).

import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { CASCADES, FFT_DEPTH_FADE, FFT_N, N_CASCADES } from '../ocean/spectrum';
import { VAR_LEVELS } from './variance';

const { If, abs, dFdx, dFdy, float, floor, fract, length, log2, max, min, mix, normalize, smoothstep, sqrt, texture, vec2, vec3, vec4, int, clamp } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

export interface SlopeSources {
  disp: unknown;
  deriv: unknown;
  /** uniformArray of VAR_LEVELS vec4 (cascades in xyzw): lost slope variance per mip level. */
  varTable: TSLNode;
}

export interface SlopeOptions {
  rest: TSLNode;
  depth: TSLNode;
  /** Swell (+hook) derivatives: vSwellD and vSwellX.x. */
  swellDD: TSLNode;
  swellDXZ: TSLNode;
  fftGain: TSLNode;
  /** Per-cascade weights (e.g. slicks). */
  weights: [TSLNode, TSLNode, TSLNode, TSLNode];
  /** Flow of the capillary cascade (m/s, world XZ) and the flow-map clock (s). */
  flow: TSLNode;
  time: TSLNode;
  flowPeriod: number;
  /** 0-1 weight of the capillary cascade (1 near the camera, 0 beyond ~30 m: skipped). */
  near: TSLNode;
}

export interface Slopes {
  /** All cascades: (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z) and ∂Dx/∂z. */
  dd: TSLNode;
  dxz: TSLNode;
  /** Swell + the two long cascades only (macro shape: refraction, thickness, Jacobian foam). */
  ddMacro: TSLNode;
  dxzMacro: TSLNode;
  /** Swell + cascades 0-2 (no capillaries): whitecap Jacobian. */
  ddChop: TSLNode;
  dxzChop: TSLNode;
  /** Slope variance (sx² + sz²) filtered away inside this pixel, all cascades. */
  lostVar: TSLNode;
  /** Height of the metre-scale chop (cascades 1-2) at this pixel (m), for crest thickness. */
  chopH: TSLNode;
}

const rotFwd = (v: TSLNode, c: number) => {
  const cr = Math.cos(CASCADES[c].rot);
  const sr = Math.sin(CASCADES[c].rot);
  return vec2(v.x.mul(cr).add(v.y.mul(sr)), v.y.mul(cr).sub(v.x.mul(sr)));
};
export const cascadeUV = (xz: TSLNode, c: number) => rotFwd(xz, c).div(CASCADES[c].L).add(0.5 / FFT_N);
export const depthFade = (depth: TSLNode, c: number) => smoothstep(FFT_DEPTH_FADE[c][0], FFT_DEPTH_FADE[c][1], depth);

/** World-frame derivative terms of one cascade sample (t = deriv texel, dx = disp.w). */
function worldTerms(t: TSLNode, dx: TSLNode, c: number) {
  const cr = Math.cos(CASCADES[c].rot);
  const sr = Math.sin(CASCADES[c].rot);
  const sx = t.x.mul(cr).sub(t.y.mul(sr));
  const sz = t.x.mul(sr).add(t.y.mul(cr));
  const a = t.z;
  const d2 = t.w;
  const cs = cr * sr;
  const jxx = a.mul(cr * cr).sub(dx.mul(2 * cs)).add(d2.mul(sr * sr));
  const jzz = a.mul(sr * sr).add(dx.mul(2 * cs)).add(d2.mul(cr * cr));
  const jxz = a.mul(cs).add(dx.mul(cr * cr - sr * sr)).sub(d2.mul(cs));
  return { dd: vec4(sx, sz, jxx, jzz), dxz: jxz };
}

/** Linear lookup in the lost-variance table at a fractional mip level. */
function lostAt(tab: TSLNode, lod: TSLNode, c: number) {
  const l = clamp(lod, 0, VAR_LEVELS - 1.001).toVar();
  const i = int(floor(l));
  const f = fract(l);
  const comp = (v: TSLNode) => (c === 0 ? v.x : c === 1 ? v.y : c === 2 ? v.z : v.w);
  return mix(comp(tab.element(i)), comp(tab.element(i.add(1))), f);
}

export function surfaceSlopes(src: SlopeSources, o: SlopeOptions): Slopes {
  const rest = o.rest;
  const dd = o.swellDD.toVar();
  const dxz = o.swellDXZ.toVar();
  const ddMacro = vec4(0).toVar();
  const dxzMacro = float(0).toVar();
  const ddChop = vec4(0).toVar();
  const dxzChop = float(0).toVar();
  const lost = float(0).toVar();
  const chopH = float(0).toVar();

  // Pixel footprint on the rest plane (m), major and minor axis; the samplers are 8× anisotropic.
  const fx = length(dFdx(rest));
  const fy = length(dFdy(rest));
  const fMaj = max(max(fx, fy), 1e-6).toVar();
  const fMin = max(min(fx, fy), fMaj.div(8)).toVar();

  for (let c = 0; c < N_CASCADES; c++) {
    const f = depthFade(o.depth, c).mul(o.fftGain).mul(o.weights[c]).toVar();
    let terms: { dd: TSLNode; dxz: TSLNode };
    if (c < N_CASCADES - 1) {
      const uv = cascadeUV(rest, c);
      const t = texture(src.deriv, uv).depth(c);
      const dsp = texture(src.disp, uv).depth(c).toVar();
      terms = worldTerms(t, dsp.w, c);
      if (c === 1 || c === 2) chopH.addAssign(dsp.y.mul(depthFade(o.depth, c)).mul(o.fftGain));
    } else {
      // Capillaries ride the local flow (drift, wakes): two phases half a period apart, blended
      // with weights normalised so the slope variance doesn't pulse. Only near the camera (beyond
      // ~30 m their slopes are fully filtered into lostVar): gradient samples inside a branch.
      const cDD = vec4(0).toVar();
      const guvx = dFdx(cascadeUV(rest, c)).toVar();
      const guvy = dFdy(cascadeUV(rest, c)).toVar();
      If(o.near.greaterThan(0.001), () => {
        const T = o.flowPeriod;
        const pa = fract(o.time.div(T)).toVar();
        const pb = fract(o.time.div(T).add(0.5)).toVar();
        const wa = float(1).sub(abs(pa.mul(2).sub(1))).toVar();
        const wb = float(1).sub(wa);
        const norm = float(1).div(sqrt(wa.mul(wa).add(wb.mul(wb))));
        const uva = cascadeUV(rest.sub(o.flow.mul(pa.sub(0.5).mul(T))), c);
        const uvb = cascadeUV(rest.sub(o.flow.mul(pb.sub(0.5).mul(T))), c);
        const ta = texture(src.deriv, uva).grad(guvx, guvy).depth(c);
        const tb = texture(src.deriv, uvb).grad(guvx, guvy).depth(c);
        cDD.assign(worldTerms(ta.mul(wa).add(tb.mul(wb)).mul(norm), float(0), c).dd.mul(o.near));
      });
      terms = { dd: cDD, dxz: float(0) };
    }
    dd.addAssign(terms.dd.mul(f));
    dxz.addAssign(terms.dxz.mul(f));
    if (c < 2) {
      ddMacro.addAssign(terms.dd.mul(f));
      dxzMacro.addAssign(terms.dxz.mul(f));
    }
    if (c < 3) {
      ddChop.addAssign(terms.dd.mul(f));
      dxzChop.addAssign(terms.dxz.mul(f));
    }
    const texel = CASCADES[c].L / FFT_N;
    const lMaj = log2(fMaj.div(texel));
    const lMin = log2(fMin.div(texel));
    const v = lostAt(src.varTable, lMaj, c).add(lostAt(src.varTable, lMin, c)).mul(0.5);
    lost.addAssign(v.mul(f).mul(f));
  }
  return {
    dd,
    dxz,
    ddMacro: ddMacro.add(o.swellDD),
    dxzMacro: dxzMacro.add(o.swellDXZ),
    ddChop: ddChop.add(o.swellDD),
    dxzChop: dxzChop.add(o.swellDXZ),
    lostVar: lost,
    chopH,
  };
}

/** World normal from the derivative terms (same construction as ocean/surface.ts). */
export function normalFromDD(dd: TSLNode, dxz: TSLNode) {
  const jx = dd.z.add(1);
  const jz = dd.w.add(1);
  const J = jx.mul(jz).sub(dxz.mul(dxz));
  return normalize(vec3(dd.y.mul(dxz).sub(jz.mul(dd.x)), max(J, 0.05), dxz.mul(dd.x).sub(dd.y.mul(jx))));
}

export function jacobianFromDD(dd: TSLNode, dxz: TSLNode) {
  return dd.z.add(1).mul(dd.w.add(1)).sub(dxz.mul(dxz));
}
