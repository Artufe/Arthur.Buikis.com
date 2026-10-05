// Enter transitions (D1, refine 1): the camera's way from where it is to a ride's pose, planned once
// at the switch as a smooth 3D path and then travelled by arc length on one smootherstep clock.
//
//   - The ground track is the great circle from the start to an approach point Q on the new view's
//     own axis, a little behind the end pose T; the last stretch Q → T runs straight along that
//     axis, so the camera arrives looking where it will keep looking (no end-of-move pan).
//   - The height along the track is a profile in (ground distance, height): log-height eased
//     between the ends (a climb rises early, a descent stays high and drops late), a hop on long
//     trips and between two low ends, then raised to clear what lies near the track (roofs within
//     1.5 m plus a margin, lamp heads, crowns, terrain) with slope-limited ramps that start before
//     the obstacle. When the start (or the end) is down in a street, the profile begins (ends) with
//     a vertical segment: the camera pops straight up out of the street before it travels, and
//     drops straight down into it at the end, instead of sliding into a facade.
//   - Corners are rounded (Chaikin), and the path is timed by an *effective* length that weighs the
//     cloud band and the last metres above the ground more: one bell-shaped speed curve, slower
//     through the clouds (the falling-through overlay reads) and settling gently onto the street.
//
// Pure math on three's Vector3: the world comes in through `clear(dir, r)`.

import { Vector3 } from 'three';
import { R } from '../../world/config';

/** The cloud layer's band (m above sea level), as clouds/crossing.ts sees it. */
export const CLOUD_LO = 34;
export const CLOUD_HI = 50;

/** Most points a planned path holds (after rounding). */
const MAXP = 4608;
/** Steepest ramp of the clearance envelope (height per metre of ground track). */
const RAMP = 0.9;
/** Roof clearance radius along the track (m): facades stay ≥ this far from the lens. */
const CLEAR_R = 4;
const PROBE_R = [CLEAR_R, 2.5, 1.5, 1, 0.6, 0.3] as const;
/** Leaving a street on a longer trip: the first rise clears everything within this (m). */
const START_R = 9;
/** Track bulges tried (fractions of the trip, capped at 160 m), when the straight one must climb. */
const BULGES = [0.18, -0.18, 0.36, -0.36, 0.55, -0.55] as const;
/** Effective length a radian of the view's turn toward the new look point costs. */
const K_TURN = 2.2;
/** Climb / descent line (height per metre of ground track). */
const CLIMB = 1;
/** The low route's height (m above sea level: under the cloud band) and its final climb's slope. */
const LOW_H = CLOUD_LO - 6;
const LOW_CLIMB = 1.6;

