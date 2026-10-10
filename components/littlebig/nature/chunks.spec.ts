import { describe, expect, it } from 'vitest';
import { getCityIndex, getCityPlan } from '../world/city';
import { R } from '../world/config';
import { getPlanet } from '../world/planet';
import { terrainData } from '../terrain/data';
import { chunkAboveHorizon, chunkBounds, ChunkedKind, chunkOfFace, CHUNKS } from './chunks';
import { createNatureCollider } from './collide';
import { scatterNature } from './scatter';

describe('nature chunks and collision', () => {
  const planet = getPlanet();
  const terrain = terrainData(planet, 6);
  const s = scatterNature({ terrain, city: getCityPlan(), cityIndex: getCityIndex(), cityDir: planet.cityDir });
  const chunk = new Int32Array(s.count);
  for (let i = 0; i < s.count; i++) chunk[i] = chunkOfFace(s.face[i], 6);
  const b = chunkBounds(s.pos, chunk, s.h, s.count, R);

  it('keeps every instance inside its chunk cap (culling never drops a visible tree)', () => {
    for (let i = 0; i < s.count; i += 7) {
      const c = chunk[i];
      const x = s.pos[i * 3], y = s.pos[i * 3 + 1], z = s.pos[i * 3 + 2];
      const l = Math.hypot(x, y, z);
      const ang = Math.acos(Math.min(1, (x * b.dir[c * 3] + y * b.dir[c * 3 + 1] + z * b.dir[c * 3 + 2]) / l));
      expect(ang).toBeLessThanOrEqual(b.rad[c] + 1e-5);
      // ...and inside its frustum-test sphere.
      const d = Math.hypot(x - b.sphere[c * 4], y - b.sphere[c * 4 + 1], z - b.sphere[c * 4 + 2]);
      expect(d).toBeLessThanOrEqual(b.sphere[c * 4 + 3]);
    }
  });

  it('drops the far side of the planet at street level but keeps it all from orbit', () => {
    const c = planet.cityDir;
    const street = R + 3.7;
    const orbit = R + 400;
    let near = 0;
    let far = 0;
    for (let k = 0; k < CHUNKS; k++) {
      if (!b.used[k]) continue;
      if (chunkAboveHorizon(b, k, c.x, c.y, c.z, Math.acos(R / street), 0)) near++;
      if (chunkAboveHorizon(b, k, -c.x, -c.y, -c.z, Math.acos(R / orbit), 0)) far++;
    }
    expect(near).toBeLessThan(CHUNKS * 0.45);
    // The city chunk is always visible from the city.
    expect(chunkAboveHorizon(b, 80, c.x, c.y, c.z, Math.acos(R / street), 0)).toBe(true);
    expect(far).toBeGreaterThan(0);
  });

  it('compacts exactly the visible chunks’ instances, in order', () => {
    const ids = new Int32Array([3, 1, 3, 0, 1, 3]);
    const k = new ChunkedKind(ids, ids.length);
    const master = new Float32Array(k.order.length);
    for (let j = 0; j < k.order.length; j++) master[j] = k.order[j];
    const vis = new Uint8Array(CHUNKS);
    vis[1] = vis[3] = 1;
    const live = new Float32Array(6);
    expect(k.compact(vis, master, live, 1)).toBe(5);
    expect(Array.from(live.subarray(0, 5))).toEqual([1, 4, 0, 2, 5]);
  });

  it('pushes a walker out of a trunk disc', () => {
    const dirs = new Float32Array([0, 0, 1]);
    const col = createNatureCollider(dirs, new Float32Array([0.4]), 1, 162);
    const p = { x: 0.1 / 162, y: 0, z: 1 };
    const out = { x: 0, y: 0, z: 0 };
    expect(col.collide(p, 0.3, out)).toBe(true);
    expect(Math.hypot(out.x, out.y) * 162).toBeGreaterThan(0.69);
    expect(col.collide({ x: 5 / 162, y: 0, z: 1 }, 0.3, out)).toBe(false);
  });
});
