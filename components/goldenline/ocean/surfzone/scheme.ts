// The surf-zone shallow-water scheme on the CPU: the reference the GPU kernels (kernels.ts)
// mirror line by line, and what scheme.spec.ts tests (lake at rest, mass, dam breaks, run-up).
//
// Nonlinear shallow-water equations on a staggered grid (Stelling & Duinmeijer 2003):
//   depth h at cell centres, bed b at cell centres, free surface η = h + b,
//   u on x-faces (u[k] sits between cell k and cell k + 1), v on z-faces (between k and k + nx).
// One step = momentum on every face from the old state, then continuity on every cell with the
// new velocities. Face depths are upwinded (η of the upstream cell minus the higher of the two
// beds), which makes the scheme well-balanced (a lake at rest stays at rest over any bed), keeps
// depths non-negative under CFL, and floods/dries cells without special cases. Advection is the
// momentum-conservative form q·∂u/∂x = ∂(q·u)/∂x − u·∂q/∂x, so bores travel at the right speed:
// the whole point here is that a broken wave keeps its momentum and runs up the beach.

export const G = 9.81;
/** A face carries flow only where the flooding depth exceeds this (m). */
export const EPS = 1e-3;
/** Velocity cap (m/s): a safety net at thin wet/dry fronts, never reached in normal flow. */
export const UMAX = 10;

/**
 * Infiltration (m/s) into unsaturated sand above sea level: the swash soaks in within seconds,
 * which is why the upper beach dries between waves and the backwash is weaker than the uprush.
 * Fades in over the first half metre above the still-water line (the water table).
 */
export const INFILTRATION = 0.004;

/**
 * Breaking (Kennedy et al. 2000): where the surface rises faster than BREAK_ONSET·√(gh) a front
 * is breaking, and an eddy viscosity ν = 1.44·h·∂η/∂t (capped at NU_MAX, and at the
 * explicit-diffusion limit of the grid it runs on, see NU_STAB) takes its energy
 * out as the turbulence would. Without it the waves reached the steep beach face unbroken,
 * surged up it and reflected into a standing wave.
 */
export const BREAK_ONSET = 0.3;
export const NU_MAX = 1.8;
/** Fraction of the explicit-diffusion limit ν·dt·(1/dx² + 1/dz²) ≤ ½ the viscosity may use: the advective Courant number (~0.4) takes the rest. */
export const NU_STAB = 0.25;
/** Stable viscosity ceiling for step dt on cells dx × dz. */
export const nuCap = (dt: number, dx: number, dz: number) => Math.min(NU_MAX, NU_STAB / (dt * (1 / (dx * dx) + 1 / (dz * dz))));
/**
 * Only in water deeper than BREAK_H0…BREAK_H1: at a thin front √(gh) → 0, so the criterion fired at
 * every run-up tip and braked exactly the uprush that should carry the wave up the beach.
 */
export const BREAK_H0 = 0.1;
export const BREAK_H1 = 0.3;
const breakNu = (hbar: number, etT: number, gain: number, cap: number) => {
  const thr = BREAK_ONSET * Math.sqrt(G * hbar);
  const u = Math.min(1, Math.max(0, (etT - thr) / thr));
  const d = Math.min(1, Math.max(0, (hbar - BREAK_H0) / (BREAK_H1 - BREAK_H0)));
  return Math.min(u * u * (3 - 2 * u) * d * d * (3 - 2 * d) * 1.44 * hbar * etT * gain, cap);
};
export const infiltrationAt = (b: number) => {
  const u = Math.min(1, Math.max(0, (b - 0.05) / 0.45));
  return INFILTRATION * u * u * (3 - 2 * u);
};

export interface SWGrid {
  nx: number;
  nz: number;
  dx: number;
  dz: number;
  /** Bed height (m), cell centres. */
  b: Float32Array;
  /** Water depth (m), cell centres. */
  h: Float32Array;
  /** x-face velocity (m/s): face between cell k and k + 1 (0 on the last column: wall). */
  u: Float32Array;
  /** z-face velocity (m/s): face between cell k and k + nx (0 on the last row: wall). */
  v: Float32Array;
}

export function createGrid(nx: number, nz: number, dx: number, dz: number): SWGrid {
  const n = nx * nz;
  return { nx, nz, dx, dz, b: new Float32Array(n), h: new Float32Array(n), u: new Float32Array(n), v: new Float32Array(n) };
}

/** Upwind depth on the x-face right of cell k for velocity `vel` (0 when dry). */
function hxFace(g: SWGrid, k: number, vel: number) {
  const bb = g.b[k] > g.b[k + 1] ? g.b[k] : g.b[k + 1];
  const e = vel > 0 ? g.h[k] + g.b[k] : vel < 0 ? g.h[k + 1] + g.b[k + 1] : Math.max(g.h[k] + g.b[k], g.h[k + 1] + g.b[k + 1]);
  const d = e - bb;
  return d > 0 ? d : 0;
}

