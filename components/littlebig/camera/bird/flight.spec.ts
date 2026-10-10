// Bird flight (v2-BF): a point-mass glider. Hands off it glides down and settles (never pitching up,
// never porpoising), and near the ground it flares, lowers its legs, lands and stands (floats on water);
// standing, A / D turn it on the spot and W or Space take off up a sustainable climb, handed over at trim
// speed. W climbs flapping, slower; a pull too slow stalls and recovers; the beats hold height; the
// stoop is fast and a pull out of it swoops up; a hard hit is a crash that bounces, tumbles, and then
// rights itself high up or falls and lands dazed low down. Frame-rate independent, bounded under
// random input (pure, synthetic world).

import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { R } from '../../world/config';
import { BIRD, BirdFlight, type BirdEnv, type BirdInput } from './flight';

const DEG = Math.PI / 180;
/** The trim glide's path angle (L/D at trim: flight.ts GLIDE). */
const GLIDE = -Math.atan(0.13);
const C_MAX = (BIRD.trim / BIRD.stall) ** 2;

const I = (o: Partial<BirdInput> = {}): BirdInput => ({ steer: 0, climb: 0, flap: false, dive: false, ...o });
const flat = (g = 0, ceiling = 400): BirdEnv => ({ floor: () => g, ceiling });

/** Local metres (east x, north z) round (0, 0, R). */
const toLocal = (d: Vector3) => ({ x: (d.x / d.z) * R, z: (d.y / d.z) * R });
const fromLocal = (x: number, z: number, out = new Vector3()) => out.set(x / R, z / R, 1).normalize();

