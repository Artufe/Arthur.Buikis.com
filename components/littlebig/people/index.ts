// People system: placeholder registered by the orchestrator so parallel agents never edit
// core/systems.ts at the same time. B2 owns this directory and replaces this file.

import type { System } from '../core/contracts';

export function createPeopleSystem(): System {
  return {
    name: 'people',
    stage: 2,
    init() {},
  };
}
