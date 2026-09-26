// GOLDENLINE shared contracts. Orchestrator-owned: every system codes against these
// interfaces, so they only ever grow additively. See docs/goldenline/TASKS.md.
//
// Units are metres and seconds. Y is up. The ocean lies to -X, the beach rises toward +X,
// and the shoreline runs roughly along Z. The sun sets over the ocean (-X). See world/layout.ts.

import type {
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import type { Input } from './input';
import type { ParamRegistry } from './params';
import type { Perf } from './perf';

/** A TSL node. The three typings for TSL are too narrow to be useful across module boundaries. */
export type TSLNode = any;

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type Variant = 'window' | 'page';

export interface GLTime {
  /** Simulation seconds since boot. Everything animated reads this, never performance.now(). */
  t: number;
  /** Seconds since the previous frame, clamped to 1/20. 0 while frozen. */
  dt: number;
  frame: number;
  /** When true (screenshots), the loop only advances through the debug hook's step(). */
  frozen: boolean;
}

export interface GLDebug {
  /** When true, the player system must not move the camera (the debug hook owns it). */
  cameraLocked: boolean;
}

export interface GLContext {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  params: ParamRegistry;
  perf: Perf;
  input: Input;
  time: GLTime;
  debug: GLDebug;
  quality: Quality;
  variant: Variant;
  reducedMotion: boolean;
  /** Service slots. Core installs stubs; the owning system replaces its slot in init(). */
  services: Services;
}

export interface GLSystem {
  name: string;
  /** Build meshes and materials and register params. Replace your service slot here. */
  init(ctx: GLContext): Promise<void> | void;
  /**
   * Called during loading, before the pipeline warm-up. Make sure every material, particle
   * system and compute pipeline you will EVER use is reachable from ctx.scene (or compiled
   * explicitly) and run several frames of any compute pass. Nothing may compile on first use.
   */
  warmup?(ctx: GLContext): Promise<void> | void;
  /** Per-frame update. Zero allocations. Systems run in the order in systems.ts. */
  update?(ctx: GLContext): void;
  /** Called when the quality preset changes. */
  setQuality?(ctx: GLContext, q: Quality): void;
  /** Release every GPU resource. The site mounts and unmounts the game repeatedly. */
  dispose?(ctx: GLContext): void;
}

export interface Services {
  terrain: TerrainService;
  atmosphere: AtmosphereService;
  ocean: OceanService;
  state: SurfaceStateService;
  player: PlayerService;
  pier: PierService;
  post: PostService;
}

// ── Terrain (world/terrain-shape.ts; seabed.ts is ocean-owned, land.ts beach-owned) ──

export interface TerrainService {
  /** Analytic base height (metres; sea level is 0) of land and seabed. CPU, zero-alloc. */
  height(x: number, z: number): number;
  /**
   * The base heightfield baked at boot: an R32F texture covering `bounds`, with texel
   * `texel` metres. Fine detail (ripples, grain, reef texture) is added on the GPU by the owner.
   */
  heightTexture: Texture;
  /** minX, minZ, maxX, maxZ. */
  bounds: [number, number, number, number];
  texel: number;
}

// ── Atmosphere (atmosphere/) ──

export interface AtmosphereService {
  /** Unit vector toward the sun. */
  sunDir: Vector3;
  /** Linear-light sun colour (already includes atmospheric reddening). */
  sunColor: Color;
  sunLight: DirectionalLight;
  /** TSL uniforms mirroring the above, for custom materials. */
  sunDirNode: TSLNode;
  sunColorNode: TSLNode;
  /**
   * Apply aerial perspective and haze to a lit colour. TSL: (color: vec3, worldPos: vec3) => vec3.
   * Every custom material that sets its own outputNode must call this; stock node materials
   * get it through scene.fogNode.
   */
  applyFog(color: TSLNode, worldPos: TSLNode): TSLNode;
  /** Sky radiance along a world direction, for reflections. TSL: (dir: vec3) => vec3. */
  skyRadiance(dir: TSLNode): TSLNode;
  /** Prefiltered environment for image-based lighting, or null until built. */
  envTexture: Texture | null;
}

// ── Ocean (ocean/, extended by ocean/breaking/) ──

export interface OceanSample {
  /** Water surface height (m) at this XZ, including swell, chop and breaking waves. */
  height: number;
  /** Surface normal. */
  nx: number;
  ny: number;
  nz: number;
  /** Water particle velocity at the surface (m/s). The board rides on this. */
  vx: number;
  vy: number;
  vz: number;
  /** 0 = calm, 1 = inside active whitewater or a breaking lip. */
  breaking: number;
  /** Water depth to the seabed at this XZ (m). */
  depth: number;
}

export interface WaveInfo {
  /** 0 = no breaking wave nearby. Otherwise how developed the local breaker is (0-1). */
  stage: number;
  /** Unit direction the wave is travelling (shoreward, XZ). */
  dirX: number;
  dirZ: number;
  /** Unit direction the break is peeling along the crest (XZ), and its speed (m/s). */
  peelX: number;
  peelZ: number;
  peelSpeed: number;
  /** Signed distance from the point to the crest along dir (m); negative = in front of the face. */
  crestDistance: number;
  /** Local face height (m). */
  faceHeight: number;
  /** 0-1: how hollow the lip is here (1 = throwing / tube-able). */
  hollowness: number;
}

export interface OceanService {
  /** CPU sample at the current ctx.time.t. Zero-alloc: writes into and returns `out`. */
  sample(x: number, z: number, out: OceanSample): OceanSample;
  /** CPU description of the nearest breaking wave (surfing uses this). Zero-alloc. */
  wave(x: number, z: number, out: WaveInfo): WaveInfo;
  /** Dominant swell direction (unit, XZ, shoreward). */
  swellDir: Vector2;
  /**
   * GPU-side outputs for the water material. The ocean owner documents the exact shape in
   * components/goldenline/ocean/README.md (cascade textures, length scales, foam/jacobian).
   */
  gpu: Record<string, unknown>;
}

// ── Surface state (state/) ──

export const SPLAT_FOAM = 0; // add foam coverage (fresh)
export const SPLAT_WAKE = 1; // disturb water (wake height/velocity along dir)
export const SPLAT_WET = 2; // wet the sand
export const SPLAT_FOOTPRINT = 3; // press a footprint into sand (dir = foot heading)
export const SPLAT_SMOOTH = 4; // swash smoothing: erase depressions, fill rims
export type SplatKind = 0 | 1 | 2 | 3 | 4;

export interface SurfaceStateService {
  /**
   * Queue a brush splat. Zero-alloc (writes into a preallocated array); flushed on the GPU once
   * per frame. `dirX/dirZ` orient directional brushes (footprints, wakes).
   */
  splat(kind: SplatKind, x: number, z: number, radius: number, strength: number, dirX?: number, dirZ?: number): void;
  /** TSL: (worldXZ: vec2) => vec2 (foam coverage 0-1, foam age 0-1). */
  foam(worldXZ: TSLNode): TSLNode;
  /** TSL: (worldXZ: vec2) => vec4 (wake height, wake velocity x, wake velocity z, disturbance). */
  wake(worldXZ: TSLNode): TSLNode;
  /** TSL: (worldXZ: vec2) => vec4 (wetness 0-1, depression m, displaced mass m, freshly-smoothed 0-1). */
  sand(worldXZ: TSLNode): TSLNode;
  /** World-space centre (XZ) and edge length (m) of the scrolling window. */
  center: Vector2;
  size: number;
}

// ── Player (player/, extended by surf/) ──

export type PlayerMode = 'walk' | 'wade' | 'paddle' | 'catch' | 'popup' | 'ride' | 'wipeout';

export interface PlayerService {
  mode: PlayerMode;
  /** Eye position. */
  eye: Vector3;
  /** Body velocity (m/s). */
  velocity: Vector3;
  yaw: number;
  pitch: number;
  /** The board's world transform source (the surf system drives it while riding). */
  boardPosition: Vector3;
  boardYaw: number;
  /** Put the player somewhere, e.g. from a debug shot. */
  teleport(x: number, z: number, yaw: number, mode?: PlayerMode): void;
}

// ── Pier (pier/) ──

export interface PierService {
  /**
   * Walkable surface height (deck, steps/ramp from the sand) under (x, z) for a body whose
   * feet are near height y, or NaN if there is none (so walking UNDER the deck still works).
   */
  surfaceAt(x: number, z: number, y: number): number;
  /** Push (x, z) back inside the railings when on the deck. Writes into out[0], out[1]. */
  clampToDeck(x: number, z: number, y: number, out: Float32Array | number[]): void;
  /** Piling centres (x, z pairs) for wave interaction and collision. */
  pilings: Float32Array;
  pilingRadius: number;
}

// ── Post (post/) ──

export interface PostService {
  /** Render the frame (scene + post chain). Core calls this once per frame after all updates. */
  render(ctx: GLContext): void;
  /** Rebuild the chain after toggles or quality changes. */
  rebuild(ctx: GLContext): void;
}
