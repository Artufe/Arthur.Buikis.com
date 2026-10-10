// Where the region's lights stand (v2, H1). Pure: town streets get the capital's streetlight every
// ~18 m on alternating kerbs, quays a globe lamp every ~22 m along the water, the open road a short
// timber lamp every ~34 m on its verge (so at night every road is a string of lights from town to
// town: the constellation from orbit), bridges globe lamps on their end pillars and over every other
// pier, gate plazas a ring of globe lamps between their arms, piers one at the berth, car parks one at
// the rail; each dead end one for its yard (on its island, on the far side of its ring, or a timber
// lamp at a farmyard's mouth). A lamp that would land on a carriageway or inside a junction is
// dropped, bar the yards' own (spec'd).

import { GLOBE_H, LAMP_H, LAMP_REACH } from '../city/props';
import { R } from '../world/config';
import { wsample, wsampleOut } from '../world/region/path';
import type { RNode, Region, WPath } from '../world/region/types';
import { chartToDir, dirToChart, v3, type Vec3 } from '../world/sphere';
import { chartAt } from '../world/region/network';
import { offsetDir, pathFrame, toward } from './geom';
import { deadEnd, polyDist, RIM } from './ground';

export interface Lamp {
  /** Unit direction of the pole's foot. */
  q: Vec3;
  /** Unit tangent the arm reaches along (toward the road); a globe lamp's is unused. */
  arm: Vec3;
  /** The foot's height above sea level, or NaN: the ground under it plus `layer`. */
  base: number;
  layer: number;
  /** 0 a streetlight (cobra head on an arm), 1 a globe lamp, 2 a country lamp (timber pole, a plank arm, a hanging lantern). */
  kind: 0 | 1 | 2;
  /** A globe lamp's height over its foot (m; GLOBE_H if absent): short on a bridge's pillars and coping. */
  h?: number;
}

/** Streetlight spacing in towns, along quays and on the open road (m). */
export const TOWN_STEP = 18;
export const QUAY_STEP = 22;
export const ROAD_STEP = 34;
/** The country lamp: its arm's height over the foot and its reach (m: the lantern hangs over the road's edge). */
export const RURAL_H = 4.15;
export const RURAL_REACH = 1.45;

const W = wsampleOut();
/** Distances are measured at the roads' own radius (R + ~2 m), as their widths are. */
const RS = R + 2;

/** Lamp l's light (into q: its unit direction) standing at `base`; returns its height above sea level. */
export function lampLight(l: Lamp, base: number, q: Vec3): number {
  offsetDir(l.q, l.arm, l.kind === 1 ? 0 : l.kind === 2 ? RURAL_REACH : LAMP_REACH - 0.25, base, q);
  return base + (l.kind === 1 ? (l.h ?? GLOBE_H) : l.kind === 2 ? RURAL_H - 0.3 : LAMP_H - 0.12);
}

