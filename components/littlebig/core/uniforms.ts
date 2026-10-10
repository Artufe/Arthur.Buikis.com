// Shared uniforms: ONE object per engine, referenced (not copied) by every material through the
// toon kit, so updating `.value` once per frame updates the whole scene. Core writes time, camera
// and reveal; the sky system (A3) writes the sun, fill and night values.
//
// GLSL names are the keys (lbTime, lbSunDir, …); render/toon.ts LB_COMMON_GLSL declares them.

import { Color, Matrix3, type Texture, Vector3 } from 'three';

export interface Uniform<T> {
  value: T;
}

export interface SharedUniforms {
  /** Render-time sim seconds (ctx.time.render). Animate shaders with this, never wall time. */
  lbTime: Uniform<number>;
  /** Unit vector toward the sun (world space). Written by the sky system. */
  lbSunDir: Uniform<Vector3>;
  /** Sun light colour × intensity as seen at the ground on the day side (linear). */
  lbSunColor: Uniform<Color>;
  /** Night factor at the camera focus (0 day … 1 night); per-fragment code uses lbNight(worldPos). */
  lbNight: Uniform<number>;
  /** Camera eye height above the terrain/water under it (ViewState.altTerrain, m) and world position. */
  lbCamAlt: Uniform<number>;
  lbCamPos: Uniform<Vector3>;
  /** Planet-aware hemisphere fill: sky-facing / ground-facing colours by day, one colour by night. */
  lbSkyFill: Uniform<Color>;
  lbGroundFill: Uniform<Color>;
  lbNightFill: Uniform<Color>;
  /** Rim light colour (× rim strength per material) on silhouettes. */
  lbRimColor: Uniform<Color>;
  /** Seconds since the reveal clock started (1e6 in shot mode = everything revealed). */
  lbRevealClock: Uniform<number>;
  /** Ink outline colour (BRIEF §3: #1B1530). For B4's post pass and any inked custom shader. */
  lbInk: Uniform<Color>;
  /**
   * Direct-light tint in the dusk band (GLSL lbDuskAt: sun from −7° to +20° over the fragment):
   * the soft pink/purple terminator, per fragment, from orbit to street. White = off. A3 writes it
   * (and keeps the sun light's own colour near-white, so the lit hemisphere stays neutral).
   */
  lbDuskTint: Uniform<Color>;
  /**
   * Optional cloud-shadow coverage map (equirectangular, R channel, see lbCloudShadowAt in
   * render/toon.ts), its strength (0 = off, nothing is sampled) and the rotation applied to a
   * world direction before the lookup (drift / sun-direction offset). A3 writes them.
   */
  lbCloudShadow: Uniform<Texture | null>;
  lbCloudShadowOn: Uniform<number>;
  lbCloudShadowRot: Uniform<Matrix3>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    lbTime: { value: 0 },
    lbSunDir: { value: new Vector3(0, 0, 1) },
    lbSunColor: { value: new Color(1, 0.95, 0.85) },
    lbNight: { value: 0 },
    lbCamAlt: { value: 400 },
    lbCamPos: { value: new Vector3() },
    lbSkyFill: { value: new Color('#9fd0ff').multiplyScalar(0.55) },
    lbGroundFill: { value: new Color('#c9a27a').multiplyScalar(0.3) },
    lbNightFill: { value: new Color('#3a4a9a').multiplyScalar(1.25) },
    lbRimColor: { value: new Color('#7FD3FF') },
    lbRevealClock: { value: 0 },
    lbInk: { value: new Color('#1B1530') },
    lbDuskTint: { value: new Color(1, 1, 1) },
    lbCloudShadow: { value: null },
    lbCloudShadowOn: { value: 0 },
    lbCloudShadowRot: { value: new Matrix3() },
  };
}
