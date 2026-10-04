// The city plan (A2): pure, seeded, deterministic. Streets come from layout.ts (plaza loop, swirling
// avenues, an oval ring, cul-de-sacs) through graph.ts (lanes, connectors, patches, walk graph);
// blocks are the faces of that graph (blocks.ts). This file fills them:
//   - the plaza (the central block): clock tower, fountain, a paved loop and paths;
//   - the park and the stadium in the outer band;
//   - downtown blocks: frontage buildings on every street side (towers near the plaza → mid-rise
//     near the ring), a back row in the leftover interior, then courtyards (raised lawn beds,
//     trees, benches) in what is left; one block is cut by a pedestrian market lane lined with
//     small shops, another has a church on a little square;
//   - houses with gardens outside the ring, along the ring and round the cul-de-sacs;
//   - street furniture: streetlights, street trees, benches, bus stops, flags, a corner café at the
//     street viewpoint (the dive lands there). A1 renders every tree.
// Placement tests go through a spatial hash (spatial.ts), never all pairs (budget: plan + index ≤ 30 ms).

import { CITY_PLAN_RADIUS, CURB_H, ROAD_H, SEED } from '../config';
import { Rng } from '../rng';
import { extractBlocks, travelPath, type Block } from './blocks';
import { buildRoadGraph, pointInPolygon, turningRadius, type RoadGraph } from './graph';
import { buildLayout, type Layout } from './layout';
import { hermitePoints, nearestOn, offset, polyline, reversed, sampleAt, trim } from './path';
import { featureRadius, obbDistance } from './index-grid';
import { KeepOut, segPointDist } from './spatial';
import { getPlanet } from '../planet';
import { pickDusk, Skyline, type WalkSpot } from './views';
import type { Area, Building, BuildingStyle, CityPlan, Feature, Polyline, RoadEdge, RoofKind, Viewpoint, WalkEdge, WalkKind, Zone } from './types';

/** Sidewalk top; downtown lots and the plaza are paved flush with it (4 mm lower, tucked under its edge). */
const SIDEWALK_TOP = ROAD_H + CURB_H;
const PAVED_H = SIDEWALK_TOP - 0.004;
/** Courtyard lawn beds: raised 25 cm above the paving behind a stone curb. */
export const BED_H = SIDEWALK_TOP + 0.25;
/** Market lane: paving width (m). */
const LANE_W = 3.6;

type BlockRole = 'plaza' | 'downtown' | 'outer';
type P = { x: number; z: number; tx: number; tz: number; i: number };
const ps = (): P => ({ x: 0, z: 0, tx: 0, tz: 0, i: 0 });

