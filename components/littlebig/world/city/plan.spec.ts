import '../../core/kit-fill'; // before the review tooling (core/kit.ts)
import { describe, expect, it } from 'vitest';
import { getCityIndex, getCityPlan } from '.';
import { CITY_PLAN_RADIUS, CURB_H, ROAD_H } from '../config';
import { Rng } from '../rng';
import { fromSphere, toSphere } from './frame';
import { footprintDistance, stadiumRing } from './index-grid';
import { BED_H, buildCityPlan } from './plan';
import { obbOverlapGap } from './spatial';
import type { Building } from './types';
import { obbOverlap, validatePlan } from './validate';
import { registerShotViews } from './views';

registerShotViews(); // the review-shot viewpoints (rooftops, horizon, dusk) resolve through views.ts

describe('city plan', () => {
  const plan = getCityPlan();

  it('satisfies every BRIEF §5 invariant (roads, lanes, buildings, walk graph, plateau)', () => {
    expect(validatePlan(plan)).toEqual([]);
  });

  it('is deterministic', () => {
    const again = buildCityPlan(plan.seed);
    expect(again.buildings.map((b) => [b.x, b.z, b.w, b.d, b.h, b.style])).toEqual(plan.buildings.map((b) => [b.x, b.z, b.w, b.d, b.h, b.style]));
    expect(again.features.length).toBe(plan.features.length);
    expect(again.walkEdges.length).toBe(plan.walkEdges.length);
  });

  it('is a town: towers downtown, houses at the edge, a plaza, a park, landmarks', () => {
    const r = (b: Building) => Math.hypot(b.x, b.z);
    const towers = plan.buildings.filter((b) => (b.style === 'tower' || b.style === 'office') && b.h >= 14);
    const houses = plan.buildings.filter((b) => b.style === 'house');
    expect(plan.buildings.length).toBeGreaterThan(45);
    expect(towers.length).toBeGreaterThan(4);
    expect(plan.buildings.filter((b) => b.zone === 'downtown' || b.zone === 'midrise').length).toBeGreaterThan(14);
    expect(houses.length).toBeGreaterThan(16);
    // Density gradient: towers stand inside the ring, houses outside it.
    expect(Math.max(...towers.map(r))).toBeLessThan(55);
    expect(Math.min(...houses.map(r))).toBeGreaterThan(62);
    expect(Math.max(...towers.map((b) => b.h))).toBeGreaterThan(28);
    for (const k of ['plaza', 'park', 'water', 'lot', 'garden'] as const) expect(plan.areas.some((a) => a.kind === k)).toBe(true);
    expect(plan.buildings.filter((b) => b.landmark).map((b) => b.landmark).sort()).toEqual(['church', 'clocktower', 'stadium']);
    expect(plan.features.filter((f) => f.kind === 'tree').length).toBeGreaterThan(40);
    for (const f of plan.features.filter((x) => x.kind === 'tree')) {
      expect(f.size).toBeGreaterThanOrEqual(3);
      expect(f.size).toBeLessThanOrEqual(9);
    }
  });

  it('gives traffic (B1) and people (B2) complete, connected paths', () => {
    for (const l of plan.lanes) {
      expect(l.next.length).toBeGreaterThan(0);
      expect(l.prev.length).toBeGreaterThan(0);
      expect(l.stopS).toBeLessThanOrEqual(l.path.length);
    }
    const crossings = plan.walkEdges.filter((w) => w.kind === 'crossing');
    expect(crossings.length).toBeGreaterThan(20);
    for (const w of crossings) {
      expect(w.lanes?.length).toBeGreaterThan(0);
      expect(w.laneS?.length).toBe(w.lanes?.length);
    }
    // Plaza and park paths join the sidewalk network (validatePlan checks it is all one graph).
    expect(plan.walkEdges.some((w) => w.kind === 'plaza')).toBe(true);
    expect(plan.walkEdges.some((w) => w.kind === 'park')).toBe(true);
    for (const n of plan.walkNodes) for (const e of n.edges) expect([plan.walkEdges[e].a, plan.walkEdges[e].b]).toContain(n.id);
    // Lanes are continuous through every junction (validatePlan checks the joins exactly).
    for (const c of plan.connectors) expect(plan.lanes[c.fromLane].to).toBe(c.node);
  });

  it('places the viewpoints where shots and the dive land', () => {
    const idx = getCityIndex();
    for (const k of ['street', 'dusk', 'horizon'] as const) expect(idx.classify(plan.viewpoints[k].x, plan.viewpoints[k].z)).toBe('sidewalk');
    expect(['plaza', 'sidewalk']).toContain(idx.classify(plan.viewpoints.plaza.x, plan.viewpoints.plaza.z));
    expect(Math.hypot(plan.viewpoints.rooftops.x, plan.viewpoints.rooftops.z)).toBeLessThan(CITY_PLAN_RADIUS);
  });

  it('fills downtown: buildings, courtyard beds and trees instead of bare paving; a market lane, a church, a café', () => {
    const idx = getCityIndex();
    const n: Record<string, number> = {};
    let total = 0;
    for (let x = -58; x <= 58; x += 1) for (let z = -58; z <= 58; z += 1) {
      if (Math.hypot(x, z) > 56) continue;
      const k = idx.classify(x, z);
      n[k] = (n[k] ?? 0) + 1;
      total++;
    }
    expect((n.building ?? 0) / total).toBeGreaterThan(0.225);
    expect((n.lot ?? 0) / total).toBeLessThan(0.26);
    const beds = plan.areas.filter((a) => a.kind === 'park' && (a.h ?? 0) > ROAD_H + CURB_H);
    expect(beds.length).toBeGreaterThanOrEqual(3);
    // a raised bed is walked on (and planted) at its own height
    const b = beds[0];
    let cx = 0, cz = 0;
    for (let i = 0; i < b.outline.length; i += 2) { cx += b.outline[i]; cz += b.outline[i + 1]; }
    cx /= b.outline.length / 2; cz /= b.outline.length / 2;
    expect(idx.groundH(cx, cz)).toBeCloseTo(BED_H, 9);
    expect(plan.walkEdges.some((w) => w.kind === 'footpath')).toBe(true);
    expect(plan.features.filter((f) => f.kind === 'cafe-table').length).toBeGreaterThan(0);
    // the café stands ahead of the street viewpoint, on its right
    const cafe = plan.buildings.find((x) => x.decor === 'cafe')!;
    const vp = plan.viewpoints.street;
    const ahead = (cafe.x - vp.x) * Math.sin(vp.heading) - (cafe.z - vp.z) * Math.cos(vp.heading);
    const right = (cafe.x - vp.x) * Math.cos(vp.heading) + (cafe.z - vp.z) * Math.sin(vp.heading);
    expect(ahead).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
  });

  it('breaks the ring: cul-de-sacs with turning circles that traffic can U-turn round', () => {
    const ends = plan.nodes.filter((x) => x.kind === 'end');
    expect(ends.length).toBeGreaterThanOrEqual(2);
    for (const e of ends) {
      const uturns = plan.connectors.filter((c) => c.node === e.id && c.turn === 'uturn');
      expect(uturns.length).toBe(1);
    }
    // conflicts are computed on demand (off the first-frame path) and are symmetric
    for (const c of plan.connectors) for (const o of c.conflicts) expect(plan.connectors[o].conflicts).toContain(c.id);
  });

  it('is read-only (shared by every engine instance)', () => {
    expect(Object.isFrozen(plan.buildings)).toBe(true);
    expect(() => (plan.buildings as unknown as number[]).sort()).toThrow();
  });

  it('index queries agree with the plan', () => {
    const idx = getCityIndex();
    const b = plan.buildings.find((x) => x.style === 'tower')!;
    expect(idx.classify(b.x, b.z)).toBe('building');
    expect(idx.roofAt(b.x, b.z)).toBe(b.h);
    const lane = plan.lanes[0];
    const mid = (lane.path.pts.length >> 2) * 2;
    expect(idx.classify(lane.path.pts[mid], lane.path.pts[mid + 1])).toBe('road');
    expect(idx.groundH(lane.path.pts[mid], lane.path.pts[mid + 1])).toBe(ROAD_H);
    const sv = plan.viewpoints.street;
    expect(idx.groundH(sv.x, sv.z)).toBeCloseTo(ROAD_H + CURB_H, 9);
    // A walker inside a building is pushed out; a lamp is an obstacle.
    const out = { x: 0, z: 0 };
    expect(idx.collide(b.x, b.z, 0.4, out)).toBe(true);
    expect(idx.classify(out.x, out.z)).not.toBe('building');
    const lamp = plan.features.find((f) => f.kind === 'streetlight')!;
    expect(idx.collide(lamp.x + 0.05, lamp.z, 0.35, out)).toBe(true);
    // Paved lots are 'lot' (nothing grows there).
    const lot = plan.areas.find((a) => a.kind === 'lot')!;
    let found = false;
    for (let i = 0; i < 400 && !found; i++) {
      const rng = new Rng(i + 1);
      const k = rng.int(0, (lot.outline.length >> 1) - 1);
      const x = lot.outline[k * 2] * 0.85 + rng.range(-2, 2);
      const z = lot.outline[k * 2 + 1] * 0.85 + rng.range(-2, 2);
      if (idx.classify(x, z) === 'lot') {
        found = true;
        // downtown lots are paved flush with the sidewalks (tucked 4 mm under the slab edge)
        expect(idx.groundH(x, z)).toBeCloseTo(ROAD_H + CURB_H - 0.004, 9);
      }
    }
    expect(found).toBe(true);
  });

  it('maps plan points to the sphere and back', () => {
    const q = fromSphere(toSphere(37.5, -12.25, 3));
    expect(q.x).toBeCloseTo(37.5, 9);
    expect(q.z).toBeCloseTo(-12.25, 9);
  });

  it('collides with the stadium where its rounded wall is, not its plan box', () => {
    const idx = getCityIndex();
    const st = plan.buildings.find((b) => b.landmark === 'stadium')!;
    const ring = stadiumRing(st);
    const c = Math.cos(st.angle);
    const s = Math.sin(st.angle);
    const out = { x: 0, z: 0 };
    const r = 0.35;
    let reached = 0;
    for (let i = 0; i < 32; i++) {
      // walk a body straight at the wall from 6 m outside it, along the ring vertex's direction
      const lx = ring[i * 2], lz = ring[i * 2 + 1];
      const l = Math.hypot(lx, lz);
      let x = st.x + ((lx / l) * (l + 6)) * c - ((lz / l) * (l + 6)) * s;
      let z = st.z + ((lx / l) * (l + 6)) * s + ((lz / l) * (l + 6)) * c;
      for (let k = 0; k < 80; k++) {
        idx.collide(x - (x - st.x) * 0.02, z - (z - st.z) * 0.02, r, out);
        x = out.x;
        z = out.z;
      }
      const d = footprintDistance(st, x, z);
      // it stops against the visible wall (± the corner masts), never short of it on an invisible box
      if (Math.hypot(x - st.x, z - st.z) < l + 2) {
        reached++;
        expect(d, `direction ${i}: stopped ${d.toFixed(2)} m from the wall`).toBeLessThan(r + 0.15);
      }
      expect(d).toBeGreaterThan(r - 0.05);
    }
    expect(reached).toBeGreaterThan(24);
  });

  it("placement's gap test agrees with validate's overlap test", () => {
    const rng = new Rng(7);
    const box = (): Building => ({ id: 0, x: rng.range(-6, 6), z: rng.range(-6, 6), angle: rng.range(0, Math.PI), w: rng.range(2, 9), d: rng.range(2, 9), h: 5, style: 'house', roof: 'flat', zone: 'residential', wall: 0, roofColor: 0, seed: 0, frontEdge: -1 });
    for (let i = 0; i < 2000; i++) {
      const a = box();
      const b = box();
      expect(obbOverlapGap(a, b, 0)).toBe(obbOverlap(a, b));
      // a positive gap only ever adds overlaps
      if (obbOverlap(a, b)) expect(obbOverlapGap(a, b, 0.8)).toBe(true);
    }
  });
});
