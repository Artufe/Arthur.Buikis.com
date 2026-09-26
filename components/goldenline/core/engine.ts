// GOLDENLINE engine bootstrap and render loop. Orchestrator-owned.
//
// Boot: WebGPU check → renderer → services (stubs) → systems.init → systems.warmup →
// renderer.compileAsync → a few warm frames → ready. The React wrapper keeps the loading
// screen up until `ready` resolves, then fades in.

import { AgXToneMapping, PerspectiveCamera, Scene, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';
import { createSystems } from '../systems';
import { createOverlay, type Overlay } from '../ui/overlay';
import { createTerrainService } from '../world/terrain-shape';
import type { GLContext, GLSystem, Quality, Variant } from './contracts';
import { installDebugHook } from './debug';
import { Input } from './input';
import { ParamRegistry } from './params';
import { Perf } from './perf';
import { stubAtmosphere, stubOcean, stubPier, stubPlayer, stubPost, stubState } from './stubs';

export class NoWebGPUError extends Error {}

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
const WARM_FRAMES = 8;

export async function createEngine(opts: EngineOptions): Promise<Engine> {
  const { canvas } = opts;
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) throw new NoWebGPUError();
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
  });
  await renderer.init();
  // WebGPURenderer silently falls back to WebGL2. The brief forbids fallbacks.
  if (!(renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
    renderer.dispose();
    throw new NoWebGPUError();
  }
  renderer.toneMapping = AgXToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.info.autoReset = false;

  const scene = new Scene();
  const camera = new PerspectiveCamera(72, 16 / 9, 0.06, 12000);
  camera.rotation.order = 'YXZ';

  const qParam = query.get('q');
  const quality: Quality =
    qParam === 'low' || qParam === 'medium' || qParam === 'high' || qParam === 'ultra'
      ? qParam
      : opts.variant === 'window'
        ? 'medium'
        : 'high';

  const params = new ParamRegistry(opts.search);
  const perf = new Perf();
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
      terrain: createTerrainService(),
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
  const total = systems.length * 2 + 2;
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
    progress(`building ${s.name}`);
  }

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
    ctx.services.post.render(ctx);
  };

  for (const s of systems) {
    try {
      if (s.warmup && !failed.has(s)) await s.warmup(ctx);
    } catch (e) {
      fail(s, 'warmup', e);
    }
    progress(`warming ${s.name}`);
  }
  await renderer.compileAsync(scene, camera);
  progress('compiling pipelines');
  for (let i = 0; i < WARM_FRAMES; i++) {
    ctx.time.dt = 1 / 60;
    updateAll();
    renderFrame();
    ctx.time.frame++;
  }
  // Let the GPU drain the warm frames before the loading screen fades.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
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

  const uninstallDebug = installDebugHook(ctx, { stepFrames, renderFrame, enabled: shotMode || process.env.NODE_ENV !== 'production' });
  return engine;
}
