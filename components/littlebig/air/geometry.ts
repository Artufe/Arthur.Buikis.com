// Air meshes, built in code (zero assets): a chunky toy airliner and a striped hot-air balloon.
// Everything is a loft (elliptical sections along an axis), indexed with smooth normals, so the
// toon ramp draws soft rounded bands. Vertex attributes the air shader reads (shaders.ts):
//   color   base colour (linear). White where the paint below decides the colour.
//   aPaint  (x, mode, z): mode 1 balloon gores (x = gore coordinate, z = envelope height 0..1),
//           mode 2 fuselage (x = height across the window row in half-widths, z = length m),
//           mode 3 / 4 solid livery colour A / B, mode 5 engine fan disc, mode 6 wing (z = 1 on
//           the underside: the root flash). Mode 0: just the vertex colour.
//   aGlow   how much the burner lights this vertex: ≥ 0 as a lantern (steady at night, brighter in
//           a burst: the envelope), < 0 in bursts only (ropes, basket rim, the burner can).
// Local frames: the plane's nose is +Z, up +Y, left wing +X (left = up × forward), origin at its
// centre; the balloon stands on its basket bottom at the origin, +Y up.

import { BufferAttribute, BufferGeometry, Color } from 'three';

type Section = readonly number[]; // [t, a, b, cu?, cv?]: position along the axis, half-axes, centre offset
type Paint = (x: number, y: number, z: number, phi: number, sec: number) => readonly [number, number, number];

const NO_PAINT: Paint = () => [0, 0, 0];

class Geo {
  pos: number[] = [];
  col: number[] = [];
  paint: number[] = [];
  glow: number[] = [];
  idx: number[] = [];
  seams: number[] = [];

  private vert(x: number, y: number, z: number, c: Color, p: readonly [number, number, number], g: number): number {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.paint.push(p[0], p[1], p[2]);
    this.glow.push(g);
    return this.pos.length / 3 - 1;
  }

  /**
   * A loft along `axis` (0 = x, 1 = y, 2 = z) through elliptical sections; a section with zero
   * half-axes is a single pole vertex (rounded tips). `seam` duplicates the first column so an
   * angle-based paint coordinate can wrap (normals are averaged across it afterwards).
   */
  loft(axis: 0 | 1 | 2, secs: readonly Section[], seg: number, color: Color | ((t: number, sec: number) => Color), paint: Paint = NO_PAINT, glow: (t: number) => number = () => 0, rot = 0, seam = false) {
    const cols = seam ? seg + 1 : seg;
    const rings: number[][] = [];
    const first = this.idx.length;
    for (let k = 0; k < secs.length; k++) {
      const [t, a, b, cu = 0, cv = 0] = secs[k];
      const c = typeof color === 'function' ? color(t, k) : color;
      const ring: number[] = [];
      const at = (u: number, v: number): [number, number, number] => (axis === 2 ? [u, v, t] : axis === 0 ? [t, v, u] : [v, t, u]);
      if (a <= 0 && b <= 0) {
        const [x, y, z] = at(cu, cv);
        const i = this.vert(x, y, z, c, paint(x, y, z, 0, k), glow(t));
        for (let j = 0; j < cols; j++) ring.push(i);
      } else {
        for (let j = 0; j < cols; j++) {
          const phi = rot + (j / seg) * Math.PI * 2;
          const [x, y, z] = at(cu + a * Math.cos(phi), cv + b * Math.sin(phi));
          ring.push(this.vert(x, y, z, c, paint(x, y, z, j / seg, k), glow(t)));
        }
        if (seam) this.seams.push(ring[0], ring[seg]);
      }
      rings.push(ring);
    }
    for (let k = 0; k < rings.length - 1; k++) {
      const r0 = rings[k];
      const r1 = rings[k + 1];
      for (let j = 0; j < seg; j++) {
        const j1 = seam ? j + 1 : (j + 1) % seg;
        const a = r0[j], b = r0[j1], c = r1[j], d = r1[j1];
        if (a !== b) this.idx.push(a, b, d);
        if (c !== d) this.idx.push(a, d, c);
      }
    }
    // Winding: each triangle runs φ then t, so its normal is φ̂ × (profile tangent): outward where
    // the profile moves along +t, and correctly inward-facing on concave caps (intakes, the basket's
    // inside, the balloon's mouth). The x-axis frame (t, v, u) is left-handed, so it flips.
    if (axis === 0)
      for (let i = first; i < this.idx.length; i += 3) {
        const t = this.idx[i + 1];
        this.idx[i + 1] = this.idx[i + 2];
        this.idx[i + 2] = t;
      }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aPaint', new BufferAttribute(new Float32Array(this.paint), 3));
    g.setAttribute('aGlow', new BufferAttribute(new Float32Array(this.glow), 1));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const n = g.getAttribute('normal') as BufferAttribute;
    for (let i = 0; i < this.seams.length; i += 2) {
      const a = this.seams[i];
      const b = this.seams[i + 1];
      const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(a, x / l, y / l, z / l);
      n.setXYZ(b, x / l, y / l, z / l);
    }
    g.computeBoundingSphere();
    return g;
  }
}

