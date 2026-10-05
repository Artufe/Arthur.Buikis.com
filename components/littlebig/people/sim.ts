// People (B2): the pedestrian simulation. Pure (no three.js), deterministic, zero-alloc per step.
//
// Walkers are persistent agents on the plan's walk graph (sidewalks, corners, zebra crossings,
// plaza and park paths, the market lane). Each one integrates a 2D position in plan space and
// steers at a target LOOK metres ahead along its walk edge, offset to the right of travel (so the
// two directions pass each other), and:
//   - sidesteps every point obstacle on its path (lamps, trunks, benches, café tables, bus
//     shelters, people sitting or standing about) by choosing a lateral offset outside their discs
//     (a 1D interval problem per step);
//   - sidesteps oncoming and standing people the same way, follows slower people walking its way,
//     and yields to crossing traffic of other people by id;
//   - at a zebra crossing waits at the kerb (0.5 m back, in the right half, so people arriving
//     from the other side pass on its left, and stepping back to give them the landing) until the
//     crossing is open — CrossingState.blocked clear, plus a per-crossing walk cycle so people
//     cross in little groups — and flags it busy from the moment it commits until it is past the
//     far kerb. Someone committed but still on the kerb steps back if `blocked` comes up; nobody
//     ever commits while it is up, so busy never rises under a car. A crosser held up on the
//     crossing for JAM_S squeezes past standing people and idlers (a brief overlap beats a jam);
//   - is pushed out of buildings and obstacles as a last resort (push-outs are rate-limited, so
//     nobody jumps sideways in a crowd);
//   - turns back after a few seconds of being stuck, or after ~17 s of waiting at a kerb.
// At a node it picks its next edge at random (seeded per decision), biased toward its home radius
// so downtown stays busier than the outskirts. Dogs are followers of their owner (trotting ahead
// on the left, at heel while the owner waits). `on` thins the crowd at night: an inactive walker is
// frozen and drawn by nobody (the renderer only toggles it out of view).
//
// Zero-alloc: no Math.hypot (V8 allocates its argument list), scratch objects of private classes
// (their double fields never share a map with someone else's {x, z}), and CityIndex queries only
// where a walker is not well inside its edge's precomputed paving room.
//
// Time jumps (setTime / init): walkers are re-placed from a hash of t and settled for SETTLE_S of
// sim, so the same t always gives the same world.

import type { CityIndex, CityPlan, Feature, PathSample, Polyline, WalkEdge } from '../world/city/types';
import { hash3, hashSeed, Rng } from '../world/rng';

/** Body radius for collisions (shoulders ~0.44 m wide). */
export const BODY_R = 0.22;
/** Centre-to-centre distance two people keep when they pass. */
const PASS_GAP = 0.56;
/** People never come closer than this, centre to centre (m). */
const SEP = 2 * BODY_R + 0.04;
/** Steering target distance along the path (m). */
const LOOK = 1.1;
/** Sideways speed limit of the lateral offset (m/s). */
const LAT_SPEED = 0.9;
/** How far ahead (m) obstacles shape the lateral choice. */
const OBS_AHEAD = 4.5;
/** Neighbour grid cell (m): the 3×3 block covers ±CELL around an agent. */
const CELL = 3;
/** Crossing walk cycle: open for CROSS_OPEN of every CROSS_CYCLE seconds (offset per crossing). */
const CROSS_CYCLE = 13;
const CROSS_OPEN = 4.5;
/** Kerb waiters stand this far back from the kerb line (m). */
const WAIT_BACK = 0.5;
/** Seconds held up on a crossing before squeezing past standing people and idlers. */
const JAM_S = 2.5;
/** Speed limit of push-outs (people, props) on top of a walker's own step (m/s). */
const PUSH_SPEED = 1.6;
/** A walker this close to its edge's end moves onto the next edge (m). */
const END_U = 0.03;
/** Seconds of sim run after a time-jump placement so people settle into their stride. */
const SETTLE_S = 1.5;
const SETTLE_DT = 1 / 30;
export const SETTLE_STEPS = Math.round(SETTLE_S / SETTLE_DT);
/** Seconds of unwanted standstill after which a walker turns back. */
const STUCK_S = 3.5;

export const enum Pose {
  Walk = 0,
  Sit = 1,
  Stand = 2,
  Cafe = 3,
  Lean = 4,
}

export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

/** A person who stays put: sitting on a bench or at a café table, or standing about. */
export interface Idler {
  x: number;
  z: number;
  /** Height of the feet / seat reference above the plateau (m): the seat top for sitters. */
  h: number;
  /** Facing as a plan direction (unit). */
  fx: number;
  fz: number;
  pose: Pose;
  /** Look id (index into the person table). */
  id: number;
}

/** Per-edge data the walkers need, precomputed once. */
interface EdgeInfo {
  e: WalkEdge;
  len: number;
  /** Lateral room for a body centre right (hiR) / left (hiL) of the centreline, a→b frame (m). */
  hiR: number;
  hiL: number;
  /** Obstacles near the edge: arc length (a→b, past the ends along the end tangent), lateral (right of a→b), clearance, obstacle index. */
  oS: Float64Array;
  oL: Float64Array;
  oR: Float64Array;
  oI: Int32Array;
  crossing: boolean;
  /** Walking surface height (m above the plateau); crossings: the kerb side. */
  hEdge: number;
  /** Crossings: the carriageway height. */
  hRoad: number;
  /** Crossings: arc length from the path's start / end to the kerb. */
  kerbA: number;
  kerbB: number;
  /** Crossings: the landing on the start / end side (up to 0.35 m short of the kerb, ± the strip) is all paving. */
  landA: boolean;
  landB: boolean;
  kindW: number;
}

const KIND_W: Record<string, number> = { sidewalk: 1, corner: 1, crossing: 0.75, plaza: 1.5, park: 1.15, footpath: 1.3 };
const DEFAULT_R: Record<string, number> = { streetlight: 0.2, lamp: 0.2, hydrant: 0.25, flag: 0.15, fountain: 1.6, planter: 0.5, statue: 0.8, tree: 0.4 };
/** Props that are several discs: local x offsets, lateral offset, radius. */
const MULTI: Record<string, [number[], number, number]> = { bench: [[-0.6, 0, 0.6], 0, 0.42], 'cafe-table': [[-0.64, 0, 0.64], 0, 0.42], 'bus-stop': [[-1.2, -0.6, 0, 0.6, 1.2], 0.05, 0.62] };

/** Obstacle discs for walkers from the plan's features (bigger props as several discs). */
export function featureObstacles(features: readonly Feature[]): Obstacle[] {
  const out: Obstacle[] = [];
  for (const f of features) {
    const c = Math.cos(f.angle);
    const s = Math.sin(f.angle);
    const at = (lx: number, lz: number, r: number) => out.push({ x: f.x + lx * c - lz * s, z: f.z + lx * s + lz * c, r });
    const m = MULTI[f.kind];
    if (m) for (const lx of m[0]) at(lx, m[1], m[2]);
    if (f.kind === 'bus-stop') at(1.75, -0.4, 0.12);
    const r = m ? 0 : Math.max(f.r ?? 0, DEFAULT_R[f.kind] ?? 0);
    if (r > 0) at(0, 0, r);
  }
  return out;
}

