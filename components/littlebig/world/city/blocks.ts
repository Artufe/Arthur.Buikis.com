// City blocks: the faces of the planar road graph. Each block is bounded by a cycle of half-edges
// (an edge travelled in one direction with the block on its LEFT); its outline runs along the outer
// edge of the sidewalks with rounded corners, the same shape graph.ts gives the curbs. Pure.

import { cornerPoints, signedArea, turningRadius } from './graph';
import { endTangent, offset, reversed, startTangent } from './path';
import type { Polyline, RoadEdge, RoadNode } from './types';

export interface HalfEdge {
  edge: number;
  /** True when travelled a → b. */
  fwd: boolean;
}

export interface Block {
  id: number;
  /** Bounding half-edges in order (block on the left of travel). */
  sides: HalfEdge[];
  /** Outline at the sidewalks' outer edge (x, z interleaved, positive winding). */
  outline: Float64Array;
  /** Signed area (m², > 0 for a bounded block). */
  area: number;
  cx: number;
  cz: number;
  /** True for the unbounded face outside the ring. */
  outer: boolean;
}

/** Centreline in travel direction. */
export function travelPath(e: RoadEdge, fwd: boolean): Polyline {
  return fwd ? e.centre : reversed(e.centre);
}

/**
 * Extract every face. `inset` pulls the outline that far back under the sidewalk (m), so a block's
 * ground tucks under the curb slab instead of leaving a sliver of bare terrain at the joint.
 */
export function extractBlocks(nodes: RoadNode[], edges: RoadEdge[], inset = 0): Block[] {
  const used = new Set<string>();
  const blocks: Block[] = [];
  for (const e of edges) {
    for (const fwd of [true, false]) {
      const k0 = `${e.id}:${fwd ? 1 : 0}`;
      if (used.has(k0)) continue;
      const sides: HalfEdge[] = [];
      let cur: HalfEdge = { edge: e.id, fwd };
      for (let guard = 0; guard < 400; guard++) {
        const k = `${cur.edge}:${cur.fwd ? 1 : 0}`;
        if (used.has(k)) break;
        used.add(k);
        sides.push(cur);
        const ce = edges[cur.edge];
        const v = nodes[cur.fwd ? ce.b : ce.a];
        const i = v.edges.indexOf(cur.edge);
        // The next arm clockwise (increasing plan angle) after the one we arrived on keeps the face
        // on our left. A dead end turns back along the same edge.
        const nextId = v.edges[(i + 1) % v.edges.length];
        const ne = edges[nextId];
        // (No self-loops in a city graph, so the far end tells the direction.)
        cur = { edge: nextId, fwd: ne.a === v.id };
      }
      const outline = blockOutline(edges, sides, inset, nodes);
      const area = signedArea(outline);
      let cx = 0;
      let cz = 0;
      const n = outline.length >> 1;
      for (let i = 0; i < n; i++) {
        cx += outline[i * 2];
        cz += outline[i * 2 + 1];
      }
      blocks.push({ id: blocks.length, sides, outline: Float64Array.from(outline), area, cx: cx / n, cz: cz / n, outer: false });
    }
  }
  // The unbounded face winds the other way round from every bounded block.
  let outerIdx = 0;
  for (let i = 1; i < blocks.length; i++) if (Math.abs(blocks[i].area) > Math.abs(blocks[outerIdx].area)) outerIdx = i;
  const sign = Math.sign(blocks[outerIdx].area);
  for (const b of blocks) b.outer = Math.sign(b.area) === sign && b === blocks[outerIdx];
  // Bounded blocks: positive winding.
  for (const b of blocks) {
    if (!b.outer && b.area < 0) {
      b.outline = reversePairs(b.outline);
      b.area = -b.area;
    }
  }
  return blocks.map((b, id) => ({ ...b, id }));
}

/** Outline points of a face: each side's sidewalk outer edge, joined by rounded corners (or, at a
 * dead end, round the turning circle's sidewalk). */
export function blockOutline(edges: RoadEdge[], sides: HalfEdge[], inset = 0, nodes?: RoadNode[]): number[] {
  const runs = sides.map((h) => {
    const e = edges[h.edge];
    const pl = travelPath(e, h.fwd);
    // Block on the left of travel: offset to the left (negative = left in path.ts).
    return offset(pl, -(e.width / 2 + e.sidewalk - inset));
  });
  const out: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    for (let k = 0; k < r.pts.length; k += 2) out.push(r.pts[k], r.pts[k + 1]);
    const j = (i + 1) % runs.length;
    const nx = runs[j];
    const x0 = r.pts[r.pts.length - 2];
    const z0 = r.pts[r.pts.length - 1];
    const x1 = nx.pts[0];
    const z1 = nx.pts[1];
    const e = edges[sides[i].edge];
    if (nodes && sides[j].edge === sides[i].edge) {
      // Dead end: round the far side of the turning circle at its sidewalk's outer radius.
      const n = nodes[sides[i].fwd ? e.b : e.a];
      const R = turningRadius(e.width / 2) + e.sidewalk - inset;
      const t0 = Math.atan2(z0 - n.z, x0 - n.x);
      let d = Math.atan2(z1 - n.z, x1 - n.x) - t0;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      // the long way round, away from the arm (the arm leaves toward the run's start)
      const ax = r.pts[0] - n.x;
      const az = r.pts[1] - n.z;
      const away = Math.atan2(-az, -ax);
      if (Math.cos(t0 + d / 2 - away) < 0) d += d > 0 ? -2 * Math.PI : 2 * Math.PI;
      const r0 = Math.hypot(x0 - n.x, z0 - n.z);
      const r1 = Math.hypot(x1 - n.x, z1 - n.z);
      const steps = Math.max(10, Math.ceil((Math.abs(d) * R) / 0.8));
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        const ease = Math.min(1, Math.min(f, 1 - f) * 6);
        const rr = (r0 * (1 - f) + r1 * f) * (1 - ease) + Math.max(R, r0, r1) * ease;
        const t = t0 + d * f;
        out.push(n.x + Math.cos(t) * rr, n.z + Math.sin(t) * rr);
      }
      continue;
    }
    const t0 = endTangent(r);
    const t1 = startTangent(nx);
    // (cornerPoints takes the arms' outward directions: −t0 for the arriving run.)
    const f = cornerPoints(x0, z0, -t0.x, -t0.z, x1, z1, t1.x, t1.z);
    for (let k = 2; k < f.length - 2; k += 2) out.push(f[k], f[k + 1]);
  }
  return out;
}

function reversePairs(a: Float64Array): Float64Array {
  const n = a.length >> 1;
  const out = new Float64Array(a.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = a[(n - 1 - i) * 2];
    out[i * 2 + 1] = a[(n - 1 - i) * 2 + 1];
  }
  return out;
}
