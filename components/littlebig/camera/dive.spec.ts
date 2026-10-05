import '../core/kit-fill'; // before the review tooling (core/kit.ts)
import { describe, expect, it } from 'vitest';
import { getCityIndex, getCityPlan } from '../world/city';
import { EYE_HEIGHT } from '../world/config';
import { buildDivePath, clearPath, divePoseAt, trapezoidEase, type DivePose } from './dive';
import { cameraSolids, clearanceAt, coneBlocked, LandingFinder } from './landing';
import { pitchForAlt } from './model';

const DEG = Math.PI / 180;

describe('the scripted dive', () => {
  const plan = getCityPlan();
  const index = getCityIndex();
  const path = buildDivePath(plan, index);
  const solids = cameraSolids(plan);
  const pose = (u: number): DivePose => divePoseAt(path, u, { x: 0, z: 0, alt: 0, heading: 0, pitch: 0, togo: 0 });

  it('opens on the top-down globe over the city and lands at eye height on pavement, facing down a street', () => {
    const a = pose(0);
    expect(a.alt).toBeCloseTo(380, 6);
    expect(a.pitch).toBeCloseTo(-Math.PI / 2, 6);
    expect(Math.hypot(a.x, a.z)).toBeLessThan(1e-6);
    // a moment later it has tipped toward the city (the limb across the top)
    expect(pose(0.2).pitch).toBeGreaterThan(-80 * DEG);
    const b = pose(1);
    expect(b.alt).toBeCloseTo(EYE_HEIGHT, 6);
    expect(b.x).toBeCloseTo(path.endX, 6);
    expect(b.z).toBeCloseTo(path.endZ, 6);
    expect(['sidewalk', 'plaza']).toContain(index.classify(b.x, b.z));
    let dh = b.heading - path.endHeading;
    dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
    expect(Math.abs(dh)).toBeLessThan(1e-6);
    expect(b.pitch).toBeCloseTo(pitchForAlt(EYE_HEIGHT), 6);
    expect(path.onRoad).toBe(true);
    // the last frame: a long view down the street, nothing in the face, a sunlit spot
    const f = new LandingFinder(plan, index);
    expect(f.viewLength(b.x, b.z, Math.sin(b.heading), -Math.cos(b.heading), 90)).toBeGreaterThan(25);
    expect(coneBlocked(solids, b.x, b.z, Math.sin(b.heading), -Math.cos(b.heading), EYE_HEIGHT + 0.2, 4, 30 * DEG)).toBe(false);
  });

  it('keeps clear of every lamp post, lamp head, trunk, crown and facade (a hard constraint)', () => {
    expect(path.margin).toBeGreaterThanOrEqual(0);
    expect(clearPath(path, index, solids, 3000)).toBeGreaterThanOrEqual(0);
    // independently: low down, 1.5 m clear (0.6 m in the last 3 m); in the last 25 m no solid at eye
    // level within 4 m inside ±30° of the view
    const near: number[] = [];
    for (let i = 0; i <= 2000; i++) {
      const p = pose(i / 2000);
      if (p.alt > 14) continue;
      const h = p.alt + index.groundH(p.x, p.z);
      const need = p.togo > 3 ? 1.5 : 0.6 + 0.3 * p.togo;
      expect(clearanceAt(index, solids, p.x, p.z, h, near, 4)).toBeGreaterThan(need - 1e-6);
      if (p.togo < 25) expect(coneBlocked(solids, p.x, p.z, Math.sin(p.heading), -Math.cos(p.heading), h, 4, 30 * DEG)).toBe(false);
    }
  });

  it('is continuous and steady: no jumps, altitude never climbs, the view only tips up and never stalls', () => {
    const N = 600; // 60 fps over a 10 s dive
    let prev = { ...pose(0) };
    for (let i = 1; i <= N; i++) {
      const p = pose(i / N);
      expect(p.alt).toBeLessThanOrEqual(prev.alt + 1e-9);
      expect(p.togo).toBeLessThanOrEqual(prev.togo + 1e-9);
      expect(Math.abs(Math.log(p.alt / prev.alt))).toBeLessThan(0.03);
      // ground speed in proportion to height (high up the glide out over the planet is fast but tiny on screen)
      expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeLessThan(Math.max(1.2, prev.alt * 0.015));
      let dh = p.heading - prev.heading;
      dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
      expect(Math.abs(dh)).toBeLessThan(1.5 * DEG);
      expect(p.pitch).toBeGreaterThanOrEqual(prev.pitch - 1e-9);
      expect(p.pitch - prev.pitch).toBeLessThan(0.8 * DEG);
      prev = { ...p };
    }
    // no hesitation mid-descent: every 0.3 s window tips the view up by at least 0.4°
    for (let u = 0.08; u < 0.86; u += 0.01) expect(pose(u + 0.03).pitch - pose(u).pitch).toBeGreaterThan(0.4 * DEG);
  });

  it('never flies through a building on the way down', () => {
    for (let i = 0; i <= 1000; i++) {
      const p = pose(i / 1000);
      const roof = index.roofAt(p.x, p.z);
      if (roof > 0) expect(p.alt).toBeGreaterThan(roof + 2);
    }
  });

  it('eases from rest and into rest (trapezoid ease is monotone, C1, exact at the ends)', () => {
    expect(trapezoidEase(0)).toBe(0);
    expect(trapezoidEase(1)).toBeCloseTo(1, 12);
    let prev = 0;
    for (let i = 1; i <= 1000; i++) {
      const v = trapezoidEase(i / 1000);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(trapezoidEase(0.001) / 0.001).toBeLessThan(0.05);
    expect((1 - trapezoidEase(0.999)) / 0.001).toBeLessThan(0.05);
  });
});
