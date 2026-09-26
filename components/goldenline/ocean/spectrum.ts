// Wind-sea spectrum for the FFT cascades: JONSWAP with Mitsuyasu-style directional spreading,
// generated on the CPU (seeded, deterministic) and uploaded as h0(k). The CPU also keeps the
// strongest modes of the two long cascades so OceanService.sample() can sum them directly.

import { G, OMEGA_QUANTUM, mulberry32 } from './swell';

export const FFT_N = 256;
export const N_CASCADES = 4;

export interface Cascade {
  /** Patch size (m). Non-harmonic ratios so the tiles never line up. */
  L: number;
  /** Wavenumber band this cascade owns (rad/m). */
  kLow: number;
  kHigh: number;
  /** Rotation of the cascade's texture frame (rad), so its tiling isn't axis aligned. */
  rot: number;
  /** Which wind drives it: 'sea' = distant wind sea (roughly with the swell), 'local' = the offshore breeze. */
  wind: 'sea' | 'local';
}

const TAU = Math.PI * 2;
const L = [233, 41.7, 7.13, 1.37];
export const CASCADES: Cascade[] = [
  { L: L[0], kLow: 1e-4, kHigh: (TAU / L[1]) * 6, rot: 0, wind: 'sea' },
  { L: L[1], kLow: (TAU / L[1]) * 6, kHigh: (TAU / L[2]) * 6, rot: 0.61, wind: 'sea' },
  { L: L[2], kLow: (TAU / L[2]) * 6, kHigh: (TAU / L[3]) * 6, rot: 1.37, wind: 'local' },
  { L: L[3], kLow: (TAU / L[3]) * 6, kHigh: TAU / 0.011, rot: 2.23, wind: 'local' },
];

/** Depth attenuation (smoothstep edges, m) of each FFT cascade; the swell is the depth-aware part. */
export const FFT_DEPTH_FADE: Array<[number, number]> = [
  [1.0, 8.0],
  [0.15, 1.2],
  [0.15, 1.2],
  [0.15, 1.2],
];

export interface SpectrumParams {
  /** Wind sea: 10 m wind speed (m/s), fetch (km), direction of travel (unit XZ). */
  seaWind: number;
  seaFetchKm: number;
  seaDirX: number;
  seaDirZ: number;
  /** Local breeze (offshore): speed and direction of travel. */
  localWind: number;
  localDirX: number;
  localDirZ: number;
  /** Overall amplitude scale on the wind sea. */
  scale: number;
  /** Extra scale on the short (local) cascades: chop / capillary strength. */
  chopScale: number;
  /** Extra scale on the capillary cascade only (cm ripples at arm's length). */
  capillaryScale: number;
}

const SIGMA_T = 7.28e-5; // surface tension / density (m³/s²): capillary term of the dispersion

export const dispersion = (k: number) => Math.sqrt(G * k + SIGMA_T * k * k * k);
const dispersionDk = (k: number) => (G + 3 * SIGMA_T * k * k) / (2 * dispersion(k));

function jonswap(omega: number, wind: number, fetch: number) {
  const g = G;
  const wp = 22 * Math.pow((g * g) / (wind * fetch), 1 / 3);
  const alpha = 0.076 * Math.pow((wind * wind) / (fetch * g), 0.22);
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) * (omega - wp)) / (2 * sigma * sigma * wp * wp));
  return { s: ((alpha * g * g) / Math.pow(omega, 5)) * Math.exp(-1.25 * Math.pow(wp / omega, 4)) * Math.pow(3.3, r), wp };
}

/** Normalised cos^2s((θ - θ0)/2) spreading. */
function spreading(dtheta: number, s: number) {
  // Γ(s+1)² 2^(2s-1) / (π Γ(2s+1)), via lgamma for large s.
  const q = Math.exp(2 * lgamma(s + 1) + (2 * s - 1) * Math.LN2 - lgamma(2 * s + 1)) / Math.PI;
  const d = dtheta - TAU * Math.round(dtheta / TAU);
  return q * Math.pow(Math.cos(d * 0.5), 2 * s);
}

