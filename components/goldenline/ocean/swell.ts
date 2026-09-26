// The groundswell: a few long-period wave trains that feel the seabed. At boot each train's
// phase, amplitude and direction are baked over the break into a field texture:
//
//   phase      eikonal |∇T| = 1/c(h) solved by fast sweeping, S = ωT. Refraction (crests bending
//              to follow the depth contours) and wavelength compression both fall out of this.
//   amplitude  energy flux A²·Cg·b conserved along the rays (shoaling × refraction), marched
//              shoreward column by column; b is the ray-tube width, grown by ∇·k̂.
//   sets       group arrival time τ = ∫ds/Cg along the same rays, so a set's envelope travels at
//              the group speed and slows over the reef like a real one.
//   breaking   Q = max upstream K/h: a wave of offshore amplitude a has broken once 2aQ > γ_b.
//
// CPU and GPU evaluate exactly the same thing from the same arrays (swell-gpu.ts mirrors
// evalTrain()), so OceanService.sample() is exact for the swell.

import { PEAK, SWELL } from '../world/layout';

export const G = 9.81;
export const N_TRAINS = 3;
/** Every angular frequency is a multiple of 2π/T_REP, so simulation time can wrap at T_REP. */
export const T_REP = 4096;
export const OMEGA_QUANTUM = (2 * Math.PI) / T_REP;
/** Breaking index (H/h at breaking) and the saturated surf-zone index for broken waves. */
export const GAMMA_BREAK = 0.78;
export const GAMMA_SURF = 0.46;
/** Second-harmonic amplitude (fraction of A) at full shoaling. */
export const HARMONIC2 = 0.32;
/** Distance (m) over which breaking saturation develops along a ray. */
export const BREAK_RELAX = 18;
/** k·B reached as a wave nears breaking, and the fold limit on k·B·(1 + skew). */
export const ORBIT_SHOAL = 0.4;
export const FOLD_LIMIT = 0.7;

export interface TrainDef {
  period: number;
  /** Offset from SWELL's direction (degrees, + toward +Z). */
  dirOffsetDeg: number;
  /** Amplitude (m) at the offshore edge of the field, before the set envelope. */
  amp: number;
  /** Whether the train is grouped into sets (else a constant background train). */
  sets: boolean;
  /** Envelope value between sets (fraction of amp). */
  lull: number;
  /** Seconds the train's set schedule is shifted by, so trains don't set in lockstep. */
  scheduleShift: number;
}

export const TRAIN_DEFS: TrainDef[] = [
  { period: SWELL.periodS, dirOffsetDeg: 0, amp: 0.66, sets: true, lull: 0.18, scheduleShift: 0 },
  { period: SWELL.periodS * 1.14, dirOffsetDeg: -6, amp: 0.22, sets: true, lull: 0.35, scheduleShift: 611 },
  { period: SWELL.periodS * 0.72, dirOffsetDeg: 12, amp: 0.09, sets: false, lull: 1, scheduleShift: 0 },
];

/** The baked field grid (texel centres at x0 + (i + 0.5) * texel). */
export const FIELD = { x0: -600, z0: -440, texel: 2, nx: 320, nz: 440 };
const NX = FIELD.nx;
const NZ = FIELD.nz;
const NC = NX * NZ;

export const quantizeOmega = (w: number) => Math.max(1, Math.round(w / OMEGA_QUANTUM)) * OMEGA_QUANTUM;

/**
 * Time is carried as an integer tick count over one T_REP cycle, so every phase ω·t is exact:
 * with ω = q·(2π/T_REP), the phase in cycles is (q·n mod TICKS)/TICKS — on the GPU that is plain
 * wrap-around u32 arithmetic (TICKS divides 2³²). f32 ω·t would jitter the fast modes.
 */
