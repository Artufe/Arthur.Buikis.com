// @vitest-environment node
// The region's invariants (V2.md §3, R1): settlements on flat pads blended into the terrain, each
// with its own street plan by style; roads on land and graded, smooth, never crossing; bridges with
// clearance and abutments; every road ending at a destination; a transit graph that is continuous,
// drivable (no sliver edges, no connector tighter than a car can turn) and strongly connected per land
// mass; a ferry over deep water; flat runways with clear glide-slope approaches; the capital untouched;
// determinism and the build budget.

import { describe, expect, it } from 'vitest';
import { withNativeMath } from '../../../../tests/deterministic-math';
import { terrainData } from '../../terrain/data';
import { icoHeights } from '../ico-heights';
import { icosphere } from '../icosphere';
import { findLandmarks } from '../../nature/landmarks';
import { CITY_AXIS, SHELL_R, scatterClusters } from '../../clouds/layout';
import { CITY_LAT, CITY_LON, CITY_PLAN_RADIUS, CITY_SURFACE_R, PLATEAU_HEIGHT, PLATEAU_RADIUS, R, ROAD_H, SEED } from '../config';
import { getCityPlan } from '../city';
import { GATE_CIRCLE_R } from '../city/layout';
import { Biome, createPlanet, getPlanet } from '../planet';
import { angleBetween, chartToDir, dirFromLatLon, dirToChart, v3, type Vec3 } from '../sphere';
import { sunDirection } from '../sun';
import type { Memo } from './bake';
import { BLEND_EDGE, BRIDGE_MIN, BRIDGE_WET, DECK_MIN, FERRY_DEPTH, GLIDE, MAX_GRADE, TOWN_APART, TOWN_GAP } from './build';
import { awayTangent, step } from './geo';
import { getRegion } from './index';
import { laneSCCs, minRadius } from './network';
import { wmaxGap, wnearest, wsample, wsampleOut } from './path';
import { cutDist, padDist, padHeight } from './pad';
import { faceDistance, planDistance, planFaces, planSymmetry, QUAY_SET, type TownPlan } from './towns';
import { KEEP, KEEP_ALL, KEEP_MARGIN_MAX, WALL_FOOT, type Region, type SurfaceHit, type WPath } from './types';

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
/** Inside a declared abutment box (types.ts BridgeAbutment: H1 clads it), with 0.5 m of tolerance. */
const inAbutment = (q: Vec3) => {
  for (const b of region.bridges) {
    for (const ab of b.abutments) {
      const dx = q.x - ab.dir.x, dy = q.y - ab.dir.y, dz = q.z - ab.dir.z;
      const along = (dx * ab.into.x + dy * ab.into.y + dz * ab.into.z) * R;
      const rx = ab.into.y * ab.dir.z - ab.into.z * ab.dir.y, ry = ab.into.z * ab.dir.x - ab.into.x * ab.dir.z, rz = ab.into.x * ab.dir.y - ab.into.y * ab.dir.x;
      const lat = (dx * rx + dy * ry + dz * rz) * R;
      if (along >= -ab.back - 0.5 && along <= ab.depth + 0.5 && Math.abs(lat) <= ab.half + 0.5) return true;
    }
  }
  return false;
};


