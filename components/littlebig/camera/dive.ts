// The scripted descent (BRIEF §0, the wow moment) as pure math over the city plan: no three.js.
// core/shots.ts turns a DivePose into a ViewSpec; the shot tool's --dive and C1's /play clip render
// it frame by frame (u = frame / (frames − 1)).
//
// The shot, in plan space:
//   - It opens on the interactive start framing (top-down over the city centre, the whole globe in
//     frame) and, while the altitude starts to fall, tips over into looking AT the city with the
//     planet's limb across the top of the frame: the limb becomes the horizon for the whole dive.
//   - The landing is the dive's own (camera/landing.ts): the best sunlit pavement spot in the city
//     with a long clear view down a street (the clock tower in it if possible), nothing within 4 m
//     of the lens, poles off the view axis, turned 7–12° off the street axis. Candidates are tried
//     best first until the whole path passes the clearance check below, so the dive follows any
//     plan A2 ships, and stays safe on it.
//   - The last ~60 m of ground track follow the landing's street, traced backwards through the road
//     graph (straightest continuation at each node) and rounded, so the camera glides in down the
//     street like a plane on final approach, easing sideways onto the pavement only at the end.
//   - Before that, a cubic Bézier swings in from the orbit start and joins the street tangentially.
//   - Altitude falls in log space on a timing table (seconds per log-unit by altitude): brisk
//     through orbit, a swoop from the clouds to the rooftops, quicker again near the ground. The
//     start eases from rest; touchdown eases into a short hold (the loop point).
//   - Distance to go is a function of altitude: a flared glide slope below 50 m, a smooth ease above
//     it, so position and height stay locked together and every frame is a pure function of u.
//   - Heading looks ahead along the track; below the clouds it sweeps ~15° across the street and
//     back (near buildings slide past with parallax), settling on the landing heading.
//   - Pitch: look-at-the-city high up, the interactive altitude curve plus a bump lower down,
//     fitted as one monotone PCHIP curve (the view only ever tips up, and never stalls).
//   - Hard constraint: below 14 m the eye keeps ≥ 1.5 m from every lamp post, lamp head, trunk,
//     crown and facade (0.6 m at touchdown), and in the last 25 m nothing at eye level sits within
//     4 m inside ±30° of the view (clearPath; spec'd).

import { ALT_MAX, CITY_SURFACE_R, EYE_HEIGHT } from '../world/config';
import { planToDir } from '../world/city/frame';
import { sunDirection } from '../world/sun';
import { v3 } from '../world/sphere';
import type { CityIndex, CityPlan } from '../world/city/types';
import { buildingDistance, clearanceAt, coneBlocked, LandingFinder, type Landing } from './landing';
import { pitchForAlt } from './model';

const DEG = Math.PI / 180;

/** Nominal length of the dive at 1× (s). The /play clip renders DIVE_SECONDS × 30 frames. */
export const DIVE_SECONDS = 10;
/** Altitude the dive starts at (m). */
export const DIVE_START_ALT = 380;
/** Fraction of the dive at the end spent standing still on the street (a calm loop point). */
const HOLD = 0.035;
/** Opening: fraction of the dive spent tipping from the top-down globe into the look-at framing. */
const U_OPEN = 0.08;
/** ...and gliding out from over the city centre onto the ground track (slow: it is high up). */
const U_GLIDE = 0.24;
/** Length of the street-following final approach (m of ground track). */
const STREET_LEN = 60;
/** Altitude at which the ground track joins the street path. */
const JOIN_ALT = 50;
/** Extra ground track before the street path, and how far it swings off-axis. */
const FAR_LEN = 30;
const FAR_SWING = 34 * DEG;
/** Glide-slope exponent: alt − eye ∝ D^(1/P); P < 1 flares the approach. */
const P = 0.714;
/**
 * The lateral ease onto the pavement: [starts, done] in m of track before touchdown. Tried in order
 * until the path clears: the long glide; stepping across low at the end (under the lamp heads and
 * crowns that hang over the kerb at 4–7 m, where the long glide crosses them); stepping over high
 * (done by ~7 m up).
 */
const EASES = [
  [24, 0],
  [9, 0],
  [36, 14],
] as const;
/** Heading eases onto the landing heading over the last metres. */
const HEADING_EASE = 26;
/** Heading sweep below the clouds (rad). */
const SWEEP = 15 * DEG;
/** Clearance rule (m): low flight, and at touchdown. */
export const DIVE_CLEAR = 1.5;
export const DIVE_CLEAR_TOUCH = 0.6;

