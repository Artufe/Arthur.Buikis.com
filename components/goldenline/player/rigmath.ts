// Zero-allocation helpers for posing: bases, two-bone IK, springs. Every function writes into
// caller-provided objects and uses module-scope scratch only.

import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';

const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

/**
 * Quaternion whose local +X maps to `xDir` and local +Y as close as possible to `yHint`.
 * Inputs need not be normalised; they must not be parallel.
 */
export function basisQuat(xDir: Vector3, yHint: Vector3, out: Quaternion) {
  _x.copy(xDir).normalize();
  _z.crossVectors(_x, yHint);
  if (_z.lengthSq() < 1e-10) {
    // Degenerate: pick any perpendicular.
    _z.set(0, 0, 1).cross(_x);
    if (_z.lengthSq() < 1e-10) _z.set(0, 1, 0).cross(_x);
  }
  _z.normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Two-bone IK. Root at `a`, target `t`, segment lengths l1, l2, bend plane hinted by `pole`
 * (a world point the middle joint should point toward). Writes the middle joint into `mid` and
 * the clamped end effector into `end`. Returns the reach ratio (1 = fully extended).
 */
export function twoBoneIK(a: Vector3, t: Vector3, l1: number, l2: number, pole: Vector3, mid: Vector3, end: Vector3) {
  _a.subVectors(t, a);
  let dist = _a.length();
  const maxReach = (l1 + l2) * 0.9995;
  const minReach = Math.abs(l1 - l2) * 1.05 + 1e-4;
  if (dist < 1e-6) {
    _a.set(1, 0, 0);
    dist = 1e-6;
  }
  _a.divideScalar(dist);
  const dd = Math.min(maxReach, Math.max(minReach, dist));
  end.copy(a).addScaledVector(_a, dd);
  // Law of cosines: distance along the chord to the middle joint's foot, and its offset.
  const x = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  _b.subVectors(pole, a);
  _b.addScaledVector(_a, -_b.dot(_a));
  if (_b.lengthSq() < 1e-10) {
    _b.set(0, 1, 0).addScaledVector(_a, -_a.y);
    if (_b.lengthSq() < 1e-10) _b.set(1, 0, 0).addScaledVector(_a, -_a.x);
  }
  _b.normalize();
  mid.copy(a).addScaledVector(_a, x).addScaledVector(_b, h);
  return dist / (l1 + l2);
}

/**
 * Orientation of a bone that runs from `from` to `to` (local +X), with its local +Y turned as
 * close as possible to `up`.
 */
export function boneQuat(from: Vector3, to: Vector3, up: Vector3, out: Quaternion) {
  _c.subVectors(to, from);
  return basisQuat(_c, up, out);
}

/** Critically-damped-ish spring on a scalar. State is [value, velocity] in a Float64Array. */
export function springStep(state: Float64Array, i: number, target: number, omega: number, zeta: number, dt: number) {
  // Semi-implicit Euler, substepped for stability at low frame rates.
  const steps = dt > 1 / 90 ? Math.ceil(dt * 90) : 1;
  const h = dt / steps;
  let x = state[i];
  let v = state[i + 1];
  for (let s = 0; s < steps; s++) {
    const acc = -2 * zeta * omega * v - omega * omega * (x - target);
    v += acc * h;
    x += v * h;
  }
  state[i] = x;
  state[i + 1] = v;
  return x;
}

export const TAU = Math.PI * 2;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Smooth 0..1 ease (smootherstep). */
export function ease(t: number) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Cheap deterministic 1D noise in [-1, 1] (sum of incommensurate sines). */
export function wobble(t: number, seed: number) {
  return (
    Math.sin(t * 1.7 + seed * 12.9898) * 0.5 +
    Math.sin(t * 2.9 + seed * 78.233) * 0.3 +
    Math.sin(t * 5.3 + seed * 37.719) * 0.2
  );
}
