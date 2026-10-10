// The ocean's swell (A1), shared by the ocean shader and anything floating on it (boats, wakes):
// three travelling sine trains in world space, scaled by `amp` and faded out 50-160 m from the
// camera (orbit sees a clean sphere). Height above sea level = amp · fade · 0.46 · w.

/** GLSL: the raw wave sum w at world point p and time t (≈ −2.2 … 2.2). */
export const SWELL_GLSL = /* glsl */ `
float lbSwellW(vec3 p, float t) {
  return sin(dot(p, vec3(0.78, 0.29, 0.46)) + t * 1.15)
       + 0.7 * sin(dot(p, vec3(-0.36, 0.64, 0.69)) + t * 1.7)
       + 0.5 * sin(dot(p, vec3(1.1, -0.72, 0.28)) + t * 2.4);
}`;

/** CPU twin of lbSwellW. */
export function swellW(x: number, y: number, z: number, t: number): number {
  return (
    Math.sin(x * 0.78 + y * 0.29 + z * 0.46 + t * 1.15) +
    0.7 * Math.sin(-x * 0.36 + y * 0.64 + z * 0.69 + t * 1.7) +
    0.5 * Math.sin(x * 1.1 - y * 0.72 + z * 0.28 + t * 2.4)
  );
}

/** Distance fade of the swell (1 near the camera, 0 beyond 160 m), as the ocean applies it. */
export function swellFade(dist: number): number {
  const k = Math.min(1, Math.max(0, (dist - 50) / 110));
  return 1 - k * k * (3 - 2 * k);
}
