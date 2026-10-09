// LITTLEBIG v2 towns (T1): every item of a site's plan (towns/plan.ts) as toy geometry merged into the
// site's Geo. The capital's own builders (city/buildings.ts, city/props.ts) make the house, shop and
// block styles and the street furniture: they build at the capital's chart origin and the result is
// moved rigidly onto the lot (stamp). What the capital has not got is built here: gabled harbour
// townhouses, chalets under snow, barns, silos, sheds and boathouses, beach huts, warehouses and quay
// cranes, the airport's tower and hangar, the ski lift, trees, gardens, paddocks and the beach. One
// program for all of it: the city's toon patch (lit windows at night, roof tiles, foliage, water).

import { Color } from 'three';
import { buildBuilding } from '../city/buildings';
import { Geo, K, type Xf } from '../city/geo';
import { buildProps } from '../city/props';
import { PALETTE } from '../render/palette';
import { CITY_CHART } from '../world/city/frame';
import type { Building, CityIndex, CityPlan } from '../world/city/types';
import { CITY_SURFACE_R, R } from '../world/config';
import { Rng } from '../world/rng';
import { chartFrame, v3 } from '../world/sphere';
import { CENTRE, F, type Item, type Site, T } from './plan';

const c = (h: string) => new Color(h);
const cs = (...h: string[]) => h.map(c);
const WHITE = c('#FFFFFF');
const CREAM = c('#FFF6E4');
const DARK = c('#3B3F4C');
const INK = c('#2A2342');
const STONE = c('#D9CDB6');
const WOOD = c('#B87A4B');
const TIMBER = cs('#9A5B34', '#B5713F', '#8A4E2C', '#A8683E');
const GLASS = c('#2E4A66');
const RED = c('#C8432F');
const SLATE = c('#5B6B8C');
const STEEL = c('#8C93A3');
const AMBER = PALETTE.accent;
const HAY = c('#E8C15A');
const LEAF = cs('#5DAE45', '#4E9F3E', '#78BE4A', '#3F904A');
const PINE = cs('#2F7F4E', '#3A8C55', '#2A7448');
const STRIPES = cs('#E2543F', '#2F8F8A', '#F2A93B', '#5866B8', '#7FB04A');
const HUTS = cs('#FF8FB0', '#7FD8B8', '#FFD35A', '#7EC8F2', '#FF8A7A', '#B9A6F0');
const HOTELS = cs('#FFF4E4', '#FFD0BE', '#C2EED8', '#FFE39C', '#C9E4FA');
const VILLAS = cs('#FFF4DC', '#FFCDB4', '#FFE48E', '#B4EBD2', '#FFC4D2');
const TERRA = c('#D46A43');
const POOL = c('#3FC1E0');
const IRON = c('#3A4152');
const BLOOM = cs('#E2543F', '#FFD35A', '#FF8FB0', '#B9A6F0', '#FFFFFF');
const UV4 = [0, 0, 1, 0, 1, 1, 0, 1];
const UV3 = [0, 0, 1, 0, 0.5, 1];
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const PI = Math.PI;
const tmp = new Color();
const shade = (k: Color, f: number) => tmp.copy(k).multiplyScalar(f);

// ── frames ──

const _up = v3(), _ax = v3(), _az = v3();
/** The frame of an item at plan (x, z) in a site's chart, local +x at plan angle a, at height y above sea level. */
export function frameAt(site: Site, x: number, z: number, a: number, y: number): Xf {
  chartFrame(site.chart, x, z, _up, _ax, _az);
  return turn({ o: v3(_up.x * (R + y), _up.y * (R + y), _up.z * (R + y)), ex: _ax, ey: v3(_up.x, _up.y, _up.z), ez: _az }, a);
}
/** A frame turned by a about its y (local x toward local z). */
function turn(xf: Xf, a: number): Xf {
  const ca = Math.cos(a), sa = Math.sin(a), { ex, ez } = xf;
  return { o: xf.o, ex: v3(ex.x * ca + ez.x * sa, ex.y * ca + ez.y * sa, ex.z * ca + ez.z * sa), ey: xf.ey, ez: v3(ez.x * ca - ex.x * sa, ez.y * ca - ex.y * sa, ez.z * ca - ex.z * sa) };
}
/** A frame moved to local (x, y, z) and turned by a. */
const sub = (xf: Xf, x: number, y: number, z: number, a = 0): Xf => turn({ ...xf, o: Geo.apply(xf, x, y, z, v3()) }, a);
/** The frame lying down: its local y along the original x (cylinders on their side). */
const lie = (xf: Xf): Xf => ({ o: xf.o, ex: v3(-xf.ey.x, -xf.ey.y, -xf.ey.z), ey: xf.ex, ez: xf.ez });
/** The frame rolled by t about its z (local y toward −x): boxes leaning in the x–y plane. */
const roll = (xf: Xf, t: number): Xf => {
  const cr = Math.cos(t), sr = Math.sin(t), { ex, ey } = xf;
  return { o: xf.o, ex: v3(ex.x * cr + ey.x * sr, ex.y * cr + ey.y * sr, ex.z * cr + ey.z * sr), ey: v3(ey.x * cr - ex.x * sr, ey.y * cr - ex.y * sr, ey.z * cr - ex.z * sr), ez: xf.ez };
};

// ── stamping the capital's builders ──

const SU = CITY_CHART.origin, SE = CITY_CHART.east, SS = CITY_CHART.south;
const SO = v3(SU.x * CITY_SURFACE_R, SU.y * CITY_SURFACE_R, SU.z * CITY_SURFACE_R);

/**
 * Move what was emitted since vertex n0 (and facade record f0), built in the capital's frame at its
 * chart origin, rigidly onto frame xf (scaled by k about its origin).
 */
function stampInto(g: Geo, n0: number, f0: number, xf: Xf, k = 1): void {
  const map = (A: Float32Array | number[], i: number, pt = 1) => {
    const x = A[i] - SO.x * pt, y = A[i + 1] - SO.y * pt, z = A[i + 2] - SO.z * pt, s = pt ? k : 1;
    const lx = (x * SE.x + y * SE.y + z * SE.z) * s, ly = (x * SU.x + y * SU.y + z * SU.z) * s, lz = (x * SS.x + y * SS.y + z * SS.z) * s;
    A[i] = xf.o.x * pt + xf.ex.x * lx + xf.ey.x * ly + xf.ez.x * lz;
    A[i + 1] = xf.o.y * pt + xf.ex.y * lx + xf.ey.y * ly + xf.ez.y * lz;
    A[i + 2] = xf.o.z * pt + xf.ex.z * lx + xf.ey.z * ly + xf.ez.z * lz;
  };
  for (let i = n0 * 3; i < g.n * 3; i += 3) {
    map(g.pos, i);
    map(g.base, i);
    map(g.nor, i, 0);
  }
  const fa = g.facades;
  if (fa) for (let q = f0; q < fa.length; q += 24) {
    map(fa, q);
    map(fa, q + 3);
    map(fa, q + 6);
    map(fa, q + 15, 0);
  }
}

const STYLE = ['house', 'shop', 'shop', 'midrise', 'office', 'tower', 'landmark'] as const;

/** A house, shop, block, tower or the chapel: the capital's own builder, stamped onto the lot. */
function capital(g: Geo, xf: Xf, it: Item, tallest: boolean): void {
  const chapel = it.t === T.chapel, tower = it.t === T.tower, hip = it.f & F.hip, tall = it.f & F.tall;
  // the chapel is the capital's church at two thirds: its tower and nave keep their proportions
  const k = chapel ? 0.66 : 1;
  const b = {
    id: +tallest,
    x: 0,
    z: 0,
    angle: 0,
    w: it.w / k,
    d: it.d / k,
    h: chapel ? 18 : it.h,
    style: STYLE[it.t],
    roof: it.t === T.corner || (it.t === T.house && !hip) ? 'gable' : hip ? 'hip' : tower && it.h > 24 && !tall ? 'stepped' : 'flat',
    zone: tower ? 'downtown' : it.t ? 'midrise' : 'residential',
    wall: it.c,
    roofColor: it.v,
    seed: it.s,
    frontEdge: 0,
    landmark: chapel ? 'church' : undefined,
    tiers: tower && tall ? [{ h: it.h * 0.62, inset: 0 }, { h: it.h * 0.86, inset: 1.1 }, { h: it.h, inset: 2.1 }] : undefined,
    decor: it.f & F.cafe ? 'cafe' : undefined,
  } as Building;
  const n0 = g.n, f0 = g.facades?.length ?? 0;
  g.growK = 1 + it.h / (tower ? 22 : 40);
  buildBuilding(g, b, g.delay, { roadFace: (_b, f) => (it.f & (1 << f)) > 0, tallest: tallest ? 1 : -1 });
  g.growK = 1;
  stampInto(g, n0, f0, xf, k);
}

const NO_INDEX = { groundH: () => 0 } as unknown as CityIndex;
/** One of the capital's street furniture (bench, fountain, statue, flag), stamped. */
function furniture(g: Geo, xf: Xf, kind: string, r = 0): void {
  const n0 = g.n, d = g.delay;
  buildProps(g, { features: [{ kind, x: 0, z: 0, angle: 0, r }], areas: [] } as unknown as CityPlan, NO_INDEX, () => d);
  stampInto(g, n0, 0, xf);
}

// ── small helpers on the current Geo ──

let G: Geo;
/** Set the colour, kind and param for what is emitted next. */
function paint(col: Color, kind: number = K.plain, param = 0) {
  G.color.copy(col);
  G.kind = kind;
  G.param = param;
}
function box(xf: Xf, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col: Color, ch = 0, kind: number = K.plain, opts?: Parameters<Geo['box']>[8]) {
  paint(col, kind);
  G.box(xf, x0, x1, y0, y1, z0, z1, ch, opts);
}
/** A box centred on (x, z), half sizes hx, hz. */
const post = (xf: Xf, x: number, z: number, hx: number, hz: number, y0: number, y1: number, col: Color, ch = 0) => box(xf, x - hx, x + hx, y0, y1, z - hz, z + hz, col, ch);
/** Four posts at (±x, ±z). */
const posts = (xf: Xf, x: number, z: number, r: number, y0: number, y1: number, col: Color) => {
  for (const [sx, sz] of CORNERS) post(xf, sx * x, sz * z, r, r, y0, y1, col);
};
function cyl(xf: Xf, x: number, z: number, r: number, y0: number, y1: number, col: Color, n = 8, cap = true, kind: number = K.plain) {
  paint(col, kind, kind === K.facade ? G.param : 0);
  G.cylinder(xf, x, z, r, y0, y1, n, cap);
}
const quad = (xf: Xf, p: number[], face: [number, number, number]) => G.quadL(xf, p, UV4, face);
const tri = (xf: Xf, p: number[], face: [number, number, number]) => G.triL(xf, p, UV3, face);
function cone(xf: Xf, x: number, z: number, r: number, y0: number, y1: number, col: Color, n = 8, kind: number = K.plain) {
  paint(col, kind);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * PI * 2, a1 = ((i + 1) / n) * PI * 2, am = (a0 + a1) / 2;
    tri(xf, [x + Math.cos(a1) * r, y0, z + Math.sin(a1) * r, x + Math.cos(a0) * r, y0, z + Math.sin(a0) * r, x, y1, z], [Math.cos(am), r / Math.max(0.1, y1 - y0), Math.sin(am)]);
  }
}
/** A small glowing box (a lamp, a beacon: the patch's glow kind). */
function glow(xf: Xf, x: number, y: number, z: number, s: number, r: number, gg: number, b: number, param: number) {
  G.color.setRGB(r, gg, b);
  G.kind = K.glow;
  G.param = param;
  G.box(xf, x - s, x + s, y, y + 2 * s, z - s, z + s, 0);
}