export const TICKS = 2 ** 24;
export const timeTicks = (t: number) => {
  const m = t - Math.floor(t / T_REP) * T_REP;
  return Math.min(TICKS - 1, Math.floor((m / T_REP) * TICKS));
};
/** Phase (rad, in [0, 2π)) of frequency multiple q at tick n. Exact in f64 (q·n < 2^40). */
export const phaseOf = (q: number, n: number) => {
  const p = q * n;
  return ((p - Math.floor(p / TICKS) * TICKS) / TICKS) * 2 * Math.PI;
};

/** Solve ω² = g k tanh(k h) for k (Newton from the Fenton–McKee approximation). */
export function waveNumber(omega: number, h: number) {
  const k0 = (omega * omega) / G;
  if (k0 * h > 10) return k0;
  let k = k0 / Math.pow(Math.tanh(Math.pow(k0 * h, 0.75)), 2 / 3);
  for (let i = 0; i < 3; i++) {
    const t = Math.tanh(k * h);
    const f = G * k * t - omega * omega;
    const df = G * t + G * k * h * (1 - t * t);
    k -= f / df;
  }
  return k;
}

export function groupSpeed(omega: number, k: number, h: number) {
  const kh2 = 2 * k * h;
  const n = kh2 > 20 ? 0.5 : 0.5 * (1 + kh2 / Math.sinh(kh2));
  return (omega / k) * n;
}

/**
 * Per-train baked data. Layer 2i: (S, K, kx, kz). Layer 2i+1: (τ, Q, hCap, h).
 * S: phase (rad); K: amplitude factor vs offshore; k: local wavenumber vector (rad/m);
 * τ: group arrival time relative to the peak (s); Q: max upstream K/h (1/m);
 * hCap: depth that caps the amplitude (min met upstream + margin, m); h: still-water depth
 * smoothed over the waves' footprint (m) — the swell is shaped from this, never the raw seabed.
 */
export class SwellField {
  readonly data = new Float32Array(2 * N_TRAINS * NC * 4);
  readonly omega = new Float64Array(N_TRAINS);
  readonly dirX = new Float64Array(N_TRAINS);
  readonly dirZ = new Float64Array(N_TRAINS);
  /** Deep (field edge) group speed, used to extrapolate τ outside the field. */
  readonly cgEdge = new Float64Array(N_TRAINS);
  /** Wavenumber at the offshore edge (for aliasing fades). */
  readonly kEdge = new Float64Array(N_TRAINS);

