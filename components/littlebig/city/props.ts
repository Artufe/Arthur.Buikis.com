// Street furniture and garden edges, merged into the city mesh: streetlights (lamp heads glow at
// night), benches, bus shelters, flags, the plaza fountain, hedges and picket fences round the
// house gardens, stones round the pond. Trees are A1's (it renders every 'tree' feature).

import { Color } from 'three';
import { PALETTE } from '../render/palette';
import { Rng } from '../world/rng';
import { featureRadius } from '../world/city/index-grid';
import type { Area, CityIndex, CityPlan, Feature } from '../world/city/types';
import { frameFor } from './buildings';
import { Geo, K, type Xf } from './geo';

const POLE = new Color('#4A5266');
const LAMP = new Color('#FFF1C9');
const WOOD = new Color('#B87A4B');
const IRON = new Color('#3B3F4C');
const STONE = new Color('#E2D9C6');
const tmpC = new Color();
const shade = (c: Color, k: number) => tmpC.copy(c).multiplyScalar(k);
const HEDGE = new Color('#3F9A4C');
const FENCE = new Color('#FBF7EE');
const FLAGS = [PALETTE.accent, new Color('#E2543F'), new Color('#3D9CA8'), new Color('#7FB04A'), new Color('#A99CDA')];

/** Height of the lamp head above the sidewalk (m); pools.ts lights the ground under it. */
export const LAMP_H = 4.9;
/** Reach of the lamp arm toward the road (m). */
export const LAMP_REACH = 1.25;

export function buildProps(g: Geo, plan: CityPlan, index: CityIndex, delayAt: (x: number, z: number) => number): void {
  plan.features.forEach((f, i) => {
    const gh = index.groundH(f.x, f.z);
    const xf = frameFor(f.x, f.z, f.angle, 0);
    g.pivot.x = xf.o.x;
    g.pivot.y = xf.o.y;
    g.pivot.z = xf.o.z;
    g.delay = delayAt(f.x, f.z);
    g.kind = K.plain;
    g.param = 0;
    switch (f.kind) {
      case 'streetlight':
        return streetlight(g, xf, gh);
      case 'bench':
        return bench(g, xf, gh);
      case 'bus-stop':
        return busStop(g, xf, gh);
      case 'flag':
        return flag(g, xf, gh, i);
      case 'fountain':
        return fountain(g, xf, gh, f);
      case 'lamp':
        return globeLamp(g, xf, gh);
      case 'hydrant':
        return hydrant(g, xf, gh);
      case 'tree':
        return; // A1 draws every tree
      case 'planter':
        return planter(g, xf, gh, featureRadius(f));
      case 'cafe-table':
        return cafeTable(g, xf, gh, i);
      case 'statue':
        return statue(g, xf, gh);
      default:
        return;
    }
  });
  for (const a of plan.areas) {
    if (a.kind === 'garden') gardenEdge(g, a, delayAt);
    if (a.kind === 'water') pondRim(g, a, delayAt);
  }
}

function streetlight(g: Geo, xf: Xf, y: number) {
  g.color.copy(POLE);
  g.cylinder(xf, 0, 0, 0.17, y - 0.1, y + 0.55, 8, true);
  g.cylinder(xf, 0, 0, 0.085, y + 0.55, y + LAMP_H + 0.15, 6, true);
  // arm reaching over the road (+x), a little curl at the pole
  g.box(xf, 0, LAMP_REACH, y + LAMP_H + 0.05, y + LAMP_H + 0.17, -0.05, 0.05, 0);
  // lamp head: a rounded cobra head (three chamfered slabs narrowing upward) over a recessed,
  // glowing lens that only shows from below
  const x0 = LAMP_REACH - 0.62;
  const x1 = LAMP_REACH + 0.14;
  const H = y + LAMP_H;
  g.box(xf, x0, x1, H - 0.05, H + 0.07, -0.21, 0.21, 0.09, { bottom: true });
  g.box(xf, x0 + 0.04, x1 - 0.03, H + 0.07, H + 0.15, -0.17, 0.17, 0.08);
  g.box(xf, x0 + 0.1, x1 - 0.08, H + 0.15, H + 0.2, -0.11, 0.11, 0.06);
  g.color.copy(LAMP);
  g.kind = K.glow;
  g.param = 2.6;
  g.box(xf, x0 + 0.08, x1 - 0.06, H - 0.09, H - 0.05, -0.15, 0.15, 0.07, { top: false, bottom: true });
  g.kind = K.plain;
  g.param = 0;
}

