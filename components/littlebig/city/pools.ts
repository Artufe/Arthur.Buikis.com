// Night lights of the streets.
//   (1) Light pools: a warm amber disc on the pavement under every lamp (hot core #FFD9A0 → rim
//       #FFB84D, quadratic falloff, r ≈ 4–5 m, ±25 % intensity per lamp). Where two pools overlap
//       their light does not stack: each pool is weighted by its share of the total at every
//       vertex (Σ wᵢ·kᵢ with wᵢ = kᵢ / Σ k ≤ max k), so a ring of lamps reads as light, not beads.
//       They fade out above ~150 m (camera altitude): from orbit the lamp heads carry the city.
//   (2) Points: a crisp lamp-head spark with a faint halo at every lamp (2–4 px core, fading in
//       past ~25 m where the lens itself gets small), and one spark on every LIT window centre —
//       the window grid recorded from the actual facade quads (geo.ts `facades`), lit by the same
//       hash as the facade shader, 5 cm proud of the wall, depth-tested. A window spark only shows
//       where its facade faces the camera and the shader's window pattern has shrunk below ~3 px
//       (bay or floor), i.e. exactly where the drawn windows have averaged out.
// Both additive, no depth write, LAYER_NO_INK.

import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, Points, ShaderMaterial, Vector2 } from 'three';
import { LAYER_NO_INK, type LBContext } from '../core/contracts';
import { LB_COMMON_GLSL } from '../render/toon';
import { toSphere } from '../world/city/frame';
import type { CityIndex, CityPlan } from '../world/city/types';
import { hash3 } from '../world/rng';
import { v3 } from '../world/sphere';
import { frameFor } from './buildings';
import { Geo } from './geo';
import { GLOBE_H, LAMP_H, LAMP_REACH } from './props';
import { facadeWindows } from './shader';

/** Pool radius under a street lamp / a plaza globe lamp (m). */
const RADIUS = 4.6;
const GLOBE_RADIUS = 2.6;
const N = 8; // grid cells per side

const vert = /* glsl */ `
${LB_COMMON_GLSL}
attribute vec2 aUv;
attribute float aGain;
varying vec2 vUv;
varying float vGain;
varying vec3 vWorld;
void main() {
  vUv = aUv;
  vGain = aGain;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
${LB_COMMON_GLSL}
uniform float uStrength;
uniform float uReveal;
varying vec2 vUv;
varying float vGain;
varying vec3 vWorld;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  // inverse-square-like falloff (1 / (1 + 7r²)) windowed to zero at the rim by (1 − r²)²: a hot
  // spot under the lamp spreading into a soft amber skirt; the core tints toward pale gold
  float w = (1.0 - r2) * (1.0 - r2);
  float k = w / (1.0 + 7.0 * r2);
  vec3 rim = vec3(1.0, 0.479, 0.074);  // #FFB84D (linear)
  vec3 core = vec3(1.0, 0.693, 0.352); // #FFD9A0 (linear)
  vec3 col = mix(rim, core, smoothstep(0.35, 1.0, k));
  float night = lbNightAt(vWorld);
  // fade out from ~110 m to ~170 m up: from orbit the lamp-head sparks carry the city
  float alt = 1.0 - smoothstep(110.0, 170.0, lbCamAlt);
  vec3 c = col * k * vGain * night * uStrength * uReveal * alt;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const pointVert = /* glsl */ `