  bake(heightAt: (x: number, z: number) => number, periodScale = 1, dirOffsetDeg = 0) {
    const depth = new Float32Array(NC); // actual still-water depth (≥ 0)
    const hb = new Float32Array(NC); // smoothed depth for dispersion
    for (let j = 0; j < NZ; j++) {
      const z = FIELD.z0 + (j + 0.5) * FIELD.texel;
      for (let i = 0; i < NX; i++) {
        const x = FIELD.x0 + (i + 0.5) * FIELD.texel;
        const d = -heightAt(x, z);
        depth[j * NX + i] = d > 0 ? d : 0;
        hb[j * NX + i] = d > 0.1 ? d : 0.1;
      }
    }
    // Waves feel the bottom averaged over a fraction of their wavelength (σ ≈ 7 m). This also
    // keeps the reef front's 10 m drop from folding the Gerstner surface.
    blur(hb, 5);
    blur(hb, 5);
    blur(hb, 5);

    const k = new Float32Array(NC);
    const T = new Float64Array(NC);
    const kxA = new Float32Array(NC);
    const kzA = new Float32Array(NC);
    const div = new Float32Array(NC);
    const cg = new Float32Array(NC);
    const baseAng = Math.atan2(SWELL.dirZ, SWELL.dirX) + (dirOffsetDeg * Math.PI) / 180;
    const dx = FIELD.texel;

    for (let tr = 0; tr < N_TRAINS; tr++) {
      const def = TRAIN_DEFS[tr];
      const omega = quantizeOmega((2 * Math.PI) / (def.period * periodScale));
      const ang = baseAng + (def.dirOffsetDeg * Math.PI) / 180;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      this.omega[tr] = omega;
      this.dirX[tr] = ux;
      this.dirZ[tr] = uz;
      for (let c = 0; c < NC; c++) {
        k[c] = waveNumber(omega, hb[c]);
        cg[c] = groupSpeed(omega, k[c], hb[c]);
      }

      // ── phase: eikonal by fast sweeping. Fixed boundaries: the offshore column (plane wave)
      // and the -Z row (Snell's law along an assumed laterally uniform shore).
      T.fill(1e30);
      for (let j = 0; j < NZ; j++) {
        const c = j * NX;
        const x = FIELD.x0 + 0.5 * dx;
        const z = FIELD.z0 + (j + 0.5) * dx;
        T[c] = ((x * ux + z * uz) * k[c]) / omega;
      }
      {
        const kz = k[0] * uz;
        for (let i = 1; i < NX; i++) {
          const kk = k[i];
          const kx = Math.sqrt(Math.max(kk * kk - kz * kz, 0.04 * kk * kk));
          T[i] = T[i - 1] + (kx * dx) / omega;
        }
      }
      for (let round = 0; round < 3; round++) {
        for (let sweep = 0; sweep < 4; sweep++) {
          const iUp = sweep === 0 || sweep === 3;
          const jUp = sweep < 2;
          for (let jj = 1; jj < NZ; jj++) {
            const j = jUp ? jj : NZ - jj;
            for (let ii = 1; ii < NX; ii++) {
              const i = iUp ? ii : NX - ii;
              const c = j * NX + i;
              const a = i + 1 < NX ? Math.min(T[c - 1], T[c + 1]) : T[c - 1];
              const b = j + 1 < NZ ? Math.min(T[c - NX], T[c + NX]) : T[c - NX];
              const f = (k[c] / omega) * dx;
              let tn: number;
              if (Math.abs(a - b) >= f) tn = Math.min(a, b) + f;
              else tn = 0.5 * (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b)));
              if (tn < T[c]) T[c] = tn;
            }
          }
        }
      }

      // ── direction: ∇T, smoothed, rescaled to the local dispersion wavenumber.
      for (let j = 0; j < NZ; j++) {
        for (let i = 0; i < NX; i++) {
          const c = j * NX + i;
          const gx = i === 0 ? T[c + 1] - T[c] : i === NX - 1 ? T[c] - T[c - 1] : 0.5 * (T[c + 1] - T[c - 1]);
          const gz = j === 0 ? T[c + NX] - T[c] : j === NZ - 1 ? T[c] - T[c - NX] : 0.5 * (T[c + NX] - T[c - NX]);
          const l = Math.hypot(gx, gz) || 1;
          kxA[c] = gx / l;
          kzA[c] = gz / l;
        }
      }
      blur(kxA, 1);
      blur(kzA, 1);
      for (let c = 0; c < NC; c++) {
        const l = Math.hypot(kxA[c], kzA[c]) || 1;
        kxA[c] /= l;
        kzA[c] /= l;
      }
      for (let j = 0; j < NZ; j++) {
        for (let i = 0; i < NX; i++) {
          const c = j * NX + i;
          const ddx = i === 0 || i === NX - 1 ? 0 : (kxA[c + 1] - kxA[c - 1]) / (2 * dx);
          const ddz = j === 0 || j === NZ - 1 ? 0 : (kzA[c + NX] - kzA[c - NX]) / (2 * dx);
          div[c] = ddx + ddz;
        }
      }
      blur(div, 2);

