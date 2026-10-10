// What the review tooling (core/debug.ts, core/shots.ts, camera/dive.ts, world/city/views.ts) uses
// from the engine's modules, handed over at runtime instead of imported.
//
// Why: those modules live in the debug chunk (loaded only with ?shot=1 or in dev). Any engine
// module they imported would be shared between the two chunks, and Turbopack then pulls it out of
// the engine's scope-hoisted chunk into a separate one: no constant inlining, no name mangling
// across it, ~4-5 KB gzip more on the production path. So the debug side imports only types and
// core/debug-kit.ts; the engine fills it with this object before loading core/debug.ts.
// Everything here is already used by the engine (nothing is pulled in just for the tools).

import { buildingDistance, clearanceAt, coneBlocked, LandingFinder } from '../camera/landing';
import { pitchForAlt } from '../camera/model';
import { cloudsShotView } from '../clouds/dive-anchors';
import { ALT_MAX, CITY_LAT, CITY_LON, CITY_PLAN_RADIUS, CITY_SURFACE_R, CURB_H, EYE_HEIGHT, PLATEAU_HEIGHT, ROAD_H } from '../world/config';
import { planFrame, planHeadingToWorld, planToDir } from '../world/city/frame';
import { obbDistance } from '../world/city/index-grid';
import { sampleAt } from '../world/city/path';
import { setShotViewSolver } from '../world/city/shot-views';
import { getPlanet } from '../world/planet';
import { latLonFromDir, v3 } from '../world/sphere';
import { eveningTimeAt, sunDirection, timeAtHourAngle } from '../world/sun';

export const KIT = {
  ALT_MAX,
  CITY_LAT,
  CITY_LON,
  CITY_PLAN_RADIUS,
  CITY_SURFACE_R,
  CURB_H,
  EYE_HEIGHT,
  PLATEAU_HEIGHT,
  ROAD_H,
  buildingDistance,
  clearanceAt,
  coneBlocked,
  LandingFinder,
  pitchForAlt,
  cloudsShotView,
  planFrame,
  planHeadingToWorld,
  planToDir,
  obbDistance,
  sampleAt,
  setShotViewSolver,
  getPlanet,
  latLonFromDir,
  v3,
  eveningTimeAt,
  sunDirection,
  timeAtHourAngle,
};

export type Kit = typeof KIT;
