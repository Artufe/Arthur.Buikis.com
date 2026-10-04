// Merged-geometry builder for the city: every static surface (buildings, props, ground) is written
// into a few big vertex buffers so the whole city draws in a handful of calls. Boot-time only.
//
// Per-vertex attributes (see shader.ts):
//   position, normal, color (u8 linear), aBase (vec3: the reveal pivot, a point on the ground),
//   aReveal (reveal delay, s), aGrow (reveal duration multiplier), aInfo (vec4: u, v, kind, param) —
//   the procedural pattern inputs.

import { BufferAttribute, BufferGeometry, Color } from 'three';
import { toSphere } from '../world/city/frame';
import { v3, type Vec3 } from '../world/sphere';

/** Pattern kinds (aInfo.z). Keep in sync with shader.ts. */
export const K = {
  plain: 0,
  facade: 1,
  sidewalk: 2,
  tiles: 3,
  roof: 4,
  asphalt: 5,
  lawn: 6,
  water: 7,
  glow: 8,
  clock: 9,
  leaf: 10,
} as const;

/** Facade styles (aInfo.w / 1024). */
export const F = { punched: 0, curtain: 1, ribbon: 2, house: 3, shop: 4, plain: 5, arcade: 6, sparse: 7 } as const;

/** An affine frame: world = o + ex·x + ey·y + ez·z. */
export interface Xf {
  o: Vec3;
  ex: Vec3;
  ey: Vec3;
  ez: Vec3;
}

export class Geo {
  pos: Float32Array;
  nor: Float32Array;
  col: Uint8Array;
  base: Float32Array;
  rev: Float32Array;
  growA: Float32Array;
  info: Float32Array;
  idx: Uint32Array;
  n = 0;
  ni = 0;
  /** Current per-vertex state (set before emitting). */
  readonly color = new Color(1, 1, 1);
  readonly pivot = v3();
  delay = 0;
  /** Reveal duration multiplier (taller buildings grow slower). */
  growK = 1;
  kind: number = K.plain;
  param = 0;
  /**
   * When set, every facade quad (kind K.facade) is recorded here as 24 numbers: three world
   * corners (P0, P1, P2: 9), their pattern uv (6), the unit normal (3), param (1), and the uv
   * bounds u0, u1, v0, v1, plus 1 spare — so pools.ts can put a night spark on every lit window
   * centre exactly where the facade shader draws it (tiers, insets and recesses included).
   */
  facades: number[] | null = null;
  /** When set, every awning (buildings.ts awningWrap) records its vertex range and wall run (world xyz). */
  awnings: Array<{ v0: number; v1: number; wall: number[] }> | null = null;

  constructor(cap = 4096) {
    this.pos = new Float32Array(cap * 3);
    this.nor = new Float32Array(cap * 3);
    this.col = new Uint8Array(cap * 3);
    this.base = new Float32Array(cap * 3);
    this.rev = new Float32Array(cap);
    this.growA = new Float32Array(cap);
    this.info = new Float32Array(cap * 4);
    this.idx = new Uint32Array(cap * 2);
  }

  private grow(nv: number, ni: number) {
    if (this.n + nv > this.rev.length) {
      const cap = Math.max(this.rev.length * 2, this.n + nv);
      const g = <T extends Float32Array | Uint8Array>(a: T, k: number): T => {
        const b = new (a.constructor as { new (n: number): T })(cap * k);
        b.set(a);
        return b;
      };
      this.pos = g(this.pos, 3);
      this.nor = g(this.nor, 3);
      this.col = g(this.col, 3);
      this.base = g(this.base, 3);
      this.rev = g(this.rev, 1);
      this.growA = g(this.growA, 1);
      this.info = g(this.info, 4);
    }
    if (this.ni + ni > this.idx.length) {
      const b = new Uint32Array(Math.max(this.idx.length * 2, this.ni + ni));
      b.set(this.idx);
      this.idx = b;
    }
  }

