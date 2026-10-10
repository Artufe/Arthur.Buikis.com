// Bird flight (v2-BF): a point-mass glider with lift and drag that flaps for thrust; pure math on
// three's Vector3.
//
// The state is the flight path: the heading `fwd` (tangent at the bird), the path angle γ (+ climbs),
// the airspeed v and the bank φ (+ = the right wing down). With q = (v / V_TRIM)², the dynamic
// pressure against trim's, and c the lift coefficient against trim's (c = 1 glides at trim):
//
//   L = g·q·c                                  lift, c ≤ C_MAX (the stall), L ≤ N_MAX·g
//   D = g·q·(CD0 + K_IND·c²) + the body's      the polar (L/D ≈ 7.7 at trim) and a drag that rises
//       drag past V_FAST                       steeply past ~11 m/s (the stoop tops out near 20)
//   T                                          thrust, in pulses on each downstroke
//   dγ/dt = (L·cos φ − g·cos γ) / v
//   dψ/dt = L·sin φ / (v·cos γ)                a coordinated turn
//   dv/dt = T − D − g·sin γ
//
// No input is trim lift, wings level, no flapping: it glides down at ~7.5° and settles at ~7 m/s.
// The point mass's phugoid is damped by the bird's own reflex (c follows the rate the speed is
// changing: KD), so it never porpoises after a dive or a pull-up, and letting go of a dive bleeds the
// speed off down the glide instead of ballooning up. W pitches up and flaps (power ∝ climb), S lowers
// the lift, Space beats (one strong beat per press, more while held), Shift stoops (wings tucked, the
// path held steep). Steer banks through a spring; the turn comes from the lift.
//
// What it meets (env.floor / env.wall: the ground, water, roofs, walls, crowns): a glancing touch
// skims along it; a touchdown slow enough is a landing (a short run-out, then it stands, or floats on
// water); a hard hit is a crash, a cartoon bonk (bounce, tumble; high up it rights itself and glides
// on, low down it falls and lands dazed). Standing, A / D turn it on the spot in little hops and W or
// Space takes off (a jump and strong beats onto a 16° climb, handing over at trim speed); it never
// takes off by itself. Within GE_H of a floor the ground effect eases a shallow glide into a skim and,
// hands off, it flares to land. Nothing steers or lifts it for the player.
//
// Frames: `fwd` is tangent at the bird; `dir` is the velocity direction (fwd pitched by γ); `up` is
// the body's up (path up, banked, pitched by the angle of attack); `quat` is the body's attitude
// (+Z forward, +Y up, +X left), tumbling in a crash. right = fwd × up.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { R } from '../../world/config';
import { springStep } from '../model';
import type { BirdSnapshot } from '../../core/session';
import { BIRD_SIZE, BIRD_STAND } from './shared';

const DEG = Math.PI / 180;
const G = 9.8;
const TAU = Math.PI * 2;

export interface BirdInput {
  /** −1 … 1: left … right. */
  steer: number;
  /** −1 … 1: dive … climb (climbing flaps). */
  climb: number;
  /** Flap (a beat per press, beats while held). */
  flap: boolean;
  /** Stoop: wings tucked. */
  dive: boolean;
}

/**
 * What the bird meets, for a body whose centre is at height h (m above sea level). A solid whose top
 * is within BIRD.step over h is under it (a floor: it lands, skims or bonks down onto it); a taller
 * one beside it is a wall.
 */
export interface BirdEnv {
  /** The floor (m above sea level) at unit dir: the terrain or the water, the roofs, crowns and lamp heads there. */
  floor(dir: Vector3, h: number): number;
  /**
   * Push a body of radius r at unit dir out of the walls beside it (facades, poles, trunks, crowns at
   * its height). Writes the resolved unit dir into out; true if it moved.
   */
  wall?(dir: Vector3, h: number, r: number, out: Vector3): boolean;
  /** Highest the bird may fly (m above sea level). */
  ceiling: number;
  /**
   * The clearest heading to fly on along from `pos` (preferring unit tangent `fwd`), into out (unit
   * tangent). Asked once per crash, as the bird rights itself in the air (optional: else it goes on
   * the way it faces).
   */
  clear?(pos: Vector3, fwd: Vector3, out: Vector3): void;
  /** Is the floor at unit dir water (it floats there instead of standing)? Optional: never. */
  water?(dir: Vector3): boolean;
}

