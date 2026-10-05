// Enter paths (D1): the planned way into a ride, against a synthetic world of blocks (pure).

import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { R } from '../../world/config';
import { CLOUD_HI, CLOUD_LO, EnterPath, heightCurve, pathWeight, type PathEnv } from './path';

/** Local metres (east x, north z) round the point (0, 0, R) to a unit direction, and back. */
const dirAt = (x: number, z: number) => new Vector3(x / R, z / R, 1).normalize();
const at = (x: number, z: number, h: number) => dirAt(x, z).multiplyScalar(R + h);
const local = (p: Vector3) => {
  const d = p.clone().normalize();
  return { x: (d.x / d.z) * R, z: (d.y / d.z) * R, h: p.length() - R };
};

/** Boxes [x0, z0, x1, z1, height]: what stands within r of a point, + the director's margins. */
function blocks(list: number[][]): PathEnv & { roofNear: (x: number, z: number, r: number) => number } {
  const roofNear = (x: number, z: number, r: number) => {
    let top = 0;
    for (const [x0, z0, x1, z1, h] of list) {
      const dx = Math.max(x0 - x, 0, x - x1);
      const dz = Math.max(z0 - z, 0, z - z1);
      if (dx * dx + dz * dz <= r * r) top = Math.max(top, h);
    }
    return top;
  };
  return {
    roofNear,
    clear: (d, r) => {
      const x = (d.x / d.z) * R;
      const z = (d.y / d.z) * R;
      const roof = roofNear(x, z, Math.max(0.01, r));
      return Math.max(1.2, roof > 0 ? roof + 3.5 : 0);
    },
  };
}

/** Walk the path on the smootherstep clock at 60 fps over `dur` s: positions per frame. */
function fly(p: EnterPath, dur: number): Vector3[] {
  const out: Vector3[] = [];
  const n = Math.round(dur * 60);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const e = t * t * t * (t * (t * 6 - 15) + 10);
    out.push(p.at(e, new Vector3()));
  }
  return out;
}

describe('enter paths', { timeout: 30_000 }, () => {
  it('lands exactly on both ends', () => {
    const env = blocks([]);
    const S = at(0, 0, 3);
    const T = at(40, 10, 3.5);
    const Q = at(36, 9, 5);
    const p = new EnterPath().plan(S, Q, T, env);
    expect(p.at(0, new Vector3()).distanceTo(S)).toBeLessThan(1e-6);
    expect(p.at(1, new Vector3()).distanceTo(T)).toBeLessThan(1e-6);
    expect(p.eQ).toBeGreaterThan(0.5);
    expect(p.eQ).toBeLessThan(1);
  });

  it('from a street beside a 20 m block, rises straight up past it before it travels', () => {
    // The block's face 0.8 m east of the start; the target down the street 70 m north, past another.
    const env = blocks([
      [0.8, -10, 14, 12, 20],
      [-14, 30, -2, 44, 16],
    ]);
    const S = at(0, 0, 3.7);
    const T = at(0, 70, 3.7);
    const Q = at(0, 64, 4.5);
    const p = new EnterPath().plan(S, Q, T, env);
    expect(p.popUp).toBeGreaterThan(18);
    for (const q of fly(p, 2)) {
      const l = local(q);
      // Below the block's roof (+ margin) it stays within a hair of the start horizontally.
      if (l.h < 22 && l.z < 2) expect(Math.hypot(l.x, l.z)).toBeLessThan(0.6);
    }
  });

  it('keeps 4 m from what it passes (roofs + 3.5 m), away from its ends', () => {
    const env = blocks([
      [10, -6, 22, 6, 14],
      [34, -8, 44, 2, 9],
    ]);
    const S = at(0, 0, 5);
    const T = at(60, 0, 5);
    const Q = at(54, 0, 6);
    const p = new EnterPath().plan(S, Q, T, env);
    for (const q of fly(p, 2)) {
      const l = local(q);
      if (Math.hypot(l.x, l.z) < 6 || Math.hypot(l.x - 54, l.z) < 6) continue;
      const roof = env.roofNear(l.x, l.z, 4);
      if (roof > 0) expect(l.h).toBeGreaterThan(roof + 2.5);
    }
  });

  it('goes round a lone tower rather than over it, between two low ends', () => {
    const env = blocks([[18, -5, 28, 5, 40]]);
    const S = at(0, 0, 4);
    const T = at(46, 0, 4);
    const Q = at(40, 0, 5);
    const p = new EnterPath().plan(S, Q, T, env);
    expect(Math.abs(p.bulge)).toBeGreaterThan(5);
    // Never up into the cloud layer for a hop across the street.
    expect(p.peak).toBeLessThan(CLOUD_LO - 3);
  });

  it('moves on one smooth speed curve: no jolts frame to frame', () => {
    for (const [S, Q, T] of [
      [at(0, 0, 3.7), at(120, 260, 200), at(125, 270, 190)], // street → up to space
      [at(0, 0, 380), at(80, 40, 22), at(88, 44, 6)], // orbit → onto a car
      [at(0, 0, 6), at(30, 4, 8), at(36, 5, 6)], // the next car along
    ]) {
      const env = blocks([[6, -8, 16, 8, 12]]);
      const p = new EnterPath().plan(S, Q, T, env);
      const pts = fly(p, 2.4);
      const v = pts.slice(1).map((q, i) => q.distanceTo(pts[i]));
      // Speed changes by < 20 % from one frame to the next (+2 cm: the last frames settling; +0.05 %
      // of the height: from orbit it sets off at once, which reads as a gentle start up there) — an
      // eased bell, no kick or stall.
      for (let i = 1; i < v.length; i++) expect(Math.abs(v[i] - v[i - 1])).toBeLessThan(0.2 * Math.max(v[i], v[i - 1]) + 0.02 + 0.0005 * (pts[i].length() - R));
    }
  });

  it('slows through the cloud band, speeds up high and away from both ends', () => {
    const mid = (CLOUD_LO + CLOUD_HI) / 2;
    expect(pathWeight(mid)).toBeGreaterThan(pathWeight(CLOUD_LO - 14) * 0.9);
    expect(pathWeight(mid)).toBeGreaterThan(pathWeight(CLOUD_HI + 14) * 1.5);
    expect(pathWeight(200)).toBeLessThan(pathWeight(5) / 2);
    // Near an end, the distance to it rules: the last metres onto a satellite settle.
    expect(pathWeight(200, 2)).toBeGreaterThan(pathWeight(200, 100) * 2);
    // Climbs rise early, descents drop late.
    expect(heightCurve(0.2, 1)).toBeGreaterThan(0.35);
    expect(heightCurve(0.8, -1)).toBeLessThan(0.65);
  });

  it('can spend longer before the cloud band without a speed step', () => {
    const env = blocks([]);
    const S = at(0, 0, 4);
    const T = at(200, 200, 220);
    const Q = at(190, 190, 240);
    const p = new EnterPath().plan(S, Q, T, env);
    expect(p.crosses).toBe(true);
    const e0 = p.eCross;
    p.delayCross(Math.min(0.5, e0 + 0.15));
    expect(p.eCross).toBeGreaterThan(e0 + 0.05);
    const pts = fly(p, 2.6);
    const v = pts.slice(1).map((q, i) => q.distanceTo(pts[i]));
    for (let i = 1; i < v.length; i++) expect(Math.abs(v[i] - v[i - 1])).toBeLessThan(0.2 * Math.max(v[i], v[i - 1]) + 0.02);
  });
});
