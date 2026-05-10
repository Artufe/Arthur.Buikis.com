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
  render(state: GameState, headTween: Cell, tailTween: Cell, now: number): void;
  triggerShockwave(at: Cell): void;
  flashGlitch(): void;
  triggerShake(intensity: number, durationMs: number): void;
  triggerDeathCascade(snake: Cell[]): void;
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
    // autoDensity + DPR scaling was producing fractional CSS pixels (e.g. 616.364px from
    // Windows 167% scaling) that bled faint sub-pixel lines at the rendered scene's edges.
    // Force 1:1 integer pixels — slightly less crisp on retina but no corner artifacts.
    autoDensity: false,
    resolution: 1,
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
  // CRT filter constructed but NOT applied to root — the shader was producing a faint edge
  // artifact tracking the snake near canvas corners. Game looks clean without it; can be
  // re-enabled once we have a leaner CRT pass that doesn't sample outside texture bounds.
  // root.filters = [crtFilter];

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
  // Screen shake — jitters root x/y for `shakeUntil - now` ms with falling intensity.
  let shakeUntil = -1;
  let shakeStart = -1;
  let shakePeak = 0;

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
        root.filters = null;
      } else {
        const radius = 1 + 6 * t;
        const strength = 30 * (1 - t);
        dispSprite.scale.set(radius);
        dispFilter.scale.set(strength, strength);
      }
    }

    // Particles — gravity pulls them down so the death cascade reads as falling debris.
    for (let i = liveParticles.length - 1; i >= 0; i--) {
      const lp = liveParticles[i];
      lp.life += tick.deltaMS;
      const t = lp.life / lp.maxLife;
      if (t >= 1) {
        particles.removeParticle(lp.p);
        liveParticles.splice(i, 1);
        continue;
      }
      lp.vy += 0.15 * (tick.deltaMS / 16); // gravity
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

    // Screen shake — physical "this moment matters" feedback. Linear decay from peak to zero.
    if (shakeUntil > 0) {
      const total = shakeUntil - shakeStart;
      const elapsed = now - shakeStart;
      if (elapsed >= total) {
        shakeUntil = -1;
        root.position.set(0, 0);
      } else {
        const t = elapsed / total;
        const mag = shakePeak * (1 - t);
        root.position.set((Math.random() - 0.5) * mag * 2, (Math.random() - 0.5) * mag * 2);
      }
    }
  });

  function render(state: GameState, headTween: Cell, tailTween: Cell, now: number) {
    drawBody(body, state, headTween, tailTween, opts);
    pelletText.text = state.pellet.glyph;

    // Telegraph: panic pellets pulse + dim during the pre-arm window so the player
    // sees the threat before it can kill them. Live panic is solid red, plain pellets
    // and active boosts use the accent color.
    let fill = opts.accentHex;
    let alpha = 1;
    if (state.pellet.kind === 'panic') {
      const armed = now >= state.pellet.armedAt;
      fill = opts.panicHex;
      if (!armed) {
        // Sine pulse over the telegraph window — alpha 0.4 → 1 → 0.4.
        const left = state.pellet.armedAt - now;
        const phase = (left / 200) * Math.PI; // ~5 pulses across 1.2s
        alpha = 0.6 + 0.4 * Math.sin(phase);
      }
    }
    pelletText.style.fill = fill;
    pelletText.alpha = alpha;

    // Tiered sizing — keep food large enough to read at a glance. Multichar keywords
    // intentionally spill into adjacent cells; the body's stroke draws over them harmlessly
    // when the snake passes by.
    const len = state.pellet.glyph.length;
    let fontSize: number;
    if (len <= 2) fontSize = opts.cellSize * 1.05; // single-char symbols fill the cell
    else if (len === 3) fontSize = opts.cellSize * 0.85;
    else if (len === 4) fontSize = opts.cellSize * 0.75;
    else fontSize = opts.cellSize * 0.65; // 5-6 chars (async, claude, panic!, await)
    pelletText.style.fontSize = fontSize;
    pelletText.position.set(
      state.pellet.cell.x * opts.cellSize + opts.cellSize / 2,
      state.pellet.cell.y * opts.cellSize + opts.cellSize / 2,
    );
  }

  function triggerShockwave(at: Cell) {
    if (reducedMotionRef.current) return;
    dispSprite.position.set(at.x * opts.cellSize + opts.cellSize / 2, at.y * opts.cellSize + opts.cellSize / 2);
    shockwaveStart = performance.now();
    root.filters = [dispFilter];
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

  function triggerShake(intensity: number, durationMs: number) {
    if (reducedMotionRef.current) return;
    shakeStart = performance.now();
    shakeUntil = shakeStart + durationMs;
    shakePeak = intensity;
  }

  // Death cascade — explode each body segment into particles falling and fading.
  // Closes the "abrupt freeze" gap and gives weight to the loss.
  function triggerDeathCascade(snake: Cell[]) {
    if (reducedMotionRef.current) return;
    body.clear(); // hide the snake body; particles take over
    const cs = opts.cellSize;
    for (let i = 0; i < snake.length; i++) {
      const c = snake[i];
      // 4 particles per segment with random outward velocities + gravity.
      for (let j = 0; j < 4; j++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * 2.5;
        const p = new Particle({
          texture: dotTex,
          x: c.x * cs + cs / 2,
          y: c.y * cs + cs / 2,
          scaleX: cs / 6,
          scaleY: cs / 6,
          tint: opts.accentHex,
          alpha: 1,
        });
        particles.addParticle(p);
        liveParticles.push({
          p,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1, // initial upward kick
          life: 0,
          maxLife: 800 + Math.random() * 400,
        });
      }
    }
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

  return {
    render,
    triggerShockwave,
    flashGlitch,
    triggerShake,
    triggerDeathCascade,
    setReducedMotion,
    dispose,
  };
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

  // Path: tailTween (between previous tail and current tail) → walk through every snake
  // cell from current tail toward the head → headTween (between current second-cell and head).
  // Replacing snake[length-1] outright would drop the new tail cell from the geometry and
  // the line would visibly cut across the corner during the tween.
  g.moveTo(tailTween.x * cs + half, tailTween.y * cs + half);
  for (let i = state.snake.length - 1; i >= 1; i--) {
    const c = state.snake[i];
    g.lineTo(c.x * cs + half, c.y * cs + half);
  }
  g.lineTo(headTween.x * cs + half, headTween.y * cs + half);
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
