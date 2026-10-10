// LITTLEBIG engine: renderer, context, staged boot, fixed-step loop, pause/resume, disposal.
// See the lifecycle notes in contracts.ts.

import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  InstancedMesh,
  Material,
  Mesh,
  MeshDepthMaterial,
  NeutralToneMapping,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  type Side,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { createPost } from '../render/post';
import { createToonKit } from '../render/toon';
import { getCityIndex, getCityPlan } from '../world/city';
import { getRegion } from '../world/region';
import { SEED } from '../world/config';
import { getPlanet } from '../world/planet';
import { type BootEntry, LAYER_NO_INK, type LBContext, type Quality, type Services, type System, type Variant, type ViewSpec, type ViewState } from './contracts';
import type { DebugDeps } from './debug';
import { KIT } from './kit';
import { ParamRegistry } from './params';
import { Perf } from './perf';
import { FrameEvents } from './frame-events';
import type { PlanetSession } from './session';
import { detectQuality, qualitySettings } from './quality';
import { createReveal } from './reveal';
import { createSystems } from './systems';
import { createLabelService, createTrackService } from './track';
import { createSharedUniforms } from './uniforms';

export class NoWebGLError extends Error {}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  variant: Variant;
  reducedMotion: boolean;
  /** location.search: `?q=low|high`, `?p.<key>=<v>`, `?shot=1`, `?t=<s>`. */
  search: string;
  onProgress?: (fraction: number, label: string) => void;
  /**
   * Reboot after a WebGL context loss: carry on from this camera view and sim time, with the
   * reveal instant (the player is not thrown back to the opening orbit, nor shown the reveal again).
   */
  resume?: PlanetSession;
}

