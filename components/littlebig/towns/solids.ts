// The towns' buildings as height-aware solids (v2-BF): what the bird meets, walls and roofs, in every
// settlement but the capital. Built once from the plan's items (each footprint in its site's chart, its
// ground `y` and height `h`); queries are zero-alloc, a dot product per site and a bounding-circle
// reject per building before the footprint test.

import type { TownsService } from '../core/contracts';
import { CURB_H, R } from '../world/config';
import type { Region } from '../world/region/types';
import { chartToDir, dirToChart, type Vec3 } from '../world/sphere';
import { F, type Item, type Site, T } from './plan';

/** Floats per building: centre x, z, the axis' cos and sin, half sizes, roof top (m above sea level), bounding radius. */
const S = 8;
/** A garden's fence or hedge, a paddock's rails: the top over the plot's ground (m), the band's half width (m). */
const FENCE_TOP = 1.25;
const FENCE_BAND = 0.35;
/** The streets' paving: floats per segment (chart x0, z0, top0, x1, z1, top1, half width, sidewalk), the grid's cell (m). */
const P = 8;
const PCELL = 4;

/**
 * The top of an item's roof as the bird meets it (m above sea level). The capital's builders (houses,
 * shops, blocks, towers: towns/build `capital`) put their roofs over `h`: a gable or a hip is met half
 * way up its 2.5 m rise. The towns' own kinds include their roofs in `h`: a gable's ridge stands
 * ~0.6 m over the middle of its slopes. The chapel is its nave (its narrow tower is let through).
 */
function topOf(it: Item): number {
  const t = it.t;
  if (t === T.house || t === T.corner) return it.y + it.h + (t === T.corner || !(it.f & F.hip) ? 1.25 : 1.1);
  if (t <= T.tower) return it.y + it.h + (t === T.tower && it.h > 24 && !(it.f & F.tall) ? 0.8 : 0.4);
  if (t === T.chapel) return it.y + it.h * 0.6;
  if (t === T.townhouse || t === T.chalet || t === T.barn || t === T.shed || t === T.boathouse || t === T.hut || t === T.station) return it.y + it.h - 0.6;
  return it.y + it.h;
}

