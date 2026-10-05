// The canonical region: the world outside the capital's plateau (R1). Built once per planet from
// its base terrain (world/region/build.ts) on the planet's first heightAt(); read it through
// ctx.world.region rather than calling this. Read-only: shared by every engine instance (in
// development it is deep-frozen, so a mutation throws).

import { SEED } from '../config';
import { getPlanet } from '../planet';
import type { Region } from './types';

let frozen: Region | null = null;

export function getRegion(seed: number = SEED): Region {
  const r = getPlanet(seed).region;
  if (process.env.NODE_ENV !== 'production' && seed === SEED && frozen !== r) {
    deepFreeze(r);
    frozen = r;
  }
  return r;
}

function deepFreeze(o: unknown): void {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return;
  if (ArrayBuffer.isView(o)) return;
  Object.freeze(o);
  for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
}

export * from './types';
export { wsample, wsampleOut, wnearest, wpos, W_STEP, type WSample } from './path';
