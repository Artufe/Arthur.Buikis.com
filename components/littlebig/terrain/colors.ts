// Terrain colour. Two colours per facet, both sRGB:
//   - a smooth colour per icosphere VERTEX (interpolated across facets): biome boundaries at a
//     distance are clean organic contours instead of per-facet staircases;
//   - a FACET colour for the crisp low-poly look up close: the colour of the facet's DOMINANT corner
//     biome (majority; ties → the median-height corner), never the corner mean (sand + grass would
//     average to olive), evaluated with the facet's own slope, so a boundary is a clean low-poly
//     staircase. Value jitter comes mostly from a low-frequency field (neighbours match: soft
//     patches, not a checkerboard), with only ±1 % per facet. Rock and snow facets are 'crisp':
//     the shader keeps them faceted at every distance (a toy mountain, not grey putty).
// No per-facet speckle of any kind: a meadow is one clean sheet of facets (a speckle of yellow
// facets read as a triangle mosaic from the rooftops to the cloud layer). Flowers live on the
// ground-cover meshes; a flower field only warms the colour a few percent at a ≥ 20 m scale.

import { Color, SRGBColorSpace } from 'three';
import { PALETTE } from '../render/palette';
import { Biome, type BiomeId } from '../world/planet';
import { hash3 } from '../world/rng';
import type { TerrainData } from './data';

type RGB = [number, number, number];

/** sRGB components (0..1) of a palette colour (palette Colors are linear). */
export function srgb(c: Color): RGB {
  const t = { r: 0, g: 0, b: 0 };
  c.getRGB(t, SRGBColorSpace);
  return [t.r, t.g, t.b];
}
const hex = (h: string): RGB => srgb(new Color(h));
const mixInto = (o: RGB, b: RGB, t: number): RGB => {
  o[0] += (b[0] - o[0]) * t;
  o[1] += (b[1] - o[1]) * t;
  o[2] += (b[2] - o[2]) * t;
  return o;
};
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const G = PALETTE.ground;
export const TERRAIN_COLORS = {
  // Lit sand should read as the palette sand (#F6D98B) on screen under the golden key and the
  // lavender fill: the albedo leans yellow (more green, much less blue) to land there, not salmon.
  sand: hex('#FCF096'),
  wetSand: hex('#EEDA88'),
  seabed: hex('#D2B877'),
  grass: srgb(G.grass),
  meadow: srgb(G.meadow),
  lush: hex('#62BC4C'),
  hollow: hex('#5BB04A'),
  bloom: hex('#B4DC5E'),
  highGrass: hex('#6CB24E'),
  forestFloor: hex('#5DAE48'),
  rock: srgb(G.rock),
  rockWarm: hex('#A99A8C'),
  rockCool: hex('#8F8D96'),
  snow: srgb(G.snow),
  snowShade: hex('#E4EEF9'),
  /**
   * Base under the city and on its outskirts: A2's garden lawn green (city/ground.ts), so the
   * terrain between and around the gardens reads as the same lawn (A2 draws every surface on top).
   */
  city: hex('#8ACF55'),
};

/** Flower fields warm the smooth colour faintly toward this (±3 %); the blooms are ground cover. */
const WARM = hex('#C8D860');

const C = TERRAIN_COLORS;

/**
 * Farmland patchwork tints by field-cell hash (cumulative thresholds): pasture in two greens, mown
 * hay, golden wheat and a few buttercup-yellow flower fields that read from 50 m up. Strength is
 * how far a cell's colour moves from the meadow under it.
 */
const FIELDS: Array<[number, RGB, number]> = [
  [0.24, hex('#8AD45C'), 0.55], // bright pasture
  [0.46, hex('#6CBB4C'), 0.55], // deep pasture
  [0.62, hex('#A6DB5E'), 0.35], // plain meadow (the palette's)
  [0.8, hex('#BCDA6A'), 0.6], // mown hay
  [0.9, hex('#B8D262'), 0.6], // ripening barley (green-gold: never mistaken for the beach)
  [1.01, hex('#9ED65A'), 0.5], // flower meadow: green; the ground cover blooms in it
];
/**
 * On the town's outskirts (the plateau and its blend ring, under the dive's money frames) the
 * fields are lawn-green variants only, a soft patchwork next to A2's gardens (no hay or barley).
 */
