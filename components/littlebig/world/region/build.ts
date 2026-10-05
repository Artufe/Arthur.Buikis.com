// The region builder (R1): settlements on carved pads, the capital's gate plazas, town streets, the
// roads between them (routed over the base terrain, graded, bridged where they must cross water,
// a hairpin climb to the alpine village), piers and a ferry, airports with clear approaches, and
// the terrain carve that makes it all part of the planet. Pure, seeded, deterministic; built once
// per planet (world/planet.ts calls it on the first heightAt).
//
// Order (each step reads only the base terrain and the steps before it):
//   1. the capital (CITY_CHART, the plateau) and its gate plazas, outside the turning circles of the
//      capital's gate avenues (world/city/layout.ts culs);
//   2. settlement sites, searched round the planet's anchors and scored for a flat, dry pad;
//   3. airports (a strip on the capital's lagoon beside its roads; a carved strip by the far city), piers;
//   4. town street plans (towns.ts) in each settlement's chart; gate roundabouts;
//   5. roads: A* (route.ts), string-pulled, filleted, graded ≤ 10 %, bridges over open water where allowed;
//   6. the network (network.ts), its components, the ferry (lazy), the carve.
//
// The world (V2 §3): every town stands apart from the capital (TOWN_GAP) and from the others
// (TOWN_APART). On the capital's continent the mill road leaves the north-west gate round the
// plateau, past the windmills, for millbrook on its shelf; the coast road runs on round the south of
// the plateau (a T for the lagoon airport's causeway when the strip lies off it) to port pebble on
// its cape (the harbour, the ferry to far haven), whose back gate meets the south gate by the short
// harbour road; the rim road joins the south gate to the east gate, where the alpine road climbs the
// pass in one wide hairpin to snowberry on the high valley meadow, and the cove road runs north over
// the shoulder and bridges the channel to coral cove; the lighthouse road leaves the north-west gate
// for a car park on the headland. On the far continent far haven's grid city has its docks, its
// airport, a highway out to clover's farms and a road up to the lookout's car park.
//
// Budget: ≤ 20 ms on the M3 (spec'd): it sits on the terrain's first-frame path. The costly
// searches go through the memo (bake.ts): replayed from baked.ts for the canonical seed.

import { CITY_LAT, CITY_LON, CITY_PLAN_RADIUS, CITY_SURFACE_R, PLATEAU_BLEND, PLATEAU_HEIGHT, PLATEAU_RADIUS, R, ROAD_H, SEED } from '../config';
import { CITY_CHART } from '../city/frame';
import { turningRadius } from '../city/graph';
import { buildLayout, GATE_CIRCLE_R, GATE_RIM_GAP } from '../city/layout';
import type { PlanetAnchors } from '../planet';
import { chartToDir, dirFromLatLon, dirToChart, headingOf, headingVector, normalize3, v3, type Chart, type Vec3 } from '../sphere';
import { sunDirection } from '../sun';
import { createMemo, hashNums, type Memo } from './bake';
import { REGION_BAKE } from './baked';
import { BATTER, carveBuilder, PAD_BATTER_CAP, PrimKind, type Abutment } from './carve';
import { arc, awayTangent, DEG, dot, lerpDir, norm2pi, segDist, slerp, smooth01, step, towardTangent, walk, wrap } from './geo';
import { buildNetwork, chartAt, type EdgeSpec, type NodeSpec } from './network';
import { wjoin, woffset, wpath, wreverse, wsample, wsampleOut, wtrim } from './path';
import { routeFinish, routeSearch, type RouteSpec } from './route';
import { filletPoly, planTown, type TownPlan } from './towns';
import type { Airport, FerryRoute, GatePlaza, Lookout, NodePlace, Pier, Region, RegionRoadKind, Settlement, SettlementKind, SettlementStyle, WPath } from './types';

/** What the builder may read of the planet: the BASE terrain and its anchors (never heightAt: no cycle). */
export interface BaseTerrain {
  seed: number;
  cityDir: Vec3;
  anchors: PlanetAnchors;
  baseHeightAt(d: Vec3): number;
  mountainAt(d: Vec3): number;
  moistureAt(d: Vec3): number;
}

// ── Dimensions (m) ──

/** Road cross-sections: carriageway width, sidewalk per side, speed limit (m/s). */
export const ROAD: Record<RegionRoadKind, { width: number; sidewalk: number; speed: number }> = {
  highway: { width: 6.6, sidewalk: 0, speed: 14 },
  road: { width: 6.0, sidewalk: 0, speed: 11 },
  access: { width: 5.6, sidewalk: 0, speed: 8 },
  street: { width: 5.6, sidewalk: 1.5, speed: 6 },
  lane: { width: 5.0, sidewalk: 1.2, speed: 5 },
  ring: { width: 5.0, sidewalk: 0, speed: 5 },
};
/** Grade limit for roads (rise / run) and on bridges. */
export const MAX_GRADE = 0.1;
/** Minimum road surface height on land (m): roads stay clear of the swell. */
const LAND_MIN = 1.0;
/** Minimum pad height (m): below ~1.7 the planet colours the ground as beach. */
const PAD_MIN = 1.75;
/** Bridges: minimum deck height over water; a span is a bridge only if ≥ BRIDGE_WET of it is over open water and it is ≥ BRIDGE_MIN m long. */
export const DECK_MIN = 2.4;
export const BRIDGE_WET = 0.4;
export const BRIDGE_MIN = 10;
/** Base height below which a route point counts as water (a bridge, where allowed). */
const WATER_H = 0.3;
/** Ferry lane: minimum depth (m) away from the berths, separation of the two legs. */
export const FERRY_DEPTH = 2.5;
export const FERRY_SEPARATION = 6;
/** Pier: deck height, width, and the depth its berth must reach. */
const PIER_H = 1.25;
const PIER_W = 3.2;
const BERTH_DEPTH = 1.8;
/** Runways: length, width, surface height in a lagoon. */
const RUNWAY_L = 62;
const RUNWAY_W = 6;
const RUNWAY_LAGOON_H = 1.1;
/** Towns stand apart (V2 §1.1: their own silhouettes): pad edge ≥ TOWN_GAP m past the plateau's edge, ≥ TOWN_APART m from another pad. */
export const TOWN_GAP = 25;
export const TOWN_APART = 40;
/** Approach contract: glide slope (rise per metre) and how far out it is checked (m). */
export const GLIDE = 1 / 12;
export const APPROACH_CHECK = 240;
/** The approach a runway must have clear at its landing end (m). */
export const APPROACH_MIN = 200;

/** The sun at t = 0 (late afternoon over the capital): what the default views show lit. */
const SUN0 = sunDirection(0);
const DEBUG = typeof process !== 'undefined' && !!process.env.LB_REGION_DEBUG;
/** Bump when a change to the builder makes the baked decisions stale (bake.spec.ts also catches it). */
const REGION_VERSION = 3;

interface TownDef {
  id: string;
  name: string;
  kind: SettlementKind;
  style: Exclude<SettlementStyle, 'capital'>;
  population: number;
  blurb: string;
  padR: number;
  blend: number;
  /** 'cap' on the capital's continent, 'far' on the far continent. */
  land: 'cap' | 'far';
}

/** The towns, in Region.settlements order after the capital. */
const TOWNS: TownDef[] = [
  { id: 'port-pebble', name: 'port pebble', kind: 'town', style: 'harbour', population: 1280, blurb: 'harbour · ferry to far haven', padR: 23, blend: 8, land: 'cap' },
  { id: 'millbrook', name: 'millbrook', kind: 'village', style: 'farm', population: 540, blurb: 'farm village · the windmills', padR: 24, blend: 10, land: 'cap' },
  { id: 'snowberry', name: 'snowberry', kind: 'village', style: 'alpine', population: 410, blurb: 'alpine village · over the pass', padR: 26, blend: 10, land: 'cap' },
  { id: 'coral-cove', name: 'coral cove', kind: 'village', style: 'resort', population: 300, blurb: 'island resort · over the bridge', padR: 24, blend: 6, land: 'cap' },
  { id: 'far-haven', name: 'far haven', kind: 'city', style: 'metro', population: 6200, blurb: 'city · docks · airport', padR: 48, blend: 14, land: 'far' },
  { id: 'clover', name: 'clover', kind: 'village', style: 'farm', population: 460, blurb: 'farm village · out on the plains', padR: 25, blend: 10, land: 'far' },
];

/** Fixed sample directions for the terrain fingerprint (a bake for another terrain is ignored). */
function fingerprint(base: BaseTerrain): number {
  const vals: number[] = [base.seed, REGION_VERSION, CITY_PLAN_RADIUS, PLATEAU_HEIGHT];
  const A = base.anchors;
  for (const d of [A.range, A.windHill, A.neck, A.shoulder, A.second, A.third, ...A.headlands, ...A.islands]) {
    vals.push(d.x, d.y, d.z, base.baseHeightAt(d), base.baseHeightAt(walk(d, 1, 11)));
  }
  return hashNums(vals);
}

