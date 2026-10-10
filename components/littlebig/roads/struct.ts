// The region's built structures (v2, H1), merged into one Geo drawn with the city's building program
// (shadows, ink, the springy reveal): bridges (an arched girder under the deck, kerbed walkways,
// cream parapets, stone piers down into the water, abutments with splayed wing walls clad in stone),
// the harbours' sea walls (an ashlar face from the dredged basin to a coping stone, bollards along
// the edge), the piers (a plank deck on piles, bollards), streetlights and globe lamps (heads that
// glow at night), the gate roundabouts' monuments and a timber rail round the viewpoint car parks.

import { Color } from 'three';
import { K, type Xf } from '../city/geo';
import { GLOBE_H, LAMP_H, LAMP_REACH } from '../city/props';
import { CURB_H, R } from '../world/config';
import { PALETTE } from '../render/palette';
import { chartAt } from '../world/region/network';
import { wpath, wsample, wsampleOut } from '../world/region/path';
import type { Bridge, Region, RNode, Settlement, WPath } from '../world/region/types';
import { chartToDir, dirToChart, v3, type Vec3 } from '../world/sphere';
import { C, chartPath, deadEnd, QUAY_H, RIM, WALK } from './ground';
import { band, cross, frameAt, Geo, offsetDir, pathFrame, ribbon, set, tangentOf, toward, type HeightFn } from './geom';
import { roadward, RURAL_H, RURAL_REACH, type Lamp } from './lamps';

const S_ = {
  stone: new Color('#E3D8C3'),
  stoneDark: new Color('#BDB2A0'),
  ashlar: new Color('#B9AE9E'),
  pier: new Color('#C9BCA6'),
  cap: new Color('#F2ECDF'),
  timber: new Color('#B98A5E'),
  pile: new Color('#7A5A3E'),
  iron: new Color('#3B3F4C'),
  pole: new Color('#4A5266'),
  globePole: new Color('#2E4A3F'),
  lamp: new Color('#FFF1C9'),
  gold: new Color('#FFB84D'),
  flower: new Color('#FF8A7A'),
  hedge: new Color('#4E9E45'),
  flag: new Color('#E8504A'),
  anchor: new Color('#2F5D8C'),
  hay: new Color('#E9C25E'),
  water: new Color('#5BC0DA'),
};

export interface StructBuild {
  region: Region;
  ground(q: Vec3): number;
  S: Geo;
  lamps: Lamp[];
  tick(): Promise<void>;
}

const _w = wsampleOut();

/** Every vertex since `from` reveals out of the ground straight under it (h0 m above sea level). */
function rootDown(g: Geo, from: number, h0: number) {
  for (let i = from; i < g.n; i++) {
    const x = g.pos[i * 3], y = g.pos[i * 3 + 1], z = g.pos[i * 3 + 2];
    const k = (R + h0) / Math.hypot(x, y, z);
    g.base[i * 3] = x * k;
    g.base[i * 3 + 1] = y * k;
    g.base[i * 3 + 2] = z * k;
  }
}

/** Pivot (the reveal's origin) at unit q, height h. */
function pivot(g: Geo, q: Vec3, h: number) {
  g.pivot.x = q.x * (R + h);
  g.pivot.y = q.y * (R + h);
  g.pivot.z = q.z * (R + h);
}

export async function buildStructures(b: StructBuild): Promise<void> {
  const { region, S } = b;
  for (const br of region.bridges) {
    bridge(b, br);
    await b.tick();
  }
  for (const s of region.settlements) {
    if (s.wall) seaWall(b, s);
  }
  await b.tick();
  for (const p of region.piers) pier(b, p.root, p.berth, p.h, p.width);
  await b.tick();
  region.gates.forEach((g, i) => {
    const c = chartAt(g.dir, R + g.h);
    monument(S, i % 3, g.dir, b.ground(g.dir) + 0.23, chartToDir(c, 1, 0));
  });
  for (const l of region.lookouts) carParkRail(b, l.node);
  await b.tick();
  for (const n of region.nodes) {
    const end = deadEnd(region, n);
    if (end && end !== 'viewpoint') yard(b, n, end);
  }
  await b.tick();
  for (let i = 0; i < b.lamps.length; i++) {
    const l = b.lamps[i];
    lamp(S, l, Number.isNaN(l.base) ? b.ground(l.q) + l.layer : l.base);
    if (i % 60 === 59) await b.tick();
  }
  await b.tick();
}

// ── Bridges ──

