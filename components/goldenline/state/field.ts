// One toroidally scrolled, texel-snapped simulation field. Storage is world-anchored: world
// texel W always lives at storage texel W mod n, so moving the window never resamples anything
// (no swimming by construction). Texels that newly enter the window are detected in the kernel
// (their source lies outside the previous window) and re-initialised.
//
// Water fields also carry a drift frame: the mean current moves the content by whole texels
// (exact, no numerical diffusion), and the sub-texel remainder `df` is applied by readers.

import { HalfFloatType, LinearFilter, RGBAFormat, RepeatWrapping, StorageTexture, Vector2, Vector4 } from 'three/webgpu';
import { uniform } from './tsl';
import type { TSLNode } from '../core/contracts';
import type { FrameConsts } from './frame';

export class Field {
  readonly n: number;
  readonly texel: number;
  readonly size: number;
  /** Window min corner in world texels (current / previous frame). */
  ox = 0;
  oz = 0;
  pox = 0;
  poz = 0;
  /** Accumulated drift (m), its integer part (texels) and this frame's integer shift. */
  dx = 0;
  dz = 0;
  dix = 0;
  diz = 0;
  shiftX = 0;
  shiftZ = 0;
  /** True until the first dispatch: every texel initialises. */
  fresh = true;

  /** Kernel uniforms (integers only: Smis never allocate). win = (ox, oz, ox mod n, oz mod n); prev likewise; drift = (shiftX, shiftZ, -, -). */
  readonly win = new Vector4();
  readonly prev = new Vector4();
  readonly drift = new Vector4();
  /** Reader uniform: (unused, unused, size, 1/size). Centre and drift remainder are in FrameConsts. */
  readonly view = new Vector4();
  readonly centre = new Vector2();
  readonly uWin: TSLNode;
  readonly uPrev: TSLNode;
  readonly uDrift: TSLNode;
  readonly uView: TSLNode;
  /** Sub-texel drift remainder (m) and snapped window centre (m), from FrameConsts. */
  readonly uDf: TSLNode;
  readonly uCenter: TSLNode;
  private readonly fc: FrameConsts;
  private readonly slot: number;
  readonly uReset: TSLNode;

  /** Ping-pong pair (written alternately). */
  readonly tex: [StorageTexture, StorageTexture];

  constructor(n: number, texel: number, name: string, fc: FrameConsts, slot: number) {
    this.fc = fc;
    this.slot = slot;
    this.n = n;
    this.texel = texel;
    this.size = n * texel;
    this.tex = [makeTex(n, `${name}0`), makeTex(n, `${name}1`)];
    this.uWin = uniform(this.win);
    this.uPrev = uniform(this.prev);
    this.uDrift = uniform(this.drift);
    this.view.set(0, 0, this.size, 1 / this.size);
    this.uView = uniform(this.view);
    this.uDf = fc.vec2(slot);
    this.uCenter = fc.vec2(slot + 2);
    this.uReset = uniform(1);
  }

  /**
   * Snap the window around `pos` and advance the drift by `drift` (m/s) * time.dt. Zero-alloc;
   * takes objects, not doubles, so no argument is ever boxed.
   */
  advance(pos: { x: number; z: number }, drift: { x: number; z: number } | null, time: { dt: number }) {
    const cx = pos.x;
    const cz = pos.z;
    const dt = time.dt;
    const vx = drift ? drift.x : 0;
    const vz = drift ? drift.z : 0;
    const n = this.n;
    const t = this.texel;
    this.pox = this.ox;
    this.poz = this.oz;
    this.ox = Math.floor(cx / t) - (n >> 1);
    this.oz = Math.floor(cz / t) - (n >> 1);
    if (this.fresh) {
      this.pox = this.ox;
      this.poz = this.oz;
    }
    this.dx += vx * dt;
    this.dz += vz * dt;
    const nix = Math.floor(this.dx / t);
    const niz = Math.floor(this.dz / t);
    this.shiftX = nix - this.dix;
    this.shiftZ = niz - this.diz;
    this.dix = nix;
    this.diz = niz;
    // Keep the drift small: rebasing by whole texels changes nothing observable.
    if (Math.abs(this.dix) > 1 << 20 || Math.abs(this.diz) > 1 << 20) {
      this.dx -= this.dix * t;
      this.dz -= this.diz * t;
      this.dix = 0;
      this.diz = 0;
    }
    const dfx = this.dx - this.dix * t;
    const dfz = this.dz - this.diz * t;
    // Component stores, not set(double, ...) calls: a non-inlined call would box the doubles.
    const w = this.win;
    w.x = this.ox;
    w.y = this.oz;
    w.z = mod(this.ox, n);
    w.w = mod(this.oz, n);
    const p = this.prev;
    p.x = this.pox;
    p.y = this.poz;
    p.z = mod(this.pox, n);
    p.w = mod(this.poz, n);
    const dr = this.drift;
    dr.x = this.shiftX;
    dr.y = this.shiftZ;
    const fd = this.fc.data;
    const s = this.slot;
    fd[s] = dfx;
    fd[s + 1] = dfz;
    fd[s + 2] = (this.ox + n * 0.5) * t;
    fd[s + 3] = (this.oz + n * 0.5) * t;
    this.dfx = dfx;
    this.dfz = dfz;
    this.uReset.value = this.fresh ? 1 : 0;
  }

  /** Sub-texel drift remainder (m), for brush placement in the drift frame (CPU copy). */
  dfx = 0;
  dfz = 0;

  dispose() {
    this.tex[0].dispose();
    this.tex[1].dispose();
  }
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function makeTex(n: number, name: string) {
  const t = new StorageTexture(n, n);
  t.type = HalfFloatType;
  t.format = RGBAFormat;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.generateMipmaps = false;
  (t as unknown as { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
  t.name = `goldenline.state.${name}`;
  return t;
}
