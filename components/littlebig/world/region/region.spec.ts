// @vitest-environment node
// The region's invariants (V2.md §3, R1): settlements on flat pads blended into the terrain, each
// with its own street plan by style; roads on land and graded, smooth, never crossing; bridges with
// clearance and abutments; every road ending at a destination; a transit graph that is continuous,
// drivable (no sliver edges, no connector tighter than a car can turn) and strongly connected per land
// mass; a ferry over deep water; flat runways with clear glide-slope approaches; the capital untouched;
// determinism and the build budget.

import { describe, expect, it } from 'vitest';
import { terrainData } from '../../terrain/data';
import { findLandmarks } from '../../nature/landmarks';
import { CITY_PLAN_RADIUS, CITY_SURFACE_R, PLATEAU_HEIGHT, PLATEAU_RADIUS, R, ROAD_H, SEED } from '../config';
import { getCityPlan } from '../city';
import { GATE_CIRCLE_R } from '../city/layout';
import { createPlanet, getPlanet } from '../planet';
import { angleBetween, chartToDir, dirFromLatLon, v3, type Vec3 } from '../sphere';
import { sunDirection } from '../sun';
import type { Memo } from './bake';
import { BRIDGE_MIN, BRIDGE_WET, DECK_MIN, FERRY_DEPTH, GLIDE, MAX_GRADE, TOWN_APART, TOWN_GAP } from './build';
import { awayTangent, step } from './geo';
import { getRegion } from './index';
import { laneSCCs, minRadius } from './network';
import { wmaxGap, wnearest, wsample, wsampleOut } from './path';
import type { Region, SurfaceHit, WPath } from './types';

const planet = getPlanet();
const region = getRegion();
const dirAt = (p: WPath, i: number, out = v3()) => {
  out.x = p.dir[i * 3];
  out.y = p.dir[i * 3 + 1];
  out.z = p.dir[i * 3 + 2];
  return out;
};
const arcM = (a: Vec3, b: Vec3) => angleBetween(a, b) * R;
const hit: SurfaceHit = { cls: 'free', roadDist: 0, edge: -1, settlement: -1 };
const towns = region.settlements.filter((s) => s.style !== 'capital');
const roads = region.edges.filter((e) => e.settlement < 0 && e.kind !== 'ring');

