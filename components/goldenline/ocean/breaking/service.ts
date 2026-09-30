// OceanService with the breakers in it (zero-alloc): wraps A2's service so that
//
//   sample()   returns the ridable surface where a breaker is: the face / tube floor / trough of
//              the profile (never the lip overhead), its normal and water velocity, and
//              `breaking` = the whitewater coverage there
//   wave()     returns the live breaker: stage, peel direction and speed along the crest, crest
//              distance, face height, hollowness (1 = an open tube you can sit in)
//   gpu.breaking.breaker(x, z, out)  the full picture for surfing (B1): stage φ, plunge, the
//              crest frame, the tube's centre and radius, the lip tip — see README.md
//
// It evaluates the same tracker data and profile tables the GPU renders, so what B1 rides is
// what the player sees. Doubles travel through the `F` scratch array inside (V8 boxes a double
// passed to a call it doesn't inline; see tracker.ts).

import type { OceanSample, OceanService, WaveInfo } from '../../core/contracts';
import { type SwellField, type SwellRuntime } from '../swell';
import { createTrainEval } from './train';
import { J_FACE0, J_FRONT0, J_LIP, J_LIP0, NJ, NP, PHI0, lookupProfile, stageTimes, type ProfileTables } from './profile';
import { labelAt } from './rays';
import { DATA_W, GLOBAL_ROW, REEF_SLOTS, ROWS, type Tracker } from './tracker';

/** Everything B1 needs about the breaker at a point. All world metres / seconds. */
export interface BreakerPoint {
  /** 0 = no breaker here. Otherwise its activity weight (0-1). */
  active: number;
  /** Stage in T_s since the breaking onset (< 0 still steepening), plunge 0-1, face height (m). */
  phi: number;
  kappa: number;
  H: number;
  /** Seconds per unit of φ (sqrt(H/g)). */
  Ts: number;
  /** Crest rest point and unit wave direction (shoreward), phase speed (m/s). */
  cx: number;
  cz: number;
  dx: number;
  dz: number;
  c: number;
  /** This point in the crest frame: metres ahead of the crest (+ shoreward). */
  u: number;
  /** Crest height and trough height (m, world y, without the wind sea). */
  crestY: number;
  troughY: number;
  /** Peel: unit direction along the crest toward the unbroken shoulder, speed (m/s). */
  peelX: number;
  peelZ: number;
  peelSpeed: number;
  /** 0-1: how open the tube is here (1 = a clean barrel). */
  tube: number;
  /** Tube interior centre (world) and radius (m), valid when tube > 0. */
  tubeX: number;
  tubeY: number;
  tubeZ: number;
  tubeR: number;
  /** Lip tip position (world). */
  lipX: number;
  lipY: number;
  lipZ: number;
}

export const newBreakerPoint = (): BreakerPoint => ({
  active: 0.5, phi: 0.5, kappa: 0.5, H: 0.5, Ts: 0.5, cx: 0.5, cz: 0.5, dx: 0.5, dz: 0.5, c: 0.5, u: 0.5, crestY: 0.5, troughY: 0.5,
  peelX: 0.5, peelZ: 0.5, peelSpeed: 0.5, tube: 0.5, tubeX: 0.5, tubeY: 0.5, tubeZ: 0.5, tubeR: 0.5, lipX: 0.5, lipY: 0.5, lipZ: 0.5,
});

export interface BreakingApi {
  breaker(x: number, z: number, out: BreakerPoint): BreakerPoint;
}

const TAU = Math.PI * 2;

