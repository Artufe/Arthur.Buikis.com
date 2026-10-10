// The bird's pose (v2-BA) through a CPU twin of the vertex shader's skinning (mesh.ts birdPatch):
// the bounding sphere holds in every pose, the upstroke folds the wing, the head holds level.

import { describe, expect, it } from 'vitest';
import { ANKLE, BIRD_RADIUS, buildBirdGeometry, ELBOW, ELBOW_BAND, FEET, FOOT, HAND, HIP, NECK, SHOULDER, TAIL_PIVOT, WRIST, WRIST_BAND } from './mesh';
import { DOWNSTROKE, POSE_FLOATS, solvePose, type PoseInput } from './pose';

type V = [number, number, number];
const rx = (p: V, a: number): V => [p[0], Math.cos(a) * p[1] - Math.sin(a) * p[2], Math.sin(a) * p[1] + Math.cos(a) * p[2]];
const ry = (p: V, a: number): V => [Math.cos(a) * p[0] + Math.sin(a) * p[2], p[1], Math.cos(a) * p[2] - Math.sin(a) * p[0]];
const rz = (p: V, a: number): V => [Math.cos(a) * p[0] - Math.sin(a) * p[1], Math.sin(a) * p[0] + Math.cos(a) * p[1], p[2]];
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function joint(p: V, o: readonly number[], a: readonly number[], distal: boolean): V {
  let q = rx([p[0] - o[0], p[1] - o[1], p[2] - o[2]], a[0]);
  q = distal ? ry(rz(q, a[2]), a[1]) : rz(ry(q, a[1]), a[2]);
  return [q[0] + o[0], q[1] + o[1], q[2] + o[2]];
}
const scaled = (u: Float32Array, i: number, k: number) => [u[i] * k, u[i + 1] * k, u[i + 2] * k];

/** The shader's skinning of one vertex (the daze's items excluded: they set their own bound). */
function skin(p: V, bd: V, u: Float32Array): V | null {
  if (bd[0] !== 0) {
    const sd = bd[0] > 0 ? 1 : -1;
    const sp = Math.abs(bd[0]);
    const j = sd > 0 ? 0 : 12;
    const side = (v: readonly number[]) => [sd * v[0], v[1], v[2]];
    if (bd[1] !== 0) p = joint(p, side(HAND), [0, bd[1] * u[j + 11], 0], false);
    p = joint(p, side(WRIST), scaled(u, j + 8, smooth(WRIST_BAND[0], WRIST_BAND[1], sp)), true);
    p = joint(p, side(ELBOW), scaled(u, j + 4, smooth(ELBOW_BAND[0], ELBOW_BAND[1], sp)), true);
    const sh = side(SHOULDER);
    p = joint(p, sh, scaled(u, j, 1), false);
    const k = 1 - u[j + 3];
    p = [sh[0] + (p[0] - sh[0]) * u[j + 3] + sd * 0.155 * k, sh[1] + (p[1] - sh[1]) * u[j + 3] - 0.22 * k, sh[2] + (p[2] - sh[2]) * u[j + 3]];
  } else if (bd[2] < -1.5) {
    if (bd[2] < -3.5) p = joint(p, [0, FOOT[1], FOOT[2]], [u[31], 0, 0], false);
    if (bd[2] < -2.5) p = joint(p, [0, ANKLE[1], ANKLE[2]], [u[53], 0, 0], false);
    p = joint(p, [0, HIP[1], HIP[2]], [u[52], 0, 0], false);
  } else if (bd[2] < 0) {
    p = joint(p, TAIL_PIVOT, [0, bd[1] * u[27], 0], false);
    p = joint(p, TAIL_PIVOT, scaled(u, 24, 1), false);
  } else if (bd[2] >= 2) return null;
  else if (bd[2] > 0) {
    p = joint(p, NECK, scaled(u, 28, bd[2]), false);
    p = [p[0] + u[48] * bd[2], p[1] + u[49] * bd[2], p[2] + u[50] * bd[2]];
  }
  if (bd[2] > -1.5) p = joint(p, [0, HIP[1], HIP[2]], [u[54], 0, 0], false);
  return [p[0], p[1] + u[32] - u[55], p[2]];
}

const geo = buildBirdGeometry();
const pos = geo.getAttribute('position');
const bd = geo.getAttribute('aBd');
const u = new Float32Array(POSE_FLOATS);
const base: PoseInput = { phase: 0, amp: 0, tuck: 0, spread: 0, turn: 0, speed: 7, crash: 0, stand: 0, legs: 0, hop: 0 };

