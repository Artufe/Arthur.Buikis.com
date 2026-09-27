// GOLDENLINE engine bootstrap and render loop. Orchestrator-owned.
//
// Boot: WebGPU check → renderer → services (stubs) → systems.init → systems.warmup →
// warmPipelines (batched real frames) → a few warm frames → ready. The React wrapper keeps the loading
// screen up until `ready` resolves, then fades in.

import { AgXToneMapping, PerspectiveCamera, Scene, SRGBColorSpace, WebGPURenderer, type Material, type Object3D } from 'three/webgpu';
import { createSystems } from '../systems';
import { createOverlay, type Overlay } from '../ui/overlay';
import { createTerrainService } from '../world/terrain-shape';
import type { GLContext, GLSystem, Quality, Variant } from './contracts';
import { bake, prefetchBakes, timeline as bakeTimeline, yieldTask } from './bakes';
import { installDebugHook } from './debug';
import { Input } from './input';
import { ParamRegistry } from './params';
import { Perf } from './perf';
import { stubAtmosphere, stubOcean, stubPier, stubPlayer, stubPost, stubState } from './stubs';

export class NoWebGPUError extends Error {}

type Drawable = Object3D & { material?: Material | Material[]; isMesh?: boolean; isSprite?: boolean; isPoints?: boolean; isLine?: boolean };
/** Yield to the browser once a warm-up task has run this long (the first build of one material can't split). */
const TASK_BUDGET_MS = 60;

/**
 * [polish] Build every render pipeline the scene will ever use, through the real post chain
 * (its MRT scene pass and every shadow cascade), a few materials at a time so the loading
 * screen keeps painting. Every object is made visible and unculled, so nothing first compiles
 * when it comes into view; each material renders one full frame with only its own drawables on,
 * yielding whenever a task has run past TASK_BUDGET_MS.
 * compileAsync() is not used: it only targets the canvas context, which the post chain never
 * draws the scene into, so its builds were thrown away (≈1 s).
 */
/**
 * [polish] three runs per-frame node work (the post chain's scene pass, shadow maps) once per
 * nodeFrame.frameId, which only its own rAF loop advances: several renders inside one task
 * would draw the scene once. Advance it for every render the engine issues outside that loop.
 */
function nextNodeFrame(ctx: GLContext) {
  (ctx.renderer as unknown as { _nodes: { nodeFrame: { update(): void } } })._nodes.nodeFrame.update();
}

/**
 * [polish] three recomputes the lighting/environment cache key (lightsNode.getCacheKey(true): a
 * forced walk of the whole lights node graph) once per render *call*, i.e. for every shadow
 * cascade, the scene pass and each post pass: ≈ 25 KB of garbage per frame. The key is
 * structural (which lights, shadows, environment and fog exist), so once per frame is enough.
 */
function cacheLightsKeyPerFrame(renderer: WebGPURenderer) {
  type NM = { getCacheKey(scene: unknown, lightsNode: unknown): number; nodeFrame: { frameId: number } };
  const nodes = (renderer as unknown as { _nodes?: NM })._nodes;
  if (!nodes || typeof nodes.getCacheKey !== 'function') return;
  const orig = nodes.getCacheKey.bind(nodes);
  const cache = new WeakMap<object, { frame: number; scene: unknown; key: number }>();
  nodes.getCacheKey = (scene: unknown, lightsNode: unknown) => {
    if (!lightsNode || typeof lightsNode !== 'object') return orig(scene, lightsNode);
    const f = nodes.nodeFrame.frameId;
    const e = cache.get(lightsNode);
    if (e && e.frame === f && e.scene === scene) return e.key;
    const key = orig(scene, lightsNode);
    if (e) {
      e.frame = f;
      e.scene = scene;
      e.key = key;
    } else cache.set(lightsNode, { frame: f, scene, key });
    return key;
  };
}

