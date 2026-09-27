// Pose writers: one per player mode, all reading PlayerCore state and writing a world-space Pose.
// Local coordinates use the body/board frame: +X forward (nose), +Y up (deck), +Z right.

import { Quaternion, Vector3 } from 'three/webgpu';
import type { PlayerMode } from '../core/contracts';
import { clamp } from '../core/pool';
import type { Stance } from './api';
import { boardSpec } from './board/shape';
import type { ArmTarget, HandShape, LegTarget } from './body/rig';
import { CLIMB, EYE_H, PlayerCore } from './controller';
import { PIER } from '../world/layout';
import { GAP } from '../pier/plan';

const PIER_TIP = PIER.tipX; // [surf]
const GAP_HALF = GAP.half; // [surf]
import type { Foot } from './gait';
import { Frame, type Pose } from './pose';
import { basisQuat, ease, TAU } from './rigmath';

const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _qy = new Quaternion();
const _ax = new Vector3();
const F = new Frame(); // body / board frame
const S = new Frame(); // stabilised frame (head, shoulders) while prone
const T = new Frame(); // torso frame while standing on the board
const B = new Frame(); // board frame scratch
const BD = new Frame(); // [surf] rider's body frame on the board (about the feet)

function smooth01(x: number) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** Yaw (layout convention) → quaternion mapping local +X to forward. */
export function yawQuat(yaw: number, out: Quaternion) {
  return out.setFromAxisAngle(UP, yaw + Math.PI / 2);
}

export interface PoseOptions {
  reduced: boolean;
  bob: number;
}

function setShape(s: HandShape, curl: number, spread: number, thumb: number, cup: number) {
  s.curl = curl;
  s.spread = spread;
  s.thumb = thumb;
  s.cup = cup;
}

/** Hand orientation from finger direction and back-of-hand hint, both in frame `fr`. */
function handQ(fr: Frame, fx: number, fy: number, fz: number, dx: number, dy: number, dz: number, out: Quaternion) {
  fr.d(fx, fy, fz, _c);
  fr.d(dx, dy, dz, _d);
  return basisQuat(_c, _d, out);
}

// ── Walk / wade ─────────────────────────────────────────────────────────────────────────

const _foot = new Quaternion();
function footTarget(core: PlayerCore, f: Foot, leg: LegTarget) {
  yawQuat(f.yaw, _foot);
  _q.setFromAxisAngle(_ax.set(0, 0, 1), f.pitch);
  leg.foot.multiplyQuaternions(_foot, _q);
  // Ankle sits 7.8 cm above the sole, 6 cm behind the mid-foot contact point.
  leg.ankle.set(-0.06, 0.078, 0).applyQuaternion(leg.foot).add(f.out);
  leg.toe = f.toe;
  void core;
}

export function standingPose(core: PlayerCore, out: Pose, o: PoseOptions, wadeDepth: number) {
  F.o.set(core.pos.x, core.feetY, core.pos.z);
  yawQuat(core.heading, F.q);
  const sp = clamp(core.speed / 1.45, 0, 2.3);
  const ph = core.bobPhase;
  // Head: lowest at each heel strike (phase 0.4 and 0.9), a little sway over the stance foot.
  const bobAmp = o.reduced ? 0 : o.bob * (0.021 * Math.min(1, sp) + 0.018 * Math.max(0, sp - 1)) * (1 - 0.5 * clamp(wadeDepth, 0, 1));
  const bob = -bobAmp * (0.5 + 0.5 * Math.cos(TAU * 2 * (ph - 0.4)));
  const sway = o.reduced ? 0 : o.bob * 0.011 * Math.min(1, sp) * Math.sin(TAU * (ph - 0.15));
  const lean = 0.035 * Math.max(0, sp - 1);
  // Looking down, the head tips forward and the eye travels ahead of the chest: that is what
  // lets you see your own feet (and keeps the torso-less body behind the lens).
  const nod = smooth01((-core.pitch - 0.45) / 0.65);
  F.p(0.07 + lean + 0.17 * nod, EYE_H + bob - 0.07 * nod, sway, out.eye);
  out.camPitch = 0;
  out.camRoll = o.reduced ? 0 : sway * 0.35;

  // Hips and legs from the gait.
  // Hips 14 cm behind the eye so, looking down, the shorts stay behind the lens and the feet show.
  const hipY = 0.93 + bob * 0.8;
  F.p(-0.07, hipY, -0.092, out.legL.hip);
  F.p(-0.07, hipY, 0.092, out.legR.hip);
  footTarget(core, core.gait.feet[0], out.legL);
  footTarget(core, core.gait.feet[1], out.legR);
  F.p(0.9, 0.5, -0.2, out.legL.pole);
  F.p(0.9, 0.5, 0.2, out.legR.pole);
  out.legL.pelvis.copy(F.q);
  out.legR.pelvis.copy(F.q);

  // Shoulders.
  const shY = EYE_H - 0.225 + bob * 0.9;
  F.p(-0.03, shY, -0.185, out.armL.shoulder);
  F.p(-0.03, shY, 0.185, out.armR.shoulder);

  // Left arm swings opposite the left leg.
  const swing = (o.reduced ? 0.6 : 1) * 0.2 * Math.min(1.2, sp) * Math.sin(TAU * (ph + 0.2));
  const wet = clamp(wadeDepth / 0.9, 0, 1);
  F.p(-0.04 + swing * 0.55, EYE_H - 0.8 + Math.abs(swing) * 0.12 + wet * 0.18, -0.235 - wet * 0.08, out.armL.wrist);
  handQ(F, 0.12 + swing * 0.3, -1, -0.05 - wet * 0.4, 0, 0, -1, out.armL.hand);
  F.p(-0.5, EYE_H - 0.45, -0.35, out.armL.pole);
  setShape(out.armL.shape, 0.32, 0.45, 0.2, 0.05);

  // Board: carried under the right arm, easing into the water alongside when wading.
  carryBoard(core, out, core.boardFloat, sp);
}

