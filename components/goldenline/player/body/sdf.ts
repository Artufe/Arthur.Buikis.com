// Boot-time SDF modelling for the first-person body: parts (tapered capsules with elliptical
// sections, ellipsoids) blended with smooth unions, meshed with surface nets, vertices projected
// onto the zero set and shaded with the field gradient, so there is no faceting at any distance.
// Skin weights come from per-part distances, so blends follow the anatomy.

export interface Part {
  bone: number;
  /** 0 = tapered capsule a→b, 1 = ellipsoid at a with radii (rx, ry, rz) in the frame. */
  kind: 0 | 1;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  r1: number;
  r2: number;
  /** Section scale along the frame's "up" (dorsal) and side axes. */
  sy: number;
  sz: number;
  /** Frame "up" hint (dorsal). */
  ux: number;
  uy: number;
  uz: number;
  /** Smooth blend radius with what came before. */
  k: number;
  /** 0 = union, 1 = subtract. */
  op: 0 | 1;
  /** Material tag: 0 skin, 1 nail, 2 fabric. */
  mat: number;
  /** Skin weight falloff (m). */
  sigma: number;
  // Derived frame (filled by finalizePart).
  len: number;
  ex: Float64Array; // axis
  ey: Float64Array; // up
  ez: Float64Array; // side
  min: Float64Array;
  max: Float64Array;
}

export interface PartSpec {
  bone: number;
  kind?: 0 | 1;
  a: readonly number[];
  b?: readonly number[];
  r1: number;
  r2?: number;
  /** Ellipsoid radii (kind 1). */
  radii?: readonly number[];
  sy?: number;
  sz?: number;
  up?: readonly number[];
  k?: number;
  op?: 0 | 1;
  mat?: number;
  sigma?: number;
}

export function makePart(s: PartSpec): Part {
  const kind = s.kind ?? 0;
  const b = s.b ?? s.a;
  const p: Part = {
    bone: s.bone,
    kind,
    ax: s.a[0],
    ay: s.a[1],
    az: s.a[2],
    bx: b[0],
    by: b[1],
    bz: b[2],
    r1: kind === 1 ? 1 : s.r1,
    r2: kind === 1 ? 1 : (s.r2 ?? s.r1),
    sy: kind === 1 ? (s.radii?.[1] ?? s.r1) : (s.sy ?? 1),
    sz: kind === 1 ? (s.radii?.[2] ?? s.r1) : (s.sz ?? 1),
    ux: s.up?.[0] ?? 0,
    uy: s.up?.[1] ?? 1,
    uz: s.up?.[2] ?? 0,
    k: s.k ?? 0,
    op: s.op ?? 0,
    mat: s.mat ?? 0,
    sigma: s.sigma ?? 0.01,
    len: kind === 1 ? (s.radii?.[0] ?? s.r1) : 0,
    ex: new Float64Array(3),
    ey: new Float64Array(3),
    ez: new Float64Array(3),
    min: new Float64Array(3),
    max: new Float64Array(3),
  };
  finalizePart(p, s);
  return p;
}