const warmLog: string[] = [];
if (typeof window !== 'undefined') (window as unknown as { __warmLog?: string[] }).__warmLog = warmLog;
async function warmPipelines(ctx: GLContext, onProgress: (f: number) => void) {
  const { scene } = ctx;
  const saved: Array<{ o: Object3D; visible: boolean; culled: boolean }> = [];
  const byMaterial = new Map<Material, Drawable[]>();
  const drawables: Drawable[] = [];
  scene.traverse((o) => {
    saved.push({ o, visible: o.visible, culled: o.frustumCulled });
    o.visible = true;
    o.frustumCulled = false;
    const d = o as Drawable;
    if (!(d.isMesh || d.isSprite || d.isPoints || d.isLine) || !d.material) return;
    drawables.push(d);
    const m = Array.isArray(d.material) ? d.material[0] : d.material;
    let list = byMaterial.get(m);
    if (!list) byMaterial.set(m, (list = []));
    list.push(d);
  });
  const groups = [...byMaterial.values()];
  try {
    for (const d of drawables) d.visible = false;
    let t0 = performance.now();
    for (let g = 0; g < groups.length; g++) {
      for (const d of groups[g]) d.visible = true;
      nextNodeFrame(ctx);
      const tg = performance.now();
      ctx.services.post.render(ctx);
      warmLog.push(`${groups[g][0].name || (groups[g][0].material as Material).name || groups[g][0].type}:${Math.round(performance.now() - tg)}`);
      for (const d of groups[g]) d.visible = false;
      if (performance.now() - t0 > TASK_BUDGET_MS) {
        onProgress((g + 1) / groups.length);
        await yieldTask();
        t0 = performance.now();
      }
    }
    // Everything together once: catches pipelines that depend on what else is in the pass.
    for (const d of drawables) d.visible = true;
    nextNodeFrame(ctx);
    ctx.services.post.render(ctx);
  } finally {
    for (const s of saved) {
      s.o.visible = s.visible;
      s.o.frustumCulled = s.culled;
    }
  }
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Element the settings overlay mounts into (the canvas wrapper). */
  overlayHost: HTMLElement;
  variant: Variant;
  reducedMotion: boolean;
  /** location.search, for `?q=`, `?p.<key>=`, `?shot=1`. */
  search: string;
  onProgress?: (fraction: number, label: string) => void;
}

