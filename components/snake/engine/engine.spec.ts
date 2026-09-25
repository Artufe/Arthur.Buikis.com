import { describe, expect, it } from 'vitest';
import { applyInput, bodyPoints, createInitialState, speedFor, step } from './engine';
import { dist2 } from './math';
import { arcAt } from './path';
import { ARENA_R, GROW_PER_FOOD, SIM_DT, START_LENGTH, TURN_RATE, type EngineEvent, type GameState } from './types';

function playing(seed = 1): GameState {
  return applyInput(createInitialState({ seed }), { type: 'start' });
}

function run(state: GameState, steps: number, steer?: (s: GameState) => number | null) {
  let s = state;
  const events: EngineEvent[] = [];
  for (let i = 0; i < steps && s.status === 'playing'; i++) {
    const h = steer?.(s) ?? null;
    if (h !== null) s = applyInput(s, { type: 'steer', heading: h });
    const r = step(s, SIM_DT);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

describe('engine — setup and status', () => {
  it('starts idle, heading screen-up, with one normal food clear of the body', () => {
    const s = createInitialState({ seed: 7 });
    expect(s.status).toBe('idle');
    expect(s.heading).toBeCloseTo(-Math.PI / 2);
    expect(s.bodyLength).toBe(START_LENGTH);
    expect(s.food).toHaveLength(1);
    expect(s.food[0].kind).toBe('normal');
    for (const p of bodyPoints(s)) expect(dist2(p, s.food[0].pos)).toBeGreaterThanOrEqual(4);
    expect(Math.hypot(s.food[0].pos.x, s.food[0].pos.z)).toBeLessThanOrEqual(ARENA_R - 2);
  });

  it('does not move while idle; the first steer starts play', () => {
    const idle = createInitialState({ seed: 1 });
    expect(step(idle, SIM_DT).state).toBe(idle);
    const s = applyInput(idle, { type: 'steer', heading: 0 });
    expect(s.status).toBe('playing');
    expect(s.targetHeading).toBe(0);
  });

  it('pause freezes time and position', () => {
    const paused = applyInput(playing(), { type: 'pause' });
    expect(paused.status).toBe('paused');
    const r = step(paused, SIM_DT);
    expect(r.state).toBe(paused);
    expect(applyInput(paused, { type: 'pause' }).status).toBe('playing');
  });

  it('restart keeps best, resets the run and starts playing', () => {
    const dead: GameState = { ...playing(), status: 'gameover', score: 9, best: 12 };
    const s = applyInput(dead, { type: 'restart' });
    expect(s.status).toBe('playing');
    expect(s.score).toBe(0);
    expect(s.best).toBe(12);
  });
});

describe('engine — steering and movement', () => {
  it('turns toward the target at most TURN_RATE * dt per step', () => {
    let s = applyInput(playing(), { type: 'steer', heading: 0 });
    s = step(s, SIM_DT).state;
    expect(s.heading).toBeCloseTo(-Math.PI / 2 + TURN_RATE * SIM_DT);
  });

  it('takes the shortest way across the ±PI seam', () => {
    let s: GameState = { ...playing(), heading: 3.0 };
    s = applyInput(s, { type: 'steer', heading: -3.0 });
    s = step(s, SIM_DT).state;
    expect(s.heading).toBeCloseTo(3.0 + TURN_RATE * SIM_DT);
  });

  it('does not stall on an exact reversal', () => {
    let s: GameState = { ...playing(), heading: 0 };
    s = applyInput(s, { type: 'steer', heading: Math.PI });
    s = step(s, SIM_DT).state;
    expect(Math.abs(s.heading)).toBeCloseTo(TURN_RATE * SIM_DT);
  });

  it('moves at speedFor(score) along the heading', () => {
    const s0 = playing();
    const s1 = step(s0, SIM_DT).state;
    expect(s1.head.z).toBeCloseTo(s0.head.z - speedFor(0) * SIM_DT);
    expect(speedFor(0)).toBe(5);
    expect(speedFor(100)).toBe(11);
  });

  it('keeps the path trimmed to the body length', () => {
    const { state } = run(playing(), 120);
    const last = state.path.length - 1;
    expect(arcAt(state.carry, last)).toBeLessThanOrEqual(state.bodyLength + 0.3 + 1e-9);
  });
});

describe('engine — collisions', () => {
  it('dies on the arena wall', () => {
    const s: GameState = { ...playing(), head: { x: 0, z: -19.3 } };
    const { state, events } = run(s, 30);
    expect(state.status).toBe('gameover');
    expect(state.deathCause).toBe('wall');
    expect(events.at(-1)).toEqual({ type: 'death', cause: 'wall' });
  });

  it('ignores the neck while moving straight', () => {
    const { state } = run(playing(), 60);
    expect(state.status).toBe('playing');
  });

  it('dies when a long snake circles into itself', () => {
    const s: GameState = { ...playing(), head: { x: 0, z: 0 }, bodyLength: 20 };
    const { state } = run(s, 600, (x) => x.heading + 1.5);
    expect(state.status).toBe('gameover');
    expect(state.deathCause).toBe('self');
  });

  it('gameover updates best', () => {
    const s: GameState = { ...playing(), head: { x: 0, z: -19.3 }, score: 30, best: 10 };
    expect(run(s, 30).state.best).toBe(30);
  });
});

describe('engine — food', () => {
  function withFoodAhead(s: GameState, kind: 'normal' | 'golden' = 'normal'): GameState {
    const pos = { x: s.head.x, z: s.head.z - 0.5 };
    return { ...s, food: [{ id: 99, pos, kind, spawnedAt: 0, expiresAt: kind === 'golden' ? 6 : null }] };
  }

  it('eating normal food scores 1, grows, speeds up and respawns', () => {
    const r = step(withFoodAhead(playing()), SIM_DT);
    expect(r.state.score).toBe(1);
    expect(r.state.bodyLength).toBeCloseTo(START_LENGTH + GROW_PER_FOOD);
    expect(r.state.speed).toBeCloseTo(5 * 1.04);
    expect(r.events[0]).toMatchObject({ type: 'eat', combo: 1 });
    const normal = r.state.food.filter((f) => f.kind === 'normal');
    expect(normal).toHaveLength(1);
    expect(dist2(normal[0].pos, r.state.head)).toBeGreaterThanOrEqual(4);
  });

  it('golden food scores 3', () => {
    const r = step(withFoodAhead(playing(), 'golden'), SIM_DT);
    expect(r.state.score).toBe(3);
  });

  it('golden food expires', () => {
    const s: GameState = {
      ...playing(),
      food: [{ id: 5, pos: { x: 10, z: 10 }, kind: 'golden', spawnedAt: 0, expiresAt: 0.01 }],
    };
    const r = step(s, SIM_DT);
    expect(r.state.food).toHaveLength(0);
    expect(r.events).toContainEqual({ type: 'expire', food: s.food[0] });
  });

  it('spawns golden food on roughly GOLDEN_CHANCE of normal eats', () => {
    let golden = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = step(withFoodAhead(playing(seed)), SIM_DT);
      if (r.state.food.some((f) => f.kind === 'golden')) golden++;
    }
    expect(golden).toBeGreaterThan(10);
    expect(golden).toBeLessThan(80);
  });

  it('counts a combo for eats within the window', () => {
    let s = step(withFoodAhead(playing()), SIM_DT).state;
    s = step(withFoodAhead(s), SIM_DT).state;
    expect(s.combo).toBe(2);
  });
});

describe('engine — determinism', () => {
  it('same seed and inputs give the same run', () => {
    const steer = (s: GameState) => s.heading + Math.sin(s.time * 2) * 0.8;
    const a = run(playing(123), 400, steer).state;
    const b = run(playing(123), 400, steer).state;
    expect(a).toEqual(b);
  });
});
