// Low-poly nature meshes, built in code (zero assets). Every mesh is non-indexed with flat facet
// normals and three extra vertex attributes the nature shaders read:
//   color  (vec3)  base colour (sRGB baked to linear here): trunks brown, crowns white (tinted per
//                  instance), rocks grey;
//   aTint  (float) 1 where the per-instance colour applies (crowns, blades), 0 elsewhere (trunks);
//   aSway  (float) 0 at the base … 1 at the top: how far wind moves the vertex.
// Origins sit at the base (the reveal grows things up out of the ground). +Y is up; heights are
// normalised so an instance's Y scale is its height in metres.

import { BufferAttribute, BufferGeometry, Color } from 'three';
import { mulberry32 } from '../world/rng';

type V3 = [number, number, number];

class Builder {
  pos: number[] = [];
  col: number[] = [];
  tint: number[] = [];
  sway: number[] = [];
  /** Add a triangle (counter-clockwise seen from outside). */
  tri(a: V3, b: V3, c: V3, color: Color, tint: number, sway: (p: V3) => number) {
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(color.r, color.g, color.b);
      this.tint.push(tint);
      this.sway.push(sway(p));
    }
  }
  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(this.tint), 1));
    g.setAttribute('aSway', new BufferAttribute(new Float32Array(this.sway), 1));
    g.computeVertexNormals(); // non-indexed: flat facet normals
    g.computeBoundingSphere();
    return g;
  }
}

const swayBy = (h0: number, h1: number) => (p: V3) => Math.max(0, Math.min(1, (p[1] - h0) / (h1 - h0)));
const noSway = () => 0;

/** A tapered n-gon prism from y0 (radius r0) to y1 (radius r1), centred on (cx, cz). */
function prism(b: Builder, n: number, r0: number, r1: number, y0: number, y1: number, color: Color, tint: number, sway: (p: V3) => number, cx = 0, cz = 0, rot = 0, cap = true, cx1 = cx, cz1 = cz) {
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i / n) * Math.PI * 2;
    const a1 = rot + ((i + 1) / n) * Math.PI * 2;
    const p00: V3 = [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0];
    const p01: V3 = [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0];
    const p10: V3 = [cx1 + Math.cos(a0) * r1, y1, cz1 + Math.sin(a0) * r1];
    const p11: V3 = [cx1 + Math.cos(a1) * r1, y1, cz1 + Math.sin(a1) * r1];
    b.tri(p00, p10, p11, color, tint, sway);
    if (r0 > 1e-4) b.tri(p00, p11, p01, color, tint, sway);
    if (cap && r1 > 1e-4) b.tri(p10, [cx1, y1, cz1], p11, color, tint, sway);
  }
}

/** A cone (n sides) from radius r at y0 to a point at y1. */
function cone(b: Builder, n: number, r: number, y0: number, y1: number, color: Color, tint: number, sway: (p: V3) => number, rot = 0, cx = 0, cz = 0) {
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i / n) * Math.PI * 2;
    const a1 = rot + ((i + 1) / n) * Math.PI * 2;
    const p0: V3 = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r];
    const p1: V3 = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r];
    b.tri(p0, [cx, y1, cz], p1, color, tint, sway);
    b.tri(p0, p1, [cx, y0 - r * 0.18, cz], color, tint, sway); // a slightly drooping underside
  }
}

