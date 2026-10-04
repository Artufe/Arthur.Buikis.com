// Terrain v0 (F0): the displaced icosphere with flat-shaded low-poly facets and per-face biome
// colour. A1 owns this directory next (coasts, meadows, forests, rocky faces, snowcaps).

import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { LBContext, System } from '../core/contracts';
import { PALETTE } from '../render/palette';
import { R } from '../world/config';
import { icoHeights } from '../world/ico-heights';
import { icosphere } from '../world/icosphere';
import { Biome, type BiomeId } from '../world/planet';
import { hash3 } from '../world/rng';
import { v3 } from '../world/sphere';

/** Biome base colours (BRIEF §3 palette, render/palette.ts). */
const G = PALETTE.ground;
const BIOME_HEX: Record<BiomeId, string> = {
  [Biome.DeepOcean]: '#c9b27a',
  [Biome.Shallows]: '#e9cf86',
  [Biome.Beach]: `#${G.sand.getHexString()}`,
  [Biome.Grass]: `#${G.grass.getHexString()}`,
  [Biome.Meadow]: `#${G.meadow.getHexString()}`,
  [Biome.Forest]: `#${G.forest.getHexString()}`,
  [Biome.Rock]: `#${G.rock.getHexString()}`,
  [Biome.Snow]: `#${G.snow.getHexString()}`,
  [Biome.City]: '#86cf52',
};

export function createTerrainSystem(): System {
  let geometry: BufferGeometry | null = null;
  return {
    name: 'terrain',
    stage: 1,
    init(ctx: LBContext) {
      const planet = ctx.world.planet;
      const ico = icosphere(ctx.q.terrainDetail);
      const P = ico.positions;
      const heights = icoHeights(planet, ctx.q.terrainDetail);
      const d = v3();
      const tris = ico.triangleCount;
      const pos = new Float32Array(tris * 9);
      const nor = new Float32Array(tris * 9);
      const col = new Uint8Array(tris * 9);
      const base = Object.fromEntries(Object.entries(BIOME_HEX).map(([k, hex]) => [k, new Color(hex)])) as unknown as Record<number, Color>;
      const rock = new Color(BIOME_HEX[Biome.Rock]);
      const c = new Color();
      const idx = ico.indices;
      for (let f = 0; f < tris; f++) {
        let cx = 0, cy = 0, cz = 0, ch = 0;
        const o = f * 9;
        for (let k = 0; k < 3; k++) {
          const vi = idx[f * 3 + k];
          const r = R + heights[vi];
          const x = P[vi * 3] * r;
          const y = P[vi * 3 + 1] * r;
          const z = P[vi * 3 + 2] * r;
          pos[o + k * 3] = x;
          pos[o + k * 3 + 1] = y;
          pos[o + k * 3 + 2] = z;
          cx += P[vi * 3];
          cy += P[vi * 3 + 1];
          cz += P[vi * 3 + 2];
          ch += heights[vi];
        }
        // face normal
        const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
        const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        for (let k = 0; k < 3; k++) {
          nor[o + k * 3] = nx;
          nor[o + k * 3 + 1] = ny;
          nor[o + k * 3 + 2] = nz;
        }
        const cl = Math.hypot(cx, cy, cz) || 1;
        d.x = cx / cl;
        d.y = cy / cl;
        d.z = cz / cl;
        const h = ch / 3;
        const biome = planet.biomeAt(d, h);
        c.copy(base[biome]);
        // Steep faces turn rocky (not on the plateau or beaches).
        const slope = 1 - (nx * d.x + ny * d.y + nz * d.z);
        if (biome !== Biome.City && biome !== Biome.Snow && h > 1.5 && slope > 0.12) c.lerp(rock, Math.min(1, (slope - 0.12) * 5));
        // Handmade variation: a little value / warmth jitter per facet.
        const j = hash3(f, 17) - 0.5;
        const k2 = hash3(f, 91) - 0.5;
        const v = 1 + j * (biome === Biome.City ? 0.08 : 0.12);
        c.r *= v * (1 + k2 * 0.04);
        c.g *= v;
        c.b *= v * (1 - k2 * 0.04);
        const r8 = Math.min(255, Math.round(c.r * 255));
        const g8 = Math.min(255, Math.round(c.g * 255));
        const b8 = Math.min(255, Math.round(c.b * 255));
        for (let k = 0; k < 3; k++) {
          col[o + k * 3] = r8;
          col[o + k * 3 + 1] = g8;
          col[o + k * 3 + 2] = b8;
        }
      }
      geometry = ctx.track(new BufferGeometry());
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      geometry.setAttribute('normal', new BufferAttribute(nor, 3));
      geometry.setAttribute('color', new BufferAttribute(col, 3, true));
      geometry.computeBoundingSphere();
      const mat = ctx.toon.material({ name: 'terrain', vertexColors: true, rim: 0.25 });
      const mesh = ctx.toon.mesh(geometry, mat, { cast: true, receive: true });
      ctx.scene.add(mesh);
    },
    dispose() {
      geometry?.dispose();
      geometry = null;
    },
  };
}
