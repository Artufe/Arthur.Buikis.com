// Ocean v0 (F0): a smooth toon sphere at sea level, tinted per vertex by the water depth
// (turquoise shallows over sand → deep blue, a pale band at the waterline). A1 owns this next
// (foam bands, swell, sparkle, toon specular).

import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { LBContext, System } from '../core/contracts';
import { PALETTE } from '../render/palette';
import { R } from '../world/config';
import { icoHeights } from '../world/ico-heights';
import { icosphere } from '../world/icosphere';
import { v3 } from '../world/sphere';

const DEEP = PALETTE.ocean.deep;
const SHALLOW = PALETTE.ocean.shallow;
const FOAM = new Color('#E8FBFF');

export function createOceanSystem(): System {
  let geometry: BufferGeometry | null = null;
  return {
    name: 'ocean',
    stage: 1,
    init(ctx: LBContext) {
      const detail = ctx.q.terrainDetail;
      const ico = icosphere(detail);
      const heights = icoHeights(ctx.world.planet, detail);
      const n = ico.vertexCount;
      const P = ico.positions;
      const pos = new Float32Array(n * 3);
      const col = new Uint8Array(n * 3);
      const d = v3();
      const c = new Color();
      for (let i = 0; i < n; i++) {
        d.x = P[i * 3];
        d.y = P[i * 3 + 1];
        d.z = P[i * 3 + 2];
        pos[i * 3] = d.x * R;
        pos[i * 3 + 1] = d.y * R;
        pos[i * 3 + 2] = d.z * R;
        const depth = -heights[i];
        const t = Math.min(1, Math.max(0, (depth - 0.3) / 7));
        c.copy(SHALLOW).lerp(DEEP, t * t * (3 - 2 * t));
        if (depth < 0.9) c.lerp(FOAM, Math.min(1, (0.9 - depth) / 0.9) * 0.6);
        col[i * 3] = Math.round(c.r * 255);
        col[i * 3 + 1] = Math.round(c.g * 255);
        col[i * 3 + 2] = Math.round(c.b * 255);
      }
      geometry = ctx.track(new BufferGeometry());
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      // A sphere's normal is its direction.
      geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(P), 3));
      geometry.setAttribute('color', new BufferAttribute(col, 3, true));
      geometry.setIndex(new BufferAttribute(ico.indices, 1));
      geometry.computeBoundingSphere();
      const mat = ctx.toon.material({ name: 'ocean', vertexColors: true, rim: 0.5 });
      const mesh = ctx.toon.mesh(geometry, mat, { cast: false, receive: true });
      ctx.scene.add(mesh);
    },
    dispose() {
      geometry?.dispose();
      geometry = null;
    },
  };
}