export interface PathEnv {
  /**
   * Lowest height (m above sea level) the camera may pass at unit `dir`, counting what stands within
   * `r` metres of it (roofs + margin, lamp heads, crowns, terrain + margin).
   */
  clear(dir: Vector3, r: number): number;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** The speed scale's height offset (m): near the ground the camera moves as if 30 m up. */
const H0 = 30;

/** Near either end the speed scales with the distance to it, plus this (m). */
const D0 = 12;

/**
 * Time weight of a metre of path at height h (m above sea level), `near` m from the nearer end.
 * The camera's speed scales with its height, or with its distance to where it left or where it
 * lands when that is less (what it sees streams past at about the same angular rate: a climb out of
 * a street is unhurried, the trip round the planet quick, the last metres to a satellite or onto a
 * car settle like a dolly), and the cloud band counts double, so the falling-through-clouds overlay
 * reads.
 */
export function pathWeight(h: number, near = Infinity): number {
  const band = smooth(CLOUD_LO - 12, CLOUD_LO, h) * (1 - smooth(CLOUD_HI, CLOUD_HI + 12, h));
  // (Softened: speed ∝ scale^0.65, so the trip's peak stays within ~3× its mean.)
  return (1 + 1.2 * band) / Math.pow(Math.min(Math.max(0, h) + H0, near + D0), 0.65);
}

/**
 * Normalised log-height progress along the track: a climb rises early (out of the street first), a
 * descent stays high and drops late, a level trip eases both ways. k: −1 (descending) … 1 (climbing).
 */
export function heightCurve(u: number, k: number): number {
  const sm = u * u * (3 - 2 * u);
  const up = 1 - Math.pow(1 - u, 2.2);
  const dn = Math.pow(u, 2.2);
  return sm + Math.max(0, k) * (up - sm) + Math.max(0, -k) * (dn - sm);
}

const _dS = new Vector3();
const _dQ = new Vector3();
const _ax = new Vector3();
const _d = new Vector3();
const _p = new Vector3();

/** Inverse of smootherstep on 0…1 (a few Newton steps from a good start). */
function invSmoother(y: number): number {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  let t = y;
  for (let i = 0; i < 8; i++) {
    const f = t * t * t * (t * (t * 6 - 15) + 10) - y;
    const d = 30 * t * t * (1 - t) * (1 - t);
    if (d < 1e-6) break;
    t = Math.min(1, Math.max(0, t - f / d));
  }
  return t;
}

export class EnterPath {
  private readonly px = new Float64Array(MAXP);
  private readonly py = new Float64Array(MAXP);
  private readonly pz = new Float64Array(MAXP);
  private readonly qx = new Float64Array(MAXP);
  private readonly qy = new Float64Array(MAXP);
  private readonly qz = new Float64Array(MAXP);
  /** Cumulative effective length at each point. */
  private readonly cum = new Float64Array(MAXP);
  // (s, h) profile scratch
  private readonly ps = new Float64Array(1024);
  private readonly ph = new Float64Array(1024);
  private readonly need = new Float64Array(130);
  private readonly env = new Float64Array(130);
  private readonly base = new Float64Array(130);
  n = 0;
  /** Real length (m). */
  length = 0;
  /** Effective-length fraction where the straight approach (Q → T) begins. */
  eQ = 1;
  /** Effective-length fraction where the path first enters the cloud band (−1: it never does). */
  eCross = -1;
  /** Effective-length fraction at the top of the first vertical rise (0: none). */
  ePop = 0;
  private iCross = -1;
  /** True when the path passes through the cloud band. */
  crosses = false;
  /** Highest point (m above sea level). */
  peak = 0;
  /** The sideways bulge of the chosen track (m; 0 = the great circle). */
  bulge = 0;
  /** Review: the planned view turn toward the new look point (rad). */
  turnSum = 0;
  /** Effective length (dimensionless: Σ metres / (height + 30 m), the cloud band ×2.2). */
  effLength = 0;
  /** Height of the first vertical rise (m; 0 = none) and of the final drop. */
  popUp = 0;
  dropDown = 0;
  /** Ground distance (m) of the low route under the band before the climb (0: none). */
  lowRoute = 0;

