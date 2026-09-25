import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three';
import { smoothstep } from '../engine/math';
import { BODY_R, type Vec2 } from '../engine/types';
import { groundHeight } from './terrain-shape';

const RADIAL = 14;
const FLAT = 0.8; // cross-section height / width
const SWAY = 0.07;

/** Drawn girth. Wider than the collision radius so the snake holds the eye at play distance. */
export const VISUAL_R = BODY_R * 1.3;

export function radiusProfile(s: number, length: number): number {
  const neck = 0.8 + 0.2 * smoothstep(0, 0.7, s);
  const tail = 1 - 0.82 * smoothstep(length * 0.35, length, s);
  return VISUAL_R * neck * tail;
}

// vUv.x = arc length from the head (world units), vUv.y = angle around the body
// (0.25 = spine on top, 0.75 = belly).
const SCALE_GLSL = /* glsl */ `
float around = fract(vUv.y);
float top = 0.5 + 0.5 * sin(around * 6.2831853);
vec3 skin = mix(uBelly, uBase, smoothstep(0.18, 0.5, top));
// Dark saddles across the back, edged in a warm accent; they read even at play distance.
float band = abs(fract(vUv.x * 1.15) - 0.5);
float dorsal = smoothstep(0.2, 0.6, top);
float saddle = (1.0 - smoothstep(0.17, 0.23, band)) * dorsal;
skin = mix(skin, uDark, saddle);
float edge = (1.0 - smoothstep(0.0, 0.035, abs(band - 0.2))) * dorsal;
skin = mix(skin, uAccent, edge * 0.85);
// Pale line where the flank meets the belly.
float flank = 1.0 - smoothstep(0.0, 0.05, abs(top - 0.22));
skin = mix(skin, uBelly * 1.1, flank * 0.6);
vec2 sc = vec2(vUv.x * 10.0, around * 28.0);
sc.x += 0.5 * mod(floor(sc.y), 2.0);
float cell = length(fract(sc) - 0.5);
skin *= 0.8 + 0.2 * (1.0 - smoothstep(0.22, 0.52, cell));
diffuseColor.rgb = skin;
`;

// Fresnel rim so the silhouette separates from the sand, strongest at night.
const RIM_GLSL = /* glsl */ `
float rimF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
totalEmissiveRadiance += uRimColor * rimF * uRim;
`;

type RimUniforms = { uRim: { value: number }; uRimColor: { value: Color } };

function addRim(shader: { uniforms: Record<string, unknown>; fragmentShader: string }, rim: RimUniforms): void {
  Object.assign(shader.uniforms, rim);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform vec3 uRimColor;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${RIM_GLSL}`);
}

function createBodyMaterial(rim: RimUniforms): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0,
    clearcoat: 0.18,
    clearcoatRoughness: 0.5,
    iridescence: 0.12,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [180, 420],
  });
  m.defines = { USE_UV: '' };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBase = { value: new Color('#4c9a3f') };
    shader.uniforms.uDark = { value: new Color('#173d24') };
    shader.uniforms.uBelly = { value: new Color('#ecdca6') };
    shader.uniforms.uAccent = { value: new Color('#e8b54a') };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uBase;\nuniform vec3 uDark;\nuniform vec3 uBelly;\nuniform vec3 uAccent;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SCALE_GLSL}`);
    addRim(shader, rim);
  };
  return m;
}

export class SnakeMesh {
  readonly group = new Group();
  private readonly geometry = new BufferGeometry();
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly uvs: Float32Array;
  private readonly arcs: Float32Array;
  private readonly head = new Group();
  private readonly tongue = new Group();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly rim: RimUniforms = { uRim: { value: 0.1 }, uRimColor: { value: new Color('#8fe0c0') } };
  private swayPhase = 0;
  private tongueClock = 0;

