// The space layer's models (v2, S1): a cartoon station and ten satellites with distinct silhouettes,
// built from three's primitives at boot and merged into ONE geometry (one draw call for every body).
// Each vertex carries its body index (aBody: the shader places it with that body's transform),
// a material id (aMat: solar cells, gold foil, windows, gold mirror, sail sheen, metal, dish; +16
// for parts that turn about the body's sun-tracking axis), a colour, panel UVs in metres, and
// edge coordinates (aEdge: per face, 0 and 1 on its borders, with flags for which ones are real
// edges), from which the shader inks every box, panel, band and rim edge at a constant ~1.3 px:
// post's depth ink barely reaches up here, and an un-inked station read as a plastic render.
//
// Local frame of every model: +Z along the flight, +Y away from the planet, +X = Y × Z. A model's
// sun-tracking parts turn about `axis` through the local origin (the shader takes the angle per
// body); `rest` is their face normal at angle 0. Beacons sit just off the hull, on the tracking
// axis when they are on a panel tip (so they never need the panel's turn).

import { BoxGeometry, type BufferGeometry, Color, ConeGeometry, CylinderGeometry, Euler, Float32BufferAttribute, LatheGeometry, Matrix3, Matrix4, Quaternion, SphereGeometry, Uint32BufferAttribute, Vector2, Vector3, BufferGeometry as BG } from 'three';
import { PALETTE } from '../render/palette';

export const MAT = { plain: 0, solar: 1, foil: 2, window: 3, mirror: 4, sail: 5, metal: 6, dish: 7 } as const;
/** Added to aMat: the part turns about the body's sun-tracking axis. */
export const TRACK = 16;

/**
 * Which borders of a primitive's faces are inked (aEdge): a box's every face edge; a cylinder's or
 * cone's two rims (the side's ends and the caps' outer edge, never the wrap seam); a lathe's lip; a
 * plate's outline; a sphere none (its silhouette is inked from the normal).
 */
type Edge = 'box' | 'cyl' | 'lathe' | 'outline' | 'none';

/** Beacon blink patterns (space/shaders.ts). */
export const BLINK = { pulse: 0, flash: 1, double: 2 } as const;

export interface Beacon {
  p: [number, number, number];
  color: Color;
  kind: number;
  /** Phase offset (s). */
  phase: number;
}

export interface ModelInfo {
  /** Sun-tracking axis (local, unit) and the tracking parts' rest normal. */
  axis: [number, number, number];
  rest: [number, number, number];
  beacons: Beacon[];
}

const C = {
  hull: new Color('#f6f2ea'),
  cream: PALETTE.walls[0],
  truss: new Color('#a49cc4'),
  joint: new Color('#6f6893'),
  cell: new Color('#3d4fd1'),
  gold: new Color('#f2b84b'),
  goldDeep: new Color('#e0943a'),
  dark: new Color('#2b2d55'),
  hole: new Color('#121327'),
  silver: new Color('#d7dcef'),
  teal: PALETTE.walls[2],
  coral: PALETTE.walls[4],
  mustard: PALETTE.walls[3],
  lilac: PALETTE.walls[5],
  red: PALETTE.roofs[0],
  slate: PALETTE.roofs[1],
  window: new Color('#ffd98f'),
  radar: new Color('#7076b4'),
  pink: new Color('#f3a6cf'),
  lav: new Color('#c7b6f2'),
  sailA: new Color('#ff7fb0'),
  sailB: new Color('#a993ff'),
};
const BEACON = { red: new Color('#ff4d5e'), green: new Color('#4dff8f'), white: new Color('#ffffff'), amber: new Color('#ffb84d') };