export function wrapOceanService(
  base: OceanService,
  tracker: Tracker,
  prof: ProfileTables,
  field: SwellField,
  env: Float32Array,
  rt: SwellRuntime,
): { service: OceanService; api: BreakingApi } {
  const d = tracker.data;
  const te = createTrainEval(field);
  const TE = te.io;
  te.set(env, rt);
  const A = new Float64Array(4);
  const Bv = new Float64Array(4);
  const A2 = new Float64Array(4);
  const PK = new Float64Array(2);
  const bp = newBreakerPoint();
  // Scratch: [x, z, label (labelAt writes F[2]), col, u, row value, result].
  const F = new Float64Array(8);
  const tPl = new Float64Array(NP * 4);
  for (let p = 0; p < NP; p++) {
    const T = stageTimes(p / (NP - 1));
    tPl[p * 4] = T.launch;
    tPl[p * 4 + 1] = T.imp;
    tPl[p * 4 + 2] = T.collapse0;
    tPl[p * 4 + 3] = T.collapse1;
  }
  // Stage times at the current κ (bp.kappa): [launch, impact, collapse start, collapse end].
  const ST = new Float64Array(4);
  const stageTimesAtKappa = () => {
    const kap = bp.kappa;
    const f = (kap < 0 ? 0 : kap > 1 ? 1 : kap) * (NP - 1);
    const p0 = Math.min(NP - 2, Math.floor(f));
    const w = f - p0;
    for (let i = 0; i < 4; i++) ST[i] = tPl[p0 * 4 + i] + (tPl[(p0 + 1) * 4 + i] - tPl[p0 * 4 + i]) * w;
  };
  /** F[5] = channel c of row rw of slot s at fractional column F[3]. */
  const row = (s: number, rw: number, c: number) => {
    const col = F[3];
    let c0 = Math.floor(col);
    if (c0 < 0) c0 = 0;
    if (c0 > DATA_W - 2) c0 = DATA_W - 2;
    let f = col - c0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const o = ((s * ROWS + rw) * DATA_W + c0) * 4 + c;
    F[5] = d[o] * (1 - f) + d[o + 4] * f;
  };

  // The profile at the current (φ, κ), evaluated once per query into scratch.
  const PU = new Float64Array(NJ);
  const PY = new Float64Array(NJ);
  const PF = new Float64Array(NJ);
  const loadProfile = () => {
    PK[0] = bp.phi;
    PK[1] = bp.kappa;
    for (let j = 0; j < NJ; j++) {
      lookupProfile(prof, j, PK, A, Bv);
      PU[j] = A[0];
      PY[j] = A[1];
      PF[j] = Bv[0];
    }
  };
  /** F[6] = ridable surface height (H units) at crest-frame u = F[4]: face / tube floor / trough / back. */
  const surfaceY = (withLip: boolean) => {
    const u = F[4];
    let best = 0;
    let found = false;
    for (let j = 1; j < NJ; j++) {
      // The lip set is overhead while the tube is open; once it collapses onto the roller it's
      // the surface.
      if (!withLip && j === J_LIP0) j = J_FACE0;
      const pu = PU[j - 1];
      const cu = PU[j];
      if ((pu <= u && u <= cu) || (cu <= u && u <= pu)) {
        const f = Math.abs(cu - pu) > 1e-6 ? (u - pu) / (cu - pu) : 0;
        const y = PY[j - 1] + (PY[j] - PY[j - 1]) * f;
        // Inside the tube the face and the trough can both cross: the lower one is the floor.
        if (!found || y < best) best = y;
        found = true;
      }
    }
    F[6] = found ? best : PY[J_LIP0];
  };
  /** F[6] = whitewater coverage of the profile point nearest u = F[4]. */
  const foamAtU = () => {
    const u = F[4];
    let bestD = 1e9;
    let f = 0;
    for (let j = 0; j < NJ; j++) {
      const dd = Math.abs(PU[j] - u);
      if (dd < bestD) {
        bestD = dd;
        f = PF[j];
      }
    }
    F[6] = f;
  };

  /** Fill bp for the breaker covering (F[0], F[1]), if any. Returns true when there is one. */
  const find = () => {
    bp.active = 0;
    const x = F[0];
    const z = F[1];
    TE[0] = x;
    TE[1] = z;
    te.eval(0);
    const n = Math.round(TE[3] / TAU);
    let best = -1;
    let bestCol = 0;
    let bestW = 0;
    // The ray fan's column here (baked label field).
    labelAt(tracker.reef, F, 0);
    const colReef = (F[2] - tracker.reef.label0) / tracker.reef.dLabel;
    {
      const s = ((n % REEF_SLOTS) + REEF_SLOTS) % REEF_SLOTS;
      const g = (GLOBAL_ROW * DATA_W + s) * 4;
      const col = colReef;
      if (d[g + 3] >= 0.5 && Math.abs(d[g + 2] - n) <= 0.5 && col >= d[g] && col <= d[g + 1]) {
        F[3] = col;
        row(s, 0, 2);
        if (F[5] > bestW) {
          bestW = F[5];
          best = s;
          bestCol = col;
        }
      }
    }
    if (best < 0 || bestW < 0.02) return false;
    const s = best;
    F[3] = bestCol;
    bp.active = bestW;
    row(s, 0, 0);
    bp.cx = F[5];
    row(s, 0, 1);
    bp.cz = F[5];
    row(s, 0, 3);
    bp.H = F[5] > 0.05 ? F[5] : 0.05;
    row(s, 1, 0);
    let dx = F[5];
    row(s, 1, 1);
    let dz = F[5];
    const dl0 = Math.sqrt(dx * dx + dz * dz);
    const dl = dl0 > 1e-9 ? dl0 : 1;
    dx /= dl;
    dz /= dl;
    bp.dx = dx;
    bp.dz = dz;
    row(s, 1, 2);
    bp.phi = F[5];
    row(s, 1, 3);
    bp.kappa = F[5];
    row(s, 2, 0);
    bp.Ts = F[5];
    row(s, 2, 2);
    bp.c = F[5];
    bp.u = (x - bp.cx) * dx + (z - bp.cz) * dz;
    // Peel: along the crest toward decreasing φ (the shoulder), at the rate the onset sweeps it.
    const R = tracker.raysOf(s);
    row(s, 3, 0);
    const dPhi = F[5]; // per metre of label
    let c0 = Math.floor(bestCol);
    if (c0 < 0) c0 = 0;
    if (c0 > DATA_W - 2) c0 = DATA_W - 2;
    const oa = ((s * ROWS) * DATA_W + c0) * 4;
    const ssx = d[oa + 4] - d[oa];
    const ssz = d[oa + 5] - d[oa + 1];
    const sp = Math.sqrt(ssx * ssx + ssz * ssz);
    const spacing = (sp > 0.2 ? sp : 0.2) / R.dLabel; // metres of crest per metre of label
    const sign = dPhi > 0 ? -1 : 1;
    bp.peelX = -dz * sign;
    bp.peelZ = dx * sign;
    const dPhiDs = Math.abs(dPhi) / spacing;
    const ps = dPhiDs > 1e-4 ? 1 / (bp.Ts * dPhiDs) : 0;
    bp.peelSpeed = ps < 40 ? ps : 40;
    // Profile landmarks: crest, trough, lip tip, tube.
    const H = bp.H;
    PK[0] = bp.phi;
    PK[1] = bp.kappa;
    lookupProfile(prof, J_LIP0 + 6, PK, A, null);
    bp.crestY = A[1] * H;
    lookupProfile(prof, J_FRONT0 + 4, PK, A, null);
    bp.troughY = A[1] * H;
    lookupProfile(prof, J_LIP0 + (J_LIP >> 1), PK, A, null);
    bp.lipX = bp.cx + dx * A[0] * H;
    bp.lipY = A[1] * H;
    bp.lipZ = bp.cz + dz * A[0] * H;
    stageTimesAtKappa();
    let a = (bp.phi - ST[0]) / 0.6;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    let b = (bp.phi - ST[2]) / (ST[3] - ST[2]);
    b = b < 0 ? 0 : b > 1 ? 1 : b;
    bp.tube = bp.kappa * a * a * (3 - 2 * a) * (1 - b * b * (3 - 2 * b)) * bestW;
    // Tube centre: between the face (a quarter up) and the lip's underside.
    lookupProfile(prof, J_FACE0 + 5, PK, A2, null);
    const tu = 0.5 * (A[0] + A2[0]) * 0.8;
    const ty = 0.5 * (bp.crestY / H + bp.troughY / H);
    bp.tubeX = bp.cx + dx * tu * H;
    bp.tubeY = ty * H;
    bp.tubeZ = bp.cz + dz * tu * H;
    bp.tubeR = 0.3 * H;
    return true;
  };

  /** Blend the breaker's surface into `out` (already A2's sample at (F[0], F[1])). */
  const blend = (out: OceanSample) => {
    if (!find()) return;
    const H = bp.H;
    const un = bp.u / H;
    if (un < -5 || un > 6.5) return;
    // Weight across the profile (same blend the ribbon uses) × the along-crest activity.
    let a = (un + 5) / 2.8;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    let b = (un - 3.2) / 3.3;
    b = b < 0 ? 0 : b > 1 ? 1 : b;
    const wa = a * a * (3 - 2 * a);
    const wb = 1 - b * b * (3 - 2 * b);
    const w = bp.active * (wa < wb ? wa : wb);
    if (w <= 0) return;
    loadProfile();
    stageTimesAtKappa();
    const withLip = bp.phi > ST[2];
    F[4] = un;
    surfaceY(withLip);
    const yP = F[6] * H;
    // The whole swell here (what the breaker replaces; trains 1-2 are folded into its H).
    TE[0] = F[0];
    TE[1] = F[1];
    te.eval(0);
    let swellY = TE[6];
    te.eval(1);
    swellY += TE[6];
    te.eval(2);
    swellY += TE[6];
    const y = out.height + w * (yP - swellY);
    // Slope of the breaker surface along the wave direction (finite difference in the profile).
    const e = 0.08;
    F[4] = un - e;
    surfaceY(withLip);
    const yA = F[6] * H;
    F[4] = un + e;
    surfaceY(withLip);
    const yB = F[6] * H;
    const slope = ((yB - yA) / (2 * e * H)) * w;
    let nx = out.nx * (1 - w) - bp.dx * slope * w;
    let ny = out.ny * (1 - w) + w;
    let nz = out.nz * (1 - w) - bp.dz * slope * w;
    const nl0 = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const nl = nl0 > 1e-9 ? nl0 : 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    out.depth += y - out.height;
    out.height = y;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    // Water in a breaking face moves shoreward at a fraction of the phase speed that grows with
    // its height (shallow-water orbit: u ≈ c·η/h), and up the face.
    const hh = out.depth > 0.5 ? out.depth : 0.5;
    let r = yP / hh;
    r = r < -0.2 ? -0.2 : r > 1.1 ? 1.1 : r;
    const uf = r * bp.c;
    out.vx = out.vx * (1 - w) + bp.dx * uf * w;
    out.vz = out.vz * (1 - w) + bp.dz * uf * w;
    out.vy = out.vy * (1 - w) - slope * uf * w;
    F[4] = un;
    foamAtU();
    const fb = w * (F[6] * 1.2 < 1 ? F[6] * 1.2 : 1);
    if (fb > out.breaking) out.breaking = fb;
  };

  const sample = (x: number, z: number, out: OceanSample) => {
    base.sample(x, z, out);
    F[0] = x;
    F[1] = z;
    blend(out);
    return out;
  };
  const gpu = base.gpu as Record<string, unknown> & { sampleCoarse?: (x: number, z: number, out: OceanSample) => OceanSample };
  const coarse = gpu.sampleCoarse;
  if (coarse)
    gpu.sampleCoarse = (x: number, z: number, out: OceanSample) => {
      coarse(x, z, out);
      F[0] = x;
      F[1] = z;
      blend(out);
      return out;
    };

  const wave = (x: number, z: number, out: WaveInfo) => {
    base.wave(x, z, out);
    F[0] = x;
    F[1] = z;
    if (!find() || bp.active <= 0.05) return out;
    stageTimesAtKappa();
    let a = (bp.phi + 1.5) / 1.5;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    const tubeish = bp.kappa * a * a * (3 - 2 * a) * 0.35;
    const W = bp.active;
    out.dirX = bp.dx;
    out.dirZ = bp.dz;
    out.crestDistance = -bp.u;
    const fade = 1 - (bp.phi - ST[1]) * 0.08;
    out.faceHeight = bp.H * (bp.phi < ST[1] ? 1 : fade > 0.3 ? fade : 0.3);
    let pre = (bp.phi - PHI0) / -PHI0;
    pre = pre < 0 ? 0 : pre > 1 ? 1 : pre;
    const st = W * (bp.phi < 0 ? pre * pre * (3 - 2 * pre) * 0.9 : 1);
    if (st > out.stage) out.stage = st;
    out.peelX = bp.peelX;
    out.peelZ = bp.peelZ;
    out.peelSpeed = bp.peelSpeed;
    const hol = bp.tube > tubeish * W ? bp.tube : tubeish * W;
    out.hollowness = hol < 1 ? hol : 1;
    return out;
  };

  const service: OceanService = { sample, wave, swellDir: base.swellDir, gpu: base.gpu };
  const api: BreakingApi = {
    breaker(x, z, out) {
      F[0] = x;
      F[1] = z;
      find();
      out.active = bp.active;
      out.phi = bp.phi;
      out.kappa = bp.kappa;
      out.H = bp.H;
      out.Ts = bp.Ts;
      out.cx = bp.cx;
      out.cz = bp.cz;
      out.dx = bp.dx;
      out.dz = bp.dz;
      out.c = bp.c;
      out.u = bp.u;
      out.crestY = bp.crestY;
      out.troughY = bp.troughY;
      out.peelX = bp.peelX;
      out.peelZ = bp.peelZ;
      out.peelSpeed = bp.peelSpeed;
      out.tube = bp.tube;
      out.tubeX = bp.tubeX;
      out.tubeY = bp.tubeY;
      out.tubeZ = bp.tubeZ;
      out.tubeR = bp.tubeR;
      out.lipX = bp.lipX;
      out.lipY = bp.lipY;
      out.lipZ = bp.lipZ;
      return out;
    },
  };
  return { service, api };
}
