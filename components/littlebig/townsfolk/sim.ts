// LITTLEBIG v2 townsfolk (T2): one town's people on its walk network (townsfolk/net.ts). Lightweight,
// deterministic and allocation-free per step: not a port of the capital's sim.
//
// A walker follows its edge (arc u, its own lateral line in the edge's band, keeping right) toward a
// destination picked from the town's places (a seat, a stall's front, a shop door, its home) or a
// waypoint, choosing the next edge at each node down the destination's distance field (a little
// seeded noise, so two people bound for the same bench take different streets). Corners are rounded
// (the heading blends into the next edge over its last 0.6 m). People ahead are passed (oncoming ones
// on the right, slower ones on the left) where the band leaves room, else followed; and a hard rule
// keeps bodies apart: no step may bring two bodies closer than SEP (a ridden walker's berth: RIDE_SEP)
// that is not taking them apart. Someone stuck a while turns round. At a crossing a walker waits at the
// kerb while transit says `blocked`, sets `busy` once committed, and steps off the kerb only while
// nothing is coming. At a seat or spot it sits or stands a while (easing into it), then walks on; at a
// door it goes in (fading through it) and comes out later; at dusk most head home, in the morning out
// again. Dog walkers' dogs trot along the owner's trail. Placement for a time t (warm) is seeded by t.

import { BODY, E, type Net, PK, POSE } from './net';
import { hash3 } from '../world/rng';

/** States. */
export const S = { walk: 0, wait: 1, rest: 2, home: 3 } as const;
/** Bodies keep this far apart (m); from a ridden walker this far. */
const SEP = 2 * BODY + 0.02;
const RIDE_SEP = 1.0;
/** Lateral clearance (m) a walker wants when it passes someone. */
const PASS = 0.56;
const RIDE_PASS = 1.15;
/** How far ahead (m) a walker looks for people; the corner blend's reach (m). */
const LOOK = 2.6;
const BLEND = 0.6;
/** Stuck this long (s) at no speed: turn round. */
const STUCK = 2.6;
/** A waiting body's centre stops this far (m) short of a crossing's kerb line. */
const KERB_STOP = 0.3;
/** …and this far (m) back from a crossing's end node, clear of its mouth. */
const MOUTH = 0.7;
/** A body this far (m) or less off the kerb onto a crossing steps back if a vehicle comes after all. */
const STEP_BACK = 0.8;
/** Spatial hash cell (m). */
const CELL = 2;
/** Dog: trail points, how far behind the owner (m). */
const TRAIL = 24;
const HEEL = 0.72;

export interface Folk {
  /** Walking speed (m/s), lateral preference (0 left … 1 right of the band), a home door (place index, −1), dog walker. */
  v: number;
  pref: number;
  home: number;
  dog: boolean;
  /** Look scale (kids ~0.66). */
  scale: number;
}

const scratch = { x: 0, z: 0, tx: 1, tz: 0, lo: 0, hi: 0, h: 0 };

export class TownSim {
  readonly net: Net;
  readonly n: number;
  readonly folk: readonly Folk[];
  readonly seed: number;
  // pose (previous and current fixed step, for interpolation)
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly h: Float64Array;
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly ph: Float64Array;
  readonly hx: Float64Array;
  readonly hz: Float64Array;
  readonly phx: Float64Array;
  readonly phz: Float64Array;
  /** Speed (m/s), velocity (for the neighbours), gait distance (m). */
  readonly v: Float64Array;
  readonly vx: Float64Array;
  readonly vz: Float64Array;
  readonly g: Float64Array;
  readonly pg: Float64Array;
  // route
  readonly e: Int32Array;
  readonly d: Int8Array;
  readonly u: Float64Array;
  readonly hint: Int32Array;
  readonly nxt: Int32Array;
  readonly dst: Int32Array;
  readonly st: Uint8Array;
  readonly tm: Float32Array;
  /** Place resting at (or heading to), the crossing committed to (−1), stuck time, rest blend 0..1, how visible (doors) 0..1. */
  readonly pl: Int32Array;
  readonly cm: Int32Array;
  readonly stuck: Float32Array;
  /** Turned round on the crossing it is on (it does not step back again there). */
  readonly back: Uint8Array;
  readonly bl: Float64Array;
  readonly vis: Float64Array;
  readonly cnt: Uint32Array;
  readonly out: Uint8Array;
  /** Per place: who is there (walker), −1. */
  readonly occ: Int32Array;
  /** Dogs: owner (walker), position (current, previous), heading, gait; the owners' trails. */
  readonly dOwner: Int32Array;
  readonly dx: Float64Array;
  readonly dz: Float64Array;
  readonly dpx: Float64Array;
  readonly dpz: Float64Array;
  readonly dhx: Float64Array;
  readonly dhz: Float64Array;
  readonly dg: Float64Array;
  readonly dpg: Float64Array;
  readonly dogOf: Int32Array;
  private readonly trail: Float64Array;
  private readonly trailN: Int32Array;
  /** The walker the camera rides (−1), the player's plan position (NaN: none). */
  rider = -1;
  camX = NaN;
  camZ = NaN;
  // spatial hash over walkers and anchored people
  private readonly cells: Int32Array;
  private readonly next: Int32Array;
  private readonly hn: number;
  private readonly hh: number;
  private readonly ax: Float64Array;
  private readonly az: Float64Array;
  /** Places by what they are for, and how many of each. */
  private readonly pick: Int32Array[];