const lin = (hex: string) => new Color(hex);

// ── The plane ──

const WHITE = lin('#FFFFFF');
const BELLY = lin('#E6EAF6');
const LIP = lin('#D9DCE8');
const WING = lin('#E6E8F2');
const DARK = lin('#2A2D52');
const METAL = lin('#8E93AE');

/** Fuselage centre-line height (rises toward the tail) and radius along the length. */
const FUSE: ReadonlyArray<readonly [number, number, number]> = [
  // z, r, centre y
  [-4.25, 0, 0.6],
  [-4.1, 0.16, 0.56],
  [-3.7, 0.32, 0.45],
  [-3.1, 0.5, 0.3],
  [-2.3, 0.68, 0.13],
  [-1.4, 0.78, 0.04],
  [-0.4, 0.8, 0],
  [0.8, 0.8, 0],
  [1.9, 0.78, 0],
  [2.7, 0.72, 0],
  [3.3, 0.6, -0.02],
  [3.75, 0.44, -0.04],
  [4.05, 0.26, -0.05],
  [4.2, 0.1, -0.05],
  [4.24, 0, -0.05],
];

/** Plane wing geometry, also used for the nav-light positions (index.ts). */
export const WING_TIP = { x: 4.44, y: 0.04, z: -1.24 };
export const TAIL_TIP = { x: 0, y: 0.62, z: -4.32 };
export const BEACON = { x: 0, y: 0.95, z: 0.3 };
export const ENGINE = { x: 1.95, y: -0.9, z: 0 };

