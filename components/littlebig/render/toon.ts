// The shared toon material factory. EVERY lit surface in LITTLEBIG comes from here, so the look
// pass (B4) can restyle the whole world in one place.
//
// What a toon material gets on top of three's MeshToonMaterial:
//   - the shared soft-banded ramp (3-4 steps, soft band edges) as gradientMap;
//   - a planet-aware hemisphere fill (sky colour on surfaces facing away from the planet centre,
//     warm bounce facing it, moonlight blue on the night side) instead of a flat ambient;
//   - rim light on silhouettes (lbRimColor × options.rim);
//   - night emissive: options.nightEmissive × lbNight(worldPos) (windows, lamps, headlights);
//   - the reveal: geometry springs up from its local origin as lbRevealClock passes its delay
//     (per-instance attribute `aReveal`, or options.revealDelay for a whole mesh); with reduced
//     motion it dither-fades instead. Put the local origin at the base of the object.
//   - optional vertex/fragment patches for system-specific effects (wind sway, walk cycles), which
//     the matching shadow depth material receives too (vertex patches, the reveal, the shared
//     dither fade and `depthFragment`), so shadows grow, sway and fade with their mesh;
//   - an optional shared dither fade by camera altitude or distance (options.fade) for LOD: one
//     program per mode, no per-system patch needed;
//   - the per-fragment direct-light tint hooks A3 drives: lbDuskTint (pink/purple terminator band,
//     lbDuskAt) and the optional cloud-shadow texture (lbCloudShadowAt).
//
// Program cache: every material with the same reveal mode, fade mode and patch key shares ONE
// program (reveal delay / duration / fade range / rim / fill are uniforms). Reuse patch keys for
// identical patches; every new key is a new program (and a new compile during the reveal).
//
// Use kit.mesh() / kit.instanced() to build meshes: they wire the custom depth material so shadows
// match the reveal and vertex patches. Materials are tracked and disposed by the kit.

