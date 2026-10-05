// LITTLEBIG shared contracts. Every system codes against these types. Additive changes only (never
// rename or remove); note each change in docs/littlebig/DECISIONS.md.
//
// Units: metres, seconds; angles in radians unless a field says degrees. The planet is centred
// on the origin with sea-level radius R (world/config.ts). "Up" at a point is its normalised
// position. Lat/lon, headings and the city's plan space are defined in world/sphere.ts and
// world/city/types.ts.
//
// Lifecycle (core/engine.ts):
//   createEngine → renderer, ctx → stage-1 systems init (sky, terrain, ocean, camera) → shader
//   warm-up → FIRST FRAME → engine.start() → stage-2 systems init one after another, time-sliced
//   across frames (ctx.yield), each revealing itself with ctx.reveal → `ready`.
// Per frame: fixed sim steps (fixedUpdate, deterministic) → update (every system, in systems.ts
// order) → services.render(ctx). fixedUpdate runs BEFORE the camera's update, so it sees the
// previous frame's ctx.view.
//
// ── Render contract (decided up front so B4's ink/post pass needs no edits elsewhere) ──
// Ink outlines (B4) come from the depth buffer: edges are found on depth discontinuities and on
// normals reconstructed from depth, so every depth-writing material is inked with no per-shader
// output (no MRT attachments to write). Rules for every system:
//   1. Anything that must NOT be inked (sky, stars, glow shells, contrails, clouds' soft edges,
//      light pools, particles) does not write depth (depthWrite: false), or lives on layer
//      LAYER_NO_INK. Everything else stays on LAYER_WORLD.
//   2. Use ctx.toon.material() for lit surfaces. A custom ShaderMaterial must merge ctx.uniforms
//      into its uniforms (LB_COMMON_GLSL declares them), include three's fog chunks when it sets
//      `fog: true`, and end its fragment shader with
//        #include <tonemapping_fragment>
//        #include <colorspace_fragment>
//      so it stays correct when B4 renders the scene into an HDR target.
//   3. B4 may add a toon-kit-only normal output inside render/; nothing outside render/ depends on it.

/** Layer 0: the world (inked by B4's outline pass). */
export const LAYER_WORLD = 0;
/** Layer 1: visible but never inked. Enable it on the camera too: `ctx.camera.layers.enable(LAYER_NO_INK)` is done by core. */
export const LAYER_NO_INK = 1;

