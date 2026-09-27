// Deterministic input playback for the surf demos (shots and motion review): `surf.demo` 1 = the
// ride (paddle into a set wave at the peak, drop, bottom turn into the barrel, out beside the pier,
// cutback, rebound, a glance back along the trail, kick-out), 2 = the pier run (walk out the deck,
// jump through the opening, paddle to the ladder, climb back up), 3 = a wipeout (see demos.ts).
//
// A script is a list of phases. Each phase reads the live state (the player, the ride, the breaker
// under the board) and writes the player's intent the way a person would with keyboard and mouse:
// look deltas toward a target view, W/A/S/D, Space. The controls go through exactly the same code
// path as real input, and the sim is deterministic, so every run of a shot replays the same ride.
// No allocation per frame: phases are created once; they only write numbers, and the step is a
// field of the pilot (p.dt), not an argument.

import type { GLContext } from '../core/contracts';
import type { Intent } from '../player/intent';
import type { PlayerRig } from '../player/api';
import type { Ride } from './ride';

export interface Pilot {
  ctx: GLContext;
  rig: PlayerRig;
  ride: Ride;
  /** This frame's step (s): a field, so no double crosses a call. */
  dt: number;
  /** Seconds in the current phase, and since the script started. */
  t: number;
  total: number;
  out: Intent;
  /** Scratch per phase (reset on entry). */
  a: number;
  b: number;
}

export interface Phase {
  name: string;
  /** Fill p.out (p.dt is the step); return true to move on. */
  run(p: Pilot): boolean;
}

export interface SurfScript {
  name: string;
  /** Start: position, view yaw, mode, sim time. */
  start: { x: number; z: number; yaw: number; pitch: number; mode: 'walk' | 'paddle'; t: number };
  phases: Phase[];
}

/** yaw such that forward points along (dx, dz). */
const TAU = Math.PI * 2;

export const yawOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/** Turn the view toward (yaw, pitch) at `rate` (1/s), like a hand on a mouse. */
export function look(p: Pilot, yaw: number, pitch: number, rate: number) {
  const k = Math.min(1, rate * p.dt);
  let d = (yaw - p.rig.yaw + Math.PI) % TAU;
  if (d < 0) d += TAU;
  p.out.lookX = -(d - Math.PI) * k;
  p.out.lookY = -(pitch - p.rig.pitch) * k;
}

export function clearIntent(o: Intent) {
  o.fwd = 0;
  o.side = 0;
  o.run = false;
  o.lookX = 0;
  o.lookY = 0;
  o.action = false;
  o.actionHeld = false;
}

export class ScriptPlayer {
  script: SurfScript | null = null;
  private i = 0;
  readonly pilot: Pilot;
  done = false;
  /** Name of the phase running (debug). */
  phase = '';

  constructor(ctx: GLContext, rig: PlayerRig, ride: Ride, out: Intent) {
    this.pilot = { ctx, rig, ride, dt: 0, t: 0, total: 0, out, a: 0, b: 0 };
  }

  start(s: SurfScript) {
    this.script = s;
    this.i = 0;
    this.done = false;
    this.pilot.t = 0;
    this.pilot.total = 0;
    this.pilot.a = 0;
    this.pilot.b = 0;
    this.phase = s.phases[0]?.name ?? '';
  }

  stop() {
    this.script = null;
    this.done = true;
  }

  /** Fill the intent for this frame (nothing while the sim is frozen). */
  step(out: Intent) {
    clearIntent(out);
    const s = this.script;
    const dt = this.pilot.ctx.time.dt;
    if (!s || !(dt > 0)) return;
    if (this.i >= s.phases.length) {
      this.done = true;
      return;
    }
    const p = this.pilot;
    p.dt = dt;
    p.t += dt;
    p.total += dt;
    const ph = s.phases[this.i];
    if (ph.run(p)) {
      this.i++;
      p.t = 0;
      p.a = 0;
      p.b = 0;
      this.phase = this.i < s.phases.length ? s.phases[this.i].name : 'done';
    }
  }
}
