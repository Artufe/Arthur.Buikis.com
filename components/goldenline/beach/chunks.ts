// Spatially chunked instancing for small, numerous props: instances are binned into square
// chunks, each its own mesh with a tight bounding sphere (so three frustum-culls it), and
// chunks beyond a draw distance are hidden per frame. Per-instance data: the affine transform
// (`iM0..iM2`, its three rows), `iOrigin` (vec3, for GPU re-seating on the rendered ground)
// and `iTint` (vec3).
//
// [polish] Chunks are plain Meshes on an InstancedBufferGeometry, transformed in the vertex
// stage from the per-instance rows, not InstancedMeshes: three keys every InstancedMesh's node
// build and pipeline by its uuid, so 500 chunks meant ~1,000 shader builds (12 s of startup).
// With the transform in plain named attributes, every chunk of a set shares one build.

import {
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  Quaternion,
  Sphere,
  Vector3,
  type Material,
} from 'three/webgpu';
import { Fn, attribute, mat3, normalLocal, positionLocal, vec3, vec4 } from 'three/tsl';

export interface PropInstance {
  x: number;
  y: number;
  z: number;
  /** Rotation (applied as given). */
  q: Quaternion;
  scale: number;
  /** Non-uniform extra vertical scale. */
  sy?: number;
  tint: [number, number, number];
}

const wrapped = new WeakSet<Material>();

/** Prepend the per-instance transform to the material's vertex stage (once per material). */
function instanced(material: Material) {
  if (wrapped.has(material)) return;
  wrapped.add(material);
  const m = material as Material & { positionNode: unknown };
  const inner = m.positionNode;
  m.positionNode = Fn(() => {
    const r0 = attribute('iM0', 'vec4');
    const r1 = attribute('iM1', 'vec4');
    const r2 = attribute('iM2', 'vec4');
    const p = vec4(positionLocal, 1);
    positionLocal.assign(vec3(r0.dot(p), r1.dot(p), r2.dot(p)));
    // Normal by the inverse transpose: M·(n / diag(MᵀM)) for M = R·S (as three's instancing does).
    const c0 = vec3(r0.x, r1.x, r2.x);
    const c1 = vec3(r0.y, r1.y, r2.y);
    const c2 = vec3(r0.z, r1.z, r2.z);
    const n = normalLocal.div(vec3(c0.dot(c0), c1.dot(c1), c2.dot(c2)));
    normalLocal.assign(mat3(c0, c1, c2).mul(n));
    return inner ? (inner as typeof positionLocal) : positionLocal;
  })();
}

export class ChunkedInstances {
  readonly meshes: Mesh[] = [];
  private readonly cx: Float32Array;
  private readonly cz: Float32Array;
  private readonly geos: BufferGeometry[] = [];

  constructor(
    name: string,
    base: BufferGeometry,
    material: Material,
    items: PropInstance[],
    chunk: number,
    private readonly drawDist: number,
    castShadow: boolean,
  ) {
    instanced(material);
    const bins = new Map<string, PropInstance[]>();
    for (const it of items) {
      const k = `${Math.floor(it.x / chunk)},${Math.floor(it.z / chunk)}`;
      let b = bins.get(k);
      if (!b) bins.set(k, (b = []));
      b.push(it);
    }
    this.cx = new Float32Array(bins.size);
    this.cz = new Float32Array(bins.size);
    if (!base.boundingSphere) base.computeBoundingSphere();
    const baseR = base.boundingSphere!.radius + base.boundingSphere!.center.length();
    const m4 = new Matrix4();
    const p = new Vector3();
    const s = new Vector3();
    let ci = 0;
    for (const list of bins.values()) {
      // Share the vertex/index buffers; only the per-instance attributes are per chunk.
      const g = new InstancedBufferGeometry();
      for (const key in base.attributes) g.setAttribute(key, base.attributes[key]);
      g.setIndex(base.index);
      g.instanceCount = list.length;
      const rows = [new Float32Array(list.length * 4), new Float32Array(list.length * 4), new Float32Array(list.length * 4)];
      const origin = new Float32Array(list.length * 3);
      const tint = new Float32Array(list.length * 3);
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        p.set(it.x, it.y, it.z);
        s.set(it.scale, it.scale * (it.sy ?? 1), it.scale);
        m4.compose(p, it.q, s);
        const e = m4.elements; // column-major
        for (let r = 0; r < 3; r++) {
          rows[r][i * 4] = e[r];
          rows[r][i * 4 + 1] = e[4 + r];
          rows[r][i * 4 + 2] = e[8 + r];
          rows[r][i * 4 + 3] = e[12 + r];
        }
        origin[i * 3] = it.x;
        origin[i * 3 + 1] = it.y;
        origin[i * 3 + 2] = it.z;
        tint[i * 3] = it.tint[0];
        tint[i * 3 + 1] = it.tint[1];
        tint[i * 3 + 2] = it.tint[2];
        sx += it.x;
        sy += it.y;
        sz += it.z;
      }
      g.setAttribute('iM0', new InstancedBufferAttribute(rows[0], 4));
      g.setAttribute('iM1', new InstancedBufferAttribute(rows[1], 4));
      g.setAttribute('iM2', new InstancedBufferAttribute(rows[2], 4));
      g.setAttribute('iOrigin', new InstancedBufferAttribute(origin, 3));
      g.setAttribute('iTint', new InstancedBufferAttribute(tint, 3));
      const c = new Vector3(sx / list.length, sy / list.length, sz / list.length);
      let rad = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const d = Math.hypot(it.x - c.x, it.y - c.y, it.z - c.z) + baseR * it.scale * Math.max(1, it.sy ?? 1);
        if (d > rad) rad = d;
      }
      // Headroom for the GPU re-seating on the rendered ground and wind sway.
      g.boundingSphere = new Sphere(c, rad + 0.5);
      const mesh = new Mesh(g, material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = name;
      this.cx[ci] = c.x;
      this.cz[ci] = c.z;
      this.meshes.push(mesh);
      this.geos.push(g);
      ci++;
    }
  }

  /** Hide chunks beyond the draw distance (zero-alloc). `enabled` gates the whole set. */
  update(camX: number, camZ: number, enabled: boolean) {
    const d2 = this.drawDist * this.drawDist;
    for (let i = 0; i < this.meshes.length; i++) {
      const dx = this.cx[i] - camX;
      const dz = this.cz[i] - camZ;
      this.meshes[i].visible = enabled && dx * dx + dz * dz < d2;
    }
  }

  dispose() {
    // Disposing a chunk geometry releases the shared buffers too; the backend ignores repeats.
    for (const g of this.geos) g.dispose();
    this.meshes.length = 0;
    this.geos.length = 0;
  }
}
