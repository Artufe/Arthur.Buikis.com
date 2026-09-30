// Geometry builders for the pier. Every timber part is a board with rounded arrises (so the low
// sun catches a highlight on every edge instead of a hard polygon line) and UVs in wood-strip
// tile units: u = metres across the grain / WOOD_U, v = metres along the grain / WOOD_V.

import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Vector3 } from 'three/webgpu';

/** Physical size of one tile of the baked wood strip (tools/quilt-wood.py). */
export const WOOD_U = 0.5;
export const WOOD_V = 4.096;

/**
 * A w (x) × h (y) × l (z) board, grain along +z, edges rounded with radius `bevel`.
 * Adds attribute `aEnd` (1 on the end-grain faces).
 */
export function boardGeometry(w: number, h: number, l: number, bevel: number): BufferGeometry {
  const g = new BoxGeometry(w, h, l, 3, 3, 3);
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const uv = g.attributes.uv;
  const n = pos.count;
  const end = new Float32Array(n);
  const half = [w / 2, h / 2, l / 2];
  const b = [Math.min(bevel, w / 2.2), Math.min(bevel, h / 2.2), Math.min(bevel, l / 2.2)];
  const p = [0, 0, 0];
  const inner = [0, 0, 0];
  const d = new Vector3();
  for (let i = 0; i < n; i++) {
    p[0] = pos.getX(i);
    p[1] = pos.getY(i);
    p[2] = pos.getZ(i);
    // BoxGeometry spaces the 3 segments evenly; move the inner grid lines to the bevel line.
    for (let a = 0; a < 3; a++) {
      const t = p[a] / half[a]; // -1, -1/3, 1/3, 1
      const s = Math.abs(t) > 0.99 ? Math.sign(t) * half[a] : Math.sign(t) * (half[a] - b[a]);
      p[a] = s;
      inner[a] = Math.max(-(half[a] - b[a]), Math.min(half[a] - b[a], s));
    }
    d.set(p[0] - inner[0], p[1] - inner[1], p[2] - inner[2]);
    // Rounded arris: pull corner points onto the bevel radius; the normal is the offset.
    const len = d.length();
    const oy = Math.abs(nrm.getY(i));
    const oz = Math.abs(nrm.getZ(i));
    let nx = nrm.getX(i);
    let ny = nrm.getY(i);
    let nz = nrm.getZ(i);
    if (len > 1e-6) {
      // Anisotropic radius per axis keeps small bevels on thin boards.
      const ex = d.x / (b[0] || 1);
      const ey = d.y / (b[1] || 1);
      const ez = d.z / (b[2] || 1);
      const el = Math.hypot(ex, ey, ez);
      const fx = ex / el;
      const fy = ey / el;
      const fz = ez / el;
      p[0] = inner[0] + fx * b[0];
      p[1] = inner[1] + fy * b[1];
      p[2] = inner[2] + fz * b[2];
      nx = fx;
      ny = fy;
      nz = fz;
    }
    pos.setXYZ(i, p[0], p[1], p[2]);
    nrm.setXYZ(i, nx, ny, nz);
    // Planar UVs by the original (unrounded) face: grain (z) is v, the other in-face axis is u.
    if (oz > 0.5) {
      // End grain: squash along the grain so it reads as rings/checks, not stretched fibres.
      uv.setXY(i, (p[0] + p[1] * 0.37) / WOOD_U, (p[1] * 0.08 + 0.3) / WOOD_V);
      end[i] = 1;
    } else if (oy > 0.5) {
      uv.setXY(i, (p[0] + w) / WOOD_U, (p[2] + l / 2) / WOOD_V);
    } else {
      uv.setXY(i, (p[1] + 0.21) / WOOD_U, (p[2] + l / 2) / WOOD_V);
    }
  }
  g.setAttribute('aEnd', new BufferAttribute(end, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Unit piling: radius 1, y from 0 to 1, open ended (the bottom is buried, the top hidden under
 * the caps). u wraps twice around (the strip is 0.5 m, a piling ~1.1 m round), v = y.
 */
export function poleGeometry(radial = 28, rings = 18): BufferGeometry {
  const g = new CylinderGeometry(1, 1, 1, radial, rings, true);
  g.translate(0, 0.5, 0);
  const uv = g.attributes.uv;
  const pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, pos.getY(i));
  return g;
}

/**
 * A tube of radius r along points (x, y, z triplets), with u around (0..1) and v in metres along.
 * Frames are parallel-transported so twisted rope strands don't swim.
 */
export function tubeGeometry(pts: number[], r: number, radial: number): BufferGeometry {
  const m = pts.length / 3;
  const ring = radial + 1;
  const position = new Float32Array(m * ring * 3);
  const normal = new Float32Array(m * ring * 3);
  const uvs = new Float32Array(m * ring * 2);
  const t = new Vector3();
  const nrm = new Vector3();
  const bin = new Vector3();
  const tmp = new Vector3();
  let along = 0;
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1);
    const c = Math.min(m - 1, i + 1);
    t.set(pts[c * 3] - pts[a * 3], pts[c * 3 + 1] - pts[a * 3 + 1], pts[c * 3 + 2] - pts[a * 3 + 2]).normalize();
    if (i === 0) {
      tmp.set(0, 1, 0);
      if (Math.abs(t.dot(tmp)) > 0.9) tmp.set(1, 0, 0);
      nrm.crossVectors(tmp, t).normalize();
    } else {
      // Parallel transport: remove the tangent component from the previous normal.
      nrm.addScaledVector(t, -nrm.dot(t)).normalize();
      along += Math.hypot(pts[i * 3] - pts[(i - 1) * 3], pts[i * 3 + 1] - pts[(i - 1) * 3 + 1], pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]);
    }
    bin.crossVectors(t, nrm);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      const cx = Math.cos(ang);
      const sy = Math.sin(ang);
      const k = i * ring + j;
      const nx = nrm.x * cx + bin.x * sy;
      const ny = nrm.y * cx + bin.y * sy;
      const nz = nrm.z * cx + bin.z * sy;
      position[k * 3] = pts[i * 3] + nx * r;
      position[k * 3 + 1] = pts[i * 3 + 1] + ny * r;
      position[k * 3 + 2] = pts[i * 3 + 2] + nz * r;
      normal[k * 3] = nx;
      normal[k * 3 + 1] = ny;
      normal[k * 3 + 2] = nz;
      uvs[k * 2] = j / radial;
      uvs[k * 2 + 1] = along;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * ring + j;
      const b = a + ring;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** Concatenate indexed geometries that share the same attribute set (position, normal, uv). */
export function mergeGeometries(list: BufferGeometry[]): BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const g of list) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(vCount * 3);
  const normal = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const index = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    position.set(g.attributes.position.array as Float32Array, vo * 3);
    normal.set(g.attributes.normal.array as Float32Array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array as Float32Array, vo * 2);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) index[io + i] = src[i] + vo;
      io += src.length;
    } else {
      for (let i = 0; i < c; i++) index[io + i] = vo + i;
      io += c;
    }
    vo += c;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(position, 3));
  out.setAttribute('normal', new BufferAttribute(normal, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}
