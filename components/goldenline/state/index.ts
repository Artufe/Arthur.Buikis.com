// GOLDENLINE surface state & interaction buffers (BRIEF §3.3). Everything writes here through
// splat(); the water and sand shaders read foam(), wake() and sand(). See README.md.
//
// Three toroidal, texel-snapped fields follow the camera:
//   far   1024² × 0.4 m  (410 m)  foam + age (drifting), wetness + smoothed (static)
//   near  1024² × 0.1 m  (102 m)  foam, age, disturbance + wake height, dh/dt, flow velocity
//   sand  2048² × 2.5 cm (51 m)   wetness, depression, displaced mass, freshly smoothed
// One compute pass per frame, three dispatches, each stamping its binned brushes.

import { Vector2, Vector4 } from 'three/webgpu';
import { uniform } from './tsl';
import type { GLContext, GLSystem, SplatKind, SurfaceStateService, TSLNode } from '../core/contracts';
import { DebugScene } from './debug-scene';
import { createDebugView, type DebugView } from './debug-view';
import { Field, makeTex } from './field';
import { createKernels } from './kernels';
import { createNoise, type Noise } from './noise';
import { createStatic, type Static } from './static';
import { FC_DT, FC_FAR, FC_LACE, FC_NEAR, FC_SAND, FC_TIME, FrameConsts } from './frame';
import { ActiveTiles } from './active';
import { FAR_KINDS, MAX_SPLATS, SAND_KINDS, SplatQueue, WATER_NEAR_KINDS } from './queue';
import { createReaders, type Readers } from './readers';
import { GLOBAL_DRIFT, makeTerrainHeight, type Tunables } from './shared';

export const FAR_N = 1024;
export const FAR_TEXEL = 0.4;
export const NEAR_N = 1024;
export const NEAR_TEXEL = 0.1;
export const SAND_N = 2048;
export const SAND_TEXEL = 0.025;

export function createStateSystem(): GLSystem {
  let sim: StateSim | null = null;
  return {
    name: 'state',
    init(ctx) {
      sim = new StateSim(ctx);
      ctx.services.state = sim.service;
      if (process.env.NODE_ENV !== 'production' || ctx.time.frozen) {
        const s = sim;
        (sim.service as unknown as { __allocTest: unknown }).__allocTest = (n: number, k: number, st?: number) => s.allocTest(ctx, n, k, st);
        (sim.service as unknown as { __bench: unknown }).__bench = (n: number, mask: number) => s.bench(ctx, n, mask);
        (sim.service as unknown as { __probe: unknown }).__probe = (w: 'far' | 'near' | 'wake' | 'sand', x: number, z: number, d = false, bw = 1, bh = 1) =>
          s.probe(ctx, w, x, z, d, bw, bh);
      }
    },
    warmup(ctx) {
      return sim?.warmup(ctx);
    },
    update(ctx) {
      sim?.update(ctx);
    },
    dispose(ctx) {
      sim?.dispose(ctx);
      sim = null;
    },
  };
}

class StateSim {
  readonly fc = new FrameConsts();
  readonly far = new Field(FAR_N, FAR_TEXEL, 'far', this.fc, FC_FAR);
  readonly near = new Field(NEAR_N, NEAR_TEXEL, 'near', this.fc, FC_NEAR);
  readonly nearB = [makeTex(NEAR_N, 'wake0'), makeTex(NEAR_N, 'wake1')] as [ReturnType<typeof makeTex>, ReturnType<typeof makeTex>];
  readonly sand = new Field(SAND_N, SAND_TEXEL, 'sand', this.fc, FC_SAND);
  readonly queue: SplatQueue;
  readonly service: SurfaceStateService & {
    sandHeight(xz: TSLNode): TSLNode;
    sandTexel: number;
    nearTexel: number;
    splatData: Float32Array;
    reserve(k: number): number;
  };
  private readonly readers: Readers;
  private readonly noise: Noise;
  private readonly st: Static;
  private readonly active: ActiveTiles;
  private readonly lists: TSLNode[][];
  /** Per parity, per enable mask (bit 0 far, 1 near, 2 sand): the dispatch list, prebuilt. */
  private readonly subsets: TSLNode[][][] = [[], []];
  private readonly fieldOn: Array<{ value: boolean }>;
  private parity = 0;
  private readonly tn: Tunables;
  private readonly uSeed = uniform(new Vector4());
  private rng = 0x2545f49;
  private readonly offParams: () => void;
  private readonly clock = { dt: 0 };
  private readonly p: {
    enabled: { value: boolean };
    foamLife: { value: number };
    lace: { value: number };
    surfCurrent: { value: number };
    rip: { value: number };
    advect: { value: boolean };
    wakeSpeed: { value: number };
    wakeDamping: { value: number };
    wakeDispersion: { value: number };
    dryTime: { value: number };
    filmTime: { value: number };
    satTime: { value: number };
    swashFloor: { value: number };
    refillWet: { value: number };
    debugScene: { value: boolean };
    debugDolly: { value: number };
  };
  private readonly uT0 = uniform(new Vector4());
  private readonly uT1 = uniform(new Vector4());
  private readonly uT2 = uniform(new Vector4());
  private readonly uT3 = uniform(new Vector4());
  private readonly debugScene = new DebugScene();
  private debugWasOn = false;
  private readonly view: DebugView;