  /** Emit one vertex (world position, unit normal, pattern u/v). Returns its index. */
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.grow(1, 0);
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.nor[i * 3] = nx;
    this.nor[i * 3 + 1] = ny;
    this.nor[i * 3 + 2] = nz;
    const c = this.color;
    this.col[i * 3] = Math.max(0, Math.min(255, Math.round(c.r * 255)));
    this.col[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(c.g * 255)));
    this.col[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(c.b * 255)));
    this.base[i * 3] = this.pivot.x;
    this.base[i * 3 + 1] = this.pivot.y;
    this.base[i * 3 + 2] = this.pivot.z;
    this.rev[i] = this.delay;
    this.growA[i] = this.growK;
    this.info[i * 4] = u;
    this.info[i * 4 + 1] = v;
    this.info[i * 4 + 2] = this.kind;
    this.info[i * 4 + 3] = this.param;
    return i;
  }

  tri(a: number, b: number, c: number) {
    this.grow(0, 3);
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }

  quadIdx(a: number, b: number, c: number, d: number) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new BufferAttribute(this.nor.slice(0, n * 3), 3));
    g.setAttribute('color', new BufferAttribute(this.col.slice(0, n * 3), 3, true));
    g.setAttribute('aBase', new BufferAttribute(this.base.slice(0, n * 3), 3));
    g.setAttribute('aReveal', new BufferAttribute(this.rev.slice(0, n), 1));
    g.setAttribute('aGrow', new BufferAttribute(this.growA.slice(0, n), 1));
    g.setAttribute('aInfo', new BufferAttribute(this.info.slice(0, n * 4), 4));
    g.setIndex(new BufferAttribute(this.idx.slice(0, this.ni), 1));
    g.computeBoundingSphere();
    return g;
  }

  // ── Local-frame primitives (a building's frame: x frontage, y up, z depth) ──

  /** Map a local point through xf into out. */
  static apply(xf: Xf, x: number, y: number, z: number, out: Vec3): Vec3 {
    out.x = xf.o.x + xf.ex.x * x + xf.ey.x * y + xf.ez.x * z;
    out.y = xf.o.y + xf.ex.y * x + xf.ey.y * y + xf.ez.y * z;
    out.z = xf.o.z + xf.ex.z * x + xf.ey.z * y + xf.ez.z * z;
    return out;
  }

  /** Local direction → unit world direction (the frame is near-orthonormal). */
  static dir(xf: Xf, x: number, y: number, z: number, out: Vec3): Vec3 {
    // Normals: divide by the axis length squared (inverse-transpose of a near-orthogonal frame).
    const lx = xf.ex.x * xf.ex.x + xf.ex.y * xf.ex.y + xf.ex.z * xf.ex.z || 1;
    const lz = xf.ez.x * xf.ez.x + xf.ez.y * xf.ez.y + xf.ez.z * xf.ez.z || 1;
    const a = x / lx;
    const c = z / lz;
    out.x = xf.ex.x * a + xf.ey.x * y + xf.ez.x * c;
    out.y = xf.ex.y * a + xf.ey.y * y + xf.ez.y * c;
    out.z = xf.ex.z * a + xf.ey.z * y + xf.ez.z * c;
    const l = Math.hypot(out.x, out.y, out.z) || 1;
    out.x /= l;
    out.y /= l;
    out.z /= l;
    return out;
  }

  /**
   * A planar quad in local space: corners p (4 × xyz) in order round the quad, pattern coords uv
   * (4 × uv). `face`: a local direction the quad should face (its normal is flipped to agree, and
   * the winding with it); `exact`: use `face` itself as the normal (walls, so chamfers shade flat).
   */
  quadL(xf: Xf, p: number[], uv: number[], face?: [number, number, number], exact = false) {
    const a = _a, b = _b, c = _c, d = _d;
    Geo.apply(xf, p[0], p[1], p[2], a);
    Geo.apply(xf, p[3], p[4], p[5], b);
    Geo.apply(xf, p[6], p[7], p[8], c);
    Geo.apply(xf, p[9], p[10], p[11], d);
    const ux = c.x - a.x, uy = c.y - a.y, uz = c.z - a.z;
    const vx = d.x - b.x, vy = d.y - b.y, vz = d.z - b.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    let flip = false;
    if (face) {
      Geo.dir(xf, face[0], face[1], face[2], _n);
      flip = nx * _n.x + ny * _n.y + nz * _n.z < 0;
      if (exact) {
        nx = _n.x;
        ny = _n.y;
        nz = _n.z;
      } else if (flip) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    const i0 = this.vert(a.x, a.y, a.z, nx, ny, nz, uv[0], uv[1]);
    const i1 = this.vert(b.x, b.y, b.z, nx, ny, nz, uv[2], uv[3]);
    const i2 = this.vert(c.x, c.y, c.z, nx, ny, nz, uv[4], uv[5]);
    const i3 = this.vert(d.x, d.y, d.z, nx, ny, nz, uv[6], uv[7]);
    if (this.facades && this.kind === K.facade) {
      const u0 = Math.min(uv[0], uv[2], uv[4], uv[6]);
      const u1 = Math.max(uv[0], uv[2], uv[4], uv[6]);
      const v0 = Math.min(uv[1], uv[3], uv[5], uv[7]);
      const v1 = Math.max(uv[1], uv[3], uv[5], uv[7]);
      this.facades.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, uv[0], uv[1], uv[2], uv[3], uv[4], uv[5], nx, ny, nz, this.param, u0, u1, v0, v1, 0);
    }
    if (flip) this.quadIdx(i0, i3, i2, i1);
    else this.quadIdx(i0, i1, i2, i3);
  }

  /** A triangle in local space with a flat normal, flipped to agree with `face` if given. */
  triL(xf: Xf, p: number[], uv: number[], face?: [number, number, number]) {
    const a = _a, b = _b, c = _c;
    Geo.apply(xf, p[0], p[1], p[2], a);
    Geo.apply(xf, p[3], p[4], p[5], b);
    Geo.apply(xf, p[6], p[7], p[8], c);
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    let flip = false;
    if (face) {
      Geo.dir(xf, face[0], face[1], face[2], _n);
      flip = nx * _n.x + ny * _n.y + nz * _n.z < 0;
      if (flip) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    const i0 = this.vert(a.x, a.y, a.z, nx, ny, nz, uv[0], uv[1]);
    const i1 = this.vert(b.x, b.y, b.z, nx, ny, nz, uv[2], uv[3]);
    const i2 = this.vert(c.x, c.y, c.z, nx, ny, nz, uv[4], uv[5]);
    if (flip) this.tri(i0, i2, i1);
    else this.tri(i0, i1, i2);
  }

  /**
   * An axis-aligned box in local space, x ∈ [x0, x1], y ∈ [y0, y1], z ∈ [z0, z1], with its four
   * vertical edges chamfered by `ch` (0 = sharp). Side faces get facade coords from `side`
   * (called per face with the face's width and height; return [u0, u1, v0, v1] or null for plain).
   * `top` / `bottom`: emit those caps.
   */
  box(
    xf: Xf,
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
    ch = 0,
    opts: { top?: boolean; bottom?: boolean; side?: (face: number, width: number, height: number) => [number, number, number, number] | null; topUv?: number } = {},
  ) {
    const top = opts.top ?? true;
    const c = Math.min(ch, (x1 - x0) * 0.3, (z1 - z0) * 0.3);
    // Footprint outline, counter-clockwise seen from above in local (x, z) with z toward the back:
    // front edge (z0) runs +x, so outward normals point away from the centre.
    const ring: number[] =
      c > 0
        ? [x0 + c, z0, x1 - c, z0, x1, z0 + c, x1, z1 - c, x1 - c, z1, x0 + c, z1, x0, z1 - c, x0, z0 + c]
        : [x0, z0, x1, z0, x1, z1, x0, z1];
    const m = ring.length >> 1;
    const kind = this.kind;
    const param = this.param;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = ring[i * 2], az = ring[i * 2 + 1];
      const bx = ring[j * 2], bz = ring[j * 2 + 1];
      const w = Math.hypot(bx - ax, bz - az);
      if (w < 1e-4) continue;
      // Face index for the main faces: 0 front, 1 right, 2 back, 3 left (chamfers get -1).
      const face = c > 0 ? (i % 2 === 0 ? i / 2 : -1) : i;
      const uvs = face >= 0 && opts.side ? opts.side(face, w, y1 - y0) : null;
      if (!uvs) {
        this.kind = kind === K.facade ? K.plain : kind;
      }
      const u = uvs ?? [0, w, y0, y1];
      this.wall(xf, ax, az, bx, bz, y0, y1, u[0], u[1], u[2], u[3]);
      this.kind = kind;
      this.param = param;
    }
    if (top) this.capRing(xf, ring, y1, true, opts.topUv);
    if (opts.bottom) this.capRing(xf, ring, y0, false);
  }

  /**
   * One vertical wall along edge a→b of a footprint ring that runs clockwise seen from above (the
   * convention for every ring here): front-facing from outside, outward normal (bz−az, −(bx−ax)).
   */
  wall(xf: Xf, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, u0: number, u1: number, v0: number, v1: number) {
    const w = Math.hypot(bx - ax, bz - az) || 1;
    this.quadL(xf, [bx, y0, bz, ax, y0, az, ax, y1, az, bx, y1, bz], [u1, v0, u0, v0, u0, v1, u1, v1], [(bz - az) / w, 0, -(bx - ax) / w], true);
  }

  /** A convex polygon cap (local x, z ring, clockwise seen from above) at height y, facing up or down. */
  capRing(xf: Xf, ring: number[], y: number, up: boolean, uvScale = 1) {
    const m = ring.length >> 1;
    const first = this.n;
    Geo.dir(xf, 0, up ? 1 : -1, 0, _n);
    for (let i = 0; i < m; i++) {
      Geo.apply(xf, ring[i * 2], y, ring[i * 2 + 1], _a);
      this.vert(_a.x, _a.y, _a.z, _n.x, _n.y, _n.z, ring[i * 2] * uvScale, ring[i * 2 + 1] * uvScale);
    }
    for (let i = 1; i < m - 1; i++) {
      if (up) this.tri(first, first + i + 1, first + i);
      else this.tri(first, first + i, first + i + 1);
    }
  }

  /** A vertical prism with an n-gon section (cylinders, posts, tanks). */
  cylinder(xf: Xf, cx: number, cz: number, r: number, y0: number, y1: number, n = 8, cap = true) {
    const ring: number[] = [];
    // Increasing plan angle (x right, z toward the back) runs clockwise seen from above.
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / n;
      ring.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
    const w = 2 * r * Math.sin(Math.PI / n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.wall(xf, ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1], y0, y1, i * w, (i + 1) * w, y0, y1);
    }
    if (cap) this.capRing(xf, ring, y1, true);
  }
}

const _a = v3();
const _b = v3();
const _c = v3();
const _d = v3();
const _n = v3();

/** A ground vertex at plan (x, z), height h, normal straight up: `toSphere` per vertex. */
export function groundVert(g: Geo, x: number, z: number, h: number, u: number, v: number): number {
  toSphere(x, z, h, _a);
  const l = Math.hypot(_a.x, _a.y, _a.z) || 1;
  return g.vert(_a.x, _a.y, _a.z, _a.x / l, _a.y / l, _a.z / l, u, v);
}
