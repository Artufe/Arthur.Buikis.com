// Nature system: placeholder registered by the orchestrator so parallel agents never edit
// core/systems.ts at the same time. A1 owns this directory and replaces this file.

import type { System } from '../core/contracts';

export function createNatureSystem(): System {
  return {
    name: 'nature',
    stage: 2,
    init() {},
  };
}
