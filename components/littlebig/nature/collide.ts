// Collision discs for the countryside's trunks and boulders (A1): FPV walks round a tree instead
// of through it, and the camera never stands inside a crown. City trees are CityIndex obstacles
// already (A2's features); these are the terrain scatter's. A 1° lat/lon grid hash; queries are
// allocation-free. Pure TS.

import type { NatureService } from '../core/contracts';
import type { Vec3 } from '../world/sphere';

const CELL = Math.PI / 180; // 1°
const ROWS = 180;
const COLS = 360;

export function createNatureCollider(dirs: Float32Array, radii: Float32Array, count: number, surfaceR: number): NatureService {
  // Bucket the discs by cell (counting sort).
  const cellOf = new Int32Array(count);
  const start = new Int32Array(ROWS * COLS + 1);
  for (let i = 0; i < count; i++) {
    const c = cellIndex(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
    cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < ROWS * COLS; c++) start[c + 1] += start[c];
  const fill = start.slice(0, ROWS * COLS);
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[fill[cellOf[i]]++] = i;

  return {
    collide(dir: Vec3, r: number, out: Vec3): boolean {
      let x = dir.x, y = dir.y, z = dir.z;
      let moved = false;
      for (let pass = 0; pass < 2; pass++) {
        const lat = Math.asin(Math.max(-1, Math.min(1, y)));
        const row = Math.min(ROWS - 1, Math.max(0, Math.floor((lat + Math.PI / 2) / CELL)));
        const col = Math.floor((Math.atan2(x, z) + Math.PI) / CELL);
        const span = Math.min(COLS / 2, Math.ceil(1 / Math.max(0.05, Math.cos(lat))));
        let hit = false;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = row + dr;
          if (rr < 0 || rr >= ROWS) continue;
          for (let dc = -span; dc <= span; dc++) {
            const cc = (((col + dc) % COLS) + COLS) % COLS;
            const c = rr * COLS + cc;
            for (let k = start[c]; k < start[c + 1]; k++) {
              const i = order[k];
              const tx = dirs[i * 3], ty = dirs[i * 3 + 1], tz = dirs[i * 3 + 2];
              const min = (r + radii[i]) / surfaceR;
              // Tangent offset from the disc centre to the body (small-angle chord).
              const d = x * tx + y * ty + z * tz;
              const ox = x - tx * d, oy = y - ty * d, oz = z - tz * d;
              const ol = Math.hypot(ox, oy, oz);
              if (ol >= min || d < 0.99) continue;
              const s = ol > 1e-9 ? min / ol : 0;
              if (s === 0) continue;
              x = tx * d + ox * s;
              y = ty * d + oy * s;
              z = tz * d + oz * s;
              const l = Math.hypot(x, y, z);
              x /= l;
              y /= l;
              z /= l;
              hit = moved = true;
            }
          }
        }
        if (!hit) break;
      }
      out.x = x;
      out.y = y;
      out.z = z;
      return moved;
    },
  };
}

function cellIndex(x: number, y: number, z: number): number {
  const lat = Math.asin(Math.max(-1, Math.min(1, y)));
  const row = Math.min(ROWS - 1, Math.max(0, Math.floor((lat + Math.PI / 2) / CELL)));
  const col = Math.min(COLS - 1, Math.max(0, Math.floor((Math.atan2(x, z) + Math.PI) / CELL)));
  return row * COLS + col;
}