export function planeGeometry(): BufferGeometry {
  const g = new Geo();
  // Fuselage: white, a soft lilac-grey belly; the window row and the nose windscreen are paint.
  const fuseCy = (z: number) => {
    for (let i = 0; i < FUSE.length - 1; i++) {
      const [z0, , y0] = FUSE[i];
      const [z1, , y1] = FUSE[i + 1];
      if (z >= z0 && z <= z1) return y0 + ((z - z0) / (z1 - z0)) * (y1 - y0);
    }
    return 0;
  };
  g.loft(
    2,
    FUSE.map(([z, r, cy]) => [z, r * 1.16, r * 1.2, 0, cy]),
    18,
    (z) => WHITE,
    (x, y, z) => [(y - fuseCy(z) - 0.16) / 0.13, 2, z],
    undefined,
    -Math.PI / 2,
  );
  // Belly: recolour the lower vertices (smooth gradient under the toon ramp).
  for (let i = 0; i < g.pos.length / 3; i++) {
    const z = g.pos[i * 3 + 2];
    const rel = g.pos[i * 3 + 1] - fuseCy(z);
    const k = Math.max(0, Math.min(1, (-rel - 0.25) / 0.35));
    g.col[i * 3] = WHITE.r + (BELLY.r - WHITE.r) * k;
    g.col[i * 3 + 1] = WHITE.g + (BELLY.g - WHITE.g) * k;
    g.col[i * 3 + 2] = WHITE.b + (BELLY.b - WHITE.b) * k;
  }
  // Wings: one chunky loft tip to tip (through the fuselage), swept, with dihedral, a blunt rounded
  // tip and an upturned livery winglet: toy proportions, so they still read edge-on.
  const wingZ = (x: number) => 0.3 - x * 0.34;
  const wingY = (x: number) => -0.34 + x * 0.075;
  const surface = (sp: number[], ch: number[], th: number[], z: (x: number) => number, y: (x: number) => number) => {
    const out: number[][] = [];
    for (let k = sp.length - 1; k > 0; k--) out.push([-sp[k], ch[k], th[k], z(sp[k]), y(sp[k])]);
    for (let k = 0; k < sp.length; k++) out.push([sp[k], ch[k], th[k], z(sp[k]), y(sp[k])]);
    return out;
  };
  g.loft(0, surface([0, 1, 2, 3, 3.8, 4.25, 4.42, 4.5], [1.3, 1.2, 1.03, 0.86, 0.72, 0.62, 0.48, 0], [0.31, 0.28, 0.24, 0.2, 0.17, 0.15, 0.11, 0], wingZ, wingY), 12, WING, (x, y) => [0, 6, y < wingY(Math.abs(x)) - 0.02 ? 1 : 0]);
  for (const s of [-1, 1])
    g.loft(
      1,
      [
        [wingY(4.3) - 0.05, 0.52, 0.08, wingZ(4.3) - 0.1, 4.3 * s],
        [wingY(4.3) + 0.35, 0.42, 0.075, wingZ(4.3) - 0.3, 4.36 * s],
        [wingY(4.3) + 0.72, 0.28, 0.06, wingZ(4.3) - 0.5, 4.42 * s],
        [wingY(4.3) + 0.8, 0, 0, wingZ(4.3) - 0.55, 4.43 * s],
      ],
      8,
      WHITE,
      () => [0, 3, 0],
    );
  // Tailplane.
  g.loft(0, surface([0, 0.8, 1.45, 1.8, 1.95], [0.72, 0.62, 0.48, 0.34, 0], [0.15, 0.13, 0.1, 0.07, 0], (x) => -3.45 - x * 0.4, (x) => 0.45 + x * 0.06), 10, WING);
  // Fin: swept, livery A.
  g.loft(
    1,
    [
      [0.3, 1.08, 0.21, -3.32],
      [0.9, 0.94, 0.19, -3.6],
      [1.5, 0.76, 0.16, -3.88],
      [2.0, 0.58, 0.13, -4.1],
      [2.3, 0.42, 0.1, -4.24],
      [2.46, 0.24, 0.06, -4.3],
      [2.5, 0, 0, -4.31],
    ],
    12,
    WHITE,
    () => [0, 3, 0],
  );
  // Engines: fat livery B nacelles with a light metal lip, a grey fan disc with blades (paint) round
  // a metal spinner, and an exhaust cone. (A dark intake with a hub dot read as a car tyre.)
  for (const s of [-1, 1]) {
    const cx = ENGINE.x * s;
    const ring = (z: number, r: number) => [ENGINE.z + z, r, r, cx, ENGINE.y];
    g.loft(2, [ring(-0.95, 0), ring(-0.84, 0.17), ring(-0.64, 0.31), ring(-0.52, 0.36)], 12, METAL);
    g.loft(2, [ring(-0.52, 0.36), ring(-0.44, 0.42), ring(0.2, 0.5), ring(0.74, 0.5), ring(0.84, 0.485)], 16, WHITE, () => [0, 4, 0]);
    g.loft(2, [ring(0.84, 0.485), ring(0.92, 0.46), ring(0.955, 0.41), ring(0.935, 0.365)], 16, LIP);
    g.loft(2, [ring(0.935, 0.365), ring(0.84, 0.345)], 16, DARK);
    g.loft(2, [ring(0.84, 0.345), ring(0.81, 0.2), ring(0.8, 0)], 16, WHITE, () => [0, 5, 0]);
    g.loft(2, [ring(0.74, 0.17), ring(0.86, 0.14), ring(0.97, 0)], 10, METAL);
    // Pylon tying the nacelle to the wing.
    g.loft(1, [[ENGINE.y + 0.3, 0.5, 0.08, ENGINE.z + 0.2, cx], [wingY(ENGINE.x), 0.5, 0.08, ENGINE.z + 0.05, cx]], 6, WING);
  }
  return g.build();
}