  constructor(ctx: GLContext) {
    const P = ctx.params;
    const g = 'state';
    this.p = {
      enabled: P.toggle('state.enabled', { label: 'surface state', group: g, value: true }),
      foamLife: P.number('state.foamLife', { label: 'foam persistence (s)', group: g, min: 5, max: 120, value: 60 }),
      lace: P.number('state.foamLace', { label: 'foam lace break-up', group: g, min: 0, max: 1, value: 0.85 }),
      surfCurrent: P.number('state.surfCurrent', { label: 'surf-zone current (m/s)', group: g, min: 0, max: 1, value: 0.22 }),
      rip: P.number('state.rip', { label: 'channel rip (m/s)', group: g, min: 0, max: 1, value: 0.32 }),
      advect: P.toggle('state.advect', { label: 'foam advection', group: g, value: true }),
      wakeSpeed: P.number('state.wakeSpeed', { label: 'wake wave speed (m/s)', group: g, min: 0.3, max: 2.4, value: 1.15 }),
      wakeDamping: P.number('state.wakeDamping', { label: 'wake damping (1/s)', group: g, min: 0, max: 3, value: 0.45 }),
      wakeDispersion: P.number('state.wakeDispersion', { label: 'wake dispersion', group: g, min: 0, max: 0.9, value: 0.7 }),
      dryTime: P.number('state.dryTime', { label: 'sand drying (s)', group: g, min: 10, max: 900, value: 260 }),
      filmTime: P.number('state.filmTime', { label: 'swash film drain (s)', group: g, min: 0.5, max: 20, value: 5 }),
      satTime: P.number('state.satTime', { label: 'wet sheen drain (s)', group: g, min: 1, max: 120, value: 12 }),
      swashFloor: P.number('state.swashFloor', { label: 'swash-band dampness', group: g, min: 0, max: 0.9, value: 0.3 }),
      refillWet: P.number('state.refillWet', { label: 'wet footprint refill (s)', group: g, min: 5, max: 600, value: 140 }),
      debugScene: P.toggle('state.debugScene', { label: 'debug writer scene', group: g, value: false }),
      debugDolly: P.number('state.debugDolly', { label: 'debug camera dolly (m/s, -Z)', group: g, min: -4, max: 4, value: 0 }),
    };
    this.fieldOn = [
      P.toggle('state.simFar', { label: 'far field sim', group: g, value: true }),
      P.toggle('state.simNear', { label: 'near water sim', group: g, value: true }),
      P.toggle('state.simSand', { label: 'sand sim', group: g, value: true }),
    ];
    // Tunables and the clock live in Vector4 uniforms: their components are double fields that
    // are mutated in place, whereas assigning a double to a scalar uniform's `value` allocates.
    const T0 = this.uT0;
    const T1 = this.uT1;
    const T2 = this.uT2;
    const T3 = this.uT3;
    this.tn = {
      foamLife: T0.x,
      lace: T0.y,
      surfCurrent: T0.z,
      rip: T0.w,
      advect: T1.x,
      wakeSpeed: T1.y,
      wakeDamping: T1.z,
      wakeDispersion: T1.w,
      dryTime: T2.x,
      filmTime: T2.y,
      satTime: T3.x,
      swashFloor: T2.z,
      refillWet: T2.w,
      laceOrigin: this.fc.vec2(FC_LACE),
      dt: this.fc.el(FC_DT),
      time: this.fc.el(FC_TIME),
      seed: this.uSeed,
    };
    // Tunables change only from the overlay / debug hook: sync on change, not every frame.
    this.syncTunables();
    this.offParams = ctx.params.onChange(() => this.syncTunables());

    this.queue = new SplatQueue([
      { field: this.far, kinds: FAR_KINDS, drifting: false },
      { field: this.near, kinds: WATER_NEAR_KINDS, drifting: true },
      { field: this.sand, kinds: SAND_KINDS, drifting: false },
    ]);
    const terrainH = makeTerrainHeight(ctx.services.terrain);
    this.noise = createNoise(ctx.renderer);
    this.active = new ActiveTiles(this.sand, 8);
    this.st = createStatic(ctx.renderer, ctx.services.terrain, terrainH, this.noise, this.tn);
    this.lists = createKernels({
      far: this.far,
      near: this.near,
      nearB: this.nearB,
      sand: this.sand,
      queue: this.queue,
      tn: this.tn,
      st: this.st,
      noise: this.noise,
      active: this.active,
      // Where the surf-zone simulation has water on the sand (ocean/surfzone; the ocean
      // initialises before the state).
      wetSrc: (ctx.services.ocean.gpu as { surfzone?: { wet?(xz: TSLNode, edge?: number): TSLNode } }).surfzone?.wet,
    }).lists;
    for (let p = 0; p < 2; p++) {
      for (let m = 0; m < 8; m++) {
        const l: TSLNode[] = [];
        for (let f = 0; f < 3; f++) if (m & (1 << f)) l.push(this.lists[p][f]);
        this.subsets[p].push(l);
      }
    }
    this.readers = createReaders(this.far, this.near, this.nearB, this.sand);

    const q = this.queue;
    const qd = q.data;
    const r = this.readers;
    this.service = {
      // The write is inlined here (no second call) so callers' doubles have no call to be boxed at.
      splat(kind: SplatKind, x: number, z: number, radius: number, strength: number, dirX = 0, dirZ = 0) {
        const n = q.count;
        if (n >= MAX_SPLATS) {
          q.dropped++;
          return;
        }
        const o = n * 8;
        const d = qd;
        d[o] = kind;
        d[o + 1] = x;
        d[o + 2] = z;
        d[o + 3] = radius;
        d[o + 4] = strength;
        d[o + 5] = dirX;
        d[o + 6] = dirZ;
        d[o + 7] = 1;
        q.count = n + 1;
      },
      foam: (xz: TSLNode) => r.foam(xz),
      wake: (xz: TSLNode) => r.wake(xz),
      sand: (xz: TSLNode) => r.sand(xz),
      sandHeight: (xz: TSLNode) => r.sandHeight(xz),
      center: new Vector2(),
      size: this.near.size,
      sandTexel: SAND_TEXEL,
      nearTexel: NEAR_TEXEL,
      splatData: q.data,
      reserve: (k: number) => q.reserve(k),
    };
    this.view = createDebugView(ctx, this.service, terrainH);
  }