/** Scratch shapes of their own (see the header: zero-alloc). */
class SL {
  s = 0;
  l = 0;
  d = 0;
  /** Inputs of nearestIn: the query point and the arc length to search up to. */
  x = 0;
  z = 0;
  sMax = 0;
}
class Sample implements PathSample {
  x = 0;
  z = 0;
  tx = 0;
  tz = 0;
  i = 0;
  /** Input of sampleIn: the arc length. */
  s = 0;
}
const SL0 = new SL();
const SM0 = new Sample();
class XZ {
  x = 0;
  z = 0;
}

/** Nearest point on a polyline from sample index lo while s ≤ sMax: arc length and signed lateral offset (right of a→b). */
export function nearestSL(pl: Polyline, x: number, z: number, out: { s: number; l: number; d: number }, lo = 0, sMax = Infinity): void {
  SL0.x = x;
  SL0.z = z;
  SL0.sMax = sMax;
  nearestIn(pl, SL0, lo);
  out.s = SL0.s;
  out.l = SL0.l;
  out.d = SL0.d;
}

/** nearestSL with its inputs in `out` (x, z, sMax): doubles never cross a call boundary in the hot loop. */
function nearestIn(pl: Polyline, out: SL, lo: number): void {
  const p = pl.pts;
  const S = pl.s;
  const x = out.x;
  const z = out.z;
  const sMax = out.sMax;
  let best = Infinity;
  for (let i = lo; i < (p.length >> 1) - 1 && S[i] <= sMax; i++) {
    const x0 = p[i * 2];
    const z0 = p[i * 2 + 1];
    const dx = p[i * 2 + 2] - x0;
    const dz = p[i * 2 + 3] - z0;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
    const qx = x - x0 - dx * t;
    const qz = z - z0 - dz * t;
    const d2 = qx * qx + qz * qz;
    if (d2 < best) {
      best = d2;
      out.s = S[i] + t * (S[i + 1] - S[i]);
      out.l = (qz * dx - qx * dz) / Math.sqrt(l2); // right of (dx, dz) is (−dz, dx)
    }
  }
  out.d = Math.sqrt(best);
}

/** Point and unit tangent at arc length s (clamped; loops wrap). The zero-alloc twin of world/city/path sampleAt. */
export function samplePath(pl: Polyline, s: number, out: PathSample): void {
  SM0.s = s;
  SM0.i = out.i;
  sampleIn(pl, SM0);
  out.x = SM0.x;
  out.z = SM0.z;
  out.tx = SM0.tx;
  out.tz = SM0.tz;
  out.i = SM0.i;
}

/** samplePath with its input in out.s. */
function sampleIn(pl: Polyline, out: Sample): void {
  const S = pl.s;
  const P = pl.pts;
  const n = P.length >> 1;
  const L = pl.length;
  let s = out.s;
  s = pl.closed && L > 0 ? ((s % L) + L) % L : s < 0 ? 0 : s > L ? L : s;
  let i = out.i | 0;
  if (i < 0 || i > n - 2) i = 0;
  if (S[i] > s || S[i + 1] < s) {
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
  }
  const t = (s - S[i]) / (S[i + 1] - S[i] || 1);
  const x0 = P[i * 2];
  const z0 = P[i * 2 + 1];
  const dx = P[i * 2 + 2] - x0;
  const dz = P[i * 2 + 3] - z0;
  const l = Math.sqrt(dx * dx + dz * dz) || 1;
  out.x = x0 + dx * t;
  out.z = z0 + dz * t;
  out.tx = dx / l;
  out.tz = dz / l;
  out.i = i;
}

export interface WalkerTraits {
  vPref: number;
  /** Preferred lateral position as a fraction of the room to the right of travel. */
  pref: number;
  /** Radius (m from the city centre) this walker gravitates to. */
  home: number;
}

const F = (n: number) => new Float64Array(n);

export class PeopleSim {
  readonly n: number;
  readonly plan: CityPlan;
  readonly index: CityIndex;
  readonly info: EdgeInfo[];
  readonly idlers: Idler[];
  readonly obstacles: Obstacle[];
  /** obstacles[k] for k ≥ nProps are idle people. */
  readonly nProps: number;
  // state
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vz: Float64Array;
  readonly hx: Float64Array;
  readonly hz: Float64Array;
  readonly phx: Float64Array;
  readonly phz: Float64Array;
  readonly h: Float64Array;
  readonly ph: Float64Array;
  readonly gait: Float64Array;
  readonly pgait: Float64Array;
  readonly edge: Int32Array;
  readonly dir: Int8Array;
  readonly u: Float64Array;
  readonly next: Int32Array;
  readonly lat: Float64Array;
  readonly commit: Uint8Array;
  readonly stuck: Float32Array;
  /** Seconds a committed crosser has been held up on its crossing; ≥ JAM_S: squeezing past. */
  readonly jam: Float32Array;
  readonly decisions: Int32Array;
  /** 1 = out and about; 0 = gone home for the night (frozen, not drawn). */
  readonly on: Uint8Array;
  // traits
  readonly vPref: Float32Array;
  readonly pref: Float32Array;
  readonly home: Float32Array;
  // dogs (followers): owner walker, position, heading, gait, speed — and the previous step's, for interpolation
  readonly dOwner: Int32Array;
  readonly dx: Float64Array;
  readonly dz: Float64Array;
  readonly dpx: Float64Array;
  readonly dpz: Float64Array;
  readonly dhx: Float64Array;
  readonly dhz: Float64Array;
  readonly dg: Float64Array;
  readonly dpg: Float64Array;
  readonly dsp: Float64Array;
  // scratch
  /** Per walker after its step: lateral offset (travel-right) and travel tangent, and whether it is well inside its paving room. */
  private readonly latW: Float64Array;
  private readonly tX: Float64Array;
  private readonly tZ: Float64Array;
  private readonly safe: Uint8Array;
  private readonly gridHead: Int32Array;
  private readonly gridNext: Int32Array;
  private readonly gridN: number;
  private readonly gridR: number;
  private readonly crossPhase: Float32Array;
  private readonly ivLo = F(48);
  private readonly ivHi = F(48);
  private readonly ivAlong = F(48);
  private nIv = 0;
  private readonly smp = new Sample();
  private readonly col = new XZ();
  private readonly near = new SL();
  private readonly near2 = new SL();
  private readonly seed: number;
  private readonly sb: Uint8Array;
  private readonly zero: Uint8Array;

