// The scene objects that draw the thing the camera follows (v2, S1f), which the clouds draw again on
// top of their falling-through-the-clouds overlay (clouds/index.ts redrawSubject).
//
// Declared objects win: `Trackable.objects`, or the camera's `subjectObjects()` (the bird). Without
// them, a scan of the scene finds the opaque mesh (or instanced mesh) with an instance or centre at
// the subject's pose, plus any other with one at the same point (a body drawn in parts).
//
// When it scans is counted in FRAMES, never wall time (in shot mode sim time outruns the wall clock,
// and a wall-clock throttle left a bird popping in unfound for a whole crossing):
//   - at once when the subject changes, or one of its objects leaves the scene or is hidden;
//   - while nothing is found: every frame when `urgent` (an episode runs, or one may start: the eye
//     or the subject near the cloud layer), else every IDLE_EVERY frames (a bird still popping in, a
//     car whose LOD is hidden at this altitude);
//   - found by a scan: once more CONFIRM_AFTER frames later (a fleet packs its near and far LOD meshes
//     on its own update: on the first frame a car is often only in the far pack, whose fragments are
//     dithered away up close, and re-drawing it alone drew a speck), then every RECHECK_EVERY frames
//     while urgent (a walker or a car moves between LOD meshes as the camera nears it).
// Zero allocation except while scanning.

import type { InstancedMesh, Mesh, Object3D, Vector3 } from 'three';
import { Matrix4, Vector3 as V3 } from 'three';

/** Nothing found: scan again this often (frames) when nothing is urgent. */
export const IDLE_EVERY = 6;
/** Found by a scan: check again this often (frames) while urgent. */
export const RECHECK_EVERY = 15;
/** …and once, this many frames after a fresh find (its owner may not have packed every LOD yet). */
export const CONFIRM_AFTER = 2;

export interface ScanOptions {
  /** An instance or mesh centre within this of the pose (m) counts. */
  reach: number;
  /** Instanced meshes with more instances than this are never it (ground cover, forests). */
  maxInstances: number;
  /** Meshes never to consider (the overlay's own, the puffs). */
  skip?: (m: Mesh) => boolean;
}

export class SubjectObjects {
  /** The objects found (or declared). Do not mutate. */
  readonly objects: Object3D[] = [];
  /** The subject they draw ('' none). */
  key = '';
  /** Found by a scan (not declared). */
  scanned = false;
  /** Frames since the last scan. */
  private age = 0;
  /** A fresh find not yet scanned again (CONFIRM_AFTER). */
  private fresh = false;
  private readonly inv = new Matrix4();
  private readonly local = new V3();
  private readonly found: Array<{ o: Object3D; d: number }> = [];

  clear(): void {
    this.objects.length = 0;
    this.key = '';
    this.scanned = false;
    this.age = 0;
    this.fresh = false;
  }

  /** True when at least one found object is drawn (visible itself, in the scene). */
  get drawn(): boolean {
    for (const o of this.objects) if (o.visible && o.parent) return true;
    return false;
  }

  /**
   * Once a frame while a subject is followed. `declared`: its owner's objects, if any. `pos`, `radius`:
   * its centre and bounding radius now. `urgent`: an episode runs or may start (scan every frame
   * while nothing is found).
   */
  update(scene: Object3D, key: string, declared: readonly Object3D[] | undefined, pos: Vector3, radius: number, urgent: boolean, opts: ScanOptions): void {
    if (key !== this.key) {
      this.clear();
      this.key = key;
    } else {
      this.age++;
      if (!this.scanned && this.objects.length > 0) {
        // Declared: keep them while they stay in the scene (re-read if the owner swapped them).
        if (declared && declared.length && declared[0] === this.objects[0] && this.objects.every((o) => o.parent)) return;
      } else if (this.objects.length > 0 && this.drawn && this.objects.every((o) => o.parent)) {
        if (this.fresh ? this.age < CONFIRM_AFTER : !urgent || this.age < RECHECK_EVERY) return;
      } else if (this.objects.length === 0 && !urgent && this.age < IDLE_EVERY) return;
    }
    this.age = 0;
    this.objects.length = 0;
    this.scanned = false;
    if (!key) return;
    if (declared && declared.length) {
      this.objects.push(...declared);
      this.fresh = false;
      return;
    }
    this.scanned = true;
    const again = this.fresh;
    this.scan(scene, pos, radius, opts);
    this.fresh = !again && this.objects.length > 0;
  }

