// GPU side of the atmosphere: the sky-view LUT lookup with per-pixel phase functions, the sun
// disc with limb darkening, and the shared uniforms every other atmosphere node reads.

import { ClampToEdgeWrapping, Color, DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat, Vector3 } from 'three/webgpu';
import { abs, acos, asin, atan, clamp, dot, float, fwidth, max, mix, pow, select, sign, smoothstep, sqrt, texture, uniform, vec2, vec3 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { AtmosphereModel, SKY_H, SKY_W } from './model';

const INV_PI = 1 / Math.PI;

export const phaseRayleigh = (c: TSLNode): TSLNode => c.mul(c).add(1).mul(3 / (16 * Math.PI));

export const phaseHG = (c: TSLNode, g: TSLNode | number): TSLNode => {
  const gg = float(g);
  const g2 = gg.mul(gg);
  const denom = g2.add(1).sub(gg.mul(c).mul(2)).max(1e-4);
  return g2.oneMinus().div(denom.mul(sqrt(denom)).mul(4 * Math.PI));
};

function halfData(src: Float32Array) {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = DataUtils.toHalfFloat(src[i]);
  return out;
}

function lutTexture(src: Float32Array, w: number, h: number) {
  const t = new DataTexture(halfData(src), w, h, RGBAFormat, HalfFloatType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export class SkyGPU {
  readonly model = new AtmosphereModel();
  readonly sunDir = uniform(new Vector3(0, 1, 0));
  /** Top-of-atmosphere solar irradiance (scene units). */
  readonly sunE = uniform(20);
  /** Sun irradiance at sea level (sunE x transmittance). */
  readonly sunColor = uniform(new Color(1, 0.7, 0.4));
  /** Sea-level sun transmittance and multiple-scattering source (per unit sunE). */
  readonly sunT0 = uniform(new Vector3(0.6, 0.4, 0.2));
  readonly ms0 = uniform(new Vector3(0.016, 0.017, 0.021));
  readonly mieG = uniform(0.88);
  readonly mieSharp = uniform(0.04);
  readonly sunDiscScale = uniform(15);
  readonly sunSize = uniform(1);
  readonly skyScale = uniform(1);
  texR: DataTexture;
  texM: DataTexture;
  texMS: DataTexture;

  constructor() {
    const empty = new Float32Array(SKY_W * SKY_H * 4);
    this.texR = lutTexture(empty, SKY_W, SKY_H);
    this.texM = lutTexture(empty, SKY_W, SKY_H);
    this.texMS = lutTexture(empty, SKY_W, SKY_H);
  }

  /** Upload the model's sky-view LUTs (after bakeSkyView). Reuses the textures. */
  uploadSkyView() {
    this.upload(this.texR, this.model.skyR);
    this.upload(this.texM, this.model.skyM);
    this.upload(this.texMS, this.model.skyMS);
  }

  private upload(t: DataTexture, src: Float32Array) {
    const dst = t.image.data as Uint16Array;
    for (let i = 0; i < src.length; i++) dst[i] = DataUtils.toHalfFloat(src[i]);
    t.needsUpdate = true;
  }

  phaseMie(c: TSLNode): TSLNode {
    return mix(phaseHG(c, this.mieG), phaseHG(c, 0.965), this.mieSharp);
  }

  /** Sky-view LUT uv for a world direction. Matches model.ts: u = sqrt(dAz/pi), v = 0.5 + 0.5 sign(l) sqrt(|l|/(pi/2)). */
  skyUV(dir: TSLNode): TSLNode {
    const sd = this.sunDir;
    const sunAz = atan(sd.z, sd.x);
    const az = atan(dir.z, dir.x);
    let d = abs(az.sub(sunAz));
    d = select(d.greaterThan(Math.PI), float(2 * Math.PI).sub(d), d);
    const u = sqrt(d.mul(INV_PI).clamp(0, 1));
    const lat = asin(clamp(dir.y, -1, 1));
    const v = sign(lat).mul(sqrt(abs(lat).mul(2 * INV_PI))).mul(0.5).add(0.5);
    // half-texel inset so the sqrt mapping lands on texel centres at the ends
    return vec2(u.mul((SKY_W - 1) / SKY_W).add(0.5 / SKY_W), v.mul((SKY_H - 1) / SKY_H).add(0.5 / SKY_H));
  }

  /** Atmospheric radiance along `dir` (no sun disc, no clouds). */
  atmosphere(dir: TSLNode, circumsolar: TSLNode | number = 1): TSLNode {
    const uvN = this.skyUV(dir);
    const r = texture(this.texR, uvN).rgb;
    const m = texture(this.texM, uvN).rgb;
    const s = texture(this.texMS, uvN).rgb;
    const c = dot(dir, this.sunDir);
    let pm: TSLNode = this.phaseMie(c);
    if (circumsolar !== 1) {
      // Scale the aureole within ~25 deg of the sun. Used by the IBL bake: anything that shadows
      // the sun also shadows its aureole, so cast shadows must not be lit by it.
      pm = pm.mul(mix(float(1), float(circumsolar), smoothstep(0.9, 0.995, c)));
    }
    return r.mul(phaseRayleigh(c)).add(m.mul(pm)).add(s).mul(this.sunE.mul(this.skyScale));
  }

  /**
   * The solar disc: 0.2666 deg radius, limb-darkened per channel (Neckel & Labs power law),
   * reddened by the same transmittance as the sun light, anti-aliased over one pixel.
   */
  sunDisc(dir: TSLNode): TSLNode {
    const radius = this.sunSize.mul(0.004654);
    const cosA = dot(dir, this.sunDir).clamp(-1, 1);
    const ang = acos(cosA);
    const r = ang.div(radius);
    const aa = max(fwidth(r), 1e-3);
    const edge = smoothstep(float(1).add(aa), float(1).sub(aa), r);
    const mu = sqrt(max(float(1).sub(r.mul(r)), 0.0));
    const limb = pow(vec3(mu, mu, mu).max(1e-3), vec3(0.397, 0.503, 0.652));
    // sunColor is irradiance; the disc radiance is scaled to an artist-controlled level so the
    // centre reads white-hot while the reddened limb still shows (a physical 1e5 would only clip).
    return (this.sunColor as TSLNode).mul(limb).mul(edge).mul(this.sunDiscScale.mul(9));
  }
}

