// Active-tile schedule for the sand field. Almost everything that happens to sand is slow
// (drying, refill), so the full 2048² field doesn't need a pass every frame. Each frame the
// kernel runs only on:
//   - update tiles: touched by a splat, just scrolled into the window, or this frame's rolling
//     1/N slice. Each integrates the time since that tile was last updated (per-tile clock),
//     so slow processes are exact, just stepped at 60/N Hz.
//   - sync tiles: last frame's update tiles, re-run with dt = 0 so both ping-pong textures hold
//     the same state again (the reader always samples the latest one).
// Zero-alloc: fixed typed arrays, uploaded as one small storage buffer.

import { StorageBufferAttribute } from 'three/webgpu';
import type { TSLNode } from '../core/contracts';
import type { Field } from './field';
import { TILE, TILE_SHIFT, pinRange } from './queue';
import { storage } from './tsl';

export class ActiveTiles {
  readonly tps: number;
  readonly count: number;
  /** (tile index, dt) per scheduled tile. */
  readonly data: Float32Array;
  readonly attr: StorageBufferAttribute;
  readonly list: TSLNode;
  /** Compute dispatch size, mutated per frame: [tiles, 16 workgroups per tile, 1]. */
  readonly dispatch: [number, number, number] = [0, 16, 1];
  used = 0;
  private readonly since: Float32Array;
  private readonly isUpdate: Uint8Array;
  private readonly wasUpdate: Uint8Array;
  private frame = 0;
  private readonly range = { start: 0, count: 0 };

  constructor(readonly field: Field, readonly slices = 8) {
    this.tps = field.n / TILE;
    this.count = this.tps * this.tps;
    this.data = new Float32Array(this.count * 2);
    this.since = new Float32Array(this.count);
    this.isUpdate = new Uint8Array(this.count);
    this.wasUpdate = new Uint8Array(this.count);
    this.attr = new StorageBufferAttribute(this.data, 2);
    this.list = storage(this.attr, 'vec2', this.count).toReadOnly();
    pinRange(this.attr, this.range);
  }

  /** Mark the tiles covering world-texel rect [x0, x1] x [z0, z1] (inclusive) for update. */
  markRect(x0: number, x1: number, z0: number, z1: number) {
    const f = this.field;
    if (x0 < f.ox) x0 = f.ox;
    if (z0 < f.oz) z0 = f.oz;
    if (x1 > f.ox + f.n - 1) x1 = f.ox + f.n - 1;
    if (z1 > f.oz + f.n - 1) z1 = f.oz + f.n - 1;
    if (x0 > x1 || z0 > z1) return;
    const tps = this.tps;
    for (let tz = z0 >> TILE_SHIFT; tz <= z1 >> TILE_SHIFT; tz++) {
      const sz = ((tz % tps) + tps) % tps;
      for (let tx = x0 >> TILE_SHIFT; tx <= x1 >> TILE_SHIFT; tx++) this.isUpdate[sz * tps + (((tx % tps) + tps) % tps)] = 1;
    }
  }

  /** Mark every tile whose storage slot holds a header count > 0 (splats binned this frame). */
  markFromHeaders(headers: Uint32Array, base: number) {
    for (let t = 0; t < this.count; t++) if ((headers[base + t] & 255) !== 0) this.isUpdate[t] = 1;
  }

  /** Call after the field advanced and splats were binned: marks scroll-in and rolling tiles and builds the list. */
  build(time: { dt: number }) {
    const dt = time.dt;
    const f = this.field;
    const n = f.n;
    const all = f.fresh || Math.abs(f.ox - f.pox) >= n || Math.abs(f.oz - f.poz) >= n;
    for (let t = 0; t < this.count; t++) this.since[t] += dt;
    if (all) this.isUpdate.fill(1);
    else {
      // Strips that entered the window this frame.
      if (f.ox > f.pox) this.markRect(f.pox + n, f.ox + n - 1, f.oz, f.oz + n - 1);
      else if (f.ox < f.pox) this.markRect(f.ox, f.pox - 1, f.oz, f.oz + n - 1);
      if (f.oz > f.poz) this.markRect(f.ox, f.ox + n - 1, f.poz + n, f.oz + n - 1);
      else if (f.oz < f.poz) this.markRect(f.ox, f.ox + n - 1, f.oz, f.poz - 1);
      const k = this.frame % this.slices;
      for (let t = k; t < this.count; t += this.slices) this.isUpdate[t] = 1;
    }
    let u = 0;
    const d = this.data;
    for (let t = 0; t < this.count; t++) {
      if (this.isUpdate[t]) {
        d[u * 2] = t;
        d[u * 2 + 1] = this.since[t];
        this.since[t] = 0;
        u++;
      } else if (this.wasUpdate[t]) {
        d[u * 2] = t;
        d[u * 2 + 1] = 0;
        u++;
      }
    }
    // Next frame's sync set is this frame's update set.
    this.wasUpdate.set(this.isUpdate);
    this.isUpdate.fill(0);
    this.used = u;
    this.dispatch[0] = Math.max(1, u);
    if (u === 0) {
      // Keep the dispatch valid; a dt of 0 on tile 0 is a harmless copy... except tile 0 may be
      // stale in the other buffer, so point it at a tile that is in sync (any: nothing changed).
      d[0] = 0;
      d[1] = 0;
      u = 1;
    }
    this.range.count = u * 2;
    this.attr.needsUpdate = true;
    this.frame++;
  }
}