  constructor(plan: CityPlan, index: CityIndex, seed: number, traits: WalkerTraits[], idlers: Idler[], dogOwners: number[] = []) {
    this.plan = plan;
    this.index = index;
    this.seed = seed;
    this.idlers = idlers;
    const n = (this.n = traits.length);
    this.x = F(n);
    this.z = F(n);
    this.px = F(n);
    this.pz = F(n);
    this.vx = F(n);
    this.vz = F(n);
    this.hx = F(n);
    this.hz = F(n);
    this.phx = F(n);
    this.phz = F(n);
    this.h = F(n);
    this.ph = F(n);
    this.gait = F(n);
    this.pgait = F(n);
    this.u = F(n);
    this.lat = F(n);
    this.latW = F(n);
    this.tX = F(n);
    this.tZ = F(n);
    this.safe = new Uint8Array(n);
    this.edge = new Int32Array(n);
    this.next = new Int32Array(n);
    this.decisions = new Int32Array(n);
    this.dir = new Int8Array(n);
    this.commit = new Uint8Array(n);
    this.on = new Uint8Array(n).fill(1);
    this.stuck = new Float32Array(n);
    this.jam = new Float32Array(n);
    this.vPref = Float32Array.from(traits, (t) => t.vPref);
    this.pref = Float32Array.from(traits, (t) => t.pref);
    this.home = Float32Array.from(traits, (t) => t.home);
    const nd = dogOwners.length;
    this.dOwner = Int32Array.from(dogOwners);
    this.dx = F(nd);
    this.dz = F(nd);
    this.dpx = F(nd);
    this.dpz = F(nd);
    this.dhx = F(nd);
    this.dhz = F(nd);
    this.dg = F(nd);
    this.dpg = F(nd);
    this.dsp = F(nd);
    this.sb = new Uint8Array(plan.walkEdges.length);
    this.zero = new Uint8Array(plan.walkEdges.length);

    // Obstacles: the plan's props plus every idle person (they stand where walkers must not).
    const obs = (this.obstacles = featureObstacles(plan.features));
    this.nProps = obs.length;
    for (const p of idlers) {
      const k = p.pose === Pose.Stand ? 0 : p.pose === Pose.Lean ? -0.1 : 0.25;
      obs.push({ x: p.x + p.fx * k, z: p.z + p.fz * k, r: k ? 0.38 : 0.3 }); // sitters: knees and feet
    }
    const near = this.near;
    const ps = this.smp;
    const bad = (l: number) => {
      const k = index.classify(ps.x - ps.tz * l, ps.z + ps.tx * l);
      return k === 'road' || k === 'intersection' || k === 'water' || k === 'building';
    };
    this.info = plan.walkEdges.map((e) => {
      const crossing = e.kind === 'crossing';
      const pl = e.path;
      const len = pl.length;
      // Lateral room, narrowed where the paving under the edge is narrower than its width (corner
      // edges run onto the intersection patch at their ends). Crossings: inside the painted strip.
      let hiR = crossing ? Math.max(0.05, e.width / 2 - 0.5) : e.width / 2 - BODY_R - 0.04;
      let hiL = hiR;
      for (let s = 0; !crossing && s <= len; s += 0.5) {
        samplePath(pl, s, ps);
        while (hiR > 0 && bad(hiR + BODY_R * 0.8)) hiR -= 0.05;
        while (hiL > 0 && bad(-hiL - BODY_R * 0.8)) hiL -= 0.05;
      }
      const oS: number[] = [];
      const oL: number[] = [];
      const oR: number[] = [];
      const oI: number[] = [];
      const np = pl.pts.length >> 1;
      obs.forEach((o, k) => {
        const dx = o.x - pl.pts[0];
        const dz = o.z - pl.pts[1];
        if (dx * dx + dz * dz > (len + e.width + 3) ** 2) return;
        nearestSL(pl, o.x, o.z, near);
        if (near.d < e.width / 2 + o.r + BODY_R + 0.4) {
          // past an end: along the end tangent, so a café table just beyond a node is not "at" it
          if (near.s < 1e-6 || near.s > len - 1e-6) {
            samplePath(pl, near.s < 1e-6 ? 0 : len, ps);
            const j = near.s < 1e-6 ? 0 : np - 1;
            const qx = o.x - pl.pts[j * 2];
            const qz = o.z - pl.pts[j * 2 + 1];
            near.s += qx * ps.tx + qz * ps.tz;
            near.l = qz * ps.tx - qx * ps.tz;
          }
          oS.push(near.s);
          oL.push(near.l);
          oR.push(o.r + BODY_R + 0.07);
          oI.push(k);
        }
      });
      let kerbA = len / 2;
      let kerbB = len / 2;
      const road = (s: number) => {
        samplePath(pl, s, ps);
        const k = index.classify(ps.x, ps.z);
        return k === 'road' || k === 'intersection';
      };
      for (let s = 0; crossing && s < len; s += 0.04) if (road(s)) { kerbA = s; break; }
      for (let s = len; crossing && s > 0; s -= 0.04) if (road(s)) { kerbB = len - s; break; }
      const land = (s0: number, s1: number) => {
        for (let s = s0; s <= s1; s += 0.1) {
          samplePath(pl, s, ps);
          for (let l = -hiR - BODY_R; l <= hiR + BODY_R + 1e-6; l += 0.1) if (bad(l)) return false;
        }
        return true;
      };
      const landA = crossing && land(0, kerbA - 0.3);
      const landB = crossing && land(len - kerbB + 0.3, len);
      samplePath(pl, len / 2, ps);
      const hMid = index.groundH(ps.x, ps.z);
      return {
        e, len, crossing, kerbA, kerbB, landA, landB,
        hiR: Math.max(0, hiR), hiL: Math.max(0, hiL),
        hEdge: crossing ? index.groundH(pl.pts[0], pl.pts[1]) : hMid, hRoad: hMid,
        oS: Float64Array.from(oS), oL: Float64Array.from(oL), oR: Float64Array.from(oR), oI: Int32Array.from(oI),
        kindW: KIND_W[e.kind] ?? 1,
      };
    });
    this.crossPhase = Float32Array.from(plan.walkEdges, (e) => hash3(e.id, seed, 7) * CROSS_CYCLE);
    this.gridR = plan.radius + 4;
    this.gridN = Math.ceil((2 * this.gridR) / CELL);
    this.gridHead = new Int32Array(this.gridN * this.gridN);
    this.gridNext = new Int32Array(n);
  }

  // ── Placement (time jumps) ──

  /** Re-place every walker for sim time t (deterministic in t), then settle. `thin`: share gone home. */
  placeAt(t: number, busy: Uint8Array | null, blocked: Uint8Array | null, thin = 0): void {
    this.scatter(t, thin);
    this.settle(t, 0, SETTLE_STEPS, busy, blocked);
  }