export function buildCityPlan(seed: number = SEED): CityPlan {
  const rng = Rng.for(seed, 'city-plan');
  const layout = buildLayout(seed);
  const g = buildRoadGraph(layout.nodes, layout.edges);
  const blocks = extractBlocks(g.nodes, g.edges, 0);
  const roles = assignRoles(blocks);

  const keep = new KeepOut();
  for (const e of g.edges) keep.addPolyline(e.centre.pts, e.width / 2 + e.sidewalk);
  for (const n of g.nodes) {
    if (n.kind === 'end') {
      const e = g.edges[n.edges[0]];
      keep.addCapsule(n.x, n.z, n.x, n.z, turningRadius(e.width / 2) + e.sidewalk + 0.05);
    } else keep.addCapsule(n.x, n.z, n.x, n.z, n.radius);
  }
  for (const w of g.walkEdges) if (w.kind === 'corner') keep.addPolyline(w.path.pts, w.width / 2);

  const buildings: Building[] = [];
  const areas: Area[] = [];
  const features: Feature[] = [];
  const W = new WalkGraph(g);
  const addBuilding = (b: Omit<Building, 'id'>) => {
    const full = { ...b, id: buildings.length } as Building;
    buildings.push(full);
    keep.addBuilding(full);
    return full;
  };
  const addArea = (kind: Area['kind'], outline: ArrayLike<number>, h?: number) => {
    const a: Area = { id: areas.length, kind, outline: Float64Array.from(positive(Array.from(outline))) };
    if (h !== undefined) a.h = h;
    areas.push(a);
    return a;
  };
  const coarseCache = new Map<number, number[]>();
  const coarse = (b: Block) => {
    let c = coarseCache.get(b.id);
    if (!c) coarseCache.set(b.id, (c = decimate(b.outline, 2.0)));
    return c;
  };

  const plazaBlock = blocks.find((b) => roles.get(b.id) === 'plaza')!;
  const outerBlock = blocks.find((b) => b.outer)!;
  const downtown = blocks.filter((b) => roles.get(b.id) === 'downtown');

  // ── Plaza: clock tower in the middle, a paved loop round it, a path in from each side ──
  const plazaFountain = { x: 0, z: 0 };
  {
    const blk = plazaBlock;
    addArea('plaza', inset(blk.outline, -0.12), PAVED_H);
    const cx = blk.cx;
    const cz = blk.cz;
    addBuilding({ x: cx, z: cz, angle: layout.rot, w: 5.2, d: 5.2, h: 23, style: 'landmark', roof: 'spire', zone: 'civic', wall: 0, roofColor: 2, seed: rng.int(0, 1 << 30), frontEdge: -1, landmark: 'clocktower' });
    const loopR = 6.6;
    const entries = sideEntries(blk, g, W);
    W.addLoop(circlePts(cx, cz, loopR, layout.rot), entries, 'plaza', 2.4);
    const ea = entries.map((e) => Math.atan2(e.z - cz, e.x - cx)).sort((a, b) => a - b);
    ea.forEach((a0, k) => {
      let a1 = ea[(k + 1) % ea.length];
      if (a1 <= a0) a1 += Math.PI * 2;
      const a = (a0 + a1) / 2;
      const room = rayToOutline(coarse(blk), cx, cz, Math.cos(a), Math.sin(a));
      const at = (r: number, da = 0) => ({ x: cx + Math.cos(a + da) * r, z: cz + Math.sin(a + da) * r });
      const far = Math.min(room - 3.2, loopR + 5.2);
      if (k === 0) {
        const f = at(far);
        plazaFountain.x = f.x;
        plazaFountain.z = f.z;
        features.push({ kind: 'fountain', ...f, angle: a, r: 1.9 });
      } else if (k === 2) for (const da of [-0.22, 0, 0.22]) features.push({ kind: 'flag', ...at(far + 0.6, da), angle: a });
      else features.push({ kind: 'tree', ...at(far + 0.4), angle: a, size: 5.6 + rng.range(-0.6, 0.8), seed: rng.int(0, 1 << 30) });
      features.push({ kind: 'bench', ...at(loopR + 2.0), angle: a + Math.PI / 2 });
    });
    for (const a of ea) {
      for (const da of [-0.36, 0.36]) features.push({ kind: 'lamp', x: cx + Math.cos(a + da) * (loopR + 1.75), z: cz + Math.sin(a + da) * (loopR + 1.75), angle: a, r: 0.2 });
    }
  }

  // ── The outer band: a park and a stadium between the ring and the plateau rim ──
  const outerCoarse = decimate(outerBlock.outline, 2.0);
  const outerLut = new Float64Array(720).fill(NaN);
  const outerR = (phi: number) => {
    const k = ((Math.round((phi / (Math.PI * 2)) * 720) % 720) + 720) % 720;
    if (Number.isNaN(outerLut[k])) {
      const a = (k / 720) * Math.PI * 2;
      outerLut[k] = rayToOutline(outerCoarse, 0, 0, Math.cos(a), Math.sin(a));
    }
    return outerLut[k];
  };
  const { parkPhi: PARK_PHI, parkHalf: PARK_HALF, stadiumPhi: STADIUM_PHI, stadiumHalf: STADIUM_HALF } = layout;
  const inArc = (phi: number, c: number, half: number) => Math.abs(Math.atan2(Math.sin(phi - c), Math.cos(phi - c))) < half;
  const reserved = (x: number, z: number) => {
    const phi = Math.atan2(z, x);
    return inArc(phi, PARK_PHI, PARK_HALF + 0.05) || inArc(phi, STADIUM_PHI, STADIUM_HALF + 0.03);
  };

  // Stadium: a bowl facing the ring across a paved forecourt.
  {
    const phi = STADIUM_PHI;
    const r0 = outerR(phi);
    const w = 27;
    const d = 19;
    const fore = 3.2;
    for (let shrink = 1; shrink > 0.75; shrink -= 0.04) {
      const dd = d * shrink;
      const rc = r0 + fore + dd / 2;
      const b: Building = { id: -1, x: Math.cos(phi) * rc, z: Math.sin(phi) * rc, angle: phi - Math.PI / 2, w: w * shrink, d: dd, h: 6.5, style: 'landmark', roof: 'flat', zone: 'civic', wall: 0, roofColor: 1, seed: rng.int(0, 1 << 30), frontEdge: -1, landmark: 'stadium' };
      const corners = cornersOf(b);
      if (corners.some((c) => Math.hypot(c[0], c[1]) > CITY_PLAN_RADIUS - 0.8) || !keep.fits(b, 1.0, 0)) continue;
      addBuilding(b);
      const c = Math.cos(b.angle);
      const sn = Math.sin(b.angle);
      const hw = b.w / 2 + 2;
      const f0 = -b.d / 2 - fore - 0.6;
      const f1 = -b.d / 2 + 0.5;
      const fc: number[] = [];
      for (const [u, v] of [[-hw, f0], [hw, f0], [hw, f1], [-hw, f1]]) fc.push(b.x + u * c - v * sn, b.z + u * sn + v * c);
      addArea('plaza', fc);
      for (const u of [-hw + 1.2, hw - 1.2]) {
        const v = -b.d / 2 - 1.4;
        features.push({ kind: 'flag', x: b.x + u * c - v * sn, z: b.z + u * sn + v * c, angle: b.angle });
      }
      break;
    }
  }

  // Park: lawn out to the rim, a pond, a loop path joined to the ring's sidewalk, trees, benches.
  const pond = { x: 0, z: 0, r: 0 };
  const parkPoly: number[] = [];
  {
    const steps = 40;
    const rimR = CITY_PLAN_RADIUS - 0.8;
    for (let i = 0; i <= steps; i++) {
      const phi = PARK_PHI - PARK_HALF + (2 * PARK_HALF * i) / steps;
      const r = outerR(phi) - 0.3;
      parkPoly.push(Math.cos(phi) * r, Math.sin(phi) * r);
    }
    for (let i = steps; i >= 0; i--) {
      const phi = PARK_PHI - PARK_HALF + (2 * PARK_HALF * i) / steps;
      const wob = 1.2 * Math.sin(phi * 9.0) * Math.sin(phi * 3.1);
      parkPoly.push(Math.cos(phi) * (rimR - 1.2 + wob), Math.sin(phi) * (rimR - 1.2 + wob));
    }
    addArea('park', parkPoly);
    const midR = (outerR(PARK_PHI) + rimR) / 2;
    const pPhi = PARK_PHI + 0.12;
    pond.x = Math.cos(pPhi) * (midR - 0.5);
    pond.z = Math.sin(pPhi) * (midR - 0.5);
    pond.r = 4.2;
    const pondPts: number[] = [];
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      const r = pond.r * (1 + 0.18 * Math.sin(3 * a + 1.3) + 0.07 * Math.sin(5 * a));
      pondPts.push(pond.x + Math.cos(a) * r * 1.25, pond.z + Math.sin(a) * r);
    }
    addArea('water', pondPts);
    const loop = smoothClosed(resampleClosed(inset(positive(parkPoly.slice()), 4.6), 1.0), 6);
    const entries: Array<{ node: number; x: number; z: number }> = [];
    for (const f of [-0.62, 0, 0.62]) {
      const phi = PARK_PHI + PARK_HALF * f;
      const r = outerR(phi) - 1.1;
      const en = W.entryAt(Math.cos(phi) * r, Math.sin(phi) * r);
      if (en) entries.push(en);
    }
    W.addLoop(loop, entries, 'park', 2.0);
  }
  for (const w of W.extra) keep.addPolyline(w.path.pts, w.width / 2 + 0.2);
  keep.addCapsule(pond.x, pond.z, pond.x, pond.z, pond.r * 1.45);

  // ── Downtown characters: a market lane through one block, a church square in another ──
  const byArea = downtown.slice().sort((a, b) => b.area - a.area);
  const marketBlk = byArea[rng.int(0, 1)];
  const churchBlk = byArea.find((b) => b !== marketBlk && b !== byArea[2]) ?? byArea[2];
  let marketLane: WalkEdge | null = null;
  {
    const blk = marketBlk;
    // From the middle of its plaza side to the facing ring side, across the block's depth.
    const plazaSide = blk.sides.find((h) => g.edges[h.edge].kind === 'street');
    const ringSides = blk.sides.filter((h) => g.edges[h.edge].kind === 'ring');
    if (plazaSide && ringSides.length) {
      const sideMid = (h: { edge: number; fwd: boolean }, f = 0.5) => {
        const e = g.edges[h.edge];
        const m = ps();
        sampleAt(e.centre, e.centre.length * f, m);
        const off = (h.fwd ? -1 : 1) * (e.width / 2 + e.sidewalk / 2);
        return { x: m.x - m.tz * off, z: m.z + m.tx * off };
      };
      const a = sideMid(plazaSide, 0.5 + rng.range(-0.08, 0.08));
      // the ring-side sidewalk point straight across (through the block's centre)
      const dx = blk.cx - a.x;
      const dz = blk.cz - a.z;
      const target = { x: blk.cx + dx * 1.2, z: blk.cz + dz * 1.2 };
      let best: { x: number; z: number } | null = null;
      let bd = Infinity;
      for (const h of ringSides) {
        for (let f = 0.25; f <= 0.75; f += 0.05) {
          const p = sideMid(h, f);
          const d = Math.hypot(p.x - target.x, p.z - target.z);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
      }
      const ea = W.entryAt(a.x, a.z);
      const eb = best ? W.entryAt(best.x, best.z) : null;
      if (ea && eb) {
        // A gentle S through the block, square to both sidewalks.
        const L = Math.hypot(eb.x - ea.x, eb.z - ea.z);
        const ux = (eb.x - ea.x) / L;
        const uz = (eb.z - ea.z) / L;
        const k = rng.range(-0.22, 0.22);
        const pts = hermitePoints(ea.x, ea.z, ux * Math.cos(k) - uz * Math.sin(k), uz * Math.cos(k) + ux * Math.sin(k), eb.x, eb.z, ux * Math.cos(-k) - uz * Math.sin(-k), uz * Math.cos(-k) + ux * Math.sin(-k), 0.5, 0.4);
        marketLane = W.addEdge(ea.node, eb.node, 'footpath', pts, LANE_W);
        keep.addPolyline(marketLane.path.pts, LANE_W / 2 + 0.15, 2);
      }
    }
  }

  // Church: on a little square on one of the block's avenue sides.
  let church: Building | null = null;
  {
    const blk = churchBlk;
    const sides = blk.sides.filter((h) => g.edges[h.edge].kind === 'avenue').sort((p, q) => g.edges[q.edge].centre.length - g.edges[p.edge].centre.length);
    for (const h of sides) {
      const e = g.edges[h.edge];
      const run = offset(travelPath(e, h.fwd), -(e.width / 2 + e.sidewalk));
      const m0 = ps();
      const m1 = ps();
      const s0 = run.length * 0.5 - 7.5;
      sampleAt(run, s0, m0);
      sampleAt(run, s0 + 15, m1);
      let tx = m1.x - m0.x;
      let tz = m1.z - m0.z;
      const tl = Math.hypot(tx, tz);
      tx /= tl;
      tz /= tl;
      const nx = tz; // into the block (on the left of travel)
      const nz = -tx;
      const angle = Math.atan2(-nx, nz);
      const fx = (m0.x + m1.x) / 2;
      const fz = (m0.z + m1.z) / 2;
      const sq = 8.5; // square depth from the sidewalk edge
      const b: Building = { id: -1, x: fx + nx * (sq + 6.75), z: fz + nz * (sq + 6.75), angle, w: 9, d: 13.5, h: 19, style: 'landmark', roof: 'gable', zone: 'civic', wall: 0, roofColor: 1, seed: rng.int(0, 1 << 30), frontEdge: h.edge, landmark: 'church' };
      if (!keep.fits(b, 0.3, 0.5)) continue;
      church = addBuilding(b);
      // The square: from the sidewalk edge to the church front, a little wider than the church.
      const hw = 7.2;
      const corners: number[] = [];
      for (const [u, v] of [[-hw, -0.1], [hw, -0.1], [hw, sq + 0.2], [-hw, sq + 0.2]]) corners.push(fx + tx * u + nx * v, fz + tz * u + nz * v);
      addArea('plaza', corners, PAVED_H + 0.006);
      keep.addCapsule(fx + nx * sq * 0.5 - tx * (hw - sq * 0.5), fz + nz * sq * 0.5 - tz * (hw - sq * 0.5), fx + nx * sq * 0.5 + tx * (hw - sq * 0.5), fz + nz * sq * 0.5 + tz * (hw - sq * 0.5), sq * 0.5);
      const at = (u: number, v: number) => ({ x: fx + tx * u + nx * v, z: fz + tz * u + nz * v });
      features.push({ kind: 'statue', ...at(0, sq * 0.45), angle: angle + Math.PI });
      for (const u of [-5, 5]) {
        features.push({ kind: 'tree', ...at(u, sq * 0.55), angle: 0, size: rng.range(4.6, 5.6), seed: rng.int(0, 1 << 30), r: 0.55 });
        features.push({ kind: 'planter', ...at(u, sq * 0.55), angle, r: 0.55 });
        features.push({ kind: 'bench', ...at(u * 0.55, sq * 0.82), angle: angle + Math.PI });
      }
      break;
    }
  }

  // ── Frontage buildings on downtown street sides ──
  const keepEdge = (x: number, z: number) => {
    let best = -1;
    let bd = Infinity;
    for (const e of g.edges) {
      const p = e.centre.pts;
      for (let i = 0; i + 7 < p.length; i += 6) {
        const d = segPointDist(x, z, p[i], p[i + 1], p[i + 6], p[i + 7]);
        if (d < bd) {
          bd = d;
          best = e.id;
        }
      }
    }
    return best;
  };
  const scales = [1.12, 0.8, 0.94, 0.74, 0.86];
  const blockScale = new Map<number, number>();
  downtown.forEach((b, i) => blockScale.set(b.id, scales[(i + rng.int(0, 4)) % scales.length]));
  const at = (pl: Polyline, s: number, out: P) => {
    if (s >= 0 && s <= pl.length) return sampleAt(pl, s, out);
    const end = s > pl.length;
    sampleAt(pl, end ? pl.length : 0, out);
    const ds = end ? s - pl.length : s;
    out.x += out.tx * ds;
    out.z += out.tz * ds;
    return out;
  };
  /** Walk a run (the block on its LEFT), placing buildings with their fronts on it. */
  const walkSide = (blk: Block, run: Polyline, pass: 0 | 1, kind: 'street' | 'lane') => {
    const L = run.length;
    const p0 = ps();
    const p1 = ps();
    let s = kind === 'lane' ? 0.4 : pass === 0 ? -3 : -3.5;
    const end = kind === 'lane' ? L - 0.4 : L + 3;
    let prevWall = -1;
    while (s < end - 4) {
      at(run, s, p0);
      const spec = kind === 'lane' ? laneSpec(rng) : pickSpec(rng, 'downtown', Math.hypot(p0.x, p0.z), pass, blockScale.get(blk.id) ?? 1);
      let placed: Building | null = null;
      at(run, s + 1.6, p1);
      if (!keep.discClear(p1.x + p1.tz * (spec.setback + 1.0), p1.z - p1.tx * (spec.setback + 1.0), 0.7)) {
        s += pass === 0 ? 1.2 : 0.9;
        continue;
      }
      for (const ws of pass === 0 ? [1, 0.7] : [1]) {
        const w = Math.max(pass === 1 ? 4.2 : 5.2, spec.w * ws);
        if (s + w > end) continue;
        // cheap reject: the far end of this frontage already taken
        at(run, s + w - 0.9, p1);
        if (!keep.discClear(p1.x + p1.tz * (spec.setback + 1.0), p1.z - p1.tx * (spec.setback + 1.0), 0.55)) continue;
        at(run, s + w, p1);
        let tx = p1.x - p0.x;
        let tz = p1.z - p0.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const nx = tz;
        const nz = -tx;
        const angle = Math.atan2(-nx, nz);
        const fx = (p0.x + p1.x) / 2;
        const fz = (p0.z + p1.z) / 2;
        const across = rayToOutline(coarse(blk), fx + nx * 0.5, fz + nz * 0.5, nx, nz);
        const maxD = Math.min(spec.dMax, kind === 'lane' ? across - spec.setback - 0.3 : across * 0.62 - spec.setback - 0.25);
        if (maxD < spec.dMin) continue;
        const tries = [maxD, Math.max(spec.dMin, maxD * 0.65)].filter((d, k, a) => d >= spec.dMin && (k === 0 || d < a[k - 1] - 0.4));
        for (const d of tries) {
          const off = spec.setback + d / 2;
          const shallow = d < 7.5 && (spec.style === 'tower' || spec.style === 'office');
          const b: Building = { id: -1, x: fx + nx * off, z: fz + nz * off, angle, w, d, h: shallow ? Math.min(spec.h, rng.range(7, 12)) : spec.h, style: shallow ? 'midrise' : spec.style, roof: spec.roof, zone: spec.zone, wall: 0, roofColor: 0, seed: 0, frontEdge: -1 };
          if (keep.fits(b, kind === 'lane' ? 0.05 : 0.2, spec.gap)) {
            placed = b;
            break;
          }
        }
        if (placed) break;
      }
      if (placed) {
        placed.wall = pickWall(rng, placed.style, prevWall);
        placed.roofColor = rng.int(0, 2);
        placed.seed = rng.int(0, 1 << 30);
        placed.tiers = tiersFor(placed, rng);
        placed.door = doorFor(placed);
        placed.frontEdge = kind === 'lane' ? -1 : keepEdge(placed.x + Math.sin(placed.angle) * (placed.d / 2 + 4), placed.z - Math.cos(placed.angle) * (placed.d / 2 + 4));
        prevWall = addBuilding(placed).wall;
        s += placed.w + spec.gap;
      } else s += pass === 0 ? 1.2 : 0.9;
    }
  };
  // Market lane: small shops shoulder to shoulder down both sides, fronts on the lane.
  if (marketLane) {
    const lane = marketLane as WalkEdge;
    walkSide(marketBlk, offset(lane.path, -(LANE_W / 2)), 0, 'lane');
    walkSide(marketBlk, offset(reversed(lane.path), -(LANE_W / 2)), 0, 'lane');
  }
  for (const blk of downtown) {
    const order = (k: string) => (k === 'street' ? 0 : k === 'ring' ? 1 : 2);
    const sides = blk.sides.slice().sort((p, q) => order(g.edges[p.edge].kind) - order(g.edges[q.edge].kind));
    const runs = sides.map((h) => {
      const e = g.edges[h.edge];
      return offset(travelPath(e, h.fwd), -(e.width / 2 + e.sidewalk));
    });
    for (const pass of [0, 1] as const) for (const run of runs) walkSide(blk, run, pass, 'street');
  }

  // ── Deepen: push each frontage building back into the block interior while it fits (fronts stay
  // on the street), so blocks are built up rather than ringed with a thin crust ──
  for (const blk of downtown) {
    const poly = coarse(blk);
    for (const b of buildings) {
      if (b.frontEdge < 0 || b.landmark || b.zone === 'residential' || !pointInPolygon(poly, b.x, b.z)) continue;
      const sx = -Math.sin(b.angle); // local +z (into the lot) in plan
      const sz = Math.cos(b.angle);
      const d0 = b.d;
      const x0 = b.x;
      const z0 = b.z;
      let grown = false;
      for (const add of [6.4, 4, 2.4, 1.2]) {
        if (d0 + add > (b.style === 'tower' ? 17 : 15)) continue;
        b.d = d0 + add;
        b.x = x0 + sx * add * 0.5;
        b.z = z0 + sz * add * 0.5;
        if (keep.fits(b, 0.3, 0.8, b) && cornersOf(b).every((c) => pointInPolygon(poly, c[0], c[1]))) {
          grown = true;
          break;
        }
      }
      if (!grown) {
        b.d = d0;
        b.x = x0;
        b.z = z0;
      }
      if (grown && b.d > d0) keep.addBuilding(b); // re-file under its new reach
    }
  }

  // ── Back row: courtyard buildings in the leftover interior of each downtown block ──
  for (const blk of downtown) {
    const poly = coarse(blk);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]);
      x1 = Math.max(x1, poly[i]);
      z0 = Math.min(z0, poly[i + 1]);
      z1 = Math.max(z1, poly[i + 1]);
    }
    let placed = 0;
    for (let z = z0 + 3.5; z < z1 - 3.5 && placed < 8; z += 3) {
      for (let x = x0 + 3.5; x < x1 - 3.5 && placed < 8; x += 3) {
        if (!keep.discClear(x, z, 2.5) || !pointInPolygon(poly, x, z)) continue;
        // Align with the nearest building already standing in this block (or square to it).
        let ang = 0;
        let bd = Infinity;
        for (const b of buildings) {
          const d = Math.abs(b.x - x) + Math.abs(b.z - z);
          if (d < bd && b.style !== 'landmark') {
            bd = d;
            ang = b.angle;
          }
        }
        let done = false;
        for (const [w, d] of [[11, 8.5], [9, 7.5], [7.5, 6.5], [6, 5.6], [5, 5]]) {
          for (const a of [ang, ang + Math.PI / 2]) {
            const b: Building = { id: -1, x, z, angle: a, w, d, h: rng.range(6.5, 12.5), style: 'midrise', roof: rng.chance(0.3) ? 'hip' : 'flat', zone: 'midrise', wall: 0, roofColor: rng.int(0, 2), seed: rng.int(0, 1 << 30), frontEdge: -1 };
            if (!keep.fits(b, 0.35, 0.9)) continue;
            if (!cornersOf(b).every((c) => pointInPolygon(poly, c[0], c[1]))) continue;
            b.wall = pickWall(rng, 'midrise', -1);
            b.door = doorFor(b);
            addBuilding(b);
            placed++;
            done = true;
            break;
          }
          if (done) break;
        }
      }
    }
  }

  // ── Courtyards: raised lawn beds with trees and benches in the larger open spots, planter trees
  // in the smaller ones, so no block is a bare car park from above ──
  const trees: Array<{ x: number; z: number; r: number }> = [];
  // Trees filed in a 6 m hash grid for the spacing test.
  const TG = 6;
  const tgrid = new Map<number, number[]>();
  const tkey = (i: number, j: number) => (i + 64) * 256 + (j + 64);
  const spaced = (x: number, z: number, minD: number) => {
    const i0 = Math.floor((x - minD) / TG), i1 = Math.floor((x + minD) / TG);
    const j0 = Math.floor((z - minD) / TG), j1 = Math.floor((z + minD) / TG);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const l = tgrid.get(tkey(i, j));
        if (!l) continue;
        for (const k of l) if (Math.hypot(trees[k].x - x, trees[k].z - z) < minD) return false;
      }
    }
    return true;
  };
  const fileTree = (x: number, z: number, r: number) => {
    const k = tkey(Math.floor(x / TG), Math.floor(z / TG));
    let l = tgrid.get(k);
    if (!l) tgrid.set(k, (l = []));
    l.push(trees.length);
    trees.push({ x, z, r });
  };
  const addTree = (x: number, z: number, size: number, r?: number) => {
    fileTree(x, z, size * 0.35);
    const f: Feature = { kind: 'tree', x, z, angle: rng.range(0, Math.PI * 2), size, seed: rng.int(0, 1 << 30) };
    if (r !== undefined) f.r = r;
    features.push(f);
  };
  for (const f of features) if (f.kind === 'tree') fileTree(f.x, f.z, 2);
  for (const blk of downtown) {
    const poly = coarse(blk);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]);
      x1 = Math.max(x1, poly[i]);
      z0 = Math.min(z0, poly[i + 1]);
      z1 = Math.max(z1, poly[i + 1]);
    }
    const cands: Array<{ x: number; z: number; r: number }> = [];
    for (let z = z0 + 2; z < z1 - 2; z += 2.5) {
      for (let x = x0 + 2; x < x1 - 2; x += 2.5) {
        if (!keep.discClear(x, z, 1.7) || !pointInPolygon(poly, x, z)) continue;
        let r = 1.7;
        for (const t of [2.6, 3.4, 4.4, 5.6]) {
          if (!keep.discClear(x, z, t)) break;
          r = t;
        }
        cands.push({ x, z, r });
      }
    }
    cands.sort((a, b) => b.r - a.r);
    let beds = 0;
    let planters = 0;
    let flowers = 0;
    for (const c of cands) {
      if (!keep.discClear(c.x, c.z, 1.7)) continue;
      // A lawn bed as a rounded rectangle squared to the nearest building, as big as fits with a
      // paved walk (0.9 m) round it.
      let ang = 0;
      let bd = Infinity;
      for (const b of buildings) {
        const d = Math.abs(b.x - c.x) + Math.abs(b.z - c.z);
        if (d < bd) {
          bd = d;
          ang = b.angle;
        }
      }
      let bed: Building | null = null;
      if (beds < 9 && c.r >= 2.6) {
        for (const [w, d] of [[11, 7], [8.5, 6], [7, 4.6], [5.4, 3.8], [4.2, 3.0]]) {
          if (d / 2 + 0.9 > c.r + 0.6) continue;
          for (const a of [ang, ang + Math.PI / 2]) {
            const b: Building = { id: -1, x: c.x, z: c.z, angle: a, w, d, h: 0, style: 'house', roof: 'flat', zone: 'park', wall: 0, roofColor: 0, seed: 0, frontEdge: -1 };
            if (!keep.fits(b, 0.9, 0.9) || !cornersOf(b).every((q) => pointInPolygon(poly, q[0], q[1]))) continue;
            bed = b;
            break;
          }
          if (bed) break;
        }
      }
      if (bed) {
        const rc = Math.min(1.3, Math.min(bed.w, bed.d) * 0.3);
        addArea('park', roundedRect(bed.x, bed.z, bed.w / 2, bed.d / 2, bed.angle, rc), BED_H);
        // reserve it plus its walk (a capsule along its long axis)
        const ca = Math.cos(bed.angle);
        const sa = Math.sin(bed.angle);
        const half = Math.max(0, bed.w / 2 - bed.d / 2);
        keep.addCapsule(bed.x - ca * half, bed.z - sa * half, bed.x + ca * half, bed.z + sa * half, bed.d / 2 + 0.9);
        const nT = bed.w > 8 ? 3 : bed.w > 5 ? 2 : 1;
        for (let k = 0; k < nT; k++) {
          const u = nT === 1 ? 0 : (k / (nT - 1) - 0.5) * (bed.w - 2.4);
          const tx = bed.x + ca * u + rng.range(-0.3, 0.3);
          const tz = bed.z + sa * u + rng.range(-0.3, 0.3);
          if (spaced(tx, tz, 2.4)) addTree(tx, tz, rng.range(3.6, 5.8), 0.35);
        }
        // a bench on the paving facing the bed's long side
        const side = rng.chance(0.5) ? 1 : -1;
        const bx = bed.x - sa * side * (bed.d / 2 + 0.55);
        const bz = bed.z + ca * side * (bed.d / 2 + 0.55);
        if (keep.discClear(bx, bz, 0.5)) features.push({ kind: 'bench', x: bx, z: bz, angle: bed.angle + (side > 0 ? Math.PI : 0) });
        beds++;
      } else if (planters < 14 && spaced(c.x, c.z, 3.0)) {
        addTree(c.x, c.z, rng.range(3.4, 4.8), 0.55);
        features.push({ kind: 'planter', x: c.x, z: c.z, angle: ang, r: 0.55 });
        keep.addCapsule(c.x, c.z, c.x, c.z, 0.9);
        planters++;
      } else if (flowers < 8 && spaced(c.x, c.z, 2.0)) {
        // a flower planter (no tree): colour on the paving between the trees
        fileTree(c.x, c.z, 0.6);
        features.push({ kind: 'planter', x: c.x, z: c.z, angle: ang, r: 0.75 });
        keep.addCapsule(c.x, c.z, c.x, c.z, 1.1);
        flowers++;
      }
    }
  }

  // ── Houses round the ring and the cul-de-sacs ──
  const gardenKeep = new KeepOut();
  const gardenLots: Array<{ outline: number[]; b: Building }> = [];
  const addGarden = (b: Building, gap: number, setback: number) => {
    const c = Math.cos(b.angle);
    const sn = Math.sin(b.angle);
    const front = -b.d / 2 - setback - 0.1;
    for (const hw of [b.w / 2 + gap / 2 - 0.05, b.w / 2 + 0.35]) {
      for (let back = b.d / 2 + 7; back >= b.d / 2 + 1.4; back -= 0.7) {
        const box: Building = { id: -1, x: b.x - ((front + back) / 2) * sn, z: b.z + ((front + back) / 2) * c, angle: b.angle, w: 2 * hw, d: back - front, h: 0, style: 'house', roof: 'flat', zone: 'residential', wall: 0, roofColor: 0, seed: 0, frontEdge: -1 };
        if (cornersOf(box).some((p) => Math.hypot(p[0], p[1]) > CITY_PLAN_RADIUS - 0.6)) continue;
        if (!gardenKeep.fits(box, 0, 0.02)) continue;
        gardenKeep.addBuilding(box);
        const outline: number[] = [];
        for (const [u, v] of [[-hw, front], [hw, front], [hw, back], [-hw, back]]) outline.push(b.x + u * c - v * sn, b.z + u * sn + v * c);
        gardenLots.push({ outline, b });
        return;
      }
    }
  };
  {
    const blk = outerBlock;
    const ol = blk.outline;
    const line = polyline(Array.from(ol), false);
    const L = line.length;
    const p0 = ps();
    const p1 = ps();
    let s = rng.range(0, 3);
    let prevWall = -1;
    while (s < L - 3) {
      sampleAt(line, s, p0);
      const spec = houseSpec(rng);
      const w = spec.w;
      sampleAt(line, Math.min(L, s + w), p1);
      let tx = p1.x - p0.x;
      let tz = p1.z - p0.z;
      const tl = Math.hypot(tx, tz);
      if (tl < w * 0.88 || reserved(p0.x, p0.z) || reserved(p1.x, p1.z)) {
        s += 1.4;
        continue;
      }
      tx /= tl;
      tz /= tl;
      // The outer face keeps its traversal order (face on the left): the front faces −n.
      const nx = tz;
      const nz = -tx;
      const angle = Math.atan2(-nx, nz);
      const fx = (p0.x + p1.x) / 2;
      const fz = (p0.z + p1.z) / 2;
      let placed: Building | null = null;
      for (const d of [spec.dMax, (spec.dMax + spec.dMin) / 2, spec.dMin]) {
        for (const extra of [0, 0.7]) {
          const off = spec.setback + extra + d / 2;
          const b: Building = { id: -1, x: fx + nx * off, z: fz + nz * off, angle, w, d, h: spec.h, style: spec.style, roof: spec.roof, zone: spec.zone, wall: 0, roofColor: 0, seed: 0, frontEdge: -1 };
          if (Math.hypot(b.x, b.z) + Math.hypot(w, d) / 2 > CITY_PLAN_RADIUS - 0.8) continue;
          if (!keep.fits(b, Math.min(spec.setback, 0.5) - 0.05, spec.gap)) continue;
          placed = b;
          spec.setback += extra;
          break;
        }
        if (placed) break;
      }
      if (placed) {
        placed.wall = pickWall(rng, placed.style === 'shop' ? 'shop' : 'house', prevWall);
        placed.roofColor = rng.chance(0.58) ? 0 : rng.chance(0.6) ? 1 : 2;
        placed.seed = rng.int(0, 1 << 30);
        placed.door = doorFor(placed);
        placed.frontEdge = keepEdge(fx - nx * 4, fz - nz * 4);
        const b = addBuilding(placed);
        prevWall = b.wall;
        if (b.style === 'house') addGarden(b, spec.gap, spec.setback);
        s += w + spec.gap + rng.range(0.1, 1.4);
      } else s += 1.2;
    }
  }

  // ── Lots: the paved ground of each downtown block (flush with the sidewalks) ──
  for (const blk of downtown) addArea('lot', inset(blk.outline, -0.1), PAVED_H);
  for (const gl of gardenLots) addArea('garden', gl.outline);

  // ── Trees ──
  const parkCoarse = decimate(parkPoly, 2);
  const treeOk = (x: number, z: number, r: number, poly: ArrayLike<number>, edgeClear: number) =>
    pointInPolygon(poly, x, z) && distToOutline(poly, x, z) > edgeClear && keep.discClear(x, z, r) && Math.hypot(x, z) < CITY_PLAN_RADIUS - 1.5;
  for (let i = 0; i < 300; i++) {
    const phi = PARK_PHI + rng.range(-PARK_HALF, PARK_HALF);
    const r = rng.range(62, CITY_PLAN_RADIUS);
    const x = Math.cos(phi) * r;
    const z = Math.sin(phi) * r;
    const size = rng.range(4.2, 8.5);
    if (Math.hypot(x - pond.x, z - pond.z) < pond.r * 1.6 + 1) continue;
    if (r < outerR(phi) + 5.5) continue;
    if (!spaced(x, z, 3.4 + size * 0.25)) continue;
    if (!treeOk(x, z, 1.3, parkCoarse, 1.6)) continue;
    addTree(x, z, size);
  }
  // Plaza: a ring of trees in planters just inside its edge, clear of the paths and furniture.
  {
    const ring = inset(plazaBlock.outline, 2.3);
    const pl = polyline([...ring, ring[0], ring[1]]);
    const pt = ps();
    for (let s = 0; s < pl.length; s += 4.6) {
      sampleAt(pl, s, pt);
      if (!keep.discClear(pt.x, pt.z, 1.25)) continue;
      if (features.some((f) => f.kind !== 'tree' && Math.abs(f.x - pt.x) < 2.6 && Math.hypot(f.x - pt.x, f.z - pt.z) < 2.6)) continue;
      if (!spaced(pt.x, pt.z, 4.2)) continue;
      addTree(pt.x, pt.z, rng.range(4.6, 6.2), 1.2);
      features.push({ kind: 'planter', x: pt.x, z: pt.z, angle: 0, r: 1.15 });
    }
  }
  // Gardens: one or two per house, behind it.
  for (const gl of gardenLots) {
    const b = gl.b;
    const c = Math.cos(b.angle);
    const sn = Math.sin(b.angle);
    const n = rng.chance(0.55) ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const u = rng.range(-b.w / 2 + 1, b.w / 2 - 1);
      const v = b.d / 2 + rng.range(2.0, 5.5);
      const x = b.x + u * c - v * sn;
      const z = b.z + u * sn + v * c;
      const size = rng.range(3.2, 5.8);
      if (!pointInPolygon(gl.outline, x, z) || !keep.discClear(x, z, 1.0) || !spaced(x, z, 3) || Math.hypot(x, z) > CITY_PLAN_RADIUS - 1.2) continue;
      addTree(x, z, size);
    }
  }

  // ── Street furniture ──
  const sp = ps();
  const lamps: Array<{ x: number; z: number }> = [];
  for (const e of g.edges) {
    const L = e.centre.length;
    const spacing = e.kind === 'ring' ? 17 : e.kind === 'lane' ? 13 : 15;
    for (const side of [1, -1]) {
      if (e.kind === 'lane' && side === -1) continue;
      const start = side === 1 ? 5.5 : 5.5 + spacing / 2;
      for (let s = start; s < L - 5.5; s += spacing) {
        sampleAt(e.centre, s, sp);
        const off = side * (e.width / 2 + 0.45);
        const x = sp.x - sp.tz * off;
        const z = sp.z + sp.tx * off;
        features.push({ kind: 'streetlight', x, z, angle: Math.atan2(sp.tx * -side, -sp.tz * -side) });
        lamps.push({ x, z });
        if (e.kind !== 'ring' && rng.chance(0.3) && s + 2.2 < L - 4) {
          sampleAt(e.centre, s + 2.2, sp);
          features.push({ kind: 'hydrant', x: sp.x - sp.tz * off, z: sp.z + sp.tx * off, angle: Math.atan2(sp.tz, sp.tx) });
        }
      }
    }
  }
  // Street trees in pits along the avenues, between the lamps, clear of crossings and corners.
  for (const e of g.edges) {
    if (e.kind !== 'avenue') continue;
    const L = e.centre.length;
    for (const side of [1, -1]) {
      for (let s = 9 + (side === 1 ? 7.5 : 0); s < L - 9; s += 15) {
        sampleAt(e.centre, s, sp);
        const off = side * (e.width / 2 + 0.55);
        const x = sp.x - sp.tz * off;
        const z = sp.z + sp.tx * off;
        if (lamps.some((l) => Math.abs(l.x - x) < 3 && Math.hypot(l.x - x, l.z - z) < 3)) continue;
        if (!spaced(x, z, 4)) continue;
        if (buildings.some((b) => Math.abs(b.x - x) < 20 && obbDistance(b, x, z) < 1.1)) continue;
        addTree(x, z, rng.range(3.8, 4.8), 0.3);
      }
    }
  }
  // Bus stops: on the longest ring arcs, outer sidewalk, facing the road.
  {
    const ring = g.edges.filter((e) => e.kind === 'ring').sort((a, b) => b.centre.length - a.centre.length);
    for (const e of ring.slice(0, 3)) {
      sampleAt(e.centre, e.centre.length * 0.5, sp);
      const outward = Math.sign(sp.x * -sp.tz + sp.z * sp.tx) || 1;
      const off = outward * (e.width / 2 + e.sidewalk - 0.7);
      const x = sp.x - sp.tz * off;
      const z = sp.z + sp.tx * off;
      if (W.nodes.some((n) => Math.hypot(n.x - x, n.z - z) < 3.5)) continue;
      if (features.some((f) => Math.abs(f.x - x) < 2 && Math.hypot(f.x - x, f.z - z) < 2)) continue;
      features.push({ kind: 'bus-stop', x, z, angle: Math.atan2(outward * sp.tz, outward * sp.tx) });
    }
  }
  // Park benches along the loop path, facing it.
  for (const w of W.extra) {
    if (w.kind !== 'park' || w.path.length < 9) continue;
    sampleAt(w.path, w.path.length * 0.5, sp);
    for (const side of [1, -1]) {
      const off = side * (w.width / 2 + 0.75);
      const x = sp.x - sp.tz * off;
      const z = sp.z + sp.tx * off;
      if (Math.hypot(x - pond.x, z - pond.z) < pond.r + 1.2) continue;
      if (!pointInPolygon(parkCoarse, x, z) || distToOutline(parkCoarse, x, z) < 1) continue;
      if (!spaced(x, z, 1.6)) continue;
      features.push({ kind: 'bench', x, z, angle: Math.atan2(-side * sp.tz, -side * sp.tx) });
      break;
    }
  }
  // Market lane: globe lamps and planters down its length.
  if (marketLane) {
    const lane = marketLane as WalkEdge;
    for (let s = 3; s < lane.path.length - 3; s += 5.5) {
      sampleAt(lane.path, s, sp);
      const side = Math.round(s / 5.5) % 2 ? 1 : -1;
      const off = side * (LANE_W / 2 - 0.35);
      features.push({ kind: 'lamp', x: sp.x - sp.tz * off, z: sp.z + sp.tx * off, angle: 0, r: 0.2 });
    }
  }

  // ── Viewpoints, and the café the street viewpoint looks at ──
  const viewpoints = pickViewpoints(seed, g, layout, buildings, features, plazaBlock, W, PARK_PHI, plazaFountain, keep);
  dressCafe(viewpoints.street, buildings, features, keep);
  void church;

  const walk = W.finish();
  return {
    seed,
    radius: CITY_PLAN_RADIUS,
    nodes: g.nodes,
    edges: g.edges,
    lanes: g.lanes,
    connectors: g.connectors,
    intersections: g.intersections,
    walkNodes: walk.nodes,
    walkEdges: walk.edges,
    buildings,
    areas,
    features,
    viewpoints,
  };
}