describe('region: settlements and pads', () => {
  it('has the capital and six towns of five styles on two land masses', () => {
    const styles = region.settlements.map((s) => s.style);
    expect(styles[0]).toBe('capital');
    for (const st of ['harbour', 'farm', 'alpine', 'resort', 'metro'] as const) expect(styles).toContain(st);
    expect(towns.length).toBeGreaterThanOrEqual(6);
    expect(new Set(region.settlements.map((s) => s.id)).size).toBe(region.settlements.length);
    for (const s of region.settlements) expect(s.name).toBe(s.name.toLowerCase());
    expect(region.components.length).toBe(2);
    const far = towns.filter((s) => s.component !== region.settlements[0].component);
    // the far continent has a city and a second settlement, joined by road
    expect(far.map((s) => s.style)).toContain('metro');
    expect(far.length).toBeGreaterThanOrEqual(2);
    // town pads are town-sized (the capital's plan is 91 m)
    for (const s of towns) expect(s.padR).toBeGreaterThanOrEqual(s.style === 'metro' ? 44 : 22);
  });

  it('sets every pad flat (±0.05 m) to its edge, on land, blended into the terrain with no cliff', { timeout: 60000 }, () => {
    for (const s of towns) {
      let wetCore = 0;
      let n = 0;
      for (let i = 0; i < 160; i++) {
        const a = i * 2.399;
        const r = Math.sqrt(i / 159) * s.padR;
        const d = chartToDir(s.chart, Math.cos(a) * r, Math.sin(a) * r);
        expect(Math.abs(planet.heightAt(d) - s.h)).toBeLessThanOrEqual(0.05);
        if (planet.baseHeightAt(d) < 0) wetCore++;
        n++;
      }
      // pads stand on land (a harbour's quay may be won from the shallows at its edge)
      expect(wetCore / n).toBeLessThan(s.style === 'harbour' ? 0.3 : 0.1);
      // across the blend ring, along 32 rays: no step, and on land no bank steeper than ~42°, or
      // than a little more than the natural slope there (a cut into a mountainside stays a slope)
      for (let k = 0; k < 32; k++) {
        const a = (k / 32) * Math.PI * 2;
        let d0 = chartToDir(s.chart, Math.cos(a) * s.padR, Math.sin(a) * s.padR);
        let prev = planet.heightAt(d0);
        let prevB = planet.baseHeightAt(d0);
        for (let r = s.padR + 0.5; r <= s.padR + s.blend + 14; r += 0.5) {
          d0 = chartToDir(s.chart, Math.cos(a) * r, Math.sin(a) * r);
          const h = planet.heightAt(d0);
          const b = planet.baseHeightAt(d0);
          const slope = Math.abs(h - prev) / 0.5;
          const natural = Math.abs(b - prevB) / 0.5;
          // (a road's own banks out here are the road's: spec'd in 'carves continuously')
          const roadBank = region.surface(d0, hit).roadDist < 13;
          if (h > 0.3 && prev > 0.3 && !roadBank) expect(slope).toBeLessThan(Math.max(0.9, natural * 1.2 + 0.6));
          expect(slope).toBeLessThan(Math.max(4, natural + 1));
          prev = h;
          prevB = b;
        }
      }
    }
  });

  it('stands every town apart: its pad well clear of the plateau and of the other towns; the windmills and the lighthouse where they were', { timeout: 60000 }, () => {
    for (let i = 0; i < towns.length; i++) {
      // its own silhouette, not a suburb (V2 §1.1): a strip of countryside between its pad and the
      // capital's plateau, and between it and any other town
      expect(angleBetween(towns[i].dir, planet.cityDir) * CITY_SURFACE_R - towns[i].padR - CITY_PLAN_RADIUS, towns[i].id).toBeGreaterThanOrEqual(TOWN_GAP);
      for (let j = i + 1; j < towns.length; j++) expect(arcM(towns[i].dir, towns[j].dir) - towns[i].padR - towns[j].padR).toBeGreaterThanOrEqual(TOWN_APART);
    }
    // The landmarks are found on the carved terrain: three windmills on the meadow hill west of the
    // capital beside the farm village, and a lighthouse on the N headland, the same on both quality
    // tiers, none on paving.
    const at = (d: number) => findLandmarks(planet, terrainData(planet, d));
    const hi = at(6);
    const lo = at(5);
    expect(hi.filter((l) => l.kind === 'windmill').length).toBe(3);
    const lh = hi.find((l) => l.kind === 'lighthouse')!;
    const ll = lo.find((l) => l.kind === 'lighthouse')!;
    expect(arcM(lh.dir, ll.dir)).toBeLessThan(6);
    expect(arcM(lh.dir, planet.anchors.headlands[0])).toBeLessThan(25);
    for (const l of hi) expect(region.surface(l.dir, hit).cls === 'free' || hit.cls === 'verge').toBe(true);
    // the farm village beside the windmill hill: the mills on its top, a field or two from its pad
    const farm = region.settlements.find((s) => s.id === 'millbrook')!;
    for (const w of hi.filter((l) => l.kind === 'windmill')) expect(arcM(w.dir, farm.dir)).toBeLessThan(farm.padR + 45);
  });

  // The default views at t = 0 (late afternoon over the capital). The game opens over the city
  // (camera/index.ts): its western and southern towns face-on in daylight round the capital. The
  // `orbit` review shot looks at the terminator from 380 m over (CITY_LAT − 6, CITY_LON + 26): there
  // the lit, face-on (> 0.45) ground outside the capital is a crescent ~10 m deep south of it, where
  // the harbour town stands on its cape; the island resort and the alpine village face it on the
  // night side (their lights, T1); the farm village is on the western limb.
  const sun = sunDirection(0);
  const facing = (d: Vec3, cam: Vec3, alt = 380) => {
    const cr = R + alt + PLATEAU_HEIGHT;
    const cx = cam.x * cr - d.x * R, cy = cam.y * cr - d.y * R, cz = cam.z * cr - d.z * R;
    return (cx * d.x + cy * d.y + cz * d.z) / Math.hypot(cx, cy, cz);
  };
  const sunEl = (d: Vec3) => (Math.asin(d.x * sun.x + d.y * sun.y + d.z * sun.z) * 180) / Math.PI;
  it('shows towns with the capital from the orbit shot and the start view', () => {
    const orbit = dirFromLatLon(14, 36);
    const seen = towns.filter((s) => facing(s.dir, orbit) > 0.18);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // one face-on in daylight, two face-on at night
    expect(seen.filter((s) => sunEl(s.dir) > 5 && facing(s.dir, orbit) > 0.45).length).toBeGreaterThanOrEqual(1);
    expect(seen.filter((s) => sunEl(s.dir) < -8 && facing(s.dir, orbit) > 0.5).length).toBeGreaterThanOrEqual(2);
    const start = dirFromLatLon(20, 10);
    expect(towns.filter((s) => facing(s.dir, start) > 0.4 && sunEl(s.dir) > 5).length).toBeGreaterThanOrEqual(2);
  });

  it('labels every settlement, airport and lookout', async () => {
    const { regionLabels } = await import('../../region');
    const labels = regionLabels(region);
    for (const s of region.settlements) expect(labels.some((l) => l.id === `town:${s.id}` && l.text === s.name)).toBe(true);
    for (const a of region.airports) expect(labels.some((l) => l.id === `airport:${a.code}`)).toBe(true);
    // the lighthouse's headland car park on the capital's continent, the far continent's lookout
    expect(region.lookouts.length).toBeGreaterThanOrEqual(2);
    for (const l of region.lookouts) expect(labels.some((x) => x.id === `lookout:${l.node}`)).toBe(true);
  });
});

