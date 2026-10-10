// The space layer's orbits (v2, S1), as pure data and closed-form math (no three.js): the station and
// the satellites circle the planet on inclined orbits between SPACE_MIN and SPACE_MAX, each at its
// own height (so no two ever meet), positions a pure function of sim time (persistent,
// deterministic, nothing spawns). The camera may sit inside the layer (the orbit view zooms through
// it), so a body that would pass near the eye is nudged aside (`dodge`): nothing ever flies through
// the camera.

import { R, SPACE_MAX, SPACE_MIN } from '../world/config';
import type { Vec3 } from '../world/sphere';

/** How a body holds itself. */
export const ATTITUDE = {
  /** Belly to the planet, nose along the flight. */
  flight: 0,
  /** Local +Y toward the sun (the solar sail; the sunshield faces it with −Y: see `flip`). */
  sun: 1,
  /** The flight frame, spinning about local +Y (or +Z, along the flight, with `spinZ`). */
  spin: 2,
} as const;

export interface OrbitDef {
  /** Trackable id: 'station:0', 'satellite:3'. */
  id: string;
  kind: 'station' | 'satellite';
  /** Model index (models.ts MODELS). */
  model: number;
  /** Card title and subtitle (site voice). */
  label: string;
  sub: string;
  /** Height above sea level (m). */
  alt: number;
  /** Inclination (deg; > 90 = retrograde). */
  incl: number;
  /** Longitude of the ascending node (deg). */
  node: number;
  /** Seconds per lap. */
  period: number;
  /** Where along the orbit it is at t = 0 (deg). */
  phase0: number;
  /** Bounding radius (m). */
  radius: number;
  attitude: number;
  /** Spin rate (rad/s) for ATTITUDE.spin; a slow tumble for others when set. */
  spin?: number;
  /** Spin about local +Z (the flight) instead of +Y. */
  spinZ?: boolean;
  /** For ATTITUDE.sun: face the sun with local −Y instead of +Y. */
  flip?: boolean;
}

/** Satellites are drawn this much bigger than their models (a cartoon: they read from orbit). */
export const SAT_SCALE = 1.4;

/**
 * The fleet. Heights are ≥ (r₁ + r₂ + 4) m apart (spec'd): orbits never intersect. Radii are the
 * drawn (scaled) bounding radii. Composed for the first look:
 *   - the station crosses the `orbit` view over the dusk side at t = 0 (sunlit against the dark
 *     ground), moving into the day, and sweeps under the /play clip's dive about a second in (t ≈
 *     12, DIVE_T0 = 11). (A retrograde station: who's checking.)
 *   - the satellites' nodes, phases and periods were searched so the default `orbit` view always
 *     has some in it: two or more bodies in frame ~90 % of the time over two hours (was 55 %), never
 *     an empty sky for more than moments, four of them at t = 0 (drizzle-1, peeper, tri-cubes,
 *     spinny). Inclinations (and so the variety of tracks) are as designed.
 */
export const ORBITS: OrbitDef[] = [
  { id: 'station:0', kind: 'station', model: 0, label: 'sky station', sub: 'crew of three · a lap every minute and a half', alt: 152, incl: 153.29, node: 69.82, period: 96.02, phase0: 30.04, radius: 11.5, attitude: ATTITUDE.flight },
  { id: 'satellite:0', kind: 'satellite', model: 1, label: 'chatterbox', sub: 'comms satellite · dishes out the gossip', alt: 213, incl: 14, node: 252.21, period: 225, phase0: 186.52, radius: 7, attitude: ATTITUDE.flight },
  { id: 'satellite:1', kind: 'satellite', model: 2, label: 'drizzle-1', sub: 'weather satellite · polar, sees every cloud', alt: 176, incl: 88, node: 271.62, period: 147, phase0: 327.53, radius: 7.28, attitude: ATTITUDE.flight },
  { id: 'satellite:2', kind: 'satellite', model: 3, label: 'peeper', sub: 'space telescope · always looking the other way', alt: 259, incl: 33, node: 11.67, period: 260, phase0: 263.29, radius: 6.44, attitude: ATTITUDE.flight },
  { id: 'satellite:3', kind: 'satellite', model: 4, label: 'tri-cubes', sub: 'three cubesats, one school project', alt: 127, incl: 98, node: 118.44, period: 91, phase0: 339.39, radius: 3.64, attitude: ATTITUDE.flight, spin: 0.35 },
  { id: 'satellite:4', kind: 'satellite', model: 5, label: 'kite', sub: 'solar sail · no engine, just sunshine', alt: 292, incl: 62, node: 76.29, period: 294, phase0: 256.25, radius: 7.7, attitude: ATTITUDE.sun },
  { id: 'satellite:5', kind: 'satellite', model: 6, label: 'pathfinder', sub: 'navigation satellite · knows where you are', alt: 195, incl: 55, node: 296.82, period: 150, phase0: 168.59, radius: 6.72, attitude: ATTITUDE.flight },
  { id: 'satellite:6', kind: 'satellite', model: 7, label: 'bat', sub: 'radar satellite · sees through clouds', alt: 231, incl: 106, node: 160.45, period: 151, phase0: 116.82, radius: 6.16, attitude: ATTITUDE.flight },
  { id: 'satellite:7', kind: 'satellite', model: 8, label: 'spinny', sub: 'spin-stabilised · dizzy since launch', alt: 245, incl: 27, node: 117.25, period: 280, phase0: 46.45, radius: 3.36, attitude: ATTITUDE.spin, spin: 1.6, spinZ: true },
  { id: 'satellite:8', kind: 'satellite', model: 9, label: 'beep', sub: 'the very first one · still beeping', alt: 115, incl: 65, node: 313.6, period: 87, phase0: 113.08, radius: 3.36, attitude: ATTITUDE.flight },
  { id: 'satellite:9', kind: 'satellite', model: 10, label: 'goldie', sub: 'deep-space telescope · gold mirror, sun umbrella', alt: 275, incl: 19, node: 111.12, period: 368, phase0: 41.68, radius: 5.04, attitude: ATTITUDE.sun, flip: true },
];