function lgamma(x: number): number {
  // Lanczos approximation.
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

export interface CpuModes {
  /** Modes kept for the CPU, strongest first (cascades 0–2). */
  count: number;
  cascade: Uint8Array;
  /** Grid indices relative to the spectrum centre (k' = (n, m)·Δk in the cascade frame). */
  n: Int16Array;
  m: Int16Array;
  /** World wavevector and its derived coefficients. */
  kx: Float64Array;
  kz: Float64Array;
  omega: Float64Array;
  /** Integer frequency multiples (see Spectrum.omegaQ). */
  q: Float64Array;
  /** Wave amplitude 2|h0| (m) and phase arg h0. */
  amp: Float64Array;
  phase: Float64Array;
  /** Height RMS captured by the modes vs the total of cascades 0–2 (m). */
  rmsKept: number;
  rmsTotal: number;
}

/** Modes the CPU sums for heights (≈1.2 cm residual RMS at the default sea). */
export const MAX_CPU_MODES = 1900;
/** The strongest of those also give slopes, velocities and horizontal displacement. */
export const CPU_DERIV_MODES = 256;
/** Cascades the CPU models (the capillary cascade is millimetres). */
export const CPU_CASCADES = 3;

/**
 * Fills h0 (N_CASCADES·N·N vec4: h0(k), conj h0(−k)) and omegaQ (quantised ω per mode).
 * Random draws depend only on the mode index, so changing the wind rescales the same sea.
 */
export class Spectrum {
  readonly h0 = new Float32Array(N_CASCADES * FFT_N * FFT_N * 4);
  /** Integer frequency multiple q per mode: ω = q · OMEGA_QUANTUM (exact phase arithmetic on the GPU). */
  readonly omegaQ = new Uint32Array(N_CASCADES * FFT_N * FFT_N);
  private readonly gauss = new Float32Array(N_CASCADES * FFT_N * FFT_N * 2);
  readonly modes: CpuModes = {
    count: 0,
    cascade: new Uint8Array(MAX_CPU_MODES),
    n: new Int16Array(MAX_CPU_MODES),
    m: new Int16Array(MAX_CPU_MODES),
    kx: new Float64Array(MAX_CPU_MODES),
    kz: new Float64Array(MAX_CPU_MODES),
    omega: new Float64Array(MAX_CPU_MODES),
    q: new Float64Array(MAX_CPU_MODES),
    amp: new Float64Array(MAX_CPU_MODES),
    phase: new Float64Array(MAX_CPU_MODES),
    rmsKept: 0,
    rmsTotal: 0,
  };

  constructor() {
    const rnd = mulberry32(0x0cea9);
    for (let i = 0; i < this.gauss.length; i += 2) {
      // Box–Muller.
      const u1 = Math.max(1e-9, rnd());
      const u2 = rnd();
      const r = Math.sqrt(-2 * Math.log(u1));
      this.gauss[i] = r * Math.cos(TAU * u2);
      this.gauss[i + 1] = r * Math.sin(TAU * u2);
    }
  }

  generate(p: SpectrumParams) {
    const N = FFT_N;
    const amp = new Float32Array(N * N); // |h0(k)| per mode for one cascade, scratch
    const seaAng = Math.atan2(p.seaDirZ, p.seaDirX);
    const localAng = Math.atan2(p.localDirZ, p.localDirX);
    const seaFetch = p.seaFetchKm * 1000;
    const localFetch = 1500; // the breeze has a short over-water fetch (it blows off the land)
    const wpSea = jonswap(1, p.seaWind, seaFetch).wp;
    const wpLocal = jonswap(1, Math.max(0.5, p.localWind), localFetch).wp;
    // Candidate list for the CPU modes (long cascades only).
    const candAmp: number[] = [];
    const candIdx: number[] = [];
    let varTotal = 0;
    for (let c = 0; c < N_CASCADES; c++) {
      const cas = CASCADES[c];
      const dk = TAU / cas.L;
      const cr = Math.cos(cas.rot);
      const sr = Math.sin(cas.rot);
      const local = cas.wind === 'local';
      const base = c * N * N;
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const i = m * N + n;
          if (n === 0 || m === 0) {
            amp[i] = 0;
            continue;
          }
          // Mode wavevector in the cascade frame, then in world.
          const kxc = (n - N / 2) * dk;
          const kzc = (m - N / 2) * dk;
          const kx = kxc * cr - kzc * sr;
          const kz = kxc * sr + kzc * cr;
          const k = Math.hypot(kx, kz);
          if (k < cas.kLow || k >= cas.kHigh) {
            amp[i] = 0;
            continue;
          }
          // Spectrum shape from the gravity branch (ω_g = √(gk)): the short-wave range stays near
          // saturation (equal slope per octave) down to the capillary peak, as measured spectra
          // do. The capillary term only enters the time evolution (omegaQ).
          const w = Math.sqrt(G * k);
          const th = Math.atan2(kz, kx);
          let psi = 0;
          // The distant wind sea (with the swell) plus, on the short scales, the local breeze.
          {
            const js = jonswap(w, p.seaWind, seaFetch);
            const rw = w / wpSea;
            const s = Math.max(2, rw <= 1 ? 11 * Math.pow(rw, 5) : 11 * Math.pow(rw, -2.5));
            psi += js.s * spreading(th - seaAng, s) * p.scale;
          }
          if (local || k > 2) {
            const js = jonswap(w, Math.max(0.5, p.localWind), localFetch);
            const rw = w / wpLocal;
            const s = Math.max(1.5, rw <= 1 ? 6 * Math.pow(rw, 5) : 6 * Math.pow(rw, -2.5));
            psi += js.s * spreading(th - localAng, s) * p.chopScale * (c === N_CASCADES - 1 ? p.capillaryScale : 1);
          }
          // Ψ(k) = S(ω) D(θ) dω/dk / k ; E|h0|² = Ψ Δk² / 2.
          const Psi = (psi * (0.5 * Math.sqrt(G / k))) / k;
          // Fade toward the capillary cascade's Nyquist (they would only alias).
          const fade = local ? Math.exp(-(k * k) / (520 * 520)) : 1;
          amp[i] = Math.sqrt((Psi * dk * dk) / 2) * fade;
        }
      }
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const i = m * N + n;
          const g = (base + i) * 2;
          const a = amp[i] * Math.SQRT1_2;
          const hr = this.gauss[g] * a;
          const hi = this.gauss[g + 1] * a;
          // Mirror mode -k.
          const mi = n === 0 || m === 0 ? i : (N - m) * N + (N - n);
          const gm = (base + mi) * 2;
          const am = amp[mi] * Math.SQRT1_2;
          const mr = this.gauss[gm] * am;
          const mim = -this.gauss[gm + 1] * am; // conjugate
          const o = (base + i) * 4;
          this.h0[o] = hr;
          this.h0[o + 1] = hi;
          this.h0[o + 2] = mr;
          this.h0[o + 3] = mim;
          const kxc = (n - N / 2) * dk;
          const kzc = (m - N / 2) * dk;
          const k = Math.hypot(kxc, kzc);
          this.omegaQ[base + i] = k > 0 ? Math.round(dispersion(k) / OMEGA_QUANTUM) : 0;
          if (c < CPU_CASCADES) {
            // Each mode is a travelling wave of amplitude 2|h0| (see fft.ts).
            const wa = 2 * Math.hypot(hr, hi);
            varTotal += (wa * wa) / 2;
            if (wa > 1e-4) {
              candAmp.push(wa);
              candIdx.push(base + i);
            }
          }
        }
      }
    }
    // Keep the strongest modes for the CPU.
    const order = candIdx.map((_, i) => i).sort((a, b) => candAmp[b] - candAmp[a]);
    const M = this.modes;
    const count = Math.min(MAX_CPU_MODES, order.length);
    let varKept = 0;
    for (let q = 0; q < count; q++) {
      const gi = candIdx[order[q]];
      const c = Math.floor(gi / (N * N));
      const i = gi - c * N * N;
      const m = Math.floor(i / N);
      const n = i - m * N;
      const cas = CASCADES[c];
      const dk = TAU / cas.L;
      const kxc = (n - N / 2) * dk;
      const kzc = (m - N / 2) * dk;
      const cr = Math.cos(cas.rot);
      const sr = Math.sin(cas.rot);
      M.kx[q] = kxc * cr - kzc * sr;
      M.kz[q] = kxc * sr + kzc * cr;
      M.n[q] = n - N / 2;
      M.m[q] = m - N / 2;
      M.q[q] = this.omegaQ[gi];
      M.omega[q] = this.omegaQ[gi] * OMEGA_QUANTUM;
      M.amp[q] = candAmp[order[q]];
      M.phase[q] = Math.atan2(this.h0[gi * 4 + 1], this.h0[gi * 4]);
      M.cascade[q] = c;
      varKept += (M.amp[q] * M.amp[q]) / 2;
    }
    M.count = count;
    M.rmsKept = Math.sqrt(varKept);
    M.rmsTotal = Math.sqrt(varTotal);
  }
}
