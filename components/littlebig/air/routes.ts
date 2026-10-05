// Air traffic as closed-form schedules (B3). Pure TS, no three.js: every plane and balloon is a
// function of sim time, so they are persistent (same t ⇒ same sky), never spawn, never teleport,
// and a time jump needs no replay.
//
// Planes fly tilted great circles above the cloud layer (PLANE_MIN…PLANE_MAX) with a gentle
// lateral S-weave (λ below), which is what makes them bank. A route is the great circle through
// `a` toward `b` (orthonormal), n = a × b its pole:
//   θ(t)  = phase + ω·t
//   d0    = a·cos θ + b·sin θ
//   λ     = weave · sin(weaveK·θ + weavePh)        (lateral offset, rad of arc)
//   dir   = d0·cos λ + n·sin λ
//   alt   = alt + altAmp · sin(altK·θ + altPh)
//   pos   = dir · (R + alt)
// The contrail shader (shaders.ts, `airPath`) evaluates the same formula at past θ, so the trail
// is laid exactly where the plane flew. Keep the two in step.
//
// Balloons drift slow loops round the city's outskirts (plan space, below the cloud base, above
// every roof): radius and height wobble a little, the envelope turns slowly.

import { planToDir } from '../world/city/frame';
import { PLANE_MAX, PLANE_MIN, R } from '../world/config';
import { cross3, dirFromLatLon, headingVector, normalize3, v3, type Vec3 } from '../world/sphere';

const TAU = Math.PI * 2;

export interface Route {
  a: Vec3;
  b: Vec3;
  n: Vec3;
  /** Angular speed along the route (rad/s). */
  omega: number;
  /** θ at t = 0 (rad). */
  phase: number;
  weave: number;
  weaveK: number;
  weavePh: number;
  /** Mean flight altitude above sea level (m) and its slow wobble. */
  alt: number;
  altAmp: number;
  altK: number;
  altPh: number;
  /** Size multiplier of the plane mesh (≈ 9 m wingspan at 1). */
  scale: number;
  /** Livery colour index (index.ts LIVERIES). */
  livery: number;
}

export interface RouteSpec {
  /** A point on the route, as lat/lon (deg) or as a city plan point (m), and the compass heading there (deg). */
  lat?: number;
  lon?: number;
  px?: number;
  pz?: number;
  heading: number;
  /** Where on the route the plane is at t = 0 (deg of arc past the point). */
  at: number;
  weave: number;
  weaveK: number;
  weavePh: number;
  alt: number;
  altAmp: number;
  altK: number;
  scale: number;
  livery: number;
}

/**
 * Every plane flies the same angular speed (one lap of the planet every PLANE_LAP s, ≈ 16 m/s), and
 * the weave and altitude wobble are whole multiples of θ, so the relative phases never drift: the
 * whole sky repeats every lap, and routes.spec.ts checking one lap checks all time. (With per-route
 * speeds two planes slid into each other every ~21 min.)
 */
export const PLANE_LAP = 90;
export const PLANE_OMEGA = TAU / PLANE_LAP;

// Over the town a plane passes every 20-50 s, never two together: route 0 right over the north side
// at t = 0 (crossing the sky of the `street` view, which looks north), route 1 half a lap later
// (southbound), route 3 skimming the west side at ~70 s; route 2 sweeps the far side as an accent
// from orbit. Headings east, south, north-north-west and south on four different circles, so the
// four never travel as a squadron. Phases are chosen so every pair stays far apart horizontally at
// every moment (any two great circles cross twice; with one ω the timing offset is the same at both
// crossings): spec ≥ 18 m (it is ~90 m), with no altitude-stacking exemption, since stacked planes
// overlap on screen seen from above or below. Altitudes still differ (depth variety); the lowest
// flies at 63 m, clear of the tallest cumulus crown (≈ 61 m).
const SPECS: RouteSpec[] = [
  { px: -8, pz: 42, heading: 344, at: -180, weave: 0.11, weaveK: 4, weavePh: 0, alt: 63.6, altAmp: 0.3, altK: 2, scale: 1.0, livery: 0 },
  { px: -11, pz: -38, heading: 230, at: 0, weave: 0.1, weaveK: 4, weavePh: Math.PI, alt: 69.0, altAmp: 0.3, altK: 3, scale: 0.92, livery: 1 },
  { lat: -28.4, lon: 3, heading: 6, at: 130.5, weave: 0.12, weaveK: 4, weavePh: 5.5, alt: 74.4, altAmp: 0.3, altK: 2, scale: 1.08, livery: 2 },
  { lat: -10.8, lon: 13, heading: 132.5, at: 239, weave: 0.12, weaveK: 4, weavePh: 5.5, alt: 79.6, altAmp: 0.3, altK: 3, scale: 0.95, livery: 3 },
];

