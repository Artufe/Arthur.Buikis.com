// The bird's chase camera (D1): behind and a little above the bird, swinging round after it through
// a critically damped spring on its flight direction (so a carve sweeps the view round and a dive
// tips it down the dive), leaning about a quarter of the bird's bank, the lens widening with speed (not
// with reduced motion). The wheel / pinch set the distance; it never dips into the floor.
//
// (v2-BF) The boom is sized to the bird (BIRD_SIZE). A crash never whips it round: through the
// tumble the swing and the look hold the way they were (the bounce reverses the bird's velocity, the
// body spins: the camera follows neither), then ease back behind the bird over the recovery (~1 s),
// their turn rate-limited; a small shake on the bonk (none with reduced motion). Standing on the ground
// it frames the bird from behind and a little higher, swinging round its hops on the spot slowly. Only
// what truly stands between the bird and the lens pulls the boom in (env.free: the bird's own, which
// looks past poles and trunks, and sees hedges and garden fences), never under OCC_MIN. Low down
// (standing, or near its floor) the boom first rises until the lens sees the bird over a hedge or a
// fence behind it (RAISE).
//
// Walls (refine 2): the camera is never shoved sideways. Something between the bird and the camera
// shortens the boom (along the line of sight: a zoom, not a turn); a facade beside the camera swings
// the boom round the bird, away from it, through a spring on the angle — the bird stays where it is
// in the frame and the view turns no faster than that spring. (Round 1 pushed the camera out of the
// facade's clearance through a stiff spring: at a corner the push flipped and threw the camera
// across the street at 70 m/s, the bird out of the frame.)

import { Quaternion, Vector3 } from 'three';
import { R } from '../../world/config';
import { springStep } from '../model';
import type { FramePose } from '../rides/blend';
import { elevationFor, keepOffWalls, lookQuat, type RideEnv } from '../rides/rig';
import { BIRD, type BirdFlight } from './flight';

const DEG = Math.PI / 180;
/** The swing's fastest turn (rad/s): a carve never spins the view faster. */
const TURN_CAP = 150 * DEG;
/** The bonk's shake (s). */
const SHAKE_T = 0.35;
/** The backstop's braking (rad/s²) as it catches up with the view it wants. */
const TURN_BRAKE = 1500 * DEG;
/** The shortest a blocker pulls the boom in to (m). */
const OCC_MIN = 1.4;
/**
 * Low down (standing, or within LOW m of its floor), the extra elevations tried in turn until the
 * lens sees the bird over what stands behind it (a hedge, a garden fence, a parked car's height of
 * clutter); none clear, none is taken and the boom pulls in as usual.
 */
const RAISE = [0, 10 * DEG, 20 * DEG, 32 * DEG, 45 * DEG, 60 * DEG];
/** The steepest the raise takes the boom (rad above the horizon): looking down on the bird from over it. */
const EL_MAX = 80 * DEG;
const LOW = 3;

/** The boom against the 1.84 m bird it was framed for (BIRD_SIZE 0.62: ×0.68). */
const K = 0.68;
export const BIRD_CAM = {
  dist: 3.5 * K,
  minDist: 2.2 * K,
  maxDist: 16 * K,
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

const _t2 = new Vector3();
const clamp1 = (x: number) => (x < -1 ? -1 : x > 1 ? 1 : x);
const smooth01 = (x: number) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};
const _q = new Quaternion();
const _sh = new Vector3();
const _hold = new Vector3();
const _bk = new Vector3();
const _ft = new Vector3();
const _eye = new Vector3();
const _lens = new Vector3();

/**
 * Swing unit `cur` toward unit `want` as a level swing: its heading turned about the local `up` and
 * its elevation, each through a critically damped spring of omega `om` (vel: x the yaw rate, y the
 * elevation's), the whole turn never faster than `maxRate` (rad/s). (Sprung per component, a swing
 * of 180° — a bounce off a wall reverses the bird — passed through the vertical, where the boom's
 * frame flips: the view turned 180° in a frame.)
 */
