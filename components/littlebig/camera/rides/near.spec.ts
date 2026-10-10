// Near trips (D1f r2): exact ends, a level horizon, the turn rate bounded, the subject kept in frame
// once it is in, and a swing that goes round the clear side.

import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { R } from '../../world/config';
import { createFramePose, lookQuat } from './blend';
import { NEAR_W_MAX, NearTrip, rampEase, type NearEnv } from './near';

const GROUND = R + 2;
const UP = new Vector3(0, 0, 1);
/** World point at local (x east, y north) metres on the ground, h m up (near the pole, flat enough). */
const at = (x: number, y: number, h: number) => new Vector3(x, y, 0).addScaledVector(UP, GROUND + h);

const open: NearEnv = { blocked: () => false, sight: () => true };

/** The rest framing of an eyes ride at a walker's eye `eye` looking along `fwd`. */
function eyesEnd(fwd: Vector3) {
  const q = lookQuat(fwd.clone().normalize(), UP, 0, new Quaternion());
  return { off: new Vector3(), q };
}

function run(trip: NearTrip, S: Vector3, qS: Quaternion, K0: Vector3, vK: Vector3, off: Vector3, qE: Quaternion) {
  const out = createFramePose();
  const cam = new PerspectiveCamera(56, 1.6, 0.05, 1000);
  const n = Math.ceil(trip.T * 60);
  const rates: number[] = [];
  const inFrame: boolean[] = [];
  let prev: Quaternion | null = null;
  const K = new Vector3();
  for (let i = 0; i <= n; i++) {
    const t = Math.min(trip.T, i / 60);
    K.copy(K0).addScaledVector(vK, t);
    trip.pose(t, S, qS, K, off, qE, 56, 60, 0, 0, out);
    if (prev) rates.push(prev.angleTo(out.quat) * 60);
    prev = out.quat.clone();
    cam.position.copy(out.pos);
    cam.quaternion.copy(out.quat);
    cam.updateMatrixWorld();
    const p = K.clone().addScaledVector(UP, -0.4).project(cam);
    inFrame.push(p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1);
  }
  return { out, rates, inFrame, K };
}

describe('near trips', () => {
  it('rampEase: 0 → 1, monotone, its peak rate 1 / (L − r)', () => {
    let last = 0;
    let peak = 0;
    for (let i = 1; i <= 1000; i++) {
      const v = rampEase(i / 1000, 0, 1, 0.25);
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      peak = Math.max(peak, (v - last) * 1000);
      last = v;
    }
    expect(last).toBeCloseTo(1, 9);
    expect(peak).toBeCloseTo(1 / 0.75, 2);
  });

  it('a walker 2 m behind the camera: turn, swing round, into the eyes — exact ends, level, bounded', () => {
    const S = at(0, 0, 1.7);
    const qS = lookQuat(new Vector3(0, 1, 0), UP, 0, new Quaternion());
    // Behind and to the right, walking east.
    const K0 = at(1.3, -1.6, 1.46);
    const vK = new Vector3(1.3, 0, 0);
    const { off, q } = eyesEnd(new Vector3(1, 0, 0));
    const trip = new NearTrip();
    expect(trip.plan(S, qS, K0, vK, off, q, true, open)).toBe(true);
    expect(trip.T).toBeLessThanOrEqual(2.4);
    const first = createFramePose();
    trip.pose(0, S, qS, K0, off, q, 56, 60, 0, 0, first);
    expect(first.pos.distanceTo(S)).toBeLessThan(1e-6);
    expect(first.quat.angleTo(qS)).toBeLessThan(1e-6);
    const { out, rates, inFrame, K } = run(trip, S, qS, K0, vK, off, q);
    expect(out.pos.distanceTo(K.clone().add(off))).toBeLessThan(1e-6);
    expect(out.quat.angleTo(q)).toBeLessThan(1e-6);
    expect(Math.max(...rates)).toBeLessThan(NEAR_W_MAX + 12 * (Math.PI / 180));
    // Once in frame, it stays in frame until the drop into the eyes.
    const firstIn = inFrame.indexOf(true);
    expect(firstIn).toBeGreaterThanOrEqual(0);
    const drop = Math.floor((trip.T - 0.55) * 60);
    expect(inFrame.slice(firstIn, drop).every(Boolean)).toBe(true);
  });

  it('the start keeps its own roll and eases it out', () => {
    const S = at(0, 0, 3);
    const qS = lookQuat(new Vector3(0, 1, -0.2).normalize(), UP, 0.3, new Quaternion());
    const K0 = at(0, 8, 1.46);
    const { off, q } = eyesEnd(new Vector3(0, 1, 0));
    const trip = new NearTrip();
    expect(trip.plan(S, qS, K0, new Vector3(), off, q, true, open)).toBe(true);
    const o = createFramePose();
    trip.pose(0, S, qS, K0, off, q, 56, 60, 0, 0, o);
    expect(o.quat.angleTo(qS)).toBeLessThan(1e-6);
  });

  it('a chase framing: a car 12 m off to the side, the camera ends behind it, never inside a blocked side', () => {
    const S = at(0, 0, 1.7);
    const qS = lookQuat(new Vector3(0, 1, 0), UP, 0, new Quaternion());
    const K0 = at(-10, 6, 0.8);
    const vK = new Vector3(0, -6, 0); // driving south, toward the camera's side
    const back = new Vector3(0, 7, 2.2); // behind (north of) it, above
    const qE = lookQuat(new Vector3(0, -1, -0.25).normalize(), UP, 0, new Quaternion());
    // Everything west of x = −14 is a wall (the swing round that side must not be taken).
    const walled: NearEnv = { blocked: (p) => p.x < -13.5, sight: () => true };
    const trip = new NearTrip();
    expect(trip.plan(S, qS, K0, vK, back, qE, false, walled)).toBe(true);
    const { out, rates, K } = run(trip, S, qS, K0, vK, back, qE);
    expect(out.pos.distanceTo(K.clone().add(back))).toBeLessThan(1e-6);
    expect(Math.max(...rates)).toBeLessThan(NEAR_W_MAX + 12 * (Math.PI / 180));
    // Replay and check the camera never went into the wall.
    const o = createFramePose();
    const Kt = new Vector3();
    for (let i = 0; i <= 100; i++) {
      const t = (i / 100) * trip.T;
      Kt.copy(K0).addScaledVector(vK, t);
      trip.pose(t, S, qS, Kt, back, qE, 56, 52, 0, 0, o);
      expect(o.pos.x).toBeGreaterThan(-13.6);
    }
  });
});
