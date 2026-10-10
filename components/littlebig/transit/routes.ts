// V1 (v2): who drives where. Pure, boot-time, deterministic: the region fleet (how many of each kind
// call each town home), the bus lines and their stops by the squares, and the travel-time tables the
// sim's turn choices read (transit/sim.ts).
//
// Travel times are seconds from the END of a lane to the START of a target, over the turns a kind
// may take (net.ok), so a car heading for a town picks, at each junction, among the turns that do
// not take it much further from it (sim.ts `choose`), and a bus follows the quickest way to its next
// stop exactly.

import { KINDS } from '../traffic/sim';
import { R } from '../world/config';
import { hash3 } from '../world/rng';
import { chartToDir } from '../world/sphere';
import { CHAIN_MAX, CHAIN_OF, type Net } from './net';

/** A kind's class for the tables: 0 cars and compacts, 1 trucks, 2 buses. */
export const kindClass = (k: number) => (k < 2 ? 0 : k - 1);

/**
 * The fleet by home town (Settlement.id): [cars, compacts, trucks]. Far haven is a city, the harbour
 * towns lively, the villages a car or two (each town also takes only as many visitors at once as its
 * streets hold, sim.ts CAP_M). Trucks live where they can stop: far haven's wider streets, and the
 * roads round the capital's gates. ('bigtown' is the capital's gates: its own traffic stays on its
 * plateau, traffic/; nobody here lives or calls there, they only pass its gate roundabouts.)
 */
export type Home = readonly [id: string, cars: number, compacts: number, trucks: number];
export const HOMES: readonly Home[] = [
  ['far-haven', 20, 6, 2],
  ['port-pebble', 6, 2, 0],
  ['coral-cove', 4, 2, 0],
  ['millbrook', 2, 0, 1],
  ['snowberry', 2, 0, 0],
  ['puffin-bay', 2, 1, 0],
  ['clover', 2, 0, 0],
  ['driftwood', 2, 1, 0],
];

/**
 * Bus lines: route number, the towns it runs between (out and back; a town twice: two stops in it; a
 * town alone: one stop, round a loop back to it), buses on it. A bus keeps to the turns and streets its
 * body clears the walks on (net.ts KERB_TOL) and to short runs it cannot stop in (CHAIN_OF): the region
 * has one such loop by a town, round the block by far haven's park row. (The village lines ran their
 * buses through the lanes the villagers' cars roam, a whole run of single file held at once: the
 * villages jammed behind them.)
 */
export interface LineSpec {
  no: number;
  name: string;
  towns: readonly string[];
  buses: number;
}
export const LINES: readonly LineSpec[] = [{ no: 31, name: 'the city loop', towns: ['far-haven'], buses: 1 }];

/** How strongly each town draws visitors (by Settlement.id; the villages VILLAGE). */
const DRAW: Record<string, number> = { 'far-haven': 6, 'port-pebble': 2.5, 'coral-cove': 1.5, bigtown: 0 };
/** How far (m) from its square a town's second stop is, on a loop round it ('id/across'; no line has one now). */
const ACROSS = 90;
/** A village's draw (its narrow lanes take a visitor or two at a time). */
const VILLAGE = 0.4;

export interface Stop {
  lane: number;
  /** Where the bus's front stops (arc length on the lane). */
  s: number;
  town: number;
}

export interface Line {
  no: number;
  name: string;
  /** Stops in running order; the bus cycles through them. */
  stops: Stop[];
}

export interface Routes {
  /** Per vehicle: kind (KINDS index), home town, bus line (−1). */
  kind: Uint8Array;
  home: Int16Array;
  line: Int16Array;
  lines: Line[];
  /** Town draw (settlement index) and the towns of each component. */
  draw: Float64Array;
  towns: number[][];
  /**
   * toTown[((cls · nT + town) · nL + lane) · CHAIN_MAX + dep]: seconds from the end of `lane`, `dep` lanes
   * into a chain (0: a lane it may wait in), into a lane of `town` it may wait in (Infinity: no way).
   */
  toTown: Float32Array;
  /** toStop[(stopKey · nL + lane) · CHAIN_MAX + dep]: the same for a bus to its stop lane's start. */
  toStop: Float32Array;
  /** Per line stop: its key into toStop. */
  stopKey: Int32Array[];
  nT: number;
}

