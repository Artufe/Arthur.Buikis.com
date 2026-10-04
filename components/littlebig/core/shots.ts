// The named review shots (BRIEF §9 / TASKS F0) and the scripted orbit → street dive. Shots that
// stand in the city read the plan's viewpoints, so they follow A2's plan automatically.
// Add your own shots here (additive): name → { view, t }.

import { CITY_LAT, CITY_LON, CITY_SURFACE_R, CURB_H, EYE_HEIGHT, ROAD_H } from '../world/config';
import { planHeadingToWorld, planToDir } from '../world/city/frame';
import type { Viewpoint } from '../world/city/types';
import { latLonFromDir } from '../world/sphere';
import { eveningTimeAt, timeAtHourAngle } from '../world/sun';
import type { LBContext, ViewSpec } from './contracts';

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

/** Plan point (x, z) as lat/lon. */
function planLL(x: number, z: number) {
  return latLonFromDir(planToDir(x, z));
}

export const SHOTS: Record<string, ShotDef> = {
  orbit: { about: 'whole planet from 380 m, city in view, the dusk terminator on the right', view: () => ({ lat: CITY_LAT - 6, lon: CITY_LON + 26, alt: 380, heading: 0 }) },
  city: { about: 'top-down over the city from 120 m', view: () => ({ lat: CITY_LAT, lon: CITY_LON, alt: 120, heading: 0 }) },
  clouds: {
    about: 'in the cloud layer (44 m), looking down at the city',
    view: () => {
      const ll = planLL(0, 70);
      return { lat: ll.lat, lon: ll.lon, alt: 44, heading: 0 };
    },
  },
  rooftops: { about: 'rooftop height (16 m) toward downtown', view: (ctx) => viewAt(ctx.world.city.viewpoints.rooftops, 16) },
  street: { about: 'FPV on a city sidewalk', view: (ctx) => viewAt(ctx.world.city.viewpoints.street, EYE_HEIGHT) },
  horizon: { about: '6 m up at the plateau edge, looking along the curve', view: (ctx) => viewAt(ctx.world.city.viewpoints.horizon, 6) },
  night: {
    about: 'orbit over the city at local midnight (the constellation)',
    view: () => ({ lat: CITY_LAT - 4, lon: CITY_LON + 6, alt: 380, heading: 0 }),
    t: timeAtHourAngle(180),
  },
  dusk: {
    about: 'street at sunset, looking west: the sun disc touching the horizon',
    view: (ctx) => viewAt(ctx.world.city.viewpoints.dusk, EYE_HEIGHT),
    // The planet is tiny: local sun elevation changes ~1° per 2.8 m, so time it at the viewpoint,
    // and the visible horizon dips ~8° at eye height: the disc meets it at about −(dip − 1°).
    t: (v) => eveningTimeAt(v.lat, v.lon, -(DUSK_DIP - 1)),
  },
};

/**
 * The scripted descent at u ∈ [0, 1]: from orbit (380 m, off to the south-east of the city) down
 * through the cloud layer and over the rooftops to the street viewpoint. Altitude falls in log
 * space; position leads altitude so the camera is over the city before it drops below the clouds.
 */
export function diveAt(ctx: LBContext, u: number): ViewSpec {
  u = Math.min(1, Math.max(0, u));
  const end = viewAt(ctx.world.city.viewpoints.street, EYE_HEIGHT);
  const start = { lat: CITY_LAT - 18, lon: CITY_LON + 22, heading: end.heading! - 40 };
  const e = (x: number) => x * x * (3 - 2 * x);
  const pu = 1 - Math.pow(1 - u, 2.2); // position leads
  const au = e(Math.min(1, u * 1.1)); // altitude eases in and out, landing a little before the end
  const lat = start.lat + (end.lat - start.lat) * pu;
  // Interpolate longitude the short way round.
  let dLon = end.lon - start.lon;
  dLon -= Math.round(dLon / 360) * 360;
  const lon = start.lon + dLon * pu;
  const alt = Math.exp(Math.log(380) + (Math.log(EYE_HEIGHT) - Math.log(380)) * au);
  let dH = end.heading! - start.heading;
  dH -= Math.round(dH / 360) * 360;
  const heading = start.heading + dH * e(Math.min(1, u * 1.3));
  return { lat, lon, alt, heading };
}
