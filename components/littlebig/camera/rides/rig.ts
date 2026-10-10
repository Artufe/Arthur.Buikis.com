// The ride rigs (D1, V2 §4): where the camera sits while it rides a Trackable. Pure math on three's
// Vector3 / Quaternion (no renderer, no world: the floor and occlusion come in through RideEnv).
//
//   chase      behind and above, looking past the target along its travel. The rig is attached to
//              the target (no positional lag: the subject stays put in the frame); only its heading
//              is smoothed, by a critically damped angular spring, so a turn swings the camera round
//              instead of whipping it, and it banks subtly with a plane. Drag orbits round the
//              target, the wheel sets the distance.
//   eyes       first person at the pose (a walker's eyes), the heading smoothed so turns never snap;
//              drag looks around (and drifts back to ahead after a while); the wheel pulls back
//              over the shoulder into a short chase and in again. Head bob is the owner's (it is in
//              the pose); with reduced motion it is filtered out.
//   alongside  floating beside a station or satellite with the planet below: from above and to the
//              side by default (the station against the planet's disc, space beyond the limb); drag
//              orbits (up to straight down: the cupola view), the wheel sets the distance.
//
// Every smoothed quantity is an exact critically damped spring (camera/model.ts springStep), so the
// rig is frame-rate independent and stable for any dt (the shot tool steps it in big strides).

import { Vector3 } from 'three';
import type { RideView, TrackPose } from '../../core/contracts';
import { R } from '../../world/config';
import { springStep } from '../model';
import { type FramePose, lookQuat } from './blend';

export { lookQuat };

const DEG = Math.PI / 180;

export interface RideEnv {
  /**
   * Lowest height (m above sea level) the camera may take above unit `dir`: terrain or water, roofs.
   * `h` (optional, v2-BF): the camera's height, so a facade taller than it beside it is left to `wall`.
   */
  floor(dir: Vector3, h?: number): number;
  /** Fraction (0…1) of the segment from a to b that is clear of buildings, measured from a. */
  free(a: Vector3, b: Vector3): number;
  /**
   * Push a camera at unit dir, h m above sea level, out to r m from every facade taller than it.
   * Writes the resolved unit dir into out; true if it moved. Optional (outside the city: none).
   */
  wall?(dir: Vector3, h: number, r: number, out: Vector3): boolean;
  /** Reduced motion: no FOV kick, the eyes' bob filtered out, slower settling. */
  reduced: boolean;
}

/** Framing per view: default distance (m, from the bounding radius), its range, elevation, lens. */
export interface Framing {
  dist: number;
  minDist: number;
  maxDist: number;
  /** Default elevation of the camera above the target's horizontal plane (rad). */
  el: number;
  minEl: number;
  maxEl: number;
  /** Default yaw from straight behind (rad, + = round to the target's right). */
  yaw: number;
  fov: number;
}

export function framingFor(view: RideView, radius: number): Framing {
  const r = Math.max(0.3, radius);
  if (view === 'eyes') return { dist: 0, minDist: 0, maxDist: 9, el: 0, minEl: -75 * DEG, maxEl: 70 * DEG, yaw: 0, fov: 60 };
  if (view === 'alongside') {
    const d = Math.max(9, r * 2.4);
    return { dist: d, minDist: Math.max(3, r * 1.25), maxDist: Math.max(60, r * 9), el: 38 * DEG, minEl: -30 * DEG, maxEl: 88 * DEG, yaw: 62 * DEG, fov: 52 };
  }
  // Chase: a car ~7 m back, a bus ~12, a plane ~17; a little higher for the small ones.
  const d = Math.min(40, Math.max(6, r * 3.3));
  return { dist: d, minDist: Math.max(2.5, r * 1.5), maxDist: Math.max(30, r * 9), el: (r < 3 ? 17 : 13) * DEG, minEl: -8 * DEG, maxEl: 80 * DEG, yaw: 0, fov: 52 };
}

/** Horizon dip (rad below level) seen from h m above sea level. */
export function horizonDip(h: number): number {
  return Math.acos(R / (R + Math.max(0, h)));
}