  /**
   * Plan from S through the approach point Q to the end T (world positions). `clearEnv` gives the
   * clearance; `hopLog` adds a sin-shaped hop in log-height units (long trips round the planet).
   */
  plan(S: Vector3, Q: Vector3, T: Vector3, clearEnv: PathEnv, hopLog = 0, look: Vector3 | null = null, subject: Vector3 | null = null): this {
    const hS = S.length() - R;
    const hQ = Q.length() - R;
    _dS.copy(S).normalize();
    _dQ.copy(Q).normalize();
    const ang = Math.acos(Math.min(1, Math.max(-1, _dS.dot(_dQ))));
    _ax.crossVectors(_dS, _dQ);
    if (_ax.lengthSq() < 1e-18) _ax.set(Math.abs(_dS.x) < 0.9 ? 1 : 0, Math.abs(_dS.x) < 0.9 ? 0 : 1, 0).cross(_dS);
    _ax.normalize();
    const sTot = ang * R;
    const N = Math.min(128, Math.max(8, Math.ceil(sTot / 1.5)));
    const ds = sTot / N;
    // How close to a facade each end may sit (it is already there: let it move away). Leaving a
    // street for somewhere further than the next block, the camera first rises over everything
    // within 9 m (a crane shot up out of the street), so it never travels past upper floors.
    const rQ = this.probe(_dQ, hQ, clearEnv);
    const rS = sTot > 40 ? START_R : this.probe(_dS, hS, clearEnv);
    const lhS = Math.log(Math.max(0.25, hS));
    const lhQ = Math.log(Math.max(0.25, hQ));
    const k = Math.max(-1, Math.min(1, (lhQ - lhS) / Math.log(4)));
    const lowHop = Math.min(18, 0.16 * sTot) * (1 - smooth(12, 40, Math.max(hS, hQ)));
    // Up to something behind the planet (a satellite on the far side): the falling-through-clouds
    // overlay needs it in frame, so the camera stays under the cloud band and travels round toward
    // it until it has risen over the horizon (seen from the bottom of the band), then climbs through.
    this.lowRoute = 0;
    let sLow = -1;
    if (subject && k > 0.3 && hQ > CLOUD_HI + 6 && hS < CLOUD_LO - 6 && !this.seenFrom(_dS, CLOUD_LO - 4, subject)) {
      for (let i = 1; i <= 64; i++) {
        const u = i / 64;
        this.trackDir(u, ang, 0, _d);
        if (this.seenFrom(_d, LOW_H + 2, subject)) {
          sLow = u * sTot;
          break;
        }
      }
      if (sLow > 0) this.lowRoute = sLow;
    }
    const need = this.need;
    const v = this.env;
    // The height profile along a track bulging `bulge` m sideways at its middle (0: the great
    // circle): returns its cost — how much it has to climb over what is in the way, and whether a
    // low hop would end up in the clouds.
    const profile = (bulge: number): number => {
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        const s = u * sTot;
        let base = Math.exp(lhS + (lhQ - lhS) * heightCurve(u, k) + hopLog * Math.sin(Math.PI * u)) + lowHop * 4 * u * (1 - u);
        // A climb gets up at ≥ 45° (no long skim over the roofs on the way to space) and never over
        // its end; a descent stays above a 45° line down to its end and never rises over its start
        // (from the city view onto a car it went up a metre before it dived).
        if (k > 0.3) base = Math.min(hQ, Math.max(base, Math.min(hQ, hS + s * CLIMB)));
        else if (k < -0.3) base = Math.min(hS, Math.max(base, Math.min(hS, hQ + (sTot - s) * CLIMB)));
        // The low route: up to just under the band, along, then a steep climb once the subject shows.
        if (sLow > 0) base = s < sLow ? Math.min(LOW_H, hS + s * CLIMB) : Math.min(hQ, LOW_H + (s - sLow) * LOW_CLIMB);
        let r: number;
        if (i === 0) r = rS;
        else if (i === N) r = rQ;
        else {
          r = Math.min(rS + (CLEAR_R - rS) * smooth(0, rS > CLEAR_R ? 22 : 4, s), rQ + (CLEAR_R - rQ) * smooth(0, 4, sTot - s));
          r = Math.max(r, Math.min(4, ds * 0.5)); // what lies between samples
        }
        this.trackDir(u, ang, bulge, _d);
        need[i] = clearEnv.clear(_d, r);
        this.base[i] = i === 0 ? hS : i === N ? hQ : base;
      }
      // Slope-limited envelope of what must be cleared: ramps up toward an obstacle and down
      // after it; then the base profile wherever it is higher.
      for (let i = 0; i <= N; i++) v[i] = need[i];
      for (let i = 1; i <= N; i++) v[i] = Math.max(v[i], v[i - 1] - RAMP * ds);
      for (let i = N - 1; i >= 0; i--) v[i] = Math.max(v[i], v[i + 1] - RAMP * ds);
      let cost = Math.abs(bulge) * 0.6;
      let top = 0;
      for (let i = 0; i <= N; i++) {
        cost += Math.max(0, v[i] - this.base[i]) * ds;
        v[i] = Math.max(v[i], this.base[i]);
        top = Math.max(top, v[i]);
      }
      // One arc per trip: up to a single peak and down from it, never a dip between two climbs
      // (over a block, down into the next street, up over the next: it read as a roller coaster).
      let pk = 0;
      for (let i = 1; i <= N; i++) if (v[i] > v[pk]) pk = i;
      for (let i = 1; i < pk; i++) v[i] = Math.max(v[i], v[i - 1]);
      for (let i = N - 1; i > pk; i--) v[i] = Math.max(v[i], v[i + 1]);
      if (top > CLOUD_LO - 3 && Math.max(hS, hQ) < CLOUD_LO - 3) cost += 2000;
      return cost;
    };
    // Over or round: a hop that would have to climb over a tower tries a track that swings round
    // it instead, either side, and keeps the cheapest.
    let bulge = 0;
    let best = profile(0);
    if (best > 1 && sTot > 6 && sTot < 500) {
      const span = Math.min(sTot, 160);
      for (const f of BULGES) {
        const c = profile(f * span);
        if (c < best - 1) {
          best = c;
          bulge = f * span;
        }
      }
      profile(bulge);
    }
    this.bulge = bulge;
    this.lastN = N;
    // The (s, h) profile: a vertical rise / drop at the ends where the envelope stands above them.
    let m = 0;
    const ps = this.ps;
    const ph = this.ph;
    const push = (s: number, h: number) => {
      // Subdivide to ≤ 2 m (or 1/300 of the trip) so rounding cuts corners by little.
      if (m > 0) {
        const dl = Math.hypot(s - ps[m - 1], h - ph[m - 1]);
        const seg = Math.max(2, (sTot + Math.abs(hQ - hS)) / 300);
        const parts = Math.min(64, Math.ceil(dl / seg));
        const s0 = ps[m - 1];
        const h0 = ph[m - 1];
        for (let j = 1; j < parts && m < ps.length - 2; j++) {
          ps[m] = s0 + ((s - s0) * j) / parts;
          ph[m] = h0 + ((h - h0) * j) / parts;
          m++;
        }
      }
      if (m < ps.length - 1) {
        ps[m] = s;
        ph[m] = h;
        m++;
      }
    };
    push(0, hS);
    this.popUp = v[0] > hS + 0.05 ? v[0] - hS : 0;
    if (this.popUp > 0) push(0, v[0]);
    const mPop = this.popUp > 0 ? m - 1 : 0;
    for (let i = 1; i < N; i++) push(i * ds, v[i]);
    push(sTot, v[N]);
    this.dropDown = v[N] > hQ + 0.05 ? v[N] - hQ : 0;
    if (this.dropDown > 0) push(sTot, hQ);
    // To 3D, then the straight approach Q → T.
    let n = 0;
    for (let j = 0; j < m; j++) {
      this.trackDir(sTot > 1e-9 ? ps[j] / sTot : 0, ang, bulge, _p).multiplyScalar(R + ph[j]);
      this.px[n] = _p.x;
      this.py[n] = _p.y;
      this.pz[n] = _p.z;
      n++;
    }
    // (Exact ends: the track's great circle reproduces S and Q only up to rounding.)
    this.px[0] = S.x;
    this.py[0] = S.y;
    this.pz[0] = S.z;
    this.px[n - 1] = Q.x;
    this.py[n - 1] = Q.y;
    this.pz[n - 1] = Q.z;
    const iQ = n - 1;
    const iPop = mPop;
    const aLen = Q.distanceTo(T);
    const aParts = Math.max(1, Math.min(40, Math.ceil(aLen / 2), 1100 - n));
    for (let j = 1; j <= aParts; j++) {
      const t = j / aParts;
      this.px[n] = Q.x + (T.x - Q.x) * t;
      this.py[n] = Q.y + (T.y - Q.y) * t;
      this.pz[n] = Q.z + (T.z - Q.z) * t;
      n++;
    }
    // The turn onto the approach: rounded over a stretch either side of Q (a curve, not a corner the
    // camera takes at 70 m/s), up to 35 % of the approach and of the way there, ≤ 25 m.
    this.roundAt(iQ, n, Math.min(25, 0.35 * aLen, 0.35 * this.arcTo(iQ)));
    // Effective-length fraction of Q (before rounding; rounding moves it by a hair).
    let effQ = 0;
    let effPop = 0;
    let eff = 0;
    for (let j = 1; j < n; j++) {
      const l = Math.hypot(this.px[j] - this.px[j - 1], this.py[j] - this.py[j - 1], this.pz[j] - this.pz[j - 1]);
      const hm = Math.hypot((this.px[j] + this.px[j - 1]) / 2, (this.py[j] + this.py[j - 1]) / 2, (this.pz[j] + this.pz[j - 1]) / 2) - R;
      eff += l * pathWeight(hm, this.nearEnds(j, S, T));
      if (j === iQ) effQ = eff;
      if (j === iPop) effPop = eff;
    }
    const fracQ = eff > 1e-9 ? effQ / eff : 1;
    const fracPop = eff > 1e-9 ? effPop / eff : 0;
    // Round the corners: three Chaikin passes (quarter cuts), the ends kept.
    for (let pass = 0; pass < 3 && n * 2 <= MAXP; pass++) n = this.chaikin(n);
    this.n = n;
    // Cumulative effective length, the band entry, the peak.
    const cum = this.cum;
    cum[0] = 0;
    let len = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let crossAt = -1;
    this.turnSum = 0;
    // (Where the view toward the new look point would turn fast, time slows: K_TURN per radian.)
    if (look) _d.set(look.x - this.px[0], look.y - this.py[0], look.z - this.pz[0]).normalize();
    for (let j = 1; j < n; j++) {
      const l = Math.hypot(this.px[j] - this.px[j - 1], this.py[j] - this.py[j - 1], this.pz[j] - this.pz[j - 1]);
      const hm = Math.hypot((this.px[j] + this.px[j - 1]) / 2, (this.py[j] + this.py[j - 1]) / 2, (this.pz[j] + this.pz[j - 1]) / 2) - R;
      len += l;
      let turn = 0;
      if (look) {
        _p.set(look.x - this.px[j], look.y - this.py[j], look.z - this.pz[j]);
        if (_p.lengthSq() > 1e-6) {
          _p.normalize();
          turn = Math.acos(Math.max(-1, Math.min(1, _p.dot(_d))));
          _d.copy(_p);
        }
      }
      // (Per segment for now: its length in qx, its time density in qy, smoothed below.)
      this.qx[j] = l;
      this.qy[j] = pathWeight(hm, this.nearEnds(j, S, T)) + (l > 1e-9 ? (K_TURN * turn) / l : 0);
      this.turnSum += turn;
      if (crossAt < 0 && hm >= CLOUD_LO && hm <= CLOUD_HI) crossAt = j;
      lo = Math.min(lo, hm);
      hi = Math.max(hi, hm);
    }
    // The time density, averaged over a window of the path's own length (±4 % of it, ≥ 6 m), so
    // every change of pace — the cloud band, the dolly near the ends, a turn — eases in over a
    // stretch instead of stepping the speed between two frames.
    const half = Math.max(6, len * 0.04);
    const sArr = this.qz; // arc length at each point
    sArr[0] = 0;
    for (let j = 1; j < n; j++) sArr[j] = sArr[j - 1] + this.qx[j];
    // Prefix sums of density × length, by segment.
    cum[0] = 0;
    for (let j = 1; j < n; j++) cum[j] = cum[j - 1] + this.qy[j] * this.qx[j];
    // (The window reads the prefix sums, never qy, so qy can take the smoothed value in place.)
    let a = 1;
    let b = 1;
    for (let j = 1; j < n; j++) {
      const mid = (sArr[j] + sArr[j - 1]) / 2;
      while (a < n - 1 && sArr[a] < mid - half) a++;
      while (b < n - 1 && sArr[b] < mid + half) b++;
      const s0 = sArr[a - 1];
      const s1 = sArr[b];
      if (s1 - s0 > 1e-9) this.qy[j] = (cum[b] - cum[a - 1]) / (s1 - s0);
    }
    // Rebuild the cumulative effective length from the smoothed density.
    cum[0] = 0;
    for (let j = 1; j < n; j++) cum[j] = cum[j - 1] + this.qy[j] * this.qx[j];
    this.length = len;
    this.effLength = cum[n - 1];
    this.peak = Math.max(hi, hS, T.length() - R);
    const total = cum[n - 1] || 1;
    this.eQ = Math.min(1, Math.max(0.05, fracQ));
    this.ePop = fracPop;
    this.crosses = n > 1 && ((lo < CLOUD_LO && hi > CLOUD_LO) || (lo < CLOUD_HI && hi > CLOUD_HI));
    this.iCross = this.crosses ? crossAt : -1;
    this.eCross = this.crosses && crossAt > 0 ? cum[crossAt] / total : -1;
    return this;
  }

