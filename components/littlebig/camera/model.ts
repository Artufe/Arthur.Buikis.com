// The camera model (BRIEF §4) as pure math, no three.js. One continuous model, no visible modes:
//
//   state: focus (unit dir of the surface point under the camera), fwd (unit tangent at focus: the
//   heading direction; storing a vector instead of an angle keeps it stable over the poles),
//   log-altitude with a critically damped spring toward a target, the user's look offsets, an
//   optional absolute pitch override (setView), the smoothed ground reference, and an FPV jump.
//
//   pose: eye = focus · (R + ground + lift + alt + jump), where ground is the terrain/water (or city
//   ground) reference and lift the smoothed extra height that clears roofs; the view pitches from straight down (orbit) to just
//   below the horizon (street) as altitude drops; FOV widens from 40° to 70°; the user's look
//   offsets blend in near the ground.
//
// camera/index.ts drives this from input; specs cover the curves and the pose.

import { R, SPACE_MAX } from '../world/config';
import { copy3, cross3, dot3, headingOf, horizonDistance, normalize3, orthonormalizeTangent, rotateAxis, set3, v3, type Vec3 } from '../world/sphere';

const DEG = Math.PI / 180;

/** Altitudes where the curves bend (m). */
export const ALT_TOPDOWN = 120;
export const ALT_LOW = 4;
export const PITCH_LOW = -8 * DEG;
export const PITCH_EYE = -4 * DEG;
export const FOV_ORBIT = 40;
export const FOV_STREET = 56;

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

const LOG_LOW = Math.log(ALT_LOW / 1.7);
const LOG_TOP = Math.log(ALT_TOPDOWN / ALT_LOW);
/** Upper segment's start slope, as a fraction of its total drop per unit of its log parameter. */
const K_UP = 0.39;
/** Mid-curve flattening (keeps the horizon in frame lower in the dive); zero value and slope at both ends. */
const D_UP = 1.5;
/** Lower segment's slope at eye height (rad per unit of its log parameter): eases into the street pose. */
const M_EYE = -2 * DEG;
/** Slope at ALT_LOW matched across the knot, in each segment's own parameter. */
const M_KNOT_UP = (-Math.PI / 2 - PITCH_LOW) * K_UP;
const M_KNOT_LOW = (M_KNOT_UP * LOG_LOW) / LOG_TOP;

/**
 * Altitude-driven pitch (rad): −90° above ALT_TOPDOWN, −8° at 4 m, −4° at eye height. One
 * monotone C1 curve in log-altitude (two cubic Hermite segments with the slope matched at 4 m), so
 * the horizon never stalls or kicks on a steady descent; flat where it meets top-down.
 */
export function pitchForAlt(alt: number): number {
  if (alt >= ALT_TOPDOWN) return -Math.PI / 2;
  if (alt <= 1.7) return PITCH_EYE;
  if (alt <= ALT_LOW) {
    const t = Math.log(alt / 1.7) / LOG_LOW;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * PITCH_EYE + (t3 - 2 * t2 + t) * M_EYE + (-2 * t3 + 3 * t2) * PITCH_LOW + (t3 - t2) * M_KNOT_LOW;
  }
  const u = Math.log(alt / ALT_LOW) / LOG_TOP;
  const u2 = u * u;
  const u3 = u2 * u;
  const f = -2 * u3 + 3 * u2 + K_UP * (u3 - 2 * u2 + u) - D_UP * u2 * (1 - u) * (1 - u);
  return PITCH_LOW + (-Math.PI / 2 - PITCH_LOW) * f;
}

/** FOV knots (alt m, vertical deg): a toy-diorama lens, not a GoPro. */
const FOV_KNOTS: Array<[number, number]> = [
  [1.7, FOV_STREET],
  [8, 45],
  [60, 43],
  [300, FOV_ORBIT],
];

/**
 * Vertical FOV (deg) by altitude: 56° at street level, a long ~43–45° from rooftops to the cloud
 * layer (towers at the frame edge stay upright: it reads as a model, not a fisheye), 40° in orbit.
 * Monotone, eased in log-altitude between knots.
 */
export function fovForAlt(alt: number): number {
  const a = Math.max(1.7, alt);
  for (let i = 1; i < FOV_KNOTS.length; i++) {
    const [a1, f1] = FOV_KNOTS[i];
    if (a <= a1 || i === FOV_KNOTS.length - 1) {
      const [a0, f0] = FOV_KNOTS[i - 1];
      return f0 + (f1 - f0) * smooth(Math.log(a / a0) / Math.log(a1 / a0));
    }
  }
  return FOV_ORBIT;
}

/** Widest horizontal FOV (deg) on a wide canvas. */
export const MAX_HFOV = 84;

/**
 * The vertical FOV for a canvas aspect (w / h): capped so the horizontal FOV never passes MAX_HFOV
 * (a 21:9 window would otherwise stretch the frame edges), and widened on portrait canvases (a
 * phone held upright) so the horizontal view does not shrink to a slit: there the vertical FOV
 * grows with 1/√aspect, up to 80°.
 */