/**
 * Camera elevation (rad) for an orbit framing at a target h m up: the framing's own, or more, so the
 * planet fills the lower ~45 % of the frame (looking down at the target by about the elevation; the
 * camera sits higher than the target and looks a little ahead of it, which lowers the horizon by a
 * few degrees more: hence the margin above the dip itself).
 */
export function elevationFor(el: number, h: number, fovDeg: number): number {
  return Math.max(el, horizonDip(h) + fovDeg * DEG * 0.06);
}

const _w = new Vector3();
const _wp = new Vector3();
const _wd = new Vector3();
/** Clearance (m) a third-person camera keeps from facades taller than it. */
export const WALL_CLEAR = 2.4;

/** Push a camera position out to `clear` m (WALL_CLEAR) from facades taller than it (env.wall), in place. */
export function keepOffWalls(pos: Vector3, env: RideEnv, clear = WALL_CLEAR): void {
  if (!env.wall) return;
  const r = pos.length();
  _t.copy(pos).divideScalar(r);
  if (env.wall(_t, r - R, clear, _w)) pos.copy(_w).multiplyScalar(r);
}

/** The eyes view's distance is log-scaled with this offset so it reaches exactly 0 (in the head). */
const EYES_LOG0 = 0.3;

const _up = new Vector3();
const _right = new Vector3();
const _back = new Vector3();
const _off = new Vector3();
const _look = new Vector3();
const _dir = new Vector3();
const _y = new Vector3();
const _t = new Vector3();
const _sp = [0, 0];

/** Signed angle (rad) from tangent a to tangent b about unit axis n (counter-clockwise seen from +n). */
function signedAngle(a: Vector3, b: Vector3, n: Vector3): number {
  _t.crossVectors(a, b);
  return Math.atan2(_t.dot(n), a.dot(b));
}

/** Project v onto the plane ⟂ unit n and normalise; falls back to `fb` (also projected) when degenerate. */
function tangent(v: Vector3, n: Vector3, fb: Vector3): Vector3 {
  v.addScaledVector(n, -v.dot(n));
  if (v.lengthSq() < 1e-10) {
    v.copy(fb).addScaledVector(n, -fb.dot(n));
    if (v.lengthSq() < 1e-10) v.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).addScaledVector(n, -(Math.abs(n.y) < 0.9 ? n.y : n.x));
  }
  return v.normalize();
}

export class RideRig {
  view: RideView = 'chase';
  radius = 1;
  framing: Framing = framingFor('chase', 1);
  /** User targets (set by input): yaw / elevation offsets from the framing (rad), log distance. */
  yawT = 0;
  pitchT = 0;
  logDistT = 0;
  /** Seconds since the user last moved the view (the eyes drift back to ahead after a while). */
  idle = 0;
  /**
   * Entry yaw (rad, the yaw's sense for the view): a ride starts framed from the side the camera
   * came from (the heading it had), held while the transition runs (`holdEntry`), then swings round
   * behind (or, in the eyes, back to ahead) on a slow critically damped spring.
   */
  entryYaw = 0;
  holdEntry = false;
  private entryVel = 0;
  /** Near plane the rig wants (m). */
  near = 0.1;
  /**
   * (D1f r2) 0 … 1: the heading follows the target this much more tightly (ω up to 9). The director
   * holds it at 1 while a transition flies in and eases it off after: a car that turned a corner on
   * the way left the heading spring a quarter turn behind, and it swung on for a second after landing.
   */
  stiff = 0;
  /** Distance from the camera to the target (m) after occlusion and floors. */
  camDist = 0;
  /** Smoothed state. */
  private readonly fwdS = new Vector3(0, 0, 1);
  private headVel = 0;
  private h = 0;
  private hVel = 0;
  private roll = 0;
  private rollVel = 0;
  private yaw = 0;
  private yawVel = 0;
  private pitch = 0;
  private pitchVel = 0;
  private logDist = 0;
  private logDistVel = 0;
  /** Distance cap from occlusion (m) and the floor's extra lift (m), both springs. */
  private occ = 10;
  private occVel = 0;
  private lift = 0;
  private liftVel = 0;
  /** (D1f r5) The facade push-out, sprung (world offset, m) and its rate. */
  private readonly wallOff = new Vector3();
  private readonly wallVel = new Vector3();
  private speedS = 0;
  readonly anchor = new Vector3();

