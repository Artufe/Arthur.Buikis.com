// The surf zone: one shallow-water simulation for the lagoon, the beach face and the run-up
// (README.md). Waves arrive from the swell at the seaward edge, steepen into bores, run up the
// beach with their own momentum and drain back; the ocean mesh draws it (a surface hook), the
// water material shows its foam, the state wets the sand where it has water, and the CPU reads a
// window around the camera back for ocean.sample().

import { ReadbackBuffer } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { GLContext, OceanSample, TSLNode } from '../../core/contracts';
import type { SurfaceHook } from '../surface';
import type { SwellGPU } from '../swell-gpu';
import { APPROACH_X0, DEFAULT_GAIN, DX, DZ, H_DRY, MANNING, MAX_SUBSTEPS, NX, NZ, RELAX_X, SPONGE_Z, SUBSTEP, WIN, WIN_STEP, X0, X1, Z0, Z1, renderWeight, swellGain } from './grid';
import { createKernels } from './kernels';
import { INFILTRATION } from './scheme';
import { SPRAY_DROPLET, type SprayService } from '../../vfx/spray';

const { Fn, If, clamp, float, floor, ivec2, max, mix, smoothstep, texture, textureLoad, vec2, vec3, vec4 } = TSL as unknown as Record<string, any>;

export interface SurfZoneDeps {
  swell: SwellGPU;
  omega: ArrayLike<number>;
  /** TSL: the rendered base terrain height at world XZ (the beach's own B-spline). */
  bedAt(xz: TSLNode): TSLNode;
  /** Point the swell's GPU uniforms at simulation time t (for spin-up). */
  setSwellTime(t: number): void;
}

export interface SurfZone {
  /** Ocean surface hook: inside the domain the surface is the simulation, not the swell. */
  hook: SurfaceHook;
  /** TSL: vec2(foam coverage, age) at world XZ, 0 outside the domain. */
  foamAt(xz: TSLNode): TSLNode;
  /** TSL: 0-1, where the simulation has water on the sand (the state's wetting). */
  wet(xz: TSLNode, edge?: number): TSLNode;
  /** Reset to still water and simulate `seconds` ending at time t. */
  spinUp(ctx: GLContext, t: number, seconds: number): void;
  update(ctx: GLContext): void;
  /** CPU: blend the simulation into a sample at (x, z) if it is inside the readback window. */
  sampleInto(x: number, z: number, out: OceanSample): void;
  /** Debug: frames stepped, last substep count, readbacks completed. */
  stats: { frames: number; substeps: number; reads: number; spinUps: number };
  dispose(): void;
}

const W_BLEND_LO = X0 + RELAX_X * 0.35;
const W_BLEND_HI = X0 + RELAX_X * 0.85;

