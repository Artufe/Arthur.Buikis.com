// A full-body pose in world space: eye, extra view rotation, board transform and limb targets.
// Every player mode writes one; transitions blend the outgoing and incoming poses, so nothing
// ever snaps. Zero allocation: poses are preallocated and blended in place.

import { Quaternion, Vector3 } from 'three/webgpu';
import type { ArmTarget, HandShape, LegTarget } from './body/rig';

function shape(): HandShape {
  return { curl: 0.2, spread: 0.6, thumb: 0.2, cup: 0 };
}
function arm(): ArmTarget {
  return { shoulder: new Vector3(), wrist: new Vector3(), hand: new Quaternion(), pole: new Vector3(), shape: shape() };
}
function leg(): LegTarget {
  return { hip: new Vector3(), ankle: new Vector3(), foot: new Quaternion(), pole: new Vector3(), toe: 0, pelvis: new Quaternion() };
}

export class Pose {
  readonly eye = new Vector3();
  /** Extra view pitch / roll on top of mouse look (board attitude, carves). */
  camPitch = 0;
  camRoll = 0;
  readonly board = new Vector3();
  readonly boardQ = new Quaternion();
  readonly armL = arm();
  readonly armR = arm();
  readonly legL = leg();
  readonly legR = leg();

  copy(p: Pose) {
    this.eye.copy(p.eye);
    this.camPitch = p.camPitch;
    this.camRoll = p.camRoll;
    this.board.copy(p.board);
    this.boardQ.copy(p.boardQ);
    copyArm(this.armL, p.armL);
    copyArm(this.armR, p.armR);
    copyLeg(this.legL, p.legL);
    copyLeg(this.legR, p.legR);
    return this;
  }

  /** this = lerp(a, b, t). `this` may alias a. */
  blend(a: Pose, b: Pose, t: number) {
    this.eye.lerpVectors(a.eye, b.eye, t);
    this.camPitch = a.camPitch + (b.camPitch - a.camPitch) * t;
    this.camRoll = a.camRoll + (b.camRoll - a.camRoll) * t;
    this.board.lerpVectors(a.board, b.board, t);
    this.boardQ.slerpQuaternions(a.boardQ, b.boardQ, t);
    blendArm(this.armL, a.armL, b.armL, t);
    blendArm(this.armR, a.armR, b.armR, t);
    blendLeg(this.legL, a.legL, b.legL, t);
    blendLeg(this.legR, a.legR, b.legR, t);
    return this;
  }
}

function copyArm(o: ArmTarget, a: ArmTarget) {
  o.shoulder.copy(a.shoulder);
  o.wrist.copy(a.wrist);
  o.hand.copy(a.hand);
  o.pole.copy(a.pole);
  o.shape.curl = a.shape.curl;
  o.shape.spread = a.shape.spread;
  o.shape.thumb = a.shape.thumb;
  o.shape.cup = a.shape.cup;
}
function copyLeg(o: LegTarget, a: LegTarget) {
  o.hip.copy(a.hip);
  o.ankle.copy(a.ankle);
  o.foot.copy(a.foot);
  o.pole.copy(a.pole);
  o.toe = a.toe;
  o.pelvis.copy(a.pelvis);
}
function blendArm(o: ArmTarget, a: ArmTarget, b: ArmTarget, t: number) {
  o.shoulder.lerpVectors(a.shoulder, b.shoulder, t);
  o.wrist.lerpVectors(a.wrist, b.wrist, t);
  o.hand.slerpQuaternions(a.hand, b.hand, t);
  o.pole.lerpVectors(a.pole, b.pole, t);
  o.shape.curl = a.shape.curl + (b.shape.curl - a.shape.curl) * t;
  o.shape.spread = a.shape.spread + (b.shape.spread - a.shape.spread) * t;
  o.shape.thumb = a.shape.thumb + (b.shape.thumb - a.shape.thumb) * t;
  o.shape.cup = a.shape.cup + (b.shape.cup - a.shape.cup) * t;
}
function blendLeg(o: LegTarget, a: LegTarget, b: LegTarget, t: number) {
  o.hip.lerpVectors(a.hip, b.hip, t);
  o.ankle.lerpVectors(a.ankle, b.ankle, t);
  o.foot.slerpQuaternions(a.foot, b.foot, t);
  o.pole.lerpVectors(a.pole, b.pole, t);
  o.toe = a.toe + (b.toe - a.toe) * t;
  o.pelvis.slerpQuaternions(a.pelvis, b.pelvis, t);
}

/** A rigid frame (origin + orientation) to place local targets with. */
export class Frame {
  readonly o = new Vector3();
  readonly q = new Quaternion();
  /** out = o + q·(x, y, z) */
  p(x: number, y: number, z: number, out: Vector3) {
    return out.set(x, y, z).applyQuaternion(this.q).add(this.o);
  }
  /** out = q·(x, y, z) (direction) */
  d(x: number, y: number, z: number, out: Vector3) {
    return out.set(x, y, z).applyQuaternion(this.q);
  }
}