function finalizePart(p: Part, s: PartSpec) {
  let ex = p.bx - p.ax;
  let ey = p.by - p.ay;
  let ez = p.bz - p.az;
  let l = Math.hypot(ex, ey, ez);
  if (p.kind === 1 || l < 1e-9) {
    // Ellipsoid frame: axis from `b` direction if given, else +X.
    if (p.kind === 1 && s.b) {
      l = Math.hypot(ex, ey, ez);
    }
    if (l < 1e-9) {
      ex = 1;
      ey = 0;
      ez = 0;
      l = 1;
    }
  }
  ex /= l;
  ey /= l;
  ez /= l;
  if (p.kind === 0) p.len = Math.hypot(p.bx - p.ax, p.by - p.ay, p.bz - p.az);
  // up = hint orthogonalised against the axis
  let ux = p.ux - ex * (p.ux * ex + p.uy * ey + p.uz * ez);
  let uy = p.uy - ey * (p.ux * ex + p.uy * ey + p.uz * ez);
  let uz = p.uz - ez * (p.ux * ex + p.uy * ey + p.uz * ez);
  let ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-6) {
    ux = 0;
    uy = 0;
    uz = 1;
    ul = 1;
  }
  ux /= ul;
  uy /= ul;
  uz /= ul;
  p.ex[0] = ex;
  p.ex[1] = ey;
  p.ex[2] = ez;
  p.ey[0] = ux;
  p.ey[1] = uy;
  p.ey[2] = uz;
  p.ez[0] = ey * uz - ez * uy;
  p.ez[1] = ez * ux - ex * uz;
  p.ez[2] = ex * uy - ey * ux;
  const reach = p.kind === 1 ? Math.max(p.len, p.sy, p.sz) : Math.max(p.r1, p.r2) * Math.max(1, p.sy, p.sz);
  const pad = reach + p.k + 0.004;
  // Ellipsoids use `b` only as an axis direction; their extent is around `a`.
  const bx = p.kind === 1 ? p.ax : p.bx;
  const by = p.kind === 1 ? p.ay : p.by;
  const bz = p.kind === 1 ? p.az : p.bz;
  p.min[0] = Math.min(p.ax, bx) - pad;
  p.min[1] = Math.min(p.ay, by) - pad;
  p.min[2] = Math.min(p.az, bz) - pad;
  p.max[0] = Math.max(p.ax, bx) + pad;
  p.max[1] = Math.max(p.ay, by) + pad;
  p.max[2] = Math.max(p.az, bz) + pad;
}

/** Signed distance to one part. */
export function partDist(p: Part, x: number, y: number, z: number) {
  const dx = x - p.ax;
  const dy = y - p.ay;
  const dz = z - p.az;
  const s = dx * p.ex[0] + dy * p.ex[1] + dz * p.ex[2];
  const u = dx * p.ey[0] + dy * p.ey[1] + dz * p.ey[2];
  const v = dx * p.ez[0] + dy * p.ez[1] + dz * p.ez[2];
  if (p.kind === 1) {
    // Ellipsoid (iq's bound): radii len (axis), sy (up), sz (side).
    const k0 = Math.hypot(s / p.len, u / p.sy, v / p.sz);
    const k1 = Math.hypot(s / (p.len * p.len), u / (p.sy * p.sy), v / (p.sz * p.sz));
    return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(p.len, p.sy, p.sz);
  }
  // Tapered capsule with an elliptical section: scale the section, then a round cone.
  const scale = Math.min(p.sy, p.sz);
  const uu = u / p.sy;
  const vv = v / p.sz;
  return roundCone(s, Math.hypot(uu, vv), p.len, p.r1, p.r2) * scale;
}

/** 2D round cone: axial coordinate s, radial q, from 0 to h with radii r1 → r2 (iq). */
function roundCone(s: number, q: number, h: number, r1: number, r2: number) {
  if (h < 1e-9) return Math.hypot(s, q) - r1;
  const b = (r1 - r2) / h;
  const a = Math.sqrt(Math.max(0, 1 - b * b));
  const k = q * -b + s * a; // dot((q, s), (-b, a))
  if (k < 0) return Math.hypot(q, s) - r1;
  if (k > a * h) return Math.hypot(q, s - h) - r2;
  return q * a + s * b - r1;
}

function smin(a: number, b: number, k: number) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function smax(a: number, b: number, k: number) {
  return -smin(-a, -b, k);
}

export function fieldAt(parts: readonly Part[], x: number, y: number, z: number) {
  let f = 1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (x < p.min[0] || y < p.min[1] || z < p.min[2] || x > p.max[0] || y > p.max[1] || z > p.max[2]) continue;
    const d = partDist(p, x, y, z);
    f = p.op === 0 ? smin(f, d, p.k) : smax(f, -d, p.k);
  }
  return f;
}

/**
 * The blended field with a coarse acceleration grid: each coarse cell lists only the parts
 * that can influence the field near the surface there (distance - cell radius < blend + margin).
 * Culled parts can't change the sign, so the zero set is exact.
 */
