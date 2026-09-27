// [polish] The reef's coral-head field, baked once at boot by a GPU compute pass into an RGBA16F
// texture (15 cm texels over the reef's footprint) instead of being evaluated per pixel: the
// warped Voronoi plus ~8 noises ran for every seabed pixel (≈ 3-6 ms of the lineup frame on the
// M3, fully shaded because the water's refraction copy breaks the render pass). Only the fine
// knobbles (< 25 cm) stay procedural, near the camera. See sand.ts reefBase().

import { HalfFloatType, LinearFilter, RGBAFormat, ClampToEdgeWrapping, StorageTexture } from 'three/webgpu';
import { REEF } from '../world/layout';

export const REEF_TEXEL = 0.15;

/** World XZ bounds (minX, minZ, maxX, maxZ) of the reef shelf and its front, with margin. */
export const REEF_BOUNDS: [number, number, number, number] = (() => {
  const ex = REEF.b.x - REEF.a.x;
  const ez = REEF.b.z - REEF.a.z;
  const l = Math.hypot(ex, ez);
  const ux = ex / l;
  const uz = ez / l;
  // across (shoreward) direction as in world/seabed.ts: across = px·uz − pz·ux
  const nx = uz;
  const nz = -ux;
  let x0 = 1e9;
  let z0 = 1e9;
  let x1 = -1e9;
  let z1 = -1e9;
  for (const along of [-0.12 * l, 1.08 * l])
    for (const across of [-18, REEF.width + 18]) {
      const x = REEF.a.x + ux * along + nx * across;
      const z = REEF.a.z + uz * along + nz * across;
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
  return [Math.floor(x0), Math.floor(z0), Math.ceil(x1), Math.ceil(z1)];
})();

export interface ReefBake {
  tex: StorageTexture;
  w: number;
  h: number;
  baked: boolean;
  dispose(): void;
}

export function createReefBake(): ReefBake {
  const [x0, z0, x1, z1] = REEF_BOUNDS;
  const w = Math.ceil((x1 - x0) / REEF_TEXEL / 8) * 8;
  const h = Math.ceil((z1 - z0) / REEF_TEXEL / 8) * 8;
  const t = new StorageTexture(w, h);
  t.type = HalfFloatType;
  t.format = RGBAFormat;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  (t as unknown as { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
  t.name = 'goldenline.beach.reef';
  return {
    tex: t,
    w,
    h,
    baked: false,
    dispose() {
      t.dispose();
    },
  };
}