${LB_COMMON_GLSL}
uniform vec2 uViewport;
attribute float aSize;
attribute float aNear;
attribute vec3 aNormal;
attribute vec2 aCell;
varying float vFade;
varying float vCore;
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vec3 toCam = lbCamPos - w.xyz;
  float d = length(toCam);
  vec3 V = toCam / max(d, 1e-3);
  // pull the sprite toward the eye a touch (depth-tested against its own wall at any distance)
  w.xyz += V * min(0.35, d * 0.0025);
  vec4 mv = viewMatrix * w;
  gl_Position = projectionMatrix * mv;
  float pxPerM = projectionMatrix[1][1] * uViewport.y * 0.5 / max(-mv.z, 0.1);
  float fade;
  float px;
  if (dot(aNormal, aNormal) > 0.5) {
    // A window: only on a wall facing the eye, and only where the facade's own window pattern has
    // shrunk below ~3 px (it averages out there; the spark takes over).
    float facing = dot(aNormal, V);
    vec3 up = normalize(w.xyz);
    vec3 T = normalize(cross(up, aNormal));
    float pu = aCell.x * pxPerM * sqrt(max(0.0, 1.0 - dot(T, V) * dot(T, V)));
    float pv = aCell.y * pxPerM * sqrt(max(0.0, 1.0 - dot(up, V) * dot(up, V)));
    fade = smoothstep(0.12, 0.4, facing) * (1.0 - smoothstep(2.6, 4.6, min(pu, pv)));
    px = clamp(aSize * pxPerM * 2.2, 2.2, 3.6);
    vCore = 0.55;
  } else {
    // a lamp head / porch light: takes over from its lens past aNear metres
    fade = smoothstep(aNear, aNear * 2.2, d);
    px = clamp(aSize * pxPerM * 3.0, 5.0, 9.0);
    vCore = 2.6 / px; // a ~2.6 px crisp core inside a soft halo
  }
  vFade = fade;
  gl_PointSize = px;
  if (fade <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen: skip the fragments
}
`;

const pointFrag = /* glsl */ `
${LB_COMMON_GLSL}
uniform float uReveal;
varying float vFade;
varying float vCore;
varying vec3 vWorld;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(vCore * 0.7, vCore, r);
  float halo = (1.0 - r) * (1.0 - r);
  float night = lbNightAt(vWorld);
  vec3 hot = vec3(1.0, 0.78, 0.45);
  vec3 warm = vec3(1.0, 0.48, 0.1);
  vec3 c = (hot * core * 2.2 + warm * halo * 0.45) * night * vFade * uReveal;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface CityLights {
  pools: Mesh;
  points: Points;
  poolMat: ShaderMaterial;
  pointMat: ShaderMaterial;
}

/** Pool centre, radius and gain per lamp (plan space). */
export function poolLayout(plan: CityPlan): Array<{ x: number; z: number; r: number; gain: number; hx: number; hz: number; globe: boolean; f: number }> {
  const out: Array<{ x: number; z: number; r: number; gain: number; hx: number; hz: number; globe: boolean; f: number }> = [];
  plan.features.forEach((f, fi) => {
    if (f.kind !== 'streetlight' && f.kind !== 'lamp') return;
    const globe = f.kind === 'lamp';
    const reach = globe ? 0 : LAMP_REACH * 0.75;
    const j = hash3(fi, 71, 5);
    out.push({
      x: f.x + Math.cos(f.angle) * reach,
      z: f.z + Math.sin(f.angle) * reach,
      r: (globe ? GLOBE_RADIUS : RADIUS) * (0.92 + 0.16 * hash3(fi, 13, 9)),
      gain: (globe ? 0.6 : 1) * (0.75 + 0.5 * j), // ±25 %
      hx: f.x + Math.cos(f.angle) * (globe ? 0 : LAMP_REACH - 0.25),
      hz: f.z + Math.sin(f.angle) * (globe ? 0 : LAMP_REACH - 0.25),
      globe,
      f: fi,
    });
  });
  return out;
}

/** The pool's falloff at squared distance d2 (the fragment shader's k). */
const fall = (d2: number, r: number) => {
  const r2 = d2 / (r * r);
  const t = 1 - r2;
  return t > 0 ? (t * t) / (1 + 7 * r2) : 0;
};