function bridge(b: StructBuild, br: Bridge) {
  const { region, S } = b;
  const e = region.edges[br.edge];
  const p = e.centre;
  const half = e.width / 2;
  const out = half + 0.62; // deck edge
  const hAt = (s: number) => wsample(p, s, _w).h;
  // supports: the abutments and piers in between, ~11 m apart
  const L = br.s1 - br.s0;
  const n = Math.max(1, Math.round(L / 11));
  const sup = Array.from({ length: n + 1 }, (_, k) => br.s0 + (L * k) / n);
  // (each arch springs from a flat as wide as its pier's top, SPRING either side of it)
  const SPRING = 0.7;
  const depth = (s: number) => {
    let k = 0;
    while (k < n - 1 && s > sup[k + 1]) k++;
    const a = sup[k] + (k ? SPRING : 0), c = sup[k + 1] - (k + 1 < n ? SPRING : 0);
    const u = Math.min(1, Math.max(0, (s - a) / (c - a)));
    return 0.62 + 1.45 * (1 - Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)));
  };
  const deck = (k: number): HeightFn => (_q, s) => hAt(s) + k;
  const s0 = br.s0 - 0.3, s1 = br.s1 + 0.3;
  // (the arched faces in pieces cut at every springing, so each flat's corners are exact)
  const cuts = [s0, ...sup.slice(1, -1).flatMap((s) => [s - SPRING, s + SPRING]), s1];
  const arched = (f: (a: number, c: number) => void) => {
    for (let i = 0; i + 1 < cuts.length; i++) f(cuts[i], cuts[i + 1]);
  };
  const v0 = S.n;
  pivot(S, offsetDir(br.abutments[0].dir, v3(), 0, 0, v3()), br.deckMin);
  // girder sides (to the parapet's top), underside (arched between the supports), walkways and kerbs
  set(S, S_.stone, K.tiles, 1);
  for (const side of [1, -1] as const) arched((a, c) => band(S, p, a, c, side * out, (_q, s) => hAt(s) - depth(s) + 0.32, deck(0.78), side));
  // the arch ring: a darker course of voussoirs along each arch's edge
  set(S, S_.stoneDark, K.tiles, 1);
  for (const side of [1, -1] as const) arched((a, c) => band(S, p, a, c, side * (out + 0.02), (_q, s) => hAt(s) - depth(s), (_q, s) => hAt(s) - depth(s) + 0.34, side));
  set(S, S_.stoneDark);
  arched((a, c) => ribbon(S, p, a, c, -out, out, 3, (_q, s) => hAt(s) - depth(s), undefined, true));
  set(S, C.sidewalk, K.sidewalk);
  ribbon(S, p, s0, s1, half, out - 0.28, 1, deck(0.17));
  ribbon(S, p, s0, s1, -out + 0.28, -half, 1, deck(0.17));
  set(S, C.curb);
  band(S, p, s0, s1, half, deck(-0.02), deck(0.17), -1);
  band(S, p, s0, s1, -half, deck(-0.02), deck(0.17), 1);
  // the parapets: inner faces and a coping that overhangs both sides a little
  set(S, S_.cap);
  band(S, p, s0, s1, out - 0.28, deck(0.17), deck(0.78), -1);
  band(S, p, s0, s1, -out + 0.28, deck(0.17), deck(0.78), 1);
  ribbon(S, p, s0, s1, out - 0.32, out + 0.05, 1, deck(0.84));
  ribbon(S, p, s0, s1, -out - 0.05, -out + 0.32, 1, deck(0.84));
  band(S, p, s0, s1, out + 0.05, deck(0.74), deck(0.84), 1);
  band(S, p, s0, s1, -out - 0.05, deck(0.74), deck(0.84), -1);
  band(S, p, s0, s1, out - 0.32, deck(0.78), deck(0.84), -1);
  band(S, p, s0, s1, -out + 0.32, deck(0.78), deck(0.84), 1);
  rootDown(S, v0, br.deckMin - 2);
  // piers into the water (stone, with rounded cutwaters), and their caps
  for (let k = 1; k < n; k++) {
    const s = sup[k];
    const w = wsample(p, s, _w);
    const q = v3(w.dx, w.dy, w.dz);
    const t = v3(w.tx, w.ty, w.tz);
    const top = w.h - depth(s) + 0.05;
    const foot = Math.min(b.ground(q), 0) - 0.4;
    const xf = frameAt(q, 0, t);
    pivot(S, q, foot);
    set(S, S_.pier, K.tiles, 1);
    S.box(xf, -out + 0.15, out - 0.15, foot, top, -0.75, 0.75, 0.45);
    set(S, S_.stone);
    S.box(xf, -out + 0.05, out - 0.05, top - 0.35, top + 0.02, -0.88, 0.88, 0.3);
    // cutwaters: a pointed nose up- and downstream at the waterline
    for (const sd of [1, -1]) S.box(xf, sd > 0 ? out - 0.2 : -out - 0.55, sd > 0 ? out + 0.55 : -out + 0.2, foot, 0.9, -0.5, 0.5, 0.42);
  }
  // abutments: a stone retaining wall along the face line, under the deck's end and out to either side
  // while the ground drops away in front of it (its top on the fill behind, under the road where it
  // crosses, its foot in the water or the bank below), with a coping; the parapets end in stone pillars
  // (the approach's surface: the centreline's height at the station nearest a point, less SLACK)
  const near: number[] = [];
  for (let i = 0; i < p.h.length; i++) if (br.abutments.some((ab) => Math.abs(p.s[i] - ab.s) < 9)) near.push(i);
  const roadAt = (q: Vec3) => {
    let bi = 0, bd = Infinity;
    for (const i of near) {
      const d = (p.dir[i * 3] - q.x) ** 2 + (p.dir[i * 3 + 1] - q.y) ** 2 + (p.dir[i * 3 + 2] - q.z) ** 2;
      if (d < bd) (bd = d), (bi = i);
    }
    return p.h[bi] - 0.02;
  };
  for (const ab of br.abutments) {
    const q = v3(ab.dir.x, ab.dir.y, ab.dir.z);
    const into = v3(ab.into.x, ab.into.y, ab.into.z);
    const xf = frameAt(q, 0, into);
    const top = ab.top - 0.06;
    // (beside the road: below the approach's surface 0.7 m back from the face)
    const hb = Math.min(ab.top, wsample(p, ab.s + (ab.s > br.s0 + 1 ? 0.7 : -0.7), _w).h) - 0.12;
    const dirs: number[] = [], tops: number[] = [], feet: number[] = [];
    const t = v3(), u = v3();
    for (const sd of [-1, 1]) {
      for (let k = sd > 0 ? 0 : 1; k < 30; k++) {
        const x = sd * k * 0.6;
        offsetDir(q, xf.ex, x, 0, t);
        const gb = b.ground(offsetDir(t, into, -0.7, 0, u));
        const rb = roadAt(u);
        const gf = b.ground(offsetDir(t, into, 0.5, 0, u));
        const under = Math.abs(x) < half + 0.95;
        // (under the road its coping lies 6 cm under the carriageway or verge over all of it: the road
        // curves away from the straight face line and falls from the deck, so this is per point)
        const tp = under ? Math.min(rb, roadAt(offsetDir(t, into, 0.2, 0, u)), gb + 0.05) - 0.16 : Math.min(hb, gb + 0.15);
        // (beside it: on while the ground in front lies ≥ 0.8 m under the top, a few metres past the
        // verge unless the bank is steep, and only while its top stays within 0.6 m of the pillar's
        // foot: a wall along a gentle bank, or stepping far down a steep one, read as a stub standing
        // apart from the bridge)
        if (!under && (tp - gf < 0.8 || tp < hb - 0.6 || (Math.abs(x) > half + 4.5 && tp - gf < 1.2))) break;
        if (sd > 0) dirs.push(t.x, t.y, t.z), tops.push(tp), feet.push(Math.min(gf, gb) - 0.4);
        else dirs.unshift(t.x, t.y, t.z), tops.unshift(tp), feet.unshift(Math.min(gf, gb) - 0.4);
      }
    }
    const wall = wpath(dirs, tops);
    const n = tops.length - 1;
    const lerp = (a: number[]): HeightFn => (_q, s) => {
      const f = Math.min(n, (s / wall.length) * n);
      const i = Math.min(n - 1, Math.floor(f));
      return a[i] + (a[i + 1] - a[i]) * (f - i);
    };
    const wt = lerp(tops), wf = lerp(feet);
    const cop: HeightFn = (q, s, d) => wt(q, s, d) + 0.1;
    pivot(S, q, ab.foot);
    set(S, S_.ashlar, K.tiles, 1);
    band(S, wall, 0, wall.length, 0.1, wf, wt, 1);
    band(S, wall, 0, wall.length, -0.6, (q, s, d) => wt(q, s, d) - 0.5, wt, -1);
    set(S, S_.cap);
    ribbon(S, wall, 0, wall.length, -0.66, 0.18, 1, cop);
    band(S, wall, 0, wall.length, 0.18, wt, cop, 1);
    set(S, S_.stone, K.tiles, 1);
    for (const i of [0, n]) S.box(frameAt(v3(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]), 0, into), -0.2, 0.2, feet[i], tops[i] + 0.22, -0.7, 0.24, 0.05);
    // the parapets end in chunky stone pillars with caps
    for (const sd of [1, -1]) {
      const x0 = sd > 0 ? out - 0.42 : -out - 0.12;
      set(S, S_.stone, K.tiles, 1);
      S.box(xf, x0, x0 + 0.54, hb, top + 1.18, -0.3, 0.24, 0.06);
      set(S, S_.cap);
      S.box(xf, x0 - 0.06, x0 + 0.6, top + 1.18, top + 1.32, -0.36, 0.3, 0.05);
    }
  }
}

