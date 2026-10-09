// The region's terrain carve and surface classification (types.ts Region.carve / surface): a list of
// primitives (pads, plazas, runways as flat discs or capsules; road beds as capsule chains) in a
// dense 3D grid round the planet (CELL-metre cubes; only those the sea-level sphere passes through
// hold anything), so a query costs one array lookup and, off the network, nothing else. Pure,
// zero-alloc per query.
//
// A primitive pulls the terrain toward its target height with weight w(d): 1 inside its core
// (distance ≤ core), easing to 0 across a batter of width blend + BATTER · |target − base| (deep
// cuts and tall fills get wider, gentler banks: the bank's slope stays under ~1.5 / BATTER). The
// primitives of one road (its segments) form a GROUP that acts once: its segments share the pull by
// soft-minimum weights (a partition of unity: no double count at the joints, no step where the
// nearest segment switches, e.g. inside a hairpin). Groups apply in insertion order (pads first,
// then roads); a later group's bank never re-shapes an earlier group's core (CORE_GUARD).

import { R } from '../config';
import type { Vec3 } from '../sphere';
import { KEEP_MARGIN_MAX, type RegionClass, type SurfaceHit } from './types';

/** Grid cell size (m) and cells per axis (the cube round the sea-level sphere, plus a margin). */
const CELL = 6;
const G = Math.ceil((2 * R) / CELL) + 2;
const ORIGIN = -R - CELL;
/** Batter widening per metre of cut / fill, and the cut / fill depth (m) beyond which it stops widening. */
export const BATTER = 2.6;
export const BATTER_CAP = 6;
/** A pad's cap: a town cut into a mountainside (the alpine village) needs the longer bank. */
export const PAD_BATTER_CAP = 13;
/** v2 (R2): a town pad's fill depth (m) past which its bank stops widening (cuts keep PAD_BATTER_CAP). */
export const PAD_FILL_CAP = 2.5;
/**
 * Soft-minimum width (m) for a group's target height (see carve()): SOFT_NEAR on the carriageway (the
 * neighbours along the road blend in, so on the inside of a tight, climbing bend the bed never steps
 * where the nearest segment switches), widening by SOFT_K per metre past the core (a bank blends the
 * passes of the road near it: inside a hairpin's bend its whole arc, between its legs, metres apart
 * in height, one S-curve from bed to bed).
 */
const SOFT_NEAR = 1.5;
const SOFT_K = 0.8;
/**
 * v2 (R2): past the core the soft minimum hands over (within SHEP_IN m) to an inverse-distance blend
 * of the group's segments: weight ∝ 1 / r², r = (distance past the core + SHEP_A) / (the nearest's +
 * SHEP_A), cut off at r = SHEP_R. Per segment the square (summed along a pass, ∝ 1 / its distance: an
 * inverse-distance blend of the passes, whose many far segments never outweigh the near ones). Between
 * two legs of a hairpin metres apart in height the bank is then close to a straight slope from bed to
 * bed (the soft minimum alone bunched the climb into a few metres: a wall); beside one road it is the
 * soft minimum's nearest stretch, as before.
 */
const SHEP_IN = 3;
const SHEP_A = 3;
const SHEP_R = 12;
/** A cut's own bank (a sea wall) applies where the natural ground is below CUT_WET m, the pad's ordinary bank above CUT_DRY. */
const CUT_WET = -0.2;
const CUT_DRY = 0.8;
/** Metres past a core's edge over which later groups' banks fade back in (see carve()). */
const CORE_GUARD = 4;

/**
 * v2 (R2): Basin — a harbour's dredged water in front of its quay: it only ever LOWERS the ground (to
 * its target, below the sea), never fills, never locks; a later pad's sea wall drops into it.
 */
export const PrimKind = { Pad: 0, Plaza: 1, Runway: 2, Road: 3, Basin: 4 } as const;
export type PrimKind = (typeof PrimKind)[keyof typeof PrimKind];

const CLS: RegionClass[] = ['pad', 'plaza', 'runway', 'road', 'free'];

