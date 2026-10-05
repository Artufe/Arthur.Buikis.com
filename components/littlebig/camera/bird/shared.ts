// The bird's render state, written by the camera system (camera/director.ts) each frame and drawn by
// the bird system (camera/bird/index.ts). Keyed on ctx.services: one object per engine, shared by
// the stage-2 system's own view of the context (core/engine.ts hands it Object.create(ctx)).

import { Quaternion, Vector3 } from 'three';
import type { LBContext } from '../../core/contracts';

export interface BirdRender {
  /** Draw the bird at all. */
  show: boolean;
  /** Body centre and orientation (local +Z forward, +Y up, +X left). */
  readonly pos: Vector3;
  readonly quat: Quaternion;
  /** Overall scale (the cartoon pop in / out). */
  scale: number;
  /** Wing cycle phase (rad), flap amplitude (0 … 1), dive tuck (0 … 1). */
  phase: number;
  amp: number;
  tuck: number;
}

const states = new WeakMap<object, BirdRender>();

export function birdRender(ctx: LBContext): BirdRender {
  let s = states.get(ctx.services);
  if (!s) states.set(ctx.services, (s = { show: false, pos: new Vector3(), quat: new Quaternion(), scale: 0, phase: 0, amp: 0, tuck: 0 }));
  return s;
}
