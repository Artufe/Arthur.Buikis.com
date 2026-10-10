// LITTLEBIG v2 transit simulation (V1): the region's fleet on R1's world-space lanes and connectors.
// Pure TS, no three.js, zero allocation per step. The capital's sim (traffic/sim.ts) carried over to
// the region's graph and grown where it needs more:
//
//   - a vehicle is a front-bumper arc `s` on one segment (a lane or a connector), the segments its
//     body still spans (a history), and a PLAN: the turns ahead, chosen as it comes to them;
//   - car-following (IDM) against the nearest obstacle along the plan: the leader (also one that
//     forked onto a sibling turn with its rear still at the fork), the first stop line it holds no
//     grant for, the entry of a conflict zone still held by a vehicle granted before it, a bus stop,
//     the walking player; the speed profile brakes it into bends (net.ts);
//   - junction grants as the capital's: one asker per lane (the front-most vehicle that holds no grant
//     for that lane's end, already on it or still on the turn into it), highest score first
//     (priority + time waited). A grant needs room for the whole body on the exit lane, no busy
//     crossing on the way, the player not in it, and every earlier-granted vehicle on a conflicting
//     turn out of the shared zone before this one can reach it (refused only by those, it claims the
//     conflicts so lower scores cannot starve it). NEW: an exit lane too short to wait in is granted
//     together with the turn out of it (a chain), so nobody waits with its tail in a junction; on a
//     curve too tight for it to pass oncoming traffic (net.ts `single`) a truck or a bus meets no one;
//   - integration with hard clamps to the leader's rear, the stop line, the zone entry and the bus
//     stop, so bodies never overlap by construction; grants are released once the rear is off;
//   - `blocked` for every town crossing a body covers, the one on the street a vehicle in a junction
//     is turning into, those a granted vehicle is about to cross, and one a vehicle has waited at for
//     CLAIM_T (people stop stepping on; those on it finish); and if people are on a crossing ahead all
//     the same (a frame's race), it stops short of them, granted or not.
//
// Deadlock: the capital's argument (a granted vehicle waits only for those granted before it and its
// leaders) no longer covers everything the region adds — swings over stop lines, single-file runs,
// chains through towns — so waits are broken explicitly, and the specs drive an hour without a stall
// past MAX_STALL: one refused STARVE s claims its whole way and exit from newcomers, whatever refuses
// it (`starve`), and shuts the turns that swing over its way's start; refused GIVE_UP s, it tries
// another turn out, one open now and not far out of its way (DETOUR); a ring of up to RING waiting on
// each other's room all go (`swapRoom`); one standing on a holder's way goes before it (`aheadOn`), as
// does one through and clear before a far-off holder could come; nobody takes a lane someone is
// granted through without a place to stop in it; walkers that never stop by the claim.
//
// Routes: cars and trucks roam their land mass with a destination town (sim `choose`: weighted by the
// turn, the road, and the time to the town, routes.ts), wander its streets a while — keeping to those
// that lead back into it, not up dead ends — then pick another (home more often than not), each town
// taking as many at once as its streets hold (CAP_M). Trucks keep to the streets they can stop in.
// Buses run their line's stops in order and wait at each with the doors open.

import { KINDS } from '../traffic/sim';
import { R } from '../world/config';
import { hash3 } from '../world/rng';
import type { Vec3 } from '../world/sphere';
import { CHAIN_MAX, CHAIN_OF, type Net } from './net';
import { kindClass, type Routes } from './routes';

// ── tuning (the capital's, traffic/sim.ts) ──
const B = 2.6;
const T_HEAD = 0.9;
const S0 = 1.7;
const MIN_GAP = 0.5;
const ROOM = 1.8;
const BUS_ROOM = 0.7;
const LOOK = 55;
const SIB_RANGE = 7;
const REQ_MARGIN = 2.0;
const REQ_T = 1.0;
const AGING = 1.5;
/** A bus's head start in the grant order (s of waiting): its long body needs the room and the turns first. */
const BUS_FIRST = 30;
const REROUTE_AFTER = 1.2;
/** Seconds refused before a vehicle's claims close the lanes it waits on to others (sim `starve`). */
const STARVE = 8;
const NONE: readonly number[] = [];
/** Seconds refused before it gives up on its way and tries the next turn out instead. */
const GIVE_UP = 15;
/** Longest ring of vehicles waiting on each other's room that all go at once (sim `swapRoom`). */
const RING = 4;
/** Seconds out of its way a vehicle takes another turn for (a full exit, giving up once). */
const DETOUR = 12;
const CROSS_PAD = 0.6;
const ZONE_MARGIN = 0.6;
/** Fastest anyone drives (m/s) and the margin (s) a turn taken ahead of a far-off holder keeps. */
const V_TOP = 24;
const FAR_MARGIN = 3;
const ZEBRA_REROUTE = 4;
const OB_R = 0.45;
// ── V1 ──
/** Seconds waiting at a busy crossing before claiming it (blocked: nobody new steps on). */
const CLAIM_T = 5;
/** Seconds a bus stands at a stop, doors open. */
export const DWELL = 7;
/** Seconds of extra travel time that halve a turn's appeal on the way to a destination. */
const TAU = 5;
/** The same round its town: a way out and back (a dead-end spur) is a rare drive. */
const TAU_ROAM = 3;
/** Chance a car's next destination is home, and its stay in a town (lanes driven), min + up to. */
const P_HOME = 0.55;
/** A truck's liking for a turn into a lane too short or narrow for it to wait in (it keeps to the wider streets). */
const TRUCK_THRU = 0.1;
/** Metres to spare (past its body) on a lane a truck likes to wait in. */
const TRUCK_SPARE = 4;
/** A turn's liking into a dead end (it is only driven up to turn round). */
const DEAD_END = 0.15;
/** Metres of a town's lanes (a car may wait in) per vehicle headed there at once. */
const CAP_M = 22;

const HN = 8; // segment history per vehicle
const PM = 18; // plan length
const HM = 20; // held grants
const LK = 14; // single-file lanes a truck or bus holds

export interface TransitSim {
  readonly n: number;
  readonly net: Net;
  readonly routes: Routes;
  readonly kind: Uint8Array;
  readonly seg: Int32Array;
  readonly s: Float64Array;
  readonly v: Float64Array;
  readonly acc: Float64Array;
  readonly odo: Float64Array;
  /** World positions (xyz) after the last step and before it: front axle, rear axle, body centre (the path between the axles). */
  readonly F: Float64Array;
  readonly Rr: Float64Array;
  readonly C: Float64Array;
  readonly pF: Float64Array;
  readonly pRr: Float64Array;
  readonly pC: Float64Array;
  /** +1 left, −1 right, 0 off; brake light; a bus's doors open. */
  readonly signal: Int8Array;
  readonly brake: Uint8Array;
  readonly door: Uint8Array;
  /** Destination town (−1 none) and, for a bus, the index of its next stop on its line. */
  readonly dest: Int16Array;
  readonly stop: Int16Array;
  /** Bus stops served (per vehicle): a counter for specs and cards. */
  readonly served: Int32Array;
  /** The connector at the end of the lane it is on (on a connector: after the next lane), −1 if not planned. */
  next(i: number): number;
  reset(): void;
  step(dt: number, busy: Uint8Array | null, blocked: Uint8Array | null): void;
  /** The walking player at unit `dir` (or off): vehicles stop short of it, no grant through it. */
  setObstacle(on: boolean, dir: Vec3 | null): void;
  /** Specs: one vehicle's state as a line (why it waits: the refusal codes in `grant`). */
  dump(i: number): string;
}

