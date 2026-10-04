// Three-level puff LOD with cluster culling (A3). Every visible puff is drawn once, by the NEAR mesh
// (a smooth sphere: the camera flies through these, and their cotton lumps need vertices), the FAR
// mesh (a modest sphere) or the TINY mesh (12×8: beyond ~160 m a puff is a few dozen pixels).
// Whole clusters are culled first: below the planet's horizon or outside the view frustum (their
// bounding sphere, inflated for lumps and breathing). The survivors are compacted to the front of
// the instance buffers, which are rewritten only when the visible set or a puff's level changes
// (with hysteresis) and uploaded only up to the used count. All three meshes share one material.

import { type BufferGeometry, Frustum, InstancedBufferAttribute, InstancedMesh, type Material, Matrix4, type PerspectiveCamera, Sphere, Vector3 } from 'three';

/** Enter the near set closer than this (m from the puff's surface), leave beyond OUT. */
const NEAR_IN = 70;
const NEAR_OUT = 82;
/** Enter the tiny set beyond this, leave closer than BACK. */
const TINY_IN = 165;
const TINY_BACK = 150;
const LEVELS = 3; // 0 near, 1 far, 2 tiny

export interface ClusterBounds {
  /** Bounding sphere in the cloud frame: centre x, y, z and radius, per cluster. */
  spheres: Float32Array;
  /** Per puff: its cluster index. */
  of: Uint16Array;
}

export class PuffLod {
  /** [near, far, tiny]. */
  readonly meshes: InstancedMesh[];
  private readonly n: number;
  private readonly centres: Float32Array; // x, y, z, r per puff (cloud frame)
  private readonly mat: Float32Array; // 16 per puff
  private readonly attrs: Array<{ src: Float32Array; dst: InstancedBufferAttribute[] }> = [];
  readonly reveal: Float32Array; // 1 per puff (write, then call refresh())
  private readonly revealAttr: InstancedBufferAttribute[] = [];
  private readonly level: Uint8Array;
  private readonly bounds: ClusterBounds;
  private readonly nc: number;
  /** Per cluster: 1 if visible this frame. */
  readonly clusterVisible: Uint8Array;
  private readonly prevVisible: Uint8Array;
  private dirty = true;
  private readonly frustum = new Frustum();
  private readonly pv = new Matrix4();
  private readonly sphere = new Sphere();
  /** The near level's puffs, sorted front to back each frame (early-z: overlapping puffs right at
   *  the eye cost far less fill), and their distances. */
  private readonly nearIdx: Uint16Array;
  private readonly nearDist: Float32Array;
  private readonly prevNear: Uint16Array;
  private nNear = 0;
  private prevNNear = -1;

  constructor(geos: BufferGeometry[], material: Material, centres: Float32Array, attrs: Record<string, Float32Array>, bounds: ClusterBounds, nearMax: number) {
    this.n = centres.length / 4;
    this.centres = centres;
    this.bounds = bounds;
    this.nc = bounds.spheres.length / 4;
    this.clusterVisible = new Uint8Array(this.nc).fill(1);
    this.prevVisible = new Uint8Array(this.nc);
    this.reveal = new Float32Array(this.n).fill(1e9);
    this.level = new Uint8Array(this.n).fill(1);
    this.mat = new Float32Array(this.n * 16);
    for (let i = 0; i < this.n; i++) {
      const r = centres[i * 4 + 3];
      const o = i * 16;
      this.mat[o] = r;
      this.mat[o + 5] = r;
      this.mat[o + 10] = r;
      this.mat[o + 12] = centres[i * 4];
      this.mat[o + 13] = centres[i * 4 + 1];
      this.mat[o + 14] = centres[i * 4 + 2];
      this.mat[o + 15] = 1;
    }
    const caps = [Math.max(1, nearMax), this.n, this.n];
    this.nearIdx = new Uint16Array(caps[0]);
    this.nearDist = new Float32Array(caps[0]);
    this.prevNear = new Uint16Array(caps[0]);
    this.meshes = geos.map((g, k) => new InstancedMesh(g, material, caps[k]));
    for (const [name, src] of Object.entries(attrs)) {
      const dst = geos.map((g, k) => {
        const a = new InstancedBufferAttribute(new Float32Array(caps[k] * 4), 4);
        g.setAttribute(name, a);
        return a;
      });
      this.attrs.push({ src, dst });
    }
    geos.forEach((g, k) => {
      const a = new InstancedBufferAttribute(new Float32Array(caps[k]), 1);
      g.setAttribute('aReveal', a);
      this.revealAttr.push(a);
    });
    const names = ['clouds:near', 'clouds', 'clouds:tiny'];
    this.meshes.forEach((m, k) => {
      m.castShadow = false;
      m.receiveShadow = false;
      m.matrixAutoUpdate = false;
      m.frustumCulled = false; // culled per cluster here
      m.name = names[k];
    });
    this.write();
  }

  /** Re-upload after the reveal delays change. */
  refresh() {
    this.dirty = true;
  }

