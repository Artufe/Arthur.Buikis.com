// Planet shape and biomes. Pure TS, seeded, deterministic, allocation-free per query.
//
// heightAt(dir) is metres above sea level (R) for a unit direction: negative under the ocean,
// exactly PLATEAU_HEIGHT on the city plateau, PEAK at most on the mountain range. The shape:
//   - a continent field: low-frequency fbm plus three seeded continent blobs, one of them centred
//     on the city so the plateau always sits on land, with coast within ~30-60 m of its edge;
//   - rolling hills on land, a ridged mountain range with snowcaps on the city's continent (far
//     enough away that it peeks over the city's horizon), a shelf and basins under the ocean;
//   - the city plateau blended in with a smoothstep over PLATEAU_BLEND radians: no cliff.
//
// A1 may tune the shape (BRIEF: "may tune world/planet*"), keeping heightAt's range, the plateau
// contract (flat ±0.05 inside PLATEAU_RADIUS, smooth edge) and land around the plateau.

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
  /** The city plateau (A2 draws the city on it; trees only where the city index says free). */
  City: 8,
} as const;
export type BiomeId = (typeof Biome)[keyof typeof Biome];

export interface Planet {
  readonly seed: number;
  /** Unit vector at the city centre. */
  readonly cityDir: Vec3;
  /** Terrain height above sea level (m) at unit `dir`. Range [OCEAN_FLOOR, PEAK]. */
  heightAt(dir: Vec3): number;
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

const cache = new Map<number, Planet>();

/** The planet for `seed` (cached). getPlanet() with no argument is the canonical world. */
export function getPlanet(seed: number = SEED): Planet {
  let p = cache.get(seed);
  if (!p) cache.set(seed, (p = createPlanet(seed)));
  return p;
}

export function createPlanet(seed: number): Planet {
  const nContinent = createNoise3(seed ^ 0x1001);
  const nDetail = createNoise3(seed ^ 0x2002);
  const nMountain = createNoise3(seed ^ 0x3003);
  const nMoist = createNoise3(seed ^ 0x4004);
  const cityDir = dirFromLatLon(CITY_LAT, CITY_LON);

  // Continent blobs: the city's, plus two more spread around the globe.
  const rng = Rng.for(seed, 'continents');
  const blobs: Array<{ c: Vec3; r: number; k: number }> = [{ c: cityDir, r: 1.25, k: 0.55 }];
  while (blobs.length < 3) {
    const c = normalize3(v3(rng.gauss(), rng.gauss() * 0.6, rng.gauss()));
    if (blobs.every((b) => angleBetween(b.c, c) > 1.5)) blobs.push({ c, r: rng.range(0.7, 0.95), k: rng.range(0.55, 0.7) });
  }
  // The mountain range: a ridge line on the city's continent, ~1.2 rad from the city.
  const rangeCentre = v3();
  {
    const e = v3();
    const n = v3();
    tangentFrame(cityDir, e, n);
    const a = rng.range(0, Math.PI * 2);
    const t = v3(e.x * Math.cos(a) + n.x * Math.sin(a), e.y * Math.cos(a) + n.y * Math.sin(a), e.z * Math.cos(a) + n.z * Math.sin(a));
    const ang = 1.05;
    rangeCentre.x = cityDir.x * Math.cos(ang) + t.x * Math.sin(ang);
    rangeCentre.y = cityDir.y * Math.cos(ang) + t.y * Math.sin(ang);
    rangeCentre.z = cityDir.z * Math.cos(ang) + t.z * Math.sin(ang);
    normalize3(rangeCentre);
    // Keep the city's continent big enough to hold the range.
    blobs.push({ c: v3(rangeCentre.x, rangeCentre.y, rangeCentre.z), r: 0.7, k: 0.55 });
  }

  const cosGuard0 = Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND + 0.02);
  const cosGuard1 = Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND + 0.3);
  function continent(d: Vec3): number {
    let c = 0.42 * nContinent.fbm3(d.x * 1.3, d.y * 1.3, d.z * 1.3, 4) - 0.3;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const cosA = d.x * b.c.x + d.y * b.c.y + d.z * b.c.z;
      // Smooth bump of angular radius b.r (cosine-space falloff, no trig).
      const x = (1 - cosA) / (1 - Math.cos(b.r));
      if (x < 1) c += b.k * (1 - x) * (1 - x);
    }
    // Guarantee land around the plateau (the coast stays at least ~10 m beyond the blend ring),
    // without drawing a circular coastline: the guard only lifts, the noise still shapes the coast.
    const cosCity = d.x * cityDir.x + d.y * cityDir.y + d.z * cityDir.z;
    c += 0.32 * smooth(cosGuard1, cosGuard0, cosCity);
    return c;
  }

  function mountainAt(d: Vec3): number {
    const cosA = d.x * rangeCentre.x + d.y * rangeCentre.y + d.z * rangeCentre.z;
    // Elongated: a noise-warped band through the range centre.
    const band = Math.abs(nMountain.fbm3(d.x * 1.6 + 3.1, d.y * 1.6, d.z * 1.6 - 1.7, 3));
    const near = smooth(0.62, 0.86, cosA);
    const cosCity = d.x * cityDir.x + d.y * cityDir.y + d.z * cityDir.z;
    const awayFromCity = smooth(Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND + 0.12), Math.cos(PLATEAU_RADIUS + PLATEAU_BLEND + 0.4), cosCity);
    return near * smooth(0.32, 0.06, band) * awayFromCity;
  }

  function natural(d: Vec3): number {
    const c = continent(d);
    if (c < 0) {
      // Shelf near the coast, basins further out.
      const deep = smooth(0.02, 0.45, -c);
      const ripple = 1.5 * nDetail.simplex3(d.x * 9, d.y * 9, d.z * 9);
      return Math.max(OCEAN_FLOOR, -deep * (-OCEAN_FLOOR - 2) + ripple * deep - 2 * smooth(0, 0.1, -c));
    }
    const inland = smooth(0.04, 0.28, c);
    // Coast: a gentle beach ramp from the waterline, then rolling hills further in.
    let h = 1.55 * smooth(0.0, 0.1, c); // continuous with the seabed at the waterline (c = 0)
    h += inland * (1.8 + 1.8 * nDetail.fbm3(d.x * 5.5, d.y * 5.5, d.z * 5.5, 3));
    h += inland * 6 * smooth(0.25, 0.7, c) * (0.5 + 0.5 * nDetail.simplex3(d.x * 2.3, d.y * 2.3, d.z * 2.3));
    const m = mountainAt(d);
    if (m > 0.001) {
      const r = nMountain.ridged3(d.x * 4.2, d.y * 4.2, d.z * 4.2, 5);
      h += m * inland * (6 + 20 * r);
    }
    return Math.min(PEAK, h);
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

  function heightAt(d: Vec3): number {
    const w = plateauWeight(d);
    if (w >= 1) return PLATEAU_HEIGHT;
    const n = natural(d);
    return w <= 0 ? n : n + (PLATEAU_HEIGHT - n) * w;
  }

  function moistureAt(d: Vec3): number {
    return 0.5 + 0.5 * nMoist.fbm3(d.x * 2.6, d.y * 2.6, d.z * 2.6, 3);
  }

  function biomeAt(d: Vec3, hIn?: number): BiomeId {
    const h = hIn ?? heightAt(d);
    if (h < -3.5) return Biome.DeepOcean;
    if (h < 0) return Biome.Shallows;
    if (plateauWeight(d) >= 1) return Biome.City;
    if (h < 1.1 && plateauWeight(d) < 0.5) return Biome.Beach;
    const m = mountainAt(d);
    const jitter = 1.6 * nDetail.simplex3(d.x * 23, d.y * 23, d.z * 23);
    if (h + jitter > 18.5) return Biome.Snow;
    if (m > 0.35 && h > 8) return Biome.Rock;
    const moist = moistureAt(d);
    if (moist > 0.58 && h > 2.2) return Biome.Forest;
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

  return {
    seed,
    cityDir,
    heightAt,
    surfaceAt: (d) => Math.max(0, heightAt(d)),
    plateauWeight,
    moistureAt,
    mountainAt,
    biomeAt,
    normalAt,
  };
}
