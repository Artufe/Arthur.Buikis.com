// @vitest-environment node
import '../core/kit-fill'; // before the review tooling (camera/dive.ts reads core/kit.ts)
import { describe, expect, it } from 'vitest';
import { buildDivePath, divePoseAt, type DivePose } from '../camera/dive';
import { getCityIndex, getCityPlan } from '../world/city';
import { CURB_H, ROAD_H, SEED } from '../world/config';
import { makeIdlers } from './idlers';
import { LensWatch, makeLooks, makeTraits, PeopleSim } from './sim';

const WALKERS = 230;
const HALF_FOV = (42 * Math.PI) / 180; // horizontal half-angle of the 16:10 view

// The scripted dive comes down onto the pavement continuously, so no camera cut clears the lens:
// walkers must make way on their own (LensWatch + step's `lens`). Before, a walker coming up the
// pavement walked up to the landing and stood ~1.1 m in front of the lens (dive from t = 0).
describe('people and a camera settling onto the pavement', () => {
  it('nobody walks up to the lens: from the landing on, nobody in view comes within 2.2 m walking at it or standing', { timeout: 60000 }, () => {
    const plan = getCityPlan();
    const index = getCityIndex();
    const path = buildDivePath(plan, index);
    const idlers = makeIdlers(plan, index, SEED, WALKERS);
    const looks = makeLooks(SEED, WALKERS + idlers.length);
    const n = plan.walkEdges.length;
    const busy = new Uint8Array(n);
    const blocked = new Uint8Array(n);
    const pose: DivePose = { x: 0, z: 0, alt: 0, heading: 0, pitch: 0, togo: 0 };
    const sim = new PeopleSim(plan, index, SEED, makeTraits(SEED, looks, WALKERS), idlers, []);
    let worst = Infinity;
    for (const T0 of [0, 1.5, 3, 4.5, 10]) {
      sim.placeAt(T0, null, null);
      const lens = new LensWatch();
      let t = T0;
      // 30 fps frames, two 60 Hz steps each: the 10 s descent (from 20 m up), then a 3 s hold
      for (let i = 200; i <= 390; i++) {
        divePoseAt(path, Math.min(1, i / 300), pose);
        for (let k = 0; k < 2; k++, t += 1 / 60) {
          lens.update(1 / 60, pose.x, pose.z, pose.alt + ROAD_H + CURB_H, true); // altTerrain over pavement
          sim.step(1 / 60, t, busy, blocked, lens.x, lens.z, lens.on, lens.r, lens.lens);
        }
        if (i < 300) continue;
        const fx = Math.sin(pose.heading);
        const fz = -Math.cos(pose.heading);
        for (let j = 0; j < sim.n; j++) {
          if (!sim.on[j]) continue;
          const dx = sim.x[j] - pose.x;
          const dz = sim.z[j] - pose.z;
          const along = dx * fx + dz * fz;
          const side = Math.abs(dz * fx - dx * fz);
          // walking at the lens, or standing in front of it (someone walking away from a camera that
          // came down behind them is just leaving: the clip's start time is picked to avoid that)
          const at = sim.hx[j] * fx + sim.hz[j] * fz < 0.5;
          if (at && along > 0 && side < along * Math.tan(HALF_FOV) + 0.3) worst = Math.min(worst, Math.hypot(dx, dz));
        }
      }
    }
    expect(worst).toBeGreaterThan(2.2);
  });
});