  constructor(net: Net, folk: readonly Folk[], seed: number) {
    this.net = net;
    this.folk = folk;
    this.n = folk.length;
    this.seed = seed;
    const n = this.n, F = (k = n) => new Float64Array(k);
    this.x = F();
    this.z = F();
    this.h = F();
    this.px = F();
    this.pz = F();
    this.ph = F();
    this.hx = F();
    this.hz = F();
    this.phx = F();
    this.phz = F();
    this.v = F();
    this.vx = F();
    this.vz = F();
    this.g = F();
    this.pg = F();
    this.u = F();
    this.bl = F();
    this.vis = F();
    this.e = new Int32Array(n);
    this.d = new Int8Array(n).fill(1);
    this.hint = new Int32Array(n);
    this.nxt = new Int32Array(n).fill(-1);
    this.dst = new Int32Array(n).fill(-1);
    this.st = new Uint8Array(n);
    this.tm = new Float32Array(n);
    this.pl = new Int32Array(n).fill(-1);
    this.cm = new Int32Array(n).fill(-1);
    this.stuck = new Float32Array(n);
    this.back = new Uint8Array(n);
    this.cnt = new Uint32Array(n);
    this.out = new Uint8Array(n).fill(1);
    this.occ = new Int32Array(net.places.length).fill(-1);
    const owners = folk.map((f, i) => (f.dog ? i : -1)).filter((i) => i >= 0);
    const m = owners.length;
    this.dOwner = Int32Array.from(owners);
    this.dogOf = new Int32Array(n).fill(-1);
    owners.forEach((o, k) => (this.dogOf[o] = k));
    this.dx = F(m);
    this.dz = F(m);
    this.dpx = F(m);
    this.dpz = F(m);
    this.dhx = F(m);
    this.dhz = F(m);
    this.dg = F(m);
    this.dpg = F(m);
    this.trail = F(m * TRAIL * 2);
    this.trailN = new Int32Array(m);
    // the hash covers the network's extent
    let r = 10;
    for (let i = 0; i < net.nx.length; i++) r = Math.max(r, Math.abs(net.nx[i]) + 4, Math.abs(net.nz[i]) + 4);
    for (const p of net.places) r = Math.max(r, Math.abs(p.x) + 4, Math.abs(p.z) + 4);
    this.hn = Math.ceil((2 * r) / CELL);
    this.hh = (this.hn * CELL) / 2;
    const anch = net.places.filter((p) => p.anch && p.pose !== POSE.lie);
    this.ax = Float64Array.from(anch.map((p) => p.x));
    this.az = Float64Array.from(anch.map((p) => p.z));
    this.cells = new Int32Array(this.hn * this.hn);
    this.next = new Int32Array(n + anch.length);
    // destinations by kind: waypoints, seats, spots, shop doors
    const by: number[][] = [[], [], [], []];
    for (let k = 0; k < net.dest.length; k++) {
      const p = net.destPlace[k] < 0 ? null : net.places[net.destPlace[k]];
      by[!p ? 0 : p.k === PK.seat ? 1 : p.k === PK.stand ? 2 : p.home ? -1 : 3]?.push(k);
    }
    this.pick = by.map((a) => Int32Array.from(a));
  }

  /** A seeded number in [0, 1) for walker i's next decision. */
  private rnd(i: number): number {
    return hash3(i, this.cnt[i]++, this.seed);
  }

  /** The node at edge e's end walker i is heading to. */
  private endNode(i: number): number {
    const e = this.e[i];
    return this.d[i] > 0 ? this.net.eb[e] : this.net.ea[e];
  }

  /** Sample edge e at arc u (hint: a sample index near it) into `scratch`; returns the sample index. */
  private at(e: number, u: number, hint: number): number {
    const N = this.net, f = N.ef[e], l = f + N.en[e] - 1;
    let i = Math.max(f, Math.min(l - 1, hint));
    while (i > f && N.sa[i] > u) i--;
    while (i < l - 1 && N.sa[i + 1] < u) i++;
    const s0 = N.sa[i], s1 = N.sa[i + 1], t = Math.max(0, Math.min(1, (u - s0) / (s1 - s0 || 1)));
    const tx = N.x[i + 1] - N.x[i], tz = N.z[i + 1] - N.z[i], tl = Math.hypot(tx, tz) || 1;
    scratch.x = N.x[i] + tx * t;
    scratch.z = N.z[i] + tz * t;
    scratch.tx = tx / tl;
    scratch.tz = tz / tl;
    scratch.lo = N.lo[i] + (N.lo[i + 1] - N.lo[i]) * t;
    scratch.hi = N.hi[i] + (N.hi[i + 1] - N.hi[i]) * t;
    scratch.h = N.h[i] + (N.h[i + 1] - N.h[i]) * t;
    return i;
  }