export function lampLayout(region: Region, walk: number, pave: number, quay = walk): Lamp[] {
  const out: Lamp[] = [];
  const own: Lamp[] = [];
  const ends = region.bridges.flatMap((b) => b.abutments.map((ab) => ab.dir));
  const put = (p: WPath, s: number, d: number, kind: 0 | 1 | 2, layer: number, base = NaN, h?: number, to = out) => {
    const r = v3();
    const w = pathFrame(p, s, r);
    const q = offsetDir(v3(w.dx, w.dy, w.dz), r, d, w.h, v3());
    const k = d > 0 ? -1 : 1;
    to.push({ q, arm: v3(r.x * k, r.y * k, r.z * k), base, layer, kind, h });
  };
  for (const e of region.edges) {
    if (e.kind === 'ring') continue;
    const p = e.centre;
    const L = p.length;
    const half = e.width / 2;
    const spans = e.bridges.map((i) => region.bridges[i]);
    if (e.sidewalk > 0) {
      if (L < 7) continue;
      // (a globe lamp instead within 20 m of a bridge's end or a gate plaza: the open road's style there)
      const n = Math.max(1, Math.round(L / TOWN_STEP));
      for (let k = 0; k < n; k++) {
        put(p, (L * (k + 0.5)) / n, ((k + e.id) & 1 ? 1 : -1) * (half + 0.45), 0, walk);
        const l = out[out.length - 1];
        if (ends.some((q) => arc(q, l.q) < 20) || region.gates.some((g) => arc(g.dir, l.q) < g.r + 20)) l.kind = 1;
      }
      continue;
    }
    const n = Math.max(1, Math.round(L / ROAD_STEP));
    for (let k = 0; k < n; k++) {
      const s = (L * (k + 0.5)) / n;
      if (!spans.some((b) => s > b.s0 - 4 && s < b.s1 + 4)) put(p, s, half + 1.0, 2, 0);
    }
    // bridges: a globe lamp on each end pillar, and on the coping over every other pier
    const out1 = half + 0.62;
    for (const b of spans) {
      for (const ab of b.abutments) {
        const xf = v3(ab.dir.y * ab.into.z - ab.dir.z * ab.into.y, ab.dir.z * ab.into.x - ab.dir.x * ab.into.z, ab.dir.x * ab.into.y - ab.dir.y * ab.into.x);
        for (const sd of [1, -1]) {
          const q = offsetDir(offsetDir(ab.dir, xf, sd * (out1 - 0.15), ab.top, v3()), ab.into, -0.03, ab.top, v3());
          out.push({ q, arm: v3(), base: ab.top + 1.26, layer: 0, kind: 1, h: 2.3 });
        }
      }
      const m = Math.max(1, Math.round((b.s1 - b.s0) / 11));
      for (let j = 1; j < m; j += 2) {
        const s = b.s0 + ((b.s1 - b.s0) * j) / m;
        put(p, s, (j & 2 ? -1 : 1) * (half + 0.485), 1, 0, wsample(p, s, W).h + 0.84, 2.75);
      }
    }
  }
  // quays: a globe lamp every QUAY_STEP along the sea wall on the apron behind its coping (clear of
  // the piers' roots), and no streetlight between the wall and its street
  for (const s of region.settlements) {
    const w = s.wall;
    if (!w) continue;
    const roots = s.piers.map((i) => dirToChart(s.chart, region.piers[i].root));
    for (let i = out.length - 1; i >= 0; i--) {
      const c = dirToChart(s.chart, out[i].q);
      if (!out[i].kind && polyDist(c.x, c.z, w.line) < 6.5) out.splice(i, 1);
    }
    let acc = QUAY_STEP / 2;
    for (let i = 0; i + 3 < w.line.length; i += 2) {
      const ax = w.line[i], az = w.line[i + 1], ux = w.line[i + 2] - ax, uz = w.line[i + 3] - az;
      const l = Math.hypot(ux, uz);
      for (; acc < l; acc += QUAY_STEP) {
        const x = ax + (ux * acc) / l - w.nx * 1.15, z = az + (uz * acc) / l - w.nz * 1.15;
        if (!roots.some((r) => Math.hypot(r.x - x, r.z - z) < 3.5)) out.push({ q: chartToDir(s.chart, x, z), arm: v3(), base: NaN, layer: quay, kind: 1 });
      }
      acc -= l;
    }
  }
  // gate plazas: globe lamps round the paving, between the arms and clear of the city's turnaround
  for (const g of region.gates) {
    const c = chartAt(g.dir, R + g.h);
    const away = g.nodes.map((id) => {
      const q = dirToChart(c, region.nodes[id].dir);
      return Math.atan2(q.z, q.x);
    });
    const t = dirToChart(c, g.touch);
    away.push(Math.atan2(t.z, t.x));
    away.sort((x, y) => x - y);
    for (let k = 0; k < away.length; k++) {
      // one in the middle of every gap between the arms (and the city's side), two in a wide one
      const a0 = away[k];
      const gap = (k + 1 < away.length ? away[k + 1] : away[0] + Math.PI * 2) - a0;
      const m = gap > 2.4 ? 2 : 1;
      for (let j = 1; j <= m; j++) {
        const a = a0 + (gap * j) / (m + 1);
        const rr = (g.ring + 2.5 + g.r) / 2 + 0.1;
        out.push({ q: chartToDir(c, Math.cos(a) * rr, Math.sin(a) * rr), arm: v3(), base: NaN, layer: pave, kind: 1 });
      }
    }
  }
  // piers: one at the berth end
  for (const p of region.piers) {
    const t = toward(p.berth, p.root);
    const r = v3(t.y * p.berth.z - t.z * p.berth.y, t.z * p.berth.x - t.x * p.berth.z, t.x * p.berth.y - t.y * p.berth.x);
    const q = offsetDir(p.berth, t, 0.9, p.h, v3());
    offsetDir(q, r, p.width / 2 - 0.3, p.h, q);
    out.push({ q, arm: v3(), base: p.h, layer: 0, kind: 1 });
  }
  // dead ends: a lookout's globe lamp beyond its rail, opposite the road; a farmyard's country lamp at
  // its mouth; a planted island's globe lamp in its middle; any other yard's streetlight across its ring
  for (const n of region.nodes) {
    const end = deadEnd(region, n);
    if (!end || end === 'end' || end === 'pier') continue;
    const e = region.edges[n.edges[0]];
    const toRoad = roadward(region, n);
    const atA = e.a === n.id;
    if (end === 'viewpoint' || end === 'lookout') {
      own.push({ q: offsetDir(n.dir, toRoad, -(n.turnR + (end === 'viewpoint' ? RIM + 0.55 : 1.1)), n.h, v3()), arm: v3(), base: NaN, layer: 0, kind: 1 });
    } else if (end === 'farm') put(e.centre, atA ? 0.6 : e.centre.length - 0.6, (atA ? 1 : -1) * (e.width / 2 + 0.45), 2, walk, NaN, undefined, own);
    else if (end === 'villa' || end === 'school' || end === 'airport') own.push({ q: n.dir, arm: v3(), base: NaN, layer: walk + 0.03, kind: 1, h: 3.1 });
    else own.push({ q: offsetDir(n.dir, toRoad, -(n.turnR + 0.45), n.h, v3()), arm: toRoad, base: NaN, layer: walk, kind: 0 });
  }
  return [...out.filter((l) => clearOfRoads(region, l.q, 0.35)), ...own];
}

