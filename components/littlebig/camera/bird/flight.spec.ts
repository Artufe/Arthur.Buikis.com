// Bird flight (D1): the dynamics stay in bounds whatever the player does (pure, synthetic world).

import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { R } from '../../world/config';
import { BIRD, BirdFlight, type BirdEnv, type BirdInput } from './flight';

const DEG = Math.PI / 180;

/** Rolling hills (0–14 m), a 30 m tower block near (0, 0, R), a ceiling at 98 m. */
function world(): BirdEnv {
  const hill = (d: Vector3) => 7 + 7 * Math.sin(d.x * 9) * Math.cos(d.y * 7);
  const tower = (d: Vector3) => (Math.abs(d.x) < 0.06 && Math.abs(d.y) < 0.06 && d.z > 0 ? 30 : 0);
  return {
    floor: (d) => Math.max(hill(d), tower(d)) + 1,
    hard: (d) => Math.max(hill(d), tower(d)),
    ceiling: 98,
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

describe('bird flight', { timeout: 30_000 }, () => {
  it('stays between the floor and the ceiling, finite and in its speed range, under random input', () => {
    const env = world();
    const b = new BirdFlight();
    b.reset(new Vector3(0.3, 0.2, 1).normalize().multiplyScalar(R + 40), new Vector3(1, 0, 0));
    const r = rng(7);
    const inp: BirdInput = { steer: 0, climb: 0, flap: false, dive: false };
    const up = new Vector3();
    for (let i = 0; i < 60 * 240; i++) {
      if (i % 50 === 0) {
        inp.steer = r() * 2 - 1;
        inp.climb = r() * 2 - 1;
        inp.flap = r() < 0.3;
        inp.dive = r() < 0.15;
      }
      b.step(1 / 60, inp, env);
      up.copy(b.pos).normalize();
      const h = b.pos.length() - R;
      expect(h).toBeGreaterThanOrEqual(env.hard(up) + BIRD.hard - 1e-6);
      expect(h).toBeLessThanOrEqual(env.ceiling + 1e-6);
      expect(b.speed).toBeGreaterThanOrEqual(BIRD.min);
      expect(b.speed).toBeLessThanOrEqual(BIRD.max);
      expect(Math.abs(b.bank)).toBeLessThan(BIRD.bankMax + 5 * DEG);
      expect(Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.fwd.x + b.up.y)).toBe(true);
      expect(Math.abs(b.fwd.dot(up))).toBeLessThan(1e-6); // the heading stays tangent
    }
  });

  it('the soft floor does the work: a dive at the hills pulls up with (almost) no hard-floor hits', () => {
    const env = world();
    const b = new BirdFlight();
    b.reset(new Vector3(0.5, -0.3, 1).normalize().multiplyScalar(R + 60), new Vector3(0, 1, 0));
    const inp: BirdInput = { steer: 0.2, climb: -1, flap: false, dive: true };
    for (let i = 0; i < 60 * 30; i++) b.step(1 / 60, inp, env);
    // ~1800 frames diving at the ground: the look-ahead floor catches it nearly every time.
    expect(b.hardHits).toBeLessThan(40);
  });

  it('levels itself: no input → wings level, path level, back to cruising speed', () => {
    const env: BirdEnv = { floor: () => 0, hard: () => 0, ceiling: 98 };
    const b = new BirdFlight();
    b.reset(new Vector3(0, 0, R + 50), new Vector3(1, 0, 0));
    const turn: BirdInput = { steer: 1, climb: 1, flap: true, dive: false };
    for (let i = 0; i < 90; i++) b.step(1 / 60, turn, env);
    expect(b.bank).toBeGreaterThan(30 * DEG);
    expect(b.gamma).toBeGreaterThan(10 * DEG);
    const idle: BirdInput = { steer: 0, climb: 0, flap: false, dive: false };
    for (let i = 0; i < 60 * 12; i++) b.step(1 / 60, idle, env);
    expect(Math.abs(b.bank)).toBeLessThan(1 * DEG);
    expect(Math.abs(b.gamma)).toBeLessThan(1 * DEG);
    expect(b.speed).toBeCloseTo(BIRD.cruise, 0);
  });

  it('turns like a bird: a full hard turn takes a few seconds, the dive is fast, a climb slows it', () => {
    const env: BirdEnv = { floor: () => 0, hard: () => 0, ceiling: 98 };
    const b = new BirdFlight();
    b.reset(new Vector3(0, 0, R + 50), new Vector3(1, 0, 0));
    const f0 = b.fwd.clone();
    const hard: BirdInput = { steer: 1, climb: 0, flap: false, dive: false };
    let t = 0;
    let turned = 0;
    let prev = b.fwd.clone();
    while (turned < Math.PI * 2 && t < 20) {
      b.step(1 / 60, hard, env);
      turned += prev.angleTo(b.fwd);
      prev = b.fwd.clone();
      t += 1 / 60;
    }
    expect(t).toBeGreaterThan(3);
    expect(t).toBeLessThan(10);
    expect(f0.length()).toBeCloseTo(1, 6);
    // Turning right: right = fwd × up.
    b.reset(new Vector3(0, 0, R + 50), new Vector3(1, 0, 0));
    const right = new Vector3().crossVectors(b.fwd, new Vector3(0, 0, 1));
    for (let i = 0; i < 60; i++) b.step(1 / 60, hard, env);
    expect(b.fwd.dot(right)).toBeGreaterThan(0.2);
    // Dive: fast. Climb: slower than cruise.
    b.reset(new Vector3(0, 0, R + 90), new Vector3(1, 0, 0));
    for (let i = 0; i < 120; i++) b.step(1 / 60, { steer: 0, climb: 0, flap: false, dive: true }, env);
    expect(b.speed).toBeGreaterThan(22);
    b.reset(new Vector3(0, 0, R + 20), new Vector3(1, 0, 0));
    for (let i = 0; i < 120; i++) b.step(1 / 60, { steer: 0, climb: 1, flap: false, dive: false }, env);
    expect(b.speed).toBeLessThan(BIRD.cruise);
    expect(b.gamma).toBeGreaterThan(15 * DEG);
  });

  it('is frame-rate independent enough: 30 fps and 120 fps fly the same course', () => {
    const env: BirdEnv = { floor: () => 0, hard: () => 0, ceiling: 98 };
    const run = (fps: number) => {
      const b = new BirdFlight();
      b.reset(new Vector3(0, 0, R + 50), new Vector3(1, 0, 0));
      const inp: BirdInput = { steer: 0.6, climb: 0.3, flap: false, dive: false };
      for (let i = 0; i < fps * 4; i++) b.step(1 / fps, inp, env);
      return b.pos.clone();
    };
    // ~60 m flown with a turn and a climb: within 30 cm (sub-stepped at ≤ 1/60 s either way).
    expect(run(30).distanceTo(run(120))).toBeLessThan(0.3);
  });
});
