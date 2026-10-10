// LITTLEBIG traffic simulation (B1). Pure TS, no three.js, zero allocation per step.
//
// A fixed fleet drives a closed network (A2's lanes + turn connectors), so nothing ever spawns,
// despawns or teleports. A vehicle is a front-bumper arc position `s` on one segment (a lane or a
// connector) plus the two segments behind it (a bus can span three).
//
// Per step:
//   1. bucket vehicles by segment; measure each lane's free tail;
//   2. accelerations (IDM) against the nearest obstacle on the vehicle's route: the leader along its
//      lane → connector → lane → connector (including vehicles that forked onto a sibling connector
//      but whose rear still sits at the fork), the stop line while it holds no grant, the entry of a
//      conflict zone still occupied by a vehicle granted before it, and a curve-speed limit;
//   3. junction grants. Only the first ungranted vehicle of each lane may ask, highest score first
//      (connector priority + time waited). A grant needs: room for the whole body on the exit lane
//      (no blocking the box), no busy zebra on the way, and every earlier-granted vehicle on a
//      conflicting connector expected out of the shared zone before this one can reach it. A request
//      refused only by such a vehicle claims its conflicts, so lower scores cannot starve it. A
//      vehicle kept waiting by a full exit, or by walkers on its exit's zebra for a few seconds,
//      re-routes through another exit with room and a clear zebra;
//   4. integrate, with hard clamps to the leader's rear, the stop line and the zone entry, so overlap
//      is impossible by construction (grant estimates only decide how smooth it looks); advance
//      across segments; release a grant once the rear has left its connector;
//   5. publish `blocked` for every zebra crossing a granted vehicle is about to pass or is on. No
//      claims ahead of a grant: with the real crowd (people cross in groups on a walk cycle) every
//      claim variant tried measured worse — it only grew the crowd at the kerb.
//
// Conflicts: A2's connector conflicts (centrelines < VEHICLE_CLEARANCE) plus every pair whose
// bus-sized bodies can touch when swept along both turns (bodyConflicts): a bus off-tracks and
// swings its overhangs, so two right turns 3.2 m apart still collide.
//
// Deadlock freedom: a granted vehicle only ever waits for vehicles granted before it (zone yields),
// or for its physical leaders, which were granted before it too (one asker per lane, room reserved
// on the exit lane). Grant order is a total order, so there is no cycle. The one remaining cycle —
// every exit full around a loop — is broken by re-routing and kept unreachable by the fleet size
// (specs run it for an hour of sim time).

import { nearestOn, sampleAt } from '../world/city/path';
import type { CityIndex, CityPlan, PathSample, Polyline, Turn } from '../world/city/types';
import { hyp } from '../world/hyp';

export interface VehicleKind {
  name: string;
  /** Body length / width / height (m). */
  len: number;
  width: number;
  height: number;
  /** Axle spacing (m), centred on the body. */
  wheelbase: number;
  wheelR: number;
  /** Desired-speed factor and max acceleration (m/s²). */
  speedK: number;
  accel: number;
}

export const KINDS: readonly VehicleKind[] = [
  { name: 'car', len: 4.0, width: 1.9, height: 1.6, wheelbase: 2.45, wheelR: 0.47, speedK: 1, accel: 2.0 },
  { name: 'compact', len: 3.2, width: 1.75, height: 1.65, wheelbase: 1.95, wheelR: 0.45, speedK: 0.95, accel: 1.9 },
  { name: 'truck', len: 5.4, width: 2.1, height: 2.6, wheelbase: 3.3, wheelR: 0.53, speedK: 0.85, accel: 1.4 },
  { name: 'bus', len: 8.0, width: 2.4, height: 2.9, wheelbase: 5.0, wheelR: 0.56, speedK: 0.8, accel: 1.2 },
];

/** The default fleet: [car, compact, truck, bus]. */
export const FLEET: readonly number[] = [20, 8, 4, 3];

// ── tuning ──
const B = 2.6; // comfortable deceleration (m/s²)
const T_HEAD = 0.9; // time headway (s)
const S0 = 1.7; // standstill bumper gap (m)
const MIN_GAP = 0.5; // hard minimum bumper gap (m)
const ROOM = 1.8; // exit-lane room needed beyond the body (m) …
const BUS_ROOM = 0.7; // … for a bus: it may nose in behind a car queued in a short lane, its tail ~0.7 m in the box
const A_LAT = 2.8; // lateral acceleration in turns (m/s²)
const LOOK = 55; // leader search distance (m)
const SIB_RANGE = 7; // a sibling's rear within this of its fork still counts as ahead (m)
const REQ_MARGIN = 2.0; // ask for a grant this far beyond the braking distance (m) …
const REQ_T = 1.0; // … plus this many seconds of travel, so a free junction never slows anyone
const AGING = 1.5; // score per second waited
const REROUTE_AFTER = 1.2; // s waiting on a full exit before trying another
const CROSS_PAD = 0.6; // m past a crossing's strip before it is released
const ZONE_R = 3.4; // centreline distance (m) inside which two connectors' vehicles could touch
const ZONE_MARGIN = 0.6; // s between one vehicle leaving a zone and the next reaching it
const ZEBRA_REROUTE = 4; // s refused by a busy zebra on the exit before trying another exit
const OB_R = 0.45; // the player's body radius plus a margin (m)