export class Field {
  readonly parts: readonly Part[];
  private readonly min: number[];
  private readonly cell: number;
  private readonly n: [number, number, number];
  private readonly start: Int32Array;
  private readonly list: Int32Array;
  /** Per coarse cell: 1 = no part nearby (outside), -1 = deep inside, 0 = near the surface. */
  private readonly state: Int8Array;

  constructor(parts: readonly Part[], min: readonly number[], max: readonly number[], cell = 0.008) {
    this.parts = parts;
    this.cell = cell;
    this.min = [min[0] - cell, min[1] - cell, min[2] - cell];
    const n: [number, number, number] = [0, 0, 0];
    for (let a = 0; a < 3; a++) n[a] = Math.ceil((max[a] - min[a]) / cell) + 3;
    this.n = n;
    const total = n[0] * n[1] * n[2];
    this.start = new Int32Array(total + 1);
    this.state = new Int8Array(total);
    const tmp: number[] = [];
    const R = cell * 0.8660254 + 0.0005;
    for (let k = 0; k < n[2]; k++)
      for (let j = 0; j < n[1]; j++)
        for (let i = 0; i < n[0]; i++) {
          const c = (k * n[1] + j) * n[0] + i;
          this.start[c] = tmp.length;
          const x = this.min[0] + (i + 0.5) * cell;
          const y = this.min[1] + (j + 0.5) * cell;
          const z = this.min[2] + (k + 0.5) * cell;
          let f = 1;
          for (let pi = 0; pi < parts.length; pi++) {
            const p = parts[pi];
            if (x + R < p.min[0] || y + R < p.min[1] || z + R < p.min[2] || x - R > p.max[0] || y - R > p.max[1] || z - R > p.max[2]) continue;
            const d = partDist(p, x, y, z);
            if (d - R < p.k * 1.5 + 0.03) {
              tmp.push(pi);
              f = p.op === 0 ? smin(f, d, p.k) : smax(f, -d, p.k);
            }
          }
          // The blend moves the surface by at most k/4; stay clear of that and the cell.
          this.state[c] = tmp.length === this.start[c] ? 1 : f < -(R + 0.004) ? -1 : 0;
        }
    this.start[total] = tmp.length;
    this.list = new Int32Array(tmp);
  }

  /** Coarse classification of a point: 1 outside, -1 deep inside, 0 near the surface. */
  classify(x: number, y: number, z: number) {
    const i = Math.floor((x - this.min[0]) / this.cell);
    const j = Math.floor((y - this.min[1]) / this.cell);
    const k = Math.floor((z - this.min[2]) / this.cell);
    const n = this.n;
    if (i < 0 || j < 0 || k < 0 || i >= n[0] || j >= n[1] || k >= n[2]) return 0;
    return this.state[(k * n[1] + j) * n[0] + i];
  }

  eval(x: number, y: number, z: number) {
    const i = Math.floor((x - this.min[0]) / this.cell);
    const j = Math.floor((y - this.min[1]) / this.cell);
    const k = Math.floor((z - this.min[2]) / this.cell);
    const n = this.n;
    if (i < 0 || j < 0 || k < 0 || i >= n[0] || j >= n[1] || k >= n[2]) return fieldAt(this.parts, x, y, z);
    const c = (k * n[1] + j) * n[0] + i;
    const a = this.start[c];
    const b = this.start[c + 1];
    let f = 1;
    for (let q = a; q < b; q++) {
      const p = this.parts[this.list[q]];
      const d = partDist(p, x, y, z);
      f = p.op === 0 ? smin(f, d, p.k) : smax(f, -d, p.k);
    }
    return f;
  }
}

export interface MeshOut {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  count: number;
}

export interface Clip {
  axis: 0 | 1 | 2;
  value: number;
  keep: 1 | -1;
  /**
   * Seam hiding for the coarse side of a split: over the last `shrink[0]` metres before the clip
   * the surface sinks by up to `shrink[1]`, so the finer sibling mesh always wins the overlap.
   */
  shrink?: [number, number];
}

