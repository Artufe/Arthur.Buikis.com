// Salt mist: the fine haze a surf zone keeps in the air, hanging over the shore break and the
// reef's impact zone and glowing when the sun is behind it. Soft vertical curtains (cylindrical
// billboards, one instanced draw) textured by drifting 3-D noise, premultiplied like the spray:
// they scatter the low sun forward and barely dim what's behind them. They fade out as the
// camera comes within a few metres, so you never see a curtain's edge from inside the mist.

import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, NodeMaterial, OneFactor, OneMinusSrcAlphaFactor, CustomBlending, PlaneGeometry } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { GLContext, TSLNode } from '../core/contracts';
import { REEF, WIND, shoreX } from '../world/layout';

const { Fn, mrt, texture, attribute, abs, cross, dot, exp, float, length, max, mix, mx_noise_float, normalize, pow, smoothstep, uv, vec2, vec3, vec4, varying, clamp } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { cameraPosition, positionLocal } = TSL as unknown as Record<string, TSLNode>;

function hg(cosT: TSLNode, g: number) {
  const g2 = g * g;
  return float((1 - g2) / (4 * Math.PI)).div(pow(max(float(1 + g2).sub(cosT.mul(2 * g)), 1e-4), 1.5));
}

export interface Mist {
  mesh: Mesh;
  dispose(): void;
}

/** A tileable value-noise texture (two octaves in R, G), smooth under bilinear filtering. */
function noiseTexture(n = 64): DataTexture {
  const lat = new Float32Array(16 * 16 * 2);
  let s = 5;
  for (let i = 0; i < lat.length; i++) lat[i] = (s = (s * 16807) % 2147483647) / 2147483647;
  const data = new Uint8Array(n * n * 4);
  const val = (u: number, v: number, cells: number, ch: number) => {
    const x = u * cells;
    const y = v * cells;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const L = (i: number, j: number) => lat[((((j % cells) + cells) % cells) * 16 + (((i % cells) + cells) % cells)) * 2 + ch];
    return (L(x0, y0) * (1 - sx) + L(x0 + 1, y0) * sx) * (1 - sy) + (L(x0, y0 + 1) * (1 - sx) + L(x0 + 1, y0 + 1) * sx) * sy;
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const v = j / n;
      const o = (j * n + i) * 4;
      data[o] = Math.round((val(u, v, 4, 0) * 0.65 + val(u, v, 8, 1) * 0.35) * 255);
      data[o + 1] = Math.round((val(u, v, 8, 1) * 0.6 + val(u, v, 16, 0) * 0.4) * 255);
      data[o + 3] = 255;
    }
  const t = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.name = 'vfx.mistNoise';
  t.needsUpdate = true;
  return t;
}

