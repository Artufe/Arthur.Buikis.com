// The bird's chase camera (D1): behind and a little above the bird, swinging round after it through
// a critically damped spring on its flight direction (so a carve sweeps the view round and a dive
// tips it down the dive), leaning about a quarter of the bird's bank, the lens widening with speed (not
// with reduced motion). The wheel / pinch set the distance; it never dips into the floor.
//
// Walls (refine 2): the camera is never shoved sideways. Something between the bird and the camera
// shortens the boom (along the line of sight: a zoom, not a turn); a facade beside the camera swings
// the boom round the bird, away from it, through a spring on the angle — the bird stays where it is
// in the frame and the view turns no faster than that spring. (Round 1 pushed the camera out of the
// facade's clearance through a stiff spring: at a corner the push flipped and threw the camera
// across the street at 70 m/s, the bird out of the frame.)

import { Vector3 } from 'three';
import { R } from '../../world/config';
import { springStep } from '../model';
import type { FramePose } from '../rides/blend';
import { elevationFor, keepOffWalls, lookQuat, type RideEnv } from '../rides/rig';
import { BIRD, type BirdFlight } from './flight';

const DEG = Math.PI / 180;

export const BIRD_CAM = {
  dist: 3.5,
  minDist: 2.2,
  maxDist: 16,
  /** Elevation above the flight line (rad). */
  el: 11 * DEG,
  fov: 58,
};

const _up = new Vector3();
const _right = new Vector3();
const _look = new Vector3();
const _d = new Vector3();
const _f = new Vector3();
const _t = new Vector3();
const _f2 = new Vector3();
const _sp = [0, 0];

export class BirdCam {
  /** Log distance target (wheel / pinch). */
  logDistT = Math.log(BIRD_CAM.dist);
  near = 0.12;
  private logDist = Math.log(BIRD_CAM.dist);
  private logDistVel = 0;
  private readonly dirS = new Vector3(0, 1, 0);
  private readonly dirV = new Vector3();
  /** The look-ahead direction, smoothed (a wall slide or a swerve turns the view, never flicks it). */
  private readonly aheadS = new Vector3(0, 1, 0);
  private readonly aheadV = new Vector3();
  /** The boom's swing away from a facade (rad, + = round to the bird's right), a spring. */
  private yawOff = 0;
  private yawOffVel = 0;
  private roll = 0;
  private rollVel = 0;
  private lift = 0;
  private liftVel = 0;
  /** Distance cap from buildings between the bird and the camera (m), a spring, in [minDist/2, 1.5 × boom]. */
  occ = BIRD_CAM.dist * 1.5;
  private occVel = 0;
  private speedS: number = BIRD.cruise;

  get minLog(): number {
    return Math.log(BIRD_CAM.minDist);
  }
  get maxLog(): number {
    return Math.log(BIRD_CAM.maxDist);
  }

  /**
   * Snap to rest behind the bird. `swing` false: the boom starts straight behind (a launch from where
   * the camera is: the swing away from a facade then eases in).
   */
  settle(b: BirdFlight, env: RideEnv, out: FramePose, swing = true, along: Vector3 | null = null): void {
    // (`along`: the boom and the look start along this direction instead of the bird's — a launch
    // starts along the lens and swings round after a bird heading off elsewhere.)
    this.dirS.copy(along ?? b.dir);
    this.dirV.set(0, 0, 0);
    this.aheadS.copy(along ?? b.dir);
    this.aheadV.set(0, 0, 0);
    this.holdDir = !!along;
    this.yawOff = 0;
    this.yawOffVel = 0;
    this.roll = b.bank * 0.28;
    this.rollVel = 0;
    this.logDist = this.logDistT;
    this.logDistVel = 0;
    this.lift = 0;
    this.liftVel = 0;
    // (Finite: seeded with 1e9 the spring wound up to ±1e6 m when the first blocker appeared and
    // pinned the boom at its minimum for ~7 s after a street launch. place() clamps it every frame.)
    this.occ = Math.exp(this.logDistT) * 1.5;
    this.occVel = 0;
    this.speedS = b.speed;
    this.noSwing = !swing;
    this.place(0, b, env, out, true);
    this.place(0, b, env, out, true);
    this.noSwing = false;
    this.holdDir = false;
  }
  private noSwing = false;
  private holdDir = false;