// ── Sea walls ──

function seaWall(b: StructBuild, s: Settlement) {
  const { S } = b;
  const w = s.wall!;
  const n = w.line.length / 2;
  const path = chartPath(s.chart, w.line, w.top[0]);
  // which side of travel is the sea?
  const tx = w.line[2] - w.line[0], tz = w.line[3] - w.line[1];
  const sea: 1 | -1 = -tz * w.nx + tx * w.nz > 0 ? 1 : -1;
  const top = (k: number): HeightFn => (q) => topAt(s, q) + k;
  // the coping stands LIP over the deck (0.1 m proud of the apron, ground.ts QUAY_H); it and the face
  // stop at each pier's root, where the face tops out under the pier's planks
  const piers = s.piers.map((i) => b.region.piers[i]);
  const gaps = piers.map((pr) => {
    const c = dirToChart(s.chart, pr.root);
    let best = 0, bd = Infinity, acc = 0;
    for (let i = 0; i + 1 < n; i++) {
      const ax = w.line[i * 2], az = w.line[i * 2 + 1], ux = w.line[i * 2 + 2] - ax, uz = w.line[i * 2 + 3] - az;
      const l = Math.hypot(ux, uz) || 1;
      const t = Math.max(0, Math.min(l, ((c.x - ax) * ux + (c.z - az) * uz) / l));
      const d = Math.hypot(ax + (ux * t) / l - c.x, az + (uz * t) / l - c.z);
      if (d < bd) (bd = d), (best = acc + t);
      acc += l;
    }
    return [best - pr.width / 2 - 0.05, best + pr.width / 2 + 0.05, pr.h - 0.03];
  });
  const runs: number[][] = [];
  let from = 0;
  for (const [a, c] of [...gaps].sort((x, y) => x[0] - y[0])) {
    if (a > from) runs.push([from, a]);
    from = c;
  }
  if (from < path.length) runs.push([from, path.length]);
  const v0 = S.n;
  pivot(S, s.dir, w.foot);
  set(S, S_.ashlar, K.tiles, 1);
  for (const [a, c] of runs) band(S, path, a, c, 0, () => w.foot, top(LIP), sea);
  for (const [a, c, h] of gaps) band(S, path, a, c, 0, () => w.foot, () => h, sea);
  // the coping: a pale stone kerb along the edge, its inland face down to the apron
  set(S, S_.cap);
  for (const [a, c] of runs) {
    ribbon(S, path, a, c, sea > 0 ? -w.coping : 0.04, sea > 0 ? -0.04 + 0.08 : w.coping, 1, top(LIP));
    band(S, path, a, c, -sea * w.coping, top(QUAY_H - 0.02), top(LIP), (-sea) as 1 | -1);
    band(S, path, a, c, sea * 0.04, top(LIP - 0.12), top(LIP), sea);
  }
  // the block's two ends, from the face back to its depth
  for (const i of [0, n - 1]) {
    const x = w.line[i * 2], z = w.line[i * 2 + 1];
    const q = chartToDir(s.chart, x, z);
    const back = chartToDir(s.chart, x - w.nx * w.depth, z - w.nz * w.depth);
    const t = toward(q, back);
    const xf = frameAt(q, 0, t);
    set(S, S_.ashlar, K.tiles, 1);
    S.box(xf, -0.25, 0.25, w.foot, w.top[i] + LIP, -0.1, w.depth, 0);
  }
  rootDown(S, v0, w.foot);
  // bollards along the edge
  set(S, S_.iron);
  for (let d = 3; d < path.length - 2; d += 7) {
    if (gaps.some(([a, c]) => d > a - 0.6 && d < c + 0.6)) continue;
    const r = v3();
    const W = pathFrame(path, d, r);
    const up = v3(W.dx, W.dy, W.dz);
    const q = offsetDir(up, r, -sea * 0.42, 0, v3());
    const y = topAt(s, q) + LIP;
    const xf = frameAt(q, 0, v3(W.tx, W.ty, W.tz));
    pivot(S, q, y);
    bollard(S, xf, y);
  }
}

