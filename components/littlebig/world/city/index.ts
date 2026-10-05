// The canonical city: one plan per page load, built lazily from the world seed, plus its spatial
// index. Systems read it through ctx.world.city / ctx.world.cityIndex rather than calling these.
//
// The plan is A2's (plan.ts: layout.ts → graph.ts → blocks.ts → buildings, areas, features).

import { SEED } from '../config';
import { getPlanet } from '../planet';
import { createCityIndex } from './index-grid';
import { buildCityPlan } from './plan';
import type { CityIndex, CityPlan } from './types';

let plan: CityPlan | null = null;
let index: CityIndex | null = null;

/** Read-only: shared by every engine instance. Deep-frozen in development so a mutation throws. */
export function getCityPlan(): CityPlan {
  if (!plan) {
    plan = buildCityPlan(SEED);
    if (process.env.NODE_ENV !== 'production') deepFreeze(plan);
  }
  return plan;
}

export function getCityIndex(): CityIndex {
  // No closure here (see CityIndexOptions.terrain): this module-level cache must not capture the
  // scope of whatever function the minifier inlines it into.
  if (!index) index = createCityIndex(getCityPlan(), { terrain: getPlanet(SEED) });
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
