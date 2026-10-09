// Toy vehicle meshes (B1), generated at boot: soft rounded boxes and chunky wheels, one merged
// geometry per kind, plus a ~150-triangle far LOD per kind (plain slabs, octagonal wheels) that
// takes over above the rooftops. Local frame: +z forward, +y up, +x LEFT, origin on the ground
// midway between the axles. Extra vertex attributes drive the shared vehicle patch (index.ts):
//   aTint  1 where the per-instance body colour applies (paint), 0 for tyres, chrome, lamps, −1 glass
//          (painted-on highlight streaks), 2 a box truck's cargo box (its livery motif, by aVar);
//   aHub   wheel hub centre (xyz) and w = 0 body · 1 rear wheel · 2 front wheel (spins and steers) ·
//          3 + v a part only variant v shows (1 taxi sign, 2 police light bar, 3 ice-cream cone);
//   aLamp  x = headlight / lit sign, y = tail light, z = ±1 indicator on the left (+) / right (−)
//          side, ±3 police light (red left, blue right).

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { PALETTE } from '../render/palette';
import type { VehicleKind } from './sim';

type RGB = Color;
interface BoxOpt {
  tint?: number;
  lamp?: readonly [number, number, number];
  /** Top narrower than the bottom by this fraction (x only). */
  taper?: number;
  /** Top front / back edge pulled in by this much (m): a raked windscreen / rear window. */
  slantF?: number;
  slantB?: number;
  /** Rotation about the box centre: x (pitch, + leans the top back) then z (roll, + leans the top to −x). */
  rx?: number;
  rz?: number;
  /** Build only this face (axis · 2 + (negative side ? 1 : 0)): a lit sign's front. */
  only?: number;
}
/** A rounded body box the wheel arches hug: half-width, centre height, half-height, edge radius. */
type Body = readonly [number, number, number, number];

const hex = (h: string) => new Color(h);
/** (Exported for transit/'s ferry: glass is recognised by this colour, aTint −1.) */
export const GLASS = hex('#2f4170');
const TYRE = hex('#2a2438');
const ARCH = hex('#3a3350');
const TRIM = hex('#4b4f66');
const CHROME = hex('#c4c7d6');
const HUB = [hex('#eceaf3'), hex('#a7acc4')];
const HEAD = hex('#fff4cc');
const TAIL = hex('#e8384a');
const AMBER = hex('#ffa53d');
const CREAM = PALETTE.walls[0];
const WHITE = hex('#f6f3ec');
const PAINT = hex('#ffffff');
const NAVY = hex('#2b3a78');
const BLUE = hex('#3d6bff');
const WAFFLE = hex('#e3a857');
const SCOOP = hex('#ff9ec4');
const NONE = [0, 0, 0] as const;
const T = { tint: 1 };

/** v2 (V1): exported for transit/ (the ferry, the bus's open doors): the same attributes, so the same patch. */
export class VehicleBuilder {
  /** The far LOD: every box plain (flat faces), parts under 0.45 m left out, octagonal wheels, no arches. */
  constructor(private lo: boolean) {}
  private P: number[] = [];
  private C: number[] = [];
  private T: number[] = [];
  private H: number[] = [];
  private L: number[] = [];
  private I: number[] = [];
  private hub: [number, number, number, number] = [0, 0, 0, 0];

  private vert(x: number, y: number, z: number, c: RGB, tint: number, lamp: readonly number[]): number {
    this.P.push(x, y, z);
    this.C.push(c.r, c.g, c.b);
    this.T.push(c === GLASS ? -1 : tint);
    this.H.push(...this.hub);
    this.L.push(lamp[0], lamp[1], lamp[2]);
    return this.P.length / 3 - 1;
  }
  private quad(a: number, b: number, c: number, d: number, flip: boolean) {
    if (flip) this.I.push(a, c, b, a, d, c);
    else this.I.push(a, b, c, a, c, d);
  }

  /** Parts only variant v shows (collapsed for every other instance in the vertex patch). */
  variant(v: number, fn: (b: this) => void): this {
    this.hub = [0, 0, 0, 3 + v];
    fn(this);
    this.hub = [0, 0, 0, 0];
    return this;
  }