/** Seconds per unit of log-altitude at each altitude (m): the dive's pacing. */
const PACE: Array<[alt: number, secPerLog: number]> = [
  [1.7, 0.3],
  [3, 0.45],
  [8, 0.82],
  [18, 1.35],
  [30, 1.35],
  [37, 0.85],
  [47, 0.85],
  [60, 1.15],
  [100, 1.05],
  [200, 1.05],
  [380, 1.2],
];

export interface DivePath {
  /** Ground track (plan x, z interleaved), ≤ 1 m apart, start → touchdown. */
  pts: Float64Array;
  /** Cumulative arc length per sample. */
  s: Float64Array;
  length: number;
  /** Length of the street-following part at the end (m). */
  streetLen: number;
  /** Touchdown point and the landing's plan heading (atan2(dx, −dz)). */
  endX: number;
  endZ: number;
  endHeading: number;
  /** True if the final approach follows a road (false: a straight line, no road near the landing). */
  onRoad: boolean;
  /** What the high part of the dive frames (plan point between the landing and the city centre). */
  targetX: number;
  targetZ: number;
  /** Signed heading sweep below the clouds (rad): toward the side the landing heading turns to. */
  sweep: number;
  /** Monotone pitch curve: PCHIP knots (u, pitch, slope). */
  pu: Float64Array;
  py: Float64Array;
  pm: Float64Array;
  /** Smallest clearance margin found by clearPath (m; ≥ 0 when the path passes). */
  margin: number;
}

export interface DivePose {
  /** Plan point under the camera. */
  x: number;
  z: number;
  /** Zoom altitude (m). */
  alt: number;
  /** Plan heading (atan2(dx, −dz)), radians. */
  heading: number;
  /** Absolute pitch (rad). */
  pitch: number;
  /** Distance to go along the track (m). */
  togo: number;
}

// ── Pacing table: u → log-altitude ──

const L_TOP = Math.log(DIVE_START_ALT);
const L_EYE = Math.log(EYE_HEIGHT);
const TABLE_N = 512;
/** cum[i] = normalised time at which log-alt reaches L_TOP − i·ΔL. */
const cum = new Float64Array(TABLE_N + 1);
(() => {
  const dL = (L_TOP - L_EYE) / TABLE_N;
  let acc = 0;
  cum[0] = 0;
  for (let i = 0; i < TABLE_N; i++) {
    const L = L_TOP - (i + 0.5) * dL;
    acc += paceAt(Math.exp(L)) * dL;
    cum[i + 1] = acc;
  }
  for (let i = 0; i <= TABLE_N; i++) cum[i] /= acc;
})();

function paceAt(alt: number): number {
  const L = Math.log(alt);
  if (alt <= PACE[0][0]) return PACE[0][1];
  for (let i = 1; i < PACE.length; i++) {
    if (alt <= PACE[i][0]) {
      const l0 = Math.log(PACE[i - 1][0]);
      const l1 = Math.log(PACE[i][0]);
      const t = (L - l0) / (l1 - l0);
      const e = t * t * (3 - 2 * t);
      return PACE[i - 1][1] + (PACE[i][1] - PACE[i - 1][1]) * e;
    }
  }
  return PACE[PACE.length - 1][1];
}

/** Trapezoidal-velocity ease (C1): accelerates over [0, a], cruises, decelerates over [b, 1]. */
export function trapezoidEase(u: number, a = 0.1, b = 0.8): number {
  u = Math.min(1, Math.max(0, u));
  const total = 1 - a / 2 - (1 - b) / 2;
  let d: number;
  if (u < a) d = (u * u) / (2 * a);
  else if (u <= b) d = a / 2 + (u - a);
  else {
    const r = 1 - u;
    const span = 1 - b;
    d = total - (r * r) / (2 * span);
  }
  return d / total;
}

/** Dive altitude (m) at u ∈ [0, 1]. */
export function diveAltAt(u: number): number {
  const t = trapezoidEase(Math.min(1, u / (1 - HOLD)), 0.07, 0.91);
  // invert cum (monotone) by binary search
  let lo = 0;
  let hi = TABLE_N;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= t) lo = m;
    else hi = m;
  }
  const span = cum[hi] - cum[lo];
  const f = span > 0 ? (t - cum[lo]) / span : 0;
  const L = L_TOP - ((lo + f) / TABLE_N) * (L_TOP - L_EYE);
  return Math.max(EYE_HEIGHT, Math.min(ALT_MAX, Math.exp(L)));
}

