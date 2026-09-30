// CPU evaluation of the FFT wind sea at a point, for OceanService.sample(). The kept modes sit
// on each cascade's k-grid, so e^{ik·x} = Ex[n]·Ez[m] with per-cascade tables built by complex
// recurrence from two exponentials: no trig per mode. The strongest CPU_DERIV_MODES also give
// slopes, velocity and horizontal displacement; the rest only add height.

import { CASCADES, CPU_CASCADES, CPU_DERIV_MODES, FFT_DEPTH_FADE, type Spectrum } from './spectrum';
import { phaseOf, smoothstep } from './swell';

const TMAX = 130; // |n|, |m| ≤ 128
const COS_ROT = CASCADES.map((c) => Math.cos(c.rot));
const SIN_ROT = CASCADES.map((c) => Math.sin(c.rot));

export interface SeaEval {
  dx: number;
  dy: number;
  dz: number;
  dydx: number;
  dydz: number;
  dxdx: number;
  dzdz: number;
  dxdz: number;
  vx: number;
  vy: number;
  vz: number;
}

export class CpuSea {
  /** Per-frame complex amplitude a·e^{i(φ0 − ωt)} of every mode. */
  private readonly tRe: Float64Array;
  private readonly tIm: Float64Array;
  private readonly ex = new Float64Array(CPU_CASCADES * TMAX * 2);
  private readonly ez = new Float64Array(CPU_CASCADES * TMAX * 2);
  // Table extents per cascade: [0] for the derivative prefix, [1] for all modes.
  private readonly nMax = new Int32Array(CPU_CASCADES * 2);
  private readonly mMax = new Int32Array(CPU_CASCADES * 2);
  private readonly fade = new Float64Array(CPU_CASCADES);
  private ticks = -1;
  private stale = true;
  readonly chop = new Float64Array(CPU_CASCADES);

  constructor(private readonly spec: Spectrum) {
    this.tRe = new Float64Array(spec.modes.n.length);
    this.tIm = new Float64Array(spec.modes.n.length);
    this.refresh();
  }

  /** Call after Spectrum.generate(). */
  refresh() {
    const M = this.spec.modes;
    this.nMax.fill(0);
    this.mMax.fill(0);
    for (let q = 0; q < M.count; q++) {
      const c = M.cascade[q];
      const an = Math.abs(M.n[q]);
      const am = Math.abs(M.m[q]);
      for (let tier = q < CPU_DERIV_MODES ? 0 : 1; tier < 2; tier++) {
        if (an > this.nMax[c * 2 + tier]) this.nMax[c * 2 + tier] = an;
        if (am > this.mMax[c * 2 + tier]) this.mMax[c * 2 + tier] = am;
      }
    }
    this.stale = true;
  }

  setTicks(ticks: number) {
    if (ticks !== this.ticks) {
      this.ticks = ticks;
      this.stale = true;
    }
  }

  /** Mode phases are only computed on the first query of a frame. */
  private ensure() {
    if (!this.stale) return;
    this.stale = false;
    const M = this.spec.modes;
    for (let q = 0; q < M.count; q++) {
      const ph = M.phase[q] - phaseOf(M.q[q], this.ticks);
      this.tRe[q] = M.amp[q] * Math.cos(ph);
      this.tIm[q] = M.amp[q] * Math.sin(ph);
    }
  }

  private tables(x: number, z: number, tier: number) {
    for (let c = 0; c < CPU_CASCADES; c++) {
      const cas = CASCADES[c];
      const cr = COS_ROT[c];
      const sr = SIN_ROT[c];
      const dk = (2 * Math.PI) / cas.L;
      fill(this.ex, c, dk * (cr * x + sr * z), this.nMax[c * 2 + tier]);
      fill(this.ez, c, dk * (cr * z - sr * x), this.mMax[c * 2 + tier]);
    }
  }