function carryBoard(core: PlayerCore, out: Pose, float: number, sp: number) {
  // Carry: on its rail under the arm, deck to the ribs (tilted a touch face-down), nose forward,
  // up ~8° and angled a few degrees outward so it frames the lower right of the view.
  const a = 0.14;
  const out_ = 0.1;
  const bob = Math.sin(TAU * 2 * (core.bobPhase - 0.4)) * 0.012 * Math.min(1, sp);
  F.p(-0.06, 1.075 + bob, 0.3, _a);
  F.d(Math.cos(a) * Math.cos(out_), Math.sin(a), Math.sin(out_), _b);
  F.d(-0.1, -0.16, -1, _c);
  basisQuat(_b, _c, _q);
  // Float: flat on the water to the right and ahead, same heading, riding the surface.
  const water = core.waterY;
  F.p(0.62, 0, 0.52, _d);
  _d.y = water - 0.035;
  _qy.setFromUnitVectors(UP, core.boardN);
  yawQuat(core.heading, _q2);
  _q2.premultiply(_qy);
  const t = ease(float);
  out.board.lerpVectors(_a, _d, t);
  // Lift through the middle of the hand-off so a rail never dips under mid-roll.
  out.board.y += Math.sin(Math.PI * t) * 0.18;
  out.boardQ.slerpQuaternions(_q, _q2, t);

  // Right hand: carry → the lower rail from outside; float → resting on the near rail.
  B.o.copy(out.board);
  B.q.copy(out.boardQ);
  const hw = boardSpec.halfWidthAt(0.05);
  if (t < 0.999) {
    // Palm flat on the bottom just above the lower rail, fingers hooked round the rail.
    B.p(0.02, -0.012, -hw + 0.075, _a);
    const wr = out.armR.wrist;
    B.d(0, 0, -1, _b);
    wr.copy(_a).addScaledVector(_b, -0.06);
    // Fingers point down the bottom toward the rail; back of the hand faces out.
    handQ(B, 0.05, 0.0, -1, 0, -1, 0, out.armR.hand);
  }
  if (t > 0.001) {
    const hwF = boardSpec.halfWidthAt(-0.1);
    B.p(-0.1, 0.06, -hwF + 0.02, _b);
    _b.y += 0.035;
    // Blend the two hand placements.
    if (t >= 0.999) out.armR.wrist.copy(_b);
    else out.armR.wrist.lerp(_b, t);
    handQ(B, 0.25, -0.35, 0.85, 0, 1, 0, _q);
    if (t >= 0.999) out.armR.hand.copy(_q);
    else out.armR.hand.slerp(_q, t);
  }
  F.p(-0.3, EYE_H - 0.35, 0.65, out.armR.pole);
  setShape(out.armR.shape, 0.78 * (1 - t) + 0.22 * t, 0.25 + 0.3 * t, 0.55 * (1 - t) + 0.2 * t, 0.1);
}

// ── Prone: paddle, catch, push-up ───────────────────────────────────────────────────────