describe('region: town plans', () => {
  /** The degree of each of a town's nodes within its own streets, sorted: a plan's signature. */
  const signature = (s: (typeof towns)[number]) => {
    const deg = new Map<number, number>();
    for (const id of s.streets) {
      const e = region.edges[id];
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    }
    return [...deg.values()].sort((a, b) => b - a).join('');
  };

  it('gives every town a main street, a loop, side streets, by its style; no two towns alike', () => {
    const sigs = new Map<string, string>();
    for (const s of towns) {
      expect(s.streets.length).toBeGreaterThanOrEqual(4);
      expect(s.square).toBeDefined();
      const streets = s.streets.map((id) => region.edges[id]);
      const nodes = s.nodes.map((id) => region.nodes[id]);
      const ends = nodes.filter((n) => n.kind === 'end').length;
      const juncs = nodes.filter((n) => n.kind === 'junction');
      // a main street ≥ 14 m in from the gate to the first junction (centre to centre)
      const g = region.nodes[s.gates[0]];
      const main = streets.find((e) => e.a === g.id || e.b === g.id)!;
      const first = region.nodes[main.a === g.id ? main.b : main.a];
      expect(main.centre.length + g.radius + first.radius, s.id).toBeGreaterThan(13.9);
      // a loop (V2 §3: "a main street, a loop or square, side streets"): the street graph has a cycle
      expect(streets.length, s.id).toBeGreaterThanOrEqual(nodes.length);
      if (s.style === 'harbour') {
        // the main street down to the pier head on the quay, the quay street round the harbour block
        expect(s.quay?.length).toBeGreaterThan(10);
        expect(s.piers.length).toBe(1);
        const pierNode = nodes.find((n) => n.place === 'pier')!;
        expect(pierNode).toBeDefined();
        expect(streets.some((e) => e.name === 'quay street')).toBe(true);
        // the pier carries straight on from a street's end: its root at the quay street's sidewalk
        const pier = region.piers[s.piers[0]];
        expect(pier.node).toBe(pierNode.id);
        expect(arcM(pier.root, pierNode.dir)).toBeLessThan(4.6);
      }
      if (s.style === 'farm') expect(ends).toBeGreaterThanOrEqual(1);
      if (s.style === 'alpine') {
        // the high street climbs past a lane to the one-way loop round the chapel square
        expect(nodes.some((n) => n.place === 'square' && n.control === 'roundabout')).toBe(true);
        expect(ends).toBeGreaterThanOrEqual(1);
      }
      if (s.style === 'resort') expect(streets.filter((e) => e.oneWay).length).toBe(2); // the promenade
      if (s.style === 'metro') expect(juncs.length).toBeGreaterThanOrEqual(12); // the 4 × 4 grid
      sigs.set(s.id, signature(s) + 'o'.repeat(streets.filter((e) => e.oneWay).length));
    }
    // no two towns share a shape (the degree signature with its one-way streets), not only no two styles
    expect(new Set(sigs.values()).size, JSON.stringify([...sigs])).toBe(sigs.size);
    // nor a lane's name within a style
    const lanes = new Map<string, string>();
    for (const s of towns) for (const id of s.streets) {
      const e = region.edges[id];
      if (e.kind !== 'lane' || e.oneWay) continue;
      const key = `${s.style}:${e.name}`;
      expect(lanes.get(key) ?? s.id, key).toBe(s.id);
      lanes.set(key, s.id);
    }
  });

  it('keeps every street inside its pad, and its turning circles too', () => {
    for (const s of towns) {
      for (const id of s.streets) {
        const e = region.edges[id];
        const d = v3();
        for (let i = 0; i < e.centre.h.length; i++) expect(arcM(dirAt(e.centre, i, d), s.dir)).toBeLessThan(s.padR + 0.1);
      }
      for (const id of s.nodes) {
        const n = region.nodes[id];
        if (n.kind === 'end') expect(arcM(n.dir, s.dir) + n.turnR + 1.2).toBeLessThan(s.padR + 0.6);
      }
    }
  });
});

