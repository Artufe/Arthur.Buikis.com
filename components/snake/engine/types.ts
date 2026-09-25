export type Vec2 = { x: number; z: number };

export type FoodKind = 'normal' | 'golden';

export type Food = {
  id: number;
  pos: Vec2;
  kind: FoodKind;
  spawnedAt: number; // sim seconds
  expiresAt: number | null; // sim seconds; golden only
};

export type GameStatus = 'idle' | 'playing' | 'paused' | 'gameover';

export type DeathCause = 'wall' | 'self';

export type GameState = {
  head: Vec2;
  heading: number; // radians; direction = (cos, sin) on XZ
  targetHeading: number | null;
  turnSense: 1 | -1; // last turn direction, used to break exact reversals
  speed: number; // units per second
  path: Vec2[]; // newest first; path[i] lies `carry + i * SAMPLE_SPACING` behind the head
  carry: number; // travel since path[0] was laid
  bodyLength: number; // arc length of the body
  food: Food[];
  nextFoodId: number;
  status: GameStatus;
  score: number;
  best: number;
  eaten: number;
  combo: number; // consecutive eats within COMBO_WINDOW
  lastEatAt: number; // sim seconds; -Infinity before the first eat
  time: number; // sim seconds, advances only while playing
  seed: number; // rng state
  deathCause: DeathCause | null;
};

export type EngineInput =
  | { type: 'steer'; heading: number }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'restart' };

export type EngineEvent =
  | { type: 'eat'; food: Food; combo: number }
  | { type: 'spawn'; food: Food }
  | { type: 'expire'; food: Food }
  | { type: 'death'; cause: DeathCause };

export type StepResult = { state: GameState; events: EngineEvent[] };

export const SIM_DT = 1 / 60;
export const ARENA_R = 20;
export const SAMPLE_SPACING = 0.15;
export const START_LENGTH = 4;
export const GROW_PER_FOOD = 1.2;
export const TURN_RATE = 3.6;
export const BASE_SPEED = 5;
export const SPEED_GROWTH = 1.04;
export const MAX_SPEED = 11;
export const HEAD_R = 0.45;
export const BODY_R = 0.35;
export const SELF_SAFE_ARC = 1.2;
export const EAT_R = 0.9;
export const GOLDEN_CHANCE = 0.12;
export const GOLDEN_LIFE = 6;
export const COMBO_WINDOW = 4;
export const FOOD_MARGIN = 2;
export const FOOD_CLEARANCE = 2;
