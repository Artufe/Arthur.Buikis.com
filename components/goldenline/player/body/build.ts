// Turns a LimbModel into a skinned BufferGeometry plus its bind skeleton. Runs once at boot.

import { Bone, BufferAttribute, BufferGeometry, Matrix4, Quaternion, Skeleton, Vector3 } from 'three/webgpu';
import type { LimbModel } from './models';
import { Field, meshField, partDist, skinWeights, thicknessAt } from './sdf';
import { basisQuat } from '../rigmath';

export interface BuiltLimb {
  geometry: BufferGeometry;
  skeleton: Skeleton;
  bones: Bone[];
  /** Bind world matrices, for posing relative to the bind frame. */
  bind: Matrix4[];
  ms: number;
}

const _q = new Quaternion();
const _v = new Vector3();
const _w = new Vector3();
const _s = new Vector3(1, 1, 1);

/**
 * Build a limb. With `mirrorOf`, the geometry is the Z-mirror of an already-built opposite
 * limb (same weights and attributes) and only the skeleton comes from `model`.
 */
export function buildLimb(model: LimbModel, mirrorOf?: BuiltLimb, prebuilt?: BufferGeometry): BuiltLimb {
  const t0 = performance.now();
  if (mirrorOf) return mirrorLimb(model, mirrorOf, t0);
  // [polish] The geometry meshed in a boot worker (core/bakes.ts); only the skeleton is built here.
  if (prebuilt) return { geometry: prebuilt, ...buildSkeleton(model), ms: performance.now() - t0 };
  const { parts } = model;
  const lo = [1e9, 1e9, 1e9];
  const hi = [-1e9, -1e9, -1e9];
  for (const j of model.jobs)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], j.min[a]);
      hi[a] = Math.max(hi[a], j.max[a]);
    }
  const field = new Field(parts, lo, hi);
  const chunks = model.jobs.map((j) => meshField(field, j.min, j.max, j.h, j.clip));
  let count = 0;
  let icount = 0;
  for (const c of chunks) {
    count += c.count;
    icount += c.indices.length;
  }
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const indices = new Uint32Array(icount);
  let vo = 0;
  let io = 0;
  for (const c of chunks) {
    positions.set(c.positions, vo * 3);
    normals.set(c.normals, vo * 3);
    for (let i = 0; i < c.indices.length; i++) indices[io + i] = c.indices[i] + vo;
    vo += c.count;
    io += c.indices.length;
  }

  const boneCount = model.bones.length;
  const { skinIndex, skinWeight } = skinWeights(parts, positions, count, boneCount);

  // aux: x = thinness (SSS), y = nail, z = knuckle-crease mask, w = crease axial coordinate (m).
  // aux2: x = fabric, y = volar (palm / sole).
  const aux = new Float32Array(count * 4);
  const aux2 = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const nx = normals[v * 3];
    const ny = normals[v * 3 + 1];
    const nz = normals[v * 3 + 2];
    const th = thicknessAt(field, x, y, z, nx, ny, nz, 0.05);
    aux[v * 4] = Math.exp(-th / 0.014);
    let nail = 0;
    let fabric = 0;
    let bestD = 1e9;
    let bestMat = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.op !== 0) continue;
      if (x < p.min[0] || y < p.min[1] || z < p.min[2] || x > p.max[0] || y > p.max[1] || z > p.max[2]) continue;
      const d = partDist(p, x, y, z);
      if (p.mat === 1) nail = Math.max(nail, smooth(0.0011, 0.0002, d));
      if (d < bestD) {
        bestD = d;
        bestMat = p.mat;
      }
    }
    if (bestMat === 2) fabric = 1;
    aux[v * 4 + 1] = nail;
    let crease = 0;
    let axial = 0;
    for (let c = 0; c < model.creases.length; c++) {
      const cr = model.creases[c];
      const dx = x - cr.p[0];
      const dy = y - cr.p[1];
      const dz = z - cr.p[2];
      const a = dx * cr.axis[0] + dy * cr.axis[1] + dz * cr.axis[2];
      const radial = Math.hypot(dx - cr.axis[0] * a, dy - cr.axis[1] * a, dz - cr.axis[2] * a);
      if (radial > 0.02) continue;
      const up = nx * cr.up[0] + ny * cr.up[1] + nz * cr.up[2];
      const m = Math.exp(-(a * a) / (0.0045 * 0.0045)) * smooth(0.05, 0.55, up);
      if (m > crease) {
        crease = m;
        axial = a;
      }
    }
    aux[v * 4 + 2] = crease;
    aux[v * 4 + 3] = axial;
    aux2[v * 2] = fabric;
    aux2[v * 2 + 1] = smooth(0.05, 0.6, -ny);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  geometry.setAttribute('aux', new BufferAttribute(aux, 4));
  geometry.setAttribute('aux2', new BufferAttribute(aux2, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  const sk = buildSkeleton(model);
  return { geometry, ...sk, ms: performance.now() - t0 };
}

function buildSkeleton(model: LimbModel) {
  const bones: Bone[] = [];
  const bind: Matrix4[] = [];
  const inverses: Matrix4[] = [];
  for (const b of model.bones) {
    const bone = new Bone();
    bone.name = b.name;
    bone.matrixAutoUpdate = false;
    bone.matrixWorldAutoUpdate = false;
    _v.set(b.x[0], b.x[1], b.x[2]);
    _w.set(b.y[0], b.y[1], b.y[2]);
    basisQuat(_v, _w, _q);
    const m = new Matrix4().compose(_v.set(b.head[0], b.head[1], b.head[2]), _q, _s);
    bone.matrixWorld.copy(m);
    bones.push(bone);
    bind.push(m);
    inverses.push(m.clone().invert());
  }
  return { skeleton: new Skeleton(bones, inverses), bones, bind };
}

function mirrorLimb(model: LimbModel, src: BuiltLimb, t0: number): BuiltLimb {
  const g = src.geometry;
  const geometry = new BufferGeometry();
  const pos = (g.getAttribute('position').array as Float32Array).slice();
  const nrm = (g.getAttribute('normal').array as Float32Array).slice();
  for (let i = 2; i < pos.length; i += 3) {
    pos[i] = -pos[i];
    nrm[i] = -nrm[i];
  }
  const idx = (g.index!.array as Uint32Array).slice();
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new BufferAttribute(nrm, 3));
  for (const name of ['skinIndex', 'skinWeight', 'aux', 'aux2']) geometry.setAttribute(name, g.getAttribute(name));
  geometry.setIndex(new BufferAttribute(idx, 1));
  geometry.computeBoundingSphere();
  const sk = buildSkeleton(model);
  return { geometry, ...sk, ms: performance.now() - t0 };
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