describe('region: settlements and pads', () => {
  it('has the capital and eight towns of five styles on two land masses', () => {
    const styles = region.settlements.map((s) => s.style);
    expect(styles[0]).toBe('capital');
    for (const st of ['harbour', 'farm', 'alpine', 'resort', 'metro'] as const) expect(styles).toContain(st);
    expect(towns.length).toBeGreaterThanOrEqual(8);
    expect(new Set(region.settlements.map((s) => s.id)).size).toBe(region.settlements.length);
    for (const s of region.settlements) expect(s.name).toBe(s.name.toLowerCase());
    expect(region.components.length).toBe(2);
    const far = towns.filter((s) => s.component !== region.settlements[0].component);
    // the far continent has a city and two more settlements, joined by road
    expect(far.map((s) => s.style)).toContain('metro');
    expect(far.length).toBeGreaterThanOrEqual(3);
    // pads sized to their kind (v2 R2): towns 24–34 m, villages ≥ 18 m, the second city ≥ 45 m
    for (const s of towns) {
      if (s.kind === 'city') expect(s.padR, s.id).toBeGreaterThanOrEqual(45);
      else if (s.kind === 'town') {
        expect(s.padR, s.id).toBeGreaterThanOrEqual(24);
        expect(s.padR, s.id).toBeLessThanOrEqual(34);
      } else expect(s.padR, s.id).toBeGreaterThanOrEqual(18);
    }
  });

  it('sets every pad on its plane (±0.05 m) to its edge, on land, blended into the terrain with no cliff', { timeout: 60000 }, () => {
    for (const s of towns) {
      let wetCore = 0;
      let n = 0;
      for (let i = 0; i < 160; i++) {
        const a = i * 2.399;
        const r = Math.sqrt(i / 159) * s.padR;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        // (a waterfront pad is the disc minus its cut: the quay's sea wall, the beach below the promenade;
        // the wall's block over the depth inside its face is the wall's deck, the ground ramps down under it)
        if (padDist(s, x, z) > -0.3) continue;
        if (s.wall && cutDist(s, x, z) > -s.wall.depth) continue;
        const d = chartToDir(s.chart, x, z);
        // flat, or on its one gentle plane (a hillside town's terraces, an alpine village's slope)
        expect(Math.abs(planet.heightAt(d) - padHeight(s, x, z)), `${s.id} at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBeLessThanOrEqual(0.05);
        if (planet.baseHeightAt(d) < 0) wetCore++;
        n++;
      }
      expect(s.grade).toBeLessThanOrEqual(0.08);
      // pads stand on land (a harbour's quay may be won from the shallows at its edge)
      expect(wetCore / n, s.id).toBeLessThan(s.style === 'harbour' ? 0.3 : 0.1);
      // across the blend ring, along 96 rays from the pad's edge (v2 R2 refine: 32 missed a spot): no
      // step, and on land no bank steeper than ~42°, or than a little more than the natural slope there
      // (a cut into a mountainside stays a slope); a sea wall drops straight into the water (below 0.3 m:
      // no step over ~4 m per m)
      for (let k = 0; k < 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        let r0 = 0;
        while (r0 < s.padR + 0.5 && padDist(s, ca * r0, sa * r0) < 0) r0 += 0.25;
        let d0 = chartToDir(s.chart, ca * r0, sa * r0);
        let prev = planet.heightAt(d0);
        let prevB = planet.baseHeightAt(d0);
        for (let r = r0 + 0.5; r <= s.padR + s.blend + 14; r += 0.5) {
          d0 = chartToDir(s.chart, ca * r, sa * r);
          const h = planet.heightAt(d0);
          const b = planet.baseHeightAt(d0);
          const slope = Math.abs(h - prev) / 0.5;
          const natural = Math.abs(b - prevB) / 0.5;
          // (a road's own banks out here are the road's: spec'd in 'carves continuously')
          const roadBank = region.surface(d0, hit).roadDist < 13;
          // (a sea wall: within 3 m of the edge where the shore is low, the quay drops into the water)
          const wall = s.cut?.wall && r - r0 < 3 && Math.min(b, prevB) < 0.8;
          // (a bridge's abutment face is built, not banked: inside its declared box H1 clads it)
          const abutment = inAbutment(d0);
          if (h > 0.3 && prev > 0.3 && !roadBank && !wall && !abutment) expect(slope, `${s.id} ray ${k} at ${r}`).toBeLessThan(Math.max(0.9, natural * 1.2 + 0.6));
          if (!(s.cut?.wall && Math.min(h, prev) < 0.3) && !abutment) expect(slope, `${s.id} ray ${k} at ${r}`).toBeLessThan(Math.max(4, natural + 1));
          prev = h;
          prevB = b;
        }
      }
    }
  });

  it('builds the harbours to the water: a quay at the waterline with the sea below it, a pier over the sea', () => {
    for (const s of towns.filter((t) => t.style === 'harbour' || t.cut?.wall)) {
      const q = s.quay!;
      expect(q.length).toBeGreaterThan(10);
      let wetBelow = 0;
      const pts = q.length / 2;
      for (let i = 0; i < pts; i++) {
        const x = q[i * 2], z = q[i * 2 + 1];
        // the quay's edge ≈ 1 m over the sea (boats moor alongside), the land side never a terrace
        const top = padHeight(s, x, z);
        expect(top, s.id).toBeGreaterThan(0.5);
        expect(top, s.id).toBeLessThan(1.6);
        // 2 m out from the edge, square to the axis, it is water
        const ax = Math.sin(s.heading), az = -Math.cos(s.heading);
        if (planet.heightAt(chartToDir(s.chart, x + ax * 2, z + az * 2)) < 0) wetBelow++;
      }
      expect(wetBelow / pts, s.id).toBeGreaterThan(0.7);
    }
    // every harbour pier stands over the water past its first metre
    for (const p of region.piers) {
      const s = region.settlements[p.settlement];
      if (s.style !== 'harbour') continue;
      const L = arcM(p.root, p.berth);
      for (let f = 1.5 / L; f <= 1; f += 0.5 / L) {
        const d = v3(p.root.x + (p.berth.x - p.root.x) * f, p.root.y + (p.berth.y - p.root.y) * f, p.root.z + (p.berth.z - p.root.z) * f);
        const l = Math.hypot(d.x, d.y, d.z);
        expect(planet.heightAt(v3(d.x / l, d.y / l, d.z / l)), `${s.id} pier at ${(f * L).toFixed(1)} m`).toBeLessThan(0);
      }
    }
  });

  it('publishes every sea wall for H1, paves its apron and dresses its footing in stone (no sand or grass vertex beside it)', () => {
    const walled = towns.filter((t) => t.cut?.wall);
    expect(walled.length).toBeGreaterThanOrEqual(3);
    for (const s of walled) {
      const w = s.wall!;
      expect(w, s.id).toBeDefined();
      expect(w.line, s.id).toBe(s.quay);
      const n = w.line.length / 2;
      expect(w.top.length).toBe(n);
      expect(w.dir.length).toBe(n * 3);
      expect(w.foot).toBeLessThan(-1);
      expect(Math.hypot(w.nx, w.nz)).toBeCloseTo(1, 6);
      expect(w.apron).toBeGreaterThan(w.coping);
      // the apron reaches the quay street's carriageway (QUAY_SET inside the line, half a 5 m street)
      expect(w.apron).toBeGreaterThanOrEqual(QUAY_SET - 2.5);
      // (v2 R2 refine 2) a solid block ≥ 3.5 m deep, the apron on it
      expect(w.depth).toBeGreaterThanOrEqual(3.5);
      expect(w.depth).toBeGreaterThan(w.apron);
      let land = 0;
      let landOk = 0;
      let sea = 0;
      let seaOk = 0;
      for (let i = 0; i < n; i++) {
        const x = w.line[i * 2], z = w.line[i * 2 + 1];
        expect(w.top[i]).toBeCloseTo(padHeight(s, x, z), 4);
        const d = v3(w.dir[i * 3], w.dir[i * 3 + 1], w.dir[i * 3 + 2]);
        expect(arcM(d, chartToDir(s.chart, x, z))).toBeLessThan(1e-3);
        // (inside the disc only: the line's ends meet the pad's rim)
        if (Math.hypot(x, z) > s.padR - 1.5) continue;
        // the apron is paved ('plaza', KEEP.plaza), the pad beyond it is not
        for (const off of [0.6, 1.5, w.apron - 0.4]) {
          const q = chartToDir(s.chart, x - w.nx * off, z - w.nz * off);
          expect(region.surface(q, hit).cls, `${s.id} apron ${off} m in`).toBe('plaza');
          expect(region.keepOut(q, 0, KEEP.plaza), `${s.id} apron keep-out`).toBe(true);
        }
        const inner = chartToDir(s.chart, x - w.nx * (w.apron + 1.5), z - w.nz * (w.apron + 1.5));
        expect(region.surface(inner, hit).cls, `${s.id} behind the apron`).toBe('pad');
        // no terrain vertex beside the wall is sand or grass: ±1.5 terrain cells (WALL_BAND) of dressed
        // stone either side (a facet takes its corners' majority biome: both rows must be stone)
        for (const off of [0.5, 1.5, 2.8, 4.2]) {
          const q = chartToDir(s.chart, x + w.nx * off, z + w.nz * off);
          const h = planet.heightAt(q);
          if (h < WALL_FOOT - 0.6) continue;
          sea++;
          if (planet.biomeAt(q, h) === Biome.Rock) seaOk++;
        }
        for (const off of [0.4, 1.5, 2.6, w.depth - 0.2]) {
          land++;
          const q = chartToDir(s.chart, x - w.nx * off, z - w.nz * off);
          if (planet.biomeAt(q) === Biome.Rock) landOk++;
          // under the block the ground ramps down from its deck toward the face, never above it
          expect(planet.heightAt(q), `${s.id} under the block ${off} m in`).toBeLessThanOrEqual(padHeight(s, x - w.nx * off, z - w.nz * off) + 0.05);
        }
        expect(planet.heightAt(chartToDir(s.chart, x - w.nx * 0.1, z - w.nz * 0.1)), `${s.id} at the face`).toBeLessThan(0);
      }
      expect(sea, s.id).toBeGreaterThan(8);
      expect(seaOk, `${s.id} stone seaward`).toBe(sea);
      expect(landOk, `${s.id} stone inland`).toBe(land);
    }
    // a beach has no wall
    for (const s of towns) if (s.cut && !s.cut.wall) expect(s.wall, s.id).toBeUndefined();
  });

  it('keeps the terrain mesh behind every sea wall: at either terrain detail no facet stands above −0.2 m more than 0.1 m out from its face', { timeout: 120000 }, () => {
    // (each facet rasterised exactly: it is planar in height, so its highest point past the face is a
    // corner of the facet clipped to the stretch in front of the face — 0.1 to 8 m out, along the
    // line short of its last 1.5 m, where it meets the pad's rim)
    for (const detail of [6, 5]) {
      const ico = icosphere(detail);
      const H = icoHeights(planet, detail);
      const P = ico.positions;
      const I = ico.indices;
      for (const s of towns) {
        const w = s.wall;
        if (!w) continue;
        const L = w.line;
        const m = L.length;
        const ex = L[m - 2] - L[0], ez = L[m - 1] - L[1];
        const len = Math.hypot(ex, ez);
        const cosR = Math.cos((s.padR + 15) / R);
        let facets = 0;
        let worst = -Infinity;
        for (let f = 0; f < ico.triangleCount; f++) {
          const a = I[f * 3];
          if (P[a * 3] * s.dir.x + P[a * 3 + 1] * s.dir.y + P[a * 3 + 2] * s.dir.z < cosR) continue;
          // corners as (u along the line, c out from the face, h)
          let poly: number[][] = [];
          for (let k = 0; k < 3; k++) {
            const vi = I[f * 3 + k];
            const q = dirToChart(s.chart, v3(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]));
            poly.push([((q.x - L[0]) * ex + (q.z - L[1]) * ez) / len, cutDist(s, q.x, q.z), H[vi]]);
          }
          const clip = (ax: 0 | 1, v: number, keepAbove: boolean) => {
            const out: number[][] = [];
            for (let k = 0; k < poly.length; k++) {
              const p = poly[k], q = poly[(k + 1) % poly.length];
              const pin = keepAbove ? p[ax] >= v : p[ax] <= v;
              const qin = keepAbove ? q[ax] >= v : q[ax] <= v;
              if (pin) out.push(p);
              if (pin !== qin) {
                const t = (v - p[ax]) / (q[ax] - p[ax]);
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
              }
            }
            poly = out;
          };
          clip(1, 0.1, true);
          if (poly.length) clip(1, 8, false);
          if (poly.length) clip(0, 1.5, true);
          if (poly.length) clip(0, len - 1.5, false);
          if (!poly.length) continue;
          facets++;
          for (const p of poly) worst = Math.max(worst, p[2]);
        }
        expect(facets, `${s.id} detail ${detail}`).toBeGreaterThan(10);
        expect(worst, `${s.id} detail ${detail}: highest facet point past the face`).toBeLessThanOrEqual(-0.2);
      }
    }
  });

  it('stands every town apart: its pad well clear of the plateau and of the other towns; the windmills and the lighthouse where they were', { timeout: 60000 }, () => {
    for (let i = 0; i < towns.length; i++) {
      // its own silhouette, not a suburb (V2 §1.1): a strip of countryside between its pad and the
      // capital's plateau, and between it and any other town
      // (v2 R2: measured from the plateau's OUTER blend edge, where the countryside begins)
      expect(angleBetween(towns[i].dir, planet.cityDir) * R - towns[i].padR - BLEND_EDGE, towns[i].id).toBeGreaterThanOrEqual(TOWN_GAP);
      for (let j = i + 1; j < towns.length; j++) expect(arcM(towns[i].dir, towns[j].dir) - towns[i].padR - towns[j].padR).toBeGreaterThanOrEqual(TOWN_APART);
      // (v2 R2 refine) and untouched countryside between the blend rings too: ≥ 20 m from ring edge to
      // ring edge, the plateau's included (measured 22.6 m at the closest pair, port pebble / millbrook)
      expect(angleBetween(towns[i].dir, planet.cityDir) * R - towns[i].padR - towns[i].blend - BLEND_EDGE, `${towns[i].id} ring / plateau`).toBeGreaterThanOrEqual(20);
      for (let j = i + 1; j < towns.length; j++) expect(arcM(towns[i].dir, towns[j].dir) - towns[i].padR - towns[i].blend - towns[j].padR - towns[j].blend, `${towns[i].id} / ${towns[j].id} rings`).toBeGreaterThanOrEqual(20);
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

  // The review views. A camera `alt` m over unit `cam` (above the plateau's height, as the shots fly):
  // how face-on it sees the ground at unit `d` (1 = straight down, 0 = on the limb).
  const facing = (d: Vec3, cam: Vec3, alt = 380) => {
    const cr = R + alt + PLATEAU_HEIGHT;
    const cx = cam.x * cr - d.x * R, cy = cam.y * cr - d.y * R, cz = cam.z * cr - d.z * R;
    return (cx * d.x + cy * d.y + cz * d.z) / Math.hypot(cx, cy, cz);
  };
  const sunEl = (d: Vec3, t: number) => {
    const sun = sunDirection(t);
    return (Math.asin(d.x * sun.x + d.y * sun.y + d.z * sun.z) * 180) / Math.PI;
  };
  // The cloud layer's scatter (clouds/layout.ts; its anchors sit by the dive and over the capital)
  // turns about the capital's axis at 0.25°/s (clouds/index.ts): the clearance (m, at the shell) of
  // the line of sight from the camera to a town's pad (its centre and six points round it) at time t.
  const scatter = scatterClusters(SEED, 30);
  const cloudClear = (s: (typeof towns)[number], cam: Vec3, t: number, alt = 380) => {
    const D = R + alt + PLATEAU_HEIGHT;
    const back = (-0.25 * Math.PI * t) / 180;
    const k = CITY_AXIS;
    let min = Infinity;
    for (let i = -1; i < 6; i++) {
      const m = Math.min(30, s.padR) * 0.6;
      const p = i < 0 ? s.dir : chartToDir(s.chart, Math.cos((i / 6) * Math.PI * 2) * m, Math.sin((i / 6) * Math.PI * 2) * m);
      const ex = p.x * (R + s.h) - cam.x * D, ey = p.y * (R + s.h) - cam.y * D, ez = p.z * (R + s.h) - cam.z * D;
      const l = Math.hypot(ex, ey, ez);
      const ux = ex / l, uy = ey / l, uz = ez / l;
      const bq = (cam.x * ux + cam.y * uy + cam.z * uz) * D;
      const disc = bq * bq - (D * D - SHELL_R * SHELL_R);
      if (disc <= 0) continue;
      const tt = -bq - Math.sqrt(disc);
      const hx = cam.x * D + ux * tt, hy = cam.y * D + uy * tt, hz = cam.z * D + uz * tt;
      const hl = Math.hypot(hx, hy, hz);
      const v = v3(hx / hl, hy / hl, hz / hl);
      // (where the layer was at t = 0: turned back about the axis, Rodrigues)
      const c = Math.cos(back), sn = Math.sin(back), kd = k.x * v.x + k.y * v.y + k.z * v.z;
      const w = v3(v.x * c + (k.y * v.z - k.z * v.y) * sn + k.x * kd * (1 - c), v.y * c + (k.z * v.x - k.x * v.z) * sn + k.y * kd * (1 - c), v.z * c + (k.x * v.y - k.y * v.x) * sn + k.z * kd * (1 - c));
      for (const cl of scatter) min = Math.min(min, angleBetween(w, cl.dir) * SHELL_R - cl.radius);
    }
    return min;
  };
  it('shows two towns besides the capital clearly from the orbit shot: face-on, in daylight, under no cloud', () => {
    // core/shots.ts `orbit` (v2 R2 refine 2): 380 m over (CITY_LAT − 18, CITY_LON − 25) at t = 468 —
    // nudged west and south so the western towns sit nearer the middle of the disc — the capital still
    // face-on (not on the limb) in its afternoon, port pebble and millbrook on the western lands under
    // no cloud, the dusk on the right limb
    const cam = dirFromLatLon(CITY_LAT - 18, CITY_LON - 25);
    const t = 468;
    expect(facing(planet.cityDir, cam), JSON.stringify(towns.map((s) => [s.id, facing(s.dir, cam).toFixed(2)]))).toBeGreaterThan(0.7);
    expect(sunEl(planet.cityDir, t)).toBeGreaterThan(30);
    const clear = towns.filter((s) => facing(s.dir, cam) > 0.6 && sunEl(s.dir, t) > 12 && cloudClear(s, cam, t) > 1);
    expect(clear.map((s) => s.id).length, JSON.stringify(towns.map((s) => [s.id, facing(s.dir, cam).toFixed(2), sunEl(s.dir, t).toFixed(0), cloudClear(s, cam, t).toFixed(1)]))).toBeGreaterThanOrEqual(2);
    // the game's opening view straight over the city (camera/index.ts) has towns in daylight on its
    // western limb (all of them stand ≥ TOWN_GAP of countryside out from the plateau)
    const start = dirFromLatLon(CITY_LAT, CITY_LON);
    expect(towns.filter((s) => facing(s.dir, start) > 0.08 && sunEl(s.dir, 0) > 5).length, JSON.stringify(towns.map((s) => [s.id, facing(s.dir, start).toFixed(2), sunEl(s.dir, 0).toFixed(0)]))).toBeGreaterThanOrEqual(2);
  });

  it('keeps every town, waterfront, region and globe shot clear of cloud over the towns it is for', async () => {
    // (core/shots.ts is review tooling: the kit filled first, core/kit-fill.ts)
    await import('../../core/kit-fill');
    const { SHOTS } = await import('../../core/shots');
    // (v2 R2 refine 2: the critic found clouds over town-driftwood, town-far-haven, region-west and
    // globe-270: each shot's line of sight to its town — or, from higher up, to every town it holds
    // face-on — clears the cloud layer at the shot's time, as the orbit shot's does)
    const ctx = { world: { region } } as unknown as Parameters<(typeof SHOTS)[string]['view']>[0];
    const bad: string[] = [];
    for (const [name, def] of Object.entries(SHOTS)) {
      const m = /^(town|quay|beach|region|globe)-(.*)$/.exec(name);
      if (!m) continue;
      const v = def.view(ctx);
      const t = typeof def.t === 'function' ? def.t(v) : (def.t ?? 0);
      const cam = dirFromLatLon(v.lat, v.lon);
      const alt = v.alt;
      const own = towns.find((x) => x.id === m[2]);
      const held = own && m[1] !== 'region' && m[1] !== 'globe' ? [own] : towns.filter((x) => facing(x.dir, cam) > (m[1] === 'globe' ? 0.6 : 0.85));
      for (const x of held) {
        const c = cloudClear(x, cam, t, alt);
        if (!(c > 1)) bad.push(`${name}: ${x.id} ${c.toFixed(1)} m`);
      }
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('leaves no side of the globe empty: from 380 m over the equator every 45° and over both poles, a settlement in view', () => {
    // (core/shots.ts globe-*: v2 R2 refine, the critic's rule — every view holds a settlement's pad
    // face-on (> 0.5, within ~70° of its nadir), not just a road: its nearest point counts, so the
    // capital's plateau answers for the north pole)
    const toward = (a: Vec3, b: Vec3, m: number) => {
      const f = Math.min(1, m / R / Math.max(1e-9, angleBetween(a, b)));
      const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, z = a.z + (b.z - a.z) * f;
      const l = Math.hypot(x, y, z);
      return v3(x / l, y / l, z / l);
    };
    const views = [...Array.from({ length: 8 }, (_, k) => dirFromLatLon(0, ((k * 45 + 180) % 360) - 180)), dirFromLatLon(89.5, CITY_LON), dirFromLatLon(-89.5, CITY_LON)];
    for (const cam of views) {
      const best = Math.max(facing(toward(planet.cityDir, cam, PLATEAU_RADIUS * R), cam), ...towns.map((s) => facing(toward(s.dir, cam, s.padR), cam)));
      expect(best, JSON.stringify(cam)).toBeGreaterThan(0.5);
      // and a town's centre well inside the view on every equator bearing (not the capital's rim alone)
      if (Math.abs(cam.y) < 0.5) expect(Math.max(facing(planet.cityDir, cam), ...towns.map((s) => facing(s.dir, cam))), JSON.stringify(cam)).toBeGreaterThan(0.5);
    }
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
  /** A town's street network back in its own chart (plan x, z), for the shape metrics in towns.ts. */
  const planOf = (s: (typeof towns)[number]): TownPlan => {
    const local = new Map<number, number>();
    const nodes: TownPlan['nodes'] = [];
    const at = (id: number) => {
      if (!local.has(id)) {
        const q = dirToChart(s.chart, region.nodes[id].dir);
        local.set(id, nodes.length);
        nodes.push({ s: q.x, f: q.z, place: region.nodes[id].place });
      }
      return local.get(id)!;
    };
    const o = wsampleOut();
    const edges = s.streets.map((id) => {
      const e = region.edges[id];
      const pts: number[] = [];
      const push = (d: Vec3) => {
        const q = dirToChart(s.chart, d);
        pts.push(q.x, q.z);
      };
      push(region.nodes[e.a].dir);
      for (let t = 0; t <= e.centre.length; t += 0.5) {
        wsample(e.centre, Math.min(t, e.centre.length), o);
        push(v3(o.dx, o.dy, o.dz));
      }
      push(region.nodes[e.b].dir);
      return { a: at(e.a), b: at(e.b), pts, kind: e.kind === 'lane' ? ('lane' as const) : ('street' as const), name: e.name };
    });
    return { nodes, edges, exits: [] };
  };
  const plans = new Map(towns.map((s) => [s.id, planOf(s)]));
  /** The street along a waterfront: the quay's points within a sidewalk of a street (by geometry, not by name). */
  const alongQuay = (s: (typeof towns)[number], within = QUAY_SET + 1.5) => {
    const q = s.quay!;
    const streets = s.streets.map((id) => region.edges[id]);
    let along = 0;
    // (a junction's patch is street too: its centre stands for the centreline trimmed back from it)
    const nodes = s.nodes.map((id) => region.nodes[id]).filter((n) => n.kind === 'junction');
    for (let i = 0; i < q.length; i += 2) {
      const d = chartToDir(s.chart, q[i], q[i + 1]);
      if (Math.min(...streets.map((e) => wnearest(e.centre, d, { dist: 0, s: 0 })), ...nodes.map((n) => arcM(n.dir, d))) < within) along++;
    }
    return along / (q.length / 2);
  };
  /**
   * A plan's shape signature: its streets' headings (12 bins over 180°, by length, sampled every 2 m)
   * and their turning (the heading change per 2 m: < 2°, < 5°, < 10°, < 20°, more), each a distribution.
   */
  const signature = (plan: TownPlan) => {
    const H = new Array<number>(12).fill(0);
    const T = new Array<number>(5).fill(0);
    for (const e of plan.edges) {
      const p = e.pts;
      const S = [0];
      for (let i = 2; i < p.length; i += 2) S.push(S[S.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]));
      const at = (sv: number): [number, number] => {
        let i = 1;
        while (i < S.length - 1 && S[i] < sv) i++;
        const u = (sv - S[i - 1]) / Math.max(1e-9, S[i] - S[i - 1]);
        return [p[(i - 1) * 2] + (p[i * 2] - p[(i - 1) * 2]) * u, p[(i - 1) * 2 + 1] + (p[i * 2 + 1] - p[(i - 1) * 2 + 1]) * u];
      };
      let prev = at(0);
      let hPrev = NaN;
      for (let k = 1; k * 2 <= S[S.length - 1]; k++) {
        const q = at(k * 2);
        const h = Math.atan2(q[1] - prev[1], q[0] - prev[0]);
        H[Math.floor((((h % Math.PI) + Math.PI) % Math.PI) / (Math.PI / 12)) % 12]++;
        if (!Number.isNaN(hPrev)) {
          const tt = (Math.abs(Math.atan2(Math.sin(h - hPrev), Math.cos(h - hPrev))) * 180) / Math.PI;
          T[tt < 2 ? 0 : tt < 5 ? 1 : tt < 10 ? 2 : tt < 20 ? 3 : 4]++;
        }
        hPrev = h;
        prev = q;
      }
    }
    const nh = H.reduce((a, b) => a + b, 0), nt = T.reduce((a, b) => a + b, 0);
    return { H: H.map((x) => x / nh), T: T.map((x) => x / nt) };
  };
  /** L1 between two signatures, the headings' best over every turn (15° steps) and flip. */
  const signatureDistance = (a: ReturnType<typeof signature>, b: ReturnType<typeof signature>) => {
    let best = Infinity;
    for (const flip of [false, true]) {
      const hb = flip ? [...b.H].reverse() : b.H;
      for (let sh = 0; sh < 12; sh++) best = Math.min(best, a.H.reduce((L, x, i) => L + Math.abs(x - hb[(i + sh) % 12]), 0));
    }
    return best + a.T.reduce((L, x, i) => L + Math.abs(x - b.T[i]), 0);
  };

  it('gives every town a main street, a square, side streets, by its style', () => {
    for (const s of towns) {
      expect(s.streets.length).toBeGreaterThanOrEqual(4);
      expect(s.square).toBeDefined();
      const streets = s.streets.map((id) => region.edges[id]);
      const nodes = s.nodes.map((id) => region.nodes[id]);
      const ends = nodes.filter((n) => n.kind === 'end').length;
      const juncs = nodes.filter((n) => n.kind === 'junction');
      // (v2 R2 refine 2: not thin: ≥ 6 nodes a town, ≥ 5 a village; ≥ 1.6 quarter-circles of its pad's
      // radius of street between the patches; a second order of lanes under the streets, ≥ 2 (≥ 4 at
      // port pebble, the biggest harbour), every dead-end lane ≥ 6 m long between its patches)
      expect(nodes.length, s.id).toBeGreaterThanOrEqual(s.kind === 'village' ? 5 : 6);
      expect(streets.reduce((L, e) => L + e.centre.length, 0), s.id).toBeGreaterThanOrEqual((1.6 * s.padR * Math.PI) / 2);
      if (s.style !== 'metro') expect(streets.filter((e) => e.kind === 'lane').length, s.id).toBeGreaterThanOrEqual(s.id === 'port-pebble' ? 4 : 2);
      for (const e of streets) if (e.kind === 'lane' && (region.nodes[e.a].kind === 'end' || region.nodes[e.b].kind === 'end')) expect(e.centre.length, `${s.id} ${e.name}`).toBeGreaterThanOrEqual(6);
      // its yards (T1's farmyards, boatyards, villas …): each at a dead end, its circle covering the
      // turning circle there
      for (const y of s.yards ?? []) {
        const n = region.nodes[y.node];
        expect(n.kind, `${s.id} ${y.kind}`).toBe('end');
        expect(s.nodes).toContain(y.node);
        expect(y.r).toBeGreaterThanOrEqual(n.turnR);
        expect(arcM(chartToDir(s.chart, y.x, y.z), n.dir)).toBeLessThan(0.05);
      }
      // a main street ≥ 14 m in from a gate to the first junction (centre to centre; a city's is its
      // boulevard, from its back gate)
      let mainLen = 0;
      for (const gid of s.gates) {
        const g = region.nodes[gid];
        for (const e of streets.filter((x) => x.a === g.id || x.b === g.id)) mainLen = Math.max(mainLen, e.centre.length + g.radius + region.nodes[e.a === g.id ? e.b : e.a].radius);
      }
      expect(mainLen, s.id).toBeGreaterThan(13.9);
      expect(juncs.length, s.id).toBeGreaterThanOrEqual(2);
      if (s.style === 'harbour') {
        // a street along the water, the pier off it (from a street's end on the quay, or its side)
        expect(s.quay?.length).toBeGreaterThan(10);
        expect(s.piers.length).toBe(1);
        expect(alongQuay(s), s.id).toBeGreaterThan(0.4);
        const pier = region.piers[s.piers[0]];
        if (pier.node >= 0) {
          const pierNode = region.nodes[pier.node];
          expect(['pier', 'junction']).toContain(pierNode.place);
          expect(s.nodes).toContain(pier.node);
          expect(arcM(pier.root, pierNode.dir)).toBeLessThan(QUAY_SET + 0.6);
        } else expect(Math.min(...streets.map((e) => wnearest(e.centre, pier.root, { dist: 0, s: 0 })))).toBeLessThan(QUAY_SET + 0.6);
      }
      // a farm village: farm lanes out to their yards (dead ends), round a green or strung along its lane
      if (s.style === 'farm') {
        expect(ends, s.id).toBeGreaterThanOrEqual(1);
        expect((s.yards ?? []).filter((y) => y.kind === 'farm').length, s.id).toBeGreaterThanOrEqual(1);
      }
      if (s.style === 'alpine') {
        // the high street climbing its slope in switchbacks: terraces along the contours turning back
        // on themselves (≥ 270° of heading between them), the chapel square at the top
        const terraces = streets.filter((e) => /terrace/.test(e.name));
        expect(terraces.length).toBeGreaterThanOrEqual(2);
        let turn = 0;
        for (const e of terraces) {
          const a = wsampleOut();
          const b = wsampleOut();
          for (let q = 0; q + 1 <= e.centre.length; q += 1) {
            wsample(e.centre, q, a);
            wsample(e.centre, q + 1, b);
            turn += Math.acos(Math.min(1, a.tx * b.tx + a.ty * b.ty + a.tz * b.tz));
          }
        }
        expect(turn, s.id).toBeGreaterThan((270 * Math.PI) / 180);
        expect(nodes.some((n) => n.place === 'square')).toBe(true);
      }
      // the resort: its promenade hugging the beach crescent (≥ 70 % of the crescent within 4.5 m of a
      // street's centre: its sidewalk at the sand), the pier off it
      if (s.style === 'resort') {
        expect(alongQuay(s, 4.5), s.id).toBeGreaterThanOrEqual(0.7);
        expect(s.piers.length).toBe(1);
      }
      if (s.style === 'metro') {
        // the warped grid: ≥ 12 junctions, its avenues visibly arcing (≤ 70 m radius, two of them), its
        // blocks unequal (area coefficient of variation ≥ 0.25: they taper toward the docks)
        expect(juncs.length).toBeGreaterThanOrEqual(12);
        const radiusOf = (name: string) => {
          let len = 0, turn = 0;
          const a = wsampleOut(), b = wsampleOut();
          for (const e of streets.filter((x) => x.name === name)) {
            for (let q = 0; q + 1 <= e.centre.length; q += 1) {
              wsample(e.centre, q, a);
              wsample(e.centre, q + 1, b);
              turn += Math.acos(Math.min(1, a.tx * b.tx + a.ty * b.ty + a.tz * b.tz));
              len += 1;
            }
          }
          return len / Math.max(1e-9, turn);
        };
        const names = [...new Set(streets.map((e) => e.name))];
        const avenues = names.filter((n) => streets.filter((e) => e.name === n).reduce((L, e) => L + e.centre.length, 0) > 40 && radiusOf(n) <= 70);
        expect(avenues.length, JSON.stringify(names.map((n) => [n, radiusOf(n).toFixed(0)]))).toBeGreaterThanOrEqual(2);
        const areas = planFaces(plans.get(s.id)!).map((f) => f.area);
        const mean = areas.reduce((x, y) => x + y, 0) / areas.length;
        const cov = Math.sqrt(areas.reduce((x, y) => x + (y - mean) ** 2, 0) / areas.length) / mean;
        expect(areas.length).toBeGreaterThanOrEqual(6);
        expect(cov, JSON.stringify(areas.map((x) => Math.round(x)))).toBeGreaterThanOrEqual(0.25);
      }
    }
    // no lane's name twice within a style
    const lanes = new Map<string, string>();
    for (const s of towns) for (const id of s.streets) {
      const e = region.edges[id];
      if (e.kind !== 'lane' || e.oneWay) continue;
      const key = `${s.style}:${e.name}`;
      expect(lanes.get(key) ?? s.id, key).toBe(s.id);
      lanes.set(key, s.id);
    }
  });

  it('lays every town out organically: never its own mirror image, no two blocks or two towns alike', { timeout: 30000 }, () => {
    for (const s of towns) {
      const plan = plans.get(s.id)!;
      // reflected about any axis through its centroid, the street network lies ≥ 4 m from itself somewhere
      expect(planSymmetry(plan), s.id).toBeGreaterThanOrEqual(4);
      // no two of its blocks congruent (within 1 m, turned or flipped)
      const faces = planFaces(plan);
      for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) expect(faceDistance(faces[i].poly, faces[j].poly), `${s.id} blocks ${i}, ${j}`).toBeGreaterThanOrEqual(1);
    }
    // no two towns share a shape: ≥ 6 m apart, however one is turned or flipped onto the other; and
    // their streets' heading and turning distributions ≥ 0.4 apart (L1, best turn and flip: not the
    // same few curves rearranged)
    const sigs = new Map(towns.map((s) => [s.id, signature(plans.get(s.id)!)]));
    for (let i = 0; i < towns.length; i++) {
      for (let j = i + 1; j < towns.length; j++) {
        expect(planDistance(plans.get(towns[i].id)!, plans.get(towns[j].id)!), `${towns[i].id} / ${towns[j].id}`).toBeGreaterThanOrEqual(6);
        expect(signatureDistance(sigs.get(towns[i].id)!, sigs.get(towns[j].id)!), `${towns[i].id} / ${towns[j].id} signature`).toBeGreaterThanOrEqual(0.4);
      }
    }
  });

  it('keeps junctions street corners, not plazas: a patch ≤ 0.6 × its widest carriageway + 2 m, ≥ 6 m of street between two', () => {
    for (const s of towns) {
      for (const id of s.nodes) {
        const n = region.nodes[id];
        if (n.kind !== 'junction' || n.control === 'roundabout') continue;
        const w = Math.max(...n.edges.map((e) => region.edges[e].width));
        // (a crossing of lanes alone: their right-angle floor √((RHO_TOWN + 1.1)² + 1.1²) ≈ 4.78 m is over
        // 0.6 × 4.4 + 2, so it is held to 4.85)
        expect(n.radius, `${s.id} node ${id} (${n.place})`).toBeLessThanOrEqual(Math.max(0.6 * w + 2, 4.85) + 1e-6);
      }
      for (const id of s.streets) {
        const e = region.edges[id];
        if (region.nodes[e.a].kind === 'junction' && region.nodes[e.b].kind === 'junction') expect(e.centre.length, `${s.id} ${e.name} #${id}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('fills every pad with streets: ≥ 60 % of it within 9 m of a street (T1 builds on the frontages)', () => {
    const q = { dist: 0, s: 0 };
    for (const s of towns) {
      const streets = s.streets.map((id) => region.edges[id]);
      let inside = 0;
      let near = 0;
      for (let x = -s.padR; x <= s.padR; x += 2) {
        for (let z = -s.padR; z <= s.padR; z += 2) {
          if (padDist(s, x, z) > 0) continue;
          inside++;
          const d = chartToDir(s.chart, x, z);
          let best = Infinity;
          for (const e of streets) best = Math.min(best, wnearest(e.centre, d, q));
          if (best <= 9) near++;
        }
      }
      expect(near / inside, s.id).toBeGreaterThanOrEqual(0.6);
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

  it('curves smoothly: roads ≥ 5.5 m radius (the alpine hairpins), streets ≥ 6 m, town lanes ≥ 4.8 m, every traffic lane ≥ 3.5 m', () => {
    for (const e of region.edges) {
      if (e.centre.length < 3) continue;
      const r = minRadius(e.centre, 2);
      // (a town lane 4.4 m wide: its traffic lanes 1.1 m either side of a 4.8 m centreline clear 3.5 m)
      expect(r, `${e.name} #${e.id}`).toBeGreaterThan(e.settlement < 0 && e.kind !== 'ring' ? 5.5 : e.kind === 'lane' ? 4.8 : 6);
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
        // (the pad: the disc minus its cut)
        if (padDist(s, Math.cos(a) * r, Math.sin(a) * r) > -0.3) continue;
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

  it('runs ferries between piers over deep water, clear of the shore', () => {
    expect(region.piers.length).toBeGreaterThanOrEqual(3);
    // (v2 R2 refine: three boats — port pebble ⇄ far haven, driftwood ⇄ coral cove, puffin bay ⇄ far haven)
    expect(region.ferries.length).toBeGreaterThanOrEqual(3);
    for (const f of region.ferries) {
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
        if (nearBerth > 34) expect(-h, f.name).toBeGreaterThan(FERRY_DEPTH - 0.6);
        else expect(h, f.name).toBeLessThan(-0.25);
      }
    }
    // every pier has a boat
    for (const p of region.piers) expect(region.ferries.some((f) => f.a === p.id || f.b === p.id), region.settlements[p.settlement].id).toBe(true);
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

describe('region: keep-out', () => {
  // 20k seeded points: half within reach of the network (round each pad, along each road, by the
  // runways and the plazas), half anywhere on the globe
  const pts: Vec3[] = [];
  let seed = 0x2545f491;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const near = (c: Vec3, m: number) => {
    const t = awayTangent(c, v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5));
    return step(c, t, Math.sqrt(rnd()) * m);
  };
  for (const s of towns) for (let i = 0; i < 900; i++) pts.push(near(s.dir, s.padR + 20));
  const d0 = v3();
  for (const e of roads) for (let i = 0; i < 260; i++) pts.push(near(dirAt(e.centre, Math.floor(rnd() * e.centre.h.length), d0), 12));
  for (const g of region.gates) for (let i = 0; i < 300; i++) pts.push(near(g.dir, g.r + 12));
  for (const a of region.airports) for (let i = 0; i < 500; i++) pts.push(near(a.centre, 60));
  while (pts.length < 20000) {
    const v = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    pts.push(v3(v.x / l, v.y / l, v.z / l));
  }
  const all = region as Region & { keepOutAll: (d: Vec3, m?: number, mask?: number) => boolean };

  it('agrees with surface() at margin 0: kept out exactly where the ground is not free', () => {
    let kept = 0;
    for (const d of pts) {
      const k = region.keepOut(d, 0, KEEP_ALL & ~KEEP.pier);
      if (k) kept++;
      expect(k, JSON.stringify(d)).toBe(region.surface(d, hit).cls !== 'free');
    }
    expect(kept).toBeGreaterThan(2000);
  });

  it('agrees with a brute-force pass over every primitive for margins up to KEEP_MARGIN_MAX (larger ones clamped)', { timeout: 30000 }, () => {
    for (const m of [0.5, 2, 4, 6, KEEP_MARGIN_MAX]) {
      for (const mask of [KEEP_ALL, KEEP.road, KEEP.pad, KEEP.plaza, KEEP.runway, KEEP.pier]) {
        let diff = 0;
        for (let i = 0; i < pts.length; i += 2) if (region.keepOut(pts[i], m, mask) !== all.keepOutAll(pts[i], m, mask)) diff++;
        expect(diff, `margin ${m}, mask ${mask}`).toBe(0);
      }
    }
    for (let i = 0; i < pts.length; i += 3) expect(region.keepOut(pts[i], 25)).toBe(region.keepOut(pts[i], KEEP_MARGIN_MAX));
  });

  it('answers in ≤ 1 µs a call (zero-alloc), per tree and per frame', () => {
    const slack = Number(process.env.LB_PERF_SLACK ?? 2);
    let n = 0;
    for (const d of pts) if (region.keepOut(d, 3)) n++;
    // (timed on the engine's own Math, what the game runs on; tests/deterministic-math.ts)
    const us = withNativeMath(() => {
      const t0 = performance.now();
      for (let r = 0; r < 5; r++) for (const d of pts) if (region.keepOut(d, 3)) n++;
      return ((performance.now() - t0) * 1000) / (5 * pts.length);
    });
    expect(n).toBeGreaterThan(0);
    expect(us).toBeLessThan(1 * slack);
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
    // (timed on the engine's own Math, what the game runs on; tests/deterministic-math.ts)
    const times: number[] = [];
    withNativeMath(() => {
      for (let i = 0; i < 5; i++) {
        const p = createPlanet(SEED);
        const t0 = performance.now();
        void p.region;
        times.push(performance.now() - t0);
      }
    });
    expect(Math.min(...times)).toBeLessThan(20 * slack);
  });

  it('declares an abutment at each bridge end, and every bank near one steeper than the rule lies inside it', { timeout: 60000 }, () => {
    for (const b of region.bridges) {
      const e = region.edges[b.edge];
      expect(b.abutments.map((a) => a.s)).toEqual([b.s0, b.s1]);
      for (const [k, ab] of b.abutments.entries()) {
        const q = wsample(e.centre, ab.s, wsampleOut());
        expect(arcM(ab.dir, v3(q.dx, q.dy, q.dz))).toBeLessThan(0.01);
        // into the span
        expect((q.tx * ab.into.x + q.ty * ab.into.y + q.tz * ab.into.z) * (k === 0 ? 1 : -1)).toBeGreaterThan(0.99);
        expect(ab.top).toBeCloseTo(q.h, 3);
        expect(ab.foot).toBeLessThan(ab.top - 1);
        expect(ab.half).toBeGreaterThan(e.width / 2);
        // every rule-breaking bank within 14 m of the face (either way, 14 m either side) is inside the box
        const rx = ab.into.y * ab.dir.z - ab.into.z * ab.dir.y, ry = ab.into.z * ab.dir.x - ab.into.x * ab.dir.z, rz = ab.into.x * ab.dir.y - ab.into.y * ab.dir.x;
        const at = (al: number, lat: number) => {
          const p = v3(ab.dir.x + (ab.into.x * al + rx * lat) / R, ab.dir.y + (ab.into.y * al + ry * lat) / R, ab.dir.z + (ab.into.z * al + rz * lat) / R);
          const l = Math.hypot(p.x, p.y, p.z);
          return v3(p.x / l, p.y / l, p.z / l);
        };
        for (let al = -14; al <= 8; al += 0.5) {
          for (let lat = -14; lat <= 14; lat += 0.5) {
            const p = at(al, lat);
            const h = planet.heightAt(p);
            if (h < 0) continue;
            for (const [da, dl] of [[0.5, 0], [0, 0.5], [0.35, 0.35], [0.35, -0.35]]) {
              const p2 = at(al + da, lat + dl);
              const slope = Math.abs(planet.heightAt(p2) - h) / 0.5;
              const nat = Math.abs(planet.baseHeightAt(p2) - planet.baseHeightAt(p)) / 0.5;
              if (slope > Math.max(0.9, 1.2 * nat + 0.6)) expect(inAbutment(p) || inAbutment(p2), `${e.name} ${k ? 'end' : 'start'} at ${al}, ${lat}: ${slope.toFixed(2)}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('banks every road like a pad: off the carriageway on land, no slope over ~42° or a little more than the natural ground', { timeout: 60000 }, () => {
    // (v2 R2, the critic's rule: slope < max(0.9, natural × 1.2 + 0.6), across the road every 3 m out
    // to 26 m either side, on free ground above the sea; between two legs of a hairpin too)
    for (const e of roads) {
      const s = wsampleOut();
      for (let k = 0; k < e.centre.length; k += 3) {
        wsample(e.centre, k, s);
        const rx = s.ty * s.dz - s.tz * s.dy;
        const ry = s.tz * s.dx - s.tx * s.dz;
        const rz = s.tx * s.dy - s.ty * s.dx;
        let prev = NaN;
        let prevB = NaN;
        for (let o = -26; o <= 26; o += 0.25) {
          const q = v3(s.dx + (rx * o) / R, s.dy + (ry * o) / R, s.dz + (rz * o) / R);
          const l = Math.hypot(q.x, q.y, q.z);
          q.x /= l;
          q.y /= l;
          q.z /= l;
          const h = planet.heightAt(q);
          const b = planet.baseHeightAt(q);
          if (prev === prev && h > 0.3 && prev > 0.3 && Math.abs(h - b) > 0.05 && (region.surface(q, hit).cls === 'free' || hit.cls === 'verge') && !inAbutment(q)) {
            const slope = Math.abs(h - prev) / 0.25;
            const natural = Math.abs(b - prevB) / 0.25;
            expect(slope, `${e.name} at ${k} m, ${o} m off`).toBeLessThan(Math.max(0.9, natural * 1.2 + 0.6));
          }
          prev = h;
          prevB = b;
        }
      }
    }
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
        let prevB = NaN;
        let prevNat = false;
        for (let o = -26; o <= 26; o += 0.25) {
          const q = v3(s.dx + (rx * o) / R, s.dy + (ry * o) / R, s.dz + (rz * o) / R);
          const l = Math.hypot(q.x, q.y, q.z);
          q.x /= l;
          q.y /= l;
          q.z /= l;
          const h = planet.heightAt(q);
          const b = planet.baseHeightAt(q);
          const nat = Math.abs(h - b) < 0.05;
          // (v2 R2, tightened: above the sea ≤ 0.25 m per 0.25 m (45°), or a little more than the
          // natural ground's own step there; under water a fill's bank may drop steeply into the deep:
          // still no step; where neither sample is carved (by more than 5 cm) it is the planet's own
          // shape, planet.spec's; inside a bridge's declared abutment the causeway ends in a short bank
          // under the deck, H1's abutment face: ≤ 0.45 m there)
          if (prev === prev && !(nat && prevNat)) {
            const db = Math.abs(b - prevB);
            const lim = h < 0 && prev < 0 ? Math.max(0.8, db * 1.2 + 0.15) : Math.max(inAbutment(q) ? 0.45 : 0.25, db * 1.2 + 0.15);
            expect(Math.abs(h - prev), `${e.name} at ${k} m, ${o} m off`).toBeLessThan(lim);
          }
          prev = h;
          prevB = b;
          prevNat = nat;
        }
      }
    }
  });
});
