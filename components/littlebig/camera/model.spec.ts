import { describe, expect, it } from 'vitest';
import { R } from '../world/config';
import { dirFromLatLon, dot3, headingVector, len3 } from '../world/sphere';
import { clipPlanes, computePose, createCamState, createPose, fovForAlt, lookBlend, pitchForAlt, springStep } from './model';

const DEG = Math.PI / 180;

describe('camera model', () => {
  it('pitch and FOV follow altitude continuously and monotonically', () => {
    expect(pitchForAlt(380)).toBeCloseTo(-Math.PI / 2);
    expect(pitchForAlt(120)).toBeCloseTo(-Math.PI / 2);
    expect(pitchForAlt(4)).toBeCloseTo(-8 * DEG);
    expect(fovForAlt(1.7)).toBeCloseTo(70);
    expect(fovForAlt(420)).toBeCloseTo(40, 0);
    let prevP = pitchForAlt(1.7);
    let prevF = fovForAlt(1.7);
    for (let a = 1.75; a < 420; a *= 1.02) {
      const p = pitchForAlt(a);
      const f = fovForAlt(a);
      expect(p).toBeLessThanOrEqual(prevP + 1e-12);
      expect(f).toBeLessThanOrEqual(prevF + 1e-12);
      expect(Math.abs(p - prevP)).toBeLessThan(2 * DEG); // no jumps
      prevP = p;
      prevF = f;
    }
    // Below ~25 m the horizon is in frame: pitch + half FOV is above the horizon dip.
    const alt = 24;
    const dip = Math.acos(R / (R + alt));
    expect(pitchForAlt(alt) + (fovForAlt(alt) / 2) * DEG).toBeGreaterThan(-dip);
    // C1 at the 4 m knot: the slope in log-altitude matches from both sides (no stall, no kick).
    const slope = (a: number, h: number) => (pitchForAlt(a * Math.exp(h)) - pitchForAlt(a)) / h;
    const left = slope(4, -1e-4);
    const right = slope(4, 1e-4);
    expect(Math.abs(left - right)).toBeLessThan(0.002);
    expect(right).toBeLessThan(-0.01); // still moving at 4 m
    expect(lookBlend(1.7)).toBe(1);
    expect(lookBlend(100)).toBe(0);
  });

  it('the spring is critically damped: converges without overshoot, frame-rate independent', () => {
    const out = [0, 0];
    let x = 0;
    let v = 0;
    let max = -Infinity;
    for (let i = 0; i < 240; i++) {
      springStep(x, v, 1, 6.5, 1 / 60, out);
      x = out[0];
      v = out[1];
      max = Math.max(max, x);
    }
    expect(x).toBeCloseTo(1, 4);
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    // 30 fps lands where 60 fps does.
    let x2 = 0;
    let v2 = 0;
    for (let i = 0; i < 30; i++) {
      springStep(x2, v2, 1, 6.5, 1 / 30, out);
      x2 = out[0];
      v2 = out[1];
    }
    let x3 = 0;
    let v3 = 0;
    for (let i = 0; i < 60; i++) {
      springStep(x3, v3, 1, 6.5, 1 / 60, out);
      x3 = out[0];
      v3 = out[1];
    }
    expect(x2).toBeCloseTo(x3, 9);
  });

  it('computes an exact, orthonormal pose from a state', () => {
    const s = createCamState();
    const p = createPose();
    s.focus = dirFromLatLon(20, 10);
    s.fwd = headingVector(s.focus, 45 * DEG);
    s.logAlt = Math.log(16);
    s.ground = 2;
    computePose(s, p);
    expect(len3(p.eye)).toBeCloseTo(R + 2 + 16, 9);
    expect(len3(p.dir)).toBeCloseTo(1, 9);
    expect(dot3(p.dir, p.up)).toBeCloseTo(0, 9);
    expect(p.heading).toBeCloseTo(45 * DEG, 9);
    expect(p.pitch).toBeCloseTo(pitchForAlt(16), 9);
    // A pitch override wins exactly.
    s.pitchOverride = -30 * DEG;
    s.overrideWeight = 1;
    computePose(s, p);
    expect(p.pitch).toBeCloseTo(-30 * DEG, 9);
    // Clip planes: no z-fighting at street level, no clipping in orbit.
    const c = clipPlanes(1.7, 3.7, { near: 0, far: 0 });
    expect(c.near).toBeLessThanOrEqual(0.06);
    expect(clipPlanes(380, 380, c).far).toBeGreaterThan(Math.sqrt(540 ** 2 - R ** 2) + 100);
  });
});
