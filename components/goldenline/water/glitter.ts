// Stochastic sun glints: the sparkle the smooth variance lobe averages away.
//
// Where the surface's slope detail is below the pixel (the mips filtered it into `lostVar`), a
// pixel really sees a handful of capillary facets, and only the rare one tilted exactly toward the
// sun lights up. We tile the REST plane with cells about two pixel footprints wide (two power-of-two
// levels, blended, so nothing pops as the camera moves), give each cell one random facet drawn from
// the unresolved slope distribution N(mean, σ²), and light a soft spot in the cell when that facet
// reflects the sun (within δ, the facet's curvature + the sun's disc). The spot is divided by its
// expected value, so the average over many cells equals the smooth lobe exactly: energy is only
// redistributed into sparks, and the soft knee rolls each spark off. Cells live in rest space
// (they ride the waves, never the screen) and redraw their facet every `tau` seconds with a
// crossfade, so glints twinkle rather than crawl, and TRAA sees them for several frames.

import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';

const { cos, dFdx, dFdy, dot, exp, exp2, float, floor, fract, length, log, log2, max, min, mix, sin, smoothstep, sqrt, vec2, vec3 } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

export interface GlintUniforms {
  /** Master gain on the sparkle share (0 = smooth lobe only). */
  amount: TSLNode;
  /** Facet acceptance δ (slope units). */
  size: TSLNode;
  /** Cell size in pixel footprints. */
  cells: TSLNode;
  /** Seconds between facet redraws. */
  tau: TSLNode;
  time: TSLNode;
}

/** PCG-ish 3→3 hash in [0,1). */
function hash33(p: TSLNode) {
  const q = fract(p.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  const d = dot(q, q.yxz.add(33.33));
  const r = q.add(d);
  return fract(vec3(r.x.add(r.y).mul(r.z), r.x.add(r.z).mul(r.y), r.y.add(r.z).mul(r.x)));
}

/** Box–Muller: two uniforms → one 2D standard normal sample. */
function gauss2(u: TSLNode) {
  const r = sqrt(log(max(u.x, 1e-6)).mul(-2));
  const a = u.y.mul(Math.PI * 2);
  return vec2(r.mul(cos(a)), r.mul(sin(a)));
}

/** Pixel footprint on the rest plane (m): uniform control flow (dFdx). */
export function glintFootprint(rest: TSLNode) {
  const fx = length(dFdx(rest));
  const fy = length(dFdy(rest));
  return sqrt(max(fx, 1e-5).mul(max(fy, 1e-5)));
}

/**
 * The factor to multiply the smooth sun lobe by (mean 1 over many cells). Pure ALU, so it can
 * run inside a branch. `N` is the resolved normal, `H` the half vector, `lostVar` the unresolved
 * slope variance (sx² + sz²), `footprint` from glintFootprint().
 */
export function glintFactor(u: GlintUniforms, rest: TSLNode, footprint: TSLNode, N: TSLNode, H: TSLNode, lostVar: TSLNode) {
  const fp = footprint.mul(u.cells).toVar();
  const lv = log2(fp.div(0.004)).toVar();
  const l0 = floor(lv);
  const fr = lv.sub(l0).toVar();
  const sigma = sqrt(lostVar.mul(0.5)).toVar(); // per-axis σ
  const delta = u.size;
  const sMean = vec2(N.x.negate(), N.z.negate()).div(max(N.y, 0.2));
  const sH = vec2(H.x.negate(), H.z.negate()).div(max(H.y, 0.05));
  const dm = sMean.sub(sH);
  const s2 = sigma.mul(sigma).add(delta.mul(delta));
  // E[hit] for a facet ~ N(mean, σ²) against exp(−|s − s_h|²/2δ²)
  const eHit = delta.mul(delta).div(s2).mul(exp(dot(dm, dm).div(s2.mul(-2)))).max(1e-6);
  const spotR = 0.32;
  const eSpot = Math.PI * spotR * spotR * 0.55; // soft-edged disc
  const tt = u.time.div(u.tau);

  const level = (lvl: TSLNode) => {
    const size = exp2(lvl).mul(0.004);
    const q = rest.div(size);
    const cell = floor(q);
    const local = fract(q);
    const h0 = hash33(vec3(cell, lvl.mul(17.1)));
    // per-cell epoch phase so cells don't all redraw on the same frame
    const t = tt.add(h0.z);
    const e = floor(t);
    const w = smoothstep(0, 1, fract(t));
    const draw = (epoch: TSLNode) => {
      const h = hash33(vec3(cell.x.add(epoch.mul(31.7)), cell.y.sub(epoch.mul(17.3)), lvl.add(epoch.mul(3.1))));
      const hs = hash33(h.mul(97.3).add(vec3(cell, epoch)));
      const s = sMean.add(gauss2(h.xy).mul(sigma));
      const ds = s.sub(sH);
      const hit = exp(dot(ds, ds).div(delta.mul(delta).mul(-2)));
      const c = vec2(hs.x, hs.y).mul(0.6).add(0.2);
      const spot = float(1).sub(smoothstep(spotR * 0.35, spotR, length(local.sub(c))));
      return hit.mul(spot);
    };
    return mix(draw(e), draw(e.add(1)), w);
  };
  const g = mix(level(l0), level(l0.add(1)), fr).div(eHit.mul(eSpot));
  // Only where the facets are unresolved (σ ≫ δ); near the camera the real normals glint.
  const share = smoothstep(0.7, 2.5, sigma.div(delta)).mul(u.amount);
  return mix(float(1), min(g, 400), share);
}

