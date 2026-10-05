// Ocean (A1): a toon sphere at sea level on the terrain's icosphere (one shared height pass).
//
//   - Depth tint per vertex from the seabed depth (aDepth): pale lagoon turquoise over sand at the
//     shore → turquoise shallows → deep blue, so coasts get a bright ring from orbit.
//   - Gentle low-poly swell: three travelling sine trains displace the vertices radially near the
//     camera (faded out with distance, so orbit sees a clean sphere); facets are flat-shaded from
//     screen-space derivatives near the camera and blend to the smooth sphere normal far away.
//   - Shoreline foam: a lapping white band where the (swell-moved) water meets the beach, plus
//     broken foam lines rolling in toward the shore; both anti-aliased by fwidth and faded out
//     where they would alias.
//   - Grazing sky reflection (Schlick fresnel toward the palette sky, through a softened normal so
//     swell facets don't jump in tint): from eye height, water reads blue whatever the key light.
//     Half of the light acts by luminance only, so the golden key doesn't turn turquoise grey.
//   - Foam is lit by the light's luminance (white, never salmon); the foam lines are domain-warped
//     (no kinks along triangle edges), taper at their ends and fade out from 15-35 m up.
//   - Toon specular: a crisp sun glint on facets facing the half-vector, and twinkling sparkles
//     around the sun path. Day only (lbNightAt). At night the sea darkens (the city's lights win).

import { BufferAttribute, BufferGeometry } from 'three';
import type { LBContext, System } from '../core/contracts';
import { PALETTE } from '../render/palette';
import { R } from '../world/config';
import { icoHeights } from '../world/ico-heights';
import { icosphere } from '../world/icosphere';
import { terrainData } from '../terrain/data';
import { chunkedMesh, terrainChunkBounds, type ChunkedMesh } from '../terrain/chunked';
import { extendToon, softShadows } from '../terrain/shader-ext';
import { SWELL_GLSL } from './swell';

const DEEP = PALETTE.ocean.deep;
const SHALLOW = PALETTE.ocean.shallow;
const FOAM = PALETTE.ocean.foam;
const SKY_TOP = PALETTE.sky.top;
const SKY_HORIZON = PALETTE.sky.horizon;
const ACCENT = PALETTE.accent;

const glslColor = (c: { r: number; g: number; b: number }) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