export function lensFov(vfov: number, aspect: number): number {
  const t = Math.tan((vfov * DEG) / 2);
  let v = vfov;
  if (aspect < 1) v = Math.min(80, (2 * Math.atan(t / Math.sqrt(Math.max(0.2, aspect)))) / DEG);
  const capV = (2 * Math.atan(Math.tan((MAX_HFOV * DEG) / 2) / Math.max(0.2, aspect))) / DEG;
  return Math.min(v, capV);
}

/**
 * Portrait canvases from orbit: widen the vertical FOV until the whole planet fits 85 % of the
 * frame's width. lensFov's portrait widening alone left a phone held upright (390×844: horizontal
 * FOV ≈ 28°) cropping both limbs of a planet that subtends ≈ 34° at alt 380, so the toy planet was
 * never whole. Blends in from 120 m (where the view is already straight down) to 260 m, capped at
 * 80° (it fits from ~340 m up: the default orbit and the zoom-out ceiling); landscape canvases are
 * untouched. `eyeDist` is the eye's distance from the planet centre.
 */
export function orbitFitFov(vfov: number, aspect: number, alt: number, eyeDist: number): number {
  if (aspect >= 1 || eyeDist <= R) return vfov;
  const w = smooth((alt - ALT_TOPDOWN) / (260 - ALT_TOPDOWN));
  if (w <= 0) return vfov;
  // The disc's silhouette on the image plane has radius tan(half its angle) (it is centred: the
  // view looks straight down from here); 85 % of the frame's half-width.
  const half = Math.asin(Math.min(1, R / eyeDist));
  const needV = (2 * Math.atan(Math.tan(half) / 0.85 / Math.max(0.2, aspect))) / DEG;
  return Math.max(vfov, Math.min(80, vfov + (needV - vfov) * w));
}

/**
 * Vertical lens shift (fraction of the frame height, ≥ 0) for an altitude and view pitch: the
 * architectural / tilt-shift trick. The camera's axis pitches up and the frustum shifts down by the
 * same angle at frame centre, so the centre ray stays at `pitch` while the image plane stands more
 * upright: verticals converge less and 10–40 m reads as a model. None at street level (already
 * upright), none from orbit (a shifted globe would go oval), none on a near-level view.
 */
export function lensShift(alt: number, pitch: number): number {
  const a = smooth((Math.log(Math.max(alt, 1.7)) - Math.log(3)) / (Math.log(8) - Math.log(3)));
  const b = 1 - smooth((Math.log(Math.max(alt, 1.7)) - Math.log(55)) / (Math.log(110) - Math.log(55)));
  const p = smooth((-pitch - 10 * DEG) / (14 * DEG));
  return 0.16 * a * b * p;
}

/** How much drag means "look around" rather than "spin the planet": 1 at ≤ 6 m, 0 at ≥ 60 m. */
export function lookBlend(alt: number): number {
  const u = Math.log(Math.max(alt, 0.01) / 6) / Math.log(60 / 6);
  return 1 - smooth(u);
}

/**
 * Adaptive clip planes for the eye at `alt` above the surface and `altSea` above sea level. The far
 * plane reaches the farthest thing that can still show over the horizon: v2's space layer (a
 * satellite at SPACE_MAX on the far side of the eye's horizon), so the station and satellites are
 * never clipped from the street, a ride or orbit. (Depth precision is set by the near plane; the far
 * one costs nothing measurable.)
 */
export function clipPlanes(alt: number, altSea: number, out: { near: number; far: number }): { near: number; far: number } {
  out.near = Math.min(30, Math.max(0.05, alt * 0.03));
  out.far = horizonDistance(R, Math.max(0, altSea)) + horizonDistance(R, SPACE_MAX) + 40;
  return out;
}

/** One exact step of a critically damped spring (frame-rate independent). Writes out[0]=x, out[1]=v. */
export function springStep(x: number, v: number, target: number, omega: number, dt: number, out: Float64Array | number[]): void {
  const y = x - target;
  const e = Math.exp(-omega * dt);
  const tmp = v + omega * y;
  out[0] = target + (y + tmp * dt) * e;
  out[1] = (v - omega * tmp * dt) * e;
}

/**
 * Roof-lift weight for a building whose footprint is `d` m away (≤ 0 inside): 1 within `margin`,
 * easing to 0 over `width` beyond it. The lift asks for (roof + clearance − eye) × this, so it swells
 * up as a tower approaches instead of stepping.
 */
export function liftRamp(d: number, margin: number, width: number): number {
  if (d <= margin) return 1;
  if (width <= 0) return 0;
  return 1 - smooth((d - margin) / width);
}

/**
 * Time (s) until a point at plan (x, z) moving at (vx, vz) m/s enters an oriented box (centre bx,
 * bz, rotation `angle` like Building.angle, half extents hw × hd): 0 if already inside, Infinity if
 * it never does. 2D slab test in the box frame. Pure; the roof lift's look-ahead.
 */