  /**
   * Dev/review only: read back one texel of a field at world (x, z). `drift` selects the drift
   * frame (water channels). Returns the four channels as floats.
   */
  async probe(ctx: GLContext, which: 'far' | 'near' | 'wake' | 'sand', x: number, z: number, drift: boolean, w = 1, h = 1) {
    const f = which === 'far' ? this.far : which === 'sand' ? this.sand : this.near;
    const tex = which === 'wake' ? this.nearB[this.parity] : f.tex[this.parity];
    const px = drift ? x - f.dfx : x;
    const pz = drift ? z - f.dfz : z;
    const sx = (((Math.floor(px / f.texel) % f.n) + f.n) % f.n) | 0;
    const sz = (((Math.floor(pz / f.texel) % f.n) + f.n) % f.n) | 0;
    const backend = ctx.renderer.backend as unknown as { textureUtils: { copyTextureToBuffer(t: unknown, x: number, y: number, w: number, h: number, f: number): Promise<Uint16Array> } };
    // Clamp the block so it doesn't cross the storage seam (callers probe well inside the window).
    const bx = Math.min(sx, f.n - w);
    const bz = Math.min(sz, f.n - h);
    const raw = await backend.textureUtils.copyTextureToBuffer(tex, bx, bz, w, h, 0);
    const row = Math.ceil((w * 8) / 256) * 128;
    const out: number[] = [];
    for (let j = 0; j < h; j++) for (let i = 0; i < w * 4; i++) out.push(half(raw[j * row + i]));
    return out;
  }

