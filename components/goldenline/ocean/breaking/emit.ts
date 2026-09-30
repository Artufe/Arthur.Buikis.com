// Whitewater effects driven by the breaker stages (CPU, zero-alloc): what each bit of crest throws
// into the air and leaves on the water.
//
//   veil     offshore spray peeling off steep crests and thrown lips, streaming back seaward
//   drip     droplets falling off the thrown lip across the tube's mouth
//   impact   the lip landing: an explosion of aerated clumps, droplets and mist
//   smoke    the rolling bore: clumps and mist boiling off the roller's front
//   foam     state splats (SPLAT_FOAM) under the roller and behind it: the foam sheet the bore
//            leaves, which the state then drifts, ages into lace and dissolves
//
// Rates are per metre of crest per second, scaled by the local face height, integrated per ray
// column in accumulators and emitted in batches (the spray queue holds 256 emitters a frame).
// Everything goes through the spray's and the state's bulk paths, and the smoothsteps are
// written out inline (no double crosses a call boundary; see tracker.ts).

import { SPLAT_FOAM, type SurfaceStateService } from '../../core/contracts';
import { SPRAY_DROPLET, SPRAY_FOAM, SPRAY_MIST, SPRAY_VEIL, type SprayService } from '../../vfx/spray';
import { J_FACE0, J_LIP, J_LIP0, NP, lookupProfile, stageTimes, type ProfileTables } from './profile';
import { RAYS, RAY_NR } from './rays';
import { DATA_W, GLOBAL_ROW, ROWS, SLOTS, type Tracker } from './tracker';

const G = 9.81;
/** Columns per emitter (every 2nd ray: ~3 m of crest). */
const STRIDE = 2;

export interface WhitewaterFx {
  /** Rates (×): [impact spray, veils, smoke, foam]; written by the owner, read every frame. */
  rates: Float64Array;
  update(clock: { dt: number }, state: SurfaceStateService): void;
}

