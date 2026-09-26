// Anatomy for the first-person limbs, authored for the RIGHT side in a rig frame:
// +X forward along the limb (arm) / toward the toes (leg), +Y up (back of the hand when palm
// down), +Z to the right. The left side mirrors Z. Bones carry their bind frames; parts carry the
// shape. Dimensions are an adult male, ~1.80 m.

import { type Clip, type Part, type PartSpec, makePart } from './sdf';

export interface BoneDef {
  name: string;
  /** Joint position (bind). */
  head: [number, number, number];
  /** Bind frame: local +X direction and a local +Y hint. */
  x: [number, number, number];
  y: [number, number, number];
}

export interface MeshJob {
  min: [number, number, number];
  max: [number, number, number];
  h: number;
  /** Keep the side of `axis = value` given by `keep` (+1 above, -1 below). Overlaps its sibling. */
  clip?: Clip;
}

export interface LimbModel {
  parts: Part[];
  bones: BoneDef[];
  jobs: MeshJob[];
  /** Joints whose dorsal skin wrinkles (finger knuckles): position, axis, dorsal. */
  creases: Array<{ p: [number, number, number]; axis: [number, number, number]; up: [number, number, number] }>;
  /** Parts on the palm / sole side for the lighter volar skin. */
  volarUp: (x: number, y: number, z: number, out: [number, number, number]) => void;
}

