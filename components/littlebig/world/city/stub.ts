// F0 STUB city plan: a ring road, four gently curving avenues meeting at a central junction, and
// a scatter of boxes along the frontages. It exists so every system has valid data to build
// against; A2 replaces it (world/city/plan*.ts) and switches world/city/index.ts over.
// It satisfies every invariant in validate.ts.

import { CITY_PLAN_RADIUS, SEED } from '../config';
import { Rng } from '../rng';
import { buildRoadGraph, type SketchEdge, type SketchNode } from './graph';
import { obbDistance } from './index-grid';
import { arcPoints, catmullRom, sampleAt } from './path';
import type { Area, Building, BuildingStyle, CityPlan, Feature, RoofKind, Zone } from './types';
import { obbOverlap, obbPolylineDistance } from './validate';

export function buildStubPlan(seed: number = SEED): CityPlan {
  const rng = Rng.for(seed, 'city-stub');
  const ringR = 58;
  const rot = 0.35;
  const nodes: SketchNode[] = [{ x: 0, z: 0, control: 'yield' }];
  for (let k = 0; k < 4; k++) {
    const a = rot + (k * Math.PI) / 2;
    nodes.push({ x: Math.cos(a) * ringR, z: Math.sin(a) * ringR, control: 'yield' });
  }
  const edges: SketchEdge[] = [];
  // Avenues: centre → ring, with a gentle S-bend.
  for (let k = 0; k < 4; k++) {
    const a = rot + (k * Math.PI) / 2;
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    const bend = (k % 2 ? 1 : -1) * 5;
    const ctrl = [0, 0, ux * 20 - uz * bend, uz * 20 + ux * bend, ux * 40 + uz * bend * 0.6, uz * 40 - ux * bend * 0.6, nodes[k + 1].x, nodes[k + 1].z];
    edges.push({ a: 0, b: k + 1, points: catmullRom(ctrl), kind: 'avenue', width: 7, sidewalk: 2.2, speed: 8 });
  }
  // Ring arcs between consecutive ring nodes.
  for (let k = 0; k < 4; k++) {
    const a0 = rot + (k * Math.PI) / 2;
    const a1 = a0 + Math.PI / 2;
    edges.push({ a: k + 1, b: ((k + 1) % 4) + 1, points: arcPoints(0, 0, ringR, a0, a1), kind: 'ring', width: 6.5, sidewalk: 1.8, speed: 10 });
  }
  const g = buildRoadGraph(nodes, edges);

  // A park in one quadrant (kept clear of buildings). No plaza in the stub: A2's plan adds one.
  const areas: Area[] = [];
  const parkA0 = rot + Math.PI / 2 + 0.32;
  const parkA1 = rot + Math.PI - 0.32;
  const park: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = parkA0 + ((parkA1 - parkA0) * i) / 8;
    park.push(Math.cos(a) * 48, Math.sin(a) * 48);
  }
  for (let i = 8; i >= 0; i--) {
    const a = parkA0 + ((parkA1 - parkA0) * i) / 8;
    park.push(Math.cos(a) * 18, Math.sin(a) * 18);
  }
  areas.push({ id: 0, kind: 'park', outline: Float64Array.from(positiveWinding(park)) });

  // Buildings along both sides of every edge.
  const buildings: Building[] = [];
  const tryPlace = (b: Building) => {
    if (Math.hypot(b.x, b.z) + Math.hypot(b.w, b.d) / 2 > CITY_PLAN_RADIUS - 1) return false;
    for (const e of g.edges) if (obbPolylineDistance(b, e.centre) < e.width / 2 + e.sidewalk + 0.8) return false;
    for (const n of g.nodes) if (obbDistance(b, n.x, n.z) < n.radius + 1) return false;
    for (const o of buildings) if (obbOverlap(b, o)) return false;
    // keep the park free
    const pa = Math.atan2(b.z, b.x);
    const pr = Math.hypot(b.x, b.z);
    const inPark = angleIn(pa, parkA0 - 0.12, parkA1 + 0.12) && pr > 12 && pr < 54;
    if (inPark) return false;
    buildings.push(b);
    return true;
  };
  const sample = { x: 0, z: 0, tx: 0, tz: 0, i: 0 };
  for (const e of g.edges) {
    for (const side of [1, -1] as const) {
      let s = 4;
      while (s < e.centre.length - 4) {
        const w = rng.range(6, 12);
        const d = rng.range(6, 11);
        sampleAt(e.centre, s + w / 2, sample);
        const rx = -sample.tz * side;
        const rz = sample.tx * side;
        const off = e.width / 2 + e.sidewalk + 1.2 + d / 2;
        const x = sample.x + rx * off;
        const z = sample.z + rz * off;
        const dist = Math.hypot(x, z);
        const zone: Zone = dist < 30 ? 'downtown' : dist < 60 ? 'midrise' : 'residential';
        const style: BuildingStyle = zone === 'downtown' ? 'tower' : zone === 'midrise' ? 'midrise' : 'house';
        const h = zone === 'downtown' ? rng.range(16, 30) : zone === 'midrise' ? rng.range(8, 15) : rng.range(4, 7);
        const roof: RoofKind = style === 'house' ? 'gable' : 'flat';
        // local +x along the travel direction on the right, against it on the left: front faces the road
        const angle = Math.atan2(sample.tz * side, sample.tx * side);
        const placed = tryPlace({
          id: buildings.length,
          x,
          z,
          angle,
          w,
          d,
          h,
          style,
          roof,
          zone,
          wall: rng.int(0, 6),
          roofColor: rng.int(0, 2),
          seed: rng.int(0, 1 << 30),
          frontEdge: e.id,
        });
        s += placed ? w + rng.range(1.5, 4) : 2;
      }
    }
  }

  const features: Feature[] = [];
  for (const e of g.edges) {
    for (let s = 6; s < e.centre.length - 6; s += 18) {
      sampleAt(e.centre, s, sample);
      const off = e.width / 2 + 0.4;
      features.push({ kind: 'streetlight', x: sample.x - sample.tz * off, z: sample.z + sample.tx * off, angle: Math.atan2(sample.tz, sample.tx) });
    }
  }

  // Viewpoints.
  const av = g.edges[0];
  sampleAt(av.centre, av.centre.length * 0.55, sample);
  const sideOff = av.width / 2 + av.sidewalk / 2;
  const street = {
    x: sample.x - sample.tz * sideOff,
    z: sample.z + sample.tx * sideOff,
    // looking back along the avenue toward the centre
    heading: Math.atan2(-sample.tx, sample.tz),
  };
  const rooftops = { x: 34 * Math.cos(rot + 0.6), z: 34 * Math.sin(rot + 0.6), heading: Math.atan2(-Math.cos(rot + 0.6), Math.sin(rot + 0.6)) };
  const edgeA = rot + Math.PI * 1.25;
  const horizon = { x: 78 * Math.cos(edgeA), z: 78 * Math.sin(edgeA), heading: Math.atan2(Math.cos(edgeA), -Math.sin(edgeA)) };
  const dusk = { x: street.x, z: street.z, heading: -Math.PI / 2 };

  return {
    seed,
    radius: CITY_PLAN_RADIUS,
    ...g,
    buildings: buildings.map((b, id) => ({ ...b, id })),
    areas,
    features,
    viewpoints: { street, rooftops, horizon, dusk },
  };
}

function angleIn(a: number, a0: number, a1: number): boolean {
  const t = (((a - a0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return t <= a1 - a0;
}

function positiveWinding(poly: number[]): number[] {
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