const TOWN_FIELDS: RGB[] = [hex('#8FD25A'), hex('#7EC651'), hex('#96D45C'), hex('#84CB54')];
/** Hedgerow green: field borders, a facet wide, with bushes and the odd tree on them (nature). */
const HEDGE = hex('#3E9443');

/**
 * Field tint of a cell hash into out (no-op off farmland, hash < 0). `town` (0..1, the plateau
 * weight) blends the cell toward its lawn-green outskirts variant.
 */
export function fieldTint(hash: number, out: RGB, town = 0): RGB {
  if (hash < 0) return out;
  if (town >= 1) return mixInto(out, TOWN_FIELDS[Math.floor(hash * 4)], 0.7);
  for (const [t, c, w] of FIELDS) {
    if (hash < t) {
      mixInto(out, c, w * (1 - town));
      return town > 0 ? mixInto(out, TOWN_FIELDS[Math.floor(hash * 4)], 0.7 * town) : out;
    }
  }
  return out;
}

/** True for a field cell hash that is a flower field (ground cover blooms in it). */
export const isFlowerField = (hash: number) => hash >= 0.9;

const isLand = (b: number) => b !== Biome.DeepOcean && b !== Biome.Shallows;

/**
 * The colour of a biome with the given local properties (sRGB 0..1), into out. Shared by vertices
 * (vertex fields) and facets (corner means, the facet's own slope).
 */
export function biomeColor(b: BiomeId, h: number, slope: number, moist: number, tone: number, out: RGB): RGB {
  switch (b) {
    case Biome.DeepOcean:
    case Biome.Shallows:
      out[0] = C.wetSand[0];
      out[1] = C.wetSand[1];
      out[2] = C.wetSand[2];
      return mixInto(out, C.seabed, smooth(0, 2.5, -h));
    case Biome.Beach:
      out[0] = C.wetSand[0];
      out[1] = C.wetSand[1];
      out[2] = C.wetSand[2];
      return mixInto(out, C.sand, smooth(0.05, 0.4, h));
    case Biome.City:
      out[0] = C.city[0];
      out[1] = C.city[1];
      out[2] = C.city[2];
      return out;
    case Biome.Snow:
      out[0] = C.snow[0];
      out[1] = C.snow[1];
      out[2] = C.snow[2];
      return mixInto(out, C.snowShade, smooth(0.2, 0.45, slope));
    case Biome.Rock:
      out[0] = C.rockCool[0];
      out[1] = C.rockCool[1];
      out[2] = C.rockCool[2];
      return mixInto(out, C.rockWarm, tone);
    case Biome.Forest:
      out[0] = C.forestFloor[0];
      out[1] = C.forestFloor[1];
      out[2] = C.forestFloor[2];
      return mixInto(out, C.lush, 0.35 * tone);
    default:
      // Grass and meadow as one continuous field: dry meadow → lush grass by moisture, with slow
      // tone patches (yellow-green bloom meadows, deep green hollows) and darker high pasture.
      out[0] = C.meadow[0];
      out[1] = C.meadow[1];
      out[2] = C.meadow[2];
      mixInto(out, C.grass, smooth(0.3, 0.6, moist));
      // Wide, gentle ramps: on flat-coloured facets a steep tone ramp becomes a staircase.
      mixInto(out, C.bloom, 0.3 * smooth(0.5, 0.85, tone));
      mixInto(out, C.hollow, 0.35 * (1 - smooth(0.15, 0.45, tone)));
      return mixInto(out, C.highGrass, 0.45 * smooth(5, 14, h));
  }
}

const _rock: RGB = [0, 0, 0];
const _meadow: RGB = [0, 0, 0];