  /** The arc (m) along edge e of the point on it nearest plan (x, z), searched about walker i's hint (which it updates). */
  private project(e: number, x: number, z: number, i: number): number {
    const N = this.net, f = N.ef[e], l = f + N.en[e] - 2;
    let h = Math.max(f, Math.min(l, this.hint[i]));
    if (this.e[i] !== e) h = this.d[i] > 0 ? f : l;
    let best = Infinity, bu = 0, bi = h;
    for (let k = Math.max(f, h - 3); k <= Math.min(l, h + 3); k++) {
      const ax = N.x[k], az = N.z[k], dx = N.x[k + 1] - ax, dz = N.z[k + 1] - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), q = (ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2;
      if (q < best) {
        best = q;
        bu = N.sa[k] + (N.sa[k + 1] - N.sa[k]) * t;
        bi = k;
      }
    }
    this.hint[i] = bi;
    return bu;
  }

  /** Destination for walker i (index into net.dest), or −1: by what it may do now (a ridden walker only walks on). */
  private choose(i: number, late: number): number {
    const N = this.net, f = this.folk[i], from = this.endNode(i), nn = N.nx.length;
    if (!this.out[i] && f.home >= 0) {
      for (let k = 0; k < N.dest.length; k++) if (N.destPlace[k] === f.home && N.dist[k * nn + from] < Infinity) return k;
    }
    const ride = i === this.rider;
    for (let tries = 0; tries < 6; tries++) {
      const r = this.rnd(i) * (ride ? 0.55 : 1);
      // walk on (0.35), a spot (0.2), a seat (0.25), a shop (0.2); dog walkers and riders neither sit nor shop
      let kind = r < 0.35 ? 0 : r < 0.55 ? 2 : r < 0.8 ? 1 : 3;
      if ((kind === 1 || kind === 3) && (f.dog || ride)) kind = 0;
      if (kind === 3 && late > 0.3) kind = 0;
      const a = this.pick[kind];
      if (!a.length) continue;
      const k = a[Math.floor(this.rnd(i) * a.length)], dd = N.dist[k * nn + from], p = N.destPlace[k];
      if (!(dd < Infinity) || (dd < 6 && kind === 0) || (p >= 0 && (this.occ[p] >= 0 || this.taken(p, i)))) continue;
      return k;
    }
    const a = this.pick[0];
    return a.length ? a[Math.floor(this.rnd(i) * a.length)] : -1;
  }

  /** Is someone else already bound for place p? */
  private taken(p: number, i: number): boolean {
    for (let j = 0; j < this.n; j++) if (j !== i && this.pl[j] === p) return true;
    return false;
  }

  /** The edge to take from node v toward walker i's destination (not straight back unless it must). */
  private route(i: number, v: number, back: number): number {
    const N = this.net, k = this.dst[i], nn = N.nx.length;
    let best = -1, bc = Infinity;
    for (let a = N.adj0[v]; a < N.adj0[v + 1]; a++) {
      const e = N.adj[a];
      const o = N.ea[e] === v ? N.eb[e] : N.ea[e];
      // (a stub is only taken to its own place)
      if (N.kind[e] === E.stub && (k < 0 || N.dest[k] !== o)) continue;
      const c = (k >= 0 ? N.dist[k * nn + o] + N.len[e] : 0) + this.rnd(i) * (k >= 0 ? 2.5 : 10) + (e === back ? 1e4 : 0);
      if (c < bc) {
        bc = c;
        best = e;
      }
    }
    return best < 0 ? back : best;
  }

  /** Put walker i on edge e leaving node v. */
  private enter(i: number, e: number, v: number): void {
    const N = this.net;
    this.back[i] = 0;
    this.e[i] = e;
    this.d[i] = N.ea[e] === v ? 1 : -1;
    this.u[i] = this.d[i] > 0 ? 0 : N.len[e];
    this.hint[i] = this.d[i] > 0 ? N.ef[e] : N.ef[e] + N.en[e] - 2;
    this.nxt[i] = -1;
  }

  /** Fill the spatial hash with the bodies standing on the ground now. */
  private hash(): void {
    const { cells, next, hn, hh, n } = this;
    cells.fill(-1);
    for (let i = 0; i < n + this.ax.length; i++) {
      if (i < n && this.st[i] === S.home) continue;
      const x = i < n ? this.x[i] : this.ax[i - n], z = i < n ? this.z[i] : this.az[i - n];
      const c = Math.min(hn - 1, Math.max(0, Math.floor((z + hh) / CELL))) * hn + Math.min(hn - 1, Math.max(0, Math.floor((x + hh) / CELL)));
      next[i] = cells[c];
      cells[c] = i;
    }
  }

  /** May a body move from (x0, z0) to (x1, z1)? Never closer than SEP to anyone it is not leaving. */
  private free(i: number, x0: number, z0: number, x1: number, z1: number): boolean {
    const { cells, next, hn, hh, n } = this;
    const ci = Math.floor((x1 + hh) / CELL), cj = Math.floor((z1 + hh) / CELL);
    for (let j = Math.max(0, cj - 1); j <= Math.min(hn - 1, cj + 1); j++)
      for (let c = Math.max(0, ci - 1); c <= Math.min(hn - 1, ci + 1); c++)
        for (let k = cells[j * hn + c]; k >= 0; k = next[k]) {
          if (k === i) continue;
          const bx = k < n ? this.x[k] : this.ax[k - n], bz = k < n ? this.z[k] : this.az[k - n];
          const sep = k === this.rider || i === this.rider ? RIDE_SEP : SEP;
          const d1 = (x1 - bx) ** 2 + (z1 - bz) ** 2;
          if (d1 < sep * sep && d1 < (x0 - bx) ** 2 + (z0 - bz) ** 2) return false;
        }
    // the player walking the street
    const c1 = (x1 - this.camX) ** 2 + (z1 - this.camZ) ** 2;
    return !(c1 < 0.36 && c1 < (x0 - this.camX) ** 2 + (z0 - this.camZ) ** 2);
  }

