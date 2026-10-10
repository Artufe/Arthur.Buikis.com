// LITTLEBIG v2 townsfolk (T2): the walk network of one town and the places on it. Pure and
// deterministic (no three.js), built once per town in its own chart (Settlement.chart, plan metres).
//
// Paths: a sidewalk down each side of every town street at the walks' height (H1's rule: the asphalt
// on the rendered ground, the slab CURB_H over it), the corner walks round each junction and the walk
// round each turning circle (H1's outlines, roads/ground outlineOf), the street crossings transit/
// places (TownCrossing), the square as rings round its centrepiece and spokes out to the walks round
// it, the quay's promenade and its piers. Each path carries per sample the lateral band a body's
// centre may use, found by scanning across it against the carriageways and their kerbs (KERB m), T1's
// buildings and props, the lamp poles, the people who stay put (CLR m), the water and the sea wall; the
// band eases (SLOPE) and where nothing is left the path is cut. Paths are split where they meet into
// graph edges. Places: the doors a walker may go in by, the seats (benches, café chairs, bar stools)
// and spots (a stall's front, the fountain's rim), each reached by a stub from the network, and the
// anchored ones (stall keepers, net-menders, farmhands, sunbathers: always someone there). Distance
// fields to every destination (Dijkstra) route the walkers. Spec: sim.spec.ts.

import type { TownCrossing } from '../core/contracts';
import { ASPH, armsOf, outlineOf, PAVE, QUAY_H } from '../roads/ground';
import { CENTRE, doorOff, T, toPoly, type Item, type Site } from '../towns/plan';
import { CURB_H, R } from '../world/config';
import { hermitePoints } from '../world/city/path';
import { chartAt } from '../world/region/network';
import { padDist } from '../world/region/pad';
import type { Region, Settlement } from '../world/region/types';
import { hash3 } from '../world/rng';
import { chartToDir, dirToChart, v3, type Chart, type Vec3 } from '../world/sphere';

/** A body's radius among people (m), and its clearance from a prop, a pole or a wall (m). */
export const BODY = 0.22;
const CLR = 0.2;
/** How near (m) a body's centre may come to a carriageway's edge (the kerb stone is 0.18 m wide). */
const KERB = 0.33;
/** How fast (m per m) a band may narrow or widen along its path; the sample spacing (m). */
const SLOPE = 0.7;
const STEP = 0.4;
/** Edge kinds. */
export const E = { walk: 0, corner: 1, cross: 2, square: 3, quay: 4, pier: 5, stub: 6 } as const;
/** Place kinds. */
export const PK = { door: 0, seat: 1, stand: 2 } as const;
/** Look rows (pose) a place puts its occupant in: idle, sit, chat, café, lean (anchored only: their chat row leans), lie (a lounger). */
export const POSE = { idle: 0, sit: 1, chat: 2, cafe: 3, lean: 4, lie: 5 } as const;

export interface Place {
  k: number;
  /** Graph node it is reached at (−1: none: anchored). */
  node: number;
  /** Where the body is: feet (a seat: the seat point), height (a seat's top), facing (unit plan; lying: feet → head). */
  x: number;
  z: number;
  h: number;
  fx: number;
  fz: number;
  pose: number;
  /** Someone is always there (a keeper, a sunbather), never a walker. */
  anch: boolean;
  /** Doors: a home (else a shop or an office). */
  home: boolean;
}

export interface Net {
  s: Settlement;
  /** Samples of every edge in order: plan x, z, height, arc length from its edge's start, the band (right of a → b). */
  x: Float64Array;
  z: Float64Array;
  h: Float32Array;
  sa: Float32Array;
  lo: Float32Array;
  hi: Float32Array;
  /** Edges: first sample, count, end nodes, length, kind, crossing id (−1), region edge (−1), a crossing's kerb (m in from either end). */
  ef: Int32Array;
  en: Int32Array;
  ea: Int32Array;
  eb: Int32Array;
  len: Float32Array;
  kind: Uint8Array;
  cross: Int16Array;
  road: Int16Array;
  kerb: Float32Array;
  /** Nodes: plan position, incident edges (adj[adj0[i] … adj0[i + 1]]), land (component), and its walkable length (m). */
  nx: Float64Array;
  nz: Float64Array;
  adj0: Int32Array;
  adj: Int32Array;
  comp: Int32Array;
  compLen: Float32Array;
  places: Place[];
  /** Destinations (node ids), the place behind each (−1: a waypoint) and their distance fields dist[k · nodes + node]. */
  dest: Int32Array;
  destPlace: Int32Array;
  dist: Float32Array;
  /** Warm lights at night (x, z, r² triples): the lamps' pools and the porch lights. */
  lights: Float64Array;
}

/** An obstacle: a disc (r > 0) or a rect (half sizes u, v; axis cos c, sin s); its plan item (−1: none). */
interface Ob {
  x: number;
  z: number;
  c: number;
  s: number;
  u: number;
  v: number;
  r: number;
  it: number;
  garden: boolean;
}
interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  hw: number;
  ha: number;
  hb: number;
  /** The sidewalk's width (0: none). */
  sw: number;
}
interface Path {
  x: number[];
  z: number[];
  h: number[];
  lo: number[];
  hi: number[];
  k: number;
  c: number;
  r: number;
  /** A crossing's kerb: m in from either end. */
  o: number;
}
type Bad = (x: number, z: number) => boolean;

/** A coarse bucket grid over a town (cell 2 m): what is near a point. */
class Buckets<T> {
  readonly n: number;
  readonly half: number;
  readonly b: T[][];
  constructor(r: number) {
    this.n = Math.ceil(r);
    this.half = this.n;
    this.b = Array.from({ length: this.n * this.n }, () => []);
  }
  add(t: T, x: number, z: number, m: number, x1 = x, z1 = z): void {
    const { n, half } = this;
    for (let j = Math.max(0, Math.floor((Math.min(z, z1) - m + half) / 2)); j <= Math.min(n - 1, Math.floor((Math.max(z, z1) + m + half) / 2)); j++)
      for (let i = Math.max(0, Math.floor((Math.min(x, x1) - m + half) / 2)); i <= Math.min(n - 1, Math.floor((Math.max(x, x1) + m + half) / 2)); i++) this.b[j * n + i].push(t);
  }
  at(x: number, z: number): T[] {
    const i = Math.floor((x + this.half) / 2), j = Math.floor((z + this.half) / 2);
    return i < 0 || j < 0 || i >= this.n || j >= this.n ? NONE : this.b[j * this.n + i];
  }
}
const NONE: never[] = [];