describe('region: roads', () => {
  it('keeps every road on land (or on a bridge over water) and graded', () => {
    const s0 = wsampleOut();
    const s1 = wsampleOut();
    for (const e of roads) {
      const c = e.centre;
      const spans = e.bridges.map((b) => region.bridges[b]);
      const onBridge = (s: number) => spans.some((b) => s >= b.s0 - 0.5 && s <= b.s1 + 0.5);
      for (let i = 0; i < c.h.length; i++) {
        if (onBridge(c.s[i])) continue;
        // the carved terrain under the carriageway is the road bed, above the sea
        const d = dirAt(c, i);
        const h = planet.heightAt(d);
        expect(h).toBeGreaterThan(0.3);
        expect(Math.abs(h - (c.h[i] - ROAD_H))).toBeLessThan(0.08);
      }
      // grade ≤ ~12 % (MAX_GRADE plus the sampling slack)
      for (let s = 0; s + 2 <= c.length; s += 2) {
        wsample(c, s, s0);
        wsample(c, s + 2, s1);
        expect(Math.abs(s1.h - s0.h) / 2).toBeLessThanOrEqual(Math.max(MAX_GRADE + 0.02, 0.12));
      }
    }
  });

  it('curves smoothly: roads ≥ 5.5 m radius (the alpine hairpins), streets ≥ 6 m, every lane ≥ 3.5 m', () => {
    for (const e of region.edges) {
      if (e.centre.length < 3) continue;
      const r = minRadius(e.centre, 2);
      expect(r, `${e.name} #${e.id}`).toBeGreaterThan(e.settlement < 0 && e.kind !== 'ring' ? 5.5 : 6);
    }
    for (const l of region.lanes) expect(minRadius(l.path, 1), `lane ${l.id} on ${region.edges[l.edge].name}`).toBeGreaterThan(3.5);
  });

  it('bridges only open water, with clearance, landing on abutments', () => {
    expect(region.bridges.length).toBeGreaterThanOrEqual(1);
    for (const b of region.bridges) {
      const e = region.edges[b.edge];
      expect(b.s1 - b.s0).toBeGreaterThanOrEqual(BRIDGE_MIN);
      expect(b.deckMin).toBeGreaterThanOrEqual(DECK_MIN);
      expect(b.clearance).toBeGreaterThan(2);
      // a short causeway past its junction's patch first, and before the next
      expect(b.s0).toBeGreaterThan(5.5);
      expect(e.centre.length - b.s1).toBeGreaterThan(5.5);
      // over the sea, not over a fill or a meadow: ≥ BRIDGE_WET of the span over water (the carved
      // terrain: the causeways' banks stop at its abutments), its middle too
      let wet = 0, n = 0;
      for (let i = 0; i < e.centre.h.length; i++) {
        if (e.centre.s[i] < b.s0 || e.centre.s[i] > b.s1) continue;
        n++;
        if (planet.heightAt(dirAt(e.centre, i)) < 0) wet++;
      }
      expect(wet / n, e.name).toBeGreaterThanOrEqual(BRIDGE_WET);
      const q = wsample(e.centre, (b.s0 + b.s1) / 2, wsampleOut());
      expect(planet.heightAt(v3(q.dx, q.dy, q.dz))).toBeLessThan(0);
    }
  });

  it('never crosses another road, a town, the airports or the capital, except where it meets them', { timeout: 60000 }, () => {
    const near = { dist: 0, s: 0 };
    const d = v3();
    for (let i = 0; i < roads.length; i++) {
      const a = roads[i];
      for (let k = 0; k < a.centre.h.length; k += 2) {
        dirAt(a.centre, k, d);
        // outside the capital's plan
        expect(angleBetween(d, planet.cityDir) * CITY_SURFACE_R).toBeGreaterThan(CITY_PLAN_RADIUS + 1);
        // inside no town but its own (it enters through a gate)
        const own = [a.a, a.b].map((n) => region.nodes[n].settlement);
        for (const s of towns) if (!own.includes(s.index)) expect(arcM(d, s.dir)).toBeGreaterThan(s.padR);
        for (const ap of region.airports) if (ap.node !== a.a && ap.node !== a.b) expect(arcM(d, ap.centre)).toBeGreaterThan(ap.width / 2 + 3);
      }
      for (let j = i + 1; j < roads.length; j++) {
        const b = roads[j];
        const shared = [a.a, a.b].filter((n) => n === b.a || n === b.b).map((n) => region.nodes[n]);
        for (let k = 0; k < a.centre.h.length; k += 2) {
          dirAt(a.centre, k, d);
          if (shared.some((n) => arcM(n.dir, d) < n.radius + 14)) continue;
          // roads of the same plaza come close beside it
          if (region.gates.some((g) => arcM(g.dir, d) < g.r + 10)) continue;
          expect(wnearest(b.centre, d, near)).toBeGreaterThan((a.width + b.width) / 2 + 1.5);
        }
      }
    }
  });

  it('ends every road at a destination with a turnaround, never in nothing', () => {
    for (const n of region.nodes) {
      if (n.kind !== 'end') continue;
      expect(['pier', 'airport', 'end', 'square', 'viewpoint', 'town-gate'].includes(n.place)).toBe(true);
      expect(n.turnR).toBeGreaterThan(4);
      // inside a pad, at an airport's apron or a lookout's car park
      const inTown = towns.some((s) => arcM(s.dir, n.dir) < s.padR);
      const atAirport = region.airports.some((a) => a.node === n.id);
      const atLookout = region.lookouts.some((l) => l.node === n.id);
      expect(inTown || atAirport || atLookout).toBe(true);
      const uturns = region.connectors.filter((c) => c.node === n.id && c.turn === 'uturn');
      expect(uturns.length).toBe(1);
    }
    // a town's gates all lead somewhere (none is a dead end of the network)
    for (const s of towns) for (const g of s.gates) expect(region.nodes[g].kind).toBe('bend');
    // every node of a country road is a junction, a roundabout, a town gate or an end
    for (const e of roads) for (const id of [e.a, e.b]) expect(['gate', 'roundabout', 'town-gate', 'junction', 'airport', 'pier', 'end', 'viewpoint'].includes(region.nodes[id].place)).toBe(true);
  });

  it('climbs to the alpine village by a hairpin, where the direct way would be too steep', () => {
    const alpine = region.edges.find((e) => e.name === 'alpine road')!;
    expect(alpine.centre.length).toBeGreaterThan(80);
    const snow = region.settlements.find((s) => s.style === 'alpine')!;
    // high on the range's flank, near the snowline (v2 R1 refine 2): a climb of ≥ 8 m
    expect(snow.h).toBeGreaterThan(11);
    const h0 = alpine.centre.h[0];
    const h1 = alpine.centre.h[alpine.centre.h.length - 1];
    expect(Math.abs(h1 - h0)).toBeGreaterThan(8);
    // a hairpin: the heading swings through more than 300° along it
    const s0 = wsampleOut();
    const s1 = wsampleOut();
    let turn = 0;
    for (let s = 0; s + 1 <= alpine.centre.length; s += 1) {
      wsample(alpine.centre, s, s0);
      wsample(alpine.centre, s + 1, s1);
      turn += Math.acos(Math.min(1, s0.tx * s1.tx + s0.ty * s1.ty + s0.tz * s1.tz));
    }
    expect(turn).toBeGreaterThan((300 * Math.PI) / 180);
    // and only because it must: straight from end to end the climb would be far over the grade limit
    const direct = arcM(dirAt(alpine.centre, 0), dirAt(alpine.centre, alpine.centre.h.length - 1));
    expect(Math.abs(h1 - h0) / direct).toBeGreaterThan(MAX_GRADE * 1.5);
    // and the far continent has a highway between its two settlements
    expect(region.edges.some((e) => e.kind === 'highway' && e.centre.length > 60)).toBe(true);
  });

  it('meets the capital at gate plazas outside its own turning circles', () => {
    const plan = getCityPlan();
    expect(region.gates.length).toBeGreaterThanOrEqual(2);
    for (const g of region.gates) {
      const e = plan.edges[g.cityEdge];
      expect(e).toBeDefined();
      expect([e.a, e.b]).toContain(g.cityNode);
      expect(plan.nodes[g.cityNode].kind).toBe('end');
      // the plaza touches the rim where the city's circle does
      expect(Math.hypot(g.touchX, g.touchZ)).toBeCloseTo(Math.hypot(g.cityX, g.cityZ) + GATE_CIRCLE_R + 0.05, 1);
      expect(Math.hypot(g.touchX, g.touchZ)).toBeLessThanOrEqual(CITY_PLAN_RADIUS + 1e-6);
      expect(arcM(g.dir, g.touch)).toBeCloseTo((g.r * R) / (R + g.h), 0);
      // flat at the plateau's height, paved continuously with the city's ground
      expect(Math.abs(planet.heightAt(g.dir) - PLATEAU_HEIGHT)).toBeLessThan(0.02);
      expect(Math.abs(planet.heightAt(g.touch) - PLATEAU_HEIGHT)).toBeLessThan(0.02);
      // region nodes on the plaza never reach into the plan
      for (const id of g.nodes) expect(angleBetween(region.nodes[id].dir, planet.cityDir) * CITY_SURFACE_R).toBeGreaterThan(CITY_PLAN_RADIUS);
    }
  });

  it('leaves the plateau untouched', () => {
    for (let i = 0; i < 2000; i++) {
      const a = i * 2.399;
      const r = Math.sqrt(i / 2000) * PLATEAU_RADIUS * 0.999;
      const d = v3();
      const c = planet.cityDir;
      // a point at angle r from the city (any frame will do)
      const e = v3(c.z, 0, -c.x);
      const el = Math.hypot(e.x, e.y, e.z);
      e.x /= el;
      e.z /= el;
      const n = v3(c.y * e.z - c.z * e.y, c.z * e.x - c.x * e.z, c.x * e.y - c.y * e.x);
      d.x = c.x * Math.cos(r) + (e.x * Math.cos(a) + n.x * Math.sin(a)) * Math.sin(r);
      d.y = c.y * Math.cos(r) + (e.y * Math.cos(a) + n.y * Math.sin(a)) * Math.sin(r);
      d.z = c.z * Math.cos(r) + (e.z * Math.cos(a) + n.z * Math.sin(a)) * Math.sin(r);
      expect(planet.heightAt(d)).toBe(planet.baseHeightAt(d));
    }
  });
});

