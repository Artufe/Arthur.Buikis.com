// The bird and its chase camera among towers (D1, v2-BF): flown at the blocks it crashes into them
// (nothing steers it off), bounces, tumbles and recovers (righted in the air, or down on the ground,
// dazed, then standing); through all of it the camera never whips
// round (it holds through the tumble and eases back behind), never goes inside a block or under the
// floor, and keeps the bird in frame (pure, synthetic world).

import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { R } from '../../world/config';
import { createFramePose } from '../rides/blend';
import type { RideEnv } from '../rides/rig';
import { BirdCam } from './cam';
import { BIRD, BirdFlight, type BirdEnv, type BirdInput } from './flight';

const DEG = Math.PI / 180;
const GROUND = 2;
/** Blocks [x0, z0, x1, z1, top] in local metres (east x, north z) round (0, 0, R). */
const BLOCKS: number[][] = [];
for (let i = -3; i <= 3; i++)
  for (let j = -3; j <= 3; j++) {
    const top = GROUND + 14 + ((i * 7 + j * 13 + 21) % 5) * 5; // 14 … 34 m tall
    BLOCKS.push([i * 18 - 5, j * 18 - 5, i * 18 + 5, j * 18 + 5, top]);
  }
/** One tall tower (x 0…20, z 0…20, 60 m). */
const TOWER: number[][] = [[0, 0, 20, 20, 62]];

const toLocal = (d: Vector3) => ({ x: (d.x / d.z) * R, z: (d.y / d.z) * R });
const fromLocal = (x: number, z: number, out = new Vector3()) => out.set(x / R, z / R, 1).normalize();

/** The highest top (m) over plan (x, z) among `blocks` (grown by pad), and the ground. */
function roofAt(blocks: number[][], x: number, z: number, pad = 0, below = Infinity): number {
  let top = GROUND;
  for (const [x0, z0, x1, z1, h] of blocks) if (h <= below && x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad) top = Math.max(top, h);
  return top;
}

/** Push a disc out of every block taller than h it overlaps (nearest face). */
function pushOut(blocks: number[][], dir: Vector3, h: number, r: number, out: Vector3): boolean {
  let { x, z } = toLocal(dir);
  let moved = false;
  for (const [x0, z0, x1, z1, top] of blocks) {
    if (top <= h) continue;
    if (x <= x0 - r || x >= x1 + r || z <= z0 - r || z >= z1 + r) continue;
    const m = Math.min(x - (x0 - r), x1 + r - x, z - (z0 - r), z1 + r - z);
    if (m === x - (x0 - r)) x = x0 - r;
    else if (m === x1 + r - x) x = x1 + r;
    else if (m === z - (z0 - r)) z = z0 - r;
    else z = z1 + r;
    moved = true;
  }
  if (moved) fromLocal(x, z, out);
  return moved;
}