export function buildPools(ctx: LBContext, plan: CityPlan, index: CityIndex, facades: number[]): CityLights {
  const lamps = poolLayout(plan);
  // neighbours whose pools overlap (a handful each)
  const nb: number[][] = lamps.map(() => []);
  for (let i = 0; i < lamps.length; i++) {
    for (let j = i + 1; j < lamps.length; j++) {
      const a = lamps[i];
      const b = lamps[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r) {
        nb[i].push(j);
        nb[j].push(i);
      }
    }
  }
  const per = (N + 1) * (N + 1);
  const pos = new Float32Array(lamps.length * per * 3);
  const uv = new Float32Array(lamps.length * per * 2);
  const gain = new Float32Array(lamps.length * per);
  const idx: number[] = [];
  const ppos: number[] = [];
  const psize: number[] = [];
  const pnear: number[] = [];
  const pnorm: number[] = [];
  const pcell: number[] = [];
  const p = v3();
  const pushPoint = (x: number, y: number, z: number, size: number, near: number) => {
    ppos.push(x, y, z);
    psize.push(size);
    pnear.push(near);
    pnorm.push(0, 0, 0);
    pcell.push(0, 0);
  };
  lamps.forEach((L, li) => {
    const gh = index.groundH(L.hx, L.hz);
    toSphere(L.hx, L.hz, gh + (L.globe ? GLOBE_H : LAMP_H - 0.12), p);
    pushPoint(p.x, p.y, p.z, L.globe ? 0.7 : 0.8, L.globe ? 18 : 25);
    const base = li * per;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const u = (i / N) * 2 - 1;
        const v = (j / N) * 2 - 1;
        const x = L.x + u * L.r;
        const z = L.z + v * L.r;
        toSphere(x, z, index.groundH(x, z) + 0.025, p);
        const k = base + j * (N + 1) + i;
        pos[k * 3] = p.x;
        pos[k * 3 + 1] = p.y;
        pos[k * 3 + 2] = p.z;
        uv[k * 2] = u;
        uv[k * 2 + 1] = v;
        // this pool's share of the light here (no stacking where pools overlap)
        const own = L.gain * fall(u * u * L.r * L.r + v * v * L.r * L.r, L.r);
        let sum = own;
        for (const o of nb[li]) {
          const M = lamps[o];
          sum += M.gain * fall((x - M.x) ** 2 + (z - M.z) ** 2, M.r);
        }
        gain[k] = sum > 1e-6 ? (L.gain * own) / sum : L.gain;
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = base + j * (N + 1) + i;
        const b = a + 1;
        const c = a + N + 2;
        const d = a + N + 1;
        idx.push(a, c, b, a, d, c);
      }
    }
  });
  const geo = ctx.track(new BufferGeometry());
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('aUv', new BufferAttribute(uv, 2));
  geo.setAttribute('aGain', new BufferAttribute(gain, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const poolMat = ctx.track(
    new ShaderMaterial({
      name: 'city:pools',
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { ...ctx.uniforms, uStrength: { value: 0.75 }, uReveal: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const pools = new Mesh(geo, poolMat);
  pools.name = 'city:pools';
  pools.layers.set(LAYER_NO_INK);
  pools.renderOrder = 2;

  // Window sparks on every lit window centre of the recorded facade quads.
  facadeWindows(facades, (x, y, z, nx, ny, nz, bay, floor, winW) => {
    ppos.push(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05);
    psize.push(winW);
    pnear.push(0);
    pnorm.push(nx, ny, nz);
    pcell.push(bay, floor);
  });
  // A porch light at every house door.
  for (const b of plan.buildings) {
    if (b.style !== 'house') continue;
    const xf = frameFor(b.x, b.z, b.angle, 0);
    Geo.apply(xf, b.door ?? 0, 2.3, -b.d / 2 + 0.12, p);
    pushPoint(p.x, p.y, p.z, 0.5, 26);
  }
  const pgeo = ctx.track(new BufferGeometry());
  pgeo.setAttribute('position', new BufferAttribute(new Float32Array(ppos), 3));
  pgeo.setAttribute('aSize', new BufferAttribute(new Float32Array(psize), 1));
  pgeo.setAttribute('aNear', new BufferAttribute(new Float32Array(pnear), 1));
  pgeo.setAttribute('aNormal', new BufferAttribute(new Float32Array(pnorm), 3));
  pgeo.setAttribute('aCell', new BufferAttribute(new Float32Array(pcell), 2));
  pgeo.computeBoundingSphere();
  const pointMat = ctx.track(
    new ShaderMaterial({
      name: 'city:lamp-points',
      vertexShader: pointVert,
      fragmentShader: pointFrag,
      uniforms: { ...ctx.uniforms, uReveal: { value: 1 }, uViewport: { value: new Vector2(1280, 800) } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
    }),
  );
  const points = new Points(pgeo, pointMat);
  points.name = 'city:lamp-points';
  points.layers.set(LAYER_NO_INK);
  points.renderOrder = 3;
  points.frustumCulled = false;
  return { pools, points, poolMat, pointMat };
}