export function createSurfZone(ctx: GLContext, deps: SurfZoneDeps): SurfZone {
  const k = createKernels(deps.swell, deps.bedAt, deps.omega);
  const r0 = texture(k.R0, vec2(0, 0));
  const r1 = texture(k.R1, vec2(0, 0));
  /** The state (h, u, v, b): rgba32f and nearest-filtered, so binding it takes no sampler. */
  const s0 = textureLoad(k.S[0], ivec2(0, 0));
  const uvOf = (xz: TSLNode) => xz.sub(vec2(X0, Z0)).div(vec2(X1 - X0, Z1 - Z0));
  /** grid.ts renderWeight() in TSL (edges written rising, as Metal requires). */
  const renderW = (p: TSLNode) =>
    smoothstep(W_BLEND_LO, W_BLEND_HI, p.x)
      .mul(smoothstep(Z0 + SPONGE_Z * 0.35, Z0 + SPONGE_Z * 0.85, p.y))
      .mul(float(1).sub(smoothstep(Z1 - SPONGE_Z * 0.85, Z1 - SPONGE_Z * 0.35, p.y)))
      .mul(float(1).sub(smoothstep(X1 - 1, X1, p.x)));

  const gainU = (k.uMisc as unknown as { x: TSLNode }).x;
  /**
   * R0/R1 at a vertex, band-limited to the vertex spacing: a bore front is one or two cells wide,
   * and point-sampling it from the 1-2 m vertices 40 m out drew the face as a staircase of
   * triangles. Coarse vertices average four taps over their footprint.
   */
  // (Called inside the surface's positionNode Fn, so its If blocks and vars live there.)
  const sampleBL = (xz: TSLNode, spacing: TSLNode) => {
    const a = vec4(0, 0, 0, 0).toVar();
    const b = vec4(0, 0, 0, 0).toVar();
    If(spacing.lessThan(DX * 1.5), () => {
      const uv = uvOf(xz);
      a.assign(r0.sample(uv).level(0));
      b.assign(r1.sample(uv).level(0));
    }).Else(() => {
      const o = spacing.mul(0.35);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const uv = uvOf(xz.add(vec2(o.mul(sx), o.mul(sz))));
        a.addAssign(r0.sample(uv).level(0).mul(0.25));
        b.addAssign(r1.sample(uv).level(0).mul(0.25));
      }
    });
    return { a, b };
  };

  const hook: SurfaceHook = ({ rest, swell, spacing }) => {
    const d = vec3(0, 0, 0).toVar();
    const dPrev = vec3(0, 0, 0).toVar();
    const dd = vec4(0, 0, 0, 0).toVar();
    const dxz = float(0).toVar();
    // The approach band: the swell loses height toward the lagoon (grid.ts swellGain).
    const att = mix(float(1), gainU, smoothstep(APPROACH_X0, X0, rest.x)).sub(1).toVar();
    If(att.lessThan(0).and(rest.y.greaterThan(Z0 - 40)).and(rest.y.lessThan(Z1 + 40)), () => {
      d.assign(swell.d.mul(att));
      dPrev.assign(swell.dPrev.mul(att));
      dd.assign(swell.dd.mul(att));
      dxz.assign(swell.dxz.mul(att));
    });
    const W = renderW(rest).toVar();
    If(W.greaterThan(0), () => {
      const { a, b } = sampleBL(rest, spacing);
      // Deep water: the simulated free surface. Thin water: draped on the sand as drawn (the bed
      // here is the same B-spline, but draping keeps a 1 cm film exactly on it). Dry: tucked
      // under the sand, so the edge of the water is where the depth runs out.
      const bed = deps.bedAt(rest);
      const thin = float(1).sub(smoothstep(0.12, 0.5, a.y));
      const tuck = float(1).sub(smoothstep(H_DRY, 0.012, a.y)).mul(0.12);
      const y = mix(a.x, bed.add(a.y), thin).sub(tuck);
      const target = vec3(0, y, 0);
      // The scaled swell (above) blends into the simulation by W.
      d.assign(mix(swell.d.mul(att), target.sub(swell.d), W));
      dPrev.assign(mix(swell.dPrev.mul(att), target.sub(swell.dPrev), W));
      dd.assign(mix(swell.dd.mul(att), vec4(b.x, b.y, 0, 0).sub(swell.dd), W));
      dxz.assign(mix(swell.dxz.mul(att), swell.dxz.negate(), W));
    });
    return { d, dPrev, dd, dxz };
  };

  const foamAt = (xz: TSLNode) =>
    Fn(() => {
      const out = vec2(0, 0).toVar();
      const W = renderW(xz).toVar();
      If(W.greaterThan(0), () => {
        const a = r0.sample(uvOf(xz)).level(0);
        out.assign(vec2(a.z.mul(W), a.w));
      });
      return out;
    })();

  // Depth bilinear by hand from four loads of the state (R0 holds the same depth, but three binds
  // a sampler with any filterable texture): the state's sand() reader evaluates this per pixel in
  // the sand material, whose fragment stage is at its 16 samplers.
  const wet = (xz: TSLNode) =>
    Fn(() => {
      const out = float(0).toVar();
      If(xz.x.greaterThan(X0).and(xz.x.lessThan(X1)).and(xz.y.greaterThan(Z0)).and(xz.y.lessThan(Z1)), () => {
        const q = vec2(xz.x.sub(X0).div(DX).sub(0.5), xz.y.sub(Z0).div(DZ).sub(0.5));
        const i0 = clamp(floor(q), vec2(0, 0), vec2(NX - 2, NZ - 2)).toVar();
        const f = clamp(q.sub(i0), 0, 1).toVar();
        const i = ivec2(i0).toVar();
        const L = (di: number, dj: number) => s0.load(i.add(ivec2(di, dj))).x;
        const h = mix(mix(L(0, 0), L(1, 0), f.x), mix(L(0, 1), L(1, 1), f.x), f.y);
        out.assign(smoothstep(H_DRY, 0.01, h));
      });
      return out;
    })();

  // ── stepping ──
  const renderer = ctx.renderer;
  const sd = k.uStep.value as { x: number; y: number; z: number; w: number };
  let parity = 0;
  const P = ctx.params;
  const pGain = P.number('surfzone.gain', { label: 'lagoon wave height ×', group: 'surfzone', min: 0.2, max: 1, value: DEFAULT_GAIN });
  const pFric = P.number('surfzone.friction', { label: 'bed friction (Manning n)', group: 'surfzone', min: 0, max: 0.08, value: MANNING, step: 0.001 });
  const pSoak = P.number('surfzone.soak', { label: 'infiltration (mm/s)', group: 'surfzone', min: 0, max: 20, value: INFILTRATION * 1000, step: 0.1 });
  const pBreak = P.number('surfzone.breaking', { label: 'breaking dissipation ×', group: 'surfzone', min: 0, max: 3, value: 1, step: 0.05 });
  const um = k.uMisc.value as { x: number; y: number; z: number; w: number };
  let tLast = NaN;
  const stats = { frames: 0, substeps: 0, reads: 0, spinUps: 0 };
  // One list per substep count, prebuilt: [momentum, continuity] × n, foam, pack.
  const lists: TSLNode[][][] = [[], []];
  for (let p = 0; p < 2; p++)
    for (let n = 0; n <= MAX_SUBSTEPS; n++) {
      const l: TSLNode[] = [];
      for (let s = 0; s < n; s++) l.push(k.step[0], k.step[1]);
      l.push(k.post[p][0], k.post[p][1]);
      lists[p].push(l);
    }

  const advance = (dt: number) => {
    if (um.x !== pGain.value) um.x = pGain.value;
    if (um.y !== pFric.value) um.y = pFric.value;
    if (um.z !== pSoak.value * 0.001) um.z = pSoak.value * 0.001;
    if (um.w !== pBreak.value) um.w = pBreak.value;
    let n = Math.ceil(dt / SUBSTEP - 1e-6);
    if (n < 1) n = 1;
    if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
    sd.x = Math.min(dt / n, SUBSTEP * 1.25);
    sd.y = dt;
    renderer.compute(lists[parity][n]);
    parity ^= 1;
    stats.substeps = n;
  };

  // ── readback (two persistent staging buffers, one in flight each) ──
  const winAttr = (k.win as unknown as { value: { array: Float32Array } }).value;
  const bytes = WIN * WIN * 2 * 16;
  const rb = [new ReadbackBuffer(bytes), new ReadbackBuffer(bytes)];
  const busy = [false, false];
  const pendX = new Float64Array(2);
  const pendZ = new Float64Array(2);
  const cpu = new Float32Array(WIN * WIN * 8);
  const cpuO = new Float64Array([NaN, NaN]);
  let slot = 0;
  const done = [0, 1].map((s) => (t: ReadbackBuffer) => {
    const buf = (t as unknown as { buffer: ArrayBuffer | null }).buffer;
    if (buf) {
      cpu.set(new Float32Array(buf));
      cpuO[0] = pendX[s];
      cpuO[1] = pendZ[s];
      stats.reads++;
    }
    t.release();
    busy[s] = false;
  });
  const fail = [0, 1].map((s) => () => {
    busy[s] = false;
  });

  const read = (cx: number, cz: number) => {
    if (busy[slot]) return;
    // Window origin snapped to its step, so samples don't swim as the camera moves.
    const ox = Math.round((cx - (WIN / 2) * WIN_STEP) / WIN_STEP) * WIN_STEP;
    const oz = Math.round((cz - (WIN / 2) * WIN_STEP) / WIN_STEP) * WIN_STEP;
    sd.z = ox;
    sd.w = oz;
    renderer.compute(k.readWin);
    busy[slot] = true;
    pendX[slot] = ox;
    pendZ[slot] = oz;
    const s = slot;
    renderer.getArrayBufferAsync(winAttr as never, rb[s] as never).then(done[s] as never, fail[s]);
    slot ^= 1;
  };

  // ── spray off the breaking fronts near the camera (from the readback window) ──
  const sprayAcc = new Float32Array(WIN * WIN);
  const rng = new Uint32Array([0x9e3779b9]);
  const rand = () => {
    rng[0] = Math.imul(rng[0] ^ (rng[0] >>> 15), 0x2c1b3c6d) + 0x6d2b79f5;
    return (rng[0] >>> 8) / 16777216;
  };
  /**
   * A breaking front: the surface falls steeply ahead in the direction fast water moves. Each such
   * cell accumulates droplets, thrown forward and up off the crest. (No mist: at these sizes it
   * read as a row of round puffs; vfx/mist keeps the haze over the shore break.)
   */
  const spray = (dt: number) => {
    const sp = (ctx.services.ocean.gpu as { spray?: SprayService }).spray;
    if (!sp || !(cpuO[0] === cpuO[0])) return;
    const sdt = sp.emitData;
    for (let j = 1; j < WIN - 1; j++)
      for (let i = 1; i < WIN - 1; i++) {
        const o = (j * WIN + i) * 4;
        const h = cpu[o + 1];
        if (h < 0.12) continue;
        const u = cpu[o + 2];
        const v = cpu[o + 3];
        const spd = Math.sqrt(u * u + v * v);
        if (spd < 1.2) continue;
        if (cpu[o + 5] < 0.01 || cpu[o - 3] < 0.01 || cpu[o + WIN * 4 + 1] < 0.01 || cpu[o - WIN * 4 + 1] < 0.01) continue;
        const gx = (cpu[o + 4] - cpu[o - 4]) / (2 * WIN_STEP);
        const gz = (cpu[o + WIN * 4] - cpu[o - WIN * 4]) / (2 * WIN_STEP);
        const front = -(gx * u + gz * v) / spd;
        if (front < 0.25) continue;
        const f = Math.min(1, (front - 0.25) / 0.35) * Math.min(1, (spd - 1.2) / 1.6);
        const a = j * WIN + i;
        sprayAcc[a] += f * dt * 14;
        const x = cpuO[0] + i * WIN_STEP + (rand() - 0.5) * WIN_STEP;
        const z = cpuO[1] + j * WIN_STEP + (rand() - 0.5) * WIN_STEP;
        const y = cpu[o] + 0.08;
        if (sprayAcc[a] >= 1) {
          const q = sp.reserve(SPRAY_DROPLET, sprayAcc[a] | 0);
          sprayAcc[a] -= sprayAcc[a] | 0;
          if (q >= 0) {
            sdt[q] = x;
            sdt[q + 1] = y;
            sdt[q + 2] = z;
            sdt[q + 4] = u * 0.85;
            sdt[q + 5] = 1 + 2.2 * f;
            sdt[q + 6] = v * 0.85;
            sdt[q + 8] = 0.5;
            sdt[q + 9] = 0.3;
            sdt[q + 13] = cpu[o] - 0.3;
          }
        }
      }
  };

  const zone = {
    hook,
    foamAt,
    wet,
    stats,
    spinUp(c: GLContext, t: number, seconds: number) {
      renderer.compute(k.bake);
      parity = 0;
      const step = 1 / 30;
      const n = Math.max(1, Math.round(seconds / step));
      for (let i = n; i >= 1; i--) {
        deps.setSwellTime(t - i * step);
        advance(step);
      }
      deps.setSwellTime(t);
      tLast = t;
      stats.spinUps++;
      void c;
    },
    update(c: GLContext) {
      const t = c.time.t;
      const dt = c.time.dt;
      // A jump in time (shots, the overlay's clock): the sim has no history for it; rebuild it.
      if (!(Math.abs(t - (tLast + dt)) < 0.5)) {
        zone.spinUp(c, t, 24);
        return;
      }
      tLast = t;
      if (dt <= 0) return;
      advance(dt);
      stats.frames++;
      const cam = c.camera.position;
      if (cam.x > X0 - 30 && cam.x < X1 + 30 && cam.z > Z0 - 30 && cam.z < Z1 + 30) {
        read(cam.x, cam.z);
        spray(dt);
      }
    },
    sampleInto(x: number, z: number, out: OceanSample) {
      if (x < X0 + RELAX_X && z > Z0 - 40 && z < Z1 + 40) {
        // The approach band's scaled swell (as drawn).
        const a = swellGain(x, pGain.value);
        out.height *= a;
        out.vx *= a;
        out.vy *= a;
        out.vz *= a;
      }
      const w = renderWeight(x, z);
      if (w <= 0) return;
      const fx = (x - cpuO[0]) / WIN_STEP;
      const fz = (z - cpuO[1]) / WIN_STEP;
      if (!(fx >= 0 && fz >= 0 && fx < WIN - 1 && fz < WIN - 1)) return;
      const i = fx | 0;
      const j = fz | 0;
      const ax = fx - i;
      const az = fz - j;
      const o00 = (j * WIN + i) * 4;
      const o10 = o00 + 4;
      const o01 = o00 + WIN * 4;
      const o11 = o01 + 4;
      const lerp = (c: number) => (cpu[o00 + c] * (1 - ax) + cpu[o10 + c] * ax) * (1 - az) + (cpu[o01 + c] * (1 - ax) + cpu[o11 + c] * ax) * az;
      const eta = lerp(0);
      const h = lerp(1);
      const u = lerp(2);
      const v = lerp(3);
      const F = WIN * WIN * 4;
      const cov = (cpu[F + o00] * (1 - ax) + cpu[F + o10] * ax) * (1 - az) + (cpu[F + o01] * (1 - ax) + cpu[F + o11] * ax) * az;
      // Slope from the neighbouring samples (the sample grid is WIN_STEP apart).
      const gx = (cpu[o10] - cpu[o00] + cpu[o11] - cpu[o01]) / (2 * WIN_STEP);
      const gz = (cpu[o01] - cpu[o00] + cpu[o11] - cpu[o10]) / (2 * WIN_STEP);
      const nl = Math.sqrt(gx * gx + gz * gz + 1);
      out.height += (eta - out.height) * w;
      out.nx += (-gx / nl - out.nx) * w;
      out.ny += (1 / nl - out.ny) * w;
      out.nz += (-gz / nl - out.nz) * w;
      out.vx += (u - out.vx) * w;
      out.vz += (v - out.vz) * w;
      out.vy *= 1 - w;
      out.depth += (h - out.depth) * w;
      const br = cov * w;
      if (br > out.breaking) out.breaking = br;
    },
    /** Dev only: GPU ms of one frame's work (`n` substeps + foam + pack), timed over `reps` frames. */
    async __bench(reps = 60, n = 2) {
      const r = renderer as unknown as { resolveTimestampsAsync(t: string): Promise<number | undefined> };
      await r.resolveTimestampsAsync('compute');
      for (let i = 0; i < reps; i++) {
        renderer.compute(lists[parity][n]);
        parity ^= 1;
      }
      return ((await r.resolveTimestampsAsync('compute')) ?? NaN) / reps;
    },
    /** Dev only: read back n cells of S0 (h, u, v, b) starting at world (x, z), along +x. */
    async __probe(x: number, z: number, n = 1) {
      const i = Math.floor((x - X0) / DX);
      const j = Math.floor((z - Z0) / DZ);
      const tu = (renderer.backend as unknown as { textureUtils: { copyTextureToBuffer(t: unknown, x: number, y: number, w: number, h: number, f: number): Promise<Float32Array> } }).textureUtils;
      const raw = await tu.copyTextureToBuffer(k.S[0], i, j, n, 1, 0);
      return Array.from(raw.slice(0, n * 4));
    },
    dispose() {
      k.dispose();
      rb[0].dispose();
      rb[1].dispose();
    },
  };
  return zone;
}