describe('region: surface classes (for the scatter and the towns: N2, T1)', () => {
  it('flags every pad, plaza, runway and carriageway, so nothing grows on them', () => {
    for (const s of towns) {
      for (let i = 0; i < 60; i++) {
        const a = i * 2.399;
        const r = Math.sqrt(i / 59) * (s.padR - 0.3);
        const cls = region.surface(chartToDir(s.chart, Math.cos(a) * r, Math.sin(a) * r), hit).cls;
        expect(['pad', 'road', 'plaza'].includes(cls), `${s.id}: ${cls}`).toBe(true);
        expect(cls === 'road' || hit.settlement === s.index).toBe(true);
      }
    }
    for (const a of region.airports) {
      for (let k = 0; k <= 10; k++) {
        const c = v3();
        const f = k / 10;
        c.x = a.ends[0].x + (a.ends[1].x - a.ends[0].x) * f;
        c.y = a.ends[0].y + (a.ends[1].y - a.ends[0].y) * f;
        c.z = a.ends[0].z + (a.ends[1].z - a.ends[0].z) * f;
        const l = Math.hypot(c.x, c.y, c.z);
        c.x /= l;
        c.y /= l;
        c.z /= l;
        expect(region.surface(c, hit).cls).toBe('runway');
      }
    }
    for (const e of roads) for (let i = 0; i < e.centre.h.length; i += 5) if (!e.bridges.some((b) => e.centre.s[i] >= region.bridges[b].s0 && e.centre.s[i] <= region.bridges[b].s1)) expect(['road', 'plaza', 'runway'].includes(region.surface(dirAt(e.centre, i), hit).cls)).toBe(true);
  });
});

