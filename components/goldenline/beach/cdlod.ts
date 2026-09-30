// Camera-centred continuous LOD terrain (CDLOD, Strugar 2010) over land and the visible seabed.
//
// Every draw is one instanced "quarter patch" (QUADS x QUADS quads). A quadtree node of level l
// has edge S0 * 2^l and is drawn as four quarters (or fewer, when some of its children are drawn
// finer). Vertices morph toward the next-coarser grid over the last 20% of each level's range,
// using a distance that is a pure function of world XZ (plus one per-frame constant), so shared
// edges between levels always agree: no cracks, no popping, no T-junctions.
//
// Selection runs on the CPU each frame with no allocation and writes a preallocated instance
// buffer; one draw call covers the whole terrain.

import {
  Box3,
  BufferAttribute,
  DynamicDrawUsage,
  Frustum,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  type PerspectiveCamera,
} from 'three/webgpu';

/** Quads per quarter-patch edge (a full node is 2 * QUADS quads across). */
export const QUADS = 16;
/** Level-0 node edge (m). Vertex spacing near the camera = S0 / (2 * QUADS) = 3.1 cm, about the
 * surface-state sand texel, so footprints are real geometry under the player's feet. */
export const S0 = 1;
/**
 * Range multiplier: level l covers distances up to RANGE_K * S0 * 2^l. Crack-free needs a level-l
 * node (diagonal √2·S) to end before the next level starts morphing:
 * K + √2 < 2·MORPH_START·K, i.e. K > √2 / (2·MORPH_START − 1) = 2.02 for MORPH_START 0.85.
 */
export const RANGE_K = 2.5;
/** Morph starts at this fraction of a level's range (see RANGE_K). */
export const MORPH_START = 0.85;
export const MORPH_END = 0.97;
export const LEVELS = 12; // 0..11, root edge 2048 m
const ROOT = S0 * 2 ** (LEVELS - 1);
/** Root grid origin and counts: x ∈ [-1536, 512], z ∈ [-2048, 2048]. */
const ROOT_X0 = -1536;
const ROOT_Z0 = -2048;
const ROOTS_X = 1;
const ROOTS_Z = 2;
const MAX_INSTANCES = 8192;
/** Nodes nearer than this are drawn even outside the view frustum (shadow casters). */
const ALWAYS_R = 40;
const Y_MIN = -45;
const Y_MAX = 45;

export function createPatchGeometry() {
  const n = QUADS + 1;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3;
      pos[o] = i; // grid index; the vertex shader scales it
      pos[o + 1] = 0;
      pos[o + 2] = j;
    }
  }
  const idx = new Uint16Array(QUADS * QUADS * 6);
  let k = 0;
  for (let j = 0; j < QUADS; j++) {
    for (let i = 0; i < QUADS; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Alternate the diagonal so the grid has no directional bias.
      if ((i + j) & 1) {
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      } else {
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
  }
  const geo = new InstancedBufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  const inst = new InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 4), 4);
  inst.setUsage(DynamicDrawUsage);
  geo.setAttribute('iPatch', inst);
  geo.instanceCount = 0;
  return { geo, inst };
}

export class CdlodSelector {
  count = 0;
  /** Camera height above the terrain (m), the constant vertical term of the LOD distance. */
  camH = 0;
  private cx = 0;
  private cz = 0;
  private readonly ranges = new Float64Array(LEVELS);
  private readonly frustum = new Frustum();
  private readonly box = new Box3();
  private readonly m = new Matrix4();
  private readonly data: Float32Array;
  private readonly range = { start: 0, count: 0 };
  private cull = true;

  constructor(private readonly attr: InstancedBufferAttribute, private readonly geo: InstancedBufferGeometry) {
    this.data = attr.array as Float32Array;
    for (let l = 0; l < LEVELS; l++) this.ranges[l] = RANGE_K * S0 * 2 ** l;
  }

  /** Change the range multiplier (keep it ≥ ~2.05; see RANGE_K). */
  setRangeK(k: number) {
    for (let l = 0; l < LEVELS; l++) this.ranges[l] = k * S0 * 2 ** l;
  }

  update(camera: PerspectiveCamera, groundY: number, cull: boolean) {
    camera.updateMatrixWorld();
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m);
    this.cull = cull;
    this.cx = camera.position.x;
    this.cz = camera.position.z;
    this.camH = Math.abs(camera.position.y - groundY);
    this.count = 0;
    for (let rz = 0; rz < ROOTS_Z; rz++) {
      for (let rx = 0; rx < ROOTS_X; rx++) this.select(ROOT_X0 + rx * ROOT, ROOT_Z0 + rz * ROOT, ROOT, LEVELS - 1);
    }
    this.geo.instanceCount = this.count;
    // Upload only the used prefix (no allocation: reuse one range object).
    this.range.start = 0;
    this.range.count = this.count * 4;
    this.attr.updateRanges.length = 0;
    this.attr.updateRanges.push(this.range);
    this.attr.needsUpdate = true;
  }

  private dist(x0: number, z0: number, size: number) {
    const dx = this.cx < x0 ? x0 - this.cx : this.cx > x0 + size ? this.cx - x0 - size : 0;
    const dz = this.cz < z0 ? z0 - this.cz : this.cz > z0 + size ? this.cz - z0 - size : 0;
    return Math.sqrt(dx * dx + dz * dz + this.camH * this.camH);
  }

  private visible(x0: number, z0: number, size: number, d: number) {
    if (!this.cull || d < ALWAYS_R) return true;
    this.box.min.set(x0, Y_MIN, z0);
    this.box.max.set(x0 + size, Y_MAX, z0 + size);
    return this.frustum.intersectsBox(this.box);
  }

  /** Returns false when the node lies outside this level's range (the parent draws it). */
  private select(x0: number, z0: number, size: number, level: number): boolean {
    const d = this.dist(x0, z0, size);
    if (d > this.ranges[level]) return false;
    if (!this.visible(x0, z0, size, d)) return true;
    const h = size * 0.5;
    if (level === 0 || this.dist(x0, z0, size) > this.ranges[level - 1]) {
      this.add(x0, z0, h, level);
      this.add(x0 + h, z0, h, level);
      this.add(x0, z0 + h, h, level);
      this.add(x0 + h, z0 + h, h, level);
      return true;
    }
    if (!this.select(x0, z0, h, level - 1)) this.add(x0, z0, h, level);
    if (!this.select(x0 + h, z0, h, level - 1)) this.add(x0 + h, z0, h, level);
    if (!this.select(x0, z0 + h, h, level - 1)) this.add(x0, z0 + h, h, level);
    if (!this.select(x0 + h, z0 + h, h, level - 1)) this.add(x0 + h, z0 + h, h, level);
    return true;
  }

  private add(x0: number, z0: number, quarter: number, level: number) {
    if (this.count >= MAX_INSTANCES) return;
    const o = this.count * 4;
    this.data[o] = x0;
    this.data[o + 1] = z0;
    this.data[o + 2] = quarter / QUADS; // cell size (m)
    this.data[o + 3] = level;
    this.count++;
  }
}