  /** Dev/review only: GPU ms per frame of the kernels selected by `mask`, timed in isolation. */
  async bench(ctx: GLContext, n: number, mask: number) {
    const r = ctx.renderer as unknown as { resolveTimestampsAsync(t: string): Promise<number | undefined> };
    this.fc.data[FC_DT] = 1 / 60;
    await r.resolveTimestampsAsync('compute');
    // Submitted synchronously and resolved before yielding, so no frame's passes are included.
    for (let i = 0; i < n; i++) {
      const list = this.subsets[this.parity][mask];
      if (list.length) ctx.renderer.compute(list);
      this.parity ^= 1;
    }
    const ms = ((await r.resolveTimestampsAsync('compute')) ?? NaN) / n;
    this.readers.select(this.parity);
    return ms;
  }

  private syncTunables() {
    // Only store what changed (a double stored into a Vector field allocates, see frame.ts), and
    // compare inline: passing a param's double into a helper call would box it.
    const p = this.p;
    const a = this.uT0.value;
    if (a.x !== p.foamLife.value) a.x = p.foamLife.value;
    if (a.y !== p.lace.value) a.y = p.lace.value;
    if (a.z !== p.surfCurrent.value) a.z = p.surfCurrent.value;
    if (a.w !== p.rip.value) a.w = p.rip.value;
    const b = this.uT1.value;
    const adv = p.advect.value ? 1 : 0;
    if (b.x !== adv) b.x = adv;
    if (b.y !== p.wakeSpeed.value) b.y = p.wakeSpeed.value;
    if (b.z !== p.wakeDamping.value) b.z = p.wakeDamping.value;
    if (b.w !== p.wakeDispersion.value) b.w = p.wakeDispersion.value;
    const c = this.uT2.value;
    if (c.x !== p.dryTime.value) c.x = p.dryTime.value;
    if (c.y !== p.filmTime.value) c.y = p.filmTime.value;
    if (c.z !== p.swashFloor.value) c.z = p.swashFloor.value;
    if (c.w !== p.refillWet.value) c.w = p.refillWet.value;
    const e = this.uT3.value;
    if (e.x !== p.satTime.value) e.x = p.satTime.value;
  }