export function createTransitSim(net: Net, routes: Routes, seed: number): TransitSim {
  const { nL, nC, len: segLen, path, hs, prof, entry, from, to, stopS, xEnd, xEndS, xStart, xStartS, cfOff, cf, cfZS, cfZE, cfZF, ok, wait: canWait, hops, like: likeC, laneTown } = net;
  const lanes = net.region.lanes;
  const conns = net.region.connectors;
  const nX = net.crossings.length;
  const xHalf = Float64Array.from(net.crossings, (x) => x.width / 2);
  const prio = Float64Array.from(conns, (c) => c.priority);
  const { opp, single, swOff, swLane, swX, ssOff, ssLane, ssY, keep, keepT } = net;
  // start swings by the lane swept (kind class · nC + connector): nobody new into a lane whose start a
  // held turn still swings over
  const dsOff = new Int32Array(nL + 1);
  for (let e = 0; e < ssLane.length; e++) dsOff[ssLane[e] + 1]++;
  for (let l = 0; l < nL; l++) dsOff[l + 1] += dsOff[l];
  const dsT = new Int32Array(ssLane.length);
  {
    const fill = dsOff.slice(0, nL);
    for (let kc = 0; kc < 3; kc++)
      for (let c = 0; c < nC; c++) for (let e = ssOff[kc * (nC + 1) + c]; e < ssOff[kc * (nC + 1) + c + 1]; e++) dsT[fill[ssLane[e]]++] = kc * nC + c;
  }
  const uturn = Uint8Array.from(conns, (c) => (c.turn === 'uturn' ? 1 : 0));
  const N = routes.kind.length;
  const kind = routes.kind;
  const K = KINDS.length;
  const len = Float64Array.from(kind, (k) => KINDS[k].len);
  const oh = Float64Array.from(kind, (k) => (KINDS[k].len - KINDS[k].wheelbase) / 2);
  const wb = Float64Array.from(kind, (k) => KINDS[k].wheelbase);
  const need = Float64Array.from(kind, (k) => KINDS[k].len + (k === 3 ? BUS_ROOM : ROOM));
  const aMax = Float64Array.from(kind, (k) => KINDS[k].accel);
  const vK = Float64Array.from(kind, (k, i) => KINDS[k].speedK * (0.92 + 0.14 * hash3(seed, i, 3)));
  const big = Uint8Array.from(kind, (k) => (k >= 2 ? 1 : 0));
  const line = routes.line;

  // ── state ──
  const seg = new Int32Array(N);
  const s = new Float64Array(N);
  const v = new Float64Array(N);
  const acc = new Float64Array(N);
  const odo = new Float64Array(N);
  const tot = new Float64Array(N);
  const hist = new Int32Array(N * HN);
  const hTop = new Int32Array(N);
  const plan = new Int32Array(N * PM);
  const pN = new Uint8Array(N);
  const gN = new Uint8Array(N);
  const hc = new Int32Array(N * HM);
  const hSeq = new Float64Array(N * HM);
  const hS0 = new Float64Array(N * HM);
  const hN = new Uint8Array(N);
  let seqN = 0;
  const res = new Int32Array(N * 2);
  const waitT = new Float64Array(N);
  const zw = new Float64Array(N);
  /** Seconds refused by a busy crossing (the lane's own or the exit's), and which one. */
  const xw = new Float64Array(N);
  const xwId = new Int32Array(N);
  const rng = new Uint32Array(N);
  const signal = new Int8Array(N);
  const brake = new Uint8Array(N);
  const door = new Uint8Array(N);
  const dwellT = new Float64Array(N);
  const leaveT = new Float64Array(N);
  /** A bus has served the stop on the lane it is still on (a line of one stop: round the block before the next). */
  const away = new Uint8Array(N);
  const dest = new Int16Array(N);
  const stay = new Int16Array(N);
  /**
   * Per town: how many are headed there or round it, and how many its streets take (CAP_M metres of lane
   * a car may wait in each): a harbour town of narrow lanes fills like a village, and the rest go elsewhere.
   */
  /** Lanes a truck waits in with room to spare (it keeps to these: the city's short core streets fill with cars). */
  const roomy = Uint8Array.from({ length: nL }, (_, l) => (canWait[2 * nL + l] && stopS[l] - keepT[l] >= KINDS[2].len + TRUCK_SPARE ? 1 : 0));
  /** Lanes that only lead back the way they came (a U-turn at a dead end: one car at a time up there). */
  const deadEnd = Uint8Array.from(lanes, (l) => (l.next.every((c) => conns[c].turn === 'uturn') ? 1 : 0));
  const destN = new Int16Array(routes.nT);
  const townCap = new Int16Array(routes.nT);
  {
    const m = new Float64Array(routes.nT);
    for (let l = 0; l < nL; l++) if (laneTown[l] >= 0 && canWait[l]) m[laneTown[l]] += stopS[l];
    for (let t = 0; t < routes.nT; t++) townCap[t] = Math.max(2, Math.floor(m[t] / CAP_M));
  }
  const stop = new Int16Array(N);
  const served = new Int32Array(N);
  const F = new Float64Array(N * 3);
  const Rr = new Float64Array(N * 3);
  const C = new Float64Array(N * 3);
  const pF = new Float64Array(N * 3);
  const pRr = new Float64Array(N * 3);
  const pC = new Float64Array(N * 3);
  // ── scratch ──
  const nS = net.nS;
  const head = new Int32Array(nS);
  const link = new Int32Array(N);
  const holdHead = new Int32Array(nC);
  const holdLink = new Int32Array(N * HM);
  const tail = new Float64Array(nL);
  const reserved = new Float64Array(nL);
  const occ = new Uint8Array(nL);
  const occBig = new Uint8Array(nL);
  /** Someone holds a grant into this lane (a chain through it, or it as the exit). */
  const thru = new Uint8Array(nL);
  /** Lanes someone is granted through without a place to stop in them (a chain's inner lanes). */
  const passing = new Uint8Array(nL);
  const asker = new Int32Array(nL);
  const askD = new Float64Array(nL);
  const claim = new Int32Array(nC);
  const full = new Int32Array(nL);
  const narrowClaim = new Int32Array(nL);
  /**
   * Starving (refused STARVE s): a lane it needs drained (its exit's room, a stop line or a lane start
   * its turn swings over) is closed to everyone else's grants until it goes (inWho: who claimed it).
   */
  const inClaim = new Int32Array(nL);
  const inWho = new Int32Array(nL);
  const giveN = new Uint8Array(N);
  const whyBy = new Int32Array(N);
  /**
   * Swings (net.ts): while a truck or a bus holds a turn that would touch a body waiting at lane l's stop
   * line, everyone coming up lane l stops at capA[l] instead (a stationary obstacle); capC is a turn's
   * claim on it while it waits for the stop line to clear (capT: the step it was claimed).
   */
  const capA = new Float64Array(nL);
  /** Whose turn set capA (its own swing never stops itself: a chain round a block). */
  const capW = new Int32Array(nL);
  const capC = new Float64Array(nL);
  const capT = new Int32Array(nL);
  /** Narrow lanes closed to oncoming traffic by trucks and buses in the section (a count), and each one's list. */
  const lockN = new Int16Array(nL);
  const lk = new Int32Array(N * LK);
  const lkN = new Uint8Array(N);
  const lkEnd = new Float64Array(N * LK);
  const secEnd = new Float64Array(LK);
  const sec = new Int32Array(LK);
  let stamp = 0;
  const req = new Int32Array(N);
  const score = new Float64Array(N);
  const leadGap = new Float64Array(N);
  const leadV = new Float64Array(N);
  const zoneGap = new Float64Array(N);
  const stopGap = new Float64Array(N);
  const stopLane = new Int32Array(N);
  const busGap = new Float64Array(N);
  /** A bus with its stop still ahead on its stop lane (or standing at it): it does not ask yet. */
  const hold = new Uint8Array(N);
  /** Specs: why a grant was last refused (a code per return in grant). */
  const why = new Uint8Array(N);
  /** Refused by a busy crossing this step. */
  const xHit = new Uint8Array(N);
  const chain = new Int32Array(CHAIN_MAX + 1);
  const chainAt = new Float64Array(CHAIN_MAX + 1);
  // the player: up to 8 segments it stands on (arc position, lateral distance)
  const obSeg = new Int32Array(8);
  const obS = new Float64Array(8);
  const obD = new Float64Array(8);
  let obN = 0;
  const ob = { x: 9, y: 9, z: 9 };

  const rand = (i: number) => {
    let a = (rng[i] = (rng[i] + 0x6d2b79f5) >>> 0);
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  };
  /** Room on lane l for kind k (a truck's rear keeps clear of the big turns' swings too, net.ts keepT). */
  const room = (l: number, k: number) => tail[l] - reserved[l] - (k === 2 ? keepT : keep)[l];
  /**
   * Room on lane l for vehicle i coming round back onto it (a roundabout, a block): by then the others
   * waiting on it will have closed up to its stop line.
   */
  const roomBut = (i: number, l: number) => {
    let t = emptyTail(l);
    for (let u = head[l]; u >= 0; u = link[u]) if (u !== i && gN[u] === 0) t -= len[u] + S0;
    return t - reserved[l] - (kind[i] === 2 ? keepT : keep)[l];
  };
  const emptyTail = (l: number) => stopS[l] + ROOM - 0.2;
  /** The lane whose end plan[k] leaves from (k = 0: the lane it is on, or turning onto). */
  const laneBefore = (i: number, k: number) => (k > 0 ? to[plan[i * PM + k - 1]] : seg[i] < nL ? seg[i] : to[seg[i] - nL]);
  /** Distance from i's front to the start of plan[k]. */
  const ahead = (i: number, k: number) => {
    const g = seg[i];
    let d = segLen[g] - s[i];
    if (g >= nL) d += segLen[to[g - nL]];
    for (let j = 0; j < k; j++) {
      const c = plan[i * PM + j];
      d += segLen[nL + c] + segLen[to[c]];
    }
    return d;
  };

  // ── routes ──
  const T = routes.toTown;
  const nT = routes.nT;
  /** The table state of lane m entered `depth` lanes into a chain (routes.ts): 0 where its class may wait, else depth + 1. */
  const TK = [0, 2, 3];
  const depOf = (cls: number, m: number, depth: number) => (canWait[TK[cls] * nL + m] ? 0 : depth + 1);
  /** Seconds to go from the end of a lane `depth` into a chain via connector c into town t (kind class cls). */
  const via = (cls: number, t: number, c: number, depth: number) => {
    const m = to[c];
    const base = segLen[nL + c] / 4;
    if (laneTown[m] === t && canWait[TK[cls] * nL + m]) return base;
    const dp = depOf(cls, m, depth);
    return dp >= CHAIN_MAX ? Infinity : base + segLen[m] / Math.max(2, lanes[m].speed) + T[((cls * nT + t) * nL + m) * CHAIN_MAX + dp];
  };
  /** Seconds from the end of the lane connector c leads into back into town t (it may lie in t). */
  const back = (cls: number, t: number, c: number, depth: number) => {
    const m = to[c];
    const dp = depOf(cls, m, depth);
    return dp >= CHAIN_MAX ? Infinity : T[((cls * nT + t) * nL + m) * CHAIN_MAX + dp];
  };
  const viaStop = (key: number, target: number, c: number, depth: number) => {
    const m = to[c];
    const base = segLen[nL + c] / 4;
    if (m === target) return base;
    const dp = depOf(2, m, depth);
    return dp >= CHAIN_MAX ? Infinity : base + segLen[m] / Math.max(2, lanes[m].speed) + routes.toStop[(key * nL + m) * CHAIN_MAX + dp];
  };
  /** Bus i's next stop from the end of `lane` (its plan's first `upto` turns lead there): the one after, if it passes its next before. */
  function stopAfter(i: number, lane: number, upto: number) {
    const ln = routes.lines[line[i]];
    const q = stop[i];
    const sl = ln.stops[q].lane;
    let passes = sl === lane || (seg[i] < nL ? seg[i] : to[seg[i] - nL]) === sl;
    for (let k = 0; k < upto && !passes; k++) passes = to[plan[i * PM + k]] === sl;
    return passes ? (q + 1) % ln.stops.length : q;
  }
  /** Seconds from the end of `lane` (i's stop lane, its plan's first k0 turns leading there) via c to where i is headed (0: anywhere). */
  function wayCost(i: number, lane: number, c: number, k0: number) {
    if (line[i] >= 0) {
      const q = stopAfter(i, lane, k0);
      return viaStop(routes.stopKey[line[i]][q], routes.lines[line[i]].stops[q].lane, c, 0);
    }
    const d = dest[i];
    if (d < 0) return 0;
    const cls = kindClass(kind[i]);
    return laneTown[lane] === d ? back(cls, d, c, 0) : via(cls, d, c, 0);
  }
  /** Turn at the end of `lane`, `depth` lanes into a chain of lanes too short for this kind. */
  function choose(i: number, lane: number, depth: number): number {
    const k = kind[i];
    const nx = lanes[lane].next;
    let best = Infinity;
    let first = -1;
    // a bus: the quickest way to its next stop (the one after, if this lane is the next stop's)
    if (line[i] >= 0) {
      const q = stopAfter(i, lane, pN[i]);
      const key = routes.stopKey[line[i]][q];
      const target = routes.lines[line[i]].stops[q].lane;
      for (let j = 0; j < nx.length; j++) {
        const c = nx[j];
        if (!usable(k, c, depth)) continue;
        const t = viaStop(key, target, c, depth);
        if (t < best || first < 0) {
          best = t;
          first = c;
        }
      }
      return first >= 0 ? first : nx[0];
    }
    const cls = kindClass(k);
    let d = dest[i];
    const inDest = d >= 0 && laneTown[lane] === d;
    // (round its town: a lane whose way on leaves it, the way back a long one, only where nothing better)
    if (d >= 0) for (let j = 0; j < nx.length; j++) if (usable(k, nx[j], depth)) best = Math.min(best, inDest ? back(cls, d, nx[j], depth) : via(cls, d, nx[j], depth));
    if (best === Infinity && !inDest) d = -1;
    let tot2 = 0;
    for (let pass = 0; pass < 2; pass++) {
      let r = pass ? rand(i) * tot2 : 0;
      for (let j = 0; j < nx.length; j++) {
        const c = nx[j];
        if (!usable(k, c, depth)) continue;
        if (first < 0) first = c;
        let w = likeC[c] * (canWait[k * nL + to[c]] ? (room(to[c], k) < need[i] ? 0.08 : 1) : 1) * (k === 2 && !roomy[to[c]] ? TRUCK_THRU : 1) * (deadEnd[to[c]] ? DEAD_END : 1);
        if (d < 0 && laneTown[to[c]] >= 0 && laneTown[to[c]] !== laneTown[lane] && destN[laneTown[to[c]]] >= townCap[laneTown[to[c]]]) w *= 0.05; // (headed nowhere: not into a full town)
        else if (d >= 0 && !inDest) w *= Math.exp(-(via(cls, d, c, depth) - best) / TAU);
        else if (inDest && laneTown[to[c]] !== d && stay[i] > 0) w = 0; // (round the town a while: out of it only where no turn stays in)
        else if (inDest && best < Infinity) w *= Math.exp(-(back(cls, d, c, depth) - best) / TAU_ROAM);
        if (!pass) tot2 += w;
        else if (w > 0 && (r -= w) <= 0) return c;
      }
    }
    return first >= 0 ? first : nx[0];
  }
  const usable = (k: number, c: number, depth: number) => ok[k * nC + c] === 1 && (canWait[k * nL + to[c]] === 1 || hops[k * nL + to[c]] <= CHAIN_OF[k] - 1 - depth);
  /** Extend i's plan to at least `want` turns. */
  function extend(i: number, want: number) {
    while (pN[i] < want && pN[i] < PM) {
      const lane = laneBefore(i, pN[i]);
      // how deep into a chain of short lanes this lane is
      let depth = 0;
      for (let j = pN[i] - 1; j >= 0 && !canWait[kind[i] * nL + to[plan[i * PM + j]]]; j--) depth++;
      plan[i * PM + pN[i]] = choose(i, lane, depth);
      pN[i]++;
    }
  }
  /** Drop the plan from index k on (never a granted entry). */
  const truncate = (i: number, k: number) => {
    if (pN[i] > k) pN[i] = Math.max(k, gN[i]);
  };
  /** Can class cls get from the end of lane into town t? (Its own town too: it drives round it a while.) */
  function reach(cls: number, lane: number, t: number) {
    if (t === laneTown[lane]) return true;
    const o = ((cls * nT + t) * nL + lane) * CHAIN_MAX;
    const w = canWait[TK[cls] * nL + lane];
    for (let dp = w ? 0 : 1; dp < (w ? 1 : CHAIN_MAX); dp++) if (T[o + dp] < Infinity) return true;
    return false;
  }
  /** Can i head for town t (reachable, wanted, and not as many already headed there as its streets take)? */
  const open = (cls: number, lane: number, t: number) => routes.draw[t] > 0 && destN[t] < townCap[t] && reach(cls, lane, t);
  function newDest(i: number) {
    const lane = seg[i] < nL ? seg[i] : to[seg[i] - nL];
    const comp = routes.towns[net.laneComp[lane]] ?? NONE;
    const cls = kindClass(kind[i]);
    if (dest[i] >= 0) destN[dest[i]]--;
    let d = routes.home[i];
    // (home more often than not; else a town by its draw; none with room: it drives on and asks again)
    if (!(destN[d] < townCap[d] && reach(cls, lane, d)) || rand(i) > P_HOME) {
      let tw = 0;
      for (let j = 0; j < comp.length; j++) if (open(cls, lane, comp[j])) tw += routes.draw[comp[j]];
      let r = rand(i) * tw;
      d = -1;
      for (let j = 0; j < comp.length && tw > 0; j++) {
        const t = comp[j];
        if (open(cls, lane, t) && (r -= routes.draw[t]) <= 0) {
          d = t;
          break;
        }
      }
    }
    dest[i] = d;
    if (d >= 0) destN[d]++;
    stay[i] = (kind[i] === 2 ? 2 : 4) + Math.floor(rand(i) * 9);
  }

  // ── geometry ──
  /** World position of segment g at arc d (the drawn road surface) into out[o..o+2]. */
  function sampleSeg(g: number, d: number, out: Float64Array, o: number) {
    const p = path[g];
    const S = p.s;
    const n = S.length;
    if (d <= 0) d = 0;
    else if (d >= S[n - 1]) d = S[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (S[m] <= d) lo = m;
      else hi = m;
    }
    const sg = S[hi] - S[lo];
    const f = sg > 1e-9 ? (d - S[lo]) / sg : 0;
    const D = p.dir;
    let x = D[lo * 3] + (D[hi * 3] - D[lo * 3]) * f;
    let y = D[lo * 3 + 1] + (D[hi * 3 + 1] - D[lo * 3 + 1]) * f;
    let z = D[lo * 3 + 2] + (D[hi * 3 + 2] - D[lo * 3 + 2]) * f;
    const H = hs[g];
    const r = (R + H[lo] + (H[hi] - H[lo]) * f) / (Math.sqrt(x * x + y * y + z * z) || 1);
    out[o] = x * r;
    out[o + 1] = y * r;
    out[o + 2] = z * r;
  }
  /** The point `back` m behind i's front along its body's segments into out[o..]. */
  function pointBack(i: number, back: number, out: Float64Array, o: number) {
    let d = s[i] - back;
    let g = seg[i];
    for (let k = 1; d < 0 && k <= HN; k++) {
      g = hist[i * HN + ((hTop[i] - k) & (HN - 1))];
      d += segLen[g];
    }
    sampleSeg(g, d, out, o);
  }
  function poses() {
    for (let i = 0; i < N; i++) {
      pointBack(i, oh[i], F, i * 3);
      pointBack(i, oh[i] + wb[i], Rr, i * 3);
      pointBack(i, oh[i] + wb[i] / 2, C, i * 3);
    }
  }

  // ── conflicts ──
  /**
   * Distance from i's front to the nearest zone entry on its held connector c (whose start is
   * `toStart` ahead) still occupied by a vehicle granted before it (seq sq), or 1e9.
   */
  function zoneBlock(i: number, c: number, sq: number, toStart: number): number {
    let best = 1e9;
    for (let k = cfOff[c]; k < cfOff[c + 1]; k++) {
      const h = cf[k];
      for (let e = holdHead[h]; e >= 0; e = holdLink[e]) {
        const j = (e / HM) | 0;
        if (j === i || hSeq[e] > sq) continue;
        if (tot[j] - len[j] - hS0[e] >= cfZE[k] && tot[j] - hS0[e] >= cfZF[k]) continue;
        const d = toStart + cfZS[k];
        if (d > -0.05 && d < best) best = d;
      }
    }
    return best;
  }
  /**
   * Is i on j's granted way, ahead of it? Then j gets nowhere past it before it moves on: i goes first
   * through what j holds (it takes a turn in the order before j's: `firstSeq`).
   */
  function aheadOn(j: number, i: number) {
    const gi = seg[i];
    if (seg[j] === gi) return s[i] > s[j];
    let g = seg[j];
    if (g >= nL) {
      g = to[g - nL];
      if (g === gi) return true;
    }
    for (let k = 0; k < gN[j]; k++) {
      const c = plan[j * PM + k];
      if (nL + c === gi || to[c] === gi) return true;
    }
    return false;
  }
  /** The lane i's next grant would end in (the first of its plan it may wait in), or −1. */
  function finLane(i: number) {
    for (let k = gN[i]; k < pN[i]; k++) {
      const t = to[plan[i * PM + k]];
      if (canWait[kind[i] * nL + t]) return t;
    }
    return -1;
  }
  /**
   * A ring kept waiting on each other's room (two on a roundabout, three or four round a block, each
   * wanting the lane the next stands on): i goes, room or not (each goes on into the lane the one
   * before it leaves).
   */
  function swapRoom(i: number, fin: number, m: number) {
    if (waitT[i] < STARVE) return false;
    let f = fin;
    for (let hop = 0; hop < RING; hop++) {
      const u = asker[f];
      // (not round a U-turn: one at a time on it, the ring would not all go)
      if (u < 0 || u === i || !(why[u] === 3 || why[u] === 4) || waitT[u] <= 2 || (hop > 0 && gN[u] < pN[u] && uturn[plan[u * PM + gN[u]]])) return false;
      f = finLane(u);
      if (f === m) return true;
      if (f < 0) return false;
    }
    return false;
  }
  /** The room on lane l reserved by vehicles i is ahead of on their way (it gets there first). */
  function resBehind(i: number, l: number) {
    if (reserved[l] < 1e-9) return 0;
    let r = 0;
    for (let j = 0; j < N; j++) if ((res[j * 2] === l || res[j * 2 + 1] === l) && j !== i && aheadOn(j, i)) r += need[j];
    return r;
  }
  let firstSeq = Infinity;
  let tieN = 0;
  /** Who a refused zonesClear waits for. */
  let zoneBy = -1;
  /** Seconds for i to have its rear off connector c (start `toStart` ahead), at its best from here. */
  function clearTime(i: number, c: number, toStart: number) {
    const dist = toStart + segLen[nL + c] + len[i];
    const vi = v[i];
    const ai = aMax[i];
    const vc = Math.max(3, entry[nL + c]);
    if (vi >= vc) return dist / vc;
    const t1 = (vc - vi) / ai;
    const d1 = ((vi + vc) / 2) * t1;
    return dist <= d1 ? (Math.sqrt(vi * vi + 2 * ai * dist) - vi) / ai : t1 + (dist - d1) / vc;
  }
  /** Can i be granted connector c (start `toStart` ahead) without cutting into a vehicle granted before it? */
  function zonesClear(i: number, c: number, toStart: number): boolean {
    const vi = v[i];
    const ai = aMax[i];
    for (let k = cfOff[c]; k < cfOff[c + 1]; k++) {
      const h = cf[k];
      for (let e = holdHead[h]; e >= 0; e = holdLink[e]) {
        const j = (e / HM) | 0;
        if (j === i) continue;
        if (aheadOn(j, i)) {
          firstSeq = Math.min(firstSeq, hSeq[e]);
          continue;
        }
        const f = tot[j] - hS0[e];
        const r = f - len[j];
        if (r >= cfZE[k] && f >= cfZF[k]) continue;
        // (one still far off, granted a long way ahead: through and clear before it could come, i goes
        // first, before it in the order)
        if (f < 0 && clearTime(i, c, toStart) + FAR_MARGIN < -f / V_TOP) {
          firstSeq = Math.min(firstSeq, hSeq[e]);
          continue;
        }
        const out = Math.max(cfZE[k] - r, cfZF[k] - f) / Math.max(v[j], 0.4);
        const d = Math.max(0, toStart + cfZS[k]);
        const tin = (Math.sqrt(vi * vi + 2 * ai * d) - vi) / ai;
        if (out + ZONE_MARGIN > tin) {
          zoneBy = j;
          return false;
        }
      }
    }
    return true;
  }

  // ── leaders ──
  /** Nearest vehicle ahead of i among those whose front is in segment g (starting `off` ahead of i's front). */
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
  /** Vehicles that took another turn from the same lane as connector c, their rears still at the fork. */
  function scanSiblings(i: number, c: number, off: number, same: boolean) {
    const sibs = lanes[from[c]].next;
    for (let k = 0; k < sibs.length; k++) {
      const o = sibs[k];
      if (o === c) continue;
      scanSeg(i, nL + o, off, same, SIB_RANGE);
      const L = segLen[nL + o];
      // (a body already out on another exit is in this one's way only while this one is still at the fork)
      // (a long body can be out on the exit lane with its rear still at the fork: maxRear measures from the fork)
      if (!(same && s[i] > 1.5)) scanSeg(i, to[o], off + L, false, SIB_RANGE - L);
    }
  }

  function reset() {
    hN.fill(0);
    gN.fill(0);
    pN.fill(0);
    res.fill(-1);
    reserved.fill(0);
    tail.fill(0);
    claim.fill(0);
    narrowClaim.fill(0);
    inClaim.fill(0);
    giveN.fill(0);
    lockN.fill(0);
    lkN.fill(0);
    waitT.fill(0);
    zw.fill(0);
    xw.fill(0);
    acc.fill(0);
    signal.fill(0);
    brake.fill(0);
    door.fill(0);
    dwellT.fill(0);
    leaveT.fill(0);
    away.fill(0);
    served.fill(0);
    tot.fill(0);
    hTop.fill(0);
    seqN = 0;
    for (let l = 0; l < nL; l++) tail[l] = emptyTail(l);
    for (let i = 0; i < N; i++) {
      rng[i] = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
      odo[i] = hash3(seed, i, 11) * 10;
      stop[i] = 0;
    }
    // Seeded layout: each vehicle on a lane of its home town (a bus at its line's first stop, others
    // in a shuffled order), filled from the stop line back, generously spaced; then anywhere on its
    // land mass if home is full.
    const order = lanes.map((l) => l.id);
    for (let a = order.length - 1; a > 0; a--) {
      const b = Math.floor(hash3(seed, a, 5) * (a + 1));
      const t = order[a];
      order[a] = order[b];
      order[b] = t;
    }
    const front = Float64Array.from(lanes, (l) => stopS[l.id] - 0.5 - hash3(seed, l.id, 9) * 4);
    const fits = (i: number, l: number) => front[l] - len[i] >= 1.5 + (xStart[l] >= 0 ? xStartS[l] + 2 : 0) && canWait[kind[i] * nL + l] === 1 && lanes[l].next.some((c) => usable(kind[i], c, 0));
    const place = (i: number, l: number) => {
      seg[i] = l;
      s[i] = front[l];
      front[l] -= len[i] + 7 + hash3(seed, i, 13) * 8;
      v[i] = lanes[l].speed * vK[i] * 0.5;
    };
    const comp = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const h = routes.home[i];
      comp[i] = net.laneComp[order.find((l) => laneTown[l] === h) ?? 0];
      let done = false;
      if (line[i] >= 0) {
        // buses: on their line, spread over its stops
        const ln = routes.lines[line[i]];
        const nb = line.filter((x) => x === line[i]).length;
        const kth = line.slice(0, i).filter((x) => x === line[i]).length;
        const q = Math.floor((kth * ln.stops.length) / nb) % ln.stops.length;
        stop[i] = q;
        const l = ln.stops[q].lane;
        if (front[l] - len[i] >= 1 && canWait[3 * nL + l]) {
          seg[i] = l;
          s[i] = Math.min(front[l], ln.stops[q].s - 4);
          front[l] = s[i] - len[i] - 7;
          v[i] = 0;
          done = s[i] - len[i] >= 0.5;
        }
      }
      for (let pass = 0; pass < 2 && !done; pass++)
        for (let t = 0; t < order.length && !done; t++) {
          const l = order[(t + i * 7) % order.length];
          if ((pass === 0 ? laneTown[l] !== h : net.laneComp[l] !== comp[i]) || !fits(i, l)) continue;
          place(i, l);
          done = true;
        }
      if (!done) throw new Error('transit: the fleet does not fit the network');
      for (let k = 0; k < HN; k++) hist[i * HN + k] = seg[i];
    }
    dest.fill(-1);
    destN.fill(0);
    for (let i = 0; i < N; i++) {
      if (line[i] < 0) newDest(i);
      extend(i, 2);
    }
    poses();
    pF.set(F);
    pRr.set(Rr);
    pC.set(C);
  }

  function setObstacle(on: boolean, d: Vec3 | null) {
    if (!on || !d) {
      obN = 0;
      ob.x = 9;
      return;
    }
    if ((d.x - ob.x) ** 2 + (d.y - ob.y) ** 2 + (d.z - ob.z) ** 2 < 1e-8) return;
    ob.x = d.x;
    ob.y = d.y;
    ob.z = d.z;
    obN = 0;
    const Rw = 1.2 + OB_R;
    for (let g = 0; g < nS && obN < 8; g++) {
      const c = Math.acos(Math.min(1, net.bc[g * 3] * d.x + net.bc[g * 3 + 1] * d.y + net.bc[g * 3 + 2] * d.z)) * R;
      if (c > net.br[g] + Rw) continue;
      // nearest sample (≤ 1 m apart: a lateral error of a few cm)
      const p = path[g];
      let best = Infinity;
      let bs = 0;
      for (let k = 0; k < p.h.length; k++) {
        const dd = (p.dir[k * 3] - d.x) ** 2 + (p.dir[k * 3 + 1] - d.y) ** 2 + (p.dir[k * 3 + 2] - d.z) ** 2;
        if (dd < best) {
          best = dd;
          bs = p.s[k];
        }
      }
      const dist = Math.sqrt(best) * R;
      if (dist < Rw) {
        obSeg[obN] = g;
        obS[obN] = bs;
        obD[obN++] = dist;
      }
    }
  }
  /** Is the player in the way of connector c or the first metres of its exit lane? */
  const obstructs = (c: number) => {
    for (let o = 0; o < obN; o++) if (obSeg[o] === nL + c || (obSeg[o] === to[c] && obS[o] < 12)) return true;
    return false;
  };

  /** Body coverage of town crossings by vehicle i: every lane its body spans, each crossing within the padded strip. */
  const cover = (blocked: Uint8Array, x: number, a: number, lo: number, hi: number) => {
    if (x >= 0 && lo < a + xHalf[x] + CROSS_PAD && hi > a - xHalf[x] - CROSS_PAD) blocked[x] = 1;
  };

  function step(dt: number, busy: Uint8Array | null, blocked: Uint8Array | null) {
    stamp++;
    // 0. who holds what; segment buckets; lane occupancy; tails and askers
    holdHead.fill(-1);
    for (let i = 0; i < N; i++)
      for (let k = 0; k < hN[i]; k++) {
        const e = i * HM + k;
        holdLink[e] = holdHead[hc[e]];
        holdHead[hc[e]] = e;
      }
    capA.fill(1e9);
    for (let i = 0; i < N; i++) {
      if (kind[i] < 2) continue;
      const base = (kind[i] - 2) * (nC + 1);
      for (let k = 0; k < hN[i]; k++) {
        const c = hc[i * HM + k];
        for (let j = swOff[base + c]; j < swOff[base + c + 1]; j++)
          if (swX[j] < capA[swLane[j]]) {
            capA[swLane[j]] = swX[j];
            capW[swLane[j]] = i;
          }
      }
    }
    head.fill(-1);
    occ.fill(0);
    occBig.fill(0);
    thru.fill(0);
    passing.fill(0);
    for (let i = 0; i < N; i++) {
      link[i] = head[seg[i]];
      head[seg[i]] = i;
      // lanes the body spans, and the lanes it is granted into
      let g = seg[i];
      let lo = s[i] - len[i];
      for (let k = 1; ; k++) {
        if (g < nL) {
          occ[g] = 1;
          occBig[g] |= single[kind[i] * nL + g];
        }
        if (lo >= 0 || k > HN) break;
        g = hist[i * HN + ((hTop[i] - k) & (HN - 1))];
        lo += segLen[g];
      }
      for (let k = 0; k < gN[i]; k++) {
        const t = to[plan[i * PM + k]];
        thru[t] = 1;
        if (!canWait[kind[i] * nL + t]) passing[t] = 1;
        occ[t] = 1;
        occBig[t] |= single[kind[i] * nL + t];
      }
    }
    asker.fill(-1);
    for (let l = 0; l < nL; l++) tail[l] = emptyTail(l);
    for (let i = 0; i < N; i++) {
      const g = seg[i];
      if (g < nL && gN[i] === 0 && s[i] - len[i] < tail[g]) tail[g] = s[i] - len[i];
    }

    // 1. accelerations (and who asks for which lane's end)
    for (let i = 0; i < N; i++) {
      extend(i, gN[i] + 3);
      const g0 = seg[i];
      const onLane = g0 < nL;
      leadGap[i] = 1e9;
      leadV[i] = 0;
      busGap[i] = 1e9;
      const kd = KINDS[kind[i]];
      // the bus stop ahead (the next stop's lane on the plan within reach)
      const ln = line[i] >= 0 ? routes.lines[line[i]] : null;
      const st = ln ? ln.stops[stop[i]] : null;
      // leaders along the plan
      let g = g0;
      let off = -s[i];
      let pk = 0;
      for (let k = 0; k < 2 * PM; k++) {
        scanSeg(i, g, off, k === 0, 1e9);
        if (g >= nL) scanSiblings(i, g - nL, off, k === 0);
        for (let o = 0; o < obN; o++) {
          if (obSeg[o] !== g || obD[o] > kd.width / 2 + OB_R || (k === 0 && obS[o] + OB_R < s[i])) continue;
          const gap = off + obS[o] - OB_R;
          if (gap < leadGap[i]) {
            leadGap[i] = gap;
            leadV[i] = 0;
          }
        }
        if (g < nL && busy) {
          // people on a crossing ahead (stepped on before it was granted the way over it, a frame's race):
          // it stops short of them, granted or not, unless its front is already on the strip
          for (let e = 0; e < 2; e++) {
            const x = e ? xEnd[g] : xStart[g];
            if (x < 0 || !busy[x]) continue;
            const near = (e ? xEndS[g] : xStartS[g]) - xHalf[x] - CROSS_PAD;
            if ((k > 0 || s[i] < near + 0.05) && off + near + S0 - 0.2 < leadGap[i]) {
              leadGap[i] = off + near + S0 - 0.2;
              leadV[i] = 0;
            }
          }
        }
        if (g < nL) {
          // a swing's stop line (only for those not past it yet; a claim not for those granted on through it)
          const cap = Math.min(capA[g] > 1e8 || capW[g] === i || aheadOn(capW[g], i) ? 1e9 : capA[g], capT[g] >= stamp - 1 && pk >= gN[i] ? capC[g] : 1e9);
          // (it stops with its front just short of it, like at a stop line: not S0 back, the tail in the junction)
          if (cap < 1e8 && (k > 0 || s[i] < cap) && off + cap - 0.4 + S0 < leadGap[i]) {
            leadGap[i] = off + cap - 0.4 + S0;
            leadV[i] = 0;
          }
        }
        if (st && g === st.lane && dwellT[i] <= 0 && (k > 0 || (s[i] < st.s + 0.5 && !away[i]))) busGap[i] = Math.min(busGap[i], off + st.s);
        off += segLen[g];
        if ((leadGap[i] < off - 8.5 && (!st || busGap[i] < 1e8)) || off > LOOK) break;
        if (g >= nL) g = to[g - nL];
        else if (pk < pN[i]) g = nL + plan[i * PM + pk++];
        else break;
      }
      // the zone entries of held connectors not yet passed
      zoneGap[i] = 1e9;
      for (let k = 0; k < hN[i]; k++) {
        const e = i * HM + k;
        const toStart = hS0[e] - tot[i];
        if (toStart + segLen[nL + hc[e]] < 0) continue;
        const zb = zoneBlock(i, hc[e], hSeq[e], toStart);
        // (kept from it, it waits at the stop line if not past it yet: others swing over what lies beyond)
        const sl = toStart - (segLen[from[hc[e]]] - stopS[from[hc[e]]]);
        if (zb < 1e8) zoneGap[i] = Math.min(zoneGap[i], sl > -0.05 ? sl : zb);
      }
      // the stop line of the first lane whose end it holds no grant for
      const m = laneBefore(i, gN[i]);
      stopLane[i] = m;
      stopGap[i] = ahead(i, gN[i]) - (segLen[m] - stopS[m]);
      // speed: the profile here, braking for the next segment's (and the one after) in time
      const vi = v[i];
      const pg = prof[g0];
      let vmax = pg[Math.min(pg.length - 1, Math.max(0, Math.floor(s[i])))];
      {
        let gg = g0;
        let dd = segLen[g0] - s[i];
        let q = 0;
        for (let k = 0; k < 2; k++) {
          const nx = gg < nL ? (q < pN[i] ? nL + plan[i * PM + q++] : -1) : to[gg - nL];
          if (nx < 0) break;
          vmax = Math.min(vmax, Math.sqrt(entry[nx] * entry[nx] + 2 * 1.6 * Math.max(0, dd)));
          dd += segLen[nx];
          gg = nx;
        }
      }
      vmax *= vK[i];
      const am = aMax[i];
      let a = am * (1 - Math.pow(vi / Math.max(vmax, 0.1), 4));
      if (leadGap[i] < 1e8) a = Math.min(a, idm(vi, vmax, am, leadGap[i], leadV[i]));
      if (zoneGap[i] < 1e8) a = Math.min(a, idm(vi, vmax, am, zoneGap[i] + S0 - 0.2, 0));
      if (stopGap[i] < LOOK) a = Math.min(a, idm(vi, vmax, am, stopGap[i] + S0 - 0.3, 0));
      if (busGap[i] < LOOK) a = Math.min(a, idm(vi, vmax, am, busGap[i] + S0, 0));
      acc[i] = Math.max(-9, a);
      // the front-most vehicle of its stop lane asks (a bus serves a stop on it first: not yet)
      hold[i] = st && ((st.lane === m && busGap[i] < 1e8) || dwellT[i] > 0) ? 1 : 0;
      if (stopGap[i] < LOOK && (asker[m] < 0 || stopGap[i] < askD[m])) {
        asker[m] = i;
        askD[m] = stopGap[i];
      }
    }

    // 2. grants, highest score first
    let nReq = 0;
    for (let l = 0; l < nL; l++) {
      const i = asker[l];
      if (i < 0 || hold[i]) continue;
      const vi = v[i];
      if (askD[l] <= (vi * vi) / (2 * B) + REQ_MARGIN + vi * REQ_T) {
        req[nReq++] = i;
        score[i] = prio[plan[i * PM + gN[i]]] + waitT[i] * AGING + (kind[i] === 3 ? BUS_FIRST : 0);
      }
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
    xHit.fill(0);
    for (let q = 0; q < nReq; q++) grant(req[q], dt, busy);
    for (let i = 0; i < N; i++) if (!xHit[i]) xw[i] = 0;

    // 3. integrate
    for (let i = 0; i < N; i++) {
      let vn = v[i] + acc[i] * dt;
      if (vn < 0) vn = 0;
      let ds = vn * dt;
      let lim = Math.min(leadGap[i] - MIN_GAP, zoneGap[i], stopGap[i] - 1e-3, busGap[i]);
      if (dwellT[i] > 0) lim = 0;
      if (ds > lim) ds = Math.max(0, lim);
      if (ds < vn * dt) vn = ds / dt;
      brake[i] = acc[i] < -0.9 || vn < 0.25 ? 1 : 0;
      v[i] = vn;
      s[i] += ds;
      odo[i] += ds;
      tot[i] += ds;
      if (gN[i] === 0 && stopGap[i] < 4 && vn < 0.5) waitT[i] += dt;
      while (s[i] >= segLen[seg[i]]) {
        const g = seg[i];
        if (g < nL && gN[i] === 0) {
          // (never: the clamp keeps an ungranted front behind its stop line)
          s[i] = segLen[g] - 1e-3;
          v[i] = 0;
          break;
        }
        s[i] -= segLen[g];
        hist[i * HN + (hTop[i] & (HN - 1))] = g;
        hTop[i]++;
        if (g < nL) {
          // onto the planned turn
          seg[i] = nL + plan[i * PM];
          plan.copyWithin(i * PM, i * PM + 1, i * PM + pN[i]);
          pN[i]--;
          gN[i]--;
        } else {
          const t = to[g - nL];
          seg[i] = t;
          for (let r = 0; r < 2; r++)
            if (res[i * 2 + r] === t) {
              reserved[t] -= need[i];
              res[i * 2 + r] = -1;
            }
          if (line[i] < 0) {
            if (dest[i] < 0 || (laneTown[t] === dest[i] && --stay[i] <= 0)) newDest(i);
          }
        }
      }
      // a bus at its stop: doors open for DWELL, then on to the next stop
      if (line[i] >= 0) {
        const ln = routes.lines[line[i]];
        const st = ln.stops[stop[i]];
        if (dwellT[i] > 0) {
          dwellT[i] -= dt;
          if (dwellT[i] <= 0) {
            dwellT[i] = 0;
            door[i] = 0;
            served[i]++;
            stop[i] = (stop[i] + 1) % ln.stops.length;
            leaveT[i] = 2.5;
            away[i] = 1;
            // the plan was made for the old stop: re-plan what is not granted yet
            truncate(i, gN[i] + 1);
          }
        } else if (away[i]) {
          if (seg[i] !== st.lane) away[i] = 0;
        } else if (seg[i] === st.lane && v[i] < 0.15 && st.s - s[i] < 0.9 && st.s - s[i] > -0.5) {
          dwellT[i] = DWELL;
          door[i] = 1;
        } else if (seg[i] === st.lane && s[i] > st.s + 0.5) {
          // (missed it: serve the next one)
          stop[i] = (stop[i] + 1) % ln.stops.length;
          truncate(i, gN[i] + 1);
        }
        if (leaveT[i] > 0) leaveT[i] -= dt;
      }
      // reopen each single-file lane to oncoming traffic once its body is off it (they are in order)
      while (lkN[i] > 0 && tot[i] - len[i] >= lkEnd[i * LK]) {
        lockN[lk[i * LK]]--;
        lk.copyWithin(i * LK, i * LK + 1, i * LK + lkN[i]);
        lkEnd.copyWithin(i * LK, i * LK + 1, i * LK + lkN[i]);
        lkN[i]--;
      }
      // release grants whose connector the rear has left
      while (hN[i] > 0 && tot[i] - len[i] >= hS0[i * HM] + segLen[nL + hc[i * HM]]) {
        hc.copyWithin(i * HM, i * HM + 1, i * HM + hN[i]);
        hSeq.copyWithin(i * HM, i * HM + 1, i * HM + hN[i]);
        hS0.copyWithin(i * HM, i * HM + 1, i * HM + hN[i]);
        hN[i]--;
      }
      // signals: the last 18 m before a turn and through it; a bus pulling in (right) and out (left)
      const g = seg[i];
      const t = g < nL ? (pN[i] > 0 && segLen[g] - s[i] < 18 ? conns[plan[i * PM]].turn : 'straight') : conns[g - nL].turn;
      signal[i] = t === 'left' ? 1 : t === 'right' ? -1 : 0;
      if (line[i] >= 0) {
        if (leaveT[i] > 0) signal[i] = 1;
        else if (busGap[i] < 14 || dwellT[i] > 0) signal[i] = -1;
      }
    }

    // 4. crossings: every one a body covers (until its rear is CROSS_PAD past the strip), those a
    // granted vehicle is about to cross, and those claimed after a long wait
    if (blocked && nX) {
      blocked.fill(0);
      for (let i = 0; i < N; i++) {
        let g = seg[i];
        let hi = s[i];
        let lo = hi - len[i];
        for (let k = 1; ; k++) {
          if (g < nL) {
            cover(blocked, xStart[g], xStartS[g], lo, k > 1 ? hi : 1e9);
            cover(blocked, xEnd[g], xEndS[g], lo, hi);
          } else if (k === 1 && xStart[to[g - nL]] >= 0) blocked[xStart[to[g - nL]]] = 1; // (in the junction: the street it turns into)
          if (lo >= 0 || k > HN) break;
          g = hist[i * HN + ((hTop[i] - k) & (HN - 1))];
          hi = segLen[g];
          lo += hi;
        }
        for (let k = 0; k < gN[i]; k++) {
          const lb = laneBefore(i, k);
          if (xEnd[lb] >= 0) blocked[xEnd[lb]] = 1;
          const t = to[plan[i * PM + k]];
          if (xStart[t] >= 0) blocked[xStart[t]] = 1;
        }
        if (xw[i] > CLAIM_T) blocked[xwId[i]] = 1;
      }
    }

    pF.set(F);
    pRr.set(Rr);
    pC.set(C);
    poses();
  }

  /** The swing cap on lane l as i sees it (none from its own turns, nor from one behind it). */
  function capOf(i: number, l: number) {
    return capA[l] > 1e8 || capW[l] === i || aheadOn(capW[l], i) ? 1e9 : capA[l];
  }
  /** Try to grant asker i the turn(s) at the end of its stop lane. */
  function grant(i: number, dt: number, busy: Uint8Array | null) {
    firstSeq = Infinity;
    const k0 = gN[i];
    const m = stopLane[i];
    const nd = need[i];
    const kd = kind[i];
    extend(i, k0 + 1);
    // re-route: the planned exit is full (at once while still rolling up, after a short wait at the
    // line), or a crossing on it has been busy a while
    // (and refused GIVE_UP s more, whatever the reason, it tries the next other way out, if any)
    // (the quickest other way; one far out of its way, round some village, only once refused twice)
    if (!lkN[i] && waitT[i] > GIVE_UP * (giveN[i] + 1)) {
      giveN[i]++;
      const nx = lanes[m].next;
      const c0 = plan[i * PM + k0];
      const w0 = wayCost(i, m, c0, k0);
      let bw = Infinity;
      let bc = -1;
      for (let j = 0; j < nx.length; j++) {
        const alt = nx[j];
        // (only a way open now: one as full as its own would leave its claims for nothing)
        const t = to[alt];
        if (alt === c0 || !usable(kd, alt, 0) || obstructs(alt) || !(canWait[kd * nL + t] ? room(t, kd) >= nd : tail[t] >= emptyTail(t) - 1e-9 && reserved[t] < 1e-9)) continue;
        const w = wayCost(i, m, alt, k0);
        if (w < bw) {
          bw = w;
          bc = alt;
        }
      }
      if (bc >= 0 && (bw - w0 < DETOUR || giveN[i] > 1)) {
        plan[i * PM + k0] = bc;
        pN[i] = k0 + 1;
      }
    }
    const c0 = plan[i * PM + k0];
    const fullExit = canWait[kd * nL + to[c0]] && room(to[c0], kd) < nd;
    // (a truck or bus inside a narrow section keeps to the way it reserved; nobody takes a way far out of its own)
    if (!lkN[i] && (fullExit && (waitT[i] > REROUTE_AFTER || stopGap[i] > 6)) || (waitT[i] > REROUTE_AFTER && zw[i] > ZEBRA_REROUTE)) {
      const nx = lanes[m].next;
      const o = Math.floor(rand(i) * nx.length);
      const w0 = wayCost(i, m, c0, k0);
      for (let j = 0; j < nx.length; j++) {
        const alt = nx[(o + j) % nx.length];
        const t = to[alt];
        if (alt !== c0 && usable(kd, alt, 0) && canWait[kd * nL + t] && room(t, kd) >= nd && !(busy && xStart[t] >= 0 && busy[xStart[t]]) && !obstructs(alt) && wayCost(i, m, alt, k0) - w0 < DETOUR) {
          plan[i * PM + k0] = alt;
          pN[i] = k0 + 1;
          zw[i] = 0;
          break;
        }
      }
    }
    // the chain: through every exit too short for this kind to wait in
    let n = 0;
    let at = ahead(i, k0);
    for (let k = k0; ; k++) {
      extend(i, k + 1);
      if (pN[i] <= k) return void (why[i] = 1);
      const c = plan[i * PM + k];
      chain[n] = c;
      chainAt[n++] = at;
      if (canWait[kd * nL + to[c]] || n > CHAIN_MAX) break;
      at += segLen[nL + c] + segLen[to[c]];
    }
    if (n > CHAIN_MAX || hN[i] + n > HM || (res[i * 2] >= 0 && res[i * 2 + 1] >= 0)) return void (why[i] = 2);
    const fin = to[chain[n - 1]];
    // (kept waiting long, it holds its whole way and exit against newcomers whatever refuses it now:
    // a claim that moved with each reason let the others fill what it had drained)
    starve(i, fin, n);
    // (a truck or bus is turning across this lane's stop line: wait behind it; go through it, or into
    // it if there is no room behind it for the whole body, only once it is through)
    if (capOf(i, m) < 1e8) return void (why[i] = 15);
    for (let j = 0; j < n - 1; j++) if (capOf(i, to[chain[j]]) < 1e8) return void (why[i] = 16);
    if (capOf(i, fin) < 1e8 && capOf(i, fin) - 0.5 < len[i] + 0.2) return void (why[i] = 19);
    // (not into a lane someone is granted through without a place to stop: it would stop in front of
    // them, their tail in the junction behind)
    if (passing[fin] && fin !== seg[i]) return starve(i, fin, n), void (why[i] = 23);
    // (ahead of one the room is reserved for, it goes on that room: the other comes after it)
    const ahead0 = resBehind(i, fin);
    if (full[fin] === stamp && fin !== seg[i] && ahead0 === 0 && !swapRoom(i, fin, m)) return starve(i, fin, n), void (why[i] = 3);
    if ((fin === seg[i] ? roomBut(i, fin) : room(fin, kd)) + ahead0 < nd && !swapRoom(i, fin, m)) {
      if (waitT[i] > 2 && fin !== seg[i]) full[fin] = stamp;
      return starve(i, fin, n), void (why[i] = 4);
    }
    // the crossing at the end of its lane, and those on the way
    if (busy) {
      if (xEnd[m] >= 0 && busy[xEnd[m]]) return (why[i] = 5), refuseX(i, xEnd[m], dt, false);
      for (let j = 0; j < n; j++) {
        const t = to[chain[j]];
        if (xStart[t] >= 0 && busy[xStart[t]]) return (why[i] = 6), refuseX(i, xStart[t], dt, true);
        if (j < n - 1 && xEnd[t] >= 0 && busy[xEnd[t]]) return (why[i] = 7), refuseX(i, xEnd[t], dt, true);
      }
    }
    for (let j = 0; j < n; j++) {
      const c = chain[j];
      const t = to[c];
      // a lane someone starving waits on is theirs
      // (those already in a lane of the same claim drain out through it)
      if (inClaim[t] >= stamp - 1 && inWho[t] !== i && !(inClaim[m] >= stamp - 1 && inWho[m] === inWho[t]) && !(t === fin && ahead0 > 0)) return void (why[i] = 20);
      // a lane passed through must hold nobody waiting and be promised to nobody
      // (a bus kept waiting queues behind them instead: they go first through all it holds, aheadOn)
      if (j < n - 1 && (tail[t] < emptyTail(t) - 1e-9 || reserved[t] - resBehind(i, t) > 1e-9) && !(kd === 3 && waitT[i] > STARVE)) return starve(i, t, n), void (why[i] = 8);
      // single file: nobody meets a truck or a bus where it cannot pass (sections, below)
      const o = opp[t];
      // (a claim keeps out only those coming from outside the claimed run: those already in it go on through)
      if (o >= 0 && !single[kd * nL + t] && (occBig[o] || lockN[t] > 0 || (narrowClaim[t] >= stamp - 1 && narrowClaim[m] < stamp - 1))) return void (why[i] = 9);
      if (obN && obstructs(c)) {
        zw[i] += dt;
        return void (why[i] = 10);
      }
      if (claim[c] === stamp) return void (why[i] = 11);
      // a U-turn loops back past its own start: one at a time on it
      if (uturn[c] && holdHead[c] >= 0 && ((holdHead[c] / HM) | 0) !== i) return void (why[i] = 22);
      for (let e = dsOff[t]; e < dsOff[t + 1]; e++) {
        const kc = (dsT[e] / nC) | 0;
        for (let h = holdHead[dsT[e] - kc * nC]; h >= 0; h = holdLink[h]) {
          const j = (h / HM) | 0;
          if (j !== i && kindClass(kind[j]) === kc && !aheadOn(j, i)) {
            // (kept waiting long, it shuts the turns that swing over its way's start: a loop round a
            // block always has someone on them)
            if (waitT[i] > STARVE) for (let q = dsOff[t]; q < dsOff[t + 1]; q++) claim[dsT[q] % nC] = stamp;
            return (whyBy[i] = j), starve(i, t, n), void (why[i] = 21);
          }
        }
      }
    }
    for (let j = 0; j < n; j++) {
      if (!zonesClear(i, chain[j], chainAt[j])) {
        // (it claims the turns across its own while it waits for one on its way: not for one stood still,
        // which may be waiting behind one of them)
        if (v[zoneBy] > 0.3) for (let k = cfOff[chain[j]]; k < cfOff[chain[j] + 1]; k++) claim[cf[k]] = stamp;
        return void (why[i] = 12);
      }
    }
    // single file: a truck or a bus is granted through the whole run of lanes it cannot pass
    // oncoming traffic on (a chain, above: it may not wait on them), with nobody coming the other way
    // on any of them, and nobody new until it is through
    let ns = 0;
    for (let j = 0; j < n - 1; j++) {
      const t = to[chain[j]];
      if (!single[kd * nL + t]) continue;
      if (lkN[i] + ns >= LK) return void (why[i] = 13);
      const o = opp[t];
      if (occ[o] || reserved[o] > 1e-9 || lockN[t] > 0) {
        if (waitT[i] > 2)
          for (let q = 0; q < n - 1; q++)
            if (single[kd * nL + to[chain[q]]]) {
              narrowClaim[opp[to[chain[q]]]] = stamp;
              starve(i, opp[to[chain[q]]], 0);
            }
        return starve(i, o, n), void (why[i] = 14);
      }
      secEnd[ns] = tot[i] + chainAt[j] + segLen[nL + chain[j]] + segLen[t];
      sec[ns++] = t;
    }
    // no tail where its turns swing over the start of another lane leaving the junction
    {
      const base = kindClass(kd) * (nC + 1);
      for (let j = 0; j < n; j++) {
        const c = chain[j];
        for (let e = ssOff[base + c]; e < ssOff[base + c + 1]; e++) {
          const D = ssLane[e];
          for (let u = head[D]; u >= 0; u = link[u]) if (u !== i && s[u] - len[u] < ssY[e]) return starve(i, D, n), void (why[i] = 18);
          // (nor anyone granted on to it: they will be)
          const pv = lanes[D].prev;
          for (let k = 0; k < pv.length; k++)
            for (let h = holdHead[pv[k]]; h >= 0; h = holdLink[h]) if (((h / HM) | 0) !== i) return starve(i, D, n), void (why[i] = 18);
        }
      }
    }
    // a truck or bus: every stop line its turns swing over clear, and nobody committed through it
    if (kd >= 2) {
      const base = (kd - 2) * (nC + 1);
      for (let j = 0; j < n; j++) {
        const c = chain[j];
        for (let e = swOff[base + c]; e < swOff[base + c + 1]; e++) {
          const L = swLane[e];
          const x = swX[e] - 0.3;
          // (nobody on the stop line or rolling up to it, nobody granted into or through the lane, nobody
          // on a turn into it, no tail still on it from a turn out of it)
          let bad = thru[L] === 1;
          // (itself excepted: a chain round a block back over its own stop line is long gone from it)
          for (let u = head[L]; u >= 0 && !bad; u = link[u]) bad = u !== i && (gN[u] > 0 || s[u] > x || s[u] + (v[u] * v[u]) / 8 > x);
          const nx = lanes[L].next;
          for (let k = 0; k < nx.length && !bad; k++) for (let u = head[nL + nx[k]]; u >= 0 && !bad; u = link[u]) bad = u !== i && s[u] < len[u];
          const pv = lanes[L].prev;
          for (let k = 0; k < pv.length && !bad; k++) bad = head[nL + pv[k]] >= 0 && head[nL + pv[k]] !== i;
          if (bad) {
            // (a claim only where a car can still wait behind it)
            if (waitT[i] > 1.5 && swX[e] > 4.6) {
              capC[L] = Math.min(capT[L] >= stamp - 1 ? capC[L] : 1e9, swX[e]);
              capT[L] = stamp;
            }
            return starve(i, L, n), void (why[i] = 17);
          }
        }
      }
    }
    // granted: close the oncoming lanes of its single-file run until its rear is off each,
    for (let j = 0; j < ns; j++) {
      const o = opp[sec[j]];
      lockN[o]++;
      lk[i * LK + lkN[i]] = o;
      lkEnd[i * LK + lkN[i]++] = secEnd[j];
    }
    // hold every turn of the chain, reserve the exit's room
    for (let j = 0; j < n; j++) {
      const e = i * HM + hN[i]++;
      hc[e] = chain[j];
      // (ahead of a holder on its way: just before it in the order, the chain's turns in their order)
      hSeq[e] = firstSeq < Infinity ? firstSeq - 1e-3 + j * 1e-6 - (++tieN % 100000) * 1e-11 : ++seqN;
      hS0[e] = tot[i] + chainAt[j];
      // (others this step see it at once)
      holdLink[e] = holdHead[chain[j]];
      holdHead[chain[j]] = e;
    }
    gN[i] = k0 + n;
    for (let j = 0; j < n; j++) {
      thru[to[chain[j]]] = 1;
      if (j < n - 1) passing[to[chain[j]]] = 1;
      occ[to[chain[j]]] = 1;
      occBig[to[chain[j]]] |= single[kd * nL + to[chain[j]]];
    }
    reserved[fin] += nd;
    res[i * 2 + (res[i * 2] < 0 ? 0 : 1)] = fin;
    waitT[i] = zw[i] = xw[i] = 0;
    giveN[i] = 0;
    why[i] = 0;
  }
  function finOf(i: number) {
    for (let k = gN[i]; k < pN[i]; k++) {
      const t = to[plan[i * PM + k]];
      if (canWait[kind[i] * nL + t]) return `${t} room ${room(t, kind[i]).toFixed(2)} keep ${keep[t].toFixed(1)} tail ${tail[t].toFixed(1)} res ${reserved[t].toFixed(1)} claim ${inClaim[t] >= stamp - 1 ? inWho[t] : '-'}`;
    }
    return '?';
  }
  /**
   * Refused a while on lane l's account: close it, and the lanes of its chain (the first n of `chain`),
   * to the others' grants this step and the next (each lane to one claimant at a time).
   */
  function starve(i: number, l: number, n: number) {
    if (waitT[i] < STARVE) return;
    for (let j = -1; j < n; j++) {
      const t = j < 0 ? l : to[chain[j]];
      if (inClaim[t] >= stamp - 1 && inWho[t] !== i) continue;
      inClaim[t] = stamp;
      inWho[t] = i;
    }
  }
  /** Refused by busy crossing x: count the wait (re-route after a while if it is on the exit). */
  function refuseX(i: number, x: number, dt: number, exit: boolean) {
    xHit[i] = 1;
    if (xwId[i] !== x) xw[i] = 0;
    xwId[i] = x;
    xw[i] += dt;
    if (exit) zw[i] += dt;
  }

  reset();
  return {
    n: N,
    net,
    routes,
    kind,
    seg,
    s,
    v,
    acc,
    odo,
    F,
    Rr,
    C,
    pF,
    pRr,
    pC,
    signal,
    brake,
    door,
    dest,
    stop,
    served,
    next: (i) => (pN[i] > 0 ? plan[i * PM] : -1),
    reset,
    step,
    setObstacle,
    dump: (i) =>
      `#${i} k${kind[i]} seg ${seg[i]} s ${s[i].toFixed(2)} v ${v[i].toFixed(2)} plan [${Array.from(plan.subarray(i * PM, i * PM + pN[i]))}] g${gN[i]} holds [${Array.from(hc.subarray(i * HM, i * HM + hN[i]))}] stopLane ${stopLane[i]} stopGap ${stopGap[i].toFixed(2)} lead ${leadGap[i].toFixed(2)} zone ${zoneGap[i].toFixed(2)} bus ${busGap[i].toFixed(2)} wait ${waitT[i].toFixed(1)} asker ${asker[stopLane[i]]} room ${pN[i] > gN[i] ? room(to[plan[i * PM + gN[i]]], kind[i]).toFixed(2) : '-'} why ${why[i]} locks [${Array.from(lk.subarray(i * LK, i * LK + lkN[i]))}] res [${res[i * 2]},${res[i * 2 + 1]}] dest ${dest[i]} fin ${finOf(i)} by ${whyBy[i]}`,
  };
}

/** IDM acceleration toward an obstacle `gap` m ahead (bumper to bumper) moving at vl. */
function idm(vi: number, vmax: number, am: number, gap: number, vl: number): number {
  const ss = S0 + Math.max(0, vi * T_HEAD + (vi * (vi - vl)) / (2 * Math.sqrt(am * B)));
  const q = ss / Math.max(gap, 0.05);
  return am * (1 - Math.pow(vi / Math.max(vmax, 0.1), 4) - q * q);
}
