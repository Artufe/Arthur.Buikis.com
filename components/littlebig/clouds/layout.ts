// Cloud layout (A3): seeded puff clusters on the cloud shell, as pure data (no three.js).
//
// A cluster is a little cumulus: a flat base at `base` m above sea level, a big central puff and a
// ring of smaller ones whose centres rise toward the middle, so it reads as one puffy cloud from
// orbit and as separate puffs streaming past from inside. Placement keeps the city readable from
// orbit: no clusters over the middle of the city, only a few small ones over its outskirts, and the
// usual scatter beyond. `anchors` force a cluster at given directions (the clouds system puts one
// where the scripted dive crosses the layer, and two that frame the `clouds` shot).
//
// The layout lives in the cloud frame; the clouds system rotates that frame slowly about the city's
// axis (drift), so the coverage over the city never changes with time.

import { CITY_LAT, CITY_LON, CLOUD_MAX, CLOUD_MIN, R } from '../world/config';
import { Rng } from '../world/rng';
import { addScaled3, angleBetween, cross3, dirFromLatLon, dot3, normalize3, v3, type Vec3 } from '../world/sphere';

export interface CloudAnchor {
  /** Unit direction of the cluster centre. */
  dir: Vec3;
  /** Footprint radius (m). */
  radius: number;
  /** Base altitude above sea level (m). */
  base: number;
  /**
   * A ring with an open middle (no crown): for a camera that hovers in the layer looking down
   * through the gap (the `clouds` shot). The ring sits at 0.6–0.9 × radius.
   */
  hole?: boolean;
  /** Cap on every puff's top (m above sea level): a lower crown. */
  top?: number;
  /**
   * Extra puffs placed exactly (part of the cluster): e.g. the small lobe the scripted dive cuts
   * through, so the camera clips the cloud's edge while its body stays beside the track.
   */
  extra?: Array<{ dir: Vec3; alt: number; r: number }>;
  /** Only the `extra` puffs, no generated cumulus (a small cloudlet). */
  bare?: boolean;
}

export interface CloudCluster {
  dir: Vec3;
  /** Footprint radius (m) on the cloud shell. */
  radius: number;
  /** Flat base, m above sea level. */
  base: number;
  /** Highest puff top, m above sea level. */
  top: number;
  /** Index of the first puff and number of puffs. */
  first: number;
  count: number;
}

export interface CloudLayout {
  clusters: CloudCluster[];
  /** Per puff: centre x, y, z (world, cloud frame), radius. */
  puffs: Float32Array;
  /** Per puff: cluster index. */
  cluster: Uint16Array;
  /** Per puff: a stable random phase in [0, 1) (breathing, reveal order). */
  phase: Float32Array;
  count: number;
}

export interface LayoutOptions {
  seed: number;
  /** Number of scattered clusters (anchors come on top). */
  clusters: number;
  anchors?: CloudAnchor[];
}

export const CITY_AXIS: Readonly<Vec3> = dirFromLatLon(CITY_LAT, CITY_LON);
/** No scattered cluster centre within this angle of the city centre (rad, ≈ 49 m). */
export const CITY_CLEAR = 0.3;
/** Between CITY_CLEAR and this angle only small clusters, sparsely (the outskirts). */
export const CITY_SPARSE = 0.62;
/** Mean radius of the cloud shell (m from the planet centre). */
export const SHELL_R = R + (CLOUD_MIN + CLOUD_MAX) / 2;

/** Puff radius range (m): 6–20 m across. */
export const PUFF_MIN = 3;
export const PUFF_MAX = 10;