// ── The balloon ──

const WICKER = lin('#B9814A');
const WICKER_RIM = lin('#7E4E2C');
const ROPE = lin('#5C4B44');
const MOUTH = lin('#3B2C4C');

/** Envelope profile: [height above the basket bottom, radius]. */
const ENVELOPE: ReadonlyArray<readonly [number, number]> = [
  [1.95, 0.55],
  [2.35, 0.95],
  [2.9, 1.55],
  [3.6, 2.2],
  [4.4, 2.7],
  [5.3, 2.95],
  [6.15, 2.85],
  [6.85, 2.45],
  [7.4, 1.8],
  [7.75, 1.05],
  [7.95, 0.4],
  [8.0, 0],
];
export const GORES = 12;

/** ENVELOPE through a Catmull-Rom spline, `sub` rings per span: a smooth silhouette up close (12 rings read as a polyline at rooftop range). */
function smoothProfile(pts: ReadonlyArray<readonly [number, number]>, sub: number): number[][] {
  const n = pts.length;
  const at = (i: number) => (i < 0 ? [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]] : i >= n ? [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]] : pts[i]);
  const out: number[][] = [];
  for (let i = 0; i < n - 1; i++)
    for (let k = 0; k < sub; k++) {
      const t = k / sub;
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      const c = (j: number) => 0.5 * (2 * p1[j] + (p2[j] - p0[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (3 * p1[j] - p0[j] - 3 * p2[j] + p3[j]) * t * t * t);
      out.push([c(0), Math.max(0, c(1))]);
    }
  out.push([pts[n - 1][0], pts[n - 1][1]]);
  return out;
}
export const BURNER_Y = 1.45;

export function balloonGeometry(): BufferGeometry {
  const g = new Geo();
  // Basket: a soft square tub (4-sided loft turned 45°), darker rim, dark inside.
  g.loft(
    1,
    [
      [0, 0, 0],
      [0.02, 0.5, 0.5],
      [0.62, 0.6, 0.6],
      [0.66, 0.66, 0.66],
      [0.78, 0.66, 0.66],
      [0.8, 0.56, 0.56],
      [0.7, 0, 0],
    ],
    4,
    (t, k) => (k >= 3 ? WICKER_RIM : WICKER),
    undefined,
    (t) => (t > 0.64 ? -0.4 : -0.12),
    Math.PI / 4,
  );
  // Ropes from the basket corners up to the envelope's mouth, and the burner frame.
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const x0 = Math.sin(a) * 0.42, z0 = Math.cos(a) * 0.42;
    const x1 = Math.sin(a) * 0.5, z1 = Math.cos(a) * 0.5;
    g.loft(1, [[0.78, 0.035, 0.035, z0, x0], [1.97, 0.035, 0.035, z1, x1]], 4, ROPE, undefined, () => -0.5);
  }
  g.loft(1, [[1.25, 0, 0], [1.25, 0.2, 0.2], [1.6, 0.2, 0.2], [1.6, 0, 0]], 8, METAL, undefined, () => -0.35);
  // Envelope: gores in two colours with a white band and a coloured crown (paint mode 1); the mouth
  // is a dark recessed cap that glows when the burner fires at night.
  const secs: number[][] = smoothProfile(ENVELOPE, 3).map(([y, r]) => [y, r, r]);
  g.loft(1, [[2.25, 0, 0], [ENVELOPE[0][0], ENVELOPE[0][1], ENVELOPE[0][1]]], 40, MOUTH, undefined, () => 1);
  const y0 = ENVELOPE[0][0];
  const y1 = ENVELOPE[ENVELOPE.length - 1][0];
  g.loft(
    1,
    secs,
    40,
    WHITE,
    (x, y, z, phi) => [phi * GORES * 0.5, 1, (y - y0) / (y1 - y0)],
    (t) => (t < y0 + 0.4 ? 1 : Math.max(0.3, 1 - (t - y0) / 4)),
    0,
    true,
  );
  return g.build();
}