/** The smooth colour of one vertex (sRGB 0..1), written into out. */
export function vertexColor(t: TerrainData, i: number, out: RGB): RGB {
  const b = t.biome[i] as BiomeId;
  const h = t.heights[i];
  const slope = t.slope[i];
  biomeColor(b, h, slope, t.moist[i], t.tone[i], out);
  if (b === Biome.Grass || b === Biome.Meadow) {
    // Flower fields warm the colour a few percent (the blooms themselves are ground cover).
    mixInto(out, WARM, 0.12 * t.flower[i] * (1 - t.plateau[i]));
    // Farmland patchwork and the hedgerow lines between the fields.
    fieldTint(t.field[i], out, t.plateau[i]);
    if (t.field[i] >= 0) mixInto(out, HEDGE, 0.5 * (1 - smooth(0.6, 2.2, t.hedge[i])));
  } else if (b === Biome.City) {
    // The plateau base under the city: meadow tone patches, so the first frame (before the city's
    // ground springs in) reads as landscape, not a flat disc.
    biomeColor(Biome.Meadow, 2, 0, t.moist[i], t.tone[i], _meadow);
    mixInto(out, _meadow, 0.25);
    fieldTint(t.field[i], out, 1);
    if (t.field[i] >= 0) mixInto(out, HEDGE, 0.5 * (1 - smooth(0.6, 2.2, t.hedge[i])));
  }
  // Steep faces turn rocky (not the beach, the city or snow).
  if (b !== Biome.City && b !== Biome.Snow && b !== Biome.Beach && isLand(b) && slope > 0.14 && h > 2.2) {
    biomeColor(Biome.Rock, h, slope, 0, t.tone[i], _rock);
    mixInto(out, _rock, smooth(0.14, 0.26, slope) * smooth(2.2, 4, h));
  }
  // Plateau blend ring: ease into the city base so the plateau edge has no seam.
  const p = t.plateau[i];
  if (p > 0 && p < 1 && b !== Biome.Beach && t.field[i] < 0) mixInto(out, C.city, smooth(0.55, 1, p));
  return out;
}

/** The dominant corner biome of face f: majority, ties (three different) → the median-height corner. */
export function dominantBiome(t: TerrainData, f: number): BiomeId {
  const I = t.ico.indices;
  const a = I[f * 3], b = I[f * 3 + 1], c = I[f * 3 + 2];
  const ba = t.biome[a], bb = t.biome[b], bc = t.biome[c];
  if (ba === bb || ba === bc) return ba as BiomeId;
  if (bb === bc) return bb as BiomeId;
  const ha = t.heights[a], hb = t.heights[b], hc = t.heights[c];
  if ((ha - hb) * (ha - hc) <= 0) return ba as BiomeId;
  if ((hb - ha) * (hb - hc) <= 0) return bb as BiomeId;
  return bc as BiomeId;
}

/**
 * The facet colour of face f (sRGB 0..1) into out; returns 1 when the facet is 'crisp' (rock,
 * snow, steep rocky slopes: kept faceted at every distance), else 0. `fslope` is 1 − n·up of the
 * facet's own normal.
 */
