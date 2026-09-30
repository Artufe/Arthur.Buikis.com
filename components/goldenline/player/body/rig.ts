// Poses the four skinned limbs from world-space targets: two-bone IK for arm and leg, a
// half-twist forearm bone, FK finger and toe chains. Zero allocation per frame.

import { type Bone, Matrix4, Quaternion, SkinnedMesh, Vector3 } from 'three/webgpu';
import type { MeshSSSNodeMaterial } from 'three/webgpu';
import { basisQuat, twoBoneIK } from '../rigmath';
import type { BuiltLimb } from './build';
import { ARM, ARM_BONES, LEG, LEG_BONES } from './models';

/** Finger curl per joint (rad, + = toward the palm) and spread scale. */
export interface HandShape {
  /** 0 = relaxed open, 1 = closed grip. */
  curl: number;
  /** 1 = bind spread, 0 = fingers together. */
  spread: number;
  /** Thumb across the palm, 0..1. */
  thumb: number;
  /** Extra flex of the finger bases only (cupped paddling hand). */
  cup: number;
}

export interface ArmTarget {
  shoulder: Vector3;
  wrist: Vector3;
  hand: Quaternion;
  /** World point the elbow points toward. */
  pole: Vector3;
  shape: HandShape;
}

export interface LegTarget {
  hip: Vector3;
  ankle: Vector3;
  foot: Quaternion;
  /** World point the knee points toward. */
  pole: Vector3;
  /** Toe bend (rad, + = toes up). */
  toe: number;
  /** Pelvis orientation (for the shorts' hip part). */
  pelvis: Quaternion;
}

const _e = new Vector3();
const _w = new Vector3();
const _x = new Vector3();
const _z = new Vector3();
const _y = new Vector3();
const _bend = new Vector3();
const _chord = new Vector3();
const _tmp = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _one = new Vector3(1, 1, 1);
const _m = new Matrix4();
const _mr = new Matrix4();
const _axisX = new Vector3(1, 0, 0);
const _axisY = new Vector3(0, 1, 0);
const _axisZ = new Vector3(0, 0, 1);

/** Bind transform of each bone relative to its parent (hand/foot/phalanx chains). */
function relMatrices(limb: BuiltLimb, parents: number[]) {
  const out: Matrix4[] = [];
  const inv = new Matrix4();
  for (let i = 0; i < limb.bind.length; i++) {
    const p = parents[i];
    if (p < 0) {
      out.push(new Matrix4());
      continue;
    }
    inv.copy(limb.bind[p]).invert();
    out.push(new Matrix4().multiplyMatrices(inv, limb.bind[i]));
  }
  return out;
}

export class Limb {
  readonly mesh: SkinnedMesh;
  readonly bones: Bone[];
  readonly side: 1 | -1;
  private readonly rel: Matrix4[];

  constructor(limb: BuiltLimb, material: MeshSSSNodeMaterial, side: 1 | -1, parents: number[]) {
    this.side = side;
    this.bones = limb.bones;
    this.rel = relMatrices(limb, parents);
    const mesh = new SkinnedMesh(limb.geometry, material);
    mesh.bind(limb.skeleton, new Matrix4());
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    for (const b of limb.bones) mesh.add(b);
    this.mesh = mesh;
  }

  /** world = parentWorld × rel[i] × R(axis, angle) (and optionally a second rotation). */
  protected chain(i: number, parent: Matrix4, axis: Vector3, angle: number, axis2?: Vector3, angle2 = 0) {
    const w = this.bones[i].matrixWorld;
    w.multiplyMatrices(parent, this.rel[i]);
    if (angle !== 0) w.multiply(_mr.makeRotationAxis(axis, angle));
    if (axis2 && angle2 !== 0) w.multiply(_mr.makeRotationAxis(axis2, angle2));
    return w;
  }

  protected set(i: number, pos: Vector3, q: Quaternion) {
    this.bones[i].matrixWorld.compose(pos, q, _one);
  }
}

// Parents for the finger/thumb FK chains (index into ARM bone list), -1 = posed directly.
const ARM_PARENTS = [-1, -1, -1, -1, 3, 4, 5, 3, 7, 8, 3, 10, 11, 3, 13, 14, 3, 16, 17];
const LEG_PARENTS = [-1, -1, -1, -1, 3];

// Per-finger curl distribution (MCP, PIP, DIP) for a full grip, and spread compensation.
const CURL_MAX = [
  [1.25, 1.55, 0.95],
  [1.3, 1.6, 1.0],
  [1.35, 1.6, 1.0],
  [1.4, 1.55, 0.95],
];
const RELAX = [0.07, 0.13, 0.07];
const SPREADS = [-0.12, -0.02, 0.08, 0.2];

export class ArmRig extends Limb {
  constructor(limb: BuiltLimb, material: MeshSSSNodeMaterial, side: 1 | -1) {
    super(limb, material, side, ARM_PARENTS);
  }

