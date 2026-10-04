// Where nature goes. Pure TS (no three.js), seeded, deterministic: the same trees every visit.
//
// Outside the city plan, every terrain facet rolls for trees, bushes, palms and rocks by its
// biome (hash of the facet index, so nothing moves between visits), standing exactly on the facet.
// Inside the plan, A2 owns the ground: every 'tree' feature of the plan is rendered here (one tree
// look for the whole world), and the scatter only adds a few bushes and trees on 'free' ground
// (outside every road, sidewalk, building and area) where cityIndex.isClear says there is room.

import { CITY_SURFACE_R } from '../world/config';
import { fromSphere, toSphere } from '../world/city/frame';
import type { CityIndex, CityPlan } from '../world/city/types';
import { Biome } from '../world/planet';
import { hash3 } from '../world/rng';
import { v3, type Vec3 } from '../world/sphere';
import { yawAlong } from './frame';
import { facePoint, faceBiome, faceMinHeight, faceSlope, fieldCell, type TerrainData } from '../terrain/data';

export const NatureKind = {
  Blob0: 0,
  Blob1: 1,
  Conifer: 2,
  Palm: 3,
  Bush: 4,
  Rock: 5,
} as const;
export type NatureKindId = (typeof NatureKind)[keyof typeof NatureKind];
export const NATURE_KINDS = 6;

/** Variety flags (colour choices in the renderer). */
export const NatureFlag = { Snowy: 1, Autumn: 2, Dark: 4, City: 8, Bloom: 16, Hedge: 32 } as const;

/** Crown radius as a share of an instance's width scale, per kind (geometry.ts proportions). */
export const CROWN_R: Record<number, number> = { 0: 0.4, 1: 0.32, 2: 0.27, 3: 0.42, 4: 0, 5: 0 };
/** Minimum centre distance between two crowns, as a share of rA + rB (forests pack tighter). */
export const CROWN_GAP = 0.8;
export const CROWN_GAP_FOREST = 0.62;

export interface NatureScatter {
  count: number;
  kind: Uint8Array;
  /** World position of the base (on the facet / city ground), xyz interleaved. */
  pos: Float32Array;
  /** Yaw about the local up (rad). */
  yaw: Float32Array;
  /** Width and height scale (m). */
  w: Float32Array;
  h: Float32Array;
  /** Length / width of the footprint (local x over local z; 1 = round; hedge segments are long). */
  stretch: Float32Array;
  /** 0..1 variety value (colour pick). */
  tone: Float32Array;
  flags: Uint8Array;
  /** Terrain face it stands on (-1 for city features): rocks tilt to its normal. */
  face: Int32Array;
  /** 0..1 reveal order: a wave spreading out from the city. */
  wave: Float32Array;
}

interface Rates {
  tree: number;
  tree2: number;
  bush: number;
  rock: number;
  palm: number;
  conifer: number;
}

const ZERO: Rates = { tree: 0, tree2: 0, bush: 0, rock: 0, palm: 0, conifer: 0 };
/** Per-facet probabilities (a detail-6 facet is ~3.9 m²), scaled by density. */
const RATES: Partial<Record<number, Rates>> = {
  [Biome.Forest]: { tree: 0.44, tree2: 0.14, bush: 0.05, rock: 0.006, palm: 0, conifer: 0 },
  [Biome.Grass]: { tree: 0.034, tree2: 0, bush: 0.04, rock: 0.007, palm: 0, conifer: 0 },
  [Biome.Meadow]: { tree: 0.014, tree2: 0, bush: 0.028, rock: 0.009, palm: 0, conifer: 0 },
  [Biome.Beach]: { tree: 0, tree2: 0, bush: 0.006, rock: 0.012, palm: 0.06, conifer: 0 },
  [Biome.Rock]: { tree: 0, tree2: 0, bush: 0.01, rock: 0.07, palm: 0, conifer: 0.035 },
  [Biome.Snow]: { tree: 0, tree2: 0, bush: 0, rock: 0.015, palm: 0, conifer: 0.014 },
};

export interface ScatterInput {
  terrain: TerrainData;
  city: CityPlan;
  cityIndex: CityIndex;
  /** Unit vector of the city centre (reveal wave origin). */
  cityDir: Vec3;
  /** Instance-count scale (QualitySettings.density). Trees in the city are never thinned. */
  density?: number;
  /** Keep-out discs (world position + radius, m) around landmarks: no scatter inside them. */
  avoid?: ReadonlyArray<{ x: number; y: number; z: number; r: number }>;
}

