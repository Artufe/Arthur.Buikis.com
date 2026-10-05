// City ground: every paved or planted surface inside the plan, drawn above the bare plateau at the
// contract heights (world/config.ts, Area.h): carriageways and junction patches at ROAD_H,
// sidewalks at ROAD_H + CURB_H with real curb faces, downtown lots / the plaza paved flush with
// them, raised lawn beds in the courtyards, park lawns and gardens at AREA_H. Paint (lane lines,
// zebras, stop lines, turn arrows, the dashed guide lines through big junctions) goes into its own
// geometry so the renderer can draw it with a polygon offset. Large polygons are cut into ≤ 2.5 m
// cells so the flat pieces follow the sphere (a 30 m flat triangle would sag 0.7 m below it).

import { Color, ShapeUtils, Vector2 } from 'three';
import { PALETTE } from '../render/palette';
import { AREA_H, CURB_H, ROAD_H } from '../world/config';
import { toSphere } from '../world/city/frame';
import { cornerPoints, pointInPolygon } from '../world/city/graph';
import { endTangent, hermitePoints, nearestOn, polyline, sampleAt, startTangent } from '../world/city/path';
import type { CityIndex, CityPlan, Polyline, Turn } from '../world/city/types';
import { v3, type Vec3 } from '../world/sphere';
import { doorX } from './buildings';
import { Geo, K } from './geo';

const SIDEWALK_TOP = ROAD_H + CURB_H;
const PAINT_H = ROAD_H + 0.006;
const CELL = 2.5;

const C = {
  // A touch lighter and warmer than the palette's asphalt: under the cool sky fill the raw value
  // reads navy-black in shadow and the streets swallow the frame from above.
  asphalt: PALETTE.road.asphalt.clone().lerp(new Color('#7A7570'), 0.32),
  sidewalk: PALETTE.road.sidewalk.clone(),
  kerb: new Color('#F4F1EA'),
  curb: new Color('#B9B4AA'),
  yellow: PALETTE.road.marking.clone(),
  white: new Color('#F7F5EE'),
  // Downtown lots: warm sand-pink setts, clearly not sidewalk (the old terracotta #BF9A80 read
  // muddy brown from 120 m and maroon at dusk).
  lot: new Color('#D9BBA6'),
  plaza: new Color('#EAD9B8'),
  lane: new Color('#D8B48E'),
  park: new Color('#74C24B'),
  bed: new Color('#6CBE45'),
  bedRim: new Color('#E6DCC8'),
  garden: new Color('#8ACF55'),
  gravel: new Color('#E9D3A1'),
  plazaPath: new Color('#D7BE96'),
  water: new Color('#3FA9D8'),
};

const _p = v3();
const _q = v3();
const _r = v3();
const _s = v3();

function gv(g: Geo, x: number, z: number, h: number, u: (x: number, z: number) => [number, number]): number {
  toSphere(x, z, h, _p);
  const l = Math.hypot(_p.x, _p.y, _p.z) || 1;
  const uv = u(x, z);
  return g.vert(_p.x, _p.y, _p.z, _p.x / l, _p.y / l, _p.z / l, uv[0], uv[1]);
}

const planUv = (x: number, z: number): [number, number] => [x, z];