/** Trim airspeed (m/s): a hands-off glide. */
const V_TRIM = 7;
/** The polar: parasitic and induced drag against trim's lift (L/D = 1 / (2·0.065) ≈ 7.7 at c = 1). */
const CD0 = 0.065;
const K_IND = 0.065;
/** Wings tucked (the stoop): little parasitic drag. Tumbling: a lot. */
const CD0_TUCK = 0.028;
const CD0_TUMBLE = 0.14;
/** Stall speed (m/s) in level flight: the most lift the wings give, against trim's. */
const V_STALL = 4;
const C_MAX = (V_TRIM / V_STALL) ** 2;
/** How long (s) a stall takes to develop: the flare, then the nose drops. */
const STALL_T = 0.45;
/** The body's drag past V_FAST (m/s), g·((v − V_FAST) / V_SPAN)²: a 62° stoop tops out near 20 m/s. */
const V_FAST = 11;
const V_SPAN = 11.1;
/** Most load (g) a pull-up or a turn may put on the wings. */
const N_MAX = 3;
/** Lift against trim's at full climb (W) and full dive (S). */
const C_UP = 0.3;
const C_DOWN = 0.85;
/** The reflex that damps the phugoid: c follows the rate the speed changes (per g), at most ±REFLEX. */
const KD = 1.9;
const REFLEX = 0.8;
/** The trim glide's path angle (rad): L/D at trim. Hands off, the path is never lifted over it (/s). */
const GLIDE = -Math.atan(CD0 + K_IND);
const CAP_K = 2;
/** Let go of a climb, the path is brought down over the glide's line this much faster (/s), pushing over to −1 g at most. */
const CAP_K_UP = 10;
/** Hands off, slow, the path sags at most this far (rad) under the glide's line while it wins its speed back. */
const SAG = 3 * DEG;
const C_PUSH = -1;
/** Spilling lift (hands off, too fast for the glide): the airbrake's drag against trim's lift. */
const AIRBRAKE = 0.1;
/** Pitch response: c eases to what is asked over this (s). */
const C_TAU = 0.12;
/** A banked turn pulls this share of the lift it needs to hold its height (the rest sinks). */
const TURN_PULL = 0.6;
/** Mean thrust (m/s²) at a full beat (power 1); Space beats at P_FLAP; the downstroke's lift bump. */
const T_AVG = 4.5;
const P_FLAP = 1.3;
const C_FLAP = 0.6;
/** The stoop: the path angle it holds (rad) and how fast it turns onto it (/s). */
const STOOP = -62 * DEG;
const STOOP_K = 2.6;
const BANK_MAX = 48 * DEG;
/** Roll spring (rad/s): ~0.3 s to bank. */
const ROLL_W = 9;
/** Backstop on the heading's turn rate (rad/s); the lift sets it. */
const TURN_MAX = 2.2;
/** Ground effect: within this (m) of a floor, less induced drag and a little more lift. */
const GE_H = 1;
/** A contact whose speed into the surface is over this (m/s) is a crash; under it, a skim. */
const V_CRASH = 2.3;
/** A crash: restitution on the normal, friction on the tangent. */
const REST = 0.3;
const FRICTION = 0.4;
/** Tumble (s) and how many turns the body spins. */
const TUMBLE = 0.9;
const TURNS = 1.25;
/** Over this (m above its floor) as the tumble ends it rights itself and glides on (level beats, at most this long, s); under it, it falls and lands dazed. */
const RIGHT_ALT = 4;
const RIGHT = 0.8;
/** Dazed on the ground after a crash (s): it may take off once the first DAZE_HOLD of it is over. */
const DAZE = 1;
const DAZE_HOLD = 0.6;
/** A touchdown (or a skim) slower than this (m/s) on a surface flatter than ~37° is a landing. */
const LAND_V = 5.2;
const LANDABLE = 0.8;
/** The run-out after a touchdown: slowing at this (m/s²), a hop every RUN_HOP s. */
const RUN_DECEL = 6;
const RUN_HOP = 0.2;
/** A hop on the spot (s) and how far one turns it (rad). */
const HOP_DUR = 0.3;
const HOP_YAW = 35 * DEG;
/** The take-off: the crouch (s), the jump's speed (m/s) and path angle, the climb it settles on, the beats' power, the longest it lasts (s). */
const LIFT_CROUCH = 0.12;
const LIFT_V = 3.8;
const LIFT_JUMP = 22 * DEG;
const LIFT_CLIMB = 16 * DEG;
const LIFT_P = 1.8;
const LIFT_MAX = 2;
/** W's steepest climb (rad), and how much steeper it may zoom per m/s over 6 m/s. */
const W_MAX = 18 * DEG;
const W_ZOOM = 3 * DEG;
/** Hands off within this (m) of a floor and slower than LAND_FLARE_V it flares to land (the airbrake's extra drag, against trim's lift). */
const LAND_FLARE_H = 1.2;
const LAND_FLARE_V = 9;
const LAND_BRAKE = 0.35;
/** Integration step (s): every frame is cut into equal steps no longer than this. */
const SUBSTEP = 1 / 120;
const V_MIN = 1.2;

export const BIRD = {
  /** m/s: the hands-off glide, the stall, a flapping climb, the stoop's top. */
  trim: V_TRIM,
  stall: V_STALL,
  climb: 6.2,
  stoop: 20,
  bankMax: BANK_MAX,
  /** Ceiling soft band (m). */
  band: 16,
  /** A solid whose top is within this (m) over the body's height is under it (stepped onto), not a wall. */
  step: 0.45,
  /** Body radius against walls (m), and its centre's height over its belly (m): also over its feet, standing (shared.ts BIRD_STAND). */
  bodyR: 0.55 * BIRD_SIZE,
  belly: BIRD_STAND * BIRD_SIZE,
  /** Floating, its centre this far (m) over the water. */
  float: 0.12 * BIRD_SIZE,
  /** Wingspan (m), for the camera and the cloud overlay's hole. */
  span: 1.84 * BIRD_SIZE,
} as const;

const _up = new Vector3();
const _right = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _w = new Vector3();
const _v = new Vector3();
const _n = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _sp = [0, 0];

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

function tangent(v: Vector3, n: Vector3): Vector3 {
  v.addScaledVector(n, -v.dot(n));
  if (v.lengthSq() < 1e-12) v.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).addScaledVector(n, -(Math.abs(n.y) < 0.9 ? n.y : n.x));
  return v.normalize();
}

/** Turn unit tangent `fwd` (at radial `up`) to leave a wall of outward tangent normal `n` at ≥ ~20° (along n if `flat`). */
function leave(fwd: Vector3, n: Vector3, up: Vector3, flat: boolean): void {
  const out = fwd.dot(n);
  if (!flat && out >= 0.35) return;
  fwd.addScaledVector(n, -out);
  if (flat || fwd.lengthSq() < 1e-8) fwd.crossVectors(up, n);
  fwd.normalize().multiplyScalar(Math.sqrt(1 - 0.35 * 0.35)).addScaledVector(n, 0.35);
}

/** The body's drag past V_FAST (per g). */
const bodyDrag = (v: number) => (v > V_FAST ? ((v - V_FAST) / V_SPAN) ** 2 : 0);


