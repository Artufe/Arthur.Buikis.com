// Road routing over the base terrain (R1): A* on a strip grid laid along the great circle between
// two points (u along it, v across, CELL metres), with costs for slope, turns, water (bridges where
// allowed) and keep-out zones, then string-pulled and smoothed into a C1 curve. Pure, boot-time.
// Heights are sampled lazily per grid cell, so a route costs only the cells A* actually opens.

import { R } from '../config';
import { normalize3, v3, type Vec3 } from '../sphere';

export interface RouteSpec {
  /** Start and end (unit directions) and the unit tangents to leave a along / arrive at b along. */
  a: Vec3;
  b: Vec3;
  ta?: Vec3;
  tb?: Vec3;
  /** Straight lead-in / lead-out along ta / tb before the search takes over (m). */
  lead?: number;
  /** Grid cell (m) and the strip's half width across the great circle (m). */
  cell: number;
  halfWidth: number;
  /**
   * Instead of the strip along the great circle a → b: a POLAR band round `centre` (roads that go
   * round the capital's plateau): u = arc along the circle of angular radius `theta0` (rad) in the
   * direction `sign` (+1 = clockwise seen from above, i.e. increasing plan angle), v = metres
   * outward from it, the band spanning [vMin, vMax].
   */
  polar?: { centre: Vec3; theta0: number; sign: 1 | -1; vMin: number; vMax: number };
  /** Base terrain height (m) at a unit direction. */
  height(d: Vec3): number;
  /** Extra cost per metre at a point (≥ 0), or Infinity where the road may not go. */
  keepOut(d: Vec3, h: number): number;
  /** Water (base height below this) is forbidden unless bridges are allowed. */
  waterH: number;
  bridges: boolean;
  /** Laplacian relaxation passes on the smoothed curve (default 50; 0 for none). */
  relax?: number;
  /** Cost multiplier per metre over water when bridges are allowed, and per bridge started. */
  waterCost?: number;
  bridgeStart?: number;
}

export interface RouteResult {
  /** Smoothed centreline: unit directions xyz interleaved, ≤ ~0.6 m apart. */
  dirs: number[];
  /** Cells opened by A* (perf). */
  opened: number;
  ok: boolean;
}

// 8 neighbours: (du, dv) and step length factor.
const DU = [1, 1, 0, -1, -1, -1, 0, 1];
const DV = [0, 1, 1, 1, 0, -1, -1, -1];
const LEN = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

/** A routing frame: (u, v) metres ↦ unit direction and back. */
export interface Frame {
  at(u: number, v: number, out: Vec3): Vec3;
  uv(d: Vec3, out: { u: number; v: number }): { u: number; v: number };
}

/**
 * A polar frame round unit `c`: u = sign · (plan angle − angle of `a`) · R sin θ0, v = (θ − θ0) · R,
 * where θ is the angle from c and the plan angle is measured in c's tangent frame (east, south).
 */
export class Polar implements Frame {
  readonly e: Vec3;
  readonly s: Vec3;
  readonly phiA: number;
  readonly c: Vec3;
  readonly theta0: number;
  readonly sign: 1 | -1;
  constructor(c: Vec3, theta0: number, sign: 1 | -1, a: Vec3) {
    this.c = c;
    this.theta0 = theta0;
    this.sign = sign;
    const e = v3();
    const n = v3();
    tangentFrameLocal(c, e, n);
    this.e = e;
    this.s = v3(-n.x, -n.y, -n.z);
    this.phiA = Math.atan2(dotv(a, this.s), dotv(a, this.e));
  }
  at(u: number, v: number, out: Vec3): Vec3 {
    const th = this.theta0 + v / R;
    const phi = this.phiA + (this.sign * u) / (R * Math.sin(this.theta0));
    const st = Math.sin(th), ct = Math.cos(th);
    const cp = Math.cos(phi), sp = Math.sin(phi);
    out.x = this.c.x * ct + (this.e.x * cp + this.s.x * sp) * st;
    out.y = this.c.y * ct + (this.e.y * cp + this.s.y * sp) * st;
    out.z = this.c.z * ct + (this.e.z * cp + this.s.z * sp) * st;
    return out;
  }
  uv(d: Vec3, out: { u: number; v: number }): { u: number; v: number } {
    const th = Math.acos(Math.max(-1, Math.min(1, dotv(d, this.c))));
    let dphi = (Math.atan2(dotv(d, this.s), dotv(d, this.e)) - this.phiA) * this.sign;
    // unwrap into (−π/2, 3π/2): routes go less than ¾ of the way round
    while (dphi < -Math.PI / 2) dphi += Math.PI * 2;
    while (dphi >= Math.PI * 1.5) dphi -= Math.PI * 2;
    out.u = dphi * R * Math.sin(this.theta0);
    out.v = (th - this.theta0) * R;
    return out;
  }
}