/** Pitch bump for the dive (rad, ≥ 0): lifts the view early so the horizon rises through the clouds. */
export function divePitchAt(alt: number): number {
  const base = pitchForAlt(alt);
  // bump in log-altitude between 10 m and 130 m, peaking near 45 m
  const v = (Math.log(alt) - Math.log(10)) / (Math.log(130) - Math.log(10));
  const bump = v <= 0 || v >= 1 ? 0 : Math.pow(Math.sin(Math.PI * Math.pow(v, 0.85)), 2);
  return base + 17 * DEG * bump;
}

// ── Path ──

/** Sample a polyline (plan pts) at arc length s: writes [x, z, tx, tz]. */
function sampleLine(pts: ArrayLike<number>, cs: ArrayLike<number>, s: number, out: number[]): void {
  const n = cs.length;
  if (n < 2) {
    out[0] = pts[0];
    out[1] = pts[1];
    out[2] = 0;
    out[3] = -1;
    return;
  }
  s = Math.max(0, Math.min(cs[n - 1], s));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cs[m] <= s) lo = m;
    else hi = m;
  }
  const seg = cs[hi] - cs[lo] || 1;
  const f = (s - cs[lo]) / seg;
  const x0 = pts[lo * 2];
  const z0 = pts[lo * 2 + 1];
  const x1 = pts[hi * 2];
  const z1 = pts[hi * 2 + 1];
  out[0] = x0 + (x1 - x0) * f;
  out[1] = z0 + (z1 - z0) * f;
  const l = Math.hypot(x1 - x0, z1 - z0) || 1;
  out[2] = (x1 - x0) / l;
  out[3] = (z1 - z0) / l;
}

function cumulative(pts: number[]): Float64Array {
  const n = pts.length >> 1;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  return s;
}

function resample(pts: number[], step: number): number[] {
  const cs = cumulative(pts);
  const len = cs[cs.length - 1];
  const n = Math.max(2, Math.ceil(len / step) + 1);
  const out: number[] = [];
  const t = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    sampleLine(pts, cs, (len * i) / (n - 1), t);
    out.push(t[0], t[1]);
  }
  return out;
}

/** Chaikin corner cutting, endpoints kept. */
function chaikin(pts: number[], passes: number): number[] {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    const n = p.length >> 1;
    if (n < 3) return p;
    const out: number[] = [p[0], p[1]];
    for (let i = 0; i < n - 1; i++) {
      const x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[i * 2 + 2], z1 = p[i * 2 + 3];
      out.push(0.75 * x0 + 0.25 * x1, 0.75 * z0 + 0.25 * z1, 0.25 * x0 + 0.75 * x1, 0.25 * z0 + 0.75 * z1);
    }
    out.push(p[(n - 1) * 2], p[(n - 1) * 2 + 1]);
    p = out;
  }
  return p;
}

/**
 * Walk backwards from the viewpoint along its street for `len` metres: returns centreline points
 * from far → near (plan x, z interleaved) plus the viewpoint's lateral offset from that centreline.
 */