const clipDist = (c: Clip | undefined, x: number, y: number, z: number) => {
  if (!c) return -1;
  const v = c.axis === 0 ? x : c.axis === 1 ? y : z;
  return c.keep > 0 ? c.value - v : v - c.value;
};

/** Field offset from a clip's shrink band (0 outside it). */
const shrinkAt = (c: Clip | undefined, x: number, y: number, z: number) => {
  if (!c || !c.shrink) return 0;
  // Distance inside the kept side, measured from the clip plane.
  const inside = -clipDist(c, x, y, z);
  const t = Math.min(1, Math.max(0, 1 - inside / c.shrink[0]));
  return c.shrink[1] * t * t * (3 - 2 * t);
};

/**
 * Surface nets over [min, max] with cell size h. Vertices are projected onto the zero set and
 * normals come from the field gradient.
 */
export function meshField(field0: Field, min: readonly number[], max: readonly number[], h: number, clip?: Clip): MeshOut {
  const F = (x: number, y: number, z: number) => Math.max(field0.eval(x, y, z) + shrinkAt(clip, x, y, z), clipDist(clip, x, y, z));
  const nx = Math.ceil((max[0] - min[0]) / h) + 1;
  const ny = Math.ceil((max[1] - min[1]) / h) + 1;
  const nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const N = nx * ny * nz;
  const field = new Float32Array(N);
  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * h;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * h;
      let idx = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++, idx++) {
        const x = min[0] + i * h;
        const c = field0.classify(x, y, z);
        field[idx] = c === 0 ? F(x, y, z) : c > 0 ? 1 : Math.max(-1, clipDist(clip, x, y, z));
      }
    }
  }

  // One vertex per cell that straddles the surface.
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const pos: number[] = [];
  const cornerOff = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const cv = new Float32Array(8);
  const cid = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const gid = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = cornerOff[c];
          const v = field[gid(i + o[0], j + o[1], k + o[2])];
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (let e = 0; e < 12; e++) {
          const a = edges[e][0];
          const b = edges[e][1];
          if (cv[a] < 0 === cv[b] < 0) continue;
          const t = cv[a] / (cv[a] - cv[b]);
          const oa = cornerOff[a];
          const ob = cornerOff[b];
          sx += oa[0] + (ob[0] - oa[0]) * t;
          sy += oa[1] + (ob[1] - oa[1]) * t;
          sz += oa[2] + (ob[2] - oa[2]) * t;
          n++;
        }
        cellVert[cid(i, j, k)] = pos.length / 3;
        pos.push(min[0] + (i + sx / n) * h, min[1] + (j + sy / n) * h, min[2] + (k + sz / n) * h);
      }
    }
  }

  // Quads across every grid edge with a sign change.
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const f0 = field[gid(i, j, k)] < 0;
        // x edge (i,j,k)-(i+1,j,k): cells sharing it vary in j-1..j, k-1..k
        if (i < nx - 1) {
          const f1 = field[gid(i + 1, j, k)] < 0;
          if (f0 !== f1)
            quad(cellVert[cid(i, j - 1, k - 1)], cellVert[cid(i, j, k - 1)], cellVert[cid(i, j, k)], cellVert[cid(i, j - 1, k)], f1);
        }
        if (j < ny - 1) {
          const f1 = field[gid(i, j + 1, k)] < 0;
          if (f0 !== f1)
            quad(cellVert[cid(i - 1, j, k - 1)], cellVert[cid(i - 1, j, k)], cellVert[cid(i, j, k)], cellVert[cid(i, j, k - 1)], f1);
        }
        if (k < nz - 1) {
          const f1 = field[gid(i, j, k + 1)] < 0;
          if (f0 !== f1)
            quad(cellVert[cid(i - 1, j - 1, k)], cellVert[cid(i, j - 1, k)], cellVert[cid(i, j, k)], cellVert[cid(i - 1, j, k)], f1);
        }
      }
    }
  }

  const count = pos.length / 3;
  const positions = new Float32Array(pos);
  const normals = new Float32Array(count * 3);
  const e = h * 0.25;
  for (let v = 0; v < count; v++) {
    let x = positions[v * 3];
    let y = positions[v * 3 + 1];
    let z = positions[v * 3 + 2];
    // Project onto the surface: two Newton steps along a forward-difference gradient.
    for (let it = 0; it < 2; it++) {
      const f = F(x, y, z);
      const gx = F(x + e, y, z) - f;
      const gy = F(x, y + e, z) - f;
      const gz = F(x, y, z + e) - f;
      const gl = Math.hypot(gx, gy, gz) / e;
      if (gl < 1e-6) break;
      const step = Math.max(-h, Math.min(h, f / gl)) / (gl * e);
      x -= gx * step;
      y -= gy * step;
      z -= gz * step;
    }
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    // Shading normal: central differences of the (unshrunk, unclipped) field, so both sides
    // of a split shade identically.
    const ev = (a: number, b: number, c: number) => field0.eval(a, b, c);
    const gx = ev(x + e, y, z) - ev(x - e, y, z);
    const gy = ev(x, y + e, z) - ev(x, y - e, z);
    const gz = ev(x, y, z + e) - ev(x, y, z - e);
    const nl = Math.hypot(gx, gy, gz) || 1;
    normals[v * 3] = gx / nl;
    normals[v * 3 + 1] = gy / nl;
    normals[v * 3 + 2] = gz / nl;
  }
  return { positions, normals, indices: new Uint32Array(idx), count };
}