export function createWhitewaterFx(tracker: Tracker, prof: ProfileTables, spray: SprayService): WhitewaterFx {
  // Pending particle counts per slot × column × kind (veil, clump, droplet, mist).
  const acc = new Float32Array(SLOTS * RAY_NR * 4);
  // Foam splat accumulator (seconds of foam) per slot × column.
  const facc = new Float32Array(SLOTS * RAY_NR);
  const A = new Float64Array(4);
  const Bv = new Float64Array(4);
  const PK = new Float64Array(2);
  const rates = new Float64Array([1, 1, 1, 1]);
  // Stage times per plunge level.
  const tImp = new Float64Array(NP);
  const tCol = new Float64Array(NP);
  const tLaunch = new Float64Array(NP);
  for (let p = 0; p < NP; p++) {
    const T = stageTimes(p / (NP - 1));
    tImp[p] = T.imp;
    tCol[p] = T.collapse1;
    tLaunch[p] = T.launch;
  }
  const rng = new Uint32Array([0x9e3779b9]);
  const d = tracker.data;
  const J_TOP = J_LIP0 + 6;
  const J_TIP = J_LIP0 + (J_LIP >> 1);
  const J_ROLL = J_FACE0 - 10;
  const sd = spray.emitData;

  return {
    rates,
    update(clock, state) {
      const dt = clock.dt;
      if (!(dt > 0)) return;
      const pSpray = rates[0];
      const pVeil = rates[1];
      const pSmoke = rates[2];
      const pFoam = rates[3];
      const len = RAYS.dz * STRIDE;
      for (let s = 0; s < SLOTS; s++) {
        const g = (GLOBAL_ROW * DATA_W + s) * 4;
        if (d[g + 3] < 0.5) continue;
        const r0 = d[g] | 0;
        const r1 = d[g + 1] | 0;
        for (let r = r0 - (r0 % STRIDE); r <= r1; r += STRIDE) {
          if (r < r0) continue;
          const o0 = ((s * ROWS) * DATA_W + r) * 4;
          const W = d[o0 + 2];
          const k = (s * RAY_NR + r) * 4;
          if (W < 0.35) {
            acc[k] = acc[k + 1] = acc[k + 2] = acc[k + 3] = 0;
            facc[s * RAY_NR + r] = 0;
            continue;
          }
          const o1 = o0 + DATA_W * 4;
          const o2 = o1 + DATA_W * 4;
          const H = d[o0 + 3];
          if (H < 0.4) continue;
          const cx = d[o0];
          const cz = d[o0 + 1];
          const dx = d[o1];
          const dz = d[o1 + 1];
          const phi = d[o1 + 2];
          const kap = d[o1 + 3];
          const cph = d[o2 + 2];
          PK[0] = phi;
          PK[1] = kap;
          // Stage times at this κ (linear over the plunge levels).
          const kf = (kap < 0 ? 0 : kap > 1 ? 1 : kap) * (NP - 1);
          const p0 = kf >= NP - 1 ? NP - 2 : kf | 0;
          const pf = kf - p0;
          const imp = tImp[p0] + (tImp[p0 + 1] - tImp[p0]) * pf;
          const col = tCol[p0] + (tCol[p0 + 1] - tCol[p0]) * pf;
          const launch = tLaunch[p0] + (tLaunch[p0 + 1] - tLaunch[p0]) * pf;
          // Emitters wander along their stretch of crest (no row of evenly spaced puffs).
          rng[0] = Math.imul(rng[0] ^ (rng[0] >>> 15), 0x2c1b3c6d) + 0x6d2b79f5;
          const jit = ((rng[0] >>> 8) / 16777216 - 0.5) * len;
          rng[0] = Math.imul(rng[0] ^ (rng[0] >>> 15), 0x2c1b3c6d) + 0x6d2b79f5;
          const rv = (rng[0] >>> 8) / 16777216;
          const jx = -dz * jit;
          const jz = dx * jit;
          // Spilling breakers make much less of an explosion than a plunging reef barrel.
          const violence = 0.3 + 0.7 * kap;
          const hs = H / 3;
          const sq = Math.sqrt(G * H);
          const troughY = -0.34 * H;
          let t: number;

          // Veil: off the steepening crest and the thrown lip (big waves only).
          t = (H - 1.2) / 1.4;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const bigW = t * t * (3 - 2 * t);
          t = (phi + 2.5) / 1.7;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const veilOn = t * t * (3 - 2 * t);
          t = (phi - (imp - 0.4)) / 0.7;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const veilOff = 1 - t * t * (3 - 2 * t);
          acc[k] += 7 * pVeil * W * bigW * veilOn * veilOff * len * dt;
          if (acc[k] >= 3) {
            const o = spray.reserve(SPRAY_VEIL, acc[k] | 0);
            if (o >= 0) {
              lookupProfile(prof, J_TOP, PK, A, null);
              sd[o] = cx + dx * A[0] * H + jx;
              sd[o + 1] = A[1] * H + 0.05;
              sd[o + 2] = cz + dz * A[0] * H + jz;
              sd[o + 4] = dx * cph * 0.75;
              sd[o + 5] = 1.1 + 0.45 * H;
              sd[o + 6] = dz * cph * 0.75;
              sd[o + 8] = 0.9;
              sd[o + 9] = 0.35 * len;
              sd[o + 11] = 0.3 + 0.18 * hs;
              sd[o + 13] = troughY;
            }
            acc[k] = 0;
          }

          // Drips off the thrown lip: a curtain of droplets falls across the open tube's mouth.
          t = (phi - (launch + 0.3)) / 0.5;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          let drip = t * t * (3 - 2 * t);
          t = (phi - (imp - 0.2)) / 0.4;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          drip *= (1 - t * t * (3 - 2 * t)) * W * kap * pSpray;
          if (drip > 0.02) {
            acc[k + 2] += 45 * drip * hs * len * dt;
            if (acc[k + 2] >= 8) {
              const o = spray.reserve(SPRAY_DROPLET, acc[k + 2] | 0);
              if (o >= 0) {
                lookupProfile(prof, J_TIP, PK, A, null);
                sd[o] = cx + dx * A[0] * H + jx;
                sd[o + 1] = A[1] * H;
                sd[o + 2] = cz + dz * A[0] * H + jz;
                sd[o + 4] = dx * cph * 0.9;
                sd[o + 5] = -0.5;
                sd[o + 6] = dz * cph * 0.9;
                sd[o + 8] = 0.7;
                sd[o + 9] = 0.3 * len;
                sd[o + 11] = 0.006;
                sd[o + 12] = 0.9;
                sd[o + 13] = troughY;
              }
              acc[k + 2] = 0;
            }
          }

          // Impact: the lip lands (plunging) or the crest spills over (κ low) — explosion.
          t = (phi - (imp - 0.25)) / 0.25;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          let hit = t * t * (3 - 2 * t);
          t = (phi - (imp + 0.35)) / 0.75;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          hit *= 1 - t * t * (3 - 2 * t);
          t = (kap + 0.05) / 0.45;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          hit *= W * t * t * (3 - 2 * t);
          if (hit > 0.01) {
            const hv = (hit * violence * pSpray * hs * len * dt) / 0.35;
            acc[k + 1] += 40 * hv;
            acc[k + 2] += 120 * hv;
            acc[k + 3] += 5 * hv;
          }
          // Smoke: the rolling bore boils off clumps and mist, decaying with the bore.
          t = (phi - (imp + 0.3)) / 0.9;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const roll = W * t * t * (3 - 2 * t) * Math.exp(-(phi > col ? phi - col : 0) / 9) * pSmoke * violence;
          if (roll > 0.01) {
            acc[k + 1] += 7 * roll * hs * len * dt;
            acc[k + 3] += 2 * roll * hs * len * dt;
          }
          if (acc[k + 1] >= 4 || acc[k + 2] >= 14 || acc[k + 3] >= 1.5) {
            lookupProfile(prof, hit > roll ? J_TIP : J_ROLL, PK, A, null);
            const x = cx + dx * A[0] * H + jx;
            const z = cz + dz * A[0] * H + jz;
            const y0 = A[1] * H;
            const y = y0 > troughY + 0.2 ? y0 : troughY + 0.2;
            const up = hit > roll ? 1.1 * sq * (0.7 + 0.3 * rv) : 1.4 + 0.25 * sq;
            const fwd = cph * (hit > roll ? 0.95 : 0.9);
            if (acc[k + 1] >= 1) {
              const o = spray.reserve(SPRAY_FOAM, acc[k + 1] | 0);
              if (o >= 0) {
                sd[o] = x;
                sd[o + 1] = y;
                sd[o + 2] = z;
                sd[o + 4] = dx * fwd;
                sd[o + 5] = up * 0.75;
                sd[o + 6] = dz * fwd;
                sd[o + 8] = 0.35 * sq;
                sd[o + 9] = 0.45 * len;
                sd[o + 11] = 0.15 * Math.sqrt(hs) + 0.05;
                sd[o + 13] = troughY;
              }
            }
            if (acc[k + 2] >= 1) {
              const o = spray.reserve(SPRAY_DROPLET, acc[k + 2] | 0);
              if (o >= 0) {
                sd[o] = x;
                sd[o + 1] = y;
                sd[o + 2] = z;
                sd[o + 4] = dx * fwd;
                sd[o + 5] = up;
                sd[o + 6] = dz * fwd;
                sd[o + 8] = 0.55 * sq;
                sd[o + 9] = 0.4 * len;
                sd[o + 13] = troughY;
              }
            }
            if (acc[k + 3] >= 1) {
              const o = spray.reserve(SPRAY_MIST, acc[k + 3] | 0);
              if (o >= 0) {
                sd[o] = x;
                sd[o + 1] = y + 0.3 * H;
                sd[o + 2] = z;
                sd[o + 4] = dx * fwd * 0.8;
                sd[o + 5] = 0.6;
                sd[o + 6] = dz * fwd * 0.8;
                sd[o + 8] = 0.8;
                sd[o + 9] = 0.5 * len;
                sd[o + 11] = 0.6 + 0.5 * hs;
                sd[o + 13] = troughY;
              }
            }
            acc[k + 1] = acc[k + 2] = acc[k + 3] = 0;
          }

          // Foam into the surface state: under the roller front and a thinner sheet behind it.
          const fk = s * RAY_NR + r;
          t = (phi - (launch + 0.6)) / (imp - launch - 0.2);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const foamRate = W * pFoam * t * t * (3 - 2 * t) * (0.08 + 0.92 * Math.exp(-(phi > col ? phi - col : 0) / 5));
          facc[fk] += foamRate * dt;
          if (facc[fk] > 1 / 15) {
            const o = state.reserve ? state.reserve(2) : -1;
            const st = state.splatData;
            if (o >= 0 && st) {
              lookupProfile(prof, J_ROLL, PK, A, Bv);
              const uF = Bv[1] * H;
              // ~0.02 per splat: the overlapping splats of a passing bore build a dense sheet only right
              // behind its front; the lagoon keeps lace (state coverage 0.1-0.5), not a white raft.
              const str = 1 - Math.exp(-0.32 * facc[fk]);
              st[o] = SPLAT_FOAM;
              st[o + 1] = cx + dx * uF;
              st[o + 2] = cz + dz * uF;
              st[o + 3] = 1.6 + 0.4 * H;
              st[o + 4] = str;
              st[o + 5] = dx;
              st[o + 6] = dz;
              st[o + 7] = 1;
              st[o + 8] = SPLAT_FOAM;
              st[o + 9] = cx - dx * 0.6 * H;
              st[o + 10] = cz - dz * 0.6 * H;
              st[o + 11] = 1.5 + 0.5 * H;
              st[o + 12] = str * 0.3;
              st[o + 13] = dx;
              st[o + 14] = dz;
              st[o + 15] = 1;
            }
            facc[fk] = 0;
          }
        }
      }
    },
  };
}