export class BirdFlight {
  readonly pos = new Vector3(0, 0, R + 40);
  /** Heading (unit, tangent at the bird). */
  readonly fwd = new Vector3(0, 1, 0);
  /** Velocity direction (unit; the heading, standing). */
  readonly dir = new Vector3(0, 1, 0);
  /** Body up (unit: banked, pitched by the angle of attack). */
  readonly up = new Vector3(0, 0, 1);
  /** Body attitude (+Z forward, +Y up, +X left), tumbling in a crash. */
  readonly quat = new Quaternion();
  speed: number = V_TRIM;
  /** Flight-path angle (rad, + = climbing). */
  gamma = 0;
  /** Bank (rad, + = right wing down) and its rate. */
  bank = 0;
  private bankVel = 0;
  /** Heading turn rate (rad/s, + = turning right). */
  turn = 0;
  /** Lift coefficient against trim's: what it is flying (eased) and what the wings gave last step. */
  private c = 1;
  lift = 1;
  /** Angle of attack drawn (rad): the body's nose over the path. */
  alpha = 2.5 * DEG;
  /** Wingbeat phase (rad, ≡ mod 2π: downstroke [0, π)), the beat's strength (0 … 1), its power (0 … LIFT_P). */
  flapPhase = 0;
  flapAmp = 0;
  private power = 0;
  /** Space: beats still to make; review: powered beats made. */
  private beats = 0;
  beatCount = 0;
  private flapHeld = false;
  /** Stoop (0 … 1), flare (0 … 1), the turn (−1 … 1) for the animation. */
  tuck = 0;
  spread = 0;
  turnK = 0;
  /** 0 … 1: stalled; spilling lift (the hands-off airbrake); flaring to land. */
  stall = 0;
  spill = 0;
  landFlare = 0;
  private stallT = 0;
  /** On the ground (the run-out, standing, its hops on the spot), floating if on water. */
  grounded = false;
  onWater = false;
  /** For the animation: 0 … 1 standing, the legs down, a hop's progress (0: none). */
  stand = 0;
  legs = 0;
  hop = 0;
  /** The run-out's speed (m/s) and clock (s); the hop on the spot (s into it, its turn, how much of it is done). */
  private runV = 0;
  private runT = 0;
  private hopT = 0;
  private hopYaw = 0;
  private hopDone = 0;
  /** The body centre's height over the floor (m), eased (standing, floating). */
  private standOff: number = BIRD.belly;
  private clock = 0;
  /** A take-off: s into it (−1: none): the crouch, the jump, the beats onto LIFT_CLIMB; the path it starts from. */
  private liftT = -1;
  private liftFrom = LIFT_JUMP;
  /** How long (s) it climbs at least before, nothing held, it eases over onto the glide; how far over it is (0 … 1). */
  private liftMin = 0;
  private liftOver = 0;
  /** Crash: s left of the tumble; then falling (low: no control until it lands), righting (high, s left), dazed on the ground (s left). */
  private tumbleT = 0;
  private fall = false;
  private rightT = 0;
  private daze = 0;
  /** 1 tumbling or falling, easing to 0 through the righting or the daze. */
  crash = 0;
  /** The tumble's axis (world). */
  private readonly tumbleAxis = new Vector3(1, 0, 0);
  /** The last wall it touched (outward normal, tangent) and how long ago it may still count (s). */
  private readonly wallN = new Vector3();
  private wallT = 0;
  /** The crash under way was against a wall (wallN): down dazed, it picks itself up facing away from it. */
  private crashWall = false;
  /** Review: crashes, landings, substeps on a floor (skims and landings), substeps against a wall. */
  crashes = 0;
  landings = 0;
  hardHits = 0;
  wallHits = 0;
  /** Each impact bumps `bonks`; `impact` 0 … 1 is how hard the last one was (the camera's shake). */
  bonks = 0;
  impact = 0;
  /** In contact with something this frame. */
  touching = false;
  /** Height above sea level and the floor under the bird, last step. */
  alt = 40;
  floorH = 0;

  reset(pos: Vector3, heading: Vector3, speed: number = V_TRIM): void {
    this.pos.copy(pos);
    _up.copy(pos).normalize();
    this.fwd.copy(heading);
    tangent(this.fwd, _up);
    this.speed = clamp(speed, V_MIN, 30);
    this.gamma = 0;
    this.bank = 0;
    this.bankVel = 0;
    this.turn = 0;
    this.c = 1;
    this.lift = 1;
    this.alpha = 2.5 * DEG;
    this.power = 0;
    this.flapAmp = 0;
    this.beats = 0;
    this.flapHeld = false;
    this.tuck = 0;
    this.spread = 0;
    this.turnK = 0;
    this.stall = 0;
    this.stallT = 0;
    this.spill = 0;
    this.landFlare = 0;
    this.grounded = false;
    this.onWater = false;
    this.stand = 0;
    this.legs = 0;
    this.hop = 0;
    this.runV = 0;
    this.hopT = 0;
    this.standOff = BIRD.belly;
    this.liftT = -1;
    this.tumbleT = 0;
    this.fall = false;
    this.rightT = 0;
    this.daze = 0;
    this.crash = 0;
    this.wallT = 0;
    this.crashWall = false;
    this.crashes = 0;
    this.landings = 0;
    this.hardHits = 0;
    this.wallHits = 0;
    this.impact = 0;
    this.touching = false;
    this.alt = this.pos.length() - R;
    this.floorH = -Infinity;
    this.frame();
  }

  snapshot(): BirdSnapshot {
    return { position: this.pos.toArray(), heading: this.fwd.toArray(), speed: this.speed,
      gamma: this.gamma, bank: this.bank, turn: this.turn, phase: this.flapPhase, lift: this.c, amp: this.flapAmp,
      ...(this.grounded ? { ground: true } : null) };
  }

  restore(state: BirdSnapshot): void {
    this.reset(new Vector3().fromArray(state.position), new Vector3().fromArray(state.heading), state.speed);
    this.gamma = state.gamma;
    this.bank = state.bank;
    this.turn = state.turn;
    this.flapPhase = state.phase;
    // (v2-BF: optional; an older snapshot flies on at trim.)
    if (Number.isFinite(state.lift)) this.c = state.lift!;
    if (Number.isFinite(state.amp)) this.flapAmp = this.power = state.amp!;
    if (state.ground) {
      // Standing where it stood (settled onto its floor by the next step).
      this.grounded = true;
      this.stand = this.legs = 1;
      this.speed = this.gamma = this.bank = this.turn = this.power = this.flapAmp = 0;
      this.floorH = this.pos.length() - R - this.standOff;
    }
    this.frame();
  }

  /** Taking off (the crouch, the jump and the beats; or, launched in the air, the beats onto the climb). */
  get takingOff(): boolean {
    return this.liftT >= 0;
  }

  /**
   * Take off. Standing: the crouch, then the jump and the strong beats onto a LIFT_CLIMB climb. In the
   * air (a launch from the street): the beats onto the climb from where it is. Either hands over at
   * trim speed.
   */
  takeOff(): void {
    if (this.grounded) {
      if (this.liftT < 0) this.startLift();
      return;
    }
    this.startLift();
    this.liftT = LIFT_CROUCH;
    this.liftFrom = LIFT_CLIMB;
    this.liftMin = LIFT_CROUCH + 1;
    this.gamma = Math.max(this.gamma, 8 * DEG);
    this.speed = Math.max(this.speed, 5);
  }