import {
  Color,
  DataTexture,
  type BufferGeometry,
  type ColorRepresentation,
  DoubleSide,
  FrontSide,
  InstancedMesh,
  LinearFilter,
  Mesh,
  MeshDepthMaterial,
  MeshToonMaterial,
  RedFormat,
  type Side,
  UnsignedByteType,
  Vector2,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { SharedUniforms } from '../core/uniforms';

/** GLSL declarations of the shared uniforms + helpers. Include in any custom ShaderMaterial. */
export const LB_COMMON_GLSL = /* glsl */ `
uniform float lbTime;
uniform vec3 lbSunDir;
uniform vec3 lbSunColor;
uniform float lbNight;
uniform float lbCamAlt;
uniform vec3 lbCamPos;
uniform vec3 lbSkyFill;
uniform vec3 lbGroundFill;
uniform vec3 lbNightFill;
uniform vec3 lbRimColor;
uniform float lbRevealClock;
uniform vec3 lbInk;
uniform vec3 lbDuskTint;
uniform sampler2D lbCloudShadow;
uniform float lbCloudShadowOn;
uniform mat3 lbCloudShadowRot;
// 0 day … 1 night at a world position (planet centred on the origin). Twin of world/sun.ts nightFactor.
// (Edges ascending: smoothstep(e0, e1) with e0 >= e1 is undefined in GLSL ES 3.0 / MSL.)
float lbNightAt(vec3 worldPos) {
  return 1.0 - smoothstep(-0.18, 0.12, dot(normalize(worldPos), lbSunDir));
}
// 0..1 weight of the dusk band (sun just above / at the local horizon) at a world position: where
// lbDuskTint colours the direct light (the soft pink/purple terminator, BRIEF §3).
float lbDuskAt(vec3 p) {
  float d = dot(normalize(p), lbSunDir);
  return smoothstep(-0.12, 0.05, d) * (1.0 - smoothstep(0.05, 0.35, d));
}
// Direct-light multiplier from cloud shadows (1 = unshadowed). lbCloudShadow is an equirectangular
// coverage map (R: 0 clear … 1 full shadow, LinearFilter, no mipmaps) looked up by the direction
// lbCloudShadowRot · normalize(p): u = atan(d.x, d.z) / 2π + 0.5, v = asin(d.y) / π + 0.5.
float lbCloudShadowAt(vec3 p) {
  if (lbCloudShadowOn <= 0.0) return 1.0;
  vec3 d = lbCloudShadowRot * normalize(p);
  vec2 uv = vec2(atan(d.x, d.z) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  return 1.0 - lbCloudShadowOn * texture2D(lbCloudShadow, uv).r;
}
// smoothstep(0, 1, x) for any x (use for ranges whose ends may be in either order).
float lbSmooth01(float x) {
  x = clamp(x, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}
// Springy 0→1 ease with a small overshoot (the reveal "pop").
float lbSpring(float p) {
  p = clamp(p, 0.0, 1.0);
  return 1.0 - exp(-6.5 * p) * cos(9.0 * p) * (1.0 - p);
}
float lbBayer4(vec2 fc) {
  ivec2 p = ivec2(mod(fc, 4.0));
  int i = p.x + p.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i] + 0.5) / 16.0;
}
`;

export interface ToonPatch {
  /** Declarations added to the vertex shader (uniforms, attributes, functions). */
  vertexPars?: string;
  /** Code run right after `transformed` is set (object space; edit `transformed`, `objectNormal`). */
  vertex?: string;
  /** Declarations added to the fragment shader. */
  fragmentPars?: string;
  /** Code run after lighting, before output: may edit `outgoingLight` and read `vLbWorld`. */
  fragment?: string;
  /**
   * Code run at the start of the SHADOW depth fragment shader (after clipping): may `discard` to
   * keep shadows in step with a fragment-side effect. `vLbWorld` and `vLbReveal` are available;
   * declare anything else in `fragmentPars` (it is added to the depth shader too).
   */
  depthFragment?: string;
  /** Extra uniforms (merged into the program; keep references to update them). */
  uniforms?: Record<string, { value: unknown }>;
  /** Distinct per patch variant: part of the program cache key. */
  key: string;
}

export interface ToonOptions {
  /** Debug / warm-up name. */
  name: string;
  /** Base colour; multiplied by vertex colours and instance colours when present. Default white. */
  color?: ColorRepresentation;
  vertexColors?: boolean;
  /** Always-on emissive colour. */
  emissive?: ColorRepresentation;
  /** Emissive faded in by lbNight(worldPos): windows, lamps. */
  nightEmissive?: ColorRepresentation;
  /** Rim light strength (0 = off). Default 0.35. */
  rim?: number;
  /** Fill light multiplier. Default 1. */
  fill?: number;
  side?: Side;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  fog?: boolean;
  /** 'instance': per-instance float attribute `aReveal` (delay s). 'object': revealDelay for all. */
  reveal?: 'instance' | 'object';
  revealDelay?: number;
  /** Seconds a single reveal takes. Default 0.7. A uniform: durations never fork programs. */
  revealDuration?: number;
  /**
   * Shared LOD dither fade (shadows fade too). by 'alt': camera altitude above the terrain/water
   * (ViewState.altTerrain); by 'dist': distance from the camera to the fragment. Fully visible at
   * `from`, gone at `to` (either order). Also set `mesh.visible = false` once it is fully faded,
   * so it costs no draw call.
   */
  fade?: { by: 'alt' | 'dist'; from: number; to: number };
  patch?: ToonPatch;
}

export interface ToonMaterial extends MeshToonMaterial {
  userData: {
    lbDepth?: MeshDepthMaterial;
    /** Per-material uniforms you may change at runtime: lbRevealDelay (object reveal), lbRevealDur, lbRim, lbNightEmissive, lbFill, lbFadeRange (x = from, y = to). */
    lbUniforms: {
      lbRevealDelay: { value: number };
      lbRevealDur: { value: number };
      lbRim: { value: number };
      lbNightEmissive: { value: Color };
      lbFill: { value: number };
      lbFadeRange: { value: Vector2 };
    };
  };
}

export interface ToonKit {
  /** The shared soft-banded ramp (R8, 64 px, linear filtered). */
  readonly ramp: DataTexture;
  readonly uniforms: SharedUniforms;
  material(opts: ToonOptions): ToonMaterial;
  /** A mesh with the kit's depth material wired for shadows. */
  mesh(geometry: BufferGeometry, material: ToonMaterial, opts?: { cast?: boolean; receive?: boolean }): Mesh;
  instanced(geometry: BufferGeometry, material: ToonMaterial, count: number, opts?: { cast?: boolean; receive?: boolean }): InstancedMesh;
  /** Every material made so far (for warm-up). */
  readonly materials: readonly ToonMaterial[];
  dispose(): void;
}

/**
 * Ramp stops: [dot·0.5+0.5 position, brightness]. Soft band edges ~0.08 wide (≈ 9° of sun angle,
 * ≈ 25 m of ground on this planet), so a band edge never reads as a hard seam across a flat plateau.
 */
export const RAMP_STOPS: Array<[number, number]> = [
  [0.0, 0.0],
  [0.45, 0.0], // the night side gets no direct light (fill only)
  [0.53, 0.42], // terminator band
  [0.6, 0.42],
  [0.68, 0.78],
  [0.78, 0.78],
  [0.86, 1.0],
  [1.0, 1.0],
];

export function createRamp(stops: Array<[number, number]> = RAMP_STOPS, size = 64): DataTexture {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    let v = stops[stops.length - 1][1];
    for (let k = 0; k < stops.length - 1; k++) {
      const [x0, v0] = stops[k];
      const [x1, v1] = stops[k + 1];
      if (x >= x0 && x <= x1) {
        const t = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
        const s = t * t * (3 - 2 * t);
        v = v0 + (v1 - v0) * s;
        break;
      }
    }
    data[i] = Math.round(v * 255);
  }
  const tex = new DataTexture(data, size, 1, RedFormat, UnsignedByteType);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const VERT_PARS = /* glsl */ `
${LB_COMMON_GLSL}
varying vec3 vLbWorld;
varying float vLbReveal;
uniform float lbRevealDelay;
uniform float lbRevealDur;
#ifdef LB_REVEAL_INSTANCE
attribute float aReveal;
#endif
`;

const VERT_REVEAL = /* glsl */ `
#if defined(LB_REVEAL_INSTANCE) || defined(LB_REVEAL_OBJECT)
  #ifdef LB_REVEAL_INSTANCE
    float lbDelay = aReveal;
  #else
    float lbDelay = lbRevealDelay;
  #endif
  float lbP = clamp((lbRevealClock - lbDelay) / max(lbRevealDur, 1e-3), 0.0, 1.0);
  vLbReveal = lbP;
  #ifndef LB_REVEAL_FADE
    transformed *= lbSpring(lbP);
  #endif
#else
  vLbReveal = 1.0;
#endif
`;

const VERT_WORLD = /* glsl */ `
  {
    vec4 lbW = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      lbW = batchingMatrix * lbW;
    #endif
    #ifdef USE_INSTANCING
      lbW = instanceMatrix * lbW;
    #endif
    vLbWorld = (modelMatrix * lbW).xyz;
  }
`;

const FRAG_PARS = /* glsl */ `
${LB_COMMON_GLSL}
varying vec3 vLbWorld;
varying float vLbReveal;
uniform float lbRim;
uniform float lbFill;
uniform vec3 lbNightEmissive;
uniform vec2 lbFadeRange;
`;

/** Depth (shadow) fragment declarations: just what the reveal / fade dither needs. */
const DEPTH_FRAG_PARS = /* glsl */ `
${LB_COMMON_GLSL}
varying vec3 vLbWorld;
varying float vLbReveal;
uniform vec2 lbFadeRange;
`;

const FRAG_FILL = /* glsl */ `
  {
    // Planet-aware hemisphere fill, faded to moonlight on the night side.
    vec3 lbUp = normalize(vLbWorld);
    vec3 lbN = inverseTransformDirection(normal, viewMatrix);
    float lbHemi = dot(lbN, lbUp) * 0.5 + 0.5;
    float lbNt = lbNightAt(vLbWorld);
    // A3's per-fragment direct-light hooks: dusk tint in the terminator band, cloud shadows.
    reflectedLight.directDiffuse *= mix(vec3(1.0), lbDuskTint, lbDuskAt(vLbWorld)) * lbCloudShadowAt(vLbWorld);
    vec3 lbFillC = mix(mix(lbGroundFill, lbSkyFill, lbHemi), lbNightFill * (0.6 + 0.4 * lbHemi), lbNt);
    reflectedLight.indirectDiffuse += lbFill * lbFillC * BRDF_Lambert(material.diffuseColor);
    totalEmissiveRadiance += lbNightEmissive * lbNt;
  }
`;

const FRAG_RIM = /* glsl */ `
  {
    vec3 lbV = normalize(vViewPosition);
    float lbR = pow(1.0 - clamp(dot(normal, lbV), 0.0, 1.0), 3.0);
    float lbDay = 1.0 - 0.7 * lbNightAt(vLbWorld);
    outgoingLight += lbRimColor * (lbRim * lbR * lbDay) * (0.35 + 0.65 * diffuseColor.rgb);
  }
`;

// Dither visibility: the reduced-motion reveal and the shared LOD fade. Used by the colour AND the
// shadow depth programs, so shadows of hidden things vanish with them.
const FRAG_FADE = /* glsl */ `
#if (defined(LB_REVEAL_FADE) && (defined(LB_REVEAL_INSTANCE) || defined(LB_REVEAL_OBJECT))) || defined(LB_FADE_ALT) || defined(LB_FADE_DIST)
  {
    float lbVis = 1.0;
    #if defined(LB_REVEAL_FADE) && (defined(LB_REVEAL_INSTANCE) || defined(LB_REVEAL_OBJECT))
      lbVis = vLbReveal;
    #endif
    #if defined(LB_FADE_ALT)
      lbVis *= 1.0 - lbSmooth01((lbCamAlt - lbFadeRange.x) / (lbFadeRange.y - lbFadeRange.x));
    #elif defined(LB_FADE_DIST)
      lbVis *= 1.0 - lbSmooth01((distance(vLbWorld, lbCamPos) - lbFadeRange.x) / (lbFadeRange.y - lbFadeRange.x));
    #endif
    if (lbVis < lbBayer4(gl_FragCoord.xy)) discard;
  }
#endif
`;

export function createToonKit(uniforms: SharedUniforms, opts: { reducedMotion: boolean }): ToonKit {
  const ramp = createRamp();
  const materials: ToonMaterial[] = [];
  const depths: MeshDepthMaterial[] = [];

  const vertexDefines = (o: ToonOptions): Record<string, string> => {
    const d: Record<string, string> = {};
    if (o.reveal === 'instance') d.LB_REVEAL_INSTANCE = '';
    if (o.reveal === 'object') d.LB_REVEAL_OBJECT = '';
    if (o.reveal && opts.reducedMotion) d.LB_REVEAL_FADE = '';
    if (o.fade?.by === 'alt') d.LB_FADE_ALT = '';
    if (o.fade?.by === 'dist') d.LB_FADE_DIST = '';
    return d;
  };

  const sharedInto = (shader: WebGLProgramParametersWithUniforms, own: Record<string, { value: unknown }>, patch?: ToonPatch) => {
    Object.assign(shader.uniforms, uniforms, own, patch?.uniforms ?? {});
  };

  function material(o: ToonOptions): ToonMaterial {
    const m = new MeshToonMaterial({
      color: o.color ?? 0xffffff,
      vertexColors: o.vertexColors ?? false,
      gradientMap: ramp,
      emissive: o.emissive ?? 0x000000,
      side: o.side ?? FrontSide,
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      depthWrite: o.depthWrite ?? true,
      fog: o.fog ?? true,
    }) as ToonMaterial;
    m.name = o.name;
    const own = {
      lbRevealDelay: { value: o.revealDelay ?? 0 },
      lbRevealDur: { value: o.revealDuration ?? 0.7 },
      lbRim: { value: o.rim ?? 0.35 },
      lbNightEmissive: { value: new Color(o.nightEmissive ?? 0x000000) },
      lbFill: { value: o.fill ?? 1 },
      lbFadeRange: { value: new Vector2(o.fade?.from ?? 0, o.fade && o.fade.to !== o.fade.from ? o.fade.to : (o.fade?.from ?? 0) + 1) },
    };
    m.userData = { lbUniforms: own };
    const defines = vertexDefines(o);
    m.defines = { ...(m.defines ?? {}), ...defines };
    const p = o.patch;
    m.onBeforeCompile = (shader) => {
      sharedInto(shader, own, p);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}\n${p?.vertexPars ?? ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_REVEAL}\n${p?.vertex ?? ''}`)
        .replace('#include <project_vertex>', `${VERT_WORLD}\n#include <project_vertex>`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}\n${p?.fragmentPars ?? ''}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_FADE}`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FRAG_FILL}`)
        .replace(
          'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
          `vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;\n${FRAG_RIM}\n${p?.fragment ?? ''}`,
        );
    };
    const fadeKey = o.fade?.by ?? '';
    m.customProgramCacheKey = () => `lbtoon|${o.reveal ?? ''}|${opts.reducedMotion ? 1 : 0}|${fadeKey}|${p?.key ?? ''}`;

    // Shadow depth twin: same reveal, fade and patches, so shadows grow, sway and fade with the mesh.
    if (o.reveal || o.fade || p?.vertex || p?.depthFragment) {
      const dm = new MeshDepthMaterial(); // basic packing, like three's own shadow depth material
      dm.name = `${o.name}:depth`;
      dm.defines = { ...defines };
      dm.side = o.side === DoubleSide ? DoubleSide : FrontSide;
      dm.onBeforeCompile = (shader) => {
        sharedInto(shader, own, p);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${VERT_PARS}\n${p?.vertexPars ?? ''}`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_REVEAL}\n${p?.vertex ?? ''}`)
          .replace('#include <project_vertex>', `${VERT_WORLD}\n#include <project_vertex>`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${DEPTH_FRAG_PARS}\n${p?.depthFragment ? (p.fragmentPars ?? '') : ''}`)
          .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_FADE}\n${p?.depthFragment ?? ''}`);
      };
      dm.customProgramCacheKey = () => `lbdepth|${o.reveal ?? ''}|${opts.reducedMotion ? 1 : 0}|${fadeKey}|${p?.key ?? ''}`;
      m.userData.lbDepth = dm;
      depths.push(dm);
    }
    materials.push(m);
    return m;
  }

  function wire<T extends Mesh>(mesh: T, mat: ToonMaterial, o?: { cast?: boolean; receive?: boolean }): T {
    mesh.castShadow = o?.cast ?? true;
    mesh.receiveShadow = o?.receive ?? true;
    if (mat.userData.lbDepth) mesh.customDepthMaterial = mat.userData.lbDepth;
    mesh.name = mat.name;
    return mesh;
  }

  return {
    ramp,
    uniforms,
    materials,
    material,
    mesh: (g, m, o) => wire(new Mesh(g, m), m, o),
    instanced: (g, m, n, o) => wire(new InstancedMesh(g, m, n), m, o),
    dispose() {
      for (const m of materials) m.dispose();
      for (const d of depths) d.dispose();
      materials.length = 0;
      depths.length = 0;
      ramp.dispose();
    },
  };
}