/** Accumulates parts into one indexed geometry. */
class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  mat: number[] = [];
  body: number[] = [];
  edge: number[] = [];
  idx: number[] = [];
  b = 0;
  private m = new Matrix4();
  private n = new Matrix3();
  private q = new Quaternion();
  private e = new Euler();
  private v = new Vector3();
  private s = new Vector3(1, 1, 1);

  /** Add `g` transformed by translation `at` and Euler rotation `rot` (rad, XYZ). Disposes g. */
  add(g: BufferGeometry, at: number[], rot: number[] | null, color: Color, mat: number, uvScale?: [number, number], edge: Edge = 'none') {
    this.q.setFromEuler(this.e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0));
    this.m.compose(this.v.set(at[0], at[1], at[2]), this.q, this.s);
    this.n.getNormalMatrix(this.m);
    const p = g.getAttribute('position');
    const nr = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const base = this.pos.length / 3;
    const t = new Vector3();
    for (let i = 0; i < p.count; i++) {
      t.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(this.m);
      this.pos.push(t.x, t.y, t.z);
      t.set(nr.getX(i), nr.getY(i), nr.getZ(i)).applyMatrix3(this.n).normalize();
      this.nrm.push(t.x, t.y, t.z);
      this.col.push(color.r, color.g, color.b);
      this.uv.push(uv ? uv.getX(i) * (uvScale?.[0] ?? 0) : 0, uv ? uv.getY(i) * (uvScale?.[1] ?? 0) : 0);
      this.mat.push(mat);
      this.body.push(this.b);
      // Edge coordinates: x, y in 0..1 across the face (an edge at 0 and at 1), flags 1 = x, 2 = y,
      // 3 = both, 6 = y even where the face is narrow on screen.
      const u = uv ? uv.getX(i) : 0;
      const v = uv ? uv.getY(i) : 0;
      if (edge === 'box') this.edge.push(u, v, 3);
      else if (edge === 'cyl') {
        // A cap (its normal along the axis): radially, 0.5 at the centre → 1 on the rim. The side:
        // along the axis only.
        if (Math.abs(nr.getY(i)) > 0.9) this.edge.push(0.5 + 0.5 * Math.min(1, 2 * Math.hypot(u - 0.5, v - 0.5)), 0, 1);
        else this.edge.push(0, v, 2);
      } else if (edge === 'lathe') this.edge.push(0, v, 6); // 6: y, never dropped (the lip strip is always thin)
      else if (edge === 'outline') this.edge.push(u, 0, 1);
      else this.edge.push(0, 0, 0);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    g.dispose();
  }

  box(w: number, h: number, d: number, at: number[], color: Color, mat: number = MAT.plain, rot: number[] | null = null, uv?: [number, number]) {
    this.add(new BoxGeometry(w, h, d), at, rot, color, mat, uv, 'box');
  }
  /** A cylinder along local Y (rotate it with rot); r2 = top radius. */
  cyl(r: number, len: number, at: number[], color: Color, mat: number = MAT.plain, rot: number[] | null = null, segs = 16, r2 = r, uv?: [number, number], edge: Edge = 'cyl') {
    this.add(new CylinderGeometry(r2, r, len, segs, 1), at, rot, color, mat, uv, edge);
  }
  sphere(r: number, at: number[], color: Color, mat: number = MAT.plain, ws = 18, hs = 12) {
    this.add(new SphereGeometry(r, ws, hs), at, null, color, mat);
  }
  /** A cone along local Y (tip at +Y). */
  cone(r: number, len: number, at: number[], color: Color, mat: number = MAT.plain, rot: number[] | null = null, segs = 14) {
    this.add(new ConeGeometry(r, len, segs, 1), at, rot, color, mat, undefined, 'cyl');
  }
  /** A parabolic dish opening toward +Y (rotate it), with a rim and a feed horn at its focus. */
  dish(r: number, depth: number, at: number[], rot: number[] | null, color: Color, horn = true) {
    const pts: Vector2[] = [];
    const n = 7;
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * r;
      pts.push(new Vector2(Math.max(0.001, x), (depth * x * x) / (r * r)));
    }
    // Back over the rim to the outside (a thin shell: the material is double-sided).
    pts.push(new Vector2(r * 1.04, depth * 1.02));
    // (The dish material shades the bowl by the profile coordinate: the lathe's UVs, unscaled.)
    this.add(new LatheGeometry(pts, 22), at, rot, color, MAT.dish, [1, 1], 'lathe');
    if (horn) {
      // The feed: a little strut and cone at the focus, along the dish's axis.
      const m = new Matrix4().makeRotationFromEuler(new Euler(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0));
      const ax = new Vector3(0, 1, 0).applyMatrix4(m);
      const f = r * 0.55;
      this.cyl(0.035, f, [at[0] + ax.x * f * 0.5, at[1] + ax.y * f * 0.5, at[2] + ax.z * f * 0.5], C.silver, MAT.metal, rot, 6);
      this.cone(r * 0.12, r * 0.18, [at[0] + ax.x * f, at[1] + ax.y * f, at[2] + ax.z * f], C.coral, MAT.plain, [(rot?.[0] ?? 0) + Math.PI, rot?.[1] ?? 0, rot?.[2] ?? 0], 10);
    }
  }
  /** A flat polygon (XZ plane, +Y face) with a little thickness, from an outline (CCW from +Y). */
  plate(outline: Array<[number, number]>, y: number, thick: number, color: Color, mat: number, billow = 0) {
    const g = new BG();
    const P: number[] = [];
    // Per vertex: how far out toward the outline (0 at the centre, 1 on it), for the outline's ink.
    const T: number[] = [];
    const cx = outline.reduce((a, p) => a + p[0], 0) / outline.length;
    const cz = outline.reduce((a, p) => a + p[1], 0) / outline.length;
    const n = outline.length;
    // Fan, each wedge split in four for a gentle billow toward +Y at the middle of every edge.
    for (let i = 0; i < n; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % n];
      const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ca = [(a[0] + cx) / 2, (a[1] + cz) / 2];
      const cb = [(b[0] + cx) / 2, (b[1] + cz) / 2];
      const H = (x: number, z: number) => {
        const d = Math.hypot(x - cx, z - cz) / Math.max(1e-3, Math.hypot(ab[0] - cx, ab[1] - cz));
        return y + billow * Math.sin(Math.min(1, d) * Math.PI) * 0.8;
      };
      // (x, z, t): t is linear over the wedge, so its interpolation is exact on every sub-triangle.
      const tri = (p: number[], q: number[], r: number[]) => {
        P.push(p[0], H(p[0], p[1]), p[1], r[0], H(r[0], r[1]), r[1], q[0], H(q[0], q[1]), q[1]);
        T.push(p[2], r[2], q[2]);
      };
      const C0 = [cx, cz, 0];
      const A = [a[0], a[1], 1];
      const B = [b[0], b[1], 1];
      const AB = [ab[0], ab[1], 1];
      const CA = [ca[0], ca[1], 0.5];
      const CB = [cb[0], cb[1], 0.5];
      tri(C0, CA, CB);
      tri(CA, A, AB);
      tri(CB, AB, B);
      tri(CA, AB, CB);
    }
    g.setAttribute('position', new Float32BufferAttribute(P, 3));
    // One flat normal for the whole membrane: crisp toon bands, no faceting from the billow.
    g.setAttribute('normal', new Float32BufferAttribute(new Float32Array(P.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('uv', new Float32BufferAttribute(T.flatMap((t) => [0.5 + 0.5 * t, 0]), 2));
    // One surface (the material is double-sided); `thick` only lifts it.
    this.add(g, [0, thick / 2, 0], null, color, mat, undefined, 'outline');
  }
  /** A solar panel: a thin box with cells, a pale frame strip along its root and the tracking flag. */
  panel(w: number, d: number, at: number[], track = true, color: Color = C.cell, rot: number[] | null = null) {
    this.box(w, 0.07, d, at, color, MAT.solar + (track ? TRACK : 0), rot, [w, d]);
  }

  geometry(): BG {
    const g = new BG();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aCol', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('aUv', new Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aMat', new Float32BufferAttribute(this.mat, 1));
    g.setAttribute('aBody', new Float32BufferAttribute(this.body, 1));
    g.setAttribute('aEdge', new Float32BufferAttribute(this.edge, 3));
    g.setIndex(new Uint32BufferAttribute(this.idx, 1));
    return g;
  }
}