/** Height of a globe lamp's light above its ground (pools.ts). */
export const GLOBE_H = 3.5;

function globeLamp(g: Geo, xf: Xf, y: number) {
  g.color.copy(new Color('#2E4A3F'));
  g.cylinder(xf, 0, 0, 0.16, y - 0.05, y + 0.45, 8, true);
  g.cylinder(xf, 0, 0, 0.07, y + 0.45, y + GLOBE_H - 0.25, 6, true);
  g.cylinder(xf, 0, 0, 0.14, y + GLOBE_H - 0.3, y + GLOBE_H - 0.2, 8, true);
  g.color.copy(LAMP);
  g.kind = K.glow;
  g.param = 2.2;
  // a chunky octagonal globe
  g.cylinder(xf, 0, 0, 0.26, y + GLOBE_H - 0.2, y + GLOBE_H + 0.2, 8, false);
  g.cylinder(xf, 0, 0, 0.17, y + GLOBE_H + 0.2, y + GLOBE_H + 0.34, 8, true);
  g.kind = K.plain;
  g.param = 0;
}

function hydrant(g: Geo, xf: Xf, y: number) {
  g.color.copy(new Color('#E2453A'));
  g.cylinder(xf, 0, 0, 0.13, y - 0.05, y + 0.55, 8, false);
  g.cylinder(xf, 0, 0, 0.16, y + 0.55, y + 0.62, 8, true);
  g.cylinder(xf, 0, 0, 0.08, y + 0.62, y + 0.72, 6, true);
  g.box(xf, -0.22, 0.22, y + 0.34, y + 0.44, -0.05, 0.05, 0);
  g.color.copy(new Color('#F2CC5B'));
  g.box(xf, -0.04, 0.04, y + 0.32, y + 0.46, -0.17, 0.17, 0);
}

function planter(g: Geo, xf: Xf, y: number, r: number) {
  const R = Math.max(0.45, r);
  const inner = R - Math.min(0.22, R * 0.2);
  g.color.copy(STONE);
  g.cylinder(xf, 0, 0, R, y - 0.05, y + 0.42, R > 0.8 ? 12 : 8, false);
  ringTop(g, xf, R, inner, y + 0.42, R > 0.8 ? 12 : 8);
  g.color.set('#6B4B33');
  discTop(g, xf, inner, y + 0.34, R > 0.8 ? 12 : 8);
  const cols = [new Color('#FF8A7A'), new Color('#F2CC5B'), new Color('#FFFFFF'), new Color('#A99CDA')];
  const n = R > 0.8 ? 7 : 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.4;
    const rr = inner * 0.68;
    g.color.copy(cols[i % cols.length]);
    g.box(xf, Math.cos(a) * rr - 0.1, Math.cos(a) * rr + 0.1, y + 0.34, y + 0.5, Math.sin(a) * rr - 0.1, Math.sin(a) * rr + 0.1, 0.04);
  }
  if (R > 0.7 && R < 0.8) {
    // a flower planter (no tree in it): a leafy mound crowned with blooms
    g.color.set('#5FAE45');
    g.cylinder(xf, 0, 0, inner * 0.62, y + 0.34, y + 0.62, 8, true);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.9;
      const rr = inner * 0.36;
      g.color.copy(cols[(i + 1) % cols.length]);
      g.box(xf, Math.cos(a) * rr - 0.09, Math.cos(a) * rr + 0.09, y + 0.6, y + 0.74, Math.sin(a) * rr - 0.09, Math.sin(a) * rr + 0.09, 0.04);
    }
  }
}