const dotv = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
function tangentFrameLocal(up: Vec3, e: Vec3, n: Vec3) {
  if (Math.abs(up.y) > 0.999999) {
    e.x = 1 - up.x * up.x;
    e.y = -up.x * up.y;
    e.z = -up.x * up.z;
  } else {
    e.x = up.z;
    e.y = 0;
    e.z = -up.x;
  }
  normalize3(e);
  n.x = up.y * e.z - up.z * e.y;
  n.y = up.z * e.x - up.x * e.z;
  n.z = up.x * e.y - up.y * e.x;
}

/** A strip frame along the great circle a → b: (u, v) metres ↦ unit direction. */
export class Strip implements Frame {
  readonly a: Vec3;
  readonly t: Vec3; // unit tangent at a toward b
  readonly n: Vec3; // unit normal of the great circle (across, to the left of a → b seen from above)
  readonly len: number; // great-circle length a → b at sea level (m)
  constructor(a: Vec3, b: Vec3) {
    this.a = a;
    const c = a.x * b.x + a.y * b.y + a.z * b.z;
    let tx = b.x - a.x * c, ty = b.y - a.y * c, tz = b.z - a.z * c;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    this.t = v3(tx, ty, tz);
    // n = a × t
    this.n = v3(a.y * tz - a.z * ty, a.z * tx - a.x * tz, a.x * ty - a.y * tx);
    this.len = Math.atan2(tl, c) * R;
  }
  /** (u, v) in metres at sea level → unit direction. */
  at(u: number, v: number, out: Vec3): Vec3 {
    const pu = u / R;
    const pv = v / R;
    const cu = Math.cos(pu), su = Math.sin(pu);
    const cv = Math.cos(pv), sv = Math.sin(pv);
    out.x = (this.a.x * cu + this.t.x * su) * cv + this.n.x * sv;
    out.y = (this.a.y * cu + this.t.y * su) * cv + this.n.y * sv;
    out.z = (this.a.z * cu + this.t.z * su) * cv + this.n.z * sv;
    return out;
  }
  /** Unit direction → (u, v) metres. */
  uv(d: Vec3, out: { u: number; v: number }): { u: number; v: number } {
    const sv = d.x * this.n.x + d.y * this.n.y + d.z * this.n.z;
    out.v = Math.asin(Math.max(-1, Math.min(1, sv))) * R;
    const x = d.x * this.a.x + d.y * this.a.y + d.z * this.a.z;
    const y = d.x * this.t.x + d.y * this.t.y + d.z * this.t.z;
    out.u = Math.atan2(y, x) * R;
    return out;
  }
}

/** Binary min-heap of (key, value) pairs in typed arrays. */
class Heap {
  k = new Float64Array(1024);
  v = new Int32Array(1024);
  n = 0;
  push(key: number, val: number) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2);
      k.set(this.k);
      this.k = k;
      const v = new Int32Array(this.n * 2);
      v.set(this.v);
      this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0];
    const key = this.k[--this.n];
    const val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = key;
    this.v[i] = val;
    return top;
  }
}

