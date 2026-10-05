// Pure curves for the post pipeline (no three.js): how much tilt-shift, ink fade, bloom and sun
// glow each view gets. Kept separate so they are spec'd (curves.spec.ts) and tunable in one place.

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** smoothstep(a, b, x) for a < b. */
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Tilt-shift (the miniature look, BRIEF §3) by camera altitude above the terrain (m): none at
 * street level and in orbit, peaking from 28 to 60 m (the cloud layer, where the town reads as a
 * toy), about half at the rooftops (16 m) and the city view (120 m): there it is a hint, not a
 * smear. Log-space ramps, so the fade takes as long at 12 m as at 130 m in a log-zoom.
 */
export function tiltAmount(alt: number): number {
  if (!(alt > 0)) return 0;
  const l = Math.log(alt);
  return smooth(Math.log(10), Math.log(28), l) * (1 - smooth(Math.log(60), Math.log(240), l));
}

/**
 * Ink fade by eye-to-surface distance (m): 1 up close, ~0.8 over the city at 120 m, ~0.27 from
 * orbit, so the globe isn't noisy but the town still reads as drawn. GLSL twin in the composite,
 * with `ref` = the post.inkDist param.
 */
export function inkFade(dist: number, ref = 230): number {
  const r = dist / ref;
  return 1 / (1 + r * r);
}

/**
 * 0 near the ground … 1 from orbit: how far the night bloom leans toward its orbit setting. From
 * orbit a window is a pixel and needs a big gain to read as a glowing constellation; at street
 * level the same window fills a tenth of the frame and the same gain would fog the view.
 */
export function bloomFar(alt: number): number {
  return alt > 0 ? smooth(Math.log(45), Math.log(340), Math.log(alt)) : 0;
}

const DEG = Math.PI / 180;

/**
 * 0..1: how much of the night side (where the lights are on) the eye can see. `eyeDist` is the eye's
 * distance from the planet centre, `cosSun` the cosine of the angle between the eye's direction and
 * the sun, `radius` the planet's. The visible cap reaches `acos(radius / eyeDist)` around the point
 * under the eye; lights are a third on at 90° from the sub-solar point and two thirds at 94°
 * (lbNightAt), so the bloom pyramid is needed only once the cap (plus `margin`) reaches that far.
 * Towers peeking over the horizon are the post's own per-building test. Smooth (the bloom scales
 * with it), so it never pops.
 */
export function nightInView(eyeDist: number, cosSun: number, radius: number, margin = 0): number {
  const cap = Math.acos(Math.min(1, radius / Math.max(eyeDist, radius)));
  const a = Math.acos(Math.max(-1, Math.min(1, cosSun)));
  return smooth(88 * DEG, 96 * DEG, a + cap + margin);
}