// ── Block roles ──

function assignRoles(blocks: Block[]): Map<number, BlockRole> {
  const roles = new Map<number, BlockRole>();
  for (const b of blocks) roles.set(b.id, b.outer ? 'outer' : pointInPolygon(b.outline, 0, 0) ? 'plaza' : 'downtown');
  return roles;
}

// ── Building specs ──

interface Spec {
  style: BuildingStyle;
  zone: Zone;
  roof: RoofKind;
  w: number;
  dMin: number;
  dMax: number;
  h: number;
  setback: number;
  gap: number;
}

function houseSpec(rng: Rng): Spec {
  // A corner shop now and then: a gabled two-storey house with a shop on the ground floor.
  if (rng.chance(0.08)) return { style: 'shop', zone: 'residential', roof: 'gable', w: rng.range(7, 8.8), dMin: 6.2, dMax: 7.6, h: rng.range(7.6, 8.6), setback: rng.range(1.0, 1.6), gap: 1.8 };
  const two = rng.chance(0.36);
  const h = two ? rng.range(7.4, 8.8) : rng.range(4.6, 6.6);
  return { style: 'house', zone: 'residential', roof: rng.chance(0.66) ? 'gable' : 'hip', w: rng.range(6.4, 9), dMin: 6, dMax: rng.range(7, 8.6), h, setback: rng.range(1.8, 3.6), gap: rng.range(2.4, 3.8) };
}

