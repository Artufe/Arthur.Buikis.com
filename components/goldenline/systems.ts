// System registry and update order. Orchestrator-owned.
// Writers (player, surf, breaking waves) run before `state`, which flushes their splats;
// `post` renders last (the core calls services.post.render after every update).

import type { GLSystem } from './core/contracts';
import { createAtmosphereSystem } from './atmosphere';
import { createBeachSystem } from './beach';
import { createOceanSystem } from './ocean';
import { createPierSystem } from './pier';
import { createPlayerSystem } from './player';
import { createPostSystem } from './post';
import { createStateSystem } from './state';
import { createSurfSystem } from './surf';
import { createVfxSystem } from './vfx';
import { createWaterSystem } from './water';

export function createSystems(): GLSystem[] {
  return [
    createAtmosphereSystem(),
    createOceanSystem(),
    createWaterSystem(),
    createPlayerSystem(),
    createSurfSystem(),
    createStateSystem(),
    createBeachSystem(),
    createPierSystem(),
    createVfxSystem(),
    createPostSystem(),
  ];
}