function streetBackwards(plan: CityPlan, index: CityIndex, ex: number, ez: number, hx: number, hz: number, len: number): { pts: number[]; lateral: number; onRoad: boolean } {
  const near = { edge: -1, dist: 0, s: 0 };
  const tmp = [0, 0, 0, 0];
  const back: number[] = []; // near → far
  let lateral = 0;
  let onRoad = false;
  if (index.nearestRoad(ex, ez, 14, near) >= 0) {
    const e0 = plan.edges[near.edge];
    sampleLine(e0.centre.pts, e0.centre.s, near.s, tmp);
    // Facing along +s (toward node b) or −s?
    const along = tmp[2] * hx + tmp[3] * hz;
    if (Math.abs(along) > 0.5) {
      onRoad = true;
      // lateral offset of the viewpoint to the right of the travel direction (right of (dx, dz) is (−dz, dx))
      const dirX = along > 0 ? tmp[2] : -tmp[2];
      const dirZ = along > 0 ? tmp[3] : -tmp[3];
      lateral = (ex - tmp[0]) * -dirZ + (ez - tmp[1]) * dirX;
      let edge = e0;
      let s = near.s;
      let backwardIsDecreasing = along > 0; // travel +s ⇒ walking back decreases s
      let walked = 0;
      let guard = 0;
      while (walked < len && guard++ < 24) {
        const cs = edge.centre.s;
        const pts = edge.centre.pts;
        const step = 1;
        if (backwardIsDecreasing) {
          for (; s >= 0 && walked < len; s -= step, walked += step) {
            sampleLine(pts, cs, s, tmp);
            back.push(tmp[0], tmp[1]);
          }
        } else {
          for (; s <= edge.centre.length && walked < len; s += step, walked += step) {
            sampleLine(pts, cs, s, tmp);
            back.push(tmp[0], tmp[1]);
          }
        }
        if (walked >= len) break;
        // Arrived at the node behind us: cross it and continue on the straightest edge.
        const nodeId = backwardIsDecreasing ? edge.a : edge.b;
        const node = plan.nodes[nodeId];
        const n = back.length >> 1;
        const lx = back[(n - 1) * 2];
        const lz = back[(n - 1) * 2 + 1];
        const px = n > 1 ? back[(n - 2) * 2] : lx;
        const pz = n > 1 ? back[(n - 2) * 2 + 1] : lz;
        let ddx = lx - px;
        let ddz = lz - pz;
        const dl = Math.hypot(ddx, ddz) || 1;
        ddx /= dl;
        ddz /= dl;
        let best = -1;
        let bestDot = 0.3; // never turn more than ~72°
        let bestFromA = true;
        for (const id of node.edges) {
          if (id === edge.id) continue;
          const e = plan.edges[id];
          const fromA = e.a === nodeId;
          const c = e.centre;
          const m = c.pts.length >> 1;
          const i0 = fromA ? 0 : m - 1;
          const i1 = fromA ? Math.min(m - 1, 3) : Math.max(0, m - 4);
          let ox = c.pts[i1 * 2] - c.pts[i0 * 2];
          let oz = c.pts[i1 * 2 + 1] - c.pts[i0 * 2 + 1];
          const ol = Math.hypot(ox, oz) || 1;
          ox /= ol;
          oz /= ol;
          const d = ox * ddx + oz * ddz;
          if (d > bestDot) {
            bestDot = d;
            best = id;
            bestFromA = fromA;
          }
        }
        if (best < 0) break;
        const prevLen = walked;
        // Cross the patch through the node centre.
        back.push(node.x, node.z);
        walked = prevLen + Math.hypot(node.x - lx, node.z - lz);
        edge = plan.edges[best];
        backwardIsDecreasing = !bestFromA;
        s = bestFromA ? 0 : edge.centre.length;
        const sx = edge.centre.pts[bestFromA ? 0 : edge.centre.pts.length - 2];
        const sz = edge.centre.pts[bestFromA ? 1 : edge.centre.pts.length - 1];
        walked += Math.hypot(sx - node.x, sz - node.z);
      }
    }
  }
  if (!onRoad) back.push(ex, ez);
  // Straight extension if the road ran out.
  let n = back.length >> 1;
  let have = cumulative(back);
  let got = have[n - 1];
  if (got < len) {
    let dx: number;
    let dz: number;
    if (n >= 2) {
      dx = back[(n - 1) * 2] - back[(n - 2) * 2];
      dz = back[(n - 1) * 2 + 1] - back[(n - 2) * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
    } else {
      dx = -hx;
      dz = -hz;
    }
    const lx = back[(n - 1) * 2];
    const lz = back[(n - 1) * 2 + 1];
    for (let d = 1; got + d <= len + 0.5; d++) back.push(lx + dx * d, lz + dz * d);
    n = back.length >> 1;
    have = cumulative(back);
    got = have[n - 1];
  }
  // far → near
  const pts: number[] = [];
  for (let i = n - 1; i >= 0; i--) pts.push(back[i * 2], back[i * 2 + 1]);
  return { pts, lateral, onRoad };
}

/** The ground track for one landing: street approach + the swing-in from orbit. */
export function pathFor(plan: CityPlan, index: CityIndex, land: Landing, ease: readonly number[] = EASES[0]): DivePath {
  const ex = land.x;
  const ez = land.z;
  const hx = Math.sin(land.heading);
  const hz = -Math.cos(land.heading);
  const street = streetBackwards(plan, index, ex, ez, hx, hz, STREET_LEN);
  // Round the corners where the walk crossed a junction, then resample.
  let sp = resample(chaikin(resample(street.pts, 2), 4), 0.5);
  // Ease sideways from the centreline onto the landing over the last metres.
  {
    const cs = cumulative(sp);
    const len = cs[cs.length - 1];
    const out: number[] = [];
    const n = sp.length >> 1;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 2);
      const i1 = Math.min(n - 1, i + 2);
      let tx = sp[i1 * 2] - sp[i0 * 2];
      let tz = sp[i1 * 2 + 1] - sp[i0 * 2 + 1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const togo = len - cs[i];
      const k = Math.min(1, Math.max(0, (ease[0] - togo) / (ease[0] - ease[1])));
      const off = street.lateral * k * k * (3 - 2 * k);
      out.push(sp[i * 2] - tz * off, sp[i * 2 + 1] + tx * off);
    }
    out[out.length - 2] = ex;
    out[out.length - 1] = ez;
    sp = out;
  }
  // Low over the street, steer clear of walls and posts: push each point out of anything within
  // reach, then smooth the push so the track stays a gentle curve (clearPath checks the result).
  {
    const n = sp.length >> 1;
    const cs = cumulative(sp);
    const len = cs[n - 1];
    const dx = new Float64Array(n);
    const dz = new Float64Array(n);
    const o = { x: 0, z: 0 };
    for (let i = 0; i < n - 1; i++) {
      const togo = len - cs[i];
      if (togo > 34) continue;
      const x = sp[i * 2];
      const z = sp[i * 2 + 1];
      const r = 0.7 + 1.3 * smoothstep01((togo - 2) / 7);
      if (index.collide(x, z, r, o)) {
        dx[i] = o.x - x;
        dz[i] = o.z - z;
      }
    }
    const win = 8; // samples (0.5 m apart): ±4 m
    for (let i = 0; i < n - 1; i++) {
      let ax = 0;
      let az = 0;
      let wsum = 0;
      for (let k = -win; k <= win; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        const wt = 1 - Math.abs(k) / (win + 1);
        ax += dx[j] * wt;
        az += dz[j] * wt;
        wsum += wt;
      }
      const sx = ax / wsum;
      const sz = az / wsum;
      const keep = Math.hypot(dx[i], dz[i]) > Math.hypot(sx, sz);
      sp[i * 2] += keep ? dx[i] : sx;
      sp[i * 2 + 1] += keep ? dz[i] : sz;
    }
    sp = resample(chaikin(sp, 2), 0.5);
    sp[sp.length - 2] = ex;
    sp[sp.length - 1] = ez;
  }
  // Join: a Bézier from the orbit start, arriving tangent to the street path, swung toward the side
  // the city centre is on (the high frames keep the city in the middle).
  const ax = sp[0];
  const az = sp[1];
  let tax = sp[6] - sp[0];
  let taz = sp[7] - sp[1];
  const tl = Math.hypot(tax, taz) || 1;
  tax /= tl;
  taz /= tl;
  const c = Math.cos(FAR_SWING);
  const sn = Math.sin(FAR_SWING);
  let sx = 0;
  let sz = 0;
  let bestR = Infinity;
  for (const sg of [1, -1]) {
    const s = sn * sg;
    const bx = -tax * c + taz * s;
    const bz = -taz * c - tax * s;
    const x = ax + bx * FAR_LEN;
    const z = az + bz * FAR_LEN;
    if (Math.hypot(x, z) < bestR) {
      bestR = Math.hypot(x, z);
      sx = x;
      sz = z;
    }
  }
  const k = FAR_LEN * 0.45;
  const p1x = sx + (ax - tax * k - sx) * 0.35;
  const p1z = sz + (az - taz * k - sz) * 0.35;
  const p2x = ax - tax * k;
  const p2z = az - taz * k;
  const head: number[] = [];
  const steps = 120;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const m = 1 - t;
    head.push(m * m * m * sx + 3 * m * m * t * p1x + 3 * m * t * t * p2x + t * t * t * ax, m * m * m * sz + 3 * m * m * t * p1z + 3 * m * t * t * p2z + t * t * t * az);
  }
  const all = resample(head.concat(sp), 0.5);
  all[all.length - 2] = ex;
  all[all.length - 1] = ez;
  const cs = cumulative(all);
  const spCs = cumulative(sp);
  // Sweep toward the side the landing heading turns to off the street (the view swings out and
  // settles back onto it, rather than swinging the other way and then twice as far near the ground).
  const n2 = sp.length >> 1;
  const j = Math.max(0, n2 - 1 - 28); // ~14 m before touchdown
  let turn = land.heading - Math.atan2(sp[(n2 - 1) * 2] - sp[j * 2], -(sp[(n2 - 1) * 2 + 1] - sp[j * 2 + 1]));
  turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
  const path: DivePath = {
    pts: Float64Array.from(all),
    s: cs,
    length: cs[cs.length - 1],
    streetLen: spCs[spCs.length - 1],
    endX: ex,
    endZ: ez,
    endHeading: land.heading,
    onRoad: street.onRoad,
    targetX: ex * (1 - TARGET_TOWARD_CENTRE),
    targetZ: ez * (1 - TARGET_TOWARD_CENTRE),
    sweep: (turn >= 0 ? 1 : -1) * SWEEP,
    pu: new Float64Array(0),
    py: new Float64Array(0),
    pm: new Float64Array(0),
    margin: -Infinity,
  };
  buildPitch(path);
  return path;
}