export function createOceanSystem(): System {
  let geometry: BufferGeometry | null = null;
  let chunks: ChunkedMesh | null = null;
  return {
    name: 'ocean',
    stage: 1,
    init(ctx: LBContext) {
      const detail = ctx.q.terrainDetail;
      const ico = icosphere(detail);
      const heights = icoHeights(ctx.world.planet, detail);
      const n = ico.vertexCount;
      const P = ico.positions;
      const pos = new Float32Array(n * 3);
      const depth = new Float32Array(n);
      // Seabed slope (rise per metre) per vertex, from the terrain's smooth normals: the foam turns
      // depth into metres from the shore with it (even foam width on flat and steep shores).
      const tdata = terrainData(ctx.world.planet, detail);
      const slope = tdata.slope;
      const grad = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        grad[i] = Math.max(0.12, Math.sqrt(2 * Math.max(0, slope[i])));
        pos[i * 3] = P[i * 3] * R;
        pos[i * 3 + 1] = P[i * 3 + 1] * R;
        pos[i * 3 + 2] = P[i * 3 + 2] * R;
        depth[i] = Math.max(-1.5, Math.min(14, -heights[i]));
      }
      geometry = ctx.track(new BufferGeometry());
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      // A sphere's normal is its direction.
      geometry.setAttribute('normal', new BufferAttribute(P, 3));
      geometry.setAttribute('aDepth', new BufferAttribute(depth, 1));
      geometry.setAttribute('aGrad', new BufferAttribute(grad, 1));
      geometry.setIndex(new BufferAttribute(ico.indices, 1));
      geometry.computeBoundingSphere();

      const swell = ctx.params.number('ocean.swell', { label: 'ocean swell amplitude (m)', min: 0, max: 0.6, value: 0.22 });
      // The kit's hemisphere fill is strong (shade on land must stay a colour); on water it washed
      // the deep blue out to pale cyan from orbit, so the sea takes only part of it.
      const fill = ctx.params.number('ocean.fill', { label: 'ocean share of the sky fill', min: 0, max: 1.5, value: 0.5 });
      const fres = ctx.params.number('ocean.fresnel', { label: 'ocean sky reflection (near)', min: 0, max: 1.5, value: 0.75 });
      const foam = ctx.params.number('ocean.foam', { label: 'ocean foam amount', min: 0, max: 2, value: 1 });
      const uSwell = { value: swell.value };
      const uFoam = { value: foam.value };
      const uFres = { value: fres.value };
      ctx.params.onChange((p) => {
        if (p === swell) uSwell.value = swell.value;
        if (p === foam) uFoam.value = foam.value;
        if (p === fres) uFres.value = fres.value;
        if (p === fill) mat.userData.lbUniforms.lbFill.value = fill.value;
      });

      // Linear-space palette constants baked into the shader.
      const lagoon = SHALLOW.clone().lerp(FOAM, 0.2);
      const mid = SHALLOW.clone().lerp(DEEP, 0.6);
      const mat = ctx.toon.material({
        name: 'ocean',
        vertexColors: false,
        rim: 0.1,
        fill: fill.value,
        patch: {
          key: 'ocean',
          uniforms: { uSwell, uFoam, uFres },
          vertexPars: /* glsl */ `
attribute float aDepth;
attribute float aGrad;
uniform float uSwell;
varying float vDepth;
varying float vShore;
varying float vSwell;
varying float vFar;
varying vec3 vWaterCol;
${SWELL_GLSL}`,
          vertex: /* glsl */ `
  {
    vec3 lbP = (modelMatrix * vec4(transformed, 1.0)).xyz;
    float lbD = distance(lbP, lbCamPos);
    vFar = smoothstep(50.0, 160.0, lbD);
    // Swell: three travelling trains, faded out with distance and softened over the beach.
    float w = lbSwellW(lbP, lbTime);
    float amp = uSwell * (1.0 - vFar) * mix(0.55, 1.0, smoothstep(0.0, 2.0, aDepth));
    vSwell = amp * w * 0.46;
    transformed += normalize(transformed) * vSwell;
    vDepth = aDepth;
    vShore = aDepth / aGrad;
    // Depth tint (linear): lagoon over sand → turquoise shallows → mid → deep blue.
    // The turquoise is a shore band (a lagoon shelf reads turquoise-blue, not milky); deep blue
    // from ~5 m, so from orbit the sea is the palette's deep blue with bright coasts.
    vec3 c = mix(${glslColor(lagoon)}, ${glslColor(SHALLOW)}, smoothstep(0.05, 0.7, aDepth));
    c = mix(c, ${glslColor(mid)}, smoothstep(0.8, 2.6, aDepth));
    vWaterCol = mix(c, ${glslColor(DEEP)}, smoothstep(2.2, 5.5, aDepth));
  }`,
          fragmentPars: /* glsl */ `
uniform float uFoam;
uniform float uFres;
varying float vDepth;
varying float vShore;
varying float vSwell;
varying float vFar;
varying vec3 vWaterCol;
float lbHash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float lbVNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(lbHash3(i), lbHash3(i + vec3(1, 0, 0)), f.x), mix(lbHash3(i + vec3(0, 1, 0)), lbHash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(lbHash3(i + vec3(0, 0, 1)), lbHash3(i + vec3(1, 0, 1)), f.x), mix(lbHash3(i + vec3(0, 1, 1)), lbHash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`,
          fragment: /* glsl */ `
  {
    float lbNt = lbNightAt(vLbWorld);
    float lbDay = 1.0 - lbNt;
    const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
    // Light reaching this fragment per unit albedo (so foam is lit like the water around it).
    vec3 lbLit = (reflectedLight.directDiffuse + reflectedLight.indirectDiffuse) / max(diffuseColor.rgb, vec3(0.02));
    float lbLum = dot(lbLit, LUM);
    // Water is lit through a soft knee: full sun gives about its albedo, never more. The key light
    // is ~3x the albedo on land; on saturated blue that pushed the blue channel into the tone
    // mapper's shoulder and the sunlit sea went pale cyan from orbit. Hue: half of the light acts
    // by luminance only, so the golden key doesn't turn turquoise grey.
    float lbK = 1.2 * lbLum / (0.75 + lbLum);
    vec3 lbHue = mix(lbLit / max(lbLum, 1e-3), vec3(1.0), 0.5);
    outgoingLight += diffuseColor.rgb * (lbHue * lbK - lbLit);
    vec3 V = normalize(vViewPosition);
    float lbDist = length(vViewPosition);
    // Grazing reflection of the sky (most water seen from eye height is grazing): a softened
    // normal, so flat swell facets don't each jump to a different tint.
    vec3 lbNs = normalize(mix(normal, normalize(vNormal), 0.6));
    float lbNv = clamp(dot(lbNs, V), 0.0, 1.0);
    float fres = 0.06 + 0.94 * pow(1.0 - lbNv, 5.0);
    vec3 lbSky = mix(${glslColor(SKY_TOP)}, ${glslColor(SKY_HORIZON)}, smoothstep(0.15, 0.9, fres));
    lbSky = mix(lbSky, lbSky * lbDuskTint, lbDuskAt(vLbWorld) * 0.6);
    // Up close the full fresnel; from altitude only a thin milky limb at grazing angles (< ~10°),
    // so the deep blue holds across the disc.
    float lbGraze = 1.0 - smoothstep(0.0, 0.17, lbNv);
    float lbHigh = smoothstep(30.0, 140.0, lbCamAlt);
    float lbReflW = mix(fres * uFres * (1.0 - 0.45 * vFar), 0.3 * lbGraze * lbGraze, lbHigh) * lbDay;
    outgoingLight = mix(outgoingLight, lbSky * (0.35 + 0.7 * lbK), lbReflW);
    // Night: the sea darkens so the city's lights stay the brightest thing in view.
    outgoingLight *= 1.0 - 0.45 * lbNt;

    float d = vDepth + vSwell;
    float nz = lbVNoise(vLbWorld * 0.45 + vec3(0.0, lbTime * 0.05, 0.0));
    // Metres from the shore (depth over the seabed slope), domain-warped by world noise so the
    // foam never kinks along the triangle edges the per-vertex ratio is interpolated across.
    vec3 wq = vLbWorld * 0.33;
    float warp = (lbVNoise(wq) - 0.5) + 0.5 * (lbVNoise(wq * 2.1 + 4.3) - 0.5);
    float dm = vShore + vSwell / 0.12 + warp * 1.0;
    // Lapping band at the waterline: narrower and softer close to a grazing eye.
    float lbNear = 1.0 - smoothstep(3.0, 18.0, lbDist);
    float edgeW = (0.3 + 0.45 * nz + 0.25 * sin(lbTime * 1.3 + nz * 9.0)) * mix(1.0, 0.45, lbNear);
    float aaD = max(fwidth(dm), 1e-3) * (1.0 + 2.5 * lbNear * (1.0 - lbNv));
    float lbFoam = 1.0 - smoothstep(edgeW - aaD, edgeW + aaD, dm);
    // Broken foam lines rolling in on gentle shelves only, tapering at their ends; they fade out
    // from altitude (a busy crack field from above) and where they would alias.
    float ph = dm * 0.32 - lbTime * 0.28 + nz * 0.8;
    float aaP = max(fwidth(ph), 1e-4);
    float fl = fract(ph);
    float seg = smoothstep(0.38, 0.62, lbVNoise(vLbWorld * vec3(0.55) + 7.0));
    float wid = 0.085 * seg;
    float line = smoothstep(0.0, aaP * 1.5, fl) * (1.0 - smoothstep(wid - aaP, wid + aaP, fl)) * step(0.004, wid);
    line *= 1.0 - smoothstep(1.8, 3.2, dm);
    line *= (1.0 - smoothstep(0.25, 0.6, aaP)) * (1.0 - smoothstep(15.0, 35.0, lbCamAlt));
    lbFoam = clamp(max(lbFoam, line * 0.85) * uFoam, 0.0, 1.0);
    // Foam is white: lit mostly by the light's luminance, never salmon or beige.
    vec3 lbFoamLight = max(mix(lbLit, vec3(lbLum), 0.75), vec3(0.75 * lbLum)) * (1.0 - 0.35 * lbNt);
    outgoingLight = mix(outgoingLight, lbFoamLight * ${glslColor(FOAM)} * 0.94, lbFoam);
    vec3 L = normalize((viewMatrix * vec4(lbSunDir, 0.0)).xyz);
    // Toon specular: a crisp glint and sparkles around the sun path.
    vec3 H = normalize(L + V);
    float nh = dot(normal, H);
    // The glint follows a softened normal (a toon sun path, not whole facets flashing white). Far
    // away it is a small soft core plus a scatter of twinkling sparkle points along the sun path
    // (a coarse world lattice, a handful lit at a time), in the site's amber: a solid disc read
    // as a hole in the sea from orbit.
    vec3 lbSn = normalize(mix(normalize(vNormal), normal, 0.3 * (1.0 - vFar)));
    float nhs = dot(lbSn, H);
    float glintNear = smoothstep(0.9965, 0.998, nhs);
    float lbGr = length(lbSn - H);
    float glintFar = 0.0;
    vec3 lbGd = lbSn - H;
    float lbGa = length(vec3(lbGd.x, lbGd.y * 0.4, lbGd.z));
    if (vFar > 0.0 && lbGa < 0.08) {
      float core = exp(-lbGr * lbGr * 20000.0) * 0.55;
      vec3 gp = vLbWorld * 0.42;
      vec3 gc = floor(gp);
      float gt = floor(lbTime * 2.5);
      float gl = lbHash3(gc + gt * 13.0);
      vec3 go = vec3(lbHash3(gc + 1.7), lbHash3(gc + 4.1), lbHash3(gc + 8.9)) * 0.5 + 0.25;
      float gd = length(fract(gp) - go);
      float aaF = max(fwidth(gp.x) + fwidth(gp.y), 1e-3);
      float pt = step(0.8, gl) * (1.0 - smoothstep(0.1, 0.1 + aaF * 1.5, gd));
      glintFar = max(core, pt * (1.0 - smoothstep(0.02, 0.075, lbGa)));
    }
    float glint = mix(glintNear, glintFar, vFar);
    // Sparkles: tiny star points on a 0.33 m lattice that re-roll a few times a second.
    vec3 sp = vLbWorld * 3.0;
    vec3 sc = floor(sp);
    float tw = floor(lbTime * 3.0);
    float cell = lbHash3(sc + tw * 17.0);
    vec3 so = vec3(lbHash3(sc + 3.1), lbHash3(sc + 5.7), lbHash3(sc + 9.3)) * 0.6 + 0.2;
    float dot3d = length(fract(sp) - so);
    float aaS = max(fwidth(sp.x) + fwidth(sp.y), 1e-3);
    float sparkle = step(0.9, cell) * (1.0 - smoothstep(0.1, 0.1 + aaS, dot3d)) * smoothstep(0.88, 0.96, nh) * (1.0 - smoothstep(0.08, 0.3, aaS));
    vec3 lbGlintC = mix(vec3(1.0), ${glslColor(ACCENT)} * 1.25, 0.55 * vFar + 0.25);
    outgoingLight += lbSunColor * (glint * mix(0.55, 0.8, vFar) * lbGlintC + sparkle * 0.9) * lbDay * (1.0 - lbFoam);
  }`,
        },
      });
      extendToon(mat, (shader) => {
        // Water colour from the vertex stage (diffuse), and flat facets near the camera.
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vWaterCol;')
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>
  {
    vec3 lbFn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    normal = normalize(mix(lbFn, normal, vFar));
  }`,
          );
      });
      extendToon(mat, softShadows(0.55));
      chunks = chunkedMesh(ctx, geometry, mat, terrainChunkBounds(tdata), ico.triangleCount, { cast: false, receive: true, inflate: 2 });
      for (const m of chunks.meshes) ctx.scene.add(m);
    },
    update(ctx: LBContext) {
      chunks?.update(ctx);
    },
    dispose() {
      chunks?.dispose();
      chunks = null;
      geometry?.dispose();
      geometry = null;
    },
  };
}