/** Fill a plan polygon (any winding, simple) at height h, cut into cells that follow the sphere. */
export function fillPolygon(g: Geo, poly: ArrayLike<number>, h: number, uv: (x: number, z: number) => [number, number] = planUv): void {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    x0 = Math.min(x0, poly[i]);
    x1 = Math.max(x1, poly[i]);
    z0 = Math.min(z0, poly[i + 1]);
    z1 = Math.max(z1, poly[i + 1]);
  }
  const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL);
  const j0 = Math.floor(z0 / CELL), j1 = Math.floor(z1 / CELL);
  const src = Array.from(poly);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const cx0 = i * CELL, cx1 = cx0 + CELL, cz0 = j * CELL, cz1 = cz0 + CELL;
      let p = clip(src, 1, 0, cx0);
      if (p.length < 6) continue;
      p = clip(p, -1, 0, -cx1);
      if (p.length < 6) continue;
      p = clip(p, 0, 1, cz0);
      if (p.length < 6) continue;
      p = clip(p, 0, -1, -cz1);
      if (p.length < 6) continue;
      if (p.length === 8 && isCell(p, cx0, cx1, cz0, cz1)) {
        quadUp(g, cx0, cz0, cx1, cz0, cx1, cz1, cx0, cz1, h, uv);
        continue;
      }
      const contour: Vector2[] = [];
      for (let k = 0; k < p.length; k += 2) contour.push(new Vector2(p[k], p[k + 1]));
      const tris = ShapeUtils.triangulateShape(contour, []);
      const ids = contour.map((c) => gv(g, c.x, c.y, h, uv));
      for (const t of tris) {
        const a = contour[t[0]], b = contour[t[1]], c = contour[t[2]];
        const w = a.x * b.y - b.x * a.y + b.x * c.y - c.x * b.y + c.x * a.y - a.x * c.y;
        if (w > 0) g.tri(ids[t[0]], ids[t[2]], ids[t[1]]);
        else g.tri(ids[t[0]], ids[t[1]], ids[t[2]]);
      }
    }
  }
}

function quadUp(g: Geo, ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, h: number, uv: (x: number, z: number) => [number, number]) {
  const i0 = gv(g, ax, az, h, uv);
  const i1 = gv(g, bx, bz, h, uv);
  const i2 = gv(g, cx, cz, h, uv);
  const i3 = gv(g, dx, dz, h, uv);
  const w = ax * bz - bx * az + bx * cz - cx * bz + cx * az - ax * cz;
  if (w > 0) g.quadIdx(i0, i3, i2, i1);
  else g.quadIdx(i0, i1, i2, i3);
}

function isCell(p: number[], x0: number, x1: number, z0: number, z1: number): boolean {
  for (let k = 0; k < 8; k += 2) {
    const onX = Math.abs(p[k] - x0) < 1e-6 || Math.abs(p[k] - x1) < 1e-6;
    const onZ = Math.abs(p[k + 1] - z0) < 1e-6 || Math.abs(p[k + 1] - z1) < 1e-6;
    if (!onX || !onZ) return false;
  }
  return true;
}

function clip(p: number[], nx: number, nz: number, c: number): number[] {
  const out: number[] = [];
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const si = p[i * 2] * nx + p[i * 2 + 1] * nz - c;
    const sj = p[j * 2] * nx + p[j * 2 + 1] * nz - c;
    if (si >= 0) out.push(p[i * 2], p[i * 2 + 1]);
    if ((si >= 0) !== (sj >= 0)) {
      const t = si / (si - sj);
      out.push(p[i * 2] + (p[j * 2] - p[i * 2]) * t, p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * t);
    }
  }
  return out;
}

/**
 * A ribbon along a polyline between lateral offsets d0 < d1 (metres to the right of travel), at
 * height h, split into `strips` across. uv: (s along, d across) in metres.
 */
export function ribbon(g: Geo, pl: Polyline, d0: number, d1: number, h: number, strips = 1, uvScale = 1, h1 = h): void {
  const n = pl.pts.length >> 1;
  if (n < 2) return;
  const P = pl.pts;
  const cols = strips + 1;
  const first = g.n;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = P[b * 2] - P[a * 2];
    let tz = P[b * 2 + 1] - P[a * 2 + 1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    const rx = -tz;
    const rz = tx;
    for (let k = 0; k < cols; k++) {
      const d = d0 + ((d1 - d0) * k) / strips;
      const hh = h + ((h1 - h) * k) / strips;
      const x = P[i * 2] + rx * d;
      const z = P[i * 2 + 1] + rz * d;
      toSphere(x, z, hh, _p);
      const L = Math.hypot(_p.x, _p.y, _p.z) || 1;
      g.vert(_p.x, _p.y, _p.z, _p.x / L, _p.y / L, _p.z / L, pl.s[i] * uvScale, d * uvScale);
    }
  }
  const flip = d1 < d0;
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < strips; k++) {
      const a = first + i * cols + k;
      const b = first + (i + 1) * cols + k;
      const c = b + 1;
      const d = a + 1;
      if (flip) g.quadIdx(a, b, c, d);
      else g.quadIdx(a, d, c, b);
    }
  }
}

