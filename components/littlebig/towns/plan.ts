// LITTLEBIG v2 towns (T1): where every building, yard, garden, tree and prop of the towns stands.
// Pure and deterministic (no three.js). Each settlement but the capital is planned in its own chart
// (Settlement.chart: plan x east, z south, metres on the pad) on a 0.3 m occupancy raster that knows
// the street corridors (carriageway + sidewalk of every region edge near the pad), the junction patches
// and turning circles, the square, the yards, the piers, the quay's apron and wall block and the pad's
// edge; the buildings themselves are kept apart exactly (separating axes), so a terrace stands wall to
// wall. The yards are ringed first (a farm's barn and silos, a boatyard's sheds, the chalets, the villas,
// the fish market), then every street frontage is walked side by side, lot after lot facing the street
// (terraces in the harbours and the city, detached houses with side gaps elsewhere), then a second row
// behind it where the block is deep; then paddocks, gardens, the waterfront (crates, pots and nets on the
// quay, cranes and containers at the docks, huts and umbrellas on the beach, moored boats) and trees.
// Each airport is a site of its own (terminal, tower, hangar and windsock round its apron).
// towns/build.ts turns the items into geometry. Spec: plan.spec.ts.

import { QUAY_H } from '../roads/ground';
import { lampLayout } from '../roads/lamps';
import { CLOUD_MIN, R } from '../world/config';
import { cutDist, padDist, padHeight } from '../world/region/pad';
import type { Airport, Region, Settlement, WPath } from '../world/region/types';
import { hashSeed, Rng } from '../world/rng';
import { chartToDir, createChart, dirToChart, latLonFromDir, v3, type Chart, type Vec3 } from '../world/sphere';

/** Item kinds. Below T.tree: buildings (solid footprints, spec'd). */
export const T = {
  house: 0, shop: 1, corner: 2, mid: 3, office: 4, tower: 5, chapel: 6, townhouse: 7, chalet: 8, barn: 9, silo: 10, shed: 11, boathouse: 12, warehouse: 13, ctower: 14, hangar: 15, station: 16, hut: 17, market: 18, containers: 19, hotel: 20, villa: 21,
  tree: 24, pine: 25, palm: 26, bush: 27, garden: 28, paddock: 29,
  centre: 30, bench: 32, cafe: 33, umbrella: 34, tractor: 35, bales: 36, woodpile: 37, cradle: 38, crates: 39, crane: 40, stall: 41, sock: 42, flag: 43, apron: 44, pylon: 45, pool: 46, lifeguard: 47, bar: 48,
  boat: 50,
} as const;

/** A square's centrepiece (T.centre's c): a harbour town's lighthouse, a fishing village's anchor, a farm green's duck pond or maypole, an alpine trough under a decorated fir, the city's water feature. */
export const CENTRE = { lighthouse: 0, anchor: 1, pond: 2, maypole: 3, trough: 4, jets: 5 } as const;

/** Item flags: faces on a street (front, back), roof and dressing variants. */
export const F = { front: 1, back: 4, hip: 16, cafe: 32, tall: 64, hedge: 128, frontFence: 256 } as const;

export interface Item {
  t: number;
  /** Plan centre in the site's chart. */
  x: number;
  z: number;
  /** Plan angle of the local +x axis (from plan +x toward +z, like the capital's Building.angle); local +z points away from the street (the front faces −z). */
  a: number;
  /** Footprint along local x and z, and height (m). */
  w: number;
  d: number;
  h: number;
  /** Ground (m above sea level) at the front centre, and the lowest ground under the footprint. */
  y: number;
  lo: number;
  s: number;
  /** Colour / variant indices (wall and roof palette for the capital's styles; a boat's fleet). */
  c: number;
  v: number;
  f: number;
}

export interface Site {
  id: string;
  style: string;
  chart: Chart;
  dir: Vec3;
  /** Site radius (m), for culling and the reveal. */
  r: number;
  items: Item[];
  /** A ski lift's supports in order up the hill: plan x, z and the cable height above sea level. */
  lift: number[] | null;
}

const CELL = 0.3;
const OUT = 1;
const ROAD = 2;
const PAVED = 3;
const BUILT = 4;
const SOFT = 5;
/** A streetlight's pole (H1's lamp layout) and the metre round it no footprint enters. */
const LAMP = 6;
/** Clearance margin (m): ≥ the cell's half diagonal, so the raster's verdict holds for the exact shapes. */
const M = 0.22;
/** How near (m) a door may come to a lamp's pole. */
const DOOR_CLEAR = 1.5;
const TAU = Math.PI * 2;
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
let t0 = 0;
/** A point to hand the frame back: after ~1.5 ms of work since the last (ctx.yield decides whether the slice is spent). */
function* tick(): Generator<void, void, void> {
  if (performance.now() - t0 < 1.5) return;
  yield;
  t0 = performance.now();
}

/** Is a kind a building that counts toward a town's size (not a silo, shed, station, hut or containers)? */
export const dwelling = (t: number) => t <= T.chalet || t === T.barn || t === T.boathouse || t === T.warehouse || t === T.market || t === T.hotel || t === T.villa;

/**
 * Where a building's door is: its offset along the front (local x) from the seed, as towns/build and
 * the capital's doorX place it; NaN for a kind with no door to keep clear (sheds, silos, the docks).
 */
export function doorOff(t: number, s: number, w: number): number {
  if (t === T.townhouse) return ((s % 3) - 1) * Math.max(0, w / 2 - 1.02);
  if (t === T.chalet) return ((s % 3) - 1) * Math.max(0, w / 2 - 2);
  if (t <= T.corner) return (((s >>> 3) % 1000) / 1000 - 0.5) * 0.8 * (w / 2 - 0.42);
  return t <= T.chapel || t === T.barn || t === T.hotel || t === T.market || t === T.villa ? 0 : NaN;
}

/** A 0.3 m occupancy raster over a site, centred on its chart's origin (0 = free). */
class Grid {
  readonly n: number;
  readonly half: number;
  readonly c: Uint8Array;
  constructor(r: number) {
    this.n = Math.ceil((2 * r) / CELL);
    this.half = (this.n * CELL) / 2;
    this.c = new Uint8Array(this.n * this.n);
  }
  /**
   * Scan the cells whose centre lies in the rect (centre x, z, angle a, half sizes u, v), or in the
   * disc of radius u when `round`: code < 0 tests (true if any is taken, bar code `skip`, or off the
   * grid), otherwise marks the free ones with `code`.
   */
  scan(x: number, z: number, a: number, u: number, v: number, code: number, round = false, skip = 0): boolean {
    const ca = Math.cos(a), sa = Math.sin(a), { n, half: h, c } = this;
    const rx = round ? u : Math.abs(ca) * u + Math.abs(sa) * v, rz = round ? u : Math.abs(sa) * u + Math.abs(ca) * v;
    const j1 = Math.floor((z + rz + h) / CELL), i0 = Math.floor((x - rx + h) / CELL), i1 = Math.floor((x + rx + h) / CELL);
    for (let j = Math.floor((z - rz + h) / CELL); j <= j1; j++) {
      const pz = (j + 0.5) * CELL - h - z;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * CELL - h - x;
        if (round ? px * px + pz * pz > u * u : Math.abs(px * ca + pz * sa) > u || Math.abs(pz * ca - px * sa) > v) continue;
        const off = i < 0 || j < 0 || i >= n || j >= n, k = c[j * n + i];
        if (code < 0) {
          if (off || (k && k !== skip)) return true;
        } else if (!off && !k) c[j * n + i] = code;
      }
    }
    return false;
  }
  /** The code at a point (OUT off the grid). */
  at(x: number, z: number): number {
    const i = Math.floor((x + this.half) / CELL), j = Math.floor((z + this.half) / CELL);
    return i < 0 || j < 0 || i >= this.n || j >= this.n ? OUT : this.c[j * this.n + i];
  }
  free(x: number, z: number, a: number, u: number, v: number, round = false, skip = 0): boolean {
    // (the centre and four points just inside the corners first: most candidates fail there; their
    // cells' centres lie inside the shape, so this never refuses what the scan would pass)
    const ca = Math.cos(a), sa = Math.sin(a), iu = Math.max(0, u - 0.45), iv = Math.max(0, v - 0.45), k = this.at(x, z);
    if (k && k !== skip) return false;
    if (!round) for (const [p, q] of CORNERS) {
      const kc = this.at(x + p * iu * ca - q * iv * sa, z + p * iu * sa + q * iv * ca);
      if (kc && kc !== skip) return false;
    }
    return !this.scan(x, z, a, u, v, -1, round, skip);
  }
  /**
   * Mark a segment's capsule (a chain of them: the rect overlaps its neighbours by 0.25 m either end,
   * which closes the outside of any bend gentler than ~10 m radius; round caps only where asked).
   */
  seg(ax: number, az: number, bx: number, bz: number, r: number, code: number, capA = true, capB = true): void {
    const h = this.half + r;
    if ((Math.abs(ax) > h || Math.abs(az) > h) && (Math.abs(bx) > h || Math.abs(bz) > h)) return;
    this.scan((ax + bx) / 2, (az + bz) / 2, Math.atan2(bz - az, bx - ax), Math.hypot(bx - ax, bz - az) / 2 + 0.25, r, code);
    if (capA) this.scan(ax, az, 0, r, r, code, true);
    if (capB) this.scan(bx, bz, 0, r, r, code, true);
  }
}

/** A road centreline in a site's plan. */
export interface Poly {
  x: Float64Array;
  z: Float64Array;
  /** Cumulative plan length at each sample. */
  s: Float64Array;
  len: number;
  /** Carriageway half width + sidewalk (or verge) (m). */
  hw: number;
  e: number;
}