const tq = [0];
let t0 = 0;
/** A point to hand the frame back: after ~1.5 ms of work since the last (the caller decides whether the slice is spent). */
function* tick(): Generator<void, void, void> {
  if (performance.now() - t0 < 1.5) return;
  yield;
  t0 = performance.now();
}
export function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number, o = tq): number {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  o[0] = t;
  return Math.hypot(ax + dx * t - x, az + dz * t - z);
}
function sdf(o: Ob, x: number, z: number): number {
  const dx = x - o.x, dz = z - o.z;
  if (o.r > 0) return Math.hypot(dx, dz) - o.r;
  const qx = Math.abs(dx * o.c + dz * o.s) - o.u, qz = Math.abs(dz * o.c - dx * o.s) - o.v;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}
function inPoly(x: number, z: number, o: number[]): boolean {
  let inside = false;
  for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) if (o[i + 1] > z !== o[j + 1] > z && x < ((o[j] - o[i]) * (z - o[i + 1])) / (o[j + 1] - o[i + 1]) + o[i]) inside = !inside;
  return inside;
}

/** The obstacle a plan item makes (trees: their trunks, the crowns are overhead), or null. */
export function itemShape(it: Item, i: number): Ob | null {
  const t = it.t, c = Math.cos(it.a), s = Math.sin(it.a);
  const ob = (r: number, u = 0, v = 0, oz = 0): Ob => ({ x: it.x - oz * s, z: it.z + oz * c, c, s, u, v, r, it: i, garden: t === T.garden || t === T.paddock });
  if (t === T.boat) return null;
  if (t === T.tree || t === T.palm) return ob(0.32);
  if (t === T.pine) return ob(0.55);
  if (t === T.bush || t === T.bales || t === T.cafe || t === T.bar || t === T.pylon || t === T.flag || t === T.sock) return ob(t === T.cafe ? 0.95 : t === T.bar ? 1.45 : t === T.pylon ? 0.4 : t === T.flag || t === T.sock ? 0.2 : (it.w / 2) * 0.85);
  // (an umbrella over loungers: their frames, 0.9 m either side, from 0.9 in front of it to 0.6 behind)
  if (t === T.umbrella) return it.f ? ob(0, 0.9, 0.78, -0.15) : ob(0.12);
  if (t === T.centre) return it.c === CENTRE.jets ? ob(0, it.w / 2, it.w / 2) : ob(it.w / 2);
  // (the pool's loungers stand 1.45 m off its long sides, its umbrellas 0.4 m off its ends)
  return t === T.pool ? ob(0, it.w / 2 + 0.6, it.d / 2 + 1.5) : ob(0, it.w / 2, it.d / 2 + (t === T.stall ? 0.1 : 0));
}

/**
 * The walk network of town s: its plan site (towns/plan.ts), heights from `ground` (the rendered ground:
 * roads/ground groundOf), crossings from transit/ (only s's are used), the region's lamp poles and their
 * lights (towns: pools under the lamps).
 */