/** A vertical band along a polyline at lateral offset d, from height h0 to h1, facing `side`. */
export function band(g: Geo, pl: Polyline, d: number, h0: number, h1: number, side: 1 | -1): void {
  const n = pl.pts.length >> 1;
  const P = pl.pts;
  let px = 0, pz = 0;
  let prevS = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = P[b * 2] - P[a * 2];
    let tz = P[b * 2 + 1] - P[a * 2 + 1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    const cx = P[i * 2] - tz * d;
    const cz = P[i * 2 + 1] + tx * d;
    if (i > 0) wallQuad(g, px, pz, cx, cz, h0, h1, side, prevS, pl.s[i]);
    px = cx;
    pz = cz;
    prevS = pl.s[i];
  }
}

function wallQuad(g: Geo, ax: number, az: number, bx: number, bz: number, h0: number, h1: number, side: 1 | -1, s0: number, s1: number) {
  toSphere(ax, az, h0, _p);
  toSphere(bx, bz, h0, _q);
  toSphere(bx, bz, h1, _r);
  toSphere(ax, az, h1, _s);
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz) || 1;
  const rx = (-dz / l) * side;
  const rz = (dx / l) * side;
  toSphere(ax + rx, az + rz, h0, _n2);
  let nx = _n2.x - _p.x, ny = _n2.y - _p.y, nz = _n2.z - _p.z;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const ux = _r.x - _p.x, uy = _r.y - _p.y, uz = _r.z - _p.z;
  const vx = _s.x - _q.x, vy = _s.y - _q.y, vz = _s.z - _q.z;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const flip = cx * nx + cy * ny + cz * nz < 0;
  const i0 = g.vert(_p.x, _p.y, _p.z, nx, ny, nz, s0, h0);
  const i1 = g.vert(_q.x, _q.y, _q.z, nx, ny, nz, s1, h0);
  const i2 = g.vert(_r.x, _r.y, _r.z, nx, ny, nz, s1, h1);
  const i3 = g.vert(_s.x, _s.y, _s.z, nx, ny, nz, s0, h1);
  if (flip) g.quadIdx(i0, i3, i2, i1);
  else g.quadIdx(i0, i1, i2, i3);
}
const _n2: Vec3 = v3();

/** The polyline extended by `e` metres past both ends along its end tangents (seams tuck under). */
function extend(pl: Polyline, e0: number, e1 = e0): Polyline {
  const p = pl.pts;
  const t0 = startTangent(pl);
  const t1 = endTangent(pl);
  const pts = Array.from(p);
  pts.unshift(p[0] - t0.x * e0, p[1] - t0.z * e0);
  pts.push(p[p.length - 2] + t1.x * e1, p[p.length - 1] + t1.z * e1);
  return polyline(pts);
}

function armsOf(plan: CityPlan, nodeId: number) {
  const n = plan.nodes[nodeId];
  return n.edges.map((id) => {
    const e = plan.edges[id];
    const atA = e.a === n.id;
    const p = e.centre.pts;
    const px = atA ? p[0] : p[p.length - 2];
    const pz = atA ? p[1] : p[p.length - 1];
    const t = atA ? startTangent(e.centre) : endTangent(e.centre);
    const ux = atA ? t.x : -t.x;
    const uz = atA ? t.z : -t.z;
    return { e, px, pz, ux, uz, rx: -uz, rz: ux, half: e.width / 2 };
  });
}