export function makeRoute(s: RouteSpec): Route {
  const a = s.px !== undefined ? planToDir(s.px, s.pz ?? 0) : dirFromLatLon(s.lat ?? 0, s.lon ?? 0);
  const b = headingVector(a, (s.heading * Math.PI) / 180);
  const n = normalize3(v3(), cross3(v3(), a, b));
  const at = (s.at * Math.PI) / 180;
  return {
    a,
    b,
    n,
    omega: PLANE_OMEGA,
    phase: at,
    weave: s.weave,
    weaveK: s.weaveK,
    weavePh: s.weavePh,
    alt: s.alt,
    altAmp: s.altAmp,
    altK: s.altK,
    altPh: s.weavePh * 1.7,
    scale: s.scale,
    livery: s.livery,
  };
}

export const ROUTES: readonly Route[] = SPECS.map(makeRoute);

/** θ of a route at time t, reduced to [0, 2π) (the shader gets this, never a large angle). */
export function routeTheta(r: Route, t: number): number {
  const th = (r.phase + r.omega * t) % TAU;
  return th < 0 ? th + TAU : th;
}

/** World position on the route at angle θ. */
export function routePos(r: Route, th: number, out: Vec3): Vec3 {
  const c = Math.cos(th);
  const s = Math.sin(th);
  const lam = r.weave * Math.sin(r.weaveK * th + r.weavePh);
  const cl = Math.cos(lam);
  const sl = Math.sin(lam);
  const k = R + r.alt + r.altAmp * Math.sin(r.altK * th + r.altPh);
  out.x = ((r.a.x * c + r.b.x * s) * cl + r.n.x * sl) * k;
  out.y = ((r.a.y * c + r.b.y * s) * cl + r.n.y * sl) * k;
  out.z = ((r.a.z * c + r.b.z * s) * cl + r.n.z * sl) * k;
  return out;
}

export interface PlanePose {
  pos: Vec3;
  /** Unit nose direction, banked up and left (left = up × fwd), and the bank angle (rad, + = left wing down). */
  fwd: Vec3;
  up: Vec3;
  left: Vec3;
  bank: number;
}

export const newPose = (): PlanePose => ({ pos: v3(), fwd: v3(), up: v3(), left: v3(), bank: 0 });

/** Cartoon gravity for the bank angle, the exaggeration on top, and the cap (rad). */
const G = 9.8;
const BANK_GAIN = 1.5;
const BANK_MAX = 0.55;
const H = 1e-3;
const _p = v3();
const _m = v3();

/** The plane's pose at time t: on the route, nose along the velocity, banked into the turn. */
export function planePose(r: Route, t: number, out: PlanePose): PlanePose {
  const th = routeTheta(r, t);
  routePos(r, th, out.pos);
  routePos(r, th + H, _p);
  routePos(r, th - H, _m);
  const f = out.fwd;
  f.x = _p.x - _m.x;
  f.y = _p.y - _m.y;
  f.z = _p.z - _m.z;
  normalize3(f);
  // Lateral acceleration (m/s²): second difference along the level left axis.
  const w2 = (r.omega * r.omega) / (H * H);
  const ax = (_p.x - 2 * out.pos.x + _m.x) * w2;
  const ay = (_p.y - 2 * out.pos.y + _m.y) * w2;
  const az = (_p.z - 2 * out.pos.z + _m.z) * w2;
  const u = normalize3(out.up, out.pos);
  const l = normalize3(out.left, cross3(out.left, u, f));
  cross3(u, f, l); // level up, orthogonal to the nose (keeps the climb pitch)
  const lat = ax * l.x + ay * l.y + az * l.z;
  const bank = Math.max(-BANK_MAX, Math.min(BANK_MAX, Math.atan(lat / G) * BANK_GAIN));
  out.bank = bank;
  const cb = Math.cos(bank);
  const sb = Math.sin(bank);
  const ux = u.x * cb + l.x * sb;
  const uy = u.y * cb + l.y * sb;
  const uz = u.z * cb + l.z * sb;
  l.x = l.x * cb - u.x * sb;
  l.y = l.y * cb - u.y * sb;
  l.z = l.z * cb - u.z * sb;
  u.x = ux;
  u.y = uy;
  u.z = uz;
  return out;
}

// ── Balloons ──

export interface BalloonPath {
  /** Loop radius round the city centre (plan m), its wobble, and the angular speed (rad/s, + = clockwise seen from above). */
  r: number;
  rAmp: number;
  omega: number;
  phase: number;
  /** Basket height above the plateau (m) and its slow bob. */
  h: number;
  hAmp: number;
  /** Envelope colours (index.ts BALLOON_COLORS) and a size multiplier. */
  colors: number;
  scale: number;
}