const H = Math.PI / 2;
const beacon = (p: [number, number, number], color: Color, kind: number, phase = 0): Beacon => ({ p, color, kind, phase });
const X: ModelInfo['axis'] = [1, 0, 0];
const UP: ModelInfo['rest'] = [0, 1, 0];

/** The station: truss, eight blue wings, modules with bands, radiators, a cupola, a docked capsule. */
function station(b: Builder): ModelInfo {
  b.box(18, 0.7, 0.7, [0, 0.6, 0], C.truss);
  for (const x of [-7.6, -5, -2.5, 2.5, 5, 7.6]) b.box(0.95, 0.95, 0.95, [x, 0.6, 0], C.joint);
  // Eight wings on four masts (they turn about the truss, X, to face the sun).
  for (const x of [-8.4, -6.2, 6.2, 8.4]) {
    b.box(0.18, 0.18, 12.2, [x, 0.6, 0], C.gold, MAT.foil + TRACK);
    for (const s of [-1, 1]) b.panel(1.75, 5.5, [x, 0.6, s * 3.35]);
  }
  // Radiators: white fins below the truss.
  for (const x of [-3.7, 3.7]) b.box(0.06, 2.1, 1.7, [x, -0.65, 0], C.hull, MAT.metal);
  // Pressurised modules along the flight, under the truss.
  // (Capsules: a cylinder ending in spheres has no edge to ink; its rims inside the spheres z-fought
  // into dashes.)
  b.cyl(1.05, 8, [0, -0.75, 0.3], C.hull, MAT.plain, [H, 0, 0], 20, 1.05, undefined, 'none');
  b.sphere(1.05, [0, -0.75, -3.7], C.hull);
  b.sphere(1.05, [0, -0.75, 4.3], C.hull);
  b.cyl(1.12, 0.38, [0, -0.75, -1.9], C.teal, MAT.plain, [H, 0, 0], 20);
  b.cyl(1.12, 0.38, [0, -0.75, 1.3], C.coral, MAT.plain, [H, 0, 0], 20);
  b.cyl(1.12, 0.38, [0, -0.75, 3.4], C.teal, MAT.plain, [H, 0, 0], 20);
  // The cross module and its mustard band.
  b.cyl(0.9, 4.6, [0, -0.75, -2.7], C.cream, MAT.plain, [0, 0, H], 18, 0.9, undefined, 'none');
  b.cyl(0.97, 0.34, [-1.6, -0.75, -2.7], C.mustard, MAT.plain, [0, 0, H], 18);
  b.cyl(0.97, 0.34, [1.6, -0.75, -2.7], C.mustard, MAT.plain, [0, 0, H], 18);
  b.sphere(0.9, [-2.3, -0.75, -2.7], C.cream);
  b.sphere(0.9, [2.3, -0.75, -2.7], C.cream);
  // Windows along the main module, and the cupola looking down at the planet.
  for (const s of [-1, 1]) for (const z of [-0.9, 0.1, 2.3]) b.box(0.08, 0.34, 0.34, [s * 1.07, -0.55, z], C.window, MAT.window);
  b.cyl(0.62, 0.55, [0, -1.95, 1.8], C.silver, MAT.metal, null, 6, 0.48);
  b.cyl(0.46, 0.06, [0, -2.24, 1.8], C.window, MAT.window, null, 6);
  // The docked capsule at the nose, with its own little wings.
  b.cyl(0.42, 0.5, [0, -0.75, 5.5], C.silver, MAT.metal, [H, 0, 0], 12);
  b.cyl(0.68, 1.2, [0, -0.75, 6.35], C.coral, MAT.plain, [H, 0, 0], 16);
  b.cone(0.68, 0.95, [0, -0.75, 7.4], C.hull, MAT.plain, [H, 0, 0], 16);
  for (const s of [-1, 1]) b.panel(1.4, 0.55, [s * 1.45, -0.75, 6.35], false);
  return {
    axis: X,
    rest: UP,
    beacons: [
      beacon([-9.15, 0.6, 0], BEACON.red, BLINK.pulse),
      beacon([9.15, 0.6, 0], BEACON.green, BLINK.pulse, 0.5),
      beacon([0, 1.12, 0], BEACON.white, BLINK.double),
      beacon([0, -0.75, 7.95], BEACON.amber, BLINK.flash, 0.7),
      beacon([0, -1.85, -3.7], BEACON.white, BLINK.flash, 1.1),
    ],
  };
}