  private startLift(): void {
    this.liftT = 0;
    this.liftFrom = LIFT_JUMP;
    this.liftMin = LIFT_CROUCH + 0.5;
    this.liftOver = 0;
  }

  /** Advance dt seconds (cut into equal steps of ≤ SUBSTEP: any frame rate flies the same course). */
  step(dt: number, inp: BirdInput, env: BirdEnv): void {
    if (!(dt > 0)) return;
    const t = Math.min(dt, 0.25);
    const n = Math.ceil(t / SUBSTEP - 1e-6);
    this.touching = false;
    for (let i = 0; i < n; i++) this.sub(t / n, inp, env);
    this.frame();
  }

  private sub(h: number, inp: BirdInput, env: BirdEnv): void {
    this.clock += h;
    _up.copy(this.pos).normalize();
    tangent(this.fwd, _up);
    _right.crossVectors(this.fwd, _up).normalize();
    const hNow = this.pos.length() - R;
    this.wallT = Math.max(0, this.wallT - h);
    if (this.grounded) {
      this.ground(h, inp, env, hNow);
      return;
    }

    // ── The crash: the tumble; then high up it rights itself and glides on (a few level beats: never
    // a climb), low down it falls, out of control, and lands dazed.
    const tumbling = this.tumbleT > 0;
    if (tumbling) {
      this.tumbleT = Math.max(0, this.tumbleT - h);
      if (this.tumbleT === 0) {
        if (hNow - this.floorH - BIRD.belly > RIGHT_ALT) {
          this.rightT = RIGHT;
          if (env.clear) {
            env.clear(this.pos, this.fwd, _a);
            if (_a.lengthSq() > 0.5) this.fwd.copy(_a);
          }
          // (Never back into a wall it has just been against.)
          if (this.wallT > 0) leave(this.fwd, this.wallN, _up, false);
          tangent(this.fwd, _up);
          _right.crossVectors(this.fwd, _up).normalize();
          this.gamma = clamp(this.gamma, -25 * DEG, GLIDE);
          this.speed = Math.max(this.speed, 5);
        } else this.fall = true;
      }
    } else if (this.rightT > 0) this.rightT = Math.max(0, this.rightT - h);
    const falling = this.tumbleT > 0 || this.fall;
    const righting = this.rightT > 0;
    this.crash = falling ? 1 : righting ? this.rightT / RIGHT : 0;

    let steer = clamp(inp.steer || 0, -1, 1);
    let climb = clamp(inp.climb || 0, -1, 1);
    let dive = !!inp.dive;
    let flap = !!inp.flap;
    if (falling) {
      steer = climb = 0;
      dive = flap = false;
    } else if (righting) {
      // (Righting itself: the player's steer and a dive ease back in; no climb, no beats of theirs.)
      const k = 1 - this.rightT / RIGHT;
      steer *= k;
      climb = Math.min(0, climb) * k;
      dive = flap = false;
    }
    // A take-off: S or a stoop cancels it; the steer is the player's throughout.
    // (Nothing held once it has climbed a little, it eases over onto the glide; W or Space held, it
    // climbs on.)
    const keep = climb > 0.3 || flap;
    if (this.liftT >= 0) {
      if (dive || climb < -0.3 || falling) this.liftT = -1;
      else {
        this.liftT += h;
        if (keep) this.liftOver = Math.max(0, this.liftOver - h / 0.3);
        else if (this.liftT > this.liftMin) this.liftOver = Math.min(1, this.liftOver + h / 0.45);
      }
    }
    const lifting = this.liftT >= 0;
    const liftG = LIFT_CLIMB + (this.liftFrom - LIFT_CLIMB) * (1 - smooth((this.liftT - LIFT_CROUCH) / 0.35)) + (GLIDE - LIFT_CLIMB) * smooth(this.liftOver);

    // ── Bank: steer asks for it (wings level when let go), through a spring.
    const bankT = falling ? 0 : steer * BANK_MAX * (1 - 0.5 * this.stall);
    springStep(this.bank, this.bankVel, bankT, ROLL_W, h, _sp);
    this.bank = _sp[0];
    this.bankVel = _sp[1];

    // ── Flapping: W (power ∝ climb), Space (a beat per press, more while held), a take-off's and a
    // righting's beats.
    if (flap && !this.flapHeld && !dive) this.beats = Math.max(this.beats, 1);
    this.flapHeld = flap;
    // (W with speed to spare zooms on it: the beats fade in only as it slows through ~9 m/s.)
    const baseW = falling || dive ? 0 : Math.max(0, climb) * (1 - smooth((this.speed - 6.5) / 3));
    let base = baseW;
    // (A take-off beats hard until it is up to speed, then enough to hold its climb.)
    if (lifting) base = Math.max(base, this.speed < V_TRIM + 0.3 ? LIFT_P : 0.9 * (1 - this.liftOver));
    if (righting && this.speed < V_TRIM) base = Math.max(base, P_FLAP);
    const top = 1 - smooth((hNow - (env.ceiling - BIRD.band)) / BIRD.band);
    const wanted = () => (this.beats > 0 && !falling && !dive ? Math.max(base, P_FLAP) : base) * top;
    let want = wanted();
    // A beat's strength is set as it starts (the top of the stroke) and held through it: a press is one
    // whole beat. From rest the first starts at once (the phase steps to the top of a stroke, unseen
    // at amplitude 0); asked for more mid-beat, it beats harder at once.
    if (want > 0.02 && this.power === 0) {
      if (this.flapAmp < 0.05) this.flapPhase = Math.ceil(this.flapPhase / TAU - 1e-9) * TAU;
      this.power = want;
    } else if (want > this.power && this.power > 0) this.power += (want - this.power) * (1 - Math.exp(-h / 0.05));
    let down = 0;
    if (this.power > 0 || this.flapAmp > 0.02) {
      const freq = 2.6 + 1.5 * Math.min(1, Math.max(this.power, this.flapAmp));
      const p0 = this.flapPhase;
      this.flapPhase += TAU * freq * h;
      if (this.power > 0 && Math.floor(this.flapPhase / TAU) > Math.floor(p0 / TAU)) {
        // A beat done: Space held beats on; let go, the queued one was the last. The next beat's
        // strength is what is wanted now (none: the wings hold out, gliding).
        this.beatCount++;
        this.beats = this.flapHeld && !dive ? 1 : Math.max(0, this.beats - 1);
        want = wanted();
        this.power = want > 0.02 ? want : 0;
      }
      if (this.flapPhase > TAU * 4096) this.flapPhase -= TAU * 4096;
      if (this.power > 0) down = Math.max(0, Math.sin(this.flapPhase));
    }
    if (falling || dive) this.power = 0;
    // (The beat drawn eases after the power: the wind-down after the last beat is seen, not cut.)
    const ampT = Math.min(1, this.power);
    this.flapAmp += (ampT - this.flapAmp) * (1 - Math.exp(-h / (ampT > this.flapAmp ? 0.06 : 0.14)));
    if (this.flapAmp < 1e-3 && ampT === 0) this.flapAmp = 0;

    // ── What the wings are asked for: the stoop holds a steep path, a take-off its climb, a righting a
    // level glide; otherwise the stick's lift.
    const v = Math.max(this.speed, V_MIN);
    const q = (v / V_TRIM) ** 2;
    const cg = Math.cos(this.gamma);
    const sg = Math.sin(this.gamma);
    const cb = Math.cos(this.bank);
    this.tuck += ((dive ? 1 : 0) - this.tuck) * (1 - Math.exp(-h / 0.12));
    // The stall: slower than the wings can hold the path at their most lift. The lift saturates (the
    // wings go to C_MAX, a flare) and the path drops; as it develops the nose drops (c eases to 1.1)
    // until the speed is back. Never a spin: the wings level (the bank's half).
    const vs = V_STALL * Math.sqrt(Math.max(0.15, cg) / Math.max(0.5, cb));
    const held = lifting || righting;
    if (!falling && !dive && !held && v < vs) this.stallT = Math.min(STALL_T, this.stallT + h);
    else if (falling || dive || held || v > vs * 1.15) this.stallT = Math.max(0, this.stallT - 2 * h);
    this.stall = smooth(this.stallT / STALL_T);
    /** The lift that turns the path onto angle `g` at K /s. */
    const hold = (g: number, k: number) => clamp((G * cg + v * k * (g - this.gamma)) / (G * q * Math.max(0.5, cb)), -0.3, C_MAX);
    let cT: number;
    // (Tumbling, the flailing wings still catch a little air: it arcs off the bonk, it does not drop.)
    if (falling) cT = 0.45;
    else if (dive) cT = clamp((v * STOOP_K * (STOOP - this.gamma) + G * cg) / (G * q * Math.max(0.3, cb)), -0.15, 0.7);
    else if (lifting) cT = hold(liftG, 6);
    else if (righting) cT = hold(Math.min(-2 * DEG, GLIDE * 0.3), 3);
    else cT = climb >= 0 ? 1 + C_UP * climb : 1 + C_DOWN * climb;
    if (this.stallT > 0) cT = v < vs ? C_MAX + (1.1 - C_MAX) * this.stall : Math.min(cT, 1.1 + (cT - 1.1) * (1 - this.stall));
    this.c += (cT - this.c) * (1 - Math.exp(-h / (dive || held ? 0.06 : C_TAU)));

    // ── Ground effect (the floor the last step found under the bird).
    const agl = hNow - this.floorH - BIRD.belly;
    const ge = agl < GE_H ? smooth(1 - agl / GE_H) : 0;
    const cd0 = falling ? CD0_TUMBLE : CD0 + (CD0_TUCK - CD0) * this.tuck;
    const kInd = K_IND * (1 - 0.45 * ge);
    const thrust = T_AVG * this.power;

    // ── Lift: the reflex that damps the phugoid (the speed's rate of change, with the beats' mean
    // thrust), the turn's pull, the cushion's lift, the downstroke's bump, then the stall and the
    // load limits.
    let c = this.c;
    if (!falling && !dive && !held && this.stallT === 0) {
      // (Bounded, and blind to the body's drag at speed: it damps the swing, it never flies the bird.)
      const vdot = thrust - G * q * (cd0 + kInd * c * c) - G * sg;
      c += clamp((KD * vdot) / G, -REFLEX, REFLEX);
    }
    const pull = 1 + TURN_PULL * (1 / Math.max(0.5, cb) - 1);
    if (!falling) c *= pull;
    c *= 1 + 0.12 * ge;
    // Hands off (no climb held, not beating): the wings never lift the path over the trim glide's
    // line (level, in the cushion). A dive let go of is levelled onto it and its extra speed spilled
    // (the tail fanned, an airbrake), never ballooned up; a climb let go of pushes over onto it at
    // once (up to −1 g). No pitch-up on release, ever. Low and slow, it flares to land.
    const handsOff = !falling && !dive && !held && climb <= 0.02 && this.power < 0.05;
    let spill = 0;
    let flareL = 0;
    let push = -0.3;
    if (handsOff) {
      const gc = GLIDE * (1 - ge);
      const up = this.gamma > 0;
      if (up) push = C_PUSH;
      const cap = (Math.max(up ? C_PUSH * G * q : 0, G * cg + v * (up ? CAP_K_UP : CAP_K) * (gc - this.gamma)) / (G * q)) * pull;
      if (c > cap) {
        spill = smooth((c - cap) / 0.6);
        c = cap;
      }
      // (Nor, slow, does it nose far under the glide to win its speed back — let go of a climb at
      // 6 m/s it dipped to −14°: it settles back onto the line along a path at most SAG under it. Not
      // with S held, nor in a turn: a dive asked for, a turn's sink. Never past a stall: the stall's
      // own law has the wings.)
      if (climb >= -0.02 && Math.abs(steer) < 0.05 && Math.abs(this.bank) < 8 * DEG && this.stallT === 0 && this.gamma < GLIDE - SAG) c = Math.max(c, Math.min(C_MAX, ((G * cg + v * CAP_K * (GLIDE - SAG - this.gamma)) / (G * q * Math.max(0.5, cb))) * pull));
      if (agl < LAND_FLARE_H && v < LAND_FLARE_V) flareL = smooth((LAND_FLARE_H - agl) / 0.8);
    }
    this.spill += (spill - this.spill) * (1 - Math.exp(-h / 0.15));
    this.landFlare += (flareL - this.landFlare) * (1 - Math.exp(-h / 0.12));
    // (Held on a path — a take-off, a righting — the hold already asks for all the lift it needs.)
    if (!held) c += C_FLAP * this.power * down * (1 - this.tuck);
    // W never zooms the path up steeply: at most W_MAX, more only with speed to spare (a swoop out of
    // a stoop still zooms; a take-off handed over at trim speed eases onto the W climb, not up to 30°).
    if (!falling && !dive && !held && climb > 0) c = Math.min(c, Math.max(1, hold(W_MAX + W_ZOOM * Math.max(0, v - 6), 3) * pull));
    const asked = c;
    c = Math.min(c, C_MAX, N_MAX / q);
    c = Math.max(c, push);
    this.lift = c;

    // ── The path: speed, path angle, heading.
    const L = G * q * c;
    const D = G * q * (cd0 + kInd * c * c + AIRBRAKE * this.spill + LAND_BRAKE * this.landFlare) + G * bodyDrag(v);
    const T = thrust * Math.PI * down * (1 - this.tuck);
    this.speed = Math.max(V_MIN, this.speed + (T - D - G * sg) * h);
    let gDot = (L * cb - G * cg) / v;
    // (A glide about as shallow as the trim glide's is eased level in the cushion: the skim. Steeper
    // than ~14° it is not: a dive into the ground is a crash.)
    if (ge > 0 && this.gamma < 0 && !falling) gDot += ge * 2.5 * -this.gamma * smooth((this.gamma + 14 * DEG) / (4 * DEG));
    this.gamma = clamp(this.gamma + gDot * h, -86 * DEG, 86 * DEG);
    this.turn = clamp((L * Math.sin(this.bank)) / (v * Math.max(0.3, cg)), -TURN_MAX, TURN_MAX);
    this.fwd.addScaledVector(_right, this.turn * h);
    tangent(this.fwd, _up);
    // A take-off hands over once it is up to trim speed on its climb (or after LIFT_MAX at most).
    // (On its climb if W or Space is held; else over on the glide's line. Its beats then are only what
    // is asked for now: none, and the wings hold out.)
    if (lifting && ((this.liftT > LIFT_CROUCH + 0.4 && this.speed >= V_TRIM && Math.abs(this.gamma - liftG) < 4 * DEG && (keep || this.liftOver >= 1)) || this.liftT > LIFT_MAX)) {
      this.liftT = -1;
      base = baseW;
      want = wanted();
      this.power = want > 0.02 ? Math.min(this.power, want) : 0;
    }

    // ── Move along the velocity.
    const cg2 = Math.cos(this.gamma);
    _v.copy(this.fwd).multiplyScalar(cg2).addScaledVector(_up, Math.sin(this.gamma)).multiplyScalar(this.speed);
    _b.copy(this.pos); // last good position
    this.pos.addScaledVector(_v, h);
    this.collide(h, hNow, env);
    if (this.grounded) return;

    // ── The ceiling: tops out softly under the space layer.
    let h1 = this.pos.length() - R;
    if (h1 > env.ceiling) {
      h1 = env.ceiling;
      _up.copy(this.pos).normalize();
      this.pos.copy(_up).multiplyScalar(R + h1);
      if (this.gamma > 0) this.gamma = 0;
    }
    this.alt = h1;

    // ── For the animation: the nose over the path, the flare, the turn, the legs (down on a slow
    // approach to a floor within ~2 m, and through a take-off's jump).
    let aT = 2.5 * DEG + 7 * DEG * (Math.min(asked, C_MAX * 1.2) - 1);
    if (dive) aT = -2 * DEG;
    aT = clamp(aT, -4 * DEG, 26 * DEG) + 12 * DEG * this.landFlare;
    this.alpha += (aT - this.alpha) * (1 - Math.exp(-h / 0.08));
    const flare = Math.max(smooth((asked - 1.6) / (C_MAX - 1.6)), dive ? 0 : smooth((V_STALL * 1.4 - this.speed) / (V_STALL * 0.5)), 0.9 * this.crash, 0.7 * this.spill, this.landFlare);
    this.spread += (flare * (1 - this.tuck) - this.spread) * (1 - Math.exp(-h / 0.1));
    this.turnK = clamp(this.bank / BANK_MAX, -1, 1);
    const legsT = lifting && this.liftT < LIFT_CROUCH + 0.45 ? 1 : falling || dive || this.power > 0.3 ? 0 : smooth((2.2 - agl) / 1.2) * smooth((8.5 - this.speed) / 1.5);
    this.legs += (legsT - this.legs) * (1 - Math.exp(-h / 0.15));
    this.stand += (0 - this.stand) * (1 - Math.exp(-h / 0.1));
    this.hop = this.liftT >= 0 && this.liftFrom === LIFT_JUMP && this.liftT < LIFT_CROUCH + 0.25 ? this.liftT / (LIFT_CROUCH + 0.25) : 0;
  }

