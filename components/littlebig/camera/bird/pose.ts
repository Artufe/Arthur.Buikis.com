// The bird's pose (v2-BA): from the flight state the physics writes (shared.ts BirdRender) to the
// joint angles, fans and head counter-rotation the vertex shader skins with (mesh.ts birdPatch,
// whose comment lays out the uniform). Pure and allocation-free; index.ts adds the daze.
//
// The beat (gull / crow / pigeon cruising flight): the downstroke takes 55 % of the cycle, the wing
// fully extended, sweeping down and a little forward, pronated (leading edge down), the primaries
// spread; the upstroke flexes elbow and wrist (span ~40 % shorter), the hand swept back and flicked
// up, supinated, the primaries closed. The body rises on the downstroke; the head holds level.
// On the ground: the legs plant the feet (a two-link IK, so the body can crouch, breathe and hop
// over them), the body tilts up on them, the wings fold along the back; a hop crouches, springs with
// the wings flicked half open and lands on bent knees.

import { ANKLE, FOOT, HIP } from './mesh';

const DEG = Math.PI / 180;
/** Fraction of the cycle that is downstroke (the physics pushes over phase [0, π): it lies inside). */
export const DOWNSTROKE = 0.55;
/** uBd size: 14 vec4 (mesh.ts birdPatch). */
export const POSE_FLOATS = 56;

