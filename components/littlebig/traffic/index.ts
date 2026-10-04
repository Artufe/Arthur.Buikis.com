// Traffic system: placeholder registered by the orchestrator so parallel agents never edit
// core/systems.ts at the same time. B1 owns this directory and replaces this file.

import type { System } from '../core/contracts';

export function createTrafficSystem(): System {
  return {
    name: 'traffic',
    stage: 2,
    init() {},
  };
}
