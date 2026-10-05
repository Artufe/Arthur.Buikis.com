// The named review shots (BRIEF §9 / TASKS F0) and the scripted orbit → street dive. Shots that
// stand in the city read the plan's viewpoints, so they follow A2's plan automatically.
// Add your own shots here (additive): name → { view, t }.

import { buildDivePath, DIVE_SECONDS, divePoseAt, type DivePath, type DivePose } from '../camera/dive';
import type { Viewpoint } from '../world/city/types';
import { registerShotViews } from '../world/city/views';
import type { LBContext, ViewSpec } from './contracts';
import { K } from './debug-kit';

// Review tooling (the debug chunk): engine modules come through the kit, not imports (core/kit.ts).
const { CITY_LAT, CITY_LON, CITY_SURFACE_R, CURB_H, EYE_HEIGHT, ROAD_H, planHeadingToWorld, planToDir, latLonFromDir, eveningTimeAt, timeAtHourAngle, cloudsShotView } = K;

// The plan's rooftops / horizon / dusk viewpoints are solved by views.ts, loaded only with the shots.
registerShotViews();

export interface ShotDef {
  /** What the shot is for (printed by --list). */
  about: string;
  view(ctx: LBContext): ViewSpec;
  /** Sim time (s), or a function of the resolved view. Default 0: late afternoon over the city. */
  t?: number | ((view: ViewSpec) => number);
}

const DEG = 180 / Math.PI;
/** Horizon dip (deg) for the eye on a sidewalk. */
const DUSK_DIP = Math.acos((CITY_SURFACE_R + ROAD_H + CURB_H) / (CITY_SURFACE_R + ROAD_H + CURB_H + EYE_HEIGHT)) * DEG;

/** A ViewSpec standing at a plan viewpoint. */
export function viewAt(vp: Viewpoint, alt: number, pitch?: number): ViewSpec {
  const ll = latLonFromDir(planToDir(vp.x, vp.z));
  const v: ViewSpec = { lat: ll.lat, lon: ll.lon, alt, heading: planHeadingToWorld(vp.x, vp.z, vp.heading) * DEG };
  if (pitch !== undefined) v.pitch = pitch;
  return v;
}

/**
 * Sim time (s) the /play clip starts at: it is rendered with `--dive 301 --t DIVE_T0`, so its last
 * frame (the poster and loop point, at DIVE_T0 + DIVE_SECONDS) is the `landing` shot's light and life.
 * Picked by `scripts/play-media/littlebig-scan.mjs` over T0 ∈ [0, 14] (loop point and final second
 * with no walker or vehicle near the lens, nobody walking at it, people + cars in view), then by eye;
 * recipe in `docs/play-media.md`. The sims are chaotic (±0.25 s changes the frame), so re-scan
 * whenever traffic or people change.
 */
export const DIVE_T0 = 11;

/**
 * The `street` shot stands on A2's viewpoint stepped 0.9 m toward the building side and turned 6°
 * toward it: on the viewpoint itself a lamp pole 8 m ahead split the frame against the clock tower.
 * Kept only if the stepped spot is still clear pavement.
 */
function streetView(ctx: LBContext): ViewSpec {
  const vp = ctx.world.city.viewpoints.street;
  const x = vp.x + Math.cos(vp.heading) * 0.9;
  const z = vp.z + Math.sin(vp.heading) * 0.9;
  const ok = ctx.world.cityIndex.classify(x, z) === 'sidewalk' && !ctx.world.cityIndex.collide(x, z, 0.4, { x: 0, z: 0 });
  return viewAt(ok ? { ...vp, x, z, heading: vp.heading + (6 * Math.PI) / 180 } : vp, EYE_HEIGHT);
}

/** Plan point (x, z) as lat/lon. */
function planLL(x: number, z: number) {
  return latLonFromDir(planToDir(x, z));
}