  /**
   * On the ground: the run-out to a stop (a few hops), then it stands (floats, on water). A / D turn it
   * on the spot in little hops; W or Space takes off (once a crash's daze has passed); S and nothing
   * keep it where it is. Walked off an edge, it is in the air again.
   */
  private ground(h: number, inp: BirdInput, env: BirdEnv, hNow: number): void {
    const steer = clamp(inp.steer || 0, -1, 1);
    const climb = clamp(inp.climb || 0, -1, 1);
    const flap = !!inp.flap;
    if (this.daze > 0) this.daze = Math.max(0, this.daze - h);
    this.crash = this.daze / DAZE;
    const act = this.daze <= DAZE - DAZE_HOLD;
    // Take-off: W, or Space pressed or held.
    if (this.liftT < 0 && act && this.hopT === 0 && (climb > 0.3 || flap)) this.startLift();
    this.flapHeld = flap;
    if (this.liftT >= 0) {
      this.liftT += h;
      this.runV = 0;
      if (this.liftT >= LIFT_CROUCH) {
        // The jump: off the floor, nose up, the first strong beat from the top of the stroke.
        this.grounded = false;
        this.onWater = false;
        this.daze = 0;
        this.crash = 0;
        this.speed = LIFT_V;
        this.gamma = LIFT_JUMP;
        this.c = 1.4;
        this.power = LIFT_P;
        this.beats = 0;
        this.flapPhase = Math.ceil(this.flapPhase / TAU - 1e-9) * TAU;
        this.pos.addScaledVector(_up, 0.03);
        this.floorH = hNow - this.standOff;
        this.alt = this.pos.length() - R;
        this.hop = this.liftT / (LIFT_CROUCH + 0.25);
        return;
      }
    }
    // The run-out: slowing, in hops.
    if (this.runV > 0) {
      this.runV = Math.max(0, this.runV - RUN_DECEL * h);
      this.runT += h;
      this.pos.addScaledVector(this.fwd, this.runV * h);
    }
    // A / D, stopped: a hop on the spot, turning it HOP_YAW (held, hop after hop).
    if (this.liftT < 0 && act && this.runV < 0.3 && this.hopT === 0 && Math.abs(steer) > 0.25) {
      this.hopT = 1e-6;
      this.hopYaw = Math.sign(steer) * HOP_YAW * Math.min(1, Math.abs(steer) * 1.2);
      this.hopDone = 0;
    }
    if (this.hopT > 0) {
      this.hopT += h;
      const u = Math.min(1, this.hopT / HOP_DUR);
      // (Turned while off its feet; + steer turns right: about the up, negative.)
      const k = smooth((u - 0.3) / 0.45);
      this.fwd.applyAxisAngle(_up, -(k - this.hopDone) * this.hopYaw);
      this.hopDone = k;
      if (u >= 1) this.hopT = 0;
    }
    this.hop = this.liftT >= 0 ? this.liftT / (LIFT_CROUCH + 0.25) : this.hopT > 0 ? this.hopT / HOP_DUR : this.runV > 0.4 ? (this.runT / RUN_HOP) % 1 : 0;
    this.turnK = this.hopT > 0 ? Math.sign(this.hopYaw) : 0;
    // Onto its floor: out of any wall the run-out took it into; off an edge, it is flying again.
    _up.copy(this.pos).normalize();
    if (env.wall && env.wall(_up, hNow, BIRD.bodyR, _w)) {
      this.pos.copy(_w).multiplyScalar(hNow + R);
      _up.copy(_w);
      this.runV = 0;
      this.wallHits++;
    }
    tangent(this.fwd, _up);
    const f = env.floor(_up, hNow);
    if (f < this.floorH - 0.6) {
      this.grounded = false;
      this.speed = Math.max(this.runV, 2.5);
      this.gamma = -5 * DEG;
      this.c = 1;
      return;
    }
    this.floorH = f;
    this.onWater = f < 0.05 && (env.water?.(_up) ?? false);
    const off = this.onWater ? BIRD.float + 0.012 * BIRD_SIZE * Math.sin(this.clock * 2.6) : BIRD.belly;
    this.standOff += (off - this.standOff) * (1 - Math.exp(-h / 0.25));
    this.pos.copy(_up).multiplyScalar(R + f + this.standOff);
    this.alt = f + this.standOff;
    this.speed = this.runV;
    this.gamma = 0;
    this.turn = 0;
    springStep(this.bank, this.bankVel, 0, ROLL_W, h, _sp);
    this.bank = _sp[0];
    this.bankVel = _sp[1];
    this.alpha += (0 - this.alpha) * (1 - Math.exp(-h / 0.1));
    this.power = 0;
    this.beats = 0;
    this.flapAmp += (0 - this.flapAmp) * (1 - Math.exp(-h / 0.1));
    this.tuck = this.spill = this.landFlare = this.stall = this.stallT = 0;
    this.spread += ((this.runV > 0.4 ? 0.4 : 0) - this.spread) * (1 - Math.exp(-h / 0.15));
    this.stand += (1 - this.stand) * (1 - Math.exp(-h / 0.2));
    this.legs += ((this.onWater ? 0 : 1) - this.legs) * (1 - Math.exp(-h / 0.12));
    this.touching = true;
  }

