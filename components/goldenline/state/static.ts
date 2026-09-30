// Position-only inputs of the state simulation, baked once at init over the terrain bounds at
// 0.5 m: the base height, the wetness floor (water table + where run-ups regularly reach), the
// initial "last big run-up" dampness and the masks of the residual current. Recomputing these
// per texel per frame was most of the kernels' cost; now each is one filtered tap.
// The floors are deliberately low: the glossy wetness above the waterline comes from the swash
// itself (ocean/surfzone wet()), so it moves and dries with the water.
//
//   A: (height m, saturated floor 0-0.88 (1 under water), swash-band shape 0-1, recent run-up 0-0.55)
//   B: (surf-zone mask x toward-channel, channel rip mask, 0, 0)

import { ClampToEdgeWrapping, HalfFloatType, LinearFilter, RGBAFormat, StorageTexture, type WebGPURenderer } from 'three/webgpu';
import type { TerrainService, TSLNode } from '../core/contracts';
import { CHANNEL } from '../world/layout';
import type { Noise } from './noise';
import { rev, type Tunables } from './shared';
import { Fn, float, globalId, ivec2, max, sin, smoothstep, textureStore, vec2, vec4, baseTex } from './tsl';

const TEXEL = 0.5;

function makeStatic(w: number, h: number, name: string) {
  const t = new StorageTexture(w, h);
  t.type = HalfFloatType;
  t.format = RGBAFormat;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  (t as unknown as { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
  t.name = `goldenline.state.${name}`;
  return t;
}

export function createStatic(renderer: WebGPURenderer, terrain: TerrainService, terrainH: TSLNode, noise: Noise, tn: Tunables) {
  const [minX, minZ, maxX, maxZ] = terrain.bounds;
  const w = Math.round((maxX - minX) / TEXEL);
  const h = Math.round((maxZ - minZ) / TEXEL);
  const A = makeStatic(w, h, 'staticA');
  const B = makeStatic(w, h, 'staticB');

  const bake = Fn(() => {
    const s = ivec2(globalId.xy);
    const p = vec2(s).add(0.5).mul(TEXEL).add(vec2(minX, minZ)).toVar();
    const hgt = terrainH(p).toVar();
    const n1 = noise.value(p.mul(0.07), 0).mul(0.08).add(noise.value(p.mul(0.23), 1).mul(0.035)).toVar();
    // Beach cusps: ~22 m spacing along the shore, bending the swash limit into lobes.
    // Irregular cusps: phase and amplitude both wander along the shore, so the lobes never read
    // as a regular sine from above.
    const cuspPhase = p.y.mul(0.2856).add(noise.value(p.mul(0.02), 2).mul(3.6)).add(noise.value(p.mul(0.061), 3).mul(1.2)).toVar();
    const cuspAmp = noise.value(p.mul(0.013).add(vec2(5.3, 1.1)), 1).mul(0.6).add(0.75).toVar();
    // Saturated only in a narrow strip where the water table meets the surface at the waterline.
    const sat = max(float(1).sub(smoothstep(0.0, 0.1, hgt.add(n1.mul(0.4)))).mul(0.88), rev(0.02, -0.08, hgt));
    const band = float(1).sub(smoothstep(0.85, 1.4, hgt.add(sin(cuspPhase).mul(cuspAmp).mul(0.14)).add(n1.mul(2))));
    const lobe = noise.value(p.mul(0.11), 3).mul(0.07);
    const recent = float(1).sub(smoothstep(0.7, 1.2, hgt.add(sin(cuspPhase).mul(cuspAmp).mul(0.16)).add(lobe))).mul(0.55);
    textureStore(A, s, vec4(hgt, sat, band, recent)).toWriteOnly();

    const surf = smoothstep(-4.0, -1.4, hgt).mul(float(1).sub(smoothstep(-0.3, 0.25, hgt)));
    const inCh = smoothstep(CHANNEL.zMin - 8, CHANNEL.zMin + 8, p.y).mul(float(1).sub(smoothstep(CHANNEL.zMax - 10, CHANNEL.zMax + 6, p.y)));
    const along = rev(4, -18, p.x).mul(float(1).sub(rev(-150, -210, p.x)));
    // The longshore current turns seaward as it reaches the channel.
    textureStore(B, s, vec4(surf.mul(float(1).sub(inCh)), inCh.mul(along), 0, 1)).toWriteOnly();
  })().compute([Math.ceil(w / 8), Math.ceil(h / 8), 1], [8, 8, 1]).setName('gl.state.bakeStatic');
  renderer.compute(bake);

  const tA = baseTex(A);
  const tB = baseTex(B);
  const uv = (p: TSLNode) => p.sub(vec2(minX, minZ)).div(vec2(maxX - minX, maxZ - minZ));
  return {
    /** (height, saturated floor, swash-band shape, recent run-up) at world XZ. */
    sampleA: (p: TSLNode) => tA.sample(uv(p)).level(0),
    sampleB: (p: TSLNode) => tB.sample(uv(p)).level(0),
    wetFloor: (a: TSLNode) => max(a.y, a.z.mul(tn.swashFloor)),
    wetInit: (a: TSLNode) => max(max(a.y, a.z.mul(tn.swashFloor)), a.w),
    /** Residual surface current (m/s) from the baked masks. */
    flow: (p: TSLNode, b: TSLNode) => {
      const meander = noise.value(p.mul(0.013).add(vec2(tn.time.mul(0.004), 0)), 0).mul(0.05);
      return vec2(b.x.mul(0.05).sub(b.y.mul(tn.rip)), b.x.mul(tn.surfCurrent).add(meander)).mul(tn.advect);
    },
    dispose() {
      bake.dispose();
      A.dispose();
      B.dispose();
    },
  };
}

export type Static = ReturnType<typeof createStatic>;
