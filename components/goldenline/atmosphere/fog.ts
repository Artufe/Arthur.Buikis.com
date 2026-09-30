// Aerial perspective for scene geometry. Near the ground the medium is three exponential
// layers (air, background aerosol, marine haze), so optical depth along camera -> point has a
// closed form, and in-scatter follows from the per-layer source terms (phase x sea-level sun
// transmittance + the multiple-scattering source from the LUT bake):
//   L = sum_i(tau_i * src_i) / tau * (1 - exp(-tau)),  result = color * exp(-tau) + L
// That is exact for a single layer and very close for three, per channel, with no ray march.
// The same medium feeds the sky LUT, so distant geometry converges on the horizon sky colour.

import { Vector3 } from 'three/webgpu';
import { Fn, abs, cameraPosition, dot, exp, float, max, select, uniform, vec3 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { SkyGPU, phaseRayleigh } from './sky';

export class Fog {
  /** Sea-level extinction (/m) per layer. */
  readonly extR = uniform(new Vector3());
  readonly extM = uniform(new Vector3());
  readonly extH = uniform(new Vector3());
  /** Single-scattering albedo per layer (per channel for the haze). */
  readonly albM = uniform(0.9);
  readonly albH = uniform(new Vector3(0.96, 0.96, 0.96));
  /** Scale heights (m). */
  readonly hR = uniform(8000);
  readonly hM = uniform(1200);
  readonly hH = uniform(500);
  /** Multiplies optical depth (the scene is small; real air at 2 km barely shows). */
  readonly aerialScale = uniform(1);
  /** Extra in-scatter toward the sun (artist), 1 = physical. */
  readonly sunGlow = uniform(1);
  readonly enabled = uniform(1);

  readonly apply: (color: TSLNode, worldPos: TSLNode) => TSLNode;

  constructor(sky: SkyGPU) {
    const layerLength = (d: TSLNode, hc: TSLNode, dy: TSLNode, H: TSLNode) => {
      // integral of exp(-h/H) along the segment, h = hc + s*dy, s in [0, d]
      const x = d.mul(dy).div(H);
      const f = select(abs(x).lessThan(1e-3), float(1).sub(x.mul(0.5)), float(1).sub(exp(x.negate())).div(x));
      return d.mul(exp(hc.negate().div(H))).mul(f);
    };
    const fn = Fn(([color, worldPos]: [TSLNode, TSLNode]) => {
      const v = vec3(worldPos).sub(cameraPosition);
      const d = v.length().max(1e-3);
      const dir = v.div(d);
      const hc = max(cameraPosition.y, 0);
      const k = this.aerialScale.mul(this.enabled);
      const lR = layerLength(d, hc, dir.y, this.hR).mul(k);
      const lM = layerLength(d, hc, dir.y, this.hM).mul(k);
      const lH = layerLength(d, hc, dir.y, this.hH).mul(k);
      const tauR = vec3(this.extR).mul(lR);
      const tauM = vec3(this.extM).mul(lM);
      const tauH = vec3(this.extH).mul(lH);
      const tau = tauR.add(tauM).add(tauH);
      const T = exp(tau.negate());
      const c = dot(dir, sky.sunDir);
      const sunT = vec3(sky.sunT0);
      const ms = vec3(sky.ms0);
      const pM = sky.phaseMie(c).mul(this.sunGlow);
      const srcR = sunT.mul(phaseRayleigh(c)).add(ms);
      const srcM = sunT.mul(pM).add(ms).mul(this.albM);
      const srcH = sunT.mul(pM).add(ms).mul(vec3(this.albH));
      const inscatter = tauR.mul(srcR).add(tauM.mul(srcM)).add(tauH.mul(srcH)).div(tau.max(1e-6)).mul(T.oneMinus());
      return vec3(color).mul(T).add(inscatter.mul(sky.sunE).mul(sky.skyScale));
    });
    this.apply = (color, worldPos) => fn(color, worldPos);
  }
}