      // ── march shoreward along the rays: ray-tube width, group time, breaking history.
      const L0 = 2 * tr * NC * 4;
      const L1 = (2 * tr + 1) * NC * 4;
      const D = this.data;
      let cgRef = 0;
      for (let j = 0; j < NZ; j++) cgRef += cg[j * NX];
      cgRef /= NZ;
      this.cgEdge[tr] = cgRef;
      this.kEdge[tr] = k[(NZ >> 1) * NX];
      const lnB = new Float32Array(NC);
      const tau = new Float64Array(NC);
      const Q = new Float32Array(NC);
      const hMin = new Float32Array(NC);
      const ampK = new Float32Array(NC);
      const qUp = new Float32Array(NZ);
      const dsCol = new Float32Array(NZ);
      for (let j = 0; j < NZ; j++) {
        const c = j * NX;
        const z = FIELD.z0 + (j + 0.5) * dx;
        const x = FIELD.x0 + 0.5 * dx;
        lnB[c] = 0;
        tau[c] = (x * ux + z * uz) / cgRef;
        ampK[c] = Math.sqrt(cgRef / cg[c]);
        Q[c] = ampK[c] / Math.max(hb[c], 0.05);
        hMin[c] = hb[c];
      }
      for (let i = 1; i < NX; i++) {
        for (let j = 0; j < NZ; j++) {
          const c = j * NX + i;
          const kx = Math.max(kxA[c], 0.2);
          const ds = dx / kx;
          // Upstream point on column i-1 (linear in z).
          let zu = j - (kzA[c] * ds) / dx;
          if (zu < 0) zu = 0;
          if (zu > NZ - 1) zu = NZ - 1;
          const j0 = Math.min(NZ - 2, Math.floor(zu));
          const f = zu - j0;
          const u0 = j0 * NX + i - 1;
          const u1 = u0 + NX;
          const lnBu = lnB[u0] * (1 - f) + lnB[u1] * f;
          const tauU = tau[u0] * (1 - f) + tau[u1] * f;
          const Qu = Q[u0] * (1 - f) + Q[u1] * f;
          const hMu = hMin[u0] * (1 - f) + hMin[u1] * f;
          const cgU = cg[u0] * (1 - f) + cg[u1] * f;
          let lb = lnBu + div[c] * ds;
          lb = lb < -1.3 ? -1.3 : lb > 1.6 ? 1.6 : lb;
          lnB[c] = lb;
          tau[c] = tauU + ds * 0.5 * (1 / cg[c] + 1 / cgU);
          qUp[j] = Qu;
          // Breaking develops over a distance, not at a point: relax toward the new minimum.
          const hr = Math.min(1, ds / BREAK_RELAX);
          hMin[c] = hb[c] < hMu ? hMu + (hb[c] - hMu) * hr : hMu;
          dsCol[j] = ds;
        }
        // Diffraction: waves spread energy sideways along the crest, which keeps refraction from
        // collapsing into caustic streaks. A small lateral diffusion of ln b per column.
        for (let pass = 0; pass < 2; pass++) {
          let prev = lnB[i];
          for (let j = 1; j < NZ - 1; j++) {
            const c = j * NX + i;
            const cur = lnB[c];
            lnB[c] = 0.25 * prev + 0.5 * cur + 0.25 * lnB[c + NX];
            prev = cur;
          }
        }
        for (let j = 0; j < NZ; j++) {
          const c = j * NX + i;
          const K = Math.sqrt(cgRef / cg[c]) * Math.exp(-0.5 * lnB[c]);
          ampK[c] = K;
          const q = K / Math.max(hb[c], 0.05);
          Q[c] = q > qUp[j] ? qUp[j] + (q - qUp[j]) * Math.min(1, dsCol[j] / BREAK_RELAX) : qUp[j];
        }
      }
      blur(Q, 2);
      blur(hMin, 2);
      // Group time relative to the peak, so sets are scheduled by the time they reach it.
      const tp = sampleGrid(tau, PEAK.x, PEAK.z);
      for (let c = 0; c < NC; c++) {
        const o0 = L0 + c * 4;
        const o1 = L1 + c * 4;
        D[o0] = omega * T[c];
        D[o0 + 1] = ampK[c];
        D[o0 + 2] = kxA[c] * k[c];
        D[o0 + 3] = kzA[c] * k[c];
        D[o1] = tau[c] - tp;
        D[o1 + 1] = Q[c];
        D[o1 + 2] = Math.min(hb[c], hMin[c] + 0.35);
        D[o1 + 3] = hb[c];
      }
    }
  }
}