/** Thickness through the body along -normal (m), for subsurface transmission. */
export function thicknessAt(field: Field, x: number, y: number, z: number, nx: number, ny: number, nz: number, maxT = 0.05) {
  let t = 0.0015;
  for (let i = 0; i < 32 && t < maxT; i++) {
    const f = field.eval(x - nx * t, y - ny * t, z - nz * t);
    if (f > 0) return t;
    t += Math.max(0.0015, -f * 0.95);
  }
  return maxT;
}

/**
 * Skin weights: per bone the best part score, softmin over part distances, top 4, normalised.
 * Writes 4 indices + 4 weights per vertex.
 */
export function skinWeights(parts: readonly Part[], positions: Float32Array, count: number, boneCount: number) {
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const best = new Float64Array(boneCount);
  const dists = new Float64Array(parts.length);
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    let dmin = 1e9;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.op !== 0) {
        dists[i] = 1e9;
        continue;
      }
      const d = partDist(p, x, y, z);
      dists[i] = d;
      if (d < dmin) dmin = d;
    }
    best.fill(0);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (dists[i] > 1e8) continue;
      const q = 1 - (dists[i] - dmin) / p.sigma;
      if (q <= 0) continue;
      const w = q * q * (3 - 2 * q);
      if (w > best[p.bone]) best[p.bone] = w;
    }
    // Top 4.
    for (let s = 0; s < 4; s++) {
      let bi = -1;
      let bw = 0;
      for (let b = 0; b < boneCount; b++) {
        if (best[b] > bw) {
          bw = best[b];
          bi = b;
        }
      }
      if (bi < 0) break;
      skinIndex[v * 4 + s] = bi;
      skinWeight[v * 4 + s] = bw;
      best[bi] = 0;
    }
    const sum = skinWeight[v * 4] + skinWeight[v * 4 + 1] + skinWeight[v * 4 + 2] + skinWeight[v * 4 + 3];
    if (sum > 0) for (let s = 0; s < 4; s++) skinWeight[v * 4 + s] /= sum;
    else skinWeight[v * 4] = 1;
  }
  return { skinIndex, skinWeight };
}

/** The part (and its distance) nearest a point, among parts with the given material filter. */
export function nearestPart(parts: readonly Part[], x: number, y: number, z: number): Part {
  let best = parts[0];
  let bd = 1e9;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.op !== 0) continue;
    const d = partDist(p, x, y, z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