/** A café table with two chairs and, on every other one, a parasol. */
function cafeTable(g: Geo, xf: Xf, y: number, i: number) {
  g.color.copy(IRON);
  g.cylinder(xf, 0, 0, 0.05, y, y + 0.72, 6, false);
  g.cylinder(xf, 0, 0, 0.22, y, y + 0.04, 8, true);
  g.color.copy(FENCE);
  g.cylinder(xf, 0, 0, 0.38, y + 0.72, y + 0.77, 10, true);
  for (const sx of [-1, 1]) {
    const cx = sx * 0.62;
    g.color.copy(sx > 0 ? new Color('#E2543F') : new Color('#2F8F8A'));
    g.box(xf, cx - 0.2, cx + 0.2, y + 0.44, y + 0.5, -0.2, 0.2, 0.03, { bottom: true });
    g.box(xf, cx + sx * 0.17, cx + sx * 0.21, y + 0.5, y + 0.95, -0.2, 0.2, 0);
    g.color.copy(IRON);
    for (const [lx, lz] of [[-0.16, -0.16], [0.16, -0.16], [0.16, 0.16], [-0.16, 0.16]]) g.box(xf, cx + lx - 0.02, cx + lx + 0.02, y, y + 0.44, lz - 0.02, lz + 0.02, 0, { top: false });
  }
  if (i % 2 === 0) {
    g.color.copy(FENCE);
    g.cylinder(xf, 0, 0, 0.03, y + 0.77, y + 2.25, 4, false);
    const n = 8;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2;
      const a1 = ((k + 1) / n) * Math.PI * 2;
      g.color.copy(k % 2 ? FENCE : new Color('#E2543F'));
      g.triL(xf, [Math.cos(a1) * 1.05, y + 2.05, Math.sin(a1) * 1.05, Math.cos(a0) * 1.05, y + 2.05, Math.sin(a0) * 1.05, 0, y + 2.45, 0], [0, 0, 1, 0, 0.5, 1], [Math.cos((a0 + a1) / 2), 0.6, Math.sin((a0 + a1) / 2)]);
    }
  }
}

/** A statue on a plinth (the church square). */
function statue(g: Geo, xf: Xf, y: number) {
  g.color.copy(STONE);
  g.box(xf, -0.7, 0.7, y - 0.05, y + 0.35, -0.7, 0.7, 0.08);
  g.color.copy(shade(STONE, 0.92));
  g.box(xf, -0.45, 0.45, y + 0.35, y + 1.6, -0.45, 0.45, 0.06);
  g.color.copy(STONE);
  g.box(xf, -0.55, 0.55, y + 1.6, y + 1.75, -0.55, 0.55, 0.06);
  const bronze = new Color('#5E9C84');
  g.color.copy(bronze);
  g.box(xf, -0.16, 0.16, y + 1.75, y + 2.55, -0.12, 0.12, 0.05); // legs + body
  g.box(xf, -0.24, 0.24, y + 2.4, y + 3.05, -0.16, 0.16, 0.08);
  g.cylinder(xf, 0, 0, 0.15, y + 3.05, y + 3.38, 8, true); // head
  g.box(xf, 0.22, 0.32, y + 2.9, y + 3.6, -0.06, 0.06, 0); // raised arm
  g.box(xf, -0.32, -0.22, y + 2.45, y + 2.95, -0.06, 0.06, 0);
}

function bench(g: Geo, xf: Xf, y: number) {
  g.color.copy(IRON);
  for (const x of [-0.65, 0.65]) {
    g.box(xf, x - 0.05, x + 0.05, y - 0.05, y + 0.42, -0.2, 0.2, 0, { top: false });
    g.box(xf, x - 0.05, x + 0.05, y + 0.42, y + 0.92, 0.18, 0.26, 0, { top: true });
  }
  g.color.copy(WOOD);
  g.box(xf, -0.85, 0.85, y + 0.42, y + 0.5, -0.24, 0.22, 0.02, { bottom: true });
  g.box(xf, -0.85, 0.85, y + 0.58, y + 0.88, 0.2, 0.27, 0, { bottom: true });
}

function busStop(g: Geo, xf: Xf, y: number) {
  // Shelter: posts, a glass back panel, a roof slab; a bench inside; a sign pole.
  g.color.copy(POLE);
  for (const [px, pz] of [[-1.25, -0.5], [1.25, -0.5], [-1.25, 0.55], [1.25, 0.55]]) g.box(xf, px - 0.05, px + 0.05, y, y + 2.35, pz - 0.05, pz + 0.05, 0, { top: false });
  g.color.copy(new Color('#9BD3EE'));
  g.box(xf, -1.2, 1.2, y + 0.25, y + 2.2, 0.52, 0.58, 0, { top: false });
  g.color.copy(new Color('#F2CC5B'));
  g.box(xf, -1.45, 1.45, y + 2.35, y + 2.52, -0.72, 0.72, 0.05, { bottom: true });
  g.color.copy(WOOD);
  g.box(xf, -0.9, 0.9, y + 0.42, y + 0.5, 0.15, 0.45, 0, { bottom: true });
  g.color.copy(IRON);
  g.box(xf, -0.85, -0.78, y, y + 0.42, 0.2, 0.4, 0, { top: false });
  g.box(xf, 0.78, 0.85, y, y + 0.42, 0.2, 0.4, 0, { top: false });
  // sign
  g.color.copy(POLE);
  g.cylinder(xf, 1.75, -0.4, 0.045, y, y + 2.6, 6, true);
  g.color.copy(new Color('#2F8F8A'));
  g.box(xf, 1.5, 2.0, y + 2.2, y + 2.7, -0.43, -0.37, 0);
}