  /** Log distance limits for the current framing. */
  get minLog(): number {
    return this.view === 'eyes' ? Math.log(EYES_LOG0) : Math.log(this.framing.minDist);
  }
  get maxLog(): number {
    return this.view === 'eyes' ? Math.log(this.framing.maxDist + EYES_LOG0) : Math.log(this.framing.maxDist);
  }

  /** Distance (m) for a log distance. */
  distOf(lg: number): number {
    return this.view === 'eyes' ? Math.max(0, Math.exp(lg) - EYES_LOG0) : Math.exp(lg);
  }

  /** Current distance (m) the rig is settling toward (0 = in the eyes). */
  get dist(): number {
    return this.distOf(this.logDist);
  }

  /** Start riding: framing for the view and radius, user offsets cleared, everything settled on `pose`. */
  begin(view: RideView, radius: number, pose: TrackPose, env: RideEnv, out: FramePose): void {
    this.view = view;
    this.radius = radius;
    this.framing = framingFor(view, radius);
    this.yawT = 0;
    this.pitchT = 0;
    this.entryYaw = 0;
    this.entryVel = 0;
    this.holdEntry = false;
    this.logDistT = view === 'eyes' ? Math.log(EYES_LOG0) : Math.log(this.framing.dist);
    this.settle(pose, env, out);
  }

  /** Snap every spring to rest on `pose` (deterministic shots; the start of a ride). */
  settle(pose: TrackPose, env: RideEnv, out: FramePose): void {
    _up.copy(pose.pos).normalize();
    this.fwdS.copy(pose.fwd);
    tangent(this.fwdS, _up, pose.up);
    this.headVel = 0;
    this.h = pose.pos.length() - R;
    this.hVel = 0;
    this.roll = this.bankOf(pose);
    this.rollVel = 0;
    this.yaw = this.yawT;
    this.pitch = this.pitchT;
    this.logDist = this.logDistT;
    this.yawVel = this.pitchVel = this.logDistVel = 0;
    this.occ = this.distOf(this.logDistT) * 1.5;
    this.occVel = 0;
    this.lift = 0;
    this.liftVel = 0;
    this.speedS = pose.speed;
    this.idle = 0;
    // Two passes: the first finds the occlusion cap and the floor lift, the second settles on them.
    this.pose(0, pose, env, out, true);
    this.pose(0, pose, env, out, true);
  }

  update(dt: number, pose: TrackPose, env: RideEnv, out: FramePose): void {
    this.pose(dt, pose, env, out, false);
  }

  /** Keep the occlusion spring inside [lo, hi] (velocity zeroed where the clamp bites). */
  private clampOcc(lo: number, hi: number): void {
    if (!(this.occ >= lo)) {
      this.occ = lo;
      this.occVel = Math.max(0, this.occVel || 0);
    } else if (this.occ > hi) {
      this.occ = hi;
      this.occVel = Math.min(0, this.occVel);
    }
  }

  /** Bank of a trackable (rad): its up rolled from the radial up about its travel. */
  private bankOf(pose: TrackPose): number {
    _up.copy(pose.pos).normalize();
    _dir.copy(pose.fwd);
    tangent(_dir, _up, pose.up);
    _right.crossVectors(_dir, _up);
    // up·right < 0: the body's up leans to the left side = a left bank (roll left).
    return Math.atan2(-pose.up.dot(_right), Math.max(1e-6, pose.up.dot(_up)));
  }