/** Unit icosahedron, subdivided once (42 vertices, 80 faces), for blobby crowns. */
const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  const f0 = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const mid = new Map<number, number>();
  const m = (a: number, b: number) => {
    const key = Math.min(a, b) * 64 + Math.max(a, b);
    if (!mid.has(key)) {
      mid.set(key, v.length / 3);
      v.push(v[a * 3] + v[b * 3], v[a * 3 + 1] + v[b * 3 + 1], v[a * 3 + 2] + v[b * 3 + 2]);
    }
    return mid.get(key)!;
  };
  const f: number[] = [];
  for (let i = 0; i < f0.length; i += 3) {
    const a = f0[i], b = f0[i + 1], cc = f0[i + 2], ab = m(a, b), bc = m(b, cc), ca = m(cc, a);
    f.push(a, ab, ca, b, bc, ab, cc, ca, bc, ab, bc, ca);
  }
  for (let i = 0; i < v.length; i += 3) {
    const l = Math.hypot(v[i], v[i + 1], v[i + 2]);
    v[i] /= l;
    v[i + 1] /= l;
    v[i + 2] /= l;
  }
  return { v, f };
})();

const _p = v3(), _n = v3();
/** A soft lump (an ellipsoid with smooth normals, a little seeded jitter), foliage-patterned. */
function lump(xf: Xf, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, col: Color, rng: Rng, kind: number = K.leaf) {
  paint(col, kind, rng.float() * 10);
  const base = G.n, { v, f } = ICO;
  for (let i = 0; i < v.length; i += 3) {
    const j = 1 + (rng.float() - 0.5) * 0.14;
    Geo.apply(xf, cx + v[i] * rx * j, cy + v[i + 1] * ry * j, cz + v[i + 2] * rz * j, _p);
    Geo.dir(xf, v[i] / rx, v[i + 1] / ry, v[i + 2] / rz, _n);
    G.vert(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, v[i] * rx, v[i + 1] * ry + v[i + 2] * rz * 0.5);
  }
  for (let i = 0; i < f.length; i += 3) G.tri(base + f[i], base + f[i + 2], base + f[i + 1]);
}

/** Walls with windows (the facade shader's styles: 3 = house, shutters, curtains, lit at night). */
function walls(xf: Xf, hw: number, hd: number, y0: number, y1: number, col: Color, seed: number, bay: number, floor: number, style = 3, ch = 0.1) {
  paint(col, K.facade, style * 1024 + (seed % 1024));
  // floor coordinates as the capital's: whole floors of about `floor` m from the ground up
  const b = Math.max(y0, 0.2), nf = Math.max(1, Math.round((y1 - b) / floor));
  G.box(xf, -hw, hw, y0, y1, -hd, hd, ch, { top: false, side: (_f, w) => [0, Math.max(1, Math.round(w / bay)), ((y0 - b) * nf) / (y1 - b), nf] });
}

/**
 * A gable roof whose ridge runs along local z over [−hw, hw] × [−hd, hd] from eave height y, rising
 * `rise`: tiled slopes with their dark undersides, the gable triangles in `wall` at ±wallHD; snow lying
 * on the slopes when asked.
 */
function gable(xf: Xf, hw: number, hd: number, y: number, rise: number, roof: Color, wall: Color, wallHW: number, wallHD: number, snow = false, th = 0.16) {
  const yt = y + rise, sl = Math.hypot(hw, rise);
  for (const s of [-1, 1]) {
    paint(roof, K.roof, 1);
    G.quadL(xf, [s * hw, y, -s * hd, s * hw, y, s * hd, 0, yt, s * hd, 0, yt, -s * hd], [-hd, sl, hd, sl, hd, 0, -hd, 0], [s, 1, 0]);
    paint(shade(roof, 0.55));
    quad(xf, [s * hw, y - th, -hd, s * hw, y - th, hd, 0, yt - th, hd, 0, yt - th, -hd], [0, -1, 0]);
    quad(xf, [s * hw, y - th, -hd, s * hw, y - th, hd, s * hw, y, hd, s * hw, y, -hd], [s, 0, 0]);
    for (const z of [-hd, hd]) quad(xf, [s * hw, y - th, z, s * hw, y, z, 0, yt, z, 0, yt - th, z], [0, 0, z]);
    G.color.copy(wall);
    tri(xf, [-wallHW, y, s * wallHD, wallHW, y, s * wallHD, 0, yt - th, s * wallHD], [0, 0, s]);
    if (snow) {
      // a blanket on the upper two thirds of each slope, a hand's breadth thick, closed at its ends and
      // its ridge, kept 0.45 m in from the gables: the dark roof frames it (eaves, verges, a ridge board)
      const xs = hw * 0.7, ys = y + rise * 0.3, e = 0.1, z = hd - 0.45;
      paint(c('#F4F9FF'));
      quad(xf, [s * xs, ys + e, -z, s * xs, ys + e, z, 0, yt + e, z, 0, yt + e, -z], [s, 1, 0]);
      quad(xf, [s * xs, ys, -z, s * xs, ys, z, s * xs, ys + e, z, s * xs, ys + e, -z], [s, -0.3, 0]);
      for (const k of [-z, z]) quad(xf, [s * xs, ys, k, s * xs, ys + e, k, 0, yt + e, k, 0, yt, k], [0, 0, k]);
      if (s > 0) box(xf, -0.09, 0.09, yt + e - 0.04, yt + e + 0.1, -hd, hd, shade(roof, 0.6));
    }
  }
}

/** A hip roof over [−hw, hw] × [−hd, hd] from eave height y, rising `rise` to a ridge along the longer side; a fascia and a soffit under its eaves. */
function hip(xf: Xf, hw: number, hd: number, y: number, rise: number, col: Color) {
  const r = Math.min(hw, hd), lx = hw - r, lz = hd - r, yt = y + rise;
  box(xf, -hw, hw, y - 0.14, y, -hd, hd, shade(col, 0.6), 0, K.plain, { top: false, bottom: true });
  paint(col, K.roof, 1);
  for (const s of [-1, 1]) {
    quad(xf, [-hw, y, s * hd, hw, y, s * hd, lx, yt, s * lz, -lx, yt, s * lz], [0, r, s * rise]);
    quad(xf, [s * hw, y, -hd, s * hw, y, hd, s * lx, yt, lz, s * lx, yt, -lz], [s * rise, r, 0]);
  }
}

/** A flower tub: a terracotta pot and its blooms. */
function tub(xf: Xf, x: number, z: number, rng: Rng) {
  cyl(xf, x, z, 0.26, -0.1, 0.4, TERRA, 8);
  cyl(xf, x, z, 0.29, 0.34, 0.42, shade(TERRA, 0.8), 8);
  lump(xf, x, 0.5, z, 0.25, 0.17, 0.25, BLOOM[rng.int(0, 4)], rng);
}

/** Still water over [x0, x1] × [z0, z1] at height y. */
function water(xf: Xf, x0: number, x1: number, z0: number, z1: number, y: number) {
  paint(POOL, K.water);
  G.capRing(xf, [x0, z0, x1, z0, x1, z1, x0, z1], y, true);
}

/** A basin: a coping 2e wide round [−hw, hw] × [−hd, hd] up to y + 0.1, the water at y. */
function basin(xf: Xf, hw: number, hd: number, e: number, y: number, col: Color) {
  for (const s of [-1, 1]) {
    box(xf, -hw - e, hw + e, -0.3, y + 0.1, s * hd - e, s * hd + e, col, 0.04);
    box(xf, s * hw - e, s * hw + e, -0.3, y + 0.1, -hd + e, hd - e, col, 0.04);
  }
  water(xf, -hw, hw, -hd, hd, y);
}

/** A stable door on the −z face at zf: a white frame, the lower and upper leaves. */
function stable(xf: Xf, x: number, zf: number) {
  box(xf, x - 0.62, x + 0.62, -0.2, 2.15, zf - 0.06, zf + 0.01, WHITE);
  for (const [y0, y1] of [[0.05, 1.05], [1.12, 2.05]]) box(xf, x - 0.5, x + 0.5, y0, y1, zf - 0.1, zf - 0.05, c('#7A2A22'));
}

/** Small white-framed windows across the −z face at zf (n of them over [−hw, hw]), sills at y. */
function windows(xf: Xf, hw: number, zf: number, y: number, n: number) {
  for (let k = 0; k < n; k++) {
    const x = -hw + ((k + 0.5) * 2 * hw) / n;
    box(xf, x - 0.4, x + 0.4, y - 0.08, y + 0.76, zf - 0.05, zf + 0.01, WHITE);
    box(xf, x - 0.3, x + 0.3, y, y + 0.68, zf - 0.08, zf - 0.04, GLASS);
  }
}

/** A door on the −z face at z = zf: frame, leaf, step. */
function door(xf: Xf, x: number, zf: number, col: Color, h = 2.1, w = 0.47) {
  box(xf, x - w - 0.1, x + w + 0.1, -0.2, h + 0.12, zf - 0.06, zf + 0.02, CREAM);
  box(xf, x - w, x + w, 0.05, h, zf - 0.09, zf - 0.04, col);
  box(xf, x - w - 0.25, x + w + 0.25, -0.3, 0.12, zf - 0.45, zf, shade(STONE, 0.9));
}

// ── our own buildings ──

/** A tall narrow harbour house, its steep gable to the street, in the terrace's colours. */
function townhouse(xf: Xf, it: Item) {
  const wall = PALETTE.walls[it.c] ?? PALETTE.walls[0];
  const hw = it.w / 2 - 0.12, hd = it.d / 2 - 0.25, rise = Math.min(it.w * 0.62, 3.3), wh = Math.max(4.5, it.h - rise);
  walls(xf, hw, hd, -0.8, wh, wall, it.s, 1.55, 2.75, 3, 0.04);
  box(xf, -hw - 0.04, hw + 0.04, -0.8, 0.5, -hd - 0.04, hd + 0.04, shade(wall, 0.7), 0.04, K.plain, { top: false });
  // white string course and corner boards
  box(xf, -hw - 0.06, hw + 0.06, wh - 0.22, wh, -hd - 0.06, hd + 0.06, CREAM, 0.04, K.plain, { bottom: true });
  for (const sx of [-hw, hw]) post(xf, sx, -hd, 0.12, 0.1, 0.5, wh, CREAM);
  gable(xf, hw + 0.25, hd + 0.3, wh, rise, it.v ? SLATE : RED, wall, hw, hd);
  // a round window in the gable, the door with its lamp
  const gy = wh + rise * 0.36;
  post(xf, 0, -hd - 0.025, 0.34, 0.035, gy - 0.34, gy + 0.34, CREAM);
  post(xf, 0, -hd - 0.065, 0.24, 0.015, gy - 0.24, gy + 0.24, GLASS);
  const dx = ((it.s % 3) - 1) * Math.max(0, hw - 0.9);
  door(xf, dx, -hd, STRIPES[it.s % 5]);
  glow(xf, dx + 0.85, 2, -hd - 0.11, 0.1, 1, 0.82, 0.45, 1.6);
}

