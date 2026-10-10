// The rendered terrain's height under a direction (v2, H1). The terrain is a displaced icosphere with
// planar facets (~3 m at detail 6, ~6 m at detail 5): between its vertices it is NOT heightAt, it is
// the facet's plane. Roads drawn at heightAt + ROAD_H would sink into a facet that straddles a cut's
// bank and float over one spanning a fill, so every paved surface is laid on the facet itself: this
// finds the facet a ray from the centre hits (descending the icosphere's hierarchical face order:
// the 4 children of face f are 4f..4f+3, terrain/data.ts) and intersects its plane. Pure, zero-alloc.

import type { TerrainData } from '../terrain/data';
import { R } from '../world/config';
import type { Vec3 } from '../world/sphere';

export interface MeshHeight {
  /** Height (m above sea level) of the rendered terrain facet under unit `d`. */
  at(d: Vec3): number;
  /** The facet (terrain face index) under unit `d`. */
  face(d: Vec3): number;
}

export function meshHeight(t: TerrainData): MeshHeight {
  const P = t.ico.positions;
  const I = t.ico.indices;
  const H = t.heights;
  const D = t.detail;
  let last = -1;
  // corner k of face F at level `lv`: the first vertex of a leaf face descending from it (child 0 of
  // [a, b, c] is [a, ab, ca], child 1 [b, bc, ab], child 2 [c, ca, bc])
  const corner = (F: number, lv: number, k: number) => {
    const sh = 2 * (D - lv);
    return sh === 0 ? I[F * 3 + k] : I[(k === 0 ? F << sh : ((F << 2) + k) << (sh - 2)) * 3];
  };
  // the least of the three edge tests (> 0: inside the face's spherical triangle)
  const inside = (F: number, lv: number, x: number, y: number, z: number) => {
    let m = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = corner(F, lv, k) * 3;
      const b = corner(F, lv, (k + 1) % 3) * 3;
      const cx = P[a + 1] * P[b + 2] - P[a + 2] * P[b + 1];
      const cy = P[a + 2] * P[b] - P[a] * P[b + 2];
      const cz = P[a] * P[b + 1] - P[a + 1] * P[b];
      // (unnormalised: the faces compared at one level are near-equilateral and alike in size)
      const v = x * cx + y * cy + z * cz;
      if (v < m) m = v;
    }
    return m;
  };
  const locate = (x: number, y: number, z: number) => {
    if (last >= 0 && inside(last, D, x, y, z) >= -1e-12) return last;
    let best = 0;
    let bv = -Infinity;
    for (let F = 0; F < 20; F++) {
      const v = inside(F, 0, x, y, z);
      if (v > bv) {
        bv = v;
        best = F;
      }
    }
    for (let lv = 1; lv <= D; lv++) {
      const base = best << 2;
      bv = -Infinity;
      for (let k = 0; k < 4; k++) {
        const v = inside(base + k, lv, x, y, z);
        if (v > bv) {
          bv = v;
          best = base + k;
        }
      }
    }
    return (last = best);
  };
  return {
    face: (d) => locate(d.x, d.y, d.z),
    at(d) {
      const f = locate(d.x, d.y, d.z);
      const a = I[f * 3], b = I[f * 3 + 1], c = I[f * 3 + 2];
      const ra = R + H[a], rb = R + H[b], rc = R + H[c];
      const ax = P[a * 3] * ra, ay = P[a * 3 + 1] * ra, az = P[a * 3 + 2] * ra;
      const ux = P[b * 3] * rb - ax, uy = P[b * 3 + 1] * rb - ay, uz = P[b * 3 + 2] * rb - az;
      const vx = P[c * 3] * rc - ax, vy = P[c * 3 + 1] * rc - ay, vz = P[c * 3 + 2] * rc - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const k = (nx * ax + ny * ay + nz * az) / (nx * d.x + ny * d.y + nz * d.z);
      return k - R;
    },
  };
}