  /**
   * One fixed step of dt. `busy` (written: cleared, then 1 for every crossing someone is committed to) and
   * `blocked` (read) are transit's arrays by TownCrossing id (null: no transit, no traffic); `late`: how
   * late in the night (0 day … 1), which sends people home.
   */
  step(dt: number, busy: Uint8Array | null, blocked: Uint8Array | null, late: number): void {
    const N = this.net, n = this.n;
    this.hash();
    for (let i = 0; i < n; i++) {
      this.px[i] = this.x[i];
      this.pz[i] = this.z[i];
      this.ph[i] = this.h[i];
      this.phx[i] = this.hx[i];
      this.phz[i] = this.hz[i];
      this.pg[i] = this.g[i];
      // who should be out (a seeded share goes home through the night)
      this.out[i] = hash3(i, 91, this.seed) >= late * 0.62 || i === this.rider ? 1 : 0;
    }
    for (let i = 0; i < n; i++) {
      const st = this.st[i];
      if (st !== S.home) this.vis[i] = Math.min(1, this.vis[i] + dt * 2.2);
      if (st === S.home) this.atHome(i, dt, late);
      else if (st === S.rest) this.rest(i, dt, late);
      else this.walk(i, dt, blocked, late);
    }
    if (busy) {
      for (let i = 0; i < n; i++) if (this.cm[i] >= 0 && this.cm[i] < busy.length) busy[this.cm[i]] = 1;
    }
    this.dogs(dt);
  }

  private atHome(i: number, dt: number, late: number): void {
    // fading in or out through the door
    const p = this.pl[i];
    if (this.vis[i] > 0 && p >= 0) {
      // (through the doorway)
      this.vis[i] = Math.max(0, this.vis[i] - dt * 2.2);
      this.x[i] -= this.net.places[p].fx * dt * 0.9;
      this.z[i] -= this.net.places[p].fz * dt * 0.9;
      this.g[i] += dt * 0.9;
      this.v[i] = 0.9;
      return;
    }
    this.v[i] = 0;
    if (p < 0) return;
    // (indoors for the night; out again in its own while once it is morning)
    if (!this.out[i]) {
      this.tm[i] = Math.max(this.tm[i], 2 + (i % 9) * 3);
      return;
    }
    this.tm[i] -= dt;
    if (this.tm[i] > 0) return;
    // out again, if the doorstep is clear
    const pl = this.net.places[p];
    if (!this.free(i, pl.x + 9, pl.z, pl.x, pl.z) || this.net.adj0[pl.node + 1] === this.net.adj0[pl.node]) return;
    this.st[i] = S.walk;
    this.vis[i] = 0;
    this.x[i] = this.px[i] = pl.x;
    this.z[i] = this.pz[i] = pl.z;
    this.h[i] = this.ph[i] = pl.h;
    this.hx[i] = this.phx[i] = -pl.fx;
    this.hz[i] = this.phz[i] = -pl.fz;
    this.pl[i] = -1;
    this.enter(i, this.net.adj[this.net.adj0[pl.node]], pl.node);
    this.dst[i] = this.choose(i, late);
    this.tm[i] = -1;
  }

  private rest(i: number, dt: number, late: number): void {
    const N = this.net, p = this.pl[i], pl = N.places[p];
    this.tm[i] -= dt;
    const leave = this.tm[i] <= 0 || i === this.rider ? 1 : 0;
    // ease into the seat (or the spot's facing), and out of it again
    const b = Math.max(0, Math.min(1, this.bl[i] + (leave ? -dt : dt) * 1.8)), k = b * b * (3 - 2 * b), ax = N.nx[pl.node], az = N.nz[pl.node];
    const x1 = ax + (pl.x - ax) * k, z1 = az + (pl.z - az) * k;
    // (getting up: only into room that is free)
    if (!leave || this.free(i, this.x[i], this.z[i], x1, z1)) {
      this.bl[i] = b;
      this.x[i] = x1;
      this.z[i] = z1;
    }
    const fx = this.hx[i] + (pl.fx - this.hx[i]) * Math.min(1, dt * 4), fz = this.hz[i] + (pl.fz - this.hz[i]) * Math.min(1, dt * 4), fl = Math.hypot(fx, fz) || 1;
    if (!leave || this.bl[i] > 0.6) {
      this.hx[i] = fx / fl;
      this.hz[i] = fz / fl;
    }
    this.v[i] = this.vx[i] = this.vz[i] = 0;
    if (leave && this.bl[i] <= 0) {
      // up and on, back down the stub
      this.occ[p] = -1;
      this.pl[i] = -1;
      this.st[i] = S.walk;
      const e = N.adj[N.adj0[pl.node]];
      this.enter(i, e, pl.node);
      this.dst[i] = this.choose(i, late);
    }
  }

