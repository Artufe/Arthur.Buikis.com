// City system: placeholder registered by the orchestrator so parallel agents never edit
// core/systems.ts at the same time. A2 owns this directory and replaces this file.

import type { System } from '../core/contracts';

export function createCitySystem(): System {
  return {
    name: 'city',
    stage: 2,
    init() {},
  };
}
