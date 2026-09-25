import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
  type IUniform,
  type Texture,
} from 'three';
import type { Palette } from './palettes';
import { DUNE_START, NOISE_GLSL, TERRAIN_GLSL, TERRAIN_HALF } from './terrain-shape';
import { GROOVE_DEPTH, RIM_HEIGHT, TRAIL_HALF_EXTENT } from './trail-constants';

/** Dense near the centre (≈0.14 units at 400 segments), coarse toward the horizon. */
export function remapGrid(t: number): number {
  return TERRAIN_HALF * (0.35 * t + 0.65 * t ** 5);
}

function createTerrainGeometry(segments: number): BufferGeometry {
  const row = segments + 1;
  const positions = new Float32Array(row * row * 3);
  const normals = new Float32Array(row * row * 3);
  for (let j = 0; j < row; j++) {
    const z = remapGrid((j / segments) * 2 - 1);
    for (let i = 0; i < row; i++) {
      const k = (j * row + i) * 3;
      positions[k] = remapGrid((i / segments) * 2 - 1);
      positions[k + 2] = z;
      normals[k + 1] = 1;
    }
  }
  const index = new Uint32Array(segments * segments * 6);
  let n = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      index[n++] = a;
      index[n++] = c;
      index[n++] = b;
      index[n++] = b;
      index[n++] = c;
      index[n++] = d;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  g.setIndex(new BufferAttribute(index, 1));
  g.boundingSphere = new Sphere(new Vector3(), TERRAIN_HALF * 1.5);
  return g;
}

const TRAIL_GLSL = /* glsl */ `
#define GROOVE_DEPTH ${GROOVE_DEPTH.toFixed(3)}
#define RIM_HEIGHT ${RIM_HEIGHT.toFixed(3)}
uniform sampler2D uTrail;
uniform float uTrailHalf;
vec4 sampleTrail(vec2 p) {
  vec2 uv = p / (2.0 * uTrailHalf) + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uTrail, uv);
}
float trailH(vec2 p) {
  vec4 t = sampleTrail(p);
  return -t.r * GROOVE_DEPTH + t.g * RIM_HEIGHT;
}
`;

const VERTEX_DECL = /* glsl */ `
varying vec2 vXZ;
varying vec3 vWN;
varying vec3 vWPos;
${NOISE_GLSL}
${TERRAIN_GLSL}
${TRAIL_GLSL}
`;

const VERTEX_NORMAL = /* glsl */ `
vec2 pXZ = position.xz;
float hC = terrainHeight(pXZ);
float hX = terrainHeight(pXZ + vec2(0.3, 0.0));
float hZ = terrainHeight(pXZ + vec2(0.0, 0.3));
vec3 objectNormal = normalize(vec3(hC - hX, 0.3, hC - hZ));
vWN = objectNormal;
vXZ = pXZ;
`;

const VERTEX_POSITION = /* glsl */ `
vec3 transformed = vec3(position.x, hC + trailH(pXZ), position.z);
vWPos = transformed;
`;

const FRAGMENT_DECL = /* glsl */ `
uniform float uTrailTexel;
uniform vec3 uSandA;
uniform vec3 uSandB;
uniform vec3 uGroove;
uniform vec3 uRim;
uniform float uGlint;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTime;
varying vec2 vXZ;
varying vec3 vWN;
varying vec3 vWPos;
${NOISE_GLSL}
${TRAIL_GLSL}
`;

const FRAGMENT_COLOR = /* glsl */ `
vec4 trailS = sampleTrail(vXZ);
float groove = trailS.r;
float rim = trailS.g;
float fresh = trailS.b;
float large = fbm(vXZ * 0.07);
float grain = vnoise(vXZ * 2.3);
vec3 sand = mix(uSandB, uSandA, smoothstep(0.3, 0.72, large));
sand *= 0.94 + 0.1 * grain;
sand = mix(sand, uGroove, clamp(groove * (0.45 + 0.4 * fresh), 0.0, 0.9));
sand = mix(sand, uRim, clamp(rim * 0.55, 0.0, 1.0));
diffuseColor.rgb *= sand;
`;