/** A chalet: masonry ground floor, timber above, a low wide roof on deep eaves under snow, a balcony. */
function chalet(xf: Xf, it: Item) {
  const tb = TIMBER[it.c % 4];
  const hw = it.w / 2 - 1, hd = it.d / 2 - 1, rise = Math.max(1.4, (hw + 1) * 0.5), wh = Math.max(4.6, it.h - rise), g1 = Math.min(2.8, wh * 0.48);
  walls(xf, hw, hd, -0.8, g1, it.c % 2 ? CREAM : c('#EDE3D0'), it.s, 2.2, 2.6, 3, 0.06);
  walls(xf, hw + 0.06, hd + 0.06, g1, wh, tb, it.s + 7, 1.9, 2.4, 3, 0);
  box(xf, -hw - 0.1, hw + 0.1, g1 - 0.06, g1 + 0.12, -hd - 0.1, hd + 0.1, shade(tb, 0.7), 0, K.plain, { bottom: true });
  gable(xf, hw + 1, hd + 0.95, wh, rise, it.v ? c('#5A4A44') : SLATE, tb, hw + 0.06, hd + 0.06, true, 0.2);
  // the balcony across the gable front, flower boxes on its rail
  const by = g1 + 0.15, bz = -hd - 0.06;
  box(xf, -hw + 0.1, hw - 0.1, by - 0.14, by, bz - 1.05, bz, shade(tb, 0.85), 0, K.plain, { bottom: true });
  box(xf, -hw + 0.1, hw - 0.1, by + 0.82, by + 0.92, bz - 1.05, bz - 0.95, shade(tb, 1.15));
  for (let x = -hw + 0.15; x <= hw - 0.1; x += 0.36) post(xf, x, bz - 1.01, 0.035, 0.03, by, by + 0.82, shade(tb, 1.15));
  for (let x = -hw + 0.6; x < hw - 0.5; x += 1.3) {
    post(xf, x, bz - 1.02, 0.4, 0.1, by + 0.92, by + 1.1, shade(tb, 0.8));
    post(xf, x, bz - 1.02, 0.36, 0.06, by + 1.1, by + 1.24, STRIPES[(it.s + Math.round(x)) & 1 ? 0 : 2], 0.05);
  }
  door(xf, ((it.s % 3) - 1) * Math.max(0, hw - 1), -hd, c('#6B3E2A'));
  // the chimney
  post(xf, hw * 0.4, hd * 0.2, 0.3, 0.3, wh - 0.5, it.h + 0.3, STONE);
}

/**
 * A red barn, its gable to the street or the yard (−z): big braced doors, the hayloft door up in the
 * gable, white trim, small windows down both sides and a stable door at the back. A long low cowshed
 * (more than 1.6 times as wide as deep) turns its eaves to the yard instead, a row of stable doors
 * under them and windows at the back.
 */
function barn(xf: Xf, it: Item) {
  const hw = it.w / 2 - 0.3, hd = it.d / 2 - 0.3, red = it.c % 2 ? c('#B8402F') : c('#A93A30'), long = it.w > it.d * 1.6;
  const rise = long ? Math.min(hd * 0.7, 1.6) : Math.min(hw * 0.95, 3.6), wh = Math.max(long ? 2.6 : 3.2, it.h - rise), roof = it.v ? SLATE : c('#7A4A3A');
  box(xf, -hw, hw, -0.8, wh, -hd, hd, red, 0.05, K.plain, { top: false });
  posts(xf, hw, hd, 0.12, -0.2, wh, WHITE);
  if (long) {
    gable(turn(xf, PI / 2), hd + 0.35, hw + 0.4, wh, rise, roof, red, hd, hw);
    // stable doors under the eaves: a white frame, the lower and upper leaves
    const n = Math.max(2, Math.floor((2 * hw) / 2.3));
    for (let k = 0; k < n; k++) stable(xf, -hw + ((k + 0.5) * 2 * hw) / n, -hd);
    windows(turn(xf, PI), hw - 0.3, -hd, 1.3, n);
    return;
  }
  gable(xf, hw + 0.4, hd + 0.35, wh, rise, roof, red, hw, hd);
  // the doors: two dark leaves in a white frame with an X brace each, the hayloft door above
  const dw = Math.min(hw * 0.8, 2.2), z = -hd - 0.14;
  box(xf, -dw - 0.15, dw + 0.15, -0.2, 3.25, -hd - 0.08, -hd + 0.02, WHITE);
  box(xf, -dw, dw, 0, 3.1, -hd - 0.12, -hd - 0.06, c('#7A2A22'));
  G.color.copy(WHITE);
  for (const [a, b] of [[-dw, -0.05], [-0.05, -dw], [0.05, dw], [dw, 0.05]]) {
    const n = Math.hypot(b - a, 3.05), tx = (-3.05 / n) * 0.07, ty = ((b - a) / n) * 0.07;
    quad(xf, [a - tx, 0.05 - ty, z, b - tx, 3.05 - ty, z, b + tx, 3.05 + ty, z, a + tx, 0.05 + ty, z], [0, 0, -1]);
  }
  post(xf, 0, -hd - 0.03, 0.75, 0.05, wh + 0.15, wh + 1.35, WHITE);
  post(xf, 0, -hd - 0.09, 0.6, 0.03, wh + 0.25, wh + 1.25, c('#5A2420'));
  // the sides' windows, the back's stable door
  for (const a of [PI / 2, -PI / 2]) windows(turn(xf, a), hd - 0.4, -hw, 1.5, Math.max(2, Math.round(hd / 1.4)));
  stable(turn(xf, PI), 0, -hd);
}

/** A silo: a banded cylinder with a cap and a ladder. */
function silo(xf: Xf, it: Item) {
  const r = it.w / 2 - 0.2, col = cs('#C9D3DC', '#7FA9B8', '#E3DCCF')[it.s % 3];
  cyl(xf, 0, 0, r, -0.5, it.h, col, 12, false);
  for (let y = 1.5; y < it.h; y += 1.8) cyl(xf, 0, 0, r + 0.05, y, y + 0.14, shade(col, 0.8), 12, false);
  cone(xf, 0, 0, r + 0.12, it.h, it.h + r * 0.75, it.s % 2 ? RED : shade(col, 0.85), 12);
  // the ladder up its flat −z face (the 12-gon's face lies at r cos 15°): two rails and rungs
  const f = -0.966 * r;
  for (const x of [-0.24, 0.24]) box(xf, x - 0.035, x + 0.035, 0.2, it.h + 0.5, f - 0.16, f + 0.01, STEEL);
  for (let y = 0.5; y < it.h + 0.3; y += 0.42) box(xf, -0.21, 0.21, y, y + 0.05, f - 0.13, f - 0.08, STEEL);
}

/** A shed or a boathouse: plank walls, a gable roof, a door (a boathouse's is the whole gable). */
function shed(xf: Xf, it: Item) {
  const boat = it.t === T.boathouse, hw = it.w / 2 - 0.2, hd = it.d / 2 - 0.2, col = boat ? PALETTE.walls[it.c] ?? WOOD : it.s % 2 ? WOOD : c('#7FA36B');
  const rise = Math.min(hw * 0.8, 2.2), wh = Math.max(1.9, it.h - rise), dw = boat ? hw - 0.45 : 0.5;
  box(xf, -hw, hw, -0.6, wh, -hd, hd, col, 0.03, K.plain, { top: false });
  gable(xf, hw + 0.3, hd + 0.25, wh, rise, it.s % 3 ? c('#6E5248') : SLATE, col, hw, hd);
  box(xf, -dw, dw, 0, boat ? wh - 0.2 : 1.9, -hd - 0.06, -hd + 0.01, boat ? c('#5A4038') : shade(col, 0.6));
  if (boat) {
    box(xf, -dw - 0.12, dw + 0.12, wh - 0.2, wh, -hd - 0.08, -hd + 0.01, CREAM);
    // a rowing boat hauled up on its slip by the door
    hull(sub(xf, hw + 0.9, 0.35, -0.6, PI / 2), 2.6, STRIPES[it.s % 5]);
  }
}

/** A beach hut: a bright little box with white boards, a striped door, a pitched roof and a deck. */
function hut(xf: Xf, it: Item) {
  const col = HUTS[it.c % 6], hw = it.w / 2 - 0.15, hd = it.d / 2 - 0.45;
  box(xf, -hw - 0.1, hw + 0.1, -0.2, 0.18, -it.d / 2 + 0.05, hd + 0.1, WOOD, 0.03);
  box(xf, -hw, hw, 0.1, 2, -hd, hd, col, 0.03, K.plain, { top: false });
  posts(xf, hw, hd, 0.07, 0.15, 2, WHITE);
  gable(turn(xf, PI / 2), hd + 0.2, hw + 0.25, 2, 0.85, it.c % 2 ? WHITE : shade(col, 0.75), col, hd, hw);
  for (let k = 0; k < 4; k++) box(xf, -0.5 + k * 0.25, -0.25 + k * 0.25, 0.18, 1.75, -hd - 0.05, -hd + 0.01, k % 2 ? WHITE : shade(col, 0.7));
}

/** A dockside warehouse: long and low, a shallow roof, roller doors to the quay street, the company stripe. */
function warehouse(xf: Xf, it: Item) {
  const hw = it.w / 2 - 0.2, hd = it.d / 2 - 0.2, col = cs('#B9705A', '#7E9AA8', '#C9B48E')[it.s % 3], n = Math.max(1, Math.floor(it.w / 3.6));
  walls(xf, hw, hd, -0.8, it.h - 1.2, col, it.s, 2.8, 3, 7, 0.05);
  gable(turn(xf, PI / 2), hd + 0.3, hw + 0.3, it.h - 1.2, 1.2, STEEL, col, hd, hw);
  for (let i = 0; i < n; i++) {
    const x = -hw + ((i + 0.5) * 2 * hw) / n;
    box(xf, x - 1.05, x + 1.05, 0, 2.9, -hd - 0.08, -hd + 0.01, c('#59606E'));
    for (let y = 0.3; y < 2.9; y += 0.3) box(xf, x - 1, x + 1, y, y + 0.05, -hd - 0.11, -hd - 0.08, c('#6C7482'));
  }
  box(xf, -hw - 0.01, hw + 0.01, it.h - 2, it.h - 1.6, -hd - 0.02, hd + 0.02, AMBER, 0, K.plain, { top: false });
}

/** A quay crane: four legs straddling the apron, a machinery house, the boom out over the water (−z). */
function crane(xf: Xf, it: Item) {
  // (its gauge, d, is what the apron leaves between the coping and the quay street: towns/plan quayside)
  const h = it.h, col = it.s % 2 ? AMBER : STRIPES[0], lx = it.w / 2 - 0.2, lz = it.d / 2 - 0.15, top = h * 0.55, by = top + 2.4, hz = Math.max(1.2, lz + 0.3);
  posts(xf, lx, lz, 0.16, -0.1, top, col);
  for (const s of [-1, 1]) {
    post(xf, 0, s * lz, lx + 0.2, 0.22, top - 0.5, top, col);
    post(xf, s * lx, 0, 0.14, lz, 3, 3.25, col);
    post(xf, s * 0.5, 0, 0.1, 0.1, by, h, col);
  }
  box(xf, -1.2, 1.2, top, top + 2.2, -hz, hz, WHITE, 0.15);
  post(xf, 0, -hz - 0.02, 0.9, 0.04, top + 0.9, top + 1.7, GLASS);
  // the boom from a counterweight inland out over the water, stayed from the A-frame; the hook
  box(xf, -0.45, 0.45, by, by + 0.55, -10.5, 3.2, col);
  box(xf, -0.8, 0.8, by - 0.4, by + 0.9, 2.2, 3.6, DARK);
  post(xf, 0, 0, 0.6, 0.15, h - 0.2, h, col);
  G.color.copy(INK);
  for (const zt of [-10.3, 3]) quad(xf, [-0.03, h, 0, 0.03, h, 0, 0.03, by + 0.55, zt, -0.03, by + 0.55, zt], [0, 1, Math.sign(zt)]);
  post(xf, 0, -9.75, 0.05, 0.05, by - 3.5, by, INK);
  post(xf, 0, -9.75, 0.45, 0.45, by - 3.9, by - 3.5, c('#FFD54A'));
  glow(xf, 0, h, 0, 0.12, 1, 0.12, 0.08, -3);
}