  /** Placement half of placeAt: scatter walkers over the walk graph from a hash of t. */
  scatter(t: number, thin = 0): void {
    const rng = new Rng(hashSeed(this.seed, `people@${Math.round(t * 60)}`));
    const info = this.info;
    const smp = this.smp;
    let total = 0;
    for (const f of info) if (!f.crossing) total += f.len * f.kindW;
    for (let i = 0; i < this.n; i++) {
      this.on[i] = hash3(i, 91, this.seed) >= thin ? 1 : 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        let r = rng.float() * total;
        let k = 0;
        for (; k < info.length - 1; k++) if (!info[k].crossing && (r -= info[k].len * info[k].kindW) <= 0) break;
        const f = info[k];
        const s = rng.range(0.2, Math.max(0.21, f.len - 0.2));
        samplePath(f.e.path, s, smp);
        // home bias (rejection)
        const dh = (Math.sqrt(smp.x * smp.x + smp.z * smp.z) - this.home[i]) / 26;
        if (f.crossing || (attempt < 40 && rng.float() > Math.exp(-dh * dh) + 0.08)) continue;
        const d: 1 | -1 = rng.float() < 0.5 ? 1 : -1;
        const lat = this.pref[i] * (d > 0 ? f.hiR : f.hiL);
        const x = smp.x - smp.tz * d * lat;
        const z = smp.z + smp.tx * d * lat;
        if (attempt < 59) {
          // clear of props and of everyone placed so far (the last attempt takes what it gets)
          if (!this.clear(f, s, d * lat)) continue;
          let crowd = false;
          for (let j = 0; j < i && !crowd; j++) crowd = (this.x[j] - x) ** 2 + (this.z[j] - z) ** 2 < 0.81;
          if (crowd) continue;
        }
        this.edge[i] = k;
        this.dir[i] = d;
        this.u[i] = d > 0 ? s : f.len - s;
        this.x[i] = x;
        this.z[i] = z;
        this.lat[i] = lat;
        const v = this.vPref[i];
        this.vx[i] = smp.tx * d * v;
        this.vz[i] = smp.tz * d * v;
        this.hx[i] = smp.tx * d;
        this.hz[i] = smp.tz * d;
        this.h[i] = f.hEdge;
        this.gait[i] = rng.range(0, 10);
        this.commit[i] = 0;
        this.stuck[i] = 0;
        this.jam[i] = 0;
        this.safe[i] = 0;
        this.decisions[i] = Math.floor(t * 3) & 0xffff;
        this.next[i] = this.chooseNext(i);
        break;
      }
    }
    this.placeDogs();
  }

  /**
   * Settle half of placeAt: run settle steps [from, to) of SETTLE_STEPS (callers may split them
   * across frames). The last one snaps the interpolation state.
   */
  settle(t: number, from: number, to: number, busy: Uint8Array | null, blocked: Uint8Array | null): void {
    for (let k = from; k < to; k++) this.step(SETTLE_DT, t - SETTLE_S + k * SETTLE_DT, busy ?? this.sb, blocked ?? this.zero, 0, 0, false);
    if (to >= SETTLE_STEPS) this.snap();
  }

  /**
   * A camera cut to street level at plan (cx, cz) looking along plan (fx, fz) (unit): walkers in a
   * 1.6 m disc round the eye or a corridor ahead of it step along their own path out of it
   * (invisible: the whole view just changed), so a shot never opens on a face in the lens.
   */
  clearAround(cx: number, cz: number, fx: number, fz: number): void {
    const smp = this.smp;
    for (let i = 0; i < this.n; i++) {
      const f = this.info[this.edge[i]];
      if (!this.on[i] || f.crossing || !this.inCut(i, cx, cz, fx, fz)) continue;
      const u0 = this.u[i];
      const d = this.dir[i];
      const l = Math.max(-(d > 0 ? f.hiL : f.hiR), Math.min(d > 0 ? f.hiR : f.hiL, this.lat[i]));
      // the nearest free spot along its own edge, ahead first
      for (let k = 1; k <= 48; k++) {
        const u = u0 + (k & 1 ? 1 : -1) * 0.5 * ((k + 1) >> 1);
        if (u < 0.2 || u > f.len - 0.2) continue;
        samplePath(f.e.path, d > 0 ? u : f.len - u, smp);
        this.x[i] = smp.x - smp.tz * d * l;
        this.z[i] = smp.z + smp.tx * d * l;
        this.u[i] = u;
        if (!this.inCut(i, cx, cz, fx, fz) && !this.crowded(i)) break;
      }
      this.lat[i] = l;
      this.safe[i] = 0;
    }
    this.placeDogs();
    this.snap();
  }

  /** Is walker i within 0.8 m of another walker or a prop / idle person? */
  private crowded(i: number): boolean {
    const x = this.x[i];
    const z = this.z[i];
    for (let j = 0; j < this.n; j++) if (j !== i && this.on[j] && (this.x[j] - x) ** 2 + (this.z[j] - z) ** 2 < 0.64) return true;
    const f = this.info[this.edge[i]];
    for (let q = 0; q < f.oI.length; q++) {
      const o = this.obstacles[f.oI[q]];
      if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.r + BODY_R + 0.1) ** 2) return true;
    }
    return false;
  }

  /** Inside the cut's clear zone: the disc, or the corridor ahead (wider and longer for someone walking at the lens). */
  private inCut(i: number, cx: number, cz: number, fx: number, fz: number): boolean {
    const dx = this.x[i] - cx;
    const dz = this.z[i] - cz;
    const along = dx * fx + dz * fz;
    const at = dx * this.hx[i] + dz * this.hz[i] < 0;
    return dx * dx + dz * dz < 1.6 * 1.6 || (along > 0 && along < (at ? 8 : 5.5) && Math.abs(dx * fz - dz * fx) < (at ? 1.7 : 1.0));
  }

  private clear(f: EdgeInfo, s: number, latAB: number): boolean {
    for (let k = 0; k < f.oS.length; k++) if ((f.oS[k] - s) ** 2 + (f.oL[k] - latAB) ** 2 < (f.oR[k] + 0.05) ** 2) return false;
    return true;
  }

  /** Copy the state into the previous-step state (interpolation). */
  private snap(): void {
    this.px.set(this.x);
    this.pz.set(this.z);
    this.phx.set(this.hx);
    this.phz.set(this.hz);
    this.ph.set(this.h);
    this.pgait.set(this.gait);
    this.dpx.set(this.dx);
    this.dpz.set(this.dz);
    this.dpg.set(this.dg);
  }

  private placeDogs(): void {
    for (let k = 0; k < this.dOwner.length; k++) {
      const i = this.dOwner[k];
      this.dhx[k] = this.hx[i];
      this.dhz[k] = this.hz[i];
      this.dogTarget(k, i, false);
      this.dx[k] = this.col.x;
      this.dz[k] = this.col.z;
    }
  }

  /** Where dog k wants to be (into col): a little ahead on the owner's left, or at heel. */
  private dogTarget(k: number, i: number, heel: boolean): void {
    const a = heel ? -0.32 : 0.75;
    const b = 0.42 + 0.06 * (k & 1);
    this.col.x = this.x[i] + this.hx[i] * a + this.hz[i] * b; // left of (hx, hz) is (hz, −hx)
    this.col.z = this.z[i] + this.hz[i] * a - this.hx[i] * b;
  }

  /** The node walker i is heading for on its current edge. */
  private endNode(i: number): number {
    const e = this.info[this.edge[i]].e;
    return this.dir[i] > 0 ? e.b : e.a;
  }

  /** Move walker i onto its chosen next edge (progress 0) and choose the one after. */
  private enterNext(i: number): void {
    const nextE = this.next[i];
    this.dir[i] = (nextE === this.edge[i] ? -this.dir[i] : this.info[nextE].e.a === this.endNode(i) ? 1 : -1) as 1 | -1;
    this.edge[i] = nextE;
    this.u[i] = 0;
    this.commit[i] = 0;
    this.jam[i] = 0;
    this.next[i] = this.chooseNext(i);
  }

  /** Pick the next edge at the end of i's current edge (seeded per decision). */
  private chooseNext(i: number): number {
    const cur = this.edge[i];
    const node = this.plan.walkNodes[this.endNode(i)];
    let total = 0;
    for (const id of node.edges) if (id !== cur) total += this.edgeWeight(id, node.id, i);
    let r = hash3(i, this.decisions[i]++, this.seed) * total;
    for (const id of node.edges) if (id !== cur && (r -= this.edgeWeight(id, node.id, i)) <= 0) return id;
    return cur; // dead end: turn back on the same edge
  }

  private edgeWeight(id: number, from: number, i: number): number {
    const f = this.info[id];
    const far = this.plan.walkNodes[f.e.a === from ? f.e.b : f.e.a];
    const dh = (Math.sqrt(far.x * far.x + far.z * far.z) - this.home[i]) / 22;
    return f.kindW * (Math.exp(-dh * dh) + 0.12);
  }

  /** Sample walker i's travel path at progress smp.s (may run onto the next edge) into smp, tangent along travel. */
  private sampleTravel(i: number): void {
    const smp = this.smp;
    let f = this.info[this.edge[i]];
    let d = this.dir[i];
    let uAhead = smp.s;
    if (uAhead > f.len && this.next[i] !== this.edge[i]) {
      const node = this.endNode(i);
      uAhead = Math.min(uAhead - f.len, (f = this.info[this.next[i]]).len);
      d = f.e.a === node ? 1 : -1;
    }
    uAhead = Math.min(uAhead, f.len);
    smp.s = d > 0 ? uAhead : f.len - uAhead;
    sampleIn(f.e.path, smp);
    smp.tx *= d;
    smp.tz *= d;
  }

  /** Update u[i] by projecting the position onto the current edge near the old progress; near.l × dir is the lateral (right of travel). */
  private project(i: number): void {
    const f = this.info[this.edge[i]];
    const S = f.e.path.s;
    const d = this.dir[i];
    const s0 = d > 0 ? this.u[i] : f.len - this.u[i];
    let lo = 0;
    let hi = S.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (S[mid + 1] < s0 - 2) lo = mid + 1;
      else hi = mid;
    }
    const near = this.near;
    near.x = this.x[i];
    near.z = this.z[i];
    near.sMax = s0 + 2;
    nearestIn(f.e.path, near, lo);
    const uNew = d > 0 ? near.s : f.len - near.s;
    if (uNew > this.u[i] - 0.5) this.u[i] = uNew; // never backwards by projection noise at sharp joints
  }

  /**
   * Near the end of its edge, is walker i already on the next one (closer to it, and past its
   * start)? At a sharp joint a walker offset to the outside reaches its steering target (on the
   * next edge) before its progress on the current edge reaches the end.
   */
  private onNext(i: number): boolean {
    const f = this.info[this.edge[i]];
    const nE = this.next[i];
    if (nE === this.edge[i] || f.len - this.u[i] > LOOK) return false;
    const dCur = this.near.d;
    const g = this.info[nE];
    const n2 = this.near2;
    n2.x = this.x[i];
    n2.z = this.z[i];
    n2.sMax = Infinity;
    nearestIn(g.e.path, n2, 0);
    const uN = g.e.a === this.endNode(i) ? n2.s : g.len - n2.s;
    return uN > 0.05 && n2.d < dCur;
  }

  private buildGrid(): void {
    const N = this.gridN;
    this.gridHead.fill(-1);
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      const R = this.gridR;
      const c = Math.min(N - 1, Math.max(0, Math.floor((this.z[i] + R) / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor((this.x[i] + R) / CELL)));
      this.gridNext[i] = this.gridHead[c];
      this.gridHead[c] = i;
    }
  }

  /**
   * Obstacle intervals for walker i: of its own edge (`next` false), up to its end when it turns
   * there (past it the next edge's own list takes over), or of its next edge (`next`), continuing
   * its progress. `props`: idle people left out. (Integer and object arguments only: see header.)
   */
  private obstacleIvs(i: number, next: boolean, props: boolean): void {
    const cur = this.info[this.edge[i]];
    const turns = this.next[i] !== this.edge[i];
    const f = next ? this.info[this.next[i]] : cur;
    const d = next ? (f.e.a === this.endNode(i) ? 1 : -1) : this.dir[i];
    const u0 = next ? this.u[i] - cur.len : this.u[i];
    const upTo = next || !turns ? OBS_AHEAD : Math.min(OBS_AHEAD, cur.len - u0 + 0.05);
    let k = this.nIv;
    for (let q = 0; q < f.oS.length && k < 48; q++) {
      if (props && f.oI[q] >= this.nProps) continue;
      const along = (d > 0 ? f.oS[q] : f.len - f.oS[q]) - u0;
      if (along <= -0.7 || along >= upTo) continue;
      this.ivLo[k] = f.oL[q] * d - f.oR[q];
      this.ivHi[k] = f.oL[q] * d + f.oR[q];
      this.ivAlong[k++] = Math.max(0, along);
    }
    this.nIv = k;
  }

  /**
   * One fixed step. `busy` is written (cleared first), `blocked` read. (camX, camZ) is the player's
   * plan position, avoided like a standing person of radius camR while camOn.
   */
  step(dt: number, t: number, busy: Uint8Array, blocked: Uint8Array, camX: number, camZ: number, camOn: boolean, camR = 0.75): void {
    this.snap();
    busy.fill(0);
    this.buildGrid();
    const { x, z, px, pz, vx, vz, hx, hz, u, lat, edge, dir, commit, stuck, jam, info, gridHead, gridNext, gridR, smp, ivLo, ivHi, ivAlong, near } = this;
    const N = this.gridN;
    const maxPush = PUSH_SPEED * dt;
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      this.project(i);
      let f = info[edge[i]];
      // Edge transitions (possibly several on very short edges).
      for (let guard = 0; guard < 3 && (u[i] >= f.len - END_U || this.onNext(i)); guard++) {
        this.enterNext(i);
        f = info[edge[i]];
        this.project(i);
      }
      const e = edge[i];
      const d = dir[i];
      const latCur = near.l * d;
      const ui = u[i];
      const xi = x[i];
      const zi = z[i];
      let vDes = this.vPref[i];
      let waiting = false;
      let queue = false;
      let kerbOut = 0;
      let waitU = 0;
      const squeeze = commit[i] > 0 && jam[i] >= JAM_S;

      // Zebra crossings: wait at the kerb, commit when open, flag busy until past the far kerb.
      if (f.crossing) {
        const kerbIn = d > 0 ? f.kerbA : f.kerbB;
        kerbOut = f.len - (d > 0 ? f.kerbB : f.kerbA);
        waitU = Math.max(0, kerbIn - WAIT_BACK);
        // committed but still on the kerb, and a car will not stop: step back (past the far kerb
        // it is over: commit ends 0.15 m on and restarts only 0.2 m before it, so no flicker)
        // (and still on the kerb when the walk window closes: wait for the next one)
        const open = !blocked[e] && (t + this.crossPhase[e]) % CROSS_CYCLE < CROSS_OPEN;
        if ((commit[i] && ui < kerbIn - 0.05 && !open) || ui > kerbOut + 0.15) commit[i] = 0;
        if (!commit[i] && ui < kerbOut - 0.2) {
          if (ui > kerbIn + 0.3 || (ui >= waitU - 0.15 && open)) commit[i] = 1; // (the first: on the road after a placement)
          else {
            vDes = Math.min(vDes, Math.max(0, (waitU - ui) * 2.2));
            waiting = ui > waitU - 1.2;
            queue = ui > waitU - 1.6;
          }
        }
        if (commit[i]) {
          vDes *= 1.25;
          busy[e] = 1;
        }
      }

      // Travel frame at the agent.
      smp.s = ui;
      this.sampleTravel(i);
      const tx = smp.tx;
      const tz = smp.tz;
      const nx = -tz; // right of travel
      const nz = tx;

      // Lateral planning: intervals the body centre must avoid, in the travel-right frame.
      this.nIv = 0;
      const turns = this.next[i] !== e;
      this.obstacleIvs(i, false, squeeze);
      if (turns && f.len - ui < OBS_AHEAD) this.obstacleIvs(i, true, squeeze);
      let nIv = this.nIv;
      let followCap = Infinity;
      let yieldTo = false;
      const cx = Math.min(N - 1, Math.max(0, Math.floor((xi + gridR) / CELL)));
      const cz = Math.min(N - 1, Math.max(0, Math.floor((zi + gridR) / CELL)));
      for (let gz = Math.max(0, cz - 1); gz <= Math.min(N - 1, cz + 1); gz++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(N - 1, cx + 1); gx++) {
          for (let j = gridHead[gz * N + gx]; j >= 0; j = gridNext[j]) {
            const rx = px[j] - xi;
            const rz = pz[j] - zi;
            const d2 = rx * rx + rz * rz;
            const along = rx * tx + rz * tz;
            const side = rx * nx + rz * nz;
            if (j === i || d2 > 9 || along < -0.25 || Math.abs(side) > 1.4) continue;
            const vj = Math.sqrt(vx[j] * vx[j] + vz[j] * vz[j]);
            const vjAlong = vx[j] * tx + vz[j] * tz;
            // a kerb waiter gives the landing to someone coming off the crossing at it
            if (waiting && edge[j] === e && dir[j] !== d && commit[j] && d2 < 4) yieldTo = true;
            if (vj > 0.25 && vjAlong > 0.6 * vj) {
              // walking our way: follow (never overtake through them)
              if (Math.abs(side) < PASS_GAP - 0.04 && along > 0) followCap = Math.min(followCap, Math.max(0, vjAlong + (along - 0.62) * 1.6));
            } else if (!squeeze) {
              // oncoming, crossing our path, or standing: step round them; yield to crossers by id
              if (along > 0 && along < 3 && nIv < 48) {
                ivLo[nIv] = latCur + side - PASS_GAP;
                ivHi[nIv] = latCur + side + PASS_GAP;
                ivAlong[nIv++] = along;
              }
              if (vj > 0.25 && vjAlong > -0.5 * vj && j < i && along < 1.3 && Math.abs(side) < 0.7) followCap = Math.min(followCap, Math.max(0, (along - 0.55) * 1.8));
            }
            if (!squeeze && along > 0 && Math.abs(side) < 0.3 && d2 < 0.49) followCap = Math.min(followCap, Math.max(0, (Math.sqrt(d2) - 0.5) * 2.5));
          }
        }
      }
      if (camOn) {
        const rx = camX - xi;
        const rz = camZ - zi;
        const along = rx * tx + rz * tz;
        const side = rx * nx + rz * nz;
        // stop short a body length early: nobody walks up to the lens
        if (along > -0.25 && along < 3.5 + camR && Math.abs(side) < camR + 0.85 && nIv < 48) {
          ivLo[nIv] = latCur + side - camR;
          ivHi[nIv] = latCur + side + camR;
          ivAlong[nIv++] = Math.max(0, along - 0.8);
        }
      }

      // Lateral offset: nearest to the preference (with hysteresis) outside every interval. Waiting
      // at a kerb: the right half, so people coming off the crossing pass on the left.
      const room = squeeze ? 0.6 : 0;
      const hi = (d > 0 ? f.hiR : f.hiL) + room;
      const lo = -(d > 0 ? f.hiL : f.hiR) - room;
      const prefLat = (queue ? Math.max(this.pref[i], 0.8) : this.pref[i]) * (hi - room);
      let bestLat = NaN;
      let bestCost = Infinity;
      for (let c = -4; c < 2 * nIv; c++) {
        const v = c === -4 ? prefLat : c === -3 ? lat[i] : c === -2 ? hi : c === -1 ? lo : c & 1 ? ivHi[c >> 1] + 0.01 : ivLo[c >> 1] - 0.01;
        if (v < lo - 1e-6 || v > hi + 1e-6) continue;
        let free = true;
        for (let q = 0; q < nIv && free; q++) free = !(v > ivLo[q] && v < ivHi[q]);
        if (!free) continue;
        const cost = Math.abs(v - prefLat) + 0.6 * Math.abs(v - lat[i]);
        if (cost < bestCost) {
          bestCost = cost;
          bestLat = v;
        }
      }
      // the nearest conflict on our current line (along), if any
      const li = lat[i];
      let a = Infinity;
      for (let q = 0; q < nIv; q++) if (li > ivLo[q] && li < ivHi[q] && ivAlong[q] < a) a = ivAlong[q];
      if (Number.isNaN(bestLat)) {
        // no room: hold the line and stop short of the nearest conflict
        bestLat = li;
        if (a < Infinity) followCap = Math.min(followCap, Math.max(0, (a - 0.75) * 1.8));
      }
      // a long sidestep before a close obstacle: slow down so it is done in time
      const shift = Math.abs(bestLat - li);
      if (shift > 0.05 && a < Infinity) followCap = Math.min(followCap, Math.max(0.15, ((a - 0.25) * LAT_SPEED) / shift));
      lat[i] += Math.max(-LAT_SPEED * dt, Math.min(LAT_SPEED * dt, bestLat - lat[i]));

      const wanted = vDes;
      vDes = Math.min(vDes, followCap);

      // Steer at the target ahead (a waiter giving way: at a spot 0.6 m back from its wait line).
      const back = yieldTo && ui > waitU - 0.7;
      smp.s = back ? Math.max(0, waitU - 0.7) : ui + LOOK;
      this.sampleTravel(i);
      let dx = smp.x - smp.tz * lat[i] - xi;
      let dz = smp.z + smp.tx * lat[i] - zi;
      const dl = Math.sqrt(dx * dx + dz * dz) || 1;
      if (back) vDes = Math.min(0.7, dl * 2);
      dx /= dl;
      dz /= dl;
      const k = Math.min(1, dt * 5);
      vx[i] += (dx * vDes - vx[i]) * k;
      vz[i] += (dz * vDes - vz[i]) * k;
      let nxp = xi + vx[i] * dt;
      let nzp = zi + vz[i] * dt;
      // Well inside the edge's paving room (precomputed clear of road, water and buildings): no
      // CityIndex queries needed.
      // (crossings: an uncommitted walker on a landing checked clear at init, short of the kerb)
      const latNew = latCur + vx[i] * dt * nx + vz[i] * dt * nz;
      const inRoom = f.crossing
        ? !commit[i] && ui > 0.05 && ui + 0.1 < (d > 0 ? f.kerbA : f.kerbB) - 0.35 && (d > 0 ? f.landA : f.landB) && Math.abs(latNew) < hi
        : ui > 0.2 && ui < f.len - 0.2 && latNew < hi - room + 0.02 && latNew > lo + room - 0.02;
      // (and nothing to bump into out on the carriageway)
      const onCarriageway = f.crossing && ui > (d > 0 ? f.kerbA : f.kerbB) + 0.3 && ui < kerbOut - 0.3;
      if (!inRoom && !onCarriageway && this.index.collide(nxp, nzp, BODY_R, this.col)) {
        nxp = this.col.x;
        nzp = this.col.z;
      }
      const sx = nxp;
      const sz = nzp;
      // People are solid: slide round anyone closer than SEP (their previous positions, so the
      // result does not depend on update order), leaning right when meeting head on. Squeezing
      // past: only round people on the move.
      for (let gz = Math.max(0, cz - 1); gz <= Math.min(N - 1, cz + 1); gz++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(N - 1, cx + 1); gx++) {
          for (let j = gridHead[gz * N + gx]; j >= 0; j = gridNext[j]) {
            let ox = nxp - px[j];
            let oz = nzp - pz[j];
            const d2 = ox * ox + oz * oz;
            if (j === i || d2 >= SEP * SEP || (squeeze && vx[j] * vx[j] + vz[j] * vz[j] < 0.0625)) continue;
            const dd = Math.sqrt(d2);
            if (dd < 1e-6) {
              ox = nx;
              oz = nz;
            } else {
              ox /= dd;
              oz /= dd;
              if (ox * tx + oz * tz < -0.85) {
                ox += nx * 0.35;
                oz += nz * 0.35;
              }
            }
            const l = Math.sqrt(ox * ox + oz * oz);
            nxp = px[j] + (ox / l) * SEP;
            nzp = pz[j] + (oz / l) * SEP;
          }
        }
      }
      // Last resort: never inside a prop or an idle person (their discs, current edge).
      for (let q = 0; q < f.oI.length; q++) {
        const oi = f.oI[q];
        if (squeeze && oi >= this.nProps) continue;
        const o = this.obstacles[oi];
        const ox = nxp - o.x;
        const oz = nzp - o.z;
        const rr = o.r + BODY_R;
        const d2 = ox * ox + oz * oz;
        if (d2 < rr * rr && d2 > 1e-8) {
          const dd = Math.sqrt(d2);
          nxp = o.x + (ox / dd) * rr;
          nzp = o.z + (oz / dd) * rr;
        }
      }
      // Push-outs are rate-limited: never further from the last position than our own step plus
      // PUSH_SPEED (the rest carries over to the next steps), so nobody jumps sideways in a crowd.
      let ex = nxp - xi;
      let ez = nzp - zi;
      const lim = Math.sqrt((sx - xi) * (sx - xi) + (sz - zi) * (sz - zi)) + maxPush;
      const el = ex * ex + ez * ez;
      if (el > lim * lim) {
        const q = lim / Math.sqrt(el);
        nxp = xi + ex * q;
        nzp = zi + ez * q;
      }
      // Never off the kerb except when committed to a crossing: if a shove would push us off, keep
      // our own step, else stand.
      if (!inRoom && (!f.crossing || (!commit[i] && !this.offPaving(xi, zi))) && this.offPaving(nxp, nzp)) {
        const own = !this.offPaving(sx, sz);
        nxp = own ? sx : xi;
        nzp = own ? sz : zi;
      }
      ex = nxp - xi;
      ez = nzp - zi;
      const moved = Math.sqrt(ex * ex + ez * ez);
      x[i] = nxp;
      z[i] = nzp;
      this.gait[i] += moved;
      this.latW[i] = latCur + ex * nx + ez * nz;
      this.tX[i] = tx;
      this.tZ[i] = tz;
      this.safe[i] = !f.crossing && ui > 1.1 && ui < f.len - 1.1 ? 1 : 0;

      // Facing: along the velocity when walking; across the road while waiting at a kerb.
      const sp = Math.sqrt(vx[i] * vx[i] + vz[i] * vz[i]);
      let fx = hx[i];
      let fz = hz[i];
      if (waiting) {
        fx = tx;
        fz = tz;
      } else if (sp > 0.02) {
        fx = vx[i] / sp;
        fz = vz[i] / sp;
      }
      const hk = Math.min(1, dt * (sp > 0.2 ? 7 : 3));
      const hxn = hx[i] + (fx - hx[i]) * hk;
      const hzn = hz[i] + (fz - hz[i]) * hk;
      const hl = Math.sqrt(hxn * hxn + hzn * hzn) || 1;
      hx[i] = hxn / hl;
      hz[i] = hzn / hl;
      this.h[i] += ((f.crossing && this.onRoad(i) ? f.hRoad : f.hEdge) - this.h[i]) * Math.min(1, dt * 16);

      // Stuck (held back by people / no room) → turn back after a while. Queueing at a kerb counts
      // slowly (people give up on a crossing after ~17 s). A committed crosser never turns back on
      // the carriageway's last 1.5 m; held up on the crossing it squeezes past after JAM_S.
      // (held: no headway along the path; shuffling sideways does not count)
      const held = wanted > 0.3 && ex * tx + ez * tz < 0.12 * wanted * dt;
      if (commit[i]) jam[i] = held ? jam[i] + dt : Math.max(0, jam[i] - dt * 0.5);
      if (queue) stuck[i] += dt * 0.2;
      else if (held && !(commit[i] && ui > kerbOut - 1.5)) stuck[i] += dt;
      else stuck[i] = Math.max(0, stuck[i] - dt * 2);
      if (stuck[i] > STUCK_S + (i % 7) * 0.3) {
        stuck[i] = 0;
        dir[i] = -d as 1 | -1;
        u[i] = f.len - ui;
        commit[i] = f.crossing && this.onRoad(i) ? 1 : 0;
        jam[i] = 0;
        this.next[i] = this.chooseNext(i);
        lat[i] = -lat[i];
      }
    }
    this.stepDogs(dt);
  }

  private stepDogs(dt: number): void {
    const { dx, dz, dhx, dhz, col } = this;
    for (let k = 0; k < this.dOwner.length; k++) {
      const i = this.dOwner[k];
      if (!this.on[i]) continue;
      const f = this.info[this.edge[i]];
      // at heel while the owner stands or waits to cross; trotting ahead on the left otherwise
      this.dogTarget(k, i, this.vx[i] * this.vx[i] + this.vz[i] * this.vz[i] < 0.1225 || (f.crossing && !this.commit[i]));
      let ex = col.x - dx[k];
      let ez = col.z - dz[k];
      const d = Math.sqrt(ex * ex + ez * ez) || 1e-4;
      const sp = Math.min(2.4, d * 3.2);
      ex /= d;
      ez /= d;
      let nx = dx[k] + ex * sp * dt;
      let nz = dz[k] + ez * sp * dt;
      // inside the owner's paving room (owner's lateral frame): no CityIndex queries
      let safe = false;
      if (this.safe[i]) {
        const rx = nx - this.x[i];
        const rz = nz - this.z[i];
        const l = this.latW[i] - rx * this.tZ[i] + rz * this.tX[i];
        const di = this.dir[i];
        safe = l < (di > 0 ? f.hiR : f.hiL) && l > -(di > 0 ? f.hiL : f.hiR) && Math.abs(rx * this.tX[i] + rz * this.tZ[i]) < 1;
      }
      if (!safe) {
        if (this.index.collide(nx, nz, 0.17, col)) {
          nx = col.x;
          nz = col.z;
        }
        // never onto the carriageway unless the owner is crossing (and always free to get off it)
        if (this.offPaving(nx, nz) && !this.offPaving(dx[k], dz[k]) && !(f.crossing && this.commit[i])) {
          nx = dx[k];
          nz = dz[k];
        }
      }
      ex = nx - dx[k];
      ez = nz - dz[k];
      const moved = Math.sqrt(ex * ex + ez * ez);
      // face the way it moves, or the owner's way when standing
      const fx = moved > 0.004 ? ex / moved : this.hx[i];
      const fz = moved > 0.004 ? ez / moved : this.hz[i];
      dx[k] = nx;
      dz[k] = nz;
      this.dg[k] += moved;
      this.dsp[k] += (moved / dt - this.dsp[k]) * Math.min(1, dt * 8);
      const hk = Math.min(1, dt * 6);
      const a = dhx[k] + (fx - dhx[k]) * hk;
      const b = dhz[k] + (fz - dhz[k]) * hk;
      const l = Math.sqrt(a * a + b * b) || 1;
      dhx[k] = a / l;
      dhz[k] = b / l;
    }
  }

  offPaving(x: number, z: number): boolean {
    const k = this.index.classify(x, z);
    return k === 'road' || k === 'intersection' || k === 'building' || k === 'water';
  }

  /** Is walker i currently on the carriageway part of a crossing? */
  onRoad(i: number): boolean {
    const f = this.info[this.edge[i]];
    const d = this.dir[i];
    return f.crossing && this.u[i] > (d > 0 ? f.kerbA : f.kerbB) && this.u[i] < f.len - (d > 0 ? f.kerbB : f.kerbA);
  }
}