/** The unit tangent at dead end n toward its road. */
export function roadward(region: Region, n: RNode): Vec3 {
  const e = region.edges[n.edges[0]];
  const i = e.a === n.id ? Math.min(3, e.centre.h.length - 1) : Math.max(0, e.centre.h.length - 4);
  return toward(n.dir, v3(e.centre.dir[i * 3], e.centre.dir[i * 3 + 1], e.centre.dir[i * 3 + 2]));
}

/**
 * True if unit q is more than `gap` m clear of every carriageway (an edge's half width round its
 * centreline), every junction patch and turning circle (the node's patch radius or turning circle),
 * every gate's ring and every runway strip.
 */
export function clearOfRoads(region: Region, q: Vec3, gap: number): boolean {
  for (const e of region.edges) {
    const p = e.centre;
    const reach = e.width / 2 + gap;
    // (a cheap reject on the edge's ends and middle, then every sample)
    const n = p.h.length;
    const m = n >> 1;
    let near = false;
    for (const i of [0, m, n - 1]) {
      const dx = p.dir[i * 3] - q.x, dy = p.dir[i * 3 + 1] - q.y, dz = p.dir[i * 3 + 2] - q.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) * RS < p.length / 2 + reach + 1) near = true;
    }
    if (!near) continue;
    for (let i = 0; i + 1 < n; i++) if (segDist(p, i, q) < reach) return false;
  }
  for (const nd of region.nodes) {
    const dx = nd.dir.x - q.x, dy = nd.dir.y - q.y, dz = nd.dir.z - q.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) * RS;
    if (d < (nd.kind === 'end' ? Math.max(nd.turnR, nd.radius) : nd.radius) + gap) return false;
  }
  for (const g of region.gates) {
    const dx = g.dir.x - q.x, dy = g.dir.y - q.y, dz = g.dir.z - q.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) * RS;
    if (d > g.island - gap && d < g.ring + 2.5 + gap) return false;
  }
  for (const a of region.airports) {
    const d = segDir(a.ends[0], a.ends[1], q);
    if (d < a.width / 2 + 2 + gap) return false;
  }
  return true;
}

const arc = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)) * R;

/** Surface distance (m, at radius R) from unit q to segment i of path p. */
function segDist(p: WPath, i: number, q: Vec3): number {
  const D = p.dir;
  return segDir(
    { x: D[i * 3], y: D[i * 3 + 1], z: D[i * 3 + 2] },
    { x: D[i * 3 + 3], y: D[i * 3 + 4], z: D[i * 3 + 5] },
    q,
  );
}

function segDir(a: Vec3, b: Vec3, q: Vec3): number {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const l2 = ux * ux + uy * uy + uz * uz;
  let t = l2 > 0 ? ((q.x - a.x) * ux + (q.y - a.y) * uy + (q.z - a.z) * uz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a.x + ux * t - q.x, dy = a.y + uy * t - q.y, dz = a.z + uz * t - q.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * RS;
}
