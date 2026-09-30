// GOLDENLINE ambient life and atmosphere (B2): seabirds along the break (birds.ts), ghost crabs
// on the wet sand (crabs.ts), the salt-mist veil over the shore break and the impact zone
// (mist.ts). The shared spray pool lives in vfx/spray/ (A8) and is driven by the ocean system.
//
// Zero allocation per frame: the clock goes to the GPU through a 1-element uniform array (a
// number uniform's .value would box a new HeapNumber every frame), the crabs write a preallocated
// instance buffer.

import { uniformArray } from 'three/tsl';
import type { GLContext, GLSystem } from '../core/contracts';
import type { ToggleParam } from '../core/params';
import { createBirds, type Birds } from './birds';
import { createCrabs, type Crabs } from './crabs';
import { createMist, type Mist } from './mist';

export function createVfxSystem(): GLSystem {
  const timeValues = [0.5];
  const time = uniformArray(timeValues, 'float').element(0);
  let birds: Birds | null = null;
  let crabs: Crabs | null = null;
  let mist: Mist | null = null;
  let pBirds: ToggleParam | null = null;
  let pCrabs: ToggleParam | null = null;
  let pMist: ToggleParam | null = null;

  return {
    name: 'vfx',
    init(ctx: GLContext) {
      const p = ctx.params;
      pBirds = p.toggle('vfx.birds', { label: 'seabirds', group: 'vfx', value: true });
      pCrabs = p.toggle('vfx.crabs', { label: 'ghost crabs', group: 'vfx', value: true });
      pMist = p.toggle('vfx.mist', { label: 'salt mist over the break', group: 'vfx', value: true });
      const atmos = ctx.services.atmosphere;
      birds = createBirds(atmos, time);
      ctx.scene.add(birds.mesh);
      crabs = createCrabs(ctx, time);
      ctx.scene.add(crabs.mesh);
      mist = createMist(ctx, time);
      ctx.scene.add(mist.mesh);
    },
    update(ctx: GLContext) {
      timeValues[0] = ctx.time.t;
      if (birds && pBirds) birds.mesh.visible = pBirds.value;
      if (crabs && pCrabs) {
        crabs.mesh.visible = pCrabs.value;
        if (pCrabs.value) crabs.update(ctx);
      }
      if (mist && pMist) mist.mesh.visible = pMist.value;
    },
    dispose(ctx: GLContext) {
      for (const x of [birds, crabs, mist]) {
        if (!x) continue;
        ctx.scene.remove(x.mesh);
        x.dispose();
      }
      birds = crabs = mist = null;
    },
  };
}