// Below the cloud base (36 m above sea level: envelope tops stay ≤ ~33.5 m), above every roof on
// their loops by ≥ 4 m (masts and props included), and apart from each other (routes.spec.ts).
export const BALLOONS: readonly BalloonPath[] = [
  { r: 65, rAmp: 2, omega: 1.0 / 65, phase: 3.9, h: 19.5, hAmp: 1.2, colors: 0, scale: 1 },
  { r: 76, rAmp: 2, omega: 0.85 / 76, phase: 5.2, h: 15.5, hAmp: 1.4, colors: 1, scale: 0.95 },
  { r: 86, rAmp: 1.5, omega: 0.7 / 86, phase: 0.9, h: 21, hAmp: 1.0, colors: 2, scale: 1.05 },
];

/** Envelope height (m, scale 1): the basket bottom is the local origin. */
export const BALLOON_TOP = 8;
/** Widest envelope radius (m, scale 1) and its height above the basket. */
export const BALLOON_RADIUS = 2.95;
export const BALLOON_BELLY = 5.4;

export interface BalloonState {
  x: number;
  z: number;
  /** Basket height above the plateau. */
  h: number;
  /** Envelope yaw (rad) and a pendulum sway (rad, about the direction of travel). */
  yaw: number;
  sway: number;
}

export const newBalloon = (): BalloonState => ({ x: 0, z: 0, h: 0, yaw: 0, sway: 0 });

export function balloonAt(b: BalloonPath, t: number, out: BalloonState): BalloonState {
  const a = (b.phase + b.omega * t) % TAU;
  const rr = b.r + b.rAmp * Math.sin(0.021 * t + b.phase * 2.3);
  out.x = rr * Math.cos(a);
  out.z = rr * Math.sin(a);
  out.h = b.h + b.hAmp * Math.sin(0.09 * t + b.phase);
  out.yaw = 0.035 * t + b.phase * 1.9;
  out.sway = 0.035 * Math.sin(0.55 * t + b.phase * 3.1);
  return out;
}

// ── Keeping clear of the camera ──

/**
 * Push a point away from the eye so it never comes closer than `dmin` (the camera is never flown
 * through). Smooth in the eye position: d' = d + dmin·(1 − d/reach)² inside `reach` (≥ 2·dmin, so it
 * stays monotone), untouched beyond. Writes the offset to add into out; returns its length.
 */
export function dodge(p: Vec3, eye: Vec3, dmin: number, reach: number, out: Vec3): number {
  const dx = p.x - eye.x;
  const dy = p.y - eye.y;
  const dz = p.z - eye.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d >= reach) {
    out.x = out.y = out.z = 0;
    return 0;
  }
  const k = 1 - d / reach;
  const push = dmin * k * k;
  // Straight away from the eye; at the eye itself (never reached in practice) straight up.
  const s = d > 1e-6 ? push / d : 0;
  if (s === 0) {
    const l = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
    out.x = (p.x / l) * push;
    out.y = (p.y / l) * push;
    out.z = (p.z / l) * push;
  } else {
    out.x = dx * s;
    out.y = dy * s;
    out.z = dz * s;
  }
  return push;
}

/**
 * A plane's dodge: push it sideways to its own flight, along the part of (P − E) orthogonal to the
 * nose `fwd` (a head-on plane holding in front of the eye then jumping behind it was the straight
 * push's failure), with a slight local-up bias so an exact head-on pass goes over the eye. The push
 * m = dmin·(1 − (d/reach)²)² is flat at d = 0 and at reach (C1 in time as the plane passes), and
 * d² + m² ≥ dmin² for reach ≥ 2·dmin, so the plane slides past beside or above, ≥ ~dmin away, on a
 * continuous path. Writes the offset into out; returns its length.
 */
export function dodgeAcross(p: Vec3, fwd: Vec3, eye: Vec3, dmin: number, reach: number, out: Vec3): number {
  let dx = p.x - eye.x;
  let dy = p.y - eye.y;
  let dz = p.z - eye.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= reach * reach) {
    out.x = out.y = out.z = 0;
    return 0;
  }
  const k = 1 - d2 / (reach * reach);
  const push = dmin * k * k;
  const a = dx * fwd.x + dy * fwd.y + dz * fwd.z;
  dx -= fwd.x * a;
  dy -= fwd.y * a;
  dz -= fwd.z * a;
  // Local up, made orthogonal to the nose: the tie-break direction.
  const pl = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
  let ux = p.x / pl;
  let uy = p.y / pl;
  let uz = p.z / pl;
  const uf = ux * fwd.x + uy * fwd.y + uz * fwd.z;
  ux -= fwd.x * uf;
  uy -= fwd.y * uf;
  uz -= fwd.z * uf;
  dx += ux * 0.25;
  dy += uy * 0.25;
  dz += uz * 0.25;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const s = l > 1e-6 ? push / l : 0;
  out.x = dx * s;
  out.y = dy * s;
  out.z = dz * s;
  return push;
}

export const PLANE_BAND = [PLANE_MIN, PLANE_MAX] as const;
