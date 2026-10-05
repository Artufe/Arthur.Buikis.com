// Bird flight (D1, V2 §4 "fly like a bird"): an arcade flight model, pure math on three's Vector3.
//
//   - Steer banks (up to 55°) and the bank turns the heading like a coordinated turn (g·tan φ / v),
//     so a hard turn is a tight, leaning carve; let go and it levels itself.
//   - Climb / descend set the flight-path angle (springs, never instant); climbing costs speed,
//     descending and the dive (Shift: wings tucked, nose down) build it; drag pulls back to a cruise.
//     A climbing bird flaps on its own (it never stalls), Space flaps for a burst of speed and lift.
//   - A soft floor: the terrain, water, roofs and tree crowns under and AHEAD of the bird (sampled
//     along its track up to ~1.6 s out) ask for the climb angle that clears them by a margin, so it
//     swoops up over a ridge or a tower instead of hitting it; a hard floor and wall push-out are
//     the last resort. It tops out softly under the space layer.
//
// Frames: the heading `fwd` is tangent at the bird; `dir` is the velocity direction (heading
// pitched by the flight-path angle); `up` is the body's up (pitched and banked). Bank > 0 = the
// right wing down (turning right); right = fwd × up.

import { Vector3 } from 'three';
import { R } from '../../world/config';
import { springStep } from '../model';

const DEG = Math.PI / 180;

export interface BirdInput {
  /** −1 … 1: left … right. */
  steer: number;
  /** −1 … 1: descend … climb. */
  climb: number;
  /** Flap (held repeats). */
  flap: boolean;
  /** Tuck and dive. */
  dive: boolean;
}

export interface BirdEnv {
  /**
   * The soft floor (m above sea level) at unit dir: terrain or water, roofs nearby, tree crowns,
   * lamp heads. The bird steers to clear it by a margin; it may brush through a crown, never pops.
   */
  floor(dir: Vector3): number;
  /** The hard floor (m above sea level) at unit dir: terrain or water and the roof directly under it. */
  hard(dir: Vector3): number;
  /**
   * Push a body of radius r at unit dir, height h (m above sea level), out of the walls it is inside
   * (building footprints taller than h). Writes the resolved unit dir into out; true if it moved.
   */
  wall?(dir: Vector3, h: number, r: number, out: Vector3): boolean;
  /** Highest the bird may fly (m above sea level). */
  ceiling: number;
}

export const BIRD = {
  /** m/s */
  cruise: 13,
  min: 6.5,
  max: 38,
  bankMax: 55 * DEG,
  climb: 28 * DEG,
  descend: 24 * DEG,
  dive: 50 * DEG,
  /** Soft floor clearance (m): cruising, and while the player holds it low on purpose. */
  margin: 3.2,
  marginLow: 1.4,
  /** Hard floor clearance (m). */
  hard: 0.6,
  /** Ceiling soft band (m). */
  band: 16,
  /** Body radius against walls (m). */
  bodyR: 0.55,
  /** Wingspan (m), for the camera and the cloud overlay's hole. */
  span: 1.8,
} as const;

/** Look-ahead times (s) for the soft floor. */
const AHEAD = [0.25, 0.6, 1.0, 1.6];
/** A floor ahead asking for more than this climb (rad) makes the bird look left and right, and swerve. */
const SWERVE_FROM = 16 * DEG;
/** How far to each side it looks (rad off the heading). */
const SWERVE_LOOK = 38 * DEG;
/** Once it picks a side to swerve to, it keeps it at least this long (s): no dithering left-right. */
const SWERVE_HOLD = 0.8;
/** How fast the swerve's own steer may change (per s). */
const SWERVE_RATE = 3;
/** How fast the wall avoidance's steer may change (per s). */
const WALL_RATE = 4;
/** Sliding along a facade, the heading turns onto the wall at most this fast (rad/s): never a snap. */
const WALL_TURN = 1.3;
/**
 * Walls ahead: the bird keeps this far (m) off a facade taller than it, steering away from one its
 * turning path would meet within WALL_LOOK s (the player's steer into it is overruled smoothly).
 */
const WALL_KEEP = 2.8;
const WALL_LOOK = [0.18, 0.4, 0.7, 1.0] as const;
const SUBSTEP = 1 / 60;
/** Fastest heading turn (rad/s). */
const TURN_MAX = 1.25;