function sampleGrid(a: Float64Array, x: number, z: number) {
  const u = Math.min(NX - 1.001, Math.max(0, (x - FIELD.x0) / FIELD.texel - 0.5));
  const v = Math.min(NZ - 1.001, Math.max(0, (z - FIELD.z0) / FIELD.texel - 0.5));
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const c = j * NX + i;
  return (a[c] * (1 - fu) + a[c + 1] * fu) * (1 - fv) + (a[c + NX] * (1 - fu) + a[c + NX + 1] * fu) * fv;
}

/** Separable box blur with radius r (texels), in place. */
function blur(a: Float32Array, r: number) {
  const tmp = new Float32Array(Math.max(NX, NZ));
  const w = 1 / (2 * r + 1);
  for (let j = 0; j < NZ; j++) {
    const o = j * NX;
    for (let i = 0; i < NX; i++) {
      let s = 0;
      for (let q = -r; q <= r; q++) s += a[o + Math.min(NX - 1, Math.max(0, i + q))];
      tmp[i] = s * w;
    }
    for (let i = 0; i < NX; i++) a[o + i] = tmp[i];
  }
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NZ; j++) {
      let s = 0;
      for (let q = -r; q <= r; q++) s += a[Math.min(NZ - 1, Math.max(0, j + q)) * NX + i];
      tmp[j] = s * w;
    }
    for (let j = 0; j < NZ; j++) a[j * NX + i] = tmp[j];
  }
}

// ── Set schedule ─────────────────────────────────────────────────────────────────────────
// A deterministic table of sets over one T_REP cycle, baked into an envelope texture (one row
// per train, 0.5 s per texel). Set sizes are 3–5 waves; lulls fill the rest of each interval.

export const ENV_W = 8192;
export const ENV_DT = T_REP / ENV_W;

export function bakeEnvelope(out: Float32Array, field: SwellField, setInterval: number, lullScale = 1) {
  for (let tr = 0; tr < N_TRAINS; tr++) {
    const def = TRAIN_DEFS[tr];
    const row = tr * ENV_W;
    if (!def.sets) {
      for (let i = 0; i < ENV_W; i++) out[row + i] = 1;
      continue;
    }
    const period = (2 * Math.PI) / field.omega[tr];
    const lull = Math.min(1, def.lull * lullScale);
    const nSets = Math.max(1, Math.round(T_REP / setInterval));
    const rnd = mulberry32(0x5e75 + tr * 977);
    const starts = new Float64Array(nSets);
    const counts = new Float64Array(nSets);
    const heights = new Float64Array(nSets);
    // Draw set sizes and raw gaps, then scale the gaps so the table exactly fills T_REP.
    let busy = 0;
    const gaps = new Float64Array(nSets);
    let gapSum = 0;
    for (let s = 0; s < nSets; s++) {
      const r = rnd();
      counts[s] = r < 0.3 ? 3 : r < 0.75 ? 4 : 5;
      heights[s] = 0.86 + 0.26 * rnd();
      // The first set reaches the peak as the default shots (t ≈ 30–45 s) look at it.
      if (s === 0) {
        counts[s] = 4;
        heights[s] = 1.08;
      }
      busy += (counts[s] + 0.6) * period;
      gaps[s] = 0.6 + 0.8 * rnd();
      gapSum += gaps[s];
    }
    const free = Math.max(nSets * period * 1.2, T_REP - busy);
    let t0 = 18; // the first set reaches the peak ~18 s in, so the default shots catch a set
    for (let s = 0; s < nSets; s++) {
      starts[s] = t0;
      t0 += (counts[s] + 0.6) * period + (gaps[s] / gapSum) * free;
    }
    for (let i = 0; i < ENV_W; i++) {
      // Texel i holds the envelope at time (i + 0.5) * ENV_DT, shifted per train.
      let t = (i + 0.5) * ENV_DT + def.scheduleShift;
      t -= Math.floor(t / T_REP) * T_REP;
      let e = 0;
      for (let s = 0; s < nSets; s++) {
        // The table wraps: test the set in this cycle and its copies either side.
        for (let w = -1; w <= 1; w++) {
          const u = t - (starts[s] + w * T_REP);
          const dur = (counts[s] + 0.6) * period;
          if (u < 0 || u > dur) continue;
          const ramp = 0.8 * period;
          const up = smooth01(u / ramp);
          const down = smooth01((dur - u) / ramp);
          // Middle waves of a set are the biggest.
          const shape = 0.8 + 0.2 * Math.sin((Math.PI * u) / dur);
          e = Math.max(e, up * down * shape * heights[s]);
        }
      }
      out[row + i] = lull + (1 - lull) * e;
    }
  }
}

