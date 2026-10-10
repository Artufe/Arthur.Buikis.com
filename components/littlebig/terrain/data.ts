// Per-vertex terrain fields on the shared icosphere, cached per (planet, detail). Pure TS, no
// three.js. The terrain mesh, the nature scatter and the ground cover all read the same arrays, so
// every tree and grass tuft stands on the exact facet the player sees.
//
// Face f of the icosphere is (indices[3f], indices[3f+1], indices[3f+2]); its vertex k sits at
// positions[vi] · (R + heights[vi]). Faces are ordered hierarchically by the subdivision: the 4^k
// faces [f·4^k, (f+1)·4^k) at detail d all descend from face f at detail d − k (spatial buckets
// for camera-local queries, see nature/ground-cover.ts).

import { PLATEAU_BLEND, PLATEAU_RADIUS, R } from '../world/config';
import { icoHeights } from '../world/ico-heights';
import { icosphere, type Icosphere } from '../world/icosphere';
import { createNoise3 } from '../world/noise';
import { Biome, type BiomeId, type Planet } from '../world/planet';
import { hash3 } from '../world/rng';
import { v3 } from '../world/sphere';

export interface TerrainData {
  detail: number;
  ico: Icosphere;
  /** Height above sea level per vertex (m). */
  heights: Float32Array;
  /** Biome per vertex. */
  biome: Uint8Array;
  /** Smooth (area-weighted) vertex normal of the displaced mesh, xyz interleaved. */
  normal: Float32Array;
  /** 1 − n·up per vertex: 0 flat, ~0.3 a 45° face. */
  slope: Float32Array;
  /** Moisture 0..1 per vertex (planet.moistureAt). */
  moist: Float32Array;
  /** A slow 0..1 tone field per vertex (meadow colour patches, flower meadows). */
  tone: Float32Array;
  /** Plateau weight per vertex (1 on the city plateau). */
  plateau: Float32Array;
  /**
   * Low-frequency colour jitter per vertex, ≈ −1..1 (period ~10 m): facets take the mean of their
   * corners, so neighbours match and the value variation forms soft patches, not a checkerboard.
   */
  jit: Float32Array;
  /** 0..1 flower-field mask per vertex (period ~30 m): speckled bloom patches in meadows and grass. */
  flower: Float32Array;
  /**
   * Farmland patchwork (the countryside read from 30-150 m up): the 0..1 hash of the field cell a
   * vertex lies in (cells ~24 m across, a 3D Voronoi on the sphere), or −1 off farmland (forest,
   * hills, beaches, the plateau, open meadow). terrain/colors.ts tints each cell.
   */
  field: Float32Array;
  /** Metres from the vertex to the nearest field border (hedgerow lines); 99 off farmland. */
  hedge: Float32Array;
}

/** Farmland cell size: the Voronoi lattice frequency on the unit sphere (R / FIELD_FREQ ≈ 24 m). */
export const FIELD_FREQ = 6.6;
const FIELD_SALT = 0x6f1e;

/**
 * Field cell of unit direction (x, y, z): writes [cell hash 0..1, metres to the cell border] into
 * out, and when out has room, [2..4] = the unit direction from this cell's centre toward the
 * nearest neighbour's (the border runs perpendicular to it). 3D Voronoi over the 27 lattice
 * neighbours, border distance by the exact bisector.
 */