const FRAGMENT_NORMAL = /* glsl */ `
vec2 windDir = normalize(vec2(0.82, 0.57));
float ripplePhase = dot(vXZ, windDir) * 7.2 + fbm(vXZ * 0.33) * 6.0;
float rippleAA = clamp(1.0 - fwidth(ripplePhase) * 0.4, 0.0, 1.0);
float disturbed = clamp(groove * 1.6 + rim * 1.2, 0.0, 1.0);
float duneFade = 1.0 - 0.75 * smoothstep(${DUNE_START.toFixed(1)}, ${(DUNE_START + 20).toFixed(1)}, length(vXZ));
float rippleAmp = 0.045 * rippleAA * (1.0 - disturbed) * duneFade * (0.55 + 0.9 * fbm(vXZ * 0.11));
float dRipple = cos(ripplePhase) + 0.35 * cos(2.0 * ripplePhase);
vec2 grad = windDir * dRipple * 7.2 * rippleAmp * 0.8;
float te = uTrailTexel;
grad += 1.6 * vec2(
  trailH(vXZ + vec2(te, 0.0)) - trailH(vXZ - vec2(te, 0.0)),
  trailH(vXZ + vec2(0.0, te)) - trailH(vXZ - vec2(0.0, te))
) / (2.0 * te);
grad += (vec2(vnoise(vXZ * 11.0), vnoise(vXZ * 11.0 + 31.7)) - 0.5) * 0.1 * rippleAA;
vec3 sandN = normalize(normalize(vWN) + vec3(-grad.x, 0.0, -grad.y));
normal = normalize((viewMatrix * vec4(sandN, 0.0)).xyz);
`;

const FRAGMENT_GLINT = /* glsl */ `
float glintSeed = hash21(floor(vXZ * 34.0));
vec3 viewDirW = normalize(cameraPosition - vWPos);
vec3 halfW = normalize(viewDirW + normalize(uSunDir));
float glintSpec = pow(max(dot(sandN, halfW), 0.0), 90.0);
float twinkle = 0.55 + 0.45 * sin(uTime * 2.3 + glintSeed * 71.0);
float glintFade = 1.0 - smoothstep(18.0, 45.0, length(cameraPosition - vWPos));
float crest = smoothstep(0.45, 0.95, sin(ripplePhase));
totalEmissiveRadiance += uSunColor * step(0.993, glintSeed) * crest * glintSpec * twinkle * glintFade * uGlint * 2.5 * (1.0 - groove);
`;

export type Terrain = {
  mesh: Mesh;
  setPalette(p: Palette): void;
  setTime(t: number): void;
  dispose(): void;
};

export function createTerrain(opts: { segments: number; trailTexture: Texture; trailTexel: number }): Terrain {
  const uniforms: Record<string, IUniform> = {
    uTrail: { value: opts.trailTexture },
    uTrailHalf: { value: TRAIL_HALF_EXTENT },
    uTrailTexel: { value: opts.trailTexel },
    uSandA: { value: new Color() },
    uSandB: { value: new Color() },
    uGroove: { value: new Color() },
    uRim: { value: new Color() },
    uGlint: { value: 1 },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uSunColor: { value: new Color() },
    uTime: { value: 0 },
  };
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <beginnormal_vertex>', VERTEX_NORMAL)
      .replace('#include <begin_vertex>', VERTEX_POSITION);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_COLOR}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAGMENT_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAGMENT_GLINT}`);
  };
  const mesh = new Mesh(createTerrainGeometry(opts.segments), material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  return {
    mesh,
    setPalette(p) {
      uniforms.uSandA.value.copy(p.sandA);
      uniforms.uSandB.value.copy(p.sandB);
      uniforms.uGroove.value.copy(p.groove);
      uniforms.uRim.value.copy(p.rim);
      uniforms.uGlint.value = p.glint;
      uniforms.uSunDir.value.copy(p.sunDir);
      uniforms.uSunColor.value.copy(p.sunColor).multiplyScalar(p.sunIntensity / 3);
    },
    setTime(t) {
      uniforms.uTime.value = t;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