  /** Down onto its floor: the run-out begins (from a dazed fall, a short one, and the daze). */
  private land(env: BirdEnv, up: Vector3, along: number): void {
    this.grounded = true;
    this.onWater = this.floorH < 0.05 && (env.water?.(up) ?? false);
    this.runV = Math.min(this.onWater ? 2 : LAND_V, along);
    this.runT = 0;
    if (this.fall) {
      this.daze = DAZE;
      this.runV = Math.min(this.runV, 1.5);
      // (Facing the wall it hit, its take-off went straight back into it: crash, daze, crash.)
      if (this.crashWall) {
        this.fwd.copy(this.wallN);
        tangent(this.fwd, up);
      }
    }
    this.crashWall = false;
    this.fall = false;
    this.tumbleT = 0;
    this.rightT = 0;
    this.liftT = -1;
    this.hopT = 0;
    this.gamma = 0;
    this.power = 0;
    this.beats = 0;
    this.stallT = 0;
    this.alt = this.pos.length() - R;
    this.standOff = this.alt - this.floorH;
    this.landings++;
  }

  /**
   * Walls, then the floor: a glancing touch slides along (a skim), a slow touchdown is a landing, a
   * hard one is a crash. Never left inside anything or under the floor.
   */
  private collide(h: number, hPrev: number, env: BirdEnv): void {
    _up.copy(this.pos).normalize();
    let h1 = this.pos.length() - R;
    if (env.wall && env.wall(_up, hPrev, BIRD.bodyR, _w)) {
      // The wall's outward normal (tangent at the bird).
      _n.copy(_w).sub(_up);
      _n.addScaledVector(_up, -_n.dot(_up));
      if (_n.lengthSq() > 1e-16) {
        _n.normalize();
        this.pos.copy(_w).multiplyScalar(R + h1);
        // Pushed into another (a corner): back to where it was, which was clear — or, if that was
        // inside too (a launch or a restore inside something), up onto the roof: never left inside.
        _up.copy(_w);
        if (env.wall(_up, hPrev, BIRD.bodyR, _a)) {
          _a.copy(_b).normalize();
          if (!env.wall(_a, hPrev, BIRD.bodyR, _v)) {
            this.pos.copy(_b);
            _up.copy(_a);
            h1 = this.pos.length() - R;
          } else {
            h1 = Math.max(h1, env.floor(_up, Infinity) + BIRD.belly);
            this.pos.copy(_up).multiplyScalar(R + h1);
          }
        }
        this.contact(_n, _up, h, env, false);
        this.wallHits++;
      }
    }
    // The floor: terrain or water, the roofs and crowns it came down onto.
    const hRef = Math.max(hPrev, h1);
    const f = env.floor(_up, hRef);
    this.floorH = f;
    if (h1 < f + BIRD.belly) {
      // The surface's normal: the slope from two samples (a roof edge reads as level).
      const s = 0.6;
      _a.copy(_up).multiplyScalar(R).addScaledVector(this.fwd, s).normalize();
      // (A step steeper than ~50° is an edge, not a slope: a roof's edge, a kerb.)
      const edge = (g: number) => (Math.abs(g) > 1.2 ? 0 : g);
      const gx = edge((env.floor(_a, hRef) - f) / s);
      _right.crossVectors(this.fwd, _up).normalize();
      _a.copy(_up).multiplyScalar(R).addScaledVector(_right, s).normalize();
      const gz = edge((env.floor(_a, hRef) - f) / s);
      _n.copy(_up).addScaledVector(this.fwd, -gx).addScaledVector(_right, -gz).normalize();
      h1 = f + BIRD.belly;
      this.pos.copy(_up).multiplyScalar(R + h1);
      this.contact(_n, _up, h, env, true);
      this.hardHits++;
    }
  }

