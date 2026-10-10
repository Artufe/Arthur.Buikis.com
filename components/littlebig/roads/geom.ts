// World-space geometry primitives for the region's roads (v2, H1), written into the city's merged
// Geo buffers (city/geo.ts) so they draw with the city's own programs. Everything lies on the sphere:
// a ribbon along a WPath (lateral offsets to the RIGHT of travel: fwd × up), vertical bands, plan
// polygons and polar rings in a local chart, cut into ≤ CELL m pieces so flat parts follow the
// curvature. Heights come from a callback (usually the rendered terrain facet plus a layer offset).

import { ShapeUtils, Vector2, type Color } from 'three';
import { Geo, type Xf } from '../city/geo';
import { R } from '../world/config';
import { wsample, wsampleOut } from '../world/region/path';
import type { WPath } from '../world/region/types';
import { chartToDir, dirToChart, v3, type Chart, type Vec3 } from '../world/sphere';

export type HeightFn = (q: Vec3, s: number, d: number) => number;
export type UvFn = (q: Vec3, s: number, d: number) => [number, number];

const CELL = 2;
const W = wsampleOut();
const _q = v3();
const _r = v3();
const _n = v3();
const _uv: [number, number] = [0, 0];
const _c = { x: 0, z: 0 };

/** Unit direction offset `d` m to the right `r` of unit `up` at radius R + h, into out. */
export function offsetDir(up: Vec3, r: Vec3, d: number, h: number, out: Vec3): Vec3 {
  const k = d / (R + h);
  const x = up.x + r.x * k, y = up.y + r.y * k, z = up.z + r.z * k;
  const l = Math.hypot(x, y, z);
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return out;
}

/** Emit a vertex at unit q, height h, normal up (or n), pattern uv. */
export function vtx(g: Geo, q: Vec3, h: number, u: number, v: number, n: Vec3 = q): number {
  const k = R + h;
  return g.vert(q.x * k, q.y * k, q.z * k, n.x, n.y, n.z, u, v);
}

/** The frame of path p at arc length s: W holds dir/tangent/h; returns the right vector into r. */
export function pathFrame(p: WPath, s: number, r: Vec3 = _r) {
  wsample(p, s, W);
  r.x = W.ty * W.dz - W.tz * W.dy;
  r.y = W.tz * W.dx - W.tx * W.dz;
  r.z = W.tx * W.dy - W.ty * W.dx;
  return W;
}

/**
 * Arc lengths to sample a path between s0 and s1: the two ends and, between them, its own samples
 * thinned to one every `step` m on a straight, every few degrees of turn on a bend (a road's
 * samples are ≤ 1 m apart, often 0.25 m in its curves: four times the vertices a toon ribbon needs).
 */
export function stations(p: WPath, s0: number, s1: number, step = 1.8): number[] {
  const out = [s0];
  const D = p.dir;
  let last = s0;
  let li = -1;
  for (let i = 1; i + 1 < p.s.length; i++) {
    const s = p.s[i];
    if (s <= s0 + 0.05 || s >= s1 - 0.05) continue;
    if (li < 0) li = i - 1;
    // the turn since the last kept sample: the angle between the chords (li → li+1) and (i → i+1)
    const ax = D[li * 3 + 3] - D[li * 3], ay = D[li * 3 + 4] - D[li * 3 + 1], az = D[li * 3 + 5] - D[li * 3 + 2];
    const bx = D[i * 3 + 3] - D[i * 3], by = D[i * 3 + 4] - D[i * 3 + 1], bz = D[i * 3 + 5] - D[i * 3 + 2];
    const c = (ax * bx + ay * by + az * bz) / (Math.sqrt((ax * ax + ay * ay + az * az) * (bx * bx + by * by + bz * bz)) || 1);
    if (s - last >= step || c < 0.9985 || Math.abs(p.h[i] - p.h[li]) > 0.25) {
      out.push((last = s));
      li = i;
    }
  }
  if (s1 - last < 0.3 && out.length > 1) out.pop();
  out.push(s1);
  return out;
}

/** A lateral offset (m, right of travel): fixed, or varying along the path (a taper). */
export type Lat = number | ((s: number) => number);
const lat = (d: Lat, s: number) => (typeof d === 'number' ? d : d(s));
/** A path's stations for a strip between offsets a and b: a taper's every 0.4 m, so its curve reads. */
const stationsFor = (p: WPath, s0: number, s1: number, a: Lat, b: Lat = 0) => stations(p, s0, s1, typeof a === 'number' && typeof b === 'number' ? 1.8 : 0.4);