export function createMist(ctx: GLContext, time: TSLNode): Mist {
  const noiseTex = noiseTexture();
  // Curtains: (centre x, centre z, width, height) and (seed, strength, base y, 0).
  const A: number[] = [];
  const B: number[] = [];
  let s = 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Shore break: along the waterline, a few metres seaward.
  for (let z = -130; z <= 40; z += 13) {
    const zz = z + (rnd() - 0.5) * 6;
    A.push(shoreX(zz) - 5 - rnd() * 6, zz, 20 + rnd() * 10, 2.6 + rnd() * 1.6);
    B.push(rnd() * 100, 0.8 + rnd() * 0.4, -0.3, 0);
  }
  // Impact zone: just inside the reef edge, where the lips land.
  const ux = REEF.b.x - REEF.a.x;
  const uz = REEF.b.z - REEF.a.z;
  const n = 11;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n + (rnd() - 0.5) * 0.04;
    const x = REEF.a.x + ux * t + 10 + rnd() * 8;
    const z = REEF.a.z + uz * t;
    A.push(x, z, 26 + rnd() * 14, 4.5 + rnd() * 2.5);
    B.push(rnd() * 100, 0.9 + rnd() * 0.5, -0.4, 0);
  }
  const count = A.length / 4;
  const quad = new PlaneGeometry(1, 1, 1, 1);
  quad.translate(0, 0.5, 0);
  const geo = new InstancedBufferGeometry();
  for (const k in quad.attributes) geo.setAttribute(k, quad.attributes[k]);
  geo.setIndex(quad.index);
  geo.instanceCount = count;
  geo.setAttribute('iMist', new InstancedBufferAttribute(new Float32Array(A), 4));
  geo.setAttribute('iMistB', new InstancedBufferAttribute(new Float32Array(B), 4));

  const atmos = ctx.services.atmosphere;
  const strength = ctx.params.number('vfx.mistStrength', { label: 'salt mist density', group: 'vfx', min: 0, max: 3, value: 1 });
  const uStrength = TSL.uniform(strength.value);
  ctx.params.onChange((p) => {
    if (p === strength) uStrength.value = strength.value;
  });

  const mat = new NodeMaterial();
  mat.name = 'vfx.mist';
  mat.transparent = true;
  mat.depthWrite = false;
  mat.side = DoubleSide;
  mat.fog = false;
  mat.blending = CustomBlending;
  mat.blendSrc = OneFactor;
  mat.blendDst = OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = OneFactor;
  mat.blendDstAlpha = OneMinusSrcAlphaFactor;

  const vWorld = varying(vec3(0), 'vMistWorld');
  const vInfo = varying(vec4(0), 'vMistInfo');
  mat.positionNode = Fn(() => {
    const I = attribute('iMist', 'vec4');
    const J = attribute('iMistB', 'vec4');
    const c = vec3(I.x, J.z, I.y);
    // Cylindrical billboard: turn about Y to face the camera.
    const toCam = cameraPosition.sub(c);
    const side = normalize(cross(vec3(0, 1, 0), vec3(toCam.x, 0, toCam.z).add(vec3(1e-4, 0, 0))));
    const p = c.add(side.mul(positionLocal.x.mul(I.z))).add(vec3(0, positionLocal.y.mul(I.w), 0));
    vWorld.assign(p);
    vInfo.assign(vec4(J.x, J.y, I.w, 0));
    return p;
  })();

  const q = uv();
  const P = vWorld;
  // Drift with the offshore breeze, churn slowly upward.
  const w = vec3(WIND.dirX, 0, WIND.dirZ).mul(time.mul(1.4));
  const np = P.sub(w).add(vec3(0, time.mul(-0.35), 0)).add(vInfo.x);
  // Two taps of a small tileable noise texture, projected on the curtain (along it × height),
  // instead of 3-D gradient noise: the curtains cover much of the frame (was ≈ 1.4 ms at 720p).
  const along = dot(vec2(P.x, P.z), vec2(-WIND.dirZ, WIND.dirX));
  const drift = time.mul(0.9).add(vInfo.x);
  const t1 = texture(noiseTex, vec2(along.mul(0.018).add(drift.mul(0.01)), P.y.mul(0.06).sub(time.mul(0.02)))).x;
  const t2 = texture(noiseTex, vec2(along.mul(0.055).sub(drift.mul(0.025)), P.y.mul(0.17).sub(time.mul(0.05))).add(0.37)).y;
  const dens = clamp(t1.mul(1.1).add(t2.mul(0.55)).sub(0.35), 0, 1);
  void np;
  // Thickest just above the water, thinning with height; soft at the curtain's sides.
  const h = q.y;
  const vert = smoothstep(0, 0.22, h).mul(exp(h.mul(-2.4))).mul(float(1).sub(smoothstep(0.45, 1, h)));
  const across = abs(q.x.sub(0.5)).mul(2);
  const edge = float(1).sub(smoothstep(0.2, 1, across)).pow(1.5);
  const dist = length(P.sub(cameraPosition));
  const nearFade = smoothstep(4, 16, dist);
  const farFade = float(1).sub(smoothstep(420, 900, dist));
  const a = dens.mul(dens).mul(vert).mul(edge).mul(nearFade).mul(farFade).mul(vInfo.y).mul(uStrength).mul(0.085).toVar();
  // Forward-scattering droplets: gold when backlit, a faint cool veil otherwise.
  const V = normalize(P.sub(cameraPosition));
  const cosT = dot(V, atmos.sunDirNode);
  const sun = vec3(atmos.sunColorNode);
  const sky = vec3(atmos.skyRadiance(vec3(0, 1, 0))).mul(0.5).add(vec3(atmos.skyRadiance(normalize(vec3(atmos.sunDirNode.x, 0.2, atmos.sunDirNode.z)))).mul(0.5));
  const light = sun.mul(hg(cosT, 0.72).mul(1.3).add(0.05)).add(sky.mul(0.55));
  // Premultiplied colour; alpha = the (small) extinction.
  mat.colorNode = vec4(light.mul(a), a.mul(0.25));
  // Leave the scene pass's other targets alone (normal, velocity, SSR mask): a zero with zero
  // alpha under this blend keeps what the opaque pass wrote, so GTAO/SSR never see the curtains.
  mat.mrtNode = mrt({ normal: vec4(0), velocity: vec4(0), ssr: vec4(0) });
  void mix;
  void vec2;

  const mesh = new Mesh(geo, mat);
  mesh.name = 'vfx.mist';
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  mesh.matrixAutoUpdate = false;
  return {
    mesh,
    dispose() {
      quad.dispose();
      noiseTex.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
