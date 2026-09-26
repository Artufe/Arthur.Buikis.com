// The pier's timber material: one node graph, three flavours.
//   deck   planks and treads: strongest sun-bleach, nail heads with rust halos
//   timber stringers, caps, rims, posts, rails, braces: bleach by exposure, tide staining
//   pile   pilings: tide band, algae, barnacles, trunk irregularity
// All flavours read the quilted wood strip (albedo/normal/roughness-AO-height) with a
// per-instance offset so no two boards show the same grain, and add reflected-water light
// (bounce + dancing caustics) to surfaces that face down or toward the sun over water.

import { type InstancedBufferAttribute, MeshPhysicalNodeMaterial } from 'three/webgpu';
import {
  Fn,
  positionPrevious,
  atan,
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  instancedBufferAttribute,
  length,
  luminance,
  max,
  min,
  mix as mix_,
  normalize,
  normalMap,
  normalWorldGeometry,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  texture as texture_,
  uv,
  vec2 as vec2_,
  vec3 as vec3_,
  vec4,
} from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import { WOOD_U, WOOD_V } from './geometry';
import { PLANK, STRINGER } from './plan';
import { causticPattern, hash22, type PierUniforms, reflectFalloff } from './shade';
import type { PierTextures } from './textures';

// The TSL typings reject mixed node/number args that TSL itself accepts; loosen locally.
const mix = mix_ as unknown as (...a: unknown[]) => TSLNode;
const texture = texture_ as unknown as (...a: unknown[]) => TSLNode;
const vec2 = vec2_ as unknown as (...a: unknown[]) => TSLNode;
const vec3 = vec3_ as unknown as (...a: unknown[]) => TSLNode;

export type WoodKind = 'deck' | 'timber' | 'pile';

export interface WoodInputs {
  kind: WoodKind;
  tex: PierTextures;
  u: PierUniforms;
  /** Per instance: (u offset, v offset, bleach 0..1, v scale). */
  seed: InstancedBufferAttribute;
  /** Per instance: (ground height below, spray exposure 0..1, random, kind-specific). */
  env: InstancedBufferAttribute;
  sunDir: TSLNode;
  /** Optional caustic override from the water system: (worldPos) => float, mean ≈ 1. */
  causticsHook?: ((p: TSLNode) => TSLNode) | null;
}