const TURN_W: Record<Turn, number> = { straight: 1, right: 0.75, left: 0.6, uturn: 0.05 };
const KIND_W: Record<string, number> = { ring: 1.3, avenue: 1.15, street: 1, rural: 0.8, lane: 0.3 };

export interface TrafficSim {
  readonly n: number;
  readonly kind: Uint8Array;
  readonly seg: Int32Array;
  readonly s: Float64Array;
  readonly v: Float64Array;
  readonly acc: Float64Array;
  /** Distance driven (m): wheel spin. */
  readonly odo: Float64Array;
  /** Front and rear axle plan positions after the last step, and before it (render interpolation). */
  readonly fx: Float64Array;
  readonly fz: Float64Array;
  readonly rx: Float64Array;
  readonly rz: Float64Array;
  readonly pfx: Float64Array;
  readonly pfz: Float64Array;
  readonly prx: Float64Array;
  readonly prz: Float64Array;
  /** Turn signal: +1 left, −1 right, 0 off. Brake light 0/1. */
  readonly signal: Int8Array;
  readonly brake: Uint8Array;
  /** Read-only (L1, the follow card): the connector a vehicle on a lane will take at its end (on a connector: after the next lane). */
  readonly next: Int32Array;
  readonly nLanes: number;
  /** Reset the fleet to its seeded starting layout. */
  reset(): void;
  /** One fixed step. busy: people on crossings (read); blocked: written (cleared first). */
  step(dt: number, busy: Uint8Array | null, blocked: Uint8Array | null): void;
  /**
   * The player standing in the street at plan (x, z), or `on` false. Vehicles whose path passes
   * within their half-width + OB_R stop short of it (S0 gap, brake lights) as for a busy zebra,
   * and no grant is given through it (askers re-route after a while).
   */
  setObstacle(on: boolean, x: number, z: number): void;
  /** Path of a segment (lane id, or nLanes + connector id). */
  path(seg: number): Polyline;
  /** Plan point `back` metres behind vehicle i's front bumper, along its path. */
  pointBack(i: number, back: number, out: PathSample): PathSample;
}