// Right-arm wrist path over one stroke (board frame), knots at these phases. Left mirrors Z.
const K_T = [0, 0.1, 0.3, 0.48, 0.56, 0.76, 0.91, 1];
const K_P = [
  [0.74, 0.07, 0.28],
  [0.7, -0.06, 0.28],
  [0.42, -0.26, 0.27],
  [0.02, -0.2, 0.29],
  [-0.08, 0.06, 0.33],
  [0.45, 0.2, 0.4],
  // The reach: arm long over the water before the hand plunges in (this is what the eye sees).
  [0.7, 0.19, 0.31],
  [0.74, 0.07, 0.28],
];
// Finger direction and back-of-hand hint at each knot.
const K_F = [
  [0.8, -0.55, 0.05, 0.55, 0.8, 0.1],
  [0.38, -0.92, 0.0, 0.92, 0.38, 0.05],
  [0.05, -1, 0.05, 1, 0.05, 0],
  [-0.35, -0.9, 0.12, 0.9, -0.35, 0.1],
  [-0.55, -0.5, 0.15, 0.1, 0.1, 1],
  [0.78, -0.3, 0.12, 0.1, 0.93, -0.35],
  [0.92, -0.32, 0.06, 0.32, 0.94, -0.1],
  [0.8, -0.55, 0.05, 0.55, 0.8, 0.1],
];
const K_POLE = [
  [0.0, 0.3, 0.6],
  [0.0, 0.35, 0.6],
  [-0.1, 0.35, 0.65],
  [-0.2, 0.4, 0.6],
  [-0.1, 0.6, 0.55],
  [0.15, 0.55, 0.6],
  [0.05, 0.4, 0.6],
  [0.0, 0.3, 0.6],
];
const _kq0 = new Quaternion();
const _kq1 = new Quaternion();

function knot(ph: number) {
  let i = 0;
  while (i < K_T.length - 2 && ph > K_T[i + 1]) i++;
  return i;
}

/** Cubic Hermite through the cyclic wrist knots at their phase times. */
function strokeWrist(ph: number, side: number, fr: Frame, out: Vector3) {
  const n = K_T.length - 1;
  const i = knot(ph);
  const t0 = K_T[i];
  const t1 = K_T[i + 1];
  const h = t1 - t0;
  const u = (ph - t0) / h;
  const im = i === 0 ? n - 1 : i - 1;
  const ip = i + 2 > n ? 1 : i + 2;
  const tm = i === 0 ? K_T[n - 1] - 1 : K_T[i - 1];
  const tp = i + 2 > n ? 1 + K_T[1] : K_T[i + 2];
  let x = 0;
  let y = 0;
  let z = 0;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  for (let c = 0; c < 3; c++) {
    const p0 = K_P[i][c];
    const p1 = K_P[i + 1][c];
    const m0 = ((K_P[i + 1][c] - K_P[im][c]) / (t1 - tm)) * h;
    const m1 = ((K_P[ip][c] - K_P[i][c]) / (tp - t0)) * h;
    const v = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    if (c === 0) x = v;
    else if (c === 1) y = v;
    else z = v;
  }
  return fr.p(x, y, z * side, out);
}

function strokeHand(ph: number, side: number, fr: Frame, arm: ArmTarget) {
  const i = knot(ph);
  const u = ease((ph - K_T[i]) / (K_T[i + 1] - K_T[i]));
  const a = K_F[i];
  const b = K_F[i + 1];
  handQ(fr, a[0], a[1], a[2] * side, a[3], a[4], a[5] * side, _kq0);
  handQ(fr, b[0], b[1], b[2] * side, b[3], b[4], b[5] * side, _kq1);
  arm.hand.slerpQuaternions(_kq0, _kq1, u);
  const pa = K_POLE[i];
  const pb = K_POLE[i + 1];
  _a.set(pa[0] + (pb[0] - pa[0]) * u, pa[1] + (pb[1] - pa[1]) * u, (pa[2] + (pb[2] - pa[2]) * u) * side);
  fr.d(_a.x, _a.y, _a.z, _b);
  arm.pole.copy(arm.shoulder).addScaledVector(_b, 1);
  // Cupped and closed underwater, loose on the recovery.
  const under = ph > 0.04 && ph < 0.52 ? 1 : 0;
  const k = under ? 1 : 0;
  setShape(arm.shape, 0.05 + 0.05 * (1 - k), 0.03 + 0.14 * (1 - k), 0.2, 0.55 * k + 0.08);
}

