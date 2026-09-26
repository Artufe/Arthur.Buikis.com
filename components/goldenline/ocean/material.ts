// Placeholder water material: normals, Fresnel sky reflection, a sun lobe and a flat absorption
// colour. Just honest enough to judge the waveform; the water agent replaces it (water/).

import { DoubleSide, MeshBasicNodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { AtmosphereService, TSLNode } from '../core/contracts';
import type { OceanSurface } from './surface';

const { Fn, abs, cameraPosition, dot, exp, float, max, mix, normalize, pow, positionWorld, reflect, uniform, vec3, length, smoothstep, clamp } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode> & { cameraPosition: TSLNode; positionWorld: TSLNode };

export interface PlaceholderWater {
  material: MeshBasicNodeMaterial;
  uSun: TSLNode;
  /** Debug: 0 = shaded, 1 = normals, 2 = brokenness/depth. */
  uView: TSLNode;
  uDbgGain: TSLNode;
}

export function createPlaceholderWater(surface: OceanSurface, atmos: AtmosphereService): PlaceholderWater {
  const mat = new MeshBasicNodeMaterial();
  mat.name = 'ocean.placeholder';
  mat.side = DoubleSide;
  mat.fog = false;
  mat.positionNode = surface.positionNode;
  const uSun = uniform(3);
  const uView = uniform(0);
  // Debug colours are scaled to land mid-range after the physically calibrated exposure.
  const uDbgGain = uniform(0.12);

  mat.colorNode = Fn(() => {
    const P = positionWorld;
    const toCam = cameraPosition.sub(P);
    const dist = length(toCam);
    const V = toCam.div(dist);
    const n0 = surface.normal().toVar();
    // Seen from under a folded crest: flip toward the viewer.
    const N = dot(n0, V).lessThan(0).select(n0.negate(), n0).toVar();
    const NdV = max(abs(dot(N, V)), 1e-3);
    const R = reflect(V.negate(), N).toVar();
    R.y.assign(abs(R.y));
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdV), 5))).toVar();
    const sky = atmos.skyRadiance(R);
    const L = atmos.sunDirNode;
    const H = normalize(L.add(V));
    const NdH = max(dot(N, H), 0);
    // Roughness grows with distance (the filtered-away normal detail).
    const rough = clamp(float(0.022).add(dist.mul(0.0004)), 0.022, 0.3);
    const a2 = rough.mul(rough).mul(rough).mul(rough);
    const dd = NdH.mul(NdH).mul(a2.sub(1)).add(1);
    const D = a2.div(dd.mul(dd).mul(Math.PI));
    const NdL = max(dot(N, L), 0);
    const spec = atmos.sunColorNode.mul(uSun).mul(D).mul(F).mul(NdL).div(max(NdV.mul(4), 0.1)).min(vec3(40, 40, 40));
    const depth = surface.vSwellX.z;
    const shallow = exp(depth.mul(-0.35));
    // Faces tilted toward the low sun transmit more light (a crude stand-in for SSS, so the
    // waveform reads in the placeholder).
    const Lh = normalize(vec3(L.x, 0, L.z));
    const tilt = max(dot(N, Lh), 0);
    const trans = float(0.35).add(tilt.mul(9));
    const body = mix(vec3(0.004, 0.024, 0.036), vec3(0.02, 0.1, 0.09), shallow).mul(atmos.sunColorNode.mul(0.06).mul(trans).add(0.05));
    const lit = mix(body, sky, F).add(spec);
    const shaded = atmos.applyFog(lit, P);
    // Debug views: 1 normals, 2 brokenness/depth, 3 surface height (±1.5 m), 4 slope, 6 mip check.
    const nv = N.mul(0.5).add(0.5);
    const dbg = vec3(surface.vSwellX.y, smoothstep(0, 12, depth), 0);
    const hgt = vec3(P.y.div(3).add(0.5));
    const slope = vec3(N.x.mul(4).add(0.5), N.y, N.z.mul(4).add(0.5));
    let out = mix(shaded, nv.mul(uDbgGain), uView.equal(1).select(1, 0));
    out = mix(out, dbg.mul(uDbgGain), uView.equal(2).select(1, 0));
    out = mix(out, hgt.mul(uDbgGain), uView.equal(3).select(1, 0));
    out = mix(out, slope.mul(uDbgGain), uView.equal(4).select(1, 0));
    // 6: cascade 1 slope sampled at an explicit coarse mip (checks mip generation).
    const mipT = surface.debugMip(3, 0);
    return mix(out, vec3(mipT.x.mul(4).add(0.5), mipT.y.mul(4).add(0.5), 0.5).mul(uDbgGain), uView.equal(6).select(1, 0));
  })();
  return { material: mat, uSun, uView, uDbgGain };
}
