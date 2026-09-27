// [polish] The boot bakes that run in workers (core/bakes.ts): pure functions of their numeric
// arguments whose results pack (bake-pack.ts). Main-thread fallback runs the same functions.

import { bakeAux, bakeDryRipples, bakeFarHeight, bakeGrain, bakeMacro, bakeSwash, bakeWaveRipples } from '../beach/bake';
import { buildLimb } from '../player/body/build';
import { buildArm, buildLeg } from '../player/body/models';
import { buildBoardGeometry, buildPadGeometry } from '../player/board/geometry';
import { bakeBeads, bakeNoise, bakeSkin, bakeWax } from '../player/tex';
import { SwellField } from '../ocean/swell';
import { bakeFoamTexture, bakeNoiseTexture } from '../water/textures';
import { bakeTerrainGrid, terrainHeight } from '../world/terrain-shape';

export const JOBS = {
  'terrain.grid': () => bakeTerrainGrid(),
  'player.arm': () => buildLimb(buildArm(1)).geometry,
  'player.leg': () => buildLimb(buildLeg(1)).geometry,
  'player.noise': () => bakeNoise(),
  'player.wax': () => bakeWax(),
  'player.beads': () => bakeBeads(),
  'player.skin': () => bakeSkin(),
  'player.board': () => buildBoardGeometry(),
  'player.pad': () => buildPadGeometry(),
  'water.foam': () => bakeFoamTexture(),
  'water.noise': () => bakeNoiseTexture(),
  'beach.swash': () => bakeSwash(),
  'beach.waveRipples': () => bakeWaveRipples(),
  'beach.dryRipples': () => bakeDryRipples(),
  'beach.grain': () => bakeGrain(),
  'beach.macro': () => bakeMacro(),
  'beach.far': () => bakeFarHeight(),
  'beach.aux': () => bakeAux(),
  'ocean.swell': (periodScale = 1, dirOffset = 0) => {
    const f = new SwellField();
    f.bake(terrainHeight, periodScale, dirOffset);
    return { data: f.data, omega: f.omega, dirX: f.dirX, dirZ: f.dirZ, cgEdge: f.cgEdge, kEdge: f.kEdge };
  },
} satisfies Record<string, (...args: number[]) => unknown>;

export type JobName = keyof typeof JOBS;
export type JobResult<N extends JobName> = ReturnType<(typeof JOBS)[N]>;

/** Prefetched at engine start, in the order the systems ask for them (ocean, water, player, beach). */
export const PREFETCH: Array<[JobName, number[]]> = [
  ['terrain.grid', []],
  ['ocean.swell', [1, 26]], // ocean.period, ocean.swellDir defaults (ocean/index.ts)
  ['water.foam', []],
  ['player.arm', []],
  ['player.leg', []],
  ['water.noise', []],
  ['player.skin', []],
  ['player.wax', []],
  ['player.beads', []],
  ['player.noise', []],
  ['player.board', []],
  ['player.pad', []],
  ['beach.swash', []],
  ['beach.waveRipples', []],
  ['beach.dryRipples', []],
  ['beach.grain', []],
  ['beach.macro', []],
  ['beach.far', []],
  ['beach.aux', []],
];