/** Board frame for the prone modes. */
function boardFrame(core: PlayerCore, fr: Frame) {
  fr.o.set(core.pos.x, core.waterY - 0.012, core.pos.z);
  _qy.setFromUnitVectors(UP, core.boardN);
  yawQuat(core.heading, fr.q);
  fr.q.premultiply(_qy);
  fr.q.multiply(_q.setFromAxisAngle(_ax.set(0, 0, 1), core.boardPitch));
  fr.q.multiply(_q.setFromAxisAngle(_ax.set(1, 0, 0), core.boardRoll));
}

const deckAt = (x: number) => boardSpec.deckAt(x);

export function pronePose(core: PlayerCore, out: Pose, o: PoseOptions) {
  boardFrame(core, F);
  out.board.copy(F.o);
  out.boardQ.copy(F.q);
  // The head and shoulders ride the board but keep a steadier horizon.
  S.o.copy(F.o);
  yawQuat(core.heading, _q2);
  S.q.slerpQuaternions(_q2, F.q, 0.55);
  const push = ease(core.push);
  const w = core.paddleW;
  const strokeBob = o.reduced ? 0 : 0.006 * w * Math.cos(TAU * 2 * core.stroke);
  S.p(0.3 - push * 0.02, deckAt(0.3) + 0.37 + push * 0.26 + strokeBob, 0, out.eye);
  // View follows part of the board's pitch and roll, so the horizon moves with the swell.
  F.d(1, 0, 0, _a);
  const pitch = Math.asin(clamp(_a.y, -1, 1));
  F.d(0, 0, 1, _b);
  const roll = -Math.asin(clamp(_b.y, -1, 1));
  const k = o.reduced ? 0.5 : 1;
  out.camPitch = pitch * 0.45 * k;
  out.camRoll = roll * 0.3 * k;

  // Shoulders 10 cm behind and 20 cm below the eye: chest arched, head up.
  const shY = deckAt(0.2) + 0.16 + push * 0.3;
  S.p(0.2 - push * 0.06, shY, -0.19, out.armL.shoulder);
  S.p(0.2 - push * 0.06, shY, 0.19, out.armR.shoulder);
  proneArm(core, out.armR, 1, w, push);
  proneArm(core, out.armL, -1, w, push);

  // Legs lie along the deck behind, feet trailing past the tail, soles up.
  const hipY = deckAt(-0.5) + 0.1 + push * 0.04;
  F.p(-0.52, hipY, -0.09, out.legL.hip);
  F.p(-0.52, hipY, 0.09, out.legR.hip);
  proneLeg(out.legL, -1, core.t);
  proneLeg(out.legR, 1, core.t + 1.3);
}

function proneArm(core: PlayerCore, arm: ArmTarget, side: number, w: number, push: number) {
  const ph = side > 0 ? core.stroke : (core.stroke + 0.5) % 1;
  // Paddling cycle.
  const wr = arm.wrist;
  strokeHand(ph, side, F, arm);
  strokeWrist(ph, side, F, wr);
  _a.copy(wr);
  if (w < 0.999) {
    // Resting: hands trail in the water beside the chest.
    F.p(0.28, 0.02, 0.3 * side, _b);
    handQ(F, 0.85, -0.35, 0.3 * side, 0, 0.9, 0.35 * side, _q);
    wr.lerpVectors(_b, _a, w);
    arm.hand.slerpQuaternions(_q, arm.hand, w);
    F.p(-0.2, 0.5, 0.55 * side, _c);
    arm.pole.lerpVectors(_c, arm.pole, w);
  }
  if (push > 0.001) {
    // Push-up: hands on the rails by the chest, arms straight.
    const x = 0.14;
    const hw = boardSpec.halfWidthAt(x);
    F.p(x, deckAt(x) + 0.03, (hw - 0.035) * side, _b);
    wr.lerp(_b, push);
    handQ(F, 0.2, -0.25, 0.95 * side, 0.1, 0.95, -0.25 * side, _q);
    arm.hand.slerp(_q, push);
    F.p(-0.4, 0.45, 0.45 * side, _c);
    arm.pole.lerp(_c, push);
    arm.shape.curl += (0.35 - arm.shape.curl) * push;
    arm.shape.spread += (0.5 - arm.shape.spread) * push;
  }
  void core;
}

function proneLeg(leg: LegTarget, side: number, t: number) {
  const kick = Math.sin(t * 1.3) * 0.02;
  F.p(-1.24, deckAt(-0.9) + 0.14 + kick * side, 0.13 * side, leg.ankle);
  F.d(-1, -0.25, 0.05 * side, _a);
  F.d(0, -1, 0, _b);
  basisQuat(_a, _b, leg.foot);
  F.p(-0.85, -0.8, 0.12 * side, leg.pole);
  leg.toe = 0.1;
  F.d(0, -1, 0, _a);
  F.d(1, 0, 0, _b);
  basisQuat(_a, _b, leg.pelvis);
}