export function buildRegion(base: BaseTerrain, opts: { bake?: string | null } = {}): Region {
  const t0 = performance.now();
  const seed = base.seed;
  const noBake = typeof process !== 'undefined' && process.env.LB_REGION_NOBAKE === '1';
  const memo: Memo = createMemo(fingerprint(base), opts.bake === undefined ? (seed === SEED && !noBake ? REGION_BAKE : undefined) : opts.bake ?? undefined);
  /** Each memo entry depends on everything cached before it (a stale entry invalidates the rest). */
  let chain = 0x9e3779b9;
  const cached = (key: string, inputs: number[], compute: () => ArrayLike<number>, enc?: Parameters<Memo['get']>[3]) => {
    const out = memo.get(key, [chain, ...inputs], compute, enc);
    chain = hashNums(out, chain);
    return out;
  };
  let samples = 0;
  /** Base terrain height (counted). */
  const H = (d: Vec3) => {
    samples++;
    return base.baseHeightAt(d);
  };
  const _h = v3();
  const Hat = (from: Vec3, heading: number, m: number) => H(walk(from, heading, m, _h));
  // Per-stage cost (ms, samples) for the budget spec and the boot log.
  const prof: Record<string, number> = {};
  let lastT = t0;
  let lastS = 0;
  const mark = (name: string) => {
    const now = performance.now();
    prof[`${name}.ms`] = Math.round((now - lastT) * 100) / 100;
    prof[`${name}.samples`] = samples - lastS;
    lastT = now;
    lastS = samples;
  };
  const city = base.cityDir;
  const cityAngle = (d: Vec3) => Math.acos(Math.min(1, d.x * city.x + d.y * city.y + d.z * city.z));
  /** Surface metres from the city centre on the plateau's chart radius. */
  const cityDist = (d: Vec3) => cityAngle(d) * CITY_SURFACE_R;
  const hd = (from: Vec3, to: Vec3) => headingOf(from, towardTangent(to, from, v3()));

  // ── 1. The capital and its gate plazas ──
  const settlements: Settlement[] = [];
  const capital: Settlement = {
    id: 'bigtown',
    index: 0,
    name: 'bigtown',
    kind: 'capital',
    style: 'capital',
    blurb: 'the capital',
    population: 4812,
    dir: v3(city.x, city.y, city.z),
    h: PLATEAU_HEIGHT,
    chart: CITY_CHART,
    padR: CITY_PLAN_RADIUS,
    blend: PLATEAU_BLEND * CITY_SURFACE_R,
    heading: 0,
    component: 0,
    nodes: [],
    streets: [],
    gates: [],
    piers: [],
    airports: [],
  };
  settlements.push(capital);

  const layout = buildLayout(seed);
  const gates: GatePlaza[] = [];
  for (const cul of layout.culs) {
    const end = layout.nodes[cul.end];
    const r = Math.hypot(end.x, end.z) || 1;
    const ux = end.x / r;
    const uz = end.z / r;
    const tx = end.x + ux * (GATE_CIRCLE_R + GATE_RIM_GAP);
    const tz = end.z + uz * (GATE_CIRCLE_R + GATE_RIM_GAP);
    const edge = layout.edges.findIndex((e) => (e.a === cul.ring && e.b === cul.end) || (e.b === cul.ring && e.a === cul.end));
    gates.push({
      id: gates.length,
      cityEdge: edge,
      cityNode: cul.end,
      cityX: end.x,
      cityZ: end.z,
      touchX: tx,
      touchZ: tz,
      dir: chartToDir(CITY_CHART, tx + ux * 10, tz + uz * 10),
      touch: chartToDir(CITY_CHART, tx, tz),
      h: PLATEAU_HEIGHT,
      r: 10,
      ring: 6.5,
      island: 3.9,
      nodes: [],
      leadsTo: [],
    });
    capital.gates.push(gates.length - 1);
  }
  const outwardOf = (g: GatePlaza) => headingOf(g.touch, awayTangent(city, g.touch, v3()));
  const gateBearing = (g: GatePlaza) => {
    const q = dirToChart(CITY_CHART, g.touch);
    return norm2pi(Math.atan2(q.x, -q.z)); // compass bearing from the city centre
  };
  // The three gates by bearing: east (the neck side), south, north-west.
  const byBearing = [...gates].sort((p, q) => gateBearing(p) - gateBearing(q));
  const gEast = byBearing.find((g) => gateBearing(g) > 60 * DEG && gateBearing(g) < 140 * DEG) ?? byBearing[0];
  const gSouth = byBearing.find((g) => g !== gEast && gateBearing(g) > 140 * DEG && gateBearing(g) < 220 * DEG) ?? byBearing[Math.min(1, byBearing.length - 1)];
  const gWest = byBearing.find((g) => g !== gEast && g !== gSouth) ?? byBearing[byBearing.length - 1];

  // ── 2. Settlement sites ──
  /** Pad statistics: base heights at the centre and on rings at 0.5 / 1.0 padR. */
  const padStats = (c: Vec3, padR: number) => {
    let min = Infinity, max = -Infinity, sum = 0, sum2 = 0, n = 0, wet = 0;
    const rings: Array<[number, number]> = [[0, 1], [0.5, 6], [1, 10]];
    for (const [f, k] of rings) {
      for (let i = 0; i < k; i++) {
        const h = f === 0 ? H(c) : Hat(c, (i / k) * Math.PI * 2 + f, f * padR);
        min = Math.min(min, h);
        max = Math.max(max, h);
        sum += h;
        sum2 += h * h;
        n++;
        if (h < 0.4) wet++;
      }
    }
    const mean = sum / n;
    return { min, max, mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), wet };
  };
  /** Sea round c at m metres: how many of 12 bearings are water (≤ −0.8 m), and the mean bearing of the sea. */
  const seaAround = (c: Vec3, m: number) => {
    let k = 0;
    let bx = 0, by = 0;
    for (let i = 0; i < 12; i++) {
      const h = (i / 12) * Math.PI * 2;
      if (Hat(c, h, m) < -0.8) {
        k++;
        bx += Math.sin(h);
        by += Math.cos(h);
      }
    }
    return { k, heading: Math.atan2(bx, by) };
  };
  /** Candidate centres on a local grid (step m, within radius m) round `c`. */
  const grid = (c: Vec3, radius: number, stepM: number): Vec3[] => {
    const out: Vec3[] = [];
    const n = Math.floor(radius / stepM);
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        if (i * i + j * j > n * n) continue;
        const d = Math.hypot(i, j) * stepM;
        out.push(d < 1e-6 ? v3(c.x, c.y, c.z) : walk(c, Math.atan2(i, j), d, v3()));
      }
    }
    return out;
  };
  const outsideCapital = (c: Vec3, m: number) => cityDist(c) >= CITY_PLAN_RADIUS + m;
  /** How face-on c is from the default orbit view (core/shots.ts `orbit`: 380 m over CITY_LAT − 6, CITY_LON + 26). */
  const orbitCam = dirFromLatLon(CITY_LAT - 6, CITY_LON + 26);
  const orbitFacing = (c: Vec3) => {
    const cr = R + 382;
    const cx = orbitCam.x * cr - c.x * R, cy = orbitCam.y * cr - c.y * R, cz = orbitCam.z * cr - c.z * R;
    return (cx * c.x + cy * c.y + cz * c.z) / Math.hypot(cx, cy, cz);
  };
  type Site = { c: Vec3; h: number; score: number };
  /** The best-scoring pad centre in a zone: a coarse grid, then a fine grid round the coarse winner. */
  const pick = (
    zone: Vec3 | Vec3[],
    radius: number,
    padR: number,
    quick: (c: Vec3, h: number) => boolean,
    score: (c: Vec3, st: ReturnType<typeof padStats>) => number,
    coarse = 7,
    fine = 2.5,
  ): Site | null => {
    let best: Site | null = null;
    let nq = 0, ns = 0, nc = 0;
    const tryAll = (cands: Vec3[]) => {
      for (const c of cands) {
        nc++;
        const hc = H(c);
        if (!quick(c, hc)) continue;
        nq++;
        const st = padStats(c, padR);
        const s = score(c, st);
        if (!(s > -Infinity)) continue;
        ns++;
        if (!best || s > best.score) best = { c, h: st.mean, score: s };
      }
    };
    tryAll(Array.isArray(zone) ? zone : grid(zone, radius, coarse));
    if (DEBUG) console.log('[region] pick', padR, 'cands', nc, 'quick', nq, 'scored', ns);
    if (best) tryAll(grid((best as Site).c, coarse * 0.75, fine));
    return best;
  };
  /** A cached site: [x, y, z, h] or [] when none was found. */
  const site = (id: string, zone: Vec3, find: () => Site | null): Site | null => {
    const v = cached(`site:${id}`, [zone.x, zone.y, zone.z], () => {
      const s = find();
      return s ? [s.c.x, s.c.y, s.c.z, s.h] : [];
    });
    return v.length ? { c: v3(v[0], v[1], v[2]), h: v[3], score: 0 } : null;
  };

  const A = base.anchors;
  // The windmill hill's summit (the windmills stand round it: keep pads and roads off it).
  const sv = cached('summit', [A.windHill.x, A.windHill.y, A.windHill.z], () => {
    let bh = -Infinity;
    let best = A.windHill;
    for (const c of grid(A.windHill, 26, 5)) {
      const h = H(c);
      if (h > bh) {
        bh = h;
        best = c;
      }
    }
    return [best.x, best.y, best.z];
  });
  const summit = v3(sv[0], sv[1], sv[2]);
  // The lighthouse's tip (nature/landmarks.ts picks the coastal spot with the most sea round it,
  // nearest the city): the N headland's. Pads keep well clear of it.
  const lighthouse = A.headlands[0];

  const sites = new Map<string, Site>();
  const def = (id: string) => TOWNS.find((t) => t.id === id)!;
  // Harbour: on the south cape (planet.ts CAPE), its pad TOWN_GAP clear of the plateau, the quay on
  // its seaward rim at the shore (not out in the lagoon, not inland), sea on that side.
  {
    const d = def('port-pebble');
    const zone = A.cape;
    const s = site(d.id, zone, () =>
      pick(
        zone,
        24,
        d.padR,
        // (its back gate faces the south gate's plaza across a short road; the quay is the far rim)
        (c, h) => h > -0.5 && h < 5 && outsideCapital(c, d.padR + TOWN_GAP) && arc(c, lighthouse) > 60 && arc(c, gSouth.dir) > d.padR + 20,
        (c, st) => {
          // (its seaward edge may be won from the shallows: the quay)
          if (st.min < -2.6 || st.wet > 6) return -Infinity;
          const sea = seaAround(c, d.padR + 8);
          if (sea.k < 2 || sea.k > 8) return -Infinity;
          const away = hd(gSouth.dir, c);
          const rim = Hat(c, away, d.padR - 1);
          // (and face-on, in daylight, from the default orbit view: V2 §1.1)
          return -st.std * 1.5 - Math.abs(sea.k - 4) * 0.3 - st.wet * 0.3 - Math.abs(rim - 0.5) * 0.8 - Math.abs(st.mean - 1.8) * 0.3 - cityDist(c) * 0.02 - Math.abs(wrap(sea.heading - away)) * 0.5 + 4 * orbitFacing(c);
        },
        5,
        2,
      ),
    );
    if (s) sites.set(d.id, s);
  }
  // Farm village: on the shelf south-west of the windmill hill (planet.ts SHELF), the mills on the hill
  // beside it, its pad TOWN_GAP clear of the plateau, dry meadow, well apart from the harbour.
  {
    const d = def('millbrook');
    const pp = sites.get('port-pebble');
    const s = site(d.id, A.shelf, () =>
      pick(
        A.shelf,
        28,
        d.padR,
        (c, h) => h > 1.2 && outsideCapital(c, d.padR + TOWN_GAP) && arc(c, summit) > d.padR + 22 && !near(c, pp?.c, def('port-pebble').padR + d.padR + TOWN_APART),
        (c, st) => (st.min < 0.6 ? -Infinity : -st.std * 2.5 - Math.abs(st.mean - 2.6) * 0.3 - st.wet * 0.6 - base.moistureAt(c) * 3 + dot(c, SUN0) * 2 - arc(c, summit) * 0.03 - cityDist(c) * 0.02),
        4,
        2,
      ),
    );
    if (s) sites.set(d.id, s);
  }
  // Alpine village: on the valley floor between the range's peaks (planet.ts VALLEY), high on the
  // range's flank (its far side drops to the sea: the pad fills the meadow, no more).
  const passFrame: Chart = { origin: A.valley, east: normalize3(cross(A.valley, A.passAxis)), south: A.passAxis, radius: R };
  {
    const d = def('snowberry');
    const c = chartToDir(passFrame, 0, 2);
    const st = cached(`site:${d.id}`, [c.x, c.y, c.z, d.padR], () => {
      const s = padStats(c, d.padR);
      return [s.mean, s.min];
    });
    if (st[1] > -1.5) sites.set(d.id, { c, h: st[0], score: 0 });
  }
  // Island resort: the big island off the east coast, beyond the shoulder (planet.ts islands[0]), its
  // pad and most of its blend ring on the island's own land (the fill never draws the coastline).
  {
    const d = def('coral-cove');
    const isl = A.islands[0];
    const s = site(d.id, isl, () =>
      pick(
        isl,
        16,
        d.padR,
        (c, h) => h > 0.3,
        (c, st) => {
          if (st.min < -0.6) return -Infinity;
          let wet = 0;
          for (let i = 0; i < 12; i++) if (Hat(c, (i / 12) * Math.PI * 2, d.padR + d.blend * 0.5) < 0) wet++;
          if (wet > 3) return -Infinity;
          return -st.std * 2 - st.wet * 0.5 - wet * 0.4 - cityDist(c) * 0.01;
        },
        4,
        2,
      ),
    );
    if (s) sites.set(d.id, s);
  }
  // Metro: the far continent, a broad pad by the coast (docks), as flat as the hills allow.
  {
    const d = def('far-haven');
    const s = site(d.id, A.second, () => {
      const cands = grid(A.second, 92, 16).filter((c) => {
        const h = H(c);
        return h > 1.2 && h < 10;
      });
      // cheap pre-score on 4 samples, then the full pad statistics for the best five
      const pre = cands
        .map((c) => {
          let mx = -Infinity, mn = Infinity;
          for (let i = 0; i < 4; i++) {
            const h = Hat(c, i * 1.5708 + 0.3, d.padR * 0.7);
            mx = Math.max(mx, h);
            mn = Math.min(mn, h);
          }
          return { c, s: -(mx - mn) - (mn < 0.6 ? 20 : 0) };
        })
        .sort((p, q) => q.s - p.s)
        .slice(0, 5)
        .map((x) => x.c);
      return pick(
        pre,
        0,
        d.padR,
        () => true,
        (c, st) => {
          if (st.min < 0.4 || st.wet > 3) return -Infinity;
          const sea = seaAround(c, d.padR + 22);
          if (sea.k < 2) return -Infinity;
          return -st.std * 1.5 - (st.max - st.min) * 0.25 + Math.min(sea.k, 6) * 0.3;
        },
        16,
        6,
      );
    });
    if (s) sites.set(d.id, s);
  }
  // Farm village on the far continent: open meadow inland of the city, a highway's drive away.
  {
    const d = def('clover');
    const fh = sites.get('far-haven');
    const zone = fh ? fh.c : A.second;
    const s = site(d.id, zone, () =>
      pick(
        zone,
        150,
        d.padR,
        (c, h) => {
          if (h < 1.6 || h > 9) return false;
          const m = fh ? arc(c, fh.c) : 999;
          return m > 95 && m < 150;
        },
        (c, st) => {
          if (st.min < 1.0 || st.wet > 0) return -Infinity;
          return -st.std * 2.4 - (st.max - st.min) * 0.3 - base.moistureAt(c) * 3 - Math.abs((fh ? arc(c, fh.c) : 120) - 118) * 0.02;
        },
        14,
        4,
      ),
    );
    if (s) sites.set(d.id, s);
  }
  mark('sites');

  // ── Settlement records ──
  const townOf = new Map<string, Settlement>();
  for (const d of TOWNS) {
    const st = sites.get(d.id);
    if (!st) continue;
    // ≥ PAD_MIN: lower ground reads as beach (planet.biomeAt) and floods under the swell.
    const h = Math.round(Math.max(PAD_MIN, Math.min(14, st.h)) * 20) / 20;
    const s: Settlement = {
      id: d.id,
      index: settlements.length,
      name: d.name,
      kind: d.kind,
      style: d.style,
      blurb: d.blurb,
      population: d.population,
      dir: normalize3(v3(st.c.x, st.c.y, st.c.z)),
      h,
      chart: { ...chartAt(st.c, R + h), radius: R + h },
      padR: d.padR,
      blend: d.blend,
      heading: 0,
      component: d.land === 'far' ? 1 : 0,
      nodes: [],
      streets: [],
      gates: [],
      piers: [],
      airports: [],
    };
    settlements.push(s);
    townOf.set(d.id, s);
  }
  const T = (id: string) => townOf.get(id);
  const portPebble = T('port-pebble');
  const millbrook = T('millbrook');
  const snowberry = T('snowberry');
  const cove = T('coral-cove');
  const farHaven = T('far-haven');
  const clover = T('clover');

  /** A cached sea heading (compass, toward the water) for a harbour or metro. */
  const seaHeading = (s: Settlement, m: number) => cached(`sea:${s.id}`, [s.dir.x, s.dir.y, s.dir.z, m], () => [seaAround(s.dir, m).heading])[0];
  // port pebble faces the sea off its cape (the quay on the shore, the pier out to deep water), its
  // back gate toward the south gate's plaza behind it; the coast road leaves its flank gate
  if (portPebble) portPebble.heading = hd(gSouth.dir, portPebble.dir);
  if (farHaven) farHaven.heading = seaHeading(farHaven, farHaven.padR + 22);

  // ── 3. Piers and airports ──
  const piers: Pier[] = [];
  const airports: Airport[] = [];
  /** A pad's bank cap (dry ground only, see the carve). */
  const padCap = new Map<Settlement, number>();
  const padDcap = (s: Settlement) => {
    let c = padCap.get(s);
    if (c === undefined) {
      c = cached(`pad:${s.id}`, [s.dir.x, s.dir.y, s.dir.z, s.h, s.padR, s.blend], () => {
        // the depth across the bank, out past its blend (a wall a little way off still needs the room)
        let m = 0;
        for (let i = 0; i < 12; i++) {
          for (const f of [0.5, 1, 1.6]) {
            const b = Hat(s.dir, (i / 12) * Math.PI * 2, s.padR + s.blend * f);
            if (b >= 0) m = Math.max(m, Math.abs(b - s.h) * (f > 1 ? 0.7 : 1));
          }
        }
        return [Math.min(PAD_BATTER_CAP, m + 1)];
      })[0];
      padCap.set(s, c);
    }
    return c;
  };
  const padReach = (s: Settlement) => s.blend + BATTER * padDcap(s);

  /** Terrain under a 1:12 glide over `APPROACH_CHECK` m beyond end `from` (away from `to`): the clear distance. */
  const clearBeyond = (from: Vec3, to: Vec3, h: number) => {
    const out = awayTangent(to, from, v3());
    const q = v3();
    for (let d = 6; d <= APPROACH_CHECK; d += 6) if (H(step(from, out, d, q)) > h + d * GLIDE - 1.5) return d - 6;
    return APPROACH_CHECK;
  };
  const runwayAt = (c: Vec3, heading: number) => ({ e0: walk(c, heading + Math.PI, RUNWAY_L / 2, v3()), e1: walk(c, heading, RUNWAY_L / 2, v3()) });
  /** [cx, cy, cz, heading, h, clear0, clear1] or []. */
  const airportSite = (code: string, inputs: number[], find: () => number[]) => cached(`airport:${code}`, inputs, find);
  // The capital's airport: a strip won from the south lagoon (0.4–3.2 m of water, offshore so the
  // roads on land keep their room), parallel to the coast, its landing approach over the open sea.
  {
    const v = airportSite('lbx', [gSouth.dir.x, gSouth.dir.y, gSouth.dir.z, gWest.dir.x, gWest.dir.y, gWest.dir.z], () => {
      let best: number[] = [];
      let bestScore = -Infinity;
      const dbg = { near: 0, wet: 0, foot: 0, towns: 0, bestClear: 0 };
      const ppSite = sites.get('port-pebble');
      const mbSite = sites.get('millbrook');
      for (let i = 0; i < 60; i++) {
        const phi = (i / 60) * Math.PI * 2;
        // (far enough out that a causeway crosses some lagoon to its apron)
        for (const rr of [CITY_PLAN_RADIUS + 44, CITY_PLAN_RADIUS + 50, CITY_PLAN_RADIUS + 56]) {
          const c = walk(city, phi, rr * (R / CITY_SURFACE_R), v3());
          // beside the coast road (the farm village to the harbour) or the mill road (the north-west
          // gate to the farm village), off the lighthouse's headland
          const gd = ppSite && mbSite ? Math.min(segDist(c, ppSite.c, mbSite.c), segDist(c, gWest.dir, mbSite.c)) : Math.min(arc(c, gSouth.dir), arc(c, gWest.dir));
          if (gd > 60 || arc(c, lighthouse) < 34) continue;
          const hc = H(c);
          if (DEBUG) dbg.near++;
          if (hc < -4.4 || hc > -0.4) continue;
          if (DEBUG) dbg.wet++;
          const out = headingOf(c, awayTangent(city, c, v3()));
          for (const dh of [0, -0.25, 0.25, -0.5, 0.5]) {
            const head = out + Math.PI / 2 + dh;
            let ok = true;
            let fill = 0;
            for (const side of [0, -1, 1]) {
              for (let k = -4; k <= 4 && ok; k++) {
                const h = H(walk(walk(c, head, (k * RUNWAY_L) / 8, v3()), head + Math.PI / 2, side * 5, v3()));
                if (h < -4.6 || h > 0.9) ok = false;
                fill += RUNWAY_LAGOON_H - h;
              }
              if (!ok) break;
            }
            if (!ok) continue;
            if (DEBUG) dbg.foot++;
            const { e0, e1 } = runwayAt(c, head);
            // (the strip's island reaches past its thresholds: its banks stay off the towns' pads and blends)
            const townSites = [ppSite, mbSite, sites.get('coral-cove')];
            const x0 = walk(c, head + Math.PI, RUNWAY_L * 0.62, v3());
            const x1 = walk(c, head, RUNWAY_L * 0.62, v3());
            if (townSites.some((t, k) => t && segDist(t.c, x0, x1) < [def('port-pebble'), def('millbrook'), def('coral-cove')][k].padR + 20)) continue;
            if (DEBUG) dbg.towns++;
            const c0 = clearBeyond(e0, e1, RUNWAY_LAGOON_H);
            const c1 = clearBeyond(e1, e0, RUNWAY_LAGOON_H);
            if (DEBUG && Math.max(c0, c1) > dbg.bestClear) dbg.bestClear = Math.max(c0, c1);
            if (Math.max(c0, c1) < APPROACH_MIN) continue;
            const off = cityDist(c) - CITY_PLAN_RADIUS;
            const score = -fill * 0.03 - gd * 0.04 - Math.abs(dh) * 2 + Math.min(c0, c1) * 0.01 + 3 * dot(c, SUN0) + Math.min(off, 50) * 0.08;
            if (score > bestScore) {
              bestScore = score;
              best = [c.x, c.y, c.z, head, RUNWAY_LAGOON_H, c0, c1];
            }
          }
        }
      }
      if (DEBUG) console.log('[region] lbx search', JSON.stringify(dbg));
      return best;
    });
    if (v.length) addAirport(capital, v, 'lbx', 'bigtown airport');
  }
  // The far city's airport: the flattest strip near the city with a long clear approach.
  if (farHaven) {
    const fh = farHaven;
    const v = airportSite('fhv', [fh.dir.x, fh.dir.y, fh.dir.z, fh.heading], () => {
      let best: number[] = [];
      let bestScore = -Infinity;
      for (let i = 0; i < 16; i++) {
        const bearing = fh.heading + Math.PI + (i - 7.5) * 0.24;
        for (const d of [fh.padR + 34, fh.padR + 44, fh.padR + 54]) {
          const c = walk(fh.dir, bearing, d, v3());
          const hc = H(c);
          if (hc < 0.8 || hc > 9) continue;
          const toward = hd(c, fh.dir);
          for (const dh of [Math.PI / 2 - 0.45, Math.PI / 2 - 0.2, Math.PI / 2, Math.PI / 2 + 0.2, Math.PI / 2 + 0.45]) {
            const head = toward + dh;
            let mn = Infinity, mx = -Infinity, sum = 0;
            let bad = false;
            for (let k = -4; k <= 4 && !bad; k += 2) if (H(walk(c, head, (k * RUNWAY_L) / 8, v3())) < 0.5) bad = true;
            for (let k = -4; k <= 4 && !bad; k++) {
              for (const side of [-1, 1]) {
                const h = H(walk(walk(c, head, (k * RUNWAY_L) / 8, v3()), head + Math.PI / 2, side * 5, v3()));
                mn = Math.min(mn, h);
                mx = Math.max(mx, h);
                sum += h;
                if (h < 0.5) bad = true;
              }
            }
            if (bad || mx - mn > 4.5) continue;
            const h = Math.round(Math.max(LAND_MIN + 0.3, sum / 18) * 20) / 20;
            // the airport road climbs ≤ ~8 %: no higher or lower than that over the way from the city
            if (Math.abs(h - fh.h) > 0.08 * (d - fh.padR - 10)) continue;
            const { e0, e1 } = runwayAt(c, head);
            if (arc(e0, fh.dir) < fh.padR + fh.blend + 6 || arc(e1, fh.dir) < fh.padR + fh.blend + 6) continue;
            const c0 = clearBeyond(e0, e1, h);
            const c1 = clearBeyond(e1, e0, h);
            if (Math.max(c0, c1) < APPROACH_MIN) continue;
            const score = -(mx - mn) - Math.abs(d - fh.padR - 44) * 0.03 + Math.min(c0, c1) * 0.006;
            if (score > bestScore) {
              bestScore = score;
              best = [c.x, c.y, c.z, head, h, c0, c1];
            }
          }
        }
      }
      return best;
    });
    if (v.length) addAirport(fh, v, 'fhv', 'far haven airport');
  }
  function addAirport(s: Settlement, v: ArrayLike<number>, code: string, name: string, apronAt?: Vec3 | null) {
    const c = v3(v[0], v[1], v[2]);
    const head = v[3];
    const h = v[4];
    const clear: [number, number] = [v[5], v[6]];
    const { e0, e1 } = runwayAt(c, head);
    // Apron beside the runway on the town's side: its middle, or where the access gate's causeway meets it.
    const toTown = hd(c, s.dir);
    const side = Math.sin(toTown - head) > 0 ? 1 : -1;
    const apron = apronAt ?? walk(c, head + side * (Math.PI / 2), RUNWAY_W / 2 + 9.5, v3());
    const landEnd: 0 | 1 = clear[0] >= clear[1] ? 0 : 1;
    const a: Airport = {
      id: airports.length,
      code,
      name,
      settlement: s.index,
      centre: c,
      ends: [e0, e1],
      heading: hd(c, e1),
      h,
      length: RUNWAY_L,
      width: RUNWAY_W,
      apron,
      apronR: 9,
      approach: clear[landEnd],
      clear,
      landEnd,
      node: -1,
    };
    airports.push(a);
    s.airports.push(a.id);
  }
  mark('airports');

  // ── 4. The network: node / edge specs ──
  const nodeSpecs: NodeSpec[] = [];
  const edgeSpecs: EdgeSpec[] = [];
  const addNode = (dir: Vec3, h: number, place: NodePlace, settlement = -1, control?: NodeSpec['control'], gate = -1) => {
    nodeSpecs.push({ dir: normalize3(v3(dir.x, dir.y, dir.z)), h, place, settlement, control, gate });
    return nodeSpecs.length - 1;
  };
  const addEdge = (a: number, b: number, raw: WPath, kind: RegionRoadKind, name: string, settlement = -1, oneWay = false, bridges?: Array<[number, number]>, bridgeInfo?: Array<{ deckMin: number; clearance: number }>) => {
    const k = ROAD[kind];
    edgeSpecs.push({ a, b, raw, kind, name, width: k.width, sidewalk: k.sidewalk, speed: k.speed, settlement, oneWay, bridges, bridgeInfo });
    return edgeSpecs.length - 1;
  };
  /** A chart-space polyline (x, z interleaved) in chart c at height h → raw world path. */
  const chartPath = (c: Chart, pts: number[], h: number) => {
    const D: number[] = [];
    const Hs: number[] = [];
    const t = v3();
    for (let i = 0; i < pts.length; i += 2) {
      chartToDir(c, pts[i], pts[i + 1], t);
      D.push(t.x, t.y, t.z);
      Hs.push(h);
    }
    return wpath(D, Hs);
  };

  /**
   * A one-way roundabout (counter-clockwise from above) round `c` with arms at the given compass
   * headings; the ring sized so its edges keep ≥ 2.5 m between the arms' patches.
   */
  const roundabout = (c: Vec3, h: number, armHeadings: number[], settlement: number, gate: number, name: string) => {
    // Plan angle (+x east, +z south) of a compass heading: east = sin hd, south = −cos hd.
    const angles = armHeadings.map((a) => Math.atan2(-Math.cos(a), Math.sin(a)));
    const ring2: Array<{ a: number; arm: boolean; arm0?: number }> = angles.map((a, i) => ({ a, arm: true, arm0: i }));
    if (ring2.length === 1) ring2.push({ a: ring2[0].a + Math.PI, arm: false });
    ring2.sort((p, q) => norm2pi(q.a) - norm2pi(p.a)); // decreasing plan angle = counter-clockwise seen from above
    let minGap = Math.PI * 2;
    for (let i = 0; i < ring2.length; i++) minGap = Math.min(minGap, norm2pi(ring2[i].a - ring2[(i + 1) % ring2.length].a) || Math.PI * 2);
    const ring = Math.max(6.5, 11.6 / minGap);
    const chart = chartAt(c, R + h);
    const ids = ring2.map((r) => addNode(chartToDir(chart, Math.cos(r.a) * ring, Math.sin(r.a) * ring), h + ROAD_H, r.arm ? 'roundabout' : 'bend', settlement, 'roundabout', gate));
    const armNode: number[] = [];
    ring2.forEach((r, i) => {
      if (r.arm) armNode[r.arm0!] = ids[i];
    });
    for (let i = 0; i < ring2.length; i++) {
      const a0 = norm2pi(ring2[i].a);
      let a1 = norm2pi(ring2[(i + 1) % ring2.length].a);
      if (a1 >= a0) a1 -= Math.PI * 2;
      const pts: number[] = [];
      const n = Math.max(6, Math.ceil(((a0 - a1) * ring) / 0.5));
      for (let k = 0; k <= n; k++) {
        const a = a0 + ((a1 - a0) * k) / n;
        pts.push(Math.cos(a) * ring, Math.sin(a) * ring);
      }
      addEdge(ids[i], ids[(i + 1) % ring2.length], chartPath(chart, pts, h + ROAD_H), 'ring', name, settlement, true);
    }
    return { ids, armNode, ring };
  };

  // ── Gate roundabouts: the rim roads leave along the rim (±90° off the outward axis), spurs straight out ──
  type ArmKey = 'cw' | 'ccw' | 'out';
  // north-west: the mill road (ccw, south-west round the plateau to the farm village) and the
  // lighthouse road (cw, north to the headland's car park); east: the rim road (cw, south), the alpine
  // road (out, up the pass) and the cove road (ccw, north over the shoulder to the island resort);
  // south: the rim road (ccw, east) and the harbour road (straight down onto the cape to port pebble's
  // back gate). Every gate meets ≥ 2 roads.
  // ('to': an arm aimed straight at a town close by its plaza, so its road leaves radially and runs straight in)
  type ArmSpec = ArmKey | 'to';
  const gateArms = new Map<GatePlaza, ArmSpec[]>([
    [gWest, ['ccw', 'cw']],
    [gEast, ['cw', 'out', 'ccw']],
    [gSouth, ['ccw', 'to']],
  ]);
  const armTarget = new Map<GatePlaza, Vec3>(portPebble ? [[gSouth, portPebble.dir]] : []);
  const armNodeOf = new Map<string, number>();
  for (const g of gates) {
    const keys = gateArms.get(g);
    if (!keys) continue;
    const out = outwardOf(g);
    const centre0 = walk(g.touch, out, 10, v3());
    const heads = keys.map((k) => (k === 'to' ? hd(centre0, armTarget.get(g) ?? walk(centre0, out, 30, v3())) : out + (k === 'cw' ? 90 : k === 'ccw' ? -90 : 0) * DEG));
    // (a rim arm gives way round the ring to an aimed arm: ≥ 85° between them)
    const ti = keys.indexOf('to');
    if (ti >= 0) keys.forEach((k, i) => {
      if (k !== 'cw' && k !== 'ccw') return;
      const sgn = k === 'cw' ? 1 : -1;
      const gap = wrap(heads[i] - heads[ti]) * sgn;
      if (gap < 85 * DEG) heads[i] = heads[ti] + sgn * 85 * DEG;
    });
    // ring and plaza: the plaza touches the city's turning circle at the rim
    const n = heads.length === 1 ? 2 : heads.length;
    const ring = Math.max(6.5, 11.6 / ((Math.PI * 2) / Math.max(n, heads.length === 3 ? 4 : n)));
    g.ring = ring;
    g.island = ring - ROAD.ring.width / 2 - 0.15;
    g.r = ring + ROAD.ring.width / 2 + 1.2;
    g.dir = walk(g.touch, out, g.r, v3());
    const rb = roundabout(g.dir, g.h, heads, 0, g.id, 'gate roundabout');
    g.ring = rb.ring;
    g.island = rb.ring - ROAD.ring.width / 2 - 0.15;
    g.nodes = rb.ids;
    keys.forEach((k, i) => armNodeOf.set(`${g.id}:${k}`, rb.armNode[i]));
  }
  /** The tangent a road leaves a gate roundabout's arm node along (away from the plaza centre). */
  const armOut = (nd: number, centre: Vec3) => awayTangent(centre, nodeSpecs[nd].dir, v3());

  // ── Town plans ──
  /**
   * Each town's exits (compass bearings from its centre toward what its roads lead to); the plan
   * puts its gate at the back (the first exit) and turns the town to face away from it.
   */
  const exitsOf = new Map<Settlement, number[]>();
  const bearingTo = (s: Settlement, to: Vec3) => hd(s.dir, to);
  // the farm village: in from the mill road (the north-west gate, round the plateau), on by the
  // coast road round the south of the plateau to the harbour
  // (roads round the plateau leave toward a point on the way round, not straight across it)
  const compassOf = (d: Vec3) => {
    const q = dirToChart(CITY_CHART, d);
    return Math.atan2(q.x, -q.z);
  };
  const roundTo = (from: Vec3, to: Vec3, m: number) => {
    const a = compassOf(from);
    const b = a + Math.sign(wrap(compassOf(to) - a)) * 22 * DEG;
    return chartToDir(CITY_CHART, Math.sin(b) * m, -Math.cos(b) * m);
  };
  if (millbrook) exitsOf.set(millbrook, [bearingTo(millbrook, roundTo(millbrook.dir, gWest.dir, 116)), ...(portPebble ? [bearingTo(millbrook, roundTo(millbrook.dir, portPebble.dir, 120))] : [])]);
  // port pebble: in from the south gate's plaza by the harbour road at its back, out by the coast
  // road to millbrook from its back street's corner gate
  if (portPebble) exitsOf.set(portPebble, [bearingTo(portPebble, gSouth.dir), ...(millbrook ? [bearingTo(portPebble, roundTo(portPebble.dir, millbrook.dir, 120))] : [])]);
  if (snowberry) exitsOf.set(snowberry, [headingOf(snowberry.dir, A.passAxis)]);
  if (cove) exitsOf.set(cove, [bearingTo(cove, gEast.dir)]);
  if (clover && farHaven) exitsOf.set(clover, [bearingTo(clover, farHaven.dir)]);
  const gateNodes = new Map<Settlement, number[]>(); // per exit, in exitsOf order
  const lookouts: Lookout[] = [];
  const pierNode = new Map<Settlement, { node: number; root: Vec3 }>();
  const lookout: { c: Vec3 | null } = { c: null };
  // The lookout: the far continent's best viewpoint a short drive from the city (a car park): a gentle
  // top standing above the ground round it, with open sea filling a wide view one way (a headland or
  // a ridge's end), not just the highest meadow.
  if (farHaven) {
    const fh = farHaven;
    const v = cached('lookout', [fh.dir.x, fh.dir.y, fh.dir.z, 2], () => {
      let best: Vec3 | null = null;
      let bs = -Infinity;
      for (const c of grid(fh.dir, 110, 7)) {
        const m = arc(c, fh.dir);
        if (m < fh.padR + 30 || m > 110) continue;
        if (clover && arc(c, clover.dir) < clover.padR + 30) continue;
        if (airports.some((a) => a.settlement === fh.index && segDist(c, a.ends[0], a.ends[1]) < 30)) continue;
        const h = H(c);
        if (h < 2) continue;
        let flat = 0;
        for (let i = 0; i < 6; i++) flat = Math.max(flat, Math.abs(Hat(c, i * 1.047, 6) - h));
        if (flat > 1.4) continue;
        // standing above its surroundings (the mean of a ring 22 m out)
        let ring = 0;
        for (let i = 0; i < 8; i++) ring += Hat(c, (i * Math.PI) / 4, 22);
        const prom = h - ring / 8;
        // the widest sea view: the most water in a 50° cone, 25–70 m out, over 8 headings
        let sea = 0;
        for (let i = 0; i < 8; i++) {
          let k = 0;
          for (const da of [-0.44, 0, 0.44]) for (const r of [25, 40, 55, 70]) if (Hat(c, (i * Math.PI) / 4 + da, r) < -0.5) k++;
          sea = Math.max(sea, k);
        }
        const sc = prom * 1.2 + sea * 0.35 + h * 0.15 - flat * 2;
        if (sc > bs) {
          bs = sc;
          best = c;
        }
      }
      return best ? [best.x, best.y, best.z] : [];
    });
    if (v.length) lookout.c = v3(v[0], v[1], v[2]);
  }
  if (farHaven) {
    const fh = farHaven;
    const fhv = airports.find((a) => a.settlement === fh.index);
    exitsOf.set(fh, [fh.heading, ...(fhv ? [bearingTo(fh, fhv.apron)] : []), ...(clover ? [bearingTo(fh, clover.dir)] : []), ...(lookout.c ? [bearingTo(fh, lookout.c)] : [])]);
  }

  for (const s of settlements) {
    if (s.style === 'capital') continue;
    const ex = exitsOf.get(s) ?? [s.heading + Math.PI];
    // the axis: harbours and the metro face the sea (set above); the rest face away from their first exit
    if (s.style !== 'harbour' && s.style !== 'metro') s.heading = ex[0] + Math.PI;
    let rel = ex.map((b) => wrap(b - s.heading));
    // a farm's gates sit on fixed arms: the back, and the side (or far) arm nearest a second exit
    // whose road can leave over dry land
    // (which of its style's shapes: the towns of one style take them in turn)
    const variant = settlements.filter((o) => o.style === s.style && o.index < s.index).length;
    if (s.style === 'farm') {
      const arms = [Math.PI / 2, -Math.PI / 2];
      // (dry ground 6 m out, and room for a road outside the plateau's rim)
      const dry = cached(`arms:${s.id}`, [s.dir.x, s.dir.y, s.dir.z, s.heading, s.padR], () =>
        arms.map((a) => {
          const q = walk(s.dir, s.heading + a, s.padR + 6, v3());
          return cityDist(q) < CITY_PLAN_RADIUS + 13 ? -9 : H(q);
        }),
      );
      rel = rel.map((b, i) => {
        if (i === 0) return Math.PI;
        let best = NaN;
        arms.forEach((a, k) => {
          if (dry[k] < -0.2) return;
          if (!(best === best) || Math.abs(wrap(a - b)) < Math.abs(wrap(best - b))) best = a;
        });
        return best === best ? best : arms[0];
      });
    }
    const plan: TownPlan = planTown({ style: s.style as Exclude<SettlementStyle, 'capital'>, name: s.name, padR: s.padR, exits: rel, vary: (s.index * 0.37) % 1, variant });
    const h = s.h + ROAD_H;
    const ch = s.chart;
    const ax = Math.sin(s.heading);
    const az = -Math.cos(s.heading);
    // (s, f) → chart (x, z): s along the axis' right (cos hd, sin hd), f along the axis (sin hd, −cos hd)
    const X = (sv: number, fv: number) => sv * -az + fv * ax;
    const Z = (sv: number, fv: number) => sv * ax + fv * az;
    const ids = plan.nodes.map((n) => {
      const id = addNode(chartToDir(ch, X(n.s, n.f), Z(n.s, n.f)), h, n.place, s.index, n.control);
      s.nodes.push(id);
      return id;
    });
    for (const e of plan.edges) {
      // (a street's world path is built on first use: the carve never reads town streets, so only
      // the network, lazily, and a gate's road, for its direction, ever need it)
      let raw: WPath | null = null;
      const id = addEdge(ids[e.a], ids[e.b], null as unknown as WPath, e.kind, e.name, s.index, !!e.oneWay);
      Object.defineProperty(edgeSpecs[id], 'raw', {
        get: () => {
          if (raw) return raw;
          const pts: number[] = [];
          for (let i = 0; i < e.pts.length; i += 2) pts.push(X(e.pts[i], e.pts[i + 1]), Z(e.pts[i], e.pts[i + 1]));
          return (raw = chartPath(ch, pts, h));
        },
        set: (v: WPath) => {
          raw = v;
        },
        enumerable: true,
        configurable: true,
      });
      s.streets.push(id);
    }
    const gIds = plan.exits.map((i) => ids[i]);
    gateNodes.set(s, gIds);
    s.gates = gIds.filter((id) => nodeSpecs[id].place === 'town-gate');
    if (plan.square) s.square = { x: X(plan.square.s, plan.square.f), z: Z(plan.square.s, plan.square.f), r: plan.square.r };
    if (plan.quay) {
      const q: number[] = [];
      for (let i = 0; i < plan.quay.length; i += 2) q.push(X(plan.quay[i], plan.quay[i + 1]), Z(plan.quay[i], plan.quay[i + 1]));
      s.quay = Float64Array.from(q);
    }
    if (plan.pier) pierNode.set(s, { node: ids[plan.pier.node], root: chartToDir(ch, X(plan.pier.s, plan.pier.f), Z(plan.pier.s, plan.pier.f)) });
  }

  // Piers: from the quay out to a berth in deep water, past the pad's banks.
  for (const s of [portPebble, farHaven]) {
    if (!s) continue;
    const pn = pierNode.get(s);
    if (!pn) continue;
    const root = pn.root;
    const out = awayTangent(s.dir, root, v3());
    const L = cached(`pier:${s.id}`, [root.x, root.y, root.z, padReach(s)], () => {
      let L = Math.ceil(padReach(s) * 0.6 + 2);
      for (; L < 46; L += 1) if (H(step(root, out, L)) < -BERTH_DEPTH) break;
      return [L + 2];
    })[0];
    const berth = step(root, out, L);
    const p: Pier = { id: piers.length, settlement: s.index, root, berth, h: PIER_H, width: PIER_W, length: L, heading: headingOf(root, out), node: pn.node };
    piers.push(p);
    s.piers.push(p.id);
  }
  mark('towns');

  // ── 5. Roads between places ──
  // Each routed road: its centreline decimated to ~3 m points, in chunks of 8 with a bounding cap
  // each (a later road's clearance test reads only the chunks near it).
  type Chunk = { x: number; y: number; z: number; cosR: number; i0: number; i1: number };
  const routed: Array<{ pts: Float64Array; width: number; ends: Vec3[]; c: Vec3; cosR: number; plazas: number[]; edge: number; chunks: Chunk[] }> = [];
  const failed: string[] = [];
  const keepPads = settlements.filter((s) => s.style !== 'capital');
  // Roads keep their verge off the plateau (rim + 7 m) and prefer to run 10–16 m outside it.
  const cosRim = Math.cos(PLATEAU_RADIUS + 7 / R);
  const rimNear = PLATEAU_RADIUS + 11 / R;
  const rimTheta = (CITY_PLAN_RADIUS + 11) / CITY_SURFACE_R;

  interface RoadOpts {
    bridges?: boolean;
    causeway?: boolean;
    ownPads: Settlement[];
    ownPlazas: number[];
    polar?: 1 | -1;
    cell?: number;
    /** Prefer meadow to forest (the canopy hides a road from above). */
    forest?: number;
  }
  /** Route, profile and grade a road from node `from` (leaving along `fromOut`) to node `to` (arriving along `toIn`). */
  const roadTo = (name: string, fromNode: number, fromOut: Vec3, toNode: number, toIn: Vec3, kind: RegionRoadKind, opts: RoadOpts) => {
    const res = routeRoad(name, fromNode, fromOut, toNode, toIn, kind, opts);
    return res ? commitRoad(name, fromNode, toNode, res.raw, kind, opts) : -1;
  };
  const routeRoad = (name: string, fromNode: number, fromOut: Vec3, toNode: number, toIn: Vec3, kind: RegionRoadKind, opts: RoadOpts) => {
    const a = nodeSpecs[fromNode];
    const b = nodeSpecs[toNode];
    const width = ROAD[kind].width;
    const padCos = keepPads.filter((s) => !opts.ownPads.includes(s)).map((s) => ({ c: s.dir, cos: Math.cos((s.padR + s.blend * 0.5) / R) }));
    const ownCos = opts.ownPads.map((s) => ({ c: s.dir, cos: Math.cos((s.padR - 1) / R) }));
    const plazaCos = gates.filter((g) => !opts.ownPlazas.includes(g.id) && g.nodes.length).map((g) => ({ c: g.dir, cos: Math.cos((g.r + 4) / R) }));
    const summitCos = Math.cos(9 / R);
    const ends = [a.dir, b.dir];
    const forest = opts.forest ?? 0.6;
    const keepOut = (d: Vec3, h: number) => {
      if (dot(d, city) > cosRim) return Infinity;
      for (const p of padCos) if (dot(d, p.c) > p.cos) return Infinity;
      // its own towns' pads: only in through the gate (the pad's core is the town's streets)
      for (const p of ownCos) if (dot(d, p.c) > p.cos) return Infinity;
      for (const p of plazaCos) if (dot(d, p.c) > p.cos) return Infinity;
      for (const ap of airports) {
        if (segDist(d, ap.ends[0], ap.ends[1]) < RUNWAY_W / 2 + 7) return Infinity;
        // (and well off the apron, so its causeway has some length) unless it is this road's own end
        if (!ends.some((e) => arc(e, ap.apron) < ap.apronR + 2) && arc(d, ap.apron) < ap.apronR + 13) return Infinity;
      }
      for (const p of piers) if (segDist(d, p.root, p.berth) < 6) return Infinity;
      if (dot(d, summit) > summitCos) return Infinity;
      if (lookout.c && !ends.some((e) => dot(e, lookout.c!) > 0.99999) && arc(d, lookout.c) < 9) return Infinity;
      for (const r of routed) {
        if (dot(d, r.c) < r.cosR) continue;
        let skip = false;
        // roads that share an end node, or leave the same plaza, may come close near it
        for (const e of r.ends) for (const f of ends) if (dot(e, f) > 0.999999 && dot(d, e) > Math.cos(18 / R)) skip = true;
        for (const gid of r.plazas) if (opts.ownPlazas.includes(gid) && arc(d, gates[gid].dir) < gates[gid].r + 10) skip = true;
        if (skip) continue;
        const lim = ((r.width + width) / 2 + 5) / R;
        const lim2 = lim * lim;
        const P = r.pts;
        for (const ch of r.chunks) {
          if (d.x * ch.x + d.y * ch.y + d.z * ch.z < ch.cosR) continue;
          for (let i = ch.i0; i < ch.i1; i += 3) {
            const dx = P[i] - d.x, dy = P[i + 1] - d.y, dz = P[i + 2] - d.z;
            if (dx * dx + dy * dy + dz * dz < lim2) return Infinity;
          }
        }
      }
      // prefer a few metres inland (the verge and its banks stay on land, the coast keeps its
      // shape), not tight against the plateau, and through meadow rather than under the trees
      let extra = h < 1.4 && h >= WATER_H ? (1.4 - h) * 3.5 : 0;
      const ca = Math.acos(Math.min(1, dot(d, city)));
      if (ca < rimNear) extra += (rimNear - ca) * R * 0.12;
      if (h > 2.2 && forest > 0) {
        const m = base.moistureAt(d);
        if (m > 0.58) extra += forest * Math.min(1, (m - 0.58) * 8);
      }
      return extra;
    };
    const spec: RouteSpec = {
      a: a.dir,
      b: b.dir,
      ta: fromOut,
      tb: toIn,
      // straight out of a junction and into the next for longer than its patch, so its turns are clean
      // (shorter on a short road, which needs the room to turn)
      lead: Math.min(8, Math.max(4, arc(a.dir, b.dir) * 0.22)),
      cell: opts.cell ?? (arc(a.dir, b.dir) > 110 || opts.polar ? 3 : 2.5),
      halfWidth: Math.max(26, arc(a.dir, b.dir) * 0.55),
      polar: opts.polar ? { centre: city, theta0: rimTheta, sign: opts.polar, vMin: -9, vMax: 34 } : undefined,
      height: H,
      keepOut,
      waterH: opts.causeway ? -3.2 : WATER_H,
      bridges: !!opts.bridges,
      waterCost: 3,
      bridgeStart: 25,
      // (a highway's long bends get more rounding: it is the fastest road)
      relax: kind === 'highway' ? 140 : undefined,
    };
    const tr0 = performance.now();
    const ctrl = cached(`route:${name}`, [a.dir.x, a.dir.y, a.dir.z, b.dir.x, b.dir.y, b.dir.z, fromOut.x, fromOut.y, fromOut.z, toIn.x, toIn.y, toIn.z, width, opts.polar ?? 0, opts.bridges ? 1 : 0, opts.causeway ? 1 : 0], () => {
      const r = routeSearch(spec);
      prof['route.opened'] = (prof['route.opened'] ?? 0) + r.opened;
      return r.ctrl ? [1, ...r.ctrl] : [0];
    }, 'f32');
    prof['route.ms'] = (prof['route.ms'] ?? 0) + performance.now() - tr0;
    if (!ctrl[0]) {
      failed.push(name);
      if (DEBUG) {
        const la = step(a.dir, fromOut, spec.lead!, v3());
        const lb = step(b.dir, toIn, -spec.lead!, v3());
        console.log('[region] no route', name, 'keepOut a', keepOut(la, H(la)), 'b', keepOut(lb, H(lb)), 'arc', arc(a.dir, b.dir).toFixed(1));
      }
      return null;
    }
    const tf0 = performance.now();
    const dirs = routeFinish(spec, ctrl.subarray(1));
    const raw = wpath(dirs, new Float64Array(dirs.length / 3));
    prof['finish.ms'] = (prof['finish.ms'] ?? 0) + performance.now() - tf0;
    return { raw };
  };
  /** Profile, grade, bridge and commit a road along raw centreline `raw` (heights ignored). */
  const commitRoad = (name: string, fromNode: number, toNode: number, raw: WPath, kind: RegionRoadKind, opts: RoadOpts) => {
    const a = nodeSpecs[fromNode];
    const b = nodeSpecs[toNode];
    // a car park at the end of its road sits no higher or lower than the road can climb to it
    if (b.place === 'viewpoint') {
      const reach = MAX_GRADE * 0.85 * Math.max(0, raw.length - 10);
      b.h = Math.max(a.h - reach, Math.min(a.h + reach, b.h));
    }
    const width = ROAD[kind].width;
    const n = raw.h.length;
    // base heights every ~2 m (the profile is smoothed over ±7 m anyway), interpolated between
    const idx: number[] = [];
    let lastS = -Infinity;
    for (let i = 0; i < n; i++) {
      if (i === n - 1 || raw.s[i] - lastS >= 2) {
        idx.push(i);
        lastS = raw.s[i];
      }
    }
    const got = cached(`prof:${name}`, [n, raw.length, raw.dir[0], raw.dir[1], raw.dir[2], raw.dir[n * 3 - 3], raw.dir[n * 3 - 2], raw.dir[n * 3 - 1]], () => {
      const out: number[] = [];
      const d = v3();
      for (const i of idx) {
        d.x = raw.dir[i * 3];
        d.y = raw.dir[i * 3 + 1];
        d.z = raw.dir[i * 3 + 2];
        out.push(H(d));
      }
      return out;
    }, 'mm16');
    const base0 = new Float64Array(n);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      base0[i] = got[k];
      if (k > 0) {
        const j0 = idx[k - 1];
        for (let j = j0 + 1; j < i; j++) base0[j] = base0[j0] + ((base0[i] - base0[j0]) * (raw.s[j] - raw.s[j0])) / (raw.s[i] - raw.s[j0] || 1);
      }
    }
    const spans: Array<[number, number]> = [];
    // How far from each end the raw line still turns tighter than a lane can (the corner the node's
    // patch will swallow, its trim running ~2–3 m past: a span starts ≥ 9 m past it, so a causeway leads to its abutment)
    const sharpEnd = (fromEnd: boolean) => {
      let far = 0;
      const P = (i: number, o: number[]) => {
        o[0] = raw.dir[i * 3] * R;
        o[1] = raw.dir[i * 3 + 1] * R;
        o[2] = raw.dir[i * 3 + 2] * R;
      };
      const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
      for (let k = 1; k < n - 1; k++) {
        const i = fromEnd ? n - 1 - k : k;
        const sd = fromEnd ? raw.length - raw.s[i] : raw.s[i];
        if (sd > 16) break;
        let i0 = i, i1 = i;
        while (i0 > 0 && raw.s[i] - raw.s[i0] < 1) i0--;
        while (i1 < n - 1 && raw.s[i1] - raw.s[i] < 1) i1++;
        P(i0, A);
        P(i, B);
        P(i1, C);
        const ab = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]), bc = Math.hypot(C[0] - B[0], C[1] - B[1], C[2] - B[2]), ca = Math.hypot(A[0] - C[0], A[1] - C[1], A[2] - C[2]);
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        if (ar > 1e-9 && (ab * bc * ca) / (2 * ar) < 5) far = sd;
      }
      return far;
    };
    // the fills a span must not stand over: every town pad and gate plaza with most of its bank
    const fills = [...keepPads.map((t) => ({ c: t.dir, cos: Math.cos((t.padR + t.blend * 0.7) / R) })), ...gates.filter((g) => g.nodes.length).map((g) => ({ c: g.dir, cos: Math.cos((g.r + 5) / R) }))];
    if (opts.bridges) {
      let i = 0;
      while (i < n) {
        if (base0[i] < WATER_H) {
          let j = i;
          while (j < n - 1 && base0[j + 1] < WATER_H) j++;
          // abutments on dry ground (≥ 0.9 m, within 12 m): the approach fills never reach the water
          let a0 = i;
          while (a0 > 0 && base0[a0 - 1] < 0.9 && raw.s[i] - raw.s[a0 - 1] < 12) a0--;
          let b0 = j;
          while (b0 < n - 1 && base0[b0 + 1] < 0.9 && raw.s[b0 + 1] - raw.s[j] < 12) b0++;
          // (and never within 10.5 m of the road's ends: a span leaving a plaza straight over the water
          // starts after a short causeway, so its deck has room to reach DECK_MIN)
          const sp: [number, number] = [Math.max(10.5, sharpEnd(false) + 9, raw.s[a0] - 1.5), Math.min(raw.length - 10.5, raw.length - sharpEnd(true) - 9, raw.s[b0] + 1.5)];
          // A bridge only over open water: ≥ BRIDGE_WET of the span over the sea, away from any pad or
          // plaza fill (whose banks would close under it), and ≥ BRIDGE_MIN long; else the road stays
          // a graded causeway across the shallows (the carve fills them).
          let wet = 0, tot = 0;
          for (let k = 0; k < n; k++) {
            if (raw.s[k] < sp[0] || raw.s[k] > sp[1]) continue;
            tot++;
            const x = raw.dir[k * 3], y = raw.dir[k * 3 + 1], z = raw.dir[k * 3 + 2];
            if (base0[k] >= 0) continue;
            if (fills.some((f) => x * f.c.x + y * f.c.y + z * f.c.z > f.cos)) continue;
            wet++;
          }
          if (sp[1] - sp[0] >= BRIDGE_MIN && tot > 0 && wet / tot >= BRIDGE_WET) spans.push(sp);
          if (DEBUG) console.log('[region] span', name, sp.map((x) => x.toFixed(1)).join('..'), 'wet', wet, '/', tot, 'len', raw.length.toFixed(1));
          i = b0 + 1;
        } else i++;
      }
    }
    // Inside a flat primitive (the plaza it leaves, its towns' pads, an apron) the road lies at its level.
    const fixed = new Float64Array(n).fill(NaN);
    const flats: Array<{ c: Vec3; cos: number; h: number }> = [
      ...opts.ownPlazas.map((g) => ({ c: gates[g].dir, cos: Math.cos((gates[g].r + 0.5) / R), h: gates[g].h })),
      ...opts.ownPads.map((t) => ({ c: t.dir, cos: Math.cos((t.padR - 0.2) / R), h: t.h })),
      ...airports.map((ap) => ({ c: ap.apron, cos: Math.cos((ap.apronR - 0.2) / R), h: ap.h })),
      // a terminal turnaround (an airport's, a lookout's car park) is a paved disc: flat round its end
      ...[a, b].filter((n) => n.place === 'airport' || n.place === 'viewpoint').map((n) => ({ c: n.dir, cos: Math.cos((turningRadius(width / 2) + 2.3) / R), h: n.h - ROAD_H })),
    ];
    for (let i = 0; i < n; i++) {
      const x = raw.dir[i * 3], y = raw.dir[i * 3 + 1], z = raw.dir[i * 3 + 2];
      for (const f of flats) if (x * f.c.x + y * f.c.y + z * f.c.z >= f.cos) fixed[i] = f.h;
    }
    const tg0 = performance.now();
    const prof2 = gradeProfile(raw.s, base0, a.h - ROAD_H, b.h - ROAD_H, spans, fixed);
    if (DEBUG && process.env.LB_REGION_DUMP === name) console.log('[region] profile', name, Array.from({ length: Math.min(16, n) }, (_, i) => `s${raw.s[i].toFixed(2)} b${base0[i].toFixed(2)} f${fixed[i] === fixed[i] ? fixed[i].toFixed(2) : '-'} h${prof2.h[i].toFixed(2)}`).join(' '));
    prof['grade.ms'] = (prof['grade.ms'] ?? 0) + performance.now() - tg0;
    const hs = new Float64Array(n);
    for (let i = 0; i < n; i++) hs[i] = prof2.h[i] + ROAD_H;
    const path = wpath(raw.dir, hs);
    // decimated points (every ~3 m) and a bounding cap for later roads' clearance test
    const pts: number[] = [];
    for (let i = 0; i < n; i += 3) pts.push(raw.dir[i * 3], raw.dir[i * 3 + 1], raw.dir[i * 3 + 2]);
    const mid = n >> 1;
    const c = v3(raw.dir[mid * 3], raw.dir[mid * 3 + 1], raw.dir[mid * 3 + 2]);
    let maxA = 0;
    for (let i = 0; i < pts.length; i += 3) maxA = Math.max(maxA, Math.acos(Math.min(1, pts[i] * c.x + pts[i + 1] * c.y + pts[i + 2] * c.z)));
    const chunks: Chunk[] = [];
    for (let i0 = 0; i0 < pts.length; i0 += 24) {
      const i1 = Math.min(pts.length, i0 + 24);
      let cx = 0, cy = 0, cz = 0;
      for (let i = i0; i < i1; i += 3) {
        cx += pts[i];
        cy += pts[i + 1];
        cz += pts[i + 2];
      }
      const cl = Math.hypot(cx, cy, cz) || 1;
      cx /= cl;
      cy /= cl;
      cz /= cl;
      let ma = 0;
      for (let i = i0; i < i1; i += 3) ma = Math.max(ma, Math.acos(Math.min(1, pts[i] * cx + pts[i + 1] * cy + pts[i + 2] * cz)));
      chunks.push({ x: cx, y: cy, z: cz, cosR: Math.cos(ma + 16 / R), i0, i1 });
    }
    const entry = { pts: Float64Array.from(pts), width, ends: [a.dir, b.dir], c, cosR: Math.cos(maxA + 22 / R), plazas: opts.ownPlazas, edge: -1, chunks };
    routed.push(entry);
    const info = spans.map(([s0, s1]) => {
      let deckMin = Infinity, clear = Infinity;
      for (let i = 0; i < n; i++) {
        if (raw.s[i] < s0 || raw.s[i] > s1 || base0[i] >= WATER_H) continue;
        deckMin = Math.min(deckMin, hs[i]);
        clear = Math.min(clear, hs[i] - Math.max(0, base0[i]));
      }
      return { deckMin, clearance: clear };
    });
    entry.edge = addEdge(fromNode, toNode, path, kind, name, -1, false, spans, info);
    return entry.edge;
  };
  /** Split edge spec i at arc length s with a new junction node (both halves keep the profile). */
  const splitEdge = (i: number, sAt: number, place: NodePlace = 'junction'): number => {
    const e = edgeSpecs[i];
    const o = wsampleOut();
    wsample(e.raw, sAt, o);
    const J = addNode(v3(o.dx, o.dy, o.dz), o.h, place, -1);
    const first = wtrim(e.raw, 0, sAt);
    const second = wtrim(e.raw, sAt, e.raw.length);
    const spans = e.bridges ?? [];
    const info = e.bridgeInfo ?? [];
    const pickSpans = (lo: number, hi: number, shift: number) => {
      const b: Array<[number, number]> = [];
      const bi: Array<{ deckMin: number; clearance: number }> = [];
      spans.forEach(([a0, a1], k) => {
        if (a1 > lo && a0 < hi) {
          b.push([Math.max(lo, a0) - shift, Math.min(hi, a1) - shift]);
          bi.push(info[k]);
        }
      });
      return { b, bi };
    };
    const p1 = pickSpans(0, sAt, 0);
    const p2 = pickSpans(sAt, e.raw.length, sAt);
    edgeSpecs[i] = { ...e, b: J, raw: first, bridges: p1.b, bridgeInfo: p1.bi };
    edgeSpecs.push({ ...e, a: J, raw: second, bridges: p2.b, bridgeInfo: p2.bi });
    // a road from the new junction may come close to this one near it
    for (const r of routed) if (r.edge === i) r.ends.push(nodeSpecs[J].dir);
    return J;
  };
  /** The arc length on edge spec i, ≥ `margin` from both ends and off any bridge, nearest to `target`. */
  const nearestOn = (i: number, target: Vec3, margin: number) => {
    const e = edgeSpecs[i];
    const o = wsampleOut();
    const q = v3();
    let best = -1;
    let bd = Infinity;
    for (let sv = margin; sv <= e.raw.length - margin; sv += 1) {
      if ((e.bridges ?? []).some(([b0, b1]) => sv > b0 - 10 && sv < b1 + 10)) continue;
      wsample(e.raw, sv, o);
      q.x = o.dx;
      q.y = o.dy;
      q.z = o.dz;
      const d = arc(q, target);
      if (d < bd) {
        bd = d;
        best = sv;
      }
    }
    return best;
  };
  const wsampleDir = (p: WPath, sv: number) => {
    const o = wsample(p, sv, wsampleOut());
    return v3(o.dx, o.dy, o.dz);
  };
  /**
   * The tangent a road leaves a town gate along: straight on from the town street that ends there
   * (a gate is a bend: the road continues the street, no kink), else straight out from the centre.
   */
  const gateOut = (s: Settlement, i: number) => {
    const g = gateNodes.get(s)![i];
    const gd = nodeSpecs[g].dir;
    for (const id of s.streets) {
      const e = edgeSpecs[id];
      if (e.a !== g && e.b !== g) continue;
      const p = e.raw;
      const n = p.h.length;
      // a point ~2 m back along the street from the gate
      let j = e.b === g ? n - 1 : 0;
      const sg = e.b === g ? -1 : 1;
      const s0 = p.s[j];
      while (j + sg >= 0 && j + sg < n && Math.abs(p.s[j] - s0) < 2) j += sg;
      return awayTangent(v3(p.dir[j * 3], p.dir[j * 3 + 1], p.dir[j * 3 + 2]), gd, v3());
    }
    return awayTangent(s.dir, gd, v3());
  };
  const gateIn = (s: Settlement, i: number) => {
    const t = gateOut(s, i);
    t.x = -t.x;
    t.y = -t.y;
    t.z = -t.z;
    return t;
  };
  const armIn = (nd: number, centre: Vec3) => towardTangent(centre, nodeSpecs[nd].dir, v3());

  // The rim road from the east gate round to the south gate. (None round the north: the shore there is
  // a thin strip under the plateau, the lighthouse's headland and the shoulder by the east gate.)
  {
    const c = armNodeOf.get(`${gEast.id}:cw`);
    const d = armNodeOf.get(`${gSouth.id}:ccw`);
    if (c !== undefined && d !== undefined) roadTo('rim road', c, armOut(c, gEast.dir), d, armIn(d, gSouth.dir), 'road', { ownPads: [], ownPlazas: [gEast.id, gSouth.id], polar: 1 });
  }
  // The west: the mill road round the plateau past the windmills to millbrook, the coast road on round
  // the south of the plateau to port pebble on its cape; the harbour road from there up to the south gate.
  let millRoad = -1;
  if (millbrook) {
    const a = armNodeOf.get(`${gWest.id}:ccw`)!;
    millRoad = roadTo('mill road', a, armOut(a, gWest.dir), gateNodes.get(millbrook)![0], gateIn(millbrook, 0), 'road', { ownPads: [millbrook], ownPlazas: [gWest.id], polar: -1 });
    gWest.leadsTo.push(millbrook.id);
  }
  let coastRoad = -1;
  if (millbrook && portPebble && gateNodes.get(millbrook)!.length > 1 && gateNodes.get(portPebble)!.length > 1) {
    coastRoad = roadTo('coast road', gateNodes.get(millbrook)![1], gateOut(millbrook, 1), gateNodes.get(portPebble)![1], gateIn(portPebble, 1), 'road', { bridges: true, ownPads: [millbrook, portPebble], ownPlazas: [], polar: -1 });
  }
  if (portPebble) {
    // (the plaza's arm is aimed at the town and the town's back gate at the plaza: straight across)
    const b = armNodeOf.get(`${gSouth.id}:to`)!;
    const ga = gateNodes.get(portPebble)![0];
    const bd = nodeSpecs[b].dir;
    const gd = nodeSpecs[ga].dir;
    commitRoad('harbour road', ga, b, wpath([gd.x, gd.y, gd.z, bd.x, bd.y, bd.z], [0, 0]), 'road', { ownPads: [portPebble], ownPlazas: [gSouth.id] });
    gSouth.leadsTo.push(portPebble.id);
  }
  // The capital's airport: a causeway out over the lagoon from a T on the coast road nearest its apron.
  const capAirport = airports.find((a) => a.settlement === 0);
  const sideRoad = capAirport ? [coastRoad, millRoad].filter((i) => i >= 0).map((i) => ({ i, sAt: nearestOn(i, capAirport.apron, 22) })).filter((x) => x.sAt > 0).sort((p, q) => arc(wsampleDir(edgeSpecs[p.i].raw, p.sAt), capAirport.apron) - arc(wsampleDir(edgeSpecs[q.i].raw, q.sAt), capAirport.apron))[0] : undefined;
  if (capAirport && sideRoad) {
    const sAt = sideRoad.sAt;
    {
      const J = splitEdge(sideRoad.i, sAt);
      const jd = nodeSpecs[J].dir;
      const endDir = walk(capAirport.apron, hd(capAirport.apron, jd), capAirport.apronR * 0.3, v3());
      const E = addNode(endDir, capAirport.h + ROAD_H, 'airport', 0);
      capAirport.node = E;
      // the causeway leaves the coast road square to it (the nearest point), straight out over the lagoon
      commitRoad('airport causeway', J, E, wpath([jd.x, jd.y, jd.z, endDir.x, endDir.y, endDir.z], [0, 0]), 'access', { causeway: true, ownPads: [], ownPlazas: [] });
    }
  }
  // The lighthouse road: north from the north-west gate to a car park on the headland, short of the
  // lighthouse (a viewpoint over the open sea).
  {
    const a = armNodeOf.get(`${gWest.id}:cw`);
    const v = cached('lookout:lighthouse', [lighthouse.x, lighthouse.y, lighthouse.z, gWest.dir.x, gWest.dir.y, gWest.dir.z], () => {
      // on the headland's spine between the gate and the tip, ≥ 16 m short of the lighthouse's tip,
      // the most sea in view (a car park facing out), dry and gentle
      let best: Vec3 | null = null;
      let bs = -Infinity;
      for (const c of grid(lighthouse, 24, 3)) {
        const h = H(c);
        if (h < 0.8 || arc(c, lighthouse) < 12 || cityDist(c) < CITY_PLAN_RADIUS + 14) continue;
        let flat = 0;
        for (let i = 0; i < 6; i++) flat = Math.max(flat, Math.abs(Hat(c, i * 1.047, 5) - h));
        if (flat > 1.2) continue;
        const sea = seaAround(c, 16).k;
        const s = sea * 0.5 - flat * 1.5 - arc(c, lighthouse) * 0.03 + h * 0.2;
        if (s > bs) {
          bs = s;
          best = c;
        }
      }
      return best ? [best.x, best.y, best.z, H(best)] : [];
    });
    if (a !== undefined && v.length) {
      const c = v3(v[0], v[1], v[2]);
      const E = addNode(c, Math.max(LAND_MIN, v[3]) + ROAD_H, 'viewpoint', -1);
      if (roadTo('lighthouse road', a, armOut(a, gWest.dir), E, towardTangent(c, nodeSpecs[a].dir, v3()), 'access', { ownPads: [], ownPlazas: [gWest.id] }) >= 0) {
        lookouts.push({ name: 'lighthouse point', dir: c, h: nodeSpecs[E].h, node: E });
        gWest.leadsTo.push('lighthouse point');
      }
    }
  }
  // The east: from the east gate the alpine road climbs the pass in hairpins (laid out in the valley's
  // pass frame: u across the ramp, v from the meadow toward the city) into snowberry's gate.
  if (snowberry) {
    const out = armNodeOf.get(`${gEast.id}:out`)!;
    const gate = gateNodes.get(snowberry)![0];
    const uvOf = (d: Vec3) => {
      const q = dirToChart(passFrame, d);
      return [q.x, q.z] as [number, number];
    };
    const [uA, vA] = uvOf(nodeSpecs[out].dir);
    const [uG, vG] = uvOf(nodeSpecs[gate].dir);
    // across the foot of the ramp, one wide hairpin, back across under the saddle and in over it to
    // the gate (planet.ts VALLEY: the ramp corridor). One hairpin, wide: the legs far apart keep the
    // bank between them (the climb, ~6 m) a slope, not a wall, and the inside of the bend clear of the
    // road; a hairpin at all only because the direct way up (≈ 45 m for ≈ 9.5 m) is far over
    // MAX_GRADE (spec'd).
    const rf = 9.5;
    // (out of the roundabout's arm radially for a straight lead, then the first bend onto the ramp)
    const lead = walk(nodeSpecs[out].dir, hd(gEast.dir, nodeSpecs[out].dir), 1, v3());
    const [uL, vL] = uvOf(lead);
    const v1 = vA - 14;
    const uX = uA + ((uL - uA) * (v1 - vA)) / (vL - vA || -1);
    const v2 = v1 - 2 * rf;
    // the ramp spans the pass corridor: the hairpin only where it can hold it
    const fits = Math.abs(uA) < 40 && vA > 56 && vA < 80 && vL < vA && v2 - vG >= 7 && Math.abs(uG) < 8;
    if (DEBUG) console.log('[region] alpine', JSON.stringify({ uA, vA, uG, vG, v1, v2, uX, fits }));
    if (fits) {
      const uE = 22;
      const ctrl: Array<[number, number]> = [[uA, vA], [uX, v1], [uE, v1], [uE, v2], [uG, v2], [uG, vG]];
      const pts = filletPoly(ctrl, rf, [0, 7, rf, rf, 7]);
      const D: number[] = [];
      const t = v3();
      for (let i = 0; i < pts.length; i += 2) {
        chartToDir(passFrame, pts[i], pts[i + 1], t);
        D.push(t.x, t.y, t.z);
      }
      // (pinned exactly on the nodes)
      D[0] = nodeSpecs[out].dir.x;
      D[1] = nodeSpecs[out].dir.y;
      D[2] = nodeSpecs[out].dir.z;
      D[D.length - 3] = nodeSpecs[gate].dir.x;
      D[D.length - 2] = nodeSpecs[gate].dir.y;
      D[D.length - 1] = nodeSpecs[gate].dir.z;
      commitRoad('alpine road', out, gate, wpath(D, new Float64Array(D.length / 3)), 'road', { ownPads: [snowberry], ownPlazas: [gEast.id] });
    } else roadTo('alpine road', out, armOut(out, gEast.dir), gate, gateIn(snowberry, 0), 'road', { ownPads: [snowberry], ownPlazas: [gEast.id], forest: 0.3 });
    gEast.leadsTo.push(snowberry.id);
  }
  // The island resort: the cove road leaves the east gate north over the shoulder and bridges the
  // channel to coral cove.
  if (cove) {
    const a = armNodeOf.get(`${gEast.id}:ccw`)!;
    roadTo('cove road', a, armOut(a, gEast.dir), gateNodes.get(cove)![0], gateIn(cove, 0), 'road', { bridges: true, ownPads: [cove], ownPlazas: [gEast.id] });
    gEast.leadsTo.push(cove.id);
  }
  // The far continent: the airport road, the highway to clover, the lookout road.
  if (farHaven) {
    const fh = farHaven;
    const gs = gateNodes.get(fh)!;
    let k = 1;
    const fhv = airports.find((a) => a.settlement === fh.index);
    if (fhv && gs[k] !== undefined) {
      const endDir = walk(fhv.apron, hd(fhv.apron, fh.dir), fhv.apronR * 0.3, v3());
      const E = addNode(endDir, fhv.h + ROAD_H, 'airport', fh.index);
      fhv.node = E;
      roadTo('airport road', gs[k], gateOut(fh, k), E, towardTangent(fhv.apron, endDir, v3()), 'access', { ownPads: [fh], ownPlazas: [] });
      k++;
    }
    if (clover && gs[k] !== undefined) {
      roadTo('clover highway', gs[k], gateOut(fh, k), gateNodes.get(clover)![0], gateIn(clover, 0), 'highway', { ownPads: [fh, clover], ownPlazas: [] });
      k++;
    }
    if (lookout.c && gs[k] !== undefined) {
      const lh = cached('lookout:h', [lookout.c.x, lookout.c.y, lookout.c.z], () => [H(lookout.c!)])[0];
      const E = addNode(lookout.c, Math.max(LAND_MIN, lh) + ROAD_H, 'viewpoint', -1);
      if (roadTo('lookout road', gs[k], gateOut(fh, k), E, towardTangent(lookout.c, nodeSpecs[gs[k]].dir, v3()), 'access', { ownPads: [fh], ownPlazas: [] }) >= 0) lookouts.push({ name: 'the lookout', dir: v3(lookout.c.x, lookout.c.y, lookout.c.z), h: nodeSpecs[E].h, node: E });
    }
  }
  mark('roads');

  // ── 6. Build the network, components ──
  // A road that found no route leaves its end nodes short: drop nodes left with no edge at all.
  {
    const deg = new Int32Array(nodeSpecs.length);
    for (const e of edgeSpecs) {
      deg[e.a]++;
      deg[e.b]++;
    }
    const remap = new Int32Array(nodeSpecs.length).fill(-1);
    const kept: NodeSpec[] = [];
    nodeSpecs.forEach((n, i) => {
      if (deg[i] > 0) {
        remap[i] = kept.length;
        kept.push(n);
      }
    });
    if (kept.length !== nodeSpecs.length) {
      for (const e of edgeSpecs) {
        e.a = remap[e.a];
        e.b = remap[e.b];
      }
      const fix = (ids: number[]) => ids.map((i) => remap[i]).filter((i) => i >= 0);
      for (const s of settlements) {
        s.nodes = fix(s.nodes);
        s.gates = s.style === 'capital' ? s.gates : fix(s.gates);
      }
      for (const g of gates) g.nodes = fix(g.nodes);
      for (const p of piers) p.node = p.node >= 0 ? remap[p.node] : -1;
      for (const ap of airports) ap.node = ap.node >= 0 ? remap[ap.node] : -1;
      for (const l of lookouts) l.node = remap[l.node];
      nodeSpecs.length = 0;
      nodeSpecs.push(...kept);
    }
  }
  // The network itself (patches, trims, lanes, connectors) is built on first read of region.nodes /
  // edges / bridges / lanes: the carve below needs only the specs' centrelines.
  let net: ReturnType<typeof buildNetwork> | null = null;
  const network = () => (net ??= buildNetwork(nodeSpecs, edgeSpecs));
  // Components: union-find over edges.
  const parent = nodeSpecs.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of edgeSpecs) parent[find(e.a)] = find(e.b);
  const compOf = new Map<number, number>();
  const components: number[][] = [];
  // The capital's component first.
  const order = nodeSpecs.map((n, id) => ({ id, first: (n.settlement ?? -1) === 0 || (n.gate ?? -1) >= 0 })).sort((p, q) => (p.first ? -1 : 0) - (q.first ? -1 : 0) || p.id - q.id);
  for (const n of order) {
    const r = find(n.id);
    if (!compOf.has(r)) {
      compOf.set(r, components.length);
      components.push([]);
    }
    components[compOf.get(r)!].push(n.id);
  }
  for (const s of settlements) {
    const anyNode = s.nodes[0] ?? (s.gates.length && s.style === 'capital' ? gates[s.gates[0]].nodes[0] : undefined);
    if (anyNode !== undefined) s.component = compOf.get(find(anyNode)) ?? s.component;
  }
  for (const c of components) c.sort((p, q) => p - q);
  mark('network');

  // ── The ferry: port pebble ⇄ far haven over deep water (built on first read of region.ferries) ──
  let ferries: FerryRoute[] | null = null;
  const ferryPiers = [portPebble, farHaven].map((s) => (s ? piers.find((p) => p.settlement === s.index) : undefined));
  const _fq = v3();
  const buildFerries = (): FerryRoute[] => {
    const out: FerryRoute[] = [];
    const [pa, pb] = ferryPiers;
    if (!pa || !pb) return out;
    const near = (d: Vec3) => Math.min(arc(d, pa.berth), arc(d, pb.berth));
    const r = routeSearch({
      a: pa.berth,
      b: pb.berth,
      ta: headingVector(pa.berth, pa.heading, v3()),
      tb: headingVector(pb.berth, pb.heading + Math.PI, v3()),
      lead: 10,
      cell: 7,
      relax: 0,
      halfWidth: Math.max(90, arc(pa.berth, pb.berth) * 0.45),
      height: base.baseHeightAt,
      keepOut: (d, h) => {
        const depth = -h;
        // (a margin over FERRY_DEPTH on the 7 m search grid, and the water round the cell deep too:
        // the two legs run 3 m either side and the smoothing cuts corners)
        const berth = near(d) < 30;
        const need = berth ? BERTH_DEPTH : FERRY_DEPTH + 0.8;
        if (depth < need) return Infinity;
        if (!berth) for (let k = 0; k < 6; k++) if (-base.baseHeightAt(walk(d, (k * Math.PI) / 3, 6, _fq)) < FERRY_DEPTH) return Infinity;
        for (const ap of airports) if (segDist(d, ap.ends[0], ap.ends[1]) < 16) return Infinity;
        return depth < 6 ? (6 - depth) * 0.25 : 0;
      },
      waterH: 99,
      bridges: true,
      waterCost: 0,
      bridgeStart: 0,
    });
    if (!r.ctrl) return out;
    const spec = {
      a: pa.berth,
      b: pb.berth,
      ta: headingVector(pa.berth, pa.heading, v3()),
      tb: headingVector(pb.berth, pb.heading + Math.PI, v3()),
      lead: 10,
      cell: 7,
      relax: 0,
      halfWidth: Math.max(90, arc(pa.berth, pb.berth) * 0.45),
      height: base.baseHeightAt,
      keepOut: () => 0,
      waterH: 99,
      bridges: true,
    };
    const dirs = routeFinish(spec, r.ctrl);
    // Out on the right of the route, back on the other side (the legs pass port to port), the
    // separation easing to nothing at each berth: the ferry turns round alongside the pier.
    const mid = wpath(dirs, new Float64Array(dirs.length / 3));
    const outLeg = woffset(mid, FERRY_SEPARATION / 2, 1, 30);
    const back = woffset(wreverse(mid), FERRY_SEPARATION / 2, 1, 30);
    const loop = wjoin([outLeg, back]);
    const closed = wpath(loop.dir, loop.h, true);
    out.push({ id: 0, name: `${settlements[pa.settlement].name} ⇄ ${settlements[pb.settlement].name}`, a: pa.id, b: pb.id, lane: closed, berthS: [0, outLeg.length] });
    return out;
  };

  // ── The carve ──
  // Each primitive's dcap (the cut / fill depth its banks widen for) comes from the ground round it:
  // a bounded reach keeps it in few grid cells (cheap to build, cheap to query). All of them are
  // sampled in one memo entry.
  const carve = carveBuilder();
  const depthRound = (c: Vec3, r: number, h: number, k = 10, dryOnly = false) => {
    let m = 0;
    for (let i = 0; i < k; i++) {
      const b = Hat(c, (i / k) * Math.PI * 2, r);
      if (dryOnly && b < 0) continue;
      m = Math.max(m, Math.abs(b - h));
    }
    return m;
  };
  type Job = { add: (dcap: number) => void; dcap: () => number; key: number[] };
  const jobs: Job[] = [];
  for (const s of settlements) {
    if (s.style === 'capital') continue;
    // (banks widen for the cuts and fills on land; toward the sea they stay short, so a coastal pad
    // never spreads a shoal over its harbour)
    const dc = padDcap(s);
    jobs.push({ key: [s.padR], dcap: () => dc, add: (d) => carve.disc(PrimKind.Pad, s.dir, s.padR, s.blend, s.h, s.index, 1, d) });
  }
  for (const g of gates) if (g.nodes.length) jobs.push({ key: [g.r], dcap: () => depthRound(g.dir, g.r + 4, g.h, 8) + 1, add: (d) => carve.disc(PrimKind.Plaza, g.dir, g.r + 1, 6, g.h, -1, 1, d) });
  for (const ap of airports) {
    // A lagoon strip: a low sandy island with wide, gentle beach banks (no saw-tooth of terrain facets
    // against a hard fill edge); a land strip ordinary batters.
    const wet = H(ap.centre) < 0;
    jobs.push({
      key: [ap.h, ap.length],
      dcap: () => Math.max(depthRound(ap.ends[0], 6, ap.h, 6), depthRound(ap.ends[1], 6, ap.h, 6), depthRound(ap.centre, 8, ap.h, 6)) + 1,
      add: (d) => carve.capsule(PrimKind.Runway, ap.ends[0], ap.ends[1], ap.width / 2 + 3.5, wet ? 7 : 4, ap.h, ap.h, carve.group(), ap.width / 2, -1, wet ? 0.6 : 1, d),
    });
    jobs.push({ key: [ap.apronR], dcap: () => depthRound(ap.apron, ap.apronR + 3, ap.h, 6) + 1, add: (d) => carve.disc(PrimKind.Plaza, ap.apron, ap.apronR, wet ? 7 : 4, ap.h, -1, wet ? 0.6 : 1, d) });
    if (wet) {
      // the strip's island: rounded ends past the thresholds and a broader middle round the apron
      for (const f of [-0.62, 0.62]) {
        const c = walk(ap.centre, ap.heading, (f * ap.length), v3());
        jobs.push({ key: [f], dcap: () => depthRound(c, 9, ap.h - 0.4, 6) + 1, add: (d) => carve.disc(PrimKind.Pad, c, 5.5, 8, ap.h - 0.35, -1, 0.6, d) });
      }
    }
  }
  // Turnarounds outside pads (airport terminals, the lookout's car park): paved discs (before the
  // roads, which keep their own bed across its banks).
  const degree = new Int32Array(nodeSpecs.length);
  for (const e of edgeSpecs) {
    degree[e.a]++;
    degree[e.b]++;
  }
  nodeSpecs.forEach((n, id) => {
    if (degree[id] !== 1 || (n.place !== 'airport' && n.place !== 'viewpoint')) return;
    const e = edgeSpecs.find((x) => x.a === id || x.b === id)!;
    const turnR = turningRadius(e.width / 2);
    jobs.push({ key: [turnR], dcap: () => depthRound(n.dir, turnR + 4, n.h - ROAD_H, 6) + 1, add: (d) => carve.disc(PrimKind.Plaza, n.dir, turnR + 2, 4, n.h - ROAD_H, -1, 1, d) });
  });
  const mid = v3();
  edgeSpecs.forEach((e, id) => {
    if ((e.settlement ?? -1) >= 0 || e.kind === 'ring') return; // town streets and rings lie on pads / plazas
    const g = carve.group();
    const c = e.raw;
    const core = e.width / 2 + 1.8;
    const sp = wsampleOut();
    const sq = wsampleOut();
    const L = c.length;
    const nSeg = Math.max(1, Math.ceil(L / 3));
    const spans = (e.bridges ?? []).map(([s0, s1]) => ({ s0, s1 }));
    const causeway = e.name === 'airport causeway';
    // each span's abutment planes (into the span at both ends): the causeways stop at them
    const abuts = spans.map((b) => {
      const at = (sv: number, sign: number): Abutment => {
        const q = wsample(c, sv, wsampleOut());
        const n = normalize3(v3(q.tx * sign, q.ty * sign, q.tz * sign));
        return { n, off: n.x * q.dx + n.y * q.dy + n.z * q.dz };
      };
      return { s0: b.s0, s1: b.s1, a: at(b.s0, 1), b: at(b.s1, -1) };
    });
    let side = 0;
    for (let k = 0; k < nSeg; k++) {
      const s0 = (k * L) / nSeg;
      const s1 = ((k + 1) * L) / nSeg;
      const gk = g;
      if (spans.some((b) => s1 > b.s0 + 1 && s0 < b.s1 - 1)) continue;
      wsample(c, s0, sp);
      wsample(c, s1, sq);
      const a = v3(sp.dx, sp.dy, sp.dz);
      const b = v3(sq.dx, sq.dy, sq.dz);
      const ha = sp.h - ROAD_H;
      const hb = sq.h - ROAD_H;
      const tx = sp.tx, ty = sp.ty, tz = sp.tz;
      const kk = k;
      // the nearest abutment within a bank's reach (before a span's start or after its end)
      let abut: Abutment | undefined;
      let ad = 30;
      for (const ab of abuts) {
        if (s1 <= ab.s0 + 1 && ab.s0 - s1 < ad) {
          ad = ab.s0 - s1;
          abut = ab.a;
        }
        if (s0 >= ab.s1 - 1 && s0 - ab.s1 < ad) {
          ad = s0 - ab.s1;
          abut = ab.b;
        }
      }
      jobs.push({
        key: [id, k],
        dcap: () => {
          mid.x = a.x + b.x;
          mid.y = a.y + b.y;
          mid.z = a.z + b.z;
          normalize3(mid);
          // the bank on either side: the deeper of the centreline cut / fill and the ground 6 m out
          const bed = (ha + hb) / 2;
          // (lateral samples on every third segment, 6 and 11 m out either side — a cut into a
          // mountainside widens its bank for the slope beyond — the previous ones carried over between)
          if (kk % 3 === 0) {
            const head = headingOf(mid, v3(tx, ty, tz));
            side = 0;
            for (const m of [6, 11]) side = Math.max(side, Math.abs(Hat(mid, head + Math.PI / 2, m) - bed) * (6 / m) ** 0.3, Math.abs(Hat(mid, head - Math.PI / 2, m) - bed) * (6 / m) ** 0.3);
          }
          return Math.max(Math.abs(H(mid) - bed), side) + 0.8;
        },
        add: (d) => carve.capsule(PrimKind.Road, a, b, core, causeway ? 2.5 : 4, ha, hb, gk, e.width / 2, id, 1, d, s0, abut),
      });
    }
  });
  const dcaps = cached('carve', [jobs.length, ...jobs.flatMap((j) => j.key)], () => jobs.map((j) => j.dcap()), 'cm16');
  jobs.forEach((j, i) => j.add(dcaps[i]));
  const tc0 = performance.now();
  const cv = carve.build();
  prof['carve.build.ms'] = performance.now() - tc0;
  mark('carve');

  if (failed.length && process.env.NODE_ENV !== 'production' && process.env.LB_REGION_QUIET !== '1') console.warn(`[littlebig] region: no route for ${failed.join(', ')}`);
  const buildMs = performance.now() - t0;
  const region: Region & { stats: Record<string, number>; memo: Memo; debugAt: typeof cv.debugAt } = {
    seed,
    settlements,
    gates,
    nodes: [],
    edges: [],
    lanes: [],
    connectors: [],
    bridges: [],
    piers,
    ferries: [],
    airports,
    lookouts,
    rail: [],
    components,
    carve: cv.carve,
    surface: cv.surface,
    debugAt: cv.debugAt,
    buildMs,
    stats: { samples, prims: cv.count, failed: failed.length, hits: memo.stats.hits, misses: memo.stats.misses, ...prof },
    memo,
  };
  // The network (nodes, edges, bridges, then lanes and connectors) and the ferry are built on first
  // read: the carve (the terrain's first-frame path) needs none of them. (Non-enumerable, so the dev
  // deep-freeze does not build them early.)
  Object.defineProperties(region, {
    nodes: { get: () => network().nodes, enumerable: false },
    edges: { get: () => network().edges, enumerable: false },
    bridges: { get: () => network().bridges, enumerable: false },
    lanes: { get: () => network().transit().lanes, enumerable: false },
    connectors: { get: () => network().transit().connectors, enumerable: false },
    ferries: { get: () => (ferries ??= buildFerries()), enumerable: false },
    memo: { value: memo, enumerable: false },
  });
  return region;
}

