// GPU FFT for the wind-sea cascades (TSL compute). Two dispatches per frame for all four
// cascades, each a 256-point radix-2 IFFT per row entirely in workgroup memory:
//
//   rows     h(k,t) from h0 and exact integer-tick phases → 4 packed complex channels →
//            IFFT along kx → written transposed into `mid`
//   columns  IFFT along kz → (−1)^(a+b) shift → displacement + derivative array textures
//
// Packing (two real fields per complex IFFT):
//   c0 = Dx + i·Dz      c1 = Dy + i·∂Dx/∂z      c2 = ∂Dy/∂x + i·∂Dy/∂z      c3 = ∂Dx/∂x + i·∂Dz/∂z
// Output, per cascade layer (cascade frame, see spectrum.ts `rot`):
//   disp  = (λ·Dx, Dy, λ·Dz, λ·∂Dx/∂z)      deriv = (∂Dy/∂x, ∂Dy/∂z, λ·∂Dx/∂x, λ·∂Dz/∂z)
// Each mode h0(k) travels along +k: h(k,t) = h0(k)·e^{−iωt} + conj(h0(−k))·e^{iωt}.

import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
  StorageArrayTexture,
  StorageBufferAttribute,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { CASCADES, FFT_N, N_CASCADES, type Spectrum } from './spectrum';
import { TICKS } from './swell';

// The TSL typings are too narrow for shader code like this; treat nodes as untyped.
const {
  Fn, If, cos, float, globalId, instancedArray, int, localId, select, sin, sqrt, storage, storageTexture, textureStore, uint, uniform, uvec2, vec4,
  workgroupArray, workgroupBarrier, workgroupId,
} = TSL as unknown as Record<string, (...args: any[]) => TSLNode> & { localId: TSLNode; workgroupId: TSLNode; globalId: TSLNode };

const N = FFT_N;
const HALF = N / 2;
const LOG2N = Math.log2(N);

export interface OceanFFT {
  /** Displacement array texture (N×N×N_CASCADES, rgba16f, mipmapped, repeat). */
  disp: StorageArrayTexture;
  /** Derivative array texture (same layout). */
  deriv: StorageArrayTexture;
  /** Compute nodes, dispatched together once per frame. */
  passes: TSLNode[];
  h0Attr: StorageBufferAttribute;
  qAttr: StorageBufferAttribute;
  midNode: TSLNode;
  pyrNode: TSLNode;
  /** Time in ticks (u32) and per-cascade choppiness. */
  uTicks: TSLNode;
  uChop: TSLNode;
  upload(spec: Spectrum): void;
  /** Run both passes and rebuild the mip chains. */
  dispatch(renderer: WebGPURenderer): void;
  dispose(): void;
}

