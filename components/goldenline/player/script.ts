// Deterministic demo scripts that drive the player through the real controller (no camera
// cheats), for screenshots and motion review: `?p.player.demo=<n>` or a lab shot.
// A script is a start state plus steps; `goto` steers the view toward a point and walks or
// paddles there, so the same script works on whatever terrain and pier the owners build.

import type { PlayerMode } from '../core/contracts';
import { PEAK, PIER, SPAWN } from '../world/layout';
import type { Intent } from './intent';
import { wrapAngle } from './rigmath';

export type Step =
  | { goto: [number, number]; run?: boolean; tol?: number; pitch?: number; max?: number }
  | { look: number; pitch: number; dur: number; rel?: boolean }
  | { wait: number; pitch?: number; fwd?: number; run?: boolean }
  | { press: true; dur?: number; fwd?: number }
  | { labWave: number };

export interface Script {
  name: string;
  start: { x: number; z: number; yaw: number; mode: PlayerMode; pitch?: number };
  steps: Step[];
}

const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export const SCRIPTS: Script[] = [
  // 1: from spawn up the pier steps, out along the deck, look down through the gaps, and back.
  {
    name: 'pier',
    start: { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw, mode: 'walk' },
    steps: [
      { goto: [PIER.rootX + 6.5, PIER.z - 5], pitch: -0.12 },
      { goto: [PIER.rootX + 5.2, PIER.z], tol: 0.4, pitch: -0.2 },
      { goto: [PIER.rootX - 18, PIER.z], pitch: -0.05 },
      { look: -0.6, pitch: -0.75, dur: 2.2, rel: true },
      { look: 0.6, pitch: -0.1, dur: 1.6, rel: true },
      { goto: [PIER.rootX - 4, PIER.z], pitch: -0.1 },
      { goto: [PIER.rootX + 5.5, PIER.z], pitch: -0.3 },
      { goto: [SPAWN.x + 4, SPAWN.z + 6], pitch: -0.2 },
    ],
  },
  // 2: from the sand down into the water, wade out, slide onto the board and paddle out.
  {
    name: 'water',
    start: { x: 16, z: 6, yaw: Math.PI / 2, mode: 'walk', pitch: -0.2 },
    steps: [
      { goto: [2, 4], pitch: -0.35 },
      { goto: [-4, 3], pitch: -0.25 },
      { goto: [-9, 2], pitch: -0.72 },
      { goto: [-14, 1], pitch: -0.1 },
      { goto: [-40, -6], pitch: -0.12, max: 40 },
    ],
  },
  // 3: paddling in the lineup, looking at the peak.
  {
    name: 'lineup',
    start: { x: -104, z: -62, yaw: yawTo(PEAK.x - -104, PEAK.z + 10 - -62), mode: 'paddle', pitch: -0.3 },
    steps: [{ goto: [PEAK.x + 6, PEAK.z + 14], pitch: -0.3, max: 60 }],
  },
  // 4: at the peak: a (lab) swell comes from behind, paddle hard, pop up once it has you.
  {
    name: 'catch',
    start: { x: PEAK.x + 4, z: PEAK.z + 6, yaw: yawTo(1, 0.25), mode: 'paddle', pitch: -0.2 },
    steps: [
      { wait: 1.2, pitch: -0.2 },
      { wait: 2.6, pitch: -0.25, fwd: 1, run: true },
      { press: true, dur: 1.4, fwd: 1 },
      { wait: 0.8, pitch: -0.3, fwd: 0 },
      { look: 0, pitch: -0.95, dur: 1.8, rel: true },
      { wait: 3, pitch: -0.2, fwd: 0 },
    ],
  },
  // 5: walking slowly on dry sand, looking down at the feet.
  {
    name: 'feet',
    start: { x: 22, z: 16, yaw: Math.PI / 2 + 0.3, mode: 'walk', pitch: -0.9 },
    steps: [
      { wait: 0.6, pitch: -1.08 },
      { wait: 4, pitch: -1.08, fwd: 0.6 },
      { wait: 2, pitch: -1.08 },
    ],
  },
  // 6: carrying the board along the beach toward the pier, looking ahead.
  {
    name: 'carry',
    start: { x: 20, z: 4, yaw: yawTo(-0.3, 1), mode: 'walk', pitch: -0.12 },
    steps: [{ goto: [12, 40], pitch: -0.12 }],
  },
];

function lookAt(out: Intent, ty: number, tp: number, yaw: number, pitch: number, k: number) {
  out.lookX = -wrapAngle(ty - yaw) * k;
  out.lookY = -(tp - pitch) * k;
}

export class ScriptRunner {
  script: Script | null = null;
  private i = 0;
  private t = 0;
  private yaw0 = 0;
  done = false;
  /** Set when a step asks for a lab wave (metres behind the player); the owner consumes it. */
  labWave = 0;

  start(s: Script) {
    this.script = s;
    this.i = 0;
    this.t = 0;
    this.done = false;
  }

  stop() {
    this.script = null;
  }

  /** Fill the intent for this frame. `yaw`/`pitch` are the current view, `x`/`z` the body. */
  step(dt: number, x: number, z: number, yaw: number, pitch: number, out: Intent) {
    out.fwd = 0;
    out.side = 0;
    out.run = false;
    out.lookX = 0;
    out.lookY = 0;
    out.action = false;
    out.actionHeld = false;
    const s = this.script;
    if (!s || this.i >= s.steps.length) {
      this.done = true;
      return out;
    }
    const st = s.steps[this.i];
    if (this.t === 0) this.yaw0 = yaw;
    this.t += dt;
    const k = Math.min(1, 3.5 * dt);
    let next = false;
    if ('goto' in st) {
      const dx = st.goto[0] - x;
      const dz = st.goto[1] - z;
      const d = Math.hypot(dx, dz);
      lookAt(out, yawTo(dx, dz), st.pitch ?? 0, yaw, pitch, k);
      // Walk once roughly facing the target (turn first, like a person would).
      const facing = Math.abs(wrapAngle(yawTo(dx, dz) - yaw)) < 0.9;
      out.fwd = facing ? Math.min(1, d / 0.6) : 0;
      out.run = !!st.run;
      next = d < (st.tol ?? 0.6) || this.t > (st.max ?? 90);
    } else if ('look' in st) {
      const ty = st.rel ? this.yaw0 + st.look : st.look;
      lookAt(out, ty, st.pitch, yaw, pitch, k);
      next = this.t >= st.dur;
    } else if ('wait' in st) {
      lookAt(out, yaw, st.pitch ?? pitch, yaw, pitch, k);
      out.lookX = 0;
      out.fwd = st.fwd ?? 0;
      out.run = !!st.run;
      next = this.t >= st.wait;
    } else if ('labWave' in st) {
      this.labWave = st.labWave;
      next = true;
    } else if ('press' in st) {
      out.action = true;
      out.actionHeld = true;
      out.fwd = st.fwd ?? 0;
      out.run = true;
      next = this.t >= (st.dur ?? 0.1);
    }
    if (next) {
      this.i++;
      this.t = 0;
    }
    return out;
  }
}
