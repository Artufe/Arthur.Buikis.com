// Pier textures: the baked, quilted wood strip (public/goldenline/pier/, see tools/quilt-wood.py)
// and a small tileable noise texture baked at boot for cheap masks (algae, wet streaks, foam).

import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu';

export interface PierTextures {
  albedo: Texture;
  normal: Texture;
  /** R roughness, G ambient occlusion, B height. */
  ord: Texture;
  /** Four independent tileable value-noise octaves (R coarse → A fine), 256² over one tile. */
  noise: Texture;
  dispose(): void;
}

const BASE = '/goldenline/pier/';

export async function loadPierTextures(renderer: WebGPURenderer): Promise<PierTextures> {
  const loader = new TextureLoader();
  const aniso = Math.min(16, renderer.getMaxAnisotropy());
  const setup = (t: Texture, srgb: boolean) => {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.anisotropy = aniso;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };
  const [albedo, normal, ord] = await Promise.all([
    loader.loadAsync(BASE + 'wood_albedo.webp'),
    loader.loadAsync(BASE + 'wood_normal.webp'),
    loader.loadAsync(BASE + 'wood_ord.webp'),
  ]);
  setup(albedo, true);
  setup(normal, false);
  setup(ord, false);
  const noise = bakeNoise(256);
  noise.anisotropy = aniso;
  return {
    albedo,
    normal,
    ord,
    noise,
    dispose() {
      albedo.dispose();
      normal.dispose();
      ord.dispose();
      noise.dispose();
    },
  };
}

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise with period `p` cells, sampled at (u, v) in [0, 1). */
function vnoise(u: number, v: number, p: number, s: number) {
  const x = u * p;
  const y = v * p;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = ((xi % p) + p) % p;
  const y0 = ((yi % p) + p) % p;
  const x1 = (x0 + 1) % p;
  const y1 = (y0 + 1) % p;
  const a = hash(x0, y0, s);
  const b = hash(x1, y0, s);
  const c = hash(x0, y1, s);
  const d = hash(x1, y1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function bakeNoise(size: number): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const periods = [4, 8, 16, 32];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      for (let c = 0; c < 4; c++) {
        // Two octaves per channel so each has some internal structure.
        const p = periods[c];
        const n = vnoise(u, v, p, c * 7 + 1) * 0.7 + vnoise(u, v, p * 2, c * 7 + 3) * 0.3;
        data[(j * size + i) * 4 + c] = Math.round(n * 255);
      }
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = NoColorSpace;
  t.needsUpdate = true;
  return t;
}