/** A convex polygon of paint given in a lane's (s along, d right) coordinates. */
function paintPoly(P: Geo, pl: Polyline, sd: number[], h: number) {
  const sp = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  const first = P.n;
  const n = sd.length >> 1;
  for (let k = 0; k < n; k++) {
    sampleAt(pl, sd[k * 2], sp);
    const x = sp.x - sp.tz * sd[k * 2 + 1];
    const z = sp.z + sp.tx * sd[k * 2 + 1];
    toSphere(x, z, h, _p);
    const l = Math.hypot(_p.x, _p.y, _p.z);
    P.vert(_p.x, _p.y, _p.z, _p.x / l, _p.y / l, _p.z / l, 0, 0);
  }
  // (s, d) with d to the right is clockwise from above for increasing s, d: emit up-facing.
  let area = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    area += sd[k * 2] * sd[j * 2 + 1] - sd[j * 2] * sd[k * 2 + 1];
  }
  for (let k = 1; k < n - 1; k++) {
    if (area > 0) P.tri(first, first + k + 1, first + k);
    else P.tri(first, first + k, first + k + 1);
  }
}

/** A painted turn arrow on a lane ending at arc length s1 (its tip), for the set of turns allowed. */
function turnArrow(P: Geo, pl: Polyline, s1: number, turns: Set<Turn>, h: number) {
  const w = 0.09; // half shaft width
  const s0 = s1 - 3.0;
  const straight = turns.has('straight');
  const shaftEnd = straight ? s1 - 0.9 : s1 - 1.35;
  paintPoly(P, pl, [s0, -w, shaftEnd, -w, shaftEnd, w, s0, w], h);
  if (straight) paintPoly(P, pl, [s1 - 0.95, -0.34, s1, 0, s1 - 0.95, 0.34], h);
  for (const t of ['left', 'right'] as const) {
    if (!turns.has(t)) continue;
    const sg = t === 'right' ? 1 : -1;
    const sb = s1 - 1.75;
    // a short arm out to the side, then its head
    paintPoly(P, pl, [sb - w, 0, sb + 0.55, sg * 0.5, sb + 0.55 + w * 1.6, sg * 0.5 - sg * w * 1.2, sb + w, -sg * w * 0.2], h);
    paintPoly(P, pl, [sb + 0.25, sg * 0.42, sb + 0.95, sg * 0.82, sb + 0.95, sg * 0.3], h);
  }
}