  async warmup(ctx: GLContext) {
    // Both parities of every kernel, with a splat of each kind, then the debug views.
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 5; k++) {
        const c = ctx.camera.position;
        this.service.splat(k as SplatKind, c.x + 2, c.z, 0.2, 0.001, 1, 0);
      }
      this.step(ctx, 1 / 60);
    }
    await this.view.warmup(ctx);
  }

  update(ctx: GLContext) {
    if (!this.p.enabled.value) {
      this.queue.count = 0;
      return;
    }
    if (this.p.debugScene.value) {
      if (!this.debugWasOn) this.debugScene.reset(ctx.services.terrain);
      this.debugScene.update(this.service, ctx.time.t, ctx.time.dt);
    }
    this.debugWasOn = this.p.debugScene.value;
    // Review aid: slide a locked (shot) camera along -Z to prove the windows scroll without swimming.
    if (this.p.debugDolly.value !== 0 && ctx.debug.cameraLocked && ctx.time.dt > 0) {
      ctx.camera.position.z -= this.p.debugDolly.value * ctx.time.dt;
      ctx.camera.updateMatrixWorld();
    }
    this.step(ctx, ctx.time.dt);
    this.view.update(ctx);
  }

  private step(ctx: GLContext, dt: number) {
    this.cpuStep(ctx, dt);
    const mask = (this.fieldOn[0].value ? 1 : 0) | (this.fieldOn[1].value ? 2 : 0) | (this.fieldOn[2].value ? 4 : 0);
    const list = this.subsets[this.parity][mask];
    if (list.length > 0) ctx.renderer.compute(list);
    this.parity ^= 1;
    this.readers.select(this.parity);
    this.far.fresh = false;
    this.near.fresh = false;
    this.sand.fresh = false;
  }

  /** Everything update() does on the CPU: window scroll, splat binning, tile schedule, uniforms. */
  private cpuStep(ctx: GLContext, dt: number) {
    const c = ctx.camera.position;
    const clk = this.clock;
    clk.dt = dt;
    this.far.advance(c, GLOBAL_DRIFT, clk);
    this.near.advance(c, GLOBAL_DRIFT, clk);
    this.sand.advance(c, null, clk);
    // Direct component stores (double fields, mutated in place) rather than set(double, ...) calls.
    // The contract's Vector2 is only written when the window actually moves (a texel step).
    const ctr = this.service.center;
    const cx = (this.near.ox + NEAR_N * 0.5) * NEAR_TEXEL;
    const cz = (this.near.oz + NEAR_N * 0.5) * NEAR_TEXEL;
    if (ctr.x !== cx) ctr.x = cx;
    if (ctr.y !== cz) ctr.y = cz;
    this.queue.flush();
    this.active.markFromHeaders(this.queue.headerData, this.queue.fields[2].base);
    this.active.build(clk);
    const fd = this.fc.data;
    fd[FC_DT] = dt;
    fd[FC_TIME] = ctx.time.t;
    fd[FC_LACE] = this.near.dx;
    fd[FC_LACE + 1] = this.near.dz;
    // Integer LCG kept to 30 bits so the state stays a Smi (31-bit with pointer compression): a
    // non-Smi integer or a Math.random() double stored in a field would allocate.
    const r = (this.rng * 1103 + 12345) & 0x3fffffff; // exact in a double (< 2^53), no builtin call
    this.rng = r;
    const sd = this.uSeed.value;
    sd.x = r & 511;
    sd.y = (r >>> 9) & 511;
    sd.z = (r >>> 18) & 1023;
    sd.w = (r >>> 4) & 1023;
  }

  /**
   * Dev/review only: run the CPU side of `n` frames with `splats` splats queued each (mixed kinds,
   * spread over the windows), without dispatching. Used to measure heap growth (zero-alloc proof).
   */
  allocTest(ctx: GLContext, n: number, splats: number, stage = 9) {
    const c = ctx.camera.position;
    for (let f = 0; f < n; f++) {
      if (stage === 8) {
        // The bulk path: no double arguments anywhere between here and the GPU upload.
        const o0 = this.queue.reserve(splats);
        const d = this.queue.data;
        for (let i = 0; i < splats; i++) {
          const o = o0 + i * 8;
          const a = i * 2.39996;
          const r = 2 + (i % 40);
          d[o] = i % 5;
          d[o + 1] = c.x + Math.cos(a) * r;
          d[o + 2] = c.z + Math.sin(a) * r;
          d[o + 3] = 0.2 + (i % 7) * 0.3;
          d[o + 4] = 0.05;
          d[o + 5] = Math.cos(a);
          d[o + 6] = Math.sin(a);
          d[o + 7] = 1;
        }
        this.cpuStep(ctx, 1 / 60);
        continue;
      }
      if (stage < 0) {
        // Integer (Smi) arguments: isolates allocations inside splat() from double boxing at the call.
        for (let i = 0; i < splats; i++) this.service.splat((i % 5) as SplatKind, 10 + (i % 40), 10 - (i % 30), 1, 1, 1, 0);
        this.queue.count = 0;
        continue;
      }
      for (let i = 0; i < splats; i++) {
        const a = i * 2.39996;
        const r = 2 + (i % 40);
        this.service.splat((i % 5) as SplatKind, c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, 0.2 + (i % 7) * 0.3, 0.05, Math.cos(a), Math.sin(a));
      }
      if (stage >= 9) this.cpuStep(ctx, 1 / 60);
      else {
        this.clock.dt = 1 / 60;
        if (stage >= 1) this.far.advance(c, GLOBAL_DRIFT, this.clock);
        if (stage >= 2) this.queue.flush();
        else this.queue.count = 0;
        if (stage >= 3) this.active.build(this.clock);
        if (stage >= 4) this.syncTunables();
      }
    }
    this.queue.count = 0;
  }


  dispose(ctx: GLContext) {
    this.offParams();
    this.view.dispose(ctx);
    this.noise.dispose();
    this.st.dispose();
    for (let p = 0; p < 2; p++) for (let i = 0; i < this.lists[p].length; i++) this.lists[p][i].dispose();
    this.far.dispose();
    this.near.dispose();
    this.sand.dispose();
    this.nearB[0].dispose();
    this.nearB[1].dispose();
    // Compute-only storage buffers aren't owned by any geometry; free them explicitly.
    const attrs = (ctx.renderer as unknown as { _attributes?: { delete(a: unknown): void } })._attributes;
    if (attrs) {
      attrs.delete(this.queue.splatAttr);
      attrs.delete(this.queue.headerAttr);
      attrs.delete(this.queue.refAttr);
      attrs.delete(this.active.attr);
    }
  }
}


function half(h: number) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