/** A sea wall's coping over its deck (m). */
const LIP = QUAY_H + 0.1;

/** The quay deck's height (the pad's plane) at unit q. */
function topAt(s: Settlement, q: Vec3): number {
  const p = dirToChart(s.chart, q);
  return s.grade ? s.h + s.grade * (p.x * Math.sin(s.upHeading) - p.z * Math.cos(s.upHeading)) : s.h;
}

function bollard(S: Geo, xf: ReturnType<typeof frameAt>, y: number) {
  S.cylinder(xf, 0, 0, 0.14, y - 0.05, y + 0.38, 8, false);
  S.cylinder(xf, 0, 0, 0.19, y + 0.38, y + 0.46, 8, true);
}

// ── Piers ──

function pier(b: StructBuild, root: Vec3, berth: Vec3, h: number, width: number) {
  const { S } = b;
  const c = chartAt(root, R + h);
  const e = dirToChart(c, berth);
  const L = Math.hypot(e.x, e.z);
  const ux = e.x / L, uz = e.z / L;
  // the deck runs from just inside the quay's edge to the berth
  const path = chartPath(c, [-ux * 1.2, -uz * 1.2, e.x, e.z], h);
  const hw = width / 2;
  const v0 = S.n;
  pivot(S, root, h - 2);
  set(S, S_.timber, K.roof, 1);
  ribbon(S, path, 0, path.length, -hw, hw, 2, () => h, (_q, s, d) => [d, s]);
  set(S, S_.pile);
  for (const sd of [1, -1] as const) band(S, path, 0, path.length, sd * hw, () => h - 0.38, () => h, sd);
  // the end: a fascia across the berth
  rootDown(S, v0, h - 2);
  const end = chartToDir(c, e.x, e.z);
  const t = toward(end, root);
  const xf0 = frameAt(end, 0, t);
  S.box(xf0, -hw, hw, h - 0.38, h, -0.02, 0.1, 0);
  // piles every ~2.4 m along both edges, down into the seabed
  for (let s = 1.2; s <= path.length + 0.01; s += Math.max(1.8, (path.length - 1.2) / Math.round((path.length - 1.2) / 2.4))) {
    const r = v3();
    const W = pathFrame(path, Math.min(s, path.length - 0.15), r);
    const up = v3(W.dx, W.dy, W.dz);
    for (const sd of [1, -1]) {
      const q = offsetDir(up, r, sd * (hw - 0.12), h, v3());
      const foot = Math.min(b.ground(q), -0.5) - 0.3;
      const xf = frameAt(q, 0, v3(W.tx, W.ty, W.tz));
      pivot(S, q, foot);
      set(S, S_.pile);
      S.cylinder(xf, 0, 0, 0.16, foot, h - 0.1, 7, false);
      if (s > path.length - 3.5 || s < 2) {
        set(S, S_.iron);
        pivot(S, q, h);
        bollard(S, frameAt(offsetDir(up, r, sd * (hw - 0.35), h, v3()), 0, v3(W.tx, W.ty, W.tz)), h);
      }
    }
  }
}