  private scan(scene: Object3D, pos: Vector3, radius: number, opts: ScanOptions): void {
    const reach = opts.reach + radius * 0.8;
    const found = this.found;
    found.length = 0;
    const { inv, local } = this;
    scene.traverseVisible((o) => {
      const m = o as Mesh;
      if (!m.isMesh || opts.skip?.(m)) return;
      const mat = m.material;
      if (Array.isArray(mat) ? mat.some((x) => x.transparent) : mat.transparent) return;
      // (Popping in or out at a scale of ~0: not drawn yet.)
      const e = m.matrixWorld.elements;
      if (e[0] * e[0] + e[1] * e[1] + e[2] * e[2] < 1e-6) return;
      let d = Infinity;
      const im = m as InstancedMesh;
      if (im.isInstancedMesh) {
        if (im.count > opts.maxInstances) return;
        inv.copy(im.matrixWorld).invert();
        local.copy(pos).applyMatrix4(inv);
        const a = im.instanceMatrix.array;
        for (let i = 0; i < im.count; i++) {
          const dx = a[i * 16 + 12] - local.x;
          const dy = a[i * 16 + 13] - local.y;
          const dz = a[i * 16 + 14] - local.z;
          const dd = dx * dx + dy * dy + dz * dz;
          if (dd < d) d = dd;
        }
        d = Math.sqrt(d);
      } else {
        const g = m.geometry;
        if (!g.boundingSphere && (g.getAttribute('position')?.count ?? 1e9) < 60000) g.computeBoundingSphere();
        if (!g.boundingSphere || g.boundingSphere.radius > radius * 3 + 2) return;
        local.copy(g.boundingSphere.center).applyMatrix4(m.matrixWorld);
        d = local.distanceTo(pos);
      }
      if (d < reach) found.push({ o, d });
    });
    if (!found.length) return;
    let best = Infinity;
    for (const f of found) best = Math.min(best, f.d);
    for (const f of found) if (f.d < best + 0.25) this.objects.push(f.o);
  }

  /**
   * Per object: this frame's instance of the subject in an instanced mesh (owners repack their
   * instances every frame), −1 for a plain mesh or when none is in reach. Do not mutate.
   */
  readonly instance: number[] = [];

  /**
   * Once a frame while the subject is re-drawn: find its instance in each instanced object (the one
   * nearest its pose, within the scan's reach), so the clouds draw that instance alone (a car right
   * behind the ridden one, in the same scissor square, was drawn over the clouds too). Zero-alloc.
   */
  locate(pos: Vector3, radius: number, reach: number): void {
    const r2 = (reach + radius * 0.8) ** 2;
    const { inv, local, instance, objects } = this;
    while (instance.length < objects.length) instance.push(-1);
    instance.length = objects.length;
    for (let k = 0; k < objects.length; k++) {
      instance[k] = -1;
      const im = objects[k] as InstancedMesh;
      if (!im.isInstancedMesh) continue;
      inv.copy(im.matrixWorld).invert();
      local.copy(pos).applyMatrix4(inv);
      const a = im.instanceMatrix.array;
      let best = r2;
      for (let i = 0; i < im.count; i++) {
        // (Collapsed to a scale of ~0: hidden by its owner, e.g. a ridden walker's body.)
        if (a[i * 16] * a[i * 16] + a[i * 16 + 1] * a[i * 16 + 1] + a[i * 16 + 2] * a[i * 16 + 2] < 1e-8) continue;
        const dx = a[i * 16 + 12] - local.x;
        const dy = a[i * 16 + 13] - local.y;
        const dz = a[i * 16 + 14] - local.z;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < best) {
          best = dd;
          instance[k] = i;
        }
      }
    }
  }

  /** After locate: is anything there to draw (a plain mesh, or an instance found)? */
  get located(): boolean {
    for (let k = 0; k < this.objects.length; k++) {
      const o = this.objects[k];
      if (o.visible && o.parent && (!(o as InstancedMesh).isInstancedMesh || (this.instance[k] ?? -1) >= 0)) return true;
    }
    return false;
  }

  /** Debug: what the last scan saw. */
  debug(): { key: string; scanned: boolean; objects: string[] } {
    return { key: this.key, scanned: this.scanned, objects: this.objects.map((o) => o.name || o.type) };
  }
}