/** chatterbox: a gold-foil box, two long wings, a big dish below and a small one ahead. */
function comms(b: Builder): ModelInfo {
  b.box(1.5, 1.5, 1.5, [0, 0, 0], C.gold, MAT.foil);
  b.box(1.56, 0.18, 1.56, [0, 0.6, 0], C.hull);
  b.cyl(0.04, 1.4, [0, 1.45, 0], C.silver, MAT.metal, null, 6);
  for (const s of [-1, 1]) {
    b.cyl(0.07, 0.75, [s * 1.12, 0, 0], C.silver, MAT.metal + TRACK, [0, 0, H], 8);
    b.panel(3.4, 1.3, [s * 3.15, 0, 0]);
  }
  b.cyl(0.08, 0.4, [0, -0.95, 0], C.silver, MAT.metal, null, 8);
  b.dish(1.3, 0.45, [0, -1.15, 0], [Math.PI, 0, 0], C.hull);
  b.dish(0.55, 0.2, [0, 0.25, 0.8], [H, 0, 0], C.hull);
  return { axis: X, rest: UP, beacons: [beacon([-4.9, 0, 0], BEACON.red, BLINK.pulse), beacon([4.9, 0, 0], BEACON.green, BLINK.pulse, 0.4), beacon([0, 2.2, 0], BEACON.white, BLINK.flash, 0.3)] };
}