export function toPoly(c: Chart, p: WPath, hw: number, e: number): Poly {
  const n = p.h.length, x = new Float64Array(n), z = new Float64Array(n), s = new Float64Array(n), q = { x: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    dirToChart(c, v3(p.dir[i * 3], p.dir[i * 3 + 1], p.dir[i * 3 + 2]), q);
    x[i] = q.x;
    z[i] = q.z;
    if (i) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  }
  return { x, z, s, len: s[n - 1], hw, e };
}

/** Distance (m) from (x, z) to a poly's centreline. */
export function polyDist(p: Poly, x: number, z: number): number {
  let best = Infinity;
  for (let i = 1; i < p.x.length; i++) {
    const ax = p.x[i - 1], az = p.z[i - 1], dx = p.x[i] - ax, dz = p.z[i] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

/** The point at plan length s along a poly (clamped to its ends), into o (x, z). */
function pointAt(p: Poly, s: number, o: number[]): number[] {
  let i = 1;
  while (i < p.x.length - 1 && p.s[i] < s) i++;
  const l = p.s[i] - p.s[i - 1] || 1, f = Math.max(0, Math.min(1, (s - p.s[i - 1]) / l));
  o[0] = p.x[i - 1] + (p.x[i] - p.x[i - 1]) * f;
  o[1] = p.z[i - 1] + (p.z[i] - p.z[i - 1]) * f;
  return o;
}

/** Does the footprint (centre x, z, angle a, half sizes u, v) overlap item b's? (separating axes) */
export function overlaps(x: number, z: number, a: number, u: number, v: number, b: Item): boolean {
  const dx = b.x - x, dz = b.z - z, bu = b.w / 2, bv = b.d / 2;
  if (dx * dx + dz * dz > (u + v + bu + bv) ** 2) return false;
  for (const t of [a, a + Math.PI / 2, b.a, b.a + Math.PI / 2]) {
    const cx = Math.cos(t), cz = Math.sin(t);
    const ra = u * Math.abs(Math.cos(a) * cx + Math.sin(a) * cz) + v * Math.abs(Math.sin(a) * cx - Math.cos(a) * cz);
    const rb = bu * Math.abs(Math.cos(b.a) * cx + Math.sin(b.a) * cz) + bv * Math.abs(Math.sin(b.a) * cx - Math.cos(b.a) * cz);
    if (Math.abs(dx * cx + dz * cz) >= ra + rb) return false;
  }
  return true;
}

/** A lot: what to build on a frontage, its least setback from the sidewalk and the gap after it. */
interface Lot {
  t: number;
  w: number;
  d: number;
  h: number;
  set: number;
  c: number;
  v: number;
  f: number;
  gap: number;
}

/** The world direction of plan (x, z) in a site's chart. */
export const siteDir = (site: { chart: Chart }, x: number, z: number, out: Vec3 = v3()) => chartToDir(site.chart, x, z, out);

/**
 * Every site, the towns (bar the capital) then the airports, as a stepped job: each `yield` is a point
 * where the caller may hand the frame back (the towns system slices it across frames).
 */
export function* planSteps(region: Region, heightAt: (d: Vec3) => number, sandAt: (d: Vec3) => boolean = (d) => heightAt(d) < 1.2): Generator<void, Site[], void> {
  const out: Site[] = [];
  t0 = performance.now();
  // (H1's streetlights, where roads/ puts them: no footprint within a metre of a pole, no door within 1.5 m;
  // a slice of its own: ~5 ms warm, ~20 ms the first call in a page, which is ours or roads')
  yield;
  const poles = lampLayout(region, 0, 0).map((l) => l.q);
  yield;
  t0 = performance.now();
  for (const s of region.settlements) if (s.style !== 'capital') out.push(yield* planTown(region, s, heightAt, sandAt, poles));
  for (const a of region.airports) out.push(yield* planAirport(region, a, heightAt, poles));
  return out;
}

/** Every site, in one go. */
export function planTowns(region: Region, heightAt: (d: Vec3) => number, sandAt?: (d: Vec3) => boolean): Site[] {
  const g = planSteps(region, heightAt, sandAt);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/** Is world direction d within r m of a ferry's lane? */
const nearFerry = (region: Region, d: Vec3, r: number) =>
  region.ferries.some((f) => {
    const D = f.lane.dir;
    for (let i = 0; i < f.lane.h.length; i += 2) if (((D[i * 3] - d.x) ** 2 + (D[i * 3 + 1] - d.y) ** 2 + (D[i * 3 + 2] - d.z) ** 2) * R * R < r * r) return true;
    return false;
  });

/** A plan item with no footprint bookkeeping (props off the raster: quays, beaches, piers). */
const item = (t: number, x: number, z: number, a: number, w: number, d: number, h: number, rng: Rng, c = 0, y = 0): Item => ({ t, x, z, a, w, d, h, y, lo: y, s: rng.int(1, 1 << 30), c, v: 0, f: 0 });

/** Shared placement state for one site. */
function* siteKit(region: Region, chart: Chart, dir: Vec3, r: number, groundAt: (x: number, z: number) => number, rng: Rng, poles: Vec3[]) {
  const G = new Grid(r + 1);
  yield* tick();
  const items: Item[] = [];
  const solids: Item[] = [];
  const cosR = Math.cos((r + 14) / R);
  const near = (d: Vec3) => d.x * dir.x + d.y * dir.y + d.z * dir.z > cosR;
  const polys: Poly[] = [];
  const at = (d: Vec3) => dirToChart(chart, d, { x: 0, z: 0 });
  // every edge with a sample near the site: its carriageway + sidewalk (or verge) is a corridor
  for (const e of region.edges) {
    yield* tick();
    const c = e.centre;
    let hit = false;
    for (let i = 0; i < c.h.length && !hit; i += 3) hit = near(v3(c.dir[i * 3], c.dir[i * 3 + 1], c.dir[i * 3 + 2]));
    if (!hit) continue;
    const p = toPoly(chart, c, e.width / 2 + (e.sidewalk > 0 ? e.sidewalk : 1.6), e.id);
    polys.push(p);
    for (let i = 1, n = p.x.length; i < n; i++) {
      if (!(i & 7)) yield* tick();
      G.seg(p.x[i - 1], p.z[i - 1], p.x[i], p.z[i], p.hw + M, ROAD, i === 1, i === n - 1);
    }
  }
  // the nodes: a dead end's turning circle and its sidewalk; a junction (or a bend) its arms' corridors
  // run in to its centre and a disc round it covers the rounded corners and their sidewalks (the blocks'
  // corners stay free)
  for (const n of region.nodes) {
    if (!near(n.dir)) continue;
    yield* tick();
    const q = at(n.dir);
    let r = n.kind === 'end' ? Math.max(n.turnR + 1.5, n.radius) : 0;
    if (!r) for (const id of n.edges) {
      const e = region.edges[id], c = e.centre, i = e.a === n.id ? 0 : c.h.length - 1, a = at(v3(c.dir[i * 3], c.dir[i * 3 + 1], c.dir[i * 3 + 2])), w = e.width / 2 + (e.sidewalk > 0 ? e.sidewalk : 1.6);
      r = Math.max(r, w + 1);
      G.seg(q.x, q.z, a.x, a.z, w + M, ROAD);
    }
    G.scan(q.x, q.z, 0, r + M, 0, PAVED, true);
  }
  for (const p of region.piers) {
    if (!near(p.root)) continue;
    const a = at(p.root), b = at(p.berth);
    G.seg(a.x, a.z, b.x, b.z, p.width / 2 + 0.8, PAVED);
  }
  const pole: number[] = [];
  for (const q of poles) {
    if (!near(q)) continue;
    const p = at(q);
    pole.push(p.x, p.z);
    G.scan(p.x, p.z, 0, 1, 0, LAMP, true);
  }
  const place = (t: number, x: number, z: number, a: number, w: number, dd: number, h: number, c = 0, v = 0, f = 0, code = BUILT, m = M, s = rng.int(1, 1 << 30)): Item => {
    const ca = Math.cos(a), sa = Math.sin(a);
    let lo = Infinity;
    for (const [u, k] of CORNERS) lo = Math.min(lo, groundAt(x + ((u * w) / 2) * ca - ((k * dd) / 2) * sa, z + ((u * w) / 2) * sa + ((k * dd) / 2) * ca));
    const it: Item = { t, x, z, a, w, d: dd, h, y: groundAt(x + (dd / 2) * sa, z - (dd / 2) * ca), lo, s, c, v, f };
    items.push(it);
    if (t < T.tree) solids.push(it);
    if (code) G.scan(x, z, a, w / 2 + m, dd / 2 + m, code);
    return it;
  };
  /**
   * Place a w × d footprint at (x, z) facing away from (nx, nz) (its local +z) if it is free: the
   * raster (other buildings aside: they are tested exactly, `gap` m apart) and every building; its door
   * DOOR_CLEAR m from every lamp's pole (a seed whose door lands clear, else no lot).
   */
  const tryAt = (t: number, x: number, z: number, nx: number, nz: number, w: number, dd: number, h: number, c = 0, v = 0, f = 0, gap = 0.04, code = BUILT): Item | null => {
    const a = Math.atan2(-nx, nz);
    if (!G.free(x, z, a, w / 2 + M, dd / 2 + M, false, BUILT)) return null;
    for (const b of solids) if (overlaps(x, z, a, w / 2 + gap, dd / 2 + gap, b)) return null;
    let s = rng.int(1, 1 << 30);
    for (let k = 0, o = doorOff(t, s, w); o === o; o = doorOff(t, (s = rng.int(1, 1 << 30)), w)) {
      // (the door's foot: the front's middle, o m along it; n is a unit normal)
      const fx = x + o * nz - (nx * dd) / 2, fz = z - o * nx - (nz * dd) / 2;
      let clear = true;
      for (let i = 0; i < pole.length && clear; i += 2) clear = Math.hypot(pole[i] - fx, pole[i + 1] - fz) > DOOR_CLEAR;
      if (clear) break;
      if (++k > 8) return null;
    }
    return place(t, x, z, a, w, dd, h, c, v, f, code, M, s);
  };
  /**
   * Up to n things round a disc (centre cx, cz, radius r) facing into it, the bearings swept out from
   * the side facing the pad's centre (a yard at a dead end lies near the pad's edge); `sizes` (w, d
   * pairs) in order of preference; `spec` per bearing: kind, height, colour, variant, flags.
   */
  const ring = (cx: number, cz: number, r: number, n: number, sizes: number[], spec: () => number[], code = BUILT, gap = 0.5) => {
    const toC = Math.atan2(-cz, -cx);
    let made = 0;
    for (let k = 0; k < 44 && made < n; k++) {
      const b = toC + (k & 1 ? 1 : -1) * Math.ceil(k / 2) * 0.143, cb = Math.cos(b), sb = Math.sin(b), [t, h, c, v, f] = spec();
      out: for (let i = 0; i < sizes.length; i += 2) {
        for (const o of [0.3, 1.3]) {
          const off = r + o + sizes[i + 1] / 2;
          if (tryAt(t, cx + cb * off, cz + sb * off, cb, sb, sizes[i], sizes[i + 1], h, c, v, f, gap, code)) {
            made++;
            break out;
          }
        }
      }
    }
    return made;
  };
  // (off every carriageway by m and out of every turning circle: for what stands off the raster, on the quay)
  const ends = region.nodes.filter((n) => n.kind === 'end' && near(n.dir)).map((n) => [at(n.dir), n.turnR] as const);
  const offRoad = (x: number, z: number, m: number) => polys.every((p) => polyDist(p, x, z) > region.edges[p.e].width / 2 + m) && ends.every(([q, r]) => Math.hypot(q.x - x, q.z - z) > r + m);
  return { G, items, solids, polys, place, tryAt, ring, offRoad };
}

// ── Towns ──

/** Wall palette indices for a colourful terrace (no glass). */
const BRIGHT = [1, 2, 3, 4, 5, 0];
/** A resort hotel's colour (towns/build HOTEL: white, then the pastels). */
const HOTEL = [0, 0, 1, 2, 3];

function* planTown(region: Region, s: Settlement, heightAt: (d: Vec3) => number, sandAt: (d: Vec3) => boolean, poles: Vec3[]): Generator<void, Site, void> {
  const rng = new Rng(hashSeed(region.seed, `towns:${s.id}`));
  const st = s.style, P = s.padR, metro = st === 'metro', wall = s.wall, sq = s.square, town = s.kind !== 'village';
  const { G, items, solids, polys, place, tryAt, ring, offRoad } = yield* siteKit(region, s.chart, s.dir, P, (x, z) => padHeight(s, x, z), rng, poles);
  const site: Site = { id: s.id, style: st, chart: s.chart, dir: s.dir, r: P + 6, items, lift: null };
  const d = v3();
  const hAt = (x: number, z: number) => heightAt(chartToDir(s.chart, x, z, d));
  const p = (k: number) => rng.chance(k);
  {
    // the pad's edge, the quay's apron and wall block (or a beach's promenade edge); padDist / cutDist
    // inlined: half a million cells over the towns
    const ax = Math.sin(s.heading), az = -Math.cos(s.heading), cut = s.cut, deep = wall ? wall.depth + 0.4 : 1.4;
    const bf = cut && Number.isFinite(cut.r) ? cut.f + cut.r : 0;
    for (let j = 0; j < G.n; j++) {
      yield* tick();
      const z = (j + 0.5) * CELL - G.half;
      for (let i = 0; i < G.n; i++) {
        const x = (i + 0.5) * CELL - G.half;
        if (Math.hypot(x, z) > P - 0.08 || (cut && (bf ? cut.r - Math.hypot(x - ax * bf, z - az * bf) : x * ax + z * az - cut.f) > -deep)) G.c[j * G.n + i] = OUT;
      }
    }
  }
  for (const y of sq ? [sq, ...(s.yards ?? [])] : s.yards ?? []) G.scan(y.x, y.z, 0, y.r + 0.6, 0, PAVED, true);

  // ── the square. H1 paves its whole block, out to the streets round it (r + 22 m; r + 9 m where it
  // opens onto the pad), and no building stands on the paving (DECISIONS [v2-T1]). It is dressed as the
  // place's own square: its centrepiece (a harbour town's lighthouse, a fishing village's anchor, an
  // alpine trough under a decorated fir, the city's water feature; the resort's pool), benches round it
  // facing in, and out across the block market stalls, café tables, tubs and trees. A farm's green is
  // H1's lawn, not paving: its middle (r + 2.8 m) holds its duck pond or maypole, benches and trees, and
  // the cottages round it face in across the grass. A square that is a turning circle keeps its
  // centrepiece on the island the U-turn goes round (turnR − 2.9 m: roads/ground), benches and tubs
  // round its rim ──
  let onSq = (_x: number, _z: number) => false;
  if (sq) {
    const turn = s.nodes.map((id) => region.nodes[id]).find((n) => n.kind === 'end' && n.place === 'square');
    const cv = st === 'harbour' ? (town ? CENTRE.lighthouse : CENTRE.anchor) : st === 'farm' ? (sq.r > 4.6 ? CENTRE.pond : CENTRE.maypole) : st === 'alpine' ? CENTRE.trough : CENTRE.jets;
    const cw = turn ? Math.min(3.2, (turn.turnR - 3.3) * 1.4) : cv === CENTRE.pond ? Math.min(sq.r * 1.4, 7.2) : cv === CENTRE.jets ? Math.min(4.4, sq.r * 1.2) : 2.6;
    if (st === 'resort') place(T.pool, sq.x, sq.z, rng.range(0, Math.PI), sq.r * 2 + 1.4, sq.r * 2 - 1, 0, 0, 0, 0, 0);
    else place(T.centre, sq.x, sq.z, rng.range(0, TAU), cw, cw, 0, cv, 0, 0, 0);
    let k = 0;
    if (turn) ring(sq.x, sq.z, Math.max(turn.turnR + 1.5, turn.radius) + 0.3, 6, [1.8, 0.6], () => (k++ & 1 ? [T.bush, 1.1] : [T.bench, 0]), SOFT, 1.4);
    else {
      // (every ray's reach first, then the block marked: a ray must not stop at its neighbour's paving)
      const reach: number[] = [];
      for (k = 0; k < 256; k++) {
        const ca = Math.cos((k / 256) * TAU), sa = Math.sin((k / 256) * TAU);
        let t = 0;
        for (let c = 0; t < sq.r + 22; t += 0.3) if ((c = G.at(sq.x + ca * t, sq.z + sa * t)) === ROAD || (c === PAVED && t > sq.r + 1)) break;
        reach.push(t < sq.r + 22 ? t : sq.r + 9);
      }
      // (a green: only its middle; then the dressing and the cottages round it stop there)
      const green = st === 'farm', gr = sq.r + 2.8;
      if (green) for (k = 0; k < 256; k++) reach[k] = Math.min(reach[k], gr);
      for (k = 0; k < 256; k++) {
        if (!(k & 7)) yield* tick();
        for (let u = sq.r; u < reach[k] + 0.3; u += 0.3) G.scan(sq.x + Math.cos((k / 256) * TAU) * u, sq.z + Math.sin((k / 256) * TAU) * u, 0, 0.36, 0, PAVED, true);
      }
      if (!green) onSq = (x, z) => Math.hypot(x - sq.x, z - sq.z) < reach[Math.round((Math.atan2(z - sq.z, x - sq.x) / TAU) * 256) & 255] + 0.5;
      if (sq.r > 3.1 && st !== 'resort') for (k = 0; k < 4; k++) {
        const b = (k / 4) * TAU + 0.785 + rng.range(-0.2, 0.2);
        place(T.bench, sq.x + Math.cos(b) * (sq.r - 0.7), sq.z + Math.sin(b) * (sq.r - 0.7), b - Math.PI / 2, 1.8, 0.5, 0, 0, 0, 0, 0);
      }
      // across the block: stalls, café tables, benches, tubs and trees along every sixth ray (~3 m apart)
      // (a way in left open on the square's side away from the pad's middle: the walk in, and the view across it)
      const at: number[] = [], ob = Math.atan2(sq.z, sq.x);
      const kinds = st === 'farm' ? [T.tree, T.bush, T.tree, T.bench] : st === 'resort' ? [T.bar, T.palm, T.umbrella, T.cafe, T.palm, T.umbrella] : st === 'alpine' ? [T.cafe, T.pine, T.bench, T.cafe, T.bush] : [T.stall, T.cafe, T.tree, T.bench, T.stall, T.bush, T.cafe];
      for (let k = 3, n = 0; k < 256; k += 6) {
        const b = (k / 256) * TAU, cb = Math.cos(b), sb = Math.sin(b);
        for (let t = sq.r + 1.4 + (k % 12 > 5 ? 1.4 : 0); t < reach[k] - 0.9; t += 3) {
          const x = sq.x + cb * t, z = sq.z + sb * t, kind = kinds[n % kinds.length];
          if ((t < sq.r + 5 && Math.abs(Math.sin((b - ob) / 2)) < 0.2) || padDist(s, x, z) > -2 || !G.free(x, z, 0, kind === T.stall || kind === T.bar ? 1.6 : 1.3, 0, true, PAVED)) continue;
          let near = false;
          for (let i = 0; i < at.length && !near; i += 2) near = Math.hypot(at[i] - x, at[i + 1] - z) < 3;
          if (near) continue;
          at.push(x, z);
          n++;
          if (kind === T.stall) place(kind, x, z, b + Math.PI / 2, 2.6, 1.5, 2.5, rng.int(0, 4), 0, 0, 0);
          else if (kind === T.bar) place(kind, x, z, b, 3, 3, 3.4, 0, 0, 0, 0);
          else if (kind === T.umbrella) place(kind, x, z, b + Math.PI / 2, 2.4, 2.4, 2.3, rng.int(0, 4), 0, 1, 0);
          else if (kind === T.bench) place(kind, x, z, b - Math.PI / 2, 1.8, 0.5, 0, 0, 0, 0, 0);
          else place(kind, x, z, rng.range(0, TAU), kind === T.cafe ? 2.2 : 1.6, kind === T.cafe ? 2.2 : 1.6, kind === T.tree ? rng.range(3.6, 5) : kind === T.palm ? rng.range(4.5, 6) : kind === T.pine ? rng.range(4.2, 5.4) : kind === T.bush ? 1.1 : 0, rng.int(0, 3), 0, 0, 0);
        }
      }
      // the green's cottages, facing in across it
      if (green) ring(sq.x, sq.z, gr, 16, [7.2, 6.2, 5.2, 4.4, 3.6].flatMap((dd) => [5, dd, 4.25, dd]), () => [T.house, rng.range(5.4, 6.6), rng.pick([0, 0, 3, 1]), rng.int(0, 1), F.front | F.hip], BUILT, 0.5);
    }
  }

  // ── the alpine ski lift, up to the snow ──
  yield* tick();
  if (st === 'alpine') {
    site.lift = yield* planLift(s, G, place, hAt, region);
    yield* tick();
  }

  yield* tick();
  // ── the yards: their buildings round the rim facing in, dressed with what the yard is for ──
  const dress = (y: { x: number; z: number; r: number }, n: number, sizes: number[], spec: () => number[]) => ring(y.x, y.z, y.r + 0.65, n, sizes, spec, SOFT, 0.3);
  for (const y of s.yards ?? []) {
    const rim = (n: number, sizes: number[], spec: () => number[]) => ring(y.x, y.z, y.r + 0.65, n, sizes, spec);
    if (y.kind === 'farm') {
      // the barn, the farmhouse, a long low cowshed (a barn with no loft), silos, a shed
      rim(1, [10, 7.5, 8.6, 6.6, 7.4, 5.8], () => [T.barn, rng.range(7.2, 8.4), rng.int(0, 1), rng.int(0, 1)]);
      rim(1, [6, 5.2, 5.2, 4.8, 4.6, 4.2], () => [T.house, rng.range(6, 7), rng.pick([0, 3, 1]), 0, F.front | F.hip]);
      rim(1, [9, 4.6, 7.4, 4.2, 6, 4], () => [T.barn, 4.6, 2, 1]);
      rim(rng.int(1, 2), [3.4, 3.4, 2.8, 2.8], () => [T.silo, rng.range(7.5, 10)]);
      rim(1, [4.5, 3.6, 3.6, 3], () => [T.shed, 3.2]);
      dress(y, 1, [1.9, 3.1], () => [T.tractor, 2, rng.int(0, 2)]);
      dress(y, 2, [2.4, 2.4, 1.6, 1.6], () => [T.bales, 1.4]);
    } else if (y.kind === 'boat') {
      rim(3, [5.6, 7.6, 4.8, 6.4, 4.2, 5.4, 3.8, 4.6], () => [T.boathouse, rng.range(5.2, 6.4), rng.int(0, 5)]);
      dress(y, 2, [1.8, 4.8], () => [T.cradle, 1, rng.int(0, 6)]);
      dress(y, 1, [3.2, 2.4, 2.8, 2], () => [T.market, 3.2, rng.int(0, 2)]);
      dress(y, 2, [1.6, 1.2], () => [T.crates, 0, rng.int(0, 2)]);
    } else if (y.kind === 'chalet') {
      rim(3, [7.6, 7.4, 6.6, 6.6, 5.8, 5.8, 5.2, 5.2], () => [T.chalet, rng.range(7, 8.5), rng.int(0, 3), rng.int(0, 1)]);
      dress(y, 2, [2.4, 0.9], () => [T.woodpile, 1.2]);
    } else if (y.kind === 'villa') {
      rim(3, [7.6, 6.8, 6.6, 6, 5.8, 5.4, 5, 4.8], () => [T.villa, rng.range(5.6, 7.2), rng.int(0, 4), rng.int(0, 1)]);
      dress(y, 2, [2.4, 2.4], () => [T.umbrella, 2.3, rng.int(0, 4), 0, 1]);
    } else if (y.kind === 'school') {
      rim(1, [13, 8.5, 11, 7.6, 9, 7], () => [T.mid, 8.2, 3, 1]);
      dress(y, 1, [0.6, 0.6], () => [T.flag, 0]);
    } else if (y.kind === 'market') {
      // (the yard itself is a turning circle: the market hall, its stalls and the café tables stand round it)
      rim(1, [7.4, 5, 6, 4.4], () => [T.market, 4.4, rng.int(0, 2)]);
      dress(y, 4, [3, 2.2], () => [T.market, 3.2, rng.int(0, 2)]);
      dress(y, 4, [2.2, 2.2], () => [T.cafe, 0]);
    } else if (y.kind === 'lookout') {
      dress(y, 1, [1.8, 0.5], () => [T.bench, 0]);
      dress(y, 1, [0.6, 0.6], () => [T.flag, 0]);
    }
  }
  // ── street frontages, walked lot after lot: the front rows (wide streets and the quay first), then
  // a second row behind them where the block is deep (the city: a third) ──
  // (every edge across the pad: its own streets and the region's roads in from its gates)
  const streets = polys
    .filter((q) => region.edges[q.e].kind !== 'ring' && q.len > 4 && q.x.some((x, i) => Math.hypot(x, q.z[i]) < P))
    .map((q) => {
      let qn = 0;
      for (let i = 0; i < q.x.length; i++) qn += +(cutDist(s, q.x[i], q.z[i]) > -8);
      return { q, quay: qn > 3, wide: region.edges[q.e].width > 6 };
    })
    .sort((a, b) => +b.wide - +a.wide || +b.quay - +a.quay || b.q.len - a.q.len || a.q.e - b.q.e);
  let lastWall = 0;
  /** A small dwelling of the style: a chalet, a resort's villa, a cottage. */
  const sm = st === 'alpine' ? T.chalet : st === 'resort' ? T.villa : T.house;
  /** A lot from ranges (width, depth, height, setback, gap after it); its wall colour from `c` (else the terrace's next bright one); flag f with chance fc. */
  const L = (t: number, w0: number, w1: number, d0: number, d1: number, h0: number, h1: number, s0: number, s1: number, g0: number, g1: number, c?: number[], f = 0, fc = 0): Lot => ({
    t,
    w: rng.range(w0, w1),
    d: rng.range(d0, d1),
    h: rng.range(h0, h1),
    set: rng.range(s0, s1),
    gap: rng.range(g0, g1),
    c: c ? rng.pick(c) : (lastWall = BRIGHT[(BRIGHT.indexOf(lastWall) + 1 + rng.int(0, 3)) % 6]),
    v: rng.int(0, 1),
    f: rng.chance(fc) ? f : 0,
  });
  /** A smaller copy (a tight corner still takes it). */
  const less = (l: Lot, k: number): Lot => ({ ...l, w: l.w * k, d: l.d * Math.max(0.8, k), h: l.h * (0.6 + k * 0.4) });
  const terrace = (rel: number) => rel < 0.8 && p(town ? 0.7 : 0.6);
  /** The lots to try at a frontage station, best first (row 0: the front row). */
  const lots = (rel: number, quay: boolean, wide: boolean, row: number): Lot[] => {
    let a: Lot;
    switch (st) {
      case 'harbour':
        // tall narrow gabled houses in every colour, wall to wall along the quay and round the middle;
        // the odd corner shop; cottages behind
        if (row) a = L(T.house, 4, 5, 4.2, 5, 5, 6.4, 0, 0.6, 0.5, 1.1, undefined, F.hip, 0.3);
        else if (quay || terrace(rel)) a = p(0.1) ? L(T.corner, 5.4, 6.2, 5.6, 6.6, 7, 8, 0, 0, 0.04, 0.04) : L(T.townhouse, 3.7, 4.7, 5.2, 6.4, quay ? 8.8 : 7.6, quay ? 11.5 : 10, 0, 0, 0.04, p(0.12) ? 1.6 : 0.04);
        else a = L(T.house, 4.2, 5.2, 4.4, 5.4, 5.6, 7.2, 0, 0.9, 0.5, 1.2, undefined, F.hip, 0.2);
        break;
      case 'alpine':
        a = row ? L(T.chalet, 5, 5.8, 5, 5.8, 6, 7, 0, 0.8, 0.3, 0.8, [0, 1, 2, 3]) : p(0.08) ? L(T.corner, 5.6, 6.4, 5.8, 6.6, 7, 8, 0.4, 0.4, 0.6, 1, [0]) : L(T.chalet, 5.4, 6.6, 5.4, 6.6, 6.6, 8, 0.2, 1, 0.3, 0.9, [0, 1, 2, 3]);
        break;
      case 'farm':
        a = row ? L(T.house, 4.2, 5, 4.2, 5, 5, 6, 0, 0.8, 0.5, 1.4, [0, 0, 3, 1, 4], F.hip, 0.4) : p(0.1) ? L(T.barn, 7.2, 8.6, 5.8, 6.8, 6.4, 7.4, 1, 2.2, 1.4, 2.6) : L(T.house, 4.4, 5.6, 4.4, 5.4, 5.4, 7, 0.4, 1.8, 0.6, 1.6, [0, 0, 3, 1, 4], F.hip, 0.45);
        break;
      case 'resort':
        // white hotels and cafés along the promenade, villas behind (each with its pool)
        a = quay && !row ? (p(0.25) ? L(T.shop, 5.4, 6.8, 5, 6.2, 4.4, 5.4, 0, 0, 0.5, 1, [0, 3, 2], F.cafe, 0.8) : L(T.hotel, 7, 9.5, 6, 7.5, 9, 13.5, 0.2, 0.6, 0.6, 1.2, HOTEL)) : p(row ? 0.05 : 0.14) ? L(T.hotel, 7, 8.6, 6, 7, 8, 10.5, 0.4, 0.4, 0.8, 1.6, HOTEL) : L(T.villa, 5, 6.6, 4.6, 6, 4.4, 7, 0.3, 1.2, 0.6, 1.2, [0, 1, 2, 3, 4]);
        break;
      default: {
        // the city: towers on the boulevard and round the middle, offices, mid-rise blocks wall to wall,
        // warehouses and container yards on the docks; shops in the gaps
        const blocks = [0, 1, 3, 4, 5, 2];
        if (quay && !row) return p(0.45) ? [L(T.containers, 6, 7.2, 4.6, 5.4, 2.6, 5.4, 0, 0.4, 0.5, 1.2, [0])] : [L(T.warehouse, 8.5, 11, 6.4, 7.6, 5.4, 6.6, 0, 0, 0.3, 0.8, [0])];
        a = row < 2 && rel < 0.8 && p(0.3) ? L(T.office, 8.5, 10.5, 8, 9.5, 12, 19, 0, 0, 0.04, 0.04, [6, 0, 2, 5, 3]) : L(T.mid, 5.8, 8.4, 6.2, 8.4, 9, 15, 0, 0, 0.04, 0.04, blocks);
        return [a, less(a, 0.8), L(T.mid, 5.6, 6.4, 5.8, 6.4, 8, 11, 0, 0, 0.04, 0.04, blocks), L(T.shop, 4.4, 5.4, 4.6, 5.2, 4.4, 5.4, 0, 0, 0.04, 0.04, [1, 3, 4, 2, 0], F.cafe, 0.2)];
      }
    }
    return [a, less(a, 0.85), L(sm, 3.8, 4.4, 3.8, 4.6, 4.8, 5.8, a.set, a.set, Math.min(a.gap, 0.6), Math.min(a.gap, 0.6), st === 'farm' ? [0, 0, 3] : sm ? [0, 1, 2, 3] : undefined, F.hip, 0.3)];
  };
  // Pass 0 places what makes the place, before anything else takes its frontage: the city's towers (on
  // the boulevard and round the middle), a resort's hotels (on the promenade), a harbour's fish market
  // (by its pier's root, on the quay), an alpine village's chapel (by its square). Then the rows: the front row, and a garden behind it a
  // second row where the block is deep (the city: a third).
  const sig = (rel: number, quay: boolean, wide: boolean, x: number, z: number): Lot[] => {
    if (metro) {
      // (the tallest tops stay under the cloud layer's puffs, roof clutter and all: the capital, in the
      // clouds' clear zone, keeps the taller skyline)
      const k = 1 - rel * 0.32, top = CLOUD_MIN - 6.5 - s.h;
      return towers < 8 && !quay && (rel < 0.5 || (wide && rel < 0.78)) ? [L(T.tower, 9, 11, 9, 10.6, top * (k - 0.1), Math.min(top, top * (k + 0.06)), 0, 0, 0.6, 2, [6, 2, 5, 0, 6, 1], F.tall, 0.6)] : [];
    }
    if (st === 'resort') {
      // (a resort's white hotels: two on the promenade, else the best frontage left)
      const k = (w: number) => L(T.hotel, w, w + 1.6, 6, 7.2, 14, 19, 0.2, 0.6, 0.8, 1.4, HOTEL);
      return towers < 2 && (quay || rel < 0.7) ? [k(7.6), k(6.2)] : [];
    }
    if (done) return [];
    if (st === 'alpine') return sq && Math.hypot(sq.x - x, sq.z - z) < 18 ? [L(T.chapel, 5.4, 5.8, 8, 8.8, 12, 12, 0.4, 0.4, 0.8, 1.2, [0]), L(T.chapel, 4.6, 5, 6.8, 7.4, 12, 12, 0.4, 0.4, 0.8, 1.2, [0])] : [];
    const mk = (w0: number, d0: number, h: number) => L(T.market, w0, w0 + 1, d0, d0 + 0.5, h, h, 0, 0, 0.6, 0.6, [0, 1, 2]);
    return st === 'harbour' && roots.some((r) => Math.hypot(r.x - x, r.z - z) < (quay ? 24 : 12)) ? [mk(6.4, 4.4, 4.4), mk(5, 3.8, 4.2), mk(3.4, 2.4, 3.6)] : [];
  };
  const A = [0, 0], B = [0, 0];
  const rows = metro ? [0, 0, 8.6, 17] : [0, 0, 6.2];
  let towers = 0, done = false;
  const roots = s.piers.map((pi) => dirToChart(s.chart, region.piers[pi].root, { x: 0, z: 0 }));
  for (let pass = 0; pass < rows.length; pass++) {
    // (row: the row this pass walks, −1 for pass 0)
    const row = pass - 1;
    for (const { q, quay, wide } of streets) {
      for (const side of [1, -1]) {
        for (let sv = 0.3, k = 0; sv < q.len - 2; ) {
          yield* tick();
          pointAt(q, sv, A);
          const rel = Math.hypot(A[0], A[1]) / P;
          let got: Item | null = null;
          // (a quay street's stretch along the water: its land side is the waterfront row)
          const qy = quay && cutDist(s, A[0], A[1]) > -8;
          for (const l of pass ? lots(rel, qy, wide, row) : sig(rel, qy, wide, A[0], A[1])) {
            // the chord over the lot's width is its frontage; the front `set` m behind the sidewalk; the
            // lot as deep as the room behind it allows (probed along three lines back from the front)
            pointAt(q, sv + l.w, B);
            const cl = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, tx = (B[0] - A[0]) / cl, tz = (B[1] - A[1]) / cl, nx = -tz * side, nz = tx * side;
            const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
            for (const extra of [0, 0.8]) {
              const f0 = q.hw + 2 * M + 0.06 + rows[pass] + l.set + extra;
              // the room behind the front (three lines back from it); a block too shallow for two lots
              // back to back is shared with the street behind it, a thin one taken whole
              let room = 16;
              for (const u of [-0.45, 0, 0.45]) {
                const ox = mx + tx * u * l.w + nx * f0, oz = mz + tz * u * l.w + nz * f0;
                let k = 0.25;
                while (k < room + M && !G.at(ox + nx * k, oz + nz * k)) k += 0.3;
                room = Math.min(room, k - M - 0.08);
              }
              // (a tower or an office block takes its block's whole depth; a hotel half of it while that
              // leaves both halves 4.4 m, else the whole: towns/build gives a shallow one a loggia on its
              // front only)
              const big = l.t === T.tower || l.t === T.office, half = (room - 0.6) / 2;
              const dd = Math.min(l.d, l.t === T.hotel ? (half < 4.4 ? room : half) : room > l.d * 2 + 0.6 || big || room <= 8.2 ? room : half);
              if (dd < Math.min(l.d, l.t === T.hotel ? 4.4 : big ? 7.5 : l.t === T.chalet ? 4.4 : 3.3)) continue;
              got = tryAt(l.t, mx + nx * (f0 + dd / 2), mz + nz * (f0 + dd / 2), nx, nz, l.w, dd, l.t > T.tower ? Math.min(l.h, 2.2 * Math.max(l.w, dd) + 1.5) : l.h, l.c, l.v, l.f | F.front, rows[pass] ? 0.6 : 0.04);
              if (got) {
                towers += +(l.t === T.tower || l.t === T.hotel);
                done ||= !pass;
                const fd = l.set + extra;
                if (!rows[pass] && fd >= 1.5 && (got.t === T.house || got.t === T.chalet || got.t === T.villa)) {
                  // a front garden between the house and the sidewalk: a picket fence (or a hedge) along
                  // the sidewalk, a gate at the door
                  const gd = fd - 2 * M - 0.1, ox = got.x - nx * (dd / 2 + fd / 2), oz = got.z - nz * (dd / 2 + fd / 2);
                  if (G.free(ox, oz, got.a, got.w / 2, gd / 2)) place(T.garden, ox, oz, got.a, got.w, gd, 0, 0, 0, F.frontFence | (p(0.3) ? F.hedge : 0), SOFT, 0);
                }
                sv += l.w + l.gap;
                break;
              }
            }
            if (got) break;
          }
          if (!got) sv += 0.6;
        }
      }
    }
    // farm paddocks once the front rows stand (before the cottages behind take the room)
    if (!row && st === 'farm') {
      for (let k = 0, made = 0; k < 220 && made < 2; k++) {
        yield* tick();
        const b = rng.range(0, TAU), r = rng.range(P * 0.25, P - 3), a = rng.range(0, Math.PI), x = Math.cos(b) * r, z = Math.sin(b) * r;
        for (const [w, dd] of [[9, 6.5], [7, 5.4], [5.6, 4.4]]) {
          if (G.free(x, z, a, w / 2 + 0.4, dd / 2 + 0.4)) {
            place(T.paddock, x, z, a, w, dd, 0, 0, 0, 0, SOFT, 0.4);
            made++;
            break;
          }
        }
      }
    }
  }

  yield* tick();
  // ── infill: the room left between the rows takes a cottage (the city: a block, a shop) facing its
  // nearest street (reached by a path), else turned along it; then gardens behind the houses (else beside
  // them; a resort's villas and hotels with a pool); then sheds and summer houses in what is left ──
  const fill = function* (kinds: number[][]) {
    for (let gz = -P; gz <= P; gz += 1.4) {
      yield* tick();
      for (let gx = -P; gx <= P; gx += 1.4) {
        const x = gx + rng.range(-0.4, 0.4), z = gz + rng.range(-0.4, 0.4);
        // (room for the smallest at least: a disc a shed fits round)
        if (!G.free(x, z, 0, 1.5, 0, true)) continue;
        yield* tick();
        let best = Infinity, bx = 0, bz = 0;
        for (const { q } of streets) {
          for (let i = 1; i < q.x.length; i++) {
            const ax = q.x[i - 1], az = q.z[i - 1], dx = q.x[i] - ax, dz = q.z[i] - az;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1))), dd = Math.hypot(x - ax - dx * t, z - az - dz * t) - q.hw;
            if (dd < best) [best, bx, bz] = [dd, ax + dx * t, az + dz * t];
          }
        }
        const l = Math.hypot(x - bx, z - bz) || 1, nx = (x - bx) / l, nz = (z - bz) / l;
        out: for (const [t, w, dd, h] of kinds) {
          const k = rng.range(0.92, 1.08);
          for (const [ux, uz] of t === T.garden ? [[nx, nz]] : [[nx, nz], [-nz, nx], [nz, -nx]]) {
            if (tryAt(t, x, z, ux, uz, w * k, dd * k, h, t === T.house ? rng.pick([0, 1, 3, 4, 5]) : t === T.garden ? 1 : rng.int(0, 4), rng.int(0, 1), t === T.garden ? F.back : F.hip * +rng.chance(0.4), metro ? 0.8 : 0.6)) break out;
          }
        }
      }
    }
  };
  yield* fill(metro ? [[T.mid, 7.4, 7, 11], [T.mid, 6, 6, 9], [T.shop, 4.8, 4.6, 5], [T.shop, 4, 3.8, 4.6]] : sm === T.chalet ? [[sm, 5.6, 5.4, 6.6], [sm, 4.8, 4.6, 6], [sm, 4.4, 4.2, 5.6]] : [[sm, 5, 4.6, 6], [sm, 4.3, 4, 5.4], [sm, 3.8, 3.5, 4.9]]);
  if (!metro) for (const it of solids.slice()) {
    yield* tick();
    if (!(it.t === T.house || it.t === T.townhouse || it.t === T.chalet || it.t === T.hotel || it.t === T.villa) || onSq(it.x, it.z) || !p(st === 'resort' ? 1 : 0.85)) continue;
    const ca = Math.cos(it.a), sa = Math.sin(it.a), f = F.back | (p(st === 'farm' ? 0.2 : 0.45) ? F.hedge : 0);
    let done = false;
    for (const gd of [6, 4.5, 3.2, 2.2]) {
      const off = it.d / 2 + M + 0.05 + gd / 2, gx = it.x - sa * off, gz = it.z + ca * off;
      if ((done = !onSq(gx, gz) && G.free(gx, gz, it.a, it.w / 2, gd / 2))) {
        place(T.garden, gx, gz, it.a, it.w, gd, 0, +(st === 'resort'), 0, f, SOFT, 0);
        break;
      }
    }
    for (const gw of done ? [] : [4, 3.2, 2.4]) {
      const k = (it.w / 2 + M + 0.05 + gw / 2) * (it.s & 1 ? 1 : -1);
      if (!onSq(it.x + ca * k, it.z + sa * k) && G.free(it.x + ca * k, it.z + sa * k, it.a, gw / 2, it.d / 2)) {
        place(T.garden, it.x + ca * k, it.z + sa * k, it.a, gw, it.d, 0, +(st === 'resort'), 0, f, SOFT, 0);
        break;
      }
    }
  }
  // (a resort's spare corners take a pool, fenced: the hotels' and villas' guests swim there)
  if (!metro) yield* fill(st === 'resort' ? [[T.garden, 4.4, 3.6, 0], [T.shed, 3.2, 2.7, 2.7]] : [[T.shed, 3.2, 2.7, 2.7]]);

  // ── the waterfront: crates, pots and nets on the quay (cranes in the city); boats along the wall and
  // the piers; the beach ──
  yield* tick();
  if (wall) yield* quayside(region, s, items, rng, hAt, offRoad);
  for (const pi of s.piers) pierBoats(region, s, pi, items, rng, hAt);
  if (st === 'resort' && s.quay) site.r = Math.max(site.r, (yield* beach(region, s, items, rng, hAt, (x, z) => sandAt(chartToDir(s.chart, x, z, d)))) + 4);

  // ── trees, bushes ──
  const flora = st === 'alpine' ? [T.pine, T.pine, T.tree] : st === 'resort' ? [T.palm, T.palm, T.tree] : [T.tree];
  const step = metro ? 3.2 : 2.5;
  for (let gz = -P; gz <= P; gz += step) {
    yield* tick();
    for (let gx = -P + ((Math.round(gz / step) & 1) * step) / 2; gx <= P; gx += step) {
      const x = gx + rng.range(-0.6, 0.6), z = gz + rng.range(-0.6, 0.6), t = rng.pick(flora);
      const cr = t === T.tree ? rng.range(1.3, 2) : rng.range(1, 1.45);
      if (G.free(x, z, 0, cr * 0.9, 0, true)) {
        G.scan(x, z, 0, cr * 0.8, 0, SOFT, true);
        place(t, x, z, rng.range(0, TAU), cr * 2, cr * 2, t === T.tree ? rng.range(3.6, 5.6) : rng.range(4.5, 6.8), rng.int(0, 3), 0, 0, 0);
      } else if (!onSq(x, z) && G.free(x, z, 0, 0.75, 0, true) && p(0.75)) {
        G.scan(x, z, 0, 0.7, 0, SOFT, true);
        place(T.bush, x, z, rng.range(0, TAU), 1.5, 1.5, rng.range(0.7, 1.1), rng.int(0, 3), 0, 0, 0);
      }
    }
  }
  return site;
}