/** A box [x0, z0, x1, z1, top] as a solid: a floor once the body is over its top, a wall beside it. */
function boxWorld(boxes: number[][], ground: (d: Vector3) => number, ceiling = 400): BirdEnv {
  return {
    floor: (d, h) => {
      let f = ground(d);
      const { x, z } = toLocal(d);
      for (const [x0, z0, x1, z1, top] of boxes) if (top <= h + BIRD.step && x > x0 && x < x1 && z > z0 && z < z1) f = Math.max(f, top);
      return f;
    },
    wall: (d, h, r, out) => {
      let { x, z } = toLocal(d);
      let moved = false;
      for (const [x0, z0, x1, z1, top] of boxes) {
        if (top <= h + BIRD.step) continue;
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
    },
    ceiling,
  };
}

/** Rolling hills (0–14 m). */
const hill = (d: Vector3) => 7 + 7 * Math.sin(d.x * 9) * Math.cos(d.y * 7);

function bird(x = 0, z = 0, alt = 120, v: number = BIRD.trim, hx = 1, hz = 0): BirdFlight {
  const b = new BirdFlight();
  const p = fromLocal(x, z);
  b.reset(p.clone().multiplyScalar(R + alt), fromLocal(x + hx, z + hz).sub(p), v);
  return b;
}

function fly(b: BirdFlight, inp: BirdInput, secs: number, env: BirdEnv, each?: (t: number) => void, fps = 60) {
  const n = Math.round(secs * fps);
  for (let i = 0; i < n; i++) {
    b.step(1 / fps, inp, env);
    each?.((i + 1) / fps);
  }
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

describe('bird flight', { timeout: 30_000 }, () => {
  it('no input glides down at the trim angle and speed: never pitching up, never porpoising', () => {
    const env = flat();
    // [what it was doing, the input held first, for how long]
    const starts: Array<[string, BirdInput, number]> = [
      ['level at trim', I(), 0],
      ['a W climb', I({ climb: 1 }), 6],
      ['an S dive', I({ climb: -1 }), 6],
      ['a stoop', I({ dive: true }), 4],
      ['a hard turn', I({ steer: 1 }), 3],
    ];
    for (const [name, first, secs] of starts) {
      const b = bird(0, 0, 220);
      fly(b, first, secs, env);
      const g0 = b.gamma;
      let gMax = -Infinity;
      let lo = Infinity;
      let hi = -Infinity;
      fly(b, I(), 20, env, (t) => {
        // (After the first half second: a climb let go of may still be easing over.)
        if (t > 0.5) gMax = Math.max(gMax, b.gamma);
        if (t > 9) {
          lo = Math.min(lo, b.gamma);
          hi = Math.max(hi, b.gamma);
        }
      });
      // Let go, the path never rises over where it was or over the glide's line.
      expect(gMax, name).toBeLessThanOrEqual(Math.max(g0, GLIDE) + 0.5 * DEG);
      // Settled on the trim glide: ~7.4° down at ~7 m/s, wings level, not beating, and steady.
      expect(b.gamma, name).toBeGreaterThan(-8.2 * DEG);
      expect(b.gamma, name).toBeLessThan(-6.5 * DEG);
      expect(Math.abs(b.speed - BIRD.trim), name).toBeLessThan(0.5);
      expect(Math.abs(b.bank), name).toBeLessThan(0.5 * DEG);
      expect(b.flapAmp, name).toBe(0);
      expect(hi - lo, `${name}: porpoising`).toBeLessThan(0.4 * DEG);
    }
  });

  it('a held climb flaps and climbs, slower than the glide', () => {
    const env = flat();
    const b = bird(0, 0, 30);
    fly(b, I(), 4, env);
    const p0 = b.flapPhase;
    fly(b, I({ climb: 1 }), 8, env);
    const h0 = b.alt;
    let ampMin = 1;
    fly(b, I({ climb: 1 }), 4, env, () => (ampMin = Math.min(ampMin, b.flapAmp)));
    const rate = (b.alt - h0) / 4;
    expect(ampMin).toBeGreaterThan(0.8);
    // ≥ 3 beats a second.
    expect((b.flapPhase - p0) / (2 * Math.PI)).toBeGreaterThan(3 * 12);
    expect(rate).toBeGreaterThan(1.2);
    expect(rate).toBeLessThan(3);
    expect(b.gamma).toBeGreaterThan(10 * DEG);
    expect(b.gamma).toBeLessThan(30 * DEG);
    expect(b.speed).toBeGreaterThan(5);
    expect(b.speed).toBeLessThan(6.5);
    // A gentle climb input climbs less.
    const c = bird(0, 0, 30);
    fly(c, I({ climb: 0.4 }), 12, env);
    const h1 = c.alt;
    fly(c, I({ climb: 0.4 }), 4, env);
    expect((c.alt - h1) / 4).toBeLessThan(rate);
  });

  it('a sustained pull without flapping stalls: the lift saturates, the path and the nose drop, it recovers', () => {
    // At the ceiling the beats fade out: W only pulls. Too slow to hold its path at the wings' most lift.
    const env = flat(0, 60);
    const b = bird(0, 0, 58, 3);
    let stall = 0;
    let lift = 0;
    let gMin = Infinity;
    let nose = Infinity;
    let amp = 0;
    fly(b, I({ climb: 1 }), 6, env, () => {
      stall = Math.max(stall, b.stall);
      lift = Math.max(lift, b.lift);
      gMin = Math.min(gMin, b.gamma);
      nose = Math.min(nose, b.gamma + b.alpha);
      amp = Math.max(amp, b.flapAmp);
      expect(Math.abs(b.bank)).toBeLessThan(0.5 * DEG); // no spin
      expect(Number.isFinite(b.pos.x + b.speed + b.gamma)).toBe(true);
    });
    expect(amp).toBeLessThan(0.3);
    expect(stall).toBeGreaterThan(0.5);
    expect(lift).toBeLessThanOrEqual(C_MAX + 1e-9);
    expect(gMin).toBeLessThan(-15 * DEG);
    expect(nose).toBeLessThan(-10 * DEG);
    // Recovered: the speed back, no longer stalled, flying (W held: about level).
    expect(b.stall).toBe(0);
    expect(b.speed).toBeGreaterThan(BIRD.stall * 1.15);
    expect(b.gamma).toBeGreaterThan(-5 * DEG);
  });

  it('flapping holds or gains height: Space held climbs, one press is one beat', () => {
    const env = flat();
    const b = bird(0, 0, 30);
    fly(b, I(), 4, env);
    const h0 = b.alt;
    fly(b, I({ flap: true }), 6, env);
    expect(b.alt - h0).toBeGreaterThan(8);
    // One press (held for a 0.2 s tap): one beat, then a glide; higher than not beating at all.
    const a = bird(0, 0, 30);
    const c = bird(0, 0, 30);
    fly(a, I(), 4, env);
    fly(c, I(), 4, env);
    const n0 = c.beatCount;
    fly(a, I(), 2.5, env);
    fly(c, I({ flap: true }), 0.2, env);
    fly(c, I(), 2.3, env);
    expect(c.beatCount - n0).toBe(1);
    expect(c.flapAmp).toBe(0);
    // Held, it beats on (~4 a second).
    const n1 = c.beatCount;
    fly(c, I({ flap: true }), 2, env);
    expect(c.beatCount - n1).toBeGreaterThanOrEqual(7);
    expect(c.alt - a.alt).toBeGreaterThan(0.4);
  });

  it('a stoop is fast and steep; pulling out swoops up, letting go levels onto the glide', () => {
    const env = flat();
    const b = bird(0, 0, 220);
    let top = 0;
    fly(b, I({ dive: true }), 5, env, () => (top = Math.max(top, b.speed)));
    expect(top).toBeGreaterThan(18);
    expect(top).toBeLessThan(22);
    expect(b.gamma).toBeLessThan(-55 * DEG);
    expect(b.tuck).toBeGreaterThan(0.95);
    const snap = b.snapshot();
    // Pull out (W): the speed turned into height.
    let low = Infinity;
    let high = -Infinity;
    fly(b, I({ climb: 1 }), 6, env, () => {
      if (b.alt < low) {
        low = b.alt;
        high = -Infinity;
      }
      high = Math.max(high, b.alt);
    });
    expect(high - low).toBeGreaterThan(10);
    // Let go instead: it pulls out onto the glide and spills the speed, never climbing.
    const c = new BirdFlight();
    c.restore(snap);
    c.tuck = 1;
    let gMax = -Infinity;
    fly(c, I(), 8, env, () => (gMax = Math.max(gMax, c.gamma)));
    expect(gMax).toBeLessThanOrEqual(GLIDE + 1 * DEG);
    expect(c.speed).toBeLessThan(9);
  });

  it('turns from its bank: hard over it carves and sinks more; let go, the wings level', () => {
    const env = flat();
    const b = bird(0, 0, 150);
    fly(b, I(), 5, env);
    const sink0 = b.speed * Math.sin(-b.gamma);
    const right = new Vector3().crossVectors(b.fwd, b.pos.clone().normalize());
    fly(b, I({ steer: 1 }), 0.4, env);
    // Steer right turns right (right = fwd × up).
    expect(b.fwd.dot(right)).toBeGreaterThan(0.05);
    fly(b, I({ steer: 1 }), 1.6, env);
    const f0 = b.fwd.clone();
    const h0 = b.alt;
    let turned = 0;
    const prev = b.fwd.clone();
    fly(b, I({ steer: 1 }), 2, env, () => {
      turned += prev.angleTo(b.fwd);
      prev.copy(b.fwd);
    });
    const rate = turned / 2;
    expect(b.bank).toBeGreaterThan(BIRD.bankMax - 2 * DEG);
    expect(rate).toBeGreaterThan(50 * DEG);
    expect(rate).toBeLessThan(110 * DEG);
    expect(b.fwd.dot(f0)).toBeLessThan(0.5);
    // It sank faster than the straight glide.
    expect((h0 - b.alt) / 2).toBeGreaterThan(sink0 * 1.2);
    // Let go: wings level within ~1 s.
    fly(b, I(), 1, env);
    expect(Math.abs(b.bank)).toBeLessThan(1 * DEG);
  });

  it('a steep dive into the ground crashes, bounces, falls and lands dazed, then stands until W: never under the floor', () => {
    const env: BirdEnv = { floor: (d) => hill(d), ceiling: 400 };
    // [x, z, start height (m), held]: stoops into the hills.
    for (const [x, z, alt, inp] of [[20, 10, 60, I({ dive: true })], [-30, 40, 60, I({ dive: true, steer: 0.4 })], [5, -25, 40, I({ dive: true, steer: -0.3 })]] as const) {
      const at = `[${x},${z}]`;
      const b = bird(x, z, alt, 8);
      const up = new Vector3();
      const bodyUp = new Vector3();
      let crashAt = -1;
      let endAt = -1;
      let tumbled = false;
      let upright = 0;
      const held = { ...inp };
      fly(b, held, 10, env, (t) => {
        up.copy(b.pos).normalize();
        // Down and standing (or getting up), the body is upright: nothing of the tumble, the fall or
        // the bounce is left in its attitude (the drawn pose adds its own nose-up tilt).
        if (b.grounded && b.stand > 0.9) {
          bodyUp.set(0, 1, 0).applyQuaternion(b.quat);
          expect(bodyUp.angleTo(up), at).toBeLessThan(30 * DEG);
          upright++;
        }
        expect(b.alt).toBeGreaterThanOrEqual(hill(up) + (b.onWater ? 0 : BIRD.belly) - 1e-6);
        expect(Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.speed + b.gamma + b.quat.w)).toBe(true);
        if (b.crashes > 0 && crashAt < 0) {
          crashAt = t;
          // (The player lets go once it has hit.)
          Object.assign(held, I());
        }
        if (b.crash === 1) tumbled = true;
        if (crashAt >= 0 && endAt < 0 && b.crash === 0) {
          endAt = t;
          // Over: down on the ground, standing (too low to right itself in the air).
          expect(b.grounded, at).toBe(true);
          expect(b.stand, at).toBeGreaterThan(0.9);
        }
        // One bonk: the bounce, the tumble and the fall land it in no second crash.
        if (crashAt >= 0) expect(b.crashes, at).toBe(1);
      });
      expect(crashAt, at).toBeGreaterThan(0);
      expect(tumbled, at).toBe(true);
      expect(b.landings, at).toBe(1);
      expect(upright, at).toBeGreaterThan(60);
      // The tumble (~0.9 s), the fall (its bounce may toss it a few metres up), the daze (~1 s): then
      // it is the player's again.
      expect(endAt - crashAt, at).toBeGreaterThan(1.5);
      expect(endAt - crashAt, at).toBeLessThan(3.5);
      // It stays down until told otherwise; W takes off.
      const p0 = b.pos.clone();
      fly(b, I(), 3, env);
      expect(b.pos.distanceTo(p0), at).toBeLessThan(1e-6);
      const h0 = b.alt;
      fly(b, I({ climb: 1 }), 2, env);
      expect(b.grounded, at).toBe(false);
      expect(b.alt - h0, at).toBeGreaterThan(2);
    }
  });

  it('a crash into a wall high up rights itself and glides on away from it, never climbing; low down it lands dazed by it', () => {
    // A slab across the way, 30 m tall: x 20 … 24.
    const env = boxWorld([[20, -40, 24, 40, 32]], () => 0);
    // [off head-on (deg), starting x, height (m), a crash?]: head-on and 40° off it high up, head-on low
    // down, and a glancing 10° to its face.
    for (const [angle, x0, alt, crash] of [[0, 4, 20, true], [40, 4, 20, true], [0, 14, 2.5, true], [80, 17, 20, false]] as const) {
      const at = `${angle}° at ${alt} m`;
      const a = angle * DEG;
      const b = bird(x0, -20, alt, BIRD.trim, Math.cos(a), Math.sin(a));
      let worstIn = Infinity;
      let away = 0;
      let crashAt = -1;
      let endAt = -1;
      let gAfter = -Infinity;
      fly(b, I(), 8, env, (t) => {
        const { x } = toLocal(b.pos.clone().normalize());
        worstIn = Math.min(worstIn, 20 - x);
        if (b.crashes > 0 && crashAt < 0) crashAt = t;
        if (crashAt >= 0 && endAt < 0 && b.crash < 1) endAt = t;
        // (From the tumble's end: righting itself, then the glide.)
        if (endAt >= 0) gAfter = Math.max(gAfter, b.gamma);
        if (crashAt >= 0 && t - crashAt > 2) away = Math.max(away, 20 - x);
      });
      if (crash) {
        expect(b.crashes, at).toBe(1);
        if (alt > 10) {
          // Righted in the air: out of the wall, heading off it, never climbing, flying.
          expect(b.landings, at).toBe(0);
          expect(away, at).toBeGreaterThan(3);
          expect(b.fwd.dot(fromLocal(5, 0).sub(fromLocal(6, 0)).normalize()), at).toBeGreaterThan(0.2);
          expect(gAfter, at).toBeLessThanOrEqual(0);
        } else {
          // Too low: it fell, landed dazed by the wall and stands there, facing away from it (a
          // take-off goes into the open, not back into the wall).
          expect(b.grounded, at).toBe(true);
          expect(b.stand, at).toBeGreaterThan(0.95);
          expect(b.crash, at).toBe(0);
          expect(b.fwd.dot(fromLocal(5, 0).sub(fromLocal(6, 0)).normalize()), at).toBeGreaterThan(0.9);
          expect(new Vector3(0, 1, 0).applyQuaternion(b.quat).angleTo(b.pos.clone().normalize()), at).toBeLessThan(30 * DEG);
        }
      } else {
        // A glancing touch slides along.
        expect(b.crashes, at).toBe(0);
      }
      // Never inside it (the body's centre stays a radius off its face).
      expect(worstIn, at).toBeGreaterThan(BIRD.bodyR - 0.02);
    }
  });

  it('let go low down it glides in, flares, lowers its legs, lands and stands: never pitching up, never taking off by itself', () => {
    const env = flat();
    const b = bird(0, 0, 12);
    let gMax = -Infinity;
    let landAt = -1;
    let legs = 0;
    let vTouch = 0;
    let x0 = 0;
    fly(b, I(), 16, env, (t) => {
      if (t > 0.3) gMax = Math.max(gMax, b.gamma);
      if (b.grounded && landAt < 0) {
        landAt = t;
        legs = b.legs;
        vTouch = b.speed;
        x0 = toLocal(b.pos.clone().normalize()).x;
      }
      if (landAt >= 0) expect(b.grounded).toBe(true);
    });
    expect(gMax).toBeLessThanOrEqual(0);
    expect(b.landings).toBe(1);
    expect(b.crashes).toBe(0);
    // The flare slowed it, the legs were down for the touchdown, a short run-out.
    expect(vTouch).toBeLessThan(5.5);
    expect(legs).toBeGreaterThan(0.6);
    expect(toLocal(b.pos.clone().normalize()).x - x0).toBeLessThan(4);
    expect(b.stand).toBeGreaterThan(0.95);
    expect(b.legs).toBeGreaterThan(0.95);
    expect(b.speed).toBe(0);
    expect(b.alt).toBeCloseTo(BIRD.belly, 6);
    // Nothing, and S, keep it where it is.
    const p0 = b.pos.clone();
    const f0 = b.fwd.clone();
    fly(b, I(), 5, env);
    fly(b, I({ climb: -1 }), 3, env);
    fly(b, I({ dive: true }), 1, env);
    expect(b.grounded).toBe(true);
    expect(b.pos.distanceTo(p0)).toBeLessThan(1e-6);
    expect(b.fwd.angleTo(f0)).toBeLessThan(1e-6);
  });

  it('standing: A / D turn it on the spot in hops; W or Space take off up a ~16–20° climb, handed over at trim speed', () => {
    const env = flat();
    const b = bird(0, 0, 3);
    fly(b, I(), 6, env);
    expect(b.grounded).toBe(true);
    // A: hop after hop to the left, on the spot.
    const p0 = b.pos.clone();
    const f0 = b.fwd.clone();
    const right = new Vector3().crossVectors(f0, p0.clone().normalize());
    let hop = 0;
    fly(b, I({ steer: -1 }), 0.2, env, () => (hop = Math.max(hop, b.hop)));
    expect(b.fwd.dot(right)).toBeLessThan(-0.05);
    fly(b, I({ steer: -1 }), 1.8, env, () => (hop = Math.max(hop, b.hop)));
    expect(hop).toBeGreaterThan(0.5);
    expect(b.fwd.angleTo(f0)).toBeGreaterThan(90 * DEG);
    expect(b.fwd.angleTo(f0)).toBeLessThan(150 * DEG);
    expect(b.pos.distanceTo(p0)).toBeLessThan(1e-6);
    fly(b, I(), 0.5, env);
    // W: the crouch, the jump, the beats up the climb; handed over on it at trim speed; W held climbs on.
    const h0 = b.alt;
    let handAt = -1;
    let handV = 0;
    let gLo = Infinity;
    let gHi = -Infinity;
    let gAfterLo = Infinity;
    let gAfterHi = -Infinity;
    fly(b, I({ climb: 1 }), 4, env, (t) => {
      if (t < 0.1) expect(b.takingOff).toBe(true);
      if (b.takingOff && t > 0.3) {
        gLo = Math.min(gLo, b.gamma);
        gHi = Math.max(gHi, b.gamma);
      }
      if (!b.takingOff && handAt < 0) {
        handAt = t;
        handV = b.speed;
      }
      if (handAt >= 0) {
        gAfterLo = Math.min(gAfterLo, b.gamma);
        gAfterHi = Math.max(gAfterHi, b.gamma);
      }
      expect(b.stall).toBe(0);
    });
    expect(handAt).toBeGreaterThan(0.4);
    expect(handAt).toBeLessThan(1.5);
    expect(handV).toBeGreaterThanOrEqual(BIRD.trim);
    expect(gLo).toBeGreaterThan(14 * DEG);
    expect(gHi).toBeLessThan(24 * DEG);
    // No dip, no zoom after it.
    expect(gAfterLo).toBeGreaterThan(14 * DEG);
    expect(gAfterHi).toBeLessThan(22 * DEG);
    expect(b.alt - h0).toBeGreaterThan(6);
    // Let go: over onto the glide, never back up.
    let gMax = -Infinity;
    fly(b, I(), 3, env, (t) => t > 0.4 && (gMax = Math.max(gMax, b.gamma)));
    expect(gMax).toBeLessThanOrEqual(0);
    // Down again: a Space tap takes off too, climbs a little and eases over onto the glide at trim
    // speed (nothing held: no climb after it, no dip), then glides in and lands.
    fly(b, I(), 30, env);
    expect(b.grounded).toBe(true);
    const n0 = b.landings;
    handAt = -1;
    let gMin = Infinity;
    let top = 0;
    const g0 = b.alt;
    fly(b, I({ flap: true }), 0.1, env);
    fly(b, I(), 6, env, (t) => {
      if (!b.takingOff && handAt < 0) {
        handAt = t;
        handV = b.speed;
      }
      if (handAt >= 0 && !b.grounded) {
        gMin = Math.min(gMin, b.gamma);
        expect(b.gamma).toBeLessThanOrEqual(0);
      }
      top = Math.max(top, b.alt - g0);
    });
    expect(handV).toBeGreaterThanOrEqual(BIRD.trim);
    expect(gMin).toBeGreaterThan(GLIDE - 2 * DEG);
    expect(top).toBeGreaterThan(1);
    expect(b.landings).toBe(n0 + 1);
    expect(b.crashes).toBe(0);
  });

  it('on water it floats, lower, legs tucked, bobbing; W takes off from it', () => {
    const env: BirdEnv = { floor: () => 0, ceiling: 400, water: () => true };
    const b = bird(0, 0, 6);
    fly(b, I(), 12, env);
    expect(b.grounded).toBe(true);
    expect(b.onWater).toBe(true);
    let lo = Infinity;
    let hi = -Infinity;
    fly(b, I(), 3, env, () => {
      lo = Math.min(lo, b.alt);
      hi = Math.max(hi, b.alt);
    });
    expect(hi).toBeLessThan(BIRD.belly * 0.5);
    expect(lo).toBeGreaterThan(0.02);
    expect(hi - lo).toBeGreaterThan(0.002);
    expect(b.legs).toBeLessThan(0.05);
    expect(b.stand).toBeGreaterThan(0.95);
    fly(b, I({ climb: 1 }), 2, env);
    expect(b.grounded).toBe(false);
    expect(b.alt).toBeGreaterThan(3);
  });

  it('flies the same course at any frame rate', () => {
    const env = flat();
    const course = (fps: number) => {
      const b = bird(0, 0, 60);
      fly(b, I({ steer: 0.6, climb: 0.3 }), 2, env, undefined, fps);
      fly(b, I({ steer: -0.4, flap: true }), 1.5, env, undefined, fps);
      fly(b, I({ dive: true }), 1.5, env, undefined, fps);
      fly(b, I(), 2, env, undefined, fps);
      return b.pos.clone();
    };
    const p60 = course(60);
    expect(course(30).distanceTo(p60)).toBeLessThan(0.05);
    expect(course(120).distanceTo(p60)).toBeLessThan(0.05);
    expect(course(144).distanceTo(p60)).toBeLessThan(0.5);
    expect(course(50).distanceTo(p60)).toBeLessThan(0.5);
    // Down, a turn on the spot, a take-off.
    const ground = (fps: number) => {
      const b = bird(0, 0, 3);
      fly(b, I(), 5, env, undefined, fps);
      fly(b, I({ steer: 1 }), 0.6, env, undefined, fps);
      fly(b, I({ climb: 1 }), 2, env, undefined, fps);
      return b.pos.clone();
    };
    const g60 = ground(60);
    expect(ground(30).distanceTo(g60)).toBeLessThan(0.05);
    expect(ground(120).distanceTo(g60)).toBeLessThan(0.05);
  });

  it('stays bounded under random input: over the floor, under the ceiling, finite, the heading tangent', () => {
    const env = boxWorld([[-8, -8, 8, 8, 30], [30, 10, 40, 30, 18]], hill, 98);
    const b = bird(10, 10, 40);
    const r = rng(7);
    const inp = I();
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
      expect(b.alt).toBeGreaterThanOrEqual(env.floor(up, b.alt) + BIRD.belly - 1e-6);
      expect(b.alt).toBeLessThanOrEqual(env.ceiling + 1e-6);
      if (!b.grounded) expect(b.speed).toBeGreaterThan(1);
      expect(b.speed).toBeLessThan(25);
      expect(b.stand).toBeGreaterThanOrEqual(0);
      expect(b.stand).toBeLessThanOrEqual(1);
      expect(Math.abs(b.bank)).toBeLessThan(BIRD.bankMax + 5 * DEG);
      expect(Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.fwd.x + b.up.y + b.quat.w)).toBe(true);
      expect(Math.abs(b.fwd.dot(up))).toBeLessThan(1e-6);
      expect(b.flapAmp).toBeGreaterThanOrEqual(0);
      expect(b.flapAmp).toBeLessThanOrEqual(1);
      expect(b.crash).toBeGreaterThanOrEqual(0);
      expect(b.crash).toBeLessThanOrEqual(1);
    }
  });
});