  private pose(dt: number, pose: TrackPose, env: RideEnv, out: FramePose, snap: boolean): void {
    const fr = this.framing;
    const reduced = env.reduced;
    _up.copy(pose.pos).normalize();

    // ── Heading: transport the smoothed heading to the target's up, then spring it toward its travel.
    tangent(this.fwdS, _up, pose.fwd);
    _dir.copy(pose.fwd);
    tangent(_dir, _up, this.fwdS);
    if (!snap && dt > 0) {
      const base = this.view === 'eyes' ? (reduced ? 3.2 : 4.5) : this.view === 'alongside' ? 1.6 : 3.2;
      const omega = base + (9 - base) * this.stiff;
      const err = -signedAngle(this.fwdS, _dir, _up);
      springStep(err, this.headVel, 0, omega, dt, _sp);
      this.headVel = _sp[1];
      // (Both angles are right-handed about up: rotate from the old error to the new one.)
      this.fwdS.applyAxisAngle(_up, _sp[0] - err);
      tangent(this.fwdS, _up, _dir);
    } else this.fwdS.copy(_dir);

    // ── Height: the target's altitude through a stiff spring (suspension, step bob); the eyes'
    // bob is the owner's, kept unless reduced motion asks for a level camera.
    const hT = pose.pos.length() - R;
    if (!snap && dt > 0) {
      const omega = this.view === 'eyes' ? (reduced ? 3 : 22) : 14;
      springStep(this.h, this.hVel, hT, omega, dt, _sp);
      this.h = _sp[0];
      this.hVel = _sp[1];
      // Never more than a few cm off on a fast climb (a plane taking off).
      if (Math.abs(this.h - hT) > 1.5) this.h = hT + Math.sign(this.h - hT) * 1.5;
    } else this.h = hT;
    this.anchor.copy(_up).multiplyScalar(R + this.h);

    // ── User offsets (drag / wheel targets) through springs; the eyes drift back to ahead.
    if (this.view === 'eyes' && !snap) {
      this.idle += dt;
      if (this.idle > 2.5) {
        const k = 1 - Math.exp(-dt * (reduced ? 0.6 : 0.9));
        this.yawT -= this.yawT * k;
        this.pitchT -= this.pitchT * k;
      }
    }
    this.pitchT = Math.max(fr.minEl - fr.el, Math.min(fr.maxEl - fr.el, this.pitchT));
    this.logDistT = Math.max(this.minLog, Math.min(this.maxLog, this.logDistT));
    if (!snap && dt > 0) {
      springStep(this.yaw, this.yawVel, this.yawT, 12, dt, _sp);
      this.yaw = _sp[0];
      this.yawVel = _sp[1];
      springStep(this.pitch, this.pitchVel, this.pitchT, 12, dt, _sp);
      this.pitch = _sp[0];
      this.pitchVel = _sp[1];
      springStep(this.logDist, this.logDistVel, this.logDistT, reduced ? 4.5 : 7, dt, _sp);
      this.logDist = _sp[0];
      this.logDistVel = _sp[1];
      this.speedS += (pose.speed - this.speedS) * (1 - Math.exp(-dt * 2));
    } else {
      this.yaw = this.yawT;
      this.pitch = this.pitchT;
      this.logDist = this.logDistT;
      this.speedS = pose.speed;
    }

    // ── The entry yaw swings home once the transition has landed.
    if (!snap && dt > 0 && !this.holdEntry && this.entryYaw !== 0) {
      // (The eyes turn back to ahead like a head, unhurried: they may arrive looking up to 95° aside.)
      springStep(this.entryYaw, this.entryVel, 0, (reduced ? 0.75 : 1) * (this.view === 'eyes' ? 1.5 : this.view === 'chase' ? 2 : 1.5), dt, _sp);
      this.entryYaw = Math.abs(_sp[0]) < 1e-4 && Math.abs(_sp[1]) < 1e-4 ? 0 : _sp[0];
      this.entryVel = this.entryYaw === 0 ? 0 : _sp[1];
    }

    // ── Bank: a third of a plane's, smoothed.
    const bankT = this.view === 'chase' ? this.bankOf(pose) * 0.3 : 0;
    if (!snap && dt > 0) {
      springStep(this.roll, this.rollVel, bankT, 3, dt, _sp);
      this.roll = _sp[0];
      this.rollVel = _sp[1];
    } else this.roll = bankT;

    if (this.view === 'eyes') this.eyesPose(dt, env, out, snap);
    else this.orbitPose(dt, env, out, snap);
  }

