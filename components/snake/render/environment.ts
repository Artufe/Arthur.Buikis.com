import {
  BackSide,
  BufferAttribute,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Scene,
} from 'three';
import { TAU } from '../engine/math';
import { nextRandom } from '../engine/rng';
import { ARENA_R } from '../engine/types';
import type { Palette } from './palettes';
import { groundHeight } from './terrain-shape';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunSize;
uniform float uStars;
uniform float uTime;
varying vec3 vDir;
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(0.0, 1.0, h), 0.55));
  col = mix(col, uHorizon * 0.85, smoothstep(0.0, -0.25, h));
  float c = dot(d, normalize(uSunDir));
  float disc = smoothstep(cos(uSunSize * 1.08), cos(uSunSize * 0.92), c);
  float glow = pow(max(c, 0.0), 6.0) * 0.4 + pow(max(c, 0.0), 48.0) * 0.5;
  col += uSunColor * (disc * 2.6 + glow);
  // Stars: one jittered, round point per occupied cell, in two layers of different density.
  float stars = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 190.0 : 420.0;
    vec3 q = d * scale;
    vec3 cell = floor(q);
    float s = hash31(cell);
    vec3 jitter = vec3(hash31(cell + 1.7), hash31(cell + 4.1), hash31(cell + 9.3)) - 0.5;
    float r = length(fract(q) - 0.5 - jitter * 0.5);
    float lit = step(layer == 0 ? 0.972 : 0.955, s);
    float bright = layer == 0 ? 0.6 + 1.4 * fract(s * 37.0) : 0.35 + 0.5 * fract(s * 53.0);
    float twinkle = 0.75 + 0.25 * sin(uTime * (1.0 + 2.0 * fract(s * 11.0)) + s * 80.0);
    stars += lit * bright * twinkle * smoothstep(0.22, 0.0, r);
  }
  // A faint band of milky light across the sky.
  vec3 bandAxis = normalize(vec3(0.35, 0.45, 0.82));
  float band = exp(-pow(dot(d, bandAxis) * 3.2, 2.0)) * (0.55 + 0.45 * hash31(floor(d * 60.0)));
  float horizonFade = smoothstep(0.03, 0.3, h);
  col += (vec3(1.2, 1.2, 1.35) * stars + vec3(0.05, 0.06, 0.1) * band) * horizonFade * uStars;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function rockGeometry(seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, 2); // non-indexed: faces stay faceted after displacement
  const pos = g.getAttribute('position') as BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const dark = new Color('#96603a');
  const light = new Color('#cf9563');
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const bump =
      1 +
      0.24 * Math.sin(3.1 * x + seed) * Math.sin(2.7 * y + 1.3 * seed) * Math.sin(2.9 * z + 0.7 * seed) +
      0.08 * Math.sin(7.3 * x + 5.1 * z + seed * 2.1);
    x *= bump;
    y *= bump * 0.72;
    z *= bump;
    if (y < -0.3) y = -0.3 + (y + 0.3) * 0.3; // flattened base
    pos.setXYZ(i, x, y, z);
    c.lerpColors(dark, light, 0.5 + 0.5 * Math.sin(y * 9 + seed)); // sandstone strata
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function createRocks(): { group: Group; material: MeshStandardMaterial; dispose(): void } {
  const group = new Group();
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const variants = [1.7, 4.2, 8.9].map(rockGeometry);
  const COUNT = 51;
  const perVariant = Math.ceil(COUNT / variants.length);
  const meshes = variants.map((geo) => {
    const m = new InstancedMesh(geo, material, perVariant);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  });
  let seed = 1337;
  const rand = () => {
    const r = nextRandom(seed);
    seed = r.seed;
    return r.value;
  };
  const m4 = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const e = new Vector3();
  const counts = meshes.map(() => 0);
  for (let i = 0; i < COUNT; i++) {
    const big = rand() < 0.18;
    const base = big ? 1.6 + rand() * 1.0 : 0.6 + rand() * 0.8;
    s.set(base * (0.8 + rand() * 0.5), base * (0.6 + rand() * 0.5), base * (0.8 + rand() * 0.5));
    const angle = (i / COUNT) * TAU + (rand() - 0.5) * 0.08;
    // Inner edge sits right at the wall so touching a rock is where the snake dies.
    const r = ARENA_R - 0.2 + Math.max(s.x, s.z) * 1.1 + rand() * 0.8;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    p.set(x, groundHeight(x, z) - 0.25 * s.y, z);
    e.set((rand() - 0.5) * 0.3, rand() * TAU, (rand() - 0.5) * 0.3);
    q.setFromAxisAngle(new Vector3(0, 1, 0), e.y).multiply(
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), e.x),
    );
    m4.compose(p, q, s);
    const v = i % meshes.length;
    meshes[v].setMatrixAt(counts[v]++, m4);
  }
  meshes.forEach((m, i) => {
    m.count = counts[i];
    m.instanceMatrix.needsUpdate = true;
  });
  return {
    group,
    material,
    dispose() {
      variants.forEach((g) => g.dispose());
      material.dispose();
    },
  };
}

export type Environment = {
  sun: DirectionalLight;
  setPalette(p: Palette): void;
  update(time: number, cameraPosition: Vector3): void;
  setShadowSize(size: number): void;
  dispose(): void;
};

export function createEnvironment(scene: Scene, opts: { shadowSize: number }): Environment {
  const sun = new DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(opts.shadowSize, opts.shadowSize);
  const cam = sun.shadow.camera;
  cam.left = -28;
  cam.right = 28;
  cam.top = 28;
  cam.bottom = -28;
  cam.near = 1;
  cam.far = 160;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);

  const hemi = new HemisphereLight(0xffffff, 0x000000, 0.6);
  scene.add(hemi);

  const skyUniforms = {
    uZenith: { value: new Color() },
    uHorizon: { value: new Color() },
    uSunColor: { value: new Color() },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uSunSize: { value: 0.03 },
    uStars: { value: 0 },
    uTime: { value: 0 },
  };
  const skyMaterial = new ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new Mesh(new SphereGeometry(500, 48, 24), skyMaterial);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  const fog = new FogExp2(0xffffff, 0.01);
  scene.fog = fog;

  const rocks = createRocks();
  scene.add(rocks.group);

  return {
    sun,
    setPalette(p) {
      skyUniforms.uZenith.value.copy(p.skyZenith);
      skyUniforms.uHorizon.value.copy(p.skyHorizon);
      skyUniforms.uSunColor.value.copy(p.sunColor);
      skyUniforms.uSunDir.value.copy(p.sunDir);
      skyUniforms.uSunSize.value = p.sunSize;
      skyUniforms.uStars.value = p.stars;
      sun.color.copy(p.sunColor);
      sun.intensity = p.sunIntensity;
      sun.position.copy(p.sunDir).multiplyScalar(80);
      hemi.color.copy(p.hemiSky);
      hemi.groundColor.copy(p.hemiGround);
      hemi.intensity = p.hemiIntensity;
      fog.color.copy(p.fog);
      fog.density = p.fogDensity;
      rocks.material.color.copy(p.rock);
    },
    update(time, cameraPosition) {
      skyUniforms.uTime.value = time;
      sky.position.copy(cameraPosition);
    },
    setShadowSize(size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    },
    dispose() {
      sky.geometry.dispose();
      skyMaterial.dispose();
      rocks.dispose();
      sun.shadow.map?.dispose();
    },
  };
}