const cross = (a: Vec3, b: Vec3) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

function near(a: Vec3, b: Vec3 | undefined, m: number): boolean {
  return !!b && arc(a, b) < m;
}

/**
 * The road's height profile (bed, m above sea level) over arc lengths S: the base terrain smoothed
 * (±7 m, twice), kept LAND_MIN − ROAD_H above the sea, over each bridge span a deck arching to at
 * least DECK_MIN over the water (and at its abutments), eased into the pinned end heights over 14 m,
 * then graded to MAX_GRADE by forward and backward passes (the pinned ends win).
 */
export function gradeProfile(S: Float64Array, baseH: Float64Array, ha: number, hb: number, spans: Array<[number, number]>, fixed?: Float64Array): { h: Float64Array } {
  const n = S.length;
  const L = S[n - 1] || 1;
  let t = Float64Array.from(baseH, (h) => Math.max(h, LAND_MIN - ROAD_H));
  // smooth (box ±7 m, two passes, on a uniform-ish sampling)
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(n);
    let lo = 0, hi = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      while (hi < n && S[hi] <= S[i] + 7) sum += t[hi++];
      while (S[lo] < S[i] - 7) sum -= t[lo++];
      out[i] = sum / (hi - lo);
    }
    t = out;
  }
  // bridge decks: an arch over each span, at least DECK_MIN over the water and at the abutments
  for (const [s0, s1] of spans) {
    const mid = (s0 + s1) / 2;
    const half = Math.max(1, (s1 - s0) / 2);
    for (let i = 0; i < n; i++) {
      if (S[i] < s0 - 14 || S[i] > s1 + 14) continue;
      const u = (S[i] - mid) / (half + 14);
      const arch = DECK_MIN + 0.6 - 0.9 * u * u * (half / 20);
      t[i] = Math.max(t[i], Math.min(DECK_MIN + 0.7, arch));
      if (S[i] >= s0 && S[i] <= s1) t[i] = Math.max(t[i], DECK_MIN + 0.05);
    }
  }
  // ease into the pinned ends
  for (let i = 0; i < n; i++) {
    const wa = 1 - smooth01(S[i] / 14);
    const wb = 1 - smooth01((L - S[i]) / 14);
    t[i] = t[i] + (ha - t[i]) * wa;
    t[i] = t[i] + (hb - t[i]) * wb;
  }
  const pin = () => {
    t[0] = ha;
    t[n - 1] = hb;
    if (fixed) for (let i = 0; i < n; i++) if (fixed[i] === fixed[i]) t[i] = fixed[i];
  };
  pin();
  // The grade limit: MAX_GRADE, or what two pinned samples need between them when they are closer
  // than that allows (a short road from a pad down to an apron spreads the extra over its length
  // instead of stepping at a pinned end).
  let G = MAX_GRADE;
  {
    let last = 0;
    for (let i = 1; i < n; i++) {
      if (i < n - 1 && !(fixed && fixed[i] === fixed[i])) continue;
      if (S[i] - S[last] > 0.01) G = Math.max(G, (Math.abs(t[i] - t[last]) / (S[i] - S[last])) * 1.02);
      last = i;
    }
  }
  // grade: forward and backward clamps, repeated (the pinned samples stay pinned)
  const grade = (iters: number) => {
    for (let it = 0; it < iters; it++) {
      for (let i = 1; i < n; i++) {
        if (fixed && fixed[i] === fixed[i]) continue;
        const g = G * (S[i] - S[i - 1]);
        t[i] = Math.min(t[i - 1] + g, Math.max(t[i - 1] - g, t[i]));
      }
      pin();
      for (let i = n - 2; i >= 0; i--) {
        if (fixed && fixed[i] === fixed[i]) continue;
        const g = G * (S[i + 1] - S[i]);
        t[i] = Math.min(t[i + 1] + g, Math.max(t[i + 1] - g, t[i]));
      }
      pin();
    }
  };
  grade(4);
  // round off the grade changes (a kinked profile would show as a crease in the carved bed)
  for (let pass = 0; pass < 3; pass++) {
    const o = Float64Array.from(t);
    for (let i = 1; i < n - 1; i++) {
      if (fixed && fixed[i] === fixed[i]) continue;
      let sum = 0;
      let w = 0;
      for (let j = i - 1; j >= 0 && S[i] - S[j] <= 2; j--) {
        sum += o[j];
        w++;
      }
      for (let j = i + 1; j < n && S[j] - S[i] <= 2; j++) {
        sum += o[j];
        w++;
      }
      t[i] = (sum + o[i]) / (w + 1);
    }
    pin();
  }
  grade(2);
  return { h: t };
}

export { walk, arc } from './geo';
void lerpDir;