/** The fleet and its lines for `net` (specs may pass their own homes and lines). */
export function buildRoutes(net: Net, seed: number, specs: readonly LineSpec[] = LINES, homes: readonly Home[] = HOMES): Routes {
  const { region, nL, nC } = net;
  const lanes = region.lanes;
  const S = region.settlements;
  const nT = S.length;
  const idx = (id: string) => S.findIndex((s) => s.id === id);
  const time = (g: number) => net.len[g] / Math.max(2, g < nL ? lanes[g].speed : net.prof[g][0]);

  const D = CHAIN_MAX;
  /**
   * Seconds from the end of every lane to the start of any target lane for kind k, by how deep into a
   * chain of lanes it may not wait in the lane is (out[o + l·D + dep]: dep 0 on a lane it may wait in,
   * 1 … D − 1 the lanes of a chain; Infinity: no way that keeps every chain within CHAIN_MAX turns).
   */
  const dist = new Float64Array(nL * D);
  const tableTo = (targets: (l: number) => boolean, k: number, out: Float32Array, o: number) => {
    const d = dist.fill(Infinity);
    const w = (l: number) => net.wait[k * nL + l] === 1;
    const heap: number[] = [];
    const hv: number[] = [];
    const push = (st: number, v: number) => {
      if (v >= d[st]) return;
      d[st] = v;
      let i = heap.length;
      heap.push(st);
      hv.push(v);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hv[p] <= v) break;
        heap[i] = heap[p];
        hv[i] = hv[p];
        i = p;
      }
      heap[i] = st;
      hv[i] = v;
    };
    const pop = () => {
      const st = heap[0];
      const v = hv[0];
      const ls = heap.pop()!;
      const lv = hv.pop()!;
      if (heap.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && hv[c + 1] < hv[c]) c++;
          if (hv[c] >= lv) break;
          heap[i] = heap[c];
          hv[i] = hv[c];
          i = c;
        }
        heap[i] = ls;
        hv[i] = lv;
      }
      return v === d[st] ? st : -1;
    };
    /**
     * Every state of lane f whose turn into m keeps the chain within bounds (into a target it may not
     * wait in, with room left in the chain for the way on from it to one it may).
     */
    const Dk = CHAIN_OF[k];
    const into = (f: number, m: number, v: number, target: boolean) => {
      const top = w(m) ? Dk - 1 : target ? Dk - net.hops[k * nL + m] - 1 : Dk - 2;
      if (w(f)) {
        if (top >= 0) push(f * D, v);
      } else for (let dep = 1; dep <= top; dep++) push(f * D + dep, v);
    };
    for (let c = 0; c < nC; c++) if (net.ok[k * nC + c] && targets(net.to[c])) into(net.from[c], net.to[c], time(nL + c), true);
    while (heap.length) {
      const st = pop();
      if (st < 0) continue;
      const u = (st / D) | 0;
      const du = st - u * D;
      const base = time(u) + d[st];
      for (const c of lanes[u].prev) {
        if (!net.ok[k * nC + c]) continue;
        const f = net.from[c];
        const v = time(nL + c) + base;
        if (w(u)) into(f, u, v, false);
        else if (w(f) ? du === 1 : du >= 2) push(f * D + (w(f) ? 0 : du - 1), v);
      }
    }
    out.set(d, o);
  };

  // (into a lane of the town it may wait in: a short one that only leads out, to a dead end, is no way in)
  const toTown = new Float32Array(3 * nT * nL * D);
  for (let cls = 0; cls < 3; cls++) {
    const k = cls === 0 ? 0 : cls + 1;
    for (let t = 0; t < nT; t++) tableTo((l) => net.laneTown[l] === t && net.wait[k * nL + l] === 1, k, toTown, (cls * nT + t) * nL * D);
  }

  // ── bus stops: on a bus lane of the town nearest its square, the whole bus clear of crossings ──
  const B = KINDS[3];
  /** (`across`: a stop across the town, ACROSS m from its square, for a loop round it) */
  const cands = (town: number, across: boolean): Array<Stop & { d: number }> => {
    const sq = S[town].square;
    const sqDir = sq ? chartToDir(S[town].chart, sq.x, sq.z) : S[town].dir;
    const out: Array<Stop & { d: number }> = [];
    for (let l = 0; l < nL; l++) {
      // (a lane of the town, or the road in up to its edge, the bus may wait in: it never stands inside a
      // run it holds alone, so a village of narrow lanes is served at its edge)
      const inTown = net.laneTown[l] === town || (!across && region.nodes[lanes[l].to].settlement === town);
      if (!inTown || !net.wait[3 * nL + l] || net.stopS[l] < B.len + 1 || !lanes[l].next.some((c) => net.ok[3 * nC + c]) || !lanes[l].prev.some((c) => net.ok[3 * nC + c])) continue;
      const x0 = net.xStart[l] >= 0 ? net.xStartS[l] + 1.2 + 0.8 : 0.6;
      const lo = x0 + B.len;
      const hi = net.stopS[l] - 0.8;
      if (hi < lo) continue;
      const p = lanes[l].path;
      let best = Infinity;
      let bs = lo;
      for (let i = 0; i < p.h.length; i++) {
        if (p.s[i] < lo || p.s[i] > hi) continue;
        const dd = Math.acos(Math.min(1, p.dir[i * 3] * sqDir.x + p.dir[i * 3 + 1] * sqDir.y + p.dir[i * 3 + 2] * sqDir.z)) * R;
        if (across ? Math.abs(dd - ACROSS) < Math.abs(best - ACROSS) : dd < best) {
          best = dd;
          bs = p.s[i];
        }
      }
      if (best < Infinity) out.push({ lane: l, s: bs, town, d: across ? Math.abs(best - ACROSS) : best });
    }
    out.sort((a, b) => a.d - b.d || a.lane - b.lane);
    return out.slice(0, across ? 16 : 6);
  };
  const stopLanes: number[] = [];
  const keyOf = (l: number) => {
    let k = stopLanes.indexOf(l);
    if (k < 0) k = stopLanes.push(l) - 1;
    return k;
  };
  const lines: Line[] = [];
  const stopKey: Int32Array[] = [];
  // seconds for a bus from the end of every lane to the start of lane b (cached per target)
  const tables = new Map<number, Float32Array>();
  const cost = (a: Stop, b: Stop) => {
    // (the same lane further on: no way; behind, or the same stop again: round the loop)
    if (a.lane === b.lane && b.s > a.s) return 0;
    let t = tables.get(b.lane);
    if (!t) {
      t = new Float32Array(nL * D);
      tableTo((l) => l === b.lane, 3, t, 0);
      tables.set(b.lane, t);
    }
    let best = Infinity;
    for (let dep = 0; dep < D; dep++) best = Math.min(best, t[a.lane * D + dep]);
    return best;
  };
  for (const L of specs) {
    const ts = L.towns.map((id) => idx(id.replace('/across', '')));
    if (ts.some((t) => t < 0)) continue;
    // out and back: A B C B (then A again)
    const seq = ts.concat(ts.slice(1, -1).reverse());
    const across = L.towns.concat(L.towns.slice(1, -1).reverse()).map((id) => id.endsWith('/across'));
    const cs = seq.map((t, k) => cands(t, across[k]));
    if (cs.some((c) => !c.length)) continue;
    // each visit's stop: the round trip quickest with stops nearest the squares (every combination)
    const pick = new Array<number>(seq.length).fill(0);
    let best = Infinity;
    let bestPick = pick.slice();
    const walk = (k: number) => {
      if (k === seq.length) {
        let v = 0;
        // (the round's driving counts double: a loop that has to go a long way round is no loop)
        for (let j = 0; j < seq.length && v < best; j++) v += cs[j][pick[j]].d + 2 * cost(cs[j][pick[j]], cs[(j + 1) % seq.length][pick[(j + 1) % seq.length]]);
        if (v < best) {
          best = v;
          bestPick = pick.slice();
        }
        return;
      }
      for (let c = 0; c < cs[k].length; c++) {
        pick[k] = c;
        walk(k + 1);
      }
    };
    walk(0);
    if (best === Infinity) continue;
    lines.push({ no: L.no, name: L.name, stops: seq.map((_, k) => ({ lane: cs[k][bestPick[k]].lane, s: cs[k][bestPick[k]].s, town: seq[k] })) });
  }
  for (const ln of lines) stopKey.push(Int32Array.from(ln.stops, (st) => keyOf(st.lane)));
  const toStop = new Float32Array(stopLanes.length * nL * D);
  stopLanes.forEach((l, k) => tableTo((x) => x === l, 3, toStop, k * nL * D));

  // ── the fleet: per home town, cars, compacts, trucks; then the buses ──
  const kind: number[] = [];
  const home: number[] = [];
  const line: number[] = [];
  for (const [id, cars, compacts, trucks] of homes) {
    const t = idx(id);
    if (t < 0) continue;
    for (const [k, nk] of [[0, cars], [1, compacts], [2, trucks]] as const)
      for (let j = 0; j < nk; j++) {
        kind.push(k);
        home.push(t);
        line.push(-1);
      }
  }
  // a seeded shuffle of the non-bus fleet, so the id order mixes towns and kinds
  for (let a = kind.length - 1; a > 0; a--) {
    const b = Math.floor(hash3(seed, a, 7) * (a + 1));
    [kind[a], kind[b]] = [kind[b], kind[a]];
    [home[a], home[b]] = [home[b], home[a]];
  }
  lines.forEach((ln, li) => {
    for (let j = 0; j < specs.find((x) => x.no === ln.no)!.buses; j++) {
      kind.push(3);
      home.push(ln.stops[0].town);
      line.push(li);
    }
  });

  const draw = Float64Array.from(S, (s) => DRAW[s.id] ?? VILLAGE);
  const towns = region.components.map((ns) => [...new Set(ns.map((n) => region.nodes[n].settlement).filter((t) => t >= 0))].sort((a, b) => a - b));
  return { kind: Uint8Array.from(kind), home: Int16Array.from(home), line: Int16Array.from(line), lines, draw, towns, toTown, toStop, stopKey, nT };
}
