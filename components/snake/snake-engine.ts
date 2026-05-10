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
    a = (a + 0x6d2b79f5) >>> 0;
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
    pellet: { cell: { x: 0, y: 0 }, kind: 'plain', glyph: 'def', armedAt: opts.now },
    status: 'playing',
    score: 0,
    best: opts.best ?? 0,
    tickRate: 6,
    baseTickRate: 6,
    asyncBoostUntil: 0,
    consoleLines: [],
    nextLineId: 1,
    lastTickAt: opts.now,
    rngSeed: opts.seed,
    comboCount: 0,
    bestCombo: 0,
    maxLength: snake.length,
  };
  state.pellet = spawnPellet(state, opts.now);
  return state;
}

export function applyInput(state: GameState, input: EngineInput): GameState {
  if (input.type === 'turn') {
    if (state.status !== 'playing') return state;
    if (input.dir === OPPOSITE[state.direction]) return state; // drop 180°
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

  // panic! pellet ends the run on contact — but only if the telegraph window has elapsed.
  // During the pre-arm window the pellet is visible but inert; eating it acts like a plain
  // pellet (one of the "varied tactics" — players who can race the timer get a free score).
  if (willEat && state.pellet.kind === 'panic' && now >= state.pellet.armedAt) {
    return appendPanic(endGame(state, now), state.score);
  }

  let newSnake: Cell[];
  let newScore = state.score;
  let newPellet = state.pellet;
  let newTickRate = state.tickRate;
  let newAsyncBoostUntil = state.asyncBoostUntil;
  let consoleLines = state.consoleLines;
  let nextLineId = state.nextLineId;
  let comboCount = state.comboCount;

  if (willEat) {
    newSnake = [next, ...state.snake];
    const eatenAsPlain = state.pellet.kind === 'panic'; // pre-arm panic counts as plain
    if (state.pellet.kind === 'claude') newScore += 3;
    else newScore += 1;

    newTickRate = Math.min(state.baseTickRate * Math.pow(1.06, newScore), 14);

    if (state.pellet.kind === 'async') {
      newAsyncBoostUntil = now + 3000;
      comboCount += 1;
      ({ consoleLines, nextLineId } = pushLine(state, '>>> async run()', 'info'));
    } else if (state.pellet.kind === 'claude') {
      comboCount += 1;
      ({ consoleLines, nextLineId } = pushLine(state, '>>> import claude', 'info'));
    } else if (eatenAsPlain) {
      // Pre-arm panic eaten — narrow win, fun beat. Doesn't break combo (treated as nothing happened).
      ({ consoleLines, nextLineId } = pushLine(state, '>>> caught(panic!) // defused', 'info'));
    } else {
      comboCount = 0; // plain pellet resets combo
      ({ consoleLines, nextLineId } = pushLine(state, `>>> ${state.pellet.glyph}`, 'info'));
    }

    newPellet = spawnPellet({
      ...state,
      snake: newSnake,
      consoleLines,
      nextLineId,
    }, now);
  } else {
    newSnake = [next, ...state.snake.slice(0, -1)];
  }

  // Boost expiry. Base cap is 14; boost layers ×1.15 on top with a ceiling of 16,
  // so `async` is a noticeable nudge instead of a panic-inducing surge.
  let effectiveTickRate = newTickRate;
  if (newAsyncBoostUntil > 0) {
    if (now < newAsyncBoostUntil) effectiveTickRate = Math.min(newTickRate * 1.15, 16);
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
    comboCount,
    bestCombo: Math.max(state.bestCombo, comboCount),
    maxLength: Math.max(state.maxLength, newSnake.length),
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

export function spawnPellet(state: GameState, now: number = state.lastTickAt): Pellet {
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
  const roll = rand();
  let kind: PelletKind;
  if (roll < 0.06) kind = 'panic';
  else if (roll < 0.18) kind = 'claude';
  else if (roll < 0.3) kind = 'async';
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
  // panic pellets get a 1.2s telegraph window before they arm; everything else is armed immediately.
  const armedAt = kind === 'panic' ? now + 1200 : now;
  return { cell, kind, glyph, armedAt };
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