type V3 = [number, number, number];
const add = (a: readonly number[], b: readonly number[], s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const norm = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// ── Arm ────────────────────────────────────────────────────────────────────────────────

export const ARM = {
  upper: 0.315,
  fore: 0.265,
  /** Wrist → middle-finger MCP knuckle. */
  palm: 0.097,
};
export const ARM_BONES = {
  upper: 0,
  fore1: 1,
  fore2: 2,
  hand: 3,
  index: 4,
  middle: 7,
  ring: 10,
  little: 13,
  thumb: 16,
  count: 19,
};

interface FingerDef {
  mcp: V3;
  spread: number; // rad, + toward +Z
  lens: [number, number, number];
  radii: [number, number, number, number];
}

const W: V3 = [ARM.upper + ARM.fore, 0, 0];
export const FINGERS: FingerDef[] = [
  { mcp: add(W, [0.094, 0.003, -0.027]), spread: -0.12, lens: [0.043, 0.025, 0.021], radii: [0.0098, 0.0089, 0.008, 0.0071] },
  { mcp: add(W, [0.097, 0.004, -0.0085]), spread: -0.02, lens: [0.047, 0.029, 0.022], radii: [0.0102, 0.0093, 0.0083, 0.0073] },
  { mcp: add(W, [0.092, 0.002, 0.0105]), spread: 0.08, lens: [0.044, 0.027, 0.021], radii: [0.0097, 0.0088, 0.0079, 0.007] },
  { mcp: add(W, [0.082, -0.001, 0.0275]), spread: 0.2, lens: [0.035, 0.021, 0.019], radii: [0.0086, 0.0078, 0.0071, 0.0063] },
];
export const THUMB = {
  cmc: add(W, [0.016, -0.009, -0.019]),
  mcp: add(W, [0.05, -0.016, -0.045]),
  dirProx: norm([0.66, -0.1, -0.5]),
  dirDist: norm([0.8, -0.06, -0.34]),
  lens: [0.032, 0.028] as [number, number],
  radii: [0.0145, 0.0118, 0.0102, 0.0088],
  up: norm([0.12, 0.5, -0.86]),
};

export function buildArm(side: 1 | -1): LimbModel {
  const s = side;
  const m = (v: readonly number[]): V3 => [v[0], v[1], v[2] * s];
  const P: PartSpec[] = [];
  const cap = (bone: number, a: readonly number[], b: readonly number[], r1: number, r2: number, o: Partial<PartSpec> = {}) =>
    P.push({ ...o, bone, a: m(a), b: m(b), r1, r2, up: o.up ? m(o.up) : [0, 1, 0] });
  const ell = (bone: number, c: readonly number[], radii: readonly number[], o: Partial<PartSpec> = {}) =>
    P.push({ ...o, bone, kind: 1, a: m(c), b: o.b ? m(add(c, o.b)) : m(add(c, [1, 0, 0])), r1: radii[0], radii, up: o.up ? m(o.up) : [0, 1, 0] });

  const E: V3 = [ARM.upper, 0, 0];
  // Upper arm: shaft, deltoid cap, biceps (anterior = elbow-crease side, -Z), triceps (+Z).
  cap(0, [-0.03, 0, 0], E, 0.046, 0.037, { sigma: 0.035 });
  ell(0, [0.03, 0.012, 0.006], [0.085, 0.05, 0.052], { k: 0.03, sigma: 0.04 });
  ell(0, [0.165, -0.002, -0.017], [0.085, 0.034, 0.031], { k: 0.025, sigma: 0.035 });
  ell(0, [0.13, 0.004, 0.019], [0.105, 0.036, 0.033], { k: 0.025, sigma: 0.035 });
  // Forearm: two segments (the distal one carries half the pronation twist).
  const F1: V3 = [ARM.upper + 0.12, 0, 0];
  cap(1, E, F1, 0.037, 0.0305, { sy: 0.86, sz: 1.06, k: 0.018, sigma: 0.045 });
  cap(2, F1, W, 0.0305, 0.0205, { sy: 0.8, sz: 1.32, k: 0.012, sigma: 0.05 });
  // Olecranon, extensor/brachioradialis bulk (radial = thumb side = -Z), flexors, ulnar head.
  ell(1, add(E, [-0.004, 0.002, 0.021]), [0.024, 0.02, 0.016], { k: 0.016, sigma: 0.04 });
  ell(1, add(E, [0.075, 0.012, -0.013]), [0.09, 0.028, 0.032], { k: 0.022, sigma: 0.05 });
  ell(1, add(E, [0.07, -0.013, 0.008]), [0.095, 0.026, 0.03], { k: 0.022, sigma: 0.05 });
  ell(2, add(W, [-0.013, 0.01, 0.021]), [0.01, 0.007, 0.0075], { k: 0.007, sigma: 0.03 });
  ell(2, add(W, [-0.02, 0.006, -0.022]), [0.022, 0.009, 0.009], { k: 0.01, sigma: 0.03 });

  // Hand: wrist block, metacarpals, palm fullness, thenar/hypothenar, knuckle heads.
  cap(3, add(W, [-0.012, 0, 0]), add(W, [0.022, 0, 0]), 0.019, 0.019, { sy: 0.82, sz: 1.36, k: 0.012, sigma: 0.022 });
  for (let i = 0; i < 4; i++) {
    const f = FINGERS[i];
    const base = add(W, [0.012, 0.002, f.mcp[2] * 0.5]);
    cap(3, base, add(f.mcp, [-0.004, 0, 0]), 0.0122, 0.0114, { sy: 0.8, k: 0.013, sigma: 0.02 });
    ell(3, add(f.mcp, [-0.005, 0.0055, 0]), [0.0095, 0.0072, 0.0086], { k: 0.005, sigma: 0.02 });
  }
  ell(3, add(W, [0.052, -0.0065, 0.001]), [0.046, 0.0125, 0.034], { k: 0.012, sigma: 0.022 });
  ell(3, add(W, [0.026, -0.009, -0.022]), [0.031, 0.0145, 0.018], { k: 0.013, sigma: 0.022, b: [0.8, 0, -0.6] });
  ell(3, add(W, [0.04, -0.0065, 0.024]), [0.037, 0.011, 0.0125], { k: 0.011, sigma: 0.022 });

  // Fingers: three phalanges each, flattened sections, PIP knuckles, pads, nails.
  const bones: BoneDef[] = [
    { name: 'upper', head: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] },
    { name: 'fore1', head: E, x: [1, 0, 0], y: [0, 1, 0] },
    { name: 'fore2', head: F1, x: [1, 0, 0], y: [0, 1, 0] },
    { name: 'hand', head: W, x: [1, 0, 0], y: [0, 1, 0] },
  ];
  const creases: LimbModel['creases'] = [];
  for (let i = 0; i < 4; i++) {
    const f = FINGERS[i];
    const dir: V3 = [Math.cos(f.spread), -0.03, Math.sin(f.spread)];
    const d = norm(dir);
    const j0 = f.mcp;
    const j1 = add(j0, d, f.lens[0]);
    const j2 = add(j1, d, f.lens[1]);
    const tip = add(j2, d, f.lens[2]);
    const b0 = 4 + i * 3;
    const r = f.radii;
    cap(b0, j0, j1, r[0], r[1], { sy: 0.86, k: 0.0035, sigma: 0.009 });
    cap(b0 + 1, j1, j2, r[1] * 0.97, r[2], { sy: 0.87, k: 0.003, sigma: 0.007 });
    cap(b0 + 2, j2, add(tip, d, -r[3] * 0.6), r[2] * 0.97, r[3], { sy: 0.84, k: 0.003, sigma: 0.007 });
    // PIP and DIP knuckles (dorsal), finger pad (volar).
    ell(b0 + 1, add(j1, [0, r[1] * 0.3, 0]), [r[1] * 0.75, r[1] * 0.78, r[1] * 1.02], { k: 0.0028, sigma: 0.007 });
    ell(b0 + 2, add(j2, [0, r[2] * 0.25, 0]), [r[2] * 0.7, r[2] * 0.72, r[2] * 0.98], { k: 0.0024, sigma: 0.006 });
    ell(b0 + 2, add(add(j2, d, f.lens[2] * 0.55), [0, -r[3] * 0.25, 0]), [f.lens[2] * 0.42, r[3] * 0.72, r[3] * 1.02], { k: 0.0026, sigma: 0.006, b: d });
    // Nail plate: a thin shell on the distal dorsum.
    ell(b0 + 2, add(add(j2, d, f.lens[2] * 0.6), [0, r[3] * 0.62, 0]), [f.lens[2] * 0.36, r[3] * 0.36, r[3] * 0.8], { k: 0.0012, sigma: 0.006, mat: 1, b: d });
    bones.push({ name: `f${i}a`, head: m(j0), x: m(d), y: [0, 1, 0] });
    bones.push({ name: `f${i}b`, head: m(j1), x: m(d), y: [0, 1, 0] });
    bones.push({ name: `f${i}c`, head: m(j2), x: m(d), y: [0, 1, 0] });
    creases.push({ p: m(j1), axis: m(d), up: [0, 1, 0] }, { p: m(j2), axis: m(d), up: [0, 1, 0] }, { p: m(add(j0, d, -0.004)), axis: m(d), up: [0, 1, 0] });
  }
  // Thumb: metacarpal (inside the thenar), proximal, distal with pad and nail.
  const T = THUMB;
  const t0 = T.cmc;
  const t1 = T.mcp;
  const t2 = add(t1, T.dirProx, T.lens[0]);
  const t3 = add(t2, T.dirDist, T.lens[1]);
  const tr = T.radii;
  const tu = T.up;
  cap(16, t0, t1, tr[0], tr[1], { up: tu, sy: 0.9, k: 0.012, sigma: 0.014 });
  cap(17, t1, t2, tr[1], tr[2], { up: tu, sy: 0.86, k: 0.004, sigma: 0.01 });
  cap(18, t2, add(t3, T.dirDist, -tr[3] * 0.6), tr[2] * 0.98, tr[3], { up: tu, sy: 0.82, k: 0.003, sigma: 0.008 });
  ell(18, add(add(t2, T.dirDist, T.lens[1] * 0.55), tu, -tr[3] * 0.3), [T.lens[1] * 0.44, tr[3] * 0.72, tr[3] * 1.05], { up: tu, k: 0.003, sigma: 0.008, b: T.dirDist });
  ell(18, add(add(t2, T.dirDist, T.lens[1] * 0.6), tu, tr[3] * 0.62), [T.lens[1] * 0.36, tr[3] * 0.36, tr[3] * 0.82], { up: tu, k: 0.0012, sigma: 0.006, mat: 1, b: T.dirDist });
  bones.push({ name: 't0', head: m(t0), x: m(norm([t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2]])), y: m(tu) });
  bones.push({ name: 't1', head: m(t1), x: m(T.dirProx), y: m(tu) });
  bones.push({ name: 't2', head: m(t2), x: m(T.dirDist), y: m(tu) });
  creases.push({ p: m(t2), axis: m(T.dirDist), up: m(tu) });

  const cut = W[0] - 0.03;
  const zMin = s > 0 ? -0.085 : -0.075;
  const zMax = s > 0 ? 0.075 : 0.085;
  return {
    parts: P.map(makePart),
    bones,
    creases,
    jobs: [
      { min: [-0.12, -0.075, zMin], max: [cut + 0.016, 0.08, zMax], h: 0.0045, clip: { axis: 0, value: cut + 0.012, keep: -1, shrink: [0.018, 0.0007] } },
      { min: [cut - 0.004, -0.05, zMin], max: [W[0] + 0.205, 0.04, zMax], h: 0.002, clip: { axis: 0, value: cut, keep: 1 } },
    ],
    volarUp: (_x, _y, _z, out) => {
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
    },
  };
}