  /**
   * Spend longer before the cloud band: stretch the timing of everything before it so the band is
   * entered at effective fraction `e` (if it comes sooner), the rest of the path sped up to match.
   * The fractions (eQ, ePop, eCross) are rescaled. Time to turn toward the subject before the
   * falling-through-clouds overlay starts.
   */
  delayCross(e: number): void {
    const i = this.iCross;
    if (i <= 0 || this.eCross >= e || e >= 0.95) return;
    const n = this.n;
    const cum = this.cum;
    const src = this.qx; // scratch: the original cumulative lengths
    src.set(cum.subarray(0, n));
    const c = src[i];
    // A smooth time multiplier: K before the band, easing to 1 over [0.5 c, 1.4 c] (no speed step).
    const remap = (K: number) => {
      cum[0] = 0;
      for (let j = 1; j < n; j++) {
        const mid = (src[j] + src[j - 1]) / 2;
        const m = 1 + (K - 1) * (1 - smooth(0.3 * c, 2.5 * c, mid));
        cum[j] = cum[j - 1] + (src[j] - src[j - 1]) * m;
      }
      return cum[i] / cum[n - 1];
    };
    let lo = 1;
    let hi = 7;
    for (let k = 0; k < 28; k++) {
      const mid = (lo + hi) / 2;
      if (remap(mid) < e) lo = mid;
      else hi = mid;
    }
    remap(hi);
    const total0 = src[n - 1];
    const total1 = cum[n - 1];
    // Rescale the fractions through the same map (interpolated on the original lengths).
    const mapFrac = (f: number) => {
      const x = f * total0;
      let j = 1;
      while (j < n - 1 && src[j] < x) j++;
      const span = src[j] - src[j - 1];
      const t = span > 1e-12 ? (x - src[j - 1]) / span : 0;
      return (cum[j - 1] + (cum[j] - cum[j - 1]) * t) / total1;
    };
    this.eQ = mapFrac(this.eQ);
    this.ePop = mapFrac(this.ePop);
    this.eCross = cum[i] / total1;
  }