  /**
   * Meet a surface of unit normal n at the bird (up = its radial up; `floor`: under it, not a wall):
   * land, skim, or crash and bounce.
   */
  private contact(n: Vector3, up: Vector3, h: number, env: BirdEnv, floor: boolean): void {
    this.touching = true;
    tangent(this.fwd, up);
    _v.copy(this.fwd).multiplyScalar(Math.cos(this.gamma)).addScaledVector(up, Math.sin(this.gamma)).multiplyScalar(this.speed);
    const vn = _v.dot(n);
    if (vn >= 0) return;
    const along = Math.sqrt(Math.max(0, _v.lengthSq() - vn * vn));
    // Falling dazed, the floor is where it lands, however it comes down.
    if (floor && this.fall) {
      this.land(env, up, along);
      return;
    }
    // (Righting itself or falling, what it meets it slides along: a crash is the player's flying,
    // never one a recovery made: no crash loop.)
    if (-vn > V_CRASH && !this.fall && this.rightT === 0) {
      // The bonk: bounce off the normal, friction on the tangent; tumble.
      if (this.tumbleT === 0) {
        this.crashes++;
        this.crash = 1;
        this.tumbleT = TUMBLE;
        this.liftT = -1;
        this.stallT = 0;
        this.beats = 0;
        this.power = 0;
        this.crashWall = false;
        this.tumbleAxis.crossVectors(n, _v);
        if (this.tumbleAxis.lengthSq() < 1e-8) this.tumbleAxis.crossVectors(this.fwd, up);
        this.tumbleAxis.normalize();
      }
      this.bonks++;
      this.impact = Math.min(1, -vn / 8);
      _a.copy(_v).addScaledVector(n, -vn).multiplyScalar(1 - FRICTION);
      _v.copy(_a).addScaledVector(n, -vn * REST);
    } else if (floor && this.tumbleT === 0 && this.liftT < 0 && n.dot(up) > LANDABLE && along < LAND_V) {
      // Slow enough, on something flat enough: a landing.
      this.land(env, up, along);
      return;
    } else {
      // A skim: the speed into the surface taken away, a little more lost to the touch.
      _v.addScaledVector(n, -vn);
      _v.multiplyScalar(Math.max(0, 1 - (0.6 + 0.4 * -vn) * h));
    }
    // Back to the path: speed, path angle, heading — away from a wall it bounced off.
    const sp = _v.length();
    const vu = _v.dot(up);
    _a.copy(_v).addScaledVector(up, -vu);
    const hz = _a.length();
    if (hz > 1e-4) this.fwd.copy(_a).divideScalar(hz);
    _w.copy(n).addScaledVector(up, -n.dot(up));
    const nh = _w.length();
    if (nh > 0.5) {
      // A wall: remembered for the righting; after a bonk the heading leaves it at ≥ ~20°, never
      // along or into it (no crash loop).
      _w.divideScalar(nh);
      this.wallN.copy(_w);
      this.wallT = 0.6;
      if (this.tumbleT > 0 || this.fall) this.crashWall = true;
      if (this.tumbleT > 0) leave(this.fwd, _w, up, hz <= 1e-4);
    }
    tangent(this.fwd, up);
    this.speed = Math.max(V_MIN, sp);
    this.gamma = clamp(Math.atan2(vu, Math.max(hz, 1e-6)), -86 * DEG, 86 * DEG);
  }

