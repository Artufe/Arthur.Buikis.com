import { describe, expect, it } from 'vitest';
import { CLOUD_MIN } from '../world/config';
import { getPlanet } from '../world/planet';
import { getRegion } from '../world/region';
import { QUAY_H } from '../roads/ground';
import { lampLayout } from '../roads/lamps';
import { padDist, padHeight } from '../world/region/pad';
import { dirToChart, v3 } from '../world/sphere';
import { doorOff, dwelling, F, type Item, planTowns, polyDist, type Site, siteDir, T, toPoly } from './plan';

const region = getRegion();
const planet = getPlanet();
const sites = planTowns(region, (d) => planet.heightAt(d));
const towns = sites.filter((s) => s.style !== 'airport');
const solid = (i: Item) => i.t < T.tree;
const count = (s: Site, f: (i: Item) => boolean) => s.items.filter(f).length;
const town = (style: string) => towns.filter((s) => s.style === style);

/** The footprint's corners (plan). */
function corners(i: Item): Array<[number, number]> {
  const ca = Math.cos(i.a), sa = Math.sin(i.a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, k]) => [i.x + ((u * i.w) / 2) * ca - ((k * i.d) / 2) * sa, i.z + ((u * i.w) / 2) * sa + ((k * i.d) / 2) * ca]);
}
/** Distance from (x, z) to the footprint (0 inside). */
function rectDist(i: Item, x: number, z: number): number {
  const ca = Math.cos(i.a), sa = Math.sin(i.a);
  const u = (x - i.x) * ca + (z - i.z) * sa, v = -(x - i.x) * sa + (z - i.z) * ca;
  return Math.hypot(Math.max(0, Math.abs(u) - i.w / 2), Math.max(0, Math.abs(v) - i.d / 2));
}
/** Separating-axis test: do two footprints overlap? (touching is not overlapping: a terrace) */
function overlap(a: Item, b: Item): boolean {
  const ca = corners(a), cb = corners(b);
  for (const it of [a, b]) {
    for (const ang of [it.a, it.a + Math.PI / 2]) {
      const ax = Math.cos(ang), az = Math.sin(ang);
      const pa = ca.map(([x, z]) => x * ax + z * az), pb = cb.map(([x, z]) => x * ax + z * az);
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

describe('towns plan (T1)', () => {
  it('fills every town by its style, and gives the city a skyline', () => {
    // (LB_TOWNS_SUMMARY=1 prints what each site holds)
    if (process.env.LB_TOWNS_SUMMARY) {
      const names = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));
      for (const s of sites) {
        const n: Record<string, number> = {};
        for (const i of s.items) n[names[i.t]] = (n[names[i.t]] ?? 0) + 1;
        console.log(s.id, 'dwellings', count(s, (i) => dwelling(i.t)), JSON.stringify(n));
      }
    }
    // (per kind: the city, a harbour town, a village; the resort town's pad is mostly its loop road, so
    // its floor is its hotels and villas, and its beach and pool are spec'd below)
    for (const s of towns) {
      const st = region.settlements.find((x) => x.id === s.id)!;
      expect(count(s, (i) => dwelling(i.t)), s.id).toBeGreaterThanOrEqual(st.kind === 'city' ? 42 : st.style === 'resort' ? 4 : st.kind === 'town' ? 26 : 10);
    }
    const city = town('metro')[0];
    expect(count(city, (i) => i.t === T.tower)).toBeGreaterThanOrEqual(6);
    // (a skyline, but under the cloud layer's puffs: the clouds drift over far haven, not the capital)
    expect(Math.max(...city.items.filter((i) => i.t === T.tower).map((i) => i.h))).toBeGreaterThan(24);
    for (const s of towns) for (const i of s.items.filter(solid)) expect(i.y + i.h, `${s.id}: a ${i.t} in the clouds`).toBeLessThan(CLOUD_MIN - 4);
    expect(count(city, (i) => i.t === T.crane)).toBeGreaterThanOrEqual(2);
    expect(count(city, (i) => i.t === T.containers || i.t === T.warehouse)).toBeGreaterThanOrEqual(2);
    for (const s of town('alpine')) {
      expect(count(s, (i) => i.t === T.chalet), s.id).toBeGreaterThanOrEqual(5);
      expect(count(s, (i) => i.t === T.chapel), s.id).toBe(1);
    }
    for (const s of town('farm')) {
      expect(count(s, (i) => i.t === T.barn), s.id).toBeGreaterThanOrEqual(1);
      expect(count(s, (i) => i.t === T.paddock || i.t === T.bales), s.id).toBeGreaterThanOrEqual(1);
    }
    for (const s of town('harbour')) {
      expect(count(s, (i) => i.t === T.townhouse), s.id).toBeGreaterThanOrEqual(s.id === 'port-pebble' ? 6 : 1);
      expect(count(s, (i) => i.t === T.market), `${s.id}: its fish market`).toBeGreaterThanOrEqual(1);
      expect(count(s, (i) => i.t === T.crates), `${s.id}: its quay dressed`).toBeGreaterThanOrEqual(5);
    }
    for (const s of town('resort')) {
      expect(count(s, (i) => i.t === T.hotel), `${s.id}: its hotels`).toBeGreaterThanOrEqual(2);
      expect(count(s, (i) => i.t === T.umbrella && i.f > 0), `${s.id}: loungers under umbrellas`).toBeGreaterThanOrEqual(8);
      expect(count(s, (i) => i.t === T.lifeguard), `${s.id}: the lifeguard`).toBe(1);
      // (the square's pool; the hotels have theirs on the roof: towns/build hotel)
      expect(count(s, (i) => i.t === T.pool), `${s.id}: its pool`).toBe(1);
    }
    // every farm and boat yard has its rim of buildings
    for (const s of towns) {
      for (const y of region.settlements.find((x) => x.id === s.id)!.yards ?? []) {
        if (y.kind !== 'farm' && y.kind !== 'boat') continue;
        expect(count(s, (i) => solid(i) && rectDist(i, y.x, y.z) < y.r + 2), `${s.id} ${y.kind} yard`).toBeGreaterThanOrEqual(1);
      }
    }
    for (const a of sites.filter((s) => s.style === 'airport')) {
      expect(a.items.some((i) => i.t === T.ctower), a.id).toBe(true);
      expect(a.items.some((i) => i.t === T.office), a.id).toBe(true);
    }
  });

  it('keeps every footprint on its pad, above the water, off every road corridor, junction and turning circle', () => {
    const d = v3();
    for (const s of towns) {
      const st = region.settlements.find((x) => x.id === s.id)!;
      const sw = (e: { sidewalk: number }) => (e.sidewalk > 0 ? e.sidewalk : 1.6);
      const polys = region.edges.map((e) => toPoly(st.chart, e.centre, e.width / 2 + sw(e), e.id)).filter((p) => p.x.some((x, k) => Math.hypot(x, p.z[k]) < st.padR + 20));
      // a dead end's turning circle; a junction's disc and its arms run in to its centre
      const nodes = region.nodes
        .filter((n) => n.dir.x * st.dir.x + n.dir.y * st.dir.y + n.dir.z * st.dir.z > 0.9)
        .map((n) => {
          const q = dirToChart(st.chart, n.dir, { x: 0, z: 0 });
          const arms = n.kind === 'end' ? [] : n.edges.map((id) => {
            const e = region.edges[id], c = e.centre, k = e.a === n.id ? 0 : c.h.length - 1;
            return { a: dirToChart(st.chart, v3(c.dir[k * 3], c.dir[k * 3 + 1], c.dir[k * 3 + 2]), { x: 0, z: 0 }), w: e.width / 2 + sw(e) };
          });
          return { q, arms, r: n.kind === 'end' ? n.turnR + 1.2 : Math.max(...arms.map((a) => a.w)) + 1 };
        });
      // (the chairlift's top station stands out on the hill and a resort's beach huts on the sand, off the
      // pad: the region's keep-out clears them of roads and piers)
      for (const i of s.items.filter((x) => solid(x) && x.t !== T.station && !(x.t === T.hut && x.y !== x.lo))) {
        const cs = corners(i);
        for (const [x, z] of cs) {
          expect(padDist(st, x, z), `${s.id} ${i.t} off its pad`).toBeLessThan(0);
          expect(planet.heightAt(siteDir(s, x, z, d)), `${s.id} ${i.t} in the water`).toBeGreaterThan(0.3);
        }
        for (const p of polys) {
          // the corridor's centreline never comes within its half width of the footprint
          let near = Infinity;
          for (const [x, z] of cs) near = Math.min(near, polyDist(p, x, z));
          for (let k = 0; k < p.x.length; k++) near = Math.min(near, rectDist(i, p.x[k], p.z[k]));
          for (let k = 1; k < p.x.length; k++) near = Math.min(near, rectDist(i, (p.x[k] + p.x[k - 1]) / 2, (p.z[k] + p.z[k - 1]) / 2));
          expect(near, `${s.id} ${i.t} on road ${p.e}`).toBeGreaterThan(p.hw);
        }
        for (const n of nodes) {
          expect(rectDist(i, n.q.x, n.q.z), `${s.id} ${i.t} on a junction`).toBeGreaterThan(n.r);
          for (const { a, w } of n.arms) for (let f = 0; f <= 1; f += 0.05) expect(rectDist(i, n.q.x + (a.x - n.q.x) * f, n.q.z + (a.z - n.q.z) * f), `${s.id} ${i.t} on a junction's arm`).toBeGreaterThan(w);
        }
      }
    }
  });

  it('keeps every prop off the carriageways and every building off the plaza', () => {
    for (const s of towns) {
      const st = region.settlements.find((x) => x.id === s.id)!;
      const polys = region.edges.map((e) => toPoly(st.chart, e.centre, e.width / 2, e.id)).filter((p) => p.x.some((x, k) => Math.hypot(x, p.z[k]) < st.padR + 40));
      const ends = region.nodes.filter((n) => n.kind === 'end' && n.dir.x * st.dir.x + n.dir.y * st.dir.y + n.dir.z * st.dir.z > 0.9).map((n) => ({ q: dirToChart(st.chart, n.dir, { x: 0, z: 0 }), r: n.turnR }));
      // (everything we stand on the ground, bar the boats: the centre and the corners of its footprint, or of a 1 m square round a post)
      for (const i of s.items.filter((x) => x.t !== T.boat && x.t !== T.pylon && x.t !== T.station)) {
        const pts = [[i.x, i.z], ...corners({ ...i, w: Math.max(0.5, i.w * 0.9), d: Math.max(0.5, i.d * 0.9) })];
        for (const [x, z] of pts) {
          for (const p of polys) expect(polyDist(p, x, z), `${s.id} ${i.t} on the carriageway of ${p.e}`).toBeGreaterThan(p.hw);
          // (a turning circle's island, clear of the U-turn's lane (turnR − 2.9 m: roads/ground), may hold a square's statue)
          for (const e of ends) {
            const dd = Math.hypot(x - e.q.x, z - e.q.z);
            expect(dd > e.r || dd < e.r - 2.9, `${s.id} ${i.t} in a turning circle (${dd.toFixed(2)} of ${e.r})`).toBe(true);
          }
        }
      }
      const sq = st.square;
      if (!sq || st.nodes.some((id) => region.nodes[id].kind === 'end' && region.nodes[id].place === 'square')) continue;
      // H1's paving (roads/ground): a ray from the square's middle to 0.3 m into the first town street
      // (or junction patch: here its disc) it meets, up to r + 22 m, else r + 9 m; a farm's green is a
      // lawn whose middle (r + 2.8 m) only is kept
      const streets = st.streets.map((id) => toPoly(st.chart, region.edges[id].centre, region.edges[id].width / 2 - 0.3, id));
      const discs = st.nodes.map((id) => [dirToChart(st.chart, region.nodes[id].dir, { x: 0, z: 0 }), region.nodes[id].radius] as const);
      const hit = (x: number, z: number) => streets.some((p) => polyDist(p, x, z) < p.hw) || discs.some(([q, r]) => Math.hypot(q.x - x, q.z - z) < r);
      const reach = (x: number, z: number) => {
        const a = Math.atan2(z - sq.z, x - sq.x);
        let t = 0;
        while (t < sq.r + 22 && !hit(sq.x + Math.cos(a) * t, sq.z + Math.sin(a) * t)) t += 0.25;
        return st.style === 'farm' ? sq.r + 2.8 : t < sq.r + 22 ? t : sq.r + 9;
      };
      for (const i of s.items.filter(solid)) {
        for (const [x, z] of [...corners(i), [i.x, i.z]]) expect(Math.hypot(x - sq.x, z - sq.z), `${s.id}: a ${i.t} on the square's paving`).toBeGreaterThan(reach(x, z) - 0.05);
      }
    }
  });

  it("keeps every footprint 1 m and every door 1.5 m from H1's streetlights, and stands the quay's props on its apron", () => {
    const poles = lampLayout(region, 0, 0).map((l) => l.q);
    for (const s of sites) {
      const st = region.settlements.find((x) => x.id === s.id);
      const near = poles.filter((q) => q.x * s.dir.x + q.y * s.dir.y + q.z * s.dir.z > Math.cos((s.r + 20) / 160)).map((q) => dirToChart(s.chart, q, { x: 0, z: 0 }));
      for (const i of s.items.filter(solid)) {
        const o = doorOff(i.t, i.s, i.w), ca = Math.cos(i.a), sa = Math.sin(i.a);
        for (const p of near) {
          expect(rectDist(i, p.x, p.z), `${s.id}: a ${i.t} against a lamp`).toBeGreaterThan(0.95);
          if (o === o) expect(Math.hypot(i.x + o * ca + (i.d / 2) * sa - p.x, i.z + o * sa - (i.d / 2) * ca - p.z), `${s.id}: a ${i.t}'s door at a lamp`).toBeGreaterThan(1.5);
        }
      }
      // (the quay's: within 4 m of its sea wall; a boatyard's crates stand on the ground by its turning circle)
      const w = st?.wall;
      if (w) {
        const wall = toPoly(st.chart, { dir: w.dir, h: w.top } as unknown as Parameters<typeof toPoly>[1], 0, 0);
        for (const i of s.items.filter((x) => (x.t === T.crates || x.t === T.crane) && polyDist(wall, x.x, x.z) < 4)) expect(i.y, `${s.id}: a ${i.t} sunk in the apron`).toBeCloseTo(padHeight(st, i.x, i.z) + QUAY_H, 3);
      }
    }
  });

  it('stands the airports on dry ground and the moored boats in deep water', () => {
    for (const a of sites.filter((s) => s.style === 'airport')) for (const i of a.items.filter(solid)) for (const [x, z] of corners(i)) expect(planet.heightAt(siteDir(a, x, z)), `${a.id} ${i.t} in the water`).toBeGreaterThan(0.1);
    for (const s of towns) for (const b of s.items.filter((i) => i.t === T.boat)) for (const [x, z] of corners(b)) expect(planet.heightAt(siteDir(s, x, z)), `${s.id}: a boat aground`).toBeLessThan(-0.6);
  });

  it('never lets two buildings overlap', () => {
    for (const s of sites) {
      const b = s.items.filter(solid);
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) expect(overlap(b[i], b[j]), `${s.id}: ${b[i].t} × ${b[j].t}`).toBe(false);
    }
  });

  it('is deterministic', () => {
    const again = planTowns(region, (d) => planet.heightAt(d));
    const key = (ss: Site[]) => JSON.stringify(ss.map((s) => [s.id, s.items, s.lift]));
    expect(key(again)).toBe(key(sites));
    expect(F.front).toBe(1);
  });
});
