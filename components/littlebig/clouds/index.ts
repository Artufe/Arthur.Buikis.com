// Clouds system: placeholder registered by the orchestrator so parallel agents never edit
// core/systems.ts at the same time. A3 owns this directory and replaces this file.

import type { System } from '../core/contracts';

export function createCloudsSystem(): System {
  return {
    name: 'clouds',
    stage: 2,
    init() {},
  };
}