  /**
   * The fastest the camera moves (m/s) if the path takes `dur` s on the smootherstep clock (the
   * effective length mapped back to metres along the way).
   */
  peakSpeed(dur: number): number {
    const n = this.n;
    const cum = this.cum;
    const total = cum[n - 1];
    if (!(total > 0) || n < 2) return 0;
    let peak = 0;
    for (let j = 1; j < n; j++) {
      const de = (cum[j] - cum[j - 1]) / total;
      if (de <= 0) continue;
      const l = Math.hypot(this.px[j] - this.px[j - 1], this.py[j] - this.py[j - 1], this.pz[j] - this.pz[j - 1]);
      // de/dt of smootherstep at this e: 30 t²(1 − t)² / dur, with t from e.
      const e = (cum[j] + cum[j - 1]) / 2 / total;
      const t = invSmoother(e);
      const dedt = (30 * t * t * (1 - t) * (1 - t)) / dur;
      peak = Math.max(peak, (l / de) * dedt);
    }
    return peak;
  }

  /** Review: the last profile (heights along the track, m above sea level) and what it had to clear. */
  dump(): { v: number[]; need: number[]; base: number[] } {
    return { v: Array.from(this.env.subarray(0, this.lastN + 1)), need: Array.from(this.need.subarray(0, this.lastN + 1)), base: Array.from(this.base.subarray(0, this.lastN + 1)) };
  }
  private lastN = 0;