// ── Lamps ──

function lamp(S: Geo, l: Lamp, y: number) {
  const up = l.q;
  // ez = arm × up, so the frame's +x (up × ez) is the arm
  const ez = l.kind === 1 ? tangentOf(up) : cross(l.arm, up);
  const xf = frameAt(up, 0, ez);
  pivot(S, up, y);
  if (l.kind === 1) {
    const H = y + (l.h ?? GLOBE_H);
    set(S, S_.globePole);
    S.cylinder(xf, 0, 0, 0.16, y - 0.05, y + 0.45, 8, true);
    S.cylinder(xf, 0, 0, 0.07, y + 0.45, H - 0.25, 6, true);
    S.cylinder(xf, 0, 0, 0.14, H - 0.3, H - 0.2, 8, true);
    set(S, S_.lamp, K.glow, 2.2);
    S.cylinder(xf, 0, 0, 0.26, H - 0.2, H + 0.2, 8, false);
    S.cylinder(xf, 0, 0, 0.17, H + 0.2, H + 0.34, 8, true);
    return;
  }
  if (l.kind === 2) {
    // the country lamp: a timber pole, a plank arm with a brace, a lantern hanging over the road's edge
    // (an iron hood, glowing panes, an iron foot: it reads lit from the road, not just a line)
    const H = y + RURAL_H, X = RURAL_REACH;
    set(S, S_.pile);
    S.cylinder(xf, 0, 0, 0.1, y - 0.1, H + 0.12, 6, true);
    S.box(xf, 0, X + 0.12, H - 0.02, H + 0.07, -0.045, 0.045, 0);
    // (the brace: a strut at 45° from the pole up to the arm)
    const k = Math.SQRT1_2, e = xf.ex, u = xf.ey;
    S.box({ o: v3(xf.o.x + e.x * 0.06 + u.x * (H - 0.62), xf.o.y + e.y * 0.06 + u.y * (H - 0.62), xf.o.z + e.z * 0.06 + u.z * (H - 0.62)), ex: v3((e.x + u.x) * k, (e.y + u.y) * k, (e.z + u.z) * k), ey: v3((u.x - e.x) * k, (u.y - e.y) * k, (u.z - e.z) * k), ez: xf.ez }, 0, 0.82, -0.03, 0.03, -0.03, 0.03, 0);
    set(S, S_.iron);
    S.box(xf, X - 0.2, X + 0.2, H - 0.13, H - 0.02, -0.2, 0.2, 0.05, { bottom: true });
    S.box(xf, X - 0.15, X + 0.15, H - 0.5, H - 0.46, -0.15, 0.15, 0.02, { bottom: true });
    set(S, S_.lamp, K.glow, 2.6);
    S.box(xf, X - 0.13, X + 0.13, H - 0.46, H - 0.13, -0.13, 0.13, 0.02, { top: false });
    return;
  }
  set(S, S_.pole);
  S.cylinder(xf, 0, 0, 0.17, y - 0.1, y + 0.55, 8, true);
  S.cylinder(xf, 0, 0, 0.085, y + 0.55, y + LAMP_H + 0.15, 6, true);
  S.box(xf, 0, LAMP_REACH, y + LAMP_H + 0.05, y + LAMP_H + 0.17, -0.05, 0.05, 0);
  const x0 = LAMP_REACH - 0.62, x1 = LAMP_REACH + 0.14, H = y + LAMP_H;
  S.box(xf, x0, x1, H - 0.05, H + 0.07, -0.21, 0.21, 0.09, { bottom: true });
  S.box(xf, x0 + 0.04, x1 - 0.03, H + 0.07, H + 0.15, -0.17, 0.17, 0.08);
  S.box(xf, x0 + 0.1, x1 - 0.08, H + 0.15, H + 0.2, -0.11, 0.11, 0.06);
  set(S, S_.lamp, K.glow, 2.6);
  S.box(xf, x0 + 0.08, x1 - 0.06, H - 0.09, H - 0.05, -0.15, 0.15, 0.07, { top: false, bottom: true });
}