describe('region: transit graph', () => {
  it('samples every lane and connector ≤ 1 m in true metres, joined exactly', () => {
    for (const l of region.lanes) {
      expect(wmaxGap(l.path)).toBeLessThanOrEqual(1.0001);
      expect(l.path.length).toBeGreaterThan(0.5);
      expect(l.next.length).toBeGreaterThan(0);
      expect(l.prev.length).toBeGreaterThan(0);
      expect(l.stopS).toBeLessThanOrEqual(l.path.length);
      expect(l.speed).toBeGreaterThan(0);
    }
    const a = v3();
    const b = v3();
    for (const c of region.connectors) {
      expect(wmaxGap(c.path)).toBeLessThanOrEqual(1.0001);
      const from = region.lanes[c.fromLane].path;
      const to = region.lanes[c.toLane].path;
      dirAt(from, from.h.length - 1, a);
      dirAt(c.path, 0, b);
      expect(arcM(a, b)).toBeLessThan(1e-6);
      expect(Math.abs(from.h[from.h.length - 1] - c.path.h[0])).toBeLessThan(1e-9);
      dirAt(c.path, c.path.h.length - 1, a);
      dirAt(to, 0, b);
      expect(arcM(a, b)).toBeLessThan(1e-6);
      expect(region.lanes[c.fromLane].to).toBe(c.node);
      expect(region.lanes[c.toLane].from).toBe(c.node);
      // conflicts are symmetric
      for (const o of c.conflicts) expect(region.connectors[o].conflicts).toContain(c.id);
    }
  });

  it('is drivable: no sliver edges, no connector tighter than a car turns', () => {
    for (const e of region.edges) expect(e.centre.length, `${e.name} #${e.id}`).toBeGreaterThan(2.5);
    for (const c of region.connectors) {
      const r = minRadius(c.path, 1);
      const n = region.nodes[c.node];
      if (c.turn === 'uturn') expect(r).toBeGreaterThan(n.turnR - 2);
      else expect(r, `connector ${c.id} (${c.turn}) at ${n.place} ${n.id}`).toBeGreaterThan(3.5);
    }
    // a roundabout's arms are ≥ 75° apart round its ring
    for (const g of region.gates) {
      const arms = g.nodes.filter((id) => region.nodes[id].place === 'roundabout').map((id) => region.nodes[id].dir);
      for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) expect(angleBetween(arms[i], arms[j]) * R).toBeGreaterThan(g.ring * 1.3);
    }
  });

  it('drives on the right, round roundabouts counter-clockwise, with priorities', () => {
    const s = wsampleOut();
    for (const l of region.lanes) {
      const e = region.edges[l.edge];
      if (e.oneWay) continue;
      // the lane's midpoint lies to the right of its travel along the centreline
      wsample(l.path, l.path.length / 2, s);
      const near = { dist: 0, s: 0 };
      wnearest(e.centre, v3(s.dx, s.dy, s.dz), near);
      const c = wsampleOut();
      wsample(e.centre, near.s, c);
      const sign = l.dir;
      // right of the centreline's a → b tangent = t × up
      const rx = c.ty * c.dz - c.tz * c.dy;
      const ry = c.tz * c.dx - c.tx * c.dz;
      const rz = c.tx * c.dy - c.ty * c.dx;
      const side = (s.dx - c.dx) * rx + (s.dy - c.dy) * ry + (s.dz - c.dz) * rz;
      expect(Math.sign(side)).toBe(sign);
    }
    for (const g of region.gates) {
      if (g.nodes.length < 2) continue;
      // ring edges run with decreasing plan angle round the plaza centre (counter-clockwise from above)
      const ring = region.edges.filter((e) => e.kind === 'ring' && g.nodes.includes(e.a));
      expect(ring.length).toBe(g.nodes.length);
      for (const e of ring) expect(e.oneWay).toBe(true);
    }
    // entries yield to the ring
    for (const c of region.connectors) {
      const n = region.nodes[c.node];
      if (n.control !== 'roundabout') continue;
      const fromRing = region.edges[region.lanes[c.fromLane].edge].oneWay;
      if (!fromRing) expect(c.priority).toBeLessThan(100);
      else expect(c.priority).toBeGreaterThanOrEqual(100);
    }
  });

  it('is strongly connected on each land mass (vehicles roam forever)', () => {
    const sccs = laneSCCs(region.lanes, region.connectors);
    expect(sccs.length).toBe(region.components.length);
    for (const comp of region.components) {
      const lanes = region.lanes.filter((l) => comp.includes(l.from)).map((l) => l.id);
      expect(sccs.some((s) => lanes.every((id) => s.includes(id)))).toBe(true);
    }
  });

  it('runs a ferry between two piers over deep water, clear of the shore', () => {
    expect(region.piers.length).toBeGreaterThanOrEqual(2);
    expect(region.ferries.length).toBeGreaterThanOrEqual(1);
    const f = region.ferries[0];
    expect(f.lane.closed).toBe(true);
    expect(wmaxGap(f.lane)).toBeLessThanOrEqual(1.0001);
    const pa = region.piers[f.a];
    const pb = region.piers[f.b];
    expect(region.settlements[pa.settlement].component).not.toBe(region.settlements[pb.settlement].component);
    const d = v3();
    for (let i = 0; i < f.lane.h.length; i += 2) {
      dirAt(f.lane, i, d);
      const nearBerth = Math.min(arcM(d, pa.berth), arcM(d, pb.berth));
      const h = planet.heightAt(d);
      if (nearBerth > 34) expect(-h).toBeGreaterThan(FERRY_DEPTH - 0.6);
      else expect(h).toBeLessThan(-0.25);
    }
    for (const p of region.piers) expect(planet.heightAt(p.berth)).toBeLessThan(-1.2);
  });

  it('builds airports on flat strips with a clear glide-slope approach at their landing end', () => {
    expect(region.airports.length).toBeGreaterThanOrEqual(2);
    const comps = new Set(region.airports.map((a) => region.settlements[a.settlement].component));
    expect(comps.size).toBeGreaterThanOrEqual(2);
    for (const a of region.airports) {
      for (let k = 0; k <= 10; k++) {
        const f = k / 10;
        const c = v3(a.ends[0].x + (a.ends[1].x - a.ends[0].x) * f, a.ends[0].y + (a.ends[1].y - a.ends[0].y) * f, a.ends[0].z + (a.ends[1].z - a.ends[0].z) * f);
        const l = Math.hypot(c.x, c.y, c.z);
        c.x /= l;
        c.y /= l;
        c.z /= l;
        expect(Math.abs(planet.heightAt(c) - a.h)).toBeLessThan(0.05);
      }
      expect(arcM(a.ends[0], a.ends[1])).toBeGreaterThan(55);
      expect(a.node).toBeGreaterThanOrEqual(0);
      // the landing end: terrain under the 1:12 glide (1 m to spare) over the whole approach, from
      // past the strip's carved overrun
      expect(a.approach).toBeGreaterThanOrEqual(200);
      const e = a.ends[a.landEnd];
      const out = awayTangent(a.ends[1 - a.landEnd], e, v3());
      for (let dd = 12; dd <= a.approach; dd += 3) expect(planet.heightAt(step(e, out, dd)), `${a.code} at ${dd} m`).toBeLessThan(a.h + dd * GLIDE - 1);
    }
  });
});