function laneSpec(rng: Rng): Spec {
  return { style: rng.chance(0.65) ? 'shop' : 'midrise', zone: 'midrise', roof: rng.chance(0.3) ? 'hip' : 'flat', w: rng.range(5.4, 7.4), dMin: 5.5, dMax: 9, h: rng.range(5, 9.5), setback: 0.3, gap: 0.06 };
}

function pickSpec(rng: Rng, role: BlockRole, r: number, pass: 0 | 1 = 0, hScale = 1): Spec {
  void role;
  const t = Math.min(1, Math.max(0, (r - 24) / 28));
  const tall = Math.min(34, (36 - (r - 24) * 0.9) * hScale + rng.range(-3, 2));
  if (pass === 1) {
    if (t < 0.45) return { style: rng.chance(0.5) ? 'office' : 'midrise', zone: 'downtown', roof: 'flat', w: rng.range(6, 9), dMin: 6, dMax: 15, h: Math.max(9, tall * rng.range(0.4, 0.7)), setback: 0.6, gap: 0.06 };
    return { style: rng.chance(0.3) ? 'shop' : 'midrise', zone: 'midrise', roof: rng.chance(0.25) ? 'hip' : 'flat', w: rng.range(4.2, 7.5), dMin: 5, dMax: 14, h: rng.range(6, 12.5), setback: 0.7, gap: 0.06 };
  }
  if (t < 0.6) {
    if (rng.chance(0.22)) return { style: 'office', zone: 'downtown', roof: 'flat', w: rng.range(10, 14), dMin: 8, dMax: 15, h: Math.max(12, tall * 0.72), setback: 0.6, gap: rng.range(0.06, 0.9) };
    return { style: 'tower', zone: 'downtown', roof: rng.chance(0.35) ? 'stepped' : 'flat', w: rng.range(9.5, 14), dMin: 8.5, dMax: 15, h: Math.max(14, tall), setback: 0.6, gap: rng.range(0.3, 1.2) };
  }
  if (rng.chance(0.28)) return { style: 'shop', zone: 'midrise', roof: 'flat', w: rng.range(7, 10), dMin: 6, dMax: 11, h: rng.range(4.5, 7), setback: 0.7, gap: rng.range(0.06, 0.9) };
  if (rng.chance(0.35)) return { style: 'office', zone: 'midrise', roof: 'flat', w: rng.range(9, 13), dMin: 8, dMax: 14, h: rng.range(10, 17), setback: 0.7, gap: rng.range(0.06, 1.0) };
  return { style: 'midrise', zone: 'midrise', roof: rng.chance(0.3) ? 'hip' : 'flat', w: rng.range(8.5, 13), dMin: 7, dMax: 14, h: rng.range(8, 15), setback: 0.7, gap: rng.range(0.06, 1.0) };
}