function each(fn: (p: V, bd: V) => void, from = 0.0) {
  for (let i = 0; i < pos.count; i++) {
    if (from > 0 && Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)) < from) continue;
    const b: V = [bd.getX(i), bd.getY(i), bd.getZ(i)];
    const p = skin([pos.getX(i), pos.getY(i), pos.getZ(i)], b, u);
    if (p) fn(p, b);
  }
}
/** The left wing's reach from its shoulder (m, model units). */
function reach(): number {
  let r = 0;
  each((p, b) => {
    if (b[0] > 0) r = Math.max(r, Math.hypot(p[0] - SHOULDER[0], p[1] - SHOULDER[1], p[2] - SHOULDER[2]));
  });
  return r;
}

describe('bird pose', () => {
  it('stays inside the bounding sphere in every pose', () => {
    // (Only vertices that can get there: within 0.4 of the centre at rest, the pivots and the bob
    // keep a vertex inside ~0.8.)
    let worst = 0;
    for (let ph = 0; ph < 16; ph++) {
      for (const amp of [0, 1]) {
        for (const [tuck, spread, turn, speed] of [[0, 0, 0, 7], [1, 0, 0, 20], [0, 1, 0, 4], [0, 0, 1, 8], [0, 0, -1, 12], [0.5, 0.5, 0.5, 6]]) {
          for (const [crash, clock] of [[0, 0], [1, 0.3], [0.6, 1.7]]) {
            solvePose(u, { ...base, phase: (ph / 24) * 2 * Math.PI, amp, tuck, spread, turn, speed, crash, legs: ph % 2 }, clock, 0.5, -0.4);
            each((p) => {
              worst = Math.max(worst, Math.hypot(p[0], p[1], p[2]));
            }, 0.4);
          }
        }
      }
    }
    // On the ground: standing, a hop's every stage, the take-off (amp rising as stand falls).
    for (let i = 0; i <= 20; i++) {
      for (const [stand, amp] of [[1, 0], [0.5, 0.5], [0.15, 1]]) {
        solvePose(u, { ...base, stand, amp, legs: 1, hop: i / 20, phase: i }, i * 0.37, 0, 0);
        each((p) => {
          worst = Math.max(worst, Math.hypot(p[0], p[1], p[2]));
        }, 0.3);
      }
    }
    expect(worst).toBeGreaterThan(0.85);
    expect(worst).toBeLessThan(BIRD_RADIUS);
  }, 30_000);

  it('folds the wing on the upstroke: span about 40 % shorter than on the downstroke', () => {
    solvePose(u, { ...base, amp: 1, phase: Math.PI * DOWNSTROKE }, 0, 0, 0); // mid-downstroke
    const open = reach();
    let folded = Infinity;
    for (let i = 0; i <= 20; i++) {
      const w = DOWNSTROKE + ((1 - DOWNSTROKE) * i) / 20;
      solvePose(u, { ...base, amp: 1, phase: 2 * Math.PI * w }, 0, 0, 0);
      folded = Math.min(folded, reach());
    }
    expect(1 - folded / open).toBeGreaterThan(0.35);
    expect(1 - folded / open).toBeLessThan(0.45);
  });

  it('standing, keeps its feet on the floor through breathing and a hop\'s crouch and landing', () => {
    for (const [hop, clock] of [[0, 0], [0, 1.2], [0.2, 0], [0.3, 0], [0.9, 0]]) {
      solvePose(u, { ...base, stand: 1, legs: 1, hop }, clock, 0, 0);
      let low = Infinity;
      each((p, b) => {
        if (b[2] < -2.5) low = Math.min(low, p[1]);
      });
      expect(low, `hop ${hop}`).toBeGreaterThan(-FEET - 0.012);
      expect(low, `hop ${hop}`).toBeLessThan(-FEET + 0.012);
    }
  });

  it('holds the head level against the body pitch, and lets go in a crash', () => {
    solvePose(u, base, 0, 0.3, 0);
    expect(u[28]).toBeCloseTo(0.85 * 0.3, 5);
    solvePose(u, { ...base, crash: 1 }, 0, 0.3, 0);
    expect(Math.abs(u[28])).toBeLessThan(0.05);
  });
});