/** drizzle-1: a banded drum standing up, ONE big wing off to the side, a lens looking down. */
function weather(b: Builder): ModelInfo {
  b.cyl(0.85, 2.0, [0, 0, 0], C.hull, MAT.plain, null, 18);
  b.cyl(0.9, 0.3, [0, 0.45, 0], C.coral, MAT.plain, null, 18);
  b.cone(0.85, 0.55, [0, 1.27, 0], C.slate, MAT.plain, null, 18);
  b.cyl(0.42, 0.35, [0, -1.15, 0], C.dark, MAT.metal, null, 16);
  b.cyl(0.56, 0.12, [0, -1.0, 0], C.gold, MAT.foil, null, 16);
  b.cyl(0.07, 1.0, [-1.3, 0.1, 0], C.silver, MAT.metal + TRACK, [0, 0, H], 8);
  b.panel(3.2, 1.75, [-3.4, 0.1, 0]);
  b.dish(0.45, 0.16, [0.9, 0.3, 0], [0, 0, -H], C.hull, false);
  return { axis: X, rest: UP, beacons: [beacon([0, 1.62, 0], BEACON.amber, BLINK.flash), beacon([-5.05, 0.1, 0], BEACON.red, BLINK.pulse)] };
}

/** peeper: a long tube pointing away from the planet, its lid flipped open, gold instrument bay. */
function telescope(b: Builder): ModelInfo {
  b.cyl(0.85, 4.0, [0, 0.7, 0], C.silver, MAT.metal, null, 20);
  // (The tube is capped: the dark aperture disc sits just on its open end, inside the rim ring.)
  b.cyl(0.76, 0.03, [0, 2.725, 0], C.hole, MAT.plain, null, 20);
  b.cyl(0.9, 0.3, [0, -0.85, 0], C.gold, MAT.foil, null, 20);
  b.cyl(0.9, 0.2, [0, 1.6, 0], C.teal, MAT.plain, null, 20);
  b.cyl(0.88, 0.12, [0, 0.35, 0], C.coral, MAT.plain, null, 20);
  // The aperture: a dark rim ring round the open end.
  b.cyl(0.93, 0.14, [0, 2.64, 0], C.joint, MAT.plain, null, 20);
  // A star tracker and a little antenna on the side (it read as a plain bottle).
  b.box(0.34, 0.5, 0.34, [0.95, 1.05, 0.15], C.silver, MAT.metal);
  b.cyl(0.03, 0.7, [-0.9, 0.9, 0.3], C.silver, MAT.metal, [0, 0, -0.5], 5);
  // The lid, hinged at the back rim and swung open past upright: a pin across the rim, a bracket up
  // to the lid's edge, the lid on it (it floated as a detached grey ellipse).
  b.cyl(0.08, 0.6, [0, 2.74, -0.9], C.joint, MAT.metal, [0, 0, H], 10);
  b.box(0.36, 0.34, 0.1, [0, 2.86, -0.96], C.joint, MAT.metal, [-0.37, 0, 0]);
  b.cyl(0.92, 0.07, [0, 3.56, -1.2], C.hull, MAT.plain, [-1.95, 0, 0], 20);
  b.cyl(0.6, 0.075, [0, 3.56, -1.2], C.silver, MAT.metal, [-1.95, 0, 0], 16);
  b.box(1.5, 0.8, 1.5, [0, -1.4, 0], C.gold, MAT.foil);
  for (const s of [-1, 1]) {
    b.cyl(0.06, 0.5, [s * 0.98, -1.4, 0], C.silver, MAT.metal + TRACK, [0, 0, H], 8);
    b.panel(2.3, 1.1, [s * 2.35, -1.4, 0]);
  }
  return { axis: X, rest: UP, beacons: [beacon([0, 4.46, -1.57], BEACON.white, BLINK.flash), beacon([-3.55, -1.4, 0], BEACON.red, BLINK.pulse), beacon([3.55, -1.4, 0], BEACON.green, BLINK.pulse, 0.6)] };
}