const WALLS: Record<BuildingStyle, number[]> = {
  tower: [6, 6, 2, 0, 5, 6],
  office: [0, 2, 6, 3, 0],
  midrise: [1, 3, 4, 5, 0, 2, 1],
  shop: [4, 3, 2, 0, 5, 1],
  house: [0, 4, 3, 5, 2, 0, 1],
  landmark: [0],
};

function pickWall(rng: Rng, style: BuildingStyle, prev: number): number {
  const opts = WALLS[style];
  for (let k = 0; k < 6; k++) {
    const w = rng.pick(opts);
    if (w !== prev) return w;
  }
  return opts[0];
}

function tiersFor(b: Building, rng: Rng): Building['tiers'] {
  if (b.style !== 'tower' || b.h < 17) return undefined;
  const podium = rng.range(4.2, 6);
  const minSide = Math.min(b.w, b.d);
  const t: Array<{ h: number; inset: number }> = [{ h: podium, inset: 0 }];
  if (b.h > 24 && minSide > 11) {
    const mid = podium + (b.h - podium) * rng.range(0.55, 0.75);
    t.push({ h: mid, inset: 0.9 }, { h: b.h, inset: 2.1 });
  } else {
    t.push({ h: b.h, inset: 0.9 });
  }
  return t;
}

