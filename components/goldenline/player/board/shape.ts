// The board's design: a 7'0" funboard / mid-length, lofted from outline, rocker and foil curves.
// Reads better in first person than a shortboard: the nose sits ~0.8 m ahead of the chin.
// All distances are metres, measured in the board frame (see api.ts BoardSpec).

import type { BoardSpec } from '../api';

export const BOARD_LENGTH = 2.134; // 7'0"
const L = BOARD_LENGTH;

// Outline as (distance from tail, half-width). Interpolated as half-width squared, so the
// round tail and nose come out as true arcs (hw ≈ sqrt(2 R d) at the tips).
const OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.05, 0.133],
  [0.15, 0.172],
  [0.3, 0.198],
  [0.55, 0.233],
  [0.85, 0.261],
  [1.1, 0.273],
  [1.35, 0.268],
  [1.6, 0.248],
  [1.83, 0.213],
  [1.98, 0.166],
  [2.08, 0.104],
  [L, 0],
];
const TAIL_R = 0.2;
const NOSE_R = 0.12;

// Foil: total thickness along the length.
const FOIL: ReadonlyArray<readonly [number, number]> = [
  [0, 0.016],
  [0.08, 0.029],
  [0.3, 0.046],
  [0.6, 0.062],
  [1.0, 0.07],
  [1.3, 0.068],
  [1.65, 0.055],
  [1.9, 0.041],
  [2.05, 0.029],
  [L, 0.013],
];

const FLAT_SPOT = 0.95; // distance from tail where the rocker is lowest
const TAIL_ROCKER = 0.055;
const NOSE_ROCKER = 0.118;

/** Cubic Hermite through (x, y) pairs with Catmull-Rom tangents; optional end slopes. */
function hermite(pts: ReadonlyArray<readonly [number, number]>, x: number, slope0?: number, slope1?: number) {
  const n = pts.length;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let i = 0;
  while (i < n - 2 && x > pts[i + 1][0]) i++;
  const [x0, y0] = pts[i];
  const [x1, y1] = pts[i + 1];
  const h = x1 - x0;
  const tan = (k: number) => {
    if (k === 0 && slope0 !== undefined) return slope0;
    if (k === n - 1 && slope1 !== undefined) return slope1;
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(n - 1, k + 1)];
    return (b[1] - a[1]) / (b[0] - a[0]);
  };
  const m0 = tan(i) * h;
  const m1 = tan(i + 1) * h;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
}

const OUTLINE_SQ: Array<[number, number]> = OUTLINE.map(([d, w]) => [d, w * w]);

/** Half-width at distance d from the tail. */
export function halfWidth(d: number) {
  if (d <= 0 || d >= L) return 0;
  const g = hermite(OUTLINE_SQ, d, 2 * TAIL_R, -2 * NOSE_R);
  return Math.sqrt(Math.max(0, g));
}

/** Bottom height of the centreline (rocker), 0 at the flat spot. */
export function rocker(d: number) {
  if (d < FLAT_SPOT) return TAIL_ROCKER * Math.pow((FLAT_SPOT - d) / FLAT_SPOT, 2.3);
  return NOSE_ROCKER * Math.pow((d - FLAT_SPOT) / (L - FLAT_SPOT), 2.5);
}

export function thickness(d: number) {
  return hermite(FOIL, d);
}

/** Rail apex height as a fraction of the thickness: a lower, harder 60/40 rail in the tail. */
export function apexFrac(d: number) {
  const s = d / L;
  return 0.3 + 0.13 * s;
}

/** Superellipse exponents of the deck (dome) and bottom (flat with a tucked edge). */
export function deckExp(d: number) {
  return 2.9 + 0.3 * (1 - d / L);
}
export function bottomExp(d: number) {
  const s = d / L;
  return 3.6 + 4.4 * (1 - s) * (1 - s);
}

/**
 * Cross-section point at station d for section angle phi (0 = +Z rail apex, PI/2 = deck
 * centre, PI = -Z rail apex, 3PI/2 = bottom centre). Writes board-frame (x, y, z).
 */
export function sectionPoint(d: number, phi: number, out: Float64Array | number[]) {
  const a = halfWidth(d);
  const t = thickness(d);
  const r = rocker(d);
  const af = apexFrac(d);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const top = s >= 0;
  const n = top ? deckExp(d) : bottomExp(d);
  const u = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
  const v = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
  const yApex = r + t * af;
  const y = top ? yApex + v * t * (1 - af) : yApex + v * t * af;
  // A whisper of bottom vee in the tail (single-to-vee), fading out ahead of the fins.
  const vee = top ? 0 : 0.004 * Math.max(0, 1 - d / 0.7) * (1 - Math.abs(u));
  out[0] = d - L / 2;
  out[1] = y - vee;
  out[2] = u * a;
}

export const boardSpec: BoardSpec = {
  length: L,
  deckY: rocker(L / 2) + thickness(L / 2),
  halfWidth: halfWidth(L / 2),
  deckAt(x: number) {
    const d = x + L / 2;
    return rocker(d) + thickness(d);
  },
  halfWidthAt(x: number) {
    return halfWidth(x + L / 2);
  },
};