  /** True when point X is in sight from h m above unit dir d (the segment clears the planet). */
  private seenFrom(d: Vector3, h: number, X: Vector3): boolean {
    _p.copy(d).multiplyScalar(R + h);
    return clearsPlanet(_p, X);
  }

  /** Unit direction of the track at u (0 … 1): the great circle, bulged `bulge` m sideways mid-way. */
  private trackDir(u: number, ang: number, bulge: number, out: Vector3): Vector3 {
    out.copy(_dS).applyAxisAngle(_ax, ang * u);
    if (bulge !== 0) out.addScaledVector(_ax, (bulge * 4 * u * (1 - u)) / R).normalize();
    return out;
  }

  /**
   * Distance (m) from the middle of segment j − 1 → j to the nearer of S and T — as pathWeight reads
   * it: a start high up counts as further (its own height × 0.6 at least), so a trip from the city
   * view or orbit sets off at once instead of creeping its first metres like a street start (the end
   * keeps its dolly: the last metres onto anything settle).
   */
  private nearEnds(j: number, S: Vector3, T: Vector3): number {
    const x = (this.px[j] + this.px[j - 1]) / 2;
    const y = (this.py[j] + this.py[j - 1]) / 2;
    const z = (this.pz[j] + this.pz[j - 1]) / 2;
    const dS = Math.hypot(x - S.x, y - S.y, z - S.z) + Math.max(0, 0.6 * (S.length() - R) - D0);
    return Math.min(dS, Math.hypot(x - T.x, y - T.y, z - T.z));
  }

  /** The largest clearance radius (m, ≤ 1.5) at which unit dir at height h is already clear. */
  private probe(dir: Vector3, h: number, env: PathEnv): number {
    for (let i = 0; i < PROBE_R.length; i++) if (env.clear(dir, PROBE_R[i]) <= h + 0.01) return PROBE_R[i];
    return 0;
  }

  /** Arc length (m) of the polyline up to point i. */
  private arcTo(i: number): number {
    let l = 0;
    for (let j = 1; j <= i; j++) l += Math.hypot(this.px[j] - this.px[j - 1], this.py[j] - this.py[j - 1], this.pz[j] - this.pz[j - 1]);
    return l;
  }

  /**
   * Replace the polyline within arc distance r of point i (of n) by a quadratic Bézier through the
   * points at −r and +r with point i as its control: the corner becomes a smooth curve.
   */
  private roundAt(i: number, n: number, r: number): void {
    if (!(r > 0.5) || i <= 0 || i >= n - 1) return;
    const { px, py, pz } = this;
    // Walk back and forward r metres.
    let a = i;
    let la = 0;
    while (a > 0 && la < r) {
      la += Math.hypot(px[a] - px[a - 1], py[a] - py[a - 1], pz[a] - pz[a - 1]);
      a--;
    }
    let b = i;
    let lb = 0;
    while (b < n - 1 && lb < r) {
      lb += Math.hypot(px[b + 1] - px[b], py[b + 1] - py[b], pz[b + 1] - pz[b]);
      b++;
    }
    if (b - a < 2) return;
    const ax = px[a], ay = py[a], az = pz[a];
    const cx = px[i], cy = py[i], cz = pz[i];
    const bx = px[b], by = py[b], bz = pz[b];
    for (let j = a + 1; j < b; j++) {
      const t = (j - a) / (b - a);
      const u = 1 - t;
      px[j] = u * u * ax + 2 * u * t * cx + t * t * bx;
      py[j] = u * u * ay + 2 * u * t * cy + t * t * by;
      pz[j] = u * u * az + 2 * u * t * cz + t * t * bz;
    }
  }