  /** Add the heights of the modes beyond CPU_DERIV_MODES at rest point (x, z) to out.dy. */
  evalRange(x: number, z: number, depth: number, out: SeaEval) {
    this.ensure();
    const M = this.spec.modes;
    if (M.count <= CPU_DERIV_MODES) return out;
    this.tables(x, z, 1);
    for (let c = 0; c < CPU_CASCADES; c++) this.fade[c] = smoothstep(FFT_DEPTH_FADE[c][0], FFT_DEPTH_FADE[c][1], depth);
    const ex = this.ex;
    const ez = this.ez;
    let dy = 0;
    for (let q = CPU_DERIV_MODES; q < M.count; q++) {
      const c = M.cascade[q];
      const n = M.n[q];
      const m = M.m[q];
      const oi = (c * TMAX + (n < 0 ? -n : n)) * 2;
      const oj = (c * TMAX + (m < 0 ? -m : m)) * 2;
      const xr = ex[oi];
      const xi = n < 0 ? -ex[oi + 1] : ex[oi + 1];
      const zr = ez[oj];
      const zi = m < 0 ? -ez[oj + 1] : ez[oj + 1];
      const er = xr * zr - xi * zi;
      const ei = xr * zi + xi * zr;
      dy += (this.tRe[q] * er - this.tIm[q] * ei) * this.fade[c];
    }
    out.dy += dy;
    return out;
  }

  /**
   * Add the sea at rest point (x, z) into `out`. `modes` limits how many of the strongest modes
   * are summed (the Newton iterations use only CPU_DERIV_MODES).
   */
  eval(x: number, z: number, depth: number, modes: number, out: SeaEval) {
    this.ensure();
    const M = this.spec.modes;
    this.tables(x, z, modes <= CPU_DERIV_MODES ? 0 : 1);
    for (let c = 0; c < CPU_CASCADES; c++) this.fade[c] = smoothstep(FFT_DEPTH_FADE[c][0], FFT_DEPTH_FADE[c][1], depth);
    const count = modes < M.count ? modes : M.count;
    const nd = count < CPU_DERIV_MODES ? count : CPU_DERIV_MODES;
    const ex = this.ex;
    const ez = this.ez;
    for (let q = 0; q < count; q++) {
      const c = M.cascade[q];
      const f = this.fade[c];
      if (f === 0) continue;
      const n = M.n[q];
      const m = M.m[q];
      const oi = (c * TMAX + (n < 0 ? -n : n)) * 2;
      const oj = (c * TMAX + (m < 0 ? -m : m)) * 2;
      const xr = ex[oi];
      const xi = n < 0 ? -ex[oi + 1] : ex[oi + 1];
      const zr = ez[oj];
      const zi = m < 0 ? -ez[oj + 1] : ez[oj + 1];
      const er = xr * zr - xi * zi;
      const ei = xr * zi + xi * zr;
      const tr = this.tRe[q];
      const ti = this.tIm[q];
      const vr = (tr * er - ti * ei) * f;
      out.dy += vr;
      if (q >= nd) continue;
      const vi = (tr * ei + ti * er) * f;
      const kx = M.kx[q];
      const kz = M.kz[q];
      const kl = Math.sqrt(kx * kx + kz * kz);
      const lam = this.chop[c] / kl;
      const w = M.omega[q];
      out.dx -= lam * kx * vi;
      out.dz -= lam * kz * vi;
      out.dydx -= kx * vi;
      out.dydz -= kz * vi;
      out.dxdx -= lam * kx * kx * vr;
      out.dzdz -= lam * kz * kz * vr;
      out.dxdz -= lam * kx * kz * vr;
      out.vy += w * vi;
      out.vx += lam * kx * w * vr;
      out.vz += lam * kz * w * vr;
    }
    return out;
  }
}

/** Height only of modes [CPU_DERIV_MODES, count) at rest point (x, z), added to out.dy. */
export function addRestHeights(sea: CpuSea, x: number, z: number, depth: number, out: SeaEval) {
  sea.evalRange(x, z, depth, out);
}

/** e^{i·j·a} for j = 0..max into t (interleaved re, im) at cascade c, by recurrence. */
function fill(t: Float64Array, c: number, a: number, max: number) {
  const o = c * TMAX * 2;
  const br = Math.cos(a);
  const bi = Math.sin(a);
  t[o] = 1;
  t[o + 1] = 0;
  let r = 1;
  let i = 0;
  for (let j = 1; j <= max; j++) {
    const nr = r * br - i * bi;
    i = r * bi + i * br;
    r = nr;
    t[o + j * 2] = r;
    t[o + j * 2 + 1] = i;
  }
}