  /** Chase and alongside: an orbit round the anchor in the target's heading frame. */
  private orbitPose(dt: number, env: RideEnv, out: FramePose, snap: boolean): void {
    const fr = this.framing;
    const chase = this.view === 'chase';
    // On this tiny planet the horizon drops fast with height (46° below level at a plane's 70 m,
    // 64° beside the station): the elevation rises with it so the planet's limb stays in the lower
    // part of the frame instead of falling out of it.
    const el = Math.max(fr.minEl, Math.min(fr.maxEl, elevationFor(fr.el, this.h, fr.fov) + this.pitch));
    const want = this.distOf(this.logDist);
    // Occlusion: buildings between the target and where the camera wants to be pull it in (quickly),
    // and let it back out (gently) once clear.
    // Behind the target, swung round to its right by the yaw (right = travel × up).
    const ya = fr.yaw + this.yaw + this.entryYaw;
    _right.crossVectors(this.fwdS, _up).normalize();
    _back.copy(this.fwdS).multiplyScalar(-Math.cos(ya)).addScaledVector(_right, Math.sin(ya));
    _off.copy(_back).multiplyScalar(Math.cos(el)).addScaledVector(_up, Math.sin(el));
    _t.copy(this.anchor).addScaledVector(_off, want);
    const free = chase ? env.free(this.anchor, _t) : 1;
    // (The cap lives in [lo, hi] and the spring is clamped there, velocity zeroed where the clamp
    // bites: seeded with 1e9 it wound up and pinned the camera at its minimum for seconds.)
    const lo = fr.minDist * 0.6;
    const hi = Math.max(lo, want * 1.5);
    const cap = free >= 0.999 ? hi : Math.min(hi, Math.max(lo, want * free - 0.6));
    if (snap || dt <= 0) {
      this.occ = cap;
      this.occVel = 0;
    } else {
      springStep(this.occ, this.occVel, cap, cap < this.occ ? 14 : 2.5, dt, _sp);
      this.occ = _sp[0];
      this.occVel = _sp[1];
    }
    this.clampOcc(lo, hi);
    const d = Math.min(want, this.occ);
    out.pos.copy(this.anchor).addScaledVector(_off, d);
    // A facade beside the camera pushes it out into the street (never a wall filling half the frame).
    // (D1f r5) Through a spring: moving along a block the push stepped by a metre in a frame where
    // one facade's reach handed over to the next. (D1f r6) Pushed at ω 6 (was 12), let back at ω 3.5:
    // chasing a truck round a roundabout, a corner pushed the camera 2 m aside and back within 0.6 s,
    // swinging the view 60°/s just as the trip in landed.
    _wp.copy(out.pos);
    keepOffWalls(out.pos, env);
    _wd.subVectors(out.pos, _wp);
    if (snap || dt <= 0) {
      this.wallOff.copy(_wd);
      this.wallVel.set(0, 0, 0);
    } else {
      const wOm = _wd.lengthSq() < this.wallOff.lengthSq() ? 3.5 : 6;
      for (let k = 0; k < 3; k++) {
        springStep(this.wallOff.getComponent(k), this.wallVel.getComponent(k), _wd.getComponent(k), wOm, dt, _sp);
        this.wallOff.setComponent(k, _sp[0]);
        this.wallVel.setComponent(k, _sp[1]);
      }
    }
    out.pos.copy(_wp).add(this.wallOff);

    // Floor: the camera stays above terrain, water and roofs (a spring, so a roof sliding under a
    // car chase swells the camera up instead of stepping it).
    _dir.copy(out.pos).normalize();
    const camH = out.pos.length() - R;
    const need = Math.max(0, env.floor(_dir) + 1 - camH);
    if (snap || dt <= 0) {
      this.lift = need;
      this.liftVel = 0;
    } else {
      springStep(this.lift, this.liftVel, need, need > this.lift ? 10 : 2.5, dt, _sp);
      this.lift = Math.max(0, _sp[0]);
      this.liftVel = _sp[1];
      // Hard floor: never below it, whatever the spring is doing.
      if (this.lift < need - 0.5) this.lift = need - 0.5;
    }
    out.pos.addScaledVector(_dir, this.lift);
    this.camDist = out.pos.distanceTo(this.anchor);

    // Look: past the target along its travel when behind it, at it when beside it; a little above
    // its centre. Alongside: at the station, nudged toward the planet below so its disc sits in frame.
    if (chase) {
      const ahead = Math.max(0, Math.cos(ya)) * this.camDist * 0.42 * Math.cos(el) ** 2;
      _look.copy(this.anchor).addScaledVector(this.fwdS, ahead).addScaledVector(_up, this.radius * 0.25);
    } else {
      _look.copy(this.anchor).addScaledVector(_up, -this.camDist * 0.18 * Math.cos(el));
      // A little left of the station, so it sits right of centre: clear of the HUD's follow card
      // (top left) and its long wings inside the frame.
      _t.subVectors(_look, out.pos).normalize();
      _right.crossVectors(_t, _up);
      if (_right.lengthSq() > 1e-8) _look.addScaledVector(_right.normalize(), -this.camDist * 0.11);
    }
    _dir.subVectors(_look, out.pos);
    if (_dir.lengthSq() < 1e-8) _dir.copy(this.fwdS);
    _dir.normalize();
    // Up hint: the radial up at the camera; looking (nearly) straight down, the target's heading.
    _y.copy(out.pos).normalize();
    const along = Math.abs(_dir.dot(_y));
    if (along > 0.9) _y.lerp(this.fwdS, Math.min(1, (along - 0.9) / 0.09)).normalize();
    lookQuat(_dir, _y, this.roll, out.quat);
    out.look.copy(_look);
    const kick = env.reduced ? 0 : Math.min(6, Math.max(0, this.speedS - 6) * 0.12);
    out.fov = fr.fov + kick;
    out.shift = 0;
    this.near = Math.min(2, Math.max(0.08, Math.min((camH + this.lift) * 0.03, (this.camDist - this.radius) * 0.35)));
  }