/** Frame xf's x axis turned by `a` rad toward its y axis (a tilted member's frame). */
function lean(xf: Xf, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return v3(xf.ex.x * c + xf.ey.x * s, xf.ex.y * c + xf.ey.y * s, xf.ex.z * c + xf.ey.z * s);
}

/**
 * A gate roundabout's centrepiece, one per gate: on a stepped stone plinth an obelisk with a gilded
 * ball and four flower tubs; a clock pillar (four faces telling the sun's time, a gilded finial); or
 * a tiered topiary ringed by six tubs.
 */
function monument(S: Geo, v: number, q: Vec3, y: number, east: Vec3) {
  const xf = frameAt(q, 0, toward(q, east));
  pivot(S, q, y);
  set(S, S_.stoneDark, K.tiles, 1);
  S.box(xf, -1.3, 1.3, y - 0.1, y + 0.32, -1.3, 1.3, 0.35);
  set(S, S_.stone);
  if (v === 2) {
    S.cylinder(xf, 0, 0, 1.0, y + 0.32, y + 0.62, 10, true);
    set(S, S_.pile);
    S.cylinder(xf, 0, 0, 0.14, y + 0.6, y + 3.4, 6, false);
    set(S, S_.hedge, K.leaf, 2);
    for (const [r, y0, y1] of [[1.0, 1.0, 1.95], [0.74, 2.15, 2.9], [0.46, 3.1, 3.75]]) S.box(xf, -r, r, y + y0, y + y1, -r, r, r * 0.6, { bottom: true });
    for (let k = 0; k < 6; k++) tub(S, xf, Math.cos(k * 1.047) * 2.3, Math.sin(k * 1.047) * 2.3, y);
    return;
  }
  S.box(xf, -0.95, 0.95, y + 0.32, y + 0.7, -0.95, 0.95, 0.25);
  const H = v ? 3.1 : 3.6;
  S.box(xf, -0.42, 0.42, y + 0.7, y + H, -0.42, 0.42, 0.1);
  if (v) {
    // the clock head: a stone box with a face on each side, a cap and a finial
    set(S, S_.cap);
    S.box(xf, -0.62, 0.62, y + H, y + H + 1.15, -0.62, 0.62, 0.08);
    S.box(xf, -0.72, 0.72, y + H + 1.15, y + H + 1.3, -0.72, 0.72, 0.08);
    set(S, S_.cap, K.clock);
    const yc = y + H + 0.57;
    for (let f = 0; f < 4; f++) {
      const ca = Math.cos((f * Math.PI) / 2), sa = Math.sin((f * Math.PI) / 2);
      const pt = (a: number, r: number) => [Math.cos(a) * r * ca + 0.64 * sa, yc + Math.sin(a) * r, Math.cos(a) * r * sa - 0.64 * ca];
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2, a1 = ((i + 1) / 12) * Math.PI * 2;
        S.triL(xf, [...pt(0, 0), ...pt(a1, 0.45), ...pt(a0, 0.45)], [0, 0, -Math.cos(a1), Math.sin(a1), -Math.cos(a0), Math.sin(a0)], [sa, 0, -ca]);
      }
    }
    set(S, S_.gold);
    S.cylinder(xf, 0, 0, 0.2, y + H + 1.3, y + H + 1.75, 8, true);
  } else {
    S.box(xf, -0.3, 0.3, y + 3.6, y + 4.4, -0.3, 0.3, 0.08);
    set(S, S_.gold);
    S.cylinder(xf, 0, 0, 0.36, y + 4.4, y + 4.75, 8, true);
    S.cylinder(xf, 0, 0, 0.24, y + 4.75, y + 4.92, 8, true);
  }
  for (const [x, z] of [[2.3, 0], [-2.3, 0], [0, 2.3], [0, -2.3]]) tub(S, xf, x, z, y);
}

