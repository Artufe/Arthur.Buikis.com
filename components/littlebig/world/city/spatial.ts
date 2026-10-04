// Placement-time spatial tests for the plan builder (boot only, allocation is fine). A uniform hash
// grid of "keep-out" capsules (road corridors, walk edges), discs (junction patches, features) and
// building footprints, so a candidate footprint is tested against its neighbourhood only (the
// city-plan budget forbids all-pairs tests).

import { buildingCorners, obbDistance } from './index-grid';
import type { Building } from './types';

const CELL = 8;

/** Distance from a point to a segment. */
export function segPointDist(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return Math.hypot(x0 + dx * t - px, z0 + dz * t - pz);
}

function segsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Signed distance from (x, z) to a footprint with precomputed cos / sin of its angle. */
function obbDistCS(b: Building, c: number, s: number, x: number, z: number): number {
  const dx = x - b.x;
  const dz = z - b.z;
  const qx = Math.abs(dx * c + dz * s) - b.w / 2;
  const qz = Math.abs(-dx * s + dz * c) - b.d / 2;
  const ox = qx > 0 ? qx : 0;
  const oz = qz > 0 ? qz : 0;
  return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0);
}

/** Distance between an oriented building footprint and a segment (0 when they touch). */
export function obbSegDist(b: Building, corners: number[], x0: number, z0: number, x1: number, z1: number, c = Math.cos(b.angle), sn = Math.sin(b.angle)): number {
  let best = Math.max(0, Math.min(obbDistCS(b, c, sn, x0, z0), obbDistCS(b, c, sn, x1, z1)));
  if (best === 0) return 0;
  for (let k = 0; k < 8; k += 2) {
    best = Math.min(best, segPointDist(corners[k], corners[k + 1], x0, z0, x1, z1));
    const k2 = (k + 2) % 8;
    if (segsCross(x0, z0, x1, z1, corners[k], corners[k + 1], corners[k2], corners[k2 + 1])) return 0;
  }
  return best;
}

/** Separating-axis overlap of two footprints, each inflated by `gap / 2` per side. Zero-alloc. */
export function obbOverlapGap(a: Building, b: Building, gap: number): boolean {
  const ca = Math.cos(a.angle), sa = Math.sin(a.angle);
  const cb = Math.cos(b.angle), sb = Math.sin(b.angle);
  const ahw = a.w / 2 + gap / 2, ahd = a.d / 2 + gap / 2;
  const bhw = b.w / 2 + gap / 2, bhd = b.d / 2 + gap / 2;
  const dx = b.x - a.x, dz = b.z - a.z;
  // Axes: a's local x (ca, sa) and z (−sa, ca), b's likewise.
  return !(
    sepAxis(ca, sa, dx, dz, ahw, ahd, ca, sa, bhw, bhd, cb, sb) ||
    sepAxis(-sa, ca, dx, dz, ahw, ahd, ca, sa, bhw, bhd, cb, sb) ||
    sepAxis(cb, sb, dx, dz, ahw, ahd, ca, sa, bhw, bhd, cb, sb) ||
    sepAxis(-sb, cb, dx, dz, ahw, ahd, ca, sa, bhw, bhd, cb, sb)
  );
}

function sepAxis(ux: number, uz: number, dx: number, dz: number, ahw: number, ahd: number, ca: number, sa: number, bhw: number, bhd: number, cb: number, sb: number): boolean {
  const ra = ahw * Math.abs(ca * ux + sa * uz) + ahd * Math.abs(-sa * ux + ca * uz);
  const rb = bhw * Math.abs(cb * ux + sb * uz) + bhd * Math.abs(-sb * ux + cb * uz);
  return Math.abs(dx * ux + dz * uz) >= ra + rb - 1e-6;
}

/** Half-size of the placement grid (m): covers the plan plus margin. */
const HALF = 104;
const DIM = Math.ceil((2 * HALF) / CELL);

/** The placement grid. */
export class KeepOut {
  /** Capsules: x0, z0, x1, z1, r per entry. */
  private cap: number[] = [];
  private capStamp: number[] = [];
  readonly buildings: Building[] = [];
  private bStamp: number[] = [];
  private readonly capCells: number[][] = Array.from({ length: DIM * DIM }, () => []);
  private readonly bCells: number[][] = Array.from({ length: DIM * DIM }, () => []);
  private stamp = 0;

  private static cellOf(v: number): number {
    const c = Math.floor((v + HALF) / CELL);
    return c < 0 ? 0 : c >= DIM ? DIM - 1 : c;
  }

  /** A keep-out capsule (segment + radius); a disc is a zero-length capsule. */
  addCapsule(x0: number, z0: number, x1: number, z1: number, r: number): void {
    const id = this.capStamp.length;
    this.cap.push(x0, z0, x1, z1, r);
    this.capStamp.push(0);
    const i0 = KeepOut.cellOf(Math.min(x0, x1) - r), i1 = KeepOut.cellOf(Math.max(x0, x1) + r);
    const j0 = KeepOut.cellOf(Math.min(z0, z1) - r), j1 = KeepOut.cellOf(Math.max(z0, z1) + r);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.capCells[j * DIM + i].push(id);
  }

