// Small shader helpers for A1's toon materials (terrain, ocean, nature). ToonPatch hooks run after
// `begin_vertex` and after lighting; a few effects need to reach a stage in between (the shadow
// term, the normal), so this chains one more onBeforeCompile edit onto a toon-kit material. Give
// such a material a unique ToonPatch key: the patch key is part of the program cache key.

import { ShaderChunk } from 'three';
import type { ToonMaterial } from '../render/toon';

type Shader = { vertexShader: string; fragmentShader: string };

// The sun-under-the-local-horizon mask (direct light × smoothstep(−0.14, 0, up·sun)) lives in the
// toon kit for every material now (render/toon.ts); these chunks no longer apply it a second time.

/**
 * Low-light grade for vegetation (terrain greens and nature): at night foliage loses saturation
 * toward the fill's hue (the eye's night vision), so lime crowns and fields sit in the same
 * moonlit light as the city instead of staying daytime green. It stays out of the twilight band
 * (sun −11.5° … +15° over the fragment): there the toon kit's FRAG_DUSK_FOLIAGE (B4) owns foliage,
 * and the two desaturations stacked into neutral grey at the terminator. GLSL; edits
 * `outgoingLight`, reads vLbWorld (ToonPatch.fragment).
 */
export const LOW_LIGHT_GRADE = /* glsl */ `
  {
    float lbSl = dot(normalize(vLbWorld), lbSunDir);
    float lbLow = (1.0 - smoothstep(-0.02, 0.3, lbSl)) * (1.0 - smoothstep(-0.2, -0.03, lbSl) * (1.0 - smoothstep(0.02, 0.26, lbSl)));
    float lbL = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
    outgoingLight = mix(outgoingLight, vec3(lbL) * vec3(0.86, 0.92, 1.18), 0.5 * lbLow);
  }`;

export function extendToon(mat: ToonMaterial, edit: (shader: Shader) => void): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    edit(shader);
  };
}

/**
 * Directional shadows that fade out on facets grazing the sun. The toon ramp already darkens a
 * facet turning away from the light (its terminator band); the shadow-map test on such a facet
 * compares it against its own depth and speckles (acne on steep slivers in low sun). Light hitting
 * at < ~9° is shaded by the ramp alone.
 */
const SHADOW_LINE =
  'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

export const GRAZING_SHADOW_FRAGMENT = ShaderChunk.lights_fragment_begin.replace(
  SHADOW_LINE,
  `{
			float lbSh = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
			directLight.color *= mix( 1.0, lbSh, smoothstep( 0.03, 0.16, dot( geometryNormal, directLight.direction ) ) );
		}`,
);

export function grazingShadows(shader: Shader): void {
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', GRAZING_SHADOW_FRAGMENT);
}

/** Directional shadows at a reduced strength (water: a shadow on it is a tint, not a hole). */
export function softShadows(strength: number) {
  const chunk = ShaderChunk.lights_fragment_begin.replace(
    SHADOW_LINE,
    `directLight.color *= mix( 1.0, ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0, ${strength.toFixed(3)} );`,
  );
  return (shader: Shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', chunk);
  };
}

/**
 * The grazing-light shadow fade, plus a per-fragment opt-out: fragments whose `vLbNoShadow` varying
 * is 1 ignore the shadow map (thin double-sided parts like windmill sails, which would self-shadow).
 * The material's patch must declare and write `varying float vLbNoShadow`.
 */
export function grazingShadowsWithOptOut(shader: Shader): void {
  const chunk = ShaderChunk.lights_fragment_begin.replace(
    SHADOW_LINE,
    `{
			float lbSh = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
			directLight.color *= mix( 1.0, lbSh, ( 1.0 - vLbNoShadow ) * smoothstep( 0.03, 0.16, dot( geometryNormal, directLight.direction ) ) );
		}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', chunk);
}
