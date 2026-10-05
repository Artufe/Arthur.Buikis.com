// System registry and update order. Each agent registers its system here (one line), nothing
// else. Order matters:
//   - camera first: it writes ctx.view, which everyone else reads in update();
//   - sky before anything lit: it writes the sun / night / fill uniforms;
//   - stage-1 systems (first frame) are initialised before the first frame: the sky first (its
//     lights and fog key every lit program, so the shader warm-up starts at once), then list order;
//   - stage-2 systems are initialised after it, in list order, each revealing itself;
//   - traffic before people: traffic writes ctx.services.crossings.blocked, people .busy.
//
// A stage-2 system, in outline (see core/contracts.ts for every field):
//
//   export function createTreesSystem(): System {
//     let geo: BufferGeometry | null = null;
//     return {
//       name: 'nature',
//       stage: 2,
//       async init(ctx) {
//         geo = ctx.track(buildTreeGeometry());                 // origin at the trunk base
//         const mat = ctx.toon.material({ name: 'trees', vertexColors: true, reveal: 'instance' });
//         const mesh = ctx.toon.instanced(geo, mat, count);      // shadows wired for you
//         for (let i = 0; i < count; i++) { place(i); if (i % 500 === 0) await ctx.yield(); }
//         ctx.scene.add(mesh);
//         await ctx.compile();                                  // colour + shadow programs, no hitch
//         const start = ctx.reveal.slot(1.2);                   // when this system's reveal begins
//         geo.setAttribute('aReveal', new InstancedBufferAttribute(delays(start), 1));
//       },
//       // Reuse patch keys for identical patches: every new key is a new program to compile.
//       update(ctx) { /* LOD from ctx.view.altTerrain, animation from ctx.time.render; zero allocations */ },
//       dispose() { geo?.dispose(); },
//     };
//   }

import { createAirSystem } from '../air';
import { createCameraSystem } from '../camera';
import { createCitySystem } from '../city';
import { createCloudsSystem } from '../clouds';
import { createNatureSystem } from '../nature';
import { createOceanSystem } from '../ocean';
import { createPeopleSystem } from '../people';
import { createSkySystem } from '../sky';
import { createSpaceSystem } from '../space';
import { createTerrainSystem } from '../terrain';
import { createTrafficSystem } from '../traffic';
import type { System } from './contracts';

export function createSystems(): System[] {
  return [
    createCameraSystem(), // stage 1 (camera/)
    createSkySystem(), // stage 1 (sky/)
    createTerrainSystem(), // stage 1 (terrain/)
    createOceanSystem(), // stage 1 (ocean/)
    // stage 2, in reveal order. Every slot is pre-registered: agents replace their own index.ts.
    createCitySystem(), // stage 2 (city/, A2)
    createNatureSystem(), // stage 2 (nature/, A1)
    createCloudsSystem(), // stage 2 (clouds/, A3)
    createTrafficSystem(), // stage 2 (traffic/, B1)
    createPeopleSystem(), // stage 2 (people/, B2)
    createAirSystem(), // stage 2 (air/, B3)
    // v2 (docs/littlebig/V2.md). Pre-registered slots: agents replace their own index.ts.
    createSpaceSystem(), // stage 2 (space/, S1)
  ];
}
