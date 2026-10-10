// The day cycle as pure math. The planet does not spin in the scene; the sun circles it instead
// (westward, one lap per DAY_LENGTH). At t = 0 the city sees late-afternoon sun
// (hour angle START_HOUR_ANGLE). A3 owns the look of the cycle and may retune the constants.

import { CITY_LAT, CITY_LON, DAY_LENGTH, START_HOUR_ANGLE, SUN_DECLINATION } from './config';
import { dirFromLatLon, dot3, v3, type Vec3 } from './sphere';

/** Unit vector toward the sun at sim time t (s). */
export function sunDirection(t: number, out: Vec3 = v3()): Vec3 {
  const lon = CITY_LON - START_HOUR_ANGLE - (360 * t) / DAY_LENGTH;
  return dirFromLatLon(SUN_DECLINATION, lon, out);
}

/**
 * The moon (a cartoon one, A3): it trails the sun by MOON_LAG degrees of longitude on the far side
 * of the sky and sits a little south of the sun's path, so it rides high over the city at night and
 * shows a fat gibbous phase. It moves with the sun (no separate month): the same sky every night.
 */
export const MOON_LAG = 158;
export const MOON_DECLINATION = -8;
export function moonDirection(t: number, out: Vec3 = v3()): Vec3 {
  const lon = CITY_LON - START_HOUR_ANGLE - (360 * t) / DAY_LENGTH + MOON_LAG;
  return dirFromLatLon(MOON_DECLINATION, lon, out);
}

/** Sim time in [0, DAY_LENGTH) at which the sun's hour angle at the city is `hourAngleDeg`
 *  (0 = local noon, 90 ≈ sunset, 180 = midnight, -90 ≈ sunrise). */
export function timeAtHourAngle(hourAngleDeg: number, lonDeg: number = CITY_LON): number {
  // hour angle at lon = lon − sunLon(t) = lon − CITY_LON + START_HOUR_ANGLE + 360 t / DAY
  const t = ((hourAngleDeg - (lonDeg - CITY_LON) - START_HOUR_ANGLE) / 360) * DAY_LENGTH;
  return ((t % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH;
}

/** Sun elevation (deg) above the horizon of a point at unit `dir`. */
export function sunElevation(dir: Vec3, sunDir: Vec3): number {
  return (Math.asin(Math.max(-1, Math.min(1, dot3(dir, sunDir)))) * 180) / Math.PI;
}

/**
 * How "night" it is at unit `dir` (0 day … 1 night). The GLSL twin is lbNight() in render/toon.ts;
 * keep them identical. Dusk spans sun elevations of about +7° to −10°.
 */
export function nightFactor(dir: Vec3, sunDir: Vec3): number {
  const x = Math.min(1, Math.max(0, (dot3(dir, sunDir) - 0.12) / (-0.18 - 0.12)));
  return x * x * (3 - 2 * x);
}

const _city = dirFromLatLon(CITY_LAT, CITY_LON);
/** Evening sim time at which the sun stands `deg` above the local horizontal at lat/lon. */
export function eveningTimeAt(latDeg: number, lonDeg: number, deg: number): number {
  return timeAtHourAngle(hourAngleForElevation(deg, latDeg), lonDeg);
}

/** Hour angle at which the sun sits at elevation `deg` (afternoon/evening side) at a latitude. */
export function hourAngleForElevation(deg: number, latDeg: number): number {
  const lat = (latDeg * Math.PI) / 180;
  const dec = (SUN_DECLINATION * Math.PI) / 180;
  const c = (Math.sin((deg * Math.PI) / 180) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Hour angle for an elevation over the city centre. */
export function hourAngleForCityElevation(deg: number): number {
  return hourAngleForElevation(deg, CITY_LAT);
}
export const CITY_DIR: Readonly<Vec3> = _city;
