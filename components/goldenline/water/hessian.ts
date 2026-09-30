// Per-cascade world Hessian of the FFT sea surface, (∂²h/∂x², ∂²h/∂x∂z, ∂²h/∂z², 0), with a
// full mip chain: level L is the central difference of A2's slope mip L (box-filtered slopes), so
// sampling it at a coarser level gives the curvature of the smoothed surface — exactly what a
// deeper seabed's blurred caustics respond to. Built each frame in compute after the FFT (one
// dispatch per level, all layers), so the caustics cost one fetch per cascade instead of four.

import { HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, StorageArrayTexture, type Texture, type WebGPURenderer } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { CASCADES, FFT_N, N_CASCADES } from '../ocean/spectrum';

const { Fn, If, float, globalId, int, ivec2, select, storageTexture, textureLoad, textureStore, uint, uvec2, vec4 } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode> & { globalId: TSLNode };

/** Highest mip level written (and sampled): three's compute path allocates per dispatch. */
export const HESSIAN_MAX_LOD = 5;

export interface Hessian {
  texture: StorageArrayTexture;
  dispatch(renderer: WebGPURenderer): void;
  dispose(): void;
}

export function createHessian(deriv: Texture): Hessian {
  const N = FFT_N;
  const C = N_CASCADES;
  const tex = new StorageArrayTexture(N, N, C);
  tex.name = 'water.hessian';
  tex.type = HalfFloatType;
  tex.format = RGBAFormat;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // Every level is written by our own compute below.
  (tex as unknown as { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;

  const perCascade = (layer: TSLNode, values: number[]) => {
    let r: TSLNode = float(values[values.length - 1]);
    for (let i = values.length - 2; i >= 0; i--) r = select(layer.equal(uint(i)), float(values[i]), r);
    return r;
  };
  const cosR = CASCADES.map((c) => Math.cos(c.rot));
  const sinR = CASCADES.map((c) => Math.sin(c.rot));
  // Levels the caustics actually sample (their lod is clamped to HESSIAN_MAX_LOD), written by
  // two dispatches: levels 0-3 over the level-0 grid (threads inside a level's extent also write
  // that level; the default limit is 4 storage textures per stage), then 4..MAX.
  const writeLevel = (L: number, x: TSLNode, y: TSLNode, layer: TSLNode) => {
    const size = N >> L;
    const dst = storageTexture(tex).setMipLevel(L);
    const inv = CASCADES.map((c) => 1 / (2 * ((c.L / N) * (1 << L))));
    If(x.lessThan(uint(size)).and(y.lessThan(uint(size))), () => {
      const wrap = (v: TSLNode, o: number) => int(v.add(uint(size + o)).bitAnd(uint(size - 1)));
      const ld = (dx: number, dy: number) => textureLoad(deriv, ivec2(wrap(x, dx), wrap(y, dy))).level(int(L)).depth(int(layer)).xy;
      const px = ld(1, 0).toVar();
      const mx = ld(-1, 0).toVar();
      const pz = ld(0, 1).toVar();
      const mz = ld(0, -1).toVar();
      const s = perCascade(layer, inv).toVar();
      // Cascade frame (x', z'): a = ∂²h/∂x'², d = ∂²h/∂z'², b = ∂²h/∂x'∂z' (symmetrised).
      const a = px.x.sub(mx.x).mul(s).toVar();
      const d = pz.y.sub(mz.y).mul(s).toVar();
      const b = pz.x.sub(mz.x).add(px.y.sub(mx.y)).mul(s).mul(0.5).toVar();
      const cr = perCascade(layer, cosR).toVar();
      const sr = perCascade(layer, sinR).toVar();
      const cs = cr.mul(sr);
      const c2 = cr.mul(cr);
      const s2 = sr.mul(sr);
      const hxx = a.mul(c2).sub(b.mul(cs).mul(2)).add(d.mul(s2));
      const hxz = a.mul(cs).add(b.mul(c2.sub(s2))).sub(d.mul(cs));
      const hzz = a.mul(s2).add(b.mul(cs).mul(2)).add(d.mul(c2));
      textureStore(dst.depth(int(layer)), uvec2(x, y), vec4(hxx, hxz, hzz, 0));
    });
  };
  const passes: TSLNode[] = [];
  const groups: number[][] = [];
  for (let L = 0; L <= HESSIAN_MAX_LOD; L += 4) {
    const g: number[] = [];
    for (let k = L; k <= Math.min(L + 3, HESSIAN_MAX_LOD); k++) g.push(k);
    groups.push(g);
  }
  for (const g of groups) {
    const size = N >> g[0];
    const wg = Math.min(8, size);
    const k = Fn(() => {
      const x = globalId.x;
      const y = globalId.y;
      const layer = globalId.z;
      for (const L of g) writeLevel(L, x, y, layer);
    })().compute([Math.ceil(size / wg), Math.ceil(size / wg), C], [wg, wg, 1]);
    passes.push(k);
  }

  return {
    texture: tex,
    dispatch(renderer) {
      renderer.compute(passes);
    },
    dispose() {
      for (let i = 0; i < passes.length; i++) passes[i].dispose();
      tex.dispose();
    },
  };
}