/** A timber rail round the far side of a viewpoint car park's turning circle, and a coin telescope. */
function carParkRail(b: StructBuild, nodeId: number) {
  const { region, S } = b;
  const n = region.nodes[nodeId];
  const e = region.edges[n.edges[0]];
  const i = e.a === n.id ? Math.min(3, e.centre.h.length - 1) : Math.max(0, e.centre.h.length - 4);
  const toRoad = toward(n.dir, v3(e.centre.dir[i * 3], e.centre.dir[i * 3 + 1], e.centre.dir[i * 3 + 2]));
  const c = chartAt(n.dir, R + n.h);
  const rd = dirToChart(c, offsetDir(n.dir, toRoad, 5, n.h, v3()));
  const a0 = Math.atan2(rd.z, rd.x);
  // (on the car park's gravel rim, or the yard's walk, near its back edge)
  const rr = n.turnR + (e.sidewalk || RIM) - 0.35;
  const pts: number[] = [];
  for (let k = 0; k <= 24; k++) {
    const a = a0 + Math.PI * 0.32 + ((Math.PI * 2 - Math.PI * 0.64) * k) / 24;
    pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  const path = chartPath(c, pts, n.h);
  const g = (q: Vec3) => b.ground(q) + WALK;
  set(S, S_.timber);
  const v0 = S.n;
  pivot(S, n.dir, n.h);
  for (const [y0, y1] of [[0.62, 0.74], [0.95, 1.07]]) {
    ribbon(S, path, 0, path.length, -0.06, 0.06, 1, (q) => g(q) + y1);
    band(S, path, 0, path.length, 0.06, (q) => g(q) + y0, (q) => g(q) + y1, 1);
    band(S, path, 0, path.length, -0.06, (q) => g(q) + y0, (q) => g(q) + y1, -1);
  }
  rootDown(S, v0, n.h - 1);
  const W = wsampleOut();
  for (let s = 0; s <= path.length; s += path.length / Math.round(path.length / 1.6)) {
    wsample(path, s, W);
    const q = v3(W.dx, W.dy, W.dz);
    const y = g(q);
    pivot(S, q, y);
    S.box(frameAt(q, 0, v3(W.tx, W.ty, W.tz)), -0.08, 0.08, y - 0.1, y + 1.18, -0.08, 0.08, 0.02);
  }
  // the coin telescope, at the rail opposite the road
  const tq = offsetDir(n.dir, toRoad, -(rr - 0.45), n.h, v3());
  const y = g(tq);
  const xf = frameAt(tq, 0, v3(-toRoad.x, -toRoad.y, -toRoad.z));
  pivot(S, tq, y);
  set(S, S_.iron);
  S.cylinder(xf, 0, 0, 0.07, y, y + 1.1, 6, true);
  set(S, new Color('#3D9CA8'));
  S.box(xf, -0.13, 0.13, y + 1.05, y + 1.3, -0.25, 0.4, 0.05);
  set(S, S_.gold);
  S.cylinder(xf, 0, 0.42, 0.1, y + 1.12, y + 1.24, 8, true);
}

// ── Yards ──

/**
 * A dead end's yard dressing (ground.ts paves it): a stack of round bales on a farmyard's straw, a
 * chalet yard's log trough with its spout and geraniums, a boat up on trestles in a boatyard, flower
 * tubs round a planted island's lamp, a lookout's rail.
 */
function yard(b: StructBuild, n: RNode, end: string) {
  const { S } = b;
  const up = n.dir;
  const t = roadward(b.region, n);
  const s = v3(up.y * t.z - up.z * t.y, up.z * t.x - up.x * t.z, up.x * t.y - up.y * t.x);
  const y = b.ground(up) + WALK + 0.03;
  const xf = frameAt(up, 0, t);
  pivot(S, up, y - 0.5);
  if (end === 'lookout') {
    carParkRail(b, n.id);
    // a white mast on the island with a yard arm and a red pennant
    set(S, S_.cap);
    S.cylinder(xf, 0, 0, 0.07, y, y + 5.2, 6, true);
    S.box(xf, -0.7, 0.7, y + 3.9, y + 3.97, -0.035, 0.035, 0);
    set(S, S_.flag);
    S.box(xf, 0.07, 1.1, y + 4.55, y + 5.15, -0.02, 0.02, 0);
  } else if (end === 'market') {
    // an anchor on a stone plinth: shank, stock, crown and flukes, a ring at the head
    set(S, S_.stoneDark, K.tiles, 1);
    S.box(xf, -0.7, 0.7, y, y + 0.5, -0.5, 0.5, 0.14);
    set(S, S_.anchor);
    S.box(xf, -0.13, 0.13, y + 0.5, y + 3.1, -0.11, 0.11, 0.04);
    S.box(xf, -0.85, 0.85, y + 2.6, y + 2.8, -0.1, 0.1, 0.04);
    S.cylinder(xf, 0, 0, 0.24, y + 3.1, y + 3.4, 8, true);
    // (each arm leans 50° out from the shank's foot: its frame turned in the x–y plane, the fluke on its inner side)
    for (const sd of [1, -1]) {
      const a = -sd * 0.87;
      const t: Xf = { o: v3(xf.o.x + xf.ey.x * (y + 0.68), xf.o.y + xf.ey.y * (y + 0.68), xf.o.z + xf.ey.z * (y + 0.68)), ex: lean(xf, a), ey: lean(xf, a + Math.PI / 2), ez: xf.ez };
      S.box(t, -0.12, 0.12, 0, 1.2, -0.1, 0.1, 0.03);
      S.box(t, sd > 0 ? -0.36 : -0.12, sd > 0 ? 0.12 : 0.36, 0.75, 1.3, -0.14, 0.14, 0.03);
    }
  } else if (end === 'farm') {
    set(S, S_.hay);
    const g = y - CURB_H + 0.01;
    for (const [d, h] of [[-0.56, 0], [0.56, 0], [0, 0.95]]) hcyl(S, offsetDir(up, t, d, g, v3()), g + h, t, s, 0.55, 1.15);
    S.cylinder(xf, 1.12, -0.25, 0.5, g, g + 1.1, 10, true);
  } else if (end === 'chalet') {
    // the trough: four plank walls and a bottom round the water, the post at its end
    set(S, S_.timber);
    S.box(xf, -0.75, 0.75, y, y + 0.12, -0.3, 0.3, 0);
    for (const z of [-0.3, 0.22]) S.box(xf, -0.75, 0.75, y, y + 0.55, z, z + 0.08, 0);
    for (const x of [-0.75, 0.67]) S.box(xf, x, x + 0.08, y, y + 0.55, -0.3, 0.3, 0);
    S.box(xf, 0.75, 0.97, y, y + 1.35, -0.11, 0.11, 0.02);
    set(S, S_.water, K.water);
    S.box(xf, -0.67, 0.67, y + 0.12, y + 0.44, -0.22, 0.22, 0);
    set(S, S_.iron);
    S.box(xf, 0.5, 0.75, y + 1.0, y + 1.05, -0.03, 0.03, 0);
    set(S, S_.flower, K.leaf, 3);
    S.box(xf, 0.68, 1.04, y + 1.35, y + 1.52, -0.17, 0.17, 0.04);
  } else if (end === 'boat') {
    // a boat up on two trestles across the yard
    const bx = frameAt(up, 0, s);
    set(S, S_.pile);
    for (const x of [-0.7, 0.6]) S.box(bx, -0.45, 0.45, y, y + 0.55, x - 0.07, x + 0.07, 0);
    const hull = [0.55, 0.5, 0, 1.45, -0.55, 0.5, -0.52, -1, -0.4, -1.35, 0.4, -1.35, 0.52, -1];
    set(S, PALETTE.walls[1 + (n.id % 3)]);
    prism(S, bx, hull, y + 0.55, y + 1.05);
    set(S, S_.cap);
    prism(S, bx, hull.map((v) => v * 1.04), y + 1.05, y + 1.15);
    S.box(bx, -0.32, 0.32, y + 1.15, y + 1.5, -0.8, -0.05, 0.05);
  } else if (end === 'villa' || end === 'school' || end === 'airport') for (let k = 0; k < 3; k++) tub(S, xf, Math.cos(k * 2.1) * 0.95, Math.sin(k * 2.1) * 0.95, y);
}

/** A convex prism from local plan ring (x, z pairs, clockwise from above) between y0 and y1, capped both ends. */
function prism(S: Geo, xf: Xf, ring: number[], y0: number, y1: number) {
  const m = ring.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    S.wall(xf, ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1], y0, y1, i, i + 1, y0, y1);
  }
  S.capRing(xf, ring, y1, true);
  S.capRing(xf, ring, y0, false);
}

/** A horizontal cylinder (a round bale) lying on the ground at unit q, height y, its axis along s. */
function hcyl(S: Geo, q: Vec3, y: number, t: Vec3, s: Vec3, r: number, len: number) {
  const k = R + y;
  // (two halves from the middle, each capped at its far end; ex × ey = up keeps the frame right-handed)
  for (const f of [1, -1]) S.cylinder({ o: v3(q.x * k, q.y * k, q.z * k), ex: v3(t.x * f, t.y * f, t.z * f), ey: v3(s.x * f, s.y * f, s.z * f), ez: q }, 0, r, r, 0, len / 2, 10, true);
}

/** A stone flower tub at local (x, z), its foot at y. */
function tub(S: Geo, xf: Xf, x: number, z: number, y: number) {
  set(S, S_.cap);
  S.cylinder(xf, x, z, 0.42, y - 0.05, y + 0.35, 8, true);
  set(S, S_.flower, K.leaf, 3);
  S.cylinder(xf, x, z, 0.36, y + 0.35, y + 0.62, 8, true);
}

export type { WPath };