const _up = new Vector3();
const _right = new Vector3();
const _a = new Vector3();
const _w = new Vector3();
const _w2 = new Vector3();
const _sp = [0, 0];

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

function tangent(v: Vector3, n: Vector3): Vector3 {
  v.addScaledVector(n, -v.dot(n));
  if (v.lengthSq() < 1e-12) v.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).addScaledVector(n, -(Math.abs(n.y) < 0.9 ? n.y : n.x));
  return v.normalize();
}

export class BirdFlight {
  readonly pos = new Vector3(0, 0, R + 40);
  /** Heading (unit, tangent at the bird). */
  readonly fwd = new Vector3(0, 1, 0);
  /** Velocity direction (unit). */
  readonly dir = new Vector3(0, 1, 0);
  /** Body up (unit, pitched and banked). */
  readonly up = new Vector3(0, 0, 1);
  speed: number = BIRD.cruise;
  /** Flight-path angle (rad, + = climbing) and its rate. */
  gamma = 0;
  private gammaVel = 0;
  /** Bank (rad, + = right wing down) and its rate. */
  bank = 0;
  private bankVel = 0;
  /** Heading turn rate (rad/s, + = turning right). */
  turn = 0;
  /** Wing cycle phase (rad) and how hard it is flapping (0 glide … 1 full), the dive tuck (0 … 1). */
  flapPhase = 0;
  flapAmp = 0.3;
  tuck = 0;
  /** Seconds left of the current flap's push, and before the next flap may start. */
  private flapT = 0;
  private flapCool = 0;
  /** A glide's occasional idle flaps (visual): time to the next burst. */
  private idleT = 1.2;
  /** The floor's own steer this step (−1 … 1: swerving left … right round an obstacle). */
  swerve = 0;
  /** The side it is swerving to (−1 / 1; 0 = none) and how long it has kept it. */
  private swerveSide = 0;
  private swerveAge = 0;
  /** The wall avoidance's own steer (−1 … 1). */
  wallAvoid = 0;
  /** True on the frame the soft floor (or the hard floor / a wall) had to step in. */
  floorBusy = false;
  hardHits = 0;
  /** Height above sea level and the floor under the bird, last step. */
  alt = 40;
  floorH = 0;

  reset(pos: Vector3, heading: Vector3, speed: number = BIRD.cruise): void {
    this.pos.copy(pos);
    _up.copy(pos).normalize();
    this.fwd.copy(heading);
    tangent(this.fwd, _up);
    this.speed = Math.min(BIRD.max, Math.max(BIRD.min, speed));
    this.gamma = 0;
    this.gammaVel = 0;
    this.bank = 0;
    this.bankVel = 0;
    this.turn = 0;
    this.flapT = 0;
    this.flapCool = 0;
    this.flapAmp = 0.6;
    this.tuck = 0;
    this.hardHits = 0;
    this.swerve = 0;
    this.swerveSide = 0;
    this.swerveAge = 0;
    this.wallAvoid = 0;
    this.frame();
  }

  /** Advance dt seconds (sub-stepped at ≤ 1/60 s). */
  step(dt: number, inp: BirdInput, env: BirdEnv): void {
    if (!(dt > 0)) return;
    this.floorBusy = false;
    let left = Math.min(dt, 0.5);
    while (left > 1e-9) {
      const h = Math.min(SUBSTEP, left);
      this.sub(h, inp, env);
      left -= h;
    }
    this.frame();
  }

  /**
   * The point t s ahead along a turn at `turn` rad/s from heading `dir` (unit tangent; right = _right),
   * as a unit direction into out: the arc the bird is actually flying, not the straight line.
   */
  private ahead(dir: Vector3, turn: number, t: number, hNow: number, out: Vector3): Vector3 {
    const v = this.speed * Math.cos(this.gamma);
    let fx: number;
    let ry: number;
    if (Math.abs(turn) < 1e-3) {
      fx = v * t;
      ry = 0;
    } else {
      fx = (v / turn) * Math.sin(turn * t);
      ry = (v / turn) * (1 - Math.cos(turn * t));
    }
    const r = R + hNow;
    out.copy(_up).multiplyScalar(r).addScaledVector(dir, fx).addScaledVector(_right, ry);
    return out.normalize();
  }