/** Local x of the main entrance (seeded, off-centre on wide fronts, centred on narrow ones). */
function doorFor(b: Building): number {
  const hw = b.w / 2 - 1.4;
  if (hw <= 0.4) return 0;
  const f = (((b.seed >>> 3) % 1000) / 1000 - 0.5) * 2;
  return b.style === 'tower' || b.style === 'office' ? Math.round(f) * hw * 0.5 : f * hw * 0.7;
}

// ── The café the dive lands at ──

/**
 * Dress the building the street viewpoint looks at: the nearest frontage building ahead within a
 * 50° cone and 22 m, on the viewpoint's own side of the street. It becomes a café (renderer: awning,
 * blade sign, glazed front, tables outside); planters flank its door.
 */
function dressCafe(vp: Viewpoint, buildings: Building[], features: Feature[], keep: KeepOut): void {
  const lx = Math.sin(vp.heading);
  const lz = -Math.cos(vp.heading);
  const rx = -lz;
  const rz = lx;
  let best: Building | null = null;
  let bd = Infinity;
  for (const b of buildings) {
    if (b.style === 'landmark' || b.style === 'house' || b.frontEdge < 0) continue;
    // its front face's centre, relative to the viewpoint: ahead and to the right
    const fx = b.x + Math.sin(b.angle) * (b.d / 2) - vp.x;
    const fz = b.z - Math.cos(b.angle) * (b.d / 2) - vp.z;
    const fa = fx * lx + fz * lz;
    const fr = fx * rx + fz * rz;
    if (fa < 3 || fa > 18 || fr < 0.8 || fr > 8) continue;
    const d = Math.abs(fa - 9) + fr;
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  // Clear the view down the street: no street tree right in the middle of it.
  for (let i = features.length - 1; i >= 0; i--) {
    const f = features[i];
    if (f.kind !== 'tree' || f.r !== 0.3) continue;
    const fa = (f.x - vp.x) * lx + (f.z - vp.z) * lz;
    const fr = (f.x - vp.x) * rx + (f.z - vp.z) * rz;
    if (fa > 0 && fa < 24 && Math.abs(fr) < 3.2) features.splice(i, 1);
  }
  if (!best) return;
  best.decor = 'cafe';
  const b = best;
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const door = b.door ?? 0;
  const at = (u: number, v: number) => ({ x: b.x + u * c - v * s, z: b.z + u * s + v * c });
  // Tables along the front, in the setback and the sidewalk's inner metre, never near the viewpoint.
  const v = -b.d / 2 - 1.0;
  for (const u of [-b.w / 2 + 1.3, -b.w / 2 + 3.2, b.w / 2 - 3.2, b.w / 2 - 1.3]) {
    if (Math.abs(u - door) < 1.4) continue;
    const p = at(u, v);
    if (Math.hypot(p.x - vp.x, p.z - vp.z) < 3.2) continue;
    if (features.some((f) => Math.abs(f.x - p.x) < 1.2 && Math.hypot(f.x - p.x, f.z - p.z) < 1.2)) continue;
    features.push({ kind: 'cafe-table', ...p, angle: b.angle, r: 0.45 });
  }
  for (const u of [door - 1.2, door + 1.2]) {
    const p = at(u, -b.d / 2 - 0.8);
    if (Math.hypot(p.x - vp.x, p.z - vp.z) < 2.6) continue;
    features.push({ kind: 'planter', ...p, angle: b.angle, r: 0.4 });
  }
  void keep;
}

// ── Walk graph: the road graph's sidewalks plus plaza / park paths ──

class WalkGraph {
  readonly nodes: Array<{ id: number; x: number; z: number; edges: number[] }>;
  readonly edges: WalkEdge[];
  readonly extra: WalkEdge[] = [];
  constructor(g: RoadGraph) {
    this.nodes = g.walkNodes.map((n) => ({ ...n, edges: [...n.edges] }));
    this.edges = g.walkEdges.map((e) => ({ ...e }));
  }
  addNode(x: number, z: number): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, edges: [] });
    return id;
  }
  addEdge(a: number, b: number, kind: WalkKind, pts: number[], width: number): WalkEdge {
    const e: WalkEdge = { id: this.edges.length, a, b, kind, path: polyline(pts), width };
    this.edges.push(e);
    this.nodes[a].edges.push(e.id);
    this.nodes[b].edges.push(e.id);
    if (kind === 'plaza' || kind === 'park' || kind === 'footpath') this.extra.push(e);
    return e;
  }
  /** Split sidewalk edge `id` at arc length s; returns the new node. */
  split(id: number, s: number): number {
    const e = this.edges[id];
    const p = ps();
    sampleAt(e.path, s, p);
    const m = this.addNode(p.x, p.z);
    const tail: WalkEdge = { id: this.edges.length, a: m, b: e.b, kind: e.kind, path: trim(e.path, s, e.path.length), width: e.width };
    this.edges.push(tail);
    const nb = this.nodes[e.b];
    nb.edges[nb.edges.indexOf(id)] = tail.id;
    this.edges[id] = { ...e, b: m, path: trim(e.path, 0, s) };
    this.nodes[m].edges.push(id, tail.id);
    return m;
  }
  /** Split the sidewalk walk edge passing through (x, z) there; null if none is within 0.6 m. */
  entryAt(x: number, z: number): { node: number; x: number; z: number } | null {
    const near = { dist: 0, s: 0 };
    let best = -1;
    let bd = Infinity;
    let bs = 0;
    for (const w of this.edges) {
      if (w.kind !== 'sidewalk') continue;
      // cheap reject on the path's bounding box
      const bb = pathBox(w.path);
      if (x < bb[0] - 1 || x > bb[2] + 1 || z < bb[1] - 1 || z > bb[3] + 1) continue;
      const d = nearestOn(w.path, x, z, near);
      if (d < bd) {
        bd = d;
        best = w.id;
        bs = near.s;
      }
    }
    if (best < 0 || bd > 0.6) return null;
    const w = this.edges[best];
    if (bs < 1.5 || bs > w.path.length - 1.5) return null;
    const node = this.split(best, bs);
    return { node, x: this.nodes[node].x, z: this.nodes[node].z };
  }
  /**
   * A closed loop path joined to the network at each entry: the loop is cut at the sample nearest
   * each entry, and a straight path joins the entry node to that cut.
   */
  addLoop(loop: number[], entries: Array<{ node: number; x: number; z: number }>, kind: WalkKind, width: number): void {
    const n = loop.length >> 1;
    const cuts = entries
      .map((en) => {
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < n; i++) {
          const d = Math.hypot(loop[i * 2] - en.x, loop[i * 2 + 1] - en.z);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        return { en, i: best };
      })
      .sort((a, b) => a.i - b.i)
      .filter((c, k, arr) => k === 0 || c.i !== arr[k - 1].i);
    if (cuts.length < 2) return;
    const loopNodes = cuts.map((c) => this.addNode(loop[c.i * 2], loop[c.i * 2 + 1]));
    for (let k = 0; k < cuts.length; k++) {
      const i0 = cuts[k].i;
      const i1 = cuts[(k + 1) % cuts.length].i;
      const pts: number[] = [];
      for (let i = i0; ; i = (i + 1) % n) {
        pts.push(loop[i * 2], loop[i * 2 + 1]);
        if (i === i1 && pts.length > 2) break;
      }
      this.addEdge(loopNodes[k], loopNodes[(k + 1) % cuts.length], kind, pts, width);
    }
    cuts.forEach((c, k) => {
      const nd = this.nodes[c.en.node];
      this.addEdge(c.en.node, loopNodes[k], kind, [nd.x, nd.z, loop[c.i * 2], loop[c.i * 2 + 1]], width);
    });
  }
  finish() {
    return { nodes: this.nodes, edges: this.edges };
  }
}