/** Crates, lobster pots and net racks along a walled quay's apron (cranes on the city's docks); boats moored along the wall. */
function* quayside(region: Region, s: Settlement, items: Item[], rng: Rng, hAt: (x: number, z: number) => number, offRoad: (x: number, z: number, m: number) => boolean): Generator<void, void, void> {
  const w = s.wall!, n = w.line.length / 2, metro = s.style === 'metro', d = v3();
  const roots = s.piers.map((pi) => [dirToChart(s.chart, region.piers[pi].root, { x: 0, z: 0 }), region.piers[pi].width] as const);
  // the wall's length, for the cranes' places along it
  let total = 0;
  for (let i = 0; i + 1 < n; i++) total += Math.hypot(w.line[i * 2 + 2] - w.line[i * 2], w.line[i * 2 + 3] - w.line[i * 2 + 1]);
  const cranes = metro ? [0.16, 0.38, 0.62, 0.84].map((f) => f * total) : [];
  // (quay things face the sea: local −z out over the water)
  const a = Math.atan2(w.nx, -w.nz);
  let acc = 0, sv0 = 0, boatAt = rng.range(2, 6), propAt = rng.range(1, 3);
  for (let i = 0; i + 1 < n; i++) {
    yield* tick();
    const ax = w.line[i * 2], az = w.line[i * 2 + 1], bx = w.line[i * 2 + 2], bz = w.line[i * 2 + 3];
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    for (; acc < L; acc += 0.5) {
      const x = ax + ux * acc, z = az + uz * acc, sv = sv0 + acc;
      const nearRoot = (m: number) => roots.some(([r, pw]) => Math.hypot(r.x - x, r.z - z) < pw / 2 + m);
      if (cranes.length && sv >= cranes[0]) {
        // a crane's four legs on the apron only: from behind the coping to 0.5 m short of the quay
        // street's carriageway (its walk is the apron's), its gauge as wide as that leaves (≥ 1.3 m)
        let o = w.coping + 0.3;
        while (o < 5 && [-2.1, 0, 2.1].every((k) => offRoad(x - w.nx * (o + 0.1) + ux * k, z - w.nz * (o + 0.1) + uz * k, 0.5))) o += 0.1;
        if (o - w.coping - 0.3 > 1.3 && !nearRoot(3.4)) {
          const c = (o + w.coping + 0.3) / 2, cx = x - w.nx * c, cz = z - w.nz * c;
          items.push(item(T.crane, cx, cz, a, 4.2, o - w.coping - 0.3, rng.range(13, 17), rng, 0, padHeight(s, cx, cz) + QUAY_H));
          cranes.shift();
          propAt = sv + 4;
        } else if (sv > cranes[0] + 10) cranes.shift();
      } else if (sv >= propAt && !nearRoot(2.6) && offRoad(x - w.nx * 1.9, z - w.nz * 1.9, 0.7)) {
        // a stack of crates and a buoy, a heap of lobster pots, or a net hung on its rack (on H1's apron,
        // raised QUAY_H over the deck)
        const o = rng.range(1.75, 2.1), k = rng.int(0, 2), cx = x - w.nx * o, cz = z - w.nz * o;
        items.push(item(T.crates, cx, cz, a + rng.range(-0.2, 0.2), 1.6, 1.1, 0, rng, k, padHeight(s, cx, cz) + QUAY_H));
        propAt = sv + rng.range(metro ? 6 : 3.4, metro ? 11 : 6.5);
      }
      if (sv > boatAt) {
        const len = metro ? rng.range(5.5, 8) : rng.chance(0.55) ? rng.range(4, 5) : rng.range(2.6, 3.2);
        const off = (metro ? 2.7 : 2) + rng.range(0, 0.3), cx = x + w.nx * off, cz = z + w.nz * off, bw = len * 0.2 + 0.2;
        // (deep enough under the whole hull: bow, stern and both beams; clear of the pier and the ferry)
        const deep = (k: number, j: number) => hAt(cx + ux * len * k + w.nx * bw * j, cz + uz * len * k + w.nz * bw * j) < -1;
        boatAt = sv + 1.5;
        if (!nearRoot(len / 2 + 2.2) && deep(0.5, 0) && deep(-0.5, 0) && deep(0, 1) && deep(0, -1) && !nearFerry(region, chartToDir(s.chart, cx, cz, d), 6)) {
          items.push(item(T.boat, cx, cz, Math.atan2(uz, ux) + Math.PI / 2 + (rng.chance(0.5) ? Math.PI : 0), len * 0.38, len, 0, rng, +(len < 3.5)));
          boatAt = sv + len + rng.range(1.5, 7);
        }
      }
    }
    acc -= L;
    sv0 += L;
  }
}