/**
 * The clearance rule over a whole dive path (the hard constraint): below 14 m the eye keeps
 * DIVE_CLEAR from every camera solid and facade (DIVE_CLEAR_TOUCH in the last 3 m), and in the last
 * 25 m nothing at eye level sits within 4 m inside ±30° of the view. Returns the smallest margin
 * (m, ≥ 0 = passes; a blocked view cone counts as −1).
 */
export function clearPath(path: DivePath, index: CityIndex, solids: Float64Array, samples = 1200, failFast = false): number {
  const pose: DivePose = { x: 0, z: 0, alt: 0, heading: 0, pitch: 0, togo: 0 };
  const near: number[] = [];
  let margin = Infinity;
  // Altitude falls monotonically: find where it drops below 14 m; above that only roofs matter.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (diveAltAt(m) > 14) lo = m;
    else hi = m;
  }
  const u14 = hi;
  const high = Math.max(20, Math.round(samples * 0.2));
  // Bottom up: a path that fails, fails low (failFast returns at the first violation).
  for (let i = high + samples; i >= 0; i--) {
    if (failFast && margin < 0) return margin;
    const u = i <= high ? (u14 * i) / high : u14 + ((1 - u14) * (i - high)) / samples;
    divePoseAt(path, u, pose);
    const h = pose.alt + index.groundH(pose.x, pose.z);
    const roof = index.roofAt(pose.x, pose.z);
    if (roof > 0) margin = Math.min(margin, h - roof - 2);
    if (i <= high) continue;
    const need = pose.togo > 3 ? DIVE_CLEAR : DIVE_CLEAR_TOUCH + (DIVE_CLEAR - DIVE_CLEAR_TOUCH) * (pose.togo / 3);
    margin = Math.min(margin, clearanceAt(index, solids, pose.x, pose.z, h, near, need + 1) - need);
    if (pose.togo < 25 && coneBlocked(solids, pose.x, pose.z, Math.sin(pose.heading), -Math.cos(pose.heading), h, 4, 30 * DEG)) margin = Math.min(margin, -1);
  }
  return margin;
}