  constructor(private readonly maxPoints = 1400) {
    const verts = maxPoints * (RADIAL + 1);
    this.positions = new Float32Array(verts * 3);
    this.normals = new Float32Array(verts * 3);
    this.uvs = new Float32Array(verts * 2);
    this.arcs = new Float32Array(maxPoints);
    const index = new Uint32Array((maxPoints - 1) * RADIAL * 6);
    let n = 0;
    for (let i = 0; i < maxPoints - 1; i++) {
      for (let k = 0; k < RADIAL; k++) {
        const a = i * (RADIAL + 1) + k;
        const b = a + 1;
        const c = a + RADIAL + 1;
        const d = c + 1;
        index[n++] = a;
        index[n++] = b;
        index[n++] = c;
        index[n++] = b;
        index[n++] = d;
        index[n++] = c;
      }
    }
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('normal', new BufferAttribute(this.normals, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('uv', new BufferAttribute(this.uvs, 2).setUsage(DynamicDrawUsage));
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);

    const bodyMat = createBodyMaterial(this.rim);
    const body = new Mesh(this.geometry, bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    body.frustumCulled = false;

    const headMat = new MeshPhysicalMaterial({
      color: '#3f8636',
      roughness: 0.5,
      clearcoat: 0.2,
      clearcoatRoughness: 0.45,
      iridescence: 0.12,
      iridescenceIOR: 1.3,
    });
    headMat.onBeforeCompile = (shader) => addRim(shader, this.rim);
    const headGeo = new SphereGeometry(1, 32, 20);
    // Wedge head: a wide skull behind a narrower, flatter snout.
    const skull = new Mesh(headGeo, headMat);
    skull.scale.set(0.52, 0.29, 0.46);
    skull.castShadow = true;
    const snout = new Mesh(headGeo, headMat);
    snout.scale.set(0.42, 0.22, 0.33);
    snout.position.set(0.22, -0.03, 0);
    snout.castShadow = true;
    const eyeGeo = new SphereGeometry(0.085, 16, 12);
    const eyeMat = new MeshPhysicalMaterial({
      color: '#f0b429',
      emissive: '#8a5a00',
      emissiveIntensity: 0.6,
      roughness: 0.15,
      clearcoat: 1,
    });
    const pupilGeo = new SphereGeometry(1, 12, 8);
    const pupilMat = new MeshStandardMaterial({ color: '#050505', roughness: 0.2 });
    for (const side of [-1, 1]) {
      const eye = new Mesh(eyeGeo, eyeMat);
      eye.position.set(0.2, 0.12, 0.3 * side);
      const pupil = new Mesh(pupilGeo, pupilMat);
      pupil.scale.set(0.022, 0.06, 0.02);
      pupil.position.set(0.035, 0, 0.055 * side);
      eye.add(pupil);
      this.head.add(eye);
    }
    const tongueMat = new MeshStandardMaterial({ color: '#c3223c', roughness: 0.5 });
    const stemGeo = new BoxGeometry(0.22, 0.012, 0.012);
    const forkGeo = new BoxGeometry(0.09, 0.01, 0.01);
    const stem = new Mesh(stemGeo, tongueMat);
    stem.position.x = 0.11;
    this.tongue.add(stem);
    for (const side of [-1, 1]) {
      const fork = new Mesh(forkGeo, tongueMat);
      fork.position.set(0.25, 0, 0.018 * side);
      fork.rotation.y = -0.4 * side;
      this.tongue.add(fork);
    }
    this.tongue.position.set(0.55, -0.02, 0);
    this.head.add(skull, snout, this.tongue);
    this.head.scale.setScalar(VISUAL_R / BODY_R);
    this.group.add(body, this.head);
    this.disposables.push(this.geometry, bodyMat, headMat, headGeo, eyeGeo, eyeMat, pupilGeo, pupilMat, tongueMat, stemGeo, forkGeo);
  }

  update(points: Vec2[], heading: number, dt: number, speed: number, sink: number, moving: boolean): void {
    const n = Math.min(points.length, this.maxPoints);
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    if (moving) this.swayPhase += dt * speed * 1.6;

    this.arcs[0] = 0;
    for (let i = 1; i < n; i++) {
      this.arcs[i] = this.arcs[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    }
    const length = this.arcs[n - 1] || 1;
    const drop = sink * 0.36; // half-buried, so the body still reads after death

    for (let i = 0; i < n; i++) {
      const p = points[i];
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(n - 1, i + 1)];
      let fx = a.x - b.x;
      let fz = a.z - b.z;
      const fl = Math.hypot(fx, fz) || 1;
      fx /= fl;
      fz /= fl;
      const px = -fz;
      const pz = fx;
      const s = this.arcs[i];
      const r = radiusProfile(s, length);
      const sway = SWAY * Math.sin(this.swayPhase - s * 2.4) * smoothstep(0.5, 1.6, s);
      const cx = p.x + px * sway;
      const cz = p.z + pz * sway;
      const cy = groundHeight(p.x, p.z) + r * FLAT - 0.05 - drop;
      for (let k = 0; k <= RADIAL; k++) {
        const ang = (k / RADIAL) * Math.PI * 2;
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const v = i * (RADIAL + 1) + k;
        this.positions[v * 3] = cx + px * c * r;
        this.positions[v * 3 + 1] = cy + sn * r * FLAT;
        this.positions[v * 3 + 2] = cz + pz * c * r;
        const nx = px * c * FLAT;
        const ny = sn;
        const nz = pz * c * FLAT;
        const nl = Math.hypot(nx, ny, nz) || 1;
        this.normals[v * 3] = nx / nl;
        this.normals[v * 3 + 1] = ny / nl;
        this.normals[v * 3 + 2] = nz / nl;
        this.uvs[v * 2] = s;
        this.uvs[v * 2 + 1] = k / RADIAL;
      }
    }
    for (const name of ['position', 'normal', 'uv'] as const) this.geometry.getAttribute(name).needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * RADIAL * 6);

    const hp = points[0];
    this.head.position.set(
      hp.x + Math.cos(heading) * 0.1,
      groundHeight(hp.x, hp.z) + 0.3 - drop * 1.3,
      hp.z + Math.sin(heading) * 0.1,
    );
    this.head.rotation.set(0, -heading, 0);

    this.tongueClock += dt;
    const cycle = this.tongueClock % 2.8;
    const out = cycle < 0.22 ? Math.sin((cycle / 0.22) * Math.PI) : 0;
    this.tongue.visible = out > 0.01 && sink === 0;
    this.tongue.scale.set(Math.max(0.001, out), 1, 1);
  }

  setRim(strength: number): void {
    this.rim.uRim.value = strength;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