/** tri-cubes: three little cubesats in a loose triangle, each with two flip-out wings. */
function cubes(b: Builder): ModelInfo {
  const bodies = [C.teal, C.coral, C.mustard];
  const beacons: Beacon[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const at = [Math.sin(a) * 1.05, (i - 1) * 0.25, Math.cos(a) * 1.05];
    const tilt = [0.3 * i, a, 0.2 - 0.15 * i];
    b.box(0.6, 0.6, 0.6, at, bodies[i], MAT.plain, tilt);
    b.box(0.64, 0.1, 0.64, [at[0], at[1] + 0.27, at[2]], C.hull, MAT.plain, tilt);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const s of [-1, 1]) b.panel(1.0, 0.5, [at[0] + s * 0.82 * ca, at[1], at[2] - s * 0.82 * sa], false, C.cell, [0, a, 0]);
    b.cyl(0.02, 0.6, [at[0], at[1] + 0.6, at[2]], C.silver, MAT.metal, null, 5);
    beacons.push(beacon([at[0], at[1] + 0.92, at[2]], BEACON.white, BLINK.flash, i * 0.45));
  }
  return { axis: X, rest: UP, beacons };
}

/** kite: a solar sail, four bright quadrants on crossed booms, a tiny gold bus in the middle. */
function sail(b: Builder): ModelInfo {
  const r = 4.0;
  const quads: Array<[Color, Array<[number, number]>]> = [
    [C.sailA, [[0, 0], [r, 0], [0, r]]],
    [C.sailB, [[0, 0], [0, r], [-r, 0]]],
    [C.sailA, [[0, 0], [-r, 0], [0, -r]]],
    [C.sailB, [[0, 0], [0, -r], [r, 0]]],
  ];
  for (const [col, tri] of quads) b.plate(tri.map(([x, z]) => [x * 0.97, z * 0.97] as [number, number]), 0, 0.03, col, MAT.sail, -0.35);
  b.cyl(0.045, 2 * r, [0, 0.05, 0], C.silver, MAT.metal, [0, 0, H], 6);
  b.cyl(0.045, 2 * r, [0, 0.05, 0], C.silver, MAT.metal, [H, 0, 0], 6);
  b.box(0.55, 0.45, 0.55, [0, 0.3, 0], C.gold, MAT.foil);
  return {
    axis: X,
    rest: UP,
    beacons: [beacon([r + 0.1, 0.05, 0], BEACON.red, BLINK.pulse), beacon([-r - 0.1, 0.05, 0], BEACON.green, BLINK.pulse, 0.3), beacon([0, 0.05, r + 0.1], BEACON.white, BLINK.flash), beacon([0, 0.05, -r - 0.1], BEACON.amber, BLINK.flash, 0.8)],
  };
}

