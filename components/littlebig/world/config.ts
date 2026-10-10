// LITTLEBIG world constants. Pure data, no three.js. Every number here is part of the contract
// between systems (BRIEF §2): change one only with a DECISIONS.md line.
//
// Units are metres and seconds. The planet is centred on the world origin. "Up" anywhere is the
// unit vector from the centre, so there is no global up axis except for lat/lon:
//   dir(lat, lon) = (cos lat · sin lon,  sin lat,  cos lat · cos lon)
// i.e. +Y is the north pole and (lat 0, lon 0) is +Z. See sphere.ts.

/** The world seed. Same planet, same city, same trees every visit. */
export const SEED = 0x1b1530;

/** Planet radius at sea level (m). The ocean surface is this sphere. */
export const R = 160;

/** Terrain height range relative to sea level (m). heightAt() stays inside it. */
export const OCEAN_FLOOR = -14;
export const PEAK = 26;

/** Eye height above the ground at street level (m). */
export const EYE_HEIGHT = 1.7;

/** Camera altitude limits (m above the surface under the camera). */
export const ALT_MIN = EYE_HEIGHT;
export const ALT_MAX = 420;

/** Cloud layer and air traffic bands (m above sea level). Used by camera near-plane logic and LOD. */
export const CLOUD_MIN = 36;
export const CLOUD_MAX = 48;
export const PLANE_MIN = 58;
export const PLANE_MAX = 80;

/** Tallest thing that can stand on the planet (m above sea level): planes. Drives the far plane. */
export const TALLEST = PLANE_MAX + 10;

/**
 * v2: the space layer (S1). Satellites and the station orbit between these heights above sea level
 * (m), below the orbit camera (ALT_MAX) and well above the planes. The camera's far plane must cover
 * SPACE_MAX from anywhere it can see it (D1); TALLEST stays the planes' bound for near-ground LOD.
 */
export const SPACE_MIN = 110;
export const SPACE_MAX = 300;

/**
 * The city plateau. A flat cap of the planet, `PLATEAU_HEIGHT` above sea level, centred on
 * (CITY_LAT, CITY_LON). Inside `PLATEAU_RADIUS` (an angle, radians) heightAt() is exactly
 * PLATEAU_HEIGHT; over the next `PLATEAU_BLEND` radians it eases into the natural terrain with no
 * cliff. City content must stay inside PLATEAU_RADIUS (validate.ts checks it).
 */
export const CITY_LAT = 20; // degrees
export const CITY_LON = 10; // degrees
export const PLATEAU_HEIGHT = 2.0;
export const PLATEAU_RADIUS = 0.56; // rad, ≈ 90.7 m of surface at R + PLATEAU_HEIGHT
export const PLATEAU_BLEND = 0.2; // rad, ≈ 32 m

/**
 * City ground heights above the plateau surface (m). The terrain mesh sits at h = 0 (its chords dip
 * a few mm below it), so nothing paved is coplanar with it:
 *   ROAD_H   carriageways and intersection patches (B1 wheels sit here);
 *   ROAD_H + CURB_H   sidewalks, corners, building plinths (B2 feet, FPV eye reference);
 *   AREA_H   park lawns, plaza paving, gardens and lots (drawn by A2, above the bare plateau).
 * CityIndex.groundH(x, z) returns the right one for any plan point.
 */
export const ROAD_H = 0.05;
export const CURB_H = 0.15;
export const AREA_H = 0.03;

/** Radius of the city's surface (m): the plan's exponential map measures arc length on it. */
export const CITY_SURFACE_R = R + PLATEAU_HEIGHT;
/** Usable plan radius (m) on the plateau, measured from the city centre along the surface. */
export const CITY_PLAN_RADIUS = PLATEAU_RADIUS * CITY_SURFACE_R;

/** Length of one day (s of sim time). The day cycle starts in late-afternoon light over the city. */
export const DAY_LENGTH = 480;
/** Sun declination (deg): the sub-solar latitude. */
export const SUN_DECLINATION = 10;
/** Hour angle of the sun at the city at t = 0 (deg; + = afternoon, the sun west of the city). */
export const START_HOUR_ANGLE = 64;