  /** One Chaikin pass in place (ends kept); returns the new count. */
  private chaikin(n: number): number {
    const { px, py, pz, qx, qy, qz } = this;
    let m = 0;
    qx[m] = px[0];
    qy[m] = py[0];
    qz[m] = pz[0];
    m++;
    for (let j = 0; j < n - 1; j++) {
      const ax = px[j], ay = py[j], az = pz[j];
      const bx = px[j + 1], by = py[j + 1], bz = pz[j + 1];
      if (j > 0) {
        qx[m] = 0.75 * ax + 0.25 * bx;
        qy[m] = 0.75 * ay + 0.25 * by;
        qz[m] = 0.75 * az + 0.25 * bz;
        m++;
      }
      if (j < n - 2) {
        qx[m] = 0.25 * ax + 0.75 * bx;
        qy[m] = 0.25 * ay + 0.75 * by;
        qz[m] = 0.25 * az + 0.75 * bz;
        m++;
      }
    }
    qx[m] = px[n - 1];
    qy[m] = py[n - 1];
    qz[m] = pz[n - 1];
    m++;
    px.set(qx.subarray(0, m));
    py.set(qy.subarray(0, m));
    pz.set(qz.subarray(0, m));
    return m;
  }

  /** The point at effective-length fraction e (0 … 1), into out. */
  at(e: number, out: Vector3): Vector3 {
    const n = this.n;
    if (n === 0) return out;
    if (e <= 0 || n === 1) return out.set(this.px[0], this.py[0], this.pz[0]);
    if (e >= 1) return out.set(this.px[n - 1], this.py[n - 1], this.pz[n - 1]);
    const want = e * this.cum[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= want) lo = mid;
      else hi = mid;
    }
    const span = this.cum[hi] - this.cum[lo];
    const t = span > 1e-12 ? (want - this.cum[lo]) / span : 0;
    return out.set(
      this.px[lo] + (this.px[hi] - this.px[lo]) * t,
      this.py[lo] + (this.py[hi] - this.py[lo]) * t,
      this.pz[lo] + (this.pz[hi] - this.pz[lo]) * t,
    );
  }
}

const _cp = new Vector3();
/** True when the segment a → b clears the planet (sea level + 2 m). */
export function clearsPlanet(a: Vector3, b: Vector3): boolean {
  _cp.subVectors(b, a);
  const len2 = _cp.lengthSq();
  if (len2 < 1e-9) return true;
  const t = Math.max(0, Math.min(1, -a.dot(_cp) / len2));
  _cp.multiplyScalar(t).add(a);
  return _cp.length() > R + 2;
}

/** Samples of a transition's time map. */
const TM_N = 128;

/**
 * A transition's time map (refine 2): the clock's progress u (0 … 1) → the path's progress e (0 … 1).
 * Built from what each stretch of the path costs: its share of the planned pace (the path's own
 * effective length), but never less than the time its turn of the view needs at `turnMax` rad/s or
 * its metres at `vMax(h)` m/s, at the clock's cruise. So the planned view never turns faster than
 * turnMax — the round-1 transitions leaned on the turn cap for half a second at a time and then let go
 * of it with a jolt — and the clock eases in and out round that.
 */
export class TimeMap {
  readonly u = new Float64Array(TM_N + 1);
  readonly e = new Float64Array(TM_N + 1);
  /** de/du at each sample (monotone cubic: the speed has no step at a sample). */
  private readonly m = new Float64Array(TM_N + 1);
  private readonly c = new Float64Array(TM_N + 1);
  private readonly t = new Float64Array(TM_N + 1);
  private readonly d = new Float64Array(TM_N + 1);
  /** Review: the share of the time the turn and speed limits took. */
  limited = 0;

  constructor() {
    this.identity();
  }

  /** Identity (u = e). */
  identity(): this {
    for (let i = 0; i <= TM_N; i++) {
      this.u[i] = this.e[i] = i / TM_N;
      this.m[i] = 1;
    }
    this.limited = 0;
    return this;
  }