/** The search frame of a route: its strip (or polar band), grid origin and size, and the lead points. */
function frameOf(spec: RouteSpec) {
  const lead = spec.lead ?? 0;
  const a0 = spec.a;
  const b0 = spec.b;
  // Lead-in / lead-out points: the search runs between them.
  const a = lead && spec.ta ? step(a0, spec.ta, lead) : a0;
  const b = lead && spec.tb ? step(b0, spec.tb, -lead) : b0;
  const C = spec.cell;
  let strip: Frame;
  let u0: number, v0: number, nu: number, nv: number;
  if (spec.polar) {
    const P = spec.polar;
    strip = new Polar(P.centre, P.theta0, P.sign, a);
    const ub = strip.uv(b, { u: 0, v: 0 }).u;
    const margin = 4 * C;
    u0 = Math.min(0, ub) - margin;
    nu = Math.ceil((Math.abs(ub) + 2 * margin) / C) + 1;
    v0 = P.vMin;
    nv = Math.ceil((P.vMax - P.vMin) / C) + 1;
  } else {
    const st = new Strip(a, b);
    strip = st;
    const margin = Math.max(3 * C, spec.halfWidth * 0.5);
    nu = Math.ceil((st.len + 2 * margin) / C) + 1;
    nv = Math.ceil((2 * spec.halfWidth) / C) + 1;
    u0 = -margin;
    v0 = -spec.halfWidth;
  }
  return { a0, b0, a, b, C, strip, u0, v0, nu, nv };
}

export function route(spec: RouteSpec): RouteResult {
  const s = routeSearch(spec);
  return { dirs: s.ctrl ? routeFinish(spec, s.ctrl) : [], opened: s.opened, ok: !!s.ctrl };
}

/**
 * The costly half of a route: A* and string pulling, down to the control polygon in the route's
 * frame ((u, v) metres interleaved, from a through the lead points to b), or null when there is no
 * way. routeFinish() turns it into the smooth centreline (cheap, deterministic: the region memo
 * caches the polygon, world/region/bake.ts).
 */
