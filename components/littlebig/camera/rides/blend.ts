// Camera transitions between modes (D1): pure math on three's Vector3 / Quaternion, no renderer.
//
// A transition blends FROM a coasting snapshot of the camera as it was when the switch happened (it
// carries on with the velocity and turn it had, easing to a stop, so the hand-over never freezes a
// moving camera) TO the live pose of the new mode (a ride's pose keeps moving under it). The eased
// progress runs 0 → 1 with zero velocity at both ends (smootherstep), so the camera leaves the old
// motion and joins the new one without a jolt. Positions travel round the planet centre (the
// direction slerped, the altitude interpolated in log space, plus a hop on long arcs), never through
// the planet; orientations slerp; the lens (FOV, vertical shift) lerps.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { R } from '../../world/config';

/** What the camera shows: position, orientation (three camera convention: looks down −Z), lens. */
export interface FramePose {
  pos: Vector3;
  quat: Quaternion;
  /**
   * The point it looks at, on its axis (the subject, or where the view ray meets the planet): a
   * transition interpolates it, so the camera keeps looking at the world on the way, never off into
   * space.
   */
  look: Vector3;
  /** Vertical FOV, degrees. */
  fov: number;
  /** Vertical lens shift (fraction of the frame height, ≥ 0; camera/model.ts lensShift). */
  shift: number;
}

export function createFramePose(): FramePose {
  return { pos: new Vector3(), quat: new Quaternion(), look: new Vector3(), fov: 50, shift: 0 };
}

export function copyFramePose(out: FramePose, a: FramePose): FramePose {
  out.pos.copy(a.pos);
  out.quat.copy(a.quat);
  out.look.copy(a.look);
  out.fov = a.fov;
  out.shift = a.shift;
  return out;
}

const _lx = new Vector3();
const _ly = new Vector3();
const _lz = new Vector3();
const _lt = new Vector3();
const _lm = new Matrix4();

/**
 * Orientation looking along unit `dir`, with `upRef` as the up hint (rolled by `roll` rad about the
 * view axis, + = counter-clockwise), into q. Three's camera looks down −Z with +Y up.
 */
export function lookQuat(dir: Vector3, upRef: Vector3, roll: number, q: Quaternion): Quaternion {
  _lz.copy(dir).negate();
  _lx.crossVectors(upRef, _lz);
  if (_lx.lengthSq() < 1e-10) {
    // Looking along the up hint: any perpendicular will do.
    _lx.set(Math.abs(_lz.x) < 0.9 ? 1 : 0, Math.abs(_lz.x) < 0.9 ? 0 : 1, 0).addScaledVector(_lz, -(Math.abs(_lz.x) < 0.9 ? _lz.x : _lz.y));
  }
  _lx.normalize();
  _ly.crossVectors(_lz, _lx);
  if (roll !== 0) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    _lt.copy(_lx).multiplyScalar(c).addScaledVector(_ly, s);
    _ly.multiplyScalar(c).addScaledVector(_lx, -s);
    _lx.copy(_lt);
  }
  _lm.makeBasis(_lx, _ly, _lz);
  return q.setFromRotationMatrix(_lm);
}

/**
 * The look point of a camera at `pos` with orientation `quat`: where its axis meets the sea-level
 * sphere, or (looking above the horizon) a point at the horizon's distance (≥ 20 m). Into out.
 */
export function lookPointOf(pos: Vector3, quat: Quaternion, out: Vector3): Vector3 {
  _lt.set(0, 0, -1).applyQuaternion(quat);
  const b = pos.dot(_lt);
  const c = pos.lengthSq() - R * R;
  const disc = b * b - c;
  let t = disc > 0 ? -b - Math.sqrt(disc) : -1;
  if (!(t > 0)) t = Math.max(20, Math.sqrt(Math.max(0, c)));
  return out.copy(pos).addScaledVector(_lt, t);
}