// Icosahedron (unit) and one subdivision level, for blobby crowns and rocks.
const ICO_T = (1 + Math.sqrt(5)) / 2;
const ICO_V: V3[] = [
  [-1, ICO_T, 0], [1, ICO_T, 0], [-1, -ICO_T, 0], [1, -ICO_T, 0],
  [0, -1, ICO_T], [0, 1, ICO_T], [0, -1, -ICO_T], [0, 1, -ICO_T],
  [ICO_T, 0, -1], [ICO_T, 0, 1], [-ICO_T, 0, -1], [-ICO_T, 0, 1],
].map(([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l] as V3;
});
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/** Unit-sphere triangles: detail 0 (20) or 1 (80). */
function sphereTris(detail: 0 | 1): V3[][] {
  const out: V3[][] = [];
  for (const [i, j, k] of ICO_F) {
    const a = ICO_V[i], b = ICO_V[j], c = ICO_V[k];
    if (detail === 0) {
      out.push([a, b, c]);
      continue;
    }
    const m = (p: V3, q: V3): V3 => {
      const x = p[0] + q[0], y = p[1] + q[1], z = p[2] + q[2];
      const l = Math.hypot(x, y, z);
      return [x / l, y / l, z / l];
    };
    const ab = m(a, b), bc = m(b, c), ca = m(c, a);
    out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  return out;
}
const SPHERE0 = sphereTris(0);
const SPHERE1 = sphereTris(1);

/** A lumpy blob (ellipsoid with seeded vertex jitter, shared corners stay welded). */
function blob(b: Builder, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: Color, tint: number, sway: (p: V3) => number, seed: number, jitter = 0.12, detail: 0 | 1 = 1) {
  const rnd = mulberry32(seed);
  const cache = new Map<string, number>();
  const j = (p: V3) => {
    const key = `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
    let v = cache.get(key);
    if (v === undefined) cache.set(key, (v = 1 + (rnd() - 0.5) * 2 * jitter));
    return v;
  };
  const shade = (p: V3): V3 => {
    const k = j(p);
    return [cx + p[0] * rx * k, cy + p[1] * ry * k, cz + p[2] * rz * k];
  };
  for (const [p, q, r] of detail === 1 ? SPHERE1 : SPHERE0) b.tri(shade(p), shade(q), shade(r), color, tint, sway);
}

const TRUNK = new Color('#8F6444');
const TRUNK_DARK = new Color('#7E573B');
const PALM_TRUNK = new Color('#AD8660');
const PALM_TRUNK_DARK = new Color('#987251');
const WHITE = new Color(1, 1, 1);
const STEM = new Color('#6CBF45');
const ROCK = new Color('#FFFFFF');

/**
 * Round deciduous tree, height 1 (trunk to crown top), crown ~0.75 wide. `variant` reshapes it;
 * `lod` 1 is the far version (a 20-facet main crown instead of 80; same silhouette and colours).
 */
export function blobTreeGeometry(variant: number, lod: 0 | 1 = 0): BufferGeometry {
  const b = new Builder();
  const sw = swayBy(0.25, 1);
  const main = lod === 0 ? 1 : 0;
  prism(b, lod === 0 ? 6 : 5, 0.075, 0.05, 0, 0.45, TRUNK, 0, noSway, 0, 0, 0.3);
  if (variant === 0) {
    blob(b, 0, 0.62, 0, 0.36, 0.34, 0.36, WHITE, 1, sw, 11, 0.1, main);
    blob(b, 0.17, 0.5, 0.08, 0.22, 0.2, 0.22, WHITE, 1, sw, 12, 0.12, 0);
    blob(b, -0.14, 0.52, -0.12, 0.2, 0.19, 0.2, WHITE, 1, sw, 13, 0.12, 0);
  } else {
    // Taller, lollipop-ish with a side lobe.
    blob(b, 0, 0.7, 0, 0.27, 0.3, 0.27, WHITE, 1, sw, 21, 0.1, main);
    blob(b, 0.06, 0.48, -0.05, 0.25, 0.18, 0.25, WHITE, 1, sw, 22, 0.12, 0);
  }
  return b.build();
}

/** Conifer: trunk and three stacked cones, height 1, ~0.5 wide. */
export function coniferGeometry(): BufferGeometry {
  const b = new Builder();
  const sw = swayBy(0.15, 1);
  prism(b, 5, 0.06, 0.045, 0, 0.22, TRUNK_DARK, 0, noSway);
  cone(b, 7, 0.27, 0.14, 0.58, WHITE, 1, sw, 0.2);
  cone(b, 7, 0.21, 0.4, 0.82, WHITE, 1, sw, 0.6);
  cone(b, 7, 0.14, 0.64, 1.0, WHITE, 1, sw, 1.0);
  return b.build();
}

/** Palm: a gently curved trunk and drooping fronds, height 1. */
export function palmGeometry(): BufferGeometry {
  const b = new Builder();
  const segs = 5;
  const bend = (y: number) => 0.16 * y * y; // trunk leans toward +x
  for (let i = 0; i < segs; i++) {
    const y0 = (i / segs) * 0.86;
    const y1 = ((i + 1) / segs) * 0.86;
    const r0 = i === 0 ? 0.062 : 0.05 - i * 0.004;
    const r1 = 0.05 - (i + 1) * 0.004;
    // Rings share their centre and radius with the next segment: one continuous, gently bent trunk.
    prism(b, 6, r0, r1, y0, y1, i % 2 ? PALM_TRUNK : PALM_TRUNK_DARK, 0, swayBy(0, 1), bend(y0 / 0.86), 0, 0, false, bend(y1 / 0.86), 0);
  }
  const top: V3 = [bend(1), 0.86, 0];
  const sw = swayBy(0.5, 1);
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + 0.3;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const L = 0.42;
    // Two-segment frond: up-and-out, then drooping.
    const mid: V3 = [top[0] + dx * L * 0.55, top[1] + 0.07, top[2] + dz * L * 0.55];
    const tip: V3 = [top[0] + dx * L, top[1] - 0.12, top[2] + dz * L];
    const sx = -dz * 0.09;
    const sz = dx * 0.09;
    const m1: V3 = [mid[0] + sx, mid[1], mid[2] + sz];
    const m2: V3 = [mid[0] - sx, mid[1], mid[2] - sz];
    b.tri(top, m1, m2, WHITE, 1, sw);
    b.tri(m2, m1, top, WHITE, 1, sw);
    b.tri(m1, tip, m2, WHITE, 1, sw);
    b.tri(m2, tip, m1, WHITE, 1, sw);
  }
  blob(b, top[0], top[1] - 0.02, top[2], 0.05, 0.045, 0.05, PALM_TRUNK, 0, sw, 5, 0.05, 0);
  return b.build();
}

/** Bush: two or three lumps, height 1, ~1.5 wide (scale it small). */
export function bushGeometry(): BufferGeometry {
  const b = new Builder();
  const sw = swayBy(0.2, 1);
  blob(b, 0, 0.5, 0, 0.55, 0.5, 0.55, WHITE, 1, sw, 31, 0.14, 0);
  blob(b, 0.42, 0.34, 0.15, 0.36, 0.34, 0.36, WHITE, 1, sw, 32, 0.14, 0);
  blob(b, -0.3, 0.32, -0.3, 0.32, 0.3, 0.32, WHITE, 1, sw, 33, 0.14, 0);
  return b.build();
}

/** Rock: a lumpy, slightly flattened icosahedron, ~1 across, base at y = 0 (sunk a little). */
export function rockGeometry(seed: number): BufferGeometry {
  const b = new Builder();
  blob(b, 0, 0.32, 0, 0.55, 0.45, 0.5, ROCK, 1, noSway, seed, 0.22, 0);
  return b.build();
}

/**
 * Grass tuft: five tapered blades fanning out, height 1, ~0.7 wide. Base a little darker than the
 * ground, tips lighter. Normals point up (like the ground they grow from), so blades shade with
 * the meadow instead of going dark edge-on to the sun.
 */
export function tuftGeometry(): BufferGeometry {
  const b = new Builder();
  const rnd = mulberry32(77);
  const base = new Color(0.86, 0.86, 0.84);
  const tip = new Color(1.3, 1.3, 1.16);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rnd() * 0.7;
    const lean = 0.16 + rnd() * 0.24;
    const h = 0.6 + rnd() * 0.4;
    const w = 0.09;
    const ox = Math.cos(a) * 0.05;
    const oz = Math.sin(a) * 0.05;
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    const l: V3 = [ox + px, 0, oz + pz];
    const r: V3 = [ox - px, 0, oz - pz];
    const t: V3 = [ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean];
    const before = b.pos.length / 3;
    b.tri(l, t, r, base, 1, (p) => p[1]);
    b.tri(r, t, l, base, 1, (p) => p[1]);
    for (let v = before; v < b.pos.length / 3; v++) {
      const k = b.pos[v * 3 + 1] / h;
      b.col[v * 3] = base.r + (tip.r - base.r) * k;
      b.col[v * 3 + 1] = base.g + (tip.g - base.g) * k;
      b.col[v * 3 + 2] = base.b + (tip.b - base.b) * k;
    }
  }
  return upNormals(b.build(), 0.25);
}

/** Point normals mostly up (+Y), keeping `keep` of the facet normal: ground-like shading. */
function upNormals(g: BufferGeometry, keep: number): BufferGeometry {
  const n = g.getAttribute('normal') as BufferAttribute;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i) * keep, y = n.getY(i) * keep + (1 - keep), z = n.getZ(i) * keep;
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(i, x / l, y / l, z / l);
  }
  return g;
}

/**
 * Flower, height 1: a short stem with one leaf and a round six-petal head facing up (petals tinted
 * per instance, a golden centre). Scale it wider than tall: the head is ~0.8 across.
 */
export function flowerGeometry(): BufferGeometry {
  const b = new Builder();
  const sw = (p: V3) => p[1];
  prism(b, 3, 0.03, 0.022, 0, 0.66, STEM, 0, sw, 0, 0, 0, false);
  b.tri([0, 0.22, 0], [0.24, 0.36, 0.05], [0.04, 0.42, 0], STEM, 0, sw);
  b.tri([0.04, 0.42, 0], [0.24, 0.36, 0.05], [0, 0.22, 0], STEM, 0, sw);
  const y = 0.7;
  const heart = new Color('#FFC233');
  // Six rounded petals: each a fan of three triangles round an ellipse, slightly cupped.
  for (let k = 0; k < 6; k++) {
    const am = (k / 6) * Math.PI * 2;
    const ca = Math.cos(am), sa = Math.sin(am);
    const pt = (u: number, v: number, lift: number): V3 => [ca * u - sa * v, y + lift, sa * u + ca * v];
    const base = pt(0.06, 0, 0);
    const ring = [pt(0.14, -0.13, 0.04), pt(0.3, -0.12, 0.08), pt(0.4, 0, 0.1), pt(0.3, 0.12, 0.08), pt(0.14, 0.13, 0.04)];
    for (let q = 0; q < ring.length - 1; q++) {
      b.tri(base, ring[q + 1], ring[q], WHITE, 1, sw);
      b.tri(base, ring[q], ring[q + 1], WHITE, 1, sw);
    }
  }
  for (let k = 0; k < 6; k++) {
    const a0 = (k / 6) * Math.PI * 2;
    const a1 = ((k + 1) / 6) * Math.PI * 2;
    const p0: V3 = [Math.cos(a0) * 0.11, y + 0.04, Math.sin(a0) * 0.11];
    const p1: V3 = [Math.cos(a1) * 0.11, y + 0.04, Math.sin(a1) * 0.11];
    b.tri(p1, p0, [0, y + 0.1, 0], heart, 0, sw);
  }
  return upNormals(b.build(), 0.35);
}

/** Pebble: a small flattened lump, ~1 across. */
export function pebbleGeometry(): BufferGeometry {
  const b = new Builder();
  blob(b, 0, 0.18, 0, 0.5, 0.32, 0.42, ROCK, 1, noSway, 91, 0.2, 0);
  return b.build();
}

const WALL = new Color('#F3E9D2');
const ROOF_RED = new Color('#D9483B');
const WOOD = new Color('#8E6A4E');
const SAIL = new Color('#FFF8EC');
const DOOR = new Color('#5B4636');
const STONE = new Color('#A39A92');
const LAMP = new Color('#FFF1C2');
const GALLERY = new Color('#4A4E5A');

/** The windmill's sail hub in object space (the nature shader spins aSway < 0 parts about it). */
export const WINDMILL_HUB: V3 = [0, 0.7, 0.17];

/**
 * Windmill, height 1 (scale ~9 m): a tapered octagonal tower, a red cap, a door, and four sails
 * in front of the cap (local +Z) whose vertices carry aSway = −1 (they spin about WINDMILL_HUB).
 */
export function windmillGeometry(): BufferGeometry {
  const b = new Builder();
  prism(b, 8, 0.19, 0.2, -0.04, 0.04, STONE, 0, noSway, 0, 0, Math.PI / 8);
  prism(b, 8, 0.16, 0.11, 0.04, 0.62, WALL, 0, noSway, 0, 0, Math.PI / 8);
  cone(b, 8, 0.14, 0.62, 0.82, ROOF_RED, 0, noSway, Math.PI / 8);
  // Door and a little window (front, +Z).
  b.tri([-0.035, 0.04, 0.162], [0.035, 0.04, 0.162], [0.035, 0.16, 0.152], DOOR, 0, noSway);
  b.tri([-0.035, 0.04, 0.162], [0.035, 0.16, 0.152], [-0.035, 0.16, 0.152], DOOR, 0, noSway);
  b.tri([-0.025, 0.36, 0.14], [0.025, 0.36, 0.14], [0.025, 0.42, 0.132], DOOR, 0, noSway);
  b.tri([-0.025, 0.36, 0.14], [0.025, 0.42, 0.132], [-0.025, 0.42, 0.132], DOOR, 0, noSway);
  // Axle from the cap to the hub.
  prism(b, 5, 0.022, 0.022, 0, 0.1, WOOD, 0, noSway, 0, 0, 0, true);
  const axle = b.pos.length / 3 - 5 * 3 * 3;
  for (let v = axle; v < b.pos.length / 3; v++) {
    // Turn the little prism to lie along +Z at the hub height.
    const x = b.pos[v * 3], y = b.pos[v * 3 + 1], z = b.pos[v * 3 + 2];
    b.pos[v * 3] = x;
    b.pos[v * 3 + 1] = WINDMILL_HUB[1] + z;
    b.pos[v * 3 + 2] = 0.08 + y;
  }
  // Sails: an arm and a slatted sail panel per blade, double-sided, in the plane z = hub.
  const spin = () => -1;
  const [hx, hy, hz] = WINDMILL_HUB;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const dx = Math.cos(a), dy = Math.sin(a);
    const px = -dy, py = dx; // perpendicular in the sail plane
    const quad = (r0: number, r1: number, o0: number, o1: number, z: number, c: Color) => {
      const p = (r: number, o: number): V3 => [hx + dx * r + px * o, hy + dy * r + py * o, hz + z];
      const q0 = p(r0, o0), q1 = p(r1, o0), q2 = p(r1, o1), q3 = p(r0, o1);
      b.tri(q0, q1, q2, c, 0, spin);
      b.tri(q0, q2, q3, c, 0, spin);
      // The back face sits a few cm behind the front one: coincident twins self-shadow (acne).
      const back = (v: V3): V3 => [v[0], v[1], v[2] - 0.007];
      b.tri(back(q2), back(q1), back(q0), c, 0, spin);
      b.tri(back(q3), back(q2), back(q0), c, 0, spin);
    };
    quad(0, 0.46, -0.012, 0.012, 0.012, WOOD);
    quad(0.1, 0.45, 0.016, 0.1, 0.006, SAIL);
  }
  // Sails spin in their own plane, so one normal serves all of them: tilted up toward the sky, the
  // same on both faces (a sail seen from behind is lit like the front, never a dark slate).
  const g = b.build();
  const nrm = g.getAttribute('normal') as BufferAttribute;
  const sw = g.getAttribute('aSway') as BufferAttribute;
  for (let i = 0; i < nrm.count; i++) if (sw.getX(i) < -0.5) nrm.setXYZ(i, 0, 0.72, nrm.getZ(i) >= 0 ? 0.69 : -0.69);
  return g;
}

/**
 * Lighthouse, height 1 (scale ~11 m): a stone plinth, a white tower with red bands, a dark
 * gallery, the lamp room (warm glass) and a red roof. The beam is the nature system's own mesh.
 */
export function lighthouseGeometry(): BufferGeometry {
  const b = new Builder();
  prism(b, 8, 0.2, 0.19, -0.06, 0.05, STONE, 0, noSway, 0, 0, 0.2);
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    const y0 = 0.05 + (i / bands) * 0.66;
    const y1 = 0.05 + ((i + 1) / bands) * 0.66;
    const r0 = 0.14 - (i / bands) * 0.05;
    const r1 = 0.14 - ((i + 1) / bands) * 0.05;
    prism(b, 10, r0, r1, y0, y1, i % 2 ? ROOF_RED : WALL, 0, noSway, 0, 0, 0, false);
  }
  prism(b, 10, 0.13, 0.13, 0.71, 0.74, GALLERY, 0, noSway);
  prism(b, 8, 0.07, 0.07, 0.74, 0.85, LAMP, 0, noSway);
  cone(b, 8, 0.1, 0.85, 0.97, ROOF_RED, 0, noSway);
  blob(b, 0, 0.985, 0, 0.022, 0.022, 0.022, GALLERY, 0, noSway, 3, 0.05, 0);
  return b.build();
}
