import {
  Application,
  Container,
  DisplacementFilter,
  Filter,
  GlProgram,
  Graphics,
  Particle,
  ParticleContainer,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from 'pixi.js';
import type { Cell, GameState } from './snake-types';
import {
  CRT_DEFAULTS,
  CRT_FRAGMENT_GLSL,
  CRT_REDUCED_MOTION,
  CRT_VERTEX_GLSL,
  type CrtUniforms,
} from './snake-shader-crt';

export type RendererHandle = {
  render(state: GameState, headTween: Cell, tailTween: Cell): void;
  triggerShockwave(at: Cell): void;
  flashGlitch(): void;
  setReducedMotion(on: boolean): void;
  dispose(): void;
};

export type RendererOpts = {
  gridCount: number;
  cellSize: number;
  reducedMotion: boolean;
  accentHex: number; // 0xRRGGBB
  panicHex: number;  // 0xRRGGBB
  bgHex: number;     // 0xRRGGBB
};

const SHOCK_MS = 400;

export async function mount(canvas: HTMLCanvasElement, opts: RendererOpts): Promise<RendererHandle> {
  const app = new Application();
  await app.init({
    canvas,
    width: opts.gridCount * opts.cellSize,
    height: opts.gridCount * opts.cellSize,
    backgroundColor: opts.bgHex,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });

  const stage = app.stage;
  const root = new Container();
  stage.addChild(root);

  const dispMapTexture = createRadialDisplacementTexture();
  const dotTex = createDotTexture();

  const crtUniforms: CrtUniforms = opts.reducedMotion ? { ...CRT_REDUCED_MOTION } : { ...CRT_DEFAULTS };
  const crtFilter = new Filter({
    glProgram: GlProgram.from({ vertex: CRT_VERTEX_GLSL, fragment: CRT_FRAGMENT_GLSL }),
    resources: {
      crtUniforms: {
        uTime: { value: crtUniforms.uTime, type: 'f32' },
        uAberration: { value: crtUniforms.uAberration, type: 'f32' },
        uGrain: { value: crtUniforms.uGrain, type: 'f32' },
        uScanlines: { value: crtUniforms.uScanlines, type: 'f32' },
        uVignette: { value: crtUniforms.uVignette, type: 'f32' },
        uBarrel: { value: crtUniforms.uBarrel, type: 'f32' },
      },
    },
  });
  root.filters = [crtFilter];

  const reducedMotionRef = { current: opts.reducedMotion };

  const dispSprite = new Sprite(dispMapTexture);
  dispSprite.anchor.set(0.5);
  dispSprite.scale.set(0); // hidden until shockwave fires
  root.addChild(dispSprite);
  const dispFilter = new DisplacementFilter({ sprite: dispSprite, scale: 0 });

  const particles = new ParticleContainer({
    dynamicProperties: { position: true, scale: true, alpha: true, color: true, rotation: false },
  });
  root.addChild(particles);

  type LiveParticle = {
    p: Particle;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
  };
  const liveParticles: LiveParticle[] = [];

  const body = new Graphics();
  root.addChild(body);

  const pelletText = new Text({
    text: '',
    style: new TextStyle({
      fontFamily: 'monospace',
      fontSize: opts.cellSize * 0.8,
      fill: opts.accentHex,
      align: 'center',
    }),
  });
  pelletText.anchor.set(0.5);
  root.addChild(pelletText);

  let timeAccum = 0;
  let shockwaveStart = -1;
  let glitchUntil = -1;

  app.ticker.add((tick) => {
    const now = performance.now();
    timeAccum += tick.deltaMS / 1000;
    crtFilter.resources.crtUniforms.uniforms.uTime = timeAccum;

    // Shockwave envelope
    if (shockwaveStart > 0) {
      const t = (now - shockwaveStart) / SHOCK_MS;
      if (t >= 1) {
        shockwaveStart = -1;
        dispFilter.scale.set(0, 0);
        dispSprite.scale.set(0);
        root.filters = [crtFilter];
      } else {
        const radius = 1 + 6 * t;
        const strength = 30 * (1 - t);
        dispSprite.scale.set(radius);
        dispFilter.scale.set(strength, strength);
      }
    }

    // Particles
    for (let i = liveParticles.length - 1; i >= 0; i--) {
      const lp = liveParticles[i];
      lp.life += tick.deltaMS;
      const t = lp.life / lp.maxLife;
      if (t >= 1) {
        particles.removeParticle(lp.p);
        liveParticles.splice(i, 1);
        continue;
      }
      lp.p.x += lp.vx * (tick.deltaMS / 16);
      lp.p.y += lp.vy * (tick.deltaMS / 16);
      lp.p.alpha = 1 - t;
      lp.p.scaleX = 1 - t * 0.5;
      lp.p.scaleY = 1 - t * 0.5;
    }

    // Glitch envelope (boost aberration + grain briefly)
    if (glitchUntil > 0) {
      const left = glitchUntil - now;
      if (left <= 0) {
        glitchUntil = -1;
        const u = reducedMotionRef.current ? CRT_REDUCED_MOTION : CRT_DEFAULTS;
        crtFilter.resources.crtUniforms.uniforms.uAberration = u.uAberration;
        crtFilter.resources.crtUniforms.uniforms.uGrain = u.uGrain;
      } else {
        crtFilter.resources.crtUniforms.uniforms.uAberration = 1.0;
        crtFilter.resources.crtUniforms.uniforms.uGrain = 0.18;
      }
    }
  });

  function render(state: GameState, headTween: Cell, tailTween: Cell) {
    drawBody(body, state, headTween, tailTween, opts);
    pelletText.text = state.pellet.glyph;
    pelletText.style.fill = state.pellet.kind === 'panic' ? opts.panicHex : opts.accentHex;
    // Auto-size: short symbols can be big; longer keywords need to fit.
    const len = state.pellet.glyph.length;
    const target = len <= 1 ? opts.cellSize * 0.95 : opts.cellSize * 1.6 / len;
    pelletText.style.fontSize = Math.max(8, Math.min(opts.cellSize * 0.95, target));
    pelletText.position.set(
      state.pellet.cell.x * opts.cellSize + opts.cellSize / 2,
      state.pellet.cell.y * opts.cellSize + opts.cellSize / 2,
    );
  }

  function triggerShockwave(at: Cell) {
    if (reducedMotionRef.current) return;
    dispSprite.position.set(at.x * opts.cellSize + opts.cellSize / 2, at.y * opts.cellSize + opts.cellSize / 2);
    shockwaveStart = performance.now();
    root.filters = [crtFilter, dispFilter];
    // Particle burst — 30 dots, random radial velocities.
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 3;
      const p = new Particle({
        texture: dotTex,
        x: at.x * opts.cellSize + opts.cellSize / 2,
        y: at.y * opts.cellSize + opts.cellSize / 2,
        scaleX: 1,
        scaleY: 1,
        tint: opts.accentHex,
        alpha: 1,
      });
      particles.addParticle(p);
      liveParticles.push({
        p,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 600 + Math.random() * 400,
      });
    }
  }

  function flashGlitch() {
    if (reducedMotionRef.current) return;
    glitchUntil = performance.now() + 300;
  }

  function setReducedMotion(on: boolean) {
    reducedMotionRef.current = on;
    const u = on ? CRT_REDUCED_MOTION : CRT_DEFAULTS;
    const r = crtFilter.resources.crtUniforms.uniforms;
    r.uAberration = u.uAberration;
    r.uGrain = u.uGrain;
    r.uScanlines = u.uScanlines;
    r.uVignette = u.uVignette;
    r.uBarrel = u.uBarrel;
  }

  function dispose() {
    app.destroy(true, { children: true });
  }

  return { render, triggerShockwave, flashGlitch, setReducedMotion, dispose };
}

function drawBody(
  g: Graphics,
  state: GameState,
  headTween: Cell,
  tailTween: Cell,
  opts: RendererOpts,
) {
  g.clear();
  if (state.snake.length === 0) return;
  const cs = opts.cellSize;
  const half = cs / 2;
  const points: Cell[] = [...state.snake];
  // Replace head and tail with their tween-interpolated positions so both ends move fluidly.
  points[0] = headTween;
  points[points.length - 1] = tailTween;

  // Walk tail → head, drawing through cell centers.
  g.moveTo(points[points.length - 1].x * cs + half, points[points.length - 1].y * cs + half);
  for (let i = points.length - 2; i >= 0; i--) {
    g.lineTo(points[i].x * cs + half, points[i].y * cs + half);
  }
  g.stroke({ width: cs - 2, color: opts.accentHex, alpha: 1, cap: 'round', join: 'round' });
}

function createRadialDisplacementTexture(): Texture {
  // 64x64 canvas with a radial gradient — DisplacementFilter samples a centered shock.
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgb(255, 255, 255)');
  grad.addColorStop(1, 'rgb(128, 128, 128)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return Texture.from(c);
}

function createDotTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 4;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 4, 4);
  return Texture.from(c);
}
