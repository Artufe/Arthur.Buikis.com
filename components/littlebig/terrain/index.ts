// Terrain (A1): the displaced icosphere with flat-shaded low-poly facets.
//
// Colour: every facet carries two colours, its corners' smooth vertex colours (interpolated, so a
// biome boundary is a clean organic contour at a distance) and its own facet colour (the dominant
// corner biome with low-frequency jitter: a crisp low-poly staircase up close, see colors.ts). The
// vertex shader blends from facet to smooth colour with distance from the camera (terrain.blendNear
// → terrain.blendFar), so orbit reads as clean painted continents and the street as chunky facets.
// Rock and snow facets are 'crisp' (aFaceCol.a): they never blend, so the range stays a faceted
// toy at every distance, and snow is half-desaturated so the golden key doesn't turn it cream.
// Colours are stored as sRGB bytes and linearised in the shader (finer steps in dark greens).
//
// Shading follows the same blend (facet normal → smooth vertex normal); soft ground keeps a share
// (terrain.soft) of the smooth normal even up close, so a curved meadow in low sun doesn't turn
// into a checkerboard of ramp bands.
//
// Shadows: facets grazing the sun ignore the shadow-map test (the ramp shades them), which removes
// the speckle on steep slivers in low sun (terrain/shader-ext.ts).

import { BufferAttribute, BufferGeometry, Vector2 } from 'three';
import type { LBContext, System } from '../core/contracts';
import { R } from '../world/config';
import { chunkedMesh, terrainChunkBounds, type ChunkedMesh } from './chunked';
import { faceColor, vertexColors } from './colors';
import { terrainData } from './data';
import { extendToon, grazingShadows, LOW_LIGHT_GRADE } from './shader-ext';

