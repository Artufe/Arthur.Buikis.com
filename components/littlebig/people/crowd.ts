// People (L1, v2): who is out. The crowd's looks, traits, idlers and dog walkers for n walkers,
// deterministic in the seed — shared by the system (people/index.ts) and the specs, so a spec rides
// exactly the walkers the game draws (same dogs, same kids, same people on the benches).

import type { CityIndex, CityPlan } from '../world/city/types';
import { Rng } from '../world/rng';
import { makeIdlers } from './idlers';
import { LookFlag, makeLooks, makeTraits, Pose, type Idler, type Look, type WalkerTraits } from './sim';

/** Share of grown-ups with a free left hand who walk a dog. */
const DOG_SHARE = 0.11;

export interface Crowd {
  /** Walkers first (0…n−1), then idlers (their `id`). */
  looks: Look[];
  traits: WalkerTraits[];
  idlers: Idler[];
  /** Dog walkers (walker indices), one dog each. */
  own: number[];
}

export function makeCrowd(plan: CityPlan, index: CityIndex, seed: number, nW: number): Crowd {
  const idlers = makeIdlers(plan, index, seed, nW);
  const looks = makeLooks(seed, nW + idlers.length);
  for (const p of idlers) {
    const l = looks[p.id];
    l.pose = p.pose;
    l.flags &= ~(LookFlag.Umbrella | LookFlag.Phone | (p.pose === Pose.Stand ? 0 : LookFlag.Backpack | LookFlag.Bag));
    if (p.pose === Pose.Lean) {
      // the one leaning over the fountain rim is a kid
      l.flags = (l.flags & ~LookFlag.Dress) | LookFlag.Kid | LookFlag.Shorts;
      l.scale = 0.66;
    }
  }
  // dog walkers: grown-ups with a free left hand
  const rng = Rng.for(seed, 'people-dogs');
  const own: number[] = [];
  for (let i = 0; i < nW; i++) {
    const l = looks[i];
    if (!(l.flags & (LookFlag.Kid | LookFlag.Bag)) && rng.float() < DOG_SHARE) {
      l.flags |= LookFlag.Leash;
      own.push(i);
    }
  }
  return { looks, traits: makeTraits(seed, looks, nW), idlers, own };
}