/** Build every ground surface of the plan into g (and the paint into P). */
export async function buildGround(g: Geo, P: Geo, plan: CityPlan, index: CityIndex, tick: () => Promise<void>): Promise<void> {
  const pivot = (x: number, z: number) => {
    toSphere(x, z, 0, g.pivot);
    P.pivot.x = g.pivot.x;
    P.pivot.y = g.pivot.y;
    P.pivot.z = g.pivot.z;
  };

  // ── Areas (lowest layer) ──
  for (const a of plan.areas) {
    let cx = 0, cz = 0;
    const n = a.outline.length >> 1;
    for (let i = 0; i < n; i++) {
      cx += a.outline[i * 2];
      cz += a.outline[i * 2 + 1];
    }
    pivot(cx / n, cz / n);
    const h = a.h ?? (a.kind === 'water' ? AREA_H + 0.02 : AREA_H);
    g.param = 0;
    if (a.kind === 'water') {
      g.color.copy(C.water);
      g.kind = K.water;
      fillPolygon(g, a.outline, h);
      continue;
    }
    if (a.kind === 'park' && h > SIDEWALK_TOP) {
      // A raised lawn bed: stone curb face and rim, lawn on top.
      const pl = polyline(Array.from(a.outline), true);
      g.color.copy(C.bedRim);
      g.kind = K.plain;
      band(g, pl, -0.14, SIDEWALK_TOP - 0.02, h + 0.05, -1);
      ribbon(g, pl, -0.14, 0.02, h + 0.05, 1);
      g.color.copy(C.bed);
      g.kind = K.lawn;
      fillPolygon(g, a.outline, h);
      continue;
    }
    if (a.kind === 'park' || a.kind === 'garden' || a.kind === 'field') {
      g.color.copy(a.kind === 'park' ? C.park : C.garden);
      g.kind = K.lawn;
    } else {
      g.color.copy(a.kind === 'plaza' ? C.plaza : C.lot);
      g.kind = K.tiles;
      g.param = a.kind === 'lot' ? 1 : 0;
    }
    fillPolygon(g, a.outline, h);
    await tick();
  }

  await tick();
  // ── Garden paths: gate to front door, as far as the sidewalk ──
  for (const b of plan.buildings) {
    if (b.style !== 'house') continue;
    const c = Math.cos(b.angle);
    const sn = Math.sin(b.angle);
    const u = doorX(b);
    const v0 = -b.d / 2 + 0.3;
    let v1 = -b.d / 2 - 0.5;
    for (let k = 0; k < 24; k++) {
      const x = b.x + u * c - v1 * sn;
      const z = b.z + u * sn + v1 * c;
      if (index.classify(x, z) === 'sidewalk') break;
      v1 -= 0.25;
    }
    const pts = [b.x + u * c - v0 * sn, b.z + u * sn + v0 * c, b.x + u * c - v1 * sn, b.z + u * sn + v1 * c];
    pivot(pts[2], pts[3]);
    g.color.copy(C.plazaPath);
    g.kind = K.tiles;
    g.param = 0;
    ribbon(g, polyline(pts), -0.55, 0.55, AREA_H + 0.012, 1);
  }
  await tick();
  // ── Park and plaza paths, the market lane ──
  const mid = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  for (const w of plan.walkEdges) {
    if (w.kind !== 'park' && w.kind !== 'plaza' && w.kind !== 'footpath') continue;
    const sp = w.path;
    sampleAt(sp, sp.length / 2, mid);
    pivot(mid.x, mid.z);
    const h = index.groundH(mid.x, mid.z) + 0.008;
    if (w.kind === 'footpath') {
      g.color.copy(C.lane);
      g.kind = K.tiles;
      g.param = 2;
      ribbon(g, sp, -w.width / 2, w.width / 2, h, 2);
      continue;
    }
    g.color.copy(w.kind === 'park' ? C.gravel : C.plazaPath);
    g.kind = w.kind === 'park' ? K.plain : K.tiles;
    g.param = 0;
    ribbon(g, sp, -w.width / 2, w.width / 2, h, 1);
  }

  await tick();
  // ── Carriageways (tucked 5 cm under the junction patches: no hairline seams) ──
  for (const e of plan.edges) {
    sampleAt(e.centre, e.centre.length / 2, mid);
    pivot(mid.x, mid.z);
    g.color.copy(C.asphalt);
    g.kind = K.asphalt;
    g.param = e.width / 2; // the shader's night glow profile across the road
    ribbon(g, extend(e.centre, 0.05), -e.width / 2, e.width / 2, ROAD_H, 4);
    await tick();
  }
  await tick();
  // ── Junction patches (same asphalt, so the overlap is invisible) ──
  for (const x of plan.intersections) {
    const n = plan.nodes[x.node];
    pivot(n.x, n.z);
    g.color.copy(C.asphalt);
    g.kind = K.asphalt;
    // uv relative to the node, param = −reach: the shader's night glow is a soft knot here
    g.param = -(n.radius + 2);
    fillPolygon(g, x.outline, ROAD_H, (px, pz) => [px - n.x, pz - n.z]);
    await tick();
  }

  await tick();
  // ── Sidewalks along edges: slab top, kerb stones, curb face, outer face ──
  for (const e of plan.edges) {
    if (e.sidewalk <= 0) continue;
    sampleAt(e.centre, e.centre.length / 2, mid);
    pivot(mid.x, mid.z);
    const pl = extend(e.centre, 0.03);
    sidewalkStrip(g, pl, e.width / 2, e.width / 2 + e.sidewalk, 1);
    sidewalkStrip(g, pl, -e.width / 2, -(e.width / 2 + e.sidewalk), -1);
    await tick();
  }
  await tick();
  // ── Corner sidewalks round each junction's rounded curbs; the ring round each turning circle ──
  for (const node of plan.nodes) {
    const arms = armsOf(plan, node.id);
    pivot(node.x, node.z);
    if (arms.length === 1) {
      const o = plan.intersections[node.id].outline;
      // the outline is [left curb, right curb, arc…]: the arc from the right curb round to the left
      const pts: number[] = [];
      for (let k = 2; k < o.length; k += 2) pts.push(o[k], o[k + 1]);
      pts.push(o[0], o[1]);
      const pl = polyline(pts);
      sampleAt(pl, pl.length / 2, mid);
      const inside = pointInPolygon(o, mid.x - mid.tz * 0.5, mid.z + mid.tx * 0.5);
      const sw = arms[0].e.sidewalk;
      sidewalkStrip(g, pl, 0, inside ? -sw : sw, inside ? -1 : 1);
      continue;
    }
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      const b = arms[(i + 1) % arms.length];
      const rx = a.px + a.rx * a.half;
      const rz = a.pz + a.rz * a.half;
      const bx = b.px - b.rx * b.half;
      const bz = b.pz - b.rz * b.half;
      if (Math.hypot(bx - rx, bz - rz) < 0.05) continue;
      const fl = polyline(cornerPoints(rx, rz, a.ux, a.uz, bx, bz, b.ux, b.uz));
      const sw = Math.min(a.e.sidewalk, b.e.sidewalk);
      sidewalkStrip(g, fl, 0, -sw, -1);
    }
    await tick();
  }

  await tick();
  // ── Paint ──
  P.kind = K.plain;
  P.param = 7; // road paint: the shader lets the night glow show through it from high up
  for (const e of plan.edges) {
    sampleAt(e.centre, e.centre.length / 2, mid);
    pivot(mid.x, mid.z);
    P.color.copy(C.yellow);
    const L = e.centre.length;
    const cutA = plan.nodes[e.a].kind === 'bend' ? 0 : 3.6;
    const cutB = plan.nodes[e.b].kind === 'bend' ? 0 : 3.6;
    if (L - cutA - cutB > 1) {
      const run = subPath(e.centre, cutA, L - cutB);
      if (e.kind === 'ring') {
        ribbon(P, run, -0.2, -0.08, PAINT_H, 1);
        ribbon(P, run, 0.08, 0.2, PAINT_H, 1);
      } else {
        const dash = 2.2;
        for (let s = 4.6; s + dash < L - 4.6; s += dash * 2) ribbon(P, subPath(e.centre, s, s + dash), -0.075, 0.075, PAINT_H, 1);
      }
      P.color.copy(C.white);
      ribbon(P, run, -e.width / 2 + 0.25, -e.width / 2 + 0.37, PAINT_H, 1);
      ribbon(P, run, e.width / 2 - 0.37, e.width / 2 - 0.25, PAINT_H, 1);
    }
    await tick();
  }
  // Zebra crossings.
  const near = { dist: 0, s: 0 };
  for (const w of plan.walkEdges) {
    if (w.kind !== 'crossing' || w.road === undefined) continue;
    const e = plan.edges[w.road];
    const m = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
    sampleAt(w.path, w.path.length / 2, m);
    nearestOn(e.centre, m.x, m.z, near);
    const c = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
    sampleAt(e.centre, near.s, c);
    pivot(c.x, c.z);
    P.color.copy(C.white);
    const half = w.width / 2;
    const span = e.width / 2 - 0.35;
    const q = subPath(e.centre, near.s - half, near.s + half);
    for (let d = -span; d + 0.45 <= span + 1e-6; d += 0.9) ribbon(P, q, d, d + 0.45, PAINT_H + 0.002, 1);
  }
  await tick();
  // Stop lines (from the centre line to the inner edge of the edge line) and turn arrows.
  for (const l of plan.lanes) {
    if (l.crossingAtEnd < 0) continue;
    const e = plan.edges[l.edge];
    const off = Math.abs(l.offset);
    const q = subPath(l.path, l.stopS - 0.4, l.stopS);
    sampleAt(q, 0, mid);
    pivot(mid.x, mid.z);
    P.color.copy(C.white);
    ribbon(P, q, -off + 0.24, e.width / 2 - 0.38 - off, PAINT_H + 0.002, 1);
    const turns = new Set<Turn>();
    for (const cid of l.next) turns.add(plan.connectors[cid].turn);
    turns.delete('uturn');
    if (turns.size && l.stopS > 9) turnArrow(P, l.path, l.stopS - 2.2, turns, PAINT_H + 0.002);
  }
  await tick();
  // Dashed guide lines through the big junctions, continuing the major road's centre line.
  for (const node of plan.nodes) {
    if (node.kind !== 'junction' || node.radius < 5) continue;
    const arms = armsOf(plan, node.id);
    let best: [number, number] | null = null;
    let bd = -0.35;
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const d = -(arms[i].ux * arms[j].ux + arms[i].uz * arms[j].uz);
        const rank = (arms[i].e.kind === 'ring' ? 1 : 0) + (arms[j].e.kind === 'ring' ? 1 : 0);
        if (d + rank * 0.5 > bd) {
          bd = d + rank * 0.5;
          best = [i, j];
        }
      }
    }
    if (!best) continue;
    const a = arms[best[0]];
    const b = arms[best[1]];
    const pl = polyline(hermitePoints(a.px, a.pz, -a.ux, -a.uz, b.px, b.pz, b.ux, b.uz, 0.4, 0.45));
    pivot(node.x, node.z);
    P.color.copy(C.yellow);
    for (let s = 0.6; s + 0.9 < pl.length - 0.4; s += 1.8) ribbon(P, subPath(pl, s, s + 0.9), -0.07, 0.07, PAINT_H, 1);
  }
}

