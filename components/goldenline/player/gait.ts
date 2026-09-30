// Procedural walking: a speed-driven gait cycle times the steps, each foot swings on its own
// clock to a target predicted for its landing, and lands exactly where it was aimed. The landing
// frame is when the footprint is splatted, at the planted foot's own position and heading, so
// prints sit exactly under the feet. When the body stops, small settling steps square the feet.

import { Vector3 } from 'three/webgpu';
import { ease } from './rigmath';

export interface Foot {
  /** Ground contact centre (mid-foot) and heading (yaw, layout convention). */
  pos: Vector3;
  yaw: number;
  swinging: boolean;
  t: number;
  dur: number;
  from: Vector3;
  to: Vector3;
  fromYaw: number;
  toYaw: number;
  /** Swing height of this step (m). */
  lift: number;
  /** Output for the renderer: lifted position, pitch (rad, + = toes up) and toe bend. */
  out: Vector3;
  pitch: number;
  toe: number;
  /** Set on the frame the foot lands; the caller consumes it. */
  landed: boolean;
}

function makeFoot(): Foot {
  return {
    pos: new Vector3(),
    yaw: 0,
    swinging: false,
    t: 0,
    dur: 0.4,
    from: new Vector3(),
    to: new Vector3(),
    fromYaw: 0,
    toYaw: 0,
    lift: 0.08,
    out: new Vector3(),
    pitch: 0,
    toe: 0,
    landed: false,
  };
}

export type GroundFn = (x: number, z: number) => number;

const _t = new Vector3();

export class Gait {
  readonly feet: [Foot, Foot] = [makeFoot(), makeFoot()]; // 0 = left, 1 = right
  phase = 0;
  /** Half the lateral stance width. */
  halfWidth = 0.1;
  private settleTimer = 0;
  private lastSwing = 1;