  /**
   * A polyline as capsules of radius r, decimated to ~3 m chords (+3 cm of radius covers the chord
   * sag on these curves) so placement tests touch fewer segments.
   */
  addPolyline(pts: ArrayLike<number>, r: number, chord = 4.5): void {
    const n = pts.length >> 1;
    if (n < 2) return;
    let p0 = 0;
    let acc = 0;
    for (let i = 1; i < n; i++) {
      acc += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      if (acc >= chord || i === n - 1) {
        // The chord's sag: the farthest skipped sample from it (exact cover, not a guess).
        const x0 = pts[p0 * 2], z0 = pts[p0 * 2 + 1], x1 = pts[i * 2], z1 = pts[i * 2 + 1];
        let sag = 0;
        for (let k = p0 + 1; k < i; k++) sag = Math.max(sag, segPointDist(pts[k * 2], pts[k * 2 + 1], x0, z0, x1, z1));
        this.addCapsule(x0, z0, x1, z1, r + sag + 0.005);
        p0 = i;
        acc = 0;
      }
    }
  }

  addBuilding(b: Building): void {
    const id = this.buildings.length;
    this.buildings.push(b);
    this.bStamp.push(0);
    const r = Math.hypot(b.w, b.d) / 2;
    const i0 = KeepOut.cellOf(b.x - r), i1 = KeepOut.cellOf(b.x + r);
    const j0 = KeepOut.cellOf(b.z - r), j1 = KeepOut.cellOf(b.z + r);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.bCells[j * DIM + i].push(id);
  }

  /**
   * True if footprint b keeps `margin` clear of every capsule and `gap` clear of every placed
   * building.
   */
  fits(b: Building, margin: number, gap: number, ignore?: Building): boolean {
    const corners = buildingCorners(b);
    const c = Math.cos(b.angle);
    const sn = Math.sin(b.angle);
    // Capsules and buildings are filed in every cell their reach touches: scan the footprint's own cells.
    const reach = Math.hypot(b.w, b.d) / 2 + Math.max(margin, gap);
    const st = ++this.stamp;
    const cap = this.cap;
    const i0 = KeepOut.cellOf(b.x - reach), i1 = KeepOut.cellOf(b.x + reach);
    const j0 = KeepOut.cellOf(b.z - reach), j1 = KeepOut.cellOf(b.z + reach);
    // Buildings first: most rejected candidates hit a neighbour, and the box test is cheap.
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const bc = this.bCells[j * DIM + i];
        for (let k = 0; k < bc.length; k++) {
          const id = bc[k];
          if (this.bStamp[id] === st) continue;
          this.bStamp[id] = st;
          const o = this.buildings[id];
          if (o === ignore) continue;
          if (Math.hypot(o.x - b.x, o.z - b.z) > reach + Math.hypot(o.w, o.d) / 2 + gap) continue;
          if (obbOverlapGap(b, o, gap)) return false;
        }
      }
    }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cc = this.capCells[j * DIM + i];
        for (let k = 0; k < cc.length; k++) {
          const id = cc[k];
          if (this.capStamp[id] === st) continue;
          this.capStamp[id] = st;
          const o = id * 5;
          const x0 = cap[o], z0 = cap[o + 1], x1 = cap[o + 2], z1 = cap[o + 3], r = cap[o + 4];
          const mx = (x0 + x1) / 2 - b.x;
          const mz = (z0 + z1) / 2 - b.z;
          const half = Math.hypot(x1 - x0, z1 - z0) / 2;
          if (Math.sqrt(mx * mx + mz * mz) - half > reach + r) continue;
          if (obbSegDist(b, corners, x0, z0, x1, z1, c, sn) < r + margin) return false;
        }
      }
    }
    return true;
  }

  /** True if (x, z) lies inside (or within `pad` of) a placed building. */
  buildingAt(x: number, z: number, pad = 0): boolean {
    const bc = this.bCells[KeepOut.cellOf(z) * DIM + KeepOut.cellOf(x)];
    for (let k = 0; k < bc.length; k++) if (obbDistance(this.buildings[bc[k]], x, z) < pad) return true;
    return false;
  }

  /** True if a disc keeps clear of every capsule and building. */
  discClear(x: number, z: number, r: number): boolean {
    const st = ++this.stamp;
    const cap = this.cap;
    const i0 = KeepOut.cellOf(x - r), i1 = KeepOut.cellOf(x + r);
    const j0 = KeepOut.cellOf(z - r), j1 = KeepOut.cellOf(z + r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cc = this.capCells[j * DIM + i];
        for (let k = 0; k < cc.length; k++) {
          const id = cc[k];
          if (this.capStamp[id] === st) continue;
          this.capStamp[id] = st;
          const o = id * 5;
          if (segPointDist(x, z, cap[o], cap[o + 1], cap[o + 2], cap[o + 3]) < cap[o + 4] + r) return false;
        }
        const bc = this.bCells[j * DIM + i];
        for (let k = 0; k < bc.length; k++) {
          const id = bc[k];
          if (this.bStamp[id] === st) continue;
          this.bStamp[id] = st;
          if (obbDistance(this.buildings[id], x, z) < r) return false;
        }
      }
    }
    return true;
  }
}
