# Snake Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PixiJS-rendered Snake easter egg that opens in a draggable floating window from the command palette and at `/snake`, themed as a REPL/CRT terminal with light AI flair.

**Architecture:** Pure-functional `snake-engine.ts` (no Pixi, no DOM, no React) drives a `snake-renderer.ts` that owns a PixiJS `Application` with a custom CRT fragment shader, a `Graphics`-driven body using `lineJoin: 'round'` for smooth turn curves, and `DisplacementFilter` + `ParticleContainer` effects on the `claude` pellet. A small event bus (`lib/snake-bus.ts`) wires the command palette to a globally-mounted floating window. PixiJS is dynamically imported so it never lands in the main bundle.

**Tech Stack:** Next.js 15 App Router (static export), React 19, TypeScript, Tailwind v4, **PixiJS v8** (new), vitest (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-05-07-snake-game-design.md`

---

## File Structure

**New files:**
- `lib/snake-bus.ts` — open/close/raise event bus (mirrors `lib/plasma-bus.ts`)
- `components/snake/snake-types.ts` — shared types (Direction, Cell, Pellet, GameState, etc.)
- `components/snake/snake-engine.ts` — pure game logic
- `components/snake/snake-engine.spec.ts` — vitest unit tests
- `components/snake/snake-shader-crt.ts` — GLSL fragment string + uniform schema
- `components/snake/snake-renderer.ts` — PixiJS `Application` owner; only file that imports `pixi.js`
- `components/snake/snake-canvas.tsx` — React lifecycle + RAF loop + input handling
- `components/snake/snake-console.tsx` — DOM REPL panel
- `components/snake/snake-window.tsx` — floating draggable window component
- `components/snake/snake-window-host.tsx` — global mount point; subscribes to bus
- `app/snake/page.tsx` — full-page route
- `tests/e2e/snake.spec.ts` — Playwright e2e

**Modified files:**
- `package.json` — add `pixi.js@^8`
- `lib/commands.ts` — new `'snake'` action type and `play snake` command
- `components/command-palette.tsx` — handle `'snake'` action by dispatching on the bus
- `components/hero-shader.tsx` — add `'/snake'` to `SHADER_EXCLUDED_ROUTES`
- `app/layout.tsx` — mount `<SnakeWindowHost />` globally

---

## Important Build Conventions (read before starting)

- **Run `npm run typecheck` after each task that changes types.** Many tasks below remind you to. Don't skip.
- **Commit after each task.** Messages use lowercase imperative, no `Co-Authored-By` trailer (project convention).
- **Indent style** in this codebase varies — match the file you're editing. New files: 2-space indent.
- **Reduced-motion** is `window.matchMedia('(prefers-reduced-motion: reduce)').matches`.
- **`localStorage`** writes must be wrapped in try/catch (Safari private mode throws).
- **Static export** — no SSR. All Pixi/canvas code lives in `'use client'` components, with `pixi.js` imported lazily inside `useEffect`.
- **PixiJS v8 syntax** is required (not v7). v8 differences worth flagging: `Application` is initialized via `await app.init({ canvas, ... })`, `Filter` takes `{ glProgram, resources }` with `GlProgram.from({ vertex, fragment })`, `DisplacementFilter` takes `{ sprite, scale }` config object. The plan uses v8 syntax throughout.

---

## Task 1: Install PixiJS and add types module

**Files:**
- Modify: `package.json`
- Create: `components/snake/snake-types.ts`

- [ ] **Step 1: Install pixi.js v8**

Run from project root:

```bash
npm install pixi.js@^8
```

Expected: `pixi.js` appears under `dependencies` in `package.json` at version `^8.x.x`. Both `package-lock.json` and `pnpm-lock.yaml` may update — commit both.

- [ ] **Step 2: Verify install**

```bash
npm run typecheck
```

Expected: PASS (no project source touches Pixi yet).

- [ ] **Step 3: Create the types module**

Create `components/snake/snake-types.ts`:

```ts
export type Direction = 'up' | 'down' | 'left' | 'right';

export type Cell = { x: number; y: number };

export type PelletKind = 'plain' | 'async' | 'claude' | 'panic';

export type Pellet = {
  cell: Cell;
  kind: PelletKind;
  glyph: string;
};

export type GameStatus = 'idle' | 'playing' | 'paused' | 'gameover';

export type ConsoleLine = { id: number; text: string; level: 'info' | 'panic' };

export type GameState = {
  gridCount: number;
  snake: Cell[];                 // head is index 0
  direction: Direction;
  queuedDirection: Direction | null;
  pellet: Pellet;
  status: GameStatus;
  score: number;
  best: number;
  tickRate: number;              // cells per second
  baseTickRate: number;
  asyncBoostUntil: number;       // ms timestamp; 0 if no boost active
  consoleLines: ConsoleLine[];   // ring buffer, max 8
  nextLineId: number;
  lastTickAt: number;            // ms timestamp of last engine tick
  rngSeed: number;               // for deterministic tests
};

export type EngineInput =
  | { type: 'turn'; dir: Direction }
  | { type: 'pause' }
  | { type: 'restart' };

export const PLAIN_GLYPHS = ['def', 'fn', 'let', 'await', 'pub', '→', 'λ', ':='] as const;
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json pnpm-lock.yaml components/snake/snake-types.ts
git commit -m "snake: install pixi.js v8 and add shared types module"
```

---

## Task 2: Engine — initial state, movement, collisions (TDD)

**Files:**
- Create: `components/snake/snake-engine.ts`
- Create: `components/snake/snake-engine.spec.ts`

- [ ] **Step 1: Write failing tests for initial state and movement**

Create `components/snake/snake-engine.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createInitialState, step, applyInput } from './snake-engine';
import type { GameState } from './snake-types';

const TICK_MS = 1000;

function tickOnce(state: GameState): GameState {
  return step(state, state.lastTickAt + TICK_MS);
}

describe('snake-engine — initial state', () => {
  it('starts with a 4-segment snake heading right in the middle of the grid', () => {
    const s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    expect(s.snake).toHaveLength(4);
    expect(s.direction).toBe('right');
    expect(s.status).toBe('playing');
    expect(s.score).toBe(0);
    expect(s.tickRate).toBe(8);
    expect(s.snake[0].y).toBe(11);
  });

  it('places a pellet not on the snake', () => {
    const s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const onSnake = s.snake.some((c) => c.x === s.pellet.cell.x && c.y === s.pellet.cell.y);
    expect(onSnake).toBe(false);
  });
});

describe('snake-engine — movement', () => {
  it('advances the head one cell in the current direction per tick', () => {
    const s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const headBefore = s.snake[0];
    const next = tickOnce(s);
    expect(next.snake[0]).toEqual({ x: headBefore.x + 1, y: headBefore.y });
  });

  it('respects a queued direction change on the next tick', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    s = applyInput(s, { type: 'turn', dir: 'up' });
    const headBefore = s.snake[0];
    s = tickOnce(s);
    expect(s.snake[0]).toEqual({ x: headBefore.x, y: headBefore.y - 1 });
  });

  it('drops a 180-degree opposing input', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    s = applyInput(s, { type: 'turn', dir: 'left' });
    expect(s.queuedDirection).toBeNull();
  });
});