  /** Returns the elbow position (for effects). */
  pose(t: ArmTarget, elbowOut?: Vector3) {
    const s = this.side;
    twoBoneIK(t.shoulder, t.wrist, ARM.upper, ARM.fore, t.pole, _e, _w);
    if (elbowOut) elbowOut.copy(_e);
    // Bend direction: from the shoulder→wrist chord toward the elbow (the olecranon side).
    _chord.subVectors(_w, t.shoulder).normalize();
    _bend.subVectors(_e, t.shoulder);
    _bend.addScaledVector(_chord, -_bend.dot(_chord));
    if (_bend.lengthSq() < 1e-8) _bend.subVectors(t.pole, t.shoulder).addScaledVector(_chord, -_tmp.subVectors(t.pole, t.shoulder).dot(_chord));
    _bend.normalize();
    // Local +Z is the olecranon side on the right arm, -Z on the (mirrored) left.
    _z.copy(_bend).multiplyScalar(s);
    // Upper arm
    _x.subVectors(_e, t.shoulder);
    _y.crossVectors(_z, _x);
    basisQuat(_x, _y, _q);
    this.set(ARM_BONES.upper, t.shoulder, _q);
    // Forearm (proximal)
    _x.subVectors(_w, _e);
    _y.crossVectors(_z, _x);
    basisQuat(_x, _y, _q);
    this.set(ARM_BONES.fore1, _e, _q);
    // Forearm twist: half of the roll between the forearm frame and the hand.
    _x.normalize();
    _y.set(0, 1, 0).applyQuaternion(_q); // forearm Y
    _tmp.set(0, 1, 0).applyQuaternion(t.hand); // hand Y
    _tmp.addScaledVector(_x, -_tmp.dot(_x));
    let twist = 0;
    if (_tmp.lengthSq() > 1e-8) {
      _tmp.normalize();
      _z.crossVectors(_y, _tmp);
      twist = Math.atan2(_z.dot(_x), _y.dot(_tmp));
    }
    _q2.setFromAxisAngle(_x, twist * 0.5).multiply(_q);
    _tmp.subVectors(_w, _e).multiplyScalar(0.12 / ARM.fore).add(_e);
    this.set(ARM_BONES.fore2, _tmp, _q2);
    // Hand
    this.set(ARM_BONES.hand, _w, t.hand);
    const hand = this.bones[ARM_BONES.hand].matrixWorld;
    const sh = t.shape;
    for (let f = 0; f < 4; f++) {
      const b0 = ARM_BONES.index + f * 3;
      const c = CURL_MAX[f];
      const k0 = RELAX[0] + (c[0] - RELAX[0]) * sh.curl + sh.cup * 0.28;
      const k1 = RELAX[1] + (c[1] - RELAX[1]) * sh.curl + sh.cup * 0.2;
      const k2 = RELAX[2] + (c[2] - RELAX[2]) * sh.curl + sh.cup * 0.1;
      // Close the spread toward the middle finger as the fingers come together.
      const spread = -SPREADS[f] * (1 - sh.spread) * s;
      const m0 = this.chain(b0, hand, _axisZ, -k0, _axisY, -spread);
      const m1 = this.chain(b0 + 1, m0, _axisZ, -k1);
      this.chain(b0 + 2, m1, _axisZ, -k2);
    }
    const th = sh.thumb;
    const t0 = this.chain(ARM_BONES.thumb, hand, _axisY, -0.35 * th * s, _axisZ, -0.1 * th);
    const t1 = this.chain(ARM_BONES.thumb + 1, t0, _axisZ, -(0.15 + 0.55 * sh.curl + 0.3 * th));
    this.chain(ARM_BONES.thumb + 2, t1, _axisZ, -(0.12 + 0.6 * sh.curl));
  }
}

export class LegRig extends Limb {
  constructor(limb: BuiltLimb, material: MeshSSSNodeMaterial, side: 1 | -1) {
    super(limb, material, side, LEG_PARENTS);
  }

  pose(t: LegTarget, kneeOut?: Vector3) {
    twoBoneIK(t.hip, t.ankle, LEG.thigh, LEG.shin, t.pole, _e, _w);
    if (kneeOut) kneeOut.copy(_e);
    _chord.subVectors(_w, t.hip).normalize();
    _bend.subVectors(_e, t.hip);
    _bend.addScaledVector(_chord, -_bend.dot(_chord));
    if (_bend.lengthSq() < 1e-8) _bend.subVectors(t.pole, t.hip).addScaledVector(_chord, -_tmp.subVectors(t.pole, t.hip).dot(_chord));
    _bend.normalize();
    // Thigh / shin: local +Y is anterior (the knee's facing).
    _x.subVectors(_e, t.hip);
    basisQuat(_x, _bend, _q);
    this.set(LEG_BONES.thigh, t.hip, _q);
    _x.subVectors(_w, _e);
    basisQuat(_x, _bend, _q);
    this.set(LEG_BONES.shin, _e, _q);
    this.set(LEG_BONES.foot, _w, t.foot);
    this.chain(LEG_BONES.toes, this.bones[LEG_BONES.foot].matrixWorld, _axisZ, t.toe);
    // Pelvis: the bind frame is (X down, Y forward); world = pelvis orientation × bind.
    _x.set(0, -1, 0).applyQuaternion(t.pelvis);
    _y.set(1, 0, 0).applyQuaternion(t.pelvis);
    basisQuat(_x, _y, _q);
    _tmp.set(0, 0.08, 0).applyQuaternion(t.pelvis).add(t.hip);
    this.set(LEG_BONES.pelvis, _tmp, _q);
    void _m;
    void _axisX;
  }
}
