// Planet shape and biomes. Pure TS, seeded, deterministic, allocation-free per query.
//
// heightAt(dir) is metres above sea level (R) for a unit direction: negative under the ocean,
// exactly PLATEAU_HEIGHT on the city plateau, PEAK at most on the mountain range. The shape (A1):
//   - a blue planet (~2/3 ocean; ~70 % of the default orbit view around the city is not city):
//     land is the max of seeded angular blobs, their outlines bent by one warp field into bays
//     and headlands, plus fine coves at the waterline;
//   - the city's continent: the coast hugs the plateau on most bearings (a guard keeps land to
//     ~20 m past the plateau edge, the blend ring lifting it gently, then a 1-2 m deep lagoon shelf
//     with sandbars for ~40 m before deep water, so the shore is a turquoise ring, never a circle
//     or a drop), a windmill hill on the sunny (west) side, and a neck of meadows and woods out to
//     a peninsula carrying a ridge of snowcapped peaks across the city's line of sight (~1 rad);
//   - islands in the city's sea and a second continent with an archipelago on the far side;
//   - a wide, gently sloping beach ramp (same slope on both sides of the waterline), rolling hills
//     inland (calmer right around the city), a shallow turquoise shelf then deep basins offshore;
//   - the city plateau blended in with a smoothstep over PLATEAU_BLEND radians: no cliff.
//
// A1 may tune the shape (BRIEF: "may tune world/planet*"), keeping heightAt's range, the plateau
// contract (flat ±0.05 inside PLATEAU_RADIUS, smooth edge) and land around the plateau.
//
// v2 (R1): heightAt() is the FINAL terrain: the natural shape and the plateau (baseHeightAt) with
// the region carved in (world/region: settlement pads, gate plazas, runways, graded road beds). The
// region is routed over baseHeightAt only, so there is no cycle; it is built on the first heightAt()
// call (≤ 20 ms, on the terrain's path) and cached on the planet (planet.region).

import {
  CITY_LAT,
  CITY_LON,
  OCEAN_FLOOR,
  PEAK,
  PLATEAU_BLEND,
  PLATEAU_HEIGHT,
  PLATEAU_RADIUS,
  R,
  SEED,
} from './config';
import { createNoise3, type Noise3 } from './noise';
import { buildRegion } from './region/build';
import type { Region, SurfaceHit } from './region/types';
import { Rng } from './rng';
import { angleBetween, cross3, dirFromLatLon, normalize3, tangentFrame, v3, type Vec3 } from './sphere';

/** Biome ids. Numeric so they pack into vertex attributes. */
export const Biome = {
  DeepOcean: 0,
  Shallows: 1,
  Beach: 2,
  Grass: 3,
  Meadow: 4,
  Forest: 5,
  Rock: 6,
  Snow: 7,
  /**
   * The city plateau (A2 draws the city on it; trees only where the city index says free), and v2
   * (R1) the region's paved ground: town pads, gate plazas, runways and carriageways.
   */
  City: 8,
} as const;
export type BiomeId = (typeof Biome)[keyof typeof Biome];

/**
 * v2 (R1): the seeded landmarks the shape is built round, so the region (world/region) can place
 * settlements by them: unit directions of the blob centres.
 */
export interface PlanetAnchors {
  /** The snowy range's centre, and the unit tangent along its ridge there. */
  readonly range: Vec3;
  readonly ridge: Vec3;
  /** The windmill meadow hill on the sunny (west) side of the city. */
  readonly windHill: Vec3;
  /** The neck of meadows and woods between the city and the range. */
  readonly neck: Vec3;
  /** The shoulder: a lobe beside the neck, by the capital's east gate. */
  readonly shoulder: Vec3;
  /** The alpine valley's meadow centre (in the hollow between the peaks) and the unit tangent there along its pass, toward the city (VALLEY). */
  readonly valley: Vec3;
  readonly passAxis: Vec3;
  /** v2 (R1): the farm village's shelf beside the windmill hill and the harbour's cape on the south coast (SHELF, CAPE). */
  readonly shelf: Vec3;
  readonly cape: Vec3;
  /** The two small headlands off the city's coast, away from the range. */
  readonly headlands: readonly Vec3[];
  /** The islands in the city's sea (5); v2 (R1): the first is the island resort's. */
  readonly islands: readonly Vec3[];
  /** The far continent's centre, its archipelago (6, arcing away) and the third land mass. */
  readonly second: Vec3;
  readonly archipelago: readonly Vec3[];
  readonly third: Vec3;
}

