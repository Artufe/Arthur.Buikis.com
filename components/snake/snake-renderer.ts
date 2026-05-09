import {
  Application,
  Container,
  Filter,
  GlProgram,
  Graphics,
  Text,
  TextStyle,
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
  render(state: GameState, headTween: Cell): void;
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

  const body = new Graphics();
  root.addChild(body);

  const pelletText = new Text({
    text: '',
    style: new TextStyle({
      fontFamily: 'monospace',
      fontSize: opts.cellSize * 0.7,
      fill: opts.accentHex,
      align: 'center',
    }),
  });
  pelletText.anchor.set(0.5);
  root.addChild(pelletText);

  const scoreText = new Text({
    text: 'score 0',
    style: new TextStyle({ fontFamily: 'monospace', fontSize: 11, fill: opts.accentHex }),
  });
  scoreText.position.set(8, 6);
  root.addChild(scoreText);

  const bestText = new Text({
    text: 'best 0',
    style: new TextStyle({ fontFamily: 'monospace', fontSize: 11, fill: 0x888888 }),
  });
  bestText.anchor.set(1, 0);
  bestText.position.set(opts.gridCount * opts.cellSize - 8, 6);
  root.addChild(bestText);

  let timeAccum = 0;
  app.ticker.add((tick) => {
    timeAccum += tick.deltaMS / 1000;
    crtFilter.resources.crtUniforms.uniforms.uTime = timeAccum;
  });

  function render(state: GameState, headTween: Cell) {
    drawBody(body, state, headTween, opts);
    pelletText.text = state.pellet.glyph;
    pelletText.style.fill = state.pellet.kind === 'panic' ? opts.panicHex : opts.accentHex;
    pelletText.position.set(
      state.pellet.cell.x * opts.cellSize + opts.cellSize / 2,
      state.pellet.cell.y * opts.cellSize + opts.cellSize / 2,
    );
    scoreText.text = `score ${state.score}`;
    bestText.text = `best ${state.best}`;
  }

  function triggerShockwave(_at: Cell) {
    // Filled in Task 10. Kept as a no-op here so callers compile.
  }

  function flashGlitch() {
    // Filled in Task 10.
  }

  function setReducedMotion(on: boolean) {
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

function drawBody(g: Graphics, state: GameState, headTween: Cell, opts: RendererOpts) {
  g.clear();
  if (state.snake.length === 0) return;
  const cs = opts.cellSize;
  const half = cs / 2;
  const points: Cell[] = [...state.snake];
  // Replace head index 0 with the tween-interpolated head position so motion looks fluid.
  points[0] = headTween;

  // Walk tail → head, drawing through cell centers.
  g.moveTo(points[points.length - 1].x * cs + half, points[points.length - 1].y * cs + half);
  for (let i = points.length - 2; i >= 0; i--) {
    g.lineTo(points[i].x * cs + half, points[i].y * cs + half);
  }
  g.stroke({ width: cs - 2, color: opts.accentHex, alpha: 1, cap: 'round', join: 'round' });
}
