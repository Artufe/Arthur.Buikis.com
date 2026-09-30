// The surf-zone grid: a fixed, world-aligned rectangle over the lagoon, the beach face and the
// run-up, the whole length of the beach. See README.md.

/** Seaward edge (in the lagoon, clear of the reef flat) and landward edge (above any run-up), m. */
export const X0 = -46;
export const X1 = 22;
/** Along-shore extent, m (the beach between the headlands). */
export const Z0 = -260;
export const Z1 = 180;
/** Cell size: fine across the shore (the swash is thin and fast), coarser along it. */
export const DX = 0.25;
export const DZ = 0.5;
export const NX = Math.round((X1 - X0) / DX);
export const NZ = Math.round((Z1 - Z0) / DZ);

/**
 * Relaxation zone at the seaward edge (m): the state is nudged toward the incident swell, which
 * both makes the waves and absorbs what the beach reflects. Sponges at both along-shore ends do
 * the same, so nothing reflects off the grid's sides. The rendered surface blends from the swell
 * to the simulation across the inner half of the relaxation zone.
 */
export const RELAX_X = 16;
export const SPONGE_Z = 16;
/** Nudging rate (1/s) where the relaxation weight is 1. */
export const RELAX_RATE = 12;

/** Target substep (s): Courant ≈ 0.35 in the 4.5 m pier channel. */
export const SUBSTEP = 1 / 118;
export const MAX_SUBSTEPS = 6;

/** Manning's n (s/m^(1/3)) of the sand: bottom friction, what stalls the run-up. */
export const MANNING = 0.022;

/** Depth (m) below which a cell counts as dry sand (for rendering, wetting and foam). */
export const H_DRY = 0.003;

/** 0-1 relaxation weight at world (x, z): 1 at the edges, 0 inside. */
export function relaxWeight(x: number, z: number) {
  const ax = Math.max(0, 1 - (x - X0) / RELAX_X);
  const az = Math.max(0, 1 - (z - Z0) / SPONGE_Z, 1 - (Z1 - z) / SPONGE_Z);
  const w = Math.max(ax, az);
  return w * w;
}

/** 0-1 weight of the simulation in the rendered surface (0 = the swell, 1 = the simulation). */
export function renderWeight(x: number, z: number) {
  const s = (a: number, b: number, t: number) => {
    const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  return s(X0 + RELAX_X * 0.35, X0 + RELAX_X * 0.85, x) * s(Z0 + SPONGE_Z * 0.35, Z0 + SPONGE_Z * 0.85, z) * s(Z1 - SPONGE_Z * 0.35, Z1 - SPONGE_Z * 0.85, z) * (1 - s(X1 - 1, X1, x));
}

/**
 * The swell arriving here is the unbroken train sum, up to ~0.78·h high (1.7 m faces in the
 * 2.3 m lagoon during a set). Real waves lose most of that crossing the reef flat and the
 * lagoon; fed in raw, the beach reflected them into 2.7 m standing waves whose run-up climbed
 * to the top of the domain. The swell is scaled by `surfzone.gain` over an approach band ending
 * at the seaward edge, and the simulation is driven with the scaled swell.
 */
export const APPROACH_X0 = X0 - 30;
export const DEFAULT_GAIN = 0.5;

/** 1 seaward of the approach band, ramping to `gain` at the seaward edge and inside. */
export function swellGain(x: number, gain: number) {
  const u = Math.min(1, Math.max(0, (x - APPROACH_X0) / (X0 - APPROACH_X0)));
  return 1 + (gain - 1) * u * u * (3 - 2 * u);
}

/** Readback window around the camera: WIN × WIN samples at WIN_STEP m (for ocean.sample()). */
export const WIN = 64;
export const WIN_STEP = 0.5;