  /** Derived frame: velocity direction, the body's up and attitude. */
  private frame(): void {
    _up.copy(this.pos).normalize();
    tangent(this.fwd, _up);
    const cg = Math.cos(this.gamma);
    const sg = Math.sin(this.gamma);
    this.dir.copy(this.fwd).multiplyScalar(cg).addScaledVector(_up, sg).normalize();
    _right.crossVectors(this.fwd, _up).normalize();
    // The path's up, banked toward the turn, then pitched by the angle of attack.
    _a.copy(_up).multiplyScalar(cg).addScaledVector(this.fwd, -sg);
    _a.multiplyScalar(Math.cos(this.bank)).addScaledVector(_right, Math.sin(this.bank)).normalize();
    const ca = Math.cos(this.alpha);
    const sa = Math.sin(this.alpha);
    _b.copy(this.dir).multiplyScalar(ca).addScaledVector(_a, sa); // nose
    this.up.copy(_a).multiplyScalar(ca).addScaledVector(this.dir, -sa).normalize();
    _w.crossVectors(this.up, _b).normalize(); // left
    _m.makeBasis(_w, this.up, _b);
    this.quat.setFromRotationMatrix(_m);
    if (this.tumbleT > 0) {
      // The tumble: spun about the bonk's axis, fast at first and slowing (TURNS turns), and over its
      // last third eased back onto the flying attitude (it rights itself; never a snap).
      const u = 1 - this.tumbleT / TUMBLE;
      _q.setFromAxisAngle(this.tumbleAxis, TURNS * TAU * (1 - (1 - u) * (1 - u))).multiply(this.quat);
      _q.slerp(this.quat, smooth((u - 0.65) / 0.35));
      this.quat.copy(_q);
    }
  }
}