function flag(g: Geo, xf: Xf, y: number, i: number) {
  g.color.copy(new Color('#E8E4DA'));
  g.cylinder(xf, 0, 0, 0.06, y - 0.1, y + 6.6, 6, true);
  g.color.copy(PALETTE.accent);
  g.cylinder(xf, 0, 0, 0.1, y + 6.6, y + 6.8, 6, true);
  const c = FLAGS[i % FLAGS.length];
  g.color.copy(c);
  // a gently bent flag: two panels, both faces
  const pts = [0.05, 0.62, 1.25];
  const bend = [0, 0.12, -0.05];
  for (let k = 0; k < 2; k++) {
    const x0 = pts[k], x1 = pts[k + 1], z0 = bend[k], z1 = bend[k + 1];
    g.quadL(xf, [x0, y + 5.4, z0, x1, y + 5.4, z1, x1, y + 6.3, z1, x0, y + 6.3, z0], [0, 0, 1, 0, 1, 1, 0, 1], [0, 0, -1]);
    g.quadL(xf, [x0, y + 5.4, z0 + 0.01, x1, y + 5.4, z1 + 0.01, x1, y + 6.3, z1 + 0.01, x0, y + 6.3, z0 + 0.01], [0, 0, 1, 0, 1, 1, 0, 1], [0, 0, 1]);
  }
}

function fountain(g: Geo, xf: Xf, y: number, f: Feature) {
  const r = (f.r ?? 1.6) - 0.05;
  g.color.copy(STONE);
  g.cylinder(xf, 0, 0, r, y - 0.1, y + 0.5, 20, false);
  // basin lip (a ring as a flat top band)
  g.cylinder(xf, 0, 0, r - 0.22, y + 0.2, y + 0.5, 20, false);
  ringTop(g, xf, r, r - 0.22, y + 0.5, 20);
  g.color.copy(new Color('#3FA9D8'));
  g.kind = K.water;
  discTop(g, xf, r - 0.22, y + 0.38, 20);
  g.kind = K.plain;
  g.color.copy(STONE);
  g.cylinder(xf, 0, 0, 0.3, y + 0.38, y + 1.15, 8, false);
  g.cylinder(xf, 0, 0, 0.85, y + 1.15, y + 1.32, 12, false);
  g.color.copy(new Color('#3FA9D8'));
  g.kind = K.water;
  discTop(g, xf, 0.85, y + 1.32, 12);
  // the jet: a small water cone
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    g.triL(xf, [Math.cos(a1) * 0.22, y + 1.32, Math.sin(a1) * 0.22, Math.cos(a0) * 0.22, y + 1.32, Math.sin(a0) * 0.22, 0, y + 2.25, 0], [0, 0, 1, 0, 0.5, 1], [Math.cos((a0 + a1) / 2), 0.3, Math.sin((a0 + a1) / 2)]);
  }
  g.kind = K.plain;
}

function discTop(g: Geo, xf: Xf, r: number, y: number, n: number) {
  const ring: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.capRing(xf, ring, y, true, 1);
}

function ringTop(g: Geo, xf: Xf, r0: number, r1: number, y: number, n: number) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    g.quadL(xf, [Math.cos(a0) * r0, y, Math.sin(a0) * r0, Math.cos(a1) * r0, y, Math.sin(a1) * r0, Math.cos(a1) * r1, y, Math.sin(a1) * r1, Math.cos(a0) * r1, y, Math.sin(a0) * r1], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 0]);
  }
}

/**
 * A garden's edge, varied by plot: hedges with a picket front, a picket fence all round, a low
 * stone wall in front with hedges behind, or open lawn with a shrub at each corner. Hedges are
 * lumpy (a row of chamfered lobes of varying height) with blotchy foliage.
 */
