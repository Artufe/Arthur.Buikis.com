// The whitewater shell's material: an aerated, bubbly mass rather than a water surface.
//
// Stock PBR lighting (so the sun arrives with its cascaded shadow and the sky through the IBL),
// plus a forward-scattering translucency lobe: sunlight diffuses through the bubbles, so backlit
// whitewater glows, most at its thin, ragged edges. The vertex stage gives cauliflower billows
// (ribbon.ts); here a baked, tileable bubble-cluster height field (two scales, rolling with the
// flow) bumps the normal per pixel, crevices darken, and the edges dissolve (alpha-tested, TRAA
// smooths them) into the water material's own foam below.

import { BackSide, DataTexture, LinearFilter, LinearMipmapLinearFilter, MeshStandardNodeMaterial, PhysicalLightingModel, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { AtmosphereService, TSLNode } from '../../core/contracts';
import type { RibbonPart } from './ribbon';

const { Fn, abs, cross, dFdx, dFdy, dot, float, max, mix, normalize, pow, sign, smoothstep, texture, vec2, vec3, vec4, clamp } = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { cameraViewMatrix, positionViewDirection, positionWorld, diffuseColor } = TSL as unknown as Record<string, TSLNode>;

export interface WhitewaterUniforms {
  /** Albedo of the dense foam. */
  albedo: TSLNode;
  /** Strength of the forward-scattered (backlit) glow. */
  translucency: TSLNode;
  /** 0-1: how ragged the edges dissolve. */
  ragged: TSLNode;
  /** Sim time (s), for the rolling bubble texture. */
  time: TSLNode;
}

function hg(cosT: TSLNode, g: number) {
  const g2 = g * g;
  return float((1 - g2) / (4 * Math.PI)).div(pow(max(float(1 + g2).sub(cosT.mul(2 * g)), 1e-4), 1.5));
}

class WhitewaterLighting extends PhysicalLightingModel {
  constructor(private readonly trans: TSLNode, private readonly thin: TSLNode) {
    super();
  }

  direct(input: unknown, builder?: unknown) {
    (PhysicalLightingModel.prototype.direct as (i: unknown, b?: unknown) => void).call(this, input, builder);
    const { lightDirection, lightColor, reflectedLight } = input as { lightDirection: TSLNode; lightColor: TSLNode; reflectedLight: { directDiffuse: TSLNode } };
    // Light travelling along −L scattered toward the eye (positionViewDirection points to it).
    const cosT = dot(positionViewDirection, lightDirection.negate());
    const lobe = hg(cosT, 0.6).mul(0.8).add(0.06);
    // Multiple scattering inside the aerated mass carries some sunlight round to faces turned
    // away from it (foam is never black on its shadow side), plus the forward lobe through it.
    // [look] Aerated water is a strongly multiple-scattering volume: shading is soft, never dark.
    const wrap = float(0.32).div(Math.PI);
    reflectedLight.directDiffuse.addAssign(vec3(lightColor).mul(diffuseColor.rgb).mul(lobe.mul(this.trans).mul(this.thin).add(wrap)));
  }
}

class WhitewaterMaterial extends MeshStandardNodeMaterial {
  constructor(private readonly trans: TSLNode, private readonly thin: TSLNode) {
    super();
  }

  setupLightingModel() {
    return new WhitewaterLighting(this.trans, this.thin);
  }
}

/**
 * Tileable bubble-cluster heights, 256² (R = height, G = coarse cluster noise): a sum of
 * |value noise| octaves (billow noise: round bubbles, sharp creases) on a periodic lattice.
 */
export function bakeBubbleTexture(): DataTexture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const hash = (i: number, j: number, s: number) => {
    let h = Math.imul(i * 374761393 + j * 668265263 + s * 2246822519, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
  };
  const vn = (x: number, y: number, period: number, s: number) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const m = (k: number) => ((k % period) + period) % period;
    const a = hash(m(i), m(j), s);
    const b = hash(m(i + 1), m(j), s);
    const c = hash(m(i), m(j + 1), s);
    const d = hash(m(i + 1), m(j + 1), s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  let mn = 1e9;
  let mx = -1e9;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let f = 0;
      let amp = 1;
      let per = 8;
      for (let o = 0; o < 5; o++) {
        f += amp * Math.abs(vn((x / N) * per, (y / N) * per, per, 3 + o * 11));
        amp *= 0.55;
        per *= 2;
      }
      h[y * N + x] = f;
      mn = Math.min(mn, f);
      mx = Math.max(mx, f);
    }
  for (let q = 0; q < N * N; q++) {
    data[q * 4] = Math.round(((h[q] - mn) / (mx - mn)) * 255);
    data[q * 4 + 1] = Math.round((vn(((q % N) / N) * 4, (Math.floor(q / N) / N) * 4, 4, 91) * 0.5 + 0.5) * 255);
    data[q * 4 + 2] = 0;
    data[q * 4 + 3] = 255;
  }
  const t = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function createWhitewaterMaterial(part: RibbonPart, u: WhitewaterUniforms, bubbles: DataTexture, atmos?: AtmosphereService) {
  const v = part.v;
  const foam = v.vBillow.y;
  const billow = v.vBillow.x;
  // Bubble clusters in the ribbon's texture frame (moves with its water), two scales, the fine
  // one rolling faster; screen-space derivatives give the bump (surface-gradient method).
  const uvA = v.vRest.div(1.1).add(vec2(u.time.mul(0.11), 0));
  const uvB = v.vRest.div(0.37).add(vec2(u.time.mul(0.23), 0.37));
  const hA = texture(bubbles, uvA).x;
  const hB = texture(bubbles, uvB).x;
  // [look] A third, centimetre scale: individual bubble clusters, so it never reads as clay.
  const uvC = v.vRest.div(0.12).add(vec2(u.time.mul(0.41), 0.71));
  const hC = texture(bubbles, uvC).x;
  const hgt = hA.mul(0.09).add(hB.mul(0.035)).add(hC.mul(0.012)).toVar();
  const N0 = normalize(v.vN);
  const pW = positionWorld;
  const dpx = dFdx(pW);
  const dpy = dFdy(pW);
  const dhx = dFdx(hgt);
  const dhy = dFdy(hgt);
  const r1 = cross(dpy, N0);
  const r2 = cross(N0, dpx);
  const det = dot(dpx, r1);
  const grad = sign(det).mul(r1.mul(dhx).add(r2.mul(dhy)));
  const Nb = normalize(abs(det).mul(N0).sub(grad));
  // Thin where the density is low (edges, spray-torn tops): those glow most when backlit.
  const cluster = hA.mul(0.6).add(hB.mul(0.4));
  const thin = clamp(float(1.25).sub(foam), 0.35, 1).mul(smoothstep(0.1, 0.8, billow).mul(0.5).add(0.5));
  const mat = new WhitewaterMaterial(u.translucency, thin);
  mat.name = 'whitewater';
  // The ribbon's triangles face into the water, so the shell's outside is their back side; seen
  // from inside the tube it simply isn't there (the curtain's clear inner face shows instead).
  mat.side = BackSide;
  mat.positionNode = part.positionNode;
  // Billow tops are dense white bubbles; the creases between them are thinner, bluer and dimmer.
  const top = smoothstep(0.05, 0.75, billow).mul(0.7).add(cluster.mul(0.3));
  // [look] Creases are thinner and a touch bluer, but still bright (was 0.6-0.78 × 0.7: clay).
  const alb = mix(vec3(0.8, 0.87, 0.9), vec3(0.98, 0.98, 0.985), top).mul(mix(float(0.88), float(1), top));
  mat.colorNode = vec4(alb.mul(u.albedo), 1);
  mat.roughnessNode = mix(float(0.62), float(0.9), top);
  mat.metalnessNode = float(0);
  // [look] Sky fill: the whole dome lights a bubble mass from every side (the IBL alone left it tan
  // under the orange 11° sun). Same irradiance estimate as the water's foam.
  if (atmos) {
    const sd = atmos.sunDirNode;
    const Esky = vec3(atmos.skyRadiance(vec3(0, 1, 0))).add(vec3(atmos.skyRadiance(normalize(vec3(sd.x, 0.45, sd.z))))).mul(0.5);
    mat.emissiveNode = alb.mul(u.albedo).mul(Esky).mul(mix(float(0.55), float(0.85), top));
  }
  mat.normalNode = Fn(() => normalize(cameraViewMatrix.mul(vec4(Nb, 0)).xyz))();
  // Dissolve the edges into ragged clumps and lace.
  const keep = foam.mul(float(0.7).add(cluster.sub(0.45).mul(u.ragged))).add(hB.mul(0.1));
  mat.maskNode = keep.greaterThan(0.4);
  return mat;
}
