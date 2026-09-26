// OceanService: CPU queries that match the rendered surface. The swell part is exact (same
// arrays and formulas as the GPU); the wind sea is the strongest FFT modes summed directly.

import { Vector2 } from 'three/webgpu';
import type { OceanSample, OceanService, WaveInfo } from '../core/contracts';
import { SWELL } from '../world/layout';
import type { CpuSea } from './cpu-sea';
import { CPU_DERIV_MODES, MAX_CPU_MODES, type Spectrum } from './spectrum';
import {
  GAMMA_BREAK,
  N_TRAINS,
  depthAt,
  evalSwell,
  newSwellEval,
  newTrainPoint,
  smoothstep,
  trainAt,
  type SwellEval,
  type SwellField,
  type SwellRuntime,
} from './swell';

export interface OceanCpu {
  field: SwellField;
  env: Float32Array;
  rt: SwellRuntime;
  spec: Spectrum;
  sea: CpuSea;
  /** Whether the FFT sea is included (param ocean.fft). */
  fft: boolean;
  ticks: number;
}

const sw: SwellEval = newSwellEval();
const dq = new Float64Array(1);
const tp = newTrainPoint();
// Scratch for one full evaluation (swell + sea).
// Initialised with non-integers so V8 gives every field a double representation from the start
// (Smi→double field migration kept boxing numbers in the optimised code).
const E = { dx: 0.5, dy: 0.5, dz: 0.5, dydx: 0.5, dydz: 0.5, dxdx: 0.5, dzdz: 0.5, dxdz: 0.5, vx: 0.5, vy: 0.5, vz: 0.5, broken: 0.5, depth: 0.5 };

/** Swell + `modes` strongest sea modes at rest position (x, z) into E. */
function evalAll(cpu: OceanCpu, x: number, z: number, modes: number) {
  evalSwell(cpu.field, cpu.env, x, z, cpu.rt, sw);
  E.dx = sw.dx;
  E.dy = sw.dy;
  E.dz = sw.dz;
  E.dydx = sw.dydx;
  E.dydz = sw.dydz;
  E.dxdx = sw.dxdx;
  E.dzdz = sw.dzdz;
  E.dxdz = sw.dxdz;
  E.vx = sw.vx;
  E.vy = sw.vy;
  E.vz = sw.vz;
  E.broken = sw.broken;
  E.depth = sw.depth;
  if (cpu.fft) cpu.sea.eval(x, z, sw.depth, modes, E);
}

/** Update per-frame CPU time state. Zero-alloc; mode phases are computed lazily on first use. */
export function setCpuTime(cpu: OceanCpu, ticks: number) {
  cpu.ticks = ticks;
  cpu.sea.setTicks(ticks);
}

/** Forward: displaced position of rest point (x, z) into out[0..2]. For probes. */
export function forwardDisplace(cpu: OceanCpu, x: number, z: number, out: Float64Array) {
  evalAll(cpu, x, z, MAX_CPU_MODES);
  out[0] = x + E.dx;
  out[1] = E.dy;
  out[2] = z + E.dz;
  return out;
}

