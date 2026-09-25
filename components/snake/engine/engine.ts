import { angleDiff, dist2, TAU, wrapAngle } from './math';
import { advancePath, arcAt, trimPath } from './path';
import { nextRandom } from './rng';
import {
  ARENA_R,
  BASE_SPEED,
  BODY_R,
  COMBO_WINDOW,
  EAT_R,
  FOOD_CLEARANCE,
  FOOD_MARGIN,
  GOLDEN_CHANCE,
  GOLDEN_LIFE,
  GROW_PER_FOOD,
  HEAD_R,
  MAX_SPEED,
  SAMPLE_SPACING,
  SELF_SAFE_ARC,
  SPEED_GROWTH,
  START_LENGTH,
  TURN_RATE,
  type DeathCause,
  type EngineEvent,
  type EngineInput,
  type Food,
  type FoodKind,
  type GameState,
  type GameStatus,
  type StepResult,
  type Vec2,
} from './types';

export function speedFor(score: number): number {
  return Math.min(BASE_SPEED * Math.pow(SPEED_GROWTH, score), MAX_SPEED);
}

export function createInitialState(opts: { seed: number; best?: number; status?: GameStatus }): GameState {
  const head: Vec2 = { x: 0, z: 6 };
  const count = Math.ceil(START_LENGTH / SAMPLE_SPACING) + 2;
  // Resting pose: a gentle S behind the head (samples stay SAMPLE_SPACING apart along it).
  const path: Vec2[] = [];
  let p = { ...head };
  for (let i = 0; i < count; i++) {
    path.push(p);
    const s = (i + 0.5) * SAMPLE_SPACING;
    const back = Math.PI / 2 + 0.75 * Math.sin(s * 1.5) * Math.min(1, s / 0.8);
    p = { x: p.x + Math.cos(back) * SAMPLE_SPACING, z: p.z + Math.sin(back) * SAMPLE_SPACING };
  }
  const base: GameState = {
    head,
    heading: -Math.PI / 2,
    targetHeading: null,
    turnSense: 1,
    speed: speedFor(0),
    path,
    carry: 0,
    bodyLength: START_LENGTH,
    food: [],
    nextFoodId: 1,
    status: opts.status ?? 'idle',
    score: 0,
    best: opts.best ?? 0,
    eaten: 0,
    combo: 0,
    lastEatAt: -Infinity,
    time: 0,
    seed: opts.seed >>> 0,
    deathCause: null,
  };
  return spawnFood(base, 'normal').state;
}

/** Points the body occupies, head first. */
export function bodyPoints(state: GameState): Vec2[] {
  const out: Vec2[] = [state.head];
  for (let i = 0; i < state.path.length; i++) {
    if (arcAt(state.carry, i) > state.bodyLength) break;
    out.push(state.path[i]);
  }
  return out;
}

export function spawnFood(state: GameState, kind: FoodKind): { state: GameState; food: Food } {
  let seed = state.seed;
  const rand = () => {
    const r = nextRandom(seed);
    seed = r.seed;
    return r.value;
  };
  const body = bodyPoints(state);
  const clear2 = FOOD_CLEARANCE * FOOD_CLEARANCE;
  const maxR = ARENA_R - FOOD_MARGIN;
  let pos: Vec2 = { x: 0, z: 0 };
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = Math.sqrt(rand()) * maxR;
    const a = rand() * TAU;
    pos = { x: Math.cos(a) * r, z: Math.sin(a) * r };
    const clear =
      body.every((p) => dist2(p, pos) >= clear2) && state.food.every((f) => dist2(f.pos, pos) >= clear2);
    if (clear) break;
  }
  const food: Food = {
    id: state.nextFoodId,
    pos,
    kind,
    spawnedAt: state.time,
    expiresAt: kind === 'golden' ? state.time + GOLDEN_LIFE : null,
  };
  return { state: { ...state, seed, food: [...state.food, food], nextFoodId: state.nextFoodId + 1 }, food };
}