  /**
   * Cull clusters and update the levels for an eye at `eyeLocal` (cloud frame), then rewrite the
   * buffers if anything changed. `drift` maps the cloud frame to the world (the meshes' matrix).
   * Zero allocation.
   */
  update(eyeLocal: Vector3, camera: PerspectiveCamera, drift: Matrix4, R: number) {
    // Clusters: horizon + frustum.
    camera.updateMatrixWorld();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const s = this.bounds.spheres;
    const e = eyeLocal.length();
    const horizonEye = Math.acos(Math.min(1, R / e));
    let visChanged = false;
    for (let k = 0; k < this.nc; k++) {
      const cx = s[k * 4];
      const cy = s[k * 4 + 1];
      const cz = s[k * 4 + 2];
      const rho = s[k * 4 + 3] * 1.2 + 2;
      const rc = Math.hypot(cx, cy, cz);
      const cosA = (eyeLocal.x * cx + eyeLocal.y * cy + eyeLocal.z * cz) / (e * rc);
      const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
      let vis = ang < horizonEye + Math.acos(Math.min(1, R / (rc + rho))) + rho / rc;
      if (vis) {
        this.sphere.center.set(cx, cy, cz).applyMatrix4(drift);
        this.sphere.radius = rho;
        vis = this.frustum.intersectsSphere(this.sphere);
      }
      const v = vis ? 1 : 0;
      this.prevVisible[k] = this.clusterVisible[k];
      this.clusterVisible[k] = v;
      if (v !== this.prevVisible[k]) visChanged = true;
    }

    // Levels (hysteresis), for puffs of visible clusters.
    const c = this.centres;
    let changed = visChanged;
    let nNear = 0;
    const cap = this.meshes[0].instanceMatrix.count;
    const of = this.bounds.of;
    for (let i = 0; i < this.n; i++) {
      if (this.clusterVisible[of[i]] === 0) continue;
      const dx = eyeLocal.x - c[i * 4];
      const dy = eyeLocal.y - c[i * 4 + 1];
      const dz = eyeLocal.z - c[i * 4 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - c[i * 4 + 3];
      const was = this.level[i];
      let now: number;
      if (was === 0) now = d < NEAR_OUT ? 0 : d > TINY_IN ? 2 : 1;
      else if (was === 2) now = d < NEAR_IN ? 0 : d < TINY_BACK ? 1 : 2;
      else now = d < NEAR_IN ? 0 : d > TINY_IN ? 2 : 1;
      if (now === 0 && nNear >= cap) now = 1;
      if (now === 0) {
        // Insertion into the front-to-back list (≤ 64 entries).
        let j = nNear++;
        while (j > 0 && this.nearDist[j - 1] > d) {
          this.nearDist[j] = this.nearDist[j - 1];
          this.nearIdx[j] = this.nearIdx[j - 1];
          j--;
        }
        this.nearDist[j] = d;
        this.nearIdx[j] = i;
      }
      if (now !== was) {
        this.level[i] = now;
        changed = true;
      }
    }
    this.nNear = nNear;
    if (changed || this.dirty) this.write();
    else {
      // Same set: re-upload the near level only if its depth order changed.
      let reorder = nNear !== this.prevNNear;
      for (let k = 0; !reorder && k < nNear; k++) reorder = this.nearIdx[k] !== this.prevNear[k];
      if (reorder) this.writeLevel0();
    }
  }

  /** Write the near level in front-to-back order. */
  private writeLevel0() {
    const n = this.nNear;
    const m = this.meshes[0].instanceMatrix.array as Float32Array;
    const rev = this.revealAttr[0].array as Float32Array;
    for (let j = 0; j < n; j++) {
      const i = this.nearIdx[j];
      for (let e = 0; e < 16; e++) m[j * 16 + e] = this.mat[i * 16 + e];
      for (const a of this.attrs) {
        const dst = a.dst[0].array as Float32Array;
        for (let e = 0; e < 4; e++) dst[j * 4 + e] = a.src[i * 4 + e];
      }
      rev[j] = this.reveal[i];
      this.prevNear[j] = i;
    }
    this.prevNNear = n;
    const mesh = this.meshes[0];
    mesh.count = n;
    mesh.visible = n > 0;
    if (n === 0) return;
    upload(mesh.instanceMatrix, n);
    for (const a of this.attrs) upload(a.dst[0], n);
    upload(this.revealAttr[0], n);
  }

  private write() {
    this.dirty = false;
    const counts = [0, 0, 0];
    const mats = this.meshes.map((m) => m.instanceMatrix.array as Float32Array);
    const revs = this.revealAttr.map((a) => a.array as Float32Array);
    const mat = this.mat;
    const of = this.bounds.of;
    for (let i = 0; i < this.n; i++) {
      if (this.clusterVisible[of[i]] === 0) continue;
      const L = this.level[i];
      if (L === 0) continue; // the near level is written sorted, below
      const j = counts[L]++;
      const m = mats[L];
      for (let e = 0; e < 16; e++) m[j * 16 + e] = mat[i * 16 + e];
      for (const a of this.attrs) {
        const dst = a.dst[L].array as Float32Array;
        for (let e = 0; e < 4; e++) dst[j * 4 + e] = a.src[i * 4 + e];
      }
      revs[L][j] = this.reveal[i];
    }
    this.writeLevel0();
    for (let L = 1; L < LEVELS; L++) {
      const mesh = this.meshes[L];
      const n = counts[L];
      mesh.count = n;
      mesh.visible = n > 0;
      if (n === 0) continue;
      upload(mesh.instanceMatrix, n);
      for (const a of this.attrs) upload(a.dst[L], n);
      upload(this.revealAttr[L], n);
    }
  }

  /** Apply the drift (the same rotation matrix for every level). */
  setMatrix(m: Matrix4) {
    for (const mesh of this.meshes) {
      mesh.matrix.copy(m);
      mesh.matrixWorld.copy(m);
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
  }
}

/** Flag an instanced attribute for upload, only up to the used count. */
function upload(a: InstancedBufferAttribute, count: number) {
  a.clearUpdateRanges();
  a.addUpdateRange(0, count * a.itemSize);
  a.needsUpdate = true;
}