/**
 * Build the dive for a plan: the best landing whose whole path passes clearPath. Allocates; call
 * once per plan (core/shots.ts caches it). ~10 ms.
 */
export function buildDivePath(plan: CityPlan, index: CityIndex, t = 0): DivePath {
  const finder = new LandingFinder(plan, index);
  const sun = sunDirection(t);
  const cands = finder.find({ cx: 0, cz: 0, radius: plan.radius, heading: NaN, sun, dive: true }, 10);
  // A2's street viewpoint competes on the same score.
  const vp = plan.viewpoints.street;
  const vs = finder.score(vp.x, vp.z, vp.heading, { cx: 0, cz: 0, radius: plan.radius, heading: NaN, sun, dive: true });
  if (vs > -Infinity) cands.push({ x: vp.x, z: vp.z, heading: vp.heading, score: vs });
  cands.sort((a, b) => b.score - a.score);
  if (!cands.length) cands.push({ x: vp.x, z: vp.z, heading: vp.heading, score: 0 });
  // The best candidate whose path clears, trying each lateral ease onto the pavement.
  for (const c of cands) {
    for (const e of EASES) {
      const p = pathFor(plan, index, c, e);
      p.margin = clearPath(p, index, finder.solids, 500, true);
      if (p.margin >= 0) return p;
    }
  }
  const p = pathFor(plan, index, cands[0]);
  p.margin = clearPath(p, index, finder.solids, 500);
  return p;
}

/** The framing target sits this far from the landing toward the city centre. */
const TARGET_TOWARD_CENTRE = 0.5;
const _e = v3();
const _u = v3();
const _g = v3();