// ── On the board: pop-up, ride, wipeout ─────────────────────────────────────────────────

/** Board frame while standing: from the rig's board pose (the surf system may drive it). */
function standingBoardFrame(board: Vector3, boardQ: Quaternion, fr: Frame) {
  fr.o.copy(board);
  fr.q.copy(boardQ);
}

export function stancePose(board: Vector3, boardQ: Quaternion, st: Stance, out: Pose, o: PoseOptions, t: number, viewYaw = NaN) {
  standingBoardFrame(board, boardQ, F);
  out.board.copy(F.o);
  out.boardQ.copy(F.q);
  const cr = clamp(st.crouch, 0, 1);
  const lean = clamp(st.lean, -1, 1);
  const fore = clamp(st.fore, -1, 1);
  // Feet on the deck (the rear foot on the pad).
  const legF = out.legL;
  const legR = out.legR;
  placeFoot(legF, st.frontX, st.frontZ, st.frontAngle, 0);
  placeFoot(legR, st.rearX, st.rearZ, st.rearAngle, 0.012);
  // Torso faces the toe-side rail (+Z) for a regular stance.
  const mid = (st.frontX + st.rearX) / 2 + fore * 0.08;
  const hipH = 0.95 - 0.33 * cr;
  const deck = deckAt(mid);
  // [surf] Body frame: the board frame tipped about the feet so its up is the rider's lean axis
  // (the ride driver writes it: vertical plus the turn's and the drop's accelerations).
  BD.q.copy(F.q);
  F.p(mid, deck, 0, BD.o);
  if ((st.bodyY ?? 0) > 0) {
    F.d(0, 1, 0, _c);
    _d.set(st.bodyX ?? 0, st.bodyY ?? 1, st.bodyZ ?? 0).normalize();
    _q.setFromUnitVectors(_c, _d);
    BD.q.premultiply(_q);
  }
  BD.p(-0.02, hipH, 0.02 + lean * 0.09, _a);
  F.d(1, 0, 0, _b);
  legF.hip.copy(_a).addScaledVector(_b, 0.092);
  legR.hip.copy(_a).addScaledVector(_b, -0.092);
  // Knees track over the toes.
  F.d(Math.cos(st.frontAngle), 0.6, Math.sin(st.frontAngle), _c);
  legF.pole.copy(legF.ankle).addScaledVector(_c, 1);
  F.d(Math.cos(st.rearAngle), 0.6, Math.sin(st.rearAngle), _c);
  legR.pole.copy(legR.ankle).addScaledVector(_c, 1);
  // Pelvis: anatomical forward = +Z of the board, up = the body's up. [surf]
  T.o.copy(_a);
  BD.d(0, 0, 1, _b);
  BD.d(0, 1, 0, _c);
  basisQuat(_b, _c, T.q);
  legF.pelvis.copy(T.q);
  legR.pelvis.copy(T.q);
  // Head over the front knee, looking up the board.
  const bob = o.reduced ? 0 : Math.sin(t * 2.1) * 0.004;
  BD.p(0.2 + fore * 0.06, 1.6 - 0.42 * cr + bob, -0.05 + lean * 0.05, out.eye); // [surf] less toe-side head shift: kept the knees in view
  out.camPitch = 0;
  out.camRoll = 0;
  // The upper body turns to face the nose with the head (as surfers do), so the shoulders sit
  // behind and below the lens like when walking and never float into the frame.
  F.d(1, 0, 0, _b);
  BD.d(0, 1, 0, _c); // [surf] leaning with the body
  _b.addScaledVector(_c, -_b.dot(_c));
  if (_b.lengthSq() < 1e-6) F.d(1, 0, 0, _b);
  _b.normalize();
  // [surf] ...and with the head beyond ±0.45 rad of the nose: carving, the view leads the board by
  // up to 90°, and a torso left facing the nose put the rear shoulder in front of the lens.
  if (viewYaw === viewYaw) {
    _d.set(-Math.sin(viewYaw), 0, -Math.cos(viewYaw));
    _d.addScaledVector(_c, -_d.dot(_c));
    if (_d.lengthSq() > 1e-6) {
      _d.normalize();
      const sn = _c.x * (_b.y * _d.z - _b.z * _d.y) + _c.y * (_b.z * _d.x - _b.x * _d.z) + _c.z * (_b.x * _d.y - _b.y * _d.x);
      const a = Math.atan2(sn, _b.dot(_d));
      const lim = 0.45;
      if (a > lim || a < -lim) {
        const th = a > 0 ? a - lim : a + lim;
        const c = Math.cos(th);
        const s = Math.sin(th);
        // _b ← _b cos θ + (_c × _b) sin θ (rotation about the body axis; _b ⟂ _c)
        const x = _b.x * c + (_c.y * _b.z - _c.z * _b.y) * s;
        const y = _b.y * c + (_c.z * _b.x - _c.x * _b.z) * s;
        const z = _b.z * c + (_c.x * _b.y - _c.y * _b.x) * s;
        _b.set(x, y, z).normalize();
      }
    }
  }
  basisQuat(_b, _c, T.q);
  T.o.copy(out.eye);
  const ar = clamp(st.arms, 0, 1);
  T.p(-0.07, -0.235, -0.19, out.armL.shoulder);
  T.p(-0.07, -0.235, 0.19, out.armR.shoulder);
  // Front (left) arm reaches ahead and out low; rear arm hangs back by the hip.
  T.d(0.12 + 0.1 * ar, -0.46 + 0.14 * ar, -0.24 - 0.12 * ar + lean * 0.06, _c);
  out.armL.wrist.copy(out.armL.shoulder).add(_c);
  handQ(T, 0.75, -0.5, -0.3, 0.1, 0.4, -0.9, out.armL.hand);
  out.armL.pole.copy(out.armL.shoulder).add(T.d(-0.2, 0.1, -0.6, _c));
  T.d(-0.06 - 0.1 * ar, -0.5 + 0.12 * ar, 0.16 + 0.1 * ar + lean * 0.06, _c);
  out.armR.wrist.copy(out.armR.shoulder).add(_c);
  handQ(T, -0.2, -0.95, 0.25, -0.1, 0.25, 0.95, out.armR.hand);
  out.armR.pole.copy(out.armR.shoulder).add(T.d(-0.4, 0.1, 0.5, _c));
  setShape(out.armL.shape, 0.28, 0.75, 0.15, 0);
  setShape(out.armR.shape, 0.3, 0.7, 0.15, 0);
}