export interface Planet {
  readonly seed: number;
  /** Unit vector at the city centre. */
  readonly cityDir: Vec3;
  /** v2 (R1): the landmarks the shape is built round. */
  readonly anchors: PlanetAnchors;
  /**
   * Terrain height above sea level (m) at unit `dir`. Range [OCEAN_FLOOR, PEAK]. v2: includes the
   * region's pads and road beds (the terrain mesh, trees, the camera and the city index all agree).
   */
  heightAt(dir: Vec3): number;
  /** v2 (R1): the natural terrain plus the plateau, before the region is carved in. Routing reads it. */
  baseHeightAt(dir: Vec3): number;
  /** v2 (R1): the region (settlements, roads, ferries, airports) carved into this planet; built on first use. */
  readonly region: Region;
  /** max(heightAt, 0): the height of whatever you would stand on (water counts as 0). */
  surfaceAt(dir: Vec3): number;
  /** 1 on the flat plateau, easing to 0 across the blend ring, 0 elsewhere. */
  plateauWeight(dir: Vec3): number;
  /** 0..1 slow moisture field (forest vs meadow). */
  moistureAt(dir: Vec3): number;
  /** 0..1 mountain-range mask (rock and snow live where it is high). */
  mountainAt(dir: Vec3): number;
  /** Biome at `dir`. Pass `h` if you already have heightAt(dir). */
  biomeAt(dir: Vec3, h?: number): BiomeId;
  /** Terrain surface normal (finite differences over ~`step` m). Writes and returns `out`. */
  normalAt(dir: Vec3, out: Vec3, step?: number): Vec3;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** 0 → 1 over x ∈ [0, 1] with a finite slope at 0 and a flat top (1 − (1 − x)²). */
const easeOut = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return 1 - (1 - t) * (1 - t);
};

/**
 * v2 (R1): the alpine valley's shape (metres): the meadow floor's height (high on the range's flank,
 * just under the snowline, so the road up from the neck needs its hairpins) and its flat / blended
 * radii round the hollow; the pass corridor along the axis toward the city: the saddle's distance
 * and height, the ramp's foot and height there, the corridor's half width at the saddle and on the
 * ramp, its centre's offset across the axis (toward the side the hairpins turn on), its lateral fade.
 */
/** v2 (R1): the farm village's shelf and the harbour's cape (compass bearing from the city, arc m, blob radius rad, height k). */
export const SHELF = { deg: 248, m: 141, r: 0.22, k: 0.26 } as const;
/** v2 (R1): extra moisture (forest) on the wild third land mass. */
export const WILD_WET = 0.12;
/** v2 (R1): how much further out (rad) the island resort's island stands than v1's. */
export const ISLE_OUT = 0.045;
export const CAPE = { deg: 174, m: 133, r: 0.21, k: 0.26 } as const;

export const VALLEY = { meadowH: 13.5, meadowIn: 26, meadowOut: 38, saddle: 30, passH: 14.5, rampEnd: 56, rampH: 2.3, passHalf: 17, rampHalf: 32, passShift: -5, fade: 16 } as const;

const cache = new Map<number, Planet>();

/** The planet for `seed` (cached). getPlanet() with no argument is the canonical world. */
export function getPlanet(seed: number = SEED): Planet {
  let p = cache.get(seed);
  if (!p) cache.set(seed, (p = createPlanet(seed)));
  return p;
}

/**
 * `region: false` builds no region (heightAt = baseHeightAt); `regionBake` overrides the region's baked
 * searches (null: none, compute everything; world/region/bake.ts).
 */
