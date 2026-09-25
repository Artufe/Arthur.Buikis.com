import { ACESFilmicToneMapping, PCFShadowMap, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer } from 'three';
import { bodyPoints } from '../engine/engine';
import { angleDiff, lerp } from '../engine/math';
import { arcAt } from '../engine/path';
import type { EngineEvent, GameState, Vec2 } from '../engine/types';
import { CameraRig } from './camera-rig';
import { Effects } from './effects';
import { createEnvironment } from './environment';
import { FoodView } from './food';
import { clonePalette, mixPalette, PALETTES, type Palette, type Theme } from './palettes';
import { ParticlePool } from './particles';
import { PostPipeline, type Quality } from './post';
import { SnakeMesh } from './snake-mesh';
import { createTerrain } from './terrain';
import { groundHeight } from './terrain-shape';
import { TrailMap } from './trail-map';

export type { Quality } from './post';
export type { Theme } from './palettes';

export type RenderInput = { prev: GameState; cur: GameState; alpha: number; dt: number; draw?: boolean };

export type RendererHandle = {
  frame(input: RenderInput): void;
  handleEvents(events: EngineEvent[], state: GameState): void;
  reset(state: GameState): void;
  screenToGround(clientX: number, clientY: number): Vec2 | null;
  setTheme(theme: Theme, instant?: boolean): void;
  setReducedMotion(on: boolean): void;
  resize(width: number, height: number): void;
  dispose(): void;
};

export type MountOptions = { theme: Theme; reducedMotion: boolean; quality?: Quality };

export function detectQuality(): Quality {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  return coarse || cores <= 4 ? 'low' : 'high';
}

const FADE_SECONDS = 0.6;
const SLOW_FRAME = 0.022;
const SINK_SECONDS = 0.8;

