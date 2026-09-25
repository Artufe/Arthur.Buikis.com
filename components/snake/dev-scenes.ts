// Development-only: deterministic scenes for screenshots and visual review.
import { applyInput, createInitialState, speedFor, step } from './engine/engine';
import { headingToward } from './engine/math';
import { ARENA_R, SIM_DT, type GameState } from './engine/types';
import type { HudPhase } from './hud';
import type { LeaderboardEntry } from './leaderboard';
import type { RendererHandle, Theme } from './render/mount';

export const SCENES = ['idle', 'mid-run', 'trail-fade', 'golden', 'death', 'gameover'] as const;
export type SceneName = (typeof SCENES)[number];

export type DevHookDeps = {
  handle: RendererHandle;
  apply(state: GameState, prev: GameState): void;
  freeze(on: boolean): void;
  setHud(phase: HudPhase, entries: LeaderboardEntry[], rank: number): void;
};

type Built = { state: GameState; prev: GameState; phase: HudPhase; entries: LeaderboardEntry[]; rank: number };

const SEED = 20260925;
const SAMPLE_TABLE: LeaderboardEntry[] = [
  { initials: 'ART', score: 41, length: 53.2, date: 1 },
  { initials: 'DUN', score: 33, length: 43.6, date: 2 },
  { initials: 'SID', score: 27, length: 36.4, date: 3 },
  { initials: 'MOJ', score: 19, length: 26.8, date: 4 },
  { initials: 'KAI', score: 12, length: 18.4, date: 5 },
];

const eight = (t: number) => ({ x: 12 * Math.sin(0.33 * t), z: 7 * Math.sin(0.66 * t) });
const follow = (s: GameState, t: number) => headingToward(s.head, eight(t + 1.2));
const outward = (s: GameState) => Math.atan2(s.head.z, s.head.x);
// A wide, wobbling orbit: far longer than any scene's body, so the snake never crosses itself.
const orbit = (s: GameState, t: number) => {
  const a = Math.atan2(s.head.z, s.head.x) - 0.55;
  const r = 10 + 2.5 * Math.sin(t * 0.8);
  return headingToward(s.head, { x: Math.cos(a) * r, z: Math.sin(a) * r });
};

function started(bodyLength: number, score: number): GameState {
  const base = applyInput(createInitialState({ seed: SEED, best: 38 }), { type: 'start' });
  return { ...base, bodyLength, score, speed: speedFor(score) };
}

function simulate(
  deps: DevHookDeps,
  start: GameState,
  seconds: number,
  steer: (s: GameState, t: number) => number | null,
  stopOnDeath = false,
) {
  let s = start;
  let prev = start;
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    if (stopOnDeath && s.status === 'gameover') break;
    const h = s.status === 'playing' ? steer(s, i * SIM_DT) : null;
    if (h !== null) s = applyInput(s, { type: 'steer', heading: h });
    prev = s;
    const r = step(s, SIM_DT);
    s = r.state;
    if (r.events.length > 0) deps.handle.handleEvents(r.events, s);
    deps.handle.frame({ prev, cur: s, alpha: 1, dt: SIM_DT, draw: false });
  }
  return { state: s, prev };
}

function hold(deps: DevHookDeps, s: GameState, seconds: number) {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) deps.handle.frame({ prev: s, cur: s, alpha: 1, dt: SIM_DT, draw: false });
}

function withFoodAhead(s: GameState, distance = 4.5, turn = 0): GameState {
  const a = s.heading + turn;
  let x = s.head.x + Math.cos(a) * distance;
  let z = s.head.z + Math.sin(a) * distance;
  const r = Math.hypot(x, z);
  if (r > ARENA_R - 2.5) {
    x *= (ARENA_R - 2.5) / r;
    z *= (ARENA_R - 2.5) / r;
  }
  return { ...s, food: s.food.map((f, i) => (i === 0 ? { ...f, pos: { x, z } } : f)) };
}

export function buildScene(name: SceneName, deps: DevHookDeps): Built {
  deps.freeze(true);
  const table = { entries: SAMPLE_TABLE, rank: -1 };
  switch (name) {
    case 'idle': {
      const s = createInitialState({ seed: SEED, best: 38 });
      deps.handle.reset(s);
      hold(deps, s, 1.5);
      return { state: s, prev: s, phase: 'none', ...table };
    }
    case 'mid-run': {
      const start = started(15, 9);
      deps.handle.reset(start);
      const r = simulate(deps, start, 7, orbit);
      return { state: withFoodAhead(r.state), prev: r.prev, phase: 'none', ...table };
    }
    case 'trail-fade': {
      const start = started(7, 4);
      deps.handle.reset(start);
      const r = simulate(deps, start, 13, follow);
      return { state: r.state, prev: r.prev, phase: 'none', ...table };
    }
    case 'golden': {
      const start = started(15, 9);
      deps.handle.reset(start);
      const r = simulate(deps, start, 7, orbit);
      const s0 = withFoodAhead(r.state, 6, -0.5);
      const g = withFoodAhead(r.state, 5, 0.6).food[0].pos;
      const s: GameState = {
        ...s0,
        food: [...s0.food, { id: s0.nextFoodId, pos: g, kind: 'golden', spawnedAt: s0.time, expiresAt: s0.time + 5 }],
        nextFoodId: s0.nextFoodId + 1,
      };
      hold(deps, s, 0.5); // let the golden food finish its spawn pop
      return { state: s, prev: s, phase: 'none', ...table };
    }
    case 'death':
    case 'gameover': {
      const start = started(15, 9);
      deps.handle.reset(start);
      const a = simulate(deps, start, 5, orbit);
      const b = simulate(deps, a.state, 8, outward, true);
      hold(deps, b.state, name === 'death' ? 0.35 : 1.4);
      const dead: GameState = { ...b.state, score: 23 };
      return name === 'death'
        ? { state: dead, prev: dead, phase: 'none', ...table }
        : { state: dead, prev: dead, phase: 'initials', ...table };
    }
  }
}

export function installDevHook(deps: DevHookDeps): () => void {
  const api = {
    scenes: SCENES,
    setScene(name: SceneName) {
      const built = buildScene(name, deps);
      deps.apply(built.state, built.prev);
      deps.setHud(built.phase, built.entries, built.rank);
      return true;
    },
    freeze(on: boolean) {
      deps.freeze(on);
    },
    setTheme(theme: Theme) {
      deps.handle.setTheme(theme, true);
    },
  };
  const w = window as unknown as { __snake?: typeof api };
  w.__snake = api;
  return () => {
    delete w.__snake;
  };
}
