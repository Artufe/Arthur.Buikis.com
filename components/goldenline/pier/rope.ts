// Railing rope: three-strand laid manila, sun-bleached, sagging between the posts and hitched
// twice round each one. The strands are shading (a helical height field turned into normals and
// occlusion), so a 2.7 cm rope holds up at arm's length without millions of triangles.

import { type BufferGeometry, InstancedBufferAttribute, MeshPhysicalNodeMaterial } from 'three/webgpu';
import {
  Fn,
  positionPrevious,
  float,
  fract,
  instancedBufferAttribute,
  mix as mix_,
  normalMap,
  normalize,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  texture as texture_,
  uv,
  vec2 as vec2_,
  vec3 as vec3_,
  vec4,
  cos,
} from 'three/tsl';
import { tubeGeometry } from './geometry';
import { ROPE } from './plan';
import type { TSLNode } from '../core/contracts';
import type { PierUniforms } from './shade';
import type { PierTextures } from './textures';

// The TSL typings reject mixed node/number args that TSL itself accepts; loosen locally.
const mix = mix_ as unknown as (...a: unknown[]) => TSLNode;
const texture = texture_ as unknown as (...a: unknown[]) => TSLNode;
const vec2 = vec2_ as unknown as (...a: unknown[]) => TSLNode;
const vec3 = vec3_ as unknown as (...a: unknown[]) => TSLNode;

/** Straight unit-length rope along +X; the instance matrix sets span and direction, sag is per instance. */
export function ropeSpanGeometry(): BufferGeometry {
  const pts: number[] = [];
  const seg = 14;
  for (let i = 0; i <= seg; i++) pts.push(i / seg, 0, 0);
  return tubeGeometry(pts, ROPE.r, 7);
}

/**
 * A whipping: `turns` tight turns of thinner line round a rail of half-extents (hz, hy),
 * axis along X, centred on the origin. Rounded-rectangle path so it hugs the rail's faces.
 */
export function whipGeometry(hz: number, hy: number, turns = 7): BufferGeometry {
  const pts: number[] = [];
  const r = ROPE.r * 0.62;
  const seg = turns * 12;
  const pitch = r * 2.05;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = t * turns * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // Superellipse (n = 6): flat along the rail's faces, rounded over its arrises.
    const z = Math.sign(c) * Math.abs(c) ** (1 / 3) * (hz + r * 0.9);
    const y = Math.sign(s) * Math.abs(s) ** (1 / 3) * (hy + r * 0.9);
    pts.push((t - 0.5) * pitch * turns, y, z);
  }
  return tubeGeometry(pts, r, 5);
}

export function createRopeMaterial(tex: PierTextures, u: PierUniforms, inst: InstancedBufferAttribute, isSpan: boolean) {
  const m = new MeshPhysicalNodeMaterial();
  const a: TSLNode = instancedBufferAttribute(inst, 'vec4'); // sag (m), length (m), seed, wetness
  const uv0 = uv();
  const vm = isSpan ? uv0.y.mul(a.y) : uv0.y; // metres along
  // Three strands, ~9 cm lay: the strand phase runs diagonally round the rope.
  const phase = fract(uv0.x.mul(3).add(vm.mul(3 / 0.09)).add(a.z));
  const prof = sin(phase.mul(Math.PI));
  const slope = cos(phase.mul(Math.PI));
  const fib = texture(tex.noise, vec2(uv0.x.mul(3).add(vm.mul(33.3)), vm.mul(6).sub(uv0.x.mul(0.4)))).a;
  const fib2 = texture(tex.noise, vec2(uv0.x.mul(9), vm.mul(90))).b;
  const nT = normalize(vec3(slope.mul(-0.85), slope.mul(-0.9), 1).add(vec3(fib2.sub(0.5).mul(0.5), fib.sub(0.5).mul(0.3), 0)));
  const groove = smoothstep(0.0, 0.35, prof);
  const bleach = texture(tex.noise, vec2(vm.mul(0.21), a.z)).r;
  const manila = mix(vec3(0.2, 0.15, 0.09), vec3(0.23, 0.215, 0.19), bleach.mul(0.7).add(0.2));
  const col = manila.mul(groove.mul(0.55).add(0.45)).mul(fib.mul(0.35).add(0.8)).mul(float(1).sub(a.w.mul(0.45)));
  m.colorNode = vec4(col, 1);
  m.roughnessNode = mix(float(0.92), float(0.55), a.w);
  m.normalNode = normalMap(nT.mul(0.5).add(0.5));
  m.aoNode = groove.mul(0.6).add(0.4);
  m.sheenNode = vec3(0.5, 0.42, 0.3).mul(0.25);
  m.sheenRoughnessNode = float(0.6);
  if (isSpan) {
    // Catenary sag (a parabola is indistinguishable at this span/sag ratio).
    const t = positionGeometry.x;
    // Static displacement: tell the velocity pass (TRAA / motion blur) it doesn't move.
    m.positionNode = Fn(() => {
      const p = positionLocal.sub(vec3(0, a.x.mul(t.mul(float(1).sub(t)).mul(4)), 0));
      positionPrevious.assign(p);
      return p;
    })();
  }
  void u;
  return m;
}

export function ropeInstanceData(count: number) {
  return new InstancedBufferAttribute(new Float32Array(count * 4), 4);
}