export interface PoseInput {
  phase: number;
  amp: number;
  tuck: number;
  spread: number;
  turn: number;
  speed: number;
  crash: number;
  stand: number;
  legs: number;
  hop: number;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Where in the beat: elevation −1 (bottom) … 1 (top), downstroke push 0 … 1, upstroke flex 0 … 1. */
export function beat(phase: number, out: { el: number; down: number; flex: number }): void {
  let u = (phase / (2 * Math.PI)) % 1;
  if (u < 0) u += 1;
  if (u < DOWNSTROKE) {
    const d = u / DOWNSTROKE;
    out.el = Math.cos(Math.PI * d);
    out.down = Math.sin(Math.PI * d);
    out.flex = 0;
  } else {
    const w = (u - DOWNSTROKE) / (1 - DOWNSTROKE);
    // (The wing starts rising at once: a quick, folded upstroke.)
    out.el = -Math.cos(Math.PI * Math.pow(w, 0.75));
    out.down = 0;
    // Flexes fast off the bottom, peaks early in the upstroke, re-extends for the top.
    out.flex = Math.sin(Math.PI * Math.pow(w, 0.7));
  }
}

const b = { el: 0, down: 0, flex: 0 };
const fl = new Float32Array(32);
const ik = { h: 0, a: 0 };

// The leg's links in the body's side plane; angles from straight down, + forward.
const L1 = Math.hypot(ANKLE[1] - HIP[1], ANKLE[2] - HIP[2]);
const L2 = Math.hypot(FOOT[1] - ANKLE[1], FOOT[2] - ANKLE[2]);
const T1 = Math.atan2(ANKLE[2] - HIP[2], HIP[1] - ANKLE[1]);
const T2 = Math.atan2(FOOT[2] - ANKLE[2], ANKLE[1] - FOOT[1]);
/** The hip and ankle angles (the shader's x rotations: they subtract) keeping the foot where it stands with the hip dropped by d. */
function plant(d: number) {
  const dz = FOOT[2] - HIP[2];
  const dy = HIP[1] - d - FOOT[1];
  const D = clamp(Math.hypot(dz, dy), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
  const t = Math.atan2(dz, dy) + Math.acos(clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
  ik.h = T1 - t;
  ik.a = T2 - Math.atan2(FOOT[2] - HIP[2] - L1 * Math.sin(t), HIP[1] - d - L1 * Math.cos(t) - FOOT[1]) - ik.h;
}
/** A bump 0 → 1 → 0 over [a, b]. */
const bump = (x: number, a: number, b2: number) => (x > a && x < b2 ? Math.sin((Math.PI * (x - a)) / (b2 - a)) : 0);

/** One wing's joints (deg: shoulder twist, sweep, elevation; elbow sweep; wrist twist, sweep, elevation; fan) into o[j …] (rad), mirrored by sd. The unused slots stay 0. */
function wing(o: Float32Array, j: number, sd: number, sTw: number, sSw: number, sEl: number, eSw: number, wTw: number, wSw: number, wEl: number, fan: number) {
  o[j] = sTw * DEG;
  o[j + 1] = sd * sSw * DEG;
  o[j + 2] = sd * sEl * DEG;
  o[j + 5] = sd * eSw * DEG;
  o[j + 8] = wTw * DEG;
  o[j + 9] = sd * wSw * DEG;
  o[j + 10] = sd * wEl * DEG;
  o[j + 11] = sd * fan * DEG;
}

/**
 * Solve the pose into `o` (POSE_FLOATS, the uBd layout): the wings, tail and head (o[0 … 31]), the
 * bob (o[32]) and the head offset (o[48 … 51]); the daze (o[33 … 47]) is index.ts's. `clock` (s)
 * drives the glide's living adjustments and the crash flail; `pitch` and `roll` (rad) are the
 * body's attitude against the local horizon (nose up +, left wing up +), which the head counters.
 */
export function solvePose(o: Float32Array, s: PoseInput, clock: number, pitch: number, roll: number): void {
  const a = clamp(s.amp, 0, 1);
  const k = clamp(s.tuck, 0, 1);
  const f = clamp(s.spread, 0, 1);
  const r = clamp(s.turn, -1, 1);
  const v = s.speed > 0 ? s.speed : 7; // (0: not wired yet; a trim glide)
  const fast = smooth(8, 16, v);
  const slow = 1 - smooth(4, 6.5, v);
  beat(s.phase, b);
  const down = a * b.down;
  const fk = b.flex * Math.min(1, a * 1.5); // the upstroke's fold, full from amp ⅔
  const g = 1 - a; // the glide's share: living micro-adjustments
  for (let i = 0; i < 2; i++) {
    const sd = i === 0 ? 1 : -1;
    const inner = Math.max(0, -sd * r); // the wing on the inside of the turn
    const outer = Math.max(0, sd * r);
    wing(o, i * 12, sd,
      // Shoulder: twist (pronation +), sweep back, elevation (dihedral / the flap). Folding, the
      // humerus lifts the wrist: the upstroke's inverted V, not a wing laid on the back.
      7 * down - 8 * a * fk + 1.5 * g * Math.sin(clock * 1.3 + sd * 0.7) + 3 * outer - 4 * inner - 2 * k,
      a * (-12 * b.down + 10 * b.flex) + 8 * fast - 20 * f + 34 * k - 4 * outer,
      7 + a * (10 + 40 * b.el) + 14 * fk + 6 * f + 6 * k - 4 * inner,
      // Elbow: the forearm swings forward as the wing folds (the wrist leads).
      Math.max(-40, -34 * fk - 4 * fast - 12 * k),
      // Wrist: twist, sweep the hand back, flick it up (or droop it: the flare's cupped wing).
      16 * down - 26 * fk - 8 * f,
      Math.min(110, 100 * fk + 18 * fast - 6 * f + 30 * k + 12 * inner),
      -4 + 22 * fk + 2.5 * g * (Math.sin(clock * 1.9 + sd * 1.3) + 0.5 * Math.sin(clock * 3.1 + sd)) - 16 * f + 5 * k,
      clamp(6 + 4 * down - 20 * fk - 8 * fast + 5 * slow + 12 * f - 16 * k, -14, 12));
  }
  // Tail: lowered and fanned wide in a flare and near the stall, closed to a point in a stoop or at
  // speed, twisted and fanned into a turn, trimming a little in a glide.
  o[24] = (-24 * f - 6 * slow + 4 * k + 3 * a * b.el + 3 * g * Math.sin(clock * 0.8)) * DEG;
  o[25] = 8 * r * DEG;
  o[26] = (15 * r + 2 * g * Math.sin(clock * 1.1)) * DEG;
  o[27] = clamp(4 + 28 * f + 10 * slow - 6 * fast - 14 * k + 10 * Math.abs(r) + 4 * down, -14, 24) * DEG;
  // Head: holds level against the body's pitch and (partly) its bank; glances about in a glide;
  // reaches forward in a flare.
  // (In a stoop it looks down the dive with the body.)
  o[28] = 0.85 * (1 - 0.7 * k) * clamp(pitch, -0.6, 0.6) + 10 * f * DEG;
  o[29] = (5 * Math.sin(clock * 0.37) + 3 * Math.sin(clock * 0.91)) * DEG * g * (1 - k);
  o[30] = -0.6 * clamp(roll, -0.6, 0.6);
  // Body bob: lowest at the top of the beat, highest at the bottom (it rises on the downstroke).
  const bob = -0.035 * a * b.el;
  o[32] = bob;
  o[49] = -0.85 * bob - 0.012 * f;
  o[50] = 0.035 * f;

  // On the ground: the wings folded on the flanks (swept back and hung top-out, the secondaries'
  // tips along the back, the primaries over the tail; the shader shrinks them and moves them out
  // onto the flank), the body tilted up on its legs (nearly level afloat, the legs tucked), the
  // tail level, the head counter-tilted; idle life (the head glancing about, a tail flick,
  // breathing). A hop flicks the wings half open.
  const st = clamp(s.stand, 0, 1);
  const hp = clamp(s.hop, 0, 1);
  const lg = clamp(s.legs, 0, 1);
  const tilt = 26 * st * (0.35 + 0.65 * lg);
  const open = bump(hp, 0.28, 0.85);
  const fold = st * (1 - 0.65 * open);
  if (fold > 0) {
    for (let i = 0; i < 2; i++) wing(fl, i * 12, i === 0 ? 1 : -1, 0, 95, -72, 0, 0, -25, 0, -14);
    for (let i = 0; i < 24; i++) if (i % 12 !== 3) o[i] += (fl[i] - o[i]) * fold;
  }
  // (Opening off the ground, the wings rise: a hop's flick, the take-off into its first downstroke.)
  const lift = 75 * DEG * Math.sqrt(open) * st;
  o[2] += lift;
  o[14] -= lift;
  const flick = bump((clock * 0.37) % 1, 0, 0.07);
  const glance = clamp(2.2 * (Math.sin(clock * 0.53) + 0.7 * Math.sin(clock * 1.31 + 1)), -1, 1);
  o[24] += (tilt + 24 * st * flick) * DEG;
  o[27] -= st * 12 * DEG;
  o[28] += (0.85 * tilt + 7 * st * Math.sin(clock * 0.9)) * DEG;
  o[29] += st * 38 * glance * DEG;
  // The crouch: breathing, a hop's crouch and spring, its landing on bent knees.
  const crouch = st * (0.005 * (1 + Math.sin(clock * 2.6)) + 0.08 * (hp < 0.3 ? smooth(0, 0.3, hp) : 1 - smooth(0.3, 0.42, hp)) + 0.05 * bump(hp, 0.82, 1));
  o[54] = (120 * crouch - tilt) * DEG;
  o[55] = crouch;
  // Legs: tucked back flat under the belly … down: swung forward for a landing, planted as it
  // stands, half drawn up in a hop's air.
  plant(crouch);
  const air = 0.6 * bump(hp, 0.38, 0.86);
  o[52] = (75 + ((-20 + (ik.h / DEG + 20) * st) * (1 - air) + 75 * air - 75) * lg) * DEG;
  o[53] = (25 + ((-10 + (ik.a / DEG + 10) * st) * (1 - air) + 25 * air - 25) * lg) * DEG;
  // The toes: flat on the floor while planted, curled when tucked.
  o[31] = -(o[52] + o[53]) * st * lg + 50 * DEG * (1 - lg);

  // Crash: the wings flail out of step and loose, the tail splays, the head wobbles dizzily.
  const c = Math.min(1, s.crash * 1.6);
  for (let i = 0; i < 2 && c > 0; i++) {
    const sd = i === 0 ? 1 : -1;
    const p = clock * (15 + 3 * sd) + sd * 1.7;
    wing(fl, i * 12, sd, 20 * Math.sin(0.9 * p + sd), 25 * Math.sin(0.7 * p + 1), 10 + 45 * Math.sin(p), -10 - 10 * Math.sin(1.3 * p),
      30 * Math.sin(1.1 * p), 25 + 25 * Math.sin(1.3 * p + 2), 30 * Math.sin(1.9 * p), 12);
  }
  fl[24] = 15 * Math.sin(clock * 7) * DEG;
  fl[25] = 10 * Math.sin(clock * 5) * DEG;
  fl[26] = 25 * Math.sin(clock * 9) * DEG;
  fl[27] = 26 * DEG;
  fl[28] = 12 * Math.sin(clock * 5) * DEG;
  fl[29] = 22 * Math.cos(clock * 7.5) * DEG;
  fl[30] = 22 * Math.sin(clock * 7.5) * DEG;
  if (c > 0) for (let i = 0; i < 31; i++) o[i] += (fl[i] - o[i]) * c;
  o[3] = o[15] = 1 - 0.45 * fold;
}
