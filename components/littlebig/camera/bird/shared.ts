// The bird's render state, written by the camera system (camera/director.ts) each frame and drawn by
// the bird system (camera/bird/index.ts). Keyed on ctx.services: one object per engine, shared by
// the stage-2 system's own view of the context (core/engine.ts hands it Object.create(ctx)).

import { Quaternion, Vector3 } from 'three';
import type { LBContext } from '../../core/contracts';

/**
 * The bird's size: the mesh (mesh.ts) is modelled at 1.84 m wing tip to wing tip and drawn at this
 * scale, so its span is about 1.15 m (a gull or a crow, not an eagle, against the 160 m planet).
 * Flight (BIRD.span, BIRD.bodyR) and the chase camera's boom are sized from it.
 */
export const BIRD_SIZE = 0.62;

/**
 * (v2-BF) Standing (stand 1, legs 1), the body centre (BirdRender.pos) is this far over the floor in
 * model units (× scale): the feet are BIRD_STAND under it along the body's up (the belly is 0.175 under
 * it, so the legs reach 0.185 below the belly). Floating on water (stand 1, legs 0) it sits lower, its
 * centre 0.12 over the water.
 */
export const BIRD_STAND = 0.36;

export interface BirdRender {
  /** Draw the bird at all. */
  show: boolean;
  /**
   * Body centre and orientation (local +Z forward, +Y up, +X left): the body's attitude, so the
   * flight path pitched by the angle of attack (nose up in a flare, along the path in a glide),
   * banked, and tumbling in a crash.
   */
  readonly pos: Vector3;
  readonly quat: Quaternion;
  /** Overall scale: BIRD_SIZE times the cartoon pop in / out. */
  scale: number;
  /**
   * Wingbeat phase (rad, grows without bound, wrap it yourself): within each 2π the downstroke is
   * [0, π) (wings from the top of the beat to the bottom) and the upstroke [π, 2π). The flight
   * model pushes on the downstroke, so the animation and the thrust stay in step.
   */
  phase: number;
  /** Beat strength: 0 gliding (wings held out), 1 a full climbing beat. */
  amp: number;
  /** Stoop: 0 … 1, the wings swept back into an arrowhead, the tail closed. */
  tuck: number;
  /**
   * Flare: 0 … 1, the wings forward and cupped, the tail fanned and lowered (a hard pull-up, slow
   * flight near the stall, the recovery after a crash).
   */
  spread: number;
  /** Turn: −1 … 1 (+ = turning right), for the tail's twist and the wings' asymmetry. */
  turn: number;
  /** Airspeed (m/s): the wings sweep back a touch and the tail closes as it rises. */
  speed: number;
  /**
   * Crash: 0 none; while tumbling after hitting something, 1 easing to 0 as it recovers (the wings
   * flail out of step, the cartoon daze).
   */
  crash: number;
  /**
   * On the ground: 0 flying … 1 standing (wings folded on the back, perched on its legs). Eases in
   * through the touchdown's run-out and out through the take-off's jump.
   */
  stand: number;
  /** Legs: 0 tucked under the belly … 1 down (lowered on a landing approach, standing, the take-off jump). */
  legs: number;
  /**
   * A hop on the ground (a turn on the spot, the take-off's jump, a little idle hop): 0 none, else its
   * progress 0 … 1 (crouch, spring, airborne, land).
   */
  hop: number;
}

const states = new WeakMap<object, BirdRender>();

export function birdRender(ctx: LBContext): BirdRender {
  let s = states.get(ctx.services);
  if (!s) {
    s = { show: false, pos: new Vector3(), quat: new Quaternion(), scale: 0, phase: 0, amp: 0, tuck: 0, spread: 0, turn: 0, speed: 0, crash: 0, stand: 0, legs: 0, hop: 0 };
    states.set(ctx.services, s);
  }
  return s;
}