const _f = new Vector3();
function envs(blocks: number[][]): { bird: BirdEnv; cam: RideEnv } {
  return {
    bird: {
      floor: (d, h) => {
        const { x, z } = toLocal(d);
        return roofAt(blocks, x, z, 0, h + BIRD.step);
      },
      wall: (d, h, r, out) => pushOut(blocks, d, h + BIRD.step, r, out),
      ceiling: 98,
    },
    cam: {
      floor: (d) => {
        const { x, z } = toLocal(d);
        return roofAt(blocks, x, z);
      },
      free: (a, b) => {
        const n = 16;
        for (let i = 1; i <= n; i++) {
          _f.lerpVectors(a, b, i / n);
          const h = _f.length() - R;
          const { x, z } = toLocal(_f.normalize());
          if (roofAt(blocks, x, z) > h - 0.4) return (i - 1) / n;
        }
        return 1;
      },
      wall: (d, h, r, out) => pushOut(blocks, d, h - 0.3, r, out),
      reduced: false,
    },
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Fly with the camera; the worst view turn per frame (rad), the bird's worst place in the frame, and checks on every frame. */
function chase(blocks: number[][], b: BirdFlight, input: (i: number, b: BirdFlight) => BirdInput, frames: number) {
  const { bird: be, cam: ce } = envs(blocks);
  const cam = new BirdCam();
  const o = createFramePose();
  cam.settle(b, ce, o);
  const lens = new PerspectiveCamera(58, 1.6, 0.05, 2000);
  const prevQ = new Quaternion().copy(o.quat);
  const prevP = o.pos.clone();
  const prevB = b.pos.clone();
  let worstTurn = 0;
  let worstCrashTurn = 0;
  let worstNdc = 0;
  let worstRatio = 0;
  let crashFrames = 0;
  let worstAt = '';
  let worstCrashJerk = 0;
  let prevTurn = 0;
  let jerkAt = '';
  let outFrames = 0;
  let ndcAt = '';
  const dt = 1 / 60;
  for (let i = 0; i < frames; i++) {
    b.step(dt, input(i, b), be);
    cam.update(dt, b, ce, o);
    expect(Number.isFinite(o.pos.x + o.quat.w)).toBe(true);
    const turn = prevQ.angleTo(o.quat);
    if (turn > worstTurn) worstAt = `frame ${i} crash ${b.crash.toFixed(2)} touching ${b.touching} v ${b.speed.toFixed(1)} γ ${(b.gamma / DEG).toFixed(0)} bank ${(b.bank / DEG).toFixed(0)} turn ${(b.turn / DEG).toFixed(0)} occ ${cam.occ.toFixed(2)} d ${o.pos.distanceTo(b.pos).toFixed(2)} alt ${(b.pos.length() - R).toFixed(1)}`;
    worstTurn = Math.max(worstTurn, turn);
    if (b.crash > 0) {
      crashFrames++;
      worstCrashTurn = Math.max(worstCrashTurn, turn);
      if (Math.abs(turn - prevTurn) > worstCrashJerk) jerkAt = `frame ${i} turn ${(prevTurn / DEG).toFixed(2)}→${(turn / DEG).toFixed(2)} crash ${b.crash.toFixed(2)} touching ${b.touching} bonks ${b.bonks} v ${b.speed.toFixed(1)} γ ${(b.gamma / DEG).toFixed(0)} occ ${cam.occ.toFixed(2)} d ${o.pos.distanceTo(b.pos).toFixed(2)} alt ${(b.pos.length() - R).toFixed(2)}`;
      worstCrashJerk = Math.max(worstCrashJerk, Math.abs(turn - prevTurn));
    }
    prevTurn = turn;
    lens.position.copy(o.pos);
    lens.quaternion.copy(o.quat);
    lens.fov = o.fov;
    lens.updateProjectionMatrix();
    lens.updateMatrixWorld();
    const n = b.pos.clone().project(lens);
    const nd = Math.max(Math.abs(n.x), Math.abs(n.y), n.z > 1 ? 9 : 0);
    if (nd > worstNdc) ndcAt = `frame ${i} ndc ${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(3)} crash ${b.crash.toFixed(2)} touching ${b.touching} v ${b.speed.toFixed(1)} γ ${(b.gamma / DEG).toFixed(0)} occ ${cam.occ.toFixed(2)} d ${o.pos.distanceTo(b.pos).toFixed(2)} turn ${(turn / DEG).toFixed(2)}`;
    worstNdc = Math.max(worstNdc, nd);
    if (nd > 1) outFrames++;
    worstRatio = Math.max(worstRatio, o.pos.distanceTo(prevP) / Math.max(b.pos.distanceTo(prevB), 4 * dt));
    // The bird: never inside a block nor under its roof; the camera: never inside a block, never under the floor.
    const bl = toLocal(b.pos.clone().normalize());
    expect(b.pos.length() - R).toBeGreaterThan(roofAt(blocks, bl.x, bl.z, -BIRD.bodyR + 0.02) - 0.05);
    const cl = toLocal(o.pos.clone().normalize());
    expect(o.pos.length() - R).toBeGreaterThan(roofAt(blocks, cl.x, cl.z, -0.05) - 0.01);
    prevQ.copy(o.quat);
    prevP.copy(o.pos);
    prevB.copy(b.pos);
  }
  return { worstTurn, worstCrashTurn, worstCrashJerk, worstNdc, worstRatio, crashFrames, worstAt, ndcAt, jerkAt, outFrames };
}

describe('bird among towers', { timeout: 30_000 }, () => {
  it('a minute of random flying at the blocks: it crashes and recovers, the camera never snaps', () => {
    let crashes = 0;
    for (const seed of [3, 11, 29]) {
      const r = rng(seed);
      const b = new BirdFlight();
      b.reset(fromLocal(9, 9).multiplyScalar(R + GROUND + 9), fromLocal(10, 9).sub(fromLocal(9, 9)));
      const inp: BirdInput = { steer: 0, climb: 0, flap: false, dive: false };
      const res = chase(BLOCKS, b, (i, bb) => {
        if (i % 30 === 0) {
          inp.steer = r() * 2 - 1;
          inp.climb = r() < 0.4 ? -1 : r() * 2 - 1;
          inp.flap = r() < 0.35;
          inp.dive = r() < 0.08;
        }
        // (Out past the blocks it turns for home: the synthetic city is a flat patch round (0, 0, R).)
        const up = bb.pos.clone().normalize();
        const here = toLocal(up);
        if (Math.hypot(here.x, here.z) > 50) {
          const home = new Vector3(0, 0, 1).addScaledVector(up, -up.z).normalize();
          const right = new Vector3().crossVectors(bb.fwd, up);
          return { ...inp, steer: Math.max(-1, Math.min(1, home.dot(right) * 3 + (home.dot(bb.fwd) < 0 ? 1 : 0))) };
        }
        return inp;
      }, 60 * 60);
      crashes += b.crashes;
      // The view never turned more than 4° in a frame (240°/s); through a crash its turn never jumped
      // by more than 2.5° from one frame to the next (in this dense grid a blocker may pull the boom
      // in to ~1 m mid-tumble, where keeping the bird in frame asks for a quick turn; the director's
      // turn follower eases that further).
      expect(res.worstTurn, `seed ${seed}: ${res.worstAt}`).toBeLessThanOrEqual(4 * DEG + 1e-9);
      expect(res.worstCrashJerk, `seed ${seed}: ${res.jerkAt}`).toBeLessThan(2.5 * DEG);
      // The bird in frame (its centre at most a frame's edge out, for a frame or two, mid-tumble at a
      // boom a blocker pulled in to ~0.9 m).
      expect(res.worstNdc, `seed ${seed}: ${res.ndcAt}`).toBeLessThan(1.15);
      expect(res.outFrames, `seed ${seed}`).toBeLessThanOrEqual(3);
    }
    // It did meet the blocks (the test means something).
    expect(crashes).toBeGreaterThan(2);
  });

  it('standing with a hedge behind it, the camera rises until it sees the bird over the hedge', () => {
    // A hedge 1.25 m tall, 0.6 m thick, 1.5 m behind a bird standing at (0, 0) facing +x.
    const HEDGE: number[][] = [[-2.1, -6, -1.5, 6, GROUND + 1.25]];
    const { cam: ce } = envs(HEDGE);
    const b = new BirdFlight();
    const p = fromLocal(0, 0);
    b.restore({ position: p.clone().multiplyScalar(R + GROUND + BIRD.belly).toArray(), heading: fromLocal(1, 0).sub(p).toArray(), speed: 0, gamma: 0, bank: 0, turn: 0, phase: 0, ground: true });
    const env: BirdEnv = { floor: () => GROUND, ceiling: 98 };
    const cam = new BirdCam();
    const o = createFramePose();
    cam.settle(b, ce, o);
    const lens = new PerspectiveCamera(58, 1.6, 0.05, 2000);
    for (let i = 0; i < 120; i++) {
      b.step(1 / 60, { steer: 0, climb: 0, flap: false, dive: false }, env);
      cam.update(1 / 60, b, ce, o);
    }
    expect(b.grounded).toBe(true);
    const up = b.pos.clone().normalize();
    const eye = b.pos.clone().addScaledVector(up, 0.25);
    // The sight line from the bird's head to the lens is clear, the lens over the hedge, the bird framed.
    expect(ce.free(eye, o.pos)).toBeGreaterThanOrEqual(0.999);
    expect(o.pos.length() - R).toBeGreaterThan(GROUND + 1.25);
    lens.position.copy(o.pos);
    lens.quaternion.copy(o.quat);
    lens.updateMatrixWorld();
    const n = b.pos.clone().project(lens);
    expect(Math.max(Math.abs(n.x), Math.abs(n.y))).toBeLessThan(0.8);
    expect(n.z).toBeLessThan(1);
  });

  it('flown into a tower face (head on, at angles, along it): bonks, recovers, the camera holds and eases back', () => {
    // [x, z, heading x, heading z, steer]: at its west face head on and 45° off, along its south face
    // steering into it, under its corner.
    const starts = [
      [-14, 10, 1, 0, 0],
      [-14, 2, 1, 1, 0],
      [-6, -6, 0, 1, 1],
      [10, -14, 0.3, 1, 0],
    ];
    const report: string[] = [];
    for (const [x, z, hx, hz, steer] of starts) {
      const b = new BirdFlight();
      b.reset(fromLocal(x, z).multiplyScalar(R + GROUND + 10), fromLocal(x + hx, z + hz).sub(fromLocal(x, z)));
      let crashAt = -1;
      let endAt = -1;
      let down = false;
      const res = chase(TOWER, b, (i, bb) => {
        if (bb.crashes > 0 && crashAt < 0) crashAt = i;
        if (crashAt >= 0 && endAt < 0 && bb.crash === 0) {
          endAt = i;
          down = bb.grounded;
        }
        // (Steering into it until it hits; hands off after.)
        return { steer: crashAt < 0 ? steer : 0, climb: 0, flap: false, dive: false };
      }, 60 * 8);
      const line = `[${x},${z}] crashes ${b.crashes} recovered ${((endAt - crashAt) / 60).toFixed(2)} s ${down ? 'standing' : 'flying'} ndc ${res.worstNdc.toFixed(2)} ratio ${res.worstRatio.toFixed(2)} turn ${(res.worstTurn / DEG * 60).toFixed(0)}°/s, in the crash ${(res.worstCrashTurn / DEG * 60).toFixed(0)}°/s, jerk ${(res.worstCrashJerk / DEG).toFixed(2)}° | worst framing: ${res.ndcAt} | worst turn: ${res.worstAt}`;
      report.push(line);
      expect(b.crashes, line).toBe(1);
      expect(endAt - crashAt, line).toBeGreaterThan(0);
      // Righted in the air: the tumble and the righting (~1.7 s). Too low for that, it falls, lands dazed
      // and stands (~2.4 s).
      expect((endAt - crashAt) / 60, line).toBeLessThan(down ? 2.8 : 2.2);
      expect(res.worstNdc, line).toBeLessThan(0.85);
      expect(res.worstRatio, line).toBeLessThan(2.5);
      expect(res.worstCrashTurn * 60, line).toBeLessThan(155 * DEG);
      expect(res.worstCrashJerk, line).toBeLessThan(0.5 * DEG);
      expect(res.worstTurn * 60, line).toBeLessThan(155 * DEG);
    }
  });
});
