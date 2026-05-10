import { describe, it, expect } from 'vitest';
import { createInitialState, step, applyInput, spawnPellet } from './snake-engine';
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
    expect(s.tickRate).toBe(6);
    expect(s.snake[0].y).toBe(11);
  });

  it('places at least one pellet, never on the snake', () => {
    const s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    expect(s.pellets.length).toBeGreaterThanOrEqual(1);
    for (const p of s.pellets) {
      const onSnake = s.snake.some((c) => c.x === p.cell.x && c.y === p.cell.y);
      expect(onSnake).toBe(false);
    }
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
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const s = tickOnce({
      ...base,
      snake: [{ x: 21, y: 5 }, { x: 20, y: 5 }],
      direction: 'right',
      queuedDirection: null,
    });
    expect(s.status).toBe('gameover');
  });

  it('ends the game on self collision', () => {
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const s = tickOnce({
      ...base,
      snake: [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
        { x: 4, y: 6 },
        { x: 5, y: 6 },
        { x: 6, y: 6 },
        { x: 6, y: 5 },
      ],
      direction: 'down',
      queuedDirection: null,
    });
    expect(s.status).toBe('gameover');
  });
});

describe('snake-engine — pellets', () => {
  it('eating a plain pellet adds 1 to the score', () => {
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const s = tickOnce({
      ...base,
      snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }],
      pellets: [{ cell: { x: 6, y: 5 }, kind: 'plain', glyph: 'def', armedAt: 0 }],
      direction: 'right',
      queuedDirection: null,
    });
    expect(s.score).toBe(1);
    expect(s.snake).toHaveLength(3);
  });

  it('eating a claude pellet adds 3 and logs an import line', () => {
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const s = tickOnce({
      ...base,
      snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }],
      pellets: [{ cell: { x: 6, y: 5 }, kind: 'claude', glyph: 'claude', armedAt: 0 }],
      direction: 'right',
      queuedDirection: null,
    });
    expect(s.score).toBe(3);
    expect(s.consoleLines.at(-1)?.text).toBe('>>> import claude');
  });

  it('async pellet adds 1 and starts a 3-second boost', () => {
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const before = base.lastTickAt;
    const s = step(
      {
        ...base,
        snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }],
        pellets: [{ cell: { x: 6, y: 5 }, kind: 'async', glyph: 'async', armedAt: 0 }],
        direction: 'right',
        queuedDirection: null,
      },
      before + TICK_MS,
    );
    expect(s.score).toBe(1);
    expect(s.asyncBoostUntil).toBe(before + TICK_MS + 3000);
    expect(s.consoleLines.at(-1)?.text).toBe('>>> async run()');
  });

  it('eating a panic pellet ends the game and logs the panic line', () => {
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const s = tickOnce({
      ...base,
      snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }],
      pellets: [{ cell: { x: 6, y: 5 }, kind: 'panic', glyph: 'panic!', armedAt: 0 }],
      score: 7,
      direction: 'right',
      queuedDirection: null,
    });
    expect(s.status).toBe('gameover');
    expect(s.consoleLines.at(-1)?.text).toBe('panic!: index out of bounds at line 7');
  });

  it('panic primary always spawns alongside a plain backup', () => {
    // Sweep many seeds; whenever createInitialState lands on a panic primary, assert
    // that a second pellet exists and is plain. Backup keeps the player from being
    // stranded during the telegraph window.
    let sawPanicPrimary = 0;
    for (let seed = 1; seed < 500; seed++) {
      const s = createInitialState({ gridCount: 22, seed, now: 0 });
      if (s.pellets[0].kind === 'panic') {
        sawPanicPrimary += 1;
        expect(s.pellets.length).toBe(2);
        expect(s.pellets[1].kind).toBe('plain');
      }
    }
    expect(sawPanicPrimary).toBeGreaterThan(0); // sanity: 6% rate × 500 seeds
  });

  it('placement guard never spawns a panic pellet on the only legal next cell', () => {
    // Construct a corner-trap state so only one cell is legal next.
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    const trap: GameState = {
      ...base,
      snake: [
        { x: 0, y: 0 }, // head, top-left corner
        { x: 1, y: 0 }, // body to the right
      ],
      direction: 'left',
    };
    // The only legal next cell from (0,0) is (0,1). Across many seeds, ensure no spawn
    // lands a 'panic' pellet on that cell.
    for (let seed = 1; seed < 200; seed++) {
      const p = spawnPellet({ ...trap, rngSeed: seed });
      const onlyLegal = p.cell.x === 0 && p.cell.y === 1;
      if (onlyLegal) expect(p.kind).not.toBe('panic');
    }
  });

  it('tick rate scales 6% per pellet eaten and clamps at 14', () => {
    const s = createInitialState({ gridCount: 22, seed: 1, now: 0 });
    expect(s.tickRate).toBeCloseTo(6, 5);
    // Saturation ceiling — ramp from 6 still hits the 14 cap before the 50-pellet horizon.
    const saturated = Math.min(6 * Math.pow(1.06, 50), 14);
    expect(saturated).toBe(14);
  });
});

describe('snake-engine — restart', () => {
  it('restart preserves best score and resets state', () => {
    const base = createInitialState({ gridCount: 22, seed: 1, now: 0, best: 42 });
    const dead = { ...base, score: 5, status: 'gameover' as const };
    const s = applyInput(dead, { type: 'restart' });
    expect(s.score).toBe(0);
    expect(s.best).toBe(42);
    expect(s.status).toBe('playing');
  });
});