// ── Population ──

/** Per-person look, packed for the shader (people/shader.ts reads it from a texture). */
export interface Look {
  skin: number;
  shirt: number;
  legs: number;
  hair: number;
  acc: number;
  /** 0 bald, 1 short, 2 bun, 3 long, 4 hat, 5 curly/afro. */
  hairStyle: number;
  flags: number;
  /** Gait bounce 0..1. */
  bounce: number;
  pose: Pose;
  /** Height scale (kids ~0.66). */
  scale: number;
  seed: number;
}

export const enum LookFlag {
  Bag = 1,
  Backpack = 2,
  Umbrella = 4,
  Dress = 8,
  ShortSleeve = 16,
  Shorts = 32,
  Kid = 64,
  Leash = 128,
  Phone = 256,
  Blush = 512,
}

// sRGB hex colours. Saturated and harmonious with BRIEF §3's walls and roofs.
const SKIN = [0xf8d9bd, 0xf1c6a0, 0xe2a97f, 0xc98b5e, 0xa66c45, 0x7d4e33, 0x5c3a28];
const SHIRT = [0xe2543f, 0xff8a7a, 0xf2cc5b, 0x3d9ca8, 0x5aa9e6, 0xa99cda, 0x7fb04a, 0xf7f3ea, 0x2e3a6b, 0xf49ac2, 0xf28c38, 0x47b39d, 0xffb84d, 0x8e5bb5, 0xd9483b];
const LEGS = [0x3b5b92, 0x2b2f4a, 0xc8a86b, 0x3a3540, 0x7a7f8c, 0x6b4a33, 0x4f6d8f, 0x2f5a52, 0xe9dcc3];
const HAIR = [0x2b2522, 0x2b2522, 0x4a3022, 0x6e4128, 0x9a5a2e, 0xe5c06a, 0xd9a55a, 0xb8b4ae, 0xecebe6, 0x3b2a20];
const ACC = [0xd9483b, 0xffb84d, 0x3d9ca8, 0x5b6b8c, 0xf49ac2, 0x7fb04a, 0x2e3a6b, 0xf2cc5b, 0x8e5bb5, 0xa0643a];

