// Per-frame breaker state: which crests of the groundswell are breaking where, and how far into
// their life each bit of crest is. Zero allocations.
//
// Crest n of train 0 sits where S = phase + 2πn on every ray at once (the phase is global), so n
// is a crest's identity across rays. Two ray fans feed two groups of slots:
//
//   reef slots   (reef fan) the crest has passed, or will pass, the point where its own offshore
//                amplitude first exceeds the breaking index (binary search on the ray's cumulative
//                K/h): φ = (S_crest − S_onset)/(ω·T_s), T_s = sqrt(H_b/g)
//   shore slots  (shore fan) the reformed wave breaks again on the beach face where 2·amp/h
//                reaches γ_shore, then its bore runs to the waterline (the swash takes over)
//
// Crest n goes to slot n mod the group's size. The result goes into one RGBA32F data texture
// (DATA_W × DATA_H) that the ribbon mesh and the ocean's vertex hook read; the CPU keeps the same
// numbers for sample()/wave() and the effects.
//
// Allocation discipline: V8 boxes a double passed to (or returned from) a call it doesn't
// inline, and this update is far too big for it to inline everything. So helpers take only
// integers and objects; doubles travel through the `F` scratch array, and interpolation is
// written out inline.

import { GAMMA_BREAK, GAMMA_SURF, TRAIN_DEFS, ENV_DT, ENV_W, type SwellField, type SwellRuntime } from '../swell';
import { createTrainEval } from './train';
import { PHI0, PHI_END, stageTimes } from './profile';
import { RAYS, labelAt, type Rays } from './rays';

export const REEF_SLOTS = 6;
export const SHORE_SLOTS = 3;
export const SLOTS = REEF_SLOTS + SHORE_SLOTS;
/** Rows per slot in the data texture. */
export const ROWS = 4;
export const DATA_W = RAYS.n;
/** SLOTS·ROWS slot rows + 1 globals row. */
export const DATA_H = SLOTS * ROWS + 1;
export const GLOBAL_ROW = SLOTS * ROWS;
/** Globals row: texel s = header, SLOTS + s = (camera column, ray set, label0, dLabel), 2·SLOTS = time. */
export const G_CAM = SLOTS;
export const G_TIME = 2 * SLOTS;

/**
 * Texel layout, slot s, column = ray r of the slot's fan:
 *   row 4s+0: crest rest x, z · W (activity) · H (profile face height, m)
 *   row 4s+1: dir x, z (unit, train-0 wave direction) · φ · κ (plunge 0-1)
 *   row 4s+2: T_s (s) · smoothed depth (m) · phase speed (m/s) · event (1 reef, 2 shore)
 *   row 4s+3: ∂φ/∂label · ∂H/∂label · smoothed depth 1.2 H ahead (m) · breaking age (s)
 */
export interface Tracker {
  data: Float32Array;
  /** Per slot: crest number held (NaN = empty), first/last active ray. */
  slotN: Float64Array;
  slotR0: Int32Array;
  slotR1: Int32Array;
  /** The fan each slot group reads. */
  reef: Rays;
  shore: Rays;
  raysOf(s: number): Rays;
  /**
   * Per-frame inputs, written by the caller before update() (a typed array, so nothing is
   * boxed): [amplitude scale, dt, camera x, camera z, plunge ×, shore-break index, time ×].
   */
  inp: Float64Array;
  /** Recompute derived per-ray tables after the fans were re-baked in place. */
  refresh(): void;
  update(rt: SwellRuntime, env: Float32Array): void;
}

export const IN_SCALE = 0;
export const IN_DT = 1;
export const IN_CAMX = 2;
export const IN_CAMZ = 3;
export const IN_PLUNGE = 4;
export const IN_GSHORE = 5;
export const IN_TSCALE = 6;

const G = 9.81;
const TAU = Math.PI * 2;