  /**
   * The climb angle (rad) that clears the soft floor (+ margin) along unit tangent `dir` from here,
   * over the look-ahead samples (on the arc of the current turn).
   */
  private needAlong(dir: Vector3, hNow: number, margin: number, env: BirdEnv, turn = 0): number {
    let need = -Infinity;
    for (let i = 0; i < AHEAD.length; i++) {
      const t = AHEAD[i];
      this.ahead(dir, turn, t, hNow, _a);
      const g = Math.atan2(env.floor(_a) + margin - hNow, Math.max(1, this.speed * t));
      if (g > need) need = g;
    }
    return need;
  }

  /**
   * Walls ahead on the current turn: −1 … 1, the steer that keeps WALL_KEEP m off them (+ = to the
   * right), 0 when the way is clear.
   */
  private wallSteer(hNow: number, env: BirdEnv): number {
    if (!env.wall) return 0;
    let s = 0;
    for (let i = 0; i < WALL_LOOK.length; i++) {
      const t = WALL_LOOK[i];
      this.ahead(this.fwd, this.turn, t, hNow, _a);
      if (!env.wall(_a, hNow, WALL_KEEP, _w2)) continue;
      // The push out of the wall (tangent at the bird): its side tells which way to steer.
      _w2.sub(_a);
      const depth = _w2.length() * (R + hNow);
      if (depth < 1e-4) continue;
      const side = _w2.dot(_right) >= 0 ? 1 : -1;
      // (Head-on, the push is straight back: steer the way it is already turning.)
      const lat = Math.abs(_w2.normalize().dot(_right));
      const dirn = lat > 0.25 ? side : this.turn !== 0 ? Math.sign(this.turn) : side;
      const k = Math.min(1, depth / WALL_KEEP) * (1.15 - t);
      if (Math.abs(k) > Math.abs(s)) s = dirn * k;
    }
    return Math.max(-1, Math.min(1, s * 1.6));
  }