/** The airport's control tower: a stem, the glazed cab, a roof and its beacon. */
function ctower(xf: Xf, it: Item) {
  const h = it.h;
  box(xf, -it.w / 2 + 0.2, it.w / 2 - 0.2, -0.8, 3, -it.d / 2 + 0.2, it.d / 2 - 0.2, CREAM, 0.2);
  cyl(xf, 0, 0, 0.9, 3, h - 3, c('#E9E2D2'), 10, false);
  for (let y = 4; y < h - 3.2; y += 1.6) cyl(xf, 0, 0, 0.94, y, y + 0.12, shade(SLATE, 1.2), 10, false);
  cyl(xf, 0, 0, 1.5, h - 3.1, h - 2.8, WHITE);
  G.param = 1024 + (it.s % 1024);
  cyl(xf, 0, 0, 1.55, h - 2.8, h - 1.2, c('#8EC9F0'), 8, false, K.facade);
  cyl(xf, 0, 0, 1.75, h - 1.2, h - 0.9, WHITE);
  cone(xf, 0, 0, 1.7, h - 0.9, h - 0.4, SLATE);
  post(xf, 0, 0, 0.04, 0.04, h - 0.5, h + 1.2, DARK);
  glow(xf, 0, h + 1.2, 0, 0.13, 1, 0.15, 0.1, -3);
}

/** A hangar: an arched roof over a long shed, its doors to the apron. */
function hangar(xf: Xf, it: Item) {
  const hw = it.w / 2 - 0.2, hd = it.d / 2 - 0.2, wh = Math.max(2.6, it.h - hw * 0.55);
  box(xf, -hw, hw, -0.8, wh, -hd + 0.1, hd, c('#C9CED6'), 0, K.plain, { top: false });
  const arc = (i: number) => [-hw * Math.cos((i / 8) * PI), wh + (it.h - wh) * Math.sin((i / 8) * PI)];
  for (let i = 0; i < 8; i++) {
    const [x0, y0] = arc(i), [x1, y1] = arc(i + 1);
    paint(i % 2 ? c('#9AA3B2') : c('#A9B2C0'));
    quad(xf, [x0, y0, -hd - 0.3, x1, y1, -hd - 0.3, x1, y1, hd + 0.2, x0, y0, hd + 0.2], [(x0 + x1) / 2, (y0 + y1) / 2 - wh + 0.5, 0]);
    G.color.copy(c('#B7BEC9'));
    for (const z of [-hd + 0.1, hd]) tri(xf, [x0, y0, z, x1, y1, z, 0, wh, z], [0, 0, z]);
  }
  box(xf, -hw + 0.3, hw - 0.3, 0, wh - 0.2, -hd - 0.05, -hd + 0.12, c('#4C5E7A'));
  for (let k = 0; k < 4; k++) post(xf, -hw + 0.3 + (k * (2 * hw - 0.6)) / 4, -hd - 0.065, 0.03, 0.025, 0, wh - 0.2, c('#2E3A50'));
  box(xf, -hw, hw, wh - 0.2, wh + 0.3, -hd - 0.08, -hd + 0.12, AMBER);
}

/** The windsock: a striped pole and an orange sock with a white band, streaming downwind. */
function sock(xf: Xf, it: Item) {
  for (let y = 0; y < it.h; y += 0.75) cyl(xf, 0, 0, 0.06, y, y + 0.75, (y / 0.75) % 2 ? WHITE : STRIPES[0], 6, false);
  const s = lie(sub(xf, 0, it.h - 0.15, 0, 0.6));
  cone(s, 0, 0, 0.3, 0.05, 1.9, c('#FF7A2E'));
  cyl(s, 0, 0, 0.31, 0, 0.25, WHITE, 8, false);
}

/** A chairlift station: a timber hut under a pitched roof, the bullwheel frame toward the line (+z). */
function station(xf: Xf, it: Item, cable: number) {
  const hw = it.w / 2 - 0.3, hd = it.d / 2 - 0.4;
  walls(xf, hw, hd * 0.55, -0.8, 2.8, TIMBER[1], it.s, 2, 3);
  gable(sub(xf, 0, 0, -hd * 0.1, PI / 2), hd * 0.55 + 0.5, hw + 0.5, 2.8, 1.2, RED, TIMBER[1], hd * 0.55, hw);
  // the bullwheel frame: two posts, a beam at cable height, the wheel
  for (const sx of [-1.2, 1.2]) post(xf, sx, hd - 0.05, 0.14, 0.15, -0.2, cable, DARK);
  post(xf, 0, hd - 0.05, 1.4, 0.25, cable - 0.1, cable + 0.25, DARK);
  cyl(xf, 0, hd + 0.4, 1, cable - 0.35, cable - 0.15, STEEL, 12);
}

/** A lift pylon: a steel column, its crossarm carrying the two cables (each side ±0.9 m). */
function pylon(xf: Xf, it: Item) {
  const h = it.h;
  cyl(xf, 0, 0, 0.3, -0.3, 0.4, STONE);
  cyl(xf, 0, 0, 0.17, 0.4, h + 0.3, c('#7E8594'));
  post(xf, 0, 0, 1.15, 0.12, h + 0.3, h + 0.55, c('#59606E'));
  for (const sx of [-0.9, 0.9]) cyl(xf, sx, 0, 0.16, h + 0.08, h + 0.3, DARK, 6);
}

/**
 * A resort hotel: white (or pastel) storeys of rooms behind a loggia front and back, a balcony with a
 * coloured rail on every floor between end walls that run out flush with the rails (from the side it is
 * one flat slab), a glazed lobby under a striped canopy, a parapet band and name board, a pool on the roof.
 */
function hotel(xf: Xf, it: Item) {
  const col = HOTELS[it.c % 5], hw = it.w / 2 - 0.35, hd = it.d / 2 - 0.35, H = it.h, g1 = 3.3, acc = STRIPES[it.s % 5], bd = 0.9, sides = hd > 2.6 ? [-1, 1] : [-1];
  walls(xf, hw - 0.15, hd - 0.15, -0.8, g1, CREAM, it.s, 2.4, 3.3, 4, 0.05);
  const nf = Math.max(1, Math.round((H - g1) / 2.9)), fh = (H - g1) / nf, zb = hd - (sides.length > 1 ? bd : 0);
  // (the rooms' block between its loggias; z centre zc)
  const zc = (zb - (hd - bd)) / 2, rooms = sub(xf, 0, 0, zc);
  walls(rooms, hw, (zb + hd - bd) / 2, g1, H, col, it.s + 3, 2.1, fh, 1, 0.08);
  box(xf, -hw - 0.1, hw + 0.1, g1 - 0.1, g1 + 0.12, -hd - 0.1, hd + 0.1, WHITE, 0, K.plain, { bottom: true });
  for (const sx of [-1, 1]) for (const sz of sides) box(xf, sx < 0 ? -hw : hw - 0.25, sx < 0 ? -hw + 0.25 : hw, g1 + 0.12, H, sz < 0 ? -hd : hd - bd, sz < 0 ? -hd + bd : hd, col, 0, K.plain, { top: false });
  // the parapet, its coloured band; the name board over the front
  box(xf, -hw - 0.15, hw + 0.15, H - 0.05, H + 0.55, -hd - 0.15, hd + 0.15, WHITE, 0.04, K.plain, { bottom: true });
  box(xf, -hw - 0.16, hw + 0.16, H + 0.12, H + 0.3, -hd - 0.16, hd + 0.16, acc, 0, K.plain, { top: false });
  box(xf, -1.7, 1.7, H + 0.55, H + 1.45, -hd + 0.05, -hd + 0.25, acc, 0.05);
  box(xf, -1.45, 1.45, H + 0.7, H + 1.3, -hd - 0.01, -hd + 0.05, WHITE);
  // the balconies: a slab on every floor above the first, a rail with its coloured panel on every one
  for (let k = 0; k < nf; k++) {
    const y = g1 + 0.12 + k * fh;
    for (const s of sides) {
      const z0 = s < 0 ? -hd : hd - bd, z1 = s < 0 ? -hd + bd : hd, zr = s < 0 ? -hd : hd - 0.07;
      if (k) box(xf, -hw + 0.25, hw - 0.25, y - 0.16, y, z0, z1, WHITE, 0, K.plain, { bottom: true });
      box(xf, -hw + 0.25, hw - 0.25, y, y + 0.9, zr, zr + 0.07, k % 2 ? acc : shade(acc, 1.1));
      box(xf, -hw + 0.25, hw - 0.25, y + 0.9, y + 1, zr - 0.02, zr + 0.09, WHITE);
    }
  }
  // the canopy over the doors
  box(xf, -2, 2, g1 - 0.55, g1 - 0.38, -hd - 1.7, -hd + 0.1, acc, 0.03);
  box(xf, -2, 2, g1 - 0.75, g1 - 0.55, -hd - 1.72, -hd - 1.62, WHITE);
  for (const x of [-1.85, 1.85]) post(xf, x, -hd - 1.6, 0.05, 0.05, 0, g1 - 0.55, WHITE);
  // a pool on the roof deck, two umbrellas by it
  if (hw > 2.6 && hd > 2.2) {
    box(xf, -hw + 0.3, hw - 0.3, H - 0.05, H + 0.16, -hd + 0.3, hd - 0.3, c('#E6D2B5'), 0.03, K.plain, { bottom: false });
    water(xf, -hw * 0.62, hw * 0.62, -hd * 0.1, hd - 0.9, H + 0.18);
    for (const x of [-hw * 0.55, hw * 0.55]) umbrella(sub(xf, x, H + 0.16, -hd + 1.3), { ...it, h: 2, c: it.c + (x > 0 ? 1 : 2), f: 0 });
  }
}

/**
 * A resort villa: white or pastel stucco under a low terracotta hip roof (or a flat roof, its parapet and
 * a sun umbrella on the terrace), shutters, its door in the front's middle; a wide one a pergola over a
 * terrace at its side, a vine climbing it.
 */
function villa(xf: Xf, it: Item) {
  const col = VILLAS[it.c % 5], pw = it.w > 5.6 ? 1.9 : 0, hw = (it.w - pw) / 2 - 0.2, hd = it.d / 2 - 0.25, H = Math.max(3.3, it.h - (it.v ? 0.5 : 1.3));
  const b = sub(xf, -pw / 2, 0, 0);
  walls(b, hw, hd, -0.8, H, col, it.s, 1.7, 2.9, 3, 0.06);
  box(b, -hw - 0.03, hw + 0.03, -0.8, 0.3, -hd - 0.03, hd + 0.03, shade(col, 0.8), 0.03, K.plain, { top: false });
  if (it.v) {
    box(b, -hw - 0.1, hw + 0.1, H - 0.05, H + 0.45, -hd - 0.1, hd + 0.1, WHITE, 0.03, K.plain, { bottom: true });
    umbrella(sub(b, hw * 0.35, H + 0.05, hd * 0.2), { ...it, h: 1.9, f: 0 });
  } else hip(b, hw + 0.38, hd + 0.38, H, Math.min(hw, hd) * 0.45 + 0.3, TERRA);
  door(b, pw / 2, -hd, STRIPES[1 + (it.s % 2) * 2]);
  if (!pw) return;
  const x0 = it.w / 2 - pw, x1 = it.w / 2 - 0.2, z0 = -hd, z1 = hd * 0.3, ph = 2.5, rng = new Rng(it.s);
  for (const x of [x0 + 0.12, x1 - 0.1]) {
    for (const z of [z0 + 0.1, z1 - 0.1]) post(xf, x, z, 0.07, 0.07, 0, ph, WHITE);
    box(xf, x - 0.06, x + 0.06, ph - 0.05, ph + 0.12, z0 - 0.15, z1 + 0.15, WHITE);
  }
  for (let k = 0; k < 6; k++) box(xf, x0 - 0.1, x1 + 0.12, ph + 0.12, ph + 0.22, z0 + ((z1 - z0) * k) / 5 - 0.04, z0 + ((z1 - z0) * k) / 5 + 0.04, WOOD);
  lump(xf, (x0 + x1) / 2, ph + 0.3, z0 + 0.5, 0.75, 0.22, 0.6, LEAF[2], rng);
  lump(xf, x1 - 0.15, ph * 0.5, z0 + 0.12, 0.22, ph * 0.5, 0.22, LEAF[1], rng);
  for (const z of [z0 + 0.6, z0 + 1.2]) lump(xf, x1 - 0.1, ph + 0.15, z, 0.18, 0.12, 0.18, BLOOM[2], rng);
  tub(xf, (x0 + x1) / 2, (z0 + z1) / 2, rng);
}