export function createTracker(field: SwellField, reef: Rays, shore: Rays): Tracker {
  const data = new Float32Array(DATA_W * DATA_H * 4);
  const slotN = new Float64Array(SLOTS);
  const slotR0 = new Int32Array(SLOTS);
  const slotR1 = new Int32Array(SLOTS);
  const inp = new Float64Array([1.8, 1 / 60, 0.5, 0.5, 1, 0.9, 1]);
  // Per slot and ray scratch before smoothing: φ, H, W, event, plus the crest's fractional m.
  const phiS = new Float32Array(SLOTS * DATA_W);
  const hS = new Float32Array(SLOTS * DATA_W);
  const wS = new Float32Array(SLOTS * DATA_W);
  const evS = new Int8Array(SLOTS * DATA_W);
  const mS = new Float32Array(SLOTS * DATA_W);
  const cut = new Float32Array(DATA_W);
  const tmp = new Float32Array(DATA_W);
  const ampS = new Float32Array(shore.nr);
  const e12S = new Float32Array(DATA_W);
  const cxS = new Float32Array(DATA_W);
  const czS = new Float32Array(DATA_W);
  // Double scratch: [search value, search result, trainAt x, z, record φ, H, m, weight, label x, z, label, phase].
  const F = new Float64Array(12);
  const te = createTrainEval(field);
  const TE = te.io;
  const omega = field.omega[0];
  const amp0 = TRAIN_DEFS[0].amp;
  const tImp1 = stageTimes(1).imp;
  const tImpShore = stageTimes(0.75).imp;
  // Shore fan: cumulative min of the raw depth along each ray (monotone, for the onset search).
  const hrMin = new Float32Array(shore.hr.length);
  const refresh = () => {
    for (let r = 0; r < shore.nr; r++) {
      const o = r * shore.nm;
      let mn = 1e9;
      for (let m = 0; m < shore.nm; m++) {
        mn = Math.min(mn, shore.hr[o + m]);
        hrMin[o + m] = mn;
      }
    }
  };
  refresh();
  // The current frame's swell runtime and envelope (set at the top of update).
  let rtCur: SwellRuntime | null = null;
  let envCur: Float32Array | null = null;

  /** F[1] = fractional index on ray (o, mEnd) where S reaches F[0] (S strictly increasing). */
  const findS = (R: Rays, o: number, mEnd: number) => {
    const S = R.S;
    const s = F[0];
    if (s <= S[o]) {
      F[1] = 0;
      return;
    }
    if (s >= S[o + mEnd]) {
      F[1] = mEnd;
      return;
    }
    let lo = 0;
    let hi = mEnd;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[o + mid] < s) lo = mid;
      else hi = mid;
    }
    F[1] = lo + (s - S[o + lo]) / (S[o + hi] - S[o + lo]);
  };
  /** F[1] = crest F[0]'s fractional index on ray r, or -1 if it isn't on the ray. */
  const crestOn = (R: Rays, r: number) => {
    const o = r * R.nm;
    const mEnd = R.mEnd[r];
    if (mEnd < 4 || F[0] < R.S[o] || F[0] > R.S[o + mEnd]) {
      F[1] = -1;
      return;
    }
    findS(R, o, mEnd);
  };
  /** F[1] = first fractional reef-fan index where the cumulative K/h reaches F[0], or -1. */
  const findQ = (o: number, mEnd: number) => {
    const Q = reef.Qh;
    const q = F[0];
    if (Q[o + mEnd] < q) {
      F[1] = -1;
      return;
    }
    if (Q[o] >= q) {
      F[1] = 0;
      return;
    }
    let lo = 0;
    let hi = mEnd;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (Q[o + mid] < q) lo = mid;
      else hi = mid;
    }
    const d = Q[o + hi] - Q[o + lo];
    F[1] = lo + (d > 1e-9 ? (q - Q[o + lo]) / d : 1);
  };
  /** F[1] = first fractional shore-fan index with raw depth ≤ F[0], or -1. */
  const findH = (o: number, mEnd: number) => {
    const h = F[0];
    if (hrMin[o + mEnd] > h) {
      F[1] = -1;
      return;
    }
    if (hrMin[o] <= h) {
      F[1] = 0;
      return;
    }
    let lo = 0;
    let hi = mEnd;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (hrMin[o + mid] > h) lo = mid;
      else hi = mid;
    }
    const d = hrMin[o + lo] - hrMin[o + hi];
    F[1] = lo + (d > 1e-9 ? (hrMin[o + lo] - h) / d : 1);
  };
  /** Train `tr` at (F[2], F[3]): amplitude into TE[2], phase θ into TE[3]. */
  const trainXZ = (tr: number) => {
    TE[0] = F[2];
    TE[1] = F[3];
    te.eval(tr);
  };
  /** Claim slot `s` for crest n at ray r (a slot holds one crest a frame). */
  const claim = (s: number, n: number, r: number) => {
    if (!(slotN[s] === n)) {
      if (slotN[s] === slotN[s]) return false;
      slotN[s] = n;
      slotR0[s] = r;
      slotR1[s] = r;
    }
    return true;
  };
  /** Record (φ, H, m, weight) = F[4..7] for slot s, ray r, event ev (the best weight wins). */
  const record = (s: number, r: number, ev: number) => {
    const k = s * DATA_W + r;
    const phi = F[4];
    let a = (phi - PHI0) / 1.5;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    let b = (phi - (PHI_END - 5)) / 5;
    b = b < 0 ? 0 : b > 1 ? 1 : b;
    const w = a * a * (3 - 2 * a) * (1 - b * b * (3 - 2 * b)) * F[7];
    if (w <= wS[k]) return;
    phiS[k] = phi;
    hS[k] = F[5];
    wS[k] = w;
    evS[k] = ev;
    mS[k] = F[6];
    if (r < slotR0[s]) slotR0[s] = r;
    if (r > slotR1[s]) slotR1[s] = r;
  };

  /** Reef fan: reef (and side-shelf) breaks. */
  const reefPass = () => {
    const phase0 = F[11];
    const scale = inp[IN_SCALE];
    const tMod = rtCur ? rtCur.tMod : 0;
    const env = envCur;
    if (!env) return;
    for (let r = 0; r < reef.nr; r++) {
      const o = r * reef.nm;
      const mEnd = reef.mEnd[r];
      const mNear = reef.mNear[r];
      if (mEnd < 4) continue;
      // Only crests that can be breaking matter: from a little before the onset of the biggest
      // wave this ray can see, to the end of the reef zone.
      F[0] = GAMMA_BREAK / (2 * amp0 * scale * 1.15);
      findQ(o, mEnd);
      const mOnMax = F[1];
      if (mOnMax < 0 || mOnMax >= mNear) continue;
      let i0 = mOnMax | 0;
      let f = mOnMax - i0;
      let q = o + i0;
      const sLo = reef.S[q] + (f > 0 ? (reef.S[q + 1] - reef.S[q]) * f : 0) - 1.6;
      const nLo = Math.ceil(((sLo > reef.S[o] ? sLo : reef.S[o]) - phase0) / TAU);
      const nHi = Math.floor((reef.S[o + mEnd] - phase0) / TAU);
      for (let n = nLo; n <= nHi; n++) {
        const sc = phase0 + TAU * n;
        F[0] = sc;
        findS(reef, o, mEnd);
        const mc = F[1];
        i0 = mc | 0;
        f = mc - i0;
        q = o + i0;
        const q1 = f > 0 ? q + 1 : q;
        const tau = reef.tau[q] + (reef.tau[q1] - reef.tau[q]) * f;
        // The envelope texture's linear filter (swell.ts envelopeAt), inline.
        let u = (tMod - tau) / ENV_DT - 0.5;
        u -= Math.floor(u / ENV_W) * ENV_W;
        const e0 = Math.floor(u);
        const ef = u - e0;
        const e1 = e0 + 1 >= ENV_W ? 0 : e0 + 1;
        const aOff = amp0 * scale * (env[e0] * (1 - ef) + env[e1] * ef);
        if (aOff < 0.02) continue;
        F[0] = GAMMA_BREAK / (2 * aOff);
        findQ(o, mEnd);
        const mOn = F[1];
        if (mOn < 0 || mOn >= mNear) continue;
        const j0 = mOn | 0;
        const jf = mOn - j0;
        const p = o + j0;
        const p1 = jf > 0 ? p + 1 : p;
        const Hb = 2 * aOff * (reef.K[p] + (reef.K[p1] - reef.K[p]) * jf);
        const Ts = Math.sqrt(Hb / G) * inp[IN_TSCALE];
        const phi = (sc - (reef.S[p] + (reef.S[p1] - reef.S[p]) * jf)) / (omega * Ts);
        if (phi < PHI0 || phi >= PHI_END) continue;
        let H: number;
        if (phi < 0) {
          const Hc = 2 * aOff * (reef.K[q] + (reef.K[q1] - reef.K[q]) * f);
          H = Hc < Hb ? Hc : Hb;
        } else {
          // The bore loses height toward the saturated surf index of the water under it.
          const hr = reef.hr[q] + (reef.hr[q1] - reef.hr[q]) * f;
          let Hbore = GAMMA_SURF * (hr > 0.3 ? hr : 0.3);
          if (Hbore < 0.25) Hbore = 0.25;
          const decay = phi < tImp1 ? 1 : Math.exp(-(phi - tImp1) / 7);
          H = Hbore + (Hb - Hbore) * decay;
        }
        const s = ((n % REEF_SLOTS) + REEF_SLOTS) % REEF_SLOTS;
        if (!claim(s, n, r)) continue;
        F[4] = phi;
        F[5] = H;
        F[6] = mc;
        F[7] = 1;
        record(s, r, 1);
      }
    }
  };

  /** Shore fan: the reformed waves dump on the beach face. */
  const shorePass = () => {
    const phase0 = F[11];
    // The wave's local (saturated) height where it enters the fan decides where it dumps
    // (evaluated on every other ray; it varies slowly along the shore).
    for (let r = 0; r < shore.nr; r++) {
      if ((r & 1) !== 0 && r !== shore.nr - 1) continue;
      const o = r * shore.nm;
      F[2] = shore.px[o];
      F[3] = shore.pz[o];
      trainXZ(0);
      ampS[r] = TE[2];
      if (r >= 2 && (r & 1) === 0) ampS[r - 1] = 0.5 * (ampS[r - 2] + ampS[r]);
    }
    const gShore = inp[IN_GSHORE];
    for (let r = 0; r < shore.nr; r++) {
      const o = r * shore.nm;
      const mEnd = shore.mEnd[r];
      if (mEnd < 4) continue;
      let Hs = 2 * ampS[r];
      if (Hs > 1.6) Hs = 1.6;
      if (Hs < 0.12) continue;
      F[0] = Hs / gShore;
      findH(o, mEnd);
      const mSb = F[1];
      if (mSb < 0) continue;
      const Ts = Math.sqrt(Hs / G) * inp[IN_TSCALE];
      const j0 = mSb | 0;
      const jf = mSb - j0;
      const p = o + j0;
      const sOn = shore.S[p] + (jf > 0 ? (shore.S[p + 1] - shore.S[p]) * jf : 0);
      // Crests on the ray, plus the one just seaward (still steepening).
      const nLo = Math.ceil((shore.S[o] - phase0) / TAU) - 1;
      const nHi = Math.floor((shore.S[o + mEnd] - phase0) / TAU) + 1;
      for (let n = nLo; n <= nHi; n++) {
        const sc = phase0 + TAU * n;
        const phi = (sc - sOn) / (omega * Ts);
        if (phi < PHI0 || phi >= PHI_END) continue;
        // Past the waterline the swash takes over: the bore fades over its last metres.
        if (sc < shore.S[o]) continue;
        F[0] = sc;
        findS(shore, o, mEnd);
        const mc = F[1];
        if (mc >= mEnd - 0.05) continue;
        const H = phi < tImpShore ? Hs : Math.max(0.15, Hs * Math.exp(-(phi - tImpShore) / 4));
        const s = REEF_SLOTS + (((n % SHORE_SLOTS) + SHORE_SLOTS) % SHORE_SLOTS);
        if (!claim(s, n, r)) continue;
        let x = (mc - (mEnd - 4)) / 3.7;
        x = x < 0 ? 0 : x > 1 ? 1 : x;
        F[4] = phi;
        F[5] = H;
        F[6] = mc;
        F[7] = 1 - x * x * (3 - 2 * x);
        record(s, r, 2);
      }
    }
  };

  /** Fade at stage jumps, smooth φ along the crest, and write slot s into the texture. */
  const writeSlot = (s: number) => {
    const phase0 = F[11];
    const R = s < REEF_SLOTS ? reef : shore;
    const active = slotN[s] === slotN[s];
    const r0 = active ? Math.max(0, slotR0[s] - 2) : 0;
    const r1 = active ? Math.min(R.nr - 1, slotR1[s] + 2) : -1;
    const b = s * DATA_W;
    if (active) {
      // Distance (rays) to the nearest stage jump (the end of the reef), both ways; fade by it.
      let dist = 1e9;
      for (let r = r0; r <= r1; r++) {
        const k = b + r;
        const isCut = r > r0 && wS[k] > 0 && wS[k - 1] > 0 && Math.abs(phiS[k] - phiS[k - 1]) > 2.2;
        dist = isCut ? 0 : dist + 1;
        cut[r] = dist;
      }
      dist = 1e9;
      for (let r = r1; r >= r0; r--) {
        const k = b + r;
        const isCut = r < r1 && wS[k] > 0 && wS[k + 1] > 0 && Math.abs(phiS[k] - phiS[k + 1]) > 2.2;
        dist = isCut ? 0 : dist + 1;
        if (dist < cut[r]) cut[r] = dist;
      }
      for (let r = r0; r <= r1; r++) {
        let x = (cut[r] - 0.5) / 6.5;
        x = x < 0 ? 0 : x > 1 ? 1 : x;
        wS[b + r] *= x * x * (3 - 2 * x);
      }
      for (let pass = 0; pass < 2; pass++) {
        for (let r = r0; r <= r1; r++) {
          const k = b + r;
          if (wS[k] <= 0) {
            tmp[r] = phiS[k];
            continue;
          }
          let sum = 2 * phiS[k];
          let wsum = 2;
          if (r > r0 && wS[k - 1] > 0) {
            sum += phiS[k - 1];
            wsum++;
          }
          if (r < r1 && wS[k + 1] > 0) {
            sum += phiS[k + 1];
            wsum++;
          }
          tmp[r] = sum / wsum;
        }
        for (let r = r0; r <= r1; r++) phiS[b + r] = tmp[r];
      }
    }
    const scN = phase0 + TAU * slotN[s];
    const timeScale = inp[IN_TSCALE];
    const plungeK = inp[IN_PLUNGE];
    for (let r = 0; r < DATA_W; r++) {
      const k = b + r;
      const o0 = ((s * ROWS) * DATA_W + r) * 4;
      const o1 = o0 + DATA_W * 4;
      const o2 = o1 + DATA_W * 4;
      const o3 = o2 + DATA_W * 4;
      const inside = active && r >= r0 && r <= r1;
      const w = inside ? wS[k] : 0;
      if (!inside) {
        data[o0] = data[o0 + 1] = data[o0 + 2] = data[o0 + 3] = 0;
        data[o1] = 1;
        data[o1 + 1] = 0;
        data[o1 + 2] = PHI0;
        data[o1 + 3] = 0;
        data[o2] = data[o2 + 1] = data[o2 + 2] = 1;
        data[o2 + 3] = 0;
        data[o3] = data[o3 + 1] = data[o3 + 2] = data[o3 + 3] = 0;
        continue;
      }
      // Inactive rays inside the section still carry this crest's true position (the ribbon
      // is continuous across them, collapsed onto the swell); where the crest isn't on the ray
      // at all, the nearest ray's position stands in (no stretched triangles).
      if (w <= 0) {
        hS[k] = 0.3;
        phiS[k] = PHI0;
        evS[k] = s < REEF_SLOTS ? 1 : 2;
      }
      let rr = r;
      let mc = mS[k];
      if (w <= 0) {
        F[0] = scN;
        crestOn(R, r);
        mc = F[1];
        for (let q = 1; mc < 0 && q < 40; q++) {
          if (r - q >= r0) {
            crestOn(R, r - q);
            if (F[1] >= 0) {
              mc = F[1];
              rr = r - q;
              break;
            }
          }
          if (r + q <= r1) {
            crestOn(R, r + q);
            if (F[1] >= 0) {
              mc = F[1];
              rr = r + q;
              break;
            }
          }
        }
        if (mc < 0) mc = 0;
      }
      const or = rr * R.nm;
      const i0 = mc | 0;
      const f = mc - i0;
      const q = or + i0;
      const q1 = f > 0 ? q + 1 : q;
      const cx = R.px[q] + (R.px[q1] - R.px[q]) * f;
      const cz = R.pz[q] + (R.pz[q1] - R.pz[q]) * f;
      const dx = R.dx[q] + (R.dx[q1] - R.dx[q]) * f;
      const dz = R.dz[q] + (R.dz[q1] - R.dz[q]) * f;
      const dl0 = Math.sqrt(dx * dx + dz * dz);
      const dl = dl0 > 1e-9 ? dl0 : 1;
      const kk = R.k[q] + (R.k[q1] - R.k[q]) * f;
      const H = hS[k];
      const phi = phiS[k];
      const Ts = Math.sqrt((H > 0.1 ? H : 0.1) / G) * timeScale;
      const kap = evS[k] === 2 ? 0.75 : Math.min(1, R.plunge[r] * plungeK);
      cxS[r] = cx;
      czS[r] = cz;
      data[o0] = cx;
      data[o0 + 1] = cz;
      data[o0 + 2] = w;
      data[o0 + 3] = H;
      data[o1] = dx / dl;
      data[o1 + 1] = dz / dl;
      data[o1 + 2] = phi;
      data[o1 + 3] = kap;
      data[o2] = Ts;
      data[o2 + 1] = R.h[q] + (R.h[q1] - R.h[q]) * f;
      data[o2 + 2] = omega / (kk > 1e-3 ? kk : 1e-3);
      data[o2 + 3] = evS[k];
      // Smoothed depth a little ahead of the crest: the trough can't drain the reef dry.
      let ma = mc + 1.2 * H;
      if (ma > R.mEnd[rr]) ma = R.mEnd[rr];
      const a0 = ma | 0;
      const af = ma - a0;
      const qa = or + a0;
      data[o3 + 2] = R.h[qa] + (af > 0 ? (R.h[qa + 1] - R.h[qa]) * af : 0);
      data[o3 + 3] = (phi > 0 ? phi : 0) * Ts;
    }
    // Trains 1 and 2 are folded into the breaker (it replaces the whole swell near its crest):
    // where they're in phase with this crest it stands taller, out of phase lower. Evaluated on
    // every 3rd column and interpolated (it varies over tens of metres).
    if (active) {
      let ra = -1;
      for (let r = r0; r <= r1; r++) {
        if (r % 3 !== 0 && r !== r0 && r !== r1) continue;
        F[2] = cxS[r];
        F[3] = czS[r];
        trainXZ(1);
        let e12 = TE[2] * Math.cos(TE[3]);
        trainXZ(2);
        e12 += TE[2] * Math.cos(TE[3]);
        e12S[r] = e12;
        if (ra >= 0) for (let qq = ra + 1; qq < r; qq++) e12S[qq] = e12S[ra] + ((e12S[r] - e12S[ra]) * (qq - ra)) / (r - ra);
        ra = r;
      }
      for (let r = r0; r <= r1; r++) {
        const o0 = ((s * ROWS) * DATA_W + r) * 4;
        if (data[o0 + 2] <= 0) continue;
        const H = data[o0 + 3];
        let Hn = H + 1.2 * e12S[r];
        if (Hn > 1.5 * H) Hn = 1.5 * H;
        if (Hn < 0.5 * H) Hn = 0.5 * H;
        data[o0 + 3] = Hn;
      }
    }
    // Along-crest derivatives of φ and H (per metre of label).
    for (let r = 0; r < DATA_W; r++) {
      const ra = r > 0 ? r - 1 : r;
      const rb = r < DATA_W - 1 ? r + 1 : r;
      const oa = (s * ROWS + 1) * DATA_W;
      const o0 = (s * ROWS + 0) * DATA_W;
      const o3 = ((s * ROWS + 3) * DATA_W + r) * 4;
      const span0 = (rb - ra) * R.dLabel;
      const span = span0 > 0 ? span0 : 1;
      data[o3] = (data[(oa + rb) * 4 + 2] - data[(oa + ra) * 4 + 2]) / span;
      data[o3 + 1] = (data[(o0 + rb) * 4 + 3] - data[(o0 + ra) * 4 + 3]) / span;
    }
    const g = (GLOBAL_ROW * DATA_W + s) * 4;
    data[g] = r0;
    data[g + 1] = r1;
    data[g + 2] = active ? slotN[s] : -9999;
    data[g + 3] = active ? 1 : 0;
    // The camera's column in this slot's fan (the ribbon samples densest there).
    const gc = (GLOBAL_ROW * DATA_W + G_CAM + s) * 4;
    data[gc] = ((s < REEF_SLOTS ? F[10] : inp[IN_CAMZ]) - R.label0) / R.dLabel;
    data[gc + 1] = s < REEF_SLOTS ? 0 : 1;
    data[gc + 2] = R.label0;
    data[gc + 3] = R.dLabel;
  };

  return {
    data,
    slotN,
    slotR0,
    slotR1,
    reef,
    shore,
    inp,
    raysOf: (s) => (s < REEF_SLOTS ? reef : shore),
    refresh,
    update(rt, env) {
      rtCur = rt;
      envCur = env;
      te.set(env, rt);
      const phase0 = rt.phase[0];
      wS.fill(0);
      for (let s = 0; s < SLOTS; s++) slotN[s] = NaN;
      F[11] = phase0;
      reefPass();
      shorePass();
      F[8] = inp[IN_CAMX];
      F[9] = inp[IN_CAMZ];
      labelAt(reef, F, 8);
      for (let s = 0; s < SLOTS; s++) writeSlot(s);
      const g = (GLOBAL_ROW * DATA_W + G_TIME) * 4;
      data[g] = rt.tMod;
      data[g + 1] = inp[IN_DT];
      data[g + 2] = phase0;
      data[g + 3] = 0;
    },
  };
}