/**
 * A ribbon along p from s0 to s1 between lateral offsets d0 < d1 (m, right of travel), `cols` strips
 * across, at height hOf(q, s); uv (s, d) unless uvOf is given. Faces up.
 */
export function ribbon(g: Geo, p: WPath, s0: number, s1: number, d0: Lat, d1: Lat, cols: number, hOf: HeightFn, uvOf?: UvFn, down = false): void {
  const ss = stationsFor(p, s0, s1, d0, d1);
  const first = g.n;
  const n = cols + 1;
  for (const s of ss) {
    const w = pathFrame(p, s);
    const up = v3(w.dx, w.dy, w.dz);
    const a = lat(d0, s), b = lat(d1, s);
    for (let k = 0; k < n; k++) {
      const d = a + ((b - a) * k) / cols;
      offsetDir(up, _r, d, w.h, _q);
      const uv = uvOf ? uvOf(_q, s, d) : ((_uv[0] = s), (_uv[1] = d), _uv);
      if (down) _n.x = -_q.x, _n.y = -_q.y, _n.z = -_q.z;
      vtx(g, _q, hOf(_q, s, d), uv[0], uv[1], down ? _n : _q);
    }
  }
  for (let i = 0; i + 1 < ss.length; i++) {
    for (let k = 0; k < cols; k++) {
      const a = first + i * n + k;
      if (down) g.quadIdx(a, a + n, a + n + 1, a + 1);
      else g.quadIdx(a, a + 1, a + n + 1, a + n);
    }
  }
}

/**
 * A vertical band along p at lateral offset d from h0(q, s) up to h1(q, s), facing `side` (+1 right of
 * travel, −1 left). uv (s, height).
 */
export function band(g: Geo, p: WPath, s0: number, s1: number, d: Lat, h0: HeightFn, h1: HeightFn, side: 1 | -1): void {
  const ss = stationsFor(p, s0, s1, d);
  const first = g.n;
  for (const s of ss) {
    const w = pathFrame(p, s);
    const up = v3(w.dx, w.dy, w.dz);
    const dd = lat(d, s);
    offsetDir(up, _r, dd, w.h, _q);
    const nrm = v3(_r.x * side, _r.y * side, _r.z * side);
    const a = h0(_q, s, dd), b = h1(_q, s, dd);
    vtx(g, _q, a, s, a, nrm);
    vtx(g, _q, b, s, b, nrm);
  }
  for (let i = 0; i + 1 < ss.length; i++) {
    const a = first + i * 2;
    if (side > 0) g.quadIdx(a, a + 2, a + 3, a + 1);
    else g.quadIdx(a, a + 1, a + 3, a + 2);
  }
}

/** A plan point of chart c as a unit direction (shared scratch: copy what you keep). */
export function at(c: Chart, x: number, z: number, out: Vec3 = _q): Vec3 {
  return chartToDir(c, x, z, out);
}

function clip(p: number[], nx: number, nz: number, k: number): number[] {
  const out: number[] = [];
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const si = p[i * 2] * nx + p[i * 2 + 1] * nz - k;
    const sj = p[j * 2] * nx + p[j * 2 + 1] * nz - k;
    if (si >= 0) out.push(p[i * 2], p[i * 2 + 1]);
    if (si >= 0 !== sj >= 0) {
      const t = si / (si - sj);
      out.push(p[i * 2] + (p[j * 2] - p[i * 2]) * t, p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * t);
    }
  }
  return out;
}