/** A square's centrepiece (towns/plan CENTRE), standing on the square's ground. */
function centre(xf: Xf, it: Item) {
  const r = it.w / 2, rng = new Rng(it.s);
  if (it.c === CENTRE.lighthouse) {
    // a little striped lighthouse on a round stone plinth: the gallery and its rail, the lamp (lit at night), a red cap
    cyl(xf, 0, 0, Math.min(r, 1.25), -0.4, 0.5, STONE, 12);
    for (let k = 0; k < 5; k++) cyl(xf, 0, 0, 0.78 - k * 0.07, 0.5 + k * 0.8, 1.3 + k * 0.8, k % 2 ? WHITE : RED, 10, false);
    cyl(xf, 0, 0, 0.66, 4.5, 4.62, DARK, 10);
    for (let k = 0; k < 10; k++) post(xf, Math.cos(k * 0.628) * 0.6, Math.sin(k * 0.628) * 0.6, 0.02, 0.02, 4.62, 4.98, DARK);
    glow(xf, 0, 4.62, 0, 0.3, 1, 0.86, 0.5, 2.2);
    cone(xf, 0, 0, 0.5, 5.22, 5.8, RED, 10);
    for (let k = 0; k < 4; k++) tub(xf, Math.cos(k * 1.571 + 0.785) * (r - 0.3), Math.sin(k * 1.571 + 0.785) * (r - 0.3), rng);
  } else if (it.c === CENTRE.anchor) {
    // a fishing village's anchor on a stone plinth: the shank, the wooden stock, the ring, the arms and their flukes
    box(xf, -0.85, 0.85, -0.4, 0.55, -0.6, 0.6, STONE, 0.08);
    const a = sub(xf, 0, 0.55, 0);
    post(a, 0, 0, 0.09, 0.09, 0.2, 2.6, IRON);
    box(a, -0.85, 0.85, 2.2, 2.36, -0.08, 0.08, WOOD, 0.03);
    for (let k = 0; k < 8; k++) post(roll(sub(a, Math.cos(k * 0.785) * 0.22, 2.82 + Math.sin(k * 0.785) * 0.22, 0), k * 0.785), 0, 0, 0.05, 0.05, -0.1, 0.1, IRON);
    for (const s of [-1, 1]) {
      post(roll(sub(a, s * 0.36, 0.42, 0), -s * 0.95), 0, 0, 0.08, 0.08, -0.45, 0.45, IRON);
      post(roll(sub(a, s * 0.72, 0.78, 0), -s * 0.5), 0, 0, 0.16, 0.05, -0.2, 0.2, IRON);
    }
    for (const [x, z] of [[-1.05, -0.8], [1.05, 0.8], [1.05, -0.8], [-1.05, 0.8]]) tub(xf, x, z, rng);
  } else if (it.c === CENTRE.pond) {
    // a duck pond on the green: a stone kerb, the water, reeds and lily pads, three ducks
    const n = 16, R0 = r - 0.4, ring: number[] = [];
    for (let k = 0; k < n; k++) {
      ring.push(Math.cos((k / n) * PI * 2) * R0, Math.sin((k / n) * PI * 2) * R0);
    }
    // (the kerb: a stone per side of the ring, outside it, a little uneven)
    const l = R0 * 0.2 + 0.24;
    for (let k = 0; k < n; k++) box(sub(xf, Math.cos((k + 0.5) * 0.3927) * (R0 + 0.2), 0, Math.sin((k + 0.5) * 0.3927) * (R0 + 0.2), (k + 0.5) * 0.3927 + PI / 2), -l, l, -0.25, 0.26 + (k % 3) * 0.03, -0.22, 0.22, shade(STONE, 0.9 + (k % 3) * 0.05), 0.06);
    paint(POOL, K.water);
    G.capRing(xf, ring, 0.18, true);
    for (let k = 0; k < 3; k++) {
      const t = rng.range(0, PI * 2), d = rng.range(0, R0 * 0.55), x = Math.cos(t) * d, z = Math.sin(t) * d, f = sub(xf, x, 0.2, z, rng.range(0, PI * 2));
      lump(f, 0, 0.1, 0, 0.2, 0.12, 0.28, WHITE, rng, K.plain);
      lump(f, 0, 0.3, -0.22, 0.1, 0.1, 0.1, WHITE, rng, K.plain);
      box(f, -0.04, 0.04, 0.26, 0.31, -0.4, -0.3, c('#FF9A2E'));
    }
    for (let k = 0; k < 4; k++) cyl(xf, Math.cos(k * 1.9 + 1) * R0 * 0.6, Math.sin(k * 1.9 + 1) * R0 * 0.6, 0.28, 0.16, 0.2, LEAF[k % 4], 7);
    for (let k = 0; k < 14; k++) {
      const t = (k < 7 ? 0.6 : 3.5) + rng.range(0, 0.5), x = Math.cos(t) * (R0 - 0.25), z = Math.sin(t) * (R0 - 0.25), h = rng.range(0.7, 1.2);
      post(xf, x, z, 0.025, 0.025, 0.1, h, PINE[k % 3]);
      if (k % 2) post(xf, x, z, 0.05, 0.05, h - 0.25, h - 0.05, c('#7A5236'));
    }
  } else if (it.c === CENTRE.maypole) {
    // the maypole: a white pole, a wreath and a gold ball, ribbons pegged out round it, flowers at its foot
    cyl(xf, 0, 0, 0.1, -0.3, 6, WHITE, 8);
    cyl(xf, 0, 0, 0.42, 5.2, 5.5, LEAF[0], 10, true, K.leaf);
    lump(xf, 0, 6.12, 0, 0.18, 0.18, 0.18, HAY, rng, K.plain);
    for (let k = 0; k < 8; k++) {
      const t = (k / 8) * PI * 2, ca = Math.cos(t), sa = Math.sin(t), ex = ca * (r - 0.15), ez = sa * (r - 0.15), w = 0.06;
      paint(STRIPES[k % 5]);
      for (const f of [1, -1]) quad(xf, [ca * 0.12 - sa * w, 5.3, sa * 0.12 + ca * w, ca * 0.12 + sa * w, 5.3, sa * 0.12 - ca * w, ex + sa * w, 0.08, ez - ca * w, ex - sa * w, 0.08, ez + ca * w], [ca * f, 0.3 * f, sa * f]);
      post(xf, ex, ez, 0.04, 0.04, -0.1, 0.22, WOOD);
    }
    for (let k = 0; k < 5; k++) lump(xf, Math.cos(k * 1.26) * 0.35, 0.15, Math.sin(k * 1.26) * 0.35, 0.22, 0.16, 0.22, BLOOM[k], rng);
  } else if (it.c === CENTRE.trough) {
    // an alpine island: a fir decked with baubles, fairy lights (lit at night) and a gold star, a trough
    // fountain before it (a hollowed log on legs, its spout post, geraniums along it), tubs round its rim
    cyl(xf, 0, 0, 0.16, -0.2, 1.1, c('#7A5236'), 6);
    for (let k = 0; k < 3; k++) cone(xf, 0, 0, 0.9 - k * 0.22, 0.9 + k * 0.85, 2.3 + k * 0.8, shade(PINE[k % 3], 1 + k * 0.06), 8, K.leaf);
    for (let k = 0; k < 24; k++) {
      const y = rng.range(1.05, 3.6), t = rng.range(0, PI * 2), j = Math.min(2, Math.floor((y - 0.9) / 0.85)), y0 = 0.9 + j * 0.85;
      const cr = (0.9 - j * 0.22) * (1 - (y - y0) / (1.4 - j * 0.05)) + 0.03, x = Math.cos(t) * cr, z = Math.sin(t) * cr;
      if (k % 3) lump(xf, x, y, z, 0.08, 0.08, 0.08, [RED, HAY, STRIPES[3], WHITE][k % 4], rng, K.plain);
      else glow(xf, x, y - 0.03, z, 0.035, 1, 0.85, 0.45, 1.4);
    }
    paint(HAY);
    for (const f of [0, PI / 2]) {
      const st = sub(xf, 0, 4.25, 0, f);
      for (const n of [1, -1]) {
        tri(st, [-0.22, 0.05, 0, 0.22, 0.05, 0, 0, 0.42, 0], [0, 0, n]);
        tri(st, [-0.22, 0.28, 0, 0.22, 0.28, 0, 0, -0.1, 0], [0, 0, n]);
      }
    }
    glow(xf, 0, 4.36, 0, 0.05, 1, 0.9, 0.5, 1.8);
    const t = sub(xf, 0, 0, -(r - 0.35));
    for (const x of [-0.65, 0.65]) post(t, x, 0, 0.08, 0.2, -0.2, 0.35, TIMBER[0]);
    box(t, -0.9, 0.9, 0.35, 0.85, -0.3, 0.3, TIMBER[1], 0.08);
    water(t, -0.8, 0.8, -0.2, 0.2, 0.8);
    post(t, 0.75, 0.36, 0.1, 0.1, 0, 1.35, TIMBER[2]);
    post(t, 0.75, 0.2, 0.025, 0.12, 1.1, 1.15, STEEL);
    box(t, -0.85, 0.85, 0.55, 0.75, -0.46, -0.3, TIMBER[0]);
    for (let x = -0.7; x < 0.8; x += 0.35) lump(t, x, 0.86, -0.38, 0.16, 0.12, 0.12, BLOOM[0], rng);
    for (let k = 1; k < 8; k++) tub(xf, Math.sin(k * 0.785) * (r - 0.3), -Math.cos(k * 0.785) * (r - 0.3), rng);
  } else {
    // the city's water feature: a square basin, jets in a ring, a bright steel hoop on a plinth
    basin(xf, r - 0.22, r - 0.22, 0.22, 0.22, STONE);
    box(xf, -0.5, 0.5, -0.2, 0.55, -0.5, 0.5, shade(STONE, 0.85), 0.05);
    for (let k = 0; k < 14; k++) post(roll(sub(xf, Math.cos(k * 0.449) * 0.85, 1.42 + Math.sin(k * 0.449) * 0.85, 0), k * 0.449), 0, 0, 0.09, 0.12, -0.2, 0.2, AMBER);
    for (let k = 0; k < 8; k++) {
      const x = Math.cos(k * 0.785) * (r - 0.75), z = Math.sin(k * 0.785) * (r - 0.75), h = 1 + (k % 2) * 0.5;
      cone(xf, x, z, 0.07, 0.2, h, c('#E4F7FF'), 6, K.water);
      lump(xf, x, h - 0.02, z, 0.09, 0.07, 0.09, WHITE, rng, K.plain);
    }
  }
}