/** scatterNature as a generator that yields every few thousand facets (time-sliced init). */
export function* scatterNatureSteps(input: ScatterInput): Generator<void, NatureScatter> {
  const { terrain: t, city, cityIndex, cityDir } = input;
  const density = input.density ?? 1;
  const cap = 16000;
  const out: NatureScatter = {
    count: 0,
    kind: new Uint8Array(cap),
    pos: new Float32Array(cap * 3),
    yaw: new Float32Array(cap),
    w: new Float32Array(cap),
    h: new Float32Array(cap),
    stretch: new Float32Array(cap).fill(1),
    tone: new Float32Array(cap),
    flags: new Uint8Array(cap),
    face: new Int32Array(cap),
    wave: new Float32Array(cap),
  };
  const p = v3();
  const q = { x: 0, z: 0 };
  const planR = city.radius;
  const cellOut = new Float32Array(5);
  // Crown spacing: accepted trees in a 4 m world-space hash, so no two crowns merge (a green and an
  // orange crown grown into one blob). Trees that would crowd an earlier one are dropped. Cells of
  // 8 m: a crown is ≤ 3.6 m in radius, so the 27 neighbours always cover the reach.
  const CELLM = 8;
  const grid = new Map<number, number[]>();
  const keyOf = (x: number, y: number, z: number) => ((Math.floor(x / CELLM) + 512) * 1024 + (Math.floor(y / CELLM) + 512)) * 1024 + (Math.floor(z / CELLM) + 512);
  const crownR = new Float32Array(cap);
  const crowdFree = (x: number, y: number, z: number, r: number, gap: number) => {
    const cx = Math.floor(x / CELLM), cy = Math.floor(y / CELLM), cz = Math.floor(z / CELLM);
    const reach = 1;
    for (let i = -reach; i <= reach; i++)
      for (let j = -reach; j <= reach; j++)
        for (let k = -reach; k <= reach; k++) {
          const list = grid.get(((cx + i + 512) * 1024 + (cy + j + 512)) * 1024 + (cz + k + 512));
          if (!list) continue;
          for (const o of list) {
            const dx = out.pos[o * 3] - x, dy = out.pos[o * 3 + 1] - y, dz = out.pos[o * 3 + 2] - z;
            const m = gap * (r + crownR[o]);
            if (dx * dx + dy * dy + dz * dz < m * m) return false;
          }
        }
    return true;
  };
  const remember = (i: number, r: number) => {
    crownR[i] = r;
    const k = keyOf(out.pos[i * 3], out.pos[i * 3 + 1], out.pos[i * 3 + 2]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  };
  const avoid = input.avoid ?? [];
  const blocked = (pt: Vec3) => {
    for (let i = 0; i < avoid.length; i++) {
      const a = avoid[i];
      const dx = pt.x - a.x, dy = pt.y - a.y, dz = pt.z - a.z;
      if (dx * dx + dy * dy + dz * dz < a.r * a.r) return true;
    }
    return false;
  };
  const add = (kind: NatureKindId, x: number, y: number, z: number, yaw: number, w: number, h: number, tone: number, flags: number, face: number, wave: number) => {
    const i = out.count;
    if (i >= cap) return;
    out.kind[i] = kind;
    out.pos[i * 3] = x;
    out.pos[i * 3 + 1] = y;
    out.pos[i * 3 + 2] = z;
    out.yaw[i] = yaw;
    out.w[i] = w;
    out.h[i] = h;
    out.tone[i] = tone;
    out.flags[i] = flags;
    out.face[i] = face;
    out.wave[i] = wave;
    out.count++;
  };

  // ── City trees (A2's features) ──
  for (let i = 0; i < city.features.length; i++) {
    const f = city.features[i];
    if (f.kind !== 'tree') continue;
    const seed = f.seed ?? i * 7919;
    const r = hash3(seed, 3);
    const size = Math.max(2.5, Math.min(10, f.size ?? 5));
    const kind: NatureKindId = r < 0.42 ? NatureKind.Blob0 : r < 0.74 ? NatureKind.Blob1 : r < 0.94 ? NatureKind.Conifer : NatureKind.Bush;
    toSphere(f.x, f.z, cityIndex.groundH(f.x, f.z), p);
    const tall = kind === NatureKind.Bush ? size * 0.3 : size;
    const wide = kind === NatureKind.Conifer ? size * 0.85 : kind === NatureKind.Bush ? size * 0.45 : size * (0.85 + 0.25 * hash3(seed, 5));
    const fl = NatureFlag.City | (hash3(seed, 9) < 0.08 ? NatureFlag.Autumn : 0);
    add(kind, p.x, p.y, p.z, hash3(seed, 4) * Math.PI * 2, wide, tall, hash3(seed, 6), fl, -1, (Math.hypot(f.x, f.z) / planR) * 0.15);
    if (CROWN_R[kind] && out.count < cap) remember(out.count - 1, CROWN_R[kind] * wide);
  }

  // ── Terrain scatter ──
  const I = t.ico.indices;
  for (let f = 0; f < t.ico.triangleCount; f++) {
    if ((f & 4095) === 4095) yield;
    const b = faceBiome(t, f);
    const rates = RATES[b] ?? ZERO;
    if (rates === ZERO && b !== Biome.City) continue;
    const minH = faceMinHeight(t, f);
    if (minH < 0.12) continue;
    const slope = faceSlope(t, f);
    const h0 = t.heights[I[f * 3]];
    const tone0 = t.tone[I[f * 3]];
    // Countryside structure (grass / meadow): farmland fields stay open, with hedgerows of bushes
    // and the odd tree along their borders; wild meadow gathers its trees into groves (the deep
    // green hollows of the tone field) instead of an even sprinkle of dots.
    const open = b === Biome.Grass || b === Biome.Meadow;
    const fa = t.field[I[f * 3]], fb = t.field[I[f * 3 + 1]], fc = t.field[I[f * 3 + 2]];
    const farm = (open || b === Biome.City) && (fa >= 0 ? 1 : 0) + (fb >= 0 ? 1 : 0) + (fc >= 0 ? 1 : 0) >= 2;
    // Hedgerow facets straddle a field border (corners in different cells): one facet wide.
    const hedgeRow = farm && (fa !== fb || fa !== fc) && Math.min(t.hedge[I[f * 3]], t.hedge[I[f * 3 + 1]], t.hedge[I[f * 3 + 2]]) < 1.6;

    const tm = (tone0 + t.tone[I[f * 3 + 1]] + t.tone[I[f * 3 + 2]]) / 3;
    const grove = open && !farm ? 0.25 + 5.5 * (1 - smooth01((tm - 0.24) / 0.2)) : 1;
    const treeRate = farm ? (hedgeRow ? 0.05 : 0) : rates.tree * grove;
    const bushRate = farm ? (hedgeRow ? 0.45 : 0.003) : rates.bush * (open ? 0.6 + 0.4 * grove : 1);
    for (let slot = 0; slot < 6; slot++) {
      const roll = hash3(f, slot, 0x51);
      let kind: NatureKindId | -1 = -1;
      let size = 0;
      let flags = 0;
      if (b === Biome.City && !farm) {
        if (slot === 0 && roll < 0.022 * density) kind = NatureKind.Bush;
        else if (slot === 1 && roll < 0.008 * density) kind = hash3(f, 2) < 0.6 ? NatureKind.Blob0 : NatureKind.Blob1;
        else continue;
      } else if (slot === 0 && roll < treeRate * density && slope < 0.3) {
        const conifer = b === Biome.Forest ? h0 > 7.5 || tone0 < 0.36 : hash3(f, 11) < 0.15;
        kind = conifer ? NatureKind.Conifer : hash3(f, 12) < 0.55 ? NatureKind.Blob0 : NatureKind.Blob1;
      } else if (slot === 1 && roll < rates.tree2 * density && slope < 0.3) {
        kind = h0 > 6 || tone0 < 0.45 ? NatureKind.Conifer : NatureKind.Blob1;
      } else if (slot === 2 && roll < bushRate * (hedgeRow ? 1 : density)) {
        kind = NatureKind.Bush;
        if (hedgeRow) flags |= NatureFlag.Hedge;
      }
      else if (slot === 3 && roll < rates.rock * density) kind = NatureKind.Rock;
      else if (slot === 4 && roll < rates.palm * density && minH > 0.22 && slope < 0.25) kind = NatureKind.Palm;
      else if (slot === 5 && roll < rates.conifer * density && slope < 0.32 && h0 < 21) {
        kind = NatureKind.Conifer;
        if (b === Biome.Snow || h0 > 16) flags |= NatureFlag.Snowy;
      }
      if (kind === -1) continue;
      // A point on the facet, kept off its edges (uniform in the triangle, shrunk toward its centre).
      let u = hash3(f, slot, 0x77);
      let v = hash3(f, slot, 0x78);
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      u = 1 / 3 + (u - 1 / 3) * 0.8;
      v = 1 / 3 + (v - 1 / 3) * 0.8;
      facePoint(t, f, u, v, p);
      let hedgeYaw = 0;
      if (flags & NatureFlag.Hedge) {
        // Snap the bush onto the field border itself and turn it along it: straight hedgerows.
        const lp = Math.hypot(p.x, p.y, p.z);
        const ux = p.x / lp, uy = p.y / lp, uz = p.z / lp;
        fieldCell(ux, uy, uz, cellOut);
        const sx = cellOut[2], sy = cellOut[3], sz = cellOut[4];
        const sn = sx * ux + sy * uy + sz * uz;
        let tx = sx - ux * sn, ty = sy - uy * sn, tz = sz - uz * sn;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        const m = Math.min(1.6, cellOut[1]);
        const nx = p.x + tx * m, ny = p.y + ty * m, nz = p.z + tz * m;
        const k = lp / Math.hypot(nx, ny, nz);
        p.x = nx * k;
        p.y = ny * k;
        p.z = nz * k;
        // along the border = up × (toward the neighbour)
        hedgeYaw = yawAlong(ux, uy, uz, uy * tz - uz * ty, uz * tx - ux * tz, ux * ty - uy * tx);
      }
      if (avoid.length && blocked(p)) continue;
      // City plan: A2 owns the ground; only free, clear spots.
      const lenP = Math.hypot(p.x, p.y, p.z);
      fromSphere(p, q);
      const inPlan = Math.hypot(q.x, q.z) < planR;
      if (b === Biome.City || inPlan) {
        if (!inPlan || cityIndex.classify(q.x, q.z) !== 'free') continue;
        const clear = kind === NatureKind.Bush ? 1.8 : 3.5;
        if (!cityIndex.isClear(q.x, q.z, clear)) continue;
        // Stand on the city ground surface (a few cm above the bare plateau).
        const s = (CITY_SURFACE_R + cityIndex.groundH(q.x, q.z)) / lenP;
        p.x *= s;
        p.y *= s;
        p.z *= s;
        flags |= NatureFlag.City;
      }
      const tone = hash3(f, slot, 0x99);
      switch (kind) {
        case NatureKind.Blob0:
        case NatureKind.Blob1:
          size = b === Biome.Forest ? 4.6 + 3.6 * tone : 3.4 + 3.4 * tone;
          if (b !== Biome.Forest && hash3(f, slot, 5) < 0.07) flags |= NatureFlag.Autumn;
          break;
        case NatureKind.Conifer:
          size = b === Biome.Forest ? 5 + 4 * tone : b === Biome.Snow || b === Biome.Rock ? 3 + 2.2 * tone : 4 + 3 * tone;
          if (b === Biome.Forest && hash3(f, slot, 6) < 0.5) flags |= NatureFlag.Dark;
          break;
        case NatureKind.Palm:
          size = 4 + 2.6 * tone;
          break;
        case NatureKind.Bush:
          size = flags & NatureFlag.Hedge ? 0.8 + 0.35 * tone : 0.7 + 0.8 * tone;
          if (b === Biome.Meadow && !(flags & NatureFlag.Hedge) && hash3(f, slot, 10) < 0.12) flags |= NatureFlag.Bloom;
          break;
        case NatureKind.Rock:
          size = b === Biome.Rock || b === Biome.Snow ? 0.9 + 2.2 * tone * tone : 0.5 + 1.1 * tone * tone;
          break;
      }
      const wide = kind === NatureKind.Bush ? size * 1.6 : kind === NatureKind.Rock ? size : kind === NatureKind.Conifer ? size * 0.82 : size * (0.85 + 0.3 * hash3(f, slot, 7));
      const cr = CROWN_R[kind] * wide;
      if (cr > 0 && !crowdFree(p.x, p.y, p.z, cr, b === Biome.Forest ? CROWN_GAP_FOREST : CROWN_GAP)) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (p.x * cityDir.x + p.y * cityDir.y + p.z * cityDir.z) / lenP)));
      const hedge = (flags & NatureFlag.Hedge) !== 0;
      const yaw = hedge ? hedgeYaw + (hash3(f, slot, 0x31) - 0.5) * 0.3 : hash3(f, slot, 0x31) * Math.PI * 2;
      add(kind, p.x, p.y, p.z, yaw, wide, size, tone, flags, f, 0.12 + 0.88 * Math.min(1, ang / 2.2) + 0.05 * hash3(f, slot, 8));
      if (hedge && out.count <= cap) out.stretch[out.count - 1] = 2.1;
      if (cr > 0 && out.count < cap) remember(out.count - 1, cr);
    }
  }
  return out;
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

export function scatterNature(input: ScatterInput): NatureScatter {
  const it = scatterNatureSteps(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