/**
 * One sidewalk strip between lateral offsets dCurb (the road side) and dOut (the block side) of a
 * path, with the slab top, a kerb-stone edge, the curb face toward the road and the outer face.
 */
function sidewalkStrip(g: Geo, pl: Polyline, dCurb: number, dOut: number, side: 1 | -1) {
  const kerb = 0.18 * side;
  g.color.copy(C.sidewalk);
  g.kind = K.sidewalk;
  g.param = 0;
  if (side > 0) ribbon(g, pl, dCurb + kerb, dOut, SIDEWALK_TOP, 1);
  else ribbon(g, pl, dOut, dCurb + kerb, SIDEWALK_TOP, 1);
  g.color.copy(C.kerb);
  g.kind = K.plain;
  if (side > 0) ribbon(g, pl, dCurb, dCurb + kerb, SIDEWALK_TOP, 1);
  else ribbon(g, pl, dCurb + kerb, dCurb, SIDEWALK_TOP, 1);
  g.color.copy(C.curb);
  band(g, pl, dCurb, ROAD_H - 0.03, SIDEWALK_TOP, side > 0 ? -1 : 1);
  band(g, pl, dOut, -0.06, SIDEWALK_TOP, side);
}

function subPath(pl: Polyline, s0: number, s1: number): Polyline {
  const a = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  const pts: number[] = [];
  const steps = Math.max(1, Math.ceil((s1 - s0) / 0.8));
  for (let k = 0; k <= steps; k++) {
    sampleAt(pl, s0 + ((s1 - s0) * k) / steps, a);
    pts.push(a.x, a.z);
  }
  return polyline(pts);
}