  /** First person at the anchor; pulled back over the shoulder by the wheel. */
  private eyesPose(dt: number, env: RideEnv, out: FramePose, snap: boolean): void {
    const fr = this.framing;
    const pitch = Math.max(fr.minEl, Math.min(fr.maxEl, -6 * DEG + this.pitch));
    // Look direction: the smoothed heading turned right by the user's yaw (right = travel × up).
    _right.crossVectors(this.fwdS, _up).normalize();
    const yw = this.yaw - this.entryYaw;
    _dir.copy(this.fwdS).multiplyScalar(Math.cos(yw)).addScaledVector(_right, Math.sin(yw));
    _dir.multiplyScalar(Math.cos(pitch)).addScaledVector(_up, Math.sin(pitch)).normalize();
    const want = this.distOf(this.logDist);
    // Over the shoulder: behind and a little above the head, slightly to the right; a wall behind
    // the walker pulls the camera in (quickly) and lets it back out (gently), as in the chase.
    _right.crossVectors(_dir, _up).normalize();
    _off.copy(_dir).multiplyScalar(-1).addScaledVector(_up, 0.32).addScaledVector(_right, 0.12);
    let d = want;
    if (want > 0.05) {
      _t.copy(this.anchor).addScaledVector(_off, want);
      const free = env.free(this.anchor, _t);
      const hi = want * 1.5;
      const cap = free >= 0.999 ? hi : Math.min(hi, Math.max(0, want * free - 0.4));
      if (snap || dt <= 0) {
        this.occ = cap;
        this.occVel = 0;
      } else {
        springStep(this.occ, this.occVel, cap, cap < this.occ ? 14 : 2.5, dt, _sp);
        this.occ = _sp[0];
        this.occVel = _sp[1];
      }
      this.clampOcc(0, hi);
      d = Math.min(want, this.occ);
    } else {
      this.occ = want * 1.5;
      this.occVel = 0;
    }
    out.pos.copy(this.anchor).addScaledVector(_off, d);
    if (d > 0.05) {
      // Look past the walker along their view (the point they look at, 6 m out and more).
      _look.copy(this.anchor).addScaledVector(_dir, 6 + d * 0.5).sub(out.pos);
      _dir.copy(_look).normalize();
      // Keep the camera above the ground behind the walker.
      _t.copy(out.pos).normalize();
      const fl = env.floor(_t) + 0.4;
      const h = out.pos.length() - R;
      if (h < fl) out.pos.addScaledVector(_t, fl - h);
    }
    this.camDist = d;
    lookQuat(_dir, _up, 0, out.quat);
    out.look.copy(out.pos).addScaledVector(_dir, 8);
    out.fov = fr.fov - Math.min(1, d / 3) * 6;
    out.shift = 0;
    this.near = d < 0.5 ? 0.05 : Math.min(0.3, 0.05 + d * 0.04);
  }
}

