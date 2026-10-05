// The time button's maths (pure): where the sun stands over the place you are looking at, and the
// sim time of the next evening or morning there. Mirrors world/sun.ts with theme.ts's constants
// (sun-time.spec.ts checks it against the real thing).

import { WORLD } from './theme';

const DEG = Math.PI / 180;

/** Local hour angle of the sun (deg, (−180, 180]; 0 = noon, + = afternoon) at longitude `lonDeg`, sim time t. */
export function hourAngle(t: number, lonDeg: number): number {
  const h = lonDeg - WORLD.CITY_LON + WORLD.START_HOUR_ANGLE + (360 * t) / WORLD.DAY_LENGTH;
  const m = (((h + 180) % 360) + 360) % 360;
  return m - 180;
}

/** Sun elevation (deg) above the local horizontal at lat/lon, sim time t. */
export function sunElevation(t: number, latDeg: number, lonDeg: number): number {
  const lat = latDeg * DEG;
  const dec = WORLD.SUN_DECLINATION * DEG;
  const s = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle(t, lonDeg) * DEG);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

/** |hour angle| (deg) at which the sun stands at elevation `deg` at a latitude (clamped at the poles). */
export function hourAngleForElevation(deg: number, latDeg: number): number {
  const lat = latDeg * DEG;
  const dec = WORLD.SUN_DECLINATION * DEG;
  const c = (Math.sin(deg * DEG) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** The first sim time after t (by at least `minAhead` s) at which the hour angle at lonDeg is `h`. */
export function nextTimeAtHourAngle(t: number, h: number, lonDeg: number, minAhead = 1): number {
  const day = WORLD.DAY_LENGTH;
  const d = (((h - hourAngle(t, lonDeg)) % 360) + 360) % 360;
  let ahead = (d / 360) * day;
  if (ahead < minAhead) ahead += day;
  return t + ahead;
}

/** Sun elevations the button aims for: dusk with the lights on, and a fresh morning. */
export const EVENING_ELEVATION = -5;
export const MORNING_ELEVATION = 9;

export interface TimeTarget {
  /** Where the button takes you: 'evening' while the sun is up there, else 'morning'. */
  to: 'evening' | 'morning';
  /** Sim time of it (> t). */
  t: number;
}

/** The next evening (sun up now) or morning (sun down now) over lat/lon. */
export function nextTimeTarget(t: number, latDeg: number, lonDeg: number): TimeTarget {
  const day = sunElevation(t, latDeg, lonDeg) > 0;
  const h = day ? hourAngleForElevation(EVENING_ELEVATION, latDeg) : -hourAngleForElevation(MORNING_ELEVATION, latDeg);
  return { to: day ? 'evening' : 'morning', t: nextTimeAtHourAngle(t, h, lonDeg, 2) };
}

/**
 * The warp's speed this frame (sim seconds per real second): eases in over `rampIn` s of real time,
 * eases out as the target nears (so the light settles instead of stopping dead), never below 1×.
 */
export function warpRate(elapsedReal: number, remainingSim: number, maxRate: number, rampIn = 0.7): number {
  const a = Math.min(1, Math.max(0, elapsedReal / rampIn));
  const easeIn = a * a * (3 - 2 * a);
  const cruise = 1 + (maxRate - 1) * easeIn;
  // Decelerate: at most 1 + 1.6 × remaining (8× is reached ~4.4 sim-s before the target).
  const brake = 1 + 1.6 * Math.max(0, remainingSim);
  return Math.max(1, Math.min(cruise, brake));
}