export function faceColor(t: TerrainData, f: number, fslope: number, out: RGB): number {
  const I = t.ico.indices;
  const a = I[f * 3], b = I[f * 3 + 1], c = I[f * 3 + 2];
  let dom = dominantBiome(t, f);
  const B = t.biome;
  // Snow by threshold: a facet is snow only if every corner is above the snowline, so the cap's
  // edge follows the facets (a crisp white staircase, no blurry smear).
  if (dom === Biome.Snow && !(B[a] === Biome.Snow && B[b] === Biome.Snow && B[c] === Biome.Snow)) dom = Biome.Rock;
  const h = (t.heights[a] + t.heights[b] + t.heights[c]) / 3;
  const moist = (t.moist[a] + t.moist[b] + t.moist[c]) / 3;
  const tone = (t.tone[a] + t.tone[b] + t.tone[c]) / 3;
  const p = (t.plateau[a] + t.plateau[b] + t.plateau[c]) / 3;
  biomeColor(dom, h, fslope, moist, tone, out);
  let crisp = dom === Biome.Rock || dom === Biome.Snow ? 1 : 0;
  // Steep facets are rock, with a narrow threshold on the facet's own slope (no khaki band).
  if (crisp === 0 && dom !== Biome.City && dom !== Biome.Beach && isLand(dom) && h > 2.2 && fslope > 0.19) {
    const k = smooth(0.19, 0.25, fslope) * smooth(2.2, 3.4, h);
    biomeColor(Biome.Rock, h, fslope, 0, tone, _rock);
    mixInto(out, _rock, k);
    if (k > 0.5) crisp = 1;
  }
  const meadow = dom === Biome.Grass || dom === Biome.Meadow;
  if (dom === Biome.City) {
    // Plateau base: lawn green with a hint of the countryside's meadow patches (see vertexColor).
    biomeColor(Biome.Meadow, 2, 0, moist, tone, _meadow);
    mixInto(out, _meadow, 0.25);
  }
  let farmed = false;
  if (meadow || dom === Biome.City) {
    // Farmland: the facet takes its majority corner's field (a crisp staircase between fields);
    // facets on a border are hedgerow green.
    const fa = t.field[a], fb = t.field[b], fcl = t.field[c];
    const fid = fa === fb || fa === fcl ? fa : fb === fcl ? fb : fa;
    if (fid >= 0) {
      farmed = true;
      fieldTint(fid, out, dom === Biome.City ? 1 : p);
      if ((fa !== fb || fa !== fcl) && Math.min(t.hedge[a], t.hedge[b], t.hedge[c]) < 1.6) mixInto(out, HEDGE, 0.6);
    }
    // Flower fields: the same faint warm tint as the smooth colour, never a per-facet speckle.
    const fl = ((t.flower[a] + t.flower[b] + t.flower[c]) / 3) * (1 - p);
    if (dom !== Biome.City) mixInto(out, WARM, 0.12 * fl);
  }
  if (dom === Biome.Rock) {
    // Rock faces: each facet leans warm or cool (strata, not one flat grey).
    biomeColor(Biome.Rock, h, fslope, 0, hash3(f, 0xf20) < 0.5 ? 0 : 1, _rock);
    mixInto(out, _rock, 0.5 * hash3(f, 0xf21));
  }
  if (p > 0 && p < 1 && dom !== Biome.Beach && !farmed) mixInto(out, C.city, smooth(0.55, 1, p));
  // Value jitter: mostly the low-frequency field (soft patches), a little per facet; warmth too.
  const quiet = p >= 1 ? 0.8 : 1;
  const jl = (t.jit[a] + t.jit[b] + t.jit[c]) / 3;
  const j = 1 + (0.035 * jl + (hash3(f, 17) - 0.5) * (dom === Biome.Rock ? 0.09 : 0.02)) * quiet;
  const w = (0.015 * jl + (hash3(f, 91) - 0.5) * 0.008) * quiet;
  out[0] *= j * (1 + w);
  out[1] *= j;
  out[2] *= j * (1 - w);
  return crisp;
}

const cache = new WeakMap<TerrainData, Uint8Array>();

/** sRGB bytes (rgb interleaved) per vertex. Cached per TerrainData. */
export function vertexColors(t: TerrainData): Uint8Array {
  const hit = cache.get(t);
  if (hit) return hit;
  const n = t.ico.vertexCount;
  const out = new Uint8Array(n * 3);
  const c: RGB = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    vertexColor(t, i, c);
    out[i * 3] = Math.round(Math.min(1, c[0]) * 255);
    out[i * 3 + 1] = Math.round(Math.min(1, c[1]) * 255);
    out[i * 3 + 2] = Math.round(Math.min(1, c[2]) * 255);
  }
  cache.set(t, out);
  return out;
}