/** The raw pitch wish at u (rad): look-at-the-city high up, the dive curve lower, −90° at u = 0. */
function rawPitch(path: DivePath, u: number, pose: DivePose): number {
  trackPose(path, u, pose);
  const rT = CITY_SURFACE_R;
  planToDir(path.targetX, path.targetZ, _g);
  planToDir(pose.x, pose.z, _u);
  const re = rT + pose.alt;
  _e.x = _g.x * rT - _u.x * re;
  _e.y = _g.y * rT - _u.y * re;
  _e.z = _g.z * rT - _u.z * re;
  const l = Math.hypot(_e.x, _e.y, _e.z) || 1;
  const lookAt = Math.asin(Math.max(-1, Math.min(1, (_e.x * _u.x + _e.y * _u.y + _e.z * _u.z) / l)));
  const w = smoothstep01((Math.log(pose.alt) - Math.log(40)) / (Math.log(90) - Math.log(40)));
  const v = divePitchAt(pose.alt) * (1 - w) + Math.max(-Math.PI / 2, Math.min(-20 * DEG, lookAt)) * w;
  const o = smoothstep01(u / U_OPEN);
  return -Math.PI / 2 + (v + Math.PI / 2) * o;
}

/**
 * Pitch along the dive as one monotone curve: the raw wish sampled at knots, made non-decreasing by
 * isotonic regression (pool adjacent violators; a pooled run collapses to one knot at its middle, so
 * there is no flat stall), then a Fritsch–Carlson monotone cubic (PCHIP) through the knots.
 */
function buildPitch(path: DivePath): void {
  const pose: DivePose = { x: 0, z: 0, alt: 0, heading: 0, pitch: 0, togo: 0 };
  // Knots: the opening, then where the altitude crosses a few anchor heights. Sparse on purpose:
  // between the look-at framing and the cloud layer the raw wish nearly stalls (looking at the city
  // while sinking toward it), so the curve ramps straight through instead of hesitating.
  const us: number[] = [0, U_OPEN * 0.5, U_OPEN];
  const anchors = [200, 120, 34, 22, 14, 9, 5.5, 3.4, 2.3];
  let ai = 0;
  for (let i = 1; i <= 4000 && ai < anchors.length; i++) {
    const u = i / 4000;
    if (diveAltAt(u) <= anchors[ai]) {
      if (u > U_OPEN + 0.01) us.push(u);
      ai++;
    }
  }
  us.push(1 - HOLD, 1);
  // PAV: blocks of (sum, count, u-sum)
  const bv: number[] = [];
  const bn: number[] = [];
  const bu: number[] = [];
  for (const u of us) {
    bv.push(rawPitch(path, u, pose));
    bn.push(1);
    bu.push(u);
    while (bv.length > 1 && bv[bv.length - 2] / bn[bn.length - 2] > bv[bv.length - 1] / bn[bn.length - 1] - 1e-9) {
      const v = bv.pop()!;
      const n = bn.pop()!;
      const uu = bu.pop()!;
      bv[bv.length - 1] += v;
      bn[bn.length - 1] += n;
      bu[bu.length - 1] += uu;
    }
  }
  const ku: number[] = [];
  const ky: number[] = [];
  for (let i = 0; i < bv.length; i++) {
    ku.push(bu[i] / bn[i]);
    ky.push(bv[i] / bn[i]);
  }
  // pin the ends exactly
  ku[0] = 0;
  ky[0] = -Math.PI / 2;
  if (ku[ku.length - 1] < 1) {
    ku.push(1);
    ky.push(Math.max(ky[ky.length - 1], pitchForAlt(EYE_HEIGHT)));
  }
  ky[ky.length - 1] = pitchForAlt(EYE_HEIGHT);
  const n = ku.length;
  const m = new Float64Array(n);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ky[i + 1] - ky[i]) / Math.max(1e-9, ku[i + 1] - ku[i]));
  m[0] = 0; // the opening starts from rest
  m[n - 1] = 0; // and settles into the hold
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] <= 0 || d[i] <= 0) m[i] = 0;
    else {
      const h0 = ku[i] - ku[i - 1];
      const h1 = ku[i + 1] - ku[i];
      const w1 = 2 * h1 + h0;
      const w2 = h1 + 2 * h0;
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  path.pu = Float64Array.from(ku);
  path.py = Float64Array.from(ky);
  path.pm = m;
}

