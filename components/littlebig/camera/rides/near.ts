// Near trips (D1f r2): onto something a few metres away, in clear sight, low down — the walker
// beside you, the car across the street. No crane and no planned path (the general planner rose 14 m
// and spun over the street to reach a walker 2 m behind the camera, the walker off screen all the
// way): the camera turns on the spot until the subject is in frame, then glides round it in the
// subject's own moving frame — its distance, height and bearing from the subject eased from where
// the camera is to the ride's rest framing (into someone's eyes: round to over their shoulder, then
// down into them) — looking at the subject all the way, and settles onto the ride's own look over
// the last half second. ~1–2 s; the planned view never turns faster than W_MAX.
//
// Pure math on three's Vector3 / Quaternion; the world comes in through NearEnv.

import { Quaternion, Vector3 } from 'three';
import { R } from '../../world/config';
import { lookQuat, type FramePose } from './blend';

const DEG = Math.PI / 180;
/** A subject within this (m) of the camera, in clear sight, gets a near trip. */
export const NEAR_D = 34;
/** Planned turn rates (rad/s): the turn on the spot, and the swing round the subject. */
const W_TURN = 175 * DEG;
const W_SWING = 160 * DEG;
/** The sampled plan never turns faster than this (rad/s): it is stretched until it does not. */
export const NEAR_W_MAX = 188 * DEG;
/** The turn's ramp in and out (s). */
const RAMP = 0.24;
/** The glide's ramp in and out (s). (D1f r5: 0.24, was 0.3 — the first 0.2 s after the click barely moved.) */
const GLIDE_RAMP = 0.24;
/** Into someone's eyes: the swing ends this far behind and above them (m), then drops in. */
const SHOULDER_BACK = 1.6;
const SHOULDER_UP = 0.75;
/** The drop from the shoulder into the eyes (s), and the settle onto the ride's look (s; into the eyes). */
const DROP = 0.55;
const SETTLE = 0.5;
/** Into the eyes the swing ends this long (s) before the trip: the drop and the settle come after it. */
const EYES_TAIL = 0.45;
/** The swing's variants, in order: [lift (m; the first is the default), widening (m)] at its middle. */
const LIFTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.7, 2.5],
  [2.5, 0],
  [2.5, 3],
  [5, 0],
  [8, 0],
];
/** Longest near trip (s): ordinarily, and at most. */
const DUR_SOFT = 2.2;
const DUR_CAP = 2.4;
/** The glide keeps this far (m) off facades (the clearance's radius) — no scrape past a wall. */
const BERTH = 1.1;

export interface NearEnv {
  /**
   * True when a camera at world `pos` would be within `berth` m of a facade taller than it, inside
   * (or within ~0.45 m of) a pole, a lamp head or a crown, or under the terrain's margin.
   */
  blocked(pos: Vector3, berth: number): boolean;
  /** True when nothing solid (a building, the terrain) stands between a and b. */
  sight(a: Vector3, b: Vector3): boolean;
}

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Progress (0 … 1) at time t of a move over [t0, t1] whose speed ramps in and out over r s each
 * (smoothstep ramps, constant between): the peak rate is 1 / (t1 − t0 − r).
 */
export function rampEase(t: number, t0: number, t1: number, r: number): number {
  const L = t1 - t0;
  if (L <= 1e-6) return t >= t1 ? 1 : 0;
  const x = Math.min(1, Math.max(0, (t - t0) / L));
  const q = Math.min(0.5, r / L);
  if (q < 1e-6) return x;
  const I = (s: number) => s * s * s - (s * s * s * s) / 2;
  const area = 1 - q;
  if (x < q) return (q * I(x / q)) / area;
  if (x > 1 - q) return 1 - (q * I((1 - x) / q)) / area;
  return (q * 0.5 + (x - q)) / area;
}