export function routeSearch(spec: RouteSpec): { ctrl: number[] | null; opened: number } {
  const { a0, b0, a, b, C, strip, u0, v0, nu, nv } = frameOf(spec);
  const NC = nu * nv;
  const H = new Float32Array(NC).fill(NaN);
  const K = new Float32Array(NC).fill(NaN);
  const d = v3();
  const cellH = (c: number) => {
    let h = H[c];
    if (h !== h) {
      strip.at(u0 + (c % nu) * C, v0 + Math.floor(c / nu) * C, d);
      h = H[c] = spec.height(d);
      const water = h < spec.waterH;
      K[c] = water && !spec.bridges ? Infinity : spec.keepOut(d, h) + (water ? spec.waterCost ?? 6 : 0);
    }
    return h;
  };
  const toCell = (p: Vec3) => {
    const q = strip.uv(p, { u: 0, v: 0 });
    const i = Math.max(0, Math.min(nu - 1, Math.round((q.u - u0) / C)));
    const j = Math.max(0, Math.min(nv - 1, Math.round((q.v - v0) / C)));
    return j * nu + i;
  };
  const start = toCell(a);
  const goal = toCell(b);
  const gi = goal % nu;
  const gj = Math.floor(goal / nu);
  // State = cell · 8 + arriving direction.
  const G = new Float64Array(NC * 8).fill(Infinity);
  const from = new Int32Array(NC * 8).fill(-1);
  const closed = new Uint8Array(NC * 8);
  const heap = new Heap();
  // (weighted A*: a 1.35× heuristic opens far fewer cells for a path within a few % of the best)
  const heur = (c: number) => Math.hypot((c % nu) - gi, Math.floor(c / nu) - gj) * C * 1.35;
  cellH(start);
  // Initial heading from ta (if any): pick the closest of the 8 grid directions.
  let dir0 = 0;
  if (spec.ta) {
    const q0 = strip.uv(a, { u: 0, v: 0 });
    const q1 = strip.uv(step(a, spec.ta, 3), { u: 0, v: 0 });
    dir0 = Math.round(Math.atan2(q1.v - q0.v, q1.u - q0.u) / (Math.PI / 4));
    dir0 = ((dir0 % 8) + 8) % 8;
  }
  G[start * 8 + dir0] = 0;
  heap.push(heur(start), start * 8 + dir0);
  let opened = 0;
  let found = -1;
  const bridgeStart = spec.bridgeStart ?? 30;
  while (heap.n) {
    const s = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const c = s >> 3;
    const k0 = s & 7;
    if (c === goal) {
      found = s;
      break;
    }
    opened++;
    const ci = c % nu;
    const cj = Math.floor(c / nu);
    const hc = cellH(c);
    const gc = G[s];
    const wc = hc < spec.waterH;
    for (let k = 0; k < 8; k++) {
      // No sharp turns: at most 90° per step.
      let dk = k - k0;
      dk = ((dk + 12) % 8) - 4;
      if (dk > 2 || dk < -2) continue;
      const ni = ci + DU[k];
      const nj = cj + DV[k];
      if (ni < 0 || nj < 0 || ni >= nu || nj >= nv) continue;
      const nc = nj * nu + ni;
      const ns = nc * 8 + k;
      if (closed[ns]) continue;
      const hn = cellH(nc);
      const kc = K[nc];
      if (kc === Infinity) continue;
      const L = LEN[k] * C;
      const wn = hn < spec.waterH;
      const grade = wn || wc ? 0 : Math.abs(hn - hc) / L;
      let cost = L * (1 + kc + 26 * grade * grade + (grade > 0.14 ? 8 * (grade - 0.14) : 0));
      cost += dk === 0 ? 0 : (dk === 1 || dk === -1 ? 0.35 : 1.6) * C;
      if (wn && !wc) cost += bridgeStart;
      const g = gc + cost;
      if (g < G[ns]) {
        G[ns] = g;
        from[ns] = s;
        heap.push(g + heur(nc), ns);
      }
    }
  }
  if (found < 0) {
    if (process.env.LB_ROUTE_DEBUG) {
      const si = start % nu, sj = Math.floor(start / nu);
      const rows: string[] = [];
      for (let j = nv - 1; j >= 0; j--) {
        let row = '';
        for (let i = 0; i < nu; i++) {
          const c = j * nu + i;
          const k = K[c];
          row += c === start ? 'S' : c === goal ? 'G' : k !== k ? ' ' : k === Infinity ? (H[c] < spec.waterH ? '~' : '#') : '.';
        }
        rows.push(row);
      }
      console.log('[route] start', si, sj, 'of', nu, nv, 'dir0', dir0, 'goal', gi, gj);
      console.log(rows.join('\n'));
    }
    return { ctrl: null, opened };
  }
  // Cell path back to the start.
  const cellsRev: number[] = [];
  for (let s = found; s >= 0; s = from[s]) cellsRev.push(s >> 3);
  const cells = cellsRev.reverse();
  // Control polygon in (u, v): a0, a, the pulled path, b, b0.
  const uv: number[] = [];
  const push = (p: Vec3) => {
    const q = strip.uv(p, { u: 0, v: 0 });
    uv.push(q.u, q.v);
  };
  push(a0);
  if (a !== a0) push(a);
  const pulled = pull(cells, nu, C, u0, v0, (c) => K[c] === Infinity || (H[c] === H[c] && H[c] < spec.waterH && !spec.bridges), cellH, toCellUV);
  function toCellUV(u: number, v: number) {
    const i = Math.max(0, Math.min(nu - 1, Math.round((u - u0) / C)));
    const j = Math.max(0, Math.min(nv - 1, Math.round((v - v0) / C)));
    return j * nu + i;
  }
  for (let i = 0; i < pulled.length; i += 2) {
    // skip points within half a cell of the previous control point
    const pu = uv[uv.length - 2], pv = uv[uv.length - 1];
    if (Math.hypot(pulled[i] - pu, pulled[i + 1] - pv) < C * 0.75) continue;
    uv.push(pulled[i], pulled[i + 1]);
  }
  if (b !== b0) {
    const q = strip.uv(b, { u: 0, v: 0 });
    const pu = uv[uv.length - 2], pv = uv[uv.length - 1];
    if (Math.hypot(q.u - pu, q.v - pv) < C * 0.75) uv.length -= 2;
    uv.push(q.u, q.v);
  }
  {
    const q = strip.uv(b0, { u: 0, v: 0 });
    uv.push(q.u, q.v);
  }
  return { ctrl: uv, opened };
}