function placeFoot(leg: LegTarget, x: number, z: number, angle: number, pad: number) {
  // Sole on the deck: ankle 7.8 cm above it along the deck normal, 6 cm behind mid-foot.
  F.d(Math.cos(angle), 0, Math.sin(angle), _b);
  F.d(0, 1, 0, _c);
  basisQuat(_b, _c, leg.foot);
  F.p(x, deckAt(x) + pad, z, _d);
  leg.ankle.set(-0.06, 0.078, 0).applyQuaternion(leg.foot).add(_d);
  leg.toe = 0;
}

export function popupPose(core: PlayerCore, st: Stance, out: Pose, o: PoseOptions, scratchA: Pose, scratchB: Pose) {
  // [surf] Evaluated as the outgoing pose of a blend (popup → ride), modeTime is the new mode's:
  // the pop-up is complete by then (it restarted at prone and snapped the eye down 0.8 m).
  const u = core.mode === 'popup' ? clamp(core.modeTime / PlayerCore.POPUP_S, 0, 1) : 1;
  // A: pushed up on the rails. B: the stance. The feet swing through between them.
  const savedPush = core.push;
  core.push = 1;
  pronePose(core, scratchA, o);
  core.push = savedPush;
  boardFrame(core, B);
  stancePose(B.o, B.q, st, scratchB, o, core.t, core.yaw); // [surf] view yaw
  const b = ease(clamp((u - 0.18) / 0.82, 0, 1));
  out.copy(scratchA);
  // The body rises in an arc while the hands stay planted.
  out.blend(out, scratchB, b);
  // The head drops to watch the hands and feet land, then comes back up to the line.
  out.camPitch -= (o.reduced ? 0.15 : 0.42) * Math.sin(Math.PI * clamp(u * 1.1, 0, 1));
  out.eye.y += Math.sin(Math.PI * clamp((u - 0.2) / 0.7, 0, 1)) * 0.08;
  // Hands leave the rails late.
  if (b < 0.6) {
    const k = 1 - b / 0.6;
    out.armL.wrist.lerp(scratchA.armL.wrist, k);
    out.armR.wrist.lerp(scratchA.armR.wrist, k);
  }
}

