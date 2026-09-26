// GOLDENLINE ocean: depth-aware groundswell (swell.ts) + 4-cascade GPU FFT wind sea (fft.ts)
// on a camera-centred clipmap (surface.ts). OceanService in service.ts. See ocean/README.md.

import { HalfFloatType, Mesh, RenderTarget, Scene } from 'three/webgpu';
import type { GLContext, GLSystem } from '../core/contracts';
import { WIND, SWELL } from '../world/layout';
import { createFFT, type OceanFFT } from './fft';
import { createPlaceholderWater, type PlaceholderWater } from './material';
import { CpuSea } from './cpu-sea';
import { createProbe, PROBE_STRIDE, type OceanProbe } from './probe';
import { createOceanService, forwardDisplace, setCpuTime, type OceanCpu } from './service';
import { CASCADES, FFT_N, Spectrum, type SpectrumParams } from './spectrum';
import { buildClipmapGeometry, createOceanSurface, CLIP, type OceanSurface } from './surface';
import {
  ENV_W,
  FIELD,
  N_TRAINS,
  SwellField,
  TRAIN_DEFS,
  bakeEnvelope,
  newSwellRuntime,
  newTrainPoint,
  trainAt,
  setSwellTime,
} from './swell';
import { createSwellGPU, type SwellGPU } from './swell-gpu';

interface OceanState {
  field: SwellField;
  env: Float32Array;
  spec: Spectrum;
  fft: OceanFFT;
  swell: SwellGPU;
  surface: OceanSurface;
  water: PlaceholderWater;
  mesh: Mesh;
  cpu: OceanCpu;
  probe: OceanProbe;
  unlisten: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createOceanSystem(): GLSystem {
  let st: OceanState | null = null;
  let P: ReturnType<typeof registerParams> | null = null;

  return {
    name: 'ocean',
    init(ctx: GLContext) {
      const p = registerParams(ctx);
      P = p;
      const heightAt = ctx.services.terrain.height;
      const field = new SwellField();
      field.bake(heightAt, p.periodScale.value, p.dirOffset.value);
      const env = new Float32Array(ENV_W * N_TRAINS);
      bakeEnvelope(env, field, p.setInterval.value, p.lull.value);
      const spec = new Spectrum();
      spec.generate(spectrumParams(p));
      const fft = createFFT(spec);
      const swell = createSwellGPU(field, env);
      const surface = createOceanSurface(fft, swell);
      const water = createPlaceholderWater(surface, ctx.services.atmosphere);
      const mesh = new Mesh(buildClipmapGeometry(), water.material);
      mesh.name = 'ocean.surface';
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      ctx.scene.add(mesh);

      const rt = newSwellRuntime();
      const cpu: OceanCpu = { field, env, rt, spec, sea: new CpuSea(spec), fft: true, ticks: 0 };
      const probe = createProbe(surface, swell);
      const gpu = {
        mesh,
        material: water.material,
        surface,
        fft: {
          disp: fft.disp,
          deriv: fft.deriv,
          cascades: CASCADES,
          size: FFT_N,
          uChop: fft.uChop,
          uGain: surface.uFftGain,
        },
        swell: {
          field: swell.field,
          envelope: swell.envelope,
          uniforms: { phase: swell.uPhase, time: swell.uTime, scale: swell.uScale, skew: swell.uSkew, amp: swell.uAmp },
          grid: FIELD,
          trains: TRAIN_DEFS,
          omega: field.omega,
        },
        // [water] the SwellGPU itself, for swellTrainGPU() in other systems' vertex hooks.
        swellGPU: swell,
        cpu,
        clipmap: CLIP,
        /** Debug: GPU (timestamp) and wall-clock ms of n dispatches of each FFT pass. */
        benchFFT: (n: number) => benchFFT(ctx, fft, n),
        /** Debug: GPU ms of rendering only the ocean mesh at w×h (timestamp queries). */
        benchRender: (n: number, w: number, h: number) => benchRender(ctx, mesh, n, w, h),
        /** Debug: compare CPU forward displacement with the GPU's at rest points around (x, z). */
        probeCompare: (x: number, z: number, radius: number) => probeCompare(ctx, probe, cpu, x, z, radius),
      };
      ctx.services.ocean = createOceanService(cpu, heightAt, gpu);

      // Heavy rebuilds (spectrum, envelope, field) run off a debounced param listener, never
      // inside update().
      const heavy = new Set(['ocean.seaWind', 'ocean.windSea', 'ocean.chop', 'ocean.capillary', 'ocean.localWind', 'ocean.setInterval', 'ocean.lull', 'ocean.period', 'ocean.swellDir']);
      const state: OceanState = { field, env, spec, fft, swell, surface, water, mesh, cpu, probe, unlisten: () => {}, timer: null };
      state.unlisten = ctx.params.onChange((param) => {
        if (!heavy.has(param.key)) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = null;
          if (st !== state) return;
          if (param.key === 'ocean.period' || param.key === 'ocean.swellDir') {
            field.bake(heightAt, p.periodScale.value, p.dirOffset.value);
          }
          bakeEnvelope(env, field, p.setInterval.value, p.lull.value);
          swell.refreshField();
          spec.generate(spectrumParams(p));
          cpu.sea.refresh();
          fft.upload(spec);
        }, 120);
      });
      st = state;
    },

