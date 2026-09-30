// Lofted board surface: dense stations toward nose and tail, curvature-weighted ring spacing so
// the rails get the vertices, and normals from the smooth parametric grid (no faceting).
// Plus the tail traction pad as its own thin shell following the deck.

import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import { BOARD_LENGTH, apexFrac, deckExp, halfWidth, rocker, sectionPoint, thickness } from './shape';

const L = BOARD_LENGTH;

export function buildBoardGeometry(stations = 240, ring = 168): BufferGeometry {
  const rowLen = ring + 1; // duplicate seam vertex at the bottom centre
  const nv = stations * rowLen;
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  // Girth distance from the rail apex: + on the deck (toward the stringer), - on the bottom.
  const railDist = new Float32Array(nv);
  const dense = 900;
  const dp = new Float64Array(3);
  const px = new Float64Array(dense + 1);
  const py = new Float64Array(dense + 1);
  const pz = new Float64Array(dense + 1);
  const wcum = new Float64Array(dense + 1);
  const gcum = new Float64Array(dense + 1);

  for (let i = 0; i < stations; i++) {
    const s = i / (stations - 1);
    // Cosine spacing: dense at the tips, where curvature lives.
    const d = (L * (1 - Math.cos(Math.PI * s))) / 2;
    // Dense sampling of the section, starting at the bottom centre, going through +Z.
    for (let k = 0; k <= dense; k++) {
      const phi = -Math.PI / 2 + (k / dense) * Math.PI * 2;
      sectionPoint(d, phi, dp);
      px[k] = dp[0];
      py[k] = dp[1];
      pz[k] = dp[2];
    }
    // Weight = arc length + turning: rails (high curvature) get more of the ring.
    wcum[0] = 0;
    gcum[0] = 0;
    let prevAng = 0;
    for (let k = 1; k <= dense; k++) {
      const ey = py[k] - py[k - 1];
      const ez = pz[k] - pz[k - 1];
      const ds = Math.hypot(ey, ez);
      const ang = Math.atan2(ey, ez);
      let dAng = k === 1 ? 0 : Math.abs(ang - prevAng);
      if (dAng > Math.PI) dAng = Math.PI * 2 - dAng;
      prevAng = ang;
      wcum[k] = wcum[k - 1] + ds + 0.035 * dAng;
      gcum[k] = gcum[k - 1] + ds;
    }
    const wTot = wcum[dense] || 1;
    const gTot = gcum[dense];
    // The +Z rail apex is a quarter turn from the bottom centre (phi = 0).
    const gApex = Math.abs(gcum[Math.round(dense / 4)] - gTot / 2);
    let k = 0;
    for (let j = 0; j <= ring; j++) {
      const target = (j / ring) * wTot;
      while (k < dense - 1 && wcum[k + 1] < target) k++;
      const span = wcum[k + 1] - wcum[k];
      const f = span > 0 ? (target - wcum[k]) / span : 0;
      const vi = i * rowLen + j;
      pos[vi * 3] = d - L / 2;
      pos[vi * 3 + 1] = py[k] + (py[k + 1] - py[k]) * f;
      pos[vi * 3 + 2] = pz[k] + (pz[k + 1] - pz[k]) * f;
      // uv.x: metres from the tail. uv.y: girth from the deck stringer (negative toward +Z).
      const g = gcum[k] + (gcum[k + 1] - gcum[k]) * f;
      uv[vi * 2] = d;
      uv[vi * 2 + 1] = gTot > 0 ? g - gTot / 2 : 0;
      railDist[vi] = gApex - Math.abs(uv[vi * 2 + 1]);
    }
  }

  const normal = new Float32Array(nv * 3);
  const tangent = new Float32Array(nv * 4);
  const P = (i: number, j: number, c: number) => pos[(i * rowLen + j) * 3 + c];
  for (let i = 0; i < stations; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(stations - 1, i + 1);
    for (let j = 0; j <= ring; j++) {
      const jm = j === 0 ? ring - 1 : j - 1;
      const jp = j === ring ? 1 : j + 1;
      const ax = P(i1, j, 0) - P(i0, j, 0);
      const ay = P(i1, j, 1) - P(i0, j, 1);
      const az = P(i1, j, 2) - P(i0, j, 2);
      const bx = P(i, jp, 0) - P(i, jm, 0);
      const by = P(i, jp, 1) - P(i, jm, 1);
      const bz = P(i, jp, 2) - P(i, jm, 2);
      // Ring runs bottom → +Z rail → deck → -Z rail; with the length axis this crosses outward.
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      let len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) {
        // Degenerate tip ring: point along the length axis.
        nx = i === 0 ? -1 : 1;
        ny = 0;
        nz = 0;
        len = 1;
      }
      const vi = (i * rowLen + j) * 3;
      nx /= len;
      ny /= len;
      nz /= len;
      normal[vi] = nx;
      normal[vi + 1] = ny;
      normal[vi + 2] = nz;
      // Tangent along the length (uv.x), orthogonalised; bitangent = n × t follows uv.y.
      const dotA = ax * nx + ay * ny + az * nz;
      let tx = ax - nx * dotA;
      let ty = ay - ny * dotA;
      let tz = az - nz * dotA;
      const tl = Math.hypot(tx, ty, tz);
      if (tl < 1e-9) (tx = 1), (ty = 0), (tz = 0);
      else (tx /= tl), (ty /= tl), (tz /= tl);
      const ti = (i * rowLen + j) * 4;
      tangent[ti] = tx;
      tangent[ti + 1] = ty;
      tangent[ti + 2] = tz;
      tangent[ti + 3] = 1;
    }
  }
  // Tip vertices: blend toward the axis so the rounded ends shade like a solid.
  for (const i of [0, stations - 1]) {
    const sx = i === 0 ? -1 : 1;
    for (let j = 0; j <= ring; j++) {
      const vi = (i * rowLen + j) * 3;
      const ny = normal[vi + 1] * 0.5;
      const len = Math.hypot(sx, ny);
      normal[vi] = sx / len;
      normal[vi + 1] = ny / len;
      normal[vi + 2] = 0;
    }
  }
  // Orientation check at the deck centre: must face +Y.
  const deckJ = Math.round(ring / 2);
  const mid = Math.floor(stations / 2);
  const flip = normal[(mid * rowLen + deckJ) * 3 + 1] < 0;
  if (flip) {
    for (let q = 0; q < normal.length; q++) normal[q] = -normal[q];
    for (let q = 3; q < tangent.length; q += 4) tangent[q] = -1;
  }

  const idx = new Uint32Array((stations - 1) * ring * 6);
  let o = 0;
  for (let i = 0; i < stations - 1; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * rowLen + j;
      const b = (i + 1) * rowLen + j;
      const c = (i + 1) * rowLen + j + 1;
      const e = i * rowLen + j + 1;
      // Face normal of (a, b, e) is dP/di × dP/dj, the same cross product as the vertex normals.
      if (!flip) {
        idx[o++] = a;
        idx[o++] = b;
        idx[o++] = e;
        idx[o++] = b;
        idx[o++] = c;
        idx[o++] = e;
      } else {
        idx[o++] = a;
        idx[o++] = e;
        idx[o++] = b;
        idx[o++] = b;
        idx[o++] = e;
        idx[o++] = c;
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(normal, 3));
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.setAttribute('tangent', new BufferAttribute(tangent, 4));
  geo.setAttribute('railDist', new BufferAttribute(railDist, 1));
  geo.setIndex(new BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Deck surface point and normal at station d, lateral z (board frame). */
function deckPoint(d: number, z: number, out: Float64Array) {
  const a = halfWidth(d);
  const t = thickness(d);
  const af = apexFrac(d);
  const n = deckExp(d);
  const yApex = rocker(d) + t * af;
  const u = Math.min(0.999, Math.abs(z) / Math.max(1e-6, a));
  const v = Math.pow(1 - Math.pow(u, n), 1 / n);
  out[0] = d - L / 2;
  out[1] = yApex + v * t * (1 - af);
  out[2] = z;
}

// Traction pad: three-piece EVA pad with a kick and an arch bar, 5 mm thick.
export const PAD = { d0: 0.03, d1: 0.36, rail: 0.034, thick: 0.0052, kick: 0.021, gap: 0.0045 };

/** Pad height above the deck (m) at station d and lateral z; 0 outside. Board-frame input. */
export function padHeight(d: number, z: number) {
  if (d < PAD.d0 || d > PAD.d1) return 0;
  const half = halfWidth(d) - PAD.rail;
  if (half <= 0) return 0;
  const az = Math.abs(z);
  // Rounded pad outline: the nose edge is gently curved, the tail follows the board.
  const noseEdge = PAD.d1 - 0.035 * (az / half) * (az / half);
  const edgeD = Math.min(d - PAD.d0, noseEdge - d);
  const edgeZ = half - az;
  const edge = Math.min(edgeD, edgeZ);
  if (edge <= 0) return 0;
  const bevel = 0.0035;
  const e = Math.min(1, edge / bevel);
  const round = Math.sqrt(Math.max(0, 1 - (1 - e) * (1 - e)));
  // Three pieces: gaps at a third of the half-width either side of the centre.
  const gz = Math.abs(az - half * 0.36);
  const gap = Math.min(1, Math.max(0, (gz - PAD.gap / 2) / 0.0018));
  const gapRound = Math.sqrt(Math.max(0, 1 - (1 - gap) * (1 - gap)));
  // Kick: rises toward the tail. Arch: a soft ridge down the centre piece.
  const k = Math.min(1, Math.max(0, (0.125 - d) / 0.085));
  const kick = PAD.kick * k * k * (3 - 2 * k);
  const archT = Math.max(0, 1 - az / (half * 0.3));
  const archL = Math.max(0, Math.min(1, (d - 0.12) / 0.04)) * Math.max(0, Math.min(1, (0.3 - d) / 0.05));
  const arch = 0.0045 * archT * archT * archL;
  return (PAD.thick + kick + arch) * round * gapRound;
}

export function buildPadGeometry(nd = 110, nz = 96): BufferGeometry {
  const nv = nd * nz;
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const hgt = new Float32Array(nv);
  const p = new Float64Array(3);
  const q = new Float64Array(3);
  const r = new Float64Array(3);
  const eps = 0.0008;
  const surf = (d: number, z: number, out: Float64Array) => {
    deckPoint(d, z, out);
    const h = padHeight(d, z);
    // Offset along the deck normal (approximated from finite differences).
    deckPoint(d + 0.002, z, q);
    deckPoint(d, z + 0.002, r);
    const ax = q[0] - out[0], ay = q[1] - out[1], az = q[2] - out[2];
    const bx = r[0] - out[0], by = r[1] - out[1], bz = r[2] - out[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    if (ny < 0) (nx = -nx), (ny = -ny), (nz = -nz);
    const off = h + 0.0006;
    out[0] += nx * off;
    out[1] += ny * off;
    out[2] += nz * off;
    return h;
  };
  const dA = PAD.d0 - 0.002;
  const dB = PAD.d1 + 0.002;
  for (let i = 0; i < nd; i++) {
    const d = dA + ((dB - dA) * i) / (nd - 1);
    const half = halfWidth(d) - PAD.rail + 0.002;
    for (let j = 0; j < nz; j++) {
      const f = j / (nz - 1);
      // Denser toward the pad edges and the piece gaps.
      const z = half * (2 * f - 1);
      const vi = i * nz + j;
      hgt[vi] = surf(d, z, p);
      pos[vi * 3] = p[0];
      pos[vi * 3 + 1] = p[1];
      pos[vi * 3 + 2] = p[2];
      uv[vi * 2] = d;
      uv[vi * 2 + 1] = z;
    }
  }
  // Normals from the displaced grid (central differences in the parameter domain).
  for (let i = 0; i < nd; i++) {
    for (let j = 0; j < nz; j++) {
      const d = uv[(i * nz + j) * 2];
      const z = uv[(i * nz + j) * 2 + 1];
      surf(d + eps, z, q);
      surf(d - eps, z, r);
      const ax = q[0] - r[0], ay = q[1] - r[1], az = q[2] - r[2];
      surf(d, z + eps, q);
      surf(d, z - eps, r);
      const bx = q[0] - r[0], by = q[1] - r[1], bz = q[2] - r[2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz2 = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz2) || 1;
      nx /= len;
      ny /= len;
      nz2 /= len;
      if (ny < 0) (nx = -nx), (ny = -ny), (nz2 = -nz2);
      const vi = (i * nz + j) * 3;
      nrm[vi] = nx;
      nrm[vi + 1] = ny;
      nrm[vi + 2] = nz2;
    }
  }
  // Only keep quads that touch the pad (height > 0), so the shell ends at the pad outline.
  const idx: number[] = [];
  for (let i = 0; i < nd - 1; i++) {
    for (let j = 0; j < nz - 1; j++) {
      const a = i * nz + j;
      const b = (i + 1) * nz + j;
      const c = (i + 1) * nz + j + 1;
      const e = i * nz + j + 1;
      if (hgt[a] + hgt[b] + hgt[c] + hgt[e] <= 0) continue;
      // Deck normal is +Y; (d, z) → (x, z) with +x along d: CCW seen from +Y is a, e, b.
      idx.push(a, e, b, b, e, c);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.setAttribute('padH', new BufferAttribute(hgt, 1));
  // Tangent +X (uv.x = d); n × t = -Z while uv.y = z grows toward +Z, hence w = -1.
  const tan = new Float32Array(nv * 4);
  for (let k = 0; k < nv; k++) {
    const nx = nrm[k * 3], ny = nrm[k * 3 + 1], nz3 = nrm[k * 3 + 2];
    let tx = 1 - nx * nx, ty = -nx * ny, tz = -nx * nz3;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tan[k * 4] = tx / tl;
    tan[k * 4 + 1] = ty / tl;
    tan[k * 4 + 2] = tz / tl;
    tan[k * 4 + 3] = -1;
  }
  geo.setAttribute('tangent', new BufferAttribute(tan, 4));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
