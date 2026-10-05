// The bird and its chase camera among towers (D1): random steering, dives and climbs into a grid of
// tall blocks for a minute. The camera never snaps round when the bird meets a wall (pure,
// synthetic world).

import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { R } from '../../world/config';
import { createFramePose } from '../rides/blend';
import type { RideEnv } from '../rides/rig';
import { BirdCam } from './cam';
import { BIRD, BirdFlight, type BirdEnv, type BirdInput } from './flight';

const GROUND = 2;
/** Blocks [x0, z0, x1, z1, top] in local metres (east x, north z) round (0, 0, R). */
const BLOCKS: number[][] = [];
for (let i = -3; i <= 3; i++)
  for (let j = -3; j <= 3; j++) {
    const top = GROUND + 14 + ((i * 7 + j * 13 + 21) % 5) * 5; // 14 … 34 m tall
    BLOCKS.push([i * 18 - 5, j * 18 - 5, i * 18 + 5, j * 18 + 5, top]);
  }

const toLocal = (d: Vector3) => ({ x: (d.x / d.z) * R, z: (d.y / d.z) * R });
const fromLocal = (x: number, z: number, out: Vector3) => out.set(x / R, z / R, 1).normalize();

function roofAt(x: number, z: number, pad = 0): number {
  let top = GROUND;
  for (const [x0, z0, x1, z1, h] of BLOCKS) if (x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad) top = Math.max(top, h);
  return top;
}

/** Push a disc out of every block taller than h it overlaps (nearest face). */
function wall(dir: Vector3, h: number, r: number, out: Vector3): boolean {
  let { x, z } = toLocal(dir);
  let moved = false;
  for (const [x0, z0, x1, z1, top] of BLOCKS) {
    if (top <= h - 0.3) continue;
    if (x <= x0 - r || x >= x1 + r || z <= z0 - r || z >= z1 + r) continue;
    const dl = x - (x0 - r);
    const dr = x1 + r - x;
    const dd = z - (z0 - r);
    const du = z1 + r - z;
    const m = Math.min(dl, dr, dd, du);
    if (m === dl) x = x0 - r;
    else if (m === dr) x = x1 + r;
    else if (m === dd) z = z0 - r;
    else z = z1 + r;
    moved = true;
  }
  if (moved) fromLocal(x, z, out);
  return moved;
}