import type { DirectionalLight, Fog, Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type { CityIndex, CityPlan } from '../world/city/types';
import type { Planet } from '../world/planet';
import type { Vec3 } from '../world/sphere';
import type { ToonKit } from '../render/toon';
import type { ParamRegistry } from './params';
import type { Perf } from './perf';
import type { SharedUniforms } from './uniforms';

export type Quality = 'low' | 'high';
export type Variant = 'window' | 'page';

/** Per-tier settings, fixed for the session (core/quality.ts). Systems read, never write. */
export interface QualitySettings {
  /** Device-pixel-ratio cap. */
  maxDpr: number;
  /** Directional shadow map size (px). */
  shadowMapSize: number;
  /** Terrain icosphere subdivision level. */
  terrainDetail: number;
  /**
   * Whether the canvas (default framebuffer) uses MSAA. Context attributes are fixed at creation,
   * so a tier whose post chain renders into its own targets (B4) should set this false: a
   * multisampled canvas would be wasted memory and bandwidth.
   */
  antialias: boolean;
  /** Scale for instance counts of decorative things (grass, flowers, birds): 1 on high. */
  density: number;
  /** Whether expensive post (outlines at full res, tilt-shift, bloom) may run. */
  post: boolean;
}

export interface LBTime {
  /** Sim seconds, advanced only in fixed steps of fixedDt (deterministic). setTime() jumps it. */
  t: number;
  /** The fixed step (1/60 s). */
  readonly fixedDt: number;
  /** [0, 1): how far render time is past the last fixed step. Interpolate entity motion with it. */
  alpha: number;
  /**
   * t + alpha · fixedDt: the moment being drawn. Derive visuals (clouds, sun, shaders, wheel spin,
   * walk phase) from this where possible rather than accumulating dt: then every path (live loop,
   * debug step, setTime) agrees.
   */
  render: number;
  /** Render-time delta of this frame (0 while frozen). After a debug step(dt, n) it is n · dt. */
  dt: number;
  /** Wall-clock delta of this frame, clamped to 0.1 s. Camera, UI and reveal use it; never sim. */
  realDt: number;
  frame: number;
  /** True in ?shot=1: sim time only moves through the debug hook's step(). */
  frozen: boolean;
  /** Multiplies sim speed (param core.timeScale). */
  timeScale: number;
}

/**
 * The camera's state, written by the camera system at the start of every frame (before the other
 * systems update). Read it for LOD, fades and culling. Never write it.
 */
export interface ViewState {
  /** Camera world position (same as ctx.camera.position). */
  eye: Vector3;
  /** Camera look direction (unit, world). */
  forward: Vector3;
  /** Unit direction of the surface point under the camera. */
  focus: Vector3;
  /**
   * The camera's zoom altitude (m): the log-spring altitude above the terrain/water reference, plus
   * the FPV jump. Drives the pitch / FOV curves. It ignores roofs: when the eye has to clear a
   * building it is lifted (altTerrain − alt) above this. Use altTerrain for LOD and fades.
   */
  alt: number;
  /**
   * Eye height above the terrain/water surface under the camera (m), roofs ignored: |eye| − R −
   * planet.surfaceAt(focus). Smooth (no jumps when a tower passes underneath). Use THIS for LOD,
   * ground-cover and people fades. lbCamAlt mirrors it.
   */
  altTerrain: number;
  /** Height above sea level: |eye| − R. */
  altSea: number;
  /** Height of the terrain/water (or city ground) reference under the camera above sea level (smoothed), m. Roofs are not part of it. */
  ground: number;
  /** Lat/lon of `focus`, degrees. */
  lat: number;
  lon: number;
  /** Compass heading of the view, radians (0 = north, clockwise). */
  heading: number;
  /** Pitch of the view, radians (0 = level, −π/2 = straight down at the planet). */
  pitch: number;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Distance from the eye to the geometric sea-level horizon (m). */
  horizon: number;
  /** True when walking (FPV at eye height): WASD active. */
  street: boolean;
  /** Plan coordinates of `focus` in the city chart, and its distance from the city centre (m). */
  cityX: number;
  cityZ: number;
  cityDist: number;
}

/** A camera placement for setView (the shot tool and fly-to presets). Angles in DEGREES. */
export interface ViewSpec {
  lat: number;
  lon: number;
  /** Height above the surface under the camera (m), clamped to [EYE_HEIGHT, ALT_MAX]. */
  alt: number;
  /** Compass heading, degrees (0 = north, 90 = east). Default 0. */
  heading?: number;
  /**
   * Absolute pitch, degrees (0 = level, −90 = straight down). Omit for the altitude-driven pitch.
   * When given it holds until the user next zooms or drags, then blends back to the curve.
   */
  pitch?: number;
}

/**
 * Everything static about the world, built once at boot. READ-ONLY: the plan is shared by every
 * engine instance (the window mounts repeatedly), so never sort, splice or mutate its arrays — copy
 * first. In development it is deep-frozen, so a mutation throws.
 */
export interface WorldData {
  seed: number;
  planet: Planet;
  city: CityPlan;
  cityIndex: CityIndex;
}

/**
 * The reveal animator (BRIEF §1: the world animates in). The clock (`lbRevealClock` in shaders)
 * starts at the first frame; in shot mode it is 1e6 so everything is fully revealed.
 * A stage-2 system calls `slot(duration)` once its meshes exist and gets the clock time at which
 * its reveal should start; it staggers its instances from there (aReveal = base + i · stagger)
 * so systems cascade instead of all popping at once.
 */
export interface RevealAnimator {
  /** Seconds since the reveal clock started (mirrors lbRevealClock). */
  readonly clock: number;
  /** True in shot mode: everything is revealed, delays are irrelevant. */
  readonly instant: boolean;
  /** Reserve a reveal window of `duration` seconds; returns its start time on the clock. */
  slot(duration: number): number;
  /** CPU twin of lbSpring for things revealed on the CPU: 0→1 with a small overshoot. */
  spring(p: number): number;
  /** Progress 0..1 of a reveal that starts at clock time `start` and lasts `duration`. */
  progress(start: number, duration: number): number;
}

export interface BootEntry {
  stage: string;
  /** Duration of the stage (ms). */
  ms: number;
  /** Time since createEngine() was called (ms) when the stage ended. */
  at: number;
  /** Stage-2 inits: ms spent waiting on the driver for the system's shader compiles (C2). */
  wait?: number;
}

export interface BootLog {
  /** End the current stage with this name. */
  mark(stage: string): void;
  readonly entries: BootEntry[];
}

/** The key light etc. The v0 sky fills it; A3 owns it. */
export interface SkyService {
  /** The sun: a DirectionalLight whose shadow camera the sky fits to the view each frame. */
  sun: DirectionalLight | null;
  /** The scene fog (always present so programs never recompile); the sky tunes it by altitude. */
  fog: Fog | null;
  /**
   * 0..1: how far the camera is inside a cloud (the clouds system's white-out veil, drawn last as a
   * full-screen overlay). Post (B4) may fade ink and tilt-shift by it. Absent / 0 outside clouds.
   */
  veil?: number;
  /**
   * 0..1: how much a real (3D) cloud stands above the eye's visible horizon, written by the clouds
   * system each frame. The sky fades its painted far cumulus out by it, so the two never share a
   * frame. Absent / 0 when no cloud is in view.
   */
  cloudsInView?: number;
  /**
   * 0..1: how far the clouds system has closed the scene fog into the cloud mist (≥ veil: it starts
   * a few metres before the eye enters a puff and lingers just after). The sky sinks into the same
   * mist by it, so fogged buildings never stand as cut-outs against a clear sky.
   */
  mist?: number;
}

/** The camera controller (camera/ owns it). */
export interface CameraService {
  /**
   * Place the camera exactly; snaps every spring and clears inertia (deterministic shots).
   * opts.glide (s): for scripted sequences (the dive) — the time since the previous setView; the
   * ground/roof reference then springs over that time instead of snapping, so crossing a building
   * does not jolt the camera.
   */
  setView(v: ViewSpec, opts?: { glide?: number }): void;
  /** Current placement (pitch included). */
  getView(): Required<ViewSpec>;
  /** Fly to a surface direction (and optionally an altitude) along a smooth arc. */
  flyTo(dir: Vec3, alt?: number): void;
  /** Release pointer lock if held. */
  releaseLock(): void;
  /** performance.now() of the last user input on the canvas (the hint row fades on it). */
  lastInputAt(): number;
  /**
   * The touch UI's live state (A4), read by the canvas overlay every frame while visible: the
   * left-thumb virtual stick (`visible` only on touch, only at street level; `ox`, `oy` where the
   * thumb went down, CSS px; `x`, `y` its deflection in the unit disc) and whether touch input has
   * been seen. Optional: core's default service has none.
   */
  stick?(): { visible: boolean; active: boolean; x: number; y: number; ox: number; oy: number; touch: boolean };
}

/**
 * The runtime channel between traffic (B1) and people (B2) at zebra crossings. Both arrays are
 * indexed by walk-edge id (CityPlan.walkEdges) and allocated by core; only 'crossing' edges are
 * used. Both are written in fixedUpdate; traffic is registered before people in systems.ts.
 *   - busy: people write it, traffic reads it. 1 while a pedestrian is on the crossing (or has
 *     committed to stepping onto it).
 *   - blocked: traffic writes it, people read it. 1 while a car is between its lane's stopS and
 *     laneS + 3 m on any lane the crossing crosses (WalkEdge.lanes / laneS), i.e. it is not going
 *     to stop. People wait at the kerb while blocked; cars stop at Lane.stopS while busy.
 * Writers clear their array each step before setting it.
 */
export interface CrossingState {
  busy: Uint8Array;
  blocked: Uint8Array;
}

/**
 * Service slots: core installs defaults, the owning system replaces its slot in init().
 * Call through ctx.services.x at use time (never cache the function across frames).
 */
export interface Services {
  /** Draw the frame. Default: renderer.render(scene, camera). B4 installs the post chain. */
  render(ctx: LBContext): void;
  sky: SkyService;
  camera: CameraService;
  /** Zebra-crossing state shared by traffic and people (core allocates it; see CrossingState). */
  crossings: CrossingState;
  /**
   * Nature's collision discs outside the city plan (A1): tree trunks and big boulders of the
   * terrain scatter (city trees are CityIndex obstacles already). Optional: installed once the
   * nature system has initialised; call through ctx.services.nature?.collide(...).
   */
  nature?: NatureService;
  /**
   * The pedestrians' bodies (B2), for the FPV player's soft collision (A4 calls it after the walls).
   * Optional: install it once the people system has initialised; call through
   * ctx.services.people?.pushOut(...).
   */
  people?: PeopleService;
  /**
   * The vehicles' bodies (B1), for the FPV player's collision (A4 calls it after the walls).
   * Optional: installed once the traffic system has initialised; call through
   * ctx.services.traffic?.collide(...).
   */
  traffic?: TrafficService;
}

/** The fleet as solid bodies the player cannot walk into (B1). Zero-alloc. */
export interface TrafficService {
  /**
   * Push a body of radius r (m) standing at plan (x, z) out of every drawn vehicle's body box it
   * overlaps (sliding along it). Writes the resolved plan position into out; returns true if it
   * moved. (Vehicles also stop short of a player standing in their lane: traffic reads ctx.view.)
   */
  collide(x: number, z: number, r: number, out: { x: number; z: number }): boolean;
}

/** The pedestrians as bodies the player bumps into (B2). Zero-alloc. */
export interface PeopleService {
  /**
   * Push a body of radius r (m) standing at plan (x, z) out of every shown walker's / idler's disc
   * it overlaps (their body radius added to r), sliding round them. Writes the resolved plan
   * position into out; returns true if it moved.
   */
  pushOut(x: number, z: number, r: number, out: { x: number; z: number }): boolean;
}

/** Collision against the countryside's trunks and boulders (A1, nature/collide.ts). Zero-alloc. */
export interface NatureService {
  /**
   * Push a body of radius r (m) standing at unit surface direction `dir` out of every trunk /
   * boulder disc it overlaps (sliding along them). Writes the resolved unit direction into out
   * (out may be dir); returns true if it moved.
   */
  collide(dir: Vec3, r: number, out: Vec3): boolean;
}

export interface LBDebug {
  /** When true, the camera system ignores user input (the debug hook owns the view). */
  cameraLocked: boolean;
}

export interface LBContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  time: LBTime;
  view: ViewState;
  world: WorldData;
  quality: Quality;
  q: QualitySettings;
  variant: Variant;
  reducedMotion: boolean;
  /** ?shot=1: deterministic mode (frozen time, instant reveal, no hint row). */
  shotMode: boolean;
  uniforms: SharedUniforms;
  /** The shared toon material factory (render/toon.ts). Use it for every lit surface. */
  toon: ToonKit;
  reveal: RevealAnimator;
  boot: BootLog;
  params: ParamRegistry;
  perf: Perf;
  services: Services;
  debug: LBDebug;
  /**
   * Register a GPU resource (geometry, texture, render target, material) to be disposed with the
   * engine. Returns its argument. Systems may still dispose their own in dispose().
   */
  track<T extends { dispose(): void }>(resource: T): T;
  /**
   * Time-slicing for init(): resolves at once while the current slice has budget left, otherwise
   * after the browser has painted a frame. `await ctx.yield()` between chunks of heavy work.
   * The budget follows the display (less per slice on 120 Hz). Once the engine is disposed the
   * promise never settles, so an abandoned init simply stops.
   */
  yield(): Promise<void>;
  /**
   * Compile every program the meshes you have added to the scene need — colour AND shadow depth
   * programs — without stalling a frame (KHR_parallel_shader_compile where available). While it
   * runs, the scene roots added since your init began are hidden, so the live loop never draws an
   * unlinked program. Call it once, after adding your meshes and before ctx.reveal.slot() (a cold
   * compile can take a few hundred ms, which must not eat into your reveal). If a stage-2 init
   * forgets, core compiles after init returns. Never settles once the engine is disposed.
   */
  compile(): Promise<void>;
  /**
   * Start compiling (colour + shadow depth) the programs of these meshes now, without adding them to
   * the scene: stand-ins that share the real materials (any small geometry; same mesh flags, e.g.
   * from ctx.toon.mesh). For System.prepare (C2): the driver compiles while the inits build.
   */
  prewarm(objects: Object3D[]): void;
}