export function townSolids(sites: Site[], region?: Region): TownsService {
  const pq = { x: 0, z: 0 };
  const pd = { x: 0, y: 0, z: 0 };
  const data = sites.map((s) => {
    const items = s.items.filter((i) => i.t < T.tree);
    const f = new Float32Array(items.length * S);
    let reach = 0;
    items.forEach((it, k) => {
      const o = k * S;
      f[o] = it.x;
      f[o + 1] = it.z;
      f[o + 2] = Math.cos(it.a);
      f[o + 3] = Math.sin(it.a);
      f[o + 4] = it.w / 2;
      f[o + 5] = it.d / 2;
      f[o + 6] = topOf(it);
      f[o + 7] = Math.hypot(it.w, it.d) / 2;
      reach = Math.max(reach, Math.hypot(it.x, it.z) + f[o + 7]);
    });
    // (Gardens and paddocks: the same layout, the top their fence's or hedge's.)
    const yards = s.items.filter((i) => i.t === T.garden || i.t === T.paddock);
    const g = new Float32Array(yards.length * S);
    yards.forEach((it, k) => {
      const o = k * S;
      g[o] = it.x;
      g[o + 1] = it.z;
      g[o + 2] = Math.cos(it.a);
      g[o + 3] = Math.sin(it.a);
      g[o + 4] = it.w / 2;
      g[o + 5] = it.d / 2;
      g[o + 6] = it.y + FENCE_TOP;
      g[o + 7] = Math.hypot(it.w, it.d) / 2;
    });
    // (Its streets: each road's samples in the site's chart, the asphalt's top per sample, on a grid.)
    const k = region ? region.settlements.findIndex((x) => x.id === s.id) : -1;
    const segs: number[] = [];
    if (region && k >= 0) {
      for (const e of region.edges) {
        if (e.settlement !== k) continue;
        const D = e.centre.dir;
        const H = e.centre.h;
        for (let i = 0; i + 1 < H.length; i++) {
          pd.x = D[3 * i];
          pd.y = D[3 * i + 1];
          pd.z = D[3 * i + 2];
          dirToChart(s.chart, pd, pq);
          const x0 = pq.x;
          const z0 = pq.z;
          pd.x = D[3 * i + 3];
          pd.y = D[3 * i + 4];
          pd.z = D[3 * i + 5];
          dirToChart(s.chart, pd, pq);
          segs.push(x0, z0, H[i], pq.x, pq.z, H[i + 1], e.width / 2, e.sidewalk);
        }
      }
    }
    const pv = Float64Array.from(segs);
    const half = Math.ceil((s.r + 20) / PCELL);
    const N = half * 2;
    const counts = new Int32Array(N * N + 1);
    const each = (fn: (c: number, o: number) => void) => {
      for (let o = 0; o < pv.length; o += P) {
        const m = pv[o + 6] + pv[o + 7];
        const x0 = Math.max(0, Math.floor((Math.min(pv[o], pv[o + 3]) - m) / PCELL) + half);
        const x1 = Math.min(N - 1, Math.floor((Math.max(pv[o], pv[o + 3]) + m) / PCELL) + half);
        const z0 = Math.max(0, Math.floor((Math.min(pv[o + 1], pv[o + 4]) - m) / PCELL) + half);
        const z1 = Math.min(N - 1, Math.floor((Math.max(pv[o + 1], pv[o + 4]) + m) / PCELL) + half);
        for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) fn(gz * N + gx, o);
      }
    };
    each((c) => counts[c + 1]++);
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const cells = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, N * N);
    each((c, o) => (cells[fill[c]++] = o));
    return { site: s, f, g, cos: Math.cos((reach + 6) / R), pv, pStart: counts, pItems: cells, pHalf: half, pN: N };
  });
  const q = { x: 0, z: 0 };
  const hit = { d: 0, nx: 0, nz: 0 };

  /** The site whose reach `dir` is in (index), or −1. Sites never overlap. */
  function siteOf(dir: Vec3): number {
    for (let k = 0; k < data.length; k++) {
      const s = data[k].site.dir;
      if (dir.x * s.x + dir.y * s.y + dir.z * s.z >= data[k].cos) return k;
    }
    return -1;
  }

  /** Signed distance (m) from chart point (x, z) to footprint o of f (negative inside) and its outward normal, into hit. */
  function footprint(f: Float32Array, o: number, x: number, z: number): void {
    const dx = x - f[o];
    const dz = z - f[o + 1];
    const c = f[o + 2];
    const s = f[o + 3];
    const u = dx * c + dz * s;
    const v = dz * c - dx * s;
    const qu = Math.abs(u) - f[o + 4];
    const qv = Math.abs(v) - f[o + 5];
    let nu: number;
    let nv: number;
    if (qu > 0 || qv > 0) {
      const eu = Math.max(qu, 0);
      const ev = Math.max(qv, 0);
      const d = Math.hypot(eu, ev);
      hit.d = d;
      nu = (eu / d) * Math.sign(u);
      nv = (ev / d) * Math.sign(v);
    } else if (Math.max(qu, qv) < -0.5) {
      // Deep inside (started there: a launch, a restore): out through its front, onto the street it
      // faces (a terrace's sides are its neighbours).
      hit.d = -v - f[o + 5];
      nu = 0;
      nv = -1;
    } else if (qu > qv) {
      // Just inside (met from outside): out through the nearest face.
      hit.d = qu;
      nu = Math.sign(u) || 1;
      nv = 0;
    } else {
      hit.d = qv;
      nu = 0;
      nv = Math.sign(v) || 1;
    }
    hit.nx = nu * c - nv * s;
    hit.nz = nu * s + nv * c;
  }

  return {
    near: (dir) => siteOf(dir) >= 0,
    roofAt(dir, h, r) {
      const k = siteOf(dir);
      if (k < 0) return -Infinity;
      const { site, f } = data[k];
      dirToChart(site.chart, dir, q);
      let top = -Infinity;
      for (let o = 0; o < f.length; o += S) {
        const t = f[o + 6];
        if (t > h || t <= top) continue;
        const rr = f[o + 7] + r;
        if (Math.abs(q.x - f[o]) > rr || Math.abs(q.z - f[o + 1]) > rr) continue;
        footprint(f, o, q.x, q.z);
        if (hit.d <= r) top = t;
      }
      return top;
    },
    pavingAt(dir, h) {
      const k = siteOf(dir);
      if (k < 0) return -Infinity;
      const { site, pv, pStart, pItems, pHalf, pN } = data[k];
      dirToChart(site.chart, dir, q);
      const gx = Math.floor(q.x / PCELL) + pHalf;
      const gz = Math.floor(q.z / PCELL) + pHalf;
      if (gx < 0 || gz < 0 || gx >= pN || gz >= pN) return -Infinity;
      const c = gz * pN + gx;
      // The nearest street: on its carriageway the asphalt, on its sidewalk CURB_H over that.
      let best = Infinity;
      let top = -Infinity;
      for (let i = pStart[c]; i < pStart[c + 1]; i++) {
        const o = pItems[i];
        const sx = pv[o + 3] - pv[o];
        const sz = pv[o + 4] - pv[o + 1];
        const t = Math.max(0, Math.min(1, ((q.x - pv[o]) * sx + (q.z - pv[o + 1]) * sz) / (sx * sx + sz * sz || 1)));
        const d = Math.hypot(pv[o] + sx * t - q.x, pv[o + 1] + sz * t - q.z);
        if (d >= best || d > pv[o + 6] + pv[o + 7]) continue;
        best = d;
        top = pv[o + 2] + (pv[o + 5] - pv[o + 2]) * t + (d > pv[o + 6] ? CURB_H : 0);
      }
      return top <= h ? top : -Infinity;
    },
    fenceTop(dir, r) {
      const k = siteOf(dir);
      if (k < 0) return -Infinity;
      const { site, g } = data[k];
      dirToChart(site.chart, dir, q);
      let top = -Infinity;
      for (let o = 0; o < g.length; o += S) {
        if (g[o + 6] <= top) continue;
        const rr = g[o + 7] + r + FENCE_BAND;
        if (Math.abs(q.x - g[o]) > rr || Math.abs(q.z - g[o + 1]) > rr) continue;
        // (Along the plot's edge, either side of it: |signed distance| to its rectangle.)
        const dx = q.x - g[o];
        const dz = q.z - g[o + 1];
        const u = Math.abs(dx * g[o + 2] + dz * g[o + 3]) - g[o + 4];
        const v = Math.abs(dz * g[o + 2] - dx * g[o + 3]) - g[o + 5];
        const d = u > 0 || v > 0 ? Math.hypot(Math.max(u, 0), Math.max(v, 0)) : -Math.max(u, v);
        if (d < r + FENCE_BAND) top = g[o + 6];
      }
      return top;
    },
    solid(dir, h, r, out) {
      const k = siteOf(dir);
      if (k < 0) return false;
      const { site, f } = data[k];
      dirToChart(site.chart, dir, q);
      let moved = false;
      // (A few passes: pushed out of one wall into a neighbour's, it is pushed on.)
      for (let pass = 0, any = true; pass < 3 && any; pass++) {
        any = false;
        for (let o = 0; o < f.length; o += S) {
          if (f[o + 6] <= h) continue;
          const rr = f[o + 7] + r;
          if (Math.abs(q.x - f[o]) > rr || Math.abs(q.z - f[o + 1]) > rr) continue;
          footprint(f, o, q.x, q.z);
          if (hit.d >= r) continue;
          q.x += hit.nx * (r - hit.d);
          q.z += hit.nz * (r - hit.d);
          moved = any = true;
        }
      }
      if (moved) chartToDir(site.chart, q.x, q.z, out);
      return moved;
    },
  };
}