/** A market stall: a counter of produce crates on trestles under a striped awning on four poles. */
function stall(xf: Xf, it: Item) {
  const hw = it.w / 2 - 0.1, hd = it.d / 2 - 0.1, col = STRIPES[it.c % 5];
  box(xf, -hw + 0.15, hw - 0.15, 0.72, 0.85, -hd + 0.05, hd - 0.35, WOOD, 0.03);
  for (const sx of [-1, 1]) post(xf, sx * (hw - 0.35), -0.15, 0.05, hd - 0.45, 0, 0.72, shade(WOOD, 0.8));
  for (let x = -hw + 0.45, k = 0; x < hw - 0.3; x += 0.56, k++) box(xf, x - 0.24, x + 0.24, 0.85, 1.06, -hd + 0.15, hd - 0.5, [RED, HAY, c('#7FB04A'), c('#FF8A3D')][(it.s + k) % 4], 0.04);
  posts(xf, hw - 0.05, hd - 0.05, 0.04, 0, 2.3, WHITE);
  const n = 6, sw = (2 * hw) / n;
  for (let k = 0; k < n; k++) box(xf, -hw + k * sw, -hw + (k + 1) * sw, 2.3, 2.42, -hd - 0.3, hd, k % 2 ? WHITE : col, 0);
  box(xf, -hw, hw, 2.02, 2.3, -hd - 0.32, -hd - 0.26, col);
}

/** A palm-thatched bar (on a resort's pool deck and its beach): a round counter, stools, the post under a conical thatch, a lamp under it. */
function bar(xf: Xf, it: Item) {
  const r = it.w / 2 - 0.2;
  cyl(xf, 0, 0, r * 0.6, -0.3, 1.05, WOOD, 10);
  cyl(xf, 0, 0, r * 0.66, 1.05, 1.15, CREAM, 10);
  cyl(xf, 0, 0, 0.1, 1.15, 2.7, TIMBER[0], 6);
  cone(xf, 0, 0, r + 0.35, 2.35, 3.4, c('#D9B26A'), 12);
  cyl(xf, 0, 0, r + 0.35, 2.2, 2.35, c('#B8924E'), 12, false);
  glow(xf, 0, 2.05, 0, 0.09, 1, 0.8, 0.4, 1.4);
  for (let k = 0; k < 6; k++) {
    const x = Math.cos(k * 1.047) * (r * 0.6 + 0.42), z = Math.sin(k * 1.047) * (r * 0.6 + 0.42);
    post(xf, x, z, 0.04, 0.04, -0.1, 0.62, STEEL);
    cyl(xf, x, z, 0.17, 0.62, 0.72, STRIPES[k % 5], 8);
  }
}

/** A sun lounger at (x, z) facing −z: a white frame, a striped pad, its back raised. */
function lounger(xf: Xf, x: number, z: number, col: Color) {
  box(xf, x - 0.3, x + 0.3, 0.18, 0.3, z - 0.9, z + 0.5, WHITE, 0.02);
  for (const [a, b] of [[-0.85, -0.75], [0.35, 0.45]]) for (const sx of [-0.25, 0.25]) post(xf, x + sx, z + (a + b) / 2, 0.03, 0.03, -0.1, 0.2, WHITE);
  box(xf, x - 0.27, x + 0.27, 0.3, 0.36, z - 0.88, z + 0.1, col, 0.02);
  paint(col);
  quad(xf, [x - 0.27, 0.36, z + 0.1, x + 0.27, 0.36, z + 0.1, x + 0.27, 0.95, z + 0.62, x - 0.27, 0.95, z + 0.62], [0, 0.6, -0.8]);
  quad(xf, [x + 0.27, 0.3, z + 0.16, x - 0.27, 0.3, z + 0.16, x - 0.27, 0.9, z + 0.68, x + 0.27, 0.9, z + 0.68], [0, -0.6, 0.8]);
}

/** The resort square's pool: a white coping round turquoise water, a ladder, loungers along both sides and an umbrella at each end. */
function pool(xf: Xf, it: Item) {
  const hw = it.w / 2 - 0.9, hd = it.d / 2 - 0.9;
  basin(xf, hw, hd, 0.35, 0.22, WHITE);
  for (const x of [-0.25, 0.25]) post(xf, hw - 1 + x, -hd + 0.3, 0.03, 0.03, 0.2, 1.1, STEEL);
  for (let x = -hw + 0.6, k = 0; x < hw - 0.3; x += 1.35, k++) for (const s of [-1, 1]) lounger(sub(xf, 0, 0, s * (hd + 1.45), s > 0 ? PI : 0), x * s, 0, STRIPES[(it.s + k) % 5]);
  for (const s of [-1, 1]) umbrella(sub(xf, s * (hw + 1.3), 0, 0), { ...it, h: 2.3, c: it.c + s + 2, f: 0 });
}

/** A lifeguard's tower on the sand: four legs, a deck, a red hut with a white roof, the ladder behind, a flag. */
function lifeguard(xf: Xf, it: Item) {
  posts(xf, 0.75, 0.75, 0.07, -0.4, 2.2, WHITE);
  box(xf, -1, 1, 2.2, 2.35, -1.25, 1, WOOD, 0.03);
  box(xf, -0.8, 0.8, 2.35, 3.6, -0.55, 0.8, RED, 0.04, K.plain, { top: false });
  box(xf, -0.4, 0.4, 2.9, 3.35, -0.58, -0.54, GLASS);
  box(xf, -0.98, 0.98, 3.6, 3.75, -0.75, 1, WHITE, 0.03);
  box(xf, -0.95, 0.95, 2.35, 3, -1.24, -1.18, WHITE);
  for (const sx of [-0.3, 0.3]) post(xf, sx, 1.18, 0.035, 0.035, -0.2, 2.3, WHITE);
  for (let y = 0.25; y < 2.2; y += 0.38) box(xf, -0.3, 0.3, y, y + 0.05, 1.15, 1.21, WHITE);
  post(xf, 0.88, -0.95, 0.03, 0.03, 3.6, 5, WHITE);
  box(xf, 0.91, 1.6, 4.45, 4.95, -0.97, -0.93, RED);
}

/** On an airport's apron: a fuel truck, a tug with its baggage carts, cones. */
function apron(xf: Xf, it: Item) {
  const wheel = (x: number, z: number, r: number) => {
    for (const s of [-1, 1]) cyl(lie(sub(xf, x + s * 0.55, r, z, s > 0 ? 0 : PI)), 0, 0, r, 0, 0.2, DARK, 8);
  };
  // the fuel truck: a cab and a tank along local z
  box(xf, -0.6, 0.6, 0.35, 1.7, -2.4, -1.3, AMBER, 0.08);
  box(xf, -0.55, 0.55, 1.05, 1.5, -2.42, -1.75, GLASS);
  cyl(lie(sub(xf, 0, 1.15, -1.25, PI / 2)), 0, 0, 0.62, 0, 2.6, WHITE, 10);
  box(xf, -0.62, 0.62, 0.25, 0.55, -2.4, 1.4, DARK);
  wheel(0, -1.9, 0.32);
  wheel(0, 0.9, 0.32);
  // the tug and three carts beside it
  box(xf, 1.4, 2.4, 0.2, 0.9, -2.2, -1.2, c('#FFD54A'), 0.06);
  for (let k = 0; k < 3; k++) {
    const z = -0.7 + k * 1.3;
    box(xf, 1.45, 2.35, 0.25, 0.4, z - 0.5, z + 0.5, STEEL, 0.02);
    box(xf, 1.5, 2.3, 0.4, 0.95, z - 0.4, z + 0.35, STRIPES[(it.s + k) % 5], 0.06);
  }
  for (const [x, z] of [[-1.3, -2.8], [1.2, -2.9], [-1.3, 2], [0.2, 2.3]]) cone(xf, x, z, 0.16, 0, 0.5, c('#FF7A2E'), 6);
}

// ── nature and gardens ──

function tree(xf: Xf, it: Item) {
  const kind = it.t, rng = new Rng(it.s), h = it.h, cr = it.w / 2;
  if (kind === T.pine) {
    cyl(xf, 0, 0, 0.16, -0.2, h * 0.3, c('#7A5236'), 5);
    for (let k = 0; k < 3; k++) cone(xf, 0, 0, cr * (1 - k * 0.24), h * (0.18 + k * 0.24), h * (0.55 + k * 0.22), shade(PINE[it.c % 3], 1 + k * 0.06), 7, K.leaf);
    return;
  }
  if (kind === T.palm) {
    let x = 0;
    for (let k = 0; k < 5; k++) {
      const y0 = (k / 5) * h * 0.86, y1 = ((k + 1) / 5) * h * 0.86;
      cyl(sub(xf, x, y0, 0), 0, 0, 0.17 - k * 0.015, 0, y1 - y0 + 0.02, k % 2 ? c('#AD8660') : c('#987251'), 6, false);
      x = 0.22 * ((k + 1) / 5) ** 2 * h;
    }
    const top = h * 0.86, L = cr + 0.6;
    paint(LEAF[(it.c + 1) % 4], K.leaf);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * PI * 2 + rng.float() * 0.4, dx = Math.cos(a), dz = Math.sin(a), sx = -dz * 0.38, sz = dx * 0.38;
      const mx = x + dx * L * 0.55, my = top + 0.35, mz = dz * L * 0.55;
      for (const f of [1, -1]) {
        tri(xf, [x, top, 0, mx + sx, my, mz + sz, mx - sx, my, mz - sz], [0, f, 0]);
        tri(xf, [mx + sx, my, mz + sz, x + dx * L, top - 0.45, dz * L, mx - sx, my, mz - sz], [0, f, 0]);
      }
    }
    lump(xf, x, top - 0.1, 0, 0.28, 0.24, 0.28, c('#7A5A3A'), rng, K.plain);
    return;
  }
  const col = LEAF[it.c % 4];
  if (kind === T.bush) {
    lump(xf, 0, h * 0.5, 0, cr * 0.7, h * 0.55, cr * 0.7, col, rng);
    lump(xf, cr * 0.35, h * 0.38, cr * 0.2, cr * 0.45, h * 0.4, cr * 0.45, shade(col, 1.08), rng);
    return;
  }
  cyl(xf, 0, 0, 0.18, -0.2, h * 0.55, c('#8F6444'), 6);
  lump(xf, 0, h * 0.68, 0, cr * 0.72, h * 0.3, cr * 0.72, col, rng);
  lump(xf, cr * 0.38, h * 0.55, cr * 0.15, cr * 0.55, h * 0.24, cr * 0.55, shade(col, 0.94), rng);
  lump(xf, -cr * 0.35, h * 0.56, -cr * 0.28, cr * 0.5, h * 0.22, cr * 0.5, shade(col, 1.06), rng);
}

/** A run of picket fence (or a lumpy hedge) from x0 to x1 along local x at z, with an optional gap at the middle. */
function fence(xf: Xf, x0: number, x1: number, z: number, hedge: boolean, gap: number, rng: Rng) {
  for (const [a, b] of gap ? [[x0, -gap], [gap, x1]] : [[x0, x1]]) {
    if (b - a < 0.3) continue;
    if (hedge) {
      for (let s = a, len = 0; s < b - 0.15; s += len) {
        len = Math.min(b - s, 0.9 + rng.float() * 0.6);
        box(xf, s - 0.06, s + len + 0.06, -0.3, 0.8 + rng.float() * 0.35, z - 0.3, z + 0.3, shade(LEAF[3], 1 + rng.float() * 0.16), 0.2, K.leaf);
      }
      continue;
    }
    for (const y of [0.32, 0.6]) box(xf, a, b, y, y + 0.08, z - 0.03, z + 0.03, WHITE);
    for (let s = a; s <= b + 1e-6; s += 0.42) box(xf, s - 0.04, s + 0.04, -0.1, 0.82, z - 0.04, z + 0.04, WHITE, 0, K.plain, { bottom: false });
  }
}