/** Boats moored along a pier (both sides, clear of its piles, the ferry's berth and lane). */
function pierBoats(region: Region, s: Settlement, pi: number, items: Item[], rng: Rng, hAt: (x: number, z: number) => number) {
  const p = region.piers[pi];
  const a0 = dirToChart(s.chart, p.root, { x: 0, z: 0 }), b0 = dirToChart(s.chart, p.berth, { x: 0, z: 0 });
  const L = Math.hypot(b0.x - a0.x, b0.z - a0.z) || 1, ux = (b0.x - a0.x) / L, uz = (b0.z - a0.z) / L;
  for (const side of [-1, 1]) {
    const len = rng.range(3.2, 4.4), f = rng.range(0.35, 0.5), off = p.width / 2 + 1.5 + len * 0.19;
    const x = a0.x + ux * L * f - uz * side * off, z = a0.z + uz * L * f + ux * side * off;
    const deep = (k: number, j: number) => hAt(x + ux * len * k - uz * side * j, z + uz * len * k + ux * side * j) < -0.9;
    // (local z, the hull's length, along the pier)
    if (deep(0.5, 0) && deep(-0.5, 0) && deep(0, len * 0.2 + 0.2) && !nearFerry(region, chartToDir(s.chart, x, z, v3()), 3.5)) items.push(item(T.boat, x, z, Math.atan2(uz, ux) - Math.PI / 2 + (rng.chance(0.5) ? Math.PI : 0), len * 0.38, len, 0, rng, +(len < 3.6)));
  }
}

