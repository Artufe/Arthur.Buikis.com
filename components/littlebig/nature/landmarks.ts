// Where the countryside landmarks stand (A1): a row of windmills on the highest meadow ridge behind
// the city, and a lighthouse on the headland that sticks furthest out into the sea near it. Pure TS,
// deterministic (picked from the terrain itself, so they follow any retune of world/planet.ts).

import { PLATEAU_BLEND, PLATEAU_RADIUS, R } from '../world/config';
import { Biome, type Planet } from '../world/planet';
import { v3, type Vec3 } from '../world/sphere';
import { sunDirection } from '../world/sun';
import type { TerrainData } from '../terrain/data';

export interface Landmark {
  kind: 'windmill' | 'lighthouse';
  /** Unit direction of its base and the terrain height there (m above sea level). */
  dir: Vec3;
  h: number;
  /** Yaw about the local up (rad): windmills face their sails toward the city. */
  yaw: number;
}

const angle = (a: Vec3, x: number, y: number, z: number) => Math.acos(Math.max(-1, Math.min(1, a.x * x + a.y * y + a.z * z)));

export function findLandmarks(planet: Planet, t: TerrainData): Landmark[] {
  const out: Landmark[] = [];
  const city = planet.cityDir;
  const P = t.ico.positions;
  const H = t.heights;
  const n = t.ico.vertexCount;
  const inner = PLATEAU_RADIUS + PLATEAU_BLEND + 0.04;

  // ── Windmills: the highest gentle meadow tops 6-50 m past the blend ring (off the range), ≥ 11 m
  //    apart, in a row within ~50 m of the first. ──
  const cand: number[] = [];
  const d0 = v3();
  for (let i = 0; i < n; i++) {
    const b = t.biome[i];
    if (b !== Biome.Grass && b !== Biome.Meadow) continue;
    if (H[i] < 2.2 || t.slope[i] > 0.06 || t.plateau[i] > 0) continue;
    const a = angle(city, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    if (a < inner || a > inner + 0.3) continue;
    d0.x = P[i * 3];
    d0.y = P[i * 3 + 1];
    d0.z = P[i * 3 + 2];
    if (planet.mountainAt(d0) > 0) continue; // meadow hills, not the range's foothills
    cand.push(i);
  }
  // Highest first, with a bonus for standing in the afternoon sun at t = 0 (what a visitor sees).
  const sun0 = sunDirection(0);
  const score = (i: number) => H[i] + 8 * (P[i * 3] * sun0.x + P[i * 3 + 1] * sun0.y + P[i * 3 + 2] * sun0.z);
  cand.sort((p, q) => score(q) - score(p) || p - q);
  const picked: number[] = [];
  for (const i of cand) {
    if (picked.length >= 3) break;
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    let ok = true;
    for (const j of picked) {
      const d = Math.acos(Math.min(1, x * P[j * 3] + y * P[j * 3 + 1] + z * P[j * 3 + 2])) * R;
      if (d < 11 || (picked.length && j === picked[0] && d > 50)) ok = false;
    }
    if (ok) picked.push(i);
  }
  for (const i of picked) {
    const dir = v3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    out.push({ kind: 'windmill', dir, h: H[i], yaw: yawToward(dir, city) });
  }

  // ── Lighthouse: a coastal spot (beach or grass, 0.5-3 m up) near the city with the most sea
  //    around it (8 directions at 12 m). ──
  let best = -1;
  let bestScore = 0;
  const d = v3();
  for (let i = 0; i < n; i += 3) {
    const h = H[i];
    if (h < 0.6 || h > 3 || t.slope[i] > 0.1 || t.plateau[i] > 0) continue;
    const b = t.biome[i];
    if (b !== Biome.Beach && b !== Biome.Grass && b !== Biome.Meadow) continue;
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const a = angle(city, x, y, z);
    if (a < PLATEAU_RADIUS + 0.1 || a > 1.15) continue;
    // Tangent frame at the vertex.
    let ex = z, ez = -x;
    const el = Math.hypot(ex, ez) || 1;
    ex /= el;
    ez /= el;
    const nx = y * ez, ny = z * ex - x * ez, nz = -y * ex;
    let water = 0;
    for (let k = 0; k < 8; k++) {
      const c = Math.cos((k / 8) * Math.PI * 2) * (12 / R);
      const s = Math.sin((k / 8) * Math.PI * 2) * (12 / R);
      d.x = x + ex * c + nx * s;
      d.y = y + ny * s;
      d.z = z + ez * c + nz * s;
      const l = Math.hypot(d.x, d.y, d.z);
      d.x /= l;
      d.y /= l;
      d.z /= l;
      if (planet.heightAt(d) < -0.3) water++;
    }
    // Prefer more sea around, then closer to the city.
    const score = water - a * 0.5;
    if (water >= 4 && score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best >= 0) {
    const dir = v3(P[best * 3], P[best * 3 + 1], P[best * 3 + 2]);
    out.push({ kind: 'lighthouse', dir, h: H[best], yaw: yawToward(dir, city) });
  }
  return out;
}

/**
 * composeUp yaw that turns an instance's local +Z (its front: forward = right × up) toward
 * `target`. With right = east·cos + north·sin, forward = east·sin − north·cos.
 */
function yawToward(up: Vec3, target: Vec3): number {
  let ex = up.z, ez = -up.x;
  const el = Math.hypot(ex, ez) || 1;
  ex /= el;
  ez /= el;
  const nx = up.y * ez, ny = up.z * ex - up.x * ez, nz = -up.y * ex;
  const tx = target.x - up.x, ty = target.y - up.y, tz = target.z - up.z;
  const te = tx * ex + tz * ez;
  const tn = tx * nx + ty * ny + tz * nz;
  return Math.atan2(te, -tn);
}