/** The envelope texture's linear filter, reproduced on the CPU (repeat-wrapped in time). */
export function envelopeAt(env: Float32Array, tr: number, t: number) {
  let u = t / ENV_DT - 0.5;
  u -= Math.floor(u / ENV_W) * ENV_W;
  const i0 = Math.floor(u);
  const f = u - i0;
  const i1 = i0 + 1 >= ENV_W ? 0 : i0 + 1;
  const row = tr * ENV_W;
  return env[row + i0] * (1 - f) + env[row + i1] * f;
}

const smooth01 = (x: number) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Evaluation (CPU mirror of swell-gpu.ts) ──────────────────────────────────────────────

export interface SwellEval {
  /** Displacement (m). */
  dx: number;
  dy: number;
  dz: number;
  /** Displacement derivatives w.r.t. the rest position. */
  dydx: number;
  dydz: number;
  dxdx: number;
  dzdz: number;
  dxdz: number;
  /** Particle velocity (m/s). */
  vx: number;
  vy: number;
  vz: number;
  /** Max brokenness over the trains (0-1), and the still-water depth. */
  broken: number;
  depth: number;
}

// Scratch records start with non-integer values so V8 gives every field a double representation
// up front (no Smi→double migration and boxing in hot loops).
export const newSwellEval = (): SwellEval => ({
  dx: 0.5, dy: 0.5, dz: 0.5, dydx: 0.5, dydz: 0.5, dxdx: 0.5, dzdz: 0.5, dxdz: 0.5, vx: 0.5, vy: 0.5, vz: 0.5, broken: 0.5, depth: 0.5,
});

/** Per-train state at a point, for the breaking-wave system and wave(). */
export interface TrainPoint {
  /** Phase θ = S − ωt (rad), before the skew warp; crests at θ ≡ 0 (mod 2π). */
  theta: number;
  /** Local wavenumber vector (rad/m); |k| = 2π/λ. */
  kx: number;
  kz: number;
  /** Local amplitude (m) after shoaling, sets and breaking saturation. */
  amp: number;
  /** Unbroken local amplitude (m) and offshore amplitude of this wave (m). */
  ampUnbroken: number;
  ampOffshore: number;
  /** 0 = unbroken, 1 = broken upstream (saturated surf zone). */
  broken: number;
  omega: number;
  depth: number;
}

export const newTrainPoint = (): TrainPoint => ({ theta: 0.5, kx: 0.5, kz: 0.5, amp: 0.5, ampUnbroken: 0.5, ampOffshore: 0.5, broken: 0.5, omega: 0.5, depth: 0.5 });

export interface SwellRuntime {
  /** Global amplitude scale (param). */
  scale: number;
  /** Simulation time wrapped to [0, T_REP), quantised to ticks (= ticks / TICKS · T_REP). */
  tMod: number;
  /** Per-train phase ω·t (rad, from phaseOf). */
  phase: Float64Array;
  /** Skew (front-face steepening) strength. */
  skew: number;
}

export const newSwellRuntime = (): SwellRuntime => ({ scale: 1.5, tMod: 0.5, phase: new Float64Array(N_TRAINS), skew: 0.5 });