const _f = new Vector3();
const birdEnv: BirdEnv = {
  floor: (d) => {
    const { x, z } = toLocal(d);
    return roofAt(x, z, 1);
  },
  hard: (d) => {
    const { x, z } = toLocal(d);
    return roofAt(x, z);
  },
  wall,
  ceiling: 98,
};
const camEnv: RideEnv = {
  floor: (d) => {
    const { x, z } = toLocal(d);
    return roofAt(x, z);
  },
  free: (a, b) => {
    const n = 16;
    for (let i = 1; i <= n; i++) {
      _f.lerpVectors(a, b, i / n);
      const h = _f.length() - R;
      const { x, z } = toLocal(_f.normalize());
      if (roofAt(x, z) > h - 0.4) return (i - 1) / n;
    }
    return 1;
  },
  wall,
  reduced: false,
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

describe('bird among towers', { timeout: 30_000 }, () => {
  it('a minute of random steering into the blocks: the camera turns smoothly, never snaps', () => {
    for (const seed of [3, 11, 29]) {
      const r = rng(seed);
      const b = new BirdFlight();
      b.reset(fromLocal(9, 9, new Vector3()).multiplyScalar(R + GROUND + 9), fromLocal(10, 9, new Vector3()).sub(fromLocal(9, 9, new Vector3())));
      const cam = new BirdCam();
      const o = createFramePose();
      cam.settle(b, camEnv, o);
      const inp: BirdInput = { steer: 0, climb: 0, flap: false, dive: false };
      const prevQ = new Quaternion().copy(o.quat);
      const prevP = o.pos.clone();
      const steps: number[] = [];
      let worstTurn = 0;
      let wallHits = 0;
      const dt = 1 / 60;
      for (let i = 0; i < 60 * 60; i++) {
        if (i % 30 === 0) {
          inp.steer = r() * 2 - 1;
          inp.climb = r() < 0.5 ? -1 : r() * 2 - 1; // mostly low, among the blocks
          inp.flap = r() < 0.2;
          inp.dive = r() < 0.1;
        }
        // (Out past the blocks it turns for home: the synthetic city is a flat patch round (0, 0, R).)
        const here = toLocal(b.pos.clone().normalize());
        const far = Math.hypot(here.x, here.z) > 50;
        let steer = inp.steer;
        if (far) {
          const up = b.pos.clone().normalize();
          const home = new Vector3(0, 0, 1).addScaledVector(up, -up.z).normalize();
          const right = new Vector3().crossVectors(b.fwd, up);
          steer = Math.max(-1, Math.min(1, home.dot(right) * 3 + (home.dot(b.fwd) < 0 ? 1 : 0)));
        }
        b.step(dt, { ...inp, steer }, birdEnv);
        if (b.floorBusy) wallHits++;
        cam.update(dt, b, camEnv, o);
        worstTurn = Math.max(worstTurn, prevQ.angleTo(o.quat));
        steps.push(o.pos.distanceTo(prevP));
        prevQ.copy(o.quat);
        prevP.copy(o.pos);
        expect(Number.isFinite(o.pos.x + o.quat.w)).toBe(true);
        // The bird itself stays out of the blocks.
        const { x, z } = toLocal(b.pos.clone().normalize());
        expect(b.pos.length() - R).toBeGreaterThan(roofAt(x, z, -BIRD.bodyR) - 0.05);
      }
      // It did meet the blocks (the test means something)…
      expect(wallHits).toBeGreaterThan(60);
      // …and the view never turned more than 4° in a frame (240°/s), nor stepped 3× its neighbours.
      expect(worstTurn).toBeLessThan((4 * Math.PI) / 180);
      for (let i = 1; i < steps.length - 1; i++) expect(steps[i]).toBeLessThan(3 * Math.max(steps[i - 1], steps[i + 1]) + 0.05);
    }
  });
});

/** One tall tower (x 0…20, z 0…20, 60 m), ground at 2 m. */
const TOWER = [0, 0, 20, 20, 62];
function towerRoof(x: number, z: number, pad = 0): number {
  const [x0, z0, x1, z1, h] = TOWER;
  return x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad ? h : GROUND;
}
function towerWall(dir: Vector3, h: number, r: number, out: Vector3): boolean {
  let { x, z } = toLocal(dir);
  const [x0, z0, x1, z1, top] = TOWER;
  if (top <= h - 0.3 || x <= x0 - r || x >= x1 + r || z <= z0 - r || z >= z1 + r) return false;
  const dl = x - (x0 - r);
  const dr = x1 + r - x;
  const dd = z - (z0 - r);
  const du = z1 + r - z;
  const m = Math.min(dl, dr, dd, du);
  if (m === dl) x = x0 - r;
  else if (m === dr) x = x1 + r;
  else if (m === dd) z = z0 - r;
  else z = z1 + r;
  fromLocal(x, z, out);
  return true;
}
const towerBird: BirdEnv = {
  floor: (d) => {
    const { x, z } = toLocal(d);
    return towerRoof(x, z, 1);
  },
  hard: (d) => {
    const { x, z } = toLocal(d);
    return towerRoof(x, z);
  },
  wall: towerWall,
  ceiling: 98,
};
const towerCam: RideEnv = {
  floor: (d) => {
    const { x, z } = toLocal(d);
    return towerRoof(x, z);
  },
  free: (a, b) => {
    const n = 16;
    for (let i = 1; i <= n; i++) {
      _f.lerpVectors(a, b, i / n);
      const h = _f.length() - R;
      const { x, z } = toLocal(_f.normalize());
      if (towerRoof(x, z) > h - 0.4) return (i - 1) / n;
    }
    return 1;
  },
  wall: towerWall,
  reduced: false,
};

describe('bird into a tower', { timeout: 30_000 }, () => {
  // Starts: [x, z, heading x, heading z, steer]: alongside it with the tower on the right, steering
  // into it; head-on at its face, steering into the corner and straight; under its corner.
  const starts = [
    [-6, -14, 0, 1, 1],
    [-6, -14, 0, 1, 0.6],
    [-22, 8, 1, 0, 1],
    [-22, 8, 1, 0, 0],
    [-22, 17, 1, 0.15, -1],
    [10, -24, 0.1, 1, 1],
  ];
  it('held low among the blocks, steering hard into them: in frame, never outrun, never whipped round', () => {
    const cam3 = new PerspectiveCamera(58, 1.6, 0.1, 2000);
    const report: string[] = [];
    for (const [sx, sz, steer, climb] of [
      [9, 9, 1, -1],
      [9, 9, -1, -1],
      [-9, 4, 1, -0.6],
      [27, -9, -1, -1],
      [0, 9, 0.7, -1],
    ]) {
      const b = new BirdFlight();
      b.reset(fromLocal(sx, sz, new Vector3()).multiplyScalar(R + GROUND + 8), fromLocal(sx + 1, sz + 0.3, new Vector3()).sub(fromLocal(sx, sz, new Vector3())));
      const cam = new BirdCam();
      const o = createFramePose();
      cam.settle(b, camEnv, o);
      const prevQ = new Quaternion().copy(o.quat);
      const prevP = o.pos.clone();
      const prevB = b.pos.clone();
      let worstNdc = 0;
      let worstTurn = 0;
      let worstRatio = 0;
      let hits = 0;
      const dt = 1 / 60;
      for (let i = 0; i < 60 * 6; i++) {
        b.step(dt, { steer: i % 180 < 120 ? steer : -steer, climb, flap: false, dive: false }, birdEnv);
        if (b.floorBusy) hits++;
        cam.update(dt, b, camEnv, o);
        cam3.position.copy(o.pos);
        cam3.quaternion.copy(o.quat);
        cam3.fov = o.fov;
        cam3.updateProjectionMatrix();
        cam3.updateMatrixWorld();
        const n = b.pos.clone().project(cam3);
        worstNdc = Math.max(worstNdc, Math.abs(n.x), Math.abs(n.y));
        worstTurn = Math.max(worstTurn, prevQ.angleTo(o.quat) / dt);
        worstRatio = Math.max(worstRatio, o.pos.distanceTo(prevP) / Math.max(b.pos.distanceTo(prevB), 4 * dt));
        prevQ.copy(o.quat);
        prevP.copy(o.pos);
        prevB.copy(b.pos);
      }
      report.push(`[${sx},${sz}] steer ${steer} climb ${climb}: hits ${hits} ndc ${worstNdc.toFixed(2)} ratio ${worstRatio.toFixed(2)} turn ${((worstTurn * 180) / Math.PI).toFixed(0)}°/s`);
    }
    for (const line of report) {
      const m = /ndc ([\d.]+) ratio ([\d.]+) turn (\d+)/.exec(line)!;
      expect(+m[1], line).toBeLessThan(0.8);
      expect(+m[2], line).toBeLessThan(2);
      expect(+m[3], line).toBeLessThan(120);
    }
  });

  it('3 s of steering into it: the bird stays well in frame, the camera never outruns it nor whips round', () => {
    const cam3 = new PerspectiveCamera(58, 1.6, 0.1, 2000);
    let hits = 0;
    const report: string[] = [];
    for (const [x, z, hx, hz, steer] of starts) {
      const b = new BirdFlight();
      const p0 = fromLocal(x, z, new Vector3()).multiplyScalar(R + GROUND + 10);
      const h0 = fromLocal(x + hx, z + hz, new Vector3()).sub(fromLocal(x, z, new Vector3()));
      b.reset(p0, h0);
      const cam = new BirdCam();
      const o = createFramePose();
      cam.settle(b, towerCam, o);
      const prevQ = new Quaternion().copy(o.quat);
      const prevP = o.pos.clone();
      const prevB = b.pos.clone();
      let worstNdc = 0;
      let worstTurn = 0;
      let worstRatio = 0;
      let wallHits = 0;
      let closest = 99;
      const dt = 1 / 60;
      for (let i = 0; i < 180; i++) {
        b.step(dt, { steer, climb: 0, flap: false, dive: false }, towerBird);
        if (b.floorBusy) wallHits++;
        cam.update(dt, b, towerCam, o);
        cam3.position.copy(o.pos);
        cam3.quaternion.copy(o.quat);
        cam3.fov = o.fov;
        cam3.updateProjectionMatrix();
        cam3.updateMatrixWorld();
        const n = b.pos.clone().project(cam3);
        worstNdc = Math.max(worstNdc, Math.abs(n.x), Math.abs(n.y));
        worstTurn = Math.max(worstTurn, prevQ.angleTo(o.quat) / dt);
        const vc = o.pos.distanceTo(prevP) / dt;
        const vb = b.pos.distanceTo(prevB) / dt;
        worstRatio = Math.max(worstRatio, vc / Math.max(vb, 4));
        prevQ.copy(o.quat);
        prevP.copy(o.pos);
        prevB.copy(b.pos);
        // Never inside it.
        const { x: bx, z: bz } = toLocal(b.pos.clone().normalize());
        closest = Math.min(closest, Math.hypot(Math.max(0 - bx, 0, bx - 20), Math.max(0 - bz, 0, bz - 20)));
        expect(b.pos.length() - R).toBeGreaterThan(towerRoof(bx, bz, -BIRD.bodyR) - 0.05);
      }
      hits += wallHits + (closest < 5 ? 100 : 0);
      report.push(`[${x},${z}] steer ${steer}: hits ${wallHits} ndc ${worstNdc.toFixed(2)} ratio ${worstRatio.toFixed(2)} turn ${((worstTurn * 180) / Math.PI).toFixed(0)}°/s`);
    }
    for (const line of report) {
      const m = /ndc ([\d.]+) ratio ([\d.]+) turn (\d+)/.exec(line)!;
      expect(+m[1], line).toBeLessThan(0.8);
      expect(+m[2], line).toBeLessThan(2);
      expect(+m[3], line).toBeLessThan(120);
    }
    // It did meet the tower, or pass within 5 m of it (the test means something).
    expect(hits).toBeGreaterThan(300);
  });
});
