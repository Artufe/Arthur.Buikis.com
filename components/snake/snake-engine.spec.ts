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