export function layoutClouds(o: LayoutOptions): CloudLayout {
  const clusters: CloudCluster[] = [];
  const puffList: number[] = [];
  const clusterOf: number[] = [];
  const phases: number[] = [];

  const add = (dir: Vec3, radius: number, base: number, crng: Rng, a?: CloudAnchor) => {
    const first = clusterOf.length;
    const ci = clusters.length;
    let top = a?.bare ? base : a?.hole ? buildRing(dir, radius, base, crng, puffList, phases) : buildCluster(dir, radius, base, crng, puffList, phases, a?.top);
    for (const e of a?.extra ?? []) {
      const d = normalize3(v3(), e.dir);
      const rad = R + e.alt;
      puffList.push(d.x * rad, d.y * rad, d.z * rad, e.r);
      phases.push(crng.float());
      top = Math.max(top, e.alt + e.r);
    }
    const count = phases.length - first;
    for (let k = 0; k < count; k++) clusterOf.push(ci);
    clusters.push({ dir, radius, base, top, first, count });
  };

  // Anchors first (their puffs come first in the arrays). The scatter is sampled from its OWN
  // stream, independent of the anchors, then any scatter cluster that overlaps an anchor is
  // dropped: moving the dive or a shot never reshuffles the clouds elsewhere on the planet.
  const anchors = (o.anchors ?? []).map((a) => ({ ...a, dir: normalize3(v3(), a.dir) }));
  for (const a of anchors) add(a.dir, a.radius, a.base, Rng.for(o.seed, `cloud-anchor-${clusters.length}`), a);

  const scatter = scatterClusters(o.seed, o.clusters);
  for (let k = 0; k < scatter.length; k++) {
    const c = scatter[k];
    let clash = false;
    for (const a of anchors) {
      if (angleBetween(a.dir, c.dir) * SHELL_R < a.radius + c.radius + 4) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    add(c.dir, c.radius, c.base, Rng.for(o.seed, `cloud-${k}`));
  }

  const n = phases.length;
  return {
    clusters,
    puffs: Float32Array.from(puffList),
    cluster: Uint16Array.from(clusterOf),
    phase: Float32Array.from(phases),
    count: n,
  };
}

/** The scattered clusters (centre, footprint, base), from their own seeded stream. */
export function scatterClusters(seed: number, count: number): Array<{ dir: Vec3; radius: number; base: number }> {
  const rng = Rng.for(seed, 'clouds');
  const out: Array<{ dir: Vec3; radius: number; base: number }> = [];
  let tries = 0;
  while (out.length < count && tries < count * 400) {
    tries++;
    const u = rng.float() * 2 - 1;
    const a = rng.float() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const dir = v3(s * Math.cos(a), u, s * Math.sin(a));
    const dc = angleBetween(dir, CITY_AXIS);
    if (dc < CITY_CLEAR) continue;
    let radius = rng.range(9, 21);
    if (dc < CITY_SPARSE) {
      if (!rng.chance(0.35)) continue;
      radius = rng.range(7, 11);
    }
    // Never let a footprint reach into the clear zone.
    if (dc * SHELL_R - radius < CITY_CLEAR * SHELL_R * 0.8) continue;
    let ok = true;
    for (const c of out) {
      if (angleBetween(c.dir, dir) * SHELL_R < c.radius + radius + 6) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    out.push({ dir, radius, base: rng.range(CLOUD_MIN, CLOUD_MIN + 3.5) });
  }
  return out;
}

const _e = v3();
const _n = v3();
const _p = v3();

/** Tangent basis + a puff writer for one cluster. */
function clusterWriter(dir: Vec3, base: number, rng: Rng, out: number[], phases: number[], elong: number, cap = Infinity) {
  const ref = Math.abs(dir.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  normalize3(_e, cross3(_e, ref, dir));
  cross3(_n, dir, _e);
  const rot = rng.float() * Math.PI;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const st = { top: base };
  const put = (x: number, z: number, r: number, lift: number) => {
    // Rotate the oval, map to the shell. Puff centres sit so their bottoms dip just under the base
    // (the shader squashes that part flat).
    const xr = (x * cr - z * sr) * elong;
    const zr = x * sr + z * cr;
    const h = Math.max(base - r * 0.15, Math.min(CLOUD_MAX + 3, base + r * 0.6 + lift, cap - r));
    const rad = R + h;
    addScaled3(_p, dir, _e, xr / rad);
    addScaled3(_p, _p, _n, zr / rad);
    normalize3(_p);
    out.push(_p.x * rad, _p.y * rad, _p.z * rad, r);
    phases.push(rng.float());
    st.top = Math.max(st.top, h + r);
  };
  return { put, st };
}

/** Puffs of one cumulus (a crown, an overlapping ring, a few fillers); returns the top altitude. */
function buildCluster(dir: Vec3, radius: number, base: number, rng: Rng, out: number[], phases: number[], cap?: number): number {
  const { put, st } = clusterWriter(dir, base, rng, out, phases, rng.range(1.0, 1.35), cap);
  // The crown: one or two big puffs near the middle.
  const big = Math.min(PUFF_MAX, Math.max(PUFF_MIN + 2, radius * rng.range(0.5, 0.62)));
  put(rng.range(-0.08, 0.08) * radius, rng.range(-0.08, 0.08) * radius, big, big * 0.3);
  if (radius > 12) put(rng.range(-0.3, 0.3) * radius, rng.range(-0.25, 0.25) * radius, big * rng.range(0.78, 0.9), big * 0.2);
  // The ring: overlapping puffs of uneven size and reach, so the silhouette is one bumpy cloud
  // (not a bunch of grapes, not a flower).
  const ring = Math.max(6, Math.round(radius / 2.1) + rng.int(0, 1));
  const a0 = rng.float() * Math.PI * 2;
  for (let k = 0; k < ring; k++) {
    const a = a0 + (k / ring) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const d = radius * rng.range(0.4, 0.74);
    const r = Math.max(PUFF_MIN, Math.min(PUFF_MAX, big * rng.range(0.5, 0.85)));
    put(Math.cos(a) * d, Math.sin(a) * d, r, rng.range(-0.4, 0.8));
  }
  // Fillers between crown and ring, plus a lump or two on top of the crown.
  const mid = Math.max(2, Math.round(ring / 2.5));
  for (let k = 0; k < mid; k++) {
    const a = a0 + ((k + rng.range(0.2, 0.8)) / mid) * Math.PI * 2;
    const d = radius * rng.range(0.22, 0.42);
    put(Math.cos(a) * d, Math.sin(a) * d, Math.max(PUFF_MIN, big * rng.range(0.66, 0.84)), big * rng.range(0.1, 0.3));
  }
  if (radius > 10) {
    const a = rng.float() * Math.PI * 2;
    put(Math.cos(a) * radius * 0.15, Math.sin(a) * radius * 0.15, big * rng.range(0.5, 0.62), big * 0.85);
  }
  return st.top;
}

/** An open ring of puffs (no crown): see CloudAnchor.hole. */
function buildRing(dir: Vec3, radius: number, base: number, rng: Rng, out: number[], phases: number[]): number {
  const { put, st } = clusterWriter(dir, base, rng, out, phases, 1);
  const n = Math.max(5, Math.round(radius / 2.1));
  const a0 = rng.float() * Math.PI * 2;
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const d = radius * rng.range(0.8, 1.0);
    put(Math.cos(a) * d, Math.sin(a) * d, rng.range(PUFF_MIN, PUFF_MIN + 1.6), rng.range(-0.6, 0.2));
  }
  return st.top;
}

/**
 * Splat the layout's coverage into an equirectangular map (R8: 0 clear … 255 full shadow), in the
 * cloud frame, for lbCloudShadow (render/toon.ts: u = atan(d.x, d.z) / 2π + 0.5, v = asin(d.y) / π
 * + 0.5). Each puff covers its disc (seen from above) with a soft edge; no blur pass (a crisp
 * shadow shape reads next to its cloud from orbit).
 */
export function coverageMap(layout: CloudLayout, w: number, h: number): Uint8Array {
  const acc = new Float32Array(w * h);
  const p = layout.puffs;
  const d = v3();
  for (let i = 0; i < layout.count; i++) {
    const x = p[i * 4];
    const y = p[i * 4 + 1];
    const z = p[i * 4 + 2];
    const r = p[i * 4 + 3];
    const len = Math.hypot(x, y, z);
    const cx = x / len;
    const cy = y / len;
    const cz = z / len;
    const ang = (r * 0.92) / len; // the puff's angular radius
    const lat = Math.asin(cy);
    const lon = Math.atan2(cx, cz);
    const v0 = Math.floor(((lat - ang * 1.3) / Math.PI + 0.5) * h);
    const v1 = Math.ceil(((lat + ang * 1.3) / Math.PI + 0.5) * h);
    const cosLat = Math.max(0.05, Math.cos(lat));
    const du = ((ang * 1.3) / cosLat / (2 * Math.PI)) * w;
    const uc = (lon / (2 * Math.PI) + 0.5) * w;
    for (let vy = Math.max(0, v0); vy <= Math.min(h - 1, v1); vy++) {
      const la = ((vy + 0.5) / h - 0.5) * Math.PI;
      for (let ux = Math.floor(uc - du); ux <= Math.ceil(uc + du); ux++) {
        const uw = ((ux % w) + w) % w;
        const lo = ((ux + 0.5) / w - 0.5) * 2 * Math.PI;
        d.x = Math.cos(la) * Math.sin(lo);
        d.y = Math.sin(la);
        d.z = Math.cos(la) * Math.cos(lo);
        const t = Math.acos(Math.max(-1, Math.min(1, d.x * cx + d.y * cy + d.z * cz))) / ang;
        if (t >= 1.22) continue;
        const c = t < 0.72 ? 1 : 1 - smooth01((t - 0.72) / 0.5);
        const k = vy * w + uw;
        acc[k] = Math.max(acc[k], c);
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, acc[i]) * 255);
  return out;
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Angle (rad) from the city centre to a direction: what the city-clear rules measure. */
export function cityAngle(dir: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot3(dir, CITY_AXIS))));
}