function gardenEdge(g: Geo, a: Area, delayAt: (x: number, z: number) => number) {
  const o = a.outline;
  const n = o.length >> 1;
  if (n !== 4) return;
  let front = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const r = Math.hypot((o[i * 2] + o[j * 2]) / 2, (o[i * 2 + 1] + o[j * 2 + 1]) / 2);
    if (r < best) {
      best = r;
      front = i;
    }
  }
  const rng = new Rng(Math.round(o[0] * 100) ^ Math.round(o[1] * 100));
  const style = rng.int(0, 9) < 4 ? 0 : rng.chance(0.4) ? 1 : rng.chance(0.55) ? 2 : 3;
  const hedgeTone = 0.85 + rng.float() * 0.3;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const ax = o[i * 2], az = o[i * 2 + 1], bx = o[j * 2], bz = o[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    const ang = Math.atan2(bz - az, bx - ax);
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const ix = -(bz - az) / L;
    const iz = (bx - ax) / L;
    const cx = mx + ix * 0.35;
    const cz = mz + iz * 0.35;
    const xf = frameFor(cx, cz, ang, 0);
    g.pivot.x = xf.o.x;
    g.pivot.y = xf.o.y;
    g.pivot.z = xf.o.z;
    g.delay = delayAt(cx, cz) + 0.2;
    g.kind = K.plain;
    const half = L / 2 - 0.4;
    const isFront = i === front;
    if (style === 3) {
      // open lawn: a round shrub at the run's far end
      if (!isFront) {
        g.color.copy(HEDGE).multiplyScalar(hedgeTone);
        g.kind = K.leaf;
        g.param = rng.float() * 10;
        g.box(xf, half - 0.55, half + 0.25, -0.2, 0.75 + rng.float() * 0.3, -0.4, 0.4, 0.3);
        g.param = 0;
      }
      continue;
    }
    if (isFront && style === 2) {
      // a low stone wall with a gate gap
      g.color.copy(STONE).multiplyScalar(0.92);
      for (const [s0, s1] of [[-half, -0.75], [0.75, half]]) if (s1 - s0 > 0.3) g.box(xf, s0, s1, -0.1, 0.5, -0.16, 0.16, 0.05);
      continue;
    }
    if (isFront || style === 1) {
      g.color.copy(FENCE);
      const gap = isFront ? 0.8 : 0;
      const runs: Array<[number, number]> = gap ? [[-half, -gap], [gap, half]] : [[-half, half]];
      for (const [s0, s1] of runs) {
        if (s1 - s0 < 0.4) continue;
        g.box(xf, s0, s1, 0.32, 0.4, -0.03, 0.03, 0);
        g.box(xf, s0, s1, 0.6, 0.68, -0.03, 0.03, 0);
        for (let s = s0; s <= s1 + 1e-6; s += 0.32) g.box(xf, s - 0.04, s + 0.04, -0.1, 0.82, -0.04, 0.04, 0);
      }
      continue;
    }
    // lumpy hedge: overlapping lobes
    g.kind = K.leaf;
    let s = -half;
    while (s < half - 0.2) {
      const len = Math.min(half - s, 0.9 + rng.float() * 0.6);
      const h = 0.85 + rng.float() * 0.35;
      const wd = 0.28 + rng.float() * 0.08;
      g.color.copy(HEDGE).multiplyScalar(hedgeTone * (0.94 + rng.float() * 0.12));
      g.param = rng.float() * 10;
      g.box(xf, s - 0.08, s + len + 0.08, -0.3, h, -wd, wd, 0.2);
      s += len;
    }
    g.param = 0;
    g.kind = K.plain;
  }
}

function pondRim(g: Geo, a: Area, delayAt: (x: number, z: number) => number) {
  const o = a.outline;
  const n = o.length >> 1;
  const rng = new Rng(17);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = o[i * 2], az = o[i * 2 + 1], bx = o[j * 2], bz = o[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    for (let s = acc; s < L; s += 0.85) {
      const t = s / L;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const xf = frameFor(x, z, Math.atan2(bz - az, bx - ax) + rng.range(-0.3, 0.3), 0);
      g.pivot.x = xf.o.x;
      g.pivot.y = xf.o.y;
      g.pivot.z = xf.o.z;
      g.delay = delayAt(x, z);
      g.color.copy(STONE).multiplyScalar(0.85 + rng.float() * 0.2);
      const w = rng.range(0.35, 0.55);
      g.box(xf, -w, w, -0.15, 0.12 + rng.range(0, 0.1), -0.3, 0.3, 0.12);
      acc = s + 0.85 - L;
    }
    if (acc < 0) acc = 0;
  }
}

export type { Feature };