export function applyInput(state: GameState, input: EngineInput): GameState {
  switch (input.type) {
    case 'steer':
      if (state.status === 'idle') return { ...state, status: 'playing', targetHeading: input.heading };
      if (state.status !== 'playing') return state;
      return { ...state, targetHeading: input.heading };
    case 'start':
      return state.status === 'idle' ? { ...state, status: 'playing' } : state;
    case 'pause':
      if (state.status === 'playing') return { ...state, status: 'paused' };
      if (state.status === 'paused') return { ...state, status: 'playing' };
      return state;
    case 'restart':
      return createInitialState({ seed: state.seed, best: state.best, status: 'playing' });
  }
}

function die(state: GameState, cause: DeathCause, events: EngineEvent[]): StepResult {
  events.push({ type: 'death', cause });
  return {
    state: { ...state, status: 'gameover', deathCause: cause, best: Math.max(state.best, state.score) },
    events,
  };
}

export function step(state: GameState, dt: number): StepResult {
  if (state.status !== 'playing') return { state, events: [] };
  const events: EngineEvent[] = [];

  let heading = state.heading;
  let turnSense = state.turnSense;
  if (state.targetHeading !== null) {
    let d = angleDiff(heading, state.targetHeading);
    if (Math.abs(d) > Math.PI - 1e-6) d = turnSense * Math.abs(d);
    const maxTurn = TURN_RATE * dt;
    const turn = Math.max(-maxTurn, Math.min(maxTurn, d));
    if (turn !== 0) turnSense = turn > 0 ? 1 : -1;
    heading = wrapAngle(heading + turn);
  }

  const travel = state.speed * dt;
  const head: Vec2 = {
    x: state.head.x + Math.cos(heading) * travel,
    z: state.head.z + Math.sin(heading) * travel,
  };
  const time = state.time + dt;
  const advanced = advancePath(state.path, state.carry, state.head, head);
  let next: GameState = { ...state, head, heading, turnSense, time, path: advanced.path, carry: advanced.carry };

  if (Math.hypot(head.x, head.z) > ARENA_R - HEAD_R) return die(next, 'wall', events);

  const hit2 = (2 * BODY_R) ** 2;
  for (let i = 0; i < next.path.length; i++) {
    const arc = arcAt(next.carry, i);
    if (arc > next.bodyLength) break;
    if (arc <= SELF_SAFE_ARC) continue;
    if (dist2(head, next.path[i]) < hit2) return die(next, 'self', events);
  }

  const expired = next.food.filter((f) => f.expiresAt !== null && f.expiresAt <= time);
  if (expired.length > 0) {
    next = { ...next, food: next.food.filter((f) => !expired.includes(f)) };
    for (const food of expired) events.push({ type: 'expire', food });
  }

  const eaten = next.food.filter((f) => dist2(head, f.pos) <= EAT_R * EAT_R);
  for (const food of eaten) {
    const combo = time - next.lastEatAt <= COMBO_WINDOW ? next.combo + 1 : 1;
    next = {
      ...next,
      food: next.food.filter((f) => f.id !== food.id),
      score: next.score + (food.kind === 'golden' ? 3 : 1),
      bodyLength: next.bodyLength + GROW_PER_FOOD,
      eaten: next.eaten + 1,
      combo,
      lastEatAt: time,
    };
    events.push({ type: 'eat', food, combo });
    if (food.kind === 'normal') {
      const spawned = spawnFood(next, 'normal');
      next = spawned.state;
      events.push({ type: 'spawn', food: spawned.food });
      const roll = nextRandom(next.seed);
      next = { ...next, seed: roll.seed };
      if (roll.value < GOLDEN_CHANCE && !next.food.some((f) => f.kind === 'golden')) {
        const golden = spawnFood(next, 'golden');
        next = golden.state;
        events.push({ type: 'spawn', food: golden.food });
      }
    }
  }

  next = {
    ...next,
    path: trimPath(next.path, next.carry, next.bodyLength + 2 * SAMPLE_SPACING),
    speed: speedFor(next.score),
  };
  return { state: next, events };
}
