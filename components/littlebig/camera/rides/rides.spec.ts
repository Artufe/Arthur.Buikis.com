// Rides (D1): the transition math and the ride rigs, against synthetic trackables (pure, no renderer).

import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { TrackPose } from '../../core/contracts';
import { R } from '../../world/config';
import { angularVelocity, blendPose, Coast, createFramePose, ease, hopFor, LiftProfile, lookPointOf, transitionDuration } from './blend';
import { elevationFor, horizonDip, lookQuat, RideRig, type RideEnv } from './rig';

const DEG = Math.PI / 180;
const flat: RideEnv = { floor: () => 0, free: () => 1, reduced: false };

/** A trackable flying a great circle at height h (m), speed v (m/s), optionally weaving. */
function circle(h: number, v: number, weave = 0) {
  const pose: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: v };
  return (t: number): TrackPose => {
    const r = R + h;
    const th = (v * t) / r;
    const wv = weave * Math.sin(t * 0.9);
    pose.pos.set(Math.cos(th) * r, wv * 6, Math.sin(th) * r);
    pose.fwd.set(-Math.sin(th), weave * Math.cos(t * 0.9) * 0.15, Math.cos(th)).normalize();
    pose.up.copy(pose.pos).normalize();
    return pose;
  };
}

const camFwd = (q: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(q);

describe('transition math', { timeout: 30_000 }, () => {
  it('eases from rest into rest and stays in 0…1', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    const h = 1e-4;
    expect((ease(h) - ease(0)) / h).toBeLessThan(1e-3); // zero velocity at the start…
    expect((ease(1) - ease(1 - h)) / h).toBeLessThan(1e-3); // …and at the end
    for (let x = 0; x < 1; x += 0.01) expect(ease(x + 0.01)).toBeGreaterThanOrEqual(ease(x));
  });

  it('takes 1.2–2 s (longer with reduced motion)', () => {
    expect(transitionDuration(0, 0, false)).toBeCloseTo(1.2, 5);
    expect(transitionDuration(5000, Math.PI, false)).toBe(2);
    for (const d of [3, 30, 300]) {
      const t = transitionDuration(d, d / 300, false);
      expect(t).toBeGreaterThanOrEqual(1.2);
      expect(t).toBeLessThanOrEqual(2);
      expect(transitionDuration(d, d / 300, true)).toBeCloseTo(t * 1.4, 6);
    }
  });

  it('arcs round the planet, never through it, and lands exactly on both ends', () => {
    const a = createFramePose();
    const b = createFramePose();
    const o = createFramePose();
    a.pos.set(0, 0, R + 380); // orbit
    b.pos.set(R + 70, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), -2.6); // a plane far round the planet
    lookQuat(new Vector3(0, 0, -1), new Vector3(0, 1, 0), 0, a.quat); // orbit: straight down
    lookQuat(new Vector3(0, 1, 0), b.pos.clone().normalize(), 0, b.quat); // a chase: along its travel
    lookPointOf(a.pos, a.quat, a.look);
    b.look.copy(b.pos).add(new Vector3(0, 12, 0));
    const ang = a.pos.angleTo(b.pos);
    const hop = new LiftProfile().hop(hopFor(ang));
    let prev = a.pos.clone();
    let maxStep = 0;
    for (let i = 0; i <= 200; i++) {
      const e = ease(i / 200);
      blendPose(a, b, e, hop, o);
      expect(o.pos.length()).toBeGreaterThan(R + 60); // well clear of the ground all the way
      maxStep = Math.max(maxStep, o.pos.distanceTo(prev));
      prev = o.pos.clone();
      // The view stays on the world: never more than ~15° off the planet's disc.
      const f = new Vector3(0, 0, -1).applyQuaternion(o.quat);
      const toC = o.pos.clone().negate();
      const disc = Math.asin(Math.min(1, R / toC.length()));
      // (The last stretch settles into the chase's own framing, which looks out along the travel.)
      if (i < 170) expect(f.angleTo(toC)).toBeLessThan(disc + 15 * DEG);
    }
    blendPose(a, b, 0, hop, o);
    expect(o.pos.distanceTo(a.pos)).toBeLessThan(1e-6);
    expect(o.quat.angleTo(a.quat)).toBeLessThan(1e-6);
    blendPose(a, b, 1, hop, o);
    expect(o.pos.distanceTo(b.pos)).toBeLessThan(1e-6);
    expect(o.quat.angleTo(b.quat)).toBeLessThan(1e-6);
    // No jumps: the largest step of 200 is a small fraction of the trip.
    expect(maxStep).toBeLessThan(a.pos.distanceTo(b.pos) * 0.05);
  });

  it('lifts over what lies between: a street-level hop clears a 20 m block, and comes back down', () => {
    const a = new Vector3(0, 0, R + 2);
    const b = new Vector3(0, 0, R + 2).applyAxisAngle(new Vector3(0, 1, 0), 60 / R);
    const block = new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), 18 / R); // 18 m out, 12 m deep
    const floor = (d: Vector3) => (d.angleTo(block) * R < 6 ? 21.5 : 1.5);
    const lift = new LiftProfile().plan(a, b, floor, 0);
    const o = createFramePose();
    const pa = createFramePose();
    const pb = createFramePose();
    pa.pos.copy(a);
    pb.pos.copy(b);
    pa.look.copy(b);
    pb.look.copy(b).multiplyScalar(1.01);
    let maxH = 0;
    const hs: number[] = [];
    for (let i = 0; i <= 120; i++) {
      blendPose(pa, pb, i / 120, lift, o);
      const h = o.pos.length() - R;
      const d = o.pos.clone().normalize();
      if (d.angleTo(block) * R < 6) expect(h).toBeGreaterThan(21.5);
      maxH = Math.max(maxH, h);
      hs.push(h);
    }
    // Just over the roofs, not flung into the sky; smooth on the way: no kink (the height's second
    // difference stays small next to the climb itself). (At the very ends a steep start is fine: the
    // eased clock leaves e = 0 with zero velocity and acceleration.)
    expect(maxH).toBeLessThan(30);
    let kink = 0;
    for (let i = 6; i < hs.length - 6; i++) kink = Math.max(kink, Math.abs(hs[i + 1] - 2 * hs[i] + hs[i - 1]));
    expect(kink).toBeLessThan(0.6);
    // Nothing in the way: the minimum hop, exactly 0 at both ends.
    const plain = new LiftProfile().plan(a, b, () => 1, 0.3);
    expect(plain.at(0.5)).toBeCloseTo(0.3, 2);
    expect(plain.at(0)).toBe(0);
    expect(plain.at(1)).toBe(0);
  });

  it('a coasting snapshot carries the motion on and glides to rest at p0 + v/k', () => {
    const c = new Coast();
    const p = createFramePose();
    p.pos.set(0, 0, R + 70);
    c.capture(p, new Vector3(20, 0, 0), new Vector3(0, 1, 0), 0.5, 3);
    const o = createFramePose();
    c.at(0, o);
    expect(o.pos.distanceTo(p.pos)).toBeLessThan(1e-9);
    // Initial velocity matches what it had (no freeze at the hand-over).
    c.at(1e-3, o);
    expect((o.pos.x - p.pos.x) / 1e-3).toBeCloseTo(20, 1);
    c.rest(o);
    expect(o.pos.x).toBeCloseTo(20 / 3, 6);
    // A fast one keeps its speed at the hand-over but glides no further than maxGlide.
    c.capture(p, new Vector3(900, 0, 0), new Vector3(0, 1, 0), 0, 3, 40);
    c.at(1e-6, o);
    expect((o.pos.x - p.pos.x) / 1e-6).toBeCloseTo(900, -1);
    c.rest(o);
    expect(o.pos.distanceTo(p.pos)).toBeLessThanOrEqual(40 + 1e-9);
    // A wild one (a hitch) does not fling it.
    c.capture(p, new Vector3(1e6, 0, 0), new Vector3(0, 1, 0), 0, 3, 40);
    c.rest(o);
    expect(o.pos.distanceTo(p.pos)).toBeLessThan(1e-9);
  });

  it('measures angular velocity', () => {
    const q0 = new Quaternion();
    const q1 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.1);
    const ax = new Vector3();
    expect(angularVelocity(q0, q1, 0.05, ax)).toBeCloseTo(2, 6);
    expect(ax.y).toBeCloseTo(1, 6);
  });
});