const DEG = Math.PI / 180;

/** The orbit's plane basis: a (ascending node, on the equator) and b (90° on along the orbit). */
export function orbitBasis(o: OrbitDef, a: Vec3, b: Vec3): void {
  const n = o.node * DEG;
  // a = dirFromLatLon(0, node) = (sin n, 0, cos n); the orbit normal is +Y tilted about a by incl.
  a.x = Math.sin(n);
  a.y = 0;
  a.z = Math.cos(n);
  const i = o.incl * DEG;
  // The orbit normal is Y turned about a by i: N = Y·cos i + (a × Y)·sin i, so
  // b = N × a = cos i · (Y × a) + sin i · Y.
  const yxax = a.z; // (Y × a).x = 1·a.z − 0·a.y
  const yxaz = -a.x; // (Y × a).z = 0·a.y − 1·a.x
  b.x = Math.cos(i) * yxax;
  b.y = Math.sin(i);
  b.z = Math.cos(i) * yxaz;
}

const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };

/** Position (world, m) and velocity (m/s) at sim time t. Zero allocation. */
export function orbitState(o: OrbitDef, t: number, pos: Vec3, vel?: Vec3): void {
  orbitBasis(o, _a, _b);
  const w = (2 * Math.PI) / o.period;
  const ph = o.phase0 * DEG + w * t;
  const c = Math.cos(ph);
  const s = Math.sin(ph);
  const r = R + o.alt;
  pos.x = r * (_a.x * c + _b.x * s);
  pos.y = r * (_a.y * c + _b.y * s);
  pos.z = r * (_a.z * c + _b.z * s);
  if (vel) {
    const k = r * w;
    vel.x = k * (-_a.x * s + _b.x * c);
    vel.y = k * (-_a.y * s + _b.y * c);
    vel.z = k * (-_a.z * s + _b.z * c);
  }
}

/** Orbital speed (m/s). */
export function orbitSpeed(o: OrbitDef): number {
  return ((2 * Math.PI) / Math.abs(o.period)) * (R + o.alt);
}

/**
 * The nudge (written into out, m) that keeps a body of bounding radius `r` at `p`, flying along unit
 * `fwd`, at least `r + clear` from the eye: it slides sideways to its flight (away from the eye, or
 * up and away from the planet when the eye is dead ahead), smoothly in and out over `reach`.
 * Returns the push length. Zero allocation.
 */
export function dodge(p: Vec3, fwd: Vec3, eye: Vec3, r: number, clear: number, out: Vec3): number {
  const dmin = r + clear;
  const reach = dmin * 3;
  let dx = p.x - eye.x;
  let dy = p.y - eye.y;
  let dz = p.z - eye.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= reach * reach) {
    out.x = out.y = out.z = 0;
    return 0;
  }
  const along = dx * fwd.x + dy * fwd.y + dz * fwd.z;
  dx -= fwd.x * along;
  dy -= fwd.y * along;
  dz -= fwd.z * along;
  // Up (away from the planet), made orthogonal to the flight: the tie-break when the eye is dead ahead.
  const pl = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
  let ux = p.x / pl;
  let uy = p.y / pl;
  let uz = p.z / pl;
  const uf = ux * fwd.x + uy * fwd.y + uz * fwd.z;
  ux -= fwd.x * uf;
  uy -= fwd.y * uf;
  uz -= fwd.z * uf;
  const side = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const k = 0.35 * dmin;
  dx += ux * k;
  dy += uy * k;
  dz += uz * k;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  // How far it must move sideways to clear dmin, weighted down smoothly with the along-track gap.
  const need = Math.max(0, dmin - side);
  const w = 1 - smooth01((Math.abs(along) - dmin * 0.6) / (reach - dmin * 0.6));
  const push = need * w;
  out.x = (dx / l) * push;
  out.y = (dy / l) * push;
  out.z = (dz / l) * push;
  return push;
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** The layer's bounds, for the specs. */
export const LAYER = { min: SPACE_MIN, max: SPACE_MAX } as const;

/**
 * 1 in sunlight … 0 in the planet's shadow (a cylinder of radius R behind it, soft over ±6 m) for a
 * point p and unit sun direction. Zero allocation.
 */
export function sunlit(p: Vec3, sun: Vec3): number {
  const s = p.x * sun.x + p.y * sun.y + p.z * sun.z;
  if (s >= 0) return 1;
  const qx = p.x - sun.x * s;
  const qy = p.y - sun.y * s;
  const qz = p.z - sun.z * s;
  const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
  return smooth01((d - (R - 6)) / 14);
}
