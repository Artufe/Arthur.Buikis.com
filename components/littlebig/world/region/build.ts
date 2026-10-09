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
import { VALLEY, type PlanetAnchors } from '../planet';
import { chartToDir, dirFromLatLon, dirToChart, headingOf, headingVector, normalize3, v3, type Chart, type Vec3 } from '../sphere';
import { sunDirection } from '../sun';
import { createMemo, hashNums, type Memo } from './bake';
import { REGION_BAKE } from './baked';
import { BATTER, carveBuilder, PAD_BATTER_CAP, PrimKind, type Abutment, type DiscOpts } from './carve';
import { arc, awayTangent, DEG, dot, lerpDir, norm2pi, segDist, slerp, smooth01, step, towardTangent, walk, wrap } from './geo';
import { buildNetwork, chartAt, LANE_TURN_R, type EdgeSpec, type NodeSpec } from './network';
import { wjoin, woffset, wpath, wreverse, wsample, wsampleOut, wtrim } from './path';
import { routeFinish, routeLift, routeSearch, routeSmooth, type RouteSpec } from './route';
import { padHeight, padHeightAt } from './pad';
import { checkPlan, filletPoly, planSkeleton, planTown, skeletonOf } from './towns';
import { KEEP, KEEP_ALL, KEEP_MARGIN_MAX, QUAY_APRON, WALL_COPING, WALL_DEPTH, WALL_FOOT, WALL_LIP, WALL_LOW, type Airport, type FerryRoute, type GatePlaza, type Lookout, type NodePlace, type Pier, type Region, type RegionRoadKind, type Settlement, type SettlementKind, type SettlementStyle, type WPath } from './types';

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
  // (v2 R2: town streets at village scale, so the blocks between them have room for buildings)
  street: { width: 5.0, sidewalk: 1.2, speed: 6 },
  lane: { width: 4.4, sidewalk: 1.0, speed: 5 },
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
/**
 * Towns stand apart (V2 §1.1: their own silhouettes, never the capital's suburbs): every pad edge is
 * ≥ TOWN_GAP m along the surface past the plateau's outer blend edge (BLEND_EDGE) and ≥ TOWN_APART m
 * from any other pad's edge, open countryside or sea between.
 */
export const TOWN_GAP = 30;
export const TOWN_APART = 30;
/**
 * v2 (R2 refine): and counted past the blend rings too (the critic: a town's own blend ring is not
 * countryside): ≥ TOWN_GAP_BLEND m from a town's blend edge to the plateau's, ≥ TOWN_APART_BLEND m
 * between two towns' blend edges.
 */
export const TOWN_GAP_BLEND = 24;
export const TOWN_APART_BLEND = 22;
/** The plateau's outer blend edge, metres of arc from the city centre at sea level. */
export const BLEND_EDGE = (PLATEAU_RADIUS + PLATEAU_BLEND) * R;
/** A harbour's quay: its height above the sea (the swell tops out ~0.25 m) and its town's grade back from it. */
export const QUAY_H = 1.1;
const HARBOUR_GRADE = 0.045;
/** A sea wall's bank (m): the terrain drops from the quay into the water this close to its edge. A resort's beach ramp below its promenade. */
const SEA_WALL = 1.0;
const BEACH_RAMP = 7;
/**
 * A harbour's basin in front of its quay (carve: lowered, never filled): half width, blend, depth (m).
 * (v2 R2 refine 2: 2.2 m, was 1.7: a coarse terrain facet from the deck behind the wall's block to the
 * seabed in front of it then crosses the face ≥ 0.2 m under the water — region.spec 'terrain mesh')
 */
const BASIN_CORE = 4;
const BASIN_BLEND = 5;
const BASIN_H = -2.2;
/** The metro's docks: the waterfront's height and the city's gentle rise inland. */
const DOCK_H = 1.4;
const METRO_GRADE = 0.012;
/** v2 (R2 refine): how much fill the alpine village's banks widen for (m; towns: carve.ts PAD_FILL_CAP 2.5). */
const ALPINE_FILL_CAP = 1.5;
/** The alpine village climbs its slope toward the peaks behind it (at most; its plane fits the meadow, planet.ts VALLEY.tilt). */
const ALPINE_GRADE = 0.075;
/**
 * The resort's promenade: its curve crosses the axis at RESORT_CUT · RESORT_R, a bite of radius
 * RESORT_BITE · RESORT_R (the beach crescent); its pad reaches further inland behind (padR).
 */
const RESORT_CUT = 0.55;
const RESORT_BITE = 1.5;
const RESORT_R = 25;
/** Approach contract: glide slope (rise per metre) and how far out it is checked (m). */
export const GLIDE = 1 / 12;
export const APPROACH_CHECK = 240;
/** The approach a runway must have clear at its landing end (m). */
export const APPROACH_MIN = 200;

/** The sun at t = 0 (late afternoon over the capital): what the default views show lit. */
const SUN0 = sunDirection(0);
const DEBUG = typeof process !== 'undefined' && !!process.env.LB_REGION_DEBUG;
/** Bump when a change to the builder makes the baked decisions stale (bake.spec.ts also catches it). */
const REGION_VERSION = 5;

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
  { id: 'port-pebble', name: 'port pebble', kind: 'town', style: 'harbour', population: 1280, blurb: 'harbour · ferry to far haven', padR: 32, blend: 9, land: 'cap' },
  { id: 'millbrook', name: 'millbrook', kind: 'village', style: 'farm', population: 540, blurb: 'farm village · the windmills', padR: 26, blend: 10, land: 'cap' },
  { id: 'snowberry', name: 'snowberry', kind: 'village', style: 'alpine', population: 410, blurb: 'alpine village · under the peaks', padR: 26, blend: 5, land: 'cap' },
  { id: 'coral-cove', name: 'coral cove', kind: 'town', style: 'resort', population: 760, blurb: 'island resort · over the bridge', padR: 28, blend: 7, land: 'cap' },
  { id: 'far-haven', name: 'far haven', kind: 'city', style: 'metro', population: 6200, blurb: 'city · docks · airport', padR: 54, blend: 14, land: 'far' },
  { id: 'clover', name: 'clover', kind: 'village', style: 'farm', population: 460, blurb: 'farm village · out on the plains', padR: 28, blend: 10, land: 'far' },
  { id: 'puffin-bay', name: 'puffin bay', kind: 'village', style: 'harbour', population: 380, blurb: 'fishing village · over the isle bridge', padR: 26, blend: 8, land: 'cap' },
  // (v2 R2 refine: the far continent's west lobe had only a road to a lookout: the globe's emptiest side)
  { id: 'driftwood', name: 'driftwood', kind: 'village', style: 'harbour', population: 340, blurb: 'fishing village · ferry to coral cove', padR: 26, blend: 8, land: 'far' },
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