  /** Fritsch–Carlson slopes for the monotone cubic through (u, e). */
  private slopes(): void {
    const { u, e, m } = this;
    const N = TM_N;
    const d = this.d;
    for (let i = 0; i < N; i++) d[i] = (e[i + 1] - e[i]) / Math.max(1e-12, u[i + 1] - u[i]);
    m[0] = d[0];
    m[N] = d[N - 1];
    for (let i = 1; i < N; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < N; i++) {
      if (d[i] === 0) {
        m[i] = m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
  }

  /**
   * Build from per-sample turns (rad) and metres between e = (i − 1)/N and i/N (index i, 1 … N),
   * the clock's peak rate `peak` (1/s) and the limits; returns how much longer (factor ≥ 1) the trip
   * would have to take to meet them.
   */
  build(turn: Float64Array, metres: Float64Array, height: Float64Array, peak: number, turnMax: number, vMax: (h: number) => number): number {
    const N = TM_N;
    const c = this.c; // the turn's minimum spans
    const d = this.d; // the speed's
    const t = this.t;
    // Minimum u-span of each sample (time at the cruise = du / peak), for its turn and its metres.
    for (let i = 1; i <= N; i++) {
      c[i] = (turn[i] / turnMax) * peak;
      d[i] = (metres[i] / vMax(height[i])) * peak;
    }
    // Each widened a sample either side and smoothed (pace changes ease in), keeping the max; and no
    // sample's minimum under 1/1.18 of its neighbour's (raised, never lowered), so whatever the mix
    // the speed changes by < 18 % from one sample to the next.
    for (const a of [c, d]) {
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i <= N; i++) t[i] = Math.max(a[i], (a[Math.max(1, i - 1)] + 2 * a[i] + a[Math.min(N, i + 1)]) / 4);
        for (let i = 1; i <= N; i++) a[i] = t[i];
      }
      for (let i = 2; i <= N; i++) a[i] = Math.max(a[i], a[i - 1] / 1.18);
      for (let i = N - 1; i >= 1; i--) a[i] = Math.max(a[i], a[i + 1] / 1.18);
    }
    // The limits may take nearly all the time (the planned pace keeps 8 %). Short of time, the turn
    // limit gives way first (the drawn camera's follower and the clock's slowing catch it), the speed
    // limit only if the metres alone overrun.
    let need = 0;
    let needV = 0;
    for (let i = 1; i <= N; i++) {
      need += Math.max(c[i], d[i]);
      needV += d[i];
    }
    const stretch = Math.max(1, need / 0.92);
    let sT = 1;
    let sV = 1;
    if (stretch > 1) {
      if (needV >= 0.92) {
        sT = 0;
        sV = 0.92 / needV;
      } else {
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 30; k++) {
          const m = (lo + hi) / 2;
          let tot = 0;
          for (let i = 1; i <= N; i++) tot += Math.max(m * c[i], d[i]);
          if (tot < 0.92) lo = m;
          else hi = m;
        }
        sT = lo;
      }
    }
    for (let i = 1; i <= N; i++) t[i] = Math.max(sT * c[i], sV * d[i]);
    // Solve for the pace share s: Σ max(s/N, t_i) = 1.
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      let tot = 0;
      for (let i = 1; i <= N; i++) tot += Math.max(m / N, t[i]);
      if (tot < 1) lo = m;
      else hi = m;
    }
    const sh = hi;
    let lim = 0;
    for (let i = 1; i <= N; i++) {
      d[i] = Math.max(sh / N, t[i]);
      if (t[i] > sh / N) lim += d[i];
    }
    this.u[0] = 0;
    this.e[0] = 0;
    for (let i = 1; i <= N; i++) {
      this.u[i] = this.u[i - 1] + d[i];
      this.e[i] = i / N;
    }
    const tot = this.u[N];
    for (let i = 1; i <= N; i++) this.u[i] /= tot;
    this.u[N] = 1;
    this.limited = lim / tot;
    this.slopes();
    return stretch;
  }

  /** e at clock progress u (a monotone cubic through the samples). */
  eAt(u: number): number {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let lo = 0;
    let hi = TM_N;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.u[m] <= u) lo = m;
      else hi = m;
    }
    const span = this.u[hi] - this.u[lo];
    if (span <= 1e-12) return this.e[lo];
    const t = (u - this.u[lo]) / span;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * this.e[lo] + (t3 - 2 * t2 + t) * span * this.m[lo] + (-2 * t3 + 3 * t2) * this.e[hi] + (t3 - t2) * span * this.m[hi];
  }

  static readonly N = TM_N;
}