/** A front garden's fence along the street, or a back garden's three sides and what grows in it. */
function garden(xf: Xf, it: Item, site: Site) {
  const rng = new Rng(it.s), hw = it.w / 2 - 0.15, hd = it.d / 2 - 0.15, hedge = (it.f & F.hedge) > 0;
  if (it.f & F.frontFence) return fence(xf, -hw, hw, -hd + 0.1, hedge, 0.55, rng);
  fence(xf, -hw, hw, hd, hedge, 0, rng);
  for (const s of [-1, 1]) fence(sub(xf, s * hw, 0, 0, (s * PI) / 2), -hd, hd, 0, hedge, 0, rng);
  if (it.c === 1 && hd > 1.4 && hw > 1.6) {
    // a pool behind a villa
    box(xf, -hw + 0.5, hw - 0.5, -0.3, 0.12, -hd + 0.4, hd - 0.6, WHITE, 0.05, K.plain, { top: false });
    water(xf, -hw + 0.75, hw - 0.75, -hd + 0.65, hd - 0.85, 0.06);
    return;
  }
  const what = rng.int(0, 3);
  if (what === 0 && hd > 1) tree(sub(xf, rng.range(-hw + 1.2, hw - 1.2), 0, hd * 0.3), { ...it, t: site.style === 'alpine' ? T.pine : T.tree, w: Math.min(3, 2 * hd), h: rng.range(3.2, 4.6), c: rng.int(0, 3) });
  else if (what === 1 && hd > 1.2 && hw > 1.4) shed(sub(xf, hw - 1.1, 0, hd - 1), { ...it, w: 1.8, d: 1.6, h: 2.2 });
  else if (hd > 1) {
    // vegetable beds
    for (let x = -hw + 0.8; x < hw - 0.6; x += 1.3) {
      box(xf, x - 0.45, x + 0.45, -0.1, 0.22, -hd + 0.6, hd - 0.6, c('#7A5236'), 0.04);
      for (let z = -hd + 0.9; z < hd - 0.7; z += 0.6) box(xf, x - 0.18, x + 0.18, 0.2, 0.42, z - 0.16, z + 0.16, LEAF[Math.abs(Math.round(z * 3)) % 4], 0.08, K.leaf);
    }
  }
}

/** A paddock: post-and-rail fence all round (a gate gap), round bales of hay inside. */
function paddock(xf: Xf, it: Item) {
  const rng = new Rng(it.s), hw = it.w / 2, hd = it.d / 2;
  const rail = (f: Xf, a: number, b: number) => {
    for (const y of [0.55, 1]) box(f, a, b, y, y + 0.08, -0.04, 0.04, WOOD);
    for (let s = a; s <= b + 1e-6; s += (b - a) / Math.max(1, Math.round((b - a) / 1.8))) box(f, s - 0.07, s + 0.07, -0.2, 1.15, -0.07, 0.07, shade(WOOD, 0.8), 0, K.plain, { bottom: false });
  };
  rail(sub(xf, 0, 0, -hd), -hw, hw);
  rail(sub(xf, 0, 0, hd), -hw, -0.9);
  rail(sub(xf, 0, 0, hd), 0.9, hw);
  for (const s of [-1, 1]) rail(sub(xf, s * hw, 0, 0, PI / 2), -hd, hd);
  for (let k = rng.int(2, 4); k > 0; k--) bale(xf, rng.range(-hw + 1.2, hw - 1.2), 0, rng.range(-hd + 1.2, hd - 1.2), rng.range(0, 3));
}

/** A round bale of hay on its side at (x, y, z): two capped halves. */
function bale(xf: Xf, x: number, y: number, z: number, a: number) {
  for (const b of [0, PI]) cyl(lie(sub(xf, x, y + 0.6, z, a + b)), 0, 0, 0.6, 0, 0.55, b ? HAY : shade(HAY, 0.9), 10);
}

/** Bales stacked in a farmyard: two side by side and one on top (a small stack: one). */
function bales(xf: Xf, it: Item) {
  const big = it.w > 2;
  bale(xf, big ? -0.6 : 0, 0, 0, 0.1);
  if (!big) return;
  bale(xf, 0.6, 0, 0.05, -0.05);
  bale(xf, 0, 0.95, 0.02, 0.02);
}

/** A little tractor (facing −z): a bonnet, a cab with its glass, big wheels at the back. */
function tractor(xf: Xf, it: Item) {
  const col = [RED, c('#3F8F4A'), c('#3D78C8')][it.c % 3];
  box(xf, -0.45, 0.45, 0.5, 1.15, -1.45, 0.1, col, 0.08);
  box(xf, -0.6, 0.6, 0.55, 1.05, 0.1, 1.2, col, 0.05);
  box(xf, -0.55, 0.55, 1.05, 2, 0.15, 1.15, GLASS, 0.03);
  box(xf, -0.62, 0.62, 2, 2.1, 0.05, 1.25, col, 0.03);
  post(xf, 0.25, -1.1, 0.05, 0.05, 1.15, 1.75, DARK);
  for (const [z, r] of [[0.75, 0.62], [-1, 0.38]]) for (const sx of [-1, 1]) cyl(lie(sub(xf, sx * 0.62, r, z, sx > 0 ? 0 : PI)), 0, 0, r, 0, 0.3, DARK, 10);
}

/** A woodpile: logs stacked three rows high against a little lean-to roof. */
function woodpile(xf: Xf, it: Item) {
  const hw = it.w / 2 - 0.1;
  for (let r = 0; r < 3; r++) for (let x = -hw + 0.18 + r * 0.09; x < hw - 0.15; x += 0.36) cyl(sub(lie(sub(xf, 0, 0.18 + r * 0.31, -0.35, PI / 2)), x, 0, 0), 0, 0, 0.16, 0, 0.7, r % 2 ? WOOD : shade(WOOD, 0.85), 6);
  box(xf, -hw - 0.1, hw + 0.1, 1.05, 1.15, -0.5, 0.45, c('#6E5248'), 0.03);
  for (const x of [-hw, hw]) post(xf, x, 0.35, 0.05, 0.05, 0, 1.1, TIMBER[0]);
}

/** A boat hauled out on its cradle: two trestles, the hull on them. */
function cradle(xf: Xf, it: Item) {
  for (const z of [-0.9, 0.9]) {
    box(xf, -0.55, 0.55, 0.45, 0.6, z - 0.1, z + 0.1, WOOD);
    for (const x of [-0.45, 0.45]) post(xf, x, z, 0.06, 0.06, 0, 0.5, WOOD);
  }
  hull(sub(xf, 0, 0.55, 0), it.d - 0.4, STRIPES[it.c % 5]);
}

/** An open fish market hall facing the quay (−z): white posts, a striped roof, counters of fish in ice, its sign. */
function market(xf: Xf, it: Item) {
  const hw = it.w / 2 - 0.25, hd = it.d / 2 - 0.3, h = 2.8;
  box(xf, -hw - 0.2, hw + 0.2, -0.5, 0.12, -hd - 0.2, hd + 0.2, shade(STONE, 0.95), 0.04);
  for (const x of [-hw, 0, hw]) for (const z of [-hd, hd]) post(xf, x, z, 0.12, 0.12, 0.1, h, WHITE);
  gable(turn(xf, PI / 2), hd + 0.45, hw + 0.45, h, 1.2, [RED, c('#3D78C8'), c('#2F8F8A')][it.c % 3], WHITE, hd, hw, false);
  box(xf, -hw, hw, h - 0.3, h, -hd - 0.12, -hd + 0.12, WHITE);
  // the counters: fish laid on ice along both long sides
  for (const z of hd > 1.5 ? [-hd + 0.75, hd - 0.75] : [-hd + 0.45]) {
    box(xf, -hw + 0.5, hw - 0.5, 0.1, 0.9, z - 0.35, z + 0.35, WOOD, 0.03);
    box(xf, -hw + 0.6, hw - 0.6, 0.9, 1, z - 0.3, z + 0.3, c('#DDF2FA'));
    for (let x = -hw + 0.8; x < hw - 0.7; x += 0.42) box(xf, x - 0.16, x + 0.16, 1, 1.07, z - 0.08, z + 0.08, x % 0.84 > 0.4 ? c('#9FB4C6') : c('#E89A7A'), 0.03);
  }
  // a hall's sign over the front, crates stacked by a post
  if (hd < 1.5) return;
  box(xf, -1.5, 1.5, h + 0.15, h + 0.75, -hd - 0.5, -hd - 0.4, CREAM);
  box(xf, -1.3, 1.3, h + 0.27, h + 0.63, -hd - 0.53, -hd - 0.5, c('#3D78C8'));
  crates(sub(xf, hw + 0.7, 0, -hd + 0.3), it);
}

/** Shipping containers stacked on the dock: rows along local x, two or three high, each its own colour. */
function containers(xf: Xf, it: Item) {
  const rng = new Rng(it.s), rows = Math.max(1, Math.floor(it.d / 2.35)), lv = Math.max(1, Math.round(it.h / 2.5)), L = it.w / 2 - 0.2;
  for (let r = 0; r < rows; r++) {
    const z = -it.d / 2 + 1.2 + r * 2.35;
    for (let k = 0; k < lv - (r & 1); k++) {
      const col = [c('#C8432F'), c('#3D78C8'), c('#F2A93B'), c('#2F8F8A'), c('#8C93A3'), c('#7FB04A')][rng.int(0, 5)], y = k * 2.45;
      box(xf, -L, L, y - (k ? 0 : 0.3), y + 2.4, z - 1.08, z + 1.08, col, 0.04);
      for (const x of [-L, L]) box(xf, x - 0.03, x + 0.03, y + 0.15, y + 2.25, z - 0.95, z + 0.95, shade(col, 0.7));
      for (let x = -L + 0.6; x < L - 0.3; x += 0.6) box(xf, x - 0.04, x + 0.04, y + 0.2, y + 2.2, z - 1.11, z + 1.11, shade(col, 0.85));
    }
  }
}

/** A beach umbrella: a pole and a striped canopy; with its pair of loungers facing the sea (−z) when flagged. */
function umbrella(xf: Xf, it: Item) {
  const h = it.h;
  cyl(xf, 0, 0, 0.04, -0.3, h, WHITE, 4, false);
  if (it.f) for (const x of [-0.55, 0.55]) lounger(xf, x, 0, STRIPES[(it.c + 2) % 5]);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * PI * 2, a1 = ((i + 1) / 8) * PI * 2, x0 = Math.cos(a0) * 1.1, z0 = Math.sin(a0) * 1.1, x1 = Math.cos(a1) * 1.1, z1 = Math.sin(a1) * 1.1;
    paint(i % 2 ? CREAM : STRIPES[it.c % 5]);
    tri(xf, [x1, h - 0.35, z1, x0, h - 0.35, z0, 0, h + 0.05, 0], [x0 + x1, 1.4, z0 + z1]);
    tri(xf, [x0, h - 0.37, z0, x1, h - 0.37, z1, 0, h + 0.03, 0], [0, -1, 0]);
  }
}

/** On the quay: crates, a heap of nets and a buoy (c 0); a stack of lobster pots (1); a net hung on its rack with floats (2). */
function crates(xf: Xf, it: Item) {
  const rng = new Rng(it.s);
  if (it.c === 1) {
    for (const [x, y, z] of [[-0.45, 0, 0], [0.45, 0, 0.05], [0, 0.5, 0], [-0.4, 0, -0.55], [0.4, 0, -0.5]]) {
      box(xf, x - 0.32, x + 0.32, y, y + 0.48, z - 0.24, z + 0.24, c('#5B4A3A'), 0.06);
      box(xf, x - 0.34, x + 0.34, y + 0.06, y + 0.42, z - 0.2, z + 0.2, c('#C9B48E'), 0.08);
    }
    cyl(xf, 0.8, -0.2, 0.16, 0, 0.32, c('#FFD54A'));
    return;
  }
  if (it.c === 2) {
    for (const x of [-0.7, 0.7]) post(xf, x, 0, 0.05, 0.05, -0.1, 1.6, WOOD);
    box(xf, -0.75, 0.75, 1.55, 1.62, -0.04, 0.04, WOOD);
    box(xf, -0.68, 0.68, 0.35, 1.55, -0.03, 0.03, c('#2F6F5A'), 0.02);
    for (let x = -0.5; x < 0.6; x += 0.33) cyl(xf, x, -0.06, 0.07, 1.3, 1.45, c('#FF7A2E'), 6);
    lump(xf, 0.1, 0.12, 0.35, 0.55, 0.18, 0.3, c('#2F6F5A'), rng);
    return;
  }
  for (let k = 0; k < 3; k++) {
    const s = rng.range(0.22, 0.35), y = k > 1 ? 0.6 : 0;
    post(xf, rng.range(-0.5, 0.5), rng.range(-0.3, 0.3), s, s, y, y + 2 * s, [WOOD, STRIPES[3], STRIPES[0]][(it.c + k) % 3], 0.03);
  }
  lump(xf, 0.75, 0.15, 0.1, 0.45, 0.22, 0.38, c('#2F6F5A'), rng);
  cyl(xf, -0.85, 0.2, 0.18, 0, 0.36, c('#FF7A2E'));
}

