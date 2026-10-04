// Air system: placeholder registered by the orchestrator so parallel agents never edit
// core/systems.ts at the same time. B3 owns this directory and replaces this file.

import type { System } from '../core/contracts';

export function createAirSystem(): System {
  return {
    name: 'air',
    stage: 2,
    init() {},
  };
}