export function createTrafficSim(plan: CityPlan, seed: number, fleet: readonly number[] = FLEET, index?: CityIndex): TrafficSim {
  const lanes = plan.lanes;
  const conns = plan.connectors;
  const nL = lanes.length;
  const nC = conns.length;
  const nS = nL + nC;
  const segPath: Polyline[] = [];
  const segLen = new Float64Array(nS);
  const segSpeed = new Float64Array(nS);
  for (const l of lanes) {
    segPath.push(l.path);
    segLen[l.id] = l.path.length;
    segSpeed[l.id] = plan.edges[l.edge].speed;
  }
  // Connector speed from its tightest curvature (tangents 1.5 m apart).
  const ps: PathSample = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  for (const c of conns) {
    const p = c.path;
    segPath.push(p);
    segLen[nL + c.id] = p.length;
    let kMax = 0;
    for (let d = 0; d + 1.5 <= p.length; d += 0.5) {
      sampleAt(p, d, ps);
      const tx = ps.tx;
      const tz = ps.tz;
      sampleAt(p, d + 1.5, ps);
      kMax = Math.max(kMax, Math.asin(Math.min(1, Math.abs(tx * ps.tz - tz * ps.tx))) / 1.5);
    }
    const vMax = Math.min(segSpeed[c.fromLane], segSpeed[c.toLane]);
    segSpeed[nL + c.id] = Math.max(2.8, Math.min(vMax, kMax > 1e-4 ? Math.sqrt(A_LAT / kMax) : vMax));
  }
  // Zebra crossings per lane: walk id, arc position, half-width.
  const xEnd = new Int32Array(nL).fill(-1);
  const xEndS = new Float64Array(nL);
  const xStart = new Int32Array(nL).fill(-1);
  const xStartS = new Float64Array(nL);
  const xHalf = new Float64Array(plan.walkEdges.length);
  for (const w of plan.walkEdges) {
    if (w.kind !== 'crossing' || !w.lanes || !w.laneS) continue;
    xHalf[w.id] = w.width / 2;
    w.lanes.forEach((li, k) => {
      const l = lanes[li];
      const at = w.laneS![k];
      if (l.crossingAtEnd === w.id || (l.crossingAtStart !== w.id && at > l.path.length / 2)) {
        xEnd[li] = w.id;
        xEndS[li] = at;
      } else {
        xStart[li] = w.id;
        xStartS[li] = at;
      }
    });
  }
  // Conflict zones. zoneEnd[h·nC + c]: the last arc length on h within ZONE_R of c's path (h's
  // length when both merge into one lane); zoneStart[c·nC + h]: the first on c near h's path.
  const conflicts: number[][] = conns.map((c) => c.conflicts.slice());
  const zoneEnd = new Float32Array(nC * nC);
  const zoneStart = new Float32Array(nC * nC);
  const near = { dist: 0, s: 0 };
  const busSweep = conns.map((c) => sweep(plan, c.id, KINDS[3]));
  const bodyPairs = bodyConflicts(plan, busSweep, conflicts, zoneStart, zoneEnd);
  // ok[k·nC + c]: kind k may take connector c. Never into a lane too short to wait in behind its
  // stop line; trucks and buses never into cul-de-sacs; buses never through a turn whose tail swing
  // takes the body over a kerb (most left turns here: walkers wait there; trucks clear them all, the
  // spec checks every body corner); and never into a lane that then only leads to such turns
  // (pruned to a fixed point, so every kind always has a way on).
  const ok = new Uint8Array(KINDS.length * nC);
  const laneOk = (k: number, l: number) => lanes[l].next.some((c) => ok[k * nC + c]);
  KINDS.forEach((K, k) => {
    for (const c of conns) {
      const to = lanes[c.toLane];
      ok[k * nC + c.id] = to.stopS < K.len + 0.2 || (k >= 2 && plan.edges[to.edge].kind === 'lane') || (k === 3 && index && offRoad(index, busSweep[c.id], K)) ? 0 : 1;
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const c of conns)
        if (ok[k * nC + c.id] && !laneOk(k, c.toLane)) {
          ok[k * nC + c.id] = 0;
          changed = true;
        }
    }
  });
  for (const h of conns) {
    const P = h.path;
    const n = P.pts.length >> 1;
    for (const c of conflicts[h.id]) {
      if (bodyPairs.has(h.id * nC + c)) continue;
      const Q = conns[c].path;
      let first = -1;
      let last = 0;
      for (let k = 0; k < n; k++) {
        if (nearestOn(Q, P.pts[k * 2], P.pts[k * 2 + 1], near) < ZONE_R) {
          if (first < 0) first = P.s[k];
          last = P.s[k];
        }
      }
      if (first < 0) first = last = P.length; // listed but never near (conservative: the end)
      zoneStart[h.id * nC + c] = Math.max(0, first - 0.6);
      zoneEnd[h.id * nC + c] = conns[c].toLane === h.toLane ? P.length : Math.min(P.length, last + 0.6);
    }
  }

  // ── fleet ──
  let N = 0;
  for (const k of fleet) N += k;
  const kind = new Uint8Array(N);
  {
    let i = 0;
    fleet.forEach((cnt, k) => {
      for (let j = 0; j < cnt; j++) kind[i++] = k;
    });
    for (let a = N - 1; a > 0; a--) {
      const b = Math.floor(hashU(seed, a, 7) * (a + 1));
      const t = kind[a];
      kind[a] = kind[b];
      kind[b] = t;
    }
  }
  const len = new Float64Array(N);
  const vK = new Float64Array(N);
  const aMax = new Float64Array(N);
  /** Exit-lane room a grant needs (and reserves). */
  const need = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const k = KINDS[kind[i]];
    len[i] = k.len;
    need[i] = k.len + (kind[i] === 3 ? BUS_ROOM : ROOM);
    vK[i] = k.speedK * (0.92 + 0.14 * hashU(seed, i, 3));
    aMax[i] = k.accel;
  }

  // ── state ──
  const seg = new Int32Array(N);
  const prev1 = new Int32Array(N);
  const prev2 = new Int32Array(N);
  const s = new Float64Array(N);
  const v = new Float64Array(N);
  const acc = new Float64Array(N);
  const odo = new Float64Array(N);
  /** The connector at the end of the lane the vehicle is on (or, on a connector, of the next lane). */
  const next = new Int32Array(N);
  /** Granted for the end of its current lane. */
  const committed = new Uint8Array(N);
  /** Held grants (oldest first) and their grant order. */
  const hold0 = new Int32Array(N);
  const hold1 = new Int32Array(N);
  const seq0 = new Float64Array(N);
  const seq1 = new Float64Array(N);
  let seqN = 0;
  const wait = new Float64Array(N);
  /** Seconds refused by a busy zebra on the planned exit. */
  const zw = new Float64Array(N);
  const rng = new Uint32Array(N);
  const signal = new Int8Array(N);
  const brake = new Uint8Array(N);
  const fx = new Float64Array(N);
  const fz = new Float64Array(N);
  const rx = new Float64Array(N);
  const rz = new Float64Array(N);
  const pfx = new Float64Array(N);
  const pfz = new Float64Array(N);
  const prx = new Float64Array(N);
  const prz = new Float64Array(N);
  // ── scratch ──
  const head = new Int32Array(nS);
  const link = new Int32Array(N);
  const tail = new Float64Array(nL);
  const reserved = new Float64Array(nL);
  const asker = new Int32Array(nL);
  const claim = new Int32Array(nC);
  const full = new Int32Array(nL);
  const mark = new Int32Array(nC);
  let stamp = 0;
  let stamp2 = 0;
  const req = new Int32Array(N);
  const score = new Float64Array(N);
  const leadGap = new Float64Array(N);
  const leadV = new Float64Array(N);
  const zoneGap = new Float64Array(N);
  const route = new Int32Array(3);
  const sample: PathSample = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  // the player as an obstacle: up to 8 segments it stands on (arc position, lateral distance)
  const box = new Float64Array(nS * 4);
  for (let g = 0; g < nS; g++) {
    const P = segPath[g].pts;
    box[g * 4] = box[g * 4 + 1] = 1e9;
    box[g * 4 + 2] = box[g * 4 + 3] = -1e9;
    for (let k = 0; k < P.length; k += 2) {
      box[g * 4] = Math.min(box[g * 4], P[k]);
      box[g * 4 + 1] = Math.min(box[g * 4 + 1], P[k + 1]);
      box[g * 4 + 2] = Math.max(box[g * 4 + 2], P[k]);
      box[g * 4 + 3] = Math.max(box[g * 4 + 3], P[k + 1]);
    }
  }
  const obSeg = new Int32Array(8);
  const obS = new Float64Array(8);
  const obD = new Float64Array(8);
  let obN = 0;
  let obX = 1e9;
  let obZ = 1e9;

  const rand = (i: number) => {
    let a = (rng[i] = (rng[i] + 0x6d2b79f5) >>> 0);
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  };
  /** How much vehicle i likes exit c: straight over turns, through roads over side streets (0: closed to its kind). */
  const like = (i: number, c: number) => {
    const cn = conns[c];
    return ok[kind[i] * nC + c] * TURN_W[cn.turn] * (KIND_W[plan.edges[lanes[cn.toLane].edge].kind] ?? 1);
  };
  /** like(), one junction ahead: an exit whose queue already reaches its start is a last resort. */
  const pick = (i: number, c: number) => like(i, c) * (room(conns[c].toLane) < need[i] ? 0.08 : 1);
  const choose = (i: number, l: number): number => {
    const nx = lanes[l].next;
    if (nx.length === 1) return nx[0];
    let tot = 0;
    for (let k = 0; k < nx.length; k++) tot += pick(i, nx[k]);
    let r = rand(i) * tot;
    for (let k = 0; k < nx.length; k++) {
      const w = pick(i, nx[k]);
      r -= w;
      if (w > 0 && r <= 0) return nx[k];
    }
    return nx[0];
  };
  const room = (l: number) => tail[l] - reserved[l];
  /** Arc position of j's rear along connector h (very negative while still approaching it). */
  const rearOn = (j: number, h: number) => {
    const g = seg[j];
    if (g === nL + h) return s[j] - len[j];
    if (g === conns[h].toLane) return segLen[nL + h] + s[j] - len[j];
    if (g === conns[h].fromLane) return s[j] - len[j] - segLen[g];
    return -1e9;
  };
  /** Mark connector c's conflicts with a fresh stamp. */
  const markConflicts = (c: number) => {
    stamp2++;
    const cf = conflicts[c];
    for (let k = 0; k < cf.length; k++) mark[cf[k]] = stamp2;
    return cf.length > 0;
  };

  /** Is the zebra at the start of connector c's exit lane busy (this step's `busy`)? */
  let busyNow: Uint8Array | null = null;
  const exitBusy = (c: number) => {
    const x = xStart[conns[c].toLane];
    return busyNow !== null && x >= 0 && busyNow[x] === 1;
  };
  /** Mark zebra x (centre at arc a on the lane) blocked if the body span [lo, hi] reaches its padded strip. */
  const cover = (blocked: Uint8Array, x: number, a: number, lo: number, hi: number) => {
    if (x >= 0 && lo < a + xHalf[x] + CROSS_PAD && hi > a - xHalf[x] - CROSS_PAD) blocked[x] = 1;
  };

  function reset() {
    hold0.fill(-1);
    hold1.fill(-1);
    committed.fill(0);
    reserved.fill(0);
    tail.fill(0); // choose() reads room(): no state may leak in from before the reset
    claim.fill(0);
    wait.fill(0);
    zw.fill(0);
    acc.fill(0);
    signal.fill(0);
    brake.fill(0);
    seqN = 0;
    for (let i = 0; i < N; i++) {
      rng[i] = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
      odo[i] = hashU(seed, i, 11) * 10;
    }
    // Seeded layout: lanes in a shuffled order, each filled from its stop line back, generously spaced.
    const order = lanes.map((l) => l.id);
    for (let a = order.length - 1; a > 0; a--) {
      const b = Math.floor(hashU(seed, a, 5) * (a + 1));
      const t = order[a];
      order[a] = order[b];
      order[b] = t;
    }
    const front = lanes.map((l) => l.stopS - 0.5 - hashU(seed, l.id, 9) * 4);
    let k = 0;
    for (let i = 0; i < N; i++) {
      let placed = false;
      for (let tries = 0; tries < order.length * 3 && !placed; tries++) {
        const l = order[k++ % order.length];
        if (front[l] - len[i] < 1.5 || !laneOk(kind[i], l)) continue;
        seg[i] = l;
        s[i] = front[l];
        front[l] -= len[i] + 7 + hashU(seed, i, 13) * 8;
        placed = true;
      }
      if (!placed) throw new Error('traffic: the fleet does not fit the network');
      prev1[i] = prev2[i] = nL + lanes[seg[i]].prev[0];
      next[i] = choose(i, seg[i]);
      v[i] = segSpeed[seg[i]] * vK[i] * 0.5;
    }
    poses();
    pfx.set(fx);
    pfz.set(fz);
    prx.set(rx);
    prz.set(rz);
  }

  function setObstacle(on: boolean, x: number, z: number) {
    if (!on) {
      obN = 0;
      obX = 1e9;
      return;
    }
    if ((x - obX) * (x - obX) + (z - obZ) * (z - obZ) < 0.01) return;
    obX = x;
    obZ = z;
    obN = 0;
    const R = 1.2 + OB_R; // the widest half-body
    for (let g = 0; g < nS && obN < 8; g++) {
      if (x < box[g * 4] - R || z < box[g * 4 + 1] - R || x > box[g * 4 + 2] + R || z > box[g * 4 + 3] + R) continue;
      const d = nearestOn(segPath[g], x, z, near);
      if (d < R) {
        obSeg[obN] = g;
        obS[obN] = near.s;
        obD[obN++] = d;
      }
    }
  }
  /** Is the player in the way of a grant through connector c into its exit lane? */
  const obstructs = (c: number, nd: number) => {
    for (let o = 0; o < obN; o++) if (obSeg[o] === nL + c || (obSeg[o] === conns[c].toLane && obS[o] < nd + 2)) return true;
    return false;
  };

  function pointBack(i: number, back: number, out: PathSample): PathSample {
    let d = s[i] - back;
    let g = seg[i];
    if (d < 0) {
      g = prev1[i];
      d += segLen[g];
      if (d < 0) {
        g = prev2[i];
        d += segLen[g];
      }
    }
    out.i = 0;
    return sampleAt(segPath[g], d, out);
  }

  function poses() {
    for (let i = 0; i < N; i++) {
      const k = KINDS[kind[i]];
      const oh = (k.len - k.wheelbase) / 2;
      pointBack(i, oh, sample);
      fx[i] = sample.x;
      fz[i] = sample.z;
      pointBack(i, oh + k.wheelbase, sample);
      rx[i] = sample.x;
      rz[i] = sample.z;
    }
  }

  /**
   * Nearest vehicle ahead of i among those whose front is in segment g, where g starts `off` m ahead
   * of i's front. `same`: g is i's own segment (only fronts ahead count). Vehicles whose rear lies
   * beyond `maxRear` along g are skipped (forks: only rears still at the fork matter).
   */
  function scanSeg(i: number, g: number, off: number, same: boolean, maxRear: number) {
    for (let u = head[g]; u >= 0; u = link[u]) {
      if (u === i) continue;
      if (same && (s[u] < s[i] || (s[u] === s[i] && u < i))) continue;
      const rear = s[u] - len[u];
      if (rear > maxRear) continue;
      const gap = off + rear;
      if (gap < leadGap[i]) {
        leadGap[i] = gap;
        leadV[i] = v[u];
      }
    }
  }
  /** Vehicles that took another exit from the same lane as connector c, rear still at the fork. */
  function scanSiblings(i: number, c: number, off: number, same: boolean) {
    const sibs = lanes[conns[c].fromLane].next;
    for (let k = 0; k < sibs.length; k++) {
      const o = sibs[k];
      if (o === c) continue;
      scanSeg(i, nL + o, off, same, SIB_RANGE);
      const L = segLen[nL + o];
      if (L < SIB_RANGE) scanSeg(i, conns[o].toLane, off + L, false, SIB_RANGE - L);
    }
  }

  /**
   * Distance from i's front to the nearest conflict-zone entry on its granted connector c (whose
   * start is `toStart` m ahead) still occupied by a vehicle granted before it (seq), or 1e9.
   */
  function zoneBlock(i: number, c: number, sq: number, toStart: number): number {
    if (!markConflicts(c)) return 1e9;
    let best = 1e9;
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      for (let q = 0; q < 2; q++) {
        const h = q === 0 ? hold0[j] : hold1[j];
        if (h < 0 || mark[h] !== stamp2 || (q === 0 ? seq0[j] : seq1[j]) > sq) continue;
        if (rearOn(j, h) >= zoneEnd[h * nC + c]) continue;
        const d = toStart + zoneStart[c * nC + h];
        if (d > -0.05 && d < best) best = d;
      }
    }
    return best;
  }

  /** Can i be granted connector c without cutting into a vehicle granted before it? */
  function zonesClear(i: number, c: number, toStart: number): boolean {
    if (!markConflicts(c)) return true;
    const vi = v[i];
    const ai = aMax[i];
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      for (let q = 0; q < 2; q++) {
        const h = q === 0 ? hold0[j] : hold1[j];
        if (h < 0 || mark[h] !== stamp2) continue;
        const r = rearOn(j, h);
        const end = zoneEnd[h * nC + c];
        if (r >= end) continue;
        // j leaves the zone (at its current speed, or a crawl) …
        const out = (end - r) / Math.max(v[j], 0.4);
        // … before i could reach it (flat out from now)?
        const d = Math.max(0, toStart + zoneStart[c * nC + h]);
        const tin = (Math.sqrt(vi * vi + 2 * ai * d) - vi) / ai;
        if (out + ZONE_MARGIN > tin) return false;
      }
    }
    return true;
  }

  function step(dt: number, busy: Uint8Array | null, blocked: Uint8Array | null) {
    // 1. buckets, lane tails, the first ungranted vehicle of each lane
    head.fill(-1);
    asker.fill(-1);
    for (let i = 0; i < N; i++) {
      link[i] = head[seg[i]];
      head[seg[i]] = i;
    }
    // an empty lane takes one more body, as long as it can wait at the stop line with its rear clear
    // of the connector behind it. Vehicles already granted onward don't count: they are leaving
    // (they wait only for vehicles granted before them, and have room reserved beyond), so a
    // platoon flows through a short lane instead of every follower stopping at the line behind it
    for (let l = 0; l < nL; l++) tail[l] = lanes[l].stopS + ROOM - 0.2;
    for (let i = 0; i < N; i++) {
      const g = seg[i];
      if (g < nL && !committed[i]) {
        if (s[i] - len[i] < tail[g]) tail[g] = s[i] - len[i];
        if (asker[g] < 0 || s[i] > s[asker[g]]) asker[g] = i;
      }
    }

    // 2. accelerations
    let nReq = 0;
    for (let i = 0; i < N; i++) {
      const g = seg[i];
      const onLane = g < nL;
      const c = onLane ? next[i] : g - nL;
      route[0] = g;
      route[1] = onLane ? nL + c : conns[c].toLane;
      route[2] = onLane ? conns[c].toLane : nL + next[i];
      leadGap[i] = 1e9;
      leadV[i] = 0;
      let off = -s[i];
      for (let k = 0; k < 3; k++) {
        const rg = route[k];
        scanSeg(i, rg, off, k === 0, 1e9);
        if (rg >= nL) scanSiblings(i, rg - nL, off, k === 0);
        // the player, as a stationary leader (unless already alongside: the push-out handles that)
        for (let o = 0; o < obN; o++) {
          if (obSeg[o] !== rg || obD[o] > KINDS[kind[i]].width / 2 + OB_R || (k === 0 && obS[o] + OB_R < s[i])) continue;
          const gap = off + obS[o] - OB_R;
          if (gap < leadGap[i]) {
            leadGap[i] = gap;
            leadV[i] = 0;
          }
        }
        off += segLen[rg];
        if (leadGap[i] < off - 8.5 || off > LOOK) break; // nothing further on can be nearer
      }
      // the zone entries of a granted connector
      zoneGap[i] = 1e9;
      const toStart = onLane ? segLen[g] - s[i] : -s[i];
      if (!onLane || committed[i]) {
        const sq = hold1[i] === c ? seq1[i] : seq0[i];
        zoneGap[i] = zoneBlock(i, c, sq, toStart);
      }
      const vi = v[i];
      let vmax = segSpeed[g] * vK[i];
      if (onLane) {
        const vc = segSpeed[nL + c] * vK[i];
        vmax = Math.min(vmax, Math.sqrt(vc * vc + 2 * 1.6 * Math.max(0, segLen[g] - s[i])));
      } else {
        // ease out of the turn: the exit lane's speed only once straightening
        vmax = Math.max(vmax, Math.min(segSpeed[conns[c].toLane] * vK[i], vmax + 0.25 * s[i]));
      }
      const am = aMax[i];
      let a = am * (1 - Math.pow(vi / Math.max(vmax, 0.1), 4));
      if (leadGap[i] < 1e8) a = Math.min(a, idm(vi, vmax, am, leadGap[i], leadV[i]));
      if (zoneGap[i] < 1e8) a = Math.min(a, idm(vi, vmax, am, zoneGap[i] + S0 - 0.2, 0));
      if (onLane && !committed[i]) {
        const dStop = lanes[g].stopS - s[i];
        a = Math.min(a, idm(vi, vmax, am, dStop + S0 - 0.3, 0));
        if (asker[g] === i && dStop <= (vi * vi) / (2 * B) + REQ_MARGIN + vi * REQ_T) req[nReq++] = i;
      }
      acc[i] = Math.max(-9, a);
    }

    // 3. grants, highest score first
    for (let k = 0; k < nReq; k++) {
      const i = req[k];
      score[i] = conns[next[i]].priority + wait[i] * AGING;
    }
    for (let a = 1; a < nReq; a++) {
      const x = req[a];
      let b = a - 1;
      while (b >= 0 && (score[req[b]] < score[x] || (score[req[b]] === score[x] && req[b] > x))) {
        req[b + 1] = req[b];
        b--;
      }
      req[b + 1] = x;
    }
    stamp++;
    busyNow = busy;
    for (let k = 0; k < nReq; k++) {
      const i = req[k];
      const l = seg[i];
      const nd = need[i];
      // the planned exit is full (re-plan at once while still rolling up to the line, after a short
      // wait once there), or walkers have held its zebra a while
      const fullExit = room(conns[next[i]].toLane) < nd;
      if ((fullExit && (wait[i] > REROUTE_AFTER || lanes[l].stopS - s[i] > 6)) || (wait[i] > REROUTE_AFTER && zw[i] > ZEBRA_REROUTE)) {
        // take another exit with room and a clear zebra (the gridlock breaker)
        const nx = lanes[l].next;
        const o = Math.floor(rand(i) * nx.length);
        for (let j = 0; j < nx.length; j++) {
          const alt = nx[(o + j) % nx.length];
          if (alt !== next[i] && room(conns[alt].toLane) >= nd && !exitBusy(alt) && like(i, alt) > 0 && !(obN && obstructs(alt, nd))) {
            next[i] = alt;
            zw[i] = 0;
            break;
          }
        }
      }
      const c = next[i];
      const cn = conns[c];
      // a lane someone has waited a while to get into (by score, so first in this loop) takes no one
      // else until it has room for them: a bus is never starved by cars filling a short lane
      if (full[cn.toLane] === stamp) continue;
      if (room(cn.toLane) < nd) {
        if (wait[i] > 2) full[cn.toLane] = stamp;
        continue;
      }
      if (exitBusy(c)) {
        zw[i] += dt;
        continue;
      }
      if (busy && xEnd[l] >= 0 && busy[xEnd[l]]) continue;
      if (obN && obstructs(c, nd)) {
        zw[i] += dt;
        continue;
      }
      if (claim[c] === stamp) continue;
      if (!zonesClear(i, c, segLen[l] - s[i])) {
        const cf = conflicts[c];
        for (let j = 0; j < cf.length; j++) claim[cf[j]] = stamp;
        continue;
      }
      committed[i] = 1;
      reserved[cn.toLane] += nd;
      if (hold0[i] < 0) {
        hold0[i] = c;
        seq0[i] = ++seqN;
      } else {
        hold1[i] = c;
        seq1[i] = ++seqN;
      }
      wait[i] = zw[i] = 0;
    }

    // 4. integrate
    for (let i = 0; i < N; i++) {
      let vn = v[i] + acc[i] * dt;
      if (vn < 0) vn = 0;
      let ds = vn * dt;
      const g0 = seg[i];
      let lim = Math.min(leadGap[i] - MIN_GAP, zoneGap[i]);
      if (g0 < nL && !committed[i]) lim = Math.min(lim, lanes[g0].stopS - s[i]);
      if (ds > lim) ds = Math.max(0, lim);
      if (ds < vn * dt) vn = ds / dt;
      brake[i] = acc[i] < -0.9 || vn < 0.25 ? 1 : 0;
      v[i] = vn;
      s[i] += ds;
      odo[i] += ds;
      if (g0 < nL && !committed[i] && lanes[g0].stopS - s[i] < 4 && vn < 0.5) wait[i] += dt;
      while (s[i] >= segLen[seg[i]]) {
        const g = seg[i];
        s[i] -= segLen[g];
        prev2[i] = prev1[i];
        prev1[i] = g;
        if (g < nL) {
          seg[i] = nL + next[i];
          next[i] = choose(i, conns[next[i]].toLane);
        } else {
          const to = conns[g - nL].toLane;
          seg[i] = to;
          reserved[to] -= need[i];
          committed[i] = 0;
        }
      }
      // release the oldest grant once the rear is off its connector
      const h = hold0[i];
      if (h >= 0 && seg[i] === conns[h].toLane && s[i] >= len[i]) {
        hold0[i] = hold1[i];
        seq0[i] = seq1[i];
        hold1[i] = -1;
      }
      // turn signal: the last 18 m before a turn, and through it
      const g = seg[i];
      const t = g < nL ? (segLen[g] - s[i] < 18 ? conns[next[i]].turn : 'straight') : conns[g - nL].turn;
      signal[i] = t === 'left' ? 1 : t === 'right' ? -1 : 0;
    }

    // 5. crossings: every zebra a body still covers (front segment and the up to two behind it),
    // until its REAR is CROSS_PAD past the strip (a bus's tail mid-turn included), plus the zebras
    // a granted vehicle is about to cross
    if (blocked) {
      blocked.fill(0);
      for (let i = 0; i < N; i++) {
        let g = seg[i];
        let hi = s[i];
        let lo = hi - len[i];
        for (let k = 0; ; k++) {
          if (g < nL) {
            cover(blocked, xStart[g], xStartS[g], lo, k ? hi : 1e9); // the front lane's: ahead of it too
            cover(blocked, xEnd[g], xEndS[g], lo, hi);
          }
          if (lo >= 0 || k === 2) break;
          g = k === 0 ? prev1[i] : prev2[i];
          hi = segLen[g];
          lo += hi;
        }
        g = seg[i];
        const x = g < nL ? (committed[i] ? xStart[conns[next[i]].toLane] : -1) : xStart[conns[g - nL].toLane];
        if (x >= 0) blocked[x] = 1;
        if (g < nL && committed[i] && xEnd[g] >= 0) blocked[xEnd[g]] = 1;
      }
    }

    pfx.set(fx);
    pfz.set(fz);
    prx.set(rx);
    prz.set(rz);
    poses();
  }

  reset();
  return {
    n: N,
    kind,
    seg,
    s,
    v,
    acc,
    odo,
    fx,
    fz,
    rx,
    rz,
    pfx,
    pfz,
    prx,
    prz,
    signal,
    brake,
    next,
    nLanes: nL,
    reset,
    step,
    setObstacle,
    path: (g) => segPath[g],
    pointBack,
  };
}

