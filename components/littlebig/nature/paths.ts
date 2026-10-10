// Footpath mask for the ground cover (A1). Park paths, plaza paths, the market lane and the house
// garden paths are drawn by the city (A2) as ribbons ON lawns, so cityIndex.classify still says
// 'park' / 'garden' there and tufts used to grow straight across them. This indexes those ribbons
// as plan-space segments (half-width + margin) on a uniform grid: onPath(x, z) is O(1)-ish and
// zero-alloc. Pure TS.

import { doorX } from '../city/buildings';
import type { CityIndex, CityPlan } from '../world/city/types';

const CELL = 4; // m
/** Extra clearance beyond the ribbon edge (m): a tuft's blades lean ~0.2 m. */
export const PATH_MARGIN = 0.25;
/** Half-width of the house garden paths (city/ground.ts draws them −0.55 … 0.55). */
const GARDEN_HALF = 0.55;

export interface PathMask {
  onPath(x: number, z: number): boolean;
}

export function createPathMask(plan: CityPlan, index: CityIndex): PathMask {
  // Segments as [x0, z0, x1, z1, half] (half includes the margin).
  const seg: number[] = [];
  for (const w of plan.walkEdges) {
    if (w.kind !== 'park' && w.kind !== 'plaza' && w.kind !== 'footpath') continue;
    const p = w.path.pts;
    const half = w.width / 2 + PATH_MARGIN;
    for (let i = 0; i + 3 < p.length; i += 2) seg.push(p[i], p[i + 1], p[i + 2], p[i + 3], half);
  }
  // Garden paths: front door → out to the sidewalk (same walk as city/ground.ts).
  for (const b of plan.buildings) {
    if (b.style !== 'house') continue;
    const c = Math.cos(b.angle);
    const sn = Math.sin(b.angle);
    const u = doorX(b);
    const v0 = -b.d / 2 + 0.3;
    let v1 = -b.d / 2 - 0.5;
    for (let k = 0; k < 24; k++) {
      if (index.classify(b.x + u * c - v1 * sn, b.z + u * sn + v1 * c) === 'sidewalk') break;
      v1 -= 0.25;
    }
    seg.push(b.x + u * c - v0 * sn, b.z + u * sn + v0 * c, b.x + u * c - v1 * sn, b.z + u * sn + v1 * c, GARDEN_HALF + PATH_MARGIN);
  }

  const S = new Float64Array(seg);
  const n = S.length / 5;
  const R = plan.radius + 4;
  const dim = Math.ceil((2 * R) / CELL);
  const cellOf = (v: number) => Math.min(dim - 1, Math.max(0, Math.floor((v + R) / CELL)));
  // Bucket each segment into every cell its (padded) box touches: CSR arrays.
  const counts = new Int32Array(dim * dim + 1);
  const forCells = (i: number, fn: (cell: number) => void) => {
    const o = i * 5;
    const h = S[o + 4];
    const x0 = cellOf(Math.min(S[o], S[o + 2]) - h), x1 = cellOf(Math.max(S[o], S[o + 2]) + h);
    const z0 = cellOf(Math.min(S[o + 1], S[o + 3]) - h), z1 = cellOf(Math.max(S[o + 1], S[o + 3]) + h);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) fn(cz * dim + cx);
  };
  for (let i = 0; i < n; i++) forCells(i, (c) => counts[c + 1]++);
  for (let c = 0; c < dim * dim; c++) counts[c + 1] += counts[c];
  const start = counts.slice();
  const items = new Int32Array(counts[dim * dim]);
  for (let i = 0; i < n; i++) forCells(i, (c) => (items[start[c]++] = i));

  return {
    onPath(x: number, z: number): boolean {
      if (x < -R || x > R || z < -R || z > R) return false;
      const c = cellOf(z) * dim + cellOf(x);
      for (let k = counts[c]; k < counts[c + 1]; k++) {
        const o = items[k] * 5;
        const ax = S[o], az = S[o + 1];
        const dx = S[o + 2] - ax, dz = S[o + 3] - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        const h = S[o + 4];
        if (ex * ex + ez * ez < h * h) return true;
      }
      return false;
    },
  };
}