export function buildNet(region: Region, s: Settlement, site: Site, ground: (q: Vec3) => number, crossings: readonly TownCrossing[], lamps: readonly { q: Vec3; light: Vec3 }[]): Net {
  const g = netSteps(region, s, site, ground, crossings, lamps);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/** buildNet as a stepped job: each `yield` is a point where the caller may hand the frame back. */
export function* netSteps(region: Region, s: Settlement, site: Site, ground: (q: Vec3) => number, crossings: readonly TownCrossing[], lamps: readonly { q: Vec3; light: Vec3 }[]): Generator<void, Net, void> {
  t0 = performance.now();
  const C = s.chart, P = s.padR, q = v3(), si = s.index, items = site.items, seed = region.seed;
  const gAt = (x: number, z: number) => ground(chartToDir(C, x, z, q));
  const reach = Math.max(site.r, P) + 30;
  const cosR = Math.cos((reach + 10) / R);
  const near = (d: Vec3) => d.x * s.dir.x + d.y * s.dir.y + d.z * s.dir.z > cosR;
  const toC = (d: Vec3) => dirToChart(C, d, { x: 0, z: 0 });
  const hsh = (a: number, b: number) => hash3(a, b, seed ^ si);

  // ── what blocks a body ──
  const segs = new Buckets<Seg>(reach), cars = new Buckets<Seg>(reach), obs = new Buckets<Ob>(reach), outl = new Buckets<number[]>(reach);
  for (const e of region.edges) {
    let hit = false;
    for (let i = 0; i < e.centre.h.length && !hit; i += 4) hit = near(v3(e.centre.dir[i * 3], e.centre.dir[i * 3 + 1], e.centre.dir[i * 3 + 2]));
    if (!hit) continue;
    // (a country road's verge is no place to walk either)
    const p = toPoly(C, e.centre, 0, e.id), hw = e.width / 2 + (e.sidewalk > 0 || e.kind === 'ring' ? 0 : 0.6);
    for (let i = 1; i < p.x.length; i++) {
      const g: Seg = { ax: p.x[i - 1], az: p.z[i - 1], bx: p.x[i], bz: p.z[i], hw, ha: e.centre.h[i - 1], hb: e.centre.h[i], sw: e.sidewalk };
      segs.add(g, g.ax, g.az, hw + e.sidewalk + 0.3, g.bx, g.bz);
      cars.add(g, g.ax, g.az, hw + KERB + 0.05, g.bx, g.bz);
    }
    yield* tick();
  }
  for (const n of region.nodes) {
    if (!near(n.dir) || !n.edges.length) continue;
    const nc = chartAt(n.dir, R + n.h), o = outlineOf(n, armsOf(region, nc, n));
    for (let i = 0; i < o.length; i += 2) {
      const p = toC(chartToDir(nc, o[i], o[i + 1], q));
      [o[i], o[i + 1]] = [p.x, p.z];
    }
    // (its kerb line's segments, and the outline itself for the inside test)
    for (let i = 0; i < o.length; i += 2) cars.add({ ax: o[i], az: o[i + 1], bx: o[(i + 2) % o.length], bz: o[(i + 3) % o.length], hw: 0, ha: n.h, hb: n.h, sw: -1 }, o[i], o[i + 1], KERB + 0.05, o[(i + 2) % o.length], o[(i + 3) % o.length]);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) [x0, x1, z0, z1] = [Math.min(x0, o[i]), Math.max(x1, o[i]), Math.min(z0, o[i + 1]), Math.max(z1, o[i + 1])];
    outl.add(o, x0, z0, 0.1, x1, z1);
  }
  const addOb = (o: Ob) => obs.add(o, o.x, o.z, (o.r || Math.hypot(o.u, o.v)) + 0.6);
  const disc = (x: number, z: number, r: number, it = -1) => addOb({ x, z, c: 1, s: 0, u: 0, v: 0, r, it, garden: false });
  items.forEach((it, i) => {
    const o = itemShape(it, i);
    if (o) addOb(o);
  });
  const lights: number[] = [];
  for (const l of lamps) {
    if (!near(l.q)) continue;
    const p = toC(l.q), g = toC(l.light);
    disc(p.x, p.z, 0.13);
    lights.push(g.x, g.z, 4.6 * 4.6);
  }
  for (const pi of s.piers) {
    // (the pier's bollards near both ends of its deck)
    const p = region.piers[pi], a = toC(p.root), b = toC(p.berth), L = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    for (const t of [0.6, 1.8, L - 1.2, L - 3.3]) for (const sd of [1, -1]) disc(a.x + ux * t - uz * sd * (p.width / 2 - 0.35), a.z + uz * t + ux * sd * (p.width / 2 - 0.35), 0.16);
  }
  const wall = s.wall;
  const CAR = 1, OBS = 2, WET = 4;
  /** True if a body centred at (x, z) is blocked by what f asks (bar item `skip`; gardens too unless `nog`). */
  const blocked = (x: number, z: number, f: number, skip = -2, nog = false): boolean => {
    if (f & CAR) {
      for (const g of cars.at(x, z)) if (segDist(x, z, g.ax, g.az, g.bx, g.bz) < g.hw + KERB) return true;
      for (const o of outl.at(x, z)) if (inPoly(x, z, o)) return true;
    }
    if (f & OBS) for (const o of obs.at(x, z)) if (o.it !== skip && !(nog && o.garden) && sdf(o, x, z) < CLR) return true;
    if (f & WET) {
      if (gAt(x, z) < 0.3) return true;
      // (off the coping and away from the wall's edge: the face is its line)
      if (wall && padDist(s, x, z) > -wall.coping - 0.35) return true;
    }
    return false;
  };
  /** The nearest street's asphalt top under (x, z) (NaN off the streets), and the walks' height there. */
  const road = (x: number, z: number): number => {
    let best = Infinity, h = NaN;
    for (const g of segs.at(x, z)) {
      const d = segDist(x, z, g.ax, g.az, g.bx, g.bz);
      if (d < best) [best, h] = [d, g.ha + (g.hb - g.ha) * tq[0]];
    }
    return h;
  };
  const walkH = (x: number, z: number) => {
    const r = road(x, z), g = gAt(x, z) + ASPH;
    return (r === r ? Math.max(g, r - 0.02) : g) + CURB_H;
  };
  /** How far (m) from (x, z) a sidewalk's middle line is, if (x, z) lies in its band (else −1). */
  const onWalk = (x: number, z: number): number => {
    for (const g of segs.at(x, z)) {
      if (g.sw <= 0) continue;
      const d = segDist(x, z, g.ax, g.az, g.bx, g.bz) - g.hw;
      if (d > KERB && d < g.sw && tq[0] > 0 && tq[0] < 1) return Math.abs(d - g.sw / 2);
    }
    return -1;
  };

  // ── the people who stay put, and the seats and spots (their bodies are obstacles first) ──
  const places: Place[] = [];
  const spot = (it: Item, i: number, lx: number, lz: number, h: number, fa: number, pose: number, k: number, anch: boolean, ax = NaN, az = NaN) => {
    const c = Math.cos(it.a), sn = Math.sin(it.a), x = it.x + lx * c - lz * sn, z = it.z + lx * sn + lz * c;
    const fx = Math.cos(it.a + fa), fz = Math.sin(it.a + fa);
    // (anchored and standing ones are bodies (a little more, so a band keeps a walker SEP off them); a
    // seat keeps its sitter's knees clear: a disc in front of it)
    if (anch && pose !== POSE.lie) disc(x, z, BODY + 0.06, i);
    else if (pose === POSE.sit || pose === POSE.cafe) disc(x + fx * 0.42, z + fz * 0.42, 0.22, i);
    places.push({ k, node: -1, x, z, h, fx, fz, pose, anch, home: false });
    if (ax === ax) (approach as number[]).push(places.length - 1, it.x + ax * c - az * sn, it.z + ax * sn + az * c, i);
  };
  const approach: number[] = [];
  const LOC = Math.PI / 2;
  items.forEach((it, i) => {
    const t = it.t, y = it.y, hd = it.d / 2, roll = (k: number) => hsh(i, k);
    if (t === T.bench)
      for (const sx of [-0.42, 0.42]) spot(it, i, sx, -0.02, y + 0.5, -LOC, POSE.sit, PK.seat, false, sx, -0.78);
    else if (t === T.cafe) for (const sx of [-1, 1]) spot(it, i, sx * 0.54, 0, y + 0.5, sx > 0 ? Math.PI : 0, POSE.cafe, PK.seat, false, sx * 1.3, 0);
    else if (t === T.bar) for (let k = 0; k < 6; k += roll(k) < 0.4 ? 2 : 1) {
      const a = k * 1.047, r = (it.w / 2 - 0.2) * 0.6 + 0.42;
      spot(it, i, Math.cos(a) * r, Math.sin(a) * r, y + 0.72, a + Math.PI, POSE.sit, PK.seat, false, Math.cos(a) * (r + 0.75), Math.sin(a) * (r + 0.75));
    } else if (t === T.stall || t === T.market) {
      const hall = t === T.market && hd - 0.3 > 1.5;
      spot(it, i, 0, t === T.stall ? hd + 0.18 : hall ? 0 : -hd + 1.25, y, -LOC, POSE.chat, PK.stand, true);
      spot(it, i, roll(1) < 0.5 ? -0.5 : 0.5, -hd - 0.6, y, LOC, POSE.idle, PK.stand, false, roll(1) < 0.5 ? -0.5 : 0.5, -hd - 0.6);
    } else if (t === T.centre) {
      const r = it.w / 2, a0 = roll(2) * 6.28;
      if (it.c === CENTRE.jets || it.c === CENTRE.pond) spot(it, i, 0, -(r + 0.3), y, LOC, POSE.lean, PK.stand, true);
      // (the watchers round its rim face in; a pair chats beside it)
      for (let k = 1; k <= 2; k++) {
        const a = it.c === CENTRE.jets ? (k * Math.PI) / 2 : a0 + k * 2.1, rr = (it.c === CENTRE.jets ? r : r + 0.15) + 0.45;
        spot(it, i, Math.cos(a) * rr, Math.sin(a) * rr, y, a + Math.PI, POSE.idle, PK.stand, false, Math.cos(a) * rr, Math.sin(a) * rr);
      }
      if (it.c !== CENTRE.pond && it.c !== CENTRE.trough) {
        const a = it.c === CENTRE.jets ? Math.PI : a0 + 4.2, rr = r + (it.c === CENTRE.jets ? 0.55 : 0.6);
        for (const sd of [1, -1]) spot(it, i, Math.cos(a) * rr - Math.sin(a) * sd * 0.36, Math.sin(a) * rr + Math.cos(a) * sd * 0.36, y, a - (sd * Math.PI) / 2 + 0.3 * sd, POSE.chat, PK.stand, true);
      }
    } else if (t === T.crates && it.c) spot(it, i, 0, 0.62, y, -LOC, it.c === 2 ? POSE.chat : POSE.idle, PK.stand, true);
    else if (t === T.umbrella && it.f) {
      for (const sx of [-0.55, 0.55]) if (roll(sx > 0 ? 3 : 4) < 0.62) spot(it, i, sx, -0.85, y + 0.36 + 0.14, LOC, POSE.lie, PK.stand, true);
    } else if (t === T.pool) {
      const hw = it.w / 2 - 0.9, ph = it.d / 2 - 0.9;
      for (let x = -hw + 0.6, k = 0; x < hw - 0.3; x += 1.35, k++)
        for (const sd of [-1, 1]) if (roll(k * 2 + (sd > 0 ? 1 : 0) + 10) < 0.5) spot(it, i, sd > 0 ? -x * sd : x * sd, sd * (ph + 1.45) + (sd > 0 ? 0.85 : -0.85), y + 0.5, sd > 0 ? -LOC : LOC, POSE.lie, PK.stand, true);
    } else if (t === T.lifeguard) spot(it, i, 0, -0.95, y + 2.35, -LOC, POSE.idle, PK.stand, true);
    else if (t === T.barn && roll(5) < 0.7) spot(it, i, 0.95, -hd - 0.75, y, -LOC + 0.4, POSE.idle, PK.stand, true);
    else if (t === T.tractor || t === T.woodpile || t === T.cradle) spot(it, i, t === T.woodpile ? 0 : 1.15, t === T.woodpile ? -0.75 : 0, y, t === T.woodpile ? LOC : Math.PI, POSE.idle, PK.stand, true);
    else if (t === T.chapel) for (const sd of [1, -1]) spot(it, i, sd * 0.4, -hd - 1.1, y, sd > 0 ? Math.PI + 0.5 : -0.5, POSE.chat, PK.stand, true);
    else if (t === T.station && it.y < s.h + 3) for (let k = 0; k < 3; k++) spot(it, i, (k - 1) * 0.15, -hd - 0.7 - k * 0.72, y, LOC, k ? POSE.idle : POSE.chat, PK.stand, true);
  });

  // ── paths ──
  const paths: Path[] = [];
  const joins: number[] = [];
  /** Lay a path along plan points (resampled every STEP m) with the band [l0, l1] (right of travel) where `bad` is false; heights hOf. Cut where nothing is left. */
  const lay = function* (pts: number[], l0: number, l1: number, bad: Bad, hOf: (x: number, z: number) => number, k: number, c = -1, r = -1, ko = 0): Generator<void, void, void> {
    const xs: number[] = [], zs: number[] = [];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]), m = Math.max(1, Math.ceil(L / STEP));
      for (let j = 0; j < m; j++) xs.push(pts[i] + ((pts[i + 2] - pts[i]) * j) / m), zs.push(pts[i + 1] + ((pts[i + 3] - pts[i + 1]) * j) / m);
    }
    xs.push(pts[pts.length - 2]);
    zs.push(pts[pts.length - 1]);
    const n = xs.length, lo: number[] = [], hi: number[] = [];
    let pc = (l0 + l1) / 2;
    for (let i = 0; i < n; i++) {
      if (!(i & 7)) yield* tick();
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), tx = xs[b] - xs[a], tz = zs[b] - zs[a], tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
      // the free runs across it: the one nearest the last one's middle (the widest at the start)
      let best = -Infinity, bl = 1, bh = -1, run = NaN;
      for (let k = 0, m = Math.round((l1 - l0) / 0.05); k <= m + 1; k++) {
        const l = l0 + ((l1 - l0) * k) / m, free = k <= m && !bad(xs[i] + nx * l, zs[i] + nz * l);
        if (free && run !== run) run = l;
        if (!free && run === run) {
          const e = l0 + ((l1 - l0) * (k - 1)) / m, sc = i ? Math.min(e - run, 0.5) - Math.abs((run + e) / 2 - pc) : e - run;
          if (sc > best) [best, bl, bh] = [sc, run, e];
          run = NaN;
        }
      }
      lo.push(bl);
      hi.push(bh);
      if (bh >= bl) pc = (bl + bh) / 2;
    }
    // (the band eases: never wider than the scan, never changing faster than SLOPE)
    for (let pass = 0; pass < 2; pass++)
      for (let i = pass ? n - 2 : 1; pass ? i >= 0 : i < n; i += pass ? -1 : 1) {
        const j = pass ? i + 1 : i - 1, ds = Math.hypot(xs[i] - xs[j], zs[i] - zs[j]) * SLOPE;
        if (lo[j] <= hi[j]) [lo[i], hi[i]] = [Math.max(lo[i], lo[j] - ds), Math.min(hi[i], hi[j] + ds)];
      }
    let p: Path | null = null;
    for (let i = 0; i <= n; i++) {
      if (i === n || hi[i] - lo[i] < 0.02) {
        if (p && p.x.length > 1) paths.push(p);
        p = null;
        continue;
      }
      p ??= { x: [], z: [], h: [], lo: [], hi: [], k, c, r, o: ko };
      p.x.push(xs[i]);
      p.z.push(zs[i]);
      p.h.push(hOf(xs[i], zs[i]));
      p.lo.push(lo[i]);
      p.hi.push(hi[i]);
    }
  };
  const street: Bad = (x, z) => blocked(x, z, CAR | OBS | WET);

  // sidewalks: both sides of every street of the town
  const streets = region.edges.filter((e) => e.settlement === si && e.sidewalk > 0);
  for (const e of streets) {
    const p = toPoly(C, e.centre, 0, e.id), half = e.width / 2, sw = e.sidewalk, off = half + sw / 2;
    for (const side of [1, -1]) {
      const pts: number[] = [];
      for (let i = 0; i < p.x.length; i++) {
        const a = Math.max(0, i - 1), b = Math.min(p.x.length - 1, i + 1), tx = p.x[b] - p.x[a], tz = p.z[b] - p.z[a], tl = Math.hypot(tx, tz) || 1;
        pts.push(p.x[i] - (tz / tl) * off * side, p.z[i] + (tx / tl) * off * side);
      }
      yield* lay(pts, -(sw / 2 - 0.1), sw / 2 - 0.1, street, walkH, E.walk, -1, e.id);
    }
  }
  // the corners round junctions and bends (both arms walked), and the walk round each turning circle
  const ce = v3();
  for (const id of s.nodes) {
    const n = region.nodes[id], nc = chartAt(n.dir, R + n.h), A = armsOf(region, nc, n);
    const town = (pts: number[]) => {
      for (let i = 0; i < pts.length; i += 2) {
        const p = toC(chartToDir(nc, pts[i], pts[i + 1], ce));
        [pts[i], pts[i + 1]] = [p.x, p.z];
      }
      return pts;
    };
    if (A.length === 1) {
      const a = A[0], sw = a.e.sidewalk;
      if (!sw) continue;
      const rho = (n.turnR || Math.max(5.4, a.half + 2.6)) + sw / 2, o = a.half + sw / 2;
      const ax = a.px - a.uz * o, az = a.pz + a.ux * o, bx = a.px + a.uz * o, bz = a.pz - a.ux * o;
      const t0 = Math.atan2(az, ax), away = Math.atan2(a.uz, a.ux) + Math.PI;
      let d = Math.atan2(bz, bx) - t0;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      if (Math.cos(t0 + d / 2 - away) < 0) d += d > 0 ? -2 * Math.PI : 2 * Math.PI;
      const pts = [ax, az];
      for (let k = 1, m = Math.ceil((Math.abs(d) * rho) / 0.5); k < m; k++) pts.push(Math.cos(t0 + (d * k) / m) * rho, Math.sin(t0 + (d * k) / m) * rho);
      pts.push(bx, bz);
      yield* lay(town(pts), -(sw / 2 - 0.1), sw / 2 - 0.1, street, walkH, E.corner, -1, a.e.id);
      continue;
    }
    for (let i = 0; i < A.length; i++) {
      const a = A[i], b = A[(i + 1) % A.length];
      if (!a.e.sidewalk || !b.e.sidewalk) continue;
      const sw = Math.max(a.e.sidewalk, b.e.sidewalk), oa = a.half + a.e.sidewalk / 2, ob = b.half + b.e.sidewalk / 2;
      const ax = a.px - a.uz * oa, az = a.pz + a.ux * oa, bx = b.px + b.uz * ob, bz = b.pz - b.ux * ob;
      if (Math.hypot(bx - ax, bz - az) > 0.05) yield* lay(town(hermitePoints(ax, az, -a.ux, -a.uz, bx, bz, b.ux, b.uz, 0.4, 0.4)), -(sw / 2 - 0.1), sw / 2 - 0.1, street, walkH, E.corner, -1, a.e.id);
    }
  }
  // the crossings (transit's): square across the street, from one walk's middle to the other's
  for (const c of crossings) {
    if (c.settlement !== si) continue;
    const a = toC(c.a), b = toC(c.b), L = Math.hypot(b.x - a.x, b.z - a.z) || 1, ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    let o = -1;
    for (let t = 0.1; t < 2 && o < 0; t += 0.05) if (onWalk(a.x - ux * t, a.z - uz * t) >= 0 && onWalk(a.x - ux * t, a.z - uz * t) < 0.03) o = t;
    if (o < 0) continue;
    const pts = [a.x - ux * o, a.z - uz * o, b.x + ux * o, b.z + uz * o];
    joins.push(...pts);
    const rh = road((a.x + b.x) / 2, (a.z + b.z) / 2);
    yield* lay(pts, -(c.width / 2 - 0.25), c.width / 2 - 0.25, (x, z) => blocked(x, z, OBS), (x, z) => {
      const t = (x - a.x) * ux + (z - a.z) * uz;
      return t > 0.03 && t < L - 0.03 ? Math.max(gAt(x, z) + ASPH, rh - 0.02) : walkH(x, z);
    }, E.cross, c.id, -1, o);
  }

  // the square: rings round its centrepiece, spokes out to the walks round it (H1 paves its block)
  const sq = s.square, centre = items.find((it) => it.t === T.centre || it.t === T.pool);
  if (sq && !s.nodes.some((id) => region.nodes[id].kind === 'end' && region.nodes[id].place === 'square')) {
    const cx = sq.x, cz = sq.z, max = sq.r + 22, rays: number[] = [];
    for (let k = 0; k < 72; k++) {
      const ca = Math.cos((k / 72) * 2 * Math.PI), sa = Math.sin((k / 72) * 2 * Math.PI);
      let t = sq.r;
      while (t < max && !blocked(cx + ca * t, cz + sa * t, CAR)) t += 0.3;
      rays.push(t >= max ? sq.r + 9 : t);
    }
    const reachAt = (x: number, z: number) => rays[(Math.round((Math.atan2(z - cz, x - cx) / (2 * Math.PI)) * 72) + 72) % 72];
    const sqH = (x: number, z: number) => (onWalk(x, z) >= 0 ? walkH(x, z) : gAt(x, z) + PAVE);
    const sqBad: Bad = (x, z) => (onWalk(x, z) >= 0 ? blocked(x, z, CAR | OBS) : blocked(x, z, CAR | OBS | WET) || Math.hypot(x - cx, z - cz) > reachAt(x, z) - 0.3 || padDist(s, x, z) > -0.5);
    const r0 = centre ? (centre.t === T.pool ? Math.hypot(centre.w / 2 + 0.6, centre.d / 2 + 1.5) : centre.c === CENTRE.jets ? (centre.w / 2) * 1.42 : centre.w / 2) + 0.55 : 1.5;
    const radii = [r0, sq.r + 0.95, sq.r + 3.7, sq.r + 6.8, sq.r + 10, sq.r + 13.4].filter((r, i, a) => r < Math.max(...rays) - 0.8 && (!i || r - a[0] > 1.2));
    const rot = hsh(7, 7) * 0.5;
    for (const rr of radii) {
      const pts: number[] = [];
      const m = 2 * Math.max(8, Math.ceil((Math.PI * rr) / 0.45));
      for (let k = 0; k <= m; k++) pts.push(cx + Math.cos((k / m) * 2 * Math.PI + rot) * rr, cz + Math.sin((k / m) * 2 * Math.PI + rot) * rr);
      joins.push(pts[m], pts[m + 1]);
      yield* lay(pts, -0.5, 0.5, sqBad, sqH, E.square);
    }
    for (let k = 0; k < 12; k++) {
      const a = rot + (k / 12) * 2 * Math.PI + 0.13, ca = Math.cos(a), sa = Math.sin(a);
      // out to the first sidewalk it meets (its middle line: a join), or as far as the paving goes
      let t = radii[0], end = -1;
      for (; t < max; t += 0.1) {
        const w = onWalk(cx + ca * t, cz + sa * t);
        if (w >= 0 && w < 0.06) {
          end = t;
          break;
        }
        if (blocked(cx + ca * t, cz + sa * t, CAR)) break;
      }
      const pts: number[] = [];
      for (const rr of radii) if (rr < (end > 0 ? end : t) - 0.3) pts.push(cx + ca * rr, cz + sa * rr);
      if (end > 0) pts.push(cx + ca * end, cz + sa * end);
      joins.push(...pts);
      if (pts.length >= 4) yield* lay(pts, -0.5, 0.5, sqBad, sqH, E.square);
    }
  }

  // the quay: a promenade along the sea wall behind its coping, rungs over to the quay street's walk,
  // and out along each pier
  if (wall) {
    const L = wall.line, pts: number[] = [], o = 1.45;
    for (let i = 0; i < L.length; i += 2) pts.push(L[i] - wall.nx * o, L[i + 1] - wall.nz * o);
    const qH = (x: number, z: number) => gAt(x, z) + QUAY_H;
    // (not where the quay street's walk already runs: that is the promenade there)
    const quay: Bad = (x, z) => onWalk(x, z) >= 0 || blocked(x, z, CAR | OBS | WET);
    yield* lay(pts, -0.45, 0.45, quay, qH, E.quay);
    let acc = 3;
    for (let i = 0; i + 3 < L.length; i += 2) {
      const sl = Math.hypot(L[i + 2] - L[i], L[i + 3] - L[i + 1]);
      for (; acc < sl; acc += 7) {
        const x = L[i] + ((L[i + 2] - L[i]) * acc) / sl - wall.nx * o, z = L[i + 1] + ((L[i + 3] - L[i + 1]) * acc) / sl - wall.nz * o;
        for (let t = 0.3; t < 3; t += 0.05) {
          const w = onWalk(x - wall.nx * t, z - wall.nz * t);
          if (w >= 0 && w < 0.04) {
            joins.push(x, z, x - wall.nx * t, z - wall.nz * t);
            yield* lay([x, z, x - wall.nx * t, z - wall.nz * t], -0.3, 0.3, (xx, zz) => blocked(xx, zz, CAR | OBS), qH, E.quay);
            break;
          }
        }
      }
      acc -= sl;
    }
    for (const pi of s.piers) {
      const p = region.piers[pi], a = toC(p.root), b = toC(p.berth), pl = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / pl, uz = (b.z - a.z) / pl;
      // (from the promenade: the root is on the quay line, o m out from the promenade)
      let t = 0.3;
      while (t < 4 && !(onWalk(a.x - ux * t, a.z - uz * t) >= 0 && onWalk(a.x - ux * t, a.z - uz * t) < 0.06)) t += 0.05;
      const sx = a.x - ux * (t < 4 ? t : o), sz = a.z - uz * (t < 4 ? t : o), ex = b.x - ux * 1.3, ez = b.z - uz * 1.3;
      joins.push(sx, sz);
      yield* lay([sx, sz, a.x, a.z, ex, ez], -(p.width / 2 - 0.3), p.width / 2 - 0.3, (x, z) => blocked(x, z, OBS), (x, z) => ((x - a.x) * ux + (z - a.z) * uz > 0.1 ? p.h : qH(x, z)), E.pier);
    }
  }

  // ── stubs: from the network to each door, seat and spot ──
  const mains = paths.length;
  /** The nearest point (within `max` m) on the network's main paths that a straight stub from (x, z) reaches clear of `bad`. */
  const reachNet = (x: number, z: number, max: number, bad: Bad): number[] | null => {
    let best: number[] | null = null, bd = max;
    for (let p = 0; p < mains; p++) {
      const pa = paths[p];
      if (pa.k === E.cross || Math.abs(pa.x[0] - x) > max + 60 || Math.abs(pa.z[0] - z) > max + 60) continue;
      for (let i = 0; i < pa.x.length; i++) {
        const d = Math.hypot(pa.x[i] - x, pa.z[i] - z);
        if (d >= bd || pa.lo[i] > 0.02 || pa.hi[i] < -0.02) continue;
        let ok = true;
        for (let t = 0.15; t < d - 0.1 && ok; t += 0.12) ok = !bad(x + ((pa.x[i] - x) * t) / d, z + ((pa.z[i] - z) * t) / d);
        if (ok) [best, bd] = [[pa.x[i], pa.z[i], pa.h[i]], d];
      }
    }
    return best;
  };
  const stub = (x: number, z: number, h: number, bad: Bad, place: number) => {
    const r = reachNet(x, z, 7, bad);
    if (!r) return;
    joins.push(r[0], r[1]);
    const d = Math.hypot(r[0] - x, r[1] - z);
    if (d < 0.2) {
      (stubs as number[]).push(place, r[0], r[1]);
      return;
    }
    paths.push({ x: [r[0], x], z: [r[1], z], h: [r[2], h], lo: [-0.08, -0.08], hi: [0.08, 0.08], k: E.stub, c: -1, r: -1, o: 0 });
    stubs.push(place, x, z);
  };
  const stubs: number[] = [];
  for (let k = 0; k < approach.length; k += 4) {
    yield* tick();
    const pl = places[approach[k]], x = approach[k + 1], z = approach[k + 2], it = approach[k + 3];
    if (!blocked(x, z, CAR | OBS | (wall ? WET : 0), it)) stub(x, z, (onWalk(x, z) >= 0 ? walkH(x, z) : pl.pose === POSE.idle || pl.pose === POSE.chat ? pl.h : items[it].y) + PAVE, (xx, zz) => blocked(xx, zz, CAR | OBS, it), approach[k]);
  }
  // doors: shops and offices first, then homes (a walker's home); ≤ 34 a town
  const doors = items.map((it, i) => [it, i] as const).filter(([it]) => it.t < T.tree && it.t !== T.silo && doorOff(it.t, it.s, it.w) === doorOff(it.t, it.s, it.w));
  for (const [it, i] of doors) {
    yield* tick();
    const c = Math.cos(it.a), sn = Math.sin(it.a), off = doorOff(it.t, it.s, it.w), lz = -it.d / 2 - 0.32;
    const x = it.x + off * c - lz * sn, z = it.z + off * sn + lz * c;
    if (places.filter((p) => p.k === PK.door).length >= 34 || blocked(x, z, CAR | OBS, i, true)) continue;
    const home = it.t === T.house || it.t === T.townhouse || it.t === T.chalet || it.t === T.villa || it.t === T.barn || it.t === T.boathouse;
    places.push({ k: PK.door, node: -1, x, z, h: it.y + 0.02, fx: sn, fz: -c, pose: POSE.idle, anch: false, home });
    stub(x, z, it.y + 0.02, (xx, zz) => blocked(xx, zz, CAR | OBS, i, true), places.length - 1);
    if (home) lights.push(x, z, 2.2 * 2.2);
  }
  yield;
  return finish(paths, joins, stubs, places, s, Float64Array.from(lights), seed);
}