const _sa = new Vector3();
/** Unit a turned toward unit b by fraction t of the angle between them (nearly opposite: about `up`). */
function slerpDir(a: Vector3, b: Vector3, t: number, up: Vector3, out: Vector3): Vector3 {
  const c = Math.max(-1, Math.min(1, a.dot(b)));
  const ang = Math.acos(c);
  if (ang < 1e-6 || t <= 0) return out.copy(a);
  if (t >= 1) return out.copy(b);
  _sa.crossVectors(a, b);
  if (_sa.lengthSq() < 1e-6) _sa.copy(up).addScaledVector(a, -a.dot(up));
  if (_sa.lengthSq() < 1e-8) _sa.set(Math.abs(a.x) < 0.9 ? 1 : 0, Math.abs(a.x) < 0.9 ? 0 : 1, 0).cross(a);
  _sa.normalize();
  return out.copy(a).applyAxisAngle(_sa, ang * t);
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class NearTrip {
  /** Length (s), the turn on the spot (s), when the glide starts (s) and how long it takes (s). */
  T = 1;
  ta = 0;
  t0 = 0;
  tm = 1;
  /** The swing round the subject (rad, signed; + = anticlockwise seen from above). */
  dphi = 0;
  /** Raised over what the swing passes (m, at its middle), and widened round the subject (m). */
  lift = 0;
  wide = 0;
  eyes = false;
  /** Review: the planned turn on the spot (rad) and the sampled peak turn rate (rad/s). */
  turn = 0;
  peak = 0;
  peakT = 0;
  readonly peaks: number[] = [];
  /** Review: per candidate swing (way round × lift), the first progress that was blocked (−1: clear). */
  readonly blockedAt: number[] = [];
  /** The gaze aims this far along the subject's up from its pose point (m; the eyes: at the chest). */
  private aimUp = 0;
  // The start's offset from the subject, in the subject's frame (bearing 0 along `ref`).
  private readonly ref = new Vector3();
  private rhoS = 0;
  private zS = 0;
  /** The end bearing, unwrapped against the planned swing (follows a live subject's turns). */
  private phiE = 0;
  // scratch
  private readonly U = new Vector3();
  private readonly e1 = new Vector3();
  private readonly e2 = new Vector3();
  private readonly v = new Vector3();
  private readonly w = new Vector3();
  private readonly cam = new Vector3();
  private readonly aim = new Vector3();
  private readonly g = new Vector3();
  private readonly f0 = new Vector3();
  /** The start's roll off a level horizon (rad). */
  private roll0 = 0;
  /** The turn's planned yaw (rad, signed: the way round). */
  private yawPlan = 0;
  private readonly tw = new Vector3();
  /** The turn's goal: where the subject was planned to be by the turn's end, from the start. */
  private readonly gFix = new Vector3();
  private readonly fE = new Vector3();
  private readonly up = new Vector3();
  private readonly q1 = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly cyl = [0, 0, 0];
  private readonly kP = new Vector3();
  private readonly fp: FramePose = {
    pos: new Vector3(),
    quat: new Quaternion(),
    look: new Vector3(),
    fov: 50,
    shift: 0,
  };

  /** The subject's frame at K: U up, e1 along ref (bearing 0), e2 = U × e1. */
  private frame(K: Vector3): void {
    this.U.copy(K).normalize();
    this.e1.copy(this.ref).addScaledVector(this.U, -this.ref.dot(this.U));
    if (this.e1.lengthSq() < 1e-10) this.e1.set(Math.abs(this.U.x) < 0.9 ? 1 : 0, Math.abs(this.U.x) < 0.9 ? 0 : 1, 0).addScaledVector(this.U, -(Math.abs(this.U.x) < 0.9 ? this.U.x : this.U.y));
    this.e1.normalize();
    this.e2.crossVectors(this.U, this.e1);
  }

  /** Where the swing ends, as (ρ, φ, z) in the frame at K (call frame(K) first). */
  private endOf(endOff: Vector3, endQuat: Quaternion, out: number[]): void {
    if (this.eyes) {
      // Behind and above the eyes, along the ride's own look (horizontal).
      this.w.set(0, 0, -1).applyQuaternion(endQuat);
      this.w.addScaledVector(this.U, -this.w.dot(this.U));
      if (this.w.lengthSq() < 1e-8) this.w.copy(this.e1);
      this.w.normalize().negate();
      out[0] = SHOULDER_BACK;
      out[1] = Math.atan2(this.w.dot(this.e2), this.w.dot(this.e1));
      out[2] = endOff.dot(this.U) + SHOULDER_UP;
      return;
    }
    const z = endOff.dot(this.U);
    this.w.copy(endOff).addScaledVector(this.U, -z);
    out[0] = this.w.length();
    out[1] = out[0] > 1e-4 ? Math.atan2(this.w.dot(this.e2), this.w.dot(this.e1)) : 0;
    out[2] = z;
  }

  /**
   * Plan a near trip from a camera at S with orientation qS onto a subject at K0 moving at vK (m/s),
   * whose ride ends at K + endOff with orientation endQuat. False when no swing round it is clear
   * (then the general planner takes the trip).
   */
  plan(S: Vector3, qS: Quaternion, K0: Vector3, vK: Vector3, endOff: Vector3, endQuat: Quaternion, eyes: boolean, env: NearEnv): boolean {
    this.eyes = eyes;
    this.aimUp = eyes ? -0.2 : 0;
    this.U.copy(K0).normalize();
    this.v.subVectors(S, K0);
    this.zS = this.v.dot(this.U);
    this.w.copy(this.v).addScaledVector(this.U, -this.zS);
    this.rhoS = this.w.length();
    if (this.rhoS > 0.2) this.ref.copy(this.w).divideScalar(this.rhoS);
    else {
      // (Right over it: bearing 0 is the way the camera looks back from.)
      this.ref.set(0, 0, 1).applyQuaternion(qS);
      this.rhoS = 0;
    }
    this.frame(K0);
    // The turn on the spot: from the start's look to the subject.
    this.f0.set(0, 0, -1).applyQuaternion(qS);
    this.up.copy(S).normalize();
    lookQuat(this.f0, this.up, 0, this.q1);
    this.w.set(0, 1, 0).applyQuaternion(this.q1); // the level frame's up
    this.v.set(0, 1, 0).applyQuaternion(qS);
    this.roll0 = -Math.atan2(this.e2.crossVectors(this.w, this.v).dot(this.f0), this.w.dot(this.v));
    this.frame(K0);
    this.aim.copy(K0).addScaledVector(this.U, this.aimUp);
    this.g.subVectors(this.aim, S).normalize();
    const theta = Math.acos(Math.max(-1, Math.min(1, this.f0.dot(this.g))));
    this.turn = theta;
    // The swing: either way round to the end's bearing; the cheaper clear one (lifted over what it
    // passes if need be). Its cost: the view's whole turn, plus a little per metre of lift.
    this.endOf(endOff, endQuat, this.cyl);
    const rhoE = this.cyl[0];
    const phiE = wrap(this.cyl[1]);
    const zE = this.cyl[2];
    let best = Infinity;
    let bestPhi = 0;
    let bestLift = -1;
    this.wide = 0;
    // (The long way round only up to 230°: an orbit of 290° round someone 2 m off is a merry-go-round.)
    const longWay = phiE - Math.sign(phiE) * 2 * Math.PI;
    const alts = Math.abs(phiE) > 20 * DEG && Math.abs(longWay) < 230 * DEG ? [phiE, longWay] : [phiE];
    this.blockedAt.length = 0;
    this.peaks.length = 0;
    // (A berth off facades; along a sidewalk beside a wall, where both ends are close to it, a
    // narrower one.)
    for (const berth of [BERTH, 0.45]) {
      if (bestLift >= 0) break;
      for (const dphi of alts) {
        // (From street level, a little over the heads of the people on the way.)
        const lift0 = this.zS < 2.5 ? (eyes ? 0.7 : 1.1) : 0;
        // (Each a lift over what is in the way, or a swing a little wider round the subject.)
        for (let li = 0; li < LIFTS.length; li++) {
          const lift = li === 0 ? lift0 : LIFTS[li][0];
          const wide = LIFTS[li][1];
          if (lift >= 8 && this.zS <= 5 && !eyes) continue;
          let blocked = false;
          let hidden = 0;
          for (let k = 1; k <= 20 && !blocked; k++) {
            const p = k / 20;
            // (The subject where it will be about then.)
            this.kP.copy(K0).addScaledVector(vK, p * 1.4);
            this.frame(this.kP);
            const rho = this.rhoS + (rhoE - this.rhoS) * p + wide * Math.sin(Math.PI * p);
            const z = this.zS + (zE - this.zS) * p + lift * Math.sin(Math.PI * p);
            this.cylTo(rho, dphi * p, z, this.v);
            this.cam.copy(this.kP).add(this.v);
            // (The start is where the camera is — perhaps beside a wall — and the end is the ride's.)
            if (p > 0.15 && p < 0.9 && env.blocked(this.cam, berth)) {
              blocked = true;
              this.blockedAt.push(p);
            } else if (k % 4 === 0) {
              this.aim.copy(this.kP).addScaledVector(this.U, this.aimUp);
              if (!env.sight(this.cam, this.aim)) hidden++;
            }
          }
          if (blocked) continue;
          this.blockedAt.push(-1);
          const cost = theta + Math.abs(dphi) + lift * 0.08 + hidden * 0.25;
          const c2 = cost + wide * 0.1;
          if (c2 < best) {
            best = c2;
            bestPhi = dphi;
            bestLift = lift;
            this.wide = wide;
          }
          break;
        }
      }
    }
    if (bestLift < 0) return false;
    this.dphi = bestPhi;
    this.lift = bestLift;
    this.phiE = bestPhi;
    // Timing: the turn at W_TURN; the glide starts once the subject is about in frame (≤ 30° off
    // the axis); it swings at W_TURN and covers its metres at a gentle pace.
    // (A subject walking or driving past close by moves across the view on its own: the turn
    // leaves room for that.)
    this.w.subVectors(K0, S);
    const dK = Math.max(1, this.w.length());
    this.v.copy(vK).addScaledVector(this.w, -vK.dot(this.w) / (dK * dK));
    const wTurn = Math.max(110 * DEG, W_TURN - (0.8 * this.v.length()) / dK);
    this.ta = theta < 3 * DEG ? 0 : theta / wTurn + RAMP;
    this.t0 = theta > 30 * DEG ? Math.max((theta - 30 * DEG) / wTurn + RAMP * 0.5, this.ta - RAMP - 0.1) : 0.06;
    this.frame(K0);
    this.cylTo(rhoE, bestPhi, zE, this.w);
    this.cylTo(this.rhoS, 0, this.zS, this.v);
    const metres = this.v.distanceTo(this.w) + (eyes ? SHOULDER_BACK : 0) + bestLift * 1.5;
    this.tm = Math.max(eyes ? 0.95 : 0.8, Math.abs(bestPhi) / W_SWING + GLIDE_RAMP + (eyes ? EYES_TAIL : 0), 0.4 + metres / (16 + 0.8 * Math.max(0, this.zS)));
    this.T = Math.max(this.ta, this.t0 + this.tm);
    this.frame(K0);
    this.gFix
      .copy(K0)
      .addScaledVector(vK, this.ta * 0.8)
      .addScaledVector(this.U, this.aimUp)
      .sub(S)
      .normalize();
    // The way round: the short one, unless it sweeps across a wall within 4.5 m and the long one
    // (a turn of more than ~100°) is open.
    this.up.copy(S).normalize();
    this.w.copy(this.f0).addScaledVector(this.up, -this.f0.dot(this.up));
    this.v.copy(this.gFix).addScaledVector(this.up, -this.gFix.dot(this.up));
    this.yawPlan = 0;
    if (this.w.lengthSq() > 1e-8 && this.v.lengthSq() > 1e-8) {
      this.w.normalize();
      this.v.normalize();
      const yaw = Math.atan2(this.tw.crossVectors(this.w, this.v).dot(this.up), this.w.dot(this.v));
      this.yawPlan = yaw;
      if (Math.abs(yaw) > 100 * DEG) {
        const open = (y: number) => {
          let clear = 0;
          for (const f of [0.3, 0.5, 0.7]) {
            this.cam.copy(this.w).applyAxisAngle(this.up, y * f).multiplyScalar(4.5).add(S);
            if (env.sight(S, this.cam)) clear++;
          }
          return clear;
        };
        const alt = yaw - Math.sign(yaw) * 2 * Math.PI;
        if (open(alt) > open(yaw)) this.yawPlan = alt;
      }
    }
    // The plan as it will play (the subject moving on as predicted): stretched until no frame turns
    // faster than W_MAX.
    // (Where the peak is: in the turn, the turn and the glide's start are stretched; in the glide,
    // the glide.)
    for (let it = 0; it < 4; it++) {
      this.peak = this.peakRate(S, qS, K0, vK, endOff, endQuat);
      this.peaks.push(+(this.peak / DEG).toFixed(0), +this.peakT.toFixed(2), +this.T.toFixed(2));
      if (this.peak <= NEAR_W_MAX) break;
      const k = Math.min(1.35, (this.peak / NEAR_W_MAX) * 1.02);
      if (this.peakT < this.t0 + 0.15) {
        this.ta *= k;
        this.t0 *= k;
      } else this.tm *= k;
      this.T = Math.max(this.ta, this.t0 + this.tm);
      if (this.T > DUR_CAP) break;
    }
    // (Over the cap, the glide gives — the turn on the spot keeps its pace; 2.2 s, or up to 2.4 s
    // where squeezing the glide into 2.2 would turn the view too fast.)
    if (this.T > DUR_SOFT) {
      const tm0 = this.tm;
      this.tm = Math.max(0.6, DUR_SOFT - this.t0);
      this.T = Math.max(this.ta, this.t0 + this.tm);
      this.peak = this.peakRate(S, qS, K0, vK, endOff, endQuat);
      if (this.peak > NEAR_W_MAX + 10 * DEG) {
        this.tm = Math.max(0.6, Math.min(tm0, DUR_CAP - this.t0));
        this.T = Math.max(this.ta, this.t0 + this.tm);
        this.peak = this.peakRate(S, qS, K0, vK, endOff, endQuat);
      }
    }
    this.phiE = bestPhi;
    return true;
  }

  /**
   * The gaze turned from the start's look (f0) toward this.g by fraction w, into this.g: about the
   * local up (the yaw the way planned: the open side on a turn of more than ~100°) and in pitch, so
   * a turn round never sweeps the view across a wall beside the camera when the other way is open.
   */
  private turnTo(w: number): void {
    if (w >= 1) return;
    const U = this.up;
    const p0 = Math.asin(Math.max(-1, Math.min(1, this.f0.dot(U))));
    const p1 = Math.asin(Math.max(-1, Math.min(1, this.g.dot(U))));
    this.w.copy(this.f0).addScaledVector(U, -this.f0.dot(U));
    this.v.copy(this.g).addScaledVector(U, -this.g.dot(U));
    if (this.w.lengthSq() < 1e-8 || this.v.lengthSq() < 1e-8) {
      slerpDir(this.f0, this.g, w, U, this.g);
      return;
    }
    this.w.normalize();
    this.v.normalize();
    let yaw = Math.atan2(this.tw.crossVectors(this.w, this.v).dot(U), this.w.dot(this.v));
    // (Unwrapped onto the planned way round.)
    yaw += Math.round((this.yawPlan - yaw) / (2 * Math.PI)) * 2 * Math.PI;
    this.w.applyAxisAngle(U, yaw * w);
    const p = p0 + (p1 - p0) * w;
    this.g.copy(this.w).multiplyScalar(Math.cos(p)).addScaledVector(U, Math.sin(p));
  }

  /** Offset (ρ, φ, z) in the current frame, into out. */
  private cylTo(rho: number, phi: number, z: number, out: Vector3): Vector3 {
    return out
      .copy(this.e1)
      .multiplyScalar(rho * Math.cos(phi))
      .addScaledVector(this.e2, rho * Math.sin(phi))
      .addScaledVector(this.U, z);
  }

  /** The sampled plan's fastest turn (rad/s). */
  private peakRate(S: Vector3, qS: Quaternion, K0: Vector3, vK: Vector3, endOff: Vector3, endQuat: Quaternion): number {
    const n = Math.max(24, Math.ceil(this.T * 60));
    const phi0 = this.phiE;
    let m = 0;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * this.T;
      this.kP.copy(K0).addScaledVector(vK, t);
      this.pose(t, S, qS, this.kP, endOff, endQuat, 50, 50, 0, 0, this.fp);
      if (i > 0) {
        const r = this.q2.angleTo(this.fp.quat) / (this.T / n);
        if (r > m) this.peakT = t;
        m = Math.max(m, r);
      }
      this.q2.copy(this.fp.quat);
    }
    this.phiE = phi0;
    return m;
  }

  /**
   * The trip at time t (s) into out: Sc / qS the coasting start, K the live subject (pose point),
   * endOff / endQuat the ride's live rest framing (its camera at K + endOff), the lens from → to.
   */
  pose(t: number, Sc: Vector3, qS: Quaternion, K: Vector3, endOff: Vector3, endQuat: Quaternion, fov0: number, fov1: number, sh0: number, sh1: number, out: FramePose): FramePose {
    const T = this.T;
    this.frame(K);
    // The end bearing, live (a car turning, a walker changing course), kept continuous.
    this.endOf(endOff, endQuat, this.cyl);
    this.phiE += wrap(this.cyl[1] - this.phiE);
    const rhoE = this.cyl[0];
    const zE = this.cyl[2];
    // (Into the eyes the swing ends first, at the shoulder; the drop and the settle follow it.)
    const tEnd = this.eyes ? Math.max(this.t0 + 0.3, T - EYES_TAIL) : T;
    const p = rampEase(t, this.t0, tEnd, GLIDE_RAMP);
    const rho = this.rhoS + (rhoE - this.rhoS) * p + this.wide * Math.sin(Math.PI * p);
    const z = this.zS + (zE - this.zS) * p + this.lift * Math.sin(Math.PI * p);
    this.cylTo(rho, this.phiE * p, z, this.v);
    // Into the eyes: down from over the shoulder (the head is hidden from 1.6 m).
    if (this.eyes) {
      // Forward over the head first, then down into it (the head, hidden only from ~1.2 m, stays
      // under the frame instead of growing at its bottom edge).
      const sd = smooth01((t - (T - DROP)) / DROP);
      if (sd > 0) {
        const vz = this.v.dot(this.U);
        const ez = endOff.dot(this.U);
        this.v.addScaledVector(this.U, -vz);
        this.w.copy(endOff).addScaledVector(this.U, -ez);
        this.v.lerp(this.w, Math.pow(sd, 0.6)).addScaledVector(this.U, vz + (ez - vz) * Math.pow(sd, 1.7));
      }
    }
    // The camera joins the subject's frame as the glide begins (it starts where it is, coasting).
    const a = smooth01((t - (this.t0 - 0.1)) / Math.max(0.2, 0.55 * this.tm + 0.1));
    this.cam.copy(K).add(this.v);
    if (a < 1) {
      this.cylTo(this.rhoS, 0, this.zS, this.w);
      this.w.add(K).sub(Sc).negate(); // Sc − (K + start offset)
      this.cam.addScaledVector(this.w, 1 - a);
    }
    // The gaze: from the start's look, turned onto the subject, settled onto the ride's look.
    this.up.copy(this.cam).normalize();
    // (Into the eyes: the aim rises from the chest to the head as the drop begins, so the settle
    // onto their look is a small tilt up, not a whip from looking down at them.)
    const aimUp = this.eyes ? this.aimUp * (1 - smooth01((t - (tEnd - 0.35)) / 0.35)) : this.aimUp;
    this.aim.copy(K).addScaledVector(this.U, aimUp);
    this.g.subVectors(this.aim, this.cam);
    const dAim = this.g.length();
    if (dAim > 1e-4) this.g.divideScalar(dAim);
    else this.g.set(0, 0, -1).applyQuaternion(endQuat);
    this.f0.set(0, 0, -1).applyQuaternion(qS);
    // (The turn heads for where the subject was planned to be by its end, and hands over to the live
    // direction as it finishes: a big slerp toward a moving point swings up to 3× as fast as it.)
    const wA = this.ta > 0 ? rampEase(t, 0, this.ta, RAMP) : smooth01(t / 0.25);
    const wL = smooth01((wA - 0.55) / 0.45);
    if (wL < 1) slerpDir(this.gFix, this.g, wL, this.up, this.g);
    this.turnTo(wA);
    this.fE.set(0, 0, -1).applyQuaternion(endQuat);
    const st = this.eyes ? T - tEnd + 0.15 : SETTLE;
    const wE = smooth01((t - (T - st)) / st);
    slerpDir(this.g, this.fE, wE, this.up, this.g);
    // Orientation: the start's own swung onto the gaze, levelled over the turn, the ride's own at
    // the end.
    // (Level from the start: the start's own roll, if any, eased out over the turn — a minimal
    // rotation of a 130° turn that also tips the gaze down rolled the horizon by 20°.)
    lookQuat(this.g, this.up, this.roll0 * (1 - wA), this.q1);
    this.q1.slerp(endQuat, wE);
    out.quat.copy(this.q1);
    out.pos.copy(this.cam);
    out.look.copy(this.cam).addScaledVector(this.w.set(0, 0, -1).applyQuaternion(out.quat), Math.max(2, dAim));
    const wF = smooth01(t / T);
    out.fov = fov0 + (fov1 - fov0) * wF;
    out.shift = sh0 + (sh1 - sh0) * wF;
    return out;
  }
}