/** Set rt.tMod and rt.phase for simulation time t. */
export function setSwellTime(field: SwellField, rt: SwellRuntime, t: number) {
  const n = timeTicks(t);
  rt.tMod = (n / TICKS) * T_REP;
  for (let tr = 0; tr < N_TRAINS; tr++) rt.phase[tr] = phaseOf(Math.round(field.omega[tr] / OMEGA_QUANTUM), n);
  return n;
}

// Scratch for the 8 bilinear channels of one train.
const ch = new Float64Array(8);

/** Baked still-water depth (m, ≥ 0) at world (x, z), bilinear, clamped to the field. Writes out[0]. */
export function depthAt(field: SwellField, x: number, z: number, out: Float64Array) {
  let u = (x - FIELD.x0) / FIELD.texel - 0.5;
  let v = (z - FIELD.z0) / FIELD.texel - 0.5;
  u = u < 0 ? 0 : u > NX - 1 ? NX - 1 : u;
  v = v < 0 ? 0 : v > NZ - 1 ? NZ - 1 : v;
  let i = Math.floor(u);
  let j = Math.floor(v);
  if (i > NX - 2) i = NX - 2;
  if (j > NZ - 2) j = NZ - 2;
  const fu = u - i;
  const fv = v - j;
  const D = field.data;
  const a = (NC + j * NX + i) * 4 + 3; // layer 1 (train 0), channel w
  out[0] = (D[a] * (1 - fu) + D[a + 4] * fu) * (1 - fv) + (D[a + NX * 4] * (1 - fu) + D[a + NX * 4 + 4] * fu) * fv;
}

/** Bilinear sample of train `tr` at world (x, z) into ch[], extrapolating S and τ off-grid. */
function fetchTrain(field: SwellField, tr: number, x: number, z: number) {
  const u = (x - FIELD.x0) / FIELD.texel - 0.5;
  const v = (z - FIELD.z0) / FIELD.texel - 0.5;
  const uc = u < 0 ? 0 : u > NX - 1 ? NX - 1 : u;
  const vc = v < 0 ? 0 : v > NZ - 1 ? NZ - 1 : v;
  let i = Math.floor(uc);
  let j = Math.floor(vc);
  if (i > NX - 2) i = NX - 2;
  if (j > NZ - 2) j = NZ - 2;
  const fu = uc - i;
  const fv = vc - j;
  const w00 = (1 - fu) * (1 - fv);
  const w10 = fu * (1 - fv);
  const w01 = (1 - fu) * fv;
  const w11 = fu * fv;
  const D = field.data;
  const c = j * NX + i;
  for (let layer = 0; layer < 2; layer++) {
    const base = (2 * tr + layer) * NC * 4;
    const a = base + c * 4;
    const b = a + 4;
    const cc = a + NX * 4;
    const d = cc + 4;
    for (let q = 0; q < 4; q++) ch[layer * 4 + q] = D[a + q] * w00 + D[b + q] * w10 + D[cc + q] * w01 + D[d + q] * w11;
  }
  const ox = (u - uc) * FIELD.texel;
  const oz = (v - vc) * FIELD.texel;
  if (ox !== 0 || oz !== 0) {
    ch[0] += ch[2] * ox + ch[3] * oz;
    const kl = Math.sqrt(ch[2] * ch[2] + ch[3] * ch[3]) || 1;
    ch[4] += ((ch[2] / kl) * ox + (ch[3] / kl) * oz) / field.cgEdge[tr];
  }
}

/**
 * One train's state at rest position (x, z) at time rt.tMod. Mirrors swellTrainGPU() in
 * swell-gpu.ts line for line; keep them in sync.
 */