export interface Engine {
  ctx: LBContext;
  /** Pauses with the engine; removed automatically on disposal. Runs after render. */
  subscribeFrame(fn: (now: number) => void): () => void;
  readonly status: 'running' | 'suspended' | 'disposed';
  /** Resolves once every stage-2 system is built (the world is complete). */
  ready: Promise<void>;
  /** Start the render loop (and the stage-2 build). */
  start(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** three's shadow pass draws a material's back faces into the map (WebGLShadowMap's shadowSide). */
const SHADOW_SIDE: Record<Side, Side> = { [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide };

/**
 * ctx.world's lazy city getters, defined at module scope on purpose: the plan and index are cached
 * for the page's lifetime (world/city/index.ts), so the closures inside them must never capture an
 * engine. Written inline in createEngine, the minifier inlined getCityIndex() and createCityIndex()
 * into the getter, and the cached index's closures (roofAt, the terrainH callback…) kept the first
 * engine — renderer, scene, every system — alive after its window closed (production only).
 */
const WORLD_CITY: PropertyDescriptorMap = {
  city: { get: getCityPlan, enumerable: true },
  cityIndex: { get: getCityIndex, enumerable: true },
  region: { get: getRegion, enumerable: true }, // v2 (R1)
};

/**
 * Adaptive resolution. The frame cost is mostly per pixel, so when the live loop misses frames (the
 * median rAF interval over ~1 s above ADAPT_SLOW_MS: a 60 Hz display dropping to 30) the pixel ratio
 * steps down the ladder (1.5 → 1.25 → 1 → 0.85). It steps back up after a calm hold, and a level
 * that failed again soon after is retried later each time (8 s, 16 s… 64 s), so a scene that cannot
 * hold it never oscillates. Only after the world is complete, never in shot mode (deterministic
 * review frames), `?p.core.adaptive=false` turns it off. A resolution change only resizes the
 * canvas and the post targets: no recompiles.
 */
const ADAPT_FLOOR = 0.85;
const ADAPT_SLOW_MS = 18;
const ADAPT_JANK_MS = 21;
const ADAPT_HOLD_MS = 8000;
function dprLadder(maxDpr: number): number[] {
  const top = Math.min(window.devicePixelRatio || 1, maxDpr);
  const out = [top];
  for (let d = Math.ceil(top * 4 - 1e-6) / 4 - 0.25; d > ADAPT_FLOOR + 0.05; d -= 0.25) out.push(d);
  if (top > ADAPT_FLOOR + 0.05) out.push(ADAPT_FLOOR);
  return out;
}

const FIXED_DT = 1 / 60;
const MAX_STEPS = 8;
/** Time-slice budget bounds for stage-2 init work per frame (ms); the live value follows the display. */
const SLICE_MIN_MS = 2;
const SLICE_MAX_MS = 8;
const SLICE_SLOW_MS = 250;

export async function createEngine(opts: EngineOptions): Promise<Engine> {
  const t0 = performance.now();
  const entries: BootEntry[] = [];
  let last = t0;
  const boot = {
    entries,
    mark(stage: string, wait?: number) {
      const now = performance.now();
      const e: BootEntry = { stage, ms: Math.round((now - last) * 10) / 10, at: Math.round(now - t0) };
      if (wait !== undefined) e.wait = Math.round(wait);
      entries.push(e);
      last = now;
    },
  };

  const query = new URLSearchParams(opts.search);
  const shotMode = query.has('shot');
  const quality: Quality = detectQuality(opts.search);
  // ?shot=1&dpr=2: supersampled trailer frames past the tier's cap (scripts/play-media/littlebig-cine.mjs).
  const q = { ...qualitySettings(quality), ...(shotMode && query.has('dpr') ? { maxDpr: Number(query.get('dpr')) || 1 } : null) };

  // WebGL2 or nothing (three r163+ needs it).
  let renderer: WebGLRenderer;
  try {
    const probe = opts.canvas.getContext('webgl2', { antialias: q.antialias, powerPreference: 'high-performance', stencil: false });
    if (!probe) throw new NoWebGLError('webgl2 unavailable');
    renderer = new WebGLRenderer({ canvas: opts.canvas, context: probe, antialias: q.antialias, powerPreference: 'high-performance', stencil: false });
  } catch (e) {
    throw e instanceof NoWebGLError ? e : new NoWebGLError(String(e));
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.info.autoReset = false;
  // Adaptive resolution: the pixel-ratio ladder from the tier's cap down to ADAPT_FLOOR (see tick).
  let dprLevels = dprLadder(q.maxDpr);
  let dprLevel = 0;
  renderer.setPixelRatio(dprLevels[0]);
  boot.mark('renderer');

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 16 / 9, 1, 1000);
  const uniforms = createSharedUniforms();
  const toon = createToonKit(uniforms, { reducedMotion: opts.reducedMotion });
  const reveal = createReveal(shotMode || !!opts.resume, uniforms);
  const params = new ParamRegistry(opts.search);
  // three's shader error check reads every program's info logs on its first use: synchronous GPU
  // round trips that stalled the main thread 40–55 ms per program on a cold first visit. A program
  // that fails still logs WebGL's "program not valid" warnings. On in dev for the readable log;
  // `?p.core.shaderChecks=false` measures the production path there.
  renderer.debug.checkShaderErrors = params.toggle('core.shaderChecks', { label: 'shader error logs (read at boot)', value: process.env.NODE_ENV !== 'production' }).value;
  const perf = new Perf();
  const frameEvents = new FrameEvents();
  // The post chain (B4, render/post): the scene renders into its own HDR target, so every scene
  // program must be compiled with a render target bound (no tone mapping, linear output), exactly
  // as it will be drawn. compileScene() does that; null post = plain render (no float targets).
  const post = createPost(renderer, q.post, params, uniforms);

  const planet = getPlanet(SEED);
  void planet.region; // v2 (R1): the region is carved into the terrain; build it inside this boot mark
  boot.mark('planet');
  // The city plan is built right after the sky has kicked off the shader warm-up (below), so its
  // cost overlaps the compile. Budget (A2): city plan + index ≤ 30 ms on the M3 — it is on the
  // first-frame path. Anything that touches ctx.world.city earlier builds it on demand.
  const world = Object.defineProperties({ seed: SEED, planet }, WORLD_CITY) as LBContext['world'];

  const tracked = new Set<{ dispose(): void }>();
  let sliceStart = performance.now();
  // Slice budget: the display's frame interval minus the last frame's CPU cost and a margin.
  let frameInterval = 1000 / 60;
  let frameCpu = 3;
  // Below 10 fps (software GL, a starved GPU) the frame is a slideshow anyway: slice for half a
  // frame (≤ SLICE_SLOW_MS), or a boot that yields a few hundred times waits minutes on frames.
  let rafInterval = 1000 / 60;
  const sliceBudget = () =>
    rafInterval > 100 ? Math.min(SLICE_SLOW_MS, rafInterval / 2) : Math.max(SLICE_MIN_MS, Math.min(SLICE_MAX_MS, frameInterval - frameCpu - 2));
  let disposed = false;
  let resolveDisposed: () => void = () => {};
  const disposedPromise = new Promise<void>((r) => (resolveDisposed = r));
  const never = <T = void>() => new Promise<T>(() => {});
  const view: ViewState = {
    eye: new Vector3(),
    forward: new Vector3(0, 0, -1),
    focus: new Vector3(0, 0, 1),
    alt: 380,
    altTerrain: 380,
    altSea: 380,
    ground: 0,
    lat: 0,
    lon: 0,
    heading: 0,
    pitch: -Math.PI / 2,
    fov: 40,
    horizon: 0,
    street: false,
    cityX: 0,
    cityZ: 0,
    cityDist: 0,
    mode: 'explore',
    ride: null,
  };
  const services: Services = {
    // (`.stats` on the post render function: why the ¼-res pass ran last frame, for review tools.)
    render: post ? Object.assign((c: LBContext) => post.render(c), { stats: post.stats }) : (c) => c.renderer.render(c.scene, c.camera),
    sky: { sun: null, fog: null },
    camera: {
      setView() {},
      getView: () => ({ lat: 0, lon: 0, alt: 380, heading: 0, pitch: -90 }),
      flyTo() {},
      releaseLock() {},
      lastInputAt: () => 0,
    },
    crossings: { busy: new Uint8Array(0), blocked: new Uint8Array(0) }, // sized once the plan exists
    // v2 registries; the track service reads ctx (camera, canvas), so it is installed just below.
    track: null as unknown as Services['track'],
    labels: createLabelService(),
  };
  const timeScale = params.number('core.timeScale', { label: 'time scale', min: 0, max: 8, value: 1 });
  const exposure = params.number('core.exposure', { label: 'exposure', min: 0.3, max: 2, value: 1 });

  const ctx: LBContext = {
    renderer,
    scene,
    camera,
    canvas: opts.canvas,
    time: { t: opts.resume?.t ?? (Number(query.get('t') ?? 0) || 0), fixedDt: FIXED_DT, alpha: 0, render: 0, dt: 0, realDt: 0, frame: 0, frozen: shotMode, timeScale: 1 },
    view,
    world,
    quality,
    q,
    variant: opts.variant,
    reducedMotion: opts.reducedMotion,
    shotMode,
    uniforms,
    toon,
    reveal,
    boot,
    params,
    perf,
    services,
    debug: { cameraLocked: shotMode },
    track(r) {
      tracked.add(r);
      return r;
    },
    yield() {
      if (disposed) return never();
      if (performance.now() - sliceStart < sliceBudget()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        // Let the browser draw a frame, then continue in a fresh task. Never resume after dispose.
        requestAnimationFrame(() =>
          setTimeout(() => {
            if (disposed) return;
            sliceStart = performance.now();
            resolve();
          }, 0),
        );
      });
    },
    compile: async () => {
      await compileNew();
    },
    prewarm: (objects) => prewarm(objects),
  };
  services.track = createTrackService(ctx);
  camera.layers.enable(LAYER_NO_INK);
  ctx.time.render = ctx.time.t;

  const systems: System[] = createSystems();
  const failed = new Set<System>();
  const fail = (s: System, stage: string, e: unknown) => {
    failed.add(s);
    console.error(`[littlebig] system "${s.name}" failed in ${stage} and was disabled:`, e);
  };
  // Stage-1 INIT order: the sky first (it creates the lights and fog every lit program's key
  // depends on, so the shader warm-up can start at once), then systems.ts order. Update order is
  // systems.ts order, camera first.
  const stage1 = systems.filter((s) => s.stage === 1).sort((a, b) => (b.name === 'sky' ? 1 : 0) - (a.name === 'sky' ? 1 : 0));
  const stage2 = systems.filter((s) => s.stage === 2);
  const total = systems.length + 1;
  let built = 0;
  const progress = (label: string) => opts.onProgress?.(Math.min(1, ++built / total), label);

  // ?cold (shot tool --cold): make every shader source unique so the OS/driver shader caches miss
  // and boot timings show a first visit's compile cost.
  const coldSalt = `0.${String(Math.random()).slice(2, 10)}e-30`;
  const saltCold = (mat: Material | undefined) => {
    if (!mat || !query.has('cold') || mat.userData.lbCold) return;
    // (A bare #define is stripped by ANGLE's preprocessor, so the salt must reach the output.)
    const salt = coldSalt;
    mat.userData.lbCold = true;
    const prev = mat.onBeforeCompile.bind(mat);
    const prevKey = mat.customProgramCacheKey.bind(mat);
    mat.onBeforeCompile = (sh, r) => {
      prev(sh, r);
      sh.fragmentShader = sh.fragmentShader.replace(/\}\s*$/, `  gl_FragColor.rgb += vec3(${salt});\n}`);
    };
    mat.customProgramCacheKey = () => prevKey() + salt;
    mat.needsUpdate = true;
  };
  const applyCold = () => {
    if (!query.has('cold')) return;
    scene.traverse((o) => {
      const m = o as Mesh;
      for (const mat of [m.material, m.customDepthMaterial].flat() as Array<Material | undefined>) saltCold(mat);
    });
  };

  // ── shader warm-up ──
  // Shadow depth programs: three's shadow pass draws with the material's shadow side, NO scene fog
  // and into a render target (so: no tone mapping, linear output) — each part of the program key.
  // A normal-pass compile (or warming against the canvas) builds the wrong program, which then
  // compiles synchronously inside the first frame that casts the shadow. So the warm-up compiles
  // proxies of every shadow caster (sharing geometry, instancing attributes and the custom depth
  // material) with a render target bound and the fog off, exactly as the shadow pass will.
  const warmRT = new WebGLRenderTarget(1, 1, { depthBuffer: false });
  const defaultDepth: Partial<Record<Side, MeshDepthMaterial>> = {}; // stand-ins for three's internal one
  /** Compile the scene's colour programs for the target the frame draws into (see `post`). */
  const compileScene = (): Promise<unknown> => {
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(post?.offscreen ? warmRT : null);
    try {
      return renderer.compileAsync(scene, camera);
    } finally {
      renderer.setRenderTarget(prevRT);
    }
  };
  const shadowProxy = (roots: Iterable<Object3D>): Scene | null => {
    const proxy = new Scene();
    for (const root of roots) {
      root.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh || !m.castShadow) return;
        for (const mat of [m.material].flat() as Material[]) {
          const side = mat.shadowSide ?? SHADOW_SIDE[mat.side];
          let dm = m.customDepthMaterial as MeshDepthMaterial | undefined;
          if (dm) dm.side = side; // the shadow pass sets the same side on every draw
          else {
            if (!(dm = defaultDepth[side])) {
              dm = defaultDepth[side] = new MeshDepthMaterial({ side });
              saltCold(dm);
            }
            // --cold salts programs so the driver cache misses; three's internal shadow material is
            // unsalted, so in cold mode the caster draws its shadow with the (salted) stand-in.
            if (query.has('cold')) m.customDepthMaterial = dm;
          }
          let p: Mesh;
          const im = m as unknown as InstancedMesh;
          if (im.isInstancedMesh) {
            const pi = new InstancedMesh(m.geometry, dm, im.count);
            pi.instanceMatrix = im.instanceMatrix;
            pi.instanceColor = im.instanceColor;
            pi.morphTexture = im.morphTexture;
            p = pi;
          } else p = new Mesh(m.geometry, dm);
          proxy.add(p);
        }
      });
    }
    return proxy.children.length ? proxy : null;
  };
  /** Compile the shadow depth programs of `roots` as the shadow pass will use them. */
  const warmShadows = (roots: Iterable<Object3D>): Promise<unknown> => {
    const sun = services.sky.sun;
    if (!sun || !renderer.shadowMap.enabled) return Promise.resolve();
    const proxy = shadowProxy(roots);
    if (!proxy) return Promise.resolve();
    const fog = scene.fog;
    const prevRT = renderer.getRenderTarget();
    scene.fog = null;
    renderer.setRenderTarget(warmRT);
    let p: Promise<unknown>;
    try {
      p = renderer.compileAsync(proxy, sun.shadow.camera, scene);
    } finally {
      renderer.setRenderTarget(prevRT);
      scene.fog = fog;
    }
    return p.catch(() => {});
  };

  /** ctx.prewarm: kick colour + shadow compiles for stand-ins of meshes still being built. */
  const prewarmed: Promise<unknown>[] = [];
  const prewarm = (objects: Object3D[]) => {
    if (disposed || !objects.length) return;
    const group = new Scene();
    for (const o of objects) {
      o.traverse((x) => {
        const m = x as Mesh;
        for (const mat of [m.material, m.customDepthMaterial].flat() as Array<Material | undefined>) saltCold(mat);
      });
      group.add(o);
    }
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(post?.offscreen ? warmRT : null);
    let colour: Promise<unknown>;
    try {
      colour = renderer.compileAsync(group, camera, scene);
    } finally {
      renderer.setRenderTarget(prevRT);
    }
    prewarmed.push(Promise.all([colour.catch(() => {}), warmShadows(objects)]).finally(() => group.clear()));
  };

  /**
   * Draw `roots` once, every descendant visible and unculled, clipped to one pixel of the target the
   * frame draws into, colour and shadow pass: their buffers upload (2.5 MB of near-only geometry
   * and instances otherwise landed mid-dive, 4–11 ms frames) and the driver builds their pipelines
   * now, behind the reveal, instead of on the frame that first shows them. Nothing else is drawn.
   */
  const warmVis: Object3D[] = [];
  const warmCull: Object3D[] = [];
  const warmCount: InstancedMesh[] = [];
  const warmDrawOn = params.toggle('core.warmDraw', { label: 'stage-2 warm draw (read at boot)', value: true }).value;
  const warmDraw = (roots: Object3D[]) => {
    if (!roots.length || !warmDrawOn) return;
    // Everything else drawable is hidden for it; lights are not (they are part of every program's key).
    const ch = scene.children;
    for (const root of ch) {
      if (roots.includes(root)) continue;
      root.traverseVisible((o) => {
        const d = o as Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
        if (d.isMesh || d.isPoints || d.isLine || d.isSprite) warmVis.push(o);
      });
    }
    for (const o of warmVis) o.visible = false;
    const hidden: Object3D[] = [];
    for (const r of roots)
      r.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
        if (o.frustumCulled) {
          warmCull.push(o);
          o.frustumCulled = false;
        }
        const im = o as InstancedMesh;
        if (im.isInstancedMesh && im.count === 0 && im.instanceMatrix.count > 0) {
          warmCount.push(im);
          im.count = 1; // (a zero-instance draw builds no pipeline)
        }
      });
    try {
      if (post?.offscreen) post.warm(scene, camera);
      else {
        renderer.setScissorTest(true);
        renderer.setScissor(0, 0, 1, 1);
        renderer.setViewport(0, 0, 1, 1);
        renderer.render(scene, camera);
      }
    } catch (e) {
      console.warn('[littlebig] warm draw', e);
    } finally {
      if (!post?.offscreen) {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        renderer.setScissor(0, 0, width, height);
      }
      for (const o of warmVis) o.visible = true;
      for (const o of hidden) o.visible = false;
      for (const o of warmCull) o.frustumCulled = true;
      for (const im of warmCount) im.count = 0;
      warmVis.length = warmCull.length = warmCount.length = 0;
    }
  };

  let cityBuilt = false;
  function buildCity() {
    if (cityBuilt) return;
    cityBuilt = true;
    const n = world.city.walkEdges.length;
    void world.cityIndex;
    services.crossings = { busy: new Uint8Array(n), blocked: new Uint8Array(n) };
    boot.mark('city plan');
  }

  /**
   * Stage 2: the scene roots whose programs are warm (frames draw only these, see renderFrame), and
   * the roots an in-flight ctx.compile() has claimed. Null outside stage 2.
   */
  let initRoots: Set<Object3D> | null = null;
  const claimed = new Set<Object3D>();
  /** Compile the programs of every root added since and not yet warm; resolves with the ms waited. */
  async function compileNew(): Promise<number> {
    if (disposed) return never<number>();
    const t = performance.now();
    const watching = watchPrograms >= 0;
    watchPrograms = -1; // compiling here is the point; don't flag it
    applyCold();
    // (Roots another init's compile has claimed are left to it: marking them warm here, before
    // their programs are ready, would let a frame draw them.)
    const fresh = initRoots ? scene.children.filter((o) => !initRoots!.has(o) && !claimed.has(o)) : [];
    for (const o of fresh) claimed.add(o);
    const was = fresh.map((o) => o.visible);
    for (const o of fresh) o.visible = false; // compile() still traverses invisible objects
    try {
      await Promise.race([Promise.all([compileScene().catch(() => {}), warmShadows(fresh)]), disposedPromise]);
      if (!disposed) warmDraw(fresh);
    } finally {
      fresh.forEach((o, i) => (o.visible = was[i]));
      if (watching || initRoots) watchPrograms = renderer.info.programs?.length ?? 0;
    }
    if (disposed) return never<number>();
    // Warm now: frames may draw them (see renderFrame).
    for (const o of fresh) {
      claimed.delete(o);
      initRoots?.add(o);
    }
    return performance.now() - t;
  }

  // Stage 1. Once the sky has made the lights and fog (which every lit program depends on), start
  // compiling — in parallel threads where the driver supports KHR_parallel_shader_compile — the
  // sky's and the post chain's programs, the default shadow depth program and (System.prepare)
  // the terrain's and ocean's, while terrain and ocean build their meshes on the main thread.
  // (C2: the warm mesh's own colour program is not compiled any more: no first-frame surface used
  // that plain toon variant since terrain and ocean got their own patches, so its ~0.5 s cold
  // compile only held the first frame back, then was thrown away. It now only stands in for the
  // default shadow depth program.)
  const warmGeo = new BufferGeometry();
  warmGeo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  warmGeo.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  warmGeo.setAttribute('color', new BufferAttribute(new Uint8Array(9), 3, true));
  const warmMesh = new Mesh(warmGeo, toon.material({ name: 'warm:toon', vertexColors: true }));
  warmMesh.castShadow = true;
  warmMesh.frustumCulled = false;
  let warmKick: Promise<unknown> | null = null;
  for (const s of stage1) {
    try {
      await s.init(ctx);
    } catch (e) {
      fail(s, 'init', e);
    }
    boot.mark(`init ${s.name}`);
    progress(s.name);
    if (!warmKick && services.sky.sun) {
      applyCold();
      warmKick = Promise.all([compileScene().catch(() => {}), warmShadows([warmMesh]), post?.compile()]);
      // The other stage-1 systems' materials, compiled while their inits build geometry.
      for (const o of stage1) {
        if (o === s || !o.prepare || failed.has(o)) continue;
        try {
          o.prepare(ctx);
        } catch (e) {
          fail(o, 'prepare', e);
        }
      }
      boot.mark('prepare');
      buildCity();
    }
  }
  buildCity();
  if (opts.resume) services.camera.setView(opts.resume.view);

  // Size before the first frame so the projection is right.
  let width = opts.canvas.clientWidth || 960;
  let height = opts.canvas.clientHeight || 600;
  renderer.setSize(width, height, false);
  const dbSize = new Vector2();
  const sizePost = () => {
    renderer.getDrawingBufferSize(dbSize);
    post?.setSize(dbSize.x, dbSize.y);
  };
  sizePost();
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  /** Canvas, post targets, projection and systems for the current size and pixel-ratio level. */
  const applySize = () => {
    const dpr = dprLevels[dprLevel];
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    sizePost();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    for (const s of systems) {
      if (!s.resize || failed.has(s) || !initialised.has(s)) continue;
      try {
        s.resize(ctx, width, height, dpr);
      } catch (e) {
        fail(s, 'resize', e);
      }
    }
  };

  // ── frame pieces ──
  let acc = 0;
  let prevRender = ctx.time.t;
  const runUpdates = () => {
    for (let i = 0; i < systems.length; i++) {
      const s = systems[i];
      if (!s.update || failed.has(s) || !initialised.has(s)) continue;
      const a = performance.now();
      try {
        s.update(ctx);
      } catch (e) {
        fail(s, 'update', e);
      }
      perf.system(s.name, performance.now() - a);
    }
  };
  const runFixed = () => {
    for (let i = 0; i < systems.length; i++) {
      const s = systems[i];
      if (!s.fixedUpdate || failed.has(s) || !initialised.has(s)) continue;
      try {
        s.fixedUpdate(ctx);
      } catch (e) {
        fail(s, 'fixedUpdate', e);
      }
    }
    ctx.time.t += FIXED_DT;
  };
  const advanceSim = (simDt: number) => {
    acc += simDt;
    let steps = 0;
    while (acc >= FIXED_DT - 1e-9 && steps < MAX_STEPS) {
      runFixed();
      acc -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) acc = Math.min(acc, FIXED_DT);
    ctx.time.alpha = Math.max(0, Math.min(0.999, acc / FIXED_DT));
    ctx.time.render = ctx.time.t + ctx.time.alpha * FIXED_DT;
    ctx.time.dt = ctx.time.render - prevRender;
    prevRender = ctx.time.render;
  };
  // Dev guard (BRIEF §1: no shader compiles after the reveal): warn when a frame builds a program.
  let watchPrograms = -1;
  const unwarmed: Object3D[] = [];
  const renderFrame = () => {
    renderer.toneMappingExposure = exposure.value;
    uniforms.lbTime.value = ctx.time.render;
    renderer.info.reset();
    // Roots a stage-2 init has added but ctx.compile() has not warmed yet are not drawn: a frame
    // that drew them (a system yielding between scene.add and compile) would build their programs
    // synchronously inside it, ~40-200 ms each on a cold visit.
    if (initRoots) {
      const ch = scene.children;
      for (let i = 0; i < ch.length; i++) {
        const o = ch[i];
        if (o.visible && !initRoots.has(o)) {
          o.visible = false;
          unwarmed.push(o);
        }
      }
    }
    try {
      services.render(ctx);
    } finally {
      for (let i = 0; i < unwarmed.length; i++) unwarmed[i].visible = true;
      unwarmed.length = 0;
    }
    if (watchPrograms >= 0) {
      const n = renderer.info.programs?.length ?? 0;
      if (n > watchPrograms && process.env.NODE_ENV !== 'production') {
        const names = (renderer.info.programs ?? []).slice(watchPrograms).map((p) => p.name).join(', ');
        console.warn(`[littlebig] shader program compiled mid-flow (a hitch): ${names}. Create the material in init() and let ctx.compile() warm it.`);
      }
      watchPrograms = n;
    }
    frameEvents.emit(performance.now());
  };
  /** One full frame with a given sim dt and real dt. */
  const frame = (simDt: number, realDt: number) => {
    ctx.time.realDt = realDt;
    ctx.time.timeScale = timeScale.value;
    advanceSim(simDt);
    reveal.tick(realDt);
    runUpdates();
    renderFrame();
    ctx.time.frame++;
  };

  const initialised = new Set<System>(stage1.filter((s) => !failed.has(s)));

  applyCold();
  // Warm every program the first frame needs — colour and shadow depth — in parallel where the
  // driver can (KHR_parallel_shader_compile), then draw it.
  try {
    await Promise.all([compileScene(), warmShadows(scene.children), post?.compile(), ...prewarmed]);
  } catch (e) {
    console.warn('[littlebig] compile', e);
  }
  boot.mark('compile');
  (warmMesh.material as Material).dispose();
  warmGeo.dispose();
  const programsBefore = renderer.info.programs?.length ?? 0;
  frame(0, 1 / 60);
  boot.mark('first frame');
  const lateFirst = (renderer.info.programs?.length ?? 0) - programsBefore;
  if (lateFirst > 0 && process.env.NODE_ENV !== 'production') console.warn(`[littlebig] ${lateFirst} shader program(s) compiled inside the first frame (missed by the warm-up)`);
  progress('first frame');

  // ── loop ──
  let raf = 0;
  let lastNow = -1;
  let running = false;
  let paused = false; // perf() pauses the loop
  let visible = !document.hidden;
  let onScreen = true;

  // ── adaptive resolution (see ADAPT_FLOOR) ──
  const adaptive = params.toggle('core.adaptive', { label: 'adaptive resolution', value: true });
  let adaptN = 0;
  let adaptSlow = 0;
  let adaptJank = 0;
  let adaptMs = 0;
  let adaptCalm = 0;
  let lastUpAt = -1e9;
  let lastUpLevel = -1;
  const retryAt = new Float64Array(8); // per ladder level: when stepping back up into it is allowed
  const backoff = new Float64Array(8).fill(ADAPT_HOLD_MS);
  const setDprLevel = (level: number, now: number) => {
    dprLevel = level;
    adaptN = adaptSlow = adaptJank = adaptMs = adaptCalm = 0;
    applySize();
    if (process.env.NODE_ENV !== 'production') console.info(`[littlebig] pixel ratio ${dprLevels[level]} (${Math.round(now / 100) / 10} s)`);
  };
  const adaptResolution = (interval: number, now: number) => {
    if (shotMode || !adaptive.value || !isReady || dprLevels.length < 2) return;
    // A stall (a GC, a tab coming back) is not a trend.
    if (interval > 100) {
      adaptN = adaptSlow = adaptJank = adaptMs = 0;
      return;
    }
    adaptN++;
    adaptMs += interval;
    if (interval > ADAPT_SLOW_MS) adaptSlow++;
    if (interval > ADAPT_JANK_MS) adaptJank++;
    if (adaptMs < 1000) return;
    const slow = adaptSlow * 2 > adaptN; // the median frame is late
    const calm = adaptJank * 20 <= adaptN; // ≤ 5 % of frames late
    adaptN = adaptSlow = adaptJank = adaptMs = 0;
    if (slow && dprLevel < dprLevels.length - 1) {
      // Dropped again soon after stepping up into this level: wait longer before the next try.
      if (dprLevel === lastUpLevel && now - lastUpAt < 4000) backoff[dprLevel] = Math.min(64000, backoff[dprLevel] * 2);
      retryAt[dprLevel] = now + backoff[dprLevel];
      setDprLevel(dprLevel + 1, now);
      return;
    }
    adaptCalm = calm ? adaptCalm + 1 : 0;
    if (dprLevel > 0 && adaptCalm >= 3 && now >= retryAt[dprLevel - 1]) {
      lastUpLevel = dprLevel - 1;
      lastUpAt = now;
      setDprLevel(dprLevel - 1, now);
    }
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const first = lastNow < 0;
    const interval = first ? 1000 / 60 : now - lastNow;
    lastNow = now;
    if (!first) adaptResolution(interval, now);
    const realDt = Math.min(0.1, interval / 1000);
    const a = performance.now();
    frame(ctx.time.frozen ? 0 : realDt * timeScale.value, realDt);
    const cpu = performance.now() - a;
    perf.push(interval, cpu);
    // Slice budget inputs (smoothed; vsync-quantised intervals jitter).
    if (interval > 4 && interval < 50) frameInterval += (interval - frameInterval) * 0.2;
    if (!first) rafInterval += (Math.min(interval, 2000) - rafInterval) * 0.2;
    frameCpu += (cpu - frameCpu) * 0.2;
  };
  const shouldRun = () => running && !paused && visible && onScreen && !disposed && !contextLost;
  const sync = () => {
    if (shouldRun()) {
      if (!raf) {
        lastNow = -1;
        raf = requestAnimationFrame(tick);
      }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  const onVisibility = () => {
    visible = !document.hidden;
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((es) => {
          onScreen = es[es.length - 1]?.isIntersecting ?? true;
          sync();
        })
      : null;
  io?.observe(opts.canvas);
  // Context loss (GPU reset, iOS backgrounding): stop drawing; littlebig-canvas.tsx reboots the
  // engine on a fresh canvas when the browser restores the context.
  let contextLost = false;
  // Everything is released right here, while the context is lost: GL deletes are silent no-ops
  // then. Released after the restore instead (the canvas reboots on a fresh one), every delete
  // would hit the restored context with objects from the lost one (INVALID_OPERATION spam).
  const onLost = (e: Event) => {
    e.preventDefault();
    contextLost = true;
    sync();
    console.warn('[littlebig] WebGL context lost');
    engine.dispose();
  };
  opts.canvas.addEventListener('webglcontextlost', onLost);

  // ── stage 2: built after the first frame, time-sliced, revealed ──
  let isReady = stage2.length === 0;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => (resolveReady = r));
  if (isReady) resolveReady();
  let stage2Started = false;
  // Pipelined: the next system starts building (on the next frame) as soon as the current one asks
  // for its compile, so one system's CPU work overlaps the driver compiling the previous ones'
  // programs (a cold visit spends most of stage 2 waiting on shader compiles). At most one system
  // builds at a time. A system's compile resolves only once the system before it has finished, so
  // the reveals still run in systems.ts order (no cars on an empty plateau before the city).
  const runStage2 = async () => {
    if (stage2Started) return;
    stage2Started = true;
    reveal.start();
    if (!stage2.length) return;
    initRoots = new Set(scene.children);
    let next = 0;
    let finished = 0;
    let allDone: () => void = () => {};
    const all = new Promise<void>((r) => (allDone = r));
    const onNextFrame = (fn: () => void) =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          if (disposed) return;
          sliceStart = performance.now();
          fn();
        }, 0),
      );
    let prevDone: Promise<void> = Promise.resolve();
    const startNext = () => {
      if (disposed || next >= stage2.length) return;
      const before = prevDone;
      let done: () => void = () => {};
      prevDone = new Promise<void>((r) => (done = r));
      void runInit(stage2[next++], before).finally(done);
    };
    const runInit = async (s: System, before: Promise<void>) => {
      let chained = false;
      const chain = () => {
        if (chained) return;
        chained = true;
        onNextFrame(startNext);
      };
      let compiled = false;
      let wait = 0;
      // The system's own view of the context: its ctx.compile() also starts the next system.
      const sctx: LBContext = Object.create(ctx);
      sctx.compile = async () => {
        compiled = true;
        chain();
        wait += await compileNew();
        await before; // reveal order
      };
      try {
        await s.init(sctx);
        if (disposed) {
          // Finished after the engine went away (it awaited something other than ctx.*): let it
          // release what it made; everything it added to the scene is already disposed.
          s.dispose?.(ctx);
          return;
        }
        // Safety net for systems that did not call ctx.compile(): compile before first draw.
        if (!compiled) await sctx.compile();
        if (disposed) return;
        initialised.add(s);
        // From here on any program built by a frame is a missed warm-up (the dev guard warns).
        watchPrograms = renderer.info.programs?.length ?? 0;
      } catch (e) {
        if (disposed) return;
        fail(s, 'init', e);
      }
      chain();
      boot.mark(`init ${s.name}`, wait);
      progress(s.name);
      if (++finished === stage2.length) allDone();
    };
    sliceStart = performance.now();
    startNext();
    await all;
    if (disposed) return;
    initRoots = null;
    boot.mark('stage 2 done');
    watchPrograms = renderer.info.programs?.length ?? 0;
    entries.push({ stage: 'total', ms: Math.round(performance.now() - t0), at: Math.round(performance.now() - t0) });
    isReady = true;
    // Systems now own their trackables. A missing target leaves the fallback explore
    // placement intact; a restored mode is presented before ready resolves.
    if (opts.resume?.camera) {
      services.camera.restore?.(opts.resume.camera);
      frame(0, 0);
    }
    resolveReady();
    if (process.env.NODE_ENV !== 'production') console.info('[littlebig] boot (ms)', entries.map((e) => `${e.stage} ${e.ms}`).join(' · '));
  };

  // ── debug hook ──
  // Loaded only in dev or with ?shot (its own chunk: debug.ts with the named shots, the scripted
  // dive and the shot viewpoints; nothing on the production path imports them).
  let uninstallDebug: () => void = () => {};
  const debugDeps: DebugDeps = {
    enabled: shotMode || process.env.NODE_ENV !== 'production',
    isReady: () => isReady,
    setTime(t) {
      ctx.time.t = t;
      acc = 0;
      ctx.time.alpha = 0;
      ctx.time.render = t;
      prevRender = t;
      for (const s of systems) {
        if (!s.onTimeJump || failed.has(s) || !initialised.has(s)) continue;
        try {
          s.onTimeJump(ctx);
        } catch (e) {
          fail(s, 'onTimeJump', e);
        }
      }
    },
    step(dt, n) {
      const r0 = ctx.time.render;
      for (let i = 0; i < n; i++) {
        advanceSim(dt);
        reveal.tick(dt);
        ctx.time.frame++;
      }
      // One update for the whole step: deltas cover all n sub-steps.
      ctx.time.dt = ctx.time.render - r0;
      ctx.time.realDt = dt * n;
      ctx.time.timeScale = timeScale.value;
      runUpdates();
      renderFrame();
    },
    renderNow: renderFrame,
    // A scripted frame advances the sim by all of dt: the live loop's MAX_STEPS cap (a hitch guard)
    // froze most of a coarse dive (1/6 s frames ran 0.13 s of sim each).
    frameNow(dt) {
      const r0 = ctx.time.render;
      let left = Math.max(0, dt);
      do {
        const d = Math.min(left, MAX_STEPS * FIXED_DT);
        advanceSim(d);
        left -= d;
      } while (left > 1e-9);
      ctx.time.dt = ctx.time.render - r0;
      ctx.time.realDt = dt || 1 / 60;
      ctx.time.timeScale = timeScale.value;
      reveal.tick(ctx.time.realDt);
      runUpdates();
      renderFrame();
      ctx.time.frame++;
    },
    pauseLoop() {
      paused = true;
      sync();
    },
    resumeLoop() {
      paused = false;
      sync();
    },
  };
  if (debugDeps.enabled) {
    // The kit first: the debug chunk's modules read it as they load (core/kit.ts says why).
    void import('./debug-kit')
      .then((k) => {
        k.useKit(KIT);
        return import('./debug');
      })
      .then((m) => {
        if (!disposed) uninstallDebug = m.installDebugHook(ctx, debugDeps);
      });
  }

  const engine: Engine = {
    ctx,
    subscribeFrame: (fn) => frameEvents.subscribe(fn),
    get status() { return disposed ? 'disposed' : shouldRun() ? 'running' : 'suspended'; },
    ready,
    start() {
      if (disposed) return;
      running = true;
      sync();
      void runStage2();
    },
    resize(w, h) {
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      // A new display (the window dragged to another screen) restarts the ladder at its top.
      const ladder = dprLadder(q.maxDpr);
      if (ladder[0] !== dprLevels[0]) {
        dprLevels = ladder;
        dprLevel = 0;
      }
      applySize();
      if (!raf && !contextLost) renderFrame();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      frameEvents.dispose();
      resolveDisposed();
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener('visibilitychange', onVisibility);
      io?.disconnect();
      opts.canvas.removeEventListener('webglcontextlost', onLost);
      uninstallDebug();
      for (let i = systems.length - 1; i >= 0; i--) {
        try {
          systems[i].dispose?.(ctx);
        } catch (e) {
          console.error(`[littlebig] dispose of "${systems[i].name}" threw:`, e);
        }
      }
      // Belt and braces: everything still in the scene, every tracked resource, the toon kit.
      scene.traverse((o: Object3D) => {
        const m = o as Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as Material | Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
        const light = o as unknown as { shadow?: { map?: { dispose(): void } | null; dispose?(): void } };
        light.shadow?.map?.dispose();
      });
      scene.clear();
      for (const r of tracked) r.dispose();
      tracked.clear();
      toon.dispose();
      post?.dispose();
      for (const d of Object.values(defaultDepth)) d?.dispose();
      warmRT.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      if (!contextLost) renderer.forceContextLoss();
    },
  };
  return engine;
}
