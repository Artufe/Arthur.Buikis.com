import type { ViewSpec } from './contracts';

/** Engine-free, versioned state shared by window expansion and GPU recovery. */
export type CameraSnapshot = { version: 1 } & (
  | { mode: 'explore' }
  | { mode: 'ride'; id: string; yaw: number; pitch: number; logDistance: number }
  | { mode: 'bird'; flight: BirdSnapshot; logDistance: number }
);

export interface BirdSnapshot {
  position: [number, number, number];
  heading: [number, number, number];
  speed: number;
  gamma: number;
  bank: number;
  turn: number;
  phase: number;
  /** (v2-BF, optional) The lift coefficient against trim's and the beat's strength; absent: trim, gliding. */
  lift?: number;
  amp?: number;
  /** (v2-BF, optional) Standing (or floating) on its floor. */
  ground?: boolean;
}

export interface PlanetSession {
  view: ViewSpec;
  t: number;
  camera?: CameraSnapshot;
}