export interface System {
  /** Unique, short, lowercase (perf and boot rows use it). */
  name: string;
  /**
   * 1 = part of the first frame (sky, terrain, ocean, camera). Keep it cheap.
   * 2 = built after the first frame, in systems.ts order, time-sliced, revealed with ctx.reveal.
   */
  stage: 1 | 2;
  /**
   * Build meshes, register params, replace your service slot. May await ctx.yield().
   * Stage-2 order: build meshes → add them to ctx.scene → `await ctx.compile()` →
   * `const start = ctx.reveal.slot(d)` → write aReveal / revealDelay from `start` → return.
   * Create every material here (a material first seen later compiles mid-flow: a hitch).
   * Sim state: init establishes entity state for the CURRENT ctx.time.t exactly as onTimeJump
   * would (stage-2 systems init after t has advanced, or with ?t=). Deterministic replay from
   * t = 0 at fixedDt is fine within ~300 ms; a closed-form schedule is better.
   */
  init(ctx: LBContext): void | Promise<void>;
  /**
   * Stage 1 only, optional (C2): called for every stage-1 system right after the sky's init (the
   * lights and fog every lit program depends on exist), before the other inits. Create the
   * materials here and hand stand-ins to ctx.prewarm(), so a cold visit's shader compiles overlap
   * the CPU-heavy inits instead of following them. init then uses those materials.
   */
  prepare?(ctx: LBContext): void;
  /**
   * Deterministic sim step of ctx.time.fixedDt (traffic, people, planes). Zero allocations.
   * Runs before the camera's update: ctx.view is the previous frame's.
   */
  fixedUpdate?(ctx: LBContext): void;
  /** Per-frame visual update, before render. Zero allocations. */
  update?(ctx: LBContext): void;
  /**
   * ctx.time.t was set directly (debug setTime / shots). Rebuild sim state for the new t,
   * deterministically (same t ⇒ same world), without spawning anything in view.
   */
  onTimeJump?(ctx: LBContext): void;
  /**
   * The canvas changed size (CSS px) or device pixel ratio. Called for initialised systems before
   * the engine redraws. Post (B4) resizes its render targets here.
   */
  resize?(ctx: LBContext, width: number, height: number, dpr: number): void;
  /**
   * Release every GPU resource and listener. The window mounts and unmounts repeatedly. Called for
   * every registered system, including one whose init has not finished (or never ran).
   */
  dispose?(ctx: LBContext): void;
}