export function createTerrainSystem(): System {
  let geometry: BufferGeometry | null = null;
  let chunks: ChunkedMesh | null = null;
  return {
    name: 'terrain',
    stage: 1,
    init(ctx: LBContext) {
      const t = terrainData(ctx.world.planet, ctx.q.terrainDetail);
      const vcol = vertexColors(t);
      const P = t.ico.positions;
      const H = t.heights;
      const idx = t.ico.indices;
      const tris = t.ico.triangleCount;
      const pos = new Float32Array(tris * 9);
      const nor = new Float32Array(tris * 9);
      const col = new Uint8Array(tris * 9);
      const fcol = new Uint8Array(tris * 12);
      const fc: [number, number, number] = [0, 0, 0];
      const snor = new Int8Array(tris * 9);
      const VN = t.normal;
      for (let f = 0; f < tris; f++) {
        const o = f * 9;
        for (let k = 0; k < 3; k++) {
          const vi = idx[f * 3 + k];
          const r = R + H[vi];
          pos[o + k * 3] = P[vi * 3] * r;
          pos[o + k * 3 + 1] = P[vi * 3 + 1] * r;
          pos[o + k * 3 + 2] = P[vi * 3 + 2] * r;
          const cr = vcol[vi * 3], cg = vcol[vi * 3 + 1], cb = vcol[vi * 3 + 2];
          col[o + k * 3] = cr;
          col[o + k * 3 + 1] = cg;
          col[o + k * 3 + 2] = cb;
          snor[o + k * 3] = Math.round(VN[vi * 3] * 127);
          snor[o + k * 3 + 1] = Math.round(VN[vi * 3 + 1] * 127);
          snor[o + k * 3 + 2] = Math.round(VN[vi * 3 + 2] * 127);
        }
        // Face normal.
        const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
        const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        // Facet colour: the dominant corner biome with the facet's own slope (terrain/colors.ts).
        const cx = pos[o] + pos[o + 3] + pos[o + 6], cy = pos[o + 1] + pos[o + 4] + pos[o + 7], cz = pos[o + 2] + pos[o + 5] + pos[o + 8];
        const fslope = 1 - (nx * cx + ny * cy + nz * cz) / (Math.hypot(cx, cy, cz) || 1);
        const crisp = faceColor(t, f, fslope, fc);
        const r8 = Math.min(255, Math.round(fc[0] * 255));
        const g8 = Math.min(255, Math.round(fc[1] * 255));
        const b8 = Math.min(255, Math.round(fc[2] * 255));
        for (let k = 0; k < 3; k++) {
          nor[o + k * 3] = nx;
          nor[o + k * 3 + 1] = ny;
          nor[o + k * 3 + 2] = nz;
          fcol[o * 4 / 3 + k * 4] = r8;
          fcol[o * 4 / 3 + k * 4 + 1] = g8;
          fcol[o * 4 / 3 + k * 4 + 2] = b8;
          fcol[o * 4 / 3 + k * 4 + 3] = crisp * 255;
        }
      }
      geometry = ctx.track(new BufferGeometry());
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      geometry.setAttribute('normal', new BufferAttribute(nor, 3));
      geometry.setAttribute('color', new BufferAttribute(col, 3, true));
      geometry.setAttribute('aFaceCol', new BufferAttribute(fcol, 4, true));
      geometry.setAttribute('aSmoothN', new BufferAttribute(snor, 3, true));
      geometry.computeBoundingSphere();

      const blendNear = ctx.params.number('terrain.blendNear', { label: 'terrain facet→smooth from (m)', min: 0, max: 200, value: 40 });
      const blendFar = ctx.params.number('terrain.blendFar', { label: 'terrain facet→smooth to (m)', min: 1, max: 400, value: 130 });
      const soft = ctx.params.number('terrain.soft', { label: 'terrain smooth-normal share up close', min: 0, max: 1, value: 0.35 });
      const uBlend = { value: new Vector2(blendNear.value, blendFar.value) };
      const uSoft = { value: soft.value };
      ctx.params.onChange((p) => {
        if (p === blendNear || p === blendFar) uBlend.value.set(blendNear.value, Math.max(blendNear.value + 1, blendFar.value));
        if (p === soft) uSoft.value = soft.value;
      });
      const mat = ctx.toon.material({
        name: 'terrain',
        vertexColors: true,
        rim: 0.22,
        patch: {
          key: 'terrain',
          uniforms: { uTerrainBlend: uBlend, uTerrainSoft: uSoft },
          vertexPars: /* glsl */ `
attribute vec4 aFaceCol;
attribute vec3 aSmoothN;
uniform vec2 uTerrainBlend;
uniform float uTerrainSoft;
varying float vSnow;`,
          vertex: /* glsl */ `
#ifdef USE_COLOR
  {
    vec3 lbTw = (modelMatrix * vec4(transformed, 1.0)).xyz;
    // Rock and snow facets (aFaceCol.a = 1) stay crisp at every distance: a faceted toy range.
    float lbK = smoothstep(uTerrainBlend.x, uTerrainBlend.y, distance(lbTw, lbCamPos)) * (1.0 - aFaceCol.a);
    vec3 lbC = mix(aFaceCol.rgb, color.rgb, lbK);
    vSnow = smoothstep(0.8, 0.9, min(lbC.r, min(lbC.g, lbC.b)));
    vColor.rgb = pow(lbC, vec3(2.2));
    // Facets fade to smooth shading with distance too: no per-facet terminator mosaic from orbit.
    // Soft ground keeps a share of the smooth normal even up close, so a curved meadow in low sun
    // reads as gentle facets, not a light/dark checkerboard of ramp bands (rock stays fully crisp).
    vNormal = normalize(normalMatrix * mix(normal, aSmoothN, max(lbK, uTerrainSoft * (1.0 - aFaceCol.a))));
  }
#endif`,
          fragmentPars: 'varying float vSnow;',
          // Snow reads white, not cream: the golden key light tints it only half as much.
          fragment: /* glsl */ `
  outgoingLight = mix(outgoingLight, vec3(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.98, 1.0, 1.04), 0.55 * vSnow);
  ${LOW_LIGHT_GRADE}`,
        },
      });
      extendToon(mat, grazingShadows);
      // Only the chunks in view (and just outside it, for shadows cast into view) are drawn.
      chunks = chunkedMesh(ctx, geometry, mat, terrainChunkBounds(t), tris, { cast: true, receive: true, inflate: 40 });
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
