// heightAt sampled at every vertex of an icosphere, cached per (planet, detail): the terrain and
// ocean (and anything else built on the same sphere) share one pass over the noise.

import { icosphere } from './icosphere';
import type { Planet } from './planet';
import { v3 } from './sphere';

const cache = new WeakMap<Planet, Map<number, Float32Array>>();

export function icoHeights(planet: Planet, detail: number): Float32Array {
  let byDetail = cache.get(planet);
  if (!byDetail) cache.set(planet, (byDetail = new Map()));
  const hit = byDetail.get(detail);
  if (hit) return hit;
  const ico = icosphere(detail);
  const P = ico.positions;
  const out = new Float32Array(ico.vertexCount);
  const d = v3();
  for (let i = 0; i < ico.vertexCount; i++) {
    d.x = P[i * 3];
    d.y = P[i * 3 + 1];
    d.z = P[i * 3 + 2];
    out[i] = planet.heightAt(d);
  }
  byDetail.set(detail, out);
  return out;
}