export function timeToBox(x: number, z: number, vx: number, vz: number, bx: number, bz: number, angle: number, hw: number, hd: number): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = x - bx;
  const dz = z - bz;
  const lx = dx * c + dz * s;
  const lz = -dx * s + dz * c;
  const ux = vx * c + vz * s;
  const uz = -vx * s + vz * c;
  let t0 = 0;
  let t1 = Infinity;
  for (let k = 0; k < 2; k++) {
    const p = k === 0 ? lx : lz;
    const u = k === 0 ? ux : uz;
    const h = k === 0 ? hw : hd;
    if (Math.abs(u) < 1e-9) {
      if (p < -h || p > h) return Infinity;
      continue;
    }
    let a = (-h - p) / u;
    let b = (h - p) / u;
    if (a > b) {
      const tmp = a;
      a = b;
      b = tmp;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Walking speed (m/s). */
export const WALK = 4.2;
export const RUN = 9;

/**
 * Movement speed for keys / stick (m/s): walking pace at street level, a pan that scales with
 * altitude above it (≈ 0.7 m/s per metre, capped), ×2 when running.
 */
export function moveSpeed(alt: number, look: number, run: boolean): number {
  if (look > 0.95) return run ? RUN : WALK;
  const pan = Math.min(160, Math.max(WALK, alt * 0.7));
  return pan * (run ? 2 : 1);
}

/** Exponential approach of x toward target at `rate` (1/s), frame-rate independent. */
export function approach(x: number, target: number, rate: number, dt: number): number {
  return target + (x - target) * Math.exp(-rate * dt);
}

export interface CamState {
  focus: Vec3;
  fwd: Vec3;
  logAlt: number;
  logAltVel: number;
  logAltTarget: number;
  lookPitch: number;
  lookYaw: number;
  /** Absolute pitch from setView (rad), or NaN. */
  pitchOverride: number;
  /** 1 = the override fully applies; decays to 0 once the user interacts. */
  overrideWeight: number;
  /** Smoothed terrain/water (or city ground) height under the camera (m above sea level). Roofs are not part of it. */
  ground: number;
  groundVel: number;
  /** Smoothed extra eye height that clears roofs under / near the camera (m, ≥ 0). */
  lift: number;
  liftVel: number;
  /** FPV jump height above eye height (m) and its vertical speed. */
  jump: number;
  jumpVel: number;
}

export function createCamState(): CamState {
  return {
    focus: v3(0, 0, 1),
    fwd: v3(0, 1, 0),
    logAlt: Math.log(380),
    logAltVel: 0,
    logAltTarget: Math.log(380),
    lookPitch: 0,
    lookYaw: 0,
    pitchOverride: NaN,
    overrideWeight: 0,
    ground: 0,
    groundVel: 0,
    lift: 0,
    liftVel: 0,
    jump: 0,
    jumpVel: 0,
  };
}

export interface Pose {
  eye: Vec3;
  /** Look direction (unit). */
  dir: Vec3;
  /** Camera up (unit, ⟂ dir). */
  up: Vec3;
  alt: number;
  pitch: number;
  heading: number;
  fov: number;
}

export function createPose(): Pose {
  return { eye: v3(), dir: v3(), up: v3(), alt: 0, pitch: 0, heading: 0, fov: 60 };
}

const _f = v3();

/** Compute the camera pose for a state. Zero-alloc. */
export function computePose(s: CamState, out: Pose): Pose {
  const alt = Math.exp(s.logAlt);
  const w = lookBlend(alt);
  let pitch = pitchForAlt(alt) + w * s.lookPitch;
  if (s.overrideWeight > 0 && Number.isFinite(s.pitchOverride)) pitch += (s.pitchOverride - pitch) * s.overrideWeight;
  pitch = Math.max(-Math.PI / 2, Math.min(80 * DEG, pitch));
  const up = s.focus;
  // Yaw offset: heading is clockwise seen from above, i.e. a negative rotation about up.
  copy3(_f, s.fwd);
  if (w * s.lookYaw !== 0) rotateAxis(_f, _f, up, -w * s.lookYaw);
  orthonormalizeTangent(_f, up);
  const c = Math.cos(pitch);
  const sn = Math.sin(pitch);
  set3(out.dir, _f.x * c + up.x * sn, _f.y * c + up.y * sn, _f.z * c + up.z * sn);
  normalize3(out.dir);
  set3(out.up, up.x * c - _f.x * sn, up.y * c - _f.y * sn, up.z * c - _f.z * sn);
  normalize3(out.up);
  const r = R + s.ground + s.lift + alt + s.jump;
  set3(out.eye, up.x * r, up.y * r, up.z * r);
  out.alt = alt + s.jump;
  out.pitch = pitch;
  out.heading = headingOf(up, _f);
  out.fov = fovForAlt(alt);
  return out;
}

/** Right vector of a pose (dir × up), for screen-space math. */
export function poseRight(p: Pose, out: Vec3): Vec3 {
  return normalize3(cross3(out, p.dir, p.up));
}

export { dot3 };
