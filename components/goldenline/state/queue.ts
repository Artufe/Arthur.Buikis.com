// The splat queue and its per-frame tile binning. Writers call splat() any number of times per
// frame (zero-alloc: fixed typed arrays). Once per frame the queue is binned into 32x32-texel
// tiles of every field that accepts the splat's kind (a counting sort into one CSR list), then
// uploaded. Each field's kernel reads the list for its tile, so brushes are gathered per texel:
// no atomics, no write races, deterministic order.

import { StorageBufferAttribute } from 'three/webgpu';
import { storage } from './tsl';
import { SPLAT_FOAM, SPLAT_FOOTPRINT, SPLAT_SMOOTH, SPLAT_WAKE, SPLAT_WET, type TSLNode } from '../core/contracts';
import type { Field } from './field';

export const MAX_SPLATS = 1024;
export const TILE = 32;
export const TILE_SHIFT = 5;
const MAX_REFS = 32768;
const MAX_PER_TILE = 255;
/** Brush extent as a multiple of the splat radius, per kind (footprint rims, wake V trail). */
const EXTENT = [1, 2.4, 1, 1.5, 1];

export const KIND_BIT = (k: number) => 1 << k;

/**
 * Give an attribute one permanent update range. three empties `updateRanges` (length = 0) after
 * each upload, and re-pushing would regrow the array's backing store every frame; instead the
 * range object is pinned and only its `count` changes.
 */
export function pinRange(attr: StorageBufferAttribute, range: { start: number; count: number }) {
  attr.updateRanges.length = 0;
  attr.updateRanges.push(range);
  (attr as unknown as { clearUpdateRanges(): void }).clearUpdateRanges = noop;
}
const noop = () => {};

export interface BinnedField {
  field: Field;
  kinds: number;
  /** Tiles along one side (field.n / TILE) and this field's first header slot. */
  tps: number;
  base: number;
  /** Brush positions are in the drift frame. */
  drifting: boolean;
}

export class SplatQueue {
  /** [kind, x, z, radius, strength, dirX, dirZ, side] per splat. */
  readonly data = new Float32Array(MAX_SPLATS * 8);
  count = 0;
  dropped = 0;
  readonly splatAttr: StorageBufferAttribute;
  readonly headerAttr: StorageBufferAttribute;
  readonly refAttr: StorageBufferAttribute;
  readonly splats: TSLNode;
  readonly headers: TSLNode;
  readonly refs: TSLNode;
  readonly fields: BinnedField[] = [];
  readonly headerData: Uint32Array;
  private readonly refData = new Uint32Array(MAX_REFS);
  private readonly counts: Uint32Array;
  private readonly cursor: Uint32Array;
  private hadAny = true;
  private readonly splatRange = { start: 0, count: 0 };
  private readonly refRange = { start: 0, count: 0 };
  /** Last footprint, to tell left from right feet. */
  private lastFootX = 0;
  private lastFootZ = 0;
  private lastFootSide = 1;