/** pathfinder: a teal box, four square panels, a little forest of antennas pointing down. */
function navsat(b: Builder): ModelInfo {
  b.box(1.3, 1.7, 1.3, [0, 0, 0], C.teal);
  b.box(0.9, 0.35, 0.9, [0, 1.02, 0], C.gold, MAT.foil);
  b.box(1.2, 0.1, 1.2, [0, -0.9, 0], C.hull);
  for (let i = 0; i < 9; i++) {
    if (i === 4) continue;
    b.cone(0.12, 0.42, [((i % 3) - 1) * 0.38, -1.15, (Math.floor(i / 3) - 1) * 0.38], C.hull, MAT.plain, [Math.PI, 0, 0], 8);
  }
  for (const s of [-1, 1]) {
    b.cyl(0.06, 0.5, [s * 0.88, 0.1, 0], C.silver, MAT.metal + TRACK, [0, 0, H], 8);
    b.panel(1.45, 1.45, [s * 1.9, 0.1, 0]);
    b.panel(1.45, 1.45, [s * 3.45, 0.1, 0]);
  }
  return { axis: X, rest: UP, beacons: [beacon([-4.25, 0.1, 0], BEACON.red, BLINK.pulse), beacon([4.25, 0.1, 0], BEACON.green, BLINK.pulse, 0.2), beacon([0, -1.5, 0], BEACON.white, BLINK.double, 0.4)] };
}

/** bat: a long flat radar wing slung under a lilac bus, one panel on a mast above. */
function radar(b: Builder): ModelInfo {
  b.box(6.8, 0.14, 1.25, [0, -0.6, 0], C.radar, MAT.solar, null, [6.8, 1.25]);
  b.box(0.95, 0.85, 1.9, [0, 0.0, 0], C.lilac);
  b.box(0.5, 0.3, 0.5, [0, -0.38, 0], C.dark);
  b.cyl(0.05, 1.3, [0, 1.05, 0], C.silver, MAT.metal, null, 8);
  b.box(1.05, 2.6, 0.07, [0, 2.95, 0], C.cell, MAT.solar + TRACK, null, [1.05, 2.6]);
  return { axis: [0, 1, 0], rest: [0, 0, 1], beacons: [beacon([-3.5, -0.6, 0], BEACON.red, BLINK.pulse), beacon([3.5, -0.6, 0], BEACON.green, BLINK.pulse, 0.5), beacon([0, 4.35, 0], BEACON.white, BLINK.flash)] };
}

/**
 * spinny: a drum covered in solar cells, gold rims, a mast and dish at its nose; it lies along the
 * flight and spins about it (orbits.ts `spinZ`), so from above, below or the street it shows its
 * side, cells and rims rolling past (standing up, an 'alongside' look-down saw a ring round a disc).
 */
function drum(b: Builder): ModelInfo {
  const Z: number[] = [H, 0, 0]; // local Y → Z
  b.cyl(1.1, 1.6, [0, 0, 0], C.cell, MAT.solar, Z, 24, 1.1, [Math.PI * 2.2, 1.6]);
  b.cyl(1.16, 0.14, [0, 0, 0.8], C.gold, MAT.foil, Z, 24);
  b.cyl(1.16, 0.14, [0, 0, -0.8], C.gold, MAT.foil, Z, 24);
  b.cyl(1.17, 0.1, [0, 0, 0], C.coral, MAT.plain, Z, 24);
  b.cyl(0.9, 0.08, [0, 0, 0.9], C.hull, MAT.plain, Z, 24);
  b.cyl(0.08, 0.8, [0, 0, 1.3], C.silver, MAT.metal, Z, 8);
  b.dish(0.42, 0.14, [0, 0, 1.72], Z, C.hull, false);
  b.cone(0.5, 0.42, [0, 0, -1.08], C.slate, MAT.plain, [-H, 0, 0], 14);
  // Two little whip antennas off the tail ring, so the spin reads even end-on.
  for (const s of [-1, 1]) b.cyl(0.025, 1.1, [s * 1.45, 0, -0.8], C.silver, MAT.metal, [0, 0, H], 5);
  return { axis: X, rest: UP, beacons: [beacon([0, 0, 1.95], BEACON.amber, BLINK.pulse), beacon([2.0, 0, -0.8], BEACON.red, BLINK.flash, 0.4)] };
}