// ── Leg ────────────────────────────────────────────────────────────────────────────────

export const LEG = { thigh: 0.44, shin: 0.43, ankleH: 0.078 };
export const LEG_BONES = { pelvis: 0, thigh: 1, shin: 2, foot: 3, toes: 4, count: 5 };

export function buildLeg(side: 1 | -1): LimbModel {
  const s = side;
  const m = (v: readonly number[]): V3 => [v[0], v[1], v[2] * s];
  const P: PartSpec[] = [];
  const cap = (bone: number, a: readonly number[], b: readonly number[], r1: number, r2: number, o: Partial<PartSpec> = {}) =>
    P.push({ ...o, bone, a: m(a), b: m(b), r1, r2, up: o.up ? m(o.up) : [1, 0, 0] });
  const ell = (bone: number, c: readonly number[], radii: readonly number[], o: Partial<PartSpec> = {}) =>
    P.push({ ...o, bone, kind: 1, a: m(c), b: o.b ? m(add(c, o.b)) : m(add(c, [1, 0, 0])), r1: radii[0], radii, up: o.up ? m(o.up) : [0, 1, 0] });

  const K: V3 = [0, -LEG.thigh, 0];
  const A: V3 = [0, -LEG.thigh - LEG.shin, 0];
  // Thigh and knee (the shorts cover most of the thigh).
  cap(1, [0, 0.03, 0], K, 0.078, 0.05, { sigma: 0.06 });
  ell(1, add(K, [0.012, 0.16, 0]), [0.12, 0.05, 0.05], { b: [0, 1, 0], up: [1, 0, 0], k: 0.03, sigma: 0.06 });
  ell(2, add(K, [0.038, -0.004, 0]), [0.028, 0.026, 0.028], { b: [0, 1, 0], up: [1, 0, 0], k: 0.016, sigma: 0.05 });
  // Shin, calf, Achilles, ankle bones.
  cap(2, K, add(A, [0, 0.03, 0]), 0.047, 0.029, { sz: 1.05, k: 0.01, sigma: 0.06 });
  ell(2, add(K, [-0.028, -0.13, 0.004]), [0.11, 0.043, 0.045], { b: [0, 1, 0], up: [1, 0, 0], k: 0.035, sigma: 0.06 });
  ell(2, add(A, [-0.028, 0.07, 0]), [0.06, 0.012, 0.016], { b: [0, 1, 0], up: [1, 0, 0], k: 0.02, sigma: 0.05 });
  ell(2, add(A, [0.004, 0.004, -0.027]), [0.013, 0.014, 0.01], { k: 0.01, sigma: 0.03 });
  ell(2, add(A, [-0.008, -0.006, 0.027]), [0.012, 0.014, 0.01], { k: 0.01, sigma: 0.03 });

  // Foot: heel, body, instep, ball; a flat sole cut; the medial arch.
  const soleY = A[1] - LEG.ankleH;
  ell(3, add(A, [-0.046, -0.05, 0]), [0.04, 0.032, 0.031], { k: 0.02, sigma: 0.04 });
  cap(3, add(A, [-0.018, -0.036, 0]), add(A, [0.138, -0.057, -0.004]), 0.033, 0.024, { up: [0, 1, 0], sy: 0.72, sz: 1.5, k: 0.02, sigma: 0.04 });
  ell(3, add(A, [0.05, -0.022, -0.004]), [0.075, 0.03, 0.036], { k: 0.022, sigma: 0.04 });
  ell(3, add(A, [0.138, -0.058, -0.012]), [0.026, 0.017, 0.047], { k: 0.014, sigma: 0.03 });
  // Toes: big toe to little toe, gently curled down, nails on top.
  const toes: Array<[V3, number, number, number]> = [
    [add(A, [0.158, -0.06, -0.027]), 0.05, 0.0128, 0.0112],
    [add(A, [0.158, -0.065, -0.0045]), 0.041, 0.0086, 0.0072],
    [add(A, [0.152, -0.067, 0.0115]), 0.036, 0.0082, 0.0068],
    [add(A, [0.143, -0.068, 0.0255]), 0.031, 0.0077, 0.0064],
    [add(A, [0.127, -0.069, 0.0375]), 0.026, 0.0073, 0.006],
  ];
  for (let i = 0; i < toes.length; i++) {
    const [b, len, r1, r2] = toes[i];
    const d = norm([1, -0.12, i === 0 ? -0.05 : 0.03 * i]);
    const tip = add(b, d, len);
    cap(4, add(b, d, -0.012), tip, r1, r2, { up: [0, 1, 0], sy: 0.78, sz: 1.02, k: i === 0 ? 0.008 : 0.004, sigma: 0.012 });
    ell(4, add(add(tip, d, -len * 0.25), [0, r2 * 0.62, 0]), [len * (i === 0 ? 0.28 : 0.22), r2 * 0.34, r2 * 0.82], { b: d, k: 0.0012, sigma: 0.008, mat: 1 });
  }
  // Flat sole: cut everything below the sole plane with a soft edge.
  P.push({ bone: 3, kind: 1, a: m([0.05, soleY - 4, 0]), b: m([1.05, soleY - 4, 0]), r1: 4, radii: [4, 4, 4], op: 1, k: 0.012, up: [0, 1, 0] });
  // Medial arch.
  ell(3, add(A, [0.035, -0.084, -0.034]), [0.055, 0.014, 0.02], { op: 1, k: 0.012 });

  // Board shorts: loose tube down to 12 cm above the knee, with a rolled hem; hip half.
  cap(1, [0, 0.06, 0], add(K, [0.0, 0.13, 0]), 0.097, 0.077, { mat: 2, k: 0.0, sigma: 0.07 });
  ell(0, [-0.015, 0.075, -0.06], [0.13, 0.1, 0.12], { mat: 2, k: 0.04, sigma: 0.08 });

  const bones: BoneDef[] = [
    { name: 'pelvis', head: [0, 0.08, 0], x: [0, -1, 0], y: [1, 0, 0] },
    { name: 'thigh', head: [0, 0, 0], x: [0, -1, 0], y: [1, 0, 0] },
    { name: 'shin', head: K, x: [0, -1, 0], y: [1, 0, 0] },
    { name: 'foot', head: A, x: [1, 0, 0], y: [0, 1, 0] },
    { name: 'toes', head: add(A, [0.14, -0.062, 0]), x: [1, 0, 0], y: [0, 1, 0] },
  ].map((b) => ({ ...b, head: m(b.head), x: m(b.x), y: m(b.y) })) as BoneDef[];

  const cut = A[1] + 0.085;
  const zMin = s > 0 ? -0.2 : -0.14;
  const zMax = s > 0 ? 0.14 : 0.2;
  const fzMin = s > 0 ? -0.06 : -0.075;
  const fzMax = s > 0 ? 0.075 : 0.06;
  return {
    parts: P.map(makePart),
    bones,
    creases: toes.map(([b], i) => ({ p: m(add(b, [0.006 + (i === 0 ? 0.02 : 0.012), 0, 0])), axis: m([1, 0, 0]), up: [0, 1, 0] as V3 })),
    jobs: [
      { min: [-0.16, cut - 0.018, zMin], max: [0.16, 0.2, zMax], h: 0.0068, clip: { axis: 1, value: cut - 0.012, keep: 1, shrink: [0.02, 0.0009] } },
      { min: [-0.1, soleY - 0.01, fzMin], max: [0.225, cut + 0.004, fzMax], h: 0.0026, clip: { axis: 1, value: cut, keep: -1 } },
    ],
    volarUp: (_x, _y, _z, out) => {
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
    },
  };
}
