import { describe, expect, it } from 'vitest';
import { getCityIndex, getCityPlan } from '.';
import { AREA_H, CURB_H, ROAD_H } from '../config';
import { buildStubPlan } from './stub';
import { fromSphere, toSphere } from './frame';
import { validatePlan } from './validate';

describe('city plan (current: F0 stub)', () => {
  const plan = getCityPlan();

  it('satisfies every BRIEF §5 invariant', () => {
    expect(validatePlan(plan)).toEqual([]);
  });

  it('is deterministic', () => {
    const again = buildStubPlan(plan.seed);
    expect(again.buildings.map((b) => [b.x, b.z, b.h])).toEqual(plan.buildings.map((b) => [b.x, b.z, b.h]));
  });

  it('has the data downstream systems need', () => {
    expect(plan.buildings.length).toBeGreaterThan(10);
    expect(plan.connectors.length).toBeGreaterThan(0);
    expect(plan.walkEdges.some((w) => w.kind === 'crossing' && w.lanes && w.lanes.length > 0)).toBe(true);
    for (const l of plan.lanes) expect(l.next.length).toBeGreaterThan(0);
    for (const k of ['street', 'rooftops', 'horizon', 'dusk'] as const) expect(plan.viewpoints[k]).toBeDefined();
    // Stop lines sit before the zebra at every junction arm (validatePlan checks the clearances).
    const withCrossing = plan.lanes.filter((l) => l.crossingAtEnd >= 0);
    expect(withCrossing.length).toBeGreaterThan(8);
    for (const l of withCrossing) expect(l.stopS).toBeLessThan(l.path.length - 2);
  });

  it('is read-only (shared by every engine instance)', () => {
    expect(Object.isFrozen(plan.buildings)).toBe(true);
    expect(() => (plan.buildings as unknown as number[]).sort()).toThrow();
  });

  it('index queries agree with the plan', () => {
    const idx = getCityIndex();
    const b = plan.buildings[0];
    expect(idx.classify(b.x, b.z)).toBe('building');
    expect(idx.roofAt(b.x, b.z)).toBe(b.h);
    const lane = plan.lanes[0];
    const mid = (lane.path.pts.length >> 2) * 2;
    expect(idx.classify(lane.path.pts[mid], lane.path.pts[mid + 1])).toBe('road');
    expect(idx.isClear(lane.path.pts[mid], lane.path.pts[mid + 1], 0.5)).toBe(false);
    const sv = plan.viewpoints.street;
    expect(['sidewalk', 'road']).toContain(idx.classify(sv.x, sv.z));
    // collide pushes a walker out of a building
    const out = { x: 0, z: 0 };
    expect(idx.collide(b.x, b.z, 0.4, out)).toBe(true);
    expect(idx.classify(out.x, out.z)).not.toBe('building');
    // Ground heights: carriageway, sidewalk (curb), bare plateau.
    expect(idx.groundH(lane.path.pts[mid], lane.path.pts[mid + 1])).toBe(ROAD_H);
    expect(idx.groundH(sv.x, sv.z)).toBeCloseTo(idx.classify(sv.x, sv.z) === 'sidewalk' ? ROAD_H + CURB_H : ROAD_H, 9);
    const park = plan.areas.find((a) => a.kind === 'park')!;
    const px = (park.outline[0] + park.outline[park.outline.length / 2]) / 2;
    const pz = (park.outline[1] + park.outline[park.outline.length / 2 + 1]) / 2;
    if (idx.classify(px, pz) === 'park') expect(idx.groundH(px, pz)).toBe(AREA_H);
    // Streetlights are obstacles: a walker standing on one is pushed off it.
    const lamp = plan.features.find((f) => f.kind === 'streetlight')!;
    expect(idx.collide(lamp.x + 0.05, lamp.z, 0.35, out)).toBe(true);
    expect(Math.hypot(out.x - lamp.x, out.z - lamp.z)).toBeGreaterThanOrEqual(0.55 - 1e-6);
  });

  it('maps plan points to the sphere and back', () => {
    const p = toSphere(37.5, -12.25, 3);
    const q = fromSphere(p);
    expect(q.x).toBeCloseTo(37.5, 9);
    expect(q.z).toBeCloseTo(-12.25, 9);
  });
});