    warmup(ctx: GLContext) {
      if (!st) return;
      for (let i = 0; i < 4; i++) {
        this.update?.(ctx);
        st.fft.dispatch(ctx.renderer);
      }
    },

    update(ctx: GLContext) {
      if (!st || !P) return;
      const { cpu, swell, fft, surface, water, mesh } = st;
      const on = P.enabled.value;
      mesh.visible = on;
      const rt = cpu.rt;
      rt.scale = P.swellHeight.value;
      rt.skew = P.skew.value;
      const ticks = setSwellTime(cpu.field, rt, ctx.time.t);
      swell.sync(rt);
      cpu.fft = P.fft.value;
      setCpuTime(cpu, ticks);
      const lam = P.choppiness.value;
      for (let c = 0; c < cpu.sea.chop.length; c++) cpu.sea.chop[c] = lam;
      fft.uChop.value.set(lam, lam, lam, lam);
      fft.uTicks.value = ticks;
      surface.uFftGain.value = cpu.fft ? 1 : 0;
      water.uSun.value = P.sunSpec.value;
      water.uView.value = P.view.value;
      water.uDbgGain.value = P.debugGain.value;
      if (on && cpu.fft) fft.dispatch(ctx.renderer);
    },

    dispose(ctx: GLContext) {
      if (!st) return;
      const s = st;
      st = null;
      if (s.timer) clearTimeout(s.timer);
      s.unlisten();
      ctx.scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.water.material.dispose();
      s.fft.dispose();
      s.swell.dispose();
      s.probe.dispose(ctx.renderer);
      const attrs = (ctx.renderer as unknown as { _attributes?: { delete(a: unknown): void } })._attributes;
      if (attrs) {
        attrs.delete(s.fft.h0Attr);
        attrs.delete(s.fft.qAttr);
        attrs.delete(s.fft.midNode.value);
        attrs.delete(s.fft.pyrNode.value);
      }
    },
  };
}

function registerParams(ctx: GLContext) {
  const P = ctx.params;
  const g = 'ocean';
  return {
    enabled: P.toggle('ocean.enabled', { label: 'ocean', group: g, value: true }),
    fft: P.toggle('ocean.fft', { label: 'FFT wind sea', group: g, value: true }),
    swellHeight: P.number('ocean.swellHeight', { label: 'swell height', group: g, min: 0, max: 2.5, value: 1 }),
    setInterval: P.number('ocean.setInterval', { label: 'set interval (s)', group: g, min: 40, max: 240, step: 1, value: SWELL.setIntervalS }),
    lull: P.number('ocean.lull', { label: 'lull height', group: g, min: 0, max: 3, value: 1 }),
    periodScale: P.number('ocean.period', { label: 'swell period ×', group: g, min: 0.6, max: 1.5, value: 1 }),
    dirOffset: P.number('ocean.swellDir', { label: 'swell dir offset (°)', group: g, min: -30, max: 30, step: 0.5, value: 0 }),
    skew: P.number('ocean.skew', { label: 'face steepening', group: g, min: 0, max: 0.9, value: 0.45 }),
    windSea: P.number('ocean.windSea', { label: 'wind sea', group: g, min: 0, max: 1, value: 0.06 }),
    seaWind: P.number('ocean.seaWind', { label: 'wind-sea wind (m/s)', group: g, min: 1, max: 14, value: 5 }),
    localWind: P.number('ocean.localWind', { label: 'breeze (m/s)', group: g, min: 0, max: 12, value: WIND.speed }),
    chop: P.number('ocean.chop', { label: 'chop', group: g, min: 0, max: 3, value: 0.6 }),
    capillary: P.number('ocean.capillary', { label: 'capillary ripples', group: g, min: 0, max: 6, value: 1 }),
    choppiness: P.number('ocean.choppiness', { label: 'choppiness', group: g, min: 0, max: 1.5, value: 0.85 }),
    sunSpec: P.number('ocean.sunSpec', { label: 'placeholder sun', group: g, min: 0, max: 20, value: 3 }),
    debugGain: P.number('ocean.debugGain', { label: 'debug view gain', group: g, min: 0.01, max: 2, value: 0.12 }),
    view: P.number('ocean.view', { label: 'debug view', group: g, min: 0, max: 6, step: 1, value: 0 }),
  };
}

function spectrumParams(p: ReturnType<typeof registerParams>): SpectrumParams {
  // The distant wind sea runs a little off the swell. The short chop also travels shoreward with
  // the swell (user direction: seaward ripples read as wrong); the offshore breeze (WIND) still
  // drives the spray feathering off the lips.
  const a = Math.atan2(SWELL.dirZ, SWELL.dirX) + 0.35;
  const b = Math.atan2(SWELL.dirZ, SWELL.dirX) - 0.2;
  return {
    seaWind: p.seaWind.value,
    seaFetchKm: 60,
    seaDirX: Math.cos(a),
    seaDirZ: Math.sin(a),
    localWind: p.localWind.value,
    localDirX: Math.cos(b),
    localDirZ: Math.sin(b),
    scale: p.windSea.value,
    chopScale: p.chop.value,
    capillaryScale: p.capillary.value,
  };
}