  constructor(fields: Array<{ field: Field; kinds: number; drifting: boolean }>) {
    let base = 0;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const tps = f.field.n / TILE;
      this.fields.push({ field: f.field, kinds: f.kinds, tps, base, drifting: f.drifting });
      base += tps * tps;
    }
    this.headerData = new Uint32Array(base);
    this.counts = new Uint32Array(base);
    this.cursor = new Uint32Array(base);
    this.splatAttr = new StorageBufferAttribute(this.data, 4);
    this.headerAttr = new StorageBufferAttribute(this.headerData, 1);
    this.refAttr = new StorageBufferAttribute(this.refData, 1);
    pinRange(this.splatAttr, this.splatRange);
    pinRange(this.refAttr, this.refRange);
    this.splats = storage(this.splatAttr, 'vec4', MAX_SPLATS * 2).toReadOnly();
    this.headers = storage(this.headerAttr, 'uint', base).toReadOnly();
    this.refs = storage(this.refAttr, 'uint', MAX_REFS).toReadOnly();
  }

  /**
   * Queue a splat. Deliberately tiny (a flat write) so TurboFan inlines it at call sites and
   * double arguments are never boxed; validation and footprint handedness happen in flush().
   */
  push(kind: number, x: number, z: number, radius: number, strength: number, dirX: number, dirZ: number) {
    const n = this.count;
    if (n >= MAX_SPLATS) {
      this.dropped++;
      return;
    }
    const o = n * 8;
    const d = this.data;
    d[o] = kind;
    d[o + 1] = x;
    d[o + 2] = z;
    d[o + 3] = radius;
    d[o + 4] = strength;
    d[o + 5] = dirX;
    d[o + 6] = dirZ;
    d[o + 7] = 1;
    this.count = n + 1;
  }

  /**
   * Bulk path for heavy writers: reserve `k` splats and get the float offset of the first (or -1
   * when full); write [kind, x, z, radius, strength, dirX, dirZ, 1] per splat into `data` yourself.
   * No function arguments carry doubles, so nothing can be boxed however the caller is compiled.
   */
  reserve(k: number) {
    const n = this.count;
    if (n + k > MAX_SPLATS) {
      this.dropped += k;
      return -1;
    }
    this.count = n + k;
    return n * 8;
  }

  /** Validate entries in place (invalid ones get kind -1) and orient footprints. */
  private prepare(n: number) {
    const d = this.data;
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      const x = d[o + 1];
      const z = d[o + 2];
      // (s - s) is 0 only for finite s: no builtin call, so nothing gets boxed.
      const s = x + z + d[o + 4] + d[o + 5] + d[o + 6];
      if (!(d[o + 3] > 0) || s - s !== 0 || d[o] < 0 || d[o] > 4) {
        d[o] = -1;
        continue;
      }
      if (d[o] !== SPLAT_FOOTPRINT) continue;
      let dirX = d[o + 5];
      let dirZ = d[o + 6];
      const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
      if (len > 1e-6) {
        dirX /= len;
        dirZ /= len;
      } else {
        dirX = 1;
        dirZ = 0;
      }
      // Left or right foot: which side of the heading the previous footprint sits on.
      const ex = this.lastFootX - x;
      const ez = this.lastFootZ - z;
      const d2 = ex * ex + ez * ez;
      let side: number;
      if (d2 < 1.6 * 1.6 && d2 > 1e-4) {
        const cross = dirX * ez - dirZ * ex;
        side = Math.abs(cross) > 0.02 ? (cross > 0 ? 1 : -1) : -this.lastFootSide;
      } else side = -this.lastFootSide;
      this.lastFootX = x;
      this.lastFootZ = z;
      this.lastFootSide = side;
      d[o + 5] = dirX;
      d[o + 6] = dirZ;
      d[o + 7] = side;
    }
  }


  /** Bin the queued splats into every field's tiles and schedule the uploads. Zero-alloc. */
  flush() {
    const n = this.count;
    if (n === 0 && !this.hadAny) return;
    this.prepare(n);
    this.counts.fill(0);
    const d = this.data;
    // Pass 1: count refs per tile.
    let total = 0;
    for (let i = 0; i < n; i++) total = this.visit(i, d, 0, total);
    // Prefix sum into header starts.
    let run = 0;
    const h = this.headerData;
    for (let t = 0; t < h.length; t++) {
      const c = this.counts[t];
      h[t] = (run << 8) | c;
      this.cursor[t] = run;
      run += c;
    }
    // Pass 2: fill.
    for (let i = 0; i < n; i++) this.visit(i, d, 1, 0);

    this.headerAttr.needsUpdate = true;
    if (n > 0) {
      this.splatRange.count = n * 8;
      this.splatAttr.needsUpdate = true;
    }
    if (run > 0) {
      this.refRange.count = run;
      this.refAttr.needsUpdate = true;
    }
    this.hadAny = n > 0;
    this.count = 0;
  }

  /** mode 0: count (returns the new running total), mode 1: write refs. */
  private visit(i: number, d: Float32Array, mode: number, total: number) {
    const o = i * 8;
    const kind = d[o];
    if (kind < 0) return total;
    const bit = 1 << kind;
    const ext = d[o + 3] * EXTENT[kind];
    const fields = this.fields;
    for (let f = 0; f < fields.length; f++) {
      const bf = fields[f];
      if ((bf.kinds & bit) === 0) continue;
      const fl = bf.field;
      const t = fl.texel;
      const x = bf.drifting ? d[o + 1] - fl.dfx : d[o + 1];
      const z = bf.drifting ? d[o + 2] - fl.dfz : d[o + 2];
      // At least one texel of reach, so sub-texel brushes still land.
      const e = ext > t ? ext : t;
      let x0 = Math.floor((x - e) / t) - 1;
      let x1 = Math.floor((x + e) / t) + 1;
      let z0 = Math.floor((z - e) / t) - 1;
      let z1 = Math.floor((z + e) / t) + 1;
      if (x0 < fl.ox) x0 = fl.ox;
      if (z0 < fl.oz) z0 = fl.oz;
      if (x1 > fl.ox + fl.n - 1) x1 = fl.ox + fl.n - 1;
      if (z1 > fl.oz + fl.n - 1) z1 = fl.oz + fl.n - 1;
      if (x0 > x1 || z0 > z1) continue;
      const tx0 = x0 >> TILE_SHIFT;
      const tx1 = x1 >> TILE_SHIFT;
      const tz0 = z0 >> TILE_SHIFT;
      const tz1 = z1 >> TILE_SHIFT;
      const tps = bf.tps;
      for (let tz = tz0; tz <= tz1; tz++) {
        const sz = ((tz % tps) + tps) % tps;
        for (let tx = tx0; tx <= tx1; tx++) {
          const sx = ((tx % tps) + tps) % tps;
          const slot = bf.base + sz * tps + sx;
          if (mode === 0) {
            if (this.counts[slot] < MAX_PER_TILE && total < MAX_REFS) {
              this.counts[slot]++;
              total++;
            }
          } else {
            const c = this.cursor[slot];
            const end = (this.headerData[slot] >>> 8) + (this.headerData[slot] & 255);
            if (c < end) {
              this.refData[c] = i;
              this.cursor[slot] = c + 1;
            }
          }
        }
      }
    }
    return total;
  }
}

export const WATER_NEAR_KINDS = KIND_BIT(SPLAT_FOAM) | KIND_BIT(SPLAT_WAKE);
export const FAR_KINDS = KIND_BIT(SPLAT_FOAM) | KIND_BIT(SPLAT_WET) | KIND_BIT(SPLAT_SMOOTH);
export const SAND_KINDS = KIND_BIT(SPLAT_WET) | KIND_BIT(SPLAT_FOOTPRINT) | KIND_BIT(SPLAT_SMOOTH);