export function wipeoutPose(core: PlayerCore, out: Pose, o: PoseOptions) {
  // Fallback tumble (the surf system replaces it): low over the water, board thrown ahead.
  pronePose(core, out, o);
  const u = clamp(core.modeTime / 1.7, 0, 1);
  const k = Math.sin(Math.PI * u);
  out.eye.y += 0.12 * k;
  out.camRoll += (o.reduced ? 0.05 : 0.5) * k * Math.sin(u * 7);
  out.camPitch += (o.reduced ? 0.02 : 0.25) * k * Math.sin(u * 5 + 1);
  F.d(1, 0, 0, _a);
  out.board.addScaledVector(_a, 1.6 * k);
}

/**
 * [surf] Climbing the pier's swim ladder (PlayerCore.updateClimb): facing the ladder, the left hand
 * goes hand-over-hand up the left stile (then onto the gap post to step out), the right arm keeps
 * the board tucked under it, the feet stand on the treads.
 */
export function climbPose(core: PlayerCore, out: Pose, o: PoseOptions, lx: number, lz: number, half: number, deck: number) {
  F.o.set(core.pos.x, core.feetY, core.pos.z);
  yawQuat(core.heading, F.q);
  const k = core.climbK;
  const out_ = core.modeTime > CLIMB.top ? clamp((core.modeTime - CLIMB.top) / (CLIMB.out - CLIMB.top), 0, 1) : 0;
  // Eye close to the ladder, rising with the steps; a little lean back to look up at the start.
  F.p(0.1 - 0.06 * (1 - k), EYE_H - 0.06 + 0.04 * out_, 0, out.eye);
  out.camPitch = 0;
  out.camRoll = 0;
  const hipY = 0.92;
  F.p(-0.08, hipY, -0.092, out.legL.hip);
  F.p(-0.08, hipY, 0.092, out.legR.hip);
  // Feet on the treads (alternating which is higher), the toes on the tread's front edge.
  const up = (core.climbStep & 1) === 0 ? 1 : 0;
  for (let s = 0; s < 2; s++) {
    const leg = s === 0 ? out.legL : out.legR;
    const lift = (s === 0 ? up : 1 - up) * 0.3;
    F.p(0.22 - 0.2 * out_, lift * (1 - out_), (s === 0 ? -1 : 1) * 0.12, _a);
    yawQuat(core.heading, _q);
    leg.foot.copy(_q);
    leg.ankle.set(-0.06, 0.078, 0).applyQuaternion(leg.foot).add(_a);
    leg.toe = 0.15;
    F.p(0.9, 0.6, (s === 0 ? -1 : 1) * 0.2, leg.pole);
    leg.pelvis.copy(F.q);
  }
  const shY = EYE_H - 0.225;
  F.p(-0.03, shY, -0.185, out.armL.shoulder);
  F.p(-0.03, shY, 0.185, out.armR.shoulder);
  // Right arm: the board under it, as when carrying on the sand.
  carryBoard(core, out, 0, 0);
  // Left hand: on the left stile, re-gripping higher every 0.6 m of rise (a reach between
  // grips); at the top it takes the gap post instead.
  const eyeY = out.eye.y;
  const grip = Math.floor((eyeY - 0.2) / 0.6) * 0.6 + 0.2;
  const ph = clamp(((eyeY - 0.2) / 0.6) % 1, 0, 1);
  const reach = ph > 0.72 ? (ph - 0.72) / 0.28 : 0;
  const hy = Math.min(deck - 0.05, grip + 0.6 * reach * reach * (3 - 2 * reach) + 0.05);
  const hand = _b.set(lx - 0.035, hy, lz - half + 0.02);
  if (out_ > 0) {
    // The gap post, a little above the deck, as the body steps out onto the planks.
    _c.set(PIER_TIP + 0.03, deck + 0.75, lz - GAP_HALF + 0.07);
    hand.lerp(_c, clamp(out_ * 1.6, 0, 1));
  }
  out.armL.wrist.copy(hand).addScaledVector(F.d(-1, 0, 0, _c), 0.05);
  handQ(F, 0.2, 0.15, 1, -0.2, 0.3, -0.95, out.armL.hand);
  F.p(-0.3, shY - 0.5, -0.55, out.armL.pole);
  setShape(out.armL.shape, 0.78, 0.2, 0.6, 0.2);
  void o;
}

/**
 * [surf] The surf driver's wipeout: the body tumbles free of the board (both from the driver:
 * eye + body axis in the stance, board in board/boardQ). Arms wrap the head, legs trail; all of
 * it just outside the lens so the view is the tumble, the spray and the board flying.
 */