/**
 * A resort's beaches: first the shore right below the promenade, an umbrella over a pair of loungers
 * every ~4.4 m along it on the first dry, gentle sand (or the low grassy bank) out from its edge; then
 * every other patch of sand round the town (out to 34 m past the pad), the most sand round it first: the
 * lifeguard's tower where the beach is widest, a run of huts at the back of the sand, umbrellas on the
 * rest; palms along the promenade's foot. Everything faces down the beach to the water.
 */
function* beach(region: Region, s: Settlement, items: Item[], rng: Rng, hAt: (x: number, z: number) => number, sand: (x: number, z: number) => boolean): Generator<void, number, void> {
  const q = s.quay!, d = v3(), P = s.padR, got: Item[] = [];
  const clear = (x: number, z: number, m: number) => !region.keepOut(chartToDir(s.chart, x, z, d), m, 1 | 4 | 16);
  const free = (x: number, z: number, m: number) => got.every((i) => Math.hypot(i.x - x, i.z - z) > m + Math.max(i.w, i.d) / 2);
  /** A spot's height, its downhill heading (the water's way) and whether it will take a set: dry, gentle, sand or a low bank, clear of roads and piers. */
  const spot = (x: number, z: number, top: number) => {
    const h = hAt(x, z), gx = hAt(x + 1, z) - hAt(x - 1, z), gz = hAt(x, z + 1) - hAt(x, z - 1), g = Math.hypot(gx, gz) || 1;
    return [h, Math.atan2(-gx / g, gz / g), +(h > 0.25 && h < top && g < 1.1 && (h < 1.1 || sand(x, z)) && clear(x, z, 1.8))];
  };
  const put = (t: number, x: number, z: number, a: number, h: number) => {
    const it = item(t, x, z, a, t === T.umbrella ? 2.4 : t === T.bar ? 3 : 2.3, t === T.umbrella ? 2.4 : t === T.bar ? 3 : 2.6, t === T.hut ? 3 : t === T.umbrella ? 2.3 : 5, rng, rng.int(0, 5), h);
    if (t === T.hut) {
      // (on the highest of its corners, a deck down to the lowest)
      const hs = CORNERS.map(([u, k]) => hAt(x + u * 1.2 * Math.cos(a) - k * 1.3 * Math.sin(a), z + u * 1.2 * Math.sin(a) + k * 1.3 * Math.cos(a)));
      [it.y, it.lo] = [Math.max(...hs), Math.min(...hs) - 0.01];
    }
    it.f = +(t === T.umbrella);
    got.push(it);
  };
  // the promenade's shore: out from the line seaward (its normal away from the pad) to the first spot
  const ax = Math.sin(s.heading), az = -Math.cos(s.heading);
  const sea: number[] = [];
  for (let i = 1, n = q.length / 2, acc = 0; i + 1 < n; i++) {
    const x0 = q[i * 2], z0 = q[i * 2 + 1], tx = q[i * 2 + 2] - q[i * 2 - 2], tz = q[i * 2 + 3] - q[i * 2 - 1], tl = Math.hypot(tx, tz) || 1, sg = Math.sign(tz * ax - tx * az) || 1;
    const nx = (sg * tz) / tl, nz = (-sg * tx) / tl;
    sea.push(x0, z0, nx, nz);
    if ((acc += Math.hypot(q[i * 2] - q[i * 2 - 2], q[i * 2 + 1] - q[i * 2 - 1])) < 4.4) continue;
    yield* tick();
    for (let o = 2.2; o < 16; o += 0.5) {
      const x = x0 + nx * o, z = z0 + nz * o, [h, a, ok] = spot(x, z, 1.6);
      if (h < 0.25) break;
      if (ok && free(x, z, 1.2)) {
        put(got.length % 6 === 3 ? T.bar : T.umbrella, x, z, a, h);
        acc = 0;
        break;
      }
    }
  }
  // the beaches round the town
  const cand: number[][] = [];
  for (let z = -P - 34; z <= P + 34; z += 2.2) {
    yield* tick();
    for (let x = -P - 34; x <= P + 34; x += 2.2) {
      const r = Math.hypot(x, z);
      if (r < P - 4 || r > P + 34) continue;
      const [h, a, ok] = spot(x, z, 1.5);
      if (!ok) continue;
      let k = 0;
      for (const [u, v] of CORNERS) k += +sand(x + u * 3, z + v * 3);
      cand.push([x, z, a, h, k + rng.float() * 0.5]);
    }
  }
  cand.sort((a, b) => b[4] - a[4]);
  let lg = 0, huts = 0;
  for (const [x, z, a, h] of cand) {
    if (got.length >= 34 || !free(x, z, 1.4)) continue;
    // the first (the widest beach) the lifeguard, then a hut where the sand rises to the land, umbrellas on the rest
    const t = !lg++ ? T.lifeguard : h > 0.9 && huts < 6 && rng.chance(0.5) ? T.hut : T.umbrella;
    huts += +(t === T.hut);
    put(t, x, z, a, h);
  }
  items.push(...got);
  // palms along the promenade's foot, seaward of its line (a pier's root and the road aside)
  for (let i = 4; i + 3 < sea.length; i += 12) {
    const x = sea[i] + sea[i + 2] * 1.1, z = sea[i + 1] + sea[i + 3] * 1.1, h = hAt(x, z);
    if (h > 0.5 && clear(x, z, 1) && free(x, z, 1.1)) items.push(item(T.palm, x, z, rng.range(0, TAU), 2.4, 2.4, rng.range(4.6, 6.4), rng, rng.int(0, 3), h));
  }
  return got.reduce((m, i) => Math.max(m, Math.hypot(i.x, i.z)), 0);
}