function hzFace(g: SWGrid, k: number, vel: number) {
  const k2 = k + g.nx;
  const bb = g.b[k] > g.b[k2] ? g.b[k] : g.b[k2];
  const e = vel > 0 ? g.h[k] + g.b[k] : vel < 0 ? g.h[k2] + g.b[k2] : Math.max(g.h[k] + g.b[k], g.h[k2] + g.b[k2]);
  const d = e - bb;
  return d > 0 ? d : 0;
}

/** x-flux through the face right of cell (i, j), 0 outside the grid. */
function qx(g: SWGrid, i: number, j: number) {
  if (i < 0 || i >= g.nx - 1) return 0;
  const k = i + j * g.nx;
  return hxFace(g, k, g.u[k]) * g.u[k];
}

function qz(g: SWGrid, i: number, j: number) {
  if (j < 0 || j >= g.nz - 1) return 0;
  const k = i + j * g.nx;
  return hzFace(g, k, g.v[k]) * g.v[k];
}

const uAt = (g: SWGrid, i: number, j: number) => (i < 0 || i >= g.nx - 1 || j < 0 || j >= g.nz ? 0 : g.u[i + j * g.nx]);
const vAt = (g: SWGrid, i: number, j: number) => (j < 0 || j >= g.nz - 1 || i < 0 || i >= g.nx ? 0 : g.v[i + j * g.nx]);

/**
 * Momentum on every face, old state in `g`, new velocities into `uN`/`vN`.
 * `manning` n (s/m^(1/3)); bottom friction is implicit.
 */
export function stepMomentum(g: SWGrid, dt: number, manning: number, uN: Float32Array, vN: Float32Array, breaking = 1) {
  const { nx, nz, dx, dz, h, b } = g;
  const n2g = G * manning * manning;
  const cap = nuCap(dt, dx, dz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = i + j * nx;
      // ── x-face (i + ½, j) ──
      if (i < nx - 1) {
        const eL = h[k] + b[k];
        const eR = h[k + 1] + b[k + 1];
        const bb = b[k] > b[k + 1] ? b[k] : b[k + 1];
        const hf = (eL > eR ? eL : eR) - bb;
        if (hf <= EPS) uN[k] = 0;
        else {
          const u0 = g.u[k];
          const hbar = Math.max(0.5 * (h[k] + h[k + 1]), EPS);
          // Cell-centred fluxes of the two cells this face joins, and upwind cell velocities.
          const qc0 = 0.5 * (qx(g, i - 1, j) + qx(g, i, j));
          const qc1 = 0.5 * (qx(g, i, j) + qx(g, i + 1, j));
          const us0 = qc0 >= 0 ? uAt(g, i - 1, j) : u0;
          const us1 = qc1 >= 0 ? u0 : uAt(g, i + 1, j);
          const adv = (qc1 * us1 - qc0 * us0 - u0 * (qc1 - qc0)) / (dx * hbar);
          // Cross advection v·∂u/∂z, first-order upwind (v averaged onto the face).
          const vb = 0.25 * (vAt(g, i, j) + vAt(g, i + 1, j) + vAt(g, i, j - 1) + vAt(g, i + 1, j - 1));
          const dudz = vb > 0 ? (j > 0 ? u0 - g.u[k - nx] : 0) : j < nz - 1 ? g.u[k + nx] - u0 : 0;
          let un = u0 - dt * (G * (eR - eL) / dx + adv + (vb * dudz) / dz);
          const qM = qx(g, i - 1, j);
          const q0 = qx(g, i, j);
          const qP = qx(g, i + 1, j);
          const nu = breakNu(hbar, Math.max(-(q0 - qM), -(qP - q0)) / dx, breaking, cap);
          const uzP = j < nz - 1 ? g.u[k + nx] : u0;
          const uzM = j > 0 ? g.u[k - nx] : u0;
          // Momentum-conservative along the flow, (1/h)·∂x(ν·h·∂x u): the plain Laplacian braked
          // the bore where the depth jumps across it (11 % slow in the dam break).
          un += dt * nu * ((h[k + 1] * (uAt(g, i + 1, j) - u0) - h[k] * (u0 - uAt(g, i - 1, j))) / (hbar * dx * dx) + (uzP + uzM - 2 * u0) / (dz * dz));
          un /= 1 + (dt * n2g * Math.abs(un)) / Math.pow(hf, 4 / 3);
          uN[k] = un > UMAX ? UMAX : un < -UMAX ? -UMAX : un;
        }
      } else uN[k] = 0;
      // ── z-face (i, j + ½) ──
      if (j < nz - 1) {
        const k2 = k + nx;
        const eL = h[k] + b[k];
        const eR = h[k2] + b[k2];
        const bb = b[k] > b[k2] ? b[k] : b[k2];
        const hf = (eL > eR ? eL : eR) - bb;
        if (hf <= EPS) vN[k] = 0;
        else {
          const v0 = g.v[k];
          const hbar = Math.max(0.5 * (h[k] + h[k2]), EPS);
          const qc0 = 0.5 * (qz(g, i, j - 1) + qz(g, i, j));
          const qc1 = 0.5 * (qz(g, i, j) + qz(g, i, j + 1));
          const vs0 = qc0 >= 0 ? vAt(g, i, j - 1) : v0;
          const vs1 = qc1 >= 0 ? v0 : vAt(g, i, j + 1);
          const adv = (qc1 * vs1 - qc0 * vs0 - v0 * (qc1 - qc0)) / (dz * hbar);
          const ub = 0.25 * (uAt(g, i, j) + uAt(g, i, j + 1) + uAt(g, i - 1, j) + uAt(g, i - 1, j + 1));
          const dvdx = ub > 0 ? (i > 0 ? v0 - g.v[k - 1] : 0) : i < nx - 1 ? g.v[k + 1] - v0 : 0;
          let vn = v0 - dt * (G * (eR - eL) / dz + adv + (ub * dvdx) / dx);
          const qM = qz(g, i, j - 1);
          const q0 = qz(g, i, j);
          const qP = qz(g, i, j + 1);
          const nu = breakNu(hbar, Math.max(-(q0 - qM), -(qP - q0)) / dz, breaking, cap);
          const vxP = i < nx - 1 ? g.v[k + 1] : v0;
          const vxM = i > 0 ? g.v[k - 1] : v0;
          vn += dt * nu * ((h[k + nx] * (vAt(g, i, j + 1) - v0) - h[k] * (v0 - vAt(g, i, j - 1))) / (hbar * dz * dz) + (vxP + vxM - 2 * v0) / (dx * dx));
          vn /= 1 + (dt * n2g * Math.abs(vn)) / Math.pow(hf, 4 / 3);
          vN[k] = vn > UMAX ? UMAX : vn < -UMAX ? -UMAX : vn;
        }
      } else vN[k] = 0;
    }
  }
}