export function fieldCell(x: number, y: number, z: number, out: Float32Array | number[]): void {
  // Domain-warped (two octaves of smooth sines) so field borders bend like old hedgerows instead
  // of tiling the countryside into regular cells.
  const qx = x * FIELD_FREQ, qy = y * FIELD_FREQ, qz = z * FIELD_FREQ;
  const px = qx + 0.3 * Math.sin(qy * 1.9 + qz * 1.3) + 0.12 * Math.sin(qz * 4.1 - qy * 3.3);
  const py = qy + 0.3 * Math.sin(qz * 1.7 - qx * 1.1) + 0.12 * Math.sin(qx * 3.7 + qz * 2.9);
  const pz = qz + 0.3 * Math.sin(qx * 1.5 + qy * 1.6) + 0.12 * Math.sin(qy * 3.9 - qx * 3.1);
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let d1 = 1e9, d2 = 1e9;
  let h1 = 0;
  let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
  for (let k = -1; k <= 1; k++) {
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = ix + i, cy = iy + j, cz = iz + k;
        const seed = cx * 73856093 ^ cy * 19349663;
        const fx = cx + hash3(seed, cz, FIELD_SALT);
        const fy = cy + hash3(seed, cz, FIELD_SALT + 1);
        const fz = cz + hash3(seed, cz, FIELD_SALT + 2);
        const dx = fx - px, dy = fy - py, dz = fz - pz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < d1) {
          d2 = d1;
          bx = ax; by = ay; bz = az;
          d1 = d;
          ax = fx; ay = fy; az = fz;
          h1 = hash3(seed, cz, FIELD_SALT + 3);
        } else if (d < d2) {
          d2 = d;
          bx = fx; by = fy; bz = fz;
        }
      }
    }
  }
  const sep = Math.hypot(bx - ax, by - ay, bz - az) || 1;
  out[0] = h1;
  out[1] = ((d2 - d1) / (2 * sep)) * (R / FIELD_FREQ);
  if (out.length >= 5) {
    out[2] = (bx - ax) / sep;
    out[3] = (by - ay) / sep;
    out[4] = (bz - az) / sep;
  }
}

const cache = new WeakMap<Planet, Map<number, TerrainData>>();

export function terrainData(planet: Planet, detail: number): TerrainData {
  let byDetail = cache.get(planet);
  if (!byDetail) cache.set(planet, (byDetail = new Map()));
  const hit = byDetail.get(detail);
  if (hit) return hit;
  const data = build(planet, detail);
  byDetail.set(detail, data);
  return data;
}