export interface Engine {
  ctx: GLContext;
  start(): void;
  resize(width: number, height: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

const RENDER_SCALE: Record<Quality, number> = { low: 0.6, medium: 0.8, high: 1, ultra: 1 };
/**
 * [polish] Per-preset overrides of system params (on top of render scale, shadow-map size and
 * SSR steps, which their owners switch in setQuality). Only uniform/visibility params: switching
 * a preset never compiles a pipeline. `high` is the params' own defaults.
 */
const QUALITY_PARAMS: Record<Quality, Record<string, number | boolean>> = {
  low: { 'beach.lodRange': 2.1, 'beach.plants': false, 'vfx.mist': false, 'water.caustics': 0.7 },
  medium: { 'beach.lodRange': 2.3, 'beach.plants': true, 'vfx.mist': true, 'water.caustics': 1 },
  high: { 'beach.lodRange': 2.5, 'beach.plants': true, 'vfx.mist': true, 'water.caustics': 1 },
  ultra: { 'beach.lodRange': 3, 'beach.plants': true, 'vfx.mist': true, 'water.caustics': 1 },
};
const applyQualityParams = (params: ParamRegistry, q: Quality, search: URLSearchParams) => {
  const o = QUALITY_PARAMS[q];
  // an explicit ?p.<key>= wins over the preset
  for (const k in o) if (!search.has(`p.${k}`) && params.get(k)) params.set(k, o[k]);
};
const WARM_FRAMES = 8;

export async function createEngine(opts: EngineOptions): Promise<Engine> {
  const { canvas } = opts;
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) throw new NoWebGPUError();
  // Boot timeline: where the loading screen's seconds go. Exposed as perf.boot and printed in dev.
  const bootStart = performance.now();
  // [polish] Heavy CPU bakes start on worker threads now, in parallel with everything below.
  prefetchBakes();
  let bootMark = bootStart;
  const boot: Array<{ stage: string; ms: number }> = [];
  const mark = (stage: string) => {
    const now = performance.now();
    const pl = (globalThis as unknown as { __pl?: { total: number } }).__pl; // dev probe (pipeline count)
    boot.push({ stage: pl ? `${stage}#${pl.total}` : stage, ms: Math.round(now - bootMark) });
    bootMark = now;
  };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new NoWebGPUError();
  const query = new URLSearchParams(opts.search);
  const shotMode = query.has('shot');

  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    // GPU timestamps for the overlay's per-pass timings (post owner reads them).
    trackTimestamp: adapter.features.has('timestamp-query'),
    // [polish] The sand shader samples 17 textures (4 shadow cascades, state, bakes); the default
    // per-stage limit is 16. Ask for what the adapter offers (Metal 48, D3D12 tier 2+ well above
    // 16); systems check ctx.renderer's device limits before relying on more than 16.
    requiredLimits: { maxSampledTexturesPerShaderStage: Math.min(adapter.limits.maxSampledTexturesPerShaderStage, 32) },
  });
  await renderer.init();
  mark('webgpu device');
  // WebGPURenderer silently falls back to WebGL2. The brief forbids fallbacks.
  if (!(renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
    renderer.dispose();
    throw new NoWebGPUError();
  }
  // [polish] ?nodeprof: time every TSL node build (material, object, pass) for startup work.
  if (query.has('nodeprof')) {
    const rows: Array<{ mat: string; obj: string; ms: number; ctx: string }> = [];
    (window as unknown as { __nodeprof?: unknown }).__nodeprof = rows;
    type NB = { build(): unknown; buildAsync(): Promise<unknown>; material?: { name?: string; type?: string; isShadowPassMaterial?: boolean } };
    type RO = { object: { name?: string; type?: string }; material: { name?: string; type?: string; isShadowPassMaterial?: boolean }; context?: { textures?: unknown[] | null } };
    (renderer.debug as unknown as { onNodeBuilderCreated: (nb: NB, ro: RO) => void }).onNodeBuilderCreated = (nb, ro) => {
      const b = nb.build.bind(nb);
      const ba = nb.buildAsync.bind(nb);
      const rec = (t0: number) =>
        rows.push({
          mat: ro?.material ? `${ro.material.name || ''}:${ro.material.type}` : 'compute',
          obj: ro?.object ? `${ro.object.name || ''}:${ro.object.type}` : '',
          ms: performance.now() - t0,
          ctx: ro?.material?.isShadowPassMaterial ? 'shadow' : `rt${ro?.context?.textures?.length ?? 0}`,
        });
      nb.build = () => {
        const t0 = performance.now();
        const r = b();
        rec(t0);
        return r;
      };
      nb.buildAsync = async () => {
        const t0 = performance.now();
        const r = await ba();
        rec(t0);
        return r;
      };
    };
  }
  cacheLightsKeyPerFrame(renderer);
  renderer.toneMapping = AgXToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.info.autoReset = false;

  const scene = new Scene();
  const camera = new PerspectiveCamera(72, 16 / 9, 0.06, 12000);
  camera.rotation.order = 'YXZ';
  camera.layers.enable(3); // [polish] NEAR_CASTER_LAYER (atmosphere/shadows.ts): the first-person body

  const qParam = query.get('q');
  const quality: Quality =
    qParam === 'low' || qParam === 'medium' || qParam === 'high' || qParam === 'ultra'
      ? qParam
      : opts.variant === 'window'
        ? 'medium'
        : 'high';

  const terrain = createTerrainService(await bake('terrain.grid'));
  mark('terrain bake');
  await yieldTask();
  const params = new ParamRegistry(opts.search);
  const perf = new Perf();
  perf.boot = boot;
  const input = new Input(canvas);

  const ctx: GLContext = {
    renderer,
    scene,
    camera,
    canvas,
    params,
    perf,
    input,
    time: { t: Number(query.get('t') ?? 0) || 0, dt: 0, frame: 0, frozen: shotMode },
    debug: { cameraLocked: false },
    quality,
    variant: opts.variant,
    reducedMotion: opts.reducedMotion,
    services: {
      terrain,
      atmosphere: stubAtmosphere(),
      ocean: stubOcean(),
      state: stubState(),
      player: null as unknown as GLContext['services']['player'],
      pier: stubPier(),
      post: stubPost(),
    },
  };
  ctx.services.player = stubPlayer(ctx);

  const exposure = params.number('core.exposure', { label: 'exposure', group: 'core', min: 0.1, max: 3, value: 1 });
  const renderScale = params.number('core.renderScale', {
    label: 'render scale',
    group: 'core',
    min: 0.4,
    max: 2,
    step: 0.05,
    value: RENDER_SCALE[quality],
  });
  const timeScale = params.number('core.timeScale', { label: 'time scale', group: 'core', min: 0, max: 2, value: 1 });

  const systems: GLSystem[] = createSystems();
  const total = systems.length * 2 + 3;
  let step = 0;
  const progress = (label: string) => opts.onProgress?.(Math.min(1, ++step / total), label);

  // Fault isolation: a system that throws is disabled (and logged) instead of taking the
  // whole demo down. Systems are built in parallel by different people; keep the rest alive.
  const failed = new Set<GLSystem>();
  const fail = (s: GLSystem, stage: string, e: unknown) => {
    failed.add(s);
    console.error(`[goldenline] system "${s.name}" failed in ${stage} and was disabled:`, e);
  };
  for (const s of systems) {
    perf.register(s.name);
    try {
      await s.init(ctx);
    } catch (e) {
      fail(s, 'init', e);
    }
    mark(`init ${s.name}`);
    progress(`building ${s.name}`);
    await yieldTask(); // [polish] let the loading screen paint between systems
  }

  applyQualityParams(params, quality, query);
  let width = canvas.clientWidth || 1280;
  let height = canvas.clientHeight || 720;
  const applySize = () => {
    renderer.setPixelRatio(renderScale.value);
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  };
  applySize();
  params.onChange((p) => {
    if (p === renderScale) applySize();
  });

  const updateAll = () => {
    for (let i = 0; i < systems.length; i++) {
      const s = systems[i];
      if (!s.update || failed.has(s)) continue;
      perf.begin();
      try {
        s.update(ctx);
      } catch (e) {
        fail(s, 'update', e);
      }
      perf.end(s.name);
    }
  };
  const renderFrame = () => {
    renderer.toneMappingExposure = exposure.value;
    renderer.info.reset();
    // [polish] three stamps GPU timestamp queries with info.frame, which only its own animation
    // loop advances: every frame shared one key, so perf.gpuMs summed the whole resolve interval.
    (renderer.info as unknown as { frame: number }).frame = ctx.time.frame;
    ctx.services.post.render(ctx);
  };

  for (const s of systems) {
    try {
      if (s.warmup && !failed.has(s)) await s.warmup(ctx);
    } catch (e) {
      fail(s, 'warmup', e);
    }
    if (s.warmup) mark(`warmup ${s.name}`);
    progress(`warming ${s.name}`);
    await yieldTask();
  }
  await warmPipelines(ctx, (f) => opts.onProgress?.(Math.min(1, (step + f) / total), 'compiling shaders'));
  step++;
  mark('pipelines');
  progress('compiling pipelines');
  for (let i = 0; i < WARM_FRAMES; i++) {
    ctx.time.dt = 1 / 60;
    updateAll();
    nextNodeFrame(ctx);
    renderFrame();
    ctx.time.frame++;
  }
  // Let the GPU drain the warm frames before the loading screen fades.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  mark('warm frames');
  boot.push({ stage: 'total', ms: Math.round(performance.now() - bootStart) });
  if (process.env.NODE_ENV !== 'production') console.info('[goldenline] boot (ms)', JSON.stringify(boot), 'bakes', JSON.stringify(bakeTimeline));
  progress('ready');

  const overlay: Overlay = createOverlay(ctx, opts.overlayHost, (q) => engine.setQuality(q));

  let raf = 0;
  let last = -1;
  let disposed = false;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const ms = last < 0 ? 16.7 : now - last;
    last = now;
    perf.pushFrame(ms);
    if (!ctx.time.frozen) {
      ctx.time.dt = Math.min(ms / 1000, 1 / 20) * timeScale.value;
      ctx.time.t += ctx.time.dt;
    } else {
      ctx.time.dt = 0;
    }
    updateAll();
    renderFrame();
    ctx.time.frame++;
    input.endFrame();
    overlay.update(now);
  };

  /** Advance the simulation deterministically (debug hook / screenshots). */
  const stepFrames = (n: number, dt: number) => {
    for (let i = 0; i < n; i++) {
      ctx.time.dt = dt;
      ctx.time.t += dt;
      updateAll();
      ctx.time.frame++;
    }
    ctx.time.dt = 0;
    nextNodeFrame(ctx);
    renderFrame();
  };

  const engine: Engine = {
    ctx,
    start() {
      if (raf || disposed) return;
      last = -1;
      raf = requestAnimationFrame(tick);
    },
    resize(w, h) {
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      applySize();
    },
    setQuality(q) {
      ctx.quality = q;
      params.set('core.renderScale', RENDER_SCALE[q]);
      applyQualityParams(params, q, query);
      for (const s of systems) s.setQuality?.(ctx, q);
      ctx.services.post.rebuild(ctx);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      overlay.dispose();
      uninstallDebug();
      for (let i = systems.length - 1; i >= 0; i--) {
        try {
          systems[i].dispose?.(ctx);
        } catch (e) {
          console.error(`[goldenline] dispose of "${systems[i].name}" threw:`, e);
        }
      }
      ctx.services.terrain.heightTexture.dispose();
      input.dispose();
      renderer.dispose();
    },
  };

  const uninstallDebug = installDebugHook(ctx, {
    stepFrames,
    renderFrame,
    restart() {
      // three's own rAF loop (it advances nodeFrame) died with the stubbed rAF too
      (renderer as unknown as { _animation: { start(): void } })._animation.start();
      raf = 0;
      engine.start();
    },
    enabled: shotMode || process.env.NODE_ENV !== 'production',
  });
  return engine;
}