/**
 * Continuity on every cell with the new face velocities `uN`/`vN` (old depths in `g`), into `hN`,
 * then infiltration (`soak` = 0 turns it off).
 */
export function stepContinuity(g: SWGrid, dt: number, uN: Float32Array, vN: Float32Array, hN: Float32Array, soak = 1) {
  const { nx, nz, dx, dz, h } = g;
  const fx = (i: number, j: number) => {
    if (i < 0 || i >= nx - 1) return 0;
    const k = i + j * nx;
    return hxFace(g, k, uN[k]) * uN[k];
  };
  const fz = (i: number, j: number) => {
    if (j < 0 || j >= nz - 1) return 0;
    const k = i + j * nx;
    return hzFace(g, k, vN[k]) * vN[k];
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = i + j * nx;
      const dh = (fx(i, j) - fx(i - 1, j)) / dx + (fz(i, j) - fz(i, j - 1)) / dz;
      const hn = h[k] - dt * dh - dt * soak * infiltrationAt(g.b[k]);
      hN[k] = hn > 0 ? hn : 0;
    }
  }
}

/** Scratch for step(): allocate once per grid. */
export interface SWScratch {
  u: Float32Array;
  v: Float32Array;
  h: Float32Array;
}

export const createScratch = (g: SWGrid): SWScratch => ({ u: new Float32Array(g.h.length), v: new Float32Array(g.h.length), h: new Float32Array(g.h.length) });

/** One full step in place. */
export function step(g: SWGrid, dt: number, manning: number, s: SWScratch, soak = 1, breaking = 1) {
  stepMomentum(g, dt, manning, s.u, s.v, breaking);
  stepContinuity(g, dt, s.u, s.v, s.h, soak);
  g.u.set(s.u);
  g.v.set(s.v);
  g.h.set(s.h);
}

/** Largest stable step (s) for Courant number `cfl` on the current state. */
export function stableDt(g: SWGrid, cfl = 0.4) {
  let smax = 1e-6;
  for (let k = 0; k < g.h.length; k++) {
    const s = Math.sqrt(G * g.h[k]) + Math.max(Math.abs(g.u[k]), Math.abs(g.v[k]));
    if (s > smax) smax = s;
  }
  return (cfl * Math.min(g.dx, g.dz)) / smax;
}

/** Total water volume (m³). */
export function volume(g: SWGrid) {
  let s = 0;
  for (let k = 0; k < g.h.length; k++) s += g.h[k];
  return s * g.dx * g.dz;
}