  private walk(i: number, dt: number, blocked: Uint8Array | null, late: number): void {
    const N = this.net, f = this.folk[i];
    let e = this.e[i];
    const d = this.d[i], len = N.len[e];
    this.hint[i] = this.at(e, this.u[i], this.hint[i]);
    const px = scratch.x, pz = scratch.z, tx = scratch.tx * d, tz = scratch.tz * d, nrx = -tz, nrz = tx;
    const x = this.x[i], z = this.z[i];
    this.h[i] = scratch.h;
    const lat = (x - px) * nrx + (z - pz) * nrz;
    const rem = d > 0 ? len - this.u[i] : this.u[i];
    // the next edge, chosen ahead (and a new destination when this one is reached)
    if (this.nxt[i] < 0 && rem < LOOK) this.nxt[i] = this.ahead(i, late);
    const nx = this.nxt[i];
    // the band ahead, in the travel frame
    this.at(e, Math.max(0, Math.min(len, this.u[i] + d * 0.8)), this.hint[i]);
    let bLo = d > 0 ? scratch.lo : -scratch.hi, bHi = d > 0 ? scratch.hi : -scratch.lo;
    if (bHi < bLo) bLo = bHi = (bLo + bHi) / 2;
    const ride = i === this.rider;
    let latT = bLo + (bHi - bLo) * (ride ? 0.5 : f.pref);
    let vmax = f.v * (this.st[i] === S.wait ? 0 : 1), faceOff = false;
    // people ahead: pass (oncoming on the right, slower ones on the left) where the band allows, else follow
    const { cells, next, hn, hh, n } = this;
    const ci = Math.floor((x + hh) / CELL), cj = Math.floor((z + hh) / CELL);
    for (let j = Math.max(0, cj - 1); j <= Math.min(hn - 1, cj + 1); j++)
      for (let c = Math.max(0, ci - 1); c <= Math.min(hn - 1, ci + 1); c++)
        for (let k = cells[j * hn + c]; k >= 0; k = next[k]) {
          if (k === i) continue;
          const bx = k < n ? this.x[k] : this.ax[k - n], bz = k < n ? this.z[k] : this.az[k - n];
          const rx = bx - x, rz = bz - z, fwd = rx * tx + rz * tz;
          if (fwd < 0.05 || fwd > LOOK) continue;
          // (the ones who stay put: the bands keep clear of them already; in the way only nearer than SEP across)
          const lj = lat + rx * nrx + rz * nrz, ps = k >= n ? SEP : ride || k === this.rider ? RIDE_PASS : PASS;
          if (Math.abs(latT - lj) >= ps) continue;
          const jv = k < n ? this.vx[k] * tx + this.vz[k] * tz : 0;
          // (oncoming: coming at us, or stopped facing us; two stopped face to face both step right)
          const on = jv < -0.2 || (k < n && this.st[k] === S.walk && this.v[k] < 0.2 && this.hx[k] * tx + this.hz[k] * tz < -0.3);
          const right = lj + ps <= bHi, left = lj - ps >= bLo;
          if (on ? right : !left && right && jv < this.v[i] - 0.1) latT = lj + ps;
          else if (left && (on || jv < this.v[i] - 0.1)) latT = lj - ps;
          else {
            vmax = Math.min(vmax, Math.max(0, jv) + Math.max(0, fwd - (ride || k === this.rider ? 1.8 : 0.85)) * 0.9);
            // (no room to pass one stopped facing us: a face-off, which the stuck rule breaks)
            if (on && vmax < 0.05) faceOff = true;
          }
        }
    // a crossing: wait at the kerb while something is coming; step off only while nothing is
    const onX = N.kind[e] === E.cross;
    // (the next edge's, from a step before its end; or this one's, entered at its end straight from a
    // seat, a spot or a door at its node: still at its start, it asks too). A wait stops the body short:
    // a step back from the crossing's mouth (so those coming off it get by), or KERB_STOP short of the
    // kerb on it (holdAt: the most it may get along this edge; the speed eases down, so it is clamped).
    const at0 = len - rem, kerb = onX ? N.kerb[e] : 0;
    // (committed, but something is coming after all (a vehicle that claimed it after a long wait) and
    // not off the kerb yet: it lets go (so the vehicle may go) and waits again)
    if (blocked && this.cm[i] >= 0 && blocked[this.cm[i]] && (!onX || at0 < kerb - KERB_STOP)) this.cm[i] = -1;
    // (just off the kerb when something comes after all: it steps back, still on it (busy) till it is off)
    if (onX && blocked && this.cm[i] >= 0 && blocked[this.cm[i]] && at0 < kerb + STEP_BACK && !this.back[i]) {
      this.back[i] = 1;
      this.d[i] = -d as 1 | -1;
      this.nxt[i] = -1;
      this.dst[i] = this.choose(i, late);
      return;
    }
    const ask = this.cm[i] >= 0 ? -1 : !onX ? (nx >= 0 && N.kind[nx] === E.cross && rem < MOUTH + 0.3 ? N.cross[nx] : -1) : at0 < Math.max(0.3, kerb - KERB_STOP) ? N.cross[e] : -1;
    let holdAt = -1;
    if (ask >= 0) {
      const c = ask;
      if (blocked && c < blocked.length && blocked[c] && onX) {
        // (on its mouth, where those coming off it pass: not a place to wait; back off and go elsewhere)
        this.d[i] = -d as 1 | -1;
        this.nxt[i] = -1;
        this.dst[i] = this.choose(i, late);
        return;
      } else if (blocked && c < blocked.length && blocked[c]) {
        vmax = 0;
        holdAt = Math.max(at0, len - MOUTH);
        this.st[i] = S.wait;
      } else {
        this.cm[i] = c;
        this.st[i] = S.walk;
      }
    } else if (this.st[i] === S.wait) this.st[i] = S.walk;
    // heading: along the edge, toward its lateral line, blending into the next edge round a corner
    let dx = tx + nrx * Math.max(-0.45, Math.min(0.45, (latT - lat) * 1.6)), dz = tz + nrz * Math.max(-0.45, Math.min(0.45, (latT - lat) * 1.6));
    if (nx >= 0 && rem < BLEND && nx !== e) {
      const v = this.endNode(i), nd = N.ea[nx] === v ? 1 : -1;
      this.at(nx, nd > 0 ? Math.min(N.len[nx], 0.5) : Math.max(0, N.len[nx] - 0.5), nd > 0 ? N.ef[nx] : N.ef[nx] + N.en[nx] - 2);
      const w = 1 - rem / BLEND, w2 = w * w * 0.5;
      dx += (scratch.tx * nd - dx) * w2;
      dz += (scratch.tz * nd - dz) * w2;
    }
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    // speed: eases toward the most it may go
    const v0 = this.v[i];
    let v = vmax > v0 ? Math.min(vmax, v0 + 1.4 * dt) : Math.max(vmax, v0 - 3.5 * dt);
    if (holdAt >= 0) v = Math.min(v, Math.max(0, (holdAt - at0) / dt));
    let x1 = x + dx * v * dt, z1 = z + dz * v * dt;
    if (v > 0 && !this.free(i, x, z, x1, z1)) {
      x1 = x + dx * v * dt * 0.3;
      z1 = z + dz * v * dt * 0.3;
      if (!this.free(i, x, z, x1, z1)) {
        x1 = x;
        z1 = z;
        v = 0;
      }
      else v *= 0.3;
    }
    // along the edge; onto the next at its end (or there: a seat, a spot, a door)
    // (where the body is along the edge: projected, so no error builds up from edge to edge)
    const u = this.project(e, x1, z1, i), node = this.endNode(i);
    // (at the end: there along the edge, or past its end node: a merged node may sit a little off it)
    if ((d > 0 ? u >= len - 0.02 : u <= 0.02) || (rem < 0.6 && (x1 - N.nx[node]) * tx + (z1 - N.nz[node]) * tz > 0)) {
      if (nx >= 0 && nx !== e) {
        if (onX) this.cm[i] = -1;
        this.enter(i, nx, node);
        this.u[i] = this.project(nx, x1, z1, i);
      } else {
        // (no way on: hold at the end; a dead end, turn round)
        const ov = Math.max(0, (x1 - N.nx[node]) * tx + (z1 - N.nz[node]) * tz);
        x1 -= tx * ov;
        z1 -= tz * ov;
        this.u[i] = d > 0 ? len : 0;
        if (nx === e) this.d[i] = -d as 1 | -1;
        this.nxt[i] = -1;
      }
      const k = this.dst[i];
      if (k >= 0 && N.dest[k] === node && N.destPlace[k] >= 0 && this.reach(i, N.destPlace[k], late)) return;
    } else this.u[i] = u;
    // keep inside the band (pushed back at most 1 m/s)
    this.hint[i] = this.at(this.e[i], this.u[i], this.hint[i]);
    const ex = -scratch.tz, ez = scratch.tx, l1 = (x1 - scratch.x) * ex + (z1 - scratch.z) * ez;
    const cl = Math.max(scratch.lo, Math.min(scratch.hi, l1)), lim = Math.max(dt, Math.abs(cl - l1) - 0.02), push = Math.max(-lim, Math.min(lim, cl - l1));
    if (Math.abs(cl - l1) > 1e-4 && this.free(i, x1, z1, x1 + ex * push, z1 + ez * push)) {
      x1 += ex * push;
      z1 += ez * push;
    }
    this.x[i] = x1;
    this.z[i] = z1;
    this.h[i] = scratch.h;
    const mx = x1 - x, mz = z1 - z, moved = Math.hypot(mx, mz);
    this.v[i] = v;
    this.vx[i] = mx / dt;
    this.vz[i] = mz / dt;
    this.g[i] += moved;
    // the body turns toward where it goes (≤ 4 rad/s)
    if (moved > 1e-4) {
      const want = Math.atan2(mz, mx), cur = Math.atan2(this.hz[i], this.hx[i]);
      let da = want - cur;
      da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
      const a = cur + Math.max(-4 * dt, Math.min(4 * dt, da));
      this.hx[i] = Math.cos(a);
      this.hz[i] = Math.sin(a);
    }
    // stuck: turn round and go somewhere else
    // (held up on a crossing, whatever by: it must clear the road, so it turns back after a while too)
    if (v < 0.05 && this.st[i] !== S.wait && (vmax > 0.05 || faceOff || onX)) this.stuck[i] += dt;
    else if (v > 0.2) this.stuck[i] = Math.max(0, this.stuck[i] - dt);
    if (this.stuck[i] > STUCK + (i % 5) * 0.3) {
      this.stuck[i] = 0;
      this.back[i] = 1;
      this.d[i] = -this.d[i] as 1 | -1;
      this.nxt[i] = -1;
      if (!onX) this.cm[i] = -1;
      this.dst[i] = this.choose(i, late);
    }
  }