  update(dt: number, b: BirdFlight, env: RideEnv, out: FramePose): void {
    this.place(dt, b, env, out, false);
  }

  private place(dt: number, b: BirdFlight, env: RideEnv, out: FramePose, snap: boolean): void {
    const reduced = env.reduced;
    _up.copy(b.pos).normalize();
    this.logDistT = Math.max(this.minLog, Math.min(this.maxLog, this.logDistT));
    if (!snap && dt > 0) {
      // Flight direction: a critically damped spring per component (renormalised), ω 5 — a carve
      // sweeps the camera round in ~0.4 s.
      const om = reduced ? 3.6 : 5;
      for (let k = 0; k < 3; k++) {
        const x = this.dirS.getComponent(k);
        springStep(x, this.dirV.getComponent(k), b.dir.getComponent(k), om, dt, _sp);
        this.dirS.setComponent(k, _sp[0]);
        this.dirV.setComponent(k, _sp[1]);
      }
      if (this.dirS.lengthSq() < 1e-6) this.dirS.copy(b.dir);
      this.dirS.normalize();
      for (let k = 0; k < 3; k++) {
        springStep(this.aheadS.getComponent(k), this.aheadV.getComponent(k), b.dir.getComponent(k), reduced ? 3.5 : 4.5, dt, _sp);
        this.aheadS.setComponent(k, _sp[0]);
        this.aheadV.setComponent(k, _sp[1]);
      }
      if (this.aheadS.lengthSq() < 1e-6) this.aheadS.copy(b.dir);
      this.aheadS.normalize();
      springStep(this.roll, this.rollVel, b.bank * 0.28, 3.5, dt, _sp);
      this.roll = _sp[0];
      this.rollVel = _sp[1];
      springStep(this.logDist, this.logDistVel, this.logDistT, reduced ? 4.5 : 7, dt, _sp);
      this.logDist = _sp[0];
      this.logDistVel = _sp[1];
      this.speedS += (b.speed - this.speedS) * (1 - Math.exp(-dt * 2.5));
    } else {
      if (!this.holdDir) {
        this.dirS.copy(b.dir);
        this.aheadS.copy(b.dir);
      }
      this.roll = b.bank * 0.28;
      this.logDist = this.logDistT;
      this.speedS = b.speed;
    }
    const want = Math.exp(this.logDist);
    // Behind along the (smoothed) flight line, raised by the elevation about its right axis; the
    // vertical part of the flight line counts in part (a dive is watched from above, not from inside it).
    _d.copy(this.dirS);
    const vert = _d.dot(_up);
    // (A climb counts less than a dive: the camera never ends up below the bird staring at the sky.)
    _d.addScaledVector(_up, -vert * (vert > 0 ? 0.75 : 0.45)).normalize();
    _right.crossVectors(_d, _up);
    if (_right.lengthSq() < 1e-10) _right.crossVectors(b.fwd, _up);
    _right.normalize();
    _t.crossVectors(_right, _d).normalize(); // up of the flight line
    // The camera looks ahead along where the bird is flying NOW (its position swings round after it):
    // in a long carve the bird stays near the middle, a little to the outside, its way ahead in view.
    _f.copy(this.aheadS).addScaledVector(_up, -this.aheadS.dot(_up) * 0.6).normalize();
    // Higher up, the camera rises behind the bird so the planet's limb stays in frame.
    // (In a dive a little higher still, so the stooping bird keeps its outline against the ground.)
    const el = elevationFor(BIRD_CAM.el, b.pos.length() - R, BIRD_CAM.fov) + 7 * DEG * b.tuck;
    _d.multiplyScalar(-Math.cos(el)).addScaledVector(_t, Math.sin(el)); // unit offset, bird → camera
    // A facade within WALL_CLEAR of where the camera would be swings the boom round the bird, away
    // from it (the angle that clears it, at most 65°), through a spring.
    let yawT = 0;
    if (env.wall) {
      _t.copy(b.pos).addScaledVector(_d, want);
      _f2.copy(_t);
      keepOffWalls(_f2, env);
      _f2.sub(_t);
      const lat = _f2.dot(_right);
      const reach = want * Math.cos(el);
      if (Math.abs(lat) > 1e-3 && reach > 0.5) yawT = Math.asin(Math.max(-0.9, Math.min(0.9, lat / reach)));
    }
    if (snap || dt <= 0) {
      this.yawOff = this.noSwing ? 0 : yawT;
      this.yawOffVel = 0;
    } else {
      springStep(this.yawOff, this.yawOffVel, yawT, reduced ? 2.4 : 3.2, dt, _sp);
      this.yawOff = _sp[0];
      this.yawOffVel = _sp[1];
    }
    // (A positive angle about the up swings the backward boom round to the bird's right.)
    if (Math.abs(this.yawOff) > 1e-5) _d.applyAxisAngle(_up, this.yawOff);
    // A building between the bird and where the camera wants to be pulls it in along the line of
    // sight, and lets it back out (gently) once clear: weaving between towers, the camera never ends
    // up in a wall.
    out.pos.copy(b.pos).addScaledVector(_d, want);
    const free = env.free(b.pos, out.pos);
    // The occlusion cap lives in [lo, hi]: clear, it rests at hi (just past the boom), so a blocker
    // pulls it in from there; the spring is clamped to the range and its velocity zeroed where the
    // clamp bites, so it can never wind up.
    const lo = BIRD_CAM.minDist * 0.5;
    const hi = Math.max(lo, want * 1.5);
    const cap = free >= 0.999 ? hi : Math.min(hi, Math.max(lo, want * free - 0.5));
    if (snap || dt <= 0) {
      this.occ = cap;
      this.occVel = 0;
    } else {
      springStep(this.occ, this.occVel, cap, cap < this.occ ? 9 : 2.5, dt, _sp);
      this.occ = _sp[0];
      this.occVel = _sp[1];
      // (Never through the blocker, whatever the spring is doing.)
      if (this.occ > cap + 0.4) {
        this.occ = cap + 0.4;
        this.occVel = Math.min(0, this.occVel);
      }
    }
    if (!(this.occ >= lo)) {
      this.occ = lo;
      this.occVel = Math.max(0, this.occVel || 0);
    } else if (this.occ > hi) {
      this.occ = hi;
      this.occVel = Math.min(0, this.occVel);
    }
    const d = Math.min(want, this.occ);
    out.pos.copy(b.pos).addScaledVector(_d, d);
    // Last resort: the lens never inside a wall (the swing and the boom see to it nearly always).
    keepOffWalls(out.pos, env, 0.3);
    // Floor: the camera stays a little above the ground / water / roofs under it.
    const dir = _look.copy(out.pos).normalize();
    const h = out.pos.length() - R;
    const need = Math.max(0, env.floor(dir) + 0.5 - h);
    if (snap || dt <= 0) {
      this.lift = need;
      this.liftVel = 0;
    } else {
      springStep(this.lift, this.liftVel, need, need > this.lift ? 8 : 3, dt, _sp);
      this.lift = Math.max(0, _sp[0]);
      this.liftVel = _sp[1];
      if (this.lift < need - 0.3) this.lift = need - 0.3;
    }
    out.pos.addScaledVector(dir, this.lift);
    // Look a little ahead of and above the bird: it sits just below the frame's centre.
    _look.copy(b.pos).addScaledVector(_f, d * 0.55 * Math.cos(el) ** 2).addScaledVector(_up, 0.22 + d * 0.04);
    out.look.copy(_look);
    _look.sub(out.pos).normalize();
    // (lookQuat rolls counter-clockwise for + ; a right bank leans the view clockwise.)
    lookQuat(_look, _up, -this.roll, out.quat);
    const kick = reduced ? 0 : Math.max(-2, Math.min(12, (this.speedS - BIRD.cruise) * 0.5));
    out.fov = BIRD_CAM.fov + kick;
    out.shift = 0;
    this.near = Math.max(0.06, Math.min(0.5, (d - BIRD.span * 0.5) * 0.25));
  }
}
