// Chunked drawing for the planet-sized meshes (terrain, ocean). Each was submitted whole every frame
// (terrain twice: colour + shadow), although at street level well over 90 % of it lies past the
// horizon. The icosphere's faces are ordered hierarchically, so the 256 detail-6 faces of each
// detail-2 face (a "chunk") are one contiguous index / vertex range. Each frame the chunks below the
// horizon (counting their highest point) or outside the inflated view frustum are dropped, and the
// visible ranges are drawn through a few Meshes that share the geometry's buffers, each with its own
// drawRange. Runs are merged across the smallest gaps until they fit the slots, so the draw-call
// count stays fixed (≤ SLOTS per pass) while the triangle count follows the view.

import { BufferGeometry, Frustum, Matrix4, type Mesh, Sphere } from 'three';
import type { LBContext } from '../core/contracts';
import type { ToonMaterial } from '../render/toon';
import { chunkAboveHorizon, type ChunkBounds } from '../nature/chunks';
import { R } from '../world/config';
import type { TerrainData } from './data';

/** Chunks: the detail-2 faces (256 detail-6 faces each, ~10° across). */
const N = 320;
/** Meshes (draw calls per pass) per chunked object. */
const SLOTS = 4;

const cache = new WeakMap<TerrainData, ChunkBounds>();

/**
 * Bounds of the N chunks of the terrain icosphere: centre direction, angular radius,
 * highest point (terrain or sea level + 1 m of swell) and a world bounding sphere. Cached.
 */
export function terrainChunkBounds(t: TerrainData): ChunkBounds {
  const hit = cache.get(t);
  if (hit) return hit;
  const P = t.ico.positions;
  const I = t.ico.indices;
  const H = t.heights;
  const per = t.ico.triangleCount / N;
  const dir = new Float32Array((N + 1) * 3);
  const rad = new Float32Array(N + 1);
  const top = new Float32Array(N + 1);
  const over = new Float32Array(N + 1);
  const sphere = new Float32Array((N + 1) * 4);
  const used = new Uint8Array(N + 1);
  for (let c = 0; c < N; c++) {
    const f0 = c * per * 3, f1 = (c + 1) * per * 3;
    let x = 0, y = 0, z = 0, hmax = 1;
    for (let k = f0; k < f1; k++) {
      const v = I[k];
      x += P[v * 3];
      y += P[v * 3 + 1];
      z += P[v * 3 + 2];
      if (H[v] > hmax) hmax = H[v];
    }
    const l = Math.hypot(x, y, z) || 1;
    x /= l;
    y /= l;
    z /= l;
    let dmin = 1;
    for (let k = f0; k < f1; k++) {
      const v = I[k];
      const d = P[v * 3] * x + P[v * 3 + 1] * y + P[v * 3 + 2] * z;
      if (d < dmin) dmin = d;
    }
    dir[c * 3] = x;
    dir[c * 3 + 1] = y;
    dir[c * 3 + 2] = z;
    rad[c] = Math.acos(Math.max(-1, Math.min(1, dmin)));
    top[c] = hmax;
    used[c] = 1;
    const rt = R + hmax;
    over[c] = Math.acos(R / rt);
    // Sphere around the cap from the seabed (R − 15) to the tops.
    const ca = Math.cos(rad[c]), sa = Math.sin(rad[c]);
    const rb = R - 15;
    const kk = (rb * ca + rt) / 2;
    sphere[c * 4] = x * kk;
    sphere[c * 4 + 1] = y * kk;
    sphere[c * 4 + 2] = z * kk;
    sphere[c * 4 + 3] = Math.max(Math.hypot(rt * sa, rt * ca - kk), Math.hypot(rb * sa, rb * ca - kk), rt - kk) + 1;
  }
  const b: ChunkBounds = { dir, rad, top, over, sphere, used };
  cache.set(t, b);
  return b;
}

export interface ChunkedMesh {
  readonly meshes: Mesh[];
  /** Re-cull for the current camera (skipped while it holds still). Zero allocations. */
  update(ctx: LBContext): void;
  dispose(): void;
}