/**
 * Body poses (cx, cz, ux, uz) of a vehicle of kind k whose front runs along connector c from s = 0
 * in STEP m steps (its approach and exit lanes included, so the swing in and out of the turn shows).
 */
const STEP = 0.5;
function sweep(plan: CityPlan, c: number, k: VehicleKind): number[] {
  const cn = plan.connectors[c];
  const fl = plan.lanes[cn.fromLane].path;
  const tl = plan.lanes[cn.toLane].path;
  const L = cn.path.length;
  const oh = (k.len - k.wheelbase) / 2;
  const ps: PathSample = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  const out: number[] = [];
  let fx = 0;
  let fz = 0;
  for (let s = 0; s <= L + k.len; s += STEP) {
    for (let e = 0; e < 2; e++) {
      const d = s - oh - e * k.wheelbase;
      ps.i = 0;
      if (d < 0) sampleAt(fl, Math.max(0, fl.length + d), ps);
      else if (d > L) sampleAt(tl, Math.min(tl.length, d - L), ps);
      else sampleAt(cn.path, d, ps);
      if (e === 0) {
        fx = ps.x;
        fz = ps.z;
      }
    }
    const dx = fx - ps.x;
    const dz = fz - ps.z;
    const l = hyp(dx, dz) || 1;
    out.push((fx + ps.x) / 2, (fz + ps.z) / 2, dx / l, dz / l);
  }
  return out;
}