export function createWoodMaterial(o: WoodInputs): MeshPhysicalNodeMaterial {
  const { kind, tex, u } = o;
  const m = new MeshPhysicalNodeMaterial();
  const seed: TSLNode = instancedBufferAttribute(o.seed, 'vec4');
  const env: TSLNode = instancedBufferAttribute(o.env, 'vec4');
  const uv0 = uv();
  const tuv = vec2(uv0.x.add(seed.x.mul(3)), uv0.y.mul(seed.w).add(seed.y));
  const alb = texture(tex.albedo, tuv).rgb;
  const nrmTex = texture(tex.normal, tuv).rgb.mul(2).sub(1);
  const ord = texture(tex.ord, tuv);
  const wp = positionWorld;
  const ng = normalWorldGeometry;
  const up = ng.y.max(0);
  const down = ng.y.negate().max(0);
  const h = wp.y;

  // Low-frequency staining along the grain, and fine vertical streaks for drips.
  const stain = texture(tex.noise, vec2(tuv.x.mul(0.5), tuv.y.mul(1.5))).r;
  const streak = texture(tex.noise, vec2(tuv.x.mul(2.2), h.mul(0.06))).b;
  const blot = texture(tex.noise, wp.xz.mul(0.07)).g;

  // ── Dry wood: sheltered faces stay warm brown; sun-facing faces bleach to silver-grey. ──
  const grey = vec3(luminance(alb));
  const exposure = kind === 'deck' ? up.mul(0.5).add(0.5) : up.mul(0.35).add(ng.y.abs().oneMinus().mul(0.45)).add(0.2);
  const bleach = seed.z.mul(u.bleach).mul(exposure).mul(down.mul(0.85).oneMinus()).clamp(0, 1);
  const warm = alb.mul(vec3(1.1, 0.93, 0.76)).mul(0.82);
  const silver = mix(grey, alb, 0.2).mul(vec3(1.0, 0.99, 0.975)).mul(1.62);
  let col: TSLNode = mix(warm, silver, bleach);
  col = col.mul(stain.mul(0.3).add(0.85));
  if (kind === 'deck') {
    // Every plank weathered a little differently: tone and warmth vary board to board.
    col = col.mul(env.z.sub(0.5).mul(0.24).add(1)).mul(vec3(1, seed.x.sub(0.5).mul(0.04).add(1), seed.x.sub(0.5).mul(0.08).add(1)));
    // A replacement plank or two: warmer, less grey, still dusty.
    col = mix(col, alb.mul(vec3(1.2, 0.95, 0.72)).mul(1.05), env.w.mul(0.6));
  }

  let rough: TSLNode = mix(float(0.62), float(0.94), ord.r);
  let ao: TSLNode = ord.g.mul(0.6).add(0.4);
  let metal: TSLNode = float(0);
  let nT: TSLNode = vec3(nrmTex.xy.mul(u.normalK), nrmTex.z);

  // ── Salt spray: toward the break the timber is damp-dark and a touch glossier. ──
  const spray = env.y.mul(u.spray).mul(blot.mul(0.6).add(0.4));
  col = col.mul(spray.mul(-0.3).add(1));
  rough = rough.sub(spray.mul(0.12));

  // ── Nails (deck): two per stringer crossing, dark iron heads bleeding rust. ──
  if (kind === 'deck') {
    const lx = uv0.x.mul(WOOD_U).sub(PLANK.w);
    const lz = uv0.y.mul(WOOD_V).sub(1.6);
    let nd: TSLNode = float(9);
    for (let k = 0; k < STRINGER.z.length; k++) {
      for (let s = -1; s <= 1; s += 2) {
        nd = min(nd, length(vec2(lx.sub(s * 0.034), lz.sub(STRINGER.z[k]))));
      }
    }
    const top = smoothstep(0.85, 0.95, up);
    const head = smoothstep(0.0052, 0.0042, nd).mul(top);
    const rust = smoothstep(0.02, 0.004, nd).mul(top).mul(env.z.mul(0.7).add(0.3));
    col = col.mul(mix(vec3(1), vec3(0.62, 0.4, 0.26), rust.mul(0.55)));
    col = mix(col, vec3(0.032, 0.028, 0.025), head);
    rough = mix(rough, float(0.55), head);
    metal = head.mul(0.5);
    // The head sits a hair proud: a ring of tilted normal around it catches the sun.
    const ring = smoothstep(0.0036, 0.0048, nd).mul(smoothstep(0.0058, 0.0048, nd)).mul(top);
    nT = nT.add(vec3(lx.sign().mul(ring).mul(0.6), 0, 0));
  }

  // ── Tide line: wet-dark band with drip streaks, then algae, barnacles and fouling. ──
  const aroundM = kind === 'pile' ? uv0.x.mul(env.w.mul(3.14159)) : tuv.x.mul(WOOD_U);
  if (kind !== 'deck') {
    // A crisp upper edge that runs down in drips, like a real tide/splash line.
    const drips = texture(tex.noise, vec2(aroundM.mul(3.1), h.mul(0.05))).a;
    const splash = float(1.0).add(env.y.mul(0.8)).add(blot.mul(0.35)).sub(smoothstep(0.45, 0.8, drips).mul(0.55));
    const wet = smoothstep(splash.add(0.04), splash.sub(0.12), h);
    const soak = smoothstep(splash.add(0.9), splash, h).mul(0.25); // damp fringe above
    col = col.mul(mix(vec3(1), vec3(0.34, 0.33, 0.31), wet)).mul(soak.mul(-0.5).add(1));
    rough = mix(rough, float(0.26), wet);
    nT = mix(nT, vec3(nT.xy.mul(0.6), nT.z), wet);
    // Algae: hanging, stringy patches in the splash zone, a dense green-brown skin below.
    const strands = texture(tex.noise, vec2(aroundM.mul(7.3), h.mul(0.55))).a;
    const patches = texture(tex.noise, vec2(aroundM.mul(0.9), h.mul(0.9))).g;
    const algaeTop = float(0.2).add(patches.mul(0.6)).add(strands.mul(0.3));
    const algae = smoothstep(algaeTop, algaeTop.sub(0.12), h).mul(smoothstep(0.35, 0.6, strands.mul(0.55).add(patches.mul(0.6)))).mul(u.growth);
    const algaeCol = mix(vec3(0.02, 0.045, 0.01), vec3(0.07, 0.085, 0.02), strands);
    const fouling = smoothstep(-0.3, -1.2, h).mul(u.growth);
    col = mix(col, algaeCol, algae.mul(0.9));
    col = mix(col, mix(vec3(0.03, 0.045, 0.02), vec3(0.06, 0.05, 0.03), patches), fouling.mul(0.85));
    rough = mix(rough, float(0.34), algae.max(fouling));
    nT = mix(nT, vec3(0, 0, 1), algae.mul(0.7));
  }

  if (kind === 'pile') {
    // Barnacles: a dense crust of small cones just above mean sea level (colonies merging into
    // each other), thinning upward into scattered individuals. Lone high-contrast rings read as
    // polka dots, so the crust is the main read and single barnacles stay low-contrast.
    const colony = texture(tex.noise, vec2(aroundM.mul(1.6), h.mul(1.3))).g.mul(0.7).add(blot.mul(0.3));
    const edgeN = blot.sub(0.5).mul(0.35).add(streak.sub(0.5).mul(0.25));
    const crustZone = smoothstep(-0.6, -0.3, h).mul(smoothstep(0.75, 0.4, h.add(edgeN)));
    const fringe = smoothstep(-0.2, 0.1, h).mul(smoothstep(1.2, 0.6, h.add(edgeN)));
    const crust = crustZone.mul(smoothstep(0.22, 0.5, colony)).mul(u.barnacles);
    const density = max(crust.mul(0.92), fringe.mul(smoothstep(0.5, 0.75, colony)).mul(0.3)).mul(u.barnacles);
    const speck = texture(tex.noise, vec2(aroundM, h).mul(14)).a;
    const speck2 = texture(tex.noise, vec2(aroundM, h).mul(31)).b;
    // Crust base between the shells: rough, chalky, pitted.
    col = mix(col, mix(vec3(0.13, 0.126, 0.112), vec3(0.28, 0.27, 0.245), speck.mul(0.6).add(speck2.mul(0.4))), crust.mul(0.92));
    nT = nT.add(vec3(speck.sub(0.5).mul(0.9), speck2.sub(0.5).mul(0.9), 0).mul(crust));
    rough = mix(rough, float(0.9), crust);
    // Two layers of cells: big adults (~3.2 cm) over a dense bed of small ones (~1.4 cm). Each
    // barnacle is a lumpy cone (angular noise on its radius) with its own tint: chalky white,
    // grey, or dead and algae-stained.
    const barnacleLayer = (scale: number, sizeMin: number, sizeVar: number, dens: TSLNode, salt: number) => {
      const sc = vec2(aroundM, h).mul(scale);
      const cell = sc.floor();
      const f = sc.fract();
      let best: TSLNode = float(9);
      let dir: TSLNode = vec2(0, 0);
      let tint: TSLNode = float(0);
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const o = vec2(i, j);
          const hh = hash22(cell.add(o).add(salt));
          const hj = hash22(cell.add(o).add(salt + 17.3));
          const d = o.add(hj.mul(0.8).add(0.1)).sub(f);
          const cr = hh.y.mul(hh.y).mul(sizeVar).add(sizeMin);
          const lump = sin(atan(d.y, d.x).mul(6).add(hj.x.mul(6.28))).mul(0.05).add(1);
          const nd = hh.x.lessThan(dens).select(length(d).div(cr.mul(lump)), float(9));
          const closer = nd.lessThan(best);
          best = closer.select(nd, best);
          dir = closer.select(d, dir);
          tint = closer.select(hj.y, tint);
        }
      }
      return { best, dir, tint };
    };
    const small = barnacleLayer(70, 0.26, 0.3, density, 0);
    const big = barnacleLayer(31, 0.22, 0.26, density.mul(0.55), 41.7);
    const shade = (L: { best: TSLNode; dir: TSLNode; tint: TSLNode }, k: number) => {
      const body = smoothstep(1.0, 0.68, L.best);
      const slope = body.mul(smoothstep(0.25, 0.7, L.best));
      const tilt = normalize(L.dir.negate().add(1e-4)).mul(slope).mul(0.35 * k);
      nT = nT.add(vec3(tilt.x, tilt.y, 0).mul(body));
      const white = vec3(0.34, 0.33, 0.3);
      const grey = vec3(0.19, 0.185, 0.17);
      const dead = vec3(0.07, 0.085, 0.045);
      const c = mix(mix(dead, grey, smoothstep(0.05, 0.3, L.tint)), white, smoothstep(0.45, 0.9, L.tint)).mul(speck2.mul(0.3).add(0.8));
      col = mix(col, c, body.mul(0.92));
      const aperture = smoothstep(0.22, 0.1, L.best).mul(smoothstep(0.35, 0.6, L.tint));
      col = mix(col, vec3(0.045, 0.043, 0.038), aperture.mul(0.6));
      rough = mix(rough, float(0.8), body);
      return body;
    };
    const bodyS = shade(small, 0.8);
    const bodyB = shade(big, 1);
    // Crevices between shells: occlusion and dark grout, which is what gives the crust depth.
    const crevice = float(1).sub(max(bodyS, bodyB)).mul(crust);
    col = col.mul(crevice.mul(-0.5).add(1));
    ao = ao.mul(crevice.mul(-0.55).add(1));

    // Trunk irregularity: ovality, a gentle bow and a slight taper to the driven tip.
    const g = positionGeometry;
    const ang = atan(g.z, g.x);
    const len = seed.w.mul(WOOD_V);
    const wob = sin(ang.mul(2).add(seed.x.mul(6.28))).mul(0.03).add(sin(ang.mul(3).add(seed.y.mul(6.28)).add(g.y.mul(len).mul(0.35))).mul(0.018));
    const taper = g.y.mul(0.1).sub(0.08);
    const dr = env.w.mul(wob.add(taper));
    const bow = sin(g.y.mul(3.14159)).mul(len).mul(0.004);
    // Static displacement: previous position = current, so TRAA/motion blur see it at rest.
    m.positionNode = Fn(() => {
      const p = positionLocal.add(vec3(g.x.mul(dr).add(bow.mul(seed.x.sub(0.5))), 0, g.z.mul(dr).add(bow.mul(seed.y.sub(0.5)))));
      positionPrevious.assign(p);
      return p;
    })();
  }

  if (kind === 'deck') {
    // Sub-pixel gaps alias into moire in the distance: close them smoothly with camera distance.
    // The shadow pass keeps the real gaps (castShadowPositionNode), so the light stripes stay.
    const gx = positionGeometry.x;
    const close = smoothstep(9, 26, positionLocal.sub(cameraPosition).length()).mul(PLANK.gapMax * 0.5);
    m.positionNode = Fn(() => {
      const p = positionLocal.add(vec3(gx.sign().mul(close), 0, 0));
      positionPrevious.assign(p);
      return p;
    })();
    m.castShadowPositionNode = positionLocal;
  }

  // End grain reads darker and rougher (it drinks water and dirt).
  const endGrain = attribute('aEnd', 'float');
  if (kind !== 'pile') {
    col = col.mul(endGrain.mul(-0.35).add(1));
    rough = mix(rough, float(0.97), endGrain);
  }

  // ── Reflected water light: cool bounce on undersides, dancing caustics near the water. ──
  const hAbove = max(h.sub(u.waterY), 0.03);
  const overWater = smoothstep(0.15, -0.35, env.x);
  const above = smoothstep(-0.15, 0.1, h.sub(u.waterY));
  // The environment already carries the ground (sand landward, water seaward); this only adds
  // the cool light the sunlit water throws up under the structure.
  const bounceCol = vec3(u.bounceWater).mul(overWater);
  const bounce = bounceCol.mul(down.mul(0.85).add(ng.y.abs().oneMinus().mul(0.25))).mul(reflectFalloff(hAbove)).mul(u.bounce);
  // Sun rays reflected off the water travel up and away from the sun.
  const sd = o.sunDir;
  const rUp = vec3(sd.x.negate(), sd.y, sd.z.negate());
  const recv = max(dot(ng, rUp.negate()), 0);
  const back = wp.xz.sub(rUp.xz.mul(hAbove.div(rUp.y.max(0.05))));
  const blur = clamp(hAbove.mul(0.08), 0, 0.8);
  const pattern = o.causticsHook ? o.causticsHook(vec3(back.x, u.waterY, back.y)) : causticPattern(back, u.time, blur);
  // Undersides get a boost: the eye reads the dancing light against a dim ceiling, and the
  // brief asks for it to be seen (a ~3x exaggeration of the grazing reflected irradiance).
  const caustic = vec3(u.sunRadiance).mul(pattern).mul(recv).mul(down.mul(2.2).add(1)).mul(0.6).mul(reflectFalloff(hAbove)).mul(overWater).mul(u.caustics);
  const reflected = bounce.add(caustic).mul(above).mul(1 / Math.PI);
  // Undersides see the water, not the bright sky: hold back their sky light (cool and dim).
  ao = ao.mul(mix(float(1), float(0.45), down.mul(overWater)));

  m.colorNode = vec4(col.clamp(0, 1), 1);
  m.roughnessNode = rough.clamp(0.08, 1);
  m.metalnessNode = metal;
  m.aoNode = ao;
  m.normalNode = normalMap(normalize(nT).mul(0.5).add(0.5));
  m.anisotropyNode = vec2(u.aniso.mul(bleach.mul(0.5).add(0.5)).mul(rough.oneMinus().mul(1.6).clamp(0, 1)), 0);
  m.emissiveNode = col.mul(reflected);
  return m;
}