/**
 * A chairlift from the pad's edge up the hill to the highest ground round the village: a valley
 * station on the pad, pylons every ~11 m, the top station at the summit. Returns the supports' plan
 * positions and cable heights.
 */
function* planLift(s: Settlement, G: Grid, place: Kit['place'], hAt: (x: number, z: number) => number, region: Region): Generator<void, number[] | null, void> {
  const d = v3();
  // the highest ground within 60 m of the pad's edge: the line climbs straight toward it
  let best = 0, bm = 0, bh = -Infinity;
  for (let k = 0; k < 48; k++) {
    yield* tick();
    for (let m = s.padR + 6; m < s.padR + 60; m += 4) {
      const h = hAt(Math.sin((k / 48) * TAU) * m, -Math.cos((k / 48) * TAU) * m);
      if (h > bh) {
        bh = h;
        best = (k / 48) * TAU;
        bm = m;
      }
    }
  }
  if (bh < s.h + 4) return null;
  const sx = Math.sin(best) * bm, sz = -Math.cos(best) * bm;
  for (const db of [0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6]) {
    for (let r0 = s.padR - 4; r0 > s.padR * 0.45; r0--) {
      // the valley station near the pad's edge, the line straight from it to the summit (local +z up it)
      const x0 = Math.sin(best + db) * r0, z0 = -Math.cos(best + db) * r0, L = Math.hypot(sx - x0, sz - z0), ux = (sx - x0) / L, uz = (sz - z0) / L;
      const la = Math.atan2(-ux, uz);
      if (!G.free(x0, z0, la, 2.4 + M, 2.2 + M)) continue;
      // supports evenly up to the summit (spans of about 11 m), each clear of roads, pads and plazas
      // (the line may stop short of a summit that is taken)
      const sup = [x0, z0, s.h + 5.25], n = Math.max(2, Math.round(L / 11));
      for (let k = 1; k <= n; k++) {
        const x = x0 + (ux * L * k) / n, z = z0 + (uz * L * k) / n;
        const j = [0, 1.5, -1.5, 3, -3].find((j) => !region.keepOut(chartToDir(s.chart, x - uz * j, z + ux * j, d), 2.2) && hAt(x - uz * j, z + ux * j) > 0.8);
        if (j === undefined) break;
        sup.push(x - uz * j, z + ux * j, hAt(x - uz * j, z + ux * j) + 8.6);
      }
      const m = sup.length / 3;
      if (m < 3) continue;
      // the pylons' cable 8.6 m up, the top station's sheave at 5.2 m; then raised wherever the cable
      // would pass within 6.4 m of the slope between two supports (the chairs ride over the pines)
      sup[m * 3 - 1] -= 3.4;
      for (let pass = 0; pass < 3; pass++) {
        for (let k = 0; k + 1 < m; k++) {
          let need = 0;
          for (let f = 0.1; f < 1; f += 0.1) need = Math.max(need, hAt(sup[k * 3] + (sup[k * 3 + 3] - sup[k * 3]) * f, sup[k * 3 + 1] + (sup[k * 3 + 4] - sup[k * 3 + 1]) * f) + (k && k + 2 < m ? 6.4 : 3) - (sup[k * 3 + 2] + (sup[k * 3 + 5] - sup[k * 3 + 2]) * f));
          if (need > 0) {
            if (k) sup[k * 3 + 2] += need;
            sup[k * 3 + 5] += need;
          }
        }
      }
      place(T.station, x0, z0, la, 4.8, 4.4, 5.2);
      for (let k = 1; k < m; k++) {
        const x = sup[k * 3], z = sup[k * 3 + 1], top = k === m - 1;
        let g = hAt(x, z), lo = g - 0.3;
        if (top) {
          // the top station stands on its own terrace over the lowest ground under it
          const g1 = hAt(x + ux * 2.2, z + uz * 2.2), g2 = hAt(x - ux * 2.2, z - uz * 2.2);
          lo = Math.min(g, g1, g2) - 0.3;
          g = Math.max(g, g1, g2);
          sup[k * 3 + 2] = g + 5.2;
        }
        // (the top station turned to face back down the line: its bullwheel toward the valley)
        Object.assign(place(top ? T.station : T.pylon, x, z, top ? la + Math.PI : la, top ? 4.8 : 0.6, top ? 4.4 : 0.6, sup[k * 3 + 2] - g, 0, 0, 0, 0), { y: g, lo });
      }
      return sup;
    }
  }
  return null;
}

