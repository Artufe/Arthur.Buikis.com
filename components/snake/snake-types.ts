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