/**
 * A bridge abutment for a road segment near a span (R1): the plane through the span's end, its unit
 * normal `n` (tangent to the sphere there, pointing into the span) and `off` = n · (the end's unit
 * direction). Past the plane the segment's influence fades within ABUT_FADE m, so the causeway ends in
 * a short bank under the deck instead of filling the water the bridge crosses.
 */
export interface Abutment {
  n: Vec3;
  off: number;
  /** Effective-distance growth per metre past the plane (default ABUT_K). */
  k?: number;
}
/** Metres past an abutment plane over which a segment's fill fades out (its effective distance grows ABUT_K× as fast). */
export const ABUT_K = 3.5;

export interface CarveBuilder {
  /**
   * A flat disc (pads, plazas, aprons). `batter` scales the cut / fill widening (1 = BATTER; < 1 steeper
   * banks). `opts` (v2 R2, pads): a tilt (the surface rises `tilt` · (q − c) · R: a world vector, grade ×
   * the unit uphill tangent at c), a cut (the disc minus a bite on its seaward side: a great-circle
   * line with unit normal `n` pointing out of the pad, or a disc round `b` of radius `r` m) whose edge
   * banks over `cutBlend` m with `cutBatter` (a harbour's sea wall: short and steep).
   */
  disc(kind: PrimKind, c: Vec3, core: number, blend: number, h: number, settlement?: number, batter?: number, dcap?: number, opts?: DiscOpts): void;
  /**
   * A capsule from a to b with target heights ha → hb (road segments, runways). `half` is the
   * carriageway half width (classification: 'road' within it, 'verge' out to the core). `along`
   * (the segment's arc length on its road) is accepted for callers but no longer used.
   */
  capsule(kind: PrimKind, a: Vec3, b: Vec3, core: number, blend: number, ha: number, hb: number, group: number, half?: number, edge?: number, batter?: number, dcap?: number, along?: number, abut?: Abutment | Abutment[]): void;
  /** Start a new group (one road): its segments share one soft-minimum pull. Returns its id. */
  group(): number;
  build(): Carve;
}

export interface DiscOpts {
  tilt?: Vec3;
  /**
   * The pad's seaward cut, in its chart's plan metres (types.ts Settlement.cut): `h` the unit heading
   * tangent at the disc's centre, `f` the cut's distance along it, `r` the bite's radius (Infinity: a
   * straight quay line). Measured in the chart (azimuthal round the centre), so the carve's edge is
   * exactly pad.ts padDist's (a great circle bends ~0.3 m inward at a 50 m quay's ends).
   */
  cut?: { h: Vec3; f: number; r: number };
  cutBlend?: number;
  cutBatter?: number;
  /** v2 (R2 refine): a sea wall's paved apron: the pad within `apron` m inland of its cut is 'plaza' (surface, keepOut). */
  apron?: number;
  /** v2 (R2 refine): this pad's fill banks widen for up to this much fill (default PAD_FILL_CAP): a dry hillside's foot. */
  fillCap?: number;
  /**
   * v2 (R2 refine 2): a sea wall's block (types.ts QuayWall.depth): over the `depth` m inland of a
   * straight cut the pad ramps down from its plane to `low` m at the face, under the wall's solid
   * deck, so the terrain mesh's facets across the face stay behind it (the face stands in the water).
   */
  wallRamp?: { depth: number; low: number };
}

export interface Carve {
  carve(dir: Vec3, base: number): number;
  surface(dir: Vec3, out: SurfaceHit): SurfaceHit;
  /** Keep-out test (types.ts Region.keepOut): within `margin` m of a primitive's core (road: carriageway + verge). */
  keepOut(dir: Vec3, margin: number, mask: number): boolean;
  /** Primitive count (spec / debug). */
  readonly count: number;
  /** Spec / debug: keepOut by brute force over every primitive (no grid, no clamp). */
  keepOutAll(dir: Vec3, margin: number, mask: number): boolean;
  /** Debug: the primitives bucketed in the grid cell of `dir` (kind, distance, reach). */
  debugAt(dir: Vec3): Array<{ p: number; kind: number; dist: number; core: number; reach: number }>;
}

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Debug: when set, carve() appends a line per group it applies. */
export const CARVE_TRACE: { lines: string[] | null } = { lines: null };