type Kit = ReturnType<typeof siteKit> extends Generator<void, infer K, void> ? K : never;

// ── Airports ──

/** The terminal, control tower, hangar and windsock round an airport's apron (its own site, chart on the apron). */
function* planAirport(region: Region, ap: Airport, heightAt: (d: Vec3) => number, poles: Vec3[]): Generator<void, Site, void> {
  const ll = latLonFromDir(ap.apron), chart = createChart(ll.lat, ll.lon, R + ap.h), d = v3();
  const groundAt = (x: number, z: number) => heightAt(chartToDir(chart, x, z, d));
  const rng = new Rng(hashSeed(region.seed, `airport:${ap.code}`));
  const { G, items, tryAt, place } = yield* siteKit(region, chart, ap.apron, 40, groundAt, rng, poles);
  // on dry ground, no more than a storey above the apron (sampled every 0.9 m)
  for (let j = 0; j < G.n; j += 3) {
    yield* tick();
    for (let i = 0; i < G.n; i += 3) {
      const h = groundAt((i + 1.5) * CELL - G.half, (j + 1.5) * CELL - G.half);
      // (the sample's 3 × 3 cells and a cell round them)
      if (h < 0.12 || h > ap.h + 2.2) G.scan((i + 1.5) * CELL - G.half, (j + 1.5) * CELL - G.half, 0, 0.75, 0.75, OUT);
    }
  }
  yield* tick();
  // the apron and the runway's strip (the kit marked the access road)
  G.scan(0, 0, 0, ap.apronR + 0.8, 0, PAVED, true);
  const e0 = dirToChart(chart, ap.ends[0], { x: 0, z: 0 }), e1 = dirToChart(chart, ap.ends[1], { x: 0, z: 0 });
  G.seg(e0.x, e0.z, e1.x, e1.z, ap.width / 2 + 3.2, PAVED);
  // round the apron, starting from the side away from the runway (farther out where the near ground is taken)
  const rx = e1.x - e0.x, rz = e1.z - e0.z, rl = Math.hypot(rx, rz) || 1, t = -(e0.x * rx + e0.z * rz) / (rl * rl);
  const base = Math.atan2(-(e0.z + rz * t), -(e0.x + rx * t));
  // (each size front to the apron first; then end on to it, where the dry ground is a narrow spit)
  const ring = function* (tt: number, from: number, h: number, ...sizes: number[]) {
    for (let s = 0; s < sizes.length; s += 2) {
      for (const turn of [0, 1]) {
        for (const gap of [1, 3, 6, 9, 12]) {
          yield* tick();
          for (let k = 0; k < 44; k++) {
            const w = sizes[s + turn], dd = sizes[s + 1 - turn], b = base + from + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.143, off = ap.apronR + gap + dd / 2;
            if (tryAt(tt, Math.cos(b) * off, Math.sin(b) * off, Math.cos(b), Math.sin(b), w, dd, h, 6, 1, F.front, 1)) return;
          }
        }
      }
    }
  };
  // the airside is H1's slab between the runway and the disc, a stand 8 m either way along it from the
  // apron's foot (roads/ground airport): the terminal stands end-on to it beyond one stand, facing it (and
  // the disc), the control tower at its far end, the hangar beyond the other stand, its doors to it; on a
  // spit too narrow for that, round the apron as before (each size front on, then end on)
  const fx = e0.x + rx * t, fz = e0.z + rz * t, ol = Math.hypot(fx, fz) || 1, vx = -fx / ol, vz = -fz / ol, ux = rx / rl, uz = rz / rl;
  // (k: which way along the runway; front 0 toward the stand, 1 toward the runway)
  const beside = (tt: number, k: number, h: number, back: number, front: number, sizes: number[]) => {
    for (let i = 0; i < sizes.length; i += 2) {
      const w = sizes[i], dd = sizes[i + 1], a = k * (10.4 + back + (front ? w : dd) / 2), o = ap.width / 2 + 3.5 + (front ? dd : w) / 2;
      if (tryAt(tt, fx + ux * a + vx * o, fz + uz * a + vz * o, front ? vx : k * ux, front ? vz : k * uz, w, dd, h, 6, 1, F.front, 1)) return true;
    }
    return false;
  };
  const side = [1, -1].find((k) => beside(T.office, k, 6, 0, 0, [12, 6, 10, 5.6, 8, 5])) ?? 0;
  if (!side) yield* ring(T.office, 0, 6, 12, 6, 10, 5.6, 8, 5, 6.6, 4.4);
  if (!side || !beside(T.ctower, side, 12.5, 7.4, 0, [3.2, 3.2])) yield* ring(T.ctower, 0.75, 12.5, 3.2, 3.2);
  // (the hangar: beyond the other stand facing it, else facing the runway there, else down the runway past the tower)
  const hangar = [[-side, 0, 0], [-side, 0, 1], [-side, 4, 1], [side, 11.6, 1]].some(([k, back, f]) => beside(T.hangar, k, 6.2, back, f, [10, 8, 8, 7, 7, 6]));
  if (!side || !hangar) yield* ring(T.hangar, -1.1, 6.2, 10, 8, 8, 7, 7, 6, 6, 5.2, 5, 4.4);
  // the ground crew's kit on the apron's rim toward the runway (a fuel truck, a tug and its baggage carts, cones)
  for (let k = 0; k < 9; k++) {
    const b = base + Math.PI + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.3, x = Math.cos(b) * (ap.apronR - 3.4), z = Math.sin(b) * (ap.apronR - 3.4);
    if (CORNERS.every(([u, v]) => groundAt(x + u * 3, z + v * 3) > 0.15) && G.free(x, z, 0, 3.2, 0, true, PAVED)) {
      place(T.apron, x, z, b + Math.PI / 2, 5, 6.6, 0, 0, 0, 0, 0);
      break;
    }
  }
  // the windsock beside the runway, off its strip, 12–30 m from the apron toward the landing end
  const ls = ap.landEnd ? 1 : -1;
  for (let k = 0; k < 16; k++) {
    const f = t + (ls * (12 + (k >> 1) * 2.5)) / rl, o = (k & 1 ? -1 : 1) * (ap.width / 2 + 6);
    const x = e0.x + rx * f - (rz / rl) * o, z = e0.z + rz * f + (rx / rl) * o;
    if (G.free(x, z, 0, 0.6, 0.6)) {
      place(T.sock, x, z, Math.atan2(rz, rx), 0.6, 0.6, 4.5);
      break;
    }
  }
  // (a building's floor at the apron's level or its own ground's, whichever is higher; a plinth under the rest)
  for (const i of items) i.y = Math.max(ap.h, i.y);
  const site = { id: `airport-${ap.code}`, style: 'airport', chart, dir: ap.apron, r: 46, items, lift: null };
  return site;
}
