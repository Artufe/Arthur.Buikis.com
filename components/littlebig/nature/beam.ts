// The lighthouse beam (A1): two soft cones of warm light sweeping round at night, plus a glow at the
// lamp. Additive, no depth write and on LAYER_NO_INK (never inked, never sorted against the world);
// the sweep is in the vertex shader (no per-frame CPU work), visibility follows lbNightAt.
// Volumetric-looking without volumes: alpha falls off along the cone (1 − s^0.7) and across it by
// the eye's path length through the cone, computed per fragment in the cone's own cross-section
// ((1 − u²)², u = the offset from the axis seen from the eye; 0 at the silhouette): a soft shaft of
// light with transparent edges, ≤ 0.34 at the lamp with both walls added.

import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { LBContext } from '../core/contracts';
import { LAYER_NO_INK } from '../core/contracts';
import { LB_COMMON_GLSL } from '../render/toon';
import { composeUp } from './frame';

export interface Beam {
  reveal(start: number): void;
  dispose(): void;
}

const LENGTH = 46;
const END_R = 4.2;
const SEGS = 14;

function beamGeometry(): BufferGeometry {
  const pos: number[] = [];
  const along: number[] = [];
  for (const sx of [1, -1]) {
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGS) * Math.PI * 2;
      pos.push(0, 0, 0, sx * LENGTH, Math.cos(a0) * END_R * 0.6, Math.sin(a0) * END_R, sx * LENGTH, Math.cos(a1) * END_R * 0.6, Math.sin(a1) * END_R);
      along.push(0, 1, 1);
    }
  }
  // Lamp glow: one quad, billboarded in the vertex shader (aAlong = −1; its corners in xy).
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
    pos.push(x, y, 0);
    along.push(-1);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aAlong', new BufferAttribute(new Float32Array(along), 1));
  geo.computeBoundingSphere();
  return geo;
}

export function createBeam(ctx: LBContext, x: number, y: number, z: number, up: { x: number; y: number; z: number }): Beam {
  const geo = ctx.track(beamGeometry());
  const uStart = { value: 1e6 };
  const mat = ctx.track(
    new ShaderMaterial({
      name: 'lighthouse beam',
      uniforms: { ...ctx.uniforms, uBeamPos: { value: new Vector3(x, y, z) }, uStart },
      vertexShader: /* glsl */ `
${LB_COMMON_GLSL}
attribute float aAlong;
varying float vAlong;
varying vec2 vCorner;
varying vec3 vLoc;
varying vec3 vVd;
void main() {
  vAlong = aAlong;
  vCorner = position.xy;
  vLoc = position;
  vVd = vec3(0.0, 1.0, 0.0);
  if (aAlong < 0.0) {
    // Glow: a camera-facing disc 2.4 m across, pulled 1.6 m toward the eye so the lamp room
    // never cuts it.
    vec4 c = viewMatrix * modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    c.xyz += normalize(-c.xyz) * 1.6;
    c.xy += position.xy * 1.2;
    gl_Position = projectionMatrix * c;
    return;
  }
  float a = lbTime * 1.2;
  mat2 r = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec3 p = position;
  p.xz = r * p.xz;
  vec4 w = modelMatrix * vec4(p, 1.0);
  // The eye direction in the cone's own (unswept) frame: the model matrix is a pure rotation.
  vec3 vd = transpose(mat3(modelMatrix)) * (cameraPosition - w.xyz);
  vd.xz = vd.xz * r;
  vVd = vd;
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
      fragmentShader: /* glsl */ `
${LB_COMMON_GLSL}
uniform vec3 uBeamPos;
uniform float uStart;
varying float vAlong;
varying vec2 vCorner;
varying vec3 vLoc;
varying vec3 vVd;
void main() {
  float on = smoothstep(0.3, 0.8, lbNightAt(uBeamPos)) * clamp((lbRevealClock - uStart) / 0.8, 0.0, 1.0);
  float a;
  if (vAlong < 0.0) {
    float g = max(0.0, 1.0 - length(vCorner));
    a = g * g * 0.8;
  } else {
    float s = clamp(vAlong, 0.0, 1.0);
    // Cross-section coordinates (the ellipse mapped to the unit circle) and the eye direction in
    // the same space: u = how far off the axis this wall point lies as the eye sees it.
    vec2 c = vec2(vLoc.y / 0.6, vLoc.z) / (${END_R.toFixed(2)} * max(abs(vLoc.x) / ${LENGTH.toFixed(1)}, 1e-3));
    vec3 vd = normalize(vVd);
    vec2 v2 = vec2(vd.y / 0.6, vd.z);
    float lv = length(v2);
    float u = clamp(abs(c.x * v2.y - c.y * v2.x) / max(lv, 1e-4), 0.0, 1.0);
    float th = mix(1.0, pow(1.0 - u * u, 2.0), smoothstep(0.05, 0.35, lv));
    a = 0.17 * pow(1.0 - pow(s, 0.7), 1.3) * th * smoothstep(0.0, 0.05, s);
  }
  a *= on;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.0, 0.8, 0.45), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
    }),
  );
  const mesh = new Mesh(geo, mat);
  mesh.name = 'lighthouse beam';
  mesh.matrixAutoUpdate = false;
  composeUp(mesh.matrix, x, y, z, up.x, up.y, up.z, 0, 1, 1);
  mesh.matrixWorldNeedsUpdate = true;
  mesh.layers.set(LAYER_NO_INK);
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  ctx.scene.add(mesh);
  return {
    reveal(start: number) {
      uStart.value = start;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
