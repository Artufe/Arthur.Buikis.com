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
import type { RegionClass, SurfaceHit } from './types';

/** Grid cell size (m) and cells per axis (the cube round the sea-level sphere, plus a margin). */
const CELL = 6;
const G = Math.ceil((2 * R) / CELL) + 2;
const ORIGIN = -R - CELL;
/** Batter widening per metre of cut / fill, and the cut / fill depth (m) beyond which it stops widening. */
export const BATTER = 2.6;
export const BATTER_CAP = 6;
/** A pad's cap: a town cut into a mountainside (the alpine village) needs the longer bank. */
export const PAD_BATTER_CAP = 13;
/**
 * Soft-minimum width (m) for a group's target height (see carve()): SOFT_NEAR on the carriageway (the
 * neighbours along the road blend in, so on the inside of a tight, climbing bend the bed never steps
 * where the nearest segment switches), widening by SOFT_K per metre past the core (a bank blends the
 * passes of the road near it: inside a hairpin's bend its whole arc, between its legs, metres apart
 * in height, one S-curve from bed to bed).
 */
const SOFT_NEAR = 1.5;
const SOFT_K = 0.8;
/** Metres past a core's edge over which later groups' banks fade back in (see carve()). */
const CORE_GUARD = 4;

export const PrimKind = { Pad: 0, Plaza: 1, Runway: 2, Road: 3 } as const;
export type PrimKind = (typeof PrimKind)[keyof typeof PrimKind];

const CLS: RegionClass[] = ['pad', 'plaza', 'runway', 'road'];

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
export const ABUT_K = 1.5;

export interface CarveBuilder {
  /** A flat disc (pads, plazas, aprons). `batter` scales the cut / fill widening (1 = BATTER; < 1 steeper banks). */
  disc(kind: PrimKind, c: Vec3, core: number, blend: number, h: number, settlement?: number, batter?: number, dcap?: number): void;
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

export interface Carve {
  carve(dir: Vec3, base: number): number;
  surface(dir: Vec3, out: SurfaceHit): SurfaceHit;
  /** Primitive count (spec / debug). */
  readonly count: number;
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
  let groups = 0;

  function add(k: PrimKind, a: Vec3, b: Vec3, core: number, blend: number, ha: number, hb: number, g: number, half: number, s: number, e: number, bt: number, dcap: number, _along = 0, abut?: Abutment | Abutment[]) {
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
    disc(k, c, core, blend, h, settlement = -1, batter = 1, dcap = BATTER_CAP) {
      add(k, c, c, core, blend, h, h, groups++, k === PrimKind.Road ? core : 0, settlement, -1, batter, dcap);
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
        const reach = P[p * 7] + P[p * 7 + 1] + P[p * 7 + 5] * P[p * 7 + 6] + 0.5;
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

      // Distance (m) from unit q to primitive p and the target height at the nearest point.
      let tH = 0;
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
        return Math.sqrt(dx * dx + dy * dy + dz * dz) * (R + tH);
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
            const width = SOFT_NEAR + SOFT_K * (best > core ? best - core : 0);
            for (let q = k0; q < k; q++) {
              const p = list[q];
              const dd = cdist(p, d.x, d.y, d.z);
              const x = (dd - best) / width;
              if (x >= 1) continue;
              // a segment fades out of the blend over the last 2 m of its reach (it is bucketed only
              // in the cells it reaches: past that, a cell boundary would cut it off)
              const rm = PP[p * 7] + PP[p * 7 + 1] + PP[p * 7 + 5] * PP[p * 7 + 6];
              const rwq = dd <= rm - 2 ? 1 : dd >= rm ? 0 : 1 - smooth01((dd - rm + 2) / 2);
              const u = (1 - x) * (1 - x) * rwq;
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
              const cap = PP[p * 7 + 6];
              const reach = PP[p * 7 + 1] + PP[p * 7 + 5] * (ad < cap ? ad : cap);
              ssum += u * (1 - smooth01((dd - core) / reach)) * dl;
            }
            if (!(wsum > 0)) continue;
            if (best <= core) {
              h = tsum / wsum;
              if (!road && lock !== lock) lock = h;
              guard = 1;
              continue;
            }
            const dh = (ssum / wsum) * (1 - guard);
            const gk = 1 - smooth01((best - core) / CORE_GUARD);
            if (gk > guard) guard = gk;
            if (CARVE_TRACE.lines) CARVE_TRACE.lines.push(`g${g} bp${bp} best ${best.toFixed(2)} core ${core.toFixed(1)} bt ${(tsum / wsum).toFixed(2)} wsum ${wsum.toFixed(2)} h ${h.toFixed(2)}->${(h + dh).toFixed(2)}`);
            h += dh;
          }
          return lock === lock ? lock : h;
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
              const r = kd === PrimKind.Runway ? 4 : kd === PrimKind.Plaza ? 3 : 2;
              if (kd === PrimKind.Pad && SS[p] >= 0) out.settlement = SS[p];
              if (r > rank) {
                rank = r;
                out.cls = CLS[kd];
              }
            }
          }
          return out;
        },
      };
    },
  };
}
