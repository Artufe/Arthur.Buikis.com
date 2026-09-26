// Spatially chunked instancing for small, numerous props: instances are binned into square
// chunks, each its own InstancedMesh with a tight bounding sphere (so three frustum-culls it),
// and chunks beyond a draw distance are hidden per frame. Per-instance data: the transform plus
// `iOrigin` (vec3, for GPU re-seating on the rendered ground) and `iTint` (vec3).

import {
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
} from 'three/webgpu';

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

export class ChunkedInstances {
  readonly meshes: InstancedMesh[] = [];
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
    const bins = new Map<string, PropInstance[]>();
    for (const it of items) {
      const k = `${Math.floor(it.x / chunk)},${Math.floor(it.z / chunk)}`;
      let b = bins.get(k);
      if (!b) bins.set(k, (b = []));
      b.push(it);
    }
    this.cx = new Float32Array(bins.size);
    this.cz = new Float32Array(bins.size);
    const m4 = new Matrix4();
    const p = new Vector3();
    const s = new Vector3();
    let ci = 0;
    for (const list of bins.values()) {
      // Share the vertex/index buffers; only the per-instance attributes are per chunk.
      const g = new BufferGeometry();
      for (const key in base.attributes) g.setAttribute(key, base.attributes[key]);
      g.setIndex(base.index);
      const origin = new Float32Array(list.length * 3);
      const tint = new Float32Array(list.length * 3);
      const mesh = new InstancedMesh(g, material, list.length);
      let sx = 0;
      let sz = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        p.set(it.x, it.y, it.z);
        s.set(it.scale, it.scale * (it.sy ?? 1), it.scale);
        m4.compose(p, it.q, s);
        mesh.setMatrixAt(i, m4);
        origin[i * 3] = it.x;
        origin[i * 3 + 1] = it.y;
        origin[i * 3 + 2] = it.z;
        tint[i * 3] = it.tint[0];
        tint[i * 3 + 1] = it.tint[1];
        tint[i * 3 + 2] = it.tint[2];
        sx += it.x;
        sz += it.z;
      }
      g.setAttribute('iOrigin', new InstancedBufferAttribute(origin, 3));
      g.setAttribute('iTint', new InstancedBufferAttribute(tint, 3));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = name;
      this.cx[ci] = sx / list.length;
      this.cz[ci] = sz / list.length;
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
    for (const m of this.meshes) m.dispose();
    this.meshes.length = 0;
    this.geos.length = 0;
  }
}