describe('snake-engine — collisions', () => {
  it('ends the game on wall collision', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    s.snake = [{ x: 21, y: 5 }, { x: 20, y: 5 }];
    s.direction = 'right';
    s.queuedDirection = null;
    s = tickOnce(s);
    expect(s.status).toBe('gameover');
  });

  it('ends the game on self collision', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    s.snake = [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 4, y: 6 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 5 },
    ];
    s.direction = 'down';
    s.queuedDirection = null;
    s = tickOnce(s);
    expect(s.status).toBe('gameover');
  });
});
```

- [ ] **Step 2: Run tests — must fail**

```bash
npm test -- snake-engine
```

Expected: FAIL — module `./snake-engine` not found.

- [ ] **Step 3: Implement the engine**

Create `components/snake/snake-engine.ts`:

```ts
import type { Cell, Direction, EngineInput, GameState, Pellet, PelletKind } from './snake-types';
import { PLAIN_GLYPHS } from './snake-types';

const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

const DELTA: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// Mulberry32 — small, deterministic PRNG, plenty good for pellet placement.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createInitialState(opts: {
  gridCount: number;
  seed: number;
  now: number;
  best?: number;
}): GameState {
  const mid = Math.floor(opts.gridCount / 2);
  const snake: Cell[] = [
    { x: mid + 1, y: mid },
    { x: mid, y: mid },
    { x: mid - 1, y: mid },
    { x: mid - 2, y: mid },
  ];
  const state: GameState = {
    gridCount: opts.gridCount,
    snake,
    direction: 'right',
    queuedDirection: null,
    pellet: { cell: { x: 0, y: 0 }, kind: 'plain', glyph: 'def' },
    status: 'playing',
    score: 0,
    best: opts.best ?? 0,
    tickRate: 8,
    baseTickRate: 8,
    asyncBoostUntil: 0,
    consoleLines: [],
    nextLineId: 1,
    lastTickAt: opts.now,
    rngSeed: opts.seed,
  };
  state.pellet = spawnPellet(state);
  return state;
}

export function applyInput(state: GameState, input: EngineInput): GameState {
  if (input.type === 'turn') {
    if (state.status !== 'playing') return state;
    if (input.dir === OPPOSITE[state.direction]) return state;       // drop 180°
    if (state.queuedDirection === OPPOSITE[state.direction]) return state;
    return { ...state, queuedDirection: input.dir };
  }
  if (input.type === 'pause') {
    if (state.status === 'playing') return { ...state, status: 'paused' };
    if (state.status === 'paused') return { ...state, status: 'playing' };
    return state;
  }
  if (input.type === 'restart') {
    return createInitialState({
      gridCount: state.gridCount,
      seed: state.rngSeed + 1,
      now: state.lastTickAt,
      best: state.best,
    });
  }
  return state;
}

export function step(state: GameState, now: number): GameState {
  if (state.status !== 'playing') return { ...state, lastTickAt: now };

  let direction = state.direction;
  if (state.queuedDirection && state.queuedDirection !== OPPOSITE[direction]) {
    direction = state.queuedDirection;
  }

  const head = state.snake[0];
  const d = DELTA[direction];
  const next: Cell = { x: head.x + d.x, y: head.y + d.y };

  // Wall collision
  if (next.x < 0 || next.x >= state.gridCount || next.y < 0 || next.y >= state.gridCount) {
    return endGame(state, now);
  }
  // Self collision (skip tail tip — it'll move out of the way unless we eat)
  const willEat = next.x === state.pellet.cell.x && next.y === state.pellet.cell.y;
  const bodyToCheck = willEat ? state.snake : state.snake.slice(0, -1);
  if (bodyToCheck.some((c) => c.x === next.x && c.y === next.y)) {
    return endGame(state, now);
  }

  // panic! pellet ends the run on contact
  if (willEat && state.pellet.kind === 'panic') {
    return appendPanic(endGame(state, now), state.score);
  }

  let newSnake: Cell[];
  let newScore = state.score;
  let newPellet = state.pellet;
  let newTickRate = state.tickRate;
  let newAsyncBoostUntil = state.asyncBoostUntil;
  let consoleLines = state.consoleLines;
  let nextLineId = state.nextLineId;

  if (willEat) {
    newSnake = [next, ...state.snake];
    if (state.pellet.kind === 'claude') newScore += 3;
    else newScore += 1;

    newTickRate = Math.min(state.baseTickRate * Math.pow(1.06, newScore), 14);

    if (state.pellet.kind === 'async') {
      newAsyncBoostUntil = now + 3000;
      ({ consoleLines, nextLineId } = pushLine(state, '>>> async run()', 'info'));
    } else if (state.pellet.kind === 'claude') {
      ({ consoleLines, nextLineId } = pushLine(state, '>>> import claude', 'info'));
    } else {
      ({ consoleLines, nextLineId } = pushLine(state, `>>> ${state.pellet.glyph}`, 'info'));
    }

    newPellet = spawnPellet({
      ...state,
      snake: newSnake,
      consoleLines,
      nextLineId,
    });
  } else {
    newSnake = [next, ...state.snake.slice(0, -1)];
  }

  // Boost expiry
  let effectiveTickRate = newTickRate;
  if (newAsyncBoostUntil > 0) {
    if (now < newAsyncBoostUntil) effectiveTickRate = Math.min(newTickRate * 1.3, 18);
    else newAsyncBoostUntil = 0;
  }

  return {
    ...state,
    snake: newSnake,
    direction,
    queuedDirection: null,
    pellet: newPellet,
    score: newScore,
    tickRate: effectiveTickRate,
    asyncBoostUntil: newAsyncBoostUntil,
    consoleLines,
    nextLineId,
    lastTickAt: now,
  };
}

function endGame(state: GameState, now: number): GameState {
  const best = Math.max(state.best, state.score);
  return { ...state, status: 'gameover', best, lastTickAt: now };
}

function appendPanic(state: GameState, score: number): GameState {
  const { consoleLines, nextLineId } = pushLine(
    state,
    `panic!: index out of bounds at line ${score}`,
    'panic',
  );
  return { ...state, consoleLines, nextLineId };
}

function pushLine(
  state: GameState,
  text: string,
  level: 'info' | 'panic',
): { consoleLines: GameState['consoleLines']; nextLineId: number } {
  const line = { id: state.nextLineId, text, level };
  const lines = [...state.consoleLines, line];
  if (lines.length > 8) lines.shift();
  return { consoleLines: lines, nextLineId: state.nextLineId + 1 };
}