  /** A box with rounded edges (radius r; 0 = a plain box with flat faces) centred at (cx, cy, cz). */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, r: number, c: RGB, o: BoxOpt = {}): this {
    if (this.lo) {
      if (Math.max(w, h, d) < 0.45) return this;
      r = 0;
    }
    const a = [w / 2, h / 2, d / 2];
    r = Math.min(r, a[0] * 0.95, a[1] * 0.95, a[2] * 0.95);
    // small radii (lamps, glass) get a plain chamfer: a quarter of the triangles, same read
    const vals = (e: number) => {
      const q = e - r;
      return r <= 0 ? [-e, e] : r < 0.06 ? [-e, -q, q, e] : [-e, -q - r * 0.55, -q, q, q + r * 0.55, e];
    };
    const tint = o.tint ?? 0;
    const lamp = o.lamp ?? NONE;
    const weld = new Map<string, number>();
    const p = [0, 0, 0];
    const inner = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const u = (k + 1) % 3;
      const v = (k + 2) % 3;
      for (const sg of [1, -1]) {
        if (o.only !== undefined && o.only !== k * 2 + (sg < 0 ? 1 : 0)) continue;
        const vu = vals(a[u]);
        const vv = vals(a[v]);
        const ids: number[] = [];
        for (let j = 0; j < vv.length; j++) {
          for (let i = 0; i < vu.length; i++) {
            p[k] = sg * a[k];
            p[u] = vu[i];
            p[v] = vv[j];
            // round: project onto the radius-r shell around the inner box
            for (let m = 0; m < 3; m++) inner[m] = Math.max(-(a[m] - r), Math.min(a[m] - r, p[m]));
            const dx = p[0] - inner[0];
            const dy = p[1] - inner[1];
            const dz = p[2] - inner[2];
            const n = Math.hypot(dx, dy, dz) || 1;
            let x = inner[0] + (dx / n) * r;
            const y = inner[1] + (dy / n) * r;
            let z = inner[2] + (dz / n) * r;
            const key = r > 0 ? `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}` : `${k}${sg}${i}${j}`;
            let id = weld.get(key);
            if (id === undefined) {
              const yn = (y + a[1]) / (2 * a[1]);
              x *= 1 - (o.taper ?? 0) * yn;
              z -= (z > 0 ? (o.slantF ?? 0) : (o.slantB ?? 0)) * yn * (z / a[2]);
              let yy = y;
              if (o.rx) {
                const c1 = Math.cos(o.rx);
                const s1 = Math.sin(o.rx);
                const z1 = z * c1 - yy * s1;
                yy = z * s1 + yy * c1;
                z = z1;
              }
              if (o.rz) {
                const c2 = Math.cos(o.rz);
                const s2 = Math.sin(o.rz);
                const x2 = x * c2 - yy * s2;
                yy = x * s2 + yy * c2;
                x = x2;
              }
              id = this.vert(cx + x, cy + yy, cz + z, c, tint, lamp);
              weld.set(key, id);
            }
            ids.push(id);
          }
        }
        const nu = vu.length;
        for (let j = 0; j < vv.length - 1; j++)
          for (let i = 0; i < nu - 1; i++) this.quad(ids[j * nu + i], ids[j * nu + i + 1], ids[(j + 1) * nu + i + 1], ids[(j + 1) * nu + i], sg < 0);
      }
    }
    return this;
  }

  /** The painted body slab; returns the builder with `body` remembered for the wheel arches. */
  body(w: number, cy: number, h: number, d: number, r: number): this {
    this.arches = [w / 2, cy, h / 2, r];
    return this.box(0, cy, 0, w, h, d, r, PAINT, T);
  }
  private arches: Body = [0, 0, 0, 0];

  /**
   * A surface of revolution about the vertical axis at (cx, cz): profile rings [radius, y] from the
   * bottom up, K sides (cones, scoops).
   */
  lathe(cx: number, cz: number, prof: readonly number[], K: number, c: RGB): this {
    if (this.lo) K = 6;
    const n = prof.length / 2;
    const base = this.P.length / 3;
    for (let j = 0; j < n; j++)
      for (let k = 0; k < K; k++) {
        const t = (k / K) * Math.PI * 2;
        this.vert(cx + Math.cos(t) * prof[j * 2], prof[j * 2 + 1], cz + Math.sin(t) * prof[j * 2], c, 0, NONE);
      }
    for (let j = 0; j < n - 1; j++)
      for (let k = 0; k < K; k++) {
        const a = base + j * K + k;
        const b = base + j * K + ((k + 1) % K);
        this.quad(a, a + K, b + K, b, false);
      }
    return this;
  }

  /**
   * A wheel on the axle along x: chamfered tyre, two-tone hub (so the spin reads), painted cap; with
   * `lo` a plain K-sided prism. Near wheels get a dark arch band hugging the body side above them.
   */
  wheel(cx: number, cy: number, cz: number, R: number, W: number, front: boolean, body: Body): this {
    const lo = this.lo;
    const K = lo ? 8 : 12;
    this.hub = [cx, cy, cz, front ? 2 : 1];
    const out = cx > 0 ? 1 : -1; // the outer face looks away from the body
    const rings = lo
      ? [
          [-W / 2, R],
          [W / 2, R],
        ]
      : [
          [-W / 2, R * 0.84],
          [-W / 2 + W * 0.22, R],
          [W / 2 - W * 0.22, R],
          [W / 2, R * 0.84],
        ];
    const base = this.P.length / 3;
    for (const [x, rr] of rings)
      for (let k = 0; k < K; k++) {
        const t = (k / K) * Math.PI * 2;
        this.vert(cx + x * out, cy + Math.cos(t) * rr, cz + Math.sin(t) * rr, TYRE, 0, NONE);
      }
    for (let ring = 0; ring < rings.length - 1; ring++)
      for (let k = 0; k < K; k++) {
        const a = base + ring * K + k;
        const b = base + ring * K + ((k + 1) % K);
        this.quad(a, b, b + K, a + K, out < 0);
      }
    const xo = cx + (W / 2) * out;
    if (lo) {
      // outer cap: a fan over the last ring
      const o = base + K;
      for (let k = 1; k < K - 1; k++) out > 0 ? this.I.push(o, o + k, o + k + 1) : this.I.push(o, o + k + 1, o + k);
    } else {
      // outer face: tyre annulus, then hub sectors, then the painted cap (each flat, own vertices)
      const fan = (r0: number, r1: number, x: number, col: (k: number) => RGB, tint: number) => {
        for (let k = 0; k < K; k++) {
          const t0 = (k / K) * Math.PI * 2;
          const t1 = ((k + 1) / K) * Math.PI * 2;
          const cc = col(k);
          const i0 = this.vert(x, cy + Math.cos(t0) * r1, cz + Math.sin(t0) * r1, cc, tint, NONE);
          const i1 = this.vert(x, cy + Math.cos(t1) * r1, cz + Math.sin(t1) * r1, cc, tint, NONE);
          const i2 = this.vert(x, cy + Math.cos(t1) * r0, cz + Math.sin(t1) * r0, cc, tint, NONE);
          const i3 = this.vert(x, cy + Math.cos(t0) * r0, cz + Math.sin(t0) * r0, cc, tint, NONE);
          this.quad(i0, i1, i2, i3, out < 0);
        }
      };
      fan(R * 0.6, R * 0.84, xo, () => TYRE, 0);
      fan(R * 0.24, R * 0.6, xo + 0.004 * out, (k) => HUB[(k >> 1) & 1], 0);
      fan(0.001, R * 0.24, xo + 0.012 * out, () => PAINT, 1);
    }
    this.hub = [0, 0, 0, 0];
    if (!lo) {
      // the arch: a dark band over the wheel, laid onto the rounded body side (clamped to its height)
      const [hw, by, hh, br] = body;
      const e = hh - br;
      const A = 12;
      const b0 = this.P.length / 3;
      for (let k = 0; k <= A; k++) {
        const t = -1.75 + (3.5 * k) / A;
        for (const rr of [R * 1.05, R * 1.19]) {
          const y = Math.max(by - hh + 0.02, Math.min(by + hh - 0.03, cy + Math.cos(t) * rr));
          const dy = Math.abs(y - by) - e;
          const x = hw - br + (dy > 0 ? Math.sqrt(Math.max(0, br * br - dy * dy)) : br) + 0.022;
          this.vert(x * out, y, cz + Math.sin(t) * rr, ARCH, 0, NONE);
        }
      }
      for (let k = 0; k < A; k++) this.quad(b0 + k * 2, b0 + k * 2 + 2, b0 + k * 2 + 3, b0 + k * 2 + 1, out > 0);
    }
    return this;
  }

  /** Four wheels for a body of track half-width tx; arches hug `front` / `rear` bodies (default: the body slab). */
  wheels(k: VehicleKind, tx: number, W: number, front = this.arches, rear = this.arches): this {
    const az = k.wheelbase / 2;
    for (const sx of [1, -1]) {
      this.wheel(sx * tx, k.wheelR, az, k.wheelR, W, true, front);
      this.wheel(sx * tx, k.wheelR, -az, k.wheelR, W, false, rear);
    }
    return this;
  }

  /** Head, tail and indicator lamps on a front face at z = zf and a back face at z = zb. */
  lamps(hx: number, hy: number, zf: number, tx: number, ty: number, zb: number, ix: number, iy: number, hw = 0.3, hh = 0.17): this {
    for (const sx of [1, -1]) {
      this.box(sx * hx, hy, zf, hw, hh, 0.12, 0.05, HEAD, { lamp: [1, 0, 0] });
      this.box(sx * tx, ty, zb, hw * 0.9, hh * 0.85, 0.12, 0.05, TAIL, { lamp: [0, 1, 0] });
      this.box(sx * ix, iy, zf - 0.02, 0.14, 0.1, 0.1, 0, AMBER, { lamp: [0, 0, sx] });
      this.box(sx * ix, iy, zb + 0.02, 0.14, 0.1, 0.1, 0, AMBER, { lamp: [0, 0, sx] });
    }
    return this;
  }

  /** Little body-coloured door mirrors on stalks, sticking out at (±x, y, z). */
  mirrors(x: number, y: number, z: number): this {
    for (const sx of [1, -1]) {
      this.box(sx * (x + 0.05), y, z, 0.1, 0.03, 0.05, 0, TRIM);
      this.box(sx * (x + 0.13), y + 0.04, z - 0.02, 0.12, 0.1, 0.07, 0.03, PAINT, T);
    }
    return this;
  }

  /**
   * A painted cabin shell with glass let into it: raked windscreen and rear window, side panes
   * (split by a B-pillar at z = zc + bPillar when given) following the rake, so the pillars and roof
   * stay body colour.
   */
  glasshouse(y0: number, y1: number, w: number, d: number, zc: number, r: number, taper: number, slantF: number, slantB: number, bPillar?: number): this {
    const h = y1 - y0;
    const ym = (y0 + y1) / 2;
    this.box(0, ym, zc, w, h, d, r, PAINT, { tint: 1, taper, slantF, slantB });
    const ins = r * 0.45 + 0.05;
    const wm = w * (1 - taper / 2);
    const lip = 0.012;
    const aF = Math.atan2(slantF, h);
    const aB = Math.atan2(slantB, h);
    this.box(0, ym + Math.sin(aF) * lip, zc + d / 2 - slantF / 2 + Math.cos(aF) * lip, wm - 2 * ins, Math.hypot(slantF, h) - 2 * ins, 0.05, 0, GLASS, { rx: aF });
    this.box(0, ym + Math.sin(aB) * lip, zc - d / 2 + slantB / 2 - Math.cos(aB) * lip, wm - 2 * ins, Math.hypot(slantB, h) - 2 * ins, 0.05, 0, GLASS, { rx: -aB });
    const aS = Math.atan2((w / 2) * taper, h);
    const ph = h - 2 * ins;
    const sF = (slantF * ph) / h;
    const sB = (slantB * ph) / h;
    const zFb = zc + d / 2 - slantF / 2 - ins + sF / 2; // front pane: bottom-front corner
    const zRb = zc - d / 2 + slantB / 2 + ins - sB / 2; // rear pane: bottom-rear corner
    for (const sx of [1, -1]) {
      const x = sx * (wm / 2 + Math.cos(aS) * lip);
      const pane = (z0: number, z1: number, o: BoxOpt) => this.box(x, ym, (z0 + z1) / 2, 0.05, ph, z1 - z0, 0, GLASS, { rz: sx * aS, ...o });
      if (bPillar === undefined) pane(zRb, zFb, { slantF: sF, slantB: sB });
      else {
        pane(zc + bPillar + 0.065, zFb, { slantF: sF });
        pane(zRb, zc + bPillar - 0.065, { slantB: sB });
      }
    }
    return this;
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.P, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.C, 3));
    g.setAttribute('aTint', new Float32BufferAttribute(this.T, 1));
    g.setAttribute('aHub', new Float32BufferAttribute(this.H, 4));
    g.setAttribute('aLamp', new Float32BufferAttribute(this.L, 3));
    g.setIndex(this.I);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Taxi roof sign (variant 1) and police light bar (variant 2) on a roof at height y, centre z. */
