// Golden-hour clouds, two techniques chosen for what each layer looks like from the beach:
//
// - Cirrus (8 km): a curved 2D shell (clouds converge toward the horizon as they should), fibrous
//   domain-warped fbm stretched ~2.5:1 along the upper wind, patchy macro coverage, lit by the sun
//   transmittance at 8 km (warmed by an artist exponent) with an ice-crystal forward lobe.
// - A distant cumulus bank (40-150 km away): at that range perspective across a cloud is
//   negligible, so it is modelled in (azimuth, elevation) space: a cluster profile gives the
//   skyline, billow noise gives puffy tops, flat bases sit in the horizon haze. That gives the bank
//   real vertical extent, which a 2D shell seen edge-on cannot. Lit from the top by the low sun:
//   backlit bodies go dusky blue-grey with gold rims toward the sun, front-lit tops go peach/pink
//   away from it.
//
// Both fade their octaves by pixel footprint and sit behind the aerial perspective of the path.

import { Vector2, Vector3 } from 'three/webgpu';
import { atan, cos, exp, float, max, mix, mx_noise_float, normalize, pow, sin, smoothstep, sqrt, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { R_GROUND } from './model';
import { SkyGPU, phaseHG } from './sky';

const R0 = R_GROUND + 0.002;
const DEG = 180 / Math.PI;

/** Distance (km) from the camera to a spherical shell at altitude h (km), for a unit dir. */
function shellDistance(mu: TSLNode, h: number): TSLNode {
  const rc = R_GROUND + h;
  return sqrt(mu.mul(mu).mul(R0 * R0).add(rc * rc - R0 * R0)).sub(mu.mul(R0));
}

/** Footprint-faded fbm of Perlin noise (2D or 3D input), octaves unrolled. Roughly [-1, 1]. */
function fbm(p: TSLNode, octaves: number, footprint: TSLNode, gain = 0.5, lac = 2.03, is3 = false): TSLNode {
  let sum: TSLNode = float(0);
  let amp = 1;
  let f = 1;
  let q = p;
  for (let i = 0; i < octaves; i++) {
    const w = smoothstep(0.6, 0.15, footprint.mul(f));
    sum = sum.add(mx_noise_float(q.mul(f)).mul(amp).mul(w));
    amp *= gain;
    f *= lac;
    q = is3
      ? vec3(q.x.mul(0.8).sub(q.y.mul(0.6)), q.x.mul(0.6).add(q.y.mul(0.8)), q.z).add(vec3(1.7, 9.2, 4.1))
      : vec2(q.x.mul(0.8).sub(q.y.mul(0.6)), q.x.mul(0.6).add(q.y.mul(0.8))).add(vec2(1.7, 9.2));
  }
  return sum;
}

export class Clouds {
  readonly time = uniform(0);
  readonly bankCover = uniform(0.55);
  readonly bankHeight = uniform(5.5); // degrees above the horizon at the tallest towers
  readonly cirrusCover = uniform(0.5);
  readonly cirrusDensity = uniform(0.9);
  /** Sun irradiance at the two layer altitudes, with the warmth exponent applied (CPU). */
  readonly sunLow = uniform(new Vector3(1, 0.8, 0.5));
  readonly sunHigh = uniform(new Vector3(1, 0.85, 0.6));
  /** Vertical extinction optical depth from the ground to each layer (CPU, per channel). */
  readonly tauLow = uniform(new Vector3(0.1, 0.12, 0.15));
  readonly tauHigh = uniform(new Vector3(0.2, 0.3, 0.5));
  readonly wind = uniform(new Vector2(-0.006, -0.0022));
  readonly enabled = uniform(1);

  constructor(private readonly sky: SkyGPU) {}

  /**
   * Composite clouds over `skyColor` (radiance behind them) for world direction `dir`.
   * `pixelAngle` is the angular pixel size in radians (bigger for the low-res panorama).
   * Returns vec4(rgb, cloud alpha).
   */
  apply(dir: TSLNode, skyColor: TSLNode, pixelAngle: number): TSLNode {
    const sky = this.sky;
    const mu = dir.y.max(0.0);
    const c = vec3(dir).dot(sky.sunDir);
    const on = this.enabled;
    const elevDeg = dir.y.clamp(-1, 1).asin().mul(DEG);
    const airMass = float(1).div(mu.add(pow(elevDeg.max(0).add(6.07995), -1.6364).mul(0.50572)));
    const zenith = sky.atmosphere(vec3(0, 1, 0));
    const ambientTop = zenith.mul(2.2);

    // ── cirrus, 8 km shell ──
    const dH = shellDistance(mu, 8);
    const pH = vec2(dir.x, dir.z).mul(dH).add(vec2(-0.0027, -0.0059).mul(this.time).mul(1.6));
    const fpH = dH.mul(pixelAngle).div(mu.max(0.02));
    // upper-wind axis ~60 deg off the sun line, so the streaks' vanishing point isn't the sun
    const sx = pH.dot(vec2(0.42, 0.91));
    const sy = pH.dot(vec2(-0.91, 0.42));
    // ~2:1 along the upper wind; two warps bend the streaks into hooks and curls (cirrus uncinus)
    const st = vec2(sx.mul(0.055), sy.mul(0.11));
    const w1 = vec2(mx_noise_float(st.mul(0.3)), mx_noise_float(st.mul(0.3).add(vec2(5.2, 1.3)))).mul(1.0);
    const q1 = st.add(w1);
    const w2 = vec2(mx_noise_float(q1.mul(1.1).add(vec2(2.7, 8.1))), mx_noise_float(q1.mul(1.1).add(vec2(9.4, 3.3)))).mul(0.35);
    const q = q1.add(w2);
    const nH = fbm(q, 5, fpH.mul(0.15), 0.55);
    // fibres: fine striations along the warped flow
    const fib = mx_noise_float(vec2(q.x.mul(2.2), q.y.mul(11))).mul(0.5).add(0.5);
    const fibW = smoothstep(0.6, 0.15, fpH.mul(1.6));
    const macro = mx_noise_float(pH.mul(0.008).add(vec2(3.1, 7.7))).mul(0.5).add(0.5);
    const macroMask = smoothstep(0.28, 0.72, macro);
    const densH = nH
      .mul(0.5)
      .add(0.5)
      .sub(this.cirrusCover.oneMinus())
      .max(0)
      .mul(2.8)
      .mul(macroMask)
      .mul(mix(float(1), fib.mul(0.9).add(0.35), fibW))
      .pow(1.2);
    const horizonH = smoothstep(0.02, 0.12, dir.y);
    const alphaH = float(1).sub(exp(densH.mul(this.cirrusDensity).negate())).mul(horizonH).mul(on);
    const phaseIce = phaseHG(c, 0.75).mul(0.8).add(phaseHG(c, -0.1).mul(0.2));
    const lightH = vec3(this.sunHigh).mul(phaseIce.mul(2.6).add(0.05)).add(ambientTop.mul(0.45));
    const tH = exp(vec3(this.tauHigh).mul(airMass).negate());

    // ── distant cumulus bank, angular space ──
    const az = atan(dir.z, dir.x);
    const ring = vec2(cos(az), sin(az));
    // cluster profile along the horizon: where towers stand and how tall they get (degrees)
    const clusterN = mx_noise_float(vec3(ring.mul(2.2), 3.7)).mul(0.5).add(0.5);
    const cluster = smoothstep(this.bankCover.oneMinus(), this.bankCover.oneMinus().add(0.28), clusterN);
    // towers: two octaves so heights vary from low shelves to the odd tall cumulus congestus
    const towerN = mx_noise_float(vec3(ring.mul(7.0), 11.3)).mul(0.65).add(mx_noise_float(vec3(ring.mul(23.0), 4.1)).mul(0.35)).mul(0.5).add(0.5);
    const top = cluster.mul(pow(towerN, 1.6).mul(0.85).add(0.15)).mul(this.bankHeight).add(cluster.mul(0.3));
    // billows: 3D noise on (azimuth ring, elevation) so the pattern has no seam
    const fpB = float(pixelAngle * DEG);
    const bp = vec3(ring.mul(55), elevDeg.mul(0.8)).add(vec3(this.time.mul(0.002), 0, 0));
    const billow = fbm(bp, 5, fpB.mul(0.8), 0.52, 2.1, true);
    const rel = elevDeg.div(top.max(0.05)); // 0 at the base, 1 at the tower top
    const edge = float(1).sub(rel).add(billow.mul(0.5)).sub(0.1);
    // bases dissolve into the horizon haze instead of sitting on it like a sticker
    const baseFade = smoothstep(-0.05, 0.9, elevDeg);
    const densB = smoothstep(0.0, 0.3, edge).mul(cluster).mul(baseFade);
    // light: sunlit tops, cauliflower relief from the billow gradient, blue-grey bases;
    // toward the sun the thin crowns glow gold
    const heightLit = smoothstep(0.05, 1.0, rel.add(billow.mul(0.35))).pow(1.3);
    const rim = smoothstep(0.3, 0.02, edge).mul(densB);
    const phaseC = phaseHG(c, 0.7).mul(0.75).add(phaseHG(c, -0.25).mul(0.25));
    const sunB = vec3(this.sunLow).mul(phaseC.mul(heightLit.mul(0.9).add(rim.mul(3.0))).mul(3.0).add(heightLit.mul(0.045)));
    const horizonSky = sky.atmosphere(normalize(vec3(dir.x, 0.02, dir.z)));
    const shade = mix(horizonSky.mul(0.32), ambientTop.mul(0.28), 0.5);
    const lightB = sunB.add(shade);
    // bank distance ~ 60 km: most of its path lies in the marine layer, so it hazes strongly
    const tB = exp(vec3(this.tauLow).mul(airMass).mul(0.9).negate()).mul(0.8).add(0.1);
    const alphaB = densB.mul(on);

    const aH = alphaH.mul(tH.x.add(tH.y).add(tH.z).div(3));
    let col: TSLNode = vec3(skyColor).mul(aH.oneMinus()).add(lightH.mul(tH).mul(alphaH));
    const hazeB = mix(vec3(lightB), horizonSky, tB.oneMinus());
    col = mix(col, hazeB, alphaB);
    return vec4(col, max(alphaB, aH));
  }
}