const boxes = new WeakMap<Polyline, number[]>();
function pathBox(pl: Polyline): number[] {
  let b = boxes.get(pl);
  if (b) return b;
  b = [Infinity, Infinity, -Infinity, -Infinity];
  const p = pl.pts;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < b[0]) b[0] = p[i];
    if (p[i] > b[2]) b[2] = p[i];
    if (p[i + 1] < b[1]) b[1] = p[i + 1];
    if (p[i + 1] > b[3]) b[3] = p[i + 1];
  }
  boxes.set(pl, b);
  return b;
}

/** Entry points into a block from the middle of each bounding street's sidewalk on its side. */
function sideEntries(blk: Block, g: RoadGraph, W: WalkGraph): Array<{ node: number; x: number; z: number }> {
  const out: Array<{ node: number; x: number; z: number }> = [];
  const mid = ps();
  for (const h of blk.sides) {
    const e = g.edges[h.edge];
    if (e.centre.length < 6) continue;
    sampleAt(e.centre, e.centre.length / 2, mid);
    const off = (h.fwd ? -1 : 1) * (e.width / 2 + e.sidewalk / 2);
    const en = W.entryAt(mid.x - mid.tz * off, mid.z + mid.tx * off);
    if (en) out.push(en);
  }
  return out;
}

// ── Viewpoints ──

function pickViewpoints(seed: number, g: RoadGraph, layout: Layout, buildings: Building[], features: Feature[], plaza: Block, W: WalkGraph, parkPhi: number, fountain: { x: number; z: number }, keep: KeepOut): CityPlan['viewpoints'] {
  const sp = ps();
  const heading = (dx: number, dz: number) => Math.atan2(dx, -dz);
  // Point obstacles in a 4 m hash grid.
  const FG = 4;
  const fgrid = new Map<number, Feature[]>();
  for (const f of features) {
    if (featureRadius(f) <= 0) continue;
    const k = (Math.floor(f.x / FG) + 64) * 256 + Math.floor(f.z / FG) + 64;
    let l = fgrid.get(k);
    if (!l) fgrid.set(k, (l = []));
    l.push(f);
  }
  const forFeatures = (x: number, z: number, reach: number, fn: (f: Feature) => void) => {
    for (let i = Math.floor((x - reach) / FG); i <= Math.floor((x + reach) / FG); i++) {
      for (let j = Math.floor((z - reach) / FG); j <= Math.floor((z + reach) / FG); j++) {
        const l = fgrid.get((i + 64) * 256 + j + 64);
        if (l) for (const f of l) fn(f);
      }
    }
  };
  const obstacleNear = (x: number, z: number, r: number) => {
    const reach = r + 2;
    for (let i = Math.floor((x - reach) / FG); i <= Math.floor((x + reach) / FG); i++) {
      for (let j = Math.floor((z - reach) / FG); j <= Math.floor((z + reach) / FG); j++) {
        const l = fgrid.get((i + 64) * 256 + j + 64);
        if (l) for (const f of l) if (Math.hypot(f.x - x, f.z - z) < r + featureRadius(f)) return true;
      }
    }
    return false;
  };
  const blocked = (x0: number, z0: number, x1: number, z1: number) => {
    // Does any building stand on the sight line (sampled every 1.5 m)?
    const L = Math.hypot(x1 - x0, z1 - z0);
    for (let s = 2; s < L - 2; s += 1.5) {
      const x = x0 + ((x1 - x0) * s) / L;
      const z = z0 + ((z1 - z0) * s) / L;
      if (Math.hypot(x - plaza.cx, z - plaza.cz) > 3.5 && keep.buildingAt(x, z, 0.2)) return true;
    }
    return false;
  };
  // Street: on an avenue's sidewalk by the curb, looking back in toward the plaza along a curving
  // stretch: towers ahead, the clock tower at the end, and on the right, 5-16 m ahead, a frontage
  // building on our own side of the street (the café the dive lands at). Scored on all three.
  const avenues = g.edges.filter((e) => e.kind === 'avenue');
  let best: Viewpoint | null = null;
  let bestScore = -Infinity;
  const q = ps();
  for (const e of avenues) {
    for (let f = 0.4; f <= 0.76; f += 0.04) {
      sampleAt(e.centre, e.centre.length * f, sp);
      sampleAt(e.centre, Math.max(0, e.centre.length * f - 25), q);
      const bend = Math.abs(Math.atan2(sp.tx * q.tz - sp.tz * q.tx, sp.tx * q.tx + sp.tz * q.tz));
      for (const side of [-1, 1]) {
        const off = side * (e.width / 2 + Math.min(1.0, e.sidewalk * 0.45));
        const x = sp.x - sp.tz * off;
        const z = sp.z + sp.tx * off;
        if (obstacleNear(x, z, 1.8)) continue;
        // look back along −t, turned a little toward the road
        const turn = 0.1;
        const lx = -sp.tx * Math.cos(turn) + side * sp.tz * Math.sin(turn);
        const lz = -sp.tz * Math.cos(turn) - side * sp.tx * Math.sin(turn);
        const rx = -lz; // right of the look direction
        const rz = lx;
        // nothing (lamp post, trunk, hydrant) standing in the middle of the view close ahead
        let blockedView = false;
        forFeatures(x + lx * 5, z + lz * 5, 6, (f) => {
          const fa = (f.x - x) * lx + (f.z - z) * lz;
          const fr = (f.x - x) * rx + (f.z - z) * rz;
          const tree = f.kind === 'tree';
          if (fa > 0.3 && fa < (tree ? 10 : 6) && Math.abs(fr) < (tree ? 1.8 : 1.0) + featureRadius(f)) blockedView = true;
        });
        if (blockedView) continue;
        let score = 0;
        let cafe = 0;
        for (const b of buildings) {
          const dx = b.x - x;
          const dz = b.z - z;
          const d = Math.hypot(dx, dz);
          if (d > 45 || d < 3) continue;
          const along = (lx * dx + lz * dz) / d;
          if (along > 0.35) score += (b.h * along) / (8 + d);
          // a café candidate: a frontage building whose front face is ahead on the right
          if (b.frontEdge < 0 || b.style === 'house' || b.landmark) continue;
          const fa = (b.x + Math.sin(b.angle) * (b.d / 2) - x) * lx + (b.z - Math.cos(b.angle) * (b.d / 2) - z) * lz;
          const fr = (b.x + Math.sin(b.angle) * (b.d / 2) - x) * rx + (b.z - Math.cos(b.angle) * (b.d / 2) - z) * rz;
          if (fa > 5 && fa < 16 && fr > 1.2 && fr < 7) cafe = Math.max(cafe, 1 - Math.abs(fa - 9) / 9);
        }
        score += bend * 6 + (cafe > 0 ? 5 + cafe * 3 : -8) + (side === -1 ? 0.6 : 0) - Math.abs(f - 0.56) * 2;
        if (score > bestScore) {
          bestScore = score;
          best = { x, z, heading: heading(lx, lz) };
        }
      }
    }
  }
  const street = best!;
  // rooftops, horizon and dusk serve the review shots only: they are computed on first read
  // (non-enumerable memoised getters), off the first-frame `city plan` path.
  let skyMemo: Skyline | null = null;
  const skyline = () => (skyMemo ??= new Skyline(buildings, features));
  const computeRooftops = (): Viewpoint => {
    const sky = skyline();
    // Rooftops (16 m, the shot pitches to −24°): far enough out (58–70 m) that the plateau's curve
    // drops the whole clock tower into frame, over open ground, with clear lines to its top, middle
    // and foot — a view in over downtown at the tower. Fallback: the old downtown-edge spot.
    const ra = layout.rot + Math.PI * 0.75;
    let rooftops: Viewpoint = { x: Math.cos(ra) * 30, z: Math.sin(ra) * 30, heading: heading(-Math.cos(ra), -Math.sin(ra)) };
    {
      const ct = buildings.find((b) => b.landmark === 'clocktower');
      if (ct) {
        const eye = 16.4;
        // nearest-to-64 m ring first; the first ring with a clear spot wins (over a road if possible)
        for (const D of [64, 62.5, 65.5, 61, 67, 59.5, 68.5, 58, 70]) {
          let found: Viewpoint | null = null;
          for (let a = 0; a < Math.PI * 2 && !(found && !keep.discClear(found.x, found.z, 1)); a += Math.PI / 60) {
            const x = ct.x + Math.cos(a) * D;
            const z = ct.z + Math.sin(a) * D;
            if (Math.hypot(x, z) > CITY_PLAN_RADIUS - 6) continue;
            if (sky.topAt(x, z) > 8 || sky.buildingClearance(x, z, 4) < 3) continue;
            const skip = ct.w / 2 + 0.6;
            if (!sky.lineClear(x, z, eye, ct.x, ct.z, ct.h, skip) || !sky.lineClear(x, z, eye, ct.x, ct.z, ct.h * 0.5, skip) || !sky.lineClear(x, z, eye, ct.x, ct.z, 3, skip)) continue;
            if (!found || !keep.discClear(x, z, 1)) found = { x, z, heading: heading(ct.x - x, ct.z - z) };
          }
          if (found) {
            rooftops = found;
            break;
          }
        }
      }
    }
    return rooftops;
  };
  // Plaza: far enough back that the clock and the fountain are in frame at eye height (≥ 22 m from
  // the tower: on a corner of the loop's outer sidewalk, looking across the street into the plaza),
  // offset so the fountain sits beside the tower, not behind it.
  let plazaVp: Viewpoint = { x: plaza.cx - 24, z: plaza.cz, heading: Math.PI / 2 };
  {
    const pc: Array<{ x: number; z: number; s: number; h: number }> = [];
    const tx = plaza.cx * 0.62 + fountain.x * 0.38;
    const tz = plaza.cz * 0.62 + fountain.z * 0.38;
    for (const w of W.edges) {
      if (w.kind !== 'sidewalk' && w.kind !== 'corner') continue;
      const bb = pathBox(w.path);
      if (bb[0] > plaza.cx + 31 || bb[2] < plaza.cx - 31 || bb[1] > plaza.cz + 31 || bb[3] < plaza.cz - 31) continue;
      const p = w.path.pts;
      for (let i = 0; i < p.length; i += 4) {
        const x = p[i];
        const z = p[i + 1];
        const d = Math.hypot(x - plaza.cx, z - plaza.cz);
        if (d < 21 || d > 31) continue;
        const a1 = Math.atan2(plaza.cz - z, plaza.cx - x);
        const a2 = Math.atan2(fountain.z - z, fountain.x - x);
        const sep = Math.abs(Math.atan2(Math.sin(a1 - a2), Math.cos(a1 - a2)));
        if (sep < 0.12 || sep > 0.55) continue;
        pc.push({ x, z, s: d * 0.2 + sep * 3 - Math.abs(d - 26) * 0.3, h: heading(tx - x, tz - z) });
      }
    }
    pc.sort((a, b) => b.s - a.s);
    for (const c of pc) {
      if (obstacleNear(c.x, c.z, 1.4) || blocked(c.x, c.z, plaza.cx, plaza.cz)) continue;
      plazaVp = { x: c.x, z: c.z, heading: c.h };
      break;
    }
  }
  const computeHorizon = (): Viewpoint => {
    const sky = skyline();
    // Horizon: on the ring's outer sidewalk where it runs past the park, looking along the ring. The
    // camera stands 6 m up, level with the lamp heads (4.6–5.5 m) and the crowns: keep its column
    // 3 m clear of every lamp head, crown and wall, and the first 14 m ahead clear of crowns.
    let horizon: Viewpoint = { x: 0, z: 0, heading: 0 };
    {
      const phi = parkPhi - 0.32;
      const tx0 = Math.cos(phi) * 62;
      const tz0 = Math.sin(phi) * 62;
      let bestH = Infinity;
      for (const e of g.edges) {
        if (e.kind !== 'ring') continue;
        for (let si = 0; si <= e.centre.length; si += 1) {
          sampleAt(e.centre, si, sp);
          const dPhi = Math.hypot(sp.x - tx0, sp.z - tz0);
          if (dPhi > 40) continue;
          const outward = Math.sign(sp.x * -sp.tz + sp.z * sp.tx) || 1;
          const along = sp.tx * -Math.sin(phi) + sp.tz * Math.cos(phi) > 0 ? 1 : -1;
          const dx = sp.tx * along;
          const dz = sp.tz * along;
          for (const k of [0.5, 0.3, 0.7]) {
            const hoff = outward * (e.width / 2 + e.sidewalk * k);
            const x = sp.x - sp.tz * hoff;
            const z = sp.z + sp.tx * hoff;
            if (sky.postClearance(x, z, 6, 3.5) < 3 || sky.buildingClearance(x, z, 4) < 3) continue;
            // nothing tall standing in the middle of the view for 10 m (a lamp head 4 m ahead fills a quarter of the frame)
            if (sky.coneClearance(x, z, dx, dz, 38, 11, 3.5) < 10) continue;
            const score = dPhi + Math.abs(k - 0.5) * 2;
            if (score < bestH) {
              bestH = score;
              horizon = { x, z, heading: heading(dx, dz) };
            }
          }
        }
      }
    }
    return horizon;
  };
  const computeDusk = (): Viewpoint => {
    const sky = skyline();
    // Dusk: a sidewalk spot whose view toward the setting sun (at the shot's own time there) shows an
    // unbroken horizon within ±4° of the disc (views.ts pickDusk); falls back to the most westward
    // open view.
    const spots: WalkSpot[] = [];
    for (const w of W.edges) {
      if (w.kind !== 'sidewalk' && w.kind !== 'corner') continue;
      for (let si = 0.5; si < w.path.length; si += 1) {
        sampleAt(w.path, si, sp);
        spots.push({ x: sp.x, z: sp.z, tx: sp.tx, tz: sp.tz, straight: w.kind === 'sidewalk' });
      }
    }
    const dusk: Viewpoint = pickDusk(sky, getPlanet(seed), spots, CITY_PLAN_RADIUS, (x, z) => !obstacleNear(x, z, 1.2)) ?? { ...street, heading: -Math.PI / 2 };
    return dusk;
  };
  const vps = { street, plaza: plazaVp } as unknown as CityPlan['viewpoints'];
  const lazy = (name: string, fn: () => Viewpoint) => {
    let v: Viewpoint | null = null;
    Object.defineProperty(vps, name, { enumerable: false, get: () => (v ??= fn()) });
  };
  lazy('rooftops', computeRooftops);
  lazy('horizon', computeHorizon);
  lazy('dusk', computeDusk);
  return vps;
}