  /** The edge after this one (a new destination first if this one ends there). */
  private ahead(i: number, late: number): number {
    const v = this.endNode(i), N = this.net;
    const k = this.dst[i];
    if (k < 0 || (N.dest[k] === v && N.destPlace[k] < 0)) this.dst[i] = this.choose(i, late);
    if (this.dst[i] >= 0 && N.dest[this.dst[i]] === v && N.destPlace[this.dst[i]] >= 0) return -1;
    return this.route(i, v, this.e[i]);
  }

  /** Walker i is at place p's node: in at a door, or onto the seat or spot if it is free. True if it stopped walking. */
  private reach(i: number, p: number, late: number): boolean {
    const N = this.net, pl = N.places[p];
    if (pl.k === PK.door) {
      this.st[i] = S.home;
      this.pl[i] = p;
      this.vis[i] = 1;
      // (a shop: a while; home: until the morning)
      this.tm[i] = pl.home ? 4 + this.rnd(i) * 30 : 8 + this.rnd(i) * 25;
      this.hx[i] = -pl.fx;
      this.hz[i] = -pl.fz;
      this.vx[i] = this.vz[i] = 0;
      return true;
    }
    if (this.occ[p] >= 0 || i === this.rider) {
      this.dst[i] = this.choose(i, late);
      return false;
    }
    this.occ[p] = i;
    this.pl[i] = p;
    this.st[i] = S.rest;
    this.bl[i] = 0;
    this.tm[i] = pl.k === PK.seat ? 14 + this.rnd(i) * 40 : 6 + this.rnd(i) * 16;
    this.v[i] = this.vx[i] = this.vz[i] = 0;
    return true;
  }

