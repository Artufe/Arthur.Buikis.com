// The space layer (v2, S1): the station and the satellites. Stub slot, replaced by S1.

import type { System } from '../core/contracts';

export function createSpaceSystem(): System {
  return { name: 'space', stage: 2, init() {} };
}