// ── Small geometry helpers ──

function circlePts(cx: number, cz: number, r: number, a0: number): number[] {
  const out: number[] = [];
  const n = Math.max(16, Math.ceil((Math.PI * 2 * r) / 0.8));
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
  }
  return out;
}

/** A rounded rectangle (half sizes hx, hz, corner radius rc) rotated by `ang`, positive winding. */
function roundedRect(cx: number, cz: number, hx: number, hz: number, ang: number, rc: number): number[] {
  const out: number[] = [];
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const corners: Array<[number, number, number]> = [
    [hx - rc, hz - rc, 0],
    [-hx + rc, hz - rc, Math.PI / 2],
    [-hx + rc, -hz + rc, Math.PI],
    [hx - rc, -hz + rc, (3 * Math.PI) / 2],
  ];
  for (const [ux, uz, a0] of corners) {
    for (let k = 0; k <= 4; k++) {
      const a = a0 + (k / 4) * (Math.PI / 2);
      const x = ux + Math.cos(a) * rc;
      const z = uz + Math.sin(a) * rc;
      out.push(cx + x * c - z * s, cz + x * s + z * c);
    }
  }
  return positive(out);
}

function smoothClosed(pts: number[], passes: number): number[] {
  let p = pts;
  const n = p.length >> 1;
  for (let k = 0; k < passes; k++) {
    const q: number[] = new Array(p.length);
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n;
      const b = (i + 1) % n;
      q[i * 2] = (p[a * 2] + 2 * p[i * 2] + p[b * 2]) / 4;
      q[i * 2 + 1] = (p[a * 2 + 1] + 2 * p[i * 2 + 1] + p[b * 2 + 1]) / 4;
    }
    p = q;
  }
  return p;
}

/** Shrink a positive-winding polygon by d (vertex normals; negative grows it). */
function inset(poly: ArrayLike<number>, d: number): number[] {
  const n = poly.length >> 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    let tx = poly[b * 2] - poly[a * 2];
    let tz = poly[b * 2 + 1] - poly[a * 2 + 1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    out.push(poly[i * 2] - tz * d, poly[i * 2 + 1] + tx * d);
  }
  return out;
}

function positive(poly: number[]): number[] {
  let s = 0;
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  if (s >= 0) return poly;
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(poly[i * 2], poly[i * 2 + 1]);
  return out;
}

function decimate(poly: ArrayLike<number>, step: number): number[] {
  const out: number[] = [poly[0], poly[1]];
  let acc = 0;
  for (let i = 2; i < poly.length; i += 2) {
    acc += Math.hypot(poly[i] - poly[i - 2], poly[i + 1] - poly[i - 1]);
    if (acc >= step) {
      out.push(poly[i], poly[i + 1]);
      acc = 0;
    }
  }
  return out;
}

function distToOutline(poly: ArrayLike<number>, x: number, z: number): number {
  const n = poly.length >> 1;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    best = Math.min(best, segPointDist(x, z, poly[i * 2], poly[i * 2 + 1], poly[j * 2], poly[j * 2 + 1]));
  }
  return best;
}

/** Distance along a ray to the first crossing of a closed outline (∞ if none). */
function rayToOutline(poly: ArrayLike<number>, x: number, z: number, dx: number, dz: number): number {
  const n = poly.length >> 1;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1];
    const bx = poly[j * 2], bz = poly[j * 2 + 1];
    const ex = bx - ax, ez = bz - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - x) * ez - (az - z) * ex) / den;
    const u = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

function cornersOf(b: Building): Array<[number, number]> {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [b.x + (u * b.w * c) / 2 - (v * b.d * s) / 2, b.z + (u * b.w * s) / 2 + (v * b.d * c) / 2] as [number, number]);
}

/** Resample a closed polygon to ≤ step spacing. */
function resampleClosed(poly: number[], step: number): number[] {
  const out: number[] = [];
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1];
    const bx = poly[j * 2], bz = poly[j * 2 + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let t = 0; t < k; t++) out.push(ax + ((bx - ax) * t) / k, az + ((bz - az) * t) / k);
  }
  return out;
}