export function tumblePose(core: PlayerCore, board: Vector3, boardQ: Quaternion, st: Stance, out: Pose) {
  out.board.copy(board);
  out.boardQ.copy(boardQ);
  out.eye.set(st.eyeX ?? board.x, st.eyeY ?? board.y + 0.5, st.eyeZ ?? board.z);
  out.camPitch = 0;
  out.camRoll = 0;
  // Body frame: up = the tumbling body axis, forward = where the head looks (so the limbs, kept
  // behind and round the head, stay out of a lens that rolls and pitches with the tumble).
  _c.set(st.bodyX ?? 0, (st.bodyY ?? 1) > 1e-3 ? (st.bodyY as number) : 1e-3, st.bodyZ ?? 0).normalize();
  _b.set(-Math.sin(core.yaw), 0, -Math.cos(core.yaw));
  _b.addScaledVector(_c, -_b.dot(_c));
  if (_b.lengthSq() < 1e-6) _b.set(1, 0, 0);
  _b.normalize();
  basisQuat(_b, _c, T.q);
  T.o.copy(out.eye);
  // Arms: hands clasped behind the head, elbows up and out beside the ears: ≥ 85° off every view
  // axis the tumble reaches (it pitches down, and roll doesn't move the axis), so the lens never
  // sees them however the eased camera lags the roll. (Elbows forward swung into the frame.)
  T.p(-0.1, -0.2, -0.19, out.armL.shoulder);
  T.p(-0.1, -0.2, 0.19, out.armR.shoulder);
  T.p(-0.16, 0.12, -0.07, out.armL.wrist);
  T.p(-0.16, 0.12, 0.07, out.armR.wrist);
  T.p(-0.08, 0.35, -0.45, out.armL.pole);
  T.p(-0.08, 0.35, 0.45, out.armR.pole);
  handQ(T, 0.1, 0.2, 1, -1, 0, 0, out.armL.hand);
  handQ(T, 0.1, 0.2, -1, -1, 0, 0, out.armR.hand);
  setShape(out.armL.shape, 0.55, 0.3, 0.3, 0.1);
  setShape(out.armR.shape, 0.55, 0.3, 0.3, 0.1);
  // Legs: trailing behind the head (a body tumbling head-first through the soup), never in front.
  T.p(-0.55, -0.35, -0.09, out.legL.hip);
  T.p(-0.55, -0.35, 0.09, out.legR.hip);
  T.p(-1.35, -0.45, -0.14, out.legL.ankle);
  T.p(-1.32, -0.4, 0.16, out.legR.ankle);
  T.p(-0.9, 0.1, -0.15, out.legL.pole);
  T.p(-0.9, 0.1, 0.15, out.legR.pole);
  T.d(-1, -0.3, 0, _a);
  T.d(0, -1, 0, _d);
  basisQuat(_a, _d, out.legL.foot);
  out.legR.foot.copy(out.legL.foot);
  out.legL.toe = 0.2;
  out.legR.toe = 0.2;
  T.d(0, -1, 0, _a);
  T.d(1, 0, 0, _d);
  basisQuat(_a, _d, out.legL.pelvis);
  out.legR.pelvis.copy(out.legL.pelvis);
}

/** Pose for any mode. */
export function poseFor(mode: PlayerMode, core: PlayerCore, st: Stance, board: Vector3, boardQ: Quaternion, out: Pose, o: PoseOptions, sa: Pose, sb: Pose) {
  switch (mode) {
    case 'walk':
      standingPose(core, out, o, 0);
      return;
    case 'wade':
      standingPose(core, out, o, core.depth);
      return;
    case 'paddle':
    case 'catch':
      pronePose(core, out, o);
      return;
    case 'popup':
      popupPose(core, st, out, o, sa, sb);
      return;
    case 'ride':
      stancePose(board, boardQ, st, out, o, core.t, core.yaw); // [surf] view yaw
      return;
    case 'wipeout':
      if ((st.tumble ?? -1) >= 0) tumblePose(core, board, boardQ, st, out); // [surf]
      else wipeoutPose(core, out, o);
      return;
    case 'climb': {
      // [surf]
      const L = core.ladder();
      if (L) climbPose(core, out, o, L.x, L.z, L.halfWidth, L.top + 0.03);
      else standingPose(core, out, o, 0);
      return;
    }
  }
}

/** Board frame the surf system starts from at the end of the pop-up. */
export function proneBoard(core: PlayerCore, pos: Vector3, q: Quaternion) {
  boardFrame(core, B);
  pos.copy(B.o);
  q.copy(B.q);
}