export function createOceanService(cpu: OceanCpu, _heightAt: (x: number, z: number) => number, gpu: Record<string, unknown>): OceanService {
  const swellDir = new Vector2(SWELL.dirX, SWELL.dirZ).normalize();

  const sample = (x: number, z: number, out: OceanSample) => sampleImpl(x, z, out, true);
  const sampleImpl = (x: number, z: number, out: OceanSample, full: boolean) => {
    // Newton-invert the horizontal displacement: find the rest point that lands on (x, z).
    // Start from one fixed-point step, then damped Newton (steps capped at 1.5 m) so steep,
    // nearly folded faces don't throw the iteration onto the wrong side of a crest.
    evalAll(cpu, x, z, CPU_DERIV_MODES);
    let x0 = x - E.dx;
    let z0 = z - E.dz;
    for (let it = 0; it < 8; it++) {
      evalAll(cpu, x0, z0, CPU_DERIV_MODES);
      const fx = x0 + E.dx - x;
      const fz = z0 + E.dz - z;
      if (fx * fx + fz * fz < 1e-6) break;
      const a = 1 + E.dxdx;
      const d = 1 + E.dzdz;
      const b = E.dxdz;
      let det = a * d - b * b;
      if (det < 0.15) det = 0.15;
      let sx = (d * fx - b * fz) / det;
      let sz = (a * fz - b * fx) / det;
      const sl = Math.sqrt(sx * sx + sz * sz);
      if (sl > 1.5) {
        sx *= 1.5 / sl;
        sz *= 1.5 / sl;
      }
      x0 -= sx;
      z0 -= sz;
    }
    // E holds the swell + strongest modes at the converged rest point; add the other modes' heights.
    if (cpu.fft && full) cpu.sea.evalRange(x0, z0, E.depth, E);
    const jx = 1 + E.dxdx;
    const jz = 1 + E.dzdz;
    const J = jx * jz - E.dxdz * E.dxdz;
    let nx = E.dydz * E.dxdz - jz * E.dydx;
    let ny = J > 0.05 ? J : 0.05;
    let nz = E.dxdz * E.dydx - E.dydz * jx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    out.height = E.dy;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    out.vx = E.vx;
    out.vy = E.vy;
    out.vz = E.vz;
    // Saturated surf zone near a crest reads as "breaking" until the breaker system refines it.
    const crest = E.dy > 0 ? Math.min(1, E.dy / 0.4) : 0;
    out.breaking = E.broken * crest;
    // Still-water depth from the baked field (the analytic terrain is too slow for per-frame use).
    out.depth = E.dy + E.depth;
    return out;
  };

  const wave = (x: number, z: number, out: WaveInfo) => {
    // Dominant train at this point.
    let best = 0;
    let bestAmp = -1;
    for (let tr = 0; tr < N_TRAINS; tr++) {
      trainAt(cpu.field, cpu.env, tr, x, z, cpu.rt, tp);
      if (tp.amp > bestAmp) {
        bestAmp = tp.amp;
        best = tr;
      }
    }
    trainAt(cpu.field, cpu.env, best, x, z, cpu.rt, tp);
    const kl = Math.sqrt(tp.kx * tp.kx + tp.kz * tp.kz) || 1e-6;
    const ux = tp.kx / kl;
    const uz = tp.kz / kl;
    const TAU = Math.PI * 2;
    const thc = TAU * Math.round(tp.theta / TAU);
    out.dirX = ux;
    out.dirZ = uz;
    out.crestDistance = (thc - tp.theta) / kl;
    out.faceHeight = 2 * tp.amp;
    // How close this wave is to breaking here (1 at the breaking index, or once broken).
    const r = (2 * tp.ampUnbroken) / (GAMMA_BREAK * Math.max(tp.depth, 0.05));
    out.stage = Math.max(tp.broken, smoothstep(0.55, 1, r));
    // Peel: along the crest toward deeper water (the unbroken shoulder), at c / tan β where β
    // is the angle between the wave direction and the depth gradient.
    const e = 3;
    depthAt(cpu.field, x + e, z, dq);
    let gx = dq[0];
    depthAt(cpu.field, x - e, z, dq);
    gx -= dq[0];
    depthAt(cpu.field, x, z + e, dq);
    let gz = dq[0];
    depthAt(cpu.field, x, z - e, dq);
    gz -= dq[0];
    const gl = Math.sqrt(gx * gx + gz * gz);
    let tx = -uz;
    let tz = ux;
    if (gl > 1e-6 && tx * gx + tz * gz < 0) {
      tx = -tx;
      tz = -tz;
    }
    out.peelX = tx;
    out.peelZ = tz;
    if (gl > 1e-6) {
      const cosB = Math.abs((ux * gx + uz * gz) / gl);
      const sinB = Math.sqrt(Math.max(1e-6, 1 - cosB * cosB));
      out.peelSpeed = Math.min(30, (tp.omega / kl) * (cosB / sinB));
    } else out.peelSpeed = 0;
    out.hollowness = 0;
    return out;
  };

  /** Swell + strongest 256 sea modes only (≈ 2–3 cm RMS, ~2× cheaper): foam, spray, triggers. */
  gpu.sampleCoarse = (x: number, z: number, out: OceanSample) => sampleImpl(x, z, out, false);
  return { sample, wave, swellDir, gpu };
}