/** beep: a shiny ball with four long whiskers swept back. */
function sputnik(b: Builder): ModelInfo {
  b.sphere(0.58, [0, 0, 0], C.silver, MAT.metal, 20, 14);
  const sw = 0.42;
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const d = new Vector3(sx * Math.sin(sw) * 0.7071, sy * Math.sin(sw) * 0.7071, -Math.cos(sw));
    const L = 2.2;
    const base = new Vector3(sx * 0.3, sy * 0.3, -0.38);
    const mid = base.clone().addScaledVector(d, L / 2);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d);
    const e = new Euler().setFromQuaternion(q);
    b.cyl(0.026, L, [mid.x, mid.y, mid.z], C.silver, MAT.metal, [e.x, e.y, e.z], 5);
  }
  return { axis: X, rest: UP, beacons: [beacon([0, 0.64, 0], BEACON.red, BLINK.double)] };
}

/** goldie: a five-layer diamond sunshield, a gold flower of hex mirrors above, a secondary on struts. */
function jwst(b: Builder): ModelInfo {
  const shield: Array<[number, number]> = [[2.7, 0], [1.25, 1.5], [-1.25, 1.5], [-2.7, 0], [-1.25, -1.5], [1.25, -1.5]];
  for (let k = 0; k < 5; k++) {
    const s = 1 - k * 0.035;
    b.plate(shield.map(([x, z]) => [x * s, z * s] as [number, number]), -0.55 - (4 - k) * 0.15, 0.02, k % 2 ? C.pink : C.lav, MAT.sail, 0.04);
  }
  b.box(0.7, 0.55, 0.7, [0, -0.15, 0], C.dark);
  const hr = 0.36;
  const hexes: Array<[number, number]> = [[0, 0]];
  for (let i = 0; i < 6; i++) hexes.push([Math.cos((i * Math.PI) / 3 + Math.PI / 6) * hr * 1.78, Math.sin((i * Math.PI) / 3 + Math.PI / 6) * hr * 1.78]);
  for (const [x, z] of hexes) b.cyl(hr, 0.12, [x, 0.25 + Math.hypot(x, z) * 0.12, z], C.gold, MAT.mirror, null, 6);
  b.cyl(0.13, 0.08, [0, 1.75, 0], C.gold, MAT.mirror, null, 10);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const foot = new Vector3(Math.cos(a) * 0.95, 0.35, Math.sin(a) * 0.95);
    const top = new Vector3(0, 1.72, 0);
    const d = top.clone().sub(foot);
    const L = d.length();
    const e = new Euler().setFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.normalize()));
    const mid = foot.clone().add(top).multiplyScalar(0.5);
    b.cyl(0.025, L, [mid.x, mid.y, mid.z], C.silver, MAT.metal, [e.x, e.y, e.z], 5);
  }
  b.box(0.9, 0.4, 0.9, [0, -1.55, 0], C.gold, MAT.foil);
  b.panel(1.3, 0.6, [0, -1.62, -1.05], false);
  return { axis: X, rest: UP, beacons: [beacon([2.75, -0.55, 0], BEACON.white, BLINK.flash), beacon([-2.75, -0.55, 0], BEACON.red, BLINK.pulse, 0.6)] };
}

/** Model builders, indexed by OrbitDef.model. */
export const MODELS: Array<(b: Builder) => ModelInfo> = [station, comms, weather, telescope, cubes, sail, navsat, radar, drum, sputnik, jwst];

/**
 * Build every body (body index i uses MODELS[models[i]]) into one geometry, one body per step so
 * the init can yield between them: iterate, then take `geometry()`.
 */
export function* buildSpace(models: readonly number[], info: ModelInfo[]): Generator<void, BG> {
  const b = new Builder();
  for (let i = 0; i < models.length; i++) {
    b.b = i;
    info.push(MODELS[models[i]](b));
    yield;
  }
  return b.geometry();
}