// ── boats (instanced: towns/index.ts bobs them) ──

/** A small boat along local z (bow at −z), keel at y = 0, length L: a hull, a gunwale, thwarts; a wheelhouse when long. */
export function hull(xf: Xf, L: number, col: Color, g: Geo = G) {
  G = g;
  const w = L * 0.36, h = L * 0.16;
  // the hull: three sections tapering to a bow point
  const sec = [[-L / 2, 0.02, h * 1.2], [-L * 0.3, w * 0.42, h], [L * 0.2, w * 0.5, h], [L / 2, w * 0.4, h * 0.95]];
  for (let i = 0; i < 3; i++) {
    const [z0, a0, h0] = sec[i], [z1, a1, h1] = sec[i + 1];
    for (const s of [-1, 1]) {
      paint(col);
      quad(xf, [s * a0, h0, z0, s * a1, h1, z1, s * a1 * 0.55, 0, z1, s * a0 * 0.55, 0, z0], [s, 0.1, 0]);
      G.color.copy(WHITE);
      quad(xf, [s * a0, h0, z0, s * a1, h1, z1, s * a1 * 1.04, h1 + 0.06, z1, s * a0 * 1.04, h0 + 0.06, z0], [s, 0.2, 0]);
    }
    G.color.copy(c('#6B4B33'));
    quad(xf, [-a0 * 0.95, h0 * 0.5, z0, a0 * 0.95, h0 * 0.5, z0, a1 * 0.95, h1 * 0.5, z1, -a1 * 0.95, h1 * 0.5, z1], [0, 1, 0]);
    G.color.copy(shade(col, 0.5));
    quad(xf, [-a0 * 0.55, 0, z0, a0 * 0.55, 0, z0, a1 * 0.55, 0, z1, -a1 * 0.55, 0, z1], [0, -1, 0]);
  }
  G.color.copy(col);
  quad(xf, [-w * 0.4, h * 0.95, L / 2, w * 0.4, h * 0.95, L / 2, w * 0.22, 0, L / 2, -w * 0.22, 0, L / 2], [0, 0, 1]);
  if (L > 3.4) {
    box(xf, -w * 0.32, w * 0.32, h * 0.5, h + 1, L * 0.05, L * 0.32, WHITE, 0.06);
    box(xf, -w * 0.3, w * 0.3, h + 0.45, h + 0.85, L * 0.04, L * 0.33, GLASS);
    box(xf, -w * 0.36, w * 0.36, h + 1, h + 1.1, L * 0.02, L * 0.35, shade(col, 0.8), 0.04);
    cyl(xf, 0, -L * 0.12, 0.04, h, h + 1.9, WHITE, 4);
  } else for (const z of [-L * 0.1, L * 0.2]) post(xf, 0, z, w * 0.42, 0.1, h * 0.62, h * 0.72, WOOD);
}

// ── the site ──

type Builder = (xf: Xf, it: Item, site: Site, g: Geo, tallest: boolean) => void;
const cap: Builder = (xf, it, _s, g, tallest) => capital(g, xf, it, tallest);
const prop = (kind: string): Builder => (xf, it, _s, g) => furniture(g, xf, kind, it.w / 2);
const BUILD: Record<number, Builder> = {
  [T.house]: cap, [T.shop]: cap, [T.corner]: cap, [T.mid]: cap, [T.office]: cap, [T.tower]: cap, [T.chapel]: cap,
  [T.townhouse]: townhouse, [T.chalet]: chalet, [T.barn]: barn, [T.silo]: silo, [T.hut]: hut, [T.shed]: shed, [T.boathouse]: shed,
  [T.warehouse]: warehouse, [T.ctower]: ctower, [T.hangar]: hangar, [T.pylon]: pylon, [T.crane]: crane, [T.sock]: sock,
  [T.tree]: tree, [T.pine]: tree, [T.palm]: tree, [T.bush]: tree, [T.garden]: garden, [T.paddock]: paddock,
  [T.centre]: centre, [T.villa]: villa, [T.bench]: prop('bench'), [T.flag]: prop('flag'),
  [T.cafe]: prop('cafe-table'), [T.umbrella]: umbrella, [T.crates]: crates, [T.market]: market, [T.containers]: containers,
  [T.tractor]: tractor, [T.bales]: bales, [T.woodpile]: woodpile, [T.cradle]: cradle,
  [T.hotel]: hotel, [T.stall]: stall, [T.pool]: pool, [T.lifeguard]: lifeguard, [T.apron]: apron, [T.bar]: bar,
  [T.station]: (xf, it, site) => {
    // the cable height above this station's floor (at the lift's support it stands on)
    let top = it.h;
    const L = site.lift ?? [];
    for (let k = 0; k < L.length; k += 3) if (Math.hypot(L[k] - it.x, L[k + 1] - it.z) < 1) top = L[k + 2] - it.y;
    station(xf, it, top);
  },
};

/**
 * Emit every item of a site into g (the boats are left to the instanced fleet). `delay` gives each
 * item's reveal delay (s, before the system's slot is added).
 */
export function* buildSite(g: Geo, site: Site, delay: (it: Item) => number): Generator<void, void, void> {
  let tallest = -1, t0 = performance.now();
  site.items.forEach((it, i) => {
    if (it.t === T.tower && (tallest < 0 || it.h > site.items[tallest].h)) tallest = i;
  });
  for (let i = 0; i < site.items.length; i++) {
    // (a yield after ~1.5 ms of work: the caller may hand the frame back; G is set again after it)
    if (performance.now() - t0 > 1.5) {
      yield;
      t0 = performance.now();
    }
    G = g;
    const it = site.items[i], fn = BUILD[it.t];
    if (!fn) continue;
    const xf = frameAt(site, it.x, it.z, it.a, it.y);
    Object.assign(g.pivot, xf.o);
    g.delay = delay(it);
    g.growK = 1;
    g.kind = K.plain;
    g.param = 0;
    // a building on falling ground stands on its own terrace (a stone plinth down to the lowest ground)
    if (it.t < T.tree && it.t !== T.silo && it.y - it.lo > 0.12) box(xf, -it.w / 2, it.w / 2, it.lo - it.y - 0.35, 0.06, -it.d / 2, it.d / 2, shade(STONE, 0.86), 0.04);
    fn(xf, it, site, g, i === tallest);
  }
}

// ── the chairlift ──

/**
 * The chairlift's cable loop, world space (x, y, z every ≤ 0.5 m, closed): up the right of the line,
 * round the top bullwheel, down the left, round the valley bullwheel; sagging a little between supports.
 */
export function liftLoop(site: Site): Float32Array | null {
  const L = site.lift;
  if (!L) return null;
  const m = L.length / 3, e = (m - 1) * 3;
  const ul = Math.hypot(L[e] - L[0], L[e + 1] - L[1]) || 1, ux = (L[e] - L[0]) / ul, uz = (L[e + 1] - L[1]) / ul;
  // keys: x, z, cable height, sags (between supports); a station's bullwheel stands 2.2 m out from it
  // toward the line (towns/build station), clear of its roof
  const key: number[] = [];
  const bx = (j: number) => (j ? (j === e ? -2.2 : 0) : 2.2);
  const side = (s: number) => {
    for (let k = 0; k < m; k++) {
      const j = (s > 0 ? k : m - 1 - k) * 3;
      key.push(L[j] - uz * 0.9 * s + ux * bx(j), L[j + 1] + ux * 0.9 * s + uz * bx(j), L[j + 2], 1);
    }
    // round the bullwheel at the end it reached
    const j = s > 0 ? e : 0;
    for (let i = 1; i < 6; i++) {
      const t = (i / 6) * PI;
      key.push(L[j] + ux * bx(j) + s * (-uz * 0.9 * Math.cos(t) + ux * 0.9 * Math.sin(t)), L[j + 1] + uz * bx(j) + s * (ux * 0.9 * Math.cos(t) + uz * 0.9 * Math.sin(t)), L[j + 2], 0);
    }
  };
  side(1);
  side(-1);
  key.push(...key.slice(0, 4));
  const out: number[] = [];
  const d = v3();
  for (let i = 0; i + 4 < key.length; i += 4) {
    const [x0, z0, h0, s0, x1, z1, h1, s1] = key.slice(i, i + 8);
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0, h1 - h0) / 0.5)), sag = s0 && s1 ? 0.24 * Math.hypot(x1 - x0, z1 - z0) : 0;
    for (let k = 0; k < n; k++) {
      const f = k / n;
      chartFrame(site.chart, x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, d, _ax, _az);
      const r = R + h0 + (h1 - h0) * f - sag * f * (1 - f);
      out.push(d.x * r, d.y * r, d.z * r);
    }
  }
  out.push(out[0], out[1], out[2]);
  return new Float32Array(out);
}

/** A thin dark cable along a world polyline (a box per sample step). */
export function cables(g: Geo, p: Float32Array): void {
  G = g;
  for (let i = 0; i + 5 < p.length; i += 3) {
    const o = v3(p[i], p[i + 1], p[i + 2]), ez = v3(p[i + 3] - o.x, p[i + 4] - o.y, p[i + 5] - o.z);
    const len = Math.hypot(ez.x, ez.y, ez.z), l = Math.hypot(o.x, o.y, o.z);
    if (len < 1e-4) continue;
    ez.x /= len;
    ez.y /= len;
    ez.z /= len;
    // up (radial) made square to the cable; x = y × z
    const k = (o.x * ez.x + o.y * ez.y + o.z * ez.z) / l, ey = v3(o.x / l - ez.x * k, o.y / l - ez.y * k, o.z / l - ez.z * k), el = Math.hypot(ey.x, ey.y, ey.z) || 1;
    ey.x /= el;
    ey.y /= el;
    ey.z /= el;
    box({ o, ey, ez, ex: v3(ey.y * ez.z - ey.z * ez.y, ey.z * ez.x - ey.x * ez.z, ey.x * ez.y - ey.y * ez.x) }, -0.035, 0.035, -0.035, 0.035, 0, len + 0.02, INK);
  }
}

/** A chair of the lift, hanging from its grip at the origin (local −z: the way it travels). */
export function chair(g: Geo): void {
  G = g;
  const xf: Xf = { o: v3(), ex: v3(1, 0, 0), ey: v3(0, 1, 0), ez: v3(0, 0, 1) };
  post(xf, 0, 0, 0.04, 0.04, -1.6, 0.05, DARK);
  post(xf, 0, 0, 0.55, 0.05, -1.65, -1.55, DARK);
  for (const sx of [-0.52, 0.52]) post(xf, sx, 0, 0.03, 0.03, -2.25, -1.6, DARK);
  box(xf, -0.6, 0.6, -2.3, -2.18, -0.5, 0.05, WHITE, 0.04);
  box(xf, -0.6, 0.6, -2.18, -1.62, 0.02, 0.12, WHITE, 0.04);
  box(xf, -0.55, 0.55, -2.32, -2.26, -0.75, -0.5, DARK);
}