/** The smooth centreline (unit directions, xyz interleaved, ≤ ~0.6 m apart) through a route's control polygon. */
export function routeFinish(spec: RouteSpec, ctrl: ArrayLike<number>): number[] {
  const { strip } = frameOf(spec);
  const smooth = relax(curve(Array.from(ctrl)), 3, spec.relax ?? 50);
  const d = v3();
  const dirs: number[] = [];
  for (let i = 0; i < smooth.length; i += 2) {
    strip.at(smooth[i], smooth[i + 1], d);
    dirs.push(d.x, d.y, d.z);
  }
  return dirs;
}

/** Walk `m` metres from unit p along unit tangent t (great circle). */
export function step(p: Vec3, t: Vec3, m: number): Vec3 {
  const a = m / R;
  return normalize3(v3(p.x * Math.cos(a) + t.x * Math.sin(a), p.y * Math.cos(a) + t.y * Math.sin(a), p.z * Math.cos(a) + t.z * Math.sin(a)));
}

/**
 * String-pull a cell path: from each kept point, jump to the farthest later cell whose straight line
 * stays on allowed cells (sampled every half cell), not across water when the path did not cross it
 * there, and never more than 6 cells of height change off the path's own profile.
 */
function pull(
  cells: number[],
  nu: number,
  C: number,
  u0: number,
  v0: number,
  blocked: (c: number) => boolean,
  cellH: (c: number) => number,
  toCell: (u: number, v: number) => number,
): number[] {
  const U = (c: number) => u0 + (c % nu) * C;
  const V = (c: number) => v0 + Math.floor(c / nu) * C;
  const out: number[] = [];
  let i = 0;
  out.push(U(cells[0]), V(cells[0]));
  while (i < cells.length - 1) {
    let best = i + 1;
    for (let j = Math.min(cells.length - 1, i + 24); j > i + 1; j--) {
      const au = U(cells[i]), av = V(cells[i]);
      const bu = U(cells[j]), bv = V(cells[j]);
      const L = Math.hypot(bu - au, bv - av);
      const n = Math.ceil(L / (C * 0.5));
      let ok = true;
      // Height along the line must stay near the straight interpolation of the path's own cells
      // (no shortcut over a hill the search went round).
      const ha = cellH(cells[i]);
      const hb = cellH(cells[j]);
      for (let k = 1; k < n && ok; k++) {
        const f = k / n;
        const c = toCell(au + (bu - au) * f, av + (bv - av) * f);
        if (blocked(c)) ok = false;
        else if (Math.abs(cellH(c) - (ha + (hb - ha) * f)) > 1.2) ok = false;
      }
      if (ok) {
        best = j;
        break;
      }
    }
    i = best;
    out.push(U(cells[i]), V(cells[i]));
  }
  return out;
}

/**
 * A C1 curve through a control polygon (u, v interleaved): corners are rounded with circular-ish
 * fillets (quadratic Béziers between edge midpoints, with the ends pinned), sampled ≤ 0.5 m.
 */