function roofKit(b: VehicleBuilder, y: number, z: number) {
  b.variant(1, (v) => v.box(0, y + 0.1, z, 0.62, 0.2, 0.3, 0.05, AMBER, { lamp: [0.8, 0, 0] }));
  b.variant(2, (v) => {
    v.box(0, y + 0.03, z, 1.0, 0.06, 0.26, 0, TRIM);
    for (const sx of [1, -1]) v.box(sx * 0.25, y + 0.11, z, 0.46, 0.12, 0.24, 0.05, sx > 0 ? TAIL : BLUE, { lamp: [0, 0, 3 * sx] });
  });
}

/** Build the geometry of one vehicle kind (KINDS order: car, compact, truck, bus); `lo`: the far LOD. */
export function buildVehicle(k: VehicleKind, lo = false): BufferGeometry {
  const b = new VehicleBuilder(lo);
  const L = k.len / 2;
  switch (k.name) {
    case 'car':
      b.body(1.72, 0.72, 0.62, k.len, 0.22)
        .glasshouse(0.98, 1.56, 1.52, 2.0, -0.24, 0.27, 0.2, 0.55, 0.3, -0.12)
        .box(0, 0.66, L, 0.64, 0.13, 0.08, 0.03, TRIM) // grille
        .box(0, 0.47, L - 0.07, 1.68, 0.18, 0.22, 0.05, CHROME)
        .box(0, 0.47, -L + 0.07, 1.68, 0.18, 0.22, 0.05, CHROME)
        .lamps(0.55, 0.8, L, 0.6, 0.84, -L, 0.76, 0.62, 0.28, 0.2)
        .mirrors(0.74, 1.06, 0.62)
        .variant(2, (v) => v.box(0, 0.72, 0.05, 1.75, 0.13, 3.3, 0.05, NAVY)) // police: the door stripe
        .wheels(k, 0.8, 0.32);
      roofKit(b, 1.54, -0.3);
      break;
    case 'compact':
      b.body(1.58, 0.7, 0.6, k.len, 0.28)
        .glasshouse(0.95, 1.63, 1.44, 1.84, -0.1, 0.3, 0.24, 0.46, 0.2)
        .box(0, 0.64, L, 0.42, 0.1, 0.08, 0.03, TRIM)
        .box(0, 0.46, L - 0.06, 1.54, 0.18, 0.2, 0.05, CHROME)
        .box(0, 0.46, -L + 0.06, 1.54, 0.18, 0.2, 0.05, CHROME)
        .lamps(0.5, 0.78, L, 0.52, 0.82, -L, 0.7, 0.61, 0.27, 0.24)
        .mirrors(0.68, 1.03, 0.66)
        .wheels(k, 0.73, 0.28)
        // ice-cream van: a waffle cone and a strawberry scoop on the roof
        .variant(3, (v) => {
          const s: number[] = [];
          for (let j = 0; j <= 6; j++) s.push(Math.sin((j / 6) * Math.PI) * 0.25 + 0.001, 2.18 - Math.cos((j / 6) * Math.PI) * 0.25);
          v.lathe(0, -0.15, [0.03, 1.6, 0.2, 2.02], 10, WAFFLE).lathe(0, -0.15, s, 10, SCOOP);
        });
      break;
    case 'truck':
      b.box(0, 0.87, L - 0.79, 1.98, 0.84, 1.58, 0.22, PAINT, T) // cab
        .glasshouse(1.23, 1.93, 1.88, 1.36, L - 0.85, 0.16, 0.06, 0.3, 0.02)
        .box(0, 1.61, -0.75, 2.12, 1.96, 3.72, 0.13, CREAM, { tint: 2 }) // cargo box (aTint 2: the livery, index.ts)
        .box(0, 0.57, -0.6, 1.5, 0.3, 4.2, 0.08, TRIM) // chassis
        .box(0, 0.65, L, 0.9, 0.16, 0.08, 0.03, TRIM)
        .box(0, 0.49, L - 0.08, 2.0, 0.22, 0.24, 0.05, CHROME)
        .lamps(0.64, 0.85, L, 0.82, 0.91, -L + 0.08, 0.86, 0.65, 0.3, 0.2)
        .mirrors(0.94, 1.36, L - 0.3)
        .wheels(k, 0.84, 0.36, [0.99, 0.87, 0.42, 0.22], [1.06, 1.61, 0.98, 0.13]);
      break;
    default:
      // bus
      b.body(2.36, 1.52, 2.2, k.len, 0.32)
        .box(0, 1.24, 0, 2.39, 0.16, k.len - 0.4, 0.05, WHITE) // skirt stripe
        .box(0, 1.76, L, 2.0, 1.1, 0.07, 0, GLASS) // windscreen
        .box(0, 1.96, -L, 1.9, 0.62, 0.07, 0, GLASS) // rear window
        .box(0, 2.45, L, 1.4, 0.22, 0.09, 0.04, TRIM) // destination sign: a dark case …
        .box(0, 2.45, L + 0.047, 1.3, 0.15, 0.01, 0, HEAD, { lamp: [0.6, 0, 0], only: 4 }) // … lit only on its face …
        .box(0, 2.69, -0.2, 2.1, 0.14, k.len - 1, 0.07, PAINT, T) // roof (body colour: buses read by colour from above)
        .box(0, 2.82, -1.3, 1.3, 0.2, 1.7, 0.08, CHROME) // roof unit
        .box(0, 0.57, L - 0.08, 2.4, 0.26, 0.24, 0.05, TRIM)
        .box(0, 0.57, -L + 0.08, 2.4, 0.26, 0.24, 0.05, TRIM)
        .lamps(0.82, 0.91, L, 0.9, 1.01, -L, 1.0, 0.69, 0.32, 0.22)
        .mirrors(1.18, 2.1, L - 0.15)
        .wheels(k, 0.98, 0.36);
      for (let d = 0; d < 4; d++) b.box(-0.42 + d * 0.22 + (d > 1 ? 0.2 : 0), 2.45, L + 0.055, 0.12, 0.1, 0.01, 0, TRIM, { only: 4 }); // … with a route number
      for (const sx of [1, -1]) {
        const x = sx * 1.185;
        for (let p = 0; p < 5; p++) b.box(x, 1.88, -3.4 + 0.49 + p * 1.18, 0.05, 0.84, 0.98, 0, GLASS);
        if (sx > 0) b.box(x, 1.88, 3.05, 0.05, 0.84, 0.95, 0, GLASS); // driver
        else for (const z of [2.75, 3.25]) b.box(x, 1.5, z, 0.05, 1.56, 0.44, 0, GLASS); // door leaves
      }
  }
  return b.geometry();
}

/** Body colours: the city palette (walls, roofs, the amber accent), a touch more saturated. */
export function bodyColours(kind: string): Color[] {
  const W = PALETTE.walls;
  const R = PALETTE.roofs;
  const base =
    kind === 'bus' ? [R[0], W[3], W[2]] : kind === 'truck' ? [R[0], W[2], W[3], R[2], W[5]] : [R[0], W[3], W[2], W[6], W[4], W[5], W[0], R[2], PALETTE.accent, R[1], hex('#f6f3ec')];
  return base.map((c) => {
    const o = c.clone();
    const hsl = { h: 0, s: 0, l: 0 };
    o.getHSL(hsl);
    return o.setHSL(hsl.h, Math.min(1, hsl.s * 1.12), hsl.l);
  });
}

/** Variant body colours: taxi yellow, police white, ice-cream mint. */
export const VARIANT_COLOURS = [null, hex('#ffc53d'), hex('#f4f4f8'), hex('#9fe3c9')];
