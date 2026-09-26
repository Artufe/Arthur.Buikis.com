// The single base heightfield for land + seabed, and its boot-time bake. Orchestrator-owned;
// the shapes themselves live in land.ts (beach agent) and seabed.ts (ocean agent).

import { DataTexture, FloatType, LinearFilter, RedFormat } from 'three/webgpu';
import type { TerrainService } from '../core/contracts';
import { landHeight } from './land';
import { TERRAIN_BOUNDS, TERRAIN_TEXEL, shoreX } from './layout';
import { seabedHeight } from './seabed';

/** Blend band (m) either side of the mean water line where land and seabed cross-fade. */
const BLEND = 12;

export function terrainHeight(x: number, z: number) {
  const d = x - shoreX(z);
  if (d > BLEND) return landHeight(x, z);
  if (d < -BLEND) return seabedHeight(x, z);
  const t = (d + BLEND) / (2 * BLEND);
  const s = t * t * (3 - 2 * t);
  return seabedHeight(x, z) * (1 - s) + landHeight(x, z) * s;
}

export function createTerrainService(): TerrainService {
  const [minX, minZ, maxX, maxZ] = TERRAIN_BOUNDS;
  const w = Math.round((maxX - minX) / TERRAIN_TEXEL);
  const h = Math.round((maxZ - minZ) / TERRAIN_TEXEL);
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = minZ + (j + 0.5) * TERRAIN_TEXEL;
    for (let i = 0; i < w; i++) data[j * w + i] = terrainHeight(minX + (i + 0.5) * TERRAIN_TEXEL, z);
  }
  const tex = new DataTexture(data, w, h, RedFormat, FloatType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  // u = (x - minX) / (maxX - minX), v = (z - minZ) / (maxZ - minZ).
  return {
    height: terrainHeight,
    heightTexture: tex,
    bounds: TERRAIN_BOUNDS,
    texel: TERRAIN_TEXEL,
  };
}