describe('ride rigs', { timeout: 30_000 }, () => {
  it('chase: behind and above the plane, the planet limb in the lower frame, the plane in view', () => {
    const at = circle(70, 18);
    const rig = new RideRig();
    const o = createFramePose();
    rig.begin('chase', 4.6, at(0), flat, o);
    const p = at(0);
    const toCam = o.pos.clone().sub(p.pos);
    expect(toCam.dot(p.fwd)).toBeLessThan(0); // behind
    expect(toCam.dot(p.up)).toBeGreaterThan(0); // above
    expect(toCam.length()).toBeGreaterThan(10);
    expect(toCam.length()).toBeLessThan(25);
    // The plane is in front of the lens, inside the frame.
    const f = camFwd(o.quat);
    const toPlane = p.pos.clone().sub(o.pos).normalize();
    expect(f.angleTo(toPlane)).toBeLessThan((o.fov / 2) * DEG);
    // The view pitches down far enough that the horizon (46° down at 70 m) is in frame.
    const up = o.pos.clone().normalize();
    const pitch = Math.asin(f.dot(up));
    const dip = horizonDip(o.pos.length() - R);
    expect(-dip).toBeGreaterThan(pitch - (o.fov / 2) * DEG);
    expect(-dip).toBeLessThan(pitch);
  });

  it('chase follows smoothly: settled on a steady flight, no jumps on a weaving one', () => {
    const at = circle(70, 18, 1);
    const rig = new RideRig();
    const o = createFramePose();
    rig.begin('chase', 4.6, at(0), flat, o);
    const dt = 1 / 60;
    let prev = o.pos.clone();
    let prevV = new Vector3();
    let worstJerk = 0;
    let worstOff = 0;
    for (let i = 1; i <= 600; i++) {
      const p = at(i * dt);
      rig.update(dt, p, flat, o);
      const v = o.pos.clone().sub(prev).divideScalar(dt);
      if (i > 2) worstJerk = Math.max(worstJerk, v.distanceTo(prevV));
      prevV = v;
      prev = o.pos.clone();
      worstOff = Math.max(worstOff, camFwd(o.quat).angleTo(p.pos.clone().sub(o.pos).normalize()));
      for (const c of [o.pos.x, o.pos.y, o.pos.z, o.quat.x, o.quat.w]) expect(Number.isFinite(c)).toBe(true);
    }
    // Velocity changes by < 0.6 m/s per frame (18 m/s flight, weaving), the plane always in frame.
    expect(worstJerk).toBeLessThan(0.6);
    expect(worstOff).toBeLessThan((o.fov / 2) * DEG);
  });

  it('chase keeps above the floor and pulls in past an occluder', () => {
    const at = circle(2, 10);
    const rig = new RideRig();
    const o = createFramePose();
    const env: RideEnv = { floor: () => 3, free: () => 0.4, reduced: false };
    rig.begin('chase', 2.3, at(0), env, o);
    expect(o.pos.length() - R).toBeGreaterThanOrEqual(3 + 0.99);
    const free = createFramePose();
    const rig2 = new RideRig();
    rig2.begin('chase', 2.3, at(0), flat, free);
    expect(o.pos.distanceTo(at(0).pos)).toBeLessThan(free.pos.distanceTo(at(0).pos));
  });

  it('eyes: at the eyes, the heading smoothed (a U-turn never snaps), back to ahead after a look', () => {
    const pose: TrackPose = { pos: new Vector3(0, 0, R + 3.6), fwd: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1), speed: 1.3 };
    const rig = new RideRig();
    const o = createFramePose();
    rig.begin('eyes', 0.85, pose, flat, o);
    expect(o.pos.distanceTo(pose.pos)).toBeLessThan(1e-9);
    expect(rig.near).toBeLessThanOrEqual(0.06);
    // Turn around on the spot: the view turns over many frames, never more than ~6° per frame.
    pose.fwd.set(0, -1, 0);
    let prevF = camFwd(o.quat);
    let worst = 0;
    for (let i = 0; i < 180; i++) {
      rig.update(1 / 60, pose, flat, o);
      const f = camFwd(o.quat);
      worst = Math.max(worst, f.angleTo(prevF));
      prevF = f;
    }
    expect(worst).toBeLessThan(6 * DEG);
    expect(camFwd(o.quat).y).toBeLessThan(-0.9); // it got there
    // A look to the side drifts back to ahead once the user lets go.
    rig.yawT = 1.2;
    for (let i = 0; i < 60 * 10; i++) rig.update(1 / 60, pose, flat, o);
    expect(Math.abs(rig.yawT)).toBeLessThan(0.1);
    // The wheel pulls back over the shoulder (behind and above), and in again.
    rig.logDistT = rig.maxLog;
    for (let i = 0; i < 120; i++) rig.update(1 / 60, pose, flat, o);
    expect(rig.dist).toBeGreaterThan(5);
    const back = o.pos.clone().sub(pose.pos);
    expect(back.dot(pose.fwd)).toBeLessThan(0);
    rig.logDistT = rig.minLog;
    for (let i = 0; i < 180; i++) rig.update(1 / 60, pose, flat, o);
    expect(rig.dist).toBeLessThan(0.01);
  });

  it('alongside: beside and above the station, the planet below in frame', () => {
    const at = circle(200, 19);
    const rig = new RideRig();
    const o = createFramePose();
    rig.begin('alongside', 12, at(0), flat, o);
    const p = at(0);
    const f = camFwd(o.quat);
    expect(f.angleTo(p.pos.clone().sub(o.pos).normalize())).toBeLessThan((o.fov / 2) * DEG);
    const up = o.pos.clone().normalize();
    const pitch = Math.asin(f.dot(up));
    const dip = horizonDip(o.pos.length() - R);
    expect(-dip).toBeGreaterThan(pitch - (o.fov / 2) * DEG); // the limb is in frame
    // Dragged up to straight down: the cupola view looks at the planet.
    rig.pitchT = 10;
    rig.settle(at(0), flat, o);
    expect(camFwd(o.quat).dot(up)).toBeLessThan(-0.85);
  });

  it('elevation follows the horizon dip', () => {
    expect(elevationFor(17 * DEG, 1, 52)).toBeCloseTo(17 * DEG, 6); // street: the framing's own
    expect(elevationFor(13 * DEG, 70, 52)).toBeGreaterThan(30 * DEG); // a plane: looking down
  });
});