function build(planet: Planet, detail: number): TerrainData {
  const ico = icosphere(detail);
  const heights = icoHeights(planet, detail);
  const n = ico.vertexCount;
  const P = ico.positions;
  const I = ico.indices;
  const normal = new Float32Array(n * 3);
  // Area-weighted face normals accumulated at the vertices (cross product length = 2·area).
  for (let f = 0; f < ico.triangleCount; f++) {
    const a = I[f * 3];
    const b = I[f * 3 + 1];
    const c = I[f * 3 + 2];
    const ra = R + heights[a];
    const rb = R + heights[b];
    const rc = R + heights[c];
    const ax = P[a * 3] * ra, ay = P[a * 3 + 1] * ra, az = P[a * 3 + 2] * ra;
    const ux = P[b * 3] * rb - ax, uy = P[b * 3 + 1] * rb - ay, uz = P[b * 3 + 2] * rb - az;
    const vx = P[c * 3] * rc - ax, vy = P[c * 3 + 1] * rc - ay, vz = P[c * 3 + 2] * rc - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normal[a * 3] += nx; normal[a * 3 + 1] += ny; normal[a * 3 + 2] += nz;
    normal[b * 3] += nx; normal[b * 3 + 1] += ny; normal[b * 3 + 2] += nz;
    normal[c * 3] += nx; normal[c * 3 + 1] += ny; normal[c * 3 + 2] += nz;
  }
  const slope = new Float32Array(n);
  const biome = new Uint8Array(n);
  const moist = new Float32Array(n);
  const tone = new Float32Array(n);
  const plateau = new Float32Array(n);
  const jit = new Float32Array(n);
  const flower = new Float32Array(n);
  const field = new Float32Array(n).fill(-1);
  const hedge = new Float32Array(n).fill(99);
  const fc = [0, 0];
  const farmNoise = createNoise3(planet.seed ^ 0x5225);
  const cd = planet.cityDir;
  const toneNoise = createNoise3(planet.seed ^ 0x5005);
  const jitNoise = createNoise3(planet.seed ^ 0x5115);
  const d = v3();
  for (let i = 0; i < n; i++) {
    let nx = normal[i * 3], ny = normal[i * 3 + 1], nz = normal[i * 3 + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    normal[i * 3] = nx; normal[i * 3 + 1] = ny; normal[i * 3 + 2] = nz;
    d.x = P[i * 3];
    d.y = P[i * 3 + 1];
    d.z = P[i * 3 + 2];
    slope[i] = 1 - (nx * d.x + ny * d.y + nz * d.z);
    const h = heights[i];
    biome[i] = planet.biomeAt(d, h);
    plateau[i] = planet.plateauWeight(d);
    if (h > -1) {
      moist[i] = planet.moistureAt(d);
      tone[i] = 0.5 + 0.5 * toneNoise.fbm3(d.x * 9, d.y * 9, d.z * 9, 2);
      jit[i] = jitNoise.simplex3(d.x * 15, d.y * 15, d.z * 15);
      const fl = jitNoise.fbm3(d.x * 5.5 + 3.7, d.y * 5.5 - 1.3, d.z * 5.5, 2);
      flower[i] = Math.min(1, Math.max(0, (fl - 0.12) / 0.3));
      // Farmland: gentle grass/meadow a little above the beaches (a wild margin before the sand),
      // where a slow mask says so (about half the open countryside; the rest stays wild meadow
      // with groves).
      // Around the town (the plateau's outskirts and its blend ring, what the dive lingers over)
      // it is always farmland; the city draws its own ground over anything it uses.
      const b = biome[i];
      const cityAng = Math.acos(Math.min(1, d.x * cd.x + d.y * cd.y + d.z * cd.z));
      const outskirts = cityAng > 0.4 && cityAng < PLATEAU_RADIUS + PLATEAU_BLEND + 0.12;
      if ((b === Biome.Grass || b === Biome.Meadow || b === Biome.City) && h > 1.4 && h < 9 && slope[i] < 0.06 && cityAng > 0.4) {
        if (outskirts || farmNoise.fbm3(d.x * 3.2, d.y * 3.2, d.z * 3.2, 2) > -0.08) {
          fieldCell(d.x, d.y, d.z, fc);
          field[i] = fc[0];
          hedge[i] = fc[1];
        }
      }
    }
  }
  return { detail, ico, heights, biome, normal, slope, moist, tone, plateau, jit, flower, field, hedge };
}

/** The biome that owns a face: its most common vertex biome (ties → the first vertex's). */
export function faceBiome(t: TerrainData, f: number): BiomeId {
  const I = t.ico.indices;
  const a = t.biome[I[f * 3]];
  const b = t.biome[I[f * 3 + 1]];
  const c = t.biome[I[f * 3 + 2]];
  return (b === c && a !== b ? b : a) as BiomeId;
}

/**
 * A point on face f at barycentric (u, v) (w = 1 − u − v), exactly on the rendered facet. Writes the
 * world position into out and returns it.
 */
export function facePoint(t: TerrainData, f: number, u: number, v: number, out: { x: number; y: number; z: number }) {
  const I = t.ico.indices;
  const P = t.ico.positions;
  const H = t.heights;
  const a = I[f * 3];
  const b = I[f * 3 + 1];
  const c = I[f * 3 + 2];
  const w = 1 - u - v;
  const ra = (R + H[a]) * w;
  const rb = (R + H[b]) * u;
  const rc = (R + H[c]) * v;
  out.x = P[a * 3] * ra + P[b * 3] * rb + P[c * 3] * rc;
  out.y = P[a * 3 + 1] * ra + P[b * 3 + 1] * rb + P[c * 3 + 1] * rc;
  out.z = P[a * 3 + 2] * ra + P[b * 3 + 2] * rb + P[c * 3 + 2] * rc;
  return out;
}

/** Minimum vertex height of face f (m): below 0 some of it is under water. */
export function faceMinHeight(t: TerrainData, f: number): number {
  const I = t.ico.indices;
  return Math.min(t.heights[I[f * 3]], t.heights[I[f * 3 + 1]], t.heights[I[f * 3 + 2]]);
}

/** Face slope 1 − n·up from the facet's own normal (steep slivers are > 0.3). */
export function faceSlope(t: TerrainData, f: number): number {
  const I = t.ico.indices;
  return (t.slope[I[f * 3]] + t.slope[I[f * 3 + 1]] + t.slope[I[f * 3 + 2]]) / 3;
}

export { Biome };
