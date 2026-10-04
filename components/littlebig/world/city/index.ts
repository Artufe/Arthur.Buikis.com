// The canonical city: one plan per page load, built lazily from the world seed, plus its spatial
// index. Systems read it through ctx.world.city / ctx.world.cityIndex rather than calling these.
//
// A2: swap buildStubPlan for the real plan builder here (keep the CityPlan contract in types.ts).

import { PLATEAU_HEIGHT, SEED } from '../config';
import { getPlanet } from '../planet';
import { planToDir } from './frame';
import { createCityIndex } from './index-grid';
import { buildStubPlan } from './stub';
import type { CityIndex, CityPlan } from './types';

let plan: CityPlan | null = null;
let index: CityIndex | null = null;

/** Read-only: shared by every engine instance. Deep-frozen in development so a mutation throws. */
export function getCityPlan(): CityPlan {
  if (!plan) {
    plan = buildStubPlan(SEED);
    if (process.env.NODE_ENV !== 'production') deepFreeze(plan);
  }
  return plan;
}

const _d = { x: 0, y: 0, z: 0 };
export function getCityIndex(): CityIndex {
  if (!index) {
    const planet = getPlanet(SEED);
    index = createCityIndex(getCityPlan(), { terrainH: (x, z) => planet.surfaceAt(planToDir(x, z, _d)) - PLATEAU_HEIGHT });
  }
  return index;
}

function deepFreeze(o: unknown): void {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return;
  // Typed arrays cannot be frozen (they are views on a buffer); their owners are.
  if (ArrayBuffer.isView(o)) return;
  Object.freeze(o);
  for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
}

export * from './types';
export { toSphere, fromSphere, planToDir, planFrame, planBasis, planHeadingToWorld, CITY_CHART } from './frame';
export { sampleAt, nearestOn } from './path';