function pitchAt(path: DivePath, u: number): number {
  const U = path.pu;
  const n = U.length;
  if (u <= U[0]) return path.py[0];
  if (u >= U[n - 1]) return path.py[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (U[mid] <= u) lo = mid;
    else hi = mid;
  }
  const h = U[hi] - U[lo];
  const t = (u - U[lo]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * path.py[lo] + (t3 - 2 * t2 + t) * h * path.pm[lo] + (-2 * t3 + 3 * t2) * path.py[hi] + (t3 - t2) * h * path.pm[hi];
}

function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Distance to go (m) along the track at altitude alt. */
export function togoAt(path: DivePath, alt: number): number {
  const join = path.streetLen;
  const K = join / Math.pow(JOIN_ALT - EYE_HEIGHT, P);
  if (alt <= JOIN_ALT) return K * Math.pow(Math.max(0, alt - EYE_HEIGHT), P);
  // Above the join: ease out to the full length at the start altitude, slope matched at the join.
  const extra = Math.max(1e-6, path.length - join);
  const v = Math.min(1, (Math.log(alt) - Math.log(JOIN_ALT)) / (Math.log(DIVE_START_ALT) - Math.log(JOIN_ALT)));
  const slope = P * join * (JOIN_ALT / (JOIN_ALT - EYE_HEIGHT)) * (Math.log(DIVE_START_ALT) - Math.log(JOIN_ALT));
  const kk = Math.min(4, Math.max(1.05, slope / extra));
  return join + extra * (1 - Math.pow(1 - v, kk));
}

/** Sweep weight by altitude: rises below the clouds, gone by touchdown. */
function sweepAt(alt: number): number {
  const L = Math.log(alt);
  const up = smoothstep01((Math.log(60) - L) / (Math.log(60) - Math.log(24)));
  const down = smoothstep01((Math.log(22) - L) / (Math.log(22) - Math.log(2.6)));
  return up * (1 - down);
}

const _t = [0, 0, 0, 0];
const _a = [0, 0, 0, 0];

/** Position, altitude and heading at u (pitch left to the caller). Zero-alloc. */
function trackPose(path: DivePath, u: number, out: DivePose): DivePose {
  const alt = diveAltAt(u);
  const togo = Math.min(path.length, togoAt(path, alt));
  const s = path.length - togo;
  sampleLine(path.pts, path.s, s, _t);
  // Heading: look ahead along the track (further when high), past the end along the landing heading.
  const look = Math.min(40, Math.max(9, alt * 0.9));
  const ahead = s + look;
  let lx: number;
  let lz: number;
  if (ahead <= path.length) {
    sampleLine(path.pts, path.s, ahead, _a);
    lx = _a[0];
    lz = _a[1];
  } else {
    const over = ahead - path.length;
    lx = path.endX + Math.sin(path.endHeading) * over;
    lz = path.endZ - Math.cos(path.endHeading) * over;
  }
  let heading = Math.atan2(lx - _t[0], -(lz - _t[1]));
  // High up, face the city instead of the track (the orbit frame centres it).
  const wT = smoothstep01((Math.log(alt) - Math.log(50)) / (Math.log(160) - Math.log(50)));
  if (wT > 0) {
    const ht = Math.atan2(path.targetX - _t[0], -(path.targetZ - _t[1]));
    let d = ht - heading;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    heading += d * wT;
  }
  // Below the clouds: sweep across the street and back (parallax on the near buildings).
  heading += path.sweep * sweepAt(alt);
  // Settle onto the landing's own heading over the last metres.
  const k = Math.min(1, Math.max(0, 1 - togo / HEADING_EASE));
  if (k > 0) {
    let d = path.endHeading - heading;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    heading += d * k * k * (3 - 2 * k);
  }
  // Opening: start over the city centre (the interactive start framing) and glide out onto the track.
  const g = Math.min(1, u / U_GLIDE);
  const o = g * g * g * (g * (g * 6 - 15) + 10);
  out.x = _t[0] * o;
  out.z = _t[1] * o;
  out.alt = alt;
  out.heading = heading;
  out.pitch = divePitchAt(alt);
  out.togo = togo;
  return out;
}

/** The dive pose at u ∈ [0, 1]. Zero-alloc. */
export function divePoseAt(path: DivePath, u: number, out: DivePose): DivePose {
  u = Math.min(1, Math.max(0, u));
  trackPose(path, u, out);
  if (path.pu.length) out.pitch = pitchAt(path, u);
  return out;
}

export { buildingDistance };