export function createPlanet(seed: number, opts: { region?: boolean; regionBake?: string | null } = {}): Planet {
  const nContinent = createNoise3(seed ^ 0x1001);
  const nDetail = createNoise3(seed ^ 0x2002);
  const nMountain = createNoise3(seed ^ 0x3003);
  const nMoist = createNoise3(seed ^ 0x4004);
  const cityDir = dirFromLatLon(CITY_LAT, CITY_LON);

  // Land masses (angular blobs). The city's continent is kept compact so that from orbit the
  // planet reads ~55-60 % ocean even with the 0.56 rad plateau in view: a ring of coast around the
  // plateau (bays come within ~8 m of the blend ring, headlands reach ~50 m out), a mountainous
  // peninsula carrying the snowy range, a few islands in the city's sea, a second continent and an
  // archipelago on the far side.
  const rng = Rng.for(seed, 'continents');
  const blobs: Array<{ c: Vec3; r: number; k: number }> = [];
  const pointAt = (from: Vec3, ang: number, bearing: number): Vec3 => {
    const e = v3();
    const n = v3();
    tangentFrame(from, e, n);
    const tx = e.x * Math.cos(bearing) + n.x * Math.sin(bearing);
    const ty = e.y * Math.cos(bearing) + n.y * Math.sin(bearing);
    const tz = e.z * Math.cos(bearing) + n.z * Math.sin(bearing);
    return normalize3(v3(from.x * Math.cos(ang) + tx * Math.sin(ang), from.y * Math.cos(ang) + ty * Math.sin(ang), from.z * Math.cos(ang) + tz * Math.sin(ang)));
  };
  // The mountain range: a ridge on a peninsula of the city's continent, ~0.98 rad from the city, so
  // its snowcaps peek over the city's horizon from the rooftops and fill the skyline from 40 m up.
  const rangeBearing = rng.range(0, Math.PI * 2);
  const rangeCentre = pointAt(cityDir, 0.98, rangeBearing);
  const cosRC = cityDir.x * rangeCentre.x + cityDir.y * rangeCentre.y + cityDir.z * rangeCentre.z;
  // The range runs across the city's line of sight (its long side faces the city skyline).
  const toCity = normalize3(v3(cityDir.x - rangeCentre.x * cosRC, cityDir.y - rangeCentre.y * cosRC, cityDir.z - rangeCentre.z * cosRC));
  const ridgeT = cross3(v3(), rangeCentre, toCity);
  const along = (s: number) => normalize3(v3(rangeCentre.x * Math.cos(s) + ridgeT.x * Math.sin(s), rangeCentre.y * Math.cos(s) + ridgeT.y * Math.sin(s), rangeCentre.z * Math.cos(s) + ridgeT.z * Math.sin(s)));
  // v2 (R1): the alpine valley's frame (valleyShape): the hollow between the peaks, on the far side of
  // the ridge, and the pass axis from it toward the city.
  const valley = (() => {
    const a = 0.0588; // along the ridge
    const b = -0.098; // across it (negative: away from the city)
    const w = Math.sqrt(1 - a * a - b * b);
    return normalize3(v3(rangeCentre.x * w + ridgeT.x * a + toCity.x * b, rangeCentre.y * w + ridgeT.y * a + toCity.y * b, rangeCentre.z * w + ridgeT.z * a + toCity.z * b));
  })();
  const passAxis = (() => {
    const c = cityDir.x * valley.x + cityDir.y * valley.y + cityDir.z * valley.z;
    return normalize3(v3(cityDir.x - valley.x * c, cityDir.y - valley.y * c, cityDir.z - valley.z * c));
  })();
  const passSide = normalize3(cross3(v3(), valley, passAxis));
  const cosValleyReach = Math.cos(80 / R);
  // The city's continent: the coast hugs the plateau on most bearings (beaches just past the blend
  // ring, a blue planet from orbit), and a broad neck of meadows and forest runs out to the range's
  // peninsula: windmill hills and woods at the foot of the snowy ridge, seen from the city.
  blobs.push({ c: pointAt(cityDir, 0.48, rangeBearing + Math.PI), r: 0.22, k: 0.3 });
  // A hill on the sunny side (west of the city at the start of the day): the windmill meadow.
  const windHill = pointAt(cityDir, 0.76, rangeBearing + Math.PI + 0.5);
  // (v2 R1: a little broader than v1's 0.19, so the farm village fits beside the mills with its fields)
  blobs.push({ c: windHill, r: 0.245, k: 0.34 });
  const neck = pointAt(cityDir, 0.66, rangeBearing);
  blobs.push({ c: neck, r: 0.24, k: 0.42 }); // the neck
  const shoulder = pointAt(cityDir, 0.74, rangeBearing + 0.45);
  blobs.push({ c: shoulder, r: 0.13, k: 0.32 }); // a shoulder
  blobs.push({ c: rangeCentre, r: 0.27, k: 0.56 });
  blobs.push({ c: along(0.2), r: 0.21, k: 0.52 });
  blobs.push({ c: along(-0.2), r: 0.21, k: 0.52 });
  // A couple of small headlands off the city's coast, away from the range.
  const headlands = [pointAt(cityDir, 0.74, rangeBearing + 2.3), pointAt(cityDir, 0.72, rangeBearing - 2.0)];
  blobs.push({ c: headlands[0], r: 0.13, k: 0.14 });
  blobs.push({ c: headlands[1], r: 0.12, k: 0.13 });
  // v2 (R1): land for two towns standing well clear of the plateau (V2 §1.1: separate silhouettes,
  // not suburbs), placed by compass bearing from the city (0 = north, clockwise; metres of arc):
  //   - a broad shelf south-west of the windmill hill, where the farm village stands among its fields;
  //   - a cape on the south coast, the harbour town's (in the afternoon light, face-on in the orbit view).
  // The SW headland's tip, the N headland (and so the lighthouse's pick), the windmill hill are v1's.
  const atCompass = (m: number, deg: number) => pointAt(cityDir, m / R, Math.PI / 2 - (deg * Math.PI) / 180);
  const shelf = atCompass(SHELF.m, SHELF.deg);
  const cape = atCompass(CAPE.m, CAPE.deg);
  blobs.push({ c: shelf, r: SHELF.r, k: SHELF.k });
  blobs.push({ c: cape, r: CAPE.r, k: CAPE.k });
  // Islands in the city's sea, east and south of it (beside the city as seen from orbit). Each is
  // two or three overlapping blobs so none is a round dot.
  const islands: Vec3[] = [];
  // Low k: a gentle dome with a sandy rim (a high k on a small blob made cliffs, not beaches).
  // (A wide, low blob has a gentle shelf: the coast's slope scales with k / r.)
  const island = (c: Vec3, r: number) => {
    blobs.push({ c, r: r * 1.7, k: rng.range(0.1, 0.2) });
    const extra = rng.int(1, 2);
    for (let j = 0; j < extra; j++) blobs.push({ c: pointAt(c, r * rng.range(0.6, 1.1), rng.range(0, Math.PI * 2)), r: r * rng.range(0.9, 1.3), k: rng.range(0.06, 0.14) });
  };
  for (const [bearing, dist, r] of [
    [0.3, 1.05, 0.15], // (v2 R1: v1's 0.1 grown for the island resort)
    [0.75, 1.25, 0.08],
    [1.15, 1.0, 0.06],
    [-1.3, 1.1, 0.09],
    [-1.75, 1.32, 0.07],
  ]) {
    // (v2 R1: the resort's island stands a little further out, a channel off the shoulder for its bridge)
    const c = pointAt(cityDir, dist + rng.range(-0.05, 0.05) + (islands.length === 0 ? ISLE_OUT : 0), bearing + rng.range(-0.1, 0.1));
    islands.push(c);
    island(c, r);
  }
  // The far side: a second continent and an archipelago arcing away from it.
  const anti = v3(-cityDir.x, -cityDir.y, -cityDir.z);
  const second = pointAt(anti, 0.45, rng.range(0, Math.PI * 2));
  blobs.push({ c: second, r: 0.72, k: 0.55 });
  const archBearing = rng.range(0, Math.PI * 2);
  const archipelago: Vec3[] = [];
  for (let i = 0; i < 6; i++) {
    const c = pointAt(second, 1.05 + i * 0.19, archBearing + Math.sin(i * 0.9) * 0.35);
    archipelago.push(c);
    island(c, rng.range(0.07, 0.13) * (1 - i * 0.06));
  }
  const third = pointAt(anti, 1.2, rng.range(0, Math.PI * 2));
  blobs.push({ c: third, r: 0.42, k: 0.5 });
  const cosBlob = blobs.map((b) => 1 - Math.cos(b.r));

  // Land guard around the plateau: land to ~20 m past the plateau edge (the coast sits inside the
  // blend ring, which lifts it gently), then a wide shallow lagoon shelf (1-2 m deep, ~40 m) before
  // the drop to deep water, so the shore is a turquoise ring and never a cliff. The wobble moves
  // both edges: bays, points and sandbars instead of a circle.
  const GUARD_LAND = PLATEAU_RADIUS + 0.05;
  const cosGuardShelf = Math.cos(1.3);
  function guard(cosCity: number, wobble: number, bars: number): number {
    const a = Math.acos(Math.min(1, cosCity));
    const coast = smooth(GUARD_LAND - 0.02, GUARD_LAND + 0.07 + 0.04 * wobble, a);
    const drop = smooth(0.8 + 0.07 * wobble, 1.06 + 0.06 * wobble, a);
    // Sandbars and channels: the lagoon floor varies between ~0.4 and ~2.2 m deep.
    return 0.12 - (0.2 + 0.07 * bars) * coast - 0.32 * drop;
  }
  function continent(d: Vec3): number {
    // One warp field bends every blob's outline into bays and headlands.
    const wn = nContinent.fbm3(d.x * 2.1, d.y * 2.1, d.z * 2.1, 3);
    const warp = 1 + 0.45 * wn;
    let c = -0.3;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const cosA = d.x * b.c.x + d.y * b.c.y + d.z * b.c.z;
      const x = ((1 - cosA) / cosBlob[i]) * warp;
      if (x < 1) c = Math.max(c, -0.3 + (b.k + 0.3) * (1 - x) * (2 - (1 - x)) * 0.999);
    }
    // Coves and spits at a ~20-40 m scale, strongest at the waterline.
    const cn = nContinent.fbm3(d.x * 6.5 + 11, d.y * 6.5, d.z * 6.5 - 7, 3);
    c += 0.075 * cn;
    // Guarantee land around the plateau: the blend ring and a few metres beyond it are always land
    // (the noise still shapes the coast right after, so it is not a circle).
    const cosCity = d.x * cityDir.x + d.y * cityDir.y + d.z * cityDir.z;
    if (cosCity > cosGuardShelf) c = Math.max(c, guard(cosCity, Math.max(-1, Math.min(1, 1.6 * wn + 1.2 * cn)), nDetail.simplex3(d.x * 13 + 5, d.y * 13, d.z * 13)));
    return c;
  }

  const cosRangeOut = Math.cos(0.62);
  const cosAway0 = Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND + 0.03);
  const cosAway1 = Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND + 0.2);
  function mountainAt(d: Vec3): number {
    const cosA = d.x * rangeCentre.x + d.y * rangeCentre.y + d.z * rangeCentre.z;
    if (cosA < cosRangeOut) return 0;
    // A noise-bent ridge line through the range centre.
    const across = d.x * toCity.x + d.y * toCity.y + d.z * toCity.z + 0.09 * nMountain.fbm3(d.x * 3.1, d.y * 3.1, d.z * 3.1, 2);
    const along = d.x * ridgeT.x + d.y * ridgeT.y + d.z * ridgeT.z;
    const m = (1 - smooth(0.04, 0.2, Math.abs(across))) * (1 - smooth(0.2, 0.42, Math.abs(along)));
    if (m <= 0) return 0;
    const cosCity = d.x * cityDir.x + d.y * cityDir.y + d.z * cityDir.z;
    return m * smooth(cosAway0, cosAway1, cosCity);
  }

  const cosCalm0 = Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND - 0.04);
  const cosCalm1 = Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND + 0.3);
  function natural(d: Vec3): number {
    const c = continent(d);
    if (c < 0) {
      // Shelf near the coast, basins further out.
      // (A wide, shallow shelf first: turquoise lagoons and a gentle waterline, then the drop.)
      const deep = smooth(0.07, 0.5, -c);
      const ripple = 1.5 * nDetail.simplex3(d.x * 9, d.y * 9, d.z * 9);
      return Math.max(OCEAN_FLOOR, -deep * (-OCEAN_FLOOR - 2) + ripple * deep - 2 * easeOut(-c / 0.26));
    }
    // Gentle meadows right around the city, bigger hills further out.
    const cosCity = d.x * cityDir.x + d.y * cityDir.y + d.z * cityDir.z;
    const calm = cosCity > cosCalm1 ? 0.36 + 0.64 * smooth(cosCalm0, cosCalm1, cosCity) : 1;
    const inland = smooth(0.04, 0.28, c) * calm;
    // Coast: a gentle beach ramp from the waterline, then rolling hills further in.
    // A wide, gently sloping beach; continuous with the seabed at the waterline (c = 0) and with
    // the same slope on both sides (no flat zone the swell would flood).
    let h = 1.3 * easeOut(c / 0.17);
    h += inland * (1.8 + 2.0 * nDetail.fbm3(d.x * 5.5, d.y * 5.5, d.z * 5.5, 3));
    h += inland * 8 * smooth(0.12, 0.42, c) * Math.max(0, 0.3 + 0.7 * nDetail.simplex3(d.x * 3.1, d.y * 3.1, d.z * 3.1));
    const m = mountainAt(d);
    if (m > 0.001) {
      const r = nMountain.ridged3(d.x * 4.2, d.y * 4.2, d.z * 4.2, 5);
      h += m * inland * (6 + 20 * r);
    }
    return Math.min(PEAK, valleyShape(d, h, c));
  }

  // v2 (R1): the alpine valley. A meadow floor in the hollow between the range's peaks (the alpine
  // village stands on it) and a pass over the range's shoulder toward the city: the saddle above the
  // meadow's rim, then a broad, even ramp down to the neck (the road climbs it in hairpins). The
  // peaks round it are v1's.
  function valleyShape(d: Vec3, h: number, c: number): number {
    const cv = d.x * valley.x + d.y * valley.y + d.z * valley.z;
    if (cv < cosValleyReach) return h;
    // (never at the shore: the valley's floor slopes down to its beach like any coast)
    const shore = smooth(0.0, 0.3, c);
    if (shore <= 0) return h;
    const r = Math.acos(Math.min(1, cv)) * R;
    const v = (d.x * passAxis.x + d.y * passAxis.y + d.z * passAxis.z) * R;
    const u = (d.x * passSide.x + d.y * passSide.y + d.z * passSide.z) * R;
    let out = h;
    const wm = (1 - smooth(VALLEY.meadowIn, VALLEY.meadowOut, r)) * shore;
    if (wm > 0) out += (VALLEY.meadowH + 0.5 * nDetail.simplex3(d.x * 13, d.y * 13, d.z * 13) - out) * wm;
    if (v > VALLEY.meadowIn - 6 && v < VALLEY.rampEnd + 9) {
      const half = VALLEY.passHalf + (VALLEY.rampHalf - VALLEY.passHalf) * smooth(VALLEY.saddle, VALLEY.saddle + 9, v);
      const wl = (1 - smooth(half, half + VALLEY.fade, Math.abs(u - VALLEY.passShift))) * (1 - smooth(VALLEY.rampEnd, VALLEY.rampEnd + 9, v)) * smooth(VALLEY.meadowIn - 6, VALLEY.meadowIn, v) * shore;
      if (wl > 0) {
        const f =
          v < VALLEY.saddle
            ? VALLEY.meadowH + (VALLEY.passH - VALLEY.meadowH) * smooth(VALLEY.meadowIn - 4, VALLEY.saddle, v)
            : VALLEY.passH - (VALLEY.passH - VALLEY.rampH) * Math.min(1, (v - VALLEY.saddle) / (VALLEY.rampEnd - VALLEY.saddle));
        out += (f - out) * wl;
      }
    }
    return out;
  }

  const cosPlateau = Math.cos(PLATEAU_RADIUS);
  const cosBlend = Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND);

  function plateauWeight(d: Vec3): number {
    const cosA = d.x * cityDir.x + d.y * cityDir.y + d.z * cityDir.z;
    if (cosA >= cosPlateau) return 1;
    if (cosA <= cosBlend) return 0;
    const a = Math.acos(Math.min(1, cosA));
    return 1 - smooth(PLATEAU_RADIUS, PLATEAU_RADIUS + PLATEAU_BLEND, a);
  }

  function baseHeightAt(d: Vec3): number {
    const w = plateauWeight(d);
    if (w >= 1) return PLATEAU_HEIGHT;
    const n = natural(d);
    return w <= 0 ? n : n + (PLATEAU_HEIGHT - n) * w;
  }

  // The region, built on first use from the base terrain alone (opts.region false: never).
  let region: Region | null = null;
  let carve: ((d: Vec3, base: number) => number) | null = null;
  let building = false;
  const withRegion = opts.region !== false;
  function ensureRegion(): Region {
    if (!region) {
      building = true;
      try {
        region = buildRegion(self, opts.regionBake === undefined ? {} : { bake: opts.regionBake });
      } finally {
        building = false;
      }
      carve = region.carve;
    }
    return region;
  }
  // The carve never touches the plateau (the city owns it, flat): it fades in over the first
  // metres outside the rim, where the base terrain is still at the plateau's height anyway.
  const cosRimFade = Math.cos(PLATEAU_RADIUS + 3 / (R + PLATEAU_HEIGHT));
  function heightAt(d: Vec3): number {
    const b = baseHeightAt(d);
    if (!withRegion || building) return b;
    if (!carve) ensureRegion();
    const cosA = d.x * cityDir.x + d.y * cityDir.y + d.z * cityDir.z;
    if (cosA >= cosPlateau) return b;
    const h = carve!(d, b);
    if (cosA <= cosRimFade || h === b) return h;
    const a = Math.acos(Math.min(1, cosA));
    return b + (h - b) * smooth(PLATEAU_RADIUS, PLATEAU_RADIUS + 3 / (R + PLATEAU_HEIGHT), a);
  }

  const cosWild0 = Math.cos(0.42);
  const cosWild1 = Math.cos(0.2);
  const cosWet0 = Math.cos(0.75);
  const cosWet1 = Math.cos(0.35);
  const cosDry0 = Math.cos(0.24);
  const cosDry1 = Math.cos(0.1);
  function moistureAt(d: Vec3): number {
    const m = 0.5 + 0.5 * nMoist.fbm3(d.x * 2.6, d.y * 2.6, d.z * 2.6, 3);
    // Wetter at the range's foot: woods between the windmill meadows and the rock.
    const cosR = d.x * rangeCentre.x + d.y * rangeCentre.y + d.z * rangeCentre.z;
    if (cosR > cosWet0) {
      const wet = Math.min(1, m + 0.16 * smooth(cosWet0, cosWet1, cosR));
      // v2 (R1): an open alpine meadow on the valley's floor (no forest there)
      const cv = d.x * valley.x + d.y * valley.y + d.z * valley.z;
      if (cv < cosValleyReach) return wet;
      const r = Math.acos(Math.min(1, cv)) * R;
      return Math.max(0, wet - 0.42 * (1 - smooth(VALLEY.meadowIn - 4, VALLEY.meadowIn + 4, r)));
    }
    // Drier on the windmill hill: open meadow round the mills.
    const cosW = d.x * windHill.x + d.y * windHill.y + d.z * windHill.z;
    if (cosW > cosDry0) return Math.max(0, m - 0.22 * smooth(cosDry0, cosDry1, cosW));
    // v2 (R1): the wild third land mass (no town, no road) is wooded: the forest the towns' pads
    // cleared grows back there (the living world keeps its trees, nature/scatter.spec)
    const cosT = d.x * third.x + d.y * third.y + d.z * third.z;
    return cosT > cosWild0 ? Math.min(1, m + WILD_WET * smooth(cosWild0, cosWild1, cosT)) : m;
  }

  const cosValleyGrass = Math.cos((VALLEY.meadowOut + 4) / R);
  /** v2 (R1): inside the alpine valley's meadow or on its pass (grass, not rock). */
  function inValley(d: Vec3): boolean {
    const cv = d.x * valley.x + d.y * valley.y + d.z * valley.z;
    if (cv >= cosValleyGrass) return true;
    if (cv < cosValleyReach) return false;
    const v = (d.x * passAxis.x + d.y * passAxis.y + d.z * passAxis.z) * R;
    const u = (d.x * passSide.x + d.y * passSide.y + d.z * passSide.z) * R;
    return v > 0 && v < VALLEY.rampEnd + 4 && Math.abs(u - VALLEY.passShift) < VALLEY.rampHalf + 4;
  }
  const _hit: SurfaceHit = { cls: 'free', roadDist: 0, edge: -1, settlement: -1 };
  function biomeAt(d: Vec3, hIn?: number): BiomeId {
    const h = hIn ?? heightAt(d);
    if (h < -3.5) return Biome.DeepOcean;
    if (h < 0) return Biome.Shallows;
    if (plateauWeight(d) >= 1) return Biome.City;
    // v2 (R1): the region's paved ground (town pads, gate plazas, runways, carriageways) is built
    // ground like the plateau: no scatter grows there and no landmark stands on it.
    let built = false;
    let pad = false;
    if (region && withRegion) {
      const cls = region.surface(d, _hit).cls;
      if (cls !== 'free' && cls !== 'verge' && cls !== 'pad') return Biome.City;
      pad = cls === 'pad';
      // v2 (R1): ground the region built up (pads, verges, fills over the shallows) is grass down to a
      // thin sand rim at the water, never a sand / grass mosaic on a flat (the old sawtooth): the
      // biome follows the carve, not the carved height against the beach line.
      built = h > 0.35 && (cls !== 'free' || h - baseHeightAt(d) > 0.25);
    }
    // Beaches ring every shore (the city's bays too), wider in some coves than others.
    if (!built && h < 1.25 + 0.4 * nDetail.simplex3(d.x * 6.5, d.y * 6.5, d.z * 6.5)) return Biome.Beach;
    const m = mountainAt(d);
    // Snow: a cap on every peak (a line at 18.5 m left 2–3 stray white facets on a grey blob from
    // above), lower in the heart of the range, with a ragged (not single-facet) edge.
    const jitter = 1.3 * nDetail.simplex3(d.x * 17, d.y * 17, d.z * 17);
    if (h + jitter > 16.2 - 1.6 * smooth(0.45, 0.9, m)) return Biome.Snow;
    // (v2 R1: the alpine valley's meadow and its pass stay grass, the village's pastures, below the snowline)
    if (m > 0.35 && h > 8 && !inValley(d)) return Biome.Rock;
    const moist = moistureAt(d);
    // (v2 R1: a town's pad is cleared ground, open grass and the odd tree, never forest; T1 builds on it)
    if (moist > 0.58 && h > 2.2 && !pad) return Biome.Forest;
    return moist > 0.42 ? Biome.Grass : Biome.Meadow;
  }

  const _e = v3();
  const _n = v3();
  const _p = v3();
  /** Height at d offset by (dx, dy)·a along the tangent frame (_e, _n). Allocation-free. */
  function sampleOffset(d: Vec3, dx: number, dy: number, a: number): number {
    _p.x = d.x + (_e.x * dx + _n.x * dy) * a;
    _p.y = d.y + (_e.y * dx + _n.y * dy) * a;
    _p.z = d.z + (_e.z * dx + _n.z * dy) * a;
    normalize3(_p);
    return heightAt(_p);
  }
  function normalAt(d: Vec3, out: Vec3, step = 1.0): Vec3 {
    tangentFrame(d, _e, _n);
    const a = step / R;
    const he = sampleOffset(d, 1, 0, a) - sampleOffset(d, -1, 0, a);
    const hn = sampleOffset(d, 0, 1, a) - sampleOffset(d, 0, -1, a);
    const r = R + heightAt(d);
    // ∂p/∂e ≈ e·(2·step·r/R) + d·he ; ∂p/∂n likewise; normal = ∂e × ∂n (outward, as east × north = up).
    const s = (2 * step * r) / R;
    const ux = _e.x * s + d.x * he;
    const uy = _e.y * s + d.y * he;
    const uz = _e.z * s + d.z * he;
    const vx = _n.x * s + d.x * hn;
    const vy = _n.y * s + d.y * hn;
    const vz = _n.z * s + d.z * hn;
    out.x = ux;
    out.y = uy;
    out.z = uz;
    _p.x = vx;
    _p.y = vy;
    _p.z = vz;
    cross3(out, out, _p);
    return normalize3(out);
  }

  const anchors: PlanetAnchors = { range: rangeCentre, ridge: ridgeT, windHill, neck, shoulder, valley, passAxis, shelf, cape, headlands, islands, second, archipelago, third };

  const self: Planet = {
    seed,
    cityDir,
    anchors,
    heightAt,
    baseHeightAt,
    get region() {
      return ensureRegion();
    },
    surfaceAt: (d) => Math.max(0, heightAt(d)),
    plateauWeight,
    moistureAt,
    mountainAt,
    biomeAt,
    normalAt,
  };
  return self;
}