export function buildRegion(base: BaseTerrain, opts: { bake?: string | null; verify?: boolean } = {}): Region {
  const t0 = performance.now();
  const seed = base.seed;
  const noBake = typeof process !== 'undefined' && process.env.LB_REGION_NOBAKE === '1';
  const memo: Memo = createMemo(fingerprint(base), opts.bake === undefined ? (seed === SEED && !noBake ? REGION_BAKE : undefined) : opts.bake ?? undefined, opts.verify);
  /** Each memo entry depends on everything cached before it (a stale entry invalidates the rest). */
  let chain = 0x9e3779b9;
  // (v2 R2 refine 2: in a production build every compute below is compiled out — `process.env.NODE_ENV
  // === 'production' ? null : …` — and the bake replays each by its key: the planners and searches
  // ship in development and the specs only)
  const cached = (key: string, inputs: number[], compute: (() => ArrayLike<number>) | null, enc?: Parameters<Memo['get']>[3]) => {
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
    grade: 0,
    upHeading: 0,
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
  /** Metres of countryside or sea along the surface between a pad (radius padR at c) and the plateau's blend edge. */
  const capGap = (c: Vec3, padR: number) => cityAngle(c) * R - padR - BLEND_EDGE;
  type Site = { c: Vec3; h: number; score: number; heading: number };
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
        if (!best || s > best.score) best = { c, h: st.mean, score: s, heading: NaN };
      }
    };
    tryAll(Array.isArray(zone) ? zone : grid(zone, radius, coarse));
    if (DEBUG) console.log('[region] pick', padR, 'cands', nc, 'quick', nq, 'scored', ns);
    if (best) tryAll(grid((best as Site).c, coarse * 0.75, fine));
    return best;
  };
  /** A cached site: [x, y, z, h, heading] or [] when none was found. */
  const site = (id: string, zone: Vec3, find: () => Site | null): Site | null => {
    const v = cached(`site:${id}`, [zone.x, zone.y, zone.z], process.env.NODE_ENV === 'production' ? null : () => {
      const s = find();
      return s ? [s.c.x, s.c.y, s.c.z, s.h, s.heading] : [];
    });
    return v.length ? { c: v3(v[0], v[1], v[2]), h: v[3], score: 0, heading: v[4] } : null;
  };
  /**
   * A waterfront site (harbours, the metro's docks): the pad's seaward side is cut by a straight
   * quay line `fq` m out along its axis (heading toward the water), its plane at `quayH` along the
   * quay and rising `grade` inland. Scored for the quay on the shoreline (the town meets the water,
   * a sea wall, not a bluff), water deepening right off it (a berth for the pier), the town on dry
   * land close to its plane (small banks); searched over centres and headings round the sea's.
   */
  const waterfront = (zone: Vec3, radius: number, padR: number, fq: number, grade: number, quayH: number, ok: (c: Vec3) => boolean, bonus: (c: Vec3, hd: number) => number, coarse = 5, fine = 2): Site | null => {
    const half = Math.sqrt(Math.max(1, padR * padR - fq * fq));
    const q = v3();
    const at = (c: Vec3, hd: number, f: number, sv: number) => H(walk(walk(c, hd, f, q), hd + Math.PI / 2, sv, q));
    const plane = (f: number) => quayH + grade * (fq - f);
    const why = DEBUG ? [0, 0, 0, 0] : null;
    const evalAt = (c: Vec3, hd: number): number => {
      let sc = 0;
      // the quay line: on the shoreline (≤ ~0.9 m of water won from the sea, never a quay on dry land);
      // its ends may run a little into the shallows or onto the beach
      for (const k of [-0.85, -0.45, 0, 0.45, 0.85]) {
        const b = at(c, hd, fq, k * half);
        const end = Math.abs(k) > 0.5;
        if (b > (end ? 2.5 : 0.6) || b < (end ? -2.6 : -1.8)) {
          if (why) why[0]++;
          return -Infinity;
        }
        sc -= Math.abs(b + 0.25) * (end ? 0.4 : 0.8);
      }
      // water right off the wall, a berth's depth a pier's length out
      for (const k of [-0.5, 0, 0.5]) {
        const b = at(c, hd, fq + 4, k * half);
        if (b > (k ? 0.3 : -0.2)) {
          if (why) why[1]++;
          return -Infinity;
        }
        sc -= Math.max(0, b + 0.7) * 1.5;
      }
      const deep = at(c, hd, fq + 13, 0);
      sc -= Math.max(0, deep + BERTH_DEPTH) * 0.8;
      // the town on dry land near its plane
      let dev = 0;
      for (const f of [fq * 0.45, -padR * 0.25, -padR * 0.8]) {
        for (const k of [-0.6, 0, 0.6]) {
          const sv = k * padR;
          if (f * f + sv * sv > padR * padR) continue;
          const b = at(c, hd, f, sv);
          if (b < -0.2) {
            if (why) why[2]++;
            return -Infinity;
          }
          const d = Math.abs(b - plane(f));
          dev = Math.max(dev, d);
          sc -= d * 0.25;
        }
      }
      return sc - dev * 0.4 + bonus(c, hd);
    };
    let best: Site | null = null;
    const tryAll = (cands: Vec3[], heads: (c: Vec3) => number[]) => {
      for (const c of cands) {
        if (H(c) < -0.5 || !ok(c)) continue;
        for (const hd of heads(c)) {
          const sc = evalAt(c, hd);
          if (sc > (best?.score ?? -Infinity)) best = { c, h: plane(0), score: sc, heading: hd };
        }
      }
    };
    const seaHd = (c: Vec3) => seaAround(c, padR + 10).heading;
    tryAll(grid(zone, radius, coarse), (c) => [-24, -12, 0, 12, 24].map((d) => seaHd(c) + d * DEG));
    const b0 = best as Site | null;
    if (b0) tryAll(grid(b0.c, coarse * 0.8, fine), () => [-8, -4, 0, 4, 8].map((d) => b0.heading + d * DEG));
    if (DEBUG) console.log('[region] waterfront', padR, best ? (best as Site).score.toFixed(2) : 'none', 'rejects quay/off/land', why);
    return best;
  };

  const A = base.anchors;
  // The windmill hill's summit (the windmills stand round it: keep pads and roads off it).
  const sv = cached('summit', [A.windHill.x, A.windHill.y, A.windHill.z], process.env.NODE_ENV === 'production' ? null : () => {
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
  /**
   * Clear of the capital (TOWN_GAP past its blend edge, TOWN_GAP_BLEND past its own) and of every town
   * sited so far (TOWN_APART pad to pad, TOWN_APART_BLEND blend to blend), with a little to spare.
   */
  const apart = (c: Vec3, padR: number, blend = 0) => {
    const g = capGap(c, padR);
    if (g < TOWN_GAP + 1 || g - blend < TOWN_GAP_BLEND + 0.5) return false;
    for (const [id, o] of sites) {
      const m = arc(c, o.c) - padR - def(id).padR;
      if (m < TOWN_APART + 1 || m - blend - def(id).blend < TOWN_APART_BLEND + 0.5) return false;
    }
    return true;
  };
  const L = A.land;
  // Farm village: millbrook on the downs beyond the windmill hill (TOWN_LAND.downs), the three mills on
  // the hill between it and the capital, dry open meadow round it for its fields.
  {
    const d = def('millbrook');
    const zone = L.downs ?? A.windHill;
    const s = site(d.id, zone, () =>
      pick(
        zone,
        56,
        d.padR,
        (c, h) => h > 1.2 && apart(c, d.padR, d.blend) && arc(c, summit) > d.padR + 24 && arc(c, summit) < d.padR + 70,
        // (and toward the downs' far side, leaving the point to the harbour)
        (c, st) => (st.min < 0.4 || st.wet > 1 ? -Infinity : -st.std * 2.5 - (st.max - st.min) * 0.3 - Math.abs(st.mean - 2.6) * 0.3 - base.moistureAt(c) * 2.5 - arc(c, summit) * 0.03 + dot(c, SUN0) * 1.5 + (L.point ? Math.min(110, arc(c, L.point)) * 0.04 : 0)),
        5,
        2,
      ),
    );
    if (s) sites.set(d.id, s);
  }
  // Harbour: port pebble on the south-west point (planet.ts TOWN_LAND.point), its quay on the shore
  // facing the open sea (the ferry to far haven leaves from its pier), the town climbing back from it.
  {
    const d = def('port-pebble');
    const zone = L.point ?? A.headlands[1];
    const s = site(d.id, zone, () => waterfront(zone, 40, d.padR, d.padR * 0.72, HARBOUR_GRADE, QUAY_H, (c) => apart(c, d.padR, d.blend) && arc(c, lighthouse) > 60, () => 0));
    if (s) sites.set(d.id, s);
  }
  // Alpine village: snowberry on the high valley's meadow between the range's peaks (planet.ts VALLEY),
  // just under the snowline, its main street climbing toward the peak behind its chapel.
  let alpineUp: number | undefined;
  let alpineGrade = ALPINE_GRADE;
  const passFrame: Chart = { origin: A.valley, east: normalize3(cross(A.valley, A.passAxis)), south: A.passAxis, radius: R };
  {
    const d = def('snowberry');
    const c = chartToDir(passFrame, VALLEY.townU, VALLEY.town);
    const st = cached(`site:${d.id}`, [c.x, c.y, c.z, d.padR], process.env.NODE_ENV === 'production' ? null : () => {
      const p = padStats(c, d.padR);
      // its axis: away from the pass toward the higher of the two peaks either side of it (the pass
      // behind its back quarter, where its gate is), the chapel under it
      const pass = headingOf(c, A.passAxis);
      let bh = -Infinity, bhd = 0;
      for (const sgn of [1, -1]) {
        const a = pass + sgn * 128 * DEG;
        let h = 0;
        for (const m of [28, 34, 40]) for (const da of [-0.25, 0, 0.25]) h += Hat(c, a + da, m);
        if (h > bh) {
          bh = h;
          bhd = norm2pi(a);
        }
      }
      // its plane: the best fit to the meadow under it (a gentle slope, ≤ ALPINE_GRADE)
      let sh = 0, sxx = 0, syy = 0, sxh = 0, syh = 0, n = 0;
      const pts: number[] = [];
      for (const f of [0, 0.35, 0.7, 1]) for (let i = 0; i < (f ? 16 : 1); i++) {
        const a = (i / 16) * Math.PI * 2;
        const h = Hat(c, a, f * d.padR);
        pts.push(Math.sin(a) * f * d.padR, Math.cos(a) * f * d.padR, h);
        sh += h;
        n++;
      }
      const mh = sh / n;
      for (let k = 0; k < pts.length; k += 3) {
        sxx += pts[k] * pts[k];
        syy += pts[k + 1] * pts[k + 1];
        sxh += pts[k] * (pts[k + 2] - mh);
        syh += pts[k + 1] * (pts[k + 2] - mh);
      }
      const gE = sxh / sxx, gN = syh / syy;
      const grade = Math.min(ALPINE_GRADE, Math.hypot(gE, gN));
      return [mh, p.min, bhd, norm2pi(Math.atan2(gE, gN)), grade];
    });
    alpineUp = st[3] ?? st[2];
    alpineGrade = st[4] ?? ALPINE_GRADE;
    // (v2 R2: its plane climbs the meadow's slope (alpineUp, the fit); its axis — the high street —
    // runs in from the pass side 30° east of straight away from it, so its gate stands on the pad's
    // north-west rim toward the saddle, where the alpine road's last leg comes in across the top of the
    // ramp (a fixed design: the fit's direction wanders with the pad's size)
    const sk = (30 * Math.PI) / 180;
    const e = passFrame.east;
    const ax = v3(-A.passAxis.x * Math.cos(sk) + e.x * Math.sin(sk), -A.passAxis.y * Math.cos(sk) + e.y * Math.sin(sk), -A.passAxis.z * Math.cos(sk) + e.z * Math.sin(sk));
    if (st[1] > -1.5) sites.set(d.id, { c, h: st[0], score: 0, heading: headingOf(c, ax) });
  }
  // Island resort: coral cove on the big island off the east coast (islands[0]), round the beach
  // crescent of its bay: the promenade on the bite's curve, the beach below it, the bay beyond.
  {
    const d = def('coral-cove');
    const isl = A.bay ? walk(A.bay, hd(A.bay, A.islands[0]), RESORT_R * 0.9, v3()) : A.islands[0];
    const s = site(d.id, isl, () => {
      const rb = RESORT_R * RESORT_BITE;
      const fc = RESORT_R * RESORT_CUT;
      let best: Site | null = null;
      const dbgCove = [0, 0, 0, 0];
      const q = v3();
      for (const c of grid(isl, 22, 3)) {
        if (H(c) < 0.6 || !apart(c, d.padR, d.blend)) {
          if (DEBUG) dbgCove[2]++;
          continue;
        }
        const hd0 = seaAround(c, RESORT_R + 8).heading;
        // (the road from the bridge comes in at its back: the bay faces away from the east gate)
        const back = hd(c, gEast.dir);
        for (const dh of [-30, -15, 0, 15, 30]) {
          const hh = hd0 + dh * DEG;
          if (Math.abs(wrap(back - hh)) < 115 * DEG) {
            if (DEBUG) dbgCove[3]++;
            continue;
          }
          const bc = walk(c, hh, fc + rb, v3());
          let sc = 0;
          let bad = false;
          // the promenade's curve: at the top of the beach; below it the beach, then the bay
          for (const k of [-0.7, -0.35, 0, 0.35, 0.7]) {
            const ang = Math.PI + k * Math.asin(Math.min(0.95, RESORT_R / rb));
            const prom = walk(bc, hh + ang, rb, q);
            const b = H(prom);
            if (b < -0.8) bad = true;
            sc -= Math.abs(b - 1.1) * 0.6;
            const beach = H(walk(bc, hh + ang, rb - 5, q));
            sc -= Math.abs(beach - 0.2) * 0.5;
            const bay = H(walk(bc, hh + ang, rb - 13, q));
            if (k === 0 && bay > -0.3) bad = true;
            sc -= Math.max(0, bay + 0.6) * 0.8;
          }
          // the town behind on dry land, gentle
          for (const f of [0, -RESORT_R * 0.7]) for (const k of [-0.6, 0, 0.6]) {
            const b = H(walk(walk(c, hh, f, q), hh + Math.PI / 2, k * RESORT_R, q));
            if (b < -0.3) bad = true;
            sc -= Math.abs(b - 1.8) * 0.2 + Math.max(0, 0.3 - b) * 2;
          }
          if (DEBUG) dbgCove[bad ? 1 : 0]++;
          if (!bad && sc > (best?.score ?? -Infinity)) best = { c: v3(c.x, c.y, c.z), h: 1.8, score: sc, heading: hh };
        }
      }
      if (DEBUG) console.log('[region] cove ok/bad/far/back', dbgCove, best ? (best as Site).score.toFixed(2) : 'none');
      return best;
    });
    if (s) sites.set(d.id, s);
  }
  // The second city: far haven on the far continent's north-east reach (TOWN_LAND.reach), its docks on
  // a straight waterfront, the city rising gently inland behind its harbour front.
  {
    const d = def('far-haven');
    const zone = L.reach ?? A.second;
    const s = site(d.id, zone, () => waterfront(zone, 46, d.padR, d.padR * 0.8, METRO_GRADE, DOCK_H, (c) => apart(c, d.padR, d.blend), () => 0, 6, 3));
    if (s) sites.set(d.id, s);
  }
  // Farm village on the far continent: clover out on the southern plains, a long highway from the city.
  {
    const d = def('clover');
    const fh = sites.get('far-haven');
    const zone = walk(A.second, 170 * DEG, 48, v3());
    const s = site(d.id, zone, () =>
      pick(
        zone,
        44,
        d.padR,
        (c, h) => h > 1.6 && h < 9 && apart(c, d.padR, d.blend) && (!fh || arc(c, fh.c) > 90),
        (c, st) => (st.min < 1.0 || st.wet > 0 ? -Infinity : -st.std * 2.4 - (st.max - st.min) * 0.3 - base.moistureAt(c) * 3),
        6,
        2.5,
      ),
    );
    if (s) sites.set(d.id, s);
  }
  // Fishing village: puffin bay on the west isle (TOWN_LAND.isle), across a strait from the downs (the isle
  // bridge), its little quay on the open western sea, the boats moored along it.
  {
    const d = def('puffin-bay');
    const zone = L.isle ?? A.windHill;
    const s = site(d.id, zone, () => waterfront(zone, 40, d.padR, d.padR * 0.7, HARBOUR_GRADE, QUAY_H, (c) => apart(c, d.padR, d.blend), () => 0));
    if (s) sites.set(d.id, s);
  }
  // Fishing village: driftwood on the far continent's west lobe (TOWN_LAND.west), its quay in a bay of
  // the lobe's north shore facing the open sea toward coral cove (the second ferry), the lookout's
  // headland beside it, the west road from clover in at its back. (v2 R2 refine: the globe's emptiest side.)
  {
    const d = def('driftwood');
    const zone = L.west;
    const cv = sites.get('coral-cove');
    const s = zone ? site(d.id, zone, () => waterfront(zone, 50, d.padR, d.padR * 0.62, HARBOUR_GRADE, QUAY_H, (c) => apart(c, d.padR, d.blend), (c, h) => (cv ? Math.cos(wrap(h - hd(c, cv.c))) * 0.6 : 0))) : null;
    if (s) sites.set(d.id, s);
  }
  mark('sites');

  // ── Settlement records ──
  const townOf = new Map<string, Settlement>();
  for (const d of TOWNS) {
    const st = sites.get(d.id);
    if (!st) continue;
    const harbour = d.style === 'harbour' || d.style === 'metro';
    // a flat pad ≥ PAD_MIN (lower ground reads as beach); a waterfront pad's plane is set by its quay
    const h = Math.round((harbour ? st.h : Math.max(PAD_MIN, Math.min(16, st.h))) * 1000) / 1000;
    const heading = st.heading === st.heading ? st.heading : 0;
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
      grade: 0,
      upHeading: 0,
      heading,
      component: d.land === 'far' ? 1 : 0,
      nodes: [],
      streets: [],
      gates: [],
      piers: [],
      airports: [],
    };
    if (d.style === 'harbour' || d.style === 'metro') {
      s.grade = d.style === 'metro' ? METRO_GRADE : HARBOUR_GRADE;
      s.upHeading = norm2pi(heading + Math.PI);
      s.cut = { f: d.padR * (d.style === 'metro' ? 0.8 : d.id === 'puffin-bay' ? 0.7 : d.id === 'driftwood' ? 0.62 : 0.72), r: Infinity, wall: true };
    } else if (d.style === 'resort') {
      s.cut = { f: RESORT_R * RESORT_CUT, r: RESORT_R * RESORT_BITE, wall: false };
    } else if (d.style === 'alpine') {
      s.grade = alpineGrade;
      s.upHeading = norm2pi(alpineUp ?? heading);
    }
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
  const puffin = T('puffin-bay');
  const driftwood = T('driftwood');
  /** A settlement's pad surface at plan (x, z) in its chart. */
  const padH = (s: Settlement, x: number, z: number) => padHeight(s, x, z);

  // ── 3. Piers and airports ──
  const piers: Pier[] = [];
  const airports: Airport[] = [];
  /** A pad's bank cap (dry ground only, see the carve). */
  const padCap = new Map<Settlement, number>();
  const padDcap = (s: Settlement) => {
    let c = padCap.get(s);
    if (c === undefined) {
      c = cached(`pad:${s.id}`, [s.dir.x, s.dir.y, s.dir.z, s.h, s.padR, s.blend], process.env.NODE_ENV === 'production' ? null : () => {
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
    for (let d = 6; d <= APPROACH_CHECK; d += 6) {
      step(from, out, d, q);
      // (the ground as it will be: the gate plazas' paving, the plateau, a town's pad)
      let g = H(q);
      for (const gp of gates) if (arc(q, gp.dir) < 24) g = Math.max(g, gp.h + 0.6);
      if (cityDist(q) < CITY_PLAN_RADIUS + 12) g = Math.max(g, PLATEAU_HEIGHT + 0.6);
      if (g > h + d * GLIDE - 1.5) return d - 6;
    }
    return APPROACH_CHECK;
  };
  const runwayAt = (c: Vec3, heading: number) => ({ e0: walk(c, heading + Math.PI, RUNWAY_L / 2, v3()), e1: walk(c, heading, RUNWAY_L / 2, v3()) });
  /** [cx, cy, cz, heading, h, clear0, clear1] or []. */
  const airportSite = (code: string, inputs: number[], find: (() => number[]) | null) => cached(`airport:${code}`, inputs, find);
  // The capital's airport: a strip won from the lagoon (0.4–3.2 m of water, offshore so the roads keep
  // their room on land), parallel to the coast, its landing approach over the open sea, a short drive
  // off the north-west gate: the gate's third arm leaves straight out for it (the airport causeway over
  // the lagoon), so no road is cut by a T for it.
  const gAir = gWest;
  {
    const v = airportSite('lbx', [gAir.dir.x, gAir.dir.y, gAir.dir.z], process.env.NODE_ENV === 'production' ? null : () => {
      let best: number[] = [];
      let bestScore = -Infinity;
      const dbg = { near: 0, wet: 0, foot: 0, towns: 0, bestClear: 0, clear: 0, apron: 0, minDev: 999 };
      const outG = outwardOf(gAir);
      for (let i = 0; i < 21; i++) {
        const brg = outG + ((i - 10) / 10) * 40 * DEG;
        for (const rr of [44, 50, 56, 62, 70, 78]) {
          // (its apron a road's length straight out from the north-west gate's plaza, clear of the other
          // gates and of the lighthouse's headland)
          const c = walk(gAir.dir, brg, rr, v3());
          const gd = rr;
          if (cityDist(c) < CITY_PLAN_RADIUS + 34 || arc(c, lighthouse) < 34 || gates.some((g) => g !== gAir && arc(c, g.dir) < 50)) continue;
          const hc = H(c);
          if (DEBUG) dbg.near++;
          if (hc < -7.5 || hc > 0.6) continue;
          if (DEBUG) dbg.wet++;
          const out = headingOf(c, awayTangent(city, c, v3()));
          for (const dh of [0, -0.25, 0.25, -0.5, 0.5, -0.8, 0.8]) {
            const head = out + Math.PI / 2 + dh;
            let ok = true;
            let fill = 0;
            let dry = 0;
            for (const side of [0, -1, 1]) {
              for (let k = -4; k <= 4 && ok; k++) {
                const h = H(walk(walk(c, head, (k * RUNWAY_L) / 8, v3()), head + Math.PI / 2, side * 5, v3()));
                if (h > 0.9) dry++;
                if (h < -8.5 || h > 2.2 || dry > 5) ok = false;
                fill += Math.abs(RUNWAY_LAGOON_H - h);
              }
              if (!ok) break;
            }
            if (!ok) continue;
            if (DEBUG) dbg.foot++;
            const { e0, e1 } = runwayAt(c, head);
            // (the strip's island reaches past its thresholds: its banks stay off the towns' pads and blends)
            const x0 = walk(c, head + Math.PI, RUNWAY_L * 0.62, v3());
            const x1 = walk(c, head, RUNWAY_L * 0.62, v3());
            if ([...sites].some(([id, t]) => segDist(t.c, x0, x1) < def(id).padR + def(id).blend + 14)) continue;
            // (and its fill off the lighthouse's headland: the sea stays round the point, nature/landmarks.ts)
            if (segDist(lighthouse, x0, x1) < 42) continue;
            if (DEBUG) dbg.towns++;
            const c0 = clearBeyond(e0, e1, RUNWAY_LAGOON_H);
            const c1 = clearBeyond(e1, e0, RUNWAY_LAGOON_H);
            if (DEBUG && Math.max(c0, c1) > dbg.bestClear) dbg.bestClear = Math.max(c0, c1);
            if (Math.max(c0, c1) < APPROACH_MIN) continue;
            if (DEBUG) dbg.clear++;
            const off = cityDist(c) - CITY_PLAN_RADIUS;
            // the apron beside the strip on the gate's side (its middle or toward an end), straight out
            // from the gate (the plaza's arm aims at it between the rim arms) a causeway's length off
            const sideA = Math.sin(hd(c, gAir.dir) - head) > 0 ? 1 : -1;
            let apron: Vec3 | null = null;
            let ad = Infinity;
            for (const al of [0, -0.36, 0.36]) {
              const q = walk(walk(c, head, al * RUNWAY_L, v3()), head + sideA * (Math.PI / 2), RUNWAY_W / 2 + 9.5, v3());
              const dev = Math.abs(wrap(hd(gAir.dir, q) - outG));
              if (DEBUG) dbg.minDev = Math.min(dbg.minDev, dev / DEG);
              if (dev > 13 * DEG || arc(q, gAir.dir) < gAir.r + 9 + 18) continue;
              if (dev < ad) {
                ad = dev;
                apron = q;
              }
            }
            if (!apron) continue;
            if (DEBUG) dbg.apron++;
            const score = -fill * 0.03 + Math.min(gd, 66) * 0.12 - Math.abs(dh) * 2 + Math.min(c0, c1) * 0.01 + 3 * dot(c, SUN0) + Math.min(off, 50) * 0.08 - ad * 3;
            if (score > bestScore) {
              bestScore = score;
              best = [c.x, c.y, c.z, head, RUNWAY_LAGOON_H, c0, c1, apron.x, apron.y, apron.z];
            }
          }
        }
      }
      if (DEBUG) console.log('[region] lbx search', JSON.stringify(dbg));
      return best;
    });
    if (v.length) addAirport(capital, v, 'lbx', 'bigtown airport', v.length > 7 ? v3(v[7], v[8], v[9]) : null);
  }
  // The far city's airport: the flattest strip near the city with a long clear approach.
  if (farHaven) {
    const fh = farHaven;
    const v = airportSite('fhv', [fh.dir.x, fh.dir.y, fh.dir.z, fh.heading], process.env.NODE_ENV === 'production' ? null : () => {
      let best: number[] = [];
      let bestScore = -Infinity;
      // (inland or along the coast behind the city, any heading: the flattest strip with a clear approach)
      for (let i = 0; i < 24; i++) {
        const bearing = fh.heading + Math.PI + (i - 11.5) * 0.2;
        for (const d of [fh.padR + 30, fh.padR + 40, fh.padR + 50, fh.padR + 62]) {
          const c = walk(fh.dir, bearing, d, v3());
          const hc = H(c);
          if (hc < 0.8 || hc > 9) continue;
          const toward = hd(c, fh.dir);
          for (let q = 0; q < 8; q++) {
            const head = toward + (q / 8) * Math.PI;
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
            if (bad || mx - mn > 5.5) continue;
            const h = Math.round(Math.max(LAND_MIN + 0.3, sum / 18) * 20) / 20;
            // the airport road climbs ≤ ~8 %: no higher or lower than that over the way from the city
            if (Math.abs(h - fh.h) > 0.08 * (d - fh.padR - 6)) continue;
            const { e0, e1 } = runwayAt(c, head);
            if (arc(e0, fh.dir) < fh.padR + fh.blend + 6 || arc(e1, fh.dir) < fh.padR + fh.blend + 6) continue;
            if ([...sites].some(([id, t]) => id !== 'far-haven' && segDist(t.c, e0, e1) < def(id).padR + def(id).blend + 12)) continue;
            const c0 = clearBeyond(e0, e1, h);
            const c1 = clearBeyond(e1, e0, h);
            if (Math.max(c0, c1) < APPROACH_MIN) continue;
            const score = -(mx - mn) - Math.abs(d - fh.padR - 40) * 0.03 + Math.min(c0, c1) * 0.006;
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

  // The lookout's car park (far continent, west lobe): a gentle top above the ground round it with open
  // sea filling a wide view one way. Found before the town plans: driftwood's flank gate faces it.
  let lookoutV: ArrayLike<number> = [];
  if (clover && L.west) {
    lookoutV = cached('lookout', [L.west.x, L.west.y, L.west.z, clover.dir.x, clover.dir.y, clover.dir.z, driftwood ? 1 : 0], process.env.NODE_ENV === 'production' ? null : () => {
      let best: Vec3 | null = null;
      let bs = -Infinity;
      for (const c of grid(L.west!, 46, 4)) {
        const m = arc(c, clover.dir);
        if (m < clover.padR + 60) continue;
        // (clear of the towns' blends: well clear, but for the town its lane leaves from, a short walk off)
        if (settlements.some((t) => t.style !== 'capital' && arc(c, t.dir) < t.padR + t.blend + (t === driftwood ? 20 : 24))) continue;
        if (airports.some((a) => segDist(c, a.ends[0], a.ends[1]) < 40)) continue;
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
          let k2 = 0;
          for (const da of [-0.44, 0, 0.44]) for (const r of [25, 40, 55, 70]) if (Hat(c, (i * Math.PI) / 4 + da, r) < -0.5) k2++;
          sea = Math.max(sea, k2);
        }
        const sc = prom * 1.2 + sea * 0.35 + h * 0.15 - flat * 2;
        if (sc > bs) {
          bs = sc;
          best = c;
        }
      }
      return best ? [best.x, best.y, best.z, H(best)] : [];
    });
  }
  const capAirportSite = () => airports.find((a) => a.settlement === 0);
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
  // south: the rim road (ccw, east) and the coast road (cw, west round the plateau to the harbour).
  // Every gate meets ≥ 2 roads.
  // ('to': an arm aimed straight at a target by its plaza, so its road leaves radially)
  type ArmSpec = ArmKey | 'to';
  const gateArms = new Map<GatePlaza, ArmSpec[]>([
    [gWest, ['ccw', 'cw', ...(capAirportSite() ? (['to'] as const) : [])]],
    [gEast, ['cw', 'out', 'ccw']],
    [gSouth, ['ccw', 'cw']],
  ]);
  const armTarget = new Map<GatePlaza, Vec3>(capAirportSite() ? [[gAir, capAirportSite()!.apron]] : []);
  const armNodeOf = new Map<string, number>();
  for (const g of gates) {
    const keys = gateArms.get(g);
    if (!keys) continue;
    const out = outwardOf(g);
    const centre0 = walk(g.touch, out, 10, v3());
    const heads = keys.map((k) => (k === 'to' ? hd(centre0, armTarget.get(g) ?? walk(centre0, out, 30, v3())) : out + (k === 'cw' ? 90 : k === 'ccw' ? -90 : 0) * DEG));
    // (a rim arm gives way round the ring to an aimed arm: ≥ 84° between them, so their arm nodes stand
    // ≥ 1.3 ring radii apart round the ring)
    const ti = keys.indexOf('to');
    if (ti >= 0) keys.forEach((k, i) => {
      if (k !== 'cw' && k !== 'ccw') return;
      const sgn = k === 'cw' ? 1 : -1;
      const gap = wrap(heads[i] - heads[ti]) * sgn;
      if (gap < 84 * DEG) heads[i] = heads[ti] + sgn * 84 * DEG;
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
  // millbrook: in from the mill road (the north-west gate, round the plateau), out by the downs road to
  // port pebble; port pebble: in from the coast road (the south gate, round the plateau) at its back,
  // out by the downs road from its flank
  if (millbrook) exitsOf.set(millbrook, [bearingTo(millbrook, roundTo(millbrook.dir, gWest.dir, 130)), ...(portPebble ? [bearingTo(millbrook, portPebble.dir)] : []), ...(puffin ? [bearingTo(millbrook, puffin.dir)] : [])]);
  if (puffin && millbrook) exitsOf.set(puffin, [bearingTo(puffin, millbrook.dir)]);
  if (portPebble) exitsOf.set(portPebble, [bearingTo(portPebble, roundTo(portPebble.dir, gSouth.dir, 130)), ...(millbrook ? [bearingTo(portPebble, millbrook.dir)] : [])]);
  // snowberry: its gate at its back, toward the pass (the alpine road comes in across the top of the ramp)
  if (snowberry) exitsOf.set(snowberry, [norm2pi(snowberry.heading + Math.PI)]);
  if (cove) exitsOf.set(cove, [bearingTo(cove, gEast.dir)]);
  /**
   * v2 (R2): a bearing turned (≤ 32°) toward the easiest way out past the pad: the smallest climb over
   * the first 30 m beyond the rim (a gate facing a hill sends its road hooking round it into the gate).
   */
  const easyBearing = (s: Settlement, b0: number) =>
    // (baked: 81 terrain samples)
    cached(`easy:${s.id}`, [s.dir.x, s.dir.y, s.dir.z, s.padR, b0], process.env.NODE_ENV === 'production' ? null : () => {
      let best = b0;
      let bestCost = Infinity;
      const q = v3();
      for (const off of [0, 8, -8, 16, -16, 24, -24, 32, -32]) {
        const b = b0 + off * DEG;
        let prev = H(walk(s.dir, b, s.padR, q));
        let cost = Math.abs(off) * 0.004;
        for (let m = 4; m <= 32; m += 4) {
          const h = H(walk(s.dir, b, s.padR + m, q));
          cost = Math.max(cost, Math.abs(h - prev) / 4 + Math.abs(off) * 0.004);
          prev = h;
        }
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          best = b;
        }
      }
      return [best];
    })[0];
  // the far continent: far haven ⇄ clover (the highway), clover → the west road to the lookout on the west lobe
  if (clover) exitsOf.set(clover, [...(farHaven ? [easyBearing(clover, bearingTo(clover, farHaven.dir))] : []), ...(L.west ? [bearingTo(clover, L.west)] : [])]);
  // driftwood: in from the west road (from clover) at its back, out by the lookout lane from its flank
  if (driftwood) exitsOf.set(driftwood, [...(clover ? [bearingTo(driftwood, clover.dir)] : []), ...(lookoutV.length ? [bearingTo(driftwood, v3(lookoutV[0], lookoutV[1], lookoutV[2]))] : [])]);
  const gateNodes = new Map<Settlement, number[]>(); // per exit, in exitsOf order
  /** Per town and exit: the point ~2 m back along the street that ends at its gate (the plan's skeleton). */
  const exitBack = new Map<Settlement, Array<Vec3 | null>>();
  const streetsOf = new Map<Settlement, number[]>();
  /** The town streets' end node ids (a, b interleaved), registered before their edges are (pruning, components). */
  const townLinks: number[] = [];
  /** Each town's plan job: its streets are planned and registered on the network's first read. */
  const townJobs: Array<{ s: Settlement; spec: Parameters<typeof planTown>[0]; ids: number[]; X: (sv: number, fv: number) => number; Z: (sv: number, fv: number) => number }> = [];
  const lookouts: Lookout[] = [];
  const pierNode = new Map<Settlement, { node: number; root: Vec3 }>();
  if (farHaven) {
    const fh = farHaven;
    const fhv = airports.find((a) => a.settlement === fh.index);
    exitsOf.set(fh, [fh.heading, ...(fhv ? [bearingTo(fh, fhv.apron)] : []), ...(clover ? [bearingTo(fh, clover.dir)] : [])]);
  }

  for (const s of settlements) {
    if (s.style === 'capital') continue;
    const ex = exitsOf.get(s) ?? [s.heading + Math.PI];
    // the axis: waterfront towns face the water (their sites set it); the alpine village climbs away
    // from its pass (set with its site); the rest face away from their first exit
    if (s.style === 'farm') s.heading = ex[0] + Math.PI;
    const rel = ex.map((b) => wrap(b - s.heading));
    // (which of its style's shapes: the towns of one style take them in turn)
    const variant = settlements.filter((o) => o.style === s.style && o.index < s.index).length;
    // v2 (R2 refine): the plan's skeleton (nodes, exits, square, quay, pier) is baked; its streets are
    // planned on the network's first read (townStreets below), off the first-frame path
    const spec = { style: s.style as Exclude<SettlementStyle, 'capital'>, name: s.name, padR: s.padR, exits: rel, vary: (s.index * 0.37) % 1, variant, cut: s.cut };
    const tp0 = performance.now();
    const plan = skeletonOf(cached(`plan:${s.id}`, [s.padR, s.heading, variant, spec.vary, s.cut?.f ?? -1, s.cut && Number.isFinite(s.cut.r) ? s.cut.r : -1, ...rel], process.env.NODE_ENV === 'production' ? null : () => planSkeleton(planTown(spec)), 'cm16'));
    prof['plans.ms'] = (prof['plans.ms'] ?? 0) + performance.now() - tp0;
    if (process.env.NODE_ENV !== 'production' && DEBUG) {
      console.log('[plan-in]', JSON.stringify({ id: s.id, style: s.style, name: s.name, padR: s.padR, exits: rel, vary: (s.index * 0.37) % 1, variant, cut: s.cut ? { f: s.cut.f, r: Number.isFinite(s.cut.r) ? s.cut.r : null } : null }));
      const issues = checkPlan(planTown(spec));
      console.log('[region] plan', s.id, 'exits', rel.map((x) => ((x * 180) / Math.PI).toFixed(0)).join(','), issues.length ? '\n  ' + issues.join('\n  ') : 'ok');
    }
    const ch = s.chart;
    const ax = Math.sin(s.heading);
    const az = -Math.cos(s.heading);
    // (s, f) → chart (x, z): s along the axis' right (cos hd, sin hd), f along the axis (sin hd, −cos hd)
    const X = (sv: number, fv: number) => sv * -az + fv * ax;
    const Z = (sv: number, fv: number) => sv * ax + fv * az;
    const ids = plan.nodes.map((n) => {
      const x = X(n.s, n.f), z = Z(n.s, n.f);
      const id = addNode(chartToDir(ch, x, z), padH(s, x, z) + ROAD_H, n.place, s.index, n.control);
      s.nodes.push(id);
      return id;
    });
    exitBack.set(s, plan.exitBack.map((b) => (b ? chartToDir(ch, X(b[0], b[1]), Z(b[0], b[1])) : null)));
    townJobs.push({ s, spec, ids, X, Z });
    for (let i = 0; i < plan.links.length; i += 2) townLinks.push(ids[plan.links[i]], ids[plan.links[i + 1]]);
    // (its street edge ids: planned on first read)
    const list: number[] = [];
    streetsOf.set(s, list);
    Object.defineProperty(s, 'streets', {
      get: () => {
        townStreets();
        return list;
      },
      enumerable: false,
      configurable: true,
    });
    const gIds = plan.exits.map((i) => ids[i]);
    gateNodes.set(s, gIds);
    s.gates = gIds.filter((id) => nodeSpecs[id].place === 'town-gate');
    if (plan.square) s.square = { x: X(plan.square.s, plan.square.f), z: Z(plan.square.s, plan.square.f), r: plan.square.r };
    if (plan.quay) {
      const q: number[] = [];
      for (let i = 0; i < plan.quay.length; i += 2) q.push(X(plan.quay[i], plan.quay[i + 1]), Z(plan.quay[i], plan.quay[i + 1]));
      s.quay = Float64Array.from(q);
      // v2 (R2 refine): a walled quay's sea wall, published for H1 to extrude (types.ts QuayWall)
      if (s.cut?.wall) {
        const n = q.length / 2;
        const wd = new Float32Array(n * 3);
        const top = new Float32Array(n);
        const t = v3();
        for (let i = 0; i < n; i++) {
          chartToDir(ch, q[i * 2], q[i * 2 + 1], t);
          wd[i * 3] = t.x;
          wd[i * 3 + 1] = t.y;
          wd[i * 3 + 2] = t.z;
          top[i] = padHeight(s, q[i * 2], q[i * 2 + 1]);
        }
        s.wall = { line: s.quay, dir: wd, top, foot: WALL_FOOT, coping: WALL_COPING, lip: WALL_LIP, apron: QUAY_APRON, depth: WALL_DEPTH, nx: ax, nz: az };
      }
    }
    if (plan.pier) pierNode.set(s, { node: plan.pier.node >= 0 ? ids[plan.pier.node] : -1, root: chartToDir(ch, X(plan.pier.s, plan.pier.f), Z(plan.pier.s, plan.pier.f)) });
    // v2 (R2 refine 2): each dead end's yard (its turning circle and sidewalk: network.ts turnR)
    if (plan.yards.length) {
      s.yards = plan.yards.map((y) => {
        const n = plan.nodes[y.node];
        return { node: ids[y.node], kind: y.kind, x: X(n.s, n.f), z: Z(n.s, n.f), r: y.lane ? LANE_TURN_R + ROAD.lane.sidewalk : turningRadius(ROAD.street.width / 2) + ROAD.street.sidewalk };
      });
    }
  }

  // Piers: from the quay's edge (the sea wall) straight out along the town's axis to a berth in deep
  // water (a boat moors alongside; the ferry docks at port pebble's and far haven's).
  for (const s of [portPebble, farHaven, puffin, driftwood, cove]) {
    if (!s) continue;
    const pn = pierNode.get(s);
    if (!pn) continue;
    const root = pn.root;
    const out = headingVector(root, s.heading, v3());
    const L = cached(`pier:${s.id}`, [root.x, root.y, root.z, s.heading], process.env.NODE_ENV === 'production' ? null : () => {
      let L = 8;
      for (; L < 40; L += 1) if (H(step(root, out, L)) < -BERTH_DEPTH - 0.2) break;
      return [L + 2];
    })[0];
    const berth = step(root, out, L);
    const rq = dirToChart(s.chart, root);
    const p: Pier = { id: piers.length, settlement: s.index, root, berth, h: Math.max(PIER_H, padH(s, rq.x, rq.z) + 0.12), width: PIER_W, length: L, heading: headingOf(root, out), node: pn.node };
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
    /** The polar band's outer reach (m past the rim's road line; default 34): roads out to the towns need more. */
    vMax?: number;
    cell?: number;
    /** Prefer meadow to forest (the canopy hides a road from above). */
    forest?: number;
    /** The straight lead out of / into its end nodes (m; default by length, 5–12). */
    lead?: number;
    /** Corner rounding passes (route.ts relax; a highway's 140, else 50). */
    relax?: number;
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
        // (v2 R2: clear of the runway strip and its bank: a road beside it at another height steps)
        if (segDist(d, ap.ends[0], ap.ends[1]) < RUNWAY_W / 2 + 12) return Infinity;
        // (and off the apron) unless it is this road's own end
        if (!ends.some((e) => arc(e, ap.apron) < ap.apronR + 2) && arc(d, ap.apron) < ap.apronR + 7) return Infinity;
      }
      for (const p of piers) if (segDist(d, p.root, p.berth) < 6) return Infinity;
      if (dot(d, summit) > summitCos) return Infinity;
      // (others' car parks)
      for (const l of lookouts) if (!ends.some((e) => dot(e, l.dir) > 0.99999) && arc(d, l.dir) < 9) return Infinity;
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
      // (v2 R2: up to 12 m on a long road: its first bend opens out past the junction's patch)
      lead: opts.lead ?? Math.min(12, Math.max(5, arc(a.dir, b.dir) * 0.22)),
      cell: opts.cell ?? (arc(a.dir, b.dir) > 110 || opts.polar ? 3 : 2.5),
      halfWidth: Math.max(26, arc(a.dir, b.dir) * 0.55),
      polar: opts.polar ? { centre: city, theta0: rimTheta, sign: opts.polar, vMin: -9, vMax: opts.vMax ?? 34 } : undefined,
      height: H,
      keepOut,
      waterH: opts.causeway ? -3.2 : WATER_H,
      bridges: !!opts.bridges,
      waterCost: 3,
      bridgeStart: 25,
      // (a highway's long bends get more rounding: it is the fastest road)
      relax: opts.relax ?? (kind === 'highway' ? 140 : undefined),
      fair: 6.4,
    };
    const tr0 = performance.now();
    const ctrl = cached(`route:${name}`, [a.dir.x, a.dir.y, a.dir.z, b.dir.x, b.dir.y, b.dir.z, fromOut.x, fromOut.y, fromOut.z, toIn.x, toIn.y, toIn.z, width, opts.polar ?? 0, opts.vMax ?? 34, opts.bridges ? 1 : 0, opts.causeway ? 1 : 0, ...(opts.lead ? [opts.lead] : [])], process.env.NODE_ENV === 'production' ? null : () => {
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
        const why = (d: Vec3) => [dot(d, city) > cosRim ? 'rim' : '', ...padCos.map((p, i) => (dot(d, p.c) > p.cos ? `pad${i}` : '')), ...plazaCos.map((p, i) => (dot(d, p.c) > p.cos ? `plaza${i}` : '')), ...airports.map((ap) => (segDist(d, ap.ends[0], ap.ends[1]) < RUNWAY_W / 2 + 7 ? `rwy:${ap.code}` : arc(d, ap.apron) < ap.apronR + 7 ? `apron:${ap.code}` : '')), ...routed.map((r, i) => { for (let k = 0; k < r.pts.length; k += 3) if (Math.hypot(r.pts[k] - d.x, r.pts[k + 1] - d.y, r.pts[k + 2] - d.z) * R < (r.width + width) / 2 + 5) return `road${i}`; return ''; })].filter(Boolean).join(',');
        console.log('[region]   why a:', why(la), 'b:', why(lb));
      }
      return null;
    }
    const tf0 = performance.now();
    // (v2 R2 refine: the finished centreline in its strip frame is baked too — its smoothing and
    // fairing were ~3 ms of a cold page load; to the cm, or float32 for a frame too wide for cm16)
    // (every other ≈ 0.5 m sample kept, the ones between put back halfway: a chord's sag at the
    // tightest bend a road may make is ~2 cm)
    let span = 0;
    for (let i = 1; i < ctrl.length; i++) span = Math.max(span, Math.abs(ctrl[i]));
    const uv = everyOther(cached(`finish:${name}`, [spec.relax ?? 50, spec.fair ?? 0, spec.lead ?? 0], process.env.NODE_ENV === 'production' ? null : () => halve(routeSmooth(spec, ctrl.subarray(1)), 2), span < 300 ? 'cm16' : 'f32'), 2);
    const dirs = routeLift(spec, uv);
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
    const got = cached(`prof:${name}`, [n, raw.length, raw.dir[0], raw.dir[1], raw.dir[2], raw.dir[n * 3 - 3], raw.dir[n * 3 - 2], raw.dir[n * 3 - 1]], process.env.NODE_ENV === 'production' ? null : () => {
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
          // starts after a short causeway, so its deck has room to reach DECK_MIN; v2 R2 refine 2: more
          // off an end that low: a town gate's last ~5 m are held at its pad's height, and the cove
          // road's deck, landing 10.5 m short of the resort's gate at 1.85 m, could only climb to 2.3 m)
          const spanEnd = (nd: number) => Math.max(10.5, 7 + (DECK_MIN + 0.1 - nodeSpecs[nd].h) / MAX_GRADE);
          const sp: [number, number] = [Math.max(spanEnd(fromNode), sharpEnd(false) + 9, raw.s[a0] - 1.5), Math.min(raw.length - spanEnd(toNode), raw.length - sharpEnd(true) - 9, raw.s[b0] + 1.5)];
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
          if (DEBUG && name === 'cove road') for (let k = 0; k < n; k += 8) if (raw.s[k] > sp[0] - 4 && raw.s[k] < sp[1] + 4) console.log('  raw', raw.s[k].toFixed(1), base0[k].toFixed(2), raw.dir[k * 3].toFixed(5), raw.dir[k * 3 + 1].toFixed(5), H(v3(raw.dir[k * 3], raw.dir[k * 3 + 1], raw.dir[k * 3 + 2])).toFixed(2));
          i = b0 + 1;
        } else i++;
      }
    }
    // (two stretches of water whose spans reach into each other are one bridge)
    spans.sort((p, q) => p[0] - q[0]);
    for (let k = spans.length - 1; k > 0; k--) {
      if (spans[k][0] <= spans[k - 1][1] + 2) {
        spans[k - 1][1] = Math.max(spans[k - 1][1], spans[k][1]);
        spans.splice(k, 1);
      }
    }
    // Inside a flat primitive (the plaza it leaves, its towns' pads, an apron) the road lies at its level.
    const fixed = new Float64Array(n).fill(NaN);
    const flats: Array<{ c: Vec3; cos: number; h: number; pad?: Settlement }> = [
      // (v2 R2: out to the plaza's carve core and its guard band, r + 1 + 4 m: a road climbing away
      // inside that band would step beside its own bed, where the plaza's bank holds the ground)
      ...opts.ownPlazas.map((g) => ({ c: gates[g].dir, cos: Math.cos((gates[g].r + 5) / R), h: gates[g].h })),
      // (and its towns' pads out to where its verge clears the rim, ≈ padR + 4: leaving on a diagonal, a
      // road climbing at once would stand beside the pad's edge a step above it)
      ...opts.ownPads.map((t) => ({ c: t.dir, cos: Math.cos((t.padR + 4) / R), h: t.h, pad: t })),
      ...airports.map((ap) => ({ c: ap.apron, cos: Math.cos((ap.apronR - 0.2) / R), h: ap.h })),
      // a terminal turnaround (an airport's, a lookout's car park) is a paved disc: flat round its end
      ...[a, b].filter((n) => n.place === 'airport' || n.place === 'viewpoint').map((n) => ({ c: n.dir, cos: Math.cos((turningRadius(width / 2) + 2.3) / R), h: n.h - ROAD_H })),
    ];
    const fq = v3();
    for (let i = 0; i < n; i++) {
      const x = raw.dir[i * 3], y = raw.dir[i * 3 + 1], z = raw.dir[i * 3 + 2];
      for (const f of flats) {
        if (x * f.c.x + y * f.c.y + z * f.c.z < f.cos) continue;
        // (a tilted pad: its plane under the road)
        fq.x = x;
        fq.y = y;
        fq.z = z;
        fixed[i] = f.pad && f.pad.grade ? padHeightAt(f.pad, fq) : f.h;
      }
    }
    const tg0 = performance.now();
    // (v2 R2 refine: baked, to the mm: ~2.5 ms of a cold page load)
    const hg = everyOther(cached(`grade:${name}`, [a.h, b.h, n, ...spans.flat()], process.env.NODE_ENV === 'production' ? null : () => halve(gradeProfile(raw.s, base0, a.h - ROAD_H, b.h - ROAD_H, spans, fixed).h, 1), 'mm16'), 1);
    const prof2 = { h: hg };
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
    // (a point ~2 m back along the street from the gate: the plan's skeleton)
    const back = exitBack.get(s)?.[i];
    return awayTangent(back ?? s.dir, gd, v3());
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
  let rimRoad = -1;
  let lighthouseRoad = -1;
  {
    const c = armNodeOf.get(`${gEast.id}:cw`);
    const d = armNodeOf.get(`${gSouth.id}:ccw`);
    if (c !== undefined && d !== undefined) rimRoad = roadTo('rim road', c, armOut(c, gEast.dir), d, armIn(d, gSouth.dir), 'road', { ownPads: [], ownPlazas: [gEast.id, gSouth.id], polar: 1 });
  }
  // The west, a loop of journeys: the mill road leaves the north-west gate round the plateau, past the
  // windmills, out over the downs to millbrook; the downs road runs on to port pebble on its point; the
  // coast road brings it back round the south-west of the plateau to the south gate.
  let millRoad = -1;
  let coastRoad = -1;
  if (millbrook) {
    const a = armNodeOf.get(`${gWest.id}:ccw`)!;
    millRoad = roadTo('mill road', a, armOut(a, gWest.dir), gateNodes.get(millbrook)![0], gateIn(millbrook, 0), 'road', { bridges: true, ownPads: [millbrook], ownPlazas: [gWest.id], polar: -1, vMax: 110 });
    gWest.leadsTo.push(millbrook.id);
  }
  if (millbrook && portPebble && gateNodes.get(millbrook)!.length > 1 && gateNodes.get(portPebble)!.length > 1) {
    roadTo('downs road', gateNodes.get(millbrook)![1], gateOut(millbrook, 1), gateNodes.get(portPebble)![1], gateIn(portPebble, 1), 'road', { bridges: true, ownPads: [millbrook, portPebble], ownPlazas: [] });
  }
  if (portPebble) {
    const a = armNodeOf.get(`${gSouth.id}:cw`)!;
    // (v2 R2 refine 2: a 16 m lead into port pebble's west gate: the road comes up the coast from the
    // south and turns ~90° onto the high street's line; on the default 12 m lead the corner's rounding
    // reached the pinned end and left a 1.8 m hook 6 m out of the gate)
    coastRoad = roadTo('coast road', a, armOut(a, gSouth.dir), gateNodes.get(portPebble)![0], gateIn(portPebble, 0), 'road', { bridges: true, ownPads: [portPebble], ownPlazas: [gSouth.id], polar: 1, vMax: 110, lead: 16 });
    gSouth.leadsTo.push(portPebble.id);
  }
  // The lighthouse road: north from the north-west gate to a car park on the headland, short of the
  // lighthouse (a viewpoint over the open sea).
  {
    const a = armNodeOf.get(`${gWest.id}:cw`);
    const v = cached('lookout:lighthouse', [lighthouse.x, lighthouse.y, lighthouse.z, gWest.dir.x, gWest.dir.y, gWest.dir.z], process.env.NODE_ENV === 'production' ? null : () => {
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
      lighthouseRoad = roadTo('lighthouse road', a, armOut(a, gWest.dir), E, towardTangent(c, nodeSpecs[a].dir, v3()), 'access', { ownPads: [], ownPlazas: [gWest.id] });
      if (lighthouseRoad >= 0) {
        lookouts.push({ name: 'lighthouse point', dir: c, h: nodeSpecs[E].h, node: E });
        gWest.leadsTo.push('lighthouse point');
      }
    }
  }
  void lighthouseRoad;
  void rimRoad;
  // The capital's airport causeway: from the north-west gate's third arm (straight out) over the lagoon to the apron.
  const capAirport = capAirportSite();
  if (capAirport) {
    const a = armNodeOf.get(`${gAir.id}:to`);
    if (a !== undefined) {
      const ad = nodeSpecs[a].dir;
      const endDir = walk(capAirport.apron, hd(capAirport.apron, ad), capAirport.apronR * 0.3, v3());
      const E = addNode(endDir, capAirport.h + ROAD_H, 'airport', 0);
      capAirport.node = E;
      // (straight out along the arm, which aims at the apron, over the lagoon)
      commitRoad('airport causeway', a, E, wpath([ad.x, ad.y, ad.z, endDir.x, endDir.y, endDir.z], [0, 0]), 'access', { causeway: true, ownPads: [], ownPlazas: [gAir.id] });
      gAir.leadsTo.push('bigtown airport');
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
    // A zig-zag up the ramp (planet.ts VALLEY: the corridor between the sea inlet east of it and the
    // cove road west of it): out of the roundabout's arm, east along the ramp's foot, a hairpin, west
    // across the ramp, a hairpin, and east into the line of the village's high street, in to its gate.
    // The legs splay apart away from each hairpin (the height between two legs grows with the road
    // between them, so does the gap: the bank between them stays a slope, spec'd). Hairpins at all
    // only because the direct way up (≈ 45 m for ≈ 10 m) is far over MAX_GRADE (spec'd).
    const rf = 6.5;
    const lead = walk(nodeSpecs[out].dir, hd(gEast.dir, nodeSpecs[out].dir), 1, v3());
    const [uL, vL] = uvOf(lead);
    const al = Math.hypot(uL - uA, vL - vA) || 1;
    // (the first bend 10 m out along the arm: a straight lead past the ring's junction patch; the east
    // hairpin at u = 6 (the inlet's shore is ~8 m on), 3.5 m up the ramp from it; the west one at
    // u = −34 (clear of the cove road west of it), 2 m farther up than the legs' parallel, its lower
    // bend cut into the knoll's flank)
    const X0: [number, number] = [uA + ((uL - uA) / al) * 10, vA + ((vL - vA) / al) * 10];
    const uE = 6;
    const E1v = X0[1] - 3.5;
    const uW = -34;
    const Wv = E1v - 2 * rf - 2;
    const W2v = Wv - 2 * rf;
    // (the last leg runs from the west hairpin across the top of the ramp onto the high street's line
    // KY m out from the gate, rising (or level) toward it: a bend of ≤ ~100° onto the line, the lead
    // into the gate straight on along it)
    const KY = 8;
    const tIn = gateIn(snowberry, 0);
    const far = uvOf(step(nodeSpecs[gate].dir, tIn, -30));
    const gl = Math.hypot(uG - far[0], vG - far[1]) || 1;
    const du = (uG - far[0]) / gl;
    const dv = (vG - far[1]) / gl;
    const Y: [number, number] = [uG - du * KY, vG - dv * KY];
    const ll = Math.hypot(Y[0] - uW, Y[1] - W2v) || 1;
    const rise = (W2v - Y[1]) / ll;
    const bendY = Math.acos(Math.max(-1, Math.min(1, ((Y[0] - uW) * du + (Y[1] - W2v) * dv) / ll)));
    const fits = Math.abs(uA) < 40 && vA > 56 && vA < 80 && vL < vA && ll > rf + 8 && rise > -0.05 && rise < 0.35 && bendY < (100 * Math.PI) / 180 && uE - X0[0] > 2 * rf + 8;
    if (DEBUG) console.log('[region] alpine', JSON.stringify({ uA, vA, uG, vG, X0, E1v, Wv, W2v, Y, ll, rise, bendY, fits }));
    if (fits) {
      // (every corner a true fillet; a leg shared between its two corners by what each needs)
      const ctrl: Array<[number, number]> = [[uA, vA], X0, [uE, E1v], [uE, E1v - 2 * rf], [uW, Wv], [uW, W2v], Y, [uG, vG]];
      const pts = filletPoly(ctrl, rf, [0, 6, rf, rf, rf, rf, 6], true);
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
    // (v2 R2 refine 2: a 15 m lead into the resort's gate, as the coast road's: on the default 12 m the
    // bridge approach's turn onto the palm avenue's line left a 2.8 m hook)
    roadTo('cove road', a, armOut(a, gEast.dir), gateNodes.get(cove)![0], gateIn(cove, 0), 'road', { bridges: true, ownPads: [cove], ownPlazas: [gEast.id], lead: 15 });
    gEast.leadsTo.push(cove.id);
  }
  // The far continent: the airport road; the clover highway south across the plains; the west road on to the lookout.
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
      roadTo('clover highway', gs[k], gateOut(fh, k), gateNodes.get(clover)![0], gateIn(clover, 0), 'highway', { bridges: true, ownPads: [fh, clover], ownPlazas: [] });
      k++;
    }

  }
  // The west road: from clover out across the far continent's plains and over the west lobe to
  // driftwood's back gate; the lookout lane from its flank gate up onto the headland to the lookout's car
  // park (without driftwood, the west road runs to the car park itself).
  if (clover && lookoutV.length && gateNodes.get(clover)!.length > 1) {
    const c = v3(lookoutV[0], lookoutV[1], lookoutV[2]);
    const E = addNode(c, Math.max(LAND_MIN, lookoutV[3]) + ROAD_H, 'viewpoint', -1);
    const cg = gateNodes.get(clover)![1];
    const dg = driftwood ? gateNodes.get(driftwood) : undefined;
    if (driftwood && dg && dg.length > 1) {
      roadTo('west road', cg, gateOut(clover, 1), dg[0], gateIn(driftwood, 0), 'road', { bridges: true, ownPads: [clover, driftwood], ownPlazas: [], relax: 120 });
      // (v2 R2 refine 2: an 8 m lead, as the coast and cove roads' 16 / 15: on the default the corner
      // off driftwood's west gate rounded to 5.2 m)
      if (roadTo('lookout lane', dg[1], gateOut(driftwood, 1), E, towardTangent(c, nodeSpecs[dg[1]].dir, v3()), 'access', { bridges: true, ownPads: [driftwood], ownPlazas: [], lead: 8 }) >= 0) lookouts.push({ name: 'the lookout', dir: c, h: nodeSpecs[E].h, node: E });
    } else if (roadTo('west road', cg, gateOut(clover, 1), E, towardTangent(c, nodeSpecs[cg].dir, v3()), 'road', { bridges: true, ownPads: [clover], ownPlazas: [], relax: 120 }) >= 0) lookouts.push({ name: 'the lookout', dir: c, h: nodeSpecs[E].h, node: E });
  }
  // The isle road: from millbrook west across the downs and over the isle bridge to puffin bay.
  if (millbrook && puffin && gateNodes.get(millbrook)!.length > 2) {
    roadTo('isle road', gateNodes.get(millbrook)![2], gateOut(millbrook, 2), gateNodes.get(puffin)![0], gateIn(puffin, 0), 'road', { bridges: true, ownPads: [millbrook, puffin], ownPlazas: [] });
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
    for (const id of townLinks) deg[id]++;
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
      for (let i = 0; i < townLinks.length; i++) townLinks[i] = remap[townLinks[i]];
      for (const j of townJobs) j.ids = j.ids.map((i) => remap[i]);
      const fix = (ids: number[]) => ids.map((i) => remap[i]).filter((i) => i >= 0);
      for (const s of settlements) {
        s.nodes = fix(s.nodes);
        s.gates = s.style === 'capital' ? s.gates : fix(s.gates);
        if (s.yards) for (const y of s.yards) y.node = remap[y.node];
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
  /**
   * v2 (R2 refine): plan every town's streets (towns.ts) and register them as edges, on the network's
   * first read. Their nodes went in at the first build from the baked skeletons (same planner).
   */
  let townsPlanned = false;
  const townStreets = () => {
    if (townsPlanned) return;
    townsPlanned = true;
    for (const { s, spec, ids, X, Z } of townJobs) {
      const plan = planTown(spec);
      const ch = s.chart;
      if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
        // (the skeleton the first build used came from the same planner: a stale bake would split them)
        plan.nodes.forEach((n, i) => {
          const d = chartToDir(ch, X(n.s, n.f), Z(n.s, n.f));
          if (i >= ids.length || arc(d, nodeSpecs[ids[i]].dir) > 0.01) console.warn(`[littlebig] region: ${s.id}'s plan differs from its baked skeleton (regenerate world/region/baked.ts)`);
        });
      }
      for (const e of plan.edges) {
        // (a street's world path is built on first use)
        let raw: WPath | null = null;
        const id = addEdge(ids[e.a], ids[e.b], null as unknown as WPath, e.kind, e.name, s.index, !!e.oneWay);
        if (e.width) edgeSpecs[id].width = e.width;
        Object.defineProperty(edgeSpecs[id], 'raw', {
          get: () => {
            if (raw) return raw;
            const D: number[] = [];
            const Hs: number[] = [];
            const t = v3();
            for (let i = 0; i < e.pts.length; i += 2) {
              const x = X(e.pts[i], e.pts[i + 1]), z = Z(e.pts[i], e.pts[i + 1]);
              chartToDir(ch, x, z, t);
              D.push(t.x, t.y, t.z);
              Hs.push(padH(s, x, z) + ROAD_H);
            }
            return (raw = wpath(D, Hs));
          },
          set: (v: WPath) => {
            raw = v;
          },
          enumerable: true,
          configurable: true,
        });
        streetsOf.get(s)!.push(id);
      }
    }
  };
  const network = () => {
    if (net) return net;
    townStreets();
    net = buildNetwork(nodeSpecs, edgeSpecs);
    // (v2 R2 refine) each abutment's foot: the lowest final ground in its box (built on first read,
    // off the boot path)
    const q = v3();
    for (const b of net.bridges) {
      for (const ab of b.abutments) {
        const rt = cross(ab.into, ab.dir);
        normalize3(rt);
        let lo = ab.top;
        for (let al = -ab.back; al <= ab.depth + 1e-6; al += (ab.depth + ab.back) / 6) {
          for (let k = -2; k <= 2; k++) {
            const lat = (k / 2) * ab.half;
            q.x = ab.dir.x + (ab.into.x * al + rt.x * lat) / R;
            q.y = ab.dir.y + (ab.into.y * al + rt.y * lat) / R;
            q.z = ab.dir.z + (ab.into.z * al + rt.z * lat) / R;
            normalize3(q);
            lo = Math.min(lo, cv.carve(q, base.baseHeightAt(q)));
          }
        }
        ab.foot = lo;
      }
    }
    return net;
  };
  // Components: union-find over edges.
  const parent = nodeSpecs.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of edgeSpecs) parent[find(e.a)] = find(e.b);
  for (let i = 0; i < townLinks.length; i += 2) parent[find(townLinks[i])] = find(townLinks[i + 1]);
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

  // ── The ferries: port pebble ⇄ far haven, driftwood ⇄ coral cove, over deep water (built on first
  // read of region.ferries). Each joins the two land masses across a wide sea. ──
  let ferries: FerryRoute[] | null = null;
  const pierOf = (s?: Settlement) => (s ? piers.find((p) => p.settlement === s.index) : undefined);
  // (v2 R2 refine: three boats, every pier served — the long crossing, the far west's run to the
  // cove, puffin bay's hop across the strait to far haven)
  const ferryPairs = [
    [pierOf(portPebble), pierOf(farHaven)],
    [pierOf(driftwood), pierOf(cove)],
    [pierOf(puffin), pierOf(farHaven)],
  ];
  const _fq = v3();
  const buildFerries = (): FerryRoute[] => {
    const out: FerryRoute[] = [];
    for (const [pa, pb] of ferryPairs) {
      if (!pa || !pb) continue;
      const near = (d: Vec3) => Math.min(arc(d, pa.berth), arc(d, pb.berth));
      const spec: RouteSpec = {
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
          // (and off the towns' pads and their banks into the sea, but at the berths)
          if (!berth) for (const t of settlements) if (t.style !== 'capital' && arc(d, t.dir) < t.padR + 10) return Infinity;
          return depth < 6 ? (6 - depth) * 0.25 : 0;
        },
        waterH: 99,
        bridges: true,
        waterCost: 0,
        bridgeStart: 0,
      };
      // (v2 R2 refine 2: the search is baked too — read lazily, so bake.spec reads the ferries before it
      // dumps; by its key alone, outside the build's chain — and compiled out of a production build)
      const got = memo.get(
        `ferry:${pa.id}-${pb.id}`,
        [pa.berth.x, pa.berth.y, pa.berth.z, pb.berth.x, pb.berth.y, pb.berth.z, pa.heading, pb.heading],
        process.env.NODE_ENV === 'production'
          ? null
          : () => {
              const r = routeSearch(spec);
              return r.ctrl ? [1, ...r.ctrl] : [0];
            },
        'f32',
      );
      if (!got[0]) continue;
      const dirs = routeFinish({ ...spec, keepOut: () => 0 }, got.subarray(1));
      // Out on the right of the route, back on the other side (the legs pass port to port), the
      // separation easing to nothing at each berth: the ferry turns round alongside the pier.
      const mid = wpath(dirs, new Float64Array(dirs.length / 3));
      const outLeg = woffset(mid, FERRY_SEPARATION / 2, 1, 30);
      const back = woffset(wreverse(mid), FERRY_SEPARATION / 2, 1, 30);
      const loop = wjoin([outLeg, back]);
      const closed = wpath(loop.dir, loop.h, true);
      out.push({ id: out.length, name: `${settlements[pa.settlement].name} ⇄ ${settlements[pb.settlement].name}`, a: pa.id, b: pb.id, lane: closed, berthS: [0, outLeg.length] });
    }
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
  /**
   * A pad's carve options: its plane's tilt (a world vector: grade × the uphill tangent at its centre)
   * and its seaward cut (the quay line, or the promenade's bite), banked as a sea wall (≈ 1 m, steep)
   * or as a beach (a long gentle slope down to the water).
   */
  const padOpts = (s: Settlement): DiscOpts | undefined => {
    const o: DiscOpts = {};
    // (the chart's plan metres are on the sphere of radius R + h, the carve's on R)
    const k = R / (R + s.h);
    if (s.grade) {
      const t = headingVector(s.dir, s.upHeading, v3());
      o.tilt = v3(t.x * (s.grade / k), t.y * (s.grade / k), t.z * (s.grade / k));
    }
    if (s.cut) {
      o.cut = { h: headingVector(s.dir, s.heading, v3()), f: s.cut.f, r: s.cut.r };
      o.cutBlend = s.cut.wall ? SEA_WALL : BEACH_RAMP;
      o.cutBatter = s.cut.wall ? 0.08 : 0.6;
      // (v2 R2 refine: a sea wall's paved apron, classified 'plaza')
      if (s.cut.wall) o.apron = QUAY_APRON;
      // (v2 R2 refine 2: and its block: the terrain ramps down under it, so the terrain mesh's facets
      // across the face lie behind it)
      if (s.cut.wall) o.wallRamp = { depth: WALL_DEPTH, low: WALL_LOW };
    }
    // (v2 R2 refine: the alpine village's fill over the top of the pass ramp, where the ground falls
    // away past its rim, follows the ground down even more closely than a town's (a wider bank there
    // only carried the fill out past the slope's foot: 96 rays found 40–80 spots over the bank rule
    // at blend 8.5 m, none with the fill's widening capped at 1.5 m)
    if (s.style === 'alpine') o.fillCap = ALPINE_FILL_CAP;
    return o.tilt || o.cut || o.fillCap ? o : undefined;
  };
  type Job = { add: (dcap: number) => void; dcap: () => number; key: number[] };
  const jobs: Job[] = [];
  // v2 (R2): each sea wall's harbour basin (dredged before its pad, so the whole quay drops into the
  // water: boats moor alongside, the pier stands over the sea from its root)
  for (const s of settlements) {
    if (!s.cut?.wall || !s.quay || s.quay.length < 4) continue;
    const q = s.quay;
    const ax = Math.sin(s.heading), az = -Math.cos(s.heading);
    // (v2 R2 refine 2: its core from the face out, the seabed at BASIN_H right under it: the wall's
    // block ramps down to WALL_LOW behind the face, the basin is deep in front of it)
    const off = BASIN_CORE;
    const a = chartToDir(s.chart, q[0] + ax * off, q[1] + az * off);
    const b = chartToDir(s.chart, q[q.length - 2] + ax * off, q[q.length - 1] + az * off);
    jobs.push({ key: [s.index, 9], dcap: () => 0, add: () => carve.capsule(PrimKind.Basin, a, b, BASIN_CORE, BASIN_BLEND, BASIN_H, BASIN_H, carve.group(), 0, -1, 0, 0) });
  }
  for (const s of settlements) {
    if (s.style === 'capital') continue;
    // (banks widen for the cuts and fills on land; toward the sea they stay short, so a coastal pad
    // never spreads a shoal over its harbour)
    const dc = padDcap(s);
    jobs.push({ key: [s.padR], dcap: () => dc, add: (d) => carve.disc(PrimKind.Pad, s.dir, s.padR, s.blend, s.h, s.index, 1, d, padOpts(s)) });
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
      // the strip's island: rounded ends past the thresholds (a low sandy spit, under the 0.6 m a
      // lighthouse's point needs: nature/landmarks.ts keeps to the headland) and a broader middle round the apron
      for (const f of [-0.62, 0.62]) {
        const c = walk(ap.centre, ap.heading, (f * ap.length), v3());
        jobs.push({ key: [f, 1], dcap: () => depthRound(c, 9, ap.h - 0.6, 6) + 1, add: (d) => carve.disc(PrimKind.Pad, c, 5.5, 8, ap.h - 0.6, -1, 0.6, d) });
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
    // (v2 R2: ~3 m segments over each stretch between spans, ending exactly at a span's abutment: a
    // segment that stopped short left the bed's last metre or two flat under a climbing approach)
    const cuts: Array<[number, number]> = [];
    {
      let from = 0;
      // (stopping 0.75 m short of the abutment: the fill's fade past it leaves the span's water open)
      for (const b of [...spans].sort((p, q) => p.s0 - q.s0)) {
        if (b.s0 - 0.75 > from) cuts.push([from, b.s0 - 0.75]);
        from = Math.max(from, b.s1 + 0.75);
      }
      if (L > from) cuts.push([from, L]);
    }
    const segs: Array<[number, number]> = [];
    for (const [c0, c1] of cuts) {
      // (1.5 m segments over the first and last 9 m of the road: its profile bends there, where it leaves
      // a pad's or a plaza's level, and a 3 m chord would cut under the crest)
      const e0 = c0 < 1e-6 ? Math.min(c1, 9) : c0;
      const e1 = c1 > L - 1e-6 ? Math.max(e0, L - 9) : c1;
      const run = (a: number, b: number, m: number) => {
        if (b - a < 1e-6) return;
        const n = Math.max(1, Math.ceil((b - a) / m));
        for (let q = 0; q < n; q++) segs.push([a + ((b - a) * q) / n, a + ((b - a) * (q + 1)) / n]);
      };
      run(c0, e0, 1.5);
      run(e0, e1, 3);
      run(e1, c1, 1.5);
    }
    for (let k = 0; k < segs.length; k++) {
      const [s0, s1] = segs[k];
      const gk = g;
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
  const dcaps = cached('carve', [jobs.length, ...jobs.flatMap((j) => j.key)], process.env.NODE_ENV === 'production' ? null : () => jobs.map((j) => j.dcap()), 'cm16');
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
    keepOut: (d, margin = 0, mask = KEEP_ALL) => {
      if (margin > KEEP_MARGIN_MAX) margin = KEEP_MARGIN_MAX;
      if (cv.keepOut(d, margin, mask)) return true;
      if (mask & KEEP.pier) for (const p of piers) if (segDist(d, p.root, p.berth) <= p.width / 2 + margin) return true;
      return false;
    },
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
    // (spec / debug: keepOut by brute force over every carve primitive and pier, no grid, no clamp)
    keepOutAll: {
      value: (d: Vec3, margin = 0, mask = KEEP_ALL) => {
        if (cv.keepOutAll(d, margin, mask)) return true;
        if (mask & KEEP.pier) for (const p of piers) if (segDist(d, p.root, p.berth) <= p.width / 2 + margin) return true;
        return false;
      },
      enumerable: false,
    },
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

/**
 * v2 (R2 refine): a sampled line with every other sample dropped (`k` numbers per sample), the last
 * always kept — what the bake stores of a road's finished centreline and its grade; everyOther puts
 * the dropped samples back halfway between their neighbours.
 */
/** Keeps every other k-tuple (plus the last) and a trailing parity tuple, so `everyOther` restores the exact count. */
function halve(a: ArrayLike<number>, k: number): number[] {
  const n = a.length / k;
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (i % 2 === 0 || i === n - 1) for (let c = 0; c < k; c++) out.push(a[i * k + c]);
  for (let c = 0; c < k; c++) out.push(n % 2);
  return out;
}
/**
 * Undoes `halve`: re-inserts the dropped midpoints with the 4-point scheme (cubic, so a curve keeps its
 * curvature instead of turning into a polygon with doubled bends at the kept samples).
 */
function everyOther(a: ArrayLike<number>, k: number): number[] {
  const m = a.length / k - 1;
  const even = a[m * k] === 0 && m > 1;
  const out: number[] = [];
  const at = (i: number, c: number) => a[i * k + c];
  for (let i = 0; i < m; i++) {
    // (even counts kept their last two neighbours: nothing was dropped between them)
    if (i > 0 && !(even && i === m - 1)) {
      const L = i >= 2, R = i + 1 < m && !(even && i + 1 === m - 1);
      for (let c = 0; c < k; c++) {
        const B = at(i - 1, c), C = at(i, c);
        out.push(
          L && R ? (-at(i - 2, c) + 9 * B + 9 * C - at(i + 1, c)) / 16
          : L ? (-at(i - 2, c) + 6 * B + 3 * C) / 8
          : R ? (3 * B + 6 * C - at(i + 1, c)) / 8
          : (B + C) / 2,
        );
      }
    }
    for (let c = 0; c < k; c++) out.push(at(i, c));
  }
  return out;
}