export function mount(canvas: HTMLCanvasElement, opts: MountOptions): RendererHandle {
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let quality: Quality = opts.quality ?? detectQuality();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const trail = new TrailMap(quality === 'high' ? 1024 : 512);
  const terrain = createTerrain({
    segments: quality === 'high' ? 400 : 240,
    trailTexture: trail.texture,
    trailTexel: trail.texel,
  });
  scene.add(terrain.mesh);
  const env = createEnvironment(scene, { shadowSize: quality === 'high' ? 2048 : 1024 });
  const snake = new SnakeMesh();
  scene.add(snake.group);
  const food = new FoodView();
  scene.add(food.group);
  const sand = new ParticlePool(quality === 'high' ? 2500 : 1200);
  const sparks = new ParticlePool(400, true);
  scene.add(sand.points, sparks.points);
  const effects = new Effects(sand, sparks);
  effects.setBudget(quality === 'high' ? 1 : 0.5);
  scene.add(effects.flash);
  const rig = new CameraRig();
  const post = new PostPipeline(renderer, scene, rig.camera, quality);

  let theme = opts.theme;
  const palette = clonePalette(PALETTES[theme]);
  let fadeFrom: Palette | null = null;
  let fadeT = 1;
  let reduced = opts.reducedMotion;
  let clock = 0;
  let trailClock = 0;
  let deathAt: number | null = null;
  let slowAvg = 1 / 60;
  let slowFor = 0;
  const points: Vec2[] = [];
  const sparklePos = new Vector3();

  function applyPalette() {
    env.setPalette(palette);
    terrain.setPalette(palette);
    post.setBloom(palette.bloom);
    renderer.toneMappingExposure = palette.exposure;
    food.setGlow(palette.foodGlow);
    effects.setDust(palette.dust);
    snake.setRim(palette.snakeRim);
    rig.setSunAzimuth(Math.atan2(palette.sunDir.z, palette.sunDir.x));
  }

  function setReducedMotion(on: boolean) {
    reduced = on;
    rig.setReducedMotion(on);
    food.setReducedMotion(on);
    effects.setReducedMotion(on);
  }

  function resize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    renderer.setSize(width, height, false);
    rig.setAspect(width / height);
    post.setSize(width, height);
    const px = height * renderer.getPixelRatio();
    sand.setScale(px, rig.camera.fov);
    sparks.setScale(px, rig.camera.fov);
  }

  function degrade() {
    quality = 'low';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    post.setQuality('low');
    env.setShadowSize(1024);
    effects.setBudget(0.5);
    const size = renderer.getSize(new Vector2());
    resize(size.x, size.y);
  }

  applyPalette();
  setReducedMotion(reduced);

  return {
    frame({ prev, cur, alpha, dt, draw = true }) {
      clock += dt;
      if (cur.status !== 'paused') trailClock += dt;

      const jump = (prev.head.x - cur.head.x) ** 2 + (prev.head.z - cur.head.z) ** 2 > 1;
      const t = jump ? 1 : alpha;
      const head = { x: lerp(prev.head.x, cur.head.x, t), z: lerp(prev.head.z, cur.head.z, t) };
      const heading = jump ? cur.heading : prev.heading + angleDiff(prev.heading, cur.heading) * t;

      if (cur.status === 'playing') trail.push(head.x, head.z, trailClock);

      points.length = 0;
      points.push(head);
      for (let i = 0; i < cur.path.length; i++) {
        if (arcAt(cur.carry, i) > cur.bodyLength) break;
        points.push(cur.path[i]);
      }
      if (cur.status === 'idle') {
        // At rest the snake lies in a fresh groove of its own body, tail to head.
        trail.clear();
        for (let i = points.length - 1; i >= 0; i--) trail.push(points[i].x, points[i].z, trailClock);
      }
      const s = deathAt === null ? 0 : Math.min(1, (clock - deathAt) / SINK_SECONDS);
      snake.update(points, heading, dt, cur.speed, s * s * (3 - 2 * s), cur.status === 'playing');
      food.sync(cur.food, cur.time, clock);
      for (const f of cur.food) {
        if (f.kind === 'golden' && cur.status !== 'gameover') {
          sparklePos.set(f.pos.x, groundHeight(f.pos.x, f.pos.z) + 0.55, f.pos.z);
          effects.sparkle(sparklePos, dt);
        }
      }
      if (cur.status === 'playing') effects.spray(head, heading, cur.speed, dt);
      effects.wisps(dt, rig.focus());
      effects.update(dt);
      const nearest = cur.food.find((f) => f.kind === 'golden') ?? cur.food[0];
      rig.update(dt, head, heading, cur.status, nearest ? nearest.pos : null);

      if (fadeFrom && fadeT < 1) {
        fadeT = Math.min(1, fadeT + dt / FADE_SECONDS);
        mixPalette(fadeFrom, PALETTES[theme], fadeT * fadeT * (3 - 2 * fadeT), palette);
        applyPalette();
        if (fadeT >= 1) fadeFrom = null;
      }
      env.update(clock, rig.camera.position);
      terrain.setTime(clock);

      if (quality === 'high' && dt > 0) {
        slowAvg = slowAvg * 0.95 + dt * 0.05;
        slowFor = slowAvg > SLOW_FRAME ? slowFor + dt : 0;
        if (slowFor > 2) degrade();
      }

      if (!draw) return;
      trail.render(renderer, trailClock);
      post.render();
    },

    handleEvents(events, state) {
      for (const e of events) {
        if (e.type === 'eat' || e.type === 'expire') {
          const p = new Vector3(e.food.pos.x, groundHeight(e.food.pos.x, e.food.pos.z) + 0.55, e.food.pos.z);
          if (e.type === 'eat') {
            effects.eatBurst(p, e.food.kind);
            rig.shake(e.food.kind === 'golden' ? 0.35 : 0.15);
          } else {
            effects.puff(p);
          }
        } else if (e.type === 'death') {
          deathAt = clock;
          effects.impact(new Vector3(state.head.x, 0, state.head.z));
          effects.deathDust(bodyPoints(state));
          rig.shake(0.8);
        }
      }
    },

    reset() {
      trail.clear();
      effects.clear();
      food.clear();
      deathAt = null;
    },

    screenToGround(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      return rig.screenToGround(x, y);
    },

    setTheme(next, instant = false) {
      if (next === theme && !fadeFrom) return;
      theme = next;
      if (instant || reduced) {
        mixPalette(PALETTES[next], PALETTES[next], 0, palette);
        applyPalette();
        fadeFrom = null;
        fadeT = 1;
      } else {
        fadeFrom = clonePalette(palette);
        fadeT = 0;
      }
    },

    setReducedMotion,
    resize,

    dispose() {
      trail.dispose();
      terrain.dispose();
      env.dispose();
      snake.dispose();
      food.dispose();
      sand.dispose();
      sparks.dispose();
      post.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