  /** The dogs at heel: HEEL m back along the owner's trail. */
  private dogs(dt: number): void {
    const T = this.trail;
    for (let k = 0; k < this.dOwner.length; k++) {
      const o = this.dOwner[k], b = k * TRAIL * 2;
      this.dpx[k] = this.dx[k];
      this.dpz[k] = this.dz[k];
      this.dpg[k] = this.dg[k];
      // the trail: the owner's position every 0.1 m (newest first)
      if (this.trailN[k] === 0 || Math.hypot(this.x[o] - T[b], this.z[o] - T[b + 1]) > 0.1) {
        T.copyWithin(b + 2, b, b + TRAIL * 2 - 2);
        T[b] = this.x[o];
        T[b + 1] = this.z[o];
        this.trailN[k] = Math.min(TRAIL, this.trailN[k] + 1);
      }
      let px = this.x[o], pz = this.z[o], left = HEEL, tx = px, tz = pz;
      for (let j = 0; j < this.trailN[k] && left > 0; j++) {
        const qx = T[b + j * 2], qz = T[b + j * 2 + 1], l = Math.hypot(qx - px, qz - pz);
        if (l >= left) {
          tx = px + ((qx - px) * left) / l;
          tz = pz + ((qz - pz) * left) / l;
          left = 0;
        } else {
          px = tx = qx;
          pz = tz = qz;
          left -= l;
        }
      }
      const mx = tx - this.dx[k], mz = tz - this.dz[k], m = Math.hypot(mx, mz);
      // (it trots to its spot, never faster than 2.6 m/s)
      const s = Math.min(1, (2.6 * dt) / (m || 1));
      this.dx[k] += mx * s;
      this.dz[k] += mz * s;
      this.dg[k] += m * s;
      const hx = this.x[o] - this.dx[k], hz = this.z[o] - this.dz[k], hl = Math.hypot(hx, hz);
      if (hl > 0.05 && m * s > 1e-4) {
        this.dhx[k] = hx / hl;
        this.dhz[k] = hz / hl;
      }
    }
  }