  /** Put both feet square under a body at (x, z) facing `yaw`. */
  reset(x: number, z: number, yaw: number, ground: GroundFn) {
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      this.neutral(i, x, z, yaw, 0, 0, _t);
      f.pos.set(_t.x, ground(_t.x, _t.z), _t.z);
      f.yaw = yaw;
      f.swinging = false;
      f.out.copy(f.pos);
      f.pitch = 0;
      f.toe = 0;
      f.landed = false;
    }
    this.phase = 0;
  }

  /** Neutral foot spot for a body at (x, z), heading yaw, moving at (vx, vz). */
  private neutral(i: number, x: number, z: number, yaw: number, vx: number, vz: number, out: Vector3) {
    const side = i === 0 ? -1 : 1;
    // Body right = (cos yaw, 0, -sin yaw) for forward = (-sin yaw, 0, -cos yaw).
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    return out.set(x + rx * side * this.halfWidth + vx, 0, z + rz * side * this.halfWidth + vz);
  }

  /**
   * Advance. `speed` is the planar body speed; (vx, vz) its velocity; `stride` the step length
   * at this speed. The body is at (x, z) heading `yaw`. `lead` scales the forward reach.
   */
  update(dt: number, x: number, z: number, yaw: number, vx: number, vz: number, stride: number, ground: GroundFn, liftScale: number) {
    const speed = Math.hypot(vx, vz);
    const f0 = this.feet[0];
    const f1 = this.feet[1];
    f0.landed = false;
    f1.landed = false;
    const cadence = speed > 0.05 ? speed / (2 * stride) : 0; // cycles / s
    const prev = this.phase;
    this.phase = (this.phase + cadence * dt) % 1;
    // Swing takes ~40% of the cycle.
    const swingDur = cadence > 0 ? Math.min(0.55, Math.max(0.2, 0.4 / cadence)) : 0.32;
    if (cadence > 0) {
      if (crossed(prev, this.phase, 0) && !f0.swinging) this.startSwing(0, x, z, yaw, vx, vz, stride, swingDur, ground, liftScale);
      if (crossed(prev, this.phase, 0.5) && !f1.swinging) this.startSwing(1, x, z, yaw, vx, vz, stride, swingDur, ground, liftScale);
      this.settleTimer = 0;
    } else if (!f0.swinging && !f1.swinging) {
      // Standing: square the feet when either strays from its neutral spot.
      this.settleTimer += dt;
      if (this.settleTimer > 0.12) {
        let worst = -1;
        let worstD = 0.11;
        for (let i = 0; i < 2; i++) {
          const f = this.feet[i];
          this.neutral(i, x, z, yaw, 0, 0, _t);
          const d = Math.hypot(_t.x - f.pos.x, _t.z - f.pos.z) + Math.abs(wrap(yaw - f.yaw)) * 0.2;
          if (d > worstD) {
            worstD = d;
            worst = i;
          }
        }
        if (worst >= 0) {
          // Alternate feet when both need it.
          if (worst === this.lastSwing && worstD < 0.2) worst = 1 - worst;
          this.startSwing(worst as 0 | 1, x, z, yaw, 0, 0, 0, 0.3, ground, liftScale * 0.6);
          this.settleTimer = 0;
        }
      }
    }
    for (let i = 0; i < 2; i++) this.advance(this.feet[i], dt, ground);
  }

  private startSwing(i: 0 | 1, x: number, z: number, yaw: number, vx: number, vz: number, stride: number, dur: number, ground: GroundFn, liftScale: number) {
    const f = this.feet[i];
    const speed = Math.hypot(vx, vz);
    // Land ahead of where the body will be at touchdown, so the stance phase is symmetric.
    const lead = dur + (speed > 0.05 ? (0.55 * stride) / speed : 0);
    this.neutral(i, x, z, yaw, vx * lead, vz * lead, _t);
    f.from.copy(f.pos);
    f.to.set(_t.x, ground(_t.x, _t.z), _t.z);
    f.fromYaw = f.yaw;
    // Feet splay out a little.
    f.toYaw = yaw + (i === 0 ? 0.07 : -0.07);
    f.t = 0;
    f.dur = dur;
    f.lift = (0.035 + 0.05 * Math.min(1, speed / 1.5) + 0.03 * Math.min(1, Math.max(0, speed - 1.5) / 2)) * liftScale;
    f.swinging = true;
    this.lastSwing = i;
  }

  private advance(f: Foot, dt: number, ground: GroundFn) {
    if (!f.swinging) {
      f.out.copy(f.pos);
      f.pitch = 0;
      f.toe = 0;
      return;
    }
    f.t = Math.min(1, f.t + dt / f.dur);
    const s = ease(f.t);
    f.pos.lerpVectors(f.from, f.to, s);
    // Re-sample the ground along the path so the swing follows slopes and steps.
    const g = ground(f.pos.x, f.pos.z);
    const base = Math.max(g, f.from.y + (f.to.y - f.from.y) * s);
    f.yaw = f.fromYaw + wrap(f.toYaw - f.fromYaw) * s;
    const arc = Math.sin(Math.PI * Math.min(1, f.t * 1.08));
    f.out.set(f.pos.x, base + f.lift * arc, f.pos.z);
    // Heel-off / toe-off early, heel strike (toes up) at the end.
    const off = Math.max(0, 1 - f.t / 0.35);
    const strike = Math.max(0, (f.t - 0.6) / 0.4);
    f.pitch = -0.42 * off * off + 0.2 * Math.sin(Math.PI * Math.min(1, strike)) * (f.t < 0.97 ? 1 : 0);
    f.toe = 0.55 * off * off;
    if (f.t >= 1) {
      f.swinging = false;
      f.pos.copy(f.to);
      f.pos.y = ground(f.pos.x, f.pos.z);
      f.yaw = f.toYaw;
      f.out.copy(f.pos);
      f.pitch = 0;
      f.toe = 0;
      f.landed = true;
    }
  }
}

/** Did the cycle phase pass `a` going from `prev` to `now` (with wrap-around)? */
function crossed(prev: number, now: number, a: number) {
  return (prev < a && now >= a) || (prev > now && (a > prev || now >= a));
}

function wrap(a: number) {
  const t = Math.PI * 2;
  a = (a + Math.PI) % t;
  if (a < 0) a += t;
  return a - Math.PI;
}