/** Deterministic looks for `n` people (walkers first, then idlers). */
export function makeLooks(seed: number, n: number): Look[] {
  const rng = Rng.for(seed, 'people-looks');
  const out: Look[] = [];
  for (let i = 0; i < n; i++) {
    const kid = rng.float() < 0.1;
    const old = !kid && rng.float() < 0.14;
    const dress = !kid && rng.float() < 0.17;
    let flags = (dress ? LookFlag.Dress : 0) | (kid ? LookFlag.Kid : 0);
    if (rng.float() < (kid ? 0.5 : 0.55)) flags |= LookFlag.ShortSleeve;
    if (!dress && rng.float() < (kid ? 0.45 : 0.14)) flags |= LookFlag.Shorts;
    const accRoll = rng.float();
    if (accRoll < (kid ? 0.45 : 0.28)) flags |= !kid && accRoll < 0.16 ? LookFlag.Bag : LookFlag.Backpack;
    const hand = rng.float();
    if (!kid && hand < 0.05) flags |= LookFlag.Umbrella;
    else if (!kid && !old && hand < 0.13) flags |= LookFlag.Phone;
    const hs = rng.float();
    const hairStyle = old ? (hs < 0.3 ? 0 : hs < 0.5 ? 4 : 1) : dress ? (hs < 0.4 ? 3 : hs < 0.7 ? 2 : hs < 0.85 ? 5 : 1) : hs < 0.42 ? 1 : hs < 0.56 ? 3 : hs < 0.68 ? 2 : hs < 0.8 ? 5 : hs < 0.9 ? 4 : 1;
    const hair = old ? HAIR[rng.int(7, 8)] : rng.float() < 0.03 ? rng.pick([0xf49ac2, 0x47b39d, 0x8e5bb5]) : HAIR[rng.int(0, 6)];
    out.push({
      skin: SKIN[rng.int(0, SKIN.length - 1)],
      shirt: SHIRT[rng.int(0, SHIRT.length - 1)],
      legs: LEGS[rng.int(0, LEGS.length - 1)],
      hair,
      acc: ACC[rng.int(0, ACC.length - 1)],
      hairStyle,
      flags: flags | (rng.float() < (kid ? 0.8 : 0.35) ? LookFlag.Blush : 0),
      bounce: kid ? rng.range(0.7, 1) : old ? rng.range(0, 0.25) : rng.range(0.15, 0.85),
      pose: Pose.Walk,
      scale: kid ? rng.range(0.6, 0.7) : rng.range(0.93, 1.07),
      seed: rng.int(0, 255),
    });
  }
  return out;
}

/** Walker traits (speed, lateral preference, home radius) for walker i. */
export function makeTraits(seed: number, looks: readonly Look[], n: number): WalkerTraits[] {
  const rng = Rng.for(seed, 'people-traits');
  const out: WalkerTraits[] = [];
  for (let i = 0; i < n; i++) {
    const l = looks[i];
    const kid = (l.flags & LookFlag.Kid) !== 0;
    const slow = l.bounce < 0.25 || (l.flags & (LookFlag.Phone | LookFlag.Leash)) !== 0;
    out.push({
      vPref: kid ? rng.range(1.0, 1.35) : slow ? rng.range(0.8, 1.05) : rng.range(1.05, 1.45),
      pref: rng.range(0.3, 0.9),
      home: 8 + 78 * Math.pow(rng.float(), 1.5),
    });
  }
  return out;
}