describe('region: build', () => {
  it('is deterministic', () => {
    const other = createPlanet(SEED).region;
    expect(other.settlements.map((s) => [s.id, s.dir.x, s.dir.y, s.dir.z, s.h])).toEqual(region.settlements.map((s) => [s.id, s.dir.x, s.dir.y, s.dir.z, s.h]));
    expect(other.edges.map((e) => e.centre.length)).toEqual(region.edges.map((e) => e.centre.length));
    expect(other.lanes.length).toBe(region.lanes.length);
  });

  it('builds a region for another seed without failing', () => {
    const p = createPlanet(SEED + 7);
    expect(() => p.heightAt(dirFromLatLon(3, 4))).not.toThrow();
    expect(p.region.settlements[0].style).toBe('capital');
  });

  it('builds within budget: every search replayed from the bake, ≤ 20 ms on the M3', { timeout: 60000 }, () => {
    // The structural half of the budget: the boot path samples no terrain (the costly searches are
    // baked, bake.ts) and leaves the network for later.
    const fresh = createPlanet(SEED);
    const r = fresh.region as Region & { stats: Record<string, number>; memo: Memo };
    expect(r.memo.stats.misses).toBe(0);
    expect(r.stats.samples).toBeLessThan(10);
    // The timing half (LB_PERF_SLACK scales it for slow or loaded machines; CI runners are ~2× an M3).
    const slack = Number(process.env.LB_PERF_SLACK ?? 2);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = createPlanet(SEED);
      const t0 = performance.now();
      void p.region;
      times.push(performance.now() - t0);
    }
    expect(Math.min(...times)).toBeLessThan(20 * slack);
  });

  it('carves continuously (no seams at the grid cells)', { timeout: 60000 }, () => {
    // walk lines across the network: neighbouring samples 0.25 m apart never jump
    for (const e of roads) {
      const s = wsampleOut();
      for (let k = 0; k < e.centre.length; k += 7) {
        wsample(e.centre, k, s);
        const rx = s.ty * s.dz - s.tz * s.dy;
        const ry = s.tz * s.dx - s.tx * s.dz;
        const rz = s.tx * s.dy - s.ty * s.dx;
        let prev = NaN;
        let prevNat = false;
        for (let o = -26; o <= 26; o += 0.25) {
          const q = v3(s.dx + (rx * o) / R, s.dy + (ry * o) / R, s.dz + (rz * o) / R);
          const l = Math.hypot(q.x, q.y, q.z);
          q.x /= l;
          q.y /= l;
          q.z /= l;
          const h = planet.heightAt(q);
          const nat = Math.abs(h - planet.baseHeightAt(q)) < 0.05;
          // (under water a fill's bank may drop steeply into the deep: still no step; where neither
          // sample is carved (by more than 5 cm) it is the planet's own shape, planet.spec's)
          if (prev === prev && !(nat && prevNat)) expect(Math.abs(h - prev)).toBeLessThan(h < 0 && prev < 0 ? 0.8 : 0.45);
          prev = h;
          prevNat = nat;
        }
      }
    }
  });
});