/**
 * Connector pairs A2 does not list as conflicts (centrelines ≥ VEHICLE_CLEARANCE apart) whose
 * BODIES can still touch: a bus off-tracks and swings its overhangs through a turn, so two buses
 * turning right from neighbouring arms 3.2 m apart collide. Sweeps a bus-sized box along both and
 * adds every touching pair to `conflicts`, with its zone from the touching poses: zoneStart = the
 * first front position on c, zoneEnd = the last rear position on h. Returns the pair keys (h·nC + c).
 */
function bodyConflicts(plan: CityPlan, bus: number[][], conflicts: number[][], zoneStart: Float32Array, zoneEnd: Float32Array): Set<number> {
  const conns = plan.connectors;
  const nC = conns.length;
  const B = KINDS[3];
  const hl = B.len / 2 + 0.1;
  const hw = B.width / 2 + 0.15;
  const near = { dist: 0, s: 0 };
  const touch = (a: number[], i: number, b: number[], j: number) => {
    const dx = b[j] - a[i];
    const dz = b[j + 1] - a[i + 1];
    if (dx * dx + dz * dz > 4 * (hl * hl + hw * hw)) return false;
    for (let k = 0; k < 4; k++) {
      const P = k < 2 ? a : b;
      const o = k < 2 ? i : j;
      const ax = k & 1 ? -P[o + 3] : P[o + 2];
      const az = k & 1 ? P[o + 2] : P[o + 3];
      const ra = hl * Math.abs(a[i + 2] * ax + a[i + 3] * az) + hw * Math.abs(-a[i + 3] * ax + a[i + 2] * az);
      const rb = hl * Math.abs(b[j + 2] * ax + b[j + 3] * az) + hw * Math.abs(-b[j + 3] * ax + b[j + 2] * az);
      if (Math.abs(dx * ax + dz * az) > ra + rb) return false;
    }
    return true;
  };
  const keys = new Set<number>();
  for (const a of conns) {
    for (const b of conns) {
      if (b.id <= a.id || b.node !== a.node || b.fromLane === a.fromLane || conflicts[a.id].includes(b.id)) continue;
      // cheap prefilter: centrelines within a bus width plus its swing
      let md = 1e9;
      for (let k = 0; k < a.path.pts.length >> 1; k++) md = Math.min(md, nearestOn(b.path, a.path.pts[k * 2], a.path.pts[k * 2 + 1], near));
      if (md > 4.2) continue;
      const A = bus[a.id];
      const Bp = bus[b.id];
      let aFirst = 1e9;
      let aLast = -1e9;
      let bFirst = 1e9;
      let bLast = -1e9;
      for (let i = 0; i < A.length; i += 4)
        for (let j = 0; j < Bp.length; j += 4) {
          if (!touch(A, i, Bp, j)) continue;
          const sa = (i / 4) * STEP;
          const sb = (j / 4) * STEP;
          aFirst = Math.min(aFirst, sa);
          aLast = Math.max(aLast, sa - B.len);
          bFirst = Math.min(bFirst, sb);
          bLast = Math.max(bLast, sb - B.len);
        }
      if (aFirst > 1e8) continue;
      conflicts[a.id].push(b.id);
      conflicts[b.id].push(a.id);
      zoneStart[a.id * nC + b.id] = Math.max(0, aFirst - 0.6);
      zoneStart[b.id * nC + a.id] = Math.max(0, bFirst - 0.6);
      zoneEnd[a.id * nC + b.id] = aLast + 0.6;
      zoneEnd[b.id * nC + a.id] = bLast + 0.6;
      keys.add(a.id * nC + b.id).add(b.id * nC + a.id);
    }
  }
  return keys;
}

/** True if any body corner of the sweep leaves the carriageway (road / junction patch); 5 cm stricter than the spec, which samples between these poses. */
function offRoad(index: CityIndex, P: number[], k: VehicleKind): boolean {
  const hl = k.len / 2;
  const hw = k.width / 2;
  for (let i = 0; i < P.length; i += 4) {
    for (let q = 0; q < 4; q++) {
      const a = q & 1 ? hl : -hl;
      const b = q & 2 ? hw : -hw;
      const g = index.classify(P[i] + P[i + 2] * a - P[i + 3] * b, P[i + 1] + P[i + 3] * a + P[i + 2] * b);
      if (g !== 'road' && g !== 'intersection') return true;
    }
  }
  return false;
}

/** IDM acceleration toward an obstacle `gap` m ahead (bumper to bumper) moving at vl. */
function idm(vi: number, vmax: number, am: number, gap: number, vl: number): number {
  const ss = S0 + Math.max(0, vi * T_HEAD + (vi * (vi - vl)) / (2 * Math.sqrt(am * B)));
  const q = ss / Math.max(gap, 0.05);
  return am * (1 - Math.pow(vi / Math.max(vmax, 0.1), 4) - q * q);
}

function hashU(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