  /**
   * Everyone where they are at time t, seeded by t (a time jump, a town coming into range): the share
   * that is home by the hour indoors, some resting at places, the rest on the network clear of each
   * other; then a short settle so nobody starts mid-stride into someone.
   */
  placeAt(t: number, late: number): void {
    const N = this.net, n = this.n, seed = (this.seed ^ Math.round(t * 60)) >>> 0;
    this.occ.fill(-1);
    this.pl.fill(-1);
    this.cm.fill(-1);
    this.cnt.fill(0);
    // edges to stand on, by length (no stubs, no crossings), on each walker's land
    const total = N.len.reduce((a, l, e) => a + (N.kind[e] === E.stub || N.kind[e] === E.cross ? 0 : l), 0);
    for (let i = 0; i < n; i++) {
      const f = this.folk[i], r = (k: number) => hash3(i, k, seed);
      this.out[i] = hash3(i, 91, this.seed) >= late * 0.62 || i === this.rider ? 1 : 0;
      this.st[i] = S.walk;
      this.vis[i] = 1;
      this.stuck[i] = 0;
      this.v[i] = this.vx[i] = this.vz[i] = this.g[i] = 0;
      this.g[i] = r(1) * 3;
      // indoors: at home for the night, or in a shop now and then
      if ((!this.out[i] && f.home >= 0) || (f.home >= 0 && r(2) < 0.06)) {
        const pl = N.places[f.home];
        this.st[i] = S.home;
        this.vis[i] = 0;
        this.pl[i] = f.home;
        this.tm[i] = r(3) * 20;
        this.x[i] = pl.x;
        this.z[i] = pl.z;
        this.h[i] = pl.h;
        this.hx[i] = 1;
        this.hz[i] = 0;
        continue;
      }
      // resting at a free seat or spot
      if (r(4) < 0.3 && !f.dog && i !== this.rider) {
        const a = this.pick[r(5) < 0.6 ? 1 : 2];
        const p = a.length ? N.destPlace[a[Math.floor(r(6) * a.length)]] : -1;
        if (p >= 0 && this.occ[p] < 0 && this.clear(i, N.places[p].x, N.places[p].z)) {
          const pl = N.places[p];
          this.occ[p] = i;
          this.pl[i] = p;
          this.st[i] = S.rest;
          this.bl[i] = 1;
          this.tm[i] = r(7) * 40 + 3;
          this.x[i] = pl.x;
          this.z[i] = pl.z;
          this.h[i] = pl.h;
          this.hx[i] = pl.fx;
          this.hz[i] = pl.fz;
          continue;
        }
      }
      // out walking somewhere on the network
      let placed = false;
      for (let tries = 0; tries < 16 && !placed; tries++) {
        let w = r(10 + tries * 3) * total, e = 0;
        for (; e < N.len.length - 1; e++) {
          if (N.kind[e] === E.stub || N.kind[e] === E.cross) continue;
          if ((w -= N.len[e]) <= 0) break;
        }
        if (N.kind[e] === E.stub || N.kind[e] === E.cross || N.compLen[N.comp[N.ea[e]]] < 12) continue;
        const u = r(11 + tries * 3) * N.len[e];
        this.hint[i] = this.at(e, u, N.ef[e]);
        const l = scratch.lo + (scratch.hi - scratch.lo) * r(12 + tries * 3), x = scratch.x - scratch.tz * l, z = scratch.z + scratch.tx * l;
        if (!this.clear(i, x, z)) continue;
        this.e[i] = e;
        this.d[i] = r(13) < 0.5 ? 1 : -1;
        this.u[i] = u;
        this.nxt[i] = -1;
        this.x[i] = x;
        this.z[i] = z;
        this.h[i] = scratch.h;
        this.hx[i] = scratch.tx * this.d[i];
        this.hz[i] = scratch.tz * this.d[i];
        this.v[i] = f.v * 0.8;
        placed = true;
      }
      if (!placed) {
        // nowhere clear: indoors at home (or anywhere a home is), out again in a while
        const p = f.home >= 0 ? f.home : N.places.findIndex((q) => q.k === PK.door && q.node >= 0);
        this.st[i] = S.home;
        this.vis[i] = 0;
        this.pl[i] = p;
        this.tm[i] = 5 + r(9) * 20;
        if (p >= 0) [this.x[i], this.z[i], this.h[i]] = [N.places[p].x, N.places[p].z, N.places[p].h];
        continue;
      }
      this.dst[i] = this.choose(i, late);
    }
    for (let i = 0; i < n; i++) {
      this.px[i] = this.x[i];
      this.pz[i] = this.z[i];
      this.ph[i] = this.h[i];
      this.phx[i] = this.hx[i];
      this.phz[i] = this.hz[i];
      this.pg[i] = this.g[i];
    }
    // the dogs at their owners' heels
    for (let k = 0; k < this.dOwner.length; k++) {
      const o = this.dOwner[k];
      this.trailN[k] = 0;
      this.dx[k] = this.dpx[k] = this.x[o] - this.hx[o] * HEEL;
      this.dz[k] = this.dpz[k] = this.z[o] - this.hz[o] * HEEL;
      this.dhx[k] = this.hx[o];
      this.dhz[k] = this.hz[o];
    }
    for (let k = 0; k < 30; k++) this.step(1 / 30, null, null, late);
  }

  /** Is (x, z) at least SEP from every walker placed before i and every anchored body? */
  private clear(i: number, x: number, z: number): boolean {
    for (let j = 0; j < i; j++) if (this.st[j] !== S.home && (this.x[j] - x) ** 2 + (this.z[j] - z) ** 2 < 0.6 * 0.6) return false;
    for (let k = 0; k < this.ax.length; k++) if ((this.ax[k] - x) ** 2 + (this.az[k] - z) ** 2 < 0.6 * 0.6) return false;
    return true;
  }

}