export const SHOTS: Record<string, ShotDef> = {
  orbit: { about: 'whole planet from 380 m, city in view, the dusk terminator on the right', view: () => ({ lat: CITY_LAT - 6, lon: CITY_LON + 26, alt: 380, heading: 0 }) },
  city: { about: 'top-down over the city from 120 m', view: () => ({ lat: CITY_LAT, lon: CITY_LON, alt: 120, heading: 0 }) },
  // (The clouds frame this view with two anchored clusters: clouds/dive-anchors.ts.)
  clouds: { about: 'in the cloud layer (44 m), looking across it at the city (pitch −35°: the layer, not a top-down)', view: cloudsShotView },
  // Pitched up to −24° (the curve's −35° puts everything above the 16 m eye out of frame): from the
  // viewpoint's 58–70 m the plateau's curve drops the whole clock tower into view (A2).
  rooftops: { about: 'rooftop height (16 m), in over downtown at the clock tower', view: (ctx) => viewAt(ctx.world.city.viewpoints.rooftops, 16, -24) },
  street: { about: "FPV on a city sidewalk (A2's viewpoint, stepped off a lamp pole's line)", view: streetView },
  horizon: { about: '6 m up at the plateau edge, looking along the curve', view: (ctx) => viewAt(ctx.world.city.viewpoints.horizon, 6) },
  night: {
    about: 'orbit over the city at local midnight (the constellation)',
    view: () => ({ lat: CITY_LAT - 4, lon: CITY_LON + 6, alt: 380, heading: 0 }),
    t: timeAtHourAngle(180),
  },
  approach: {
    about: 'the dive at ~12 m, gliding in down the street toward the landing (A4)',
    view: (ctx) => diveAt(ctx, 0.7),
    t: DIVE_T0 + 0.7 * DIVE_SECONDS,
  },
  landing: {
    about: "the dive's last frame: its own landing on a sunlit downtown corner (A4; the /play loop point, at the clip's end time)",
    view: (ctx) => diveAt(ctx, 1),
    t: DIVE_T0 + DIVE_SECONDS,
  },
  cloudscape: {
    about: 'across the cloud layer from its top (46 m), toward the clouds-shot anchors: crowns, bellies, rims (A3)',
    view: () => {
      const ll = planLL(-8, 100);
      return { lat: ll.lat, lon: ll.lon, alt: 46, heading: 0, pitch: -12 };
    },
  },
  dusk: {
    about: 'street at sunset, looking west: the sun disc touching the horizon',
    view: (ctx) => viewAt(ctx.world.city.viewpoints.dusk, EYE_HEIGHT),
    // The planet is tiny: local sun elevation changes ~1° per 2.8 m, so time it at the viewpoint,
    // and the visible horizon dips ~8° at eye height: the disc meets it at about −(dip − 1°).
    t: (v) => eveningTimeAt(v.lat, v.lon, -(DUSK_DIP - 1)),
  },
};

const divePaths = new WeakMap<object, DivePath>();
const _pose: DivePose = { x: 0, z: 0, alt: 0, heading: 0, pitch: 0, togo: 0 };

/** The dive's ground track for this world's plan (built once per plan). */
export function divePath(ctx: LBContext): DivePath {
  let p = divePaths.get(ctx.world.city);
  if (!p) {
    p = buildDivePath(ctx.world.city, ctx.world.cityIndex);
    divePaths.set(ctx.world.city, p);
  }
  return p;
}

/**
 * The scripted descent at u ∈ [0, 1] (camera/dive.ts): from orbit down through the cloud layer,
 * gliding in along a street to land at eye height on the dive's own landing (camera/landing.ts:
 * the best sunlit pavement spot with a long view down the street), facing down it.
 * Render it at DIVE_SECONDS × fps + 1 frames with glide = 1 / fps, the sim starting at DIVE_T0.
 */
export function diveAt(ctx: LBContext, u: number): ViewSpec {
  const p = divePoseAt(divePath(ctx), u, _pose);
  const ll = latLonFromDir(planToDir(p.x, p.z));
  return { lat: ll.lat, lon: ll.lon, alt: p.alt, heading: planHeadingToWorld(p.x, p.z, p.heading) * DEG, pitch: p.pitch * DEG };
}

export { DIVE_SECONDS };