/** Split the paths where they meet into a graph; prune dangling bits; components; destinations and their distance fields. */
function finish(paths: Path[], joins: number[], stubs: number[], places: Place[], s: Settlement, lights: Float64Array, seed: number): Net {
  // nodes: every path's ends and every join (merged within 0.1 m; a join near a path's cut is that cut)
  const nx: number[] = [], nz: number[] = [], par: number[] = [];
  const find = (a: number): number => (par[a] === a ? a : (par[a] = find(par[a])));
  const nodeAt = (x: number, z: number): number => {
    for (let i = 0; i < nx.length; i++) if (Math.abs(nx[i] - x) < 0.1 && Math.abs(nz[i] - z) < 0.1) return find(i);
    nx.push(x), nz.push(z), par.push(nx.length - 1);
    return nx.length - 1;
  };
  const cuts: Array<Array<[number, number]>> = paths.map((p) => [[0, nodeAt(p.x[0], p.z[0])], [p.x.length - 1, nodeAt(p.x[p.x.length - 1], p.z[p.z.length - 1])]]);
  for (let j = 0; j < joins.length; j += 2) {
    const x = joins[j], z = joins[j + 1], node = nodeAt(x, z);
    paths.forEach((p, pi) => {
      for (let i = 0; i + 1 < p.x.length; i++) {
        if (segDist(x, z, p.x[i], p.z[i], p.x[i + 1], p.z[i + 1]) > 0.1) continue;
        const f = i + tq[0], c = cuts[pi].find((c) => Math.abs(c[0] - f) < 0.3 / STEP);
        if (c) par[find(node)] = find(c[1]);
        else cuts[pi].push([f, node]);
        break;
      }
    });
  }
  // edges between consecutive cuts
  const X: number[] = [], Z: number[] = [], H: number[] = [], SA: number[] = [], LO: number[] = [], HI: number[] = [];
  const ef: number[] = [], en: number[] = [], ea: number[] = [], eb: number[] = [], len: number[] = [], kind: number[] = [], cross: number[] = [], road: number[] = [], kerb: number[] = [];
  paths.forEach((p, pi) => {
    const cs = cuts[pi].sort((a, b) => a[0] - b[0]);
    for (let c = 0; c + 1 < cs.length; c++) {
      const f0 = cs[c][0], f1 = cs[c + 1][0], a = find(cs[c][1]), b = find(cs[c + 1][1]);
      if (a === b) continue;
      const first = X.length;
      let acc = 0;
      const put = (f: number) => {
        const i = Math.min(p.x.length - 2, Math.floor(f)), t = f - i, lerp = (A: number[]) => A[i] + (A[i + 1] - A[i]) * t;
        const x = lerp(p.x), z = lerp(p.z);
        if (X.length > first) acc += Math.hypot(x - X[X.length - 1], z - Z[Z.length - 1]);
        X.push(x), Z.push(z), H.push(lerp(p.h)), SA.push(acc), LO.push(lerp(p.lo)), HI.push(lerp(p.hi));
      };
      put(f0);
      for (let i = Math.floor(f0) + 1; i < f1 - 1e-6; i++) put(i);
      put(f1);
      ef.push(first), en.push(X.length - first), ea.push(a), eb.push(b), len.push(acc), kind.push(p.k), cross.push(p.c), road.push(p.r);
      // (a crossing is one edge, kerb to kerb o in from each end; were it ever split, a cautious 0.6)
      kerb.push(p.k !== E.cross ? 0 : f0 < 1e-6 && f1 > p.x.length - 1 - 1e-6 ? p.o : 0.6);
    }
  });
  // (the ends sit exactly on their nodes: a merged node may lie a little off a path; the samples next
  // to an end that it now covers or lies past are dropped, so no edge starts on a zero or backward step)
  const keepS = new Uint8Array(X.length).fill(1);
  for (let e = 0; e < ef.length; e++) {
    const f = ef[e], l = f + en[e] - 1;
    [X[f], Z[f], X[l], Z[l]] = [nx[ea[e]], nz[ea[e]], nx[eb[e]], nz[eb[e]]];
    for (let i = f + 1; i < l && (Math.hypot(X[i] - X[f], Z[i] - Z[f]) < 0.05 || (X[i] - X[f]) * (X[i + 1] - X[i]) + (Z[i] - Z[f]) * (Z[i + 1] - Z[i]) < 0); i++) keepS[i] = 0;
    for (let i = l - 1; i > f && keepS[i] && (Math.hypot(X[l] - X[i], Z[l] - Z[i]) < 0.05 || (X[l] - X[i]) * (X[i] - X[i - 1]) + (Z[l] - Z[i]) * (Z[i] - Z[i - 1]) < 0); i--) keepS[i] = 0;
  }
  {
    const cols = [X, Z, H, SA, LO, HI];
    let w = 0;
    for (let e = 0; e < ef.length; e++) {
      const f = ef[e], l = f + en[e];
      ef[e] = w;
      for (let i = f; i < l; i++) if (keepS[i]) {
        for (const A of cols) A[w] = A[i];
        w++;
      }
      en[e] = w - ef[e];
      for (let i = ef[e] + 1; i < w; i++) SA[i] = SA[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
      SA[ef[e]] = 0;
      len[e] = SA[w - 1];
    }
    for (const A of cols) A.length = w;
  }
  // place nodes (a stub's far end), then prune what dangles: squares, quays, stubs, crossings
  for (let k = 0; k < stubs.length; k += 3) places[stubs[k]].node = nodeAt(stubs[k + 1], stubs[k + 2]);
  const keep = new Set(places.map((p) => p.node));
  const alive = ef.map((_, e) => len[e] > 0.05);
  // (dangling chains go: shorter than 6 m, through a crossing (a crossing must land on a walk at both
  // ends), or only square, quay and stub bits; a long dead-end walk or a pier stays)
  const at: number[][] = nx.map(() => []);
  for (let e = 0; e < ef.length; e++) if (alive[e]) at[ea[e]].push(e), at[eb[e]].push(e);
  const deg = (v: number) => at[v].reduce((n, e) => n + +alive[e], 0);
  for (let changed = true; changed; ) {
    changed = false;
    for (let v = 0; v < nx.length; v++) {
      if (keep.has(v) || deg(v) !== 1) continue;
      const chain: number[] = [];
      let cur = v, prev = -1, total = 0, cross = false, useless = true;
      for (;;) {
        const e = at[cur].find((e) => alive[e] && e !== prev);
        if (e === undefined) break;
        chain.push(e);
        total += len[e];
        cross ||= kind[e] === E.cross;
        useless &&= kind[e] > E.corner && kind[e] !== E.pier;
        [prev, cur] = [e, ea[e] === cur ? eb[e] : ea[e]];
        if (keep.has(cur) || deg(cur) !== 2 || chain.length > 400) break;
      }
      if (total < 6 || cross || useless) {
        for (const e of chain) alive[e] = false;
        changed = true;
      }
    }
  }
  const E2 = ef.map((_, e) => e).filter((e) => alive[e]);
  const N = nx.length, adj0 = new Int32Array(N + 1);
  for (const e of E2) adj0[ea[e] + 1]++, adj0[eb[e] + 1]++;
  for (let i = 0; i < N; i++) adj0[i + 1] += adj0[i];
  const fill = adj0.slice(0, N), adj = new Int32Array(adj0[N]);
  E2.forEach((e, k) => {
    adj[fill[ea[e]]++] = k;
    adj[fill[eb[e]]++] = k;
  });
  const pick = (A: number[]) => E2.map((e) => A[e]);
  const Ea = Int32Array.from(pick(ea)), Eb = Int32Array.from(pick(eb)), Len = Float32Array.from(pick(len)), Kind = Uint8Array.from(pick(kind));
  // components
  const comp = new Int32Array(N).fill(-1), compLen: number[] = [];
  for (let i = 0; i < N; i++) {
    if (comp[i] >= 0 || adj0[i + 1] === adj0[i]) continue;
    const c = compLen.length, stack = [i];
    let L = 0;
    comp[i] = c;
    while (stack.length) {
      const v = stack.pop()!;
      for (let k = adj0[v]; k < adj0[v + 1]; k++) {
        const e = adj[k], o = Ea[e] === v ? Eb[e] : Ea[e];
        if (Ea[e] === v) L += Len[e];
        if (comp[o] < 0) (comp[o] = c), stack.push(o);
      }
    }
    compLen.push(L);
  }
  // destinations: every reachable place, and waypoints (the ends of piers, then nodes spread out
  // over the network, farthest first)
  const dest: number[] = [], destPlace: number[] = [];
  places.forEach((p, i) => {
    if (p.node >= 0 && comp[p.node] >= 0 && !p.anch) dest.push(p.node), destPlace.push(i);
  });
  const way = (v: number) => {
    if (comp[v] >= 0 && compLen[comp[v]] > 12 && !dest.includes(v)) dest.push(v), destPlace.push(-1);
  };
  for (let i = 0; i < N; i++) if (adj0[i + 1] - adj0[i] === 1 && Eb.some((b, e) => (b === i || Ea[e] === i) && Kind[e] === E.pier)) way(i);
  const cand = Array.from({ length: N }, (_, i) => i).filter((i) => comp[i] >= 0 && compLen[comp[i]] > 12 && adj0[i + 1] - adj0[i] !== 2);
  for (let k = 0; k < 10 && cand.length; k++) {
    let bi = cand[Math.floor(hash3(k, 11, seed ^ s.index) * cand.length)], bd = -1;
    if (k) for (const i of cand) {
      let d = Infinity;
      for (const j of dest) d = Math.min(d, Math.hypot(nx[i] - nx[j], nz[i] - nz[j]));
      if (d > bd) [bd, bi] = [d, i];
    }
    way(bi);
  }
  // distance fields (Dijkstra; a crossing costs 2 m more: the wait)
  const D = dest.length, dist = new Float32Array(D * N).fill(Infinity), hn: number[] = [], hk: number[] = [];
  const push = (v: number, k: number) => {
    let i = hn.length;
    hn.push(v), hk.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= hk[i]) break;
      [hn[p], hn[i], hk[p], hk[i]] = [hn[i], hn[p], hk[i], hk[p]];
      i = p;
    }
  };
  const pop = () => {
    const v = hn[0], last = hn.length - 1;
    [hn[0], hk[0]] = [hn[last], hk[last]];
    hn.pop(), hk.pop();
    for (let i = 0; ; ) {
      const a = i * 2 + 1, b = a + 1;
      let m = i;
      if (a < hn.length && hk[a] < hk[m]) m = a;
      if (b < hn.length && hk[b] < hk[m]) m = b;
      if (m === i) break;
      [hn[m], hn[i], hk[m], hk[i]] = [hn[i], hn[m], hk[i], hk[m]];
      i = m;
    }
    return v;
  };
  for (let k = 0; k < D; k++) {
    const o = k * N;
    dist[o + dest[k]] = 0;
    push(dest[k], 0);
    while (hn.length) {
      const key = hk[0], v = pop();
      if (key > dist[o + v]) continue;
      for (let a = adj0[v]; a < adj0[v + 1]; a++) {
        const e = adj[a], w = Ea[e] === v ? Eb[e] : Ea[e], nd = key + Len[e] + (Kind[e] === E.cross ? 2 : 0);
        // (keyed by the stored float32 value, so the stale-entry test below is exact)
        if (nd < dist[o + w]) push(w, (dist[o + w] = Math.fround(nd)));
      }
    }
  }
  return {
    s,
    x: Float64Array.from(X),
    z: Float64Array.from(Z),
    h: Float32Array.from(H),
    sa: Float32Array.from(SA),
    lo: Float32Array.from(LO),
    hi: Float32Array.from(HI),
    ef: Int32Array.from(pick(ef)),
    en: Int32Array.from(pick(en)),
    ea: Ea,
    eb: Eb,
    len: Len,
    kind: Kind,
    cross: Int16Array.from(pick(cross)),
    kerb: Float32Array.from(pick(kerb)),
    road: Int16Array.from(pick(road)),
    nx: Float64Array.from(nx),
    nz: Float64Array.from(nz),
    adj0,
    adj,
    comp,
    compLen: Float32Array.from(compLen),
    places,
    dest: Int32Array.from(dest),
    destPlace: Int32Array.from(destPlace),
    dist,
    lights,
  };
}