/** Smootherstep: 0 → 1 with zero first and second derivatives at both ends. */
export function ease(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Length (s) of a transition that moves the eye `dist` metres round an arc of `ang` radians about
 * the planet centre: 1.2 s for a hop next door, growing with the log of the distance, 2 s at most
 * (V2 §4: ≈ 1.2–2 s). Reduced motion: 40 % slower (BRIEF §1: slower, critically damped moves).
 */
export function transitionDuration(dist: number, ang: number, reduced: boolean): number {
  const d = 1.2 + 0.16 * Math.log2(1 + Math.max(0, dist) / 12) + 0.25 * Math.min(1, ang);
  return Math.min(2, Math.max(1.2, d)) * (reduced ? 1.4 : 1);
}

/** Lowest altitude (m above sea level) the arc interpolates in log space from. */
const ALT_FLOOR = 0.25;

const _a = new Vector3();
const _b = new Vector3();
const _ax = new Vector3();
const _look = new Vector3();
const _up = new Vector3();
const _q = new Quaternion();

/**
 * Round the planet centre from a to b at e (0…1): the direction slerped, the distance from the
 * centre interpolated (in log height above sea level when `logH`), plus `lift` log units there.
 */
function around(a: Vector3, b: Vector3, e: number, lift: number, logH: boolean, out: Vector3): Vector3 {
  const ra = a.length();
  const rb = b.length();
  if (ra < 1e-6 || rb < 1e-6) return out.lerpVectors(a, b, e);
  _a.copy(a).divideScalar(ra);
  _b.copy(b).divideScalar(rb);
  const ang = Math.acos(Math.min(1, Math.max(-1, _a.dot(_b))));
  if (ang < 1e-6) out.copy(_a);
  else {
    _ax.crossVectors(_a, _b);
    if (_ax.lengthSq() < 1e-18) {
      // Antipodal: any great circle will do; pick one through a stable perpendicular.
      _ax.set(Math.abs(_a.x) < 0.9 ? 1 : 0, Math.abs(_a.x) < 0.9 ? 0 : 1, 0).cross(_a);
    }
    _ax.normalize();
    out.copy(_a).applyAxisAngle(_ax, ang * e);
  }
  let r: number;
  if (e <= 0) r = ra;
  else if (e >= 1) r = rb;
  else if (logH) {
    const ha = Math.max(ALT_FLOOR, ra - R);
    const hb = Math.max(ALT_FLOOR, rb - R);
    r = R + Math.exp(Math.log(ha) + (Math.log(hb) - Math.log(ha)) * e + lift);
  } else r = ra + (rb - ra) * e;
  return out.multiplyScalar(r);
}

/**
 * The transition pose at eased progress e (0…1) from a to b, into out (may alias neither input).
 * Positions travel round the planet centre: the direction slerps, the altitude above sea level is
 * interpolated in log space and lifted by the `lift` profile (LiftProfile), so a long move arcs up
 * over the planet and a short one hops over what lies between, instead of skimming or crossing it. The look point travels the same way and the
 * camera keeps looking at it (its up slerping from a's to b's), so the view stays on the world the
 * whole way and lands exactly on each end's orientation. `eLook` (≥ e) lets the gaze lead the
 * eye: it turns to where it is going a little before it gets there. The lens lerps.
 */
export function blendPose(a: FramePose, b: FramePose, e: number, lift: LiftProfile, out: FramePose, eLook = e): FramePose {
  around(a.pos, b.pos, e, lift.at(e), true, out.pos);
  around(a.look, b.look, eLook, 0, false, _look);
  _q.slerpQuaternions(a.quat, b.quat, e);
  _look.sub(out.pos);
  if (e <= 0) out.quat.copy(a.quat);
  else if (e >= 1) out.quat.copy(b.quat);
  else if (_look.lengthSq() < 1e-6) out.quat.copy(_q);
  else {
    _up.set(0, 1, 0).applyQuaternion(_q);
    lookQuat(_look.normalize(), _up, 0, out.quat);
  }
  out.look.copy(_look).add(out.pos);
  out.fov = a.fov + (b.fov - a.fov) * e;
  out.shift = a.shift + (b.shift - a.shift) * e;
  return out;
}

/** The arc's position at e with a given lift (log units), no look, no lens. Into out. */
export function arcPoint(a: Vector3, b: Vector3, e: number, lift: number, out: Vector3): Vector3 {
  return around(a, b, e, lift, true, out);
}

const LIFT_N = 48;
const _need = new Float64Array(LIFT_N + 1);
const _hc = new Vector3();

/**
 * A transition's lift along its arc: log-altitude units added at progress e (0 at both ends, so the
 * ends are exact). Either a plain sin-shaped hop, or planned to clear what lies between: each of 48
 * samples asks for the lift that puts the arc over `floor(dir)` there; the profile ramps up toward
 * an obstacle and down after it (slope-limited), is smoothed, and is read back as a C1 curve. A
 * street-level hop over a block climbs just over its roofs and settles, instead of a symmetric
 * sin-hop tall enough for the worst sample (which flung a downtown start 400 m up).
 */
export class LiftProfile {
  readonly v = new Float64Array(LIFT_N + 1);

  /** A plain hop: `hop` log units at mid-way, sin-shaped. */
  hop(hop: number): this {
    for (let i = 0; i <= LIFT_N; i++) this.v[i] = hop * Math.sin((Math.PI * i) / LIFT_N);
    return this;
  }

  /** At least a sin hop of `min`, and enough to clear floor(dir) (m above sea level) all the way. */
  plan(a: Vector3, b: Vector3, floor: (dir: Vector3) => number, min: number): this {
    const v = this.v;
    for (let i = 0; i <= LIFT_N; i++) {
      const e = i / LIFT_N;
      around(a, b, e, 0, true, _hc);
      const base = Math.max(ALT_FLOOR, _hc.length() - R);
      // (+6 %: what lies between two samples, a building edge just off a sample.)
      const f = floor(_hc.normalize()) * 1.06;
      _need[i] = Math.max(min * Math.sin(Math.PI * e), f > base ? Math.log(f / base) : 0);
    }
    _need[0] = _need[LIFT_N] = 0;
    // Widen each need by two samples (what lies between samples; the smoothing below eats an edge).
    for (let pass = 0; pass < 2; pass++) {
      let prev = _need[0];
      for (let i = 1; i < LIFT_N; i++) {
        const cur = _need[i];
        _need[i] = Math.max(prev, cur, _need[i + 1]);
        prev = cur;
      }
    }
    // Ramps: never steeper than SLOPE per sample, up toward an obstacle and down after it.
    const SLOPE = 0.2;
    v[0] = 0;
    for (let i = 1; i <= LIFT_N; i++) v[i] = Math.max(_need[i], v[i - 1] - SLOPE);
    for (let i = LIFT_N - 1; i >= 0; i--) v[i] = Math.max(v[i], v[i + 1] - SLOPE);
    // Smooth, back above the needs, smooth once more; pinned to 0 at the ends, capped (×33).
    for (let k = 0; k < 4; k++) {
      if (k === 3) for (let i = 0; i <= LIFT_N; i++) v[i] = Math.max(v[i], _need[i]);
      let prev = v[0];
      for (let i = 1; i < LIFT_N; i++) {
        const cur = v[i];
        v[i] = (prev + 2 * cur + v[i + 1]) / 4;
        prev = cur;
      }
    }
    v[0] = v[LIFT_N] = 0;
    for (let i = 0; i <= LIFT_N; i++) v[i] = Math.min(3.5, v[i]);
    return this;
  }

  /** The lift at progress e (Catmull–Rom between samples: C1). */
  at(e: number): number {
    if (e <= 0 || e >= 1) return 0;
    const x = e * LIFT_N;
    const i = Math.min(LIFT_N - 1, Math.floor(x));
    const t = x - i;
    const v = this.v;
    const p0 = v[Math.max(0, i - 1)];
    const p1 = v[i];
    const p2 = v[i + 1];
    const p3 = v[Math.min(LIFT_N, i + 2)];
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  /** The largest lift (log units). */
  get peak(): number {
    let m = 0;
    for (let i = 0; i <= LIFT_N; i++) m = Math.max(m, this.v[i]);
    return m;
  }
}

/**
 * Hop (log-altitude units at mid-arc) for a move of `ang` radians round the planet: none next door,
 * a gentle lift across a town, up to 1 (×2.7 the altitude) half way round the world. Like the
 * explore fly-to's.
 */
export function hopFor(ang: number): number {
  return Math.min(1, Math.max(0, ang - 0.05) * 1.1);
}

/**
 * A coasting snapshot: the camera as it was at the switch, carrying on with its linear and angular
 * velocity, both decaying at rate k (1/s), so it glides to a stop at p0 + v / k.
 */
export class Coast {
  readonly p0 = new Vector3();
  readonly look0 = new Vector3();
  readonly v = new Vector3();
  readonly q0 = new Quaternion();
  readonly axis = new Vector3(0, 1, 0);
  /** Angular speed (rad/s) about `axis` (world). */
  rate = 0;
  fov = 50;
  shift = 0;
  k = 3;
  private readonly _q = new Quaternion();

  /**
   * Snapshot `pose` moving at `vel` (m/s), turning at `rate` (rad/s) about `axis`. It glides on at its
   * own speed (never a freeze: Esc in the middle of a 900 m/s trip used to stop the camera dead) and
   * bleeds it off at rate k (1/s) — faster when that would glide further than `maxGlide` m.
   */
  capture(pose: FramePose, vel: Vector3, axis: Vector3, rate: number, k = 3, maxGlide = 20): void {
    this.p0.copy(pose.pos);
    this.look0.copy(pose.look);
    this.q0.copy(pose.quat);
    this.fov = pose.fov;
    this.shift = pose.shift;
    const sp = vel.length();
    this.v.copy(vel);
    if (!Number.isFinite(sp) || sp > 5000) this.v.set(0, 0, 0);
    this.k = Math.max(k, this.v.length() / Math.max(1, maxGlide));
    this.axis.copy(axis);
    this.rate = Number.isFinite(rate) ? Math.max(-3, Math.min(3, rate)) : 0;
  }

  /** Fraction of the total glide covered after t seconds. */
  private frac(t: number): number {
    return 1 - Math.exp(-this.k * Math.max(0, t));
  }

  /** The snapshot t seconds after the capture, into out. */
  at(t: number, out: FramePose): FramePose {
    const f = this.frac(t) / this.k;
    out.pos.copy(this.p0).addScaledVector(this.v, f);
    if (this.rate !== 0) {
      this._q.setFromAxisAngle(this.axis, this.rate * f);
      out.quat.multiplyQuaternions(this._q, this.q0);
      // The look point turns with it (about the eye).
      out.look.copy(this.look0).sub(this.p0).applyQuaternion(this._q).add(out.pos);
    } else {
      out.quat.copy(this.q0);
      out.look.copy(this.look0).addScaledVector(this.v, f);
    }
    out.fov = this.fov;
    out.shift = this.shift;
    return out;
  }

  /** Where the glide comes to rest (t → ∞), into out. */
  rest(out: FramePose): FramePose {
    return this.at(1e6, out);
  }
}

const _dq = new Quaternion();

/**
 * A transition's clock (refine 2): time t (s) of `dur` → progress u (0 … 1) along a velocity profile
 * that ramps up over `tin` s (a smoothstep: zero acceleration at both ends of the ramp), cruises, and
 * ramps down over `tout` s. A short ramp-in, so a click is answered at once (the old smootherstep
 * spent its first 0.6 s of a 3 s trip barely moving: from orbit it read as ignored); a long ramp-out,
 * so it settles softly. The ramps shrink in proportion when they would overlap.
 */
export function clockU(t: number, dur: number, tin: number, tout: number): number {
  if (t <= 0) return 0;
  if (t >= dur) return 1;
  const k = Math.min(1, dur / Math.max(1e-6, tin + tout));
  const a = tin * k;
  const b = tout * k;
  const total = dur - a / 2 - b / 2;
  // ∫ smoothstep = x³ − x⁴/2 over a ramp of unit length.
  const I = (x: number) => x * x * x - (x * x * x * x) / 2;
  let A: number;
  if (t < a) A = a * I(t / a);
  else if (t <= dur - b) A = a / 2 + (t - a);
  else A = total - b * I((dur - t) / b);
  return Math.min(1, Math.max(0, A / total));
}

/** The clock's peak rate (du/dt at the cruise, 1/s). */
export function clockPeak(dur: number, tin: number, tout: number): number {
  const k = Math.min(1, dur / Math.max(1e-6, tin + tout));
  return 1 / (dur - (tin * k) / 2 - (tout * k) / 2);
}

const _fq = new Quaternion();
const _fa = new Vector3();
const _fw = new Vector3();

/**
 * The drawn camera's orientation as a follower of the wanted one (refine 2): limited in angular rate
 * AND angular acceleration, so a turn always eases in and out — the rate-only cap of round 1 held a
 * fast pan at its limit and then let go of it within a frame (a hard stop in rotation). The wanted
 * orientation's own turn is fed forward (a steady pan is followed with no lag); the error closes
 * along a braking curve (√(2·acc·err), and linearly near zero: no chatter, no overshoot).
 */
export class TurnFollower {
  readonly q = new Quaternion();
  /** Angular velocity (world axis × rad/s). */
  readonly w = new Vector3();
  valid = false;
  private readonly prevT = new Quaternion();
  /** Error-closing gain near zero (1/s). */
  k = 7;

  reset(q: Quaternion): void {
    this.q.copy(q);
    this.prevT.copy(q);
    this.w.set(0, 0, 0);
    this.valid = true;
  }

  /** The angle (rad) between what is drawn and the wanted orientation `t`. */
  lag(t: Quaternion): number {
    return this.valid ? this.q.angleTo(t) : 0;
  }

  /**
   * Follow `target` for dt s within `rate` (rad/s) and `acc` (rad/s²); Infinity for either passes
   * the target straight through (the state still tracks it, so switching the limits on never jumps).
   * Returns the drawn orientation (this.q).
   */
  step(target: Quaternion, dt: number, rate: number, acc: number): Quaternion {
    if (!this.valid) {
      this.reset(target);
      return this.q;
    }
    if (!(dt > 0)) return this.q;
    // The target's own turn this frame (fed forward).
    const rT = angularVelocity(this.prevT, target, dt, _fa);
    _fw.copy(_fa).multiplyScalar(Number.isFinite(rT) ? rT : 0);
    this.prevT.copy(target);
    if (!Number.isFinite(rate) && !Number.isFinite(acc)) {
      this.q.copy(target);
      this.w.copy(_fw);
      return this.q;
    }
    if (_fw.length() > rate) _fw.setLength(rate);
    // The error: the rotation from what is drawn to the target (world axis, angle in [0, π]).
    _fq.copy(this.q).invert().premultiply(target);
    if (_fq.w < 0) _fq.set(-_fq.x, -_fq.y, -_fq.z, -_fq.w);
    const s = Math.sqrt(_fq.x * _fq.x + _fq.y * _fq.y + _fq.z * _fq.z);
    const err = 2 * Math.atan2(s, _fq.w);
    if (s > 1e-9) {
      const c = Math.min(Math.sqrt(2 * acc * err * 0.8), this.k * err);
      _fw.x += (_fq.x / s) * c;
      _fw.y += (_fq.y / s) * c;
      _fw.z += (_fq.z / s) * c;
    }
    if (_fw.length() > rate) _fw.setLength(rate);
    // Accelerate toward that angular velocity, at most acc·dt this frame.
    _fw.sub(this.w);
    const dv = _fw.length();
    const max = acc * dt;
    if (dv > max) _fw.multiplyScalar(max / dv);
    this.w.add(_fw);
    const r = this.w.length();
    if (r * dt > 1e-9) {
      _fq.setFromAxisAngle(_fa.copy(this.w).divideScalar(r), r * dt);
      this.q.premultiply(_fq).normalize();
    }
    // Settled on it (and turning with it): exact.
    if (this.q.angleTo(target) < 2e-4 && err < 2e-3) this.q.copy(target);
    return this.q;
  }
}

/**
 * Angular velocity from two orientations dt apart: writes the world axis into outAxis, returns the
 * rate (rad/s, ≥ 0). Zero for dt ≤ 0.
 */
export function angularVelocity(prev: Quaternion, cur: Quaternion, dt: number, outAxis: Vector3): number {
  if (dt <= 0) return 0;
  // cur = dq · prev  ⇒  dq = cur · prev⁻¹ (world-frame rotation)
  _dq.copy(prev).invert().premultiply(cur);
  if (_dq.w < 0) {
    _dq.x = -_dq.x;
    _dq.y = -_dq.y;
    _dq.z = -_dq.z;
    _dq.w = -_dq.w;
  }
  const s = Math.sqrt(_dq.x * _dq.x + _dq.y * _dq.y + _dq.z * _dq.z);
  if (s < 1e-9) return 0;
  const ang = 2 * Math.atan2(s, _dq.w);
  outAxis.set(_dq.x / s, _dq.y / s, _dq.z / s);
  return ang / dt;
}