function curve(ctrl: number[]): number[] {
  const n = ctrl.length >> 1;
  if (n < 3) return lineSamples(ctrl);
  const out: number[] = [];
  const P = (i: number, c: 0 | 1) => ctrl[i * 2 + c];
  // Chaikin-like corner cutting with quadratic Béziers: segment i runs from M(i−1, i) to M(i, i+1)
  // with control point P(i), where M are points on the edges a fraction away from each corner.
  const cut = (i: number, j: number, near: number): [number, number] => {
    // point on edge i → j at distance min(near, 0.5 · |ij|) from i; on the first and last edges (the
    // straight leads out of the end nodes, which no other corner shares) up to all but 1.5 m of it
    const dx = P(j, 0) - P(i, 0), dz = P(j, 1) - P(i, 1);
    const L = Math.hypot(dx, dz) || 1;
    const end = j === 0 || j === n - 1;
    const t = Math.min(end ? Math.max(0.5, 1 - 1.5 / L) : 0.5, near / L);
    return [P(i, 0) + dx * t, P(i, 1) + dz * t];
  };
  out.push(P(0, 0), P(0, 1));
  for (let i = 1; i < n - 1; i++) {
    const r = 14; // fillet reach (m): larger = rounder
    const m0 = cut(i, i - 1, r);
    const m1 = cut(i, i + 1, r);
    // straight from the last output point to m0
    const lx = out[out.length - 2], lz = out[out.length - 1];
    const L = Math.hypot(m0[0] - lx, m0[1] - lz);
    const ks = Math.ceil(L / 0.5);
    for (let k = 1; k <= ks; k++) out.push(lx + ((m0[0] - lx) * k) / ks, lz + ((m0[1] - lz) * k) / ks);
    const arc = Math.hypot(P(i, 0) - m0[0], P(i, 1) - m0[1]) + Math.hypot(m1[0] - P(i, 0), m1[1] - P(i, 1));
    const ka = Math.max(2, Math.ceil(arc / 0.5));
    for (let k = 1; k <= ka; k++) {
      const t = k / ka;
      const u = 1 - t;
      out.push(u * u * m0[0] + 2 * u * t * P(i, 0) + t * t * m1[0], u * u * m0[1] + 2 * u * t * P(i, 1) + t * t * m1[1]);
    }
  }
  const lx = out[out.length - 2], lz = out[out.length - 1];
  const ex = P(n - 1, 0), ez = P(n - 1, 1);
  const L = Math.hypot(ex - lx, ez - lz);
  const ks = Math.max(1, Math.ceil(L / 0.5));
  for (let k = 1; k <= ks; k++) out.push(lx + ((ex - lx) * k) / ks, lz + ((ez - lz) * k) / ks);
  return out;
}

/**
 * Round what the fillets left tight: three running-average passes (≈ a Gaussian, σ ≈ 0.3 ·
 * `passes`·0.1 m) over a dense (≤ 0.5 m) polyline, the window shrinking toward the ends so the
 * first and last `keep` samples (the lead-in and lead-out) stay put. Bends open to ≳ 6 m radius.
 */
function relax(pts: number[], keep: number, passes: number): number[] {
  const n = pts.length >> 1;
  if (passes <= 0 || n < 2 * keep + 3) return pts;
  const w = Math.max(1, Math.round(passes / 8)); // half window in samples (50 → 6: ±3 m)
  let a = Float64Array.from(pts);
  let b = new Float64Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      // symmetric window, shrinking near the ends (pinned: radius 0 at the end samples)
      const r = Math.min(w, Math.max(0, i - keep + 1), Math.max(0, n - keep - i));
      let sx = 0, sz = 0;
      for (let j = i - r; j <= i + r; j++) {
        sx += a[j * 2];
        sz += a[j * 2 + 1];
      }
      b[i * 2] = sx / (2 * r + 1);
      b[i * 2 + 1] = sz / (2 * r + 1);
    }
    const t = a;
    a = b;
    b = t;
  }
  return Array.from(a);
}

function lineSamples(ctrl: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < ctrl.length; i += 2) {
    const L = Math.hypot(ctrl[i + 2] - ctrl[i], ctrl[i + 3] - ctrl[i + 1]);
    const k = Math.max(1, Math.ceil(L / 0.5));
    for (let j = i === 0 ? 0 : 1; j <= k; j++) out.push(ctrl[i] + ((ctrl[i + 2] - ctrl[i]) * j) / k, ctrl[i + 1] + ((ctrl[i + 3] - ctrl[i + 1]) * j) / k);
  }
  return out;
}