const _pm = new Matrix4();
const _frustum = new Frustum();
const _sphere = new Sphere();

/**
 * Draw `geometry` (faces in icosphere order; indexed or not, 3 vertices / indices per face) through
 * SLOTS meshes that show only the visible chunks. `inflate` (m) widens the frustum test so
 * shadows cast into view from just outside it stay.
 */
export function chunkedMesh(ctx: LBContext, geometry: BufferGeometry, material: ToonMaterial, bounds: ChunkBounds, faces: number, opts: { cast: boolean; receive: boolean; inflate: number }): ChunkedMesh {
  const per = faces / N;
  const geos: BufferGeometry[] = [];
  const meshes: Mesh[] = [];
  for (let s = 0; s < SLOTS; s++) {
    // Views of one geometry: the same attribute objects, so the buffers upload once.
    const g = new BufferGeometry();
    for (const name in geometry.attributes) g.setAttribute(name, geometry.attributes[name]);
    if (geometry.index) g.setIndex(geometry.index);
    g.boundingSphere = geometry.boundingSphere;
    const m = ctx.toon.mesh(g, material, { cast: opts.cast, receive: opts.receive });
    m.frustumCulled = false; // culled per chunk here
    m.visible = s === 0; // until the first cull: one full draw
    geos.push(g);
    meshes.push(m);
  }
  const vis = new Uint8Array(N);
  const runA = new Int32Array(N);
  const runB = new Int32Array(N);
  const last = new Float64Array(18).fill(NaN);
  let first = true;

  function cull(ctx: LBContext) {
    const cam = ctx.camera;
    const eye = ctx.view.eye;
    const de = eye.length();
    const ex = eye.x / de, ey = eye.y / de, ez = eye.z / de;
    const hor = Math.acos(Math.min(1, R / de));
    _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    let nr = 0;
    for (let c = 0; c < N; c++) {
      const was = vis[c] === 1;
      let v = 0;
      if (chunkAboveHorizon(bounds, c, ex, ey, ez, hor, was ? 0.06 : 0.03)) {
        _sphere.center.set(bounds.sphere[c * 4], bounds.sphere[c * 4 + 1], bounds.sphere[c * 4 + 2]);
        _sphere.radius = bounds.sphere[c * 4 + 3] + opts.inflate + (was ? 8 : 0);
        v = _frustum.intersectsSphere(_sphere) ? 1 : 0;
      }
      vis[c] = v;
      if (!v) continue;
      if (nr > 0 && runB[nr - 1] === c) runB[nr - 1] = c + 1;
      else {
        runA[nr] = c;
        runB[nr++] = c + 1;
      }
    }
    // Merge across the smallest gaps until the runs fit the slots.
    while (nr > SLOTS) {
      let best = 1, gap = 1e9;
      for (let r = 1; r < nr; r++) {
        const g = runA[r] - runB[r - 1];
        if (g < gap) {
          gap = g;
          best = r;
        }
      }
      runB[best - 1] = runB[best];
      for (let r = best; r < nr - 1; r++) {
        runA[r] = runA[r + 1];
        runB[r] = runB[r + 1];
      }
      nr--;
    }
    for (let s = 0; s < SLOTS; s++) {
      const on = s < nr;
      meshes[s].visible = on;
      if (on) geos[s].setDrawRange(runA[s] * per * 3, (runB[s] - runA[s]) * per * 3);
    }
  }

  return {
    meshes,
    update(ctx: LBContext) {
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      const w = cam.matrixWorld.elements, p = cam.projectionMatrix.elements;
      let moved = first;
      for (let i = 0; i < 16; i++) {
        if (last[i] !== w[i]) {
          last[i] = w[i];
          moved = true;
        }
      }
      if (last[16] !== p[0] || last[17] !== p[5]) {
        last[16] = p[0];
        last[17] = p[5];
        moved = true;
      }
      if (!moved) return;
      first = false;
      cull(ctx);
    },
    dispose() {
      for (const m of meshes) m.removeFromParent();
      // The views share the source geometry's buffers: disposing it (the owner does) frees them.
      for (const g of geos) g.dispose();
    },
  };
}