/** Grid cell of unit direction (x, y, z), indexed at sea level. */
function cellOf(x: number, y: number, z: number): number {
  let i = Math.floor((x * R - ORIGIN) / CELL);
  let j = Math.floor((y * R - ORIGIN) / CELL);
  let k = Math.floor((z * R - ORIGIN) / CELL);
  i = i < 0 ? 0 : i >= G ? G - 1 : i;
  j = j < 0 ? 0 : j >= G ? G - 1 : j;
  k = k < 0 ? 0 : k >= G ? G - 1 : k;
  return (k * G + j) * G + i;
}

export function carveBuilder(): CarveBuilder {
  const kind: number[] = [];
  const grp: number[] = [];
  const A: number[] = []; // a xyz, b xyz
  // core, blend, ha, hb, half, batter, dcap (the cut / fill depth the batter widens for, ≤ BATTER_CAP:
  // a primitive's reach is bounded, so it only lives in the cells it can touch)
  const P: number[] = [];
  const AB: number[] = []; // up to two abutment planes: nx, ny, nz, off (off NaN: none), k
  const sett: number[] = [];
  const edges: number[] = [];
  // v2 (R2) per primitive: tilt (world vector, 3), cut (type 0 none / 1 line / 2 bite, xyz, r, blend, batter)
  const TL: number[] = [];
  const CU: number[] = [];
  const AP: number[] = [];
  const FCAP: number[] = [];
  const WRD: number[] = [];
  const WRL: number[] = [];
  let groups = 0;

  function add(k: PrimKind, a: Vec3, b: Vec3, core: number, blend: number, ha: number, hb: number, g: number, half: number, s: number, e: number, bt: number, dcap: number, _along = 0, abut?: Abutment | Abutment[], opts?: DiscOpts) {
    const t = opts?.tilt;
    TL.push(t ? t.x : 0, t ? t.y : 0, t ? t.z : 0);
    AP.push(opts?.cut && opts.apron ? opts.apron : 0);
    FCAP.push(opts?.fillCap ?? PAD_FILL_CAP);
    WRD.push(opts?.cut && !Number.isFinite(opts.cut.r) && opts.wallRamp ? opts.wallRamp.depth : 0);
    WRL.push(opts?.wallRamp?.low ?? 0);
    const cu = opts?.cut;
    if (!cu) CU.push(0, 0, 0, 0, 0, 0, 0, 0);
    else {
      const fin = Number.isFinite(cu.r);
      CU.push(fin ? 2 : 1, cu.h.x, cu.h.y, cu.h.z, fin ? cu.r : 0, opts!.cutBlend ?? blend, BATTER * (opts!.cutBatter ?? bt), fin ? cu.f + cu.r : cu.f);
    }
    const ab = abut === undefined ? [] : Array.isArray(abut) ? abut : [abut];
    for (let i = 0; i < 2; i++) {
      const pl = ab[i];
      if (pl) AB.push(pl.n.x, pl.n.y, pl.n.z, pl.off, pl.k ?? ABUT_K);
      else AB.push(0, 0, 0, NaN, 0);
    }
    kind.push(k);
    grp.push(g);
    A.push(a.x, a.y, a.z, b.x, b.y, b.z);
    P.push(core, blend, ha, hb, half, BATTER * bt, Math.min(k === PrimKind.Pad ? PAD_BATTER_CAP : BATTER_CAP, dcap));
    sett.push(s);
    edges.push(e);
  }

  return {
    group: () => groups++,
    disc(k, c, core, blend, h, settlement = -1, batter = 1, dcap = BATTER_CAP, opts) {
      add(k, c, c, core, blend, h, h, groups++, k === PrimKind.Road ? core : 0, settlement, -1, batter, dcap, 0, undefined, opts);
    },
    capsule(k, a, b, core, blend, ha, hb, group, half = 0, edge = -1, batter = 1, dcap = BATTER_CAP, along = 0, abut) {
      add(k, a, b, core, blend, ha, hb, group, half, -1, edge, batter, dcap, along, abut);
    },
    build() {
      const n = kind.length;
      // Bucket every primitive into the cells its reach touches (core + blend + the capped batter):
      // every cell of its bounding box whose cube meets both the sea-level sphere and the capsule.
      // (cell, primitive) pairs as one sortable number each: cell · 4096 + primitive. Primitive order
      // is insertion order, which is also group order (a group's segments are added together).
      /** CSR buckets: every primitive in the cells its `reachOf` touches. */
      const bucket = (reachOf: (p: number) => number) => {
        let kc = new Int32Array(8192); // (cell, primitive) pairs, in primitive order
        let kp = new Int32Array(8192);
        let nk = 0;
        const half = (CELL * Math.sqrt(3)) / 2;
        const rIn = (R - half) * (R - half), rOut = (R + half) * (R + half);
        const add1 = (c: number, p: number) => {
          if (nk === kc.length) {
            const gc = new Int32Array(nk * 2);
            gc.set(kc);
            kc = gc;
            const gp = new Int32Array(nk * 2);
            gp.set(kp);
            kp = gp;
          }
          kc[nk] = c;
          kp[nk++] = p;
        };
        for (let p = 0; p < n; p++) {
          const ax = A[p * 6] * R, ay = A[p * 6 + 1] * R, az = A[p * 6 + 2] * R;
          const bx = A[p * 6 + 3] * R, by = A[p * 6 + 4] * R, bz = A[p * 6 + 5] * R;
          const reach = reachOf(p);
          if (!(reach > 0)) continue;
          const rr = (reach + half) * (reach + half);
          const ex = bx - ax, ey = by - ay, ez = bz - az;
          const ll = ex * ex + ey * ey + ez * ez;
          const k0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - ORIGIN) / CELL));
          const k1 = Math.min(G - 1, Math.floor((Math.max(az, bz) + reach - ORIGIN) / CELL));
          const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - ORIGIN) / CELL));
          const j1 = Math.min(G - 1, Math.floor((Math.max(ay, by) + reach - ORIGIN) / CELL));
          const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - ORIGIN) / CELL));
          const i1 = Math.min(G - 1, Math.floor((Math.max(ax, bx) + reach - ORIGIN) / CELL));
          for (let j = j0; j <= j1; j++) {
            const cy = ORIGIN + (j + 0.5) * CELL;
            for (let i = i0; i <= i1; i++) {
              const cx = ORIGIN + (i + 0.5) * CELL;
              // only the cells of this column the shell passes through: |z| in [zLo, zHi], on either side
              const xy = cx * cx + cy * cy;
              if (xy > rOut) continue;
              const zLo = Math.sqrt(Math.max(0, rIn - xy));
              const zHi = Math.sqrt(rOut - xy);
              for (let side = -1; side <= 1; side += 2) {
                const za = side > 0 ? zLo : -zHi;
                const zb = side > 0 ? zHi : -zLo;
                const ka = Math.max(k0, Math.ceil((za - ORIGIN) / CELL - 0.5));
                const kb = Math.min(k1, Math.floor((zb - ORIGIN) / CELL - 0.5));
                for (let k = ka; k <= kb; k++) {
                  const cz = ORIGIN + (k + 0.5) * CELL;
                  let t = ll > 0 ? ((cx - ax) * ex + (cy - ay) * ey + (cz - az) * ez) / ll : 0;
                  t = t < 0 ? 0 : t > 1 ? 1 : t;
                  const dx = ax + ex * t - cx, dy = ay + ey * t - cy, dz = az + ez * t - cz;
                  if (dx * dx + dy * dy + dz * dz > rr) continue;
                  add1((k * G + j) * G + i, p);
                }
              }
            }
          }
        }
        // CSR: per cell a [start, end) range into one list, by a stable counting sort on the cell, so
        // within a cell the primitives keep their insertion order (a group's segments contiguous).
        // Empty cells have end 0; only occupied cells are touched (no pass over the whole grid).
        const NC = G * G * G;
        const start = new Int32Array(NC);
        const end = new Int32Array(NC);
        for (let q = 0; q < nk; q++) end[kc[q]]++;
        // starts in first-seen order (+1 while assigning, so 0 still means 'not yet')
        let run = 0;
        const cells: number[] = [];
        for (let q = 0; q < nk; q++) {
          const c = kc[q];
          if (start[c] !== 0) continue;
          start[c] = run + 1;
          run += end[c];
          cells.push(c);
        }
        for (const c of cells) {
          start[c] -= 1;
          end[c] = start[c]; // the fill cursor; ends at start + count
        }
        const list = new Int32Array(nk);
        for (let q = 0; q < nk; q++) list[end[kc[q]]++] = kp[q];
        return { start, end, list };
      };
      const own = (p: number) => P[p * 7] + Math.max(P[p * 7 + 1] + P[p * 7 + 5] * P[p * 7 + 6], CU[p * 8] ? CU[p * 8 + 5] + CU[p * 8 + 6] * P[p * 7 + 6] : 0) + 0.5;
      const { start, end, list } = bucket(own);
      // (v2 R2 refine) keepOut's own buckets, built on its first call (off the boot path): every
      // primitive in each cell within its core + KEEP_MARGIN_MAX, so a margin up to that cap never
      // misses a road or a pad listed only in a neighbouring cell
      let kb: { start: Int32Array; end: Int32Array; list: Int32Array } | null = null;
      const keepBuckets = () => (kb ??= bucket((p) => (kind[p] === PrimKind.Basin ? 0 : Math.max(own(p), P[p * 7] + KEEP_MARGIN_MAX + 0.5))));
      const K = Uint8Array.from(kind);
      const GR = Int32Array.from(grp);
      const AA = Float64Array.from(A);
      const PP = Float64Array.from(P);
      const ABUT = Float64Array.from(AB);
      /** The carve's distance to primitive p: past its abutment plane, ABUT_K m farther per metre. */
      const cdist = (p: number, qx: number, qy: number, qz: number) => {
        let dd = dist(p, qx, qy, qz);
        for (let i = p * 10; i < p * 10 + 10; i += 5) {
          const off = ABUT[i + 3];
          if (off !== off) break;
          const dp = (ABUT[i] * qx + ABUT[i + 1] * qy + ABUT[i + 2] * qz - off) * R;
          if (dp > 0) dd += ABUT[i + 4] * dp;
        }
        return dd;
      };
      const SS = Int32Array.from(sett);
      const EE = Int32Array.from(edges);
      const TT = Float64Array.from(TL);
      const CC = Float64Array.from(CU);
      const APR = Float64Array.from(AP);
      const FC = Float64Array.from(FCAP);
      const WD = Float64Array.from(WRD);
      const WL = Float64Array.from(WRL);

      // Distance (m) from unit q to primitive p and the target height at the nearest point. A cut pad's
      // distance is core + its signed distance outside the disc-minus-bite (so ≤ core inside it), and
      // `onCut` says the cut's edge is the nearer one (its blend and batter then apply).
      let tH = 0;
      let onCut = false;
      // (v2 R2) how much the cut's edge is the nearer one: 1 once it is ≥ 1 m nearer than the disc's
      // edge, 0 once it is ≥ 1 m farther (the bank's reach blends between the two, no step where the
      // nearer edge switches, e.g. under the water off a beach crescent's end)
      let cutW = 0;
      /** (v2 R2 refine) the last cut pad's signed distance past its cut line (m; < 0 inland), else NaN. */
      let cutD = NaN;
      function dist(p: number, qx: number, qy: number, qz: number): number {
        const o = p * 6;
        const ax = AA[o], ay = AA[o + 1], az = AA[o + 2];
        const ex = AA[o + 3] - ax, ey = AA[o + 4] - ay, ez = AA[o + 5] - az;
        const ll = ex * ex + ey * ey + ez * ez;
        let t = ll > 0 ? ((qx - ax) * ex + (qy - ay) * ey + (qz - az) * ez) / ll : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = ax + ex * t - qx, dy = ay + ey * t - qy, dz = az + ez * t - qz;
        const h0 = PP[p * 7 + 2];
        tH = h0 + (PP[p * 7 + 3] - h0) * t;
        const tx = TT[p * 3], ty = TT[p * 3 + 1], tz = TT[p * 3 + 2];
        if (tx !== 0 || ty !== 0 || tz !== 0) tH += ((qx - ax) * tx + (qy - ay) * ty + (qz - az) * tz) * R;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) * (R + tH);
        onCut = false;
        cutW = 0;
        cutD = NaN;
        const o8 = p * 8;
        const ct = CC[o8];
        if (ct === 0) return d;
        const core = PP[p * 7];
        // (q in the pad's chart: azimuthal round its centre a, u along the heading, v across it)
        const hx = CC[o8 + 1], hy = CC[o8 + 2], hz = CC[o8 + 3];
        const ca = qx * ax + qy * ay + qz * az;
        const wx = qx - ax * ca, wy = qy - ay * ca, wz = qz - az * ca;
        const sn = Math.sqrt(wx * wx + wy * wy + wz * wz);
        const rc = R + h0;
        const sc = sn > 1e-12 ? (Math.atan2(sn, ca) * rc) / sn : rc;
        const u = (wx * hx + wy * hy + wz * hz) * sc;
        let cd: number;
        if (ct === 1) cd = u - CC[o8 + 7];
        else {
          const sx = ay * hz - az * hy, sy = az * hx - ax * hz, sz = ax * hy - ay * hx;
          const v = (wx * sx + wy * sy + wz * sz) * sc;
          const du = u - CC[o8 + 7];
          cd = CC[o8 + 4] - Math.sqrt(du * du + v * v);
        }
        cutD = cd;
        // (a sea wall's block: the plane ramps down to its low over the block's depth, and stays there
        // past the face — the target its own bank blends from)
        const wd = WD[p];
        if (wd > 0 && cd > -wd) tH += (WL[p] - tH) * (cd >= 0 ? 1 : (cd + wd) / wd);
        if (cd > 0) cutW = smooth01((cd - (d - core)) / 2 + 0.5);
        if (cd > d - core) {
          onCut = cd > 0;
          return core + cd;
        }
        return d;
      }

      return {
        count: n,
        debugAt(d) {
          const c = cellOf(d.x, d.y, d.z);
          const out: Array<{ p: number; kind: number; dist: number; core: number; reach: number }> = [];
          for (let k = start[c]; k < end[c]; k++) {
            const p = list[k];
            out.push({ p, kind: K[p], dist: dist(p, d.x, d.y, d.z), core: PP[p * 7], reach: PP[p * 7 + 1] + PP[p * 7 + 5] * PP[p * 7 + 6] });
          }
          return out;
        },
        carve(d, base) {
          const c = cellOf(d.x, d.y, d.z);
          const s1 = end[c];
          if (s1 === 0) return base;
          const s0 = start[c];
          let h = base;
          let k = s0;
          // a flat primitive's core (pad, plaza, runway) is exactly level: it wins over everything
          // (the roads that reach one are graded to its level there, so its edge never steps)
          let lock = NaN;
          // how much of an earlier group's core the point is in (1 inside, fading over CORE_GUARD m
          // past its edge): a later group's bank never re-shapes an earlier road's carriageway or a
          // flat core's edge (its own core still applies: roads meet only at their shared nodes)
          let guard = 0;
          // (v2 R2) the same for a flat core (pad, plaza, runway): a road's bank still meets its own
          // carriageway's edge there (fading to the guard over 2 m out from it), so a road climbing away
          // from a pad's edge never steps at its verge
          let guardF = 0;
          while (k < s1) {
            const g = GR[list[k]];
            let best = Infinity;
            let bp = -1;
            const k0 = k;
            for (; k < s1 && GR[list[k]] === g; k++) {
              const p = list[k];
              const dd = cdist(p, d.x, d.y, d.z);
              if (dd < best) {
                best = dd;
                bp = p;
              }
            }
            // The target: a soft minimum over the group's segments, weighted by how much farther each
            // is than the nearest, over a width that grows from SOFT_NEAR on the carriageway (only the
            // road's own stretch there: its bed is its profile) by SOFT_K per metre past the core (a
            // bank blends whatever passes of the road are near: inside a hairpin's bend the whole arc,
            // between its legs one S-curve from bed to bed). Each segment pulls with its own bank
            // weight (distance, reach); the weights are a partition of unity, so the carve is
            // continuous wherever the nearest segment switches.
            let wsum = 0;
            let tsum = 0;
            let ssum = 0;
            const core = PP[bp * 7];
            const road = K[bp] === PrimKind.Road;
            // (a basin: lower only, toward its target, by its own bank weight; it never locks)
            if (K[bp] === PrimKind.Basin) {
              const tb = PP[bp * 7 + 2];
              const rn = PP[bp * 7 + 1] + PP[bp * 7 + 5] * PP[bp * 7 + 6];
              const w = best <= core ? 1 : 1 - smooth01((best - core) / rn);
              if (h > tb) h += (tb - h) * w * (1 - Math.max(guard, guardF));
              // (later groups' banks fade out toward the basin as it fades in, wherever the seabed is:
              // no seam at its core's edge, and no bank spreading a shoal over the harbour)
              guard = Math.max(guard, w);
              continue;
            }
            const past = best > core ? best - core : 0;
            const width = SOFT_NEAR + SOFT_K * past;
            const lam = past > 0 ? smooth01(past / SHEP_IN) : 0;
            for (let q = k0; q < k; q++) {
              const p = list[q];
              const dd = cdist(p, d.x, d.y, d.z);
              const x = (dd - best) / width;
              let u0 = x < 1 ? (1 - x) * (1 - x) : 0;
              if (lam > 0) {
                const r = (dd - PP[p * 7] + SHEP_A) / (past + SHEP_A);
                const un = r < SHEP_R ? (1 / (r * r) - 1 / (SHEP_R * SHEP_R)) / (1 - 1 / (SHEP_R * SHEP_R)) : 0;
                u0 += (un - u0) * lam;
              }
              if (!(u0 > 0)) continue;
              // a segment fades out of the blend over the last 2 m of its reach (it is bucketed only
              // in the cells it reaches: past that, a cell boundary would cut it off)
              const rn = PP[p * 7 + 1] + PP[p * 7 + 5] * PP[p * 7 + 6];
              const rm = PP[p * 7] + (onCut ? Math.max(rn, CC[p * 8 + 5] + CC[p * 8 + 6] * PP[p * 7 + 6]) : rn);
              const rwq = dd <= rm - 2 ? 1 : dd >= rm ? 0 : 1 - smooth01((dd - rm + 2) / 2);
              const u = u0 * rwq;
              if (!(u > 0)) continue;
              const tr = tH;
              wsum += u;
              tsum += u * tr;
              const dl = tr - h;
              if (dd <= core) {
                ssum += u * dl;
                continue;
              }
              const ad = dl < 0 ? -dl : dl;
              // (a town pad's fill banks widen only so far: past a pad's edge on a cliff top, or a sea
              // shore, the bank follows the ground down instead of spreading an embankment out over it)
              const cap = dl > 0 && K[p] === PrimKind.Pad && SS[p] >= 0 ? Math.min(FC[p], PP[p * 7 + 6]) : PP[p * 7 + 6];
              // (a cut's own bank, a sea wall, only where it stands in the water: on land it banks
              // like the rest of the pad, blending by the ground's height so there is no seam)
              let reach = PP[p * 7 + 1] + PP[p * 7 + 5] * (ad < cap ? ad : cap);
              // (a town pad's fill over the sea drops off short: no shoal spreads into a channel under
              // a bridge or over a harbour, blending by the natural ground's depth so there is no seam)
              if (dl > 0 && K[p] === PrimKind.Pad && SS[p] >= 0) {
                reach *= 0.7 + 0.3 * smooth01((base + 4.5) / 3.5);
              }
              if (cutW > 0) {
                const wr = CC[p * 8 + 5] + CC[p * 8 + 6] * (ad < cap ? ad : cap);
                // (by the ground as carved so far: a harbour's basin, dredged before its pad, makes the
                // whole quay a wall)
                const wk = smooth01((Math.min(base, h) - CUT_WET) / (CUT_DRY - CUT_WET));
                reach += (wr + (reach - wr) * wk - reach) * cutW;
              }
              ssum += u * (1 - smooth01((dd - core) / reach)) * dl;
            }
            if (!(wsum > 0)) continue;
            if (best <= core) {
              h = tsum / wsum;
              if (!road && lock !== lock) lock = h;
              if (road) guard = 1;
              else guardF = 1;
              continue;
            }
            const gEff = road ? Math.max(guard, guardF * smooth01(past / 2)) : Math.max(guard, guardF);
            const dh = (ssum / wsum) * (1 - gEff);
            const gk = 1 - smooth01((best - core) / CORE_GUARD);
            if (road) {
              if (gk > guard) guard = gk;
            } else if (gk > guardF) guardF = gk;
            if (CARVE_TRACE.lines) CARVE_TRACE.lines.push(`g${g} bp${bp} best ${best.toFixed(2)} core ${core.toFixed(1)} bt ${(tsum / wsum).toFixed(2)} wsum ${wsum.toFixed(2)} h ${h.toFixed(2)}->${(h + dh).toFixed(2)}`);
            h += dh;
          }
          return lock === lock ? lock : h;
        },
        keepOut(d, margin, mask) {
          // (margins past KEEP_MARGIN_MAX are clamped: types.ts Region.keepOut)
          if (margin > KEEP_MARGIN_MAX) margin = KEEP_MARGIN_MAX;
          const B = keepBuckets();
          const c = cellOf(d.x, d.y, d.z);
          for (let k = B.start[c]; k < B.end[c]; k++) {
            const p = B.list[k];
            const kd = K[p];
            if (kd === PrimKind.Basin) continue;
            const bit = kd === PrimKind.Road ? 1 : kd === PrimKind.Pad ? (SS[p] >= 0 ? 2 : 8) : kd === PrimKind.Plaza ? 4 : 8;
            if (!(mask & bit)) {
              // (v2 R2 refine: a sea wall's paved apron answers to KEEP.plaza)
              if (!(mask & 4) || APR[p] === 0) continue;
              if (dist(p, d.x, d.y, d.z) <= PP[p * 7] + margin && cutD >= -APR[p] - margin) return true;
              continue;
            }
            if (dist(p, d.x, d.y, d.z) <= PP[p * 7] + margin) return true;
          }
          return false;
        },
        // (the brute-force reference for region.spec, compiled out of a production build)
        keepOutAll: process.env.NODE_ENV === 'production' ? () => false : (d, margin, mask) => {
          for (let p = 0; p < n; p++) {
            const kd = K[p];
            if (kd === PrimKind.Basin) continue;
            const bit = kd === PrimKind.Road ? 1 : kd === PrimKind.Pad ? (SS[p] >= 0 ? 2 : 8) : kd === PrimKind.Plaza ? 4 : 8;
            if (!(mask & bit)) {
              if (!(mask & 4) || APR[p] === 0) continue;
              if (dist(p, d.x, d.y, d.z) <= PP[p * 7] + margin && cutD >= -APR[p] - margin) return true;
              continue;
            }
            if (dist(p, d.x, d.y, d.z) <= PP[p * 7] + margin) return true;
          }
          return false;
        },
        surface(d, out) {
          out.cls = 'free';
          out.roadDist = 1e9;
          out.edge = -1;
          out.settlement = -1;
          const c = cellOf(d.x, d.y, d.z);
          let rank = 0; // free 0 < verge 1 < pad 2 < plaza 3 < runway 4 < road 5
          for (let k = start[c]; k < end[c]; k++) {
            const p = list[k];
            const kd = K[p];
            if (kd === PrimKind.Basin) continue;
            const dd = dist(p, d.x, d.y, d.z);
            if (kd === PrimKind.Road) {
              if (dd < out.roadDist) {
                out.roadDist = dd;
                out.edge = EE[p];
              }
              const half = PP[p * 7 + 4];
              if (dd <= half && rank < 5) {
                rank = 5;
                out.cls = 'road';
              } else if (dd <= PP[p * 7] && rank < 1) {
                rank = 1;
                out.cls = 'verge';
              }
            } else if (dd <= PP[p * 7]) {
              // (v2 R2 refine: a sea wall's paved apron, QUAY_APRON m inland of its face, is 'plaza')
              const apron = APR[p] > 0 && cutD >= -APR[p];
              const r = kd === PrimKind.Runway ? 4 : kd === PrimKind.Plaza || apron ? 3 : 2;
              if (kd === PrimKind.Pad && SS[p] >= 0) out.settlement = SS[p];
              if (r > rank) {
                rank = r;
                out.cls = apron ? 'plaza' : CLS[kd];
              }
            }
          }
          return out;
        },
      };
    },
  };
}
