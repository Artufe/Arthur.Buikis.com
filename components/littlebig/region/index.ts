// The region system (v2, R1): the name tags of the settlements and airports (ctx.services.labels,
// drawn by the UI), and a debug overlay of the whole network behind `?p.region.debug=1` (F1 / the
// params hook toggle it live): carriageways as flat ribbons coloured by kind, bridges red, lanes
// yellow, turn connectors cyan, nodes as dots (junction green, turnaround red, bend blue, ring
// orange), pads and gate plazas as rings, runways, piers and the ferry lane. H1 replaces the ribbons
// with real roads; the overlay stays a review tool.

import { BufferGeometry, DoubleSide, Float32BufferAttribute, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, type Object3D } from 'three';
import { LAYER_NO_INK, type LabelKind, type LBContext, type System, type WorldLabel } from '../core/contracts';
import { R } from '../world/config';
import type { Region, Settlement, WPath } from '../world/region/types';
import { headingVector, v3, type Vec3 } from '../world/sphere';

const KIND_COL: Record<string, [number, number, number]> = {
  road: [0.18, 0.2, 0.26],
  access: [0.45, 0.16, 0.62],
  street: [0.42, 0.42, 0.46],
  lane: [0.55, 0.52, 0.5],
  ring: [0.95, 0.5, 0.1],
  highway: [0.1, 0.1, 0.14],
};
const BRIDGE: [number, number, number] = [0.92, 0.16, 0.16];

/** The label kind a settlement shows as. */
function labelKind(s: Settlement): LabelKind {
  if (s.style === 'capital') return 'capital';
  if (s.style === 'harbour') return 'harbour';
  return s.kind === 'city' ? 'city' : s.kind === 'town' ? 'town' : 'village';
}

/** 'pop. 1,204 · harbour' */
function popLine(s: Settlement): string {
  return `pop. ${s.population.toLocaleString('en-US')} · ${s.blurb}`;
}

/** The labels for a region (pure: the spec checks them). */
export function regionLabels(region: Region): WorldLabel[] {
  const out: WorldLabel[] = [];
  for (const s of region.settlements) {
    const capital = s.style === 'capital';
    out.push({
      id: `town:${s.id}`,
      text: s.name,
      sub: popLine(s),
      kind: labelKind(s),
      dir: v3(s.dir.x, s.dir.y, s.dir.z),
      h: s.h + (capital ? 30 : s.style === 'metro' ? 22 : 9),
      // The capital reads from orbit down to its rooftops; a town from orbit down to ~25 m above it.
      minAlt: capital ? 60 : 22,
      maxAlt: 1e4,
      flyAlt: capital ? 120 : s.style === 'metro' ? 70 : 42,
    });
  }
  for (const l of region.lookouts) {
    out.push({ id: `lookout:${l.node}`, text: l.name, sub: 'viewpoint · car park', kind: 'landmark', dir: v3(l.dir.x, l.dir.y, l.dir.z), h: l.h + 5, minAlt: 25, maxAlt: 1e4, flyAlt: 36 });
  }
  for (const a of region.airports) {
    out.push({
      id: `airport:${a.code}`,
      text: a.name,
      sub: `${a.code} · runway ${String(Math.round((((a.heading * 180) / Math.PI + 360) % 360) / 10) || 36).padStart(2, '0')}`,
      kind: 'airport',
      dir: v3(a.apron.x, a.apron.y, a.apron.z),
      h: a.h + 6,
      minAlt: 30,
      maxAlt: 1e4,
      flyAlt: 46,
    });
  }
  return out;
}