function swing(cur: Vector3, vel: Vector3, want: Vector3, up: Vector3, om: number, maxRate: number, dt: number): void {
  const ec = Math.asin(clamp1(cur.dot(up)));
  _t.copy(cur).addScaledVector(up, -cur.dot(up));
  if (_t.lengthSq() < 1e-10) _t.copy(want).addScaledVector(up, -want.dot(up));
  if (_t.lengthSq() < 1e-10) return;
  _t.normalize();
  const ew = Math.asin(clamp1(want.dot(up)));
  _f2.copy(want).addScaledVector(up, -want.dot(up));
  let yaw = 0;
  if (_f2.lengthSq() > 1e-10) {
    _f2.normalize();
    yaw = Math.atan2(_t2.crossVectors(_t, _f2).dot(up), _t.dot(_f2));
  }
  springStep(-yaw, vel.x, 0, om, dt, _sp);
  let dy = _sp[0] + yaw;
  vel.x = _sp[1];
  springStep(ec, vel.y, ew, om, dt, _sp);
  let de = _sp[0] - ec;
  vel.y = _sp[1];
  const a = Math.hypot(dy * Math.cos(ec), de);
  const lim = maxRate * dt;
  if (a > lim) {
    const k = lim / a;
    dy *= k;
    de *= k;
    vel.x *= k;
    vel.y *= k;
  }
  _t.applyAxisAngle(up, dy);
  const e = ec + de;
  cur.copy(_t).multiplyScalar(Math.cos(e)).addScaledVector(up, Math.sin(e)).normalize();
}

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
  /** The elevation added to see the bird over something low behind it (rad), a spring; its target, for review. */
  private raise = 0;
  private raiseVel = 0;
  raiseT = 0;
  readonly raiseFree: number[] = RAISE.map(() => 1);
  /** Distance cap from what stands between the bird and the camera (m), a spring, in [OCC_MIN, 1.5 × boom]. */
  occ = BIRD_CAM.dist * 1.5;
  private occVel = 0;
  private speedS: number = BIRD.trim;
  /** The crash hold (1 through the tumble, easing to 0 through the recovery) and the shake. */
  private hold = 0;
  private bonks = 0;
  private shakeT = 0;
  private shakeA = 0;
  /** The orientation presented last frame (the turn-rate backstop), and whether it is still catching up. */
  private readonly qPrev = new Quaternion();
  private lagging = false;

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
    this.raise = 0;
    this.raiseVel = 0;
    // (Finite: seeded with 1e9 the spring wound up to ±1e6 m when the first blocker appeared and
    // pinned the boom at its minimum for ~7 s after a street launch. place() clamps it every frame.)
    this.occ = Math.exp(this.logDistT) * 1.5;
    this.occVel = 0;
    this.speedS = b.speed;
    this.hold = 0;
    this.bonks = b.bonks;
    this.shakeT = 0;
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
      // A crash: hold the swing and the look (the bird's velocity reverses in the bounce), then ease
      // back behind it as the recovery fades out.
      this.hold = b.crash > this.hold ? b.crash : this.hold + (b.crash - this.hold) * (1 - Math.exp(-dt / 0.4));
      // (Unless the held boom has run into something: pulled in short by a blocker, it swings behind
      // the bird as usual — held, a bird flying off across a boom of 0.9 m crossed the frame in a blink.)
      const want0 = Math.exp(this.logDist);
      const hold = this.hold * (1 - smooth01((0.75 * want0 - this.occ) / (0.35 * want0)));
      const free = 1 - hold;
      if (b.bonks !== this.bonks) {
        this.bonks = b.bonks;
        this.shakeT = reduced ? 0 : SHAKE_T;
        this.shakeA = 0.04 + 0.08 * b.impact;
      }
      if (hold > 0.999) {
        // (Held where it is: a turn under way bleeds off through the spring, not cut dead.)
        _hold.copy(this.dirS);
        swing(this.dirS, this.dirV, _hold, _up, reduced ? 3.6 : 5, TURN_CAP, dt);
        _hold.copy(this.aheadS);
        swing(this.aheadS, this.aheadV, _hold, _up, reduced ? 3.5 : 4.5, TURN_CAP, dt);
      } else {
        // Flight direction: a critically damped spring per component (renormalised), ω 5 — a carve
        // sweeps the camera round in ~0.4 s; never faster than TURN_CAP (after a crash, slower).
        // (Standing, slower: a hop on the spot turns the bird 35° in a blink; the view follows it round
        // over about half a second.)
        const st = 1 - 0.55 * b.stand;
        const om = (reduced ? 3.6 : 5) * (0.35 + 0.65 * free) * st;
        const cap = TURN_CAP * (0.4 + 0.6 * free * free) * st;
        swing(this.dirS, this.dirV, b.dir, _up, om, cap, dt);
        swing(this.aheadS, this.aheadV, b.dir, _up, (reduced ? 3.5 : 4.5) * (0.35 + 0.65 * free) * st, cap, dt);
      }
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
      this.hold = 0;
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
    // (Standing, a little higher again: it is looked down on over its back, the ground ahead in view.)
    const el0 = elevationFor(BIRD_CAM.el, b.pos.length() - R, BIRD_CAM.fov) + 7 * DEG * b.tuck + 7 * DEG * b.stand;
    _bk.copy(_d);
    _ft.copy(_t);
    // The sight line starts on the bird: its body standing (seeing the head over a hedge is not seeing
    // the bird), just over its back flying (skimming or down on the ground, the line from its centre
    // met the ground within its first step and the boom collapsed).
    _eye.copy(b.pos).addScaledVector(_up, 0.45 - 0.25 * b.stand);
    // Low down, raised until the lens sees the bird over a hedge or a fence behind it (the first of
    // RAISE that clears; none: none, and the boom pulls in as before). Up quickly, back down slowly.
    let raiseT = 0;
    if (b.stand > 0.5 || b.alt - b.floorH < LOW) {
      // (Standing, failing a clear view at the full boom: the raise whose pulled-in boom — as the
      // occlusion cap below would pull it — sees the bird from furthest out; failing that too, the
      // highest: looking down over the clutter beats a lens in a hedge. Flying, none: the pull-in and
      // the swing off the walls see to it, as before.)
      const standing = b.stand > 0.5;
      let bestD = 0;
      raiseT = standing ? RAISE[RAISE.length - 1] : 0;
      for (let k = 0; k < RAISE.length; k++) {
        const e = Math.min(EL_MAX, el0 + RAISE[k]);
        _lens.copy(_bk).multiplyScalar(-Math.cos(e)).addScaledVector(_ft, Math.sin(e));
        if (Math.abs(this.yawOff) > 1e-5) _lens.applyAxisAngle(_up, this.yawOff);
        const fr = env.free(_eye, _f2.copy(b.pos).addScaledVector(_lens, want));
        this.raiseFree[k] = fr;
        if (fr >= 0.999) {
          raiseT = RAISE[k];
          break;
        }
        const dk = Math.max(Math.min(OCC_MIN, want), want * fr - 0.5);
        if (standing && dk > bestD + 0.05 && env.free(_eye, _f2.copy(b.pos).addScaledVector(_lens, dk)) >= 0.999) {
          bestD = dk;
          raiseT = RAISE[k];
        }
      }
    }
    this.raiseT = raiseT;
    if (snap || dt <= 0) {
      this.raise = raiseT;
      this.raiseVel = 0;
    } else {
      springStep(this.raise, this.raiseVel, raiseT, raiseT > this.raise ? (reduced ? 4 : 6) : 1.8, dt, _sp);
      this.raise = Math.max(0, _sp[0]);
      this.raiseVel = _sp[1];
    }
    const el = Math.min(Math.max(el0, EL_MAX), el0 + this.raise);
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
    const free = env.free(_eye, out.pos);
    // The occlusion cap lives in [lo, hi]: clear, it rests at hi (just past the boom), so a blocker
    // pulls it in from there; the spring is clamped to the range and its velocity zeroed where the
    // clamp bites, so it can never wind up.
    // (Never under OCC_MIN: pulled in to 0.9 m by a pole after a crash, the bird filled the frame.)
    const lo = Math.min(OCC_MIN, want);
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
    // The bonk's shake: the camera and its look point jolted together by a few centimetres, decaying
    // over SHAKE_T (a jolt, not a turn; before the wall and floor checks).
    _sh.set(0, 0, 0);
    if (this.shakeT > 0 && dt > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const k = this.shakeA * (this.shakeT / SHAKE_T) ** 2;
      const ph = (SHAKE_T - this.shakeT) * 70;
      _sh.copy(_up).multiplyScalar(k * Math.sin(ph)).addScaledVector(_right, k * 0.6 * Math.sin(ph * 1.37 + 1));
      out.pos.add(_sh);
    }
    // Last resort: the lens never inside a wall (the swing and the boom see to it nearly always).
    keepOffWalls(out.pos, env, 0.3);
    // Floor: the camera stays a little above the ground / water / roofs under it.
    const dir = _look.copy(out.pos).normalize();
    const h = out.pos.length() - R;
    const need = Math.max(0, env.floor(dir, h) + 0.5 - h);
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
    _look.copy(b.pos).addScaledVector(_f, d * 0.55 * Math.cos(el) ** 2).addScaledVector(_up, 0.15 + d * 0.04).add(_sh);
    out.look.copy(_look);
    _look.sub(out.pos).normalize();
    // (lookQuat rolls counter-clockwise for + ; a right bank leans the view clockwise.)
    lookQuat(_look, _up, -this.roll, out.quat);
    // Backstop: the view turns no faster than TURN_CAP (a bounce at a boom pulled in short by a
    // blocker swung the look 5° in a frame) — unless that would lose the bird off the frame's edge.
    // (Catching up after it held the view back, it slows into the view it wants — TURN_BRAKE — rather
    // than stopping dead: a 4° turn one frame and 0.6° the next read as a jolt.)
    if (!snap && dt > 0) {
      const a = this.qPrev.angleTo(out.quat);
      const lim = TURN_CAP * dt;
      if (a > lim || this.lagging) {
        _q.copy(this.qPrev).slerp(out.quat, Math.min(1, lim / a));
        _f2.set(0, 0, -1).applyQuaternion(_q);
        _t.copy(b.pos).sub(out.pos).normalize();
        const half = (out.fov / 2) * DEG;
        const edge = smooth01((Math.acos(clamp1(_f2.dot(_t))) - 0.5 * half) / (0.35 * half));
        const step = Math.min(lim * (1 + 0.6 * edge), this.lagging ? Math.max(Math.sqrt(2 * TURN_BRAKE * a) * dt, 0.002) : Infinity);
        this.lagging = a > step;
        if (a > step) {
          _q.copy(out.quat);
          out.quat.copy(this.qPrev).slerp(_q, step / a);
        }
      }
    } else this.lagging = false;
    this.qPrev.copy(out.quat);
    const kick = reduced ? 0 : Math.max(-1.5, Math.min(10, (this.speedS - BIRD.trim) * 0.7));
    out.fov = BIRD_CAM.fov + kick;
    out.shift = 0;
    this.near = Math.max(0.06, Math.min(0.5, (d - BIRD.span * 0.5) * 0.25));
  }
}