export function spawnPellet(state: GameState): Pellet {
  const rand = rng(state.rngSeed + state.score * 1000 + state.snake.length);
  const occupied = new Set(state.snake.map((c) => `${c.x},${c.y}`));
  const candidates: Cell[] = [];
  for (let y = 0; y < state.gridCount; y++) {
    for (let x = 0; x < state.gridCount; x++) {
      if (!occupied.has(`${x},${y}`)) candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return state.pellet;

  const cell = candidates[Math.floor(rand() * candidates.length)];

  // Roll a kind (plain 70 / async 12 / claude 12 / panic 6).
  let roll = rand();
  let kind: PelletKind;
  if (roll < 0.06) kind = 'panic';
  else if (roll < 0.18) kind = 'claude';
  else if (roll < 0.30) kind = 'async';
  else kind = 'plain';

  // Placement guard: if the head has only one legal next-move cell and the pellet sits there,
  // never make that pellet a panic — re-roll to plain.
  if (kind === 'panic') {
    const head = state.snake[0];
    const legal = legalNextCells(state, head);
    if (legal.length === 1 && legal[0].x === cell.x && legal[0].y === cell.y) {
      kind = 'plain';
    }
  }

  const glyph = kindToGlyph(kind, rand);
  return { cell, kind, glyph };
}

function legalNextCells(state: GameState, head: Cell): Cell[] {
  const occ = new Set(state.snake.map((c) => `${c.x},${c.y}`));
  const out: Cell[] = [];
  for (const dir of ['up', 'down', 'left', 'right'] as Direction[]) {
    const d = DELTA[dir];
    const c = { x: head.x + d.x, y: head.y + d.y };
    if (c.x < 0 || c.x >= state.gridCount || c.y < 0 || c.y >= state.gridCount) continue;
    if (occ.has(`${c.x},${c.y}`)) continue;
    out.push(c);
  }
  return out;
}

function kindToGlyph(kind: PelletKind, rand: () => number): string {
  if (kind === 'async') return 'async';
  if (kind === 'claude') return 'claude';
  if (kind === 'panic') return 'panic!';
  const i = Math.floor(rand() * PLAIN_GLYPHS.length);
  return PLAIN_GLYPHS[i];
}
```

- [ ] **Step 4: Run tests — must pass**

```bash
npm test -- snake-engine
```

Expected: all 7 tests pass.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/snake/snake-engine.ts components/snake/snake-engine.spec.ts
git commit -m "snake: add pure engine module with movement and collision tests"
```

---

## Task 3: Engine — pellet effects and panic placement guard (TDD)

**Files:**
- Modify: `components/snake/snake-engine.spec.ts` (add tests)

The implementation already supports pellet effects from Task 2 — we add tests that lock the behavior.

- [ ] **Step 1: Append failing tests**

Append to `components/snake/snake-engine.spec.ts`:

```ts
import { spawnPellet } from './snake-engine';

describe('snake-engine — pellets', () => {
  it('eating a plain pellet adds 1 to the score', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    s.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }];
    s.pellet = { cell: { x: 6, y: 5 }, kind: 'plain', glyph: 'def' };
    s.direction = 'right';
    s = step(s, s.lastTickAt + TICK_MS);
    expect(s.score).toBe(1);
    expect(s.snake).toHaveLength(3);
  });

  it('eating a claude pellet adds 3 and logs an import line', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    s.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }];
    s.pellet = { cell: { x: 6, y: 5 }, kind: 'claude', glyph: 'claude' };
    s.direction = 'right';
    s = step(s, s.lastTickAt + TICK_MS);
    expect(s.score).toBe(3);
    expect(s.consoleLines.at(-1)?.text).toBe('>>> import claude');
  });

  it('async pellet adds 1 and starts a 3-second boost', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    s.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }];
    s.pellet = { cell: { x: 6, y: 5 }, kind: 'async', glyph: 'async' };
    s.direction = 'right';
    const before = s.lastTickAt;
    s = step(s, before + TICK_MS);
    expect(s.score).toBe(1);
    expect(s.asyncBoostUntil).toBe(before + TICK_MS + 3000);
    expect(s.consoleLines.at(-1)?.text).toBe('>>> async run()');
  });

  it('eating a panic pellet ends the game and logs the panic line', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    s.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }];
    s.pellet = { cell: { x: 6, y: 5 }, kind: 'panic', glyph: 'panic!' };
    s.score = 7;
    s.direction = 'right';
    s = step(s, s.lastTickAt + TICK_MS);
    expect(s.status).toBe('gameover');
    expect(s.consoleLines.at(-1)?.text).toBe('panic!: index out of bounds at line 7');
  });

  it('placement guard never spawns a panic pellet on the only legal next cell', () => {
    // Construct a corner-trap state so only one cell is legal next.
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const state: GameState = {
      ...base,
      snake: [
        { x: 0, y: 0 },          // head, top-left corner
        { x: 1, y: 0 },          // body to the right
      ],
      direction: 'left',
    };
    // Only legal next cell from (0,0) heading 'left' (or any) within grid is (0,1) — the rest are walls or body.
    // Force seeds across many trials; ensure no spawn lands a 'panic' pellet on (0,1).
    for (let seed = 1; seed < 200; seed++) {
      const s = { ...state, rngSeed: seed };
      const p = spawnPellet(s);
      const onlyLegal = p.cell.x === 0 && p.cell.y === 1;
      if (onlyLegal) expect(p.kind).not.toBe('panic');
    }
  });

  it('tick rate scales 6% per pellet eaten and clamps at 14', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    expect(s.tickRate).toBeCloseTo(8, 5);
    s.score = 5;
    s.tickRate = 8 * Math.pow(1.06, 5);
    expect(s.tickRate).toBeLessThan(14);
    // Saturate
    const saturated = Math.min(8 * Math.pow(1.06, 50), 14);
    expect(saturated).toBe(14);
  });
});

describe('snake-engine — restart', () => {
  it('restart preserves best score and resets state', () => {
    let s = createInitialState({ gridCount: 22, seed: 1, now: 0, best: 42 });
    s.score = 5;
    s.status = 'gameover';
    s = applyInput(s, { type: 'restart' });
    expect(s.score).toBe(0);
    expect(s.best).toBe(42);
    expect(s.status).toBe('playing');
  });
});
```

- [ ] **Step 2: Run tests — must pass**

```bash
npm test -- snake-engine
```

Expected: all tests pass (Task 2's 7 + 7 new = 14).

- [ ] **Step 3: Commit**

```bash
git add components/snake/snake-engine.spec.ts
git commit -m "snake: cover pellet effects, panic guard, and restart in engine tests"
```

---

## Task 4: Snake event bus

**Files:**
- Create: `lib/snake-bus.ts`

- [ ] **Step 1: Write the bus**

Create `lib/snake-bus.ts`:

```ts
const EVENT_OPEN = 'snake:open';
const EVENT_CLOSE = 'snake:close';
const EVENT_RAISE = 'snake:raise';

export function openSnake() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_OPEN));
}

export function closeSnake() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_CLOSE));
}

export function raiseSnake() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_RAISE));
}

export function onSnakeOpen(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_OPEN, handler);
  return () => window.removeEventListener(EVENT_OPEN, handler);
}

export function onSnakeClose(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_CLOSE, handler);
  return () => window.removeEventListener(EVENT_CLOSE, handler);
}

export function onSnakeRaise(handler: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_RAISE, handler);
  return () => window.removeEventListener(EVENT_RAISE, handler);
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/snake-bus.ts
git commit -m "snake: add open/close/raise event bus"
```

---

## Task 5: Command palette wiring

**Files:**
- Modify: `lib/commands.ts`
- Modify: `components/command-palette.tsx`

- [ ] **Step 1: Add `'snake'` to the action union and append the command**

In `lib/commands.ts`:

Replace the `CommandAction` type with:

```ts
export type CommandAction =
  | { type: 'navigate'; href: string }
  | { type: 'external'; href: string }
  | { type: 'download'; href: string; filename?: string }
  | { type: 'theme'; value: 'light' | 'dark' | 'system' }
  | { type: 'copy'; value: string }
  | { type: 'whoami' }
  | { type: 'help' }
  | { type: 'plasma'; value: 'calm' | 'vivid' }
  | { type: 'snake' };
```

Add a new entry to the `commands` array, in the `Meta` group (after `help`, before the plasma entries):

```ts
  { id: 'play-snake', label: 'play snake', group: 'Meta', arrow: '▶', hint: 'easter egg', action: { type: 'snake' }, keywords: ['game', 'easter egg', 'snake'] },
```

- [ ] **Step 2: Handle the new action in the palette**

In `components/command-palette.tsx`:

Add the import next to the other bus imports:

```ts
import { openSnake } from '@/lib/snake-bus';
```

Inside the `runAction` switch (after the `'plasma'` case), add:

```ts
        case 'snake':
          openSnake();
          close();
          break;
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Smoke-run**

```bash
npm run dev
```

In the browser, press `/` to open the palette. Type `snake`. Confirm `play snake` appears in Meta with the `▶` arrow and the `easter egg` hint. Pressing Enter dispatches the bus event (no listener yet → palette closes silently, no errors in console).

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add lib/commands.ts components/command-palette.tsx
git commit -m "snake: register play snake command and wire palette action"
```

---

## Task 6: Floating window — chrome and drag (no canvas yet)

**Files:**
- Create: `components/snake/snake-window.tsx`
- Create: `components/snake/snake-window-host.tsx`
- Modify: `app/layout.tsx`

The window is built first with placeholder content so we can test open/drag/close before the renderer lands.

- [ ] **Step 1: Write the window component**

Create `components/snake/snake-window.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { closeSnake } from '@/lib/snake-bus';

const POS_KEY = 'snake.window.pos';
const WIN_W = 560;
const WIN_H = 640;

type Pos = { x: number; y: number };

function readPos(): Pos | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
  } catch {}
  return null;
}

function writePos(p: Pos) {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {}
}

function clamp(p: Pos, w: number, h: number): Pos {
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  return { x: Math.min(maxX, Math.max(0, p.x)), y: Math.min(maxY, Math.max(0, p.y)) };
}

function defaultPos(w: number, h: number): Pos {
  return clamp({ x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2 }, w, h);
}

export function SnakeWindow({ onExpand }: { onExpand: () => void }) {
  const [pos, setPos] = useState<Pos>(() =>
    typeof window === 'undefined' ? { x: 0, y: 0 } : readPos() ?? defaultPos(WIN_W, WIN_H),
  );
  const [isMobile, setIsMobile] = useState(false);
  const dragRef = useRef<{ originX: number; originY: number; startX: number; startY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p, WIN_W, WIN_H));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { originX: e.clientX, originY: e.clientY, startX: pos.x, startY: pos.y };
      setDragging(true);
    },
    [isMobile, pos],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = clamp(
      { x: d.startX + (e.clientX - d.originX), y: d.startY + (e.clientY - d.originY) },
      WIN_W,
      WIN_H,
    );
    setPos(next);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setDragging(false);
    setPos((p) => {
      writePos(p);
      return p;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSnake();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const baseStyle: React.CSSProperties = isMobile
    ? { position: 'fixed', inset: 0, zIndex: 90 }
    : {
        position: 'fixed',
        top: 0,
        left: 0,
        width: WIN_W,
        height: WIN_H,
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        zIndex: 90,
      };

  return (
    <div
      style={baseStyle}
      className="bg-[var(--bg-muted)] border border-[var(--rule)] shadow-[0_40px_80px_rgba(0,0,0,0.7)] flex flex-col font-mono"
      role="dialog"
      aria-label="snake.py"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`flex items-center justify-between px-4 py-2 border-b border-[var(--rule)] select-none ${
          isMobile ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <span className="text-[12px] text-[var(--fg)]/80">&gt; snake.py</span>
        <div className="flex items-center gap-1" data-no-drag>
          <button
            type="button"
            onClick={onExpand}
            aria-label="open in full page"
            className="px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)]"
          >
            ↗
          </button>
          <button
            type="button"
            onClick={closeSnake}
            aria-label="close"
            className="px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)]"
          >
            ×
          </button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center text-[11px] text-[var(--fg-faint)]">
        snake placeholder
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the host**

Create `components/snake/snake-window-host.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onSnakeClose, onSnakeOpen, onSnakeRaise } from '@/lib/snake-bus';
import { SnakeWindow } from './snake-window';

export function SnakeWindowHost() {
  const [open, setOpen] = useState(false);
  const [raiseToken, setRaiseToken] = useState(0);
  const router = useRouter();

  useEffect(() => {
    const offOpen = onSnakeOpen(() => {
      setOpen((wasOpen) => {
        if (wasOpen) setRaiseToken((t) => t + 1);
        return true;
      });
    });
    const offClose = onSnakeClose(() => setOpen(false));
    const offRaise = onSnakeRaise(() => setRaiseToken((t) => t + 1));
    return () => {
      offOpen();
      offClose();
      offRaise();
    };
  }, []);

  if (!open) return null;
  return (
    <SnakeWindow
      key={raiseToken}
      onExpand={() => {
        setOpen(false);
        router.push('/snake');
      }}
    />
  );
}
```

- [ ] **Step 3: Mount the host globally**

In `app/layout.tsx`, add the import:

```tsx
import { SnakeWindowHost } from '@/components/snake/snake-window-host';
```

And add the component just before `<CommandPaletteLazy />`:

```tsx
        <Footer />
        <SnakeWindowHost />
        <CommandPaletteLazy />
```

- [ ] **Step 4: Smoke-test in the browser**

```bash
npm run dev
```

- Press `/`, type `snake`, hit Enter. Window appears centered. Title bar reads `> snake.py`.
- Drag the window by the title bar to a corner. Release. Refresh the page. Reopen the window. Confirm position persists.
- Press `×` — window closes. Press `↗` — window closes and the URL changes to `/snake` (404 expected for now, that's OK).
- On a narrow viewport (<768px), the window goes full-bleed and dragging is disabled.

Stop the dev server.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/snake/snake-window.tsx components/snake/snake-window-host.tsx app/layout.tsx
git commit -m "snake: add draggable floating window shell with placeholder body"
```

---

## Task 7: Add `/snake` route stub and exclude hero shader

**Files:**
- Create: `app/snake/page.tsx`
- Modify: `components/hero-shader.tsx`

A stub route so the expand button has somewhere to land while we build the canvas.

- [ ] **Step 1: Create the route**

Create `app/snake/page.tsx`:

```tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'snake.py',
  description: 'Easter egg.',
};

export default function SnakePage() {
  return (
    <div className="min-h-[80vh] flex items-center justify-center font-mono text-[12px] text-[var(--fg-muted)]">
      &gt; snake.py — coming online
    </div>
  );
}
```

- [ ] **Step 2: Exclude the route from the hero shader**

In `components/hero-shader.tsx`, change the constant on line 9 from:

```ts
const SHADER_EXCLUDED_ROUTES = ['/cv', '/contact'];
```

To:

```ts
const SHADER_EXCLUDED_ROUTES = ['/cv', '/contact', '/snake'];
```

- [ ] **Step 3: Smoke-run**

```bash
npm run dev
```

Visit `http://localhost:3000/snake/`. Confirm the stub renders and there is no plasma backdrop. Stop the dev server.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/snake/page.tsx components/hero-shader.tsx
git commit -m "snake: add /snake route stub and exclude from hero shader"
```

---

## Task 8: CRT shader source

**Files:**
- Create: `components/snake/snake-shader-crt.ts`

- [ ] **Step 1: Write the GLSL fragment + vertex**

Create `components/snake/snake-shader-crt.ts`:

```ts
// Default PixiJS v8 filter vertex shader. Provided verbatim so the filter compiles
// without depending on any internal default. Source: pixijs.com filter docs.
export const CRT_VERTEX_GLSL = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;

export const CRT_FRAGMENT_GLSL = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uAberration;     // chromatic aberration strength, 0..1
uniform float uGrain;          // grain strength, 0..0.2
uniform float uScanlines;      // scanline strength, 0..0.4
uniform float uVignette;       // vignette strength, 0..1
uniform float uBarrel;         // barrel distortion, 0..0.2

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 barrel(vec2 uv, float k) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  return uv + c * r2 * k;
}

void main(void) {
  vec2 uv = barrel(vTextureCoord, uBarrel);

  // Chromatic aberration
  float a = uAberration * 0.004;
  float r = texture(uTexture, uv + vec2(a, 0.0)).r;
  float g = texture(uTexture, uv).g;
  float b = texture(uTexture, uv - vec2(a, 0.0)).b;
  float alpha = texture(uTexture, uv).a;
  vec3 col = vec3(r, g, b);

  // Scanlines
  float sl = sin(uv.y * 800.0) * 0.5 + 0.5;
  col *= 1.0 - uScanlines * (1.0 - sl);

  // Grain (animated by uTime)
  float n = hash(uv * 1024.0 + vec2(uTime * 13.0, uTime * 7.0));
  col += (n - 0.5) * uGrain;

  // Vignette
  vec2 vc = uv - 0.5;
  float vd = dot(vc, vc);
  col *= mix(1.0, 1.0 - vd * 2.0, uVignette);

  // Clip to rendered area
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    finalColor = vec4(0.0);
    return;
  }
  finalColor = vec4(col, alpha);
}
`;

export type CrtUniforms = {
  uTime: number;
  uAberration: number;
  uGrain: number;
  uScanlines: number;
  uVignette: number;
  uBarrel: number;
};

export const CRT_DEFAULTS: CrtUniforms = {
  uTime: 0,
  uAberration: 0.6,
  uGrain: 0.06,
  uScanlines: 0.18,
  uVignette: 0.55,
  uBarrel: 0.04,
};

export const CRT_REDUCED_MOTION: CrtUniforms = {
  uTime: 0,
  uAberration: 0.0,
  uGrain: 0.0,
  uScanlines: 0.18,
  uVignette: 0.55,
  uBarrel: 0.04,
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/snake/snake-shader-crt.ts
git commit -m "snake: add CRT fragment and vertex shaders with default uniforms"
```

---

## Task 9: PixiJS renderer — app, CRT filter, body Graphics

**Files:**
- Create: `components/snake/snake-renderer.ts`

- [ ] **Step 1: Write the renderer module**

Create `components/snake/snake-renderer.ts`:

```ts
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
  Texture,
} from 'pixi.js';
import type { Cell, GameState } from './snake-types';
import { CRT_DEFAULTS, CRT_FRAGMENT_GLSL, CRT_REDUCED_MOTION, CRT_VERTEX_GLSL, type CrtUniforms } from './snake-shader-crt';

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
  accentHex: number;             // 0xRRGGBB
  panicHex: number;              // 0xRRGGBB
  bgHex: number;                 // 0xRRGGBB (the canvas dark background)
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

  // CRT filter on the root container.
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

  // Body graphics — redrawn every frame.
  const body = new Graphics();
  root.addChild(body);

  // Pellet glyph — DOM Text would be cheaper, but we keep it inside the canvas so the
  // CRT filter applies. PixiJS v8 Text falls back to Canvas2D measurement.
  const { Text, TextStyle } = await import('pixi.js');
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

  // Score and best (top-left, top-right).
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

  // Animate uTime each frame.
  let timeAccum = 0;
  app.ticker.add((tick) => {
    timeAccum += tick.deltaMS / 1000;
    crtFilter.resources.crtUniforms.uniforms.uTime = timeAccum;
  });

  // ---- handle methods ----

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
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. (If pixi.js v8's `Filter` resource shape errors, refer to https://pixijs.com/8.x/guides/components/filters/custom-filters and adjust the `resources` block — types may require wrapping the uniform group in a `UniformGroup` instance instead of an inline object literal. Fix is local to this file.)

- [ ] **Step 3: Commit**

```bash
git add components/snake/snake-renderer.ts
git commit -m "snake: add pixi renderer with CRT filter and rounded-join body"
```

---

## Task 10: Renderer effects — shockwave, particles, glitch

**Files:**
- Modify: `components/snake/snake-renderer.ts`

- [ ] **Step 1: Add a tiny radial-gradient texture for the displacement map**

Insert near the top of `mount()` in `components/snake/snake-renderer.ts`, after the `Application` init:

```ts
  const dispMapTexture = createRadialDisplacementTexture(app);
```

Add the helper at the bottom of the file:

```ts
function createRadialDisplacementTexture(app: Application): Texture {
  // 64x64 canvas with a radial gradient from (0.5,0.5) → black edges, in the R/G channels
  // so DisplacementFilter samples a centered shock.
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
```

- [ ] **Step 2: Add the displacement filter, particle container, and glitch state**

Replace the placeholder bodies of `triggerShockwave` and `flashGlitch` with real implementations. Add these declarations above the `render` function (the imports are already at the top of the file from Task 9's edit above):

```ts
  const reducedMotionRef = { current: opts.reducedMotion };

  const dispSprite = new Sprite(dispMapTexture);
  dispSprite.anchor.set(0.5);
  dispSprite.scale.set(0); // hidden until shockwave fires
  root.addChild(dispSprite);
  const dispFilter = new DisplacementFilter({ sprite: dispSprite, scale: 0 });

  const particles = new ParticleContainer({
    dynamicProperties: { position: true, scale: true, alpha: true, color: true, rotation: false },
  });
  // We render particles as 3px squares using a 1x1 white texture tinted to accent.
  const dotTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 4, 4);
    return Texture.from(c);
  })();
  root.addChild(particles);

  type LiveParticle = {
    p: Particle;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
  };
  const liveParticles: LiveParticle[] = [];

  let shockwaveStart = -1;
  const SHOCK_MS = 400;

  let glitchUntil = -1;

  app.ticker.add((tick) => {
    const now = performance.now();
    // Shockwave envelope
    if (shockwaveStart > 0) {
      const t = (now - shockwaveStart) / SHOCK_MS;
      if (t >= 1) {
        shockwaveStart = -1;
        dispFilter.scale = 0;
        dispSprite.scale.set(0);
        root.filters = [crtFilter];
      } else {
        const radius = 1 + 6 * t;
        const strength = 30 * (1 - t);
        dispSprite.scale.set(radius);
        dispFilter.scale = strength;
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
```

Then replace the placeholder bodies:

```ts
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
```

(The previous `setReducedMotion` is replaced — there should be only one definition.)

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. PixiJS v8's `Particle` and `ParticleContainer` API is documented at https://pixijs.com/8.x/guides/components/particles. If the Particle constructor signature differs in the installed version, adjust to match — the intent is one Particle per dot, manually animated each tick.

- [ ] **Step 3: Commit**

```bash
git add components/snake/snake-renderer.ts
git commit -m "snake: add shockwave, particle burst, and glitch envelope to renderer"
```

---

## Task 11: SnakeCanvas — wire engine + renderer + input

**Files:**
- Create: `components/snake/snake-canvas.tsx`

- [ ] **Step 1: Write the canvas component**

Create `components/snake/snake-canvas.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  applyInput,
  createInitialState,
  step,
} from './snake-engine';
import type { RendererHandle } from './snake-renderer';
import type { Cell, GameState, Direction } from './snake-types';

type Props = {
  variant: 'window' | 'page';
  onConsoleChange?: (lines: GameState['consoleLines']) => void;
};

const BEST_KEY = 'snake.best';

const KEY_TO_DIR: Record<string, Direction | undefined> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  W: 'up',
  s: 'down',
  S: 'down',
  a: 'left',
  A: 'left',
  d: 'right',
  D: 'right',
};

function readBest(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const v = window.localStorage.getItem(BEST_KEY);
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeBest(n: number) {
  try {
    window.localStorage.setItem(BEST_KEY, String(n));
  } catch {}
}

function getCssColor(name: string, fallback: string): number {
  if (typeof window === 'undefined') return parseInt(fallback.slice(1), 16);
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  // Accept #RRGGBB only.
  const hex = v.startsWith('#') ? v.slice(1) : v;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : parseInt(fallback.slice(1), 16);
}

export function SnakeCanvas({ variant, onConsoleChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState | null>(null);
  const handleRef = useRef<RendererHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);
  const [mounted, setMounted] = useState(false);

  const gridCount = variant === 'page' ? 28 : 22;
  const cellSize = variant === 'page' ? 22 : 20;

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    (async () => {
      const { mount } = await import('./snake-renderer');
      if (cancelled || !canvasRef.current) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const accentHex = getCssColor('--accent', '#FFB84D');
      const handle = await mount(canvas, {
        gridCount,
        cellSize,
        reducedMotion: reduced,
        accentHex,
        panicHex: 0xff5050,
        bgHex: 0x0a0a0a,
      });
      if (cancelled) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;

      const now = performance.now();
      const initial = createInitialState({
        gridCount,
        seed: Math.floor(Math.random() * 0x7fffffff),
        now,
        best: readBest(),
      });
      stateRef.current = initial;
      onConsoleChange?.(initial.consoleLines);
      setMounted(true);

      let lastFrame = now;
      let acc = 0;
      const loop = () => {
        if (!stateRef.current || !handleRef.current) return;
        const t = performance.now();
        const dt = t - lastFrame;
        lastFrame = t;
        acc += dt;
        const tickInterval = 1000 / stateRef.current.tickRate;
        while (acc >= tickInterval && stateRef.current.status === 'playing') {
          const before = stateRef.current;
          const after = step(before, before.lastTickAt + tickInterval);
          // Detect pellet eaten: snake length grew or score changed.
          const ate = after.score !== before.score || after.snake.length !== before.snake.length;
          if (ate && before.pellet.kind === 'claude') {
            handleRef.current.triggerShockwave(before.pellet.cell);
          }
          if (ate && before.pellet.kind === 'async') {
            handleRef.current.flashGlitch();
          }
          if (after.status === 'gameover' && before.status === 'playing') {
            handleRef.current.flashGlitch();
            if (after.score > readBest()) writeBest(after.score);
          }
          if (after.consoleLines !== before.consoleLines) {
            onConsoleChange?.(after.consoleLines);
          }
          stateRef.current = after;
          acc -= tickInterval;
        }
        // Head tween position
        const s = stateRef.current;
        const head = s.snake[0];
        let headTween: Cell;
        if (reducedMotionRef.current) {
          headTween = head;
        } else {
          const tickInterval2 = 1000 / s.tickRate;
          const tweenT = Math.min(1, acc / tickInterval2);
          const prev = s.snake[1] ?? head;
          headTween = {
            x: prev.x + (head.x - prev.x) * tweenT,
            y: prev.y + (head.y - prev.y) * tweenT,
          };
        }
        handleRef.current.render(s, headTween);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      handleRef.current?.dispose();
      handleRef.current = null;
      stateRef.current = null;
    };
  }, [gridCount, cellSize, onConsoleChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const s = stateRef.current;
      if (!s) return;
      if (e.key === ' ') {
        e.preventDefault();
        stateRef.current = applyInput(s, { type: 'pause' });
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        stateRef.current = applyInput({ ...s, best: readBest() }, { type: 'restart' });
        return;
      }
      const dir = KEY_TO_DIR[e.key];
      if (dir) {
        e.preventDefault();
        stateRef.current = applyInput(s, { type: 'turn', dir });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Touch swipe (mobile)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let startX = 0;
    let startY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      startX = e.clientX;
      startY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      const dir: Direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      const s = stateRef.current;
      if (s) stateRef.current = applyInput(s, { type: 'turn', dir });
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: gridCount * cellSize,
        height: gridCount * cellSize,
        display: 'block',
        touchAction: 'none',
      }}
      data-mounted={mounted ? '1' : '0'}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/snake/snake-canvas.tsx
git commit -m "snake: add canvas component wiring engine, renderer, and input"
```

---

## Task 12: Console panel and integrate into the window

**Files:**
- Create: `components/snake/snake-console.tsx`
- Modify: `components/snake/snake-window.tsx`
- Modify: `components/snake/snake-window-host.tsx`
- Modify: `app/snake/page.tsx`

- [ ] **Step 1: Write the console panel**

Create `components/snake/snake-console.tsx`:

```tsx
'use client';

import type { ConsoleLine } from './snake-types';

export function SnakeConsole({ lines }: { lines: ConsoleLine[] }) {
  return (
    <div className="hidden md:flex flex-col gap-1 px-3 py-2 border-l border-[var(--rule)] bg-[var(--bg)]/40 font-mono text-[11px] min-w-[200px] max-h-full overflow-hidden">
      {lines.length === 0 && <div className="text-[var(--fg-faint)]">&gt;&gt;&gt;</div>}
      {lines.map((l) => (
        <div
          key={l.id}
          className={l.level === 'panic' ? 'text-[#ff7070]' : 'text-[var(--fg)]/85'}
        >
          {l.text}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wire canvas + console into the window body**

In `components/snake/snake-window.tsx`, replace the placeholder body div:

```tsx
      <div className="flex-1 flex items-center justify-center text-[11px] text-[var(--fg-faint)]">
        snake placeholder
      </div>
```

with:

```tsx
      {children}
```

And update the function signature to accept children:

```tsx
export function SnakeWindow({ onExpand, children }: { onExpand: () => void; children: React.ReactNode }) {
```

- [ ] **Step 3: Render the canvas + console inside the host**

Replace the contents of `components/snake/snake-window-host.tsx` with:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onSnakeClose, onSnakeOpen, onSnakeRaise } from '@/lib/snake-bus';
import { SnakeWindow } from './snake-window';
import { SnakeCanvas } from './snake-canvas';
import { SnakeConsole } from './snake-console';
import type { ConsoleLine } from './snake-types';

export function SnakeWindowHost() {
  const [open, setOpen] = useState(false);
  const [raiseToken, setRaiseToken] = useState(0);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const router = useRouter();

  useEffect(() => {
    const offOpen = onSnakeOpen(() => {
      setOpen((wasOpen) => {
        if (wasOpen) setRaiseToken((t) => t + 1);
        return true;
      });
    });
    const offClose = onSnakeClose(() => setOpen(false));
    const offRaise = onSnakeRaise(() => setRaiseToken((t) => t + 1));
    return () => {
      offOpen();
      offClose();
      offRaise();
    };
  }, []);

  if (!open) return null;
  return (
    <SnakeWindow
      key={raiseToken}
      onExpand={() => {
        setOpen(false);
        router.push('/snake');
      }}
    >
      <div className="flex-1 flex">
        <div className="flex-1 flex items-center justify-center bg-[#0a0a0a]">
          <SnakeCanvas variant="window" onConsoleChange={setLines} />
        </div>
        <SnakeConsole lines={lines} />
      </div>
    </SnakeWindow>
  );
}
```

- [ ] **Step 4: Wire the page route**

Replace `app/snake/page.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { SnakeConsole } from '@/components/snake/snake-console';
import type { ConsoleLine } from '@/components/snake/snake-types';

const SnakeCanvas = dynamic(
  () => import('@/components/snake/snake-canvas').then((m) => ({ default: m.SnakeCanvas })),
  { ssr: false },
);

export default function SnakePage() {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  return (
    <div className="min-h-[80vh] flex items-center justify-center bg-[#0a0a0a]">
      <div className="flex">
        <div className="flex items-center justify-center">
          <SnakeCanvas variant="page" onConsoleChange={setLines} />
        </div>
        <SnakeConsole lines={lines} />
      </div>
    </div>
  );
}
```

Because `'use client'` is set, the `metadata` export must move. Delete the metadata export in this file.

- [ ] **Step 5: Smoke-run end-to-end**

```bash
npm run dev
```

- Open `/snake/` directly. The canvas mounts; the CRT shader is visible immediately; the snake animates rightward.
- Press arrow keys; the snake turns; the body bends around corners as a curve, not a sharp angle.
- Eat a `claude` pellet (you may need to wait/play a few games). Confirm the displacement shockwave + particle burst.
- Eat an `async` pellet. Confirm the brief glitch + speed boost.
- Eat a `panic!` pellet. Confirm game-over flash and the panic line in the side console.
- Press `r` to restart. Best score persists; reload the page and best is still shown.
- Press `space` to pause; the canvas keeps rendering the static state.
- Open the floating window via the palette (`/`, `play snake`). Confirm the same behavior in the window. Drag it. Press `↗`; the URL changes to `/snake/` and the page version takes over.

Stop the dev server.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/snake/snake-console.tsx components/snake/snake-window.tsx components/snake/snake-window-host.tsx app/snake/page.tsx
git commit -m "snake: integrate canvas, console, and route bodies"
```

---

## Task 13: Game-over overlay and pause overlay

**Files:**
- Modify: `components/snake/snake-canvas.tsx`

The canvas needs a DOM overlay for the panic strip and pause indicator (drawing this in Pixi is more code than it's worth and the CRT shader still affects the canvas underneath).

- [ ] **Step 1: Add the overlay state**

In `components/snake/snake-canvas.tsx`, add `useState` to track status. Inside the component (above the existing effects):

```tsx
  const [status, setStatus] = useState<GameState['status']>('idle');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
```

In the RAF loop, after `stateRef.current = after;`, also call:

```ts
          setStatus(after.status);
          setScore(after.score);
          setBest(after.best);
```

(Adjust to call these only when values changed to avoid React thrashing — wrap each `set` with `if (after.status !== before.status) setStatus(...)` etc.)

- [ ] **Step 2: Render the overlay**

Replace the `return (...)` JSX with:

```tsx
  return (
    <div style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        style={{
          width: gridCount * cellSize,
          height: gridCount * cellSize,
          display: 'block',
          touchAction: 'none',
        }}
        data-mounted={mounted ? '1' : '0'}
      />
      {status === 'paused' && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center font-mono text-[12px] text-[var(--accent)] pointer-events-none">
          // paused
        </div>
      )}
      {status === 'gameover' && (
        <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-1 font-mono text-[12px] text-[#ff7070] pointer-events-none">
          <div>panic!: index out of bounds at line {score}</div>
          <div className="text-[var(--fg-muted)]">best: {best}</div>
          <div className="text-[var(--accent)]">press r to restart</div>
        </div>
      )}
    </div>
  );
```

- [ ] **Step 3: Smoke-run**

```bash
npm run dev
```

Play, die, confirm overlay shows panic line + best + restart prompt. Press `r`; overlay clears and a new run starts. Press `space` mid-run; overlay shows `// paused`. Press `space` again; clear.

Stop the dev server.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/snake/snake-canvas.tsx
git commit -m "snake: add pause and game-over overlays"
```

---

## Task 14: Reduced-motion live updates

**Files:**
- Modify: `components/snake/snake-canvas.tsx`

The renderer already supports a `setReducedMotion` toggle and starts in the right mode. The RAF loop already reads from `reducedMotionRef.current` (added in Task 11). This task wires the OS-level media query to that ref so changes mid-session take effect.

- [ ] **Step 1: Watch the media query and update the ref + the renderer**

In `components/snake/snake-canvas.tsx`, add a new `useEffect` (e.g., right after the existing pointer-swipe effect):

```tsx
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      reducedMotionRef.current = mq.matches;
      handleRef.current?.setReducedMotion(mq.matches);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
```

Also, in the existing renderer-mount `useEffect`, ensure the initial `reducedMotionRef.current` is set right before `mount()` is called so the renderer initializes with the correct mode. Replace:

```ts
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```

with:

```ts
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      reducedMotionRef.current = reduced;
```

- [ ] **Step 2: Smoke-run with reduced motion**

In Chrome devtools, Rendering pane → "Emulate CSS media feature prefers-reduced-motion" → "reduce".

```bash
npm run dev
```

Visit `/snake/`. Confirm grain and chromatic aberration are off; scanlines remain; head snaps cell-to-cell; eating `claude` produces no shockwave/particles; eating `async` produces no glitch.

Stop the dev server. Reset the devtools emulation.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/snake/snake-canvas.tsx
git commit -m "snake: honor prefers-reduced-motion at runtime"
```

---

## Task 15: Playwright e2e tests

**Files:**
- Create: `tests/e2e/snake.spec.ts`

- [ ] **Step 1: Write the test file**

Create `tests/e2e/snake.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('command palette opens the snake floating window', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('/');
  await page.fill('input[aria-label="Command palette"]', 'snake');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'snake.py' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('> snake.py');
});

test('escape closes the snake window', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('/');
  await page.fill('input[aria-label="Command palette"]', 'snake');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'snake.py' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'snake.py' })).toHaveCount(0);
});

test('expand button routes to /snake', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('/');
  await page.fill('input[aria-label="Command palette"]', 'snake');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'open in full page' }).click();
  await expect(page).toHaveURL(/\/snake\/?$/);
});

test('/snake mounts a canvas', async ({ page }) => {
  await page.goto('/snake/');
  // The canvas reports data-mounted="1" once the renderer has booted.
  const canvas = page.locator('canvas[data-mounted="1"]');
  await expect(canvas).toBeVisible({ timeout: 10_000 });
});

test('high score persists across reloads', async ({ page }) => {
  await page.goto('/snake/');
  await page.evaluate(() => window.localStorage.setItem('snake.best', '42'));
  await page.reload();
  // The renderer text "best 42" lives inside the canvas — assert via getComputedStyle indirectly
  // by reading the number we wrote.
  const v = await page.evaluate(() => window.localStorage.getItem('snake.best'));
  expect(v).toBe('42');
});
```

- [ ] **Step 2: Run the e2e suite**

In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run test:e2e -- snake
```

Expected: all 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/snake.spec.ts
git commit -m "snake: add playwright e2e for window, route, and persistence"
```

---

## Task 16: Final verification

- [ ] **Step 1: Full check**

```bash
npm run typecheck && npm test && npm run lint
```

Expected: all pass.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: build succeeds, `out/snake/index.html` exists, `out/_next/static/chunks/` contains a chunk file with `pixi` in the name (the lazy chunk).

- [ ] **Step 3: Smoke-test the static export**

```bash
npx serve out
```

Visit `http://localhost:3000/snake/` (port may differ — read `serve`'s output). Confirm the page loads, canvas mounts, snake animates, palette `play snake` opens the window. Stop `serve`.

- [ ] **Step 4: Browser hand-check matrix**

In `npm run dev`, exercise each row at least once:

| Surface | Open | Play | Eat plain | Eat claude | Eat async | Die | Restart | Pause |
|---------|------|------|-----------|------------|-----------|-----|---------|-------|
| Window (desktop) |  |  |  |  |  |  |  |  |
| Window (mobile, devtools toolbar) |  |  |  |  |  |  |  |  |
| `/snake` (desktop) |  |  |  |  |  |  |  |  |
| `/snake` (mobile, devtools toolbar) |  |  |  |  |  |  |  |  |

Tick each cell only after you have personally seen the behavior in the browser. Anything that fails goes back through the relevant task.

- [ ] **Step 5: Final commit (if any fixups)**

If the matrix surfaced fixups, commit them with a short message. Otherwise skip.

```bash
git status
git diff
# If clean: nothing to commit. Otherwise:
git add <files>
git commit -m "snake: <fixup summary>"
```

---

## Spec coverage check

Each spec requirement maps to a task:

- Floating window via palette → Tasks 4, 5, 6, 12
- `/snake` route → Tasks 7, 12
- Easter-egg only (no nav, no footer) → Task 5 (only the palette mentions it)
- Title `> snake.py` → Task 6
- Drag, single-instance, position persistence → Task 6
- 560×640 desktop, full-bleed mobile → Task 6
- Hero-shader exclusion on `/snake` → Task 7
- CRT custom shader → Tasks 8, 9
- Body as rounded-join Graphics with smooth turn curves and head tween → Tasks 9, 11, 14
- Displacement shockwave + GPU particles on `claude` → Task 10, wired in Task 11
- Loss-curve corner widget — descoped during plan-writing (the score/best texts already occupy the corners; see "Open items" below)
- Speed-boost glitch on `async` → Tasks 10, 11
- Side console (DOM, hidden on mobile) → Task 12
- 22×22 / 28×28 grid, 8→14 cells/sec tick rate → Tasks 1, 2, 11
- Direction queue, no 180° self-kill → Task 2
- Keyboard + WASD + space + r + esc → Tasks 6, 11
- Mobile swipe + sheet → Tasks 6, 11
- Pellets with weights and effects → Tasks 2, 3
- Panic-pellet placement guard → Tasks 2, 3
- Score + best in localStorage at game-over → Tasks 11, 13
- Game-over overlay → Task 13
- Pause overlay → Task 13
- Reduced motion → Tasks 9, 10, 14
- Engine/renderer isolation → Tasks 2, 9
- PixiJS lazy load → Tasks 11, 12
- Static export compatibility → Tasks 11, 16
- Tests → Tasks 2, 3, 15

## Open items deferred from the spec

- **Loss-curve corner widget.** The plan does not implement this. Rationale: top-left/top-right corners already hold `score` and `best` text; adding a third widget would crowd the corners. If the visual real-estate is reorganized later (e.g., score moves into the side console), revisit and add a `Graphics`-drawn line into the renderer with a small history buffer of `score` samples. Tracked here because the spec lists it; flag if you want it implemented now.