export function createRegionSystem(): System {
  const unregister: Array<() => void> = [];
  let overlay: Object3D[] = [];
  let built = false;

  function buildOverlay(ctx: LBContext) {
    const region = ctx.world.region;
    const tri: number[] = [];
    const triC: number[] = [];
    const lin: number[] = [];
    const linC: number[] = [];
    const t = v3();
    const up = v3();
    const rt = v3();
    /** World position of unit d at height h into a flat array. */
    const push = (arr: number[], d: Vec3, h: number) => arr.push(d.x * (R + h), d.y * (R + h), d.z * (R + h));
    const ribbon = (p: WPath, half: number, lift: number, col: (i: number) => [number, number, number]) => {
      const n = p.h.length;
      for (let i = 0; i < n - 1; i++) {
        const quad: Vec3[] = [];
        const hs: number[] = [];
        for (const k of [i, i + 1]) {
          up.x = p.dir[k * 3];
          up.y = p.dir[k * 3 + 1];
          up.z = p.dir[k * 3 + 2];
          const a = Math.max(0, k - 1);
          const b = Math.min(n - 1, k + 1);
          t.x = p.dir[b * 3] - p.dir[a * 3];
          t.y = p.dir[b * 3 + 1] - p.dir[a * 3 + 1];
          t.z = p.dir[b * 3 + 2] - p.dir[a * 3 + 2];
          // right = t × up
          rt.x = t.y * up.z - t.z * up.y;
          rt.y = t.z * up.x - t.x * up.z;
          rt.z = t.x * up.y - t.y * up.x;
          const l = Math.hypot(rt.x, rt.y, rt.z) || 1;
          const s = half / (R + p.h[k]) / l;
          quad.push(v3(up.x + rt.x * s, up.y + rt.y * s, up.z + rt.z * s), v3(up.x - rt.x * s, up.y - rt.y * s, up.z - rt.z * s));
          hs.push(p.h[k] + lift);
        }
        const c0 = col(i);
        for (const [q, hh] of [[0, 0], [1, 0], [2, 1], [1, 0], [3, 1], [2, 1]] as const) {
          const d = quad[q];
          const l = Math.hypot(d.x, d.y, d.z);
          push(tri, v3(d.x / l, d.y / l, d.z / l), hs[hh]);
          triC.push(c0[0], c0[1], c0[2]);
        }
      }
    };
    const line = (p: WPath, lift: number, c: [number, number, number], stride = 1) => {
      const n = p.h.length;
      for (let i = 0; i + stride < n; i += stride) {
        const j = Math.min(n - 1, i + stride);
        push(lin, v3(p.dir[i * 3], p.dir[i * 3 + 1], p.dir[i * 3 + 2]), p.h[i] + lift);
        push(lin, v3(p.dir[j * 3], p.dir[j * 3 + 1], p.dir[j * 3 + 2]), p.h[j] + lift);
        linC.push(...c, ...c);
      }
    };
    const ring = (c: Vec3, r: number, h: number, col: [number, number, number]) => {
      const n = Math.max(24, Math.ceil(r * 2));
      const p = v3();
      const q = v3();
      for (let i = 0; i < n; i++) {
        for (const [k, o] of [[i, p], [i + 1, q]] as const) {
          const a = (k / n) * Math.PI * 2;
          headingVector(c, a, t);
          const s = r / (R + h);
          o.x = c.x + t.x * s;
          o.y = c.y + t.y * s;
          o.z = c.z + t.z * s;
          const l = Math.hypot(o.x, o.y, o.z);
          o.x /= l;
          o.y /= l;
          o.z /= l;
        }
        push(lin, p, h + 0.25);
        push(lin, q, h + 0.25);
        linC.push(...col, ...col);
      }
    };
    // (v2 R2) a junction paved along its turning paths (each connector a lane-wide ribbon, so a plan
    // reads as one network rather than ribbons between empty circles), a dead end's turning circle
    // as a paved disc
    const disc = (c: Vec3, r: number, h: number, col: [number, number, number]) => {
      const n = Math.max(16, Math.ceil(r * 3));
      const p = v3();
      const q = v3();
      for (let i = 0; i < n; i++) {
        for (const [k, o] of [[i, p], [i + 1, q]] as const) {
          headingVector(c, (k / n) * Math.PI * 2, t);
          const sc = r / (R + h);
          o.x = c.x + t.x * sc;
          o.y = c.y + t.y * sc;
          o.z = c.z + t.z * sc;
          const l = Math.hypot(o.x, o.y, o.z);
          o.x /= l;
          o.y /= l;
          o.z /= l;
        }
        push(tri, c, h + 0.05);
        push(tri, p, h + 0.05);
        push(tri, q, h + 0.05);
        for (let k = 0; k < 3; k++) triC.push(col[0], col[1], col[2]);
      }
    };
    for (const c of region.connectors) {
      if (c.turn === 'uturn' || c.path.h.length < 2) continue;
      const n = region.nodes[c.node];
      if (n.control === 'roundabout') continue;
      const e = region.edges[n.edges[0]];
      ribbon(c.path, 1.9, 0.05, () => KIND_COL[e?.kind ?? 'street'] ?? KIND_COL.street);
    }
    for (const n of region.nodes) if (n.kind === 'end' && n.turnR > 0) disc(n.dir, n.turnR, n.h, KIND_COL.street);
    for (const e of region.edges) {
      const base = KIND_COL[e.kind] ?? KIND_COL.road;
      const spans = e.bridges.map((b) => region.bridges[b]);
      ribbon(e.centre, e.width / 2, 0.06, (i) => (spans.some((b) => e.centre.s[i] >= b.s0 && e.centre.s[i] <= b.s1) ? BRIDGE : base));
      if (e.sidewalk > 0) {
        // sidewalk edges as pale lines
        line(e.centre, 0.12, [0.9, 0.88, 0.82], 2);
      }
    }
    for (const l of region.lanes) line(l.path, 0.14, [1, 0.86, 0.2]);
    for (const c of region.connectors) line(c.path, 0.16, [0.3, 0.95, 1]);
    for (const n of region.nodes) {
      const col: [number, number, number] = n.kind === 'end' ? [1, 0.15, 0.15] : n.control === 'roundabout' ? [1, 0.55, 0.1] : n.kind === 'junction' ? [0.2, 1, 0.3] : [0.2, 0.55, 1];
      ring(n.dir, 0.9, n.h, col);
      ring(n.dir, n.radius, n.h, [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6]);
      if (n.kind === 'end') ring(n.dir, n.turnR, n.h, [1, 0.4, 0.4]);
    }
    for (const s of region.settlements) {
      if (s.style === 'capital') continue;
      ring(s.dir, s.padR, s.h, [1, 1, 1]);
      ring(s.dir, s.padR + s.blend, s.h, [0.75, 0.75, 0.78]);
      if (s.square) {
        // the green / square (plan → world through the town's chart)
        const d = chartDir(s, s.square.x, s.square.z);
        ring(d, s.square.r, s.h, [0.4, 1, 0.5]);
      }
    }
    // (v2 R2 refine) sea walls: the stone face from its foot to the deck, the coping, the paved apron
    // behind (types.ts QuayWall: what H1 extrudes); v2 R2 refine 2: the block's deck on back to its
    // depth (the terrain ramps down under it) and its two end faces
    for (const s of region.settlements) {
      const w = s.wall;
      if (!w) continue;
      const n = w.line.length / 2;
      const quadAt = (a: Vec3, ha: number, b: Vec3, hb: number, c: Vec3, hc: number, d: Vec3, hd: number, col: [number, number, number]) => {
        for (const [v, hh] of [[a, ha], [b, hb], [c, hc], [b, hb], [d, hd], [c, hc]] as const) {
          push(tri, v, hh);
          triC.push(col[0], col[1], col[2]);
        }
      };
      for (let i = 0; i + 1 < n; i++) {
        const x0 = w.line[i * 2], z0 = w.line[i * 2 + 1], x1 = w.line[i * 2 + 2], z1 = w.line[i * 2 + 3];
        const f0 = chartDir(s, x0, z0), f1 = chartDir(s, x1, z1);
        const t0 = w.top[i], t1 = w.top[i + 1];
        // face (outward, slightly proud of the cut so it never hides in the terrain)
        const o0 = chartDir(s, x0 + w.nx * 0.15, z0 + w.nz * 0.15), o1 = chartDir(s, x1 + w.nx * 0.15, z1 + w.nz * 0.15);
        quadAt(o0, w.foot, o1, w.foot, o0, t0 + w.lip, o1, t1 + w.lip, [0.52, 0.5, 0.47]);
        // coping
        const c0 = chartDir(s, x0 - w.nx * w.coping, z0 - w.nz * w.coping), c1 = chartDir(s, x1 - w.nx * w.coping, z1 - w.nz * w.coping);
        quadAt(o0, t0 + w.lip, o1, t1 + w.lip, c0, t0 + w.lip, c1, t1 + w.lip, [0.86, 0.84, 0.78]);
        // apron, then the rest of the block's deck back to its depth
        const a0 = chartDir(s, x0 - w.nx * w.apron, z0 - w.nz * w.apron), a1 = chartDir(s, x1 - w.nx * w.apron, z1 - w.nz * w.apron);
        quadAt(c0, t0 + 0.04, c1, t1 + 0.04, a0, t0 + 0.04, a1, t1 + 0.04, [0.72, 0.66, 0.58]);
        const b0 = chartDir(s, x0 - w.nx * w.depth, z0 - w.nz * w.depth), b1 = chartDir(s, x1 - w.nx * w.depth, z1 - w.nz * w.depth);
        quadAt(a0, t0 + 0.04, a1, t1 + 0.04, b0, t0 + 0.04, b1, t1 + 0.04, [0.64, 0.6, 0.54]);
        // the block's end faces
        for (const [k, o, b, t] of [[0, o0, b0, t0], [n - 2, o1, b1, t1]] as const) if (i === k) quadAt(o, w.foot, b, w.foot, o, t + w.lip, b, t + 0.04, [0.46, 0.44, 0.41]);
        push(lin, f0, t0 + w.lip + 0.05);
        push(lin, f1, t1 + w.lip + 0.05);
        linC.push(1, 1, 1, 1, 1, 1);
      }
    }
    // (v2 R2 refine) bridge abutments: the box H1 clads (types.ts BridgeAbutment), outlined at deck height
    for (const b of region.bridges) {
      for (const ab of b.abutments) {
        const rx = ab.into.y * ab.dir.z - ab.into.z * ab.dir.y, ry = ab.into.z * ab.dir.x - ab.into.x * ab.dir.z, rz = ab.into.x * ab.dir.y - ab.into.y * ab.dir.x;
        const at = (al: number, lat: number) => {
          const p = v3(ab.dir.x + (ab.into.x * al + rx * lat) / R, ab.dir.y + (ab.into.y * al + ry * lat) / R, ab.dir.z + (ab.into.z * al + rz * lat) / R);
          const l = Math.hypot(p.x, p.y, p.z);
          return v3(p.x / l, p.y / l, p.z / l);
        };
        const cs = [at(-ab.back, -ab.half), at(ab.depth, -ab.half), at(ab.depth, ab.half), at(-ab.back, ab.half)];
        for (let i = 0; i < 4; i++) {
          push(lin, cs[i], ab.top + 0.3);
          push(lin, cs[(i + 1) % 4], ab.top + 0.3);
          linC.push(1, 0.55, 0.2, 1, 0.55, 0.2);
        }
        // the face across the road
        push(lin, at(0, -ab.half), ab.top + 0.3);
        push(lin, at(0, ab.half), ab.top + 0.3);
        linC.push(1, 0.85, 0.3, 1, 0.85, 0.3);
      }
    }
    for (const g of region.gates) {
      ring(g.dir, g.r, g.h, [1, 0.4, 1]);
      ring(g.dir, g.island, g.h, [1, 0.7, 1]);
      ring(g.touch, 0.6, g.h, [1, 1, 1]);
    }
    for (const l of region.lookouts) ring(l.dir, 8, l.h, [0.6, 1, 0.6]);
    for (const a of region.airports) {
      // runway: centreline and edges
      const along = (f: number, side: number) => {
        const c = v3();
        const e0 = a.ends[0];
        const e1 = a.ends[1];
        c.x = e0.x + (e1.x - e0.x) * f;
        c.y = e0.y + (e1.y - e0.y) * f;
        c.z = e0.z + (e1.z - e0.z) * f;
        const l = Math.hypot(c.x, c.y, c.z);
        c.x /= l;
        c.y /= l;
        c.z /= l;
        headingVector(c, a.heading + Math.PI / 2, t);
        const s = (side * a.width) / 2 / (R + a.h);
        const o = v3(c.x + t.x * s, c.y + t.y * s, c.z + t.z * s);
        const ol = Math.hypot(o.x, o.y, o.z);
        return v3(o.x / ol, o.y / ol, o.z / ol);
      };
      for (const side of [-1, 0, 1]) {
        for (let k = 0; k < 20; k++) {
          if (side === 0 && k % 2) continue;
          push(lin, along(k / 20, side), a.h + 0.3);
          push(lin, along((k + 1) / 20, side), a.h + 0.3);
          linC.push(1, 1, 1, 1, 1, 1);
        }
      }
      ring(a.apron, a.apronR, a.h, [1, 0.6, 1]);
    }
    for (const p of region.piers) {
      push(lin, p.root, p.h + 0.3);
      push(lin, p.berth, p.h + 0.3);
      linC.push(0.6, 0.4, 0.2, 0.6, 0.4, 0.2);
      ring(p.berth, 1.5, p.h, [1, 1, 1]);
    }
    for (const f of region.ferries) {
      const n = f.lane.h.length;
      for (let i = 0; i + 2 < n; i += 4) {
        push(lin, v3(f.lane.dir[i * 3], f.lane.dir[i * 3 + 1], f.lane.dir[i * 3 + 2]), 0.6);
        push(lin, v3(f.lane.dir[(i + 2) * 3], f.lane.dir[(i + 2) * 3 + 1], f.lane.dir[(i + 2) * 3 + 2]), 0.6);
        linC.push(1, 1, 1, 1, 1, 1);
      }
    }

    const tg = ctx.track(new BufferGeometry());
    tg.setAttribute('position', new Float32BufferAttribute(tri, 3));
    tg.setAttribute('color', new Float32BufferAttribute(triC, 3));
    const tm = ctx.track(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8, fog: false }));
    const mesh = new Mesh(tg, tm);
    mesh.renderOrder = 5;
    const lg = ctx.track(new BufferGeometry());
    lg.setAttribute('position', new Float32BufferAttribute(lin, 3));
    lg.setAttribute('color', new Float32BufferAttribute(linC, 3));
    const lm = ctx.track(new LineBasicMaterial({ vertexColors: true, depthWrite: false, fog: false }));
    const lines = new LineSegments(lg, lm);
    lines.renderOrder = 6;
    for (const o of [mesh, lines]) {
      o.layers.set(LAYER_NO_INK);
      o.frustumCulled = false;
      o.matrixAutoUpdate = false;
      ctx.scene.add(o);
    }
    overlay = [mesh, lines];
  }

  return {
    name: 'region',
    stage: 2,
    async init(ctx) {
      for (const l of regionLabels(ctx.world.region)) unregister.push(ctx.services.labels.add(l));
      const debug = ctx.params.toggle('region.debug', { label: 'region: network overlay', value: false });
      if (debug.value) {
        buildOverlay(ctx);
        built = true;
        await ctx.compile();
      }
      unregister.push(
        ctx.params.onChange((p) => {
          if (p.key !== 'region.debug') return;
          if (p.value && !built) {
            buildOverlay(ctx);
            built = true;
          }
          for (const o of overlay) o.visible = !!p.value;
        }),
      );
    },
    dispose(ctx) {
      for (const u of unregister.splice(0)) u();
      for (const o of overlay) {
        ctx.scene.remove(o);
        const m = o as Mesh;
        m.geometry?.dispose();
        (m.material as MeshBasicMaterial | undefined)?.dispose();
      }
      overlay = [];
      built = false;
    },
  };
}

/** Plan (x, z) in a settlement's chart → unit direction. */
function chartDir(s: Settlement, x: number, z: number): Vec3 {
  const c = s.chart;
  const d = Math.hypot(x, z);
  if (d < 1e-9) return v3(c.origin.x, c.origin.y, c.origin.z);
  const th = d / c.radius;
  const k = Math.sin(th) / d;
  const co = Math.cos(th);
  const o = v3(c.origin.x * co + (c.east.x * x + c.south.x * z) * k, c.origin.y * co + (c.east.y * x + c.south.y * z) * k, c.origin.z * co + (c.east.z * x + c.south.z * z) * k);
  const l = Math.hypot(o.x, o.y, o.z);
  return v3(o.x / l, o.y / l, o.z / l);
}