export function trainAt(field: SwellField, env: Float32Array, tr: number, x: number, z: number, rt: SwellRuntime, out: TrainPoint) {
  fetchTrain(field, tr, x, z);
  const S = ch[0];
  const K = ch[1];
  const kx = ch[2];
  const kz = ch[3];
  const tau = ch[4];
  const Q = ch[5];
  const hCap = ch[6];
  const h = ch[7];
  const omega = field.omega[tr];
  const e = envelopeAt(env, tr, rt.tMod - tau);
  const a = TRAIN_DEFS[tr].amp * rt.scale * e;
  const au = a * K;
  // Brokenness: this wave exceeded the breaking index somewhere upstream.
  const r = (2 * a * Q) / GAMMA_BREAK;
  const broken = smoothstep(0.85, 1.15, r);
  const hEff = hCap;
  const cap = 0.5 * (GAMMA_BREAK + (GAMMA_SURF - GAMMA_BREAK) * broken) * Math.max(hEff, 0.02);
  // Smooth min(au, cap).
  const q1 = au * au * au * au;
  const q2 = cap * cap * cap * cap;
  const amp = au * Math.pow(q2 / (q1 + q2 + 1e-12), 0.25);
  out.theta = S - rt.phase[tr];
  out.kx = kx;
  out.kz = kz;
  out.amp = amp;
  out.ampUnbroken = au;
  out.ampOffshore = a;
  out.broken = broken;
  out.omega = omega;
  out.depth = h;
  return out;
}

const tp = newTrainPoint();

/** Sum of all trains' Gerstner displacement, derivatives and velocity at rest position (x, z). */
export function evalSwell(field: SwellField, env: Float32Array, x: number, z: number, rt: SwellRuntime, out: SwellEval) {
  out.dx = out.dy = out.dz = 0;
  out.dydx = out.dydz = out.dxdx = out.dzdz = out.dxdz = 0;
  out.vx = out.vy = out.vz = 0;
  out.broken = 0;
  for (let tr = 0; tr < N_TRAINS; tr++) {
    trainAt(field, env, tr, x, z, rt, tp);
    const kl = Math.sqrt(tp.kx * tp.kx + tp.kz * tp.kz) || 1e-6;
    const ux = tp.kx / kl;
    const uz = tp.kz / kl;
    const A = tp.amp;
    // Shallow water: orbits flatten into ellipses (horizontal amplitude A / tanh kh).
    const kh = kl * Math.max(tp.depth, 0.25);
    const hf = Math.min(1 / Math.tanh(kh), 2.6);
    // Approaching the breaking index the orbital speed nears the phase speed (k·B → 1): the crest
    // peaks, the trough flattens and the face pitches forward. Bores stay steep-fronted.
    const rb = tp.ampUnbroken / (0.5 * GAMMA_BREAK * Math.max(tp.depth, 0.05));
    const shoal = smoothstep(0.35, 1, rb) * (1 - tp.broken) + 0.45 * tp.broken;
    const beta = rt.skew * shoal;
    // No folding: ∂x/∂x0 = 1 − kB·cos θ'·(1 + β sin θ) must stay > 0, so kB(1 + β) < 1.
    const B = Math.min(Math.max(A * hf, (ORBIT_SHOAL * shoal) / kl), 5 * A, FOLD_LIMIT / (kl * (1 + beta)));
    const th = tp.theta;
    const sth = Math.sin(th);
    const thw = th + beta * (1 - Math.cos(th));
    const dw = 1 + beta * sth;
    const s = Math.sin(thw);
    const c = Math.cos(thw);
    // Second harmonic (Stokes-like): peaked crests, flat troughs as the wave shoals.
    const a2 = HARMONIC2 * A * shoal;
    const s2 = 2 * s * c;
    const c2 = c * c - s * s;
    out.dx -= B * ux * s;
    out.dy += A * c + a2 * c2;
    out.dz -= B * uz * s;
    const ys = A * s + 2 * a2 * s2;
    out.dydx -= ys * dw * tp.kx;
    out.dydz -= ys * dw * tp.kz;
    out.dxdx -= B * ux * c * dw * tp.kx;
    out.dzdz -= B * uz * c * dw * tp.kz;
    out.dxdz -= B * ux * c * dw * tp.kz;
    const wv = tp.omega * dw;
    out.vx += B * ux * c * wv;
    out.vy += ys * wv;
    out.vz += B * uz * c * wv;
    if (tp.broken > out.broken) out.broken = tp.broken;
    out.depth = tp.depth;
  }
  return out;
}

export function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