/** Fill a simple plan polygon (x, z pairs, any winding) of chart c, cut into CELL m cells, facing up. uv: plan (x, z) unless uvOf. */
export function fill(g: Geo, c: Chart, poly: ArrayLike<number>, hOf: HeightFn, uvOf?: UvFn): void {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    x0 = Math.min(x0, poly[i]);
    x1 = Math.max(x1, poly[i]);
    z0 = Math.min(z0, poly[i + 1]);
    z1 = Math.max(z1, poly[i + 1]);
  }
  const src = Array.from(poly);
  for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      let p = clip(src, 1, 0, i * CELL);
      if (p.length >= 6) p = clip(p, -1, 0, -(i + 1) * CELL);
      if (p.length >= 6) p = clip(p, 0, 1, j * CELL);
      if (p.length >= 6) p = clip(p, 0, -1, -(j + 1) * CELL);
      if (p.length < 6) continue;
      const pts: Vector2[] = [];
      for (let k = 0; k < p.length; k += 2) pts.push(new Vector2(p[k], p[k + 1]));
      const ids = pts.map((v) => {
        const q = at(c, v.x, v.y);
        const uv = uvOf ? uvOf(q, 0, 0) : ((_uv[0] = v.x), (_uv[1] = v.y), _uv);
        return vtx(g, q, hOf(q, 0, 0), uv[0], uv[1]);
      });
      for (const t of ShapeUtils.triangulateShape(pts, [])) {
        const a = pts[t[0]], b = pts[t[1]], d = pts[t[2]];
        const w = (b.x - a.x) * (d.y - a.y) - (d.x - a.x) * (b.y - a.y);
        if (w > 0) g.tri(ids[t[0]], ids[t[2]], ids[t[1]]);
        else g.tri(ids[t[0]], ids[t[1]], ids[t[2]]);
      }
    }
  }
}

/**
 * A polar ring (or disc: r0 = 0) round chart c's origin from angle a0 to a1 (plan radians, atan2(z, x)),
 * facing up; uv: plan (x, z) unless uvOf.
 */
export function ring(g: Geo, c: Chart, r0: number, r1: number, a0: number, a1: number, hOf: HeightFn, uvOf?: UvFn): void {
  const nr = Math.max(1, Math.ceil((r1 - r0) / CELL));
  const na = Math.max(3, Math.ceil((Math.abs(a1 - a0) * r1) / 1.2));
  const first = g.n;
  for (let i = 0; i <= na; i++) {
    const a = a0 + ((a1 - a0) * i) / na;
    for (let k = 0; k <= nr; k++) {
      const r = r0 + ((r1 - r0) * k) / nr;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const q = at(c, x, z);
      const uv = uvOf ? uvOf(q, r, a) : ((_uv[0] = x), (_uv[1] = z), _uv);
      vtx(g, q, hOf(q, r, a), uv[0], uv[1]);
    }
  }
  const m = nr + 1;
  for (let i = 0; i < na; i++) {
    for (let k = 0; k < nr; k++) {
      const v = first + i * m + k;
      // increasing angle runs clockwise seen from above (+z is south)
      if (a1 > a0) g.quadIdx(v, v + m, v + m + 1, v + 1);
      else g.quadIdx(v, v + 1, v + m + 1, v + m);
    }
  }
}

/** A local frame at unit q, height h: ez along tangent t (unit, horizontal), ey up, ex = up × t. */
export function frameAt(q: Vec3, h: number, t: Vec3): Xf {
  const k = R + h;
  return {
    o: v3(q.x * k, q.y * k, q.z * k),
    ex: v3(q.y * t.z - q.z * t.y, q.z * t.x - q.x * t.z, q.x * t.y - q.y * t.x),
    ey: v3(q.x, q.y, q.z),
    ez: v3(t.x, t.y, t.z),
  };
}

/** Set the Geo's colour, surface kind and its param for what is emitted next. */
export function set(g: Geo, c: Color, kind = 0, param = 0) {
  g.color.copy(c);
  g.kind = kind;
  g.param = param;
}

export function cross(a: Vec3, c: Vec3): Vec3 {
  return v3(a.y * c.z - a.z * c.y, a.z * c.x - a.x * c.z, a.x * c.y - a.y * c.x);
}

/** Some unit tangent at unit up (toward the pole, or +x near it). */
export function tangentOf(up: Vec3): Vec3 {
  return toward(up, Math.abs(up.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0));
}

/** Unit tangent at unit q toward unit b (horizontal), into out. */
export function toward(q: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 {
  const d = b.x * q.x + b.y * q.y + b.z * q.z;
  out.x = b.x - q.x * d;
  out.y = b.y - q.y * d;
  out.z = b.z - q.z * d;
  const l = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= l;
  out.y /= l;
  out.z /= l;
  return out;
}

/** Plan coordinates of unit q in chart c (shared scratch). */
export function plan(c: Chart, q: Vec3) {
  return dirToChart(c, q, _c);
}

export { Geo };