function makeArrayTarget(name: string) {
  const t = new StorageArrayTexture(N, N, N_CASCADES);
  t.name = name;
  t.type = HalfFloatType;
  t.format = RGBAFormat;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  // Mips are built by our own compute downsample (see mipPasses): three's render-pass mip
  // generator costs one render pass per level and layer.
  (t as unknown as { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
  return t;
}

export function createFFT(spec: Spectrum): OceanFFT {
  const C = N_CASCADES;
  const h0Attr = new StorageBufferAttribute(spec.h0, 4);
  const qAttr = new StorageBufferAttribute(spec.omegaQ, 1);
  const h0Node = storage(h0Attr, 'vec4', C * N * N).toReadOnly();
  const qNode = storage(qAttr, 'uint', C * N * N).toReadOnly();
  const mid = instancedArray(C * N * N * 2, 'vec4');
  const disp = makeArrayTarget('ocean.disp');
  const deriv = makeArrayTarget('ocean.deriv');
  const uTicks = uniform(0, 'uint');
  const uChopV = uniform(new Vector4(0.9, 0.9, 0.9, 0.9));

  const bitrev = (n: TSLNode) => {
    let r: TSLNode = n.bitAnd(uint(1)).shiftLeft(uint(LOG2N - 1));
    for (let b = 1; b < LOG2N; b++) r = r.bitOr(n.shiftRight(uint(b)).bitAnd(uint(1)).shiftLeft(uint(LOG2N - 1 - b)));
    return r;
  };

  const cmul2 = (v: TSLNode, c: TSLNode, s: TSLNode) =>
    vec4(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)), v.z.mul(c).sub(v.w.mul(s)), v.z.mul(s).add(v.w.mul(c)));

  const cascadeConst = (cas: TSLNode, values: number[]) => {
    let r: TSLNode = float(values[values.length - 1]);
    for (let i = values.length - 2; i >= 0; i--) r = select(cas.equal(uint(i)), float(values[i]), r);
    return r;
  };

  /** In-place radix-2 DIT butterflies over `sh` (bit-reversed input). Inverse transform (e^{+i}). */
  const butterflies = (sh: TSLNode, tid: TSLNode) => {
    for (let s = 0; s < LOG2N; s++) {
      const half = 1 << s;
      const pos = tid.bitAnd(uint(half - 1));
      const i0 = tid.shiftRight(uint(s)).shiftLeft(uint(s + 1)).add(pos);
      const i1 = i0.add(uint(half));
      const ang = float(pos).mul(Math.PI / half);
      const c = cos(ang).toVar();
      const sn = sin(ang).toVar();
      const a01 = sh.element(i0.mul(uint(2))).toVar();
      const a23 = sh.element(i0.mul(uint(2)).add(uint(1))).toVar();
      const b01 = cmul2(sh.element(i1.mul(uint(2))), c, sn).toVar();
      const b23 = cmul2(sh.element(i1.mul(uint(2)).add(uint(1))), c, sn).toVar();
      sh.element(i0.mul(uint(2))).assign(a01.add(b01));
      sh.element(i0.mul(uint(2)).add(uint(1))).assign(a23.add(b23));
      sh.element(i1.mul(uint(2))).assign(a01.sub(b01));
      sh.element(i1.mul(uint(2)).add(uint(1))).assign(a23.sub(b23));
      workgroupBarrier();
    }
  };

  const dks = CASCADES.map((c) => (2 * Math.PI) / c.L);

  const rows = Fn(() => {
    const sh = workgroupArray('vec4', N * 2);
    const row = workgroupId.x; // kz index m
    const cas = workgroupId.y;
    const tid = localId.x;
    const dk = cascadeConst(cas, dks);
    for (let e = 0; e < 2; e++) {
      const n = tid.add(uint(e * HALF)).toVar();
      const idx = cas.mul(uint(N * N)).add(row.mul(uint(N))).add(n).toVar();
      const h0 = h0Node.element(idx).toVar();
      // Exact phase: (q·ticks mod 2^24) / 2^24 cycles; u32 multiply wraps mod 2^32.
      const cyc = float(qNode.element(idx).mul(uTicks).bitAnd(uint(TICKS - 1))).mul(1 / TICKS);
      const ph = cyc.mul(2 * Math.PI);
      const c = cos(ph).toVar();
      const s = sin(ph).toVar();
      const hr = h0.x.mul(c).add(h0.y.mul(s)).add(h0.z.mul(c)).sub(h0.w.mul(s)).toVar();
      const hi = h0.y.mul(c).sub(h0.x.mul(s)).add(h0.z.mul(s)).add(h0.w.mul(c)).toVar();
      const kx = float(n).sub(N / 2).mul(dk).toVar();
      const kz = float(row).sub(N / 2).mul(dk).toVar();
      const kl = sqrt(kx.mul(kx).add(kz.mul(kz)));
      const ik = select(kl.greaterThan(1e-6), float(1).div(kl), float(0)).toVar();
      const kxk = kx.mul(ik);
      const kzk = kz.mul(ik);
      const kxz = kx.mul(kz).mul(ik);
      const kxx = kx.mul(kx).mul(ik);
      const kzz = kz.mul(kz).mul(ik);
      // (c0, c1) and (c2, c3) as two vec4s.
      const v01 = vec4(kxk.mul(hi).add(kzk.mul(hr)).negate(), kxk.mul(hr).sub(kzk.mul(hi)), hr.add(kxz.mul(hi)), hi.sub(kxz.mul(hr)));
      const v23 = vec4(
        kx.mul(hi).add(kz.mul(hr)).negate(),
        kx.mul(hr).sub(kz.mul(hi)),
        kxx.mul(hr).negate().add(kzz.mul(hi)),
        kxx.mul(hi).negate().sub(kzz.mul(hr)),
      );
      const dst = bitrev(n).mul(uint(2)).toVar();
      sh.element(dst).assign(v01);
      sh.element(dst.add(uint(1))).assign(v23);
    }
    workgroupBarrier();
    butterflies(sh, tid);
    for (let e = 0; e < 2; e++) {
      const n = tid.add(uint(e * HALF)).toVar();
      // Transposed: mid[cas][n = x index a][row = kz index].
      const o = cas.mul(uint(N)).add(n).mul(uint(N)).add(row).mul(uint(2)).toVar();
      mid.element(o).assign(sh.element(n.mul(uint(2))));
      mid.element(o.add(uint(1))).assign(sh.element(n.mul(uint(2)).add(uint(1))));
    }
  })().compute([N, C, 1], [HALF]);

  const dispStore = storageTexture(disp);
  const derivStore = storageTexture(deriv);
  // Mip pyramid mirror in a buffer: [kind (disp, deriv)][layer][level offset + y·size + x].
  const levels = Math.log2(N) + 1;
  const levelOff: number[] = [];
  let pyrTexels = 0;
  for (let L = 0; L < levels; L++) {
    levelOff.push(pyrTexels);
    pyrTexels += (N >> L) * (N >> L);
  }
  const pyr = instancedArray(2 * C * pyrTexels, 'vec4');
  const pyrIndex = (kind: number, layer: TSLNode, L: number, x: TSLNode, y: TSLNode) =>
    uint(kind * C)
      .add(layer)
      .mul(uint(pyrTexels))
      .add(uint(levelOff[L]))
      .add(y.mul(uint(N >> L)))
      .add(x);

  const cols = Fn(() => {
    const sh = workgroupArray('vec4', N * 2);
    const a = workgroupId.x; // spatial x index
    const cas = workgroupId.y;
    const tid = localId.x;
    for (let e = 0; e < 2; e++) {
      const m = tid.add(uint(e * HALF)).toVar();
      const idx = cas.mul(uint(N)).add(a).mul(uint(N)).add(m).mul(uint(2)).toVar();
      const dst = bitrev(m).mul(uint(2)).toVar();
      sh.element(dst).assign(mid.element(idx));
      sh.element(dst.add(uint(1))).assign(mid.element(idx.add(uint(1))));
    }
    workgroupBarrier();
    butterflies(sh, tid);
    const lam = select(
      cas.equal(uint(0)),
      uChopV.x,
      select(cas.equal(uint(1)), uChopV.y, select(cas.equal(uint(2)), uChopV.z, uChopV.w)),
    ).toVar();
    for (let e = 0; e < 2; e++) {
      const b = tid.add(uint(e * HALF)).toVar();
      const sign = float(1).sub(float(a.add(b).bitAnd(uint(1))).mul(2)).toVar();
      const v01 = sh.element(b.mul(uint(2))).mul(sign).toVar();
      const v23 = sh.element(b.mul(uint(2)).add(uint(1))).mul(sign).toVar();
      const coord = uvec2(a, b);
      const layer = int(cas);
      const dv = vec4(v01.x.mul(lam), v01.z, v01.y.mul(lam), v01.w.mul(lam)).toVar();
      const vv = vec4(v23.x, v23.y, v23.z.mul(lam), v23.w.mul(lam)).toVar();
      textureStore(dispStore.depth(layer), coord, dv);
      textureStore(derivStore.depth(layer), coord, vv);
      pyr.element(pyrIndex(0, cas, 0, a, b)).assign(dv);
      pyr.element(pyrIndex(1, cas, 0, a, b)).assign(vv);
    }
  })().compute([N, C, 1], [HALF]);

  // Mip chain: level L = 2×2 box of level L−1, read from the pyramid buffer, written to the
  // buffer and to the texture's mip L (one dispatch per level, all layers of both textures).
  const mipPasses: TSLNode[] = [];
  for (let L = 1; L < levels; L++) {
    const size = N >> L;
    const dstD = storageTexture(disp).setMipLevel(L);
    const dstV = storageTexture(deriv).setMipLevel(L);
    const wg = Math.min(8, size);
    const k = Fn(() => {
      const x = globalId.x;
      const y = globalId.y;
      const layer = globalId.z;
      If(x.lessThan(uint(size)).and(y.lessThan(uint(size))), () => {
        const x2 = x.mul(uint(2));
        const y2 = y.mul(uint(2));
        const box = (kind: number) =>
          pyr
            .element(pyrIndex(kind, layer, L - 1, x2, y2))
            .add(pyr.element(pyrIndex(kind, layer, L - 1, x2.add(uint(1)), y2)))
            .add(pyr.element(pyrIndex(kind, layer, L - 1, x2, y2.add(uint(1)))))
            .add(pyr.element(pyrIndex(kind, layer, L - 1, x2.add(uint(1)), y2.add(uint(1)))))
            .mul(0.25);
        const bd = box(0).toVar();
        const bv = box(1).toVar();
        pyr.element(pyrIndex(0, layer, L, x, y)).assign(bd);
        pyr.element(pyrIndex(1, layer, L, x, y)).assign(bv);
        textureStore(dstD.depth(int(layer)), uvec2(x, y), bd);
        textureStore(dstV.depth(int(layer)), uvec2(x, y), bv);
      });
    })().compute([Math.ceil(size / wg), Math.ceil(size / wg), C], [wg, wg, 1]);
    mipPasses.push(k);
  }

  const fft: OceanFFT = {
    disp,
    deriv,
    passes: [rows, cols, ...mipPasses],
    h0Attr,
    qAttr,
    midNode: mid,
    pyrNode: pyr,
    uTicks,
    uChop: uChopV,
    upload(s: Spectrum) {
      h0Attr.array.set(s.h0);
      h0Attr.needsUpdate = true;
      qAttr.array.set(s.omegaQ);
      qAttr.needsUpdate = true;
    },
    dispatch(renderer) {
      // One compute pass: both FFT stages, then the mip chain.
      renderer.compute(fft.passes);
    },
    dispose() {
      for (let i = 0; i < fft.passes.length; i++) fft.passes[i].dispose();
      disp.dispose();
      deriv.dispose();
    },
  };
  return fft;
}
