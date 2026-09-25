export const TRAIL_HOLD = 4; // seconds at full width
export const TRAIL_LIFE = 10; // seconds until gone
export const TRAIL_HALF_EXTENT = 26; // trail map covers [-26, 26]² on XZ
export const RIBBON_HALF = 1.0; // groove + rims half-width at full shape
export const GROOVE_DEPTH = 0.14;
export const RIM_HEIGHT = 0.06;
export const TRAIL_MIN_STEP = 0.1;
export const TRAIL_MAX_POINTS = 1600;

/** 1 while fresh, then eases to 0 between TRAIL_HOLD and TRAIL_LIFE. */
export function trailShape(age: number): number {
  if (age <= TRAIL_HOLD) return 1;
  if (age >= TRAIL_LIFE) return 0;
  const t = (age - TRAIL_HOLD) / (TRAIL_LIFE - TRAIL_HOLD);
  return 1 - t * t * (3 - 2 * t);
}