/** Debug only (allocates): CPU vs GPU displacement at a 16×16 grid of rest points. */
async function probeCompare(ctx: GLContext, probe: OceanProbe, cpu: OceanCpu, x: number, z: number, radius: number) {
  const n = 16;
  const rest = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      rest[(j * n + i) * 2] = x + ((i / (n - 1)) * 2 - 1) * radius;
      rest[(j * n + i) * 2 + 1] = z + ((j / (n - 1)) * 2 - 1) * radius;
    }
  const out = await probe.run(ctx.renderer, rest);
  const f = new Float64Array(3);
  const tp = newTrainPoint();
  let maxErr = 0;
  let sumSq = 0;
  let maxH = -1e9;
  let minH = 1e9;
  const rows: Array<Record<string, number>> = [];
  const smp = { height: 0, nx: 0, ny: 0, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 0 };
  let maxErr3 = 0;
  for (let k = 0; k < n * n; k++) {
    forwardDisplace(cpu, rest[k * 2], rest[k * 2 + 1], f);
    const o = k * 4 * PROBE_STRIDE;
    // What matters: the height sample() reports at the world XZ where the GPU put the vertex.
    ctx.services.ocean.sample(out[o], out[o + 2], smp);
    const e = Math.abs(smp.height - out[o + 1]);
    maxErr3 = Math.max(maxErr3, Math.hypot(out[o] - f[0], out[o + 1] - f[1], out[o + 2] - f[2]));
    maxErr = Math.max(maxErr, e);
    sumSq += e * e;
    maxH = Math.max(maxH, out[o + 1]);
    minH = Math.min(minH, out[o + 1]);
    if (k % 37 === 0) {
      trainAt(cpu.field, cpu.env, 0, rest[k * 2], rest[k * 2 + 1], cpu.rt, tp);
      rows.push({
        x: rest[k * 2], z: rest[k * 2 + 1], gpuY: out[o + 1], cpuY: f[1], gpuDepth: out[o + 3],
        gpuEnv: out[o + 4], gpuK: out[o + 5], gpuAmp: out[o + 6], gpuFade: out[o + 7],
        cpuEnv: tp.ampOffshore / (TRAIN_DEFS[0].amp * cpu.rt.scale), cpuAmp: tp.amp, cpuDepth: tp.depth,
        gpuFftY: out[o + 13],
      });
    }
  }
  return { maxErr, rmsErr: Math.sqrt(sumSq / (n * n)), maxErr3, minH, maxH, rows };
}

/** Debug only: time n back-to-back dispatches of each FFT pass (ms per dispatch, wall clock). */
async function benchFFT(ctx: GLContext, fft: OceanFFT, n: number) {
  const device = (ctx.renderer.backend as unknown as { device: GPUDevice }).device;
  const r: Record<string, number> = {};
  const run = async (name: string, fn: () => void) => {
    fn();
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    await device.queue.onSubmittedWorkDone();
    r[name] = (performance.now() - t0) / n;
  };
  // GPU time from timestamp queries (immune to other processes sharing the GPU).
  const ts = async (name: string, fn: () => void) => {
    await ctx.renderer.resolveTimestampsAsync('compute');
    for (let i = 0; i < n; i++) fn();
    await device.queue.onSubmittedWorkDone();
    r[name + '_gpu'] = ((await ctx.renderer.resolveTimestampsAsync('compute')) ?? 0) / n;
  };
  await ts('rows', () => ctx.renderer.compute(fft.passes[0]));
  await ts('cols', () => ctx.renderer.compute(fft.passes[1]));
  await ts('both', () => ctx.renderer.compute([fft.passes[0], fft.passes[1]]));
  await ts('all+mips', () => ctx.renderer.compute(fft.passes));
  await run('rows', () => ctx.renderer.compute(fft.passes[0]));
  await run('cols', () => ctx.renderer.compute(fft.passes[1]));
  await run('both', () => ctx.renderer.compute(fft.passes));
  await run('dispatch+mips', () => fft.dispatch(ctx.renderer));
  return r;
}

/** Debug only: render just the ocean into an offscreen target n times; GPU ms per render. */
async function benchRender(ctx: GLContext, mesh: Mesh, n: number, w: number, h: number) {
  const r = ctx.renderer;
  const rt = new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: true });
  const solo = new Scene();
  const parent = mesh.parent;
  solo.add(mesh);
  const prev = r.getRenderTarget();
  r.setRenderTarget(rt);
  r.render(solo, ctx.camera);
  await r.resolveTimestampsAsync('render');
  for (let i = 0; i < n; i++) r.render(solo, ctx.camera);
  const device = (r.backend as unknown as { device: GPUDevice }).device;
  await device.queue.onSubmittedWorkDone();
  const ms = ((await r.resolveTimestampsAsync('render')) ?? 0) / n;
  r.setRenderTarget(prev);
  parent?.add(mesh);
  rt.dispose();
  return { ms, w, h };
}