  private sub(h: number, inp: BirdInput, env: BirdEnv): void {
    let steer = Math.max(-1, Math.min(1, inp.steer || 0));
    const climb = Math.max(-1, Math.min(1, inp.climb || 0));
    _up.copy(this.pos).normalize();
    tangent(this.fwd, _up);
    const hNow = this.pos.length() - R;
    _right.crossVectors(this.fwd, _up).normalize();

    // ── The soft floor ahead: the climb it asks for, and (when that is steep: a tower, a cliff)
    // which side is clearer — the bird swerves round a tall building rather than climbing its wall.
    const low = climb < -0.1 || inp.dive;
    const margin = low ? BIRD.marginLow : BIRD.margin;
    let need = this.needAlong(this.fwd, hNow, margin, env, this.turn);
    let swerveT = 0;
    this.swerveAge += h;
    if (need > SWERVE_FROM) {
      _w.copy(this.fwd).multiplyScalar(Math.cos(SWERVE_LOOK)).addScaledVector(_right, -Math.sin(SWERVE_LOOK));
      const nl = this.needAlong(_w, hNow, margin, env);
      _w.copy(this.fwd).multiplyScalar(Math.cos(SWERVE_LOOK)).addScaledVector(_right, Math.sin(SWERVE_LOOK));
      const nr = this.needAlong(_w, hNow, margin, env);
      const k = smooth((need - SWERVE_FROM) / (25 * DEG));
      // Pick a side (the clearer one, or the way the player already leans), then keep it for a
      // while unless the other side becomes clearly better: never a left-right dither.
      const pref = Math.abs(nl - nr) > 3 * DEG ? Math.sign(nl - nr) : steer !== 0 ? Math.sign(steer) : this.swerveSide || 1;
      if (this.swerveSide === 0 || (pref !== this.swerveSide && this.swerveAge > SWERVE_HOLD && Math.abs(nl - nr) > 10 * DEG)) {
        this.swerveSide = pref;
        this.swerveAge = 0;
      }
      swerveT = this.swerveSide * Math.max(0.5, Math.min(1, Math.abs(nl - nr) / (20 * DEG))) * k;
      // The chosen side is the way: ask only for the climb that side needs.
      const nSide = this.swerveSide > 0 ? nr : nl;
      need = Math.min(need, Math.max(nSide, need - k * Math.max(0, need - nSide)));
    } else if (this.swerveAge > 0.4) this.swerveSide = 0;
    const ds = SWERVE_RATE * h;
    this.swerve += Math.max(-ds, Math.min(ds, swerveT - this.swerve));
    steer = Math.max(-1, Math.min(1, steer + this.swerve * 1.2));
    // Walls ahead on the turn it is making: steer off them (smoothly; the player's steer into the
    // wall gives way), so it slides past a facade at a bird's berth instead of scraping along it.
    const wT = this.wallSteer(hNow, env);
    const dw = WALL_RATE * h;
    this.wallAvoid += Math.max(-dw, Math.min(dw, wT - this.wallAvoid));
    if (this.wallAvoid !== 0) {
      const a = Math.min(1, Math.abs(this.wallAvoid));
      const into = Math.sign(steer) === -Math.sign(this.wallAvoid) ? steer * (1 - a) : steer;
      steer = Math.max(-1, Math.min(1, into + this.wallAvoid));
    }
    const f0 = env.floor(_up);
    this.floorH = f0;
    // Under the bird right now: the margin itself (a gentle push back up out of the soft zone).
    need = Math.max(need, Math.atan2(f0 + margin - hNow, Math.max(2, this.speed * 0.35)));

    // ── Bank and turn.
    const bankT = steer * BIRD.bankMax * (inp.dive ? 0.55 : 1);
    springStep(this.bank, this.bankVel, bankT, 5.5, h, _sp);
    this.bank = _sp[0];
    this.bankVel = _sp[1];
    // (At most ~72°/s: a slow bird carving at full bank turned on a 4 m circle, the chase camera
    // spinning round after it.)
    this.turn = Math.max(-TURN_MAX, Math.min(TURN_MAX, (9.8 * Math.tan(this.bank)) / Math.max(this.speed, 8)));
    this.fwd.addScaledVector(_right, this.turn * h);
    tangent(this.fwd, _up);

    // ── Flight-path angle: input, then the floor and the ceiling.
    let gT = climb > 0 ? climb * BIRD.climb : climb * BIRD.descend;
    if (inp.dive) gT = -BIRD.dive;
    if (this.flapT > 0) gT += 6 * DEG;
    let omega = 3.2;
    if (need > gT) {
      gT = Math.min(55 * DEG, need);
      omega = 5.5;
      this.floorBusy = true;
    }
    const top = env.ceiling;
    const cap = BIRD.climb + (-6 * DEG - BIRD.climb) * smooth((hNow - (top - BIRD.band)) / BIRD.band);
    if (gT > cap) gT = Math.max(cap, Math.min(gT, need));
    springStep(this.gamma, this.gammaVel, gT, omega, h, _sp);
    this.gamma = Math.max(-75 * DEG, Math.min(75 * DEG, _sp[0]));
    this.gammaVel = _sp[1];

    // ── Flaps: Space (repeats while held), and on its own while climbing hard or slow.
    this.flapCool -= h;
    this.flapT = Math.max(0, this.flapT - h);
    if (inp.flap && this.flapCool <= 0 && !inp.dive) {
      this.flapT = 0.3;
      this.flapCool = 0.36;
    }

    // ── Speed: gravity along the path (mostly paid back by flapping on a climb), drag toward the
    // cruise (less with the wings tucked), the flap's push.
    const sg = Math.sin(this.gamma);
    let acc = -9.8 * sg * (sg > 0 ? 0.42 : 0.9);
    acc += (BIRD.cruise - this.speed) * (inp.dive ? 0.1 : this.speed > BIRD.cruise ? 0.3 : 0.55);
    if (this.flapT > 0) acc += 10;
    if (this.speed < BIRD.min + 1.5) acc += 4; // never stall
    this.speed = Math.max(BIRD.min, Math.min(BIRD.max, this.speed + acc * h));

    // ── Move along the velocity, carry the heading onto the new up.
    const cg = Math.cos(this.gamma);
    _a.copy(this.fwd).multiplyScalar(cg).addScaledVector(_up, sg);
    this.pos.addScaledVector(_a, this.speed * h);
    _up.copy(this.pos).normalize();
    tangent(this.fwd, _up);

    // ── Walls first (a facade beside a low bird pushes it along the street, so the roof never
    // counts as under it and lifts it with a pop), then the hard floor and the ceiling.
    let h1 = this.pos.length() - R;
    if (env.wall && env.wall(_up, h1, BIRD.bodyR, _w)) {
      // Slide: the body is pushed out of the wall at once, but the heading turns onto the wall's
      // tangent no faster than WALL_TURN (never reflected, never reversed); a little speed is lost.
      _a.copy(_w).sub(_up);
      _a.addScaledVector(_w, -_a.dot(_w));
      if (_a.lengthSq() > 1e-14) {
        _a.normalize(); // the wall's outward normal (tangent at the bird)
        const into = this.fwd.dot(_a);
        if (into < 0) {
          // Along the wall: the side the heading already leans to (head-on: the way it turns).
          _w2.crossVectors(_a, _w).normalize();
          let side = this.fwd.dot(_w2);
          if (Math.abs(side) < 0.08) side = Math.sign(this.turn) * Math.sign(_w2.dot(_right)) || 1;
          _w2.multiplyScalar(Math.sign(side));
          const ang = Math.acos(Math.max(-1, Math.min(1, this.fwd.dot(_w2))));
          // (With what it is turning already, the heading never turns faster than ~83°/s.)
          const rate = Math.max(0.25, Math.min(WALL_TURN, 1.45 - Math.abs(this.turn)));
          const t = ang > 1e-6 ? Math.min(1, (rate * h) / ang) : 1;
          this.fwd.lerp(_w2, t);
          tangent(this.fwd, _w);
        }
      }
      this.pos.copy(_w).multiplyScalar(R + h1);
      _up.copy(_w);
      tangent(this.fwd, _up);
      this.speed = Math.max(BIRD.min, this.speed * (1 - 0.6 * h));
      this.floorBusy = true;
    }
    const f1 = env.hard(_up);
    if (h1 < f1 + BIRD.hard) {
      h1 = f1 + BIRD.hard;
      this.pos.copy(_up).multiplyScalar(R + h1);
      if (this.gamma < 0) {
        this.gamma = 0;
        this.gammaVel = Math.max(0, this.gammaVel);
      }
      this.floorBusy = true;
      this.hardHits++;
    }
    if (h1 > top) {
      h1 = top;
      this.pos.copy(_up).multiplyScalar(R + h1);
      if (this.gamma > 0) {
        this.gamma = 0;
        this.gammaVel = Math.min(0, this.gammaVel);
      }
    }
    this.alt = h1;

    // ── The wings (visual): flapping while pushing, climbing or slow; a glide with an occasional
    // burst of idle flaps; folded back in a dive.
    this.idleT -= h;
    let want = 0.12;
    if (this.flapT > 0) want = 1;
    else if (this.gamma > 6 * DEG || this.speed < BIRD.cruise - 2.5) want = 0.8;
    else if (this.idleT < 0) {
      want = 0.65;
      if (this.idleT < -0.9) this.idleT = 2.2 + ((this.flapPhase * 7.31) % 1.7);
    }
    if (inp.dive) want = 0;
    this.flapAmp += (want - this.flapAmp) * (1 - Math.exp(-h * (want > this.flapAmp ? 9 : 3)));
    this.tuck += ((inp.dive ? 1 : 0) - this.tuck) * (1 - Math.exp(-h * 5));
    const freq = 1.6 + 1.6 * this.flapAmp + (this.flapT > 0 ? 0.8 : 0);
    this.flapPhase = (this.flapPhase + 2 * Math.PI * freq * h * Math.max(0.25, this.flapAmp)) % (Math.PI * 200);
  }

  /** Derived frame: velocity direction and the banked body up. */
  private frame(): void {
    _up.copy(this.pos).normalize();
    const cg = Math.cos(this.gamma);
    const sg = Math.sin(this.gamma);
    this.dir.copy(this.fwd).multiplyScalar(cg).addScaledVector(_up, sg).normalize();
    _right.crossVectors(this.fwd, _up).normalize();
    // Up pitched with the path, then banked toward the turn.
    _a.copy(_up).multiplyScalar(cg).addScaledVector(this.fwd, -sg);
    this.up.copy(_a).multiplyScalar(Math.cos(this.bank)).addScaledVector(_right, Math.sin(this.bank)).normalize();
  }
}
