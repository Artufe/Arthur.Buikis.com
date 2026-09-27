// The terrain material: CDLOD vertex stage (morph + base height + GPU detail) and the sand /
// seabed / reef surface. Built on MeshStandardNodeMaterial so the sun's cascaded shadows, the
// environment and scene fog all apply; this file only supplies the surface description.
//
// Surface states (brief §3.4), keyed to state.sand().x as documented in state/README.md:
// 0 dry (rippled, sparkling) · ~0.5 damp (dark, matte) · ~0.88 saturated (dark, glossy) ·
// >0.95 standing film right after a run-up (near mirror, SSR opt-in). A physical baseline is
// always applied on top: the saturated effluent strip at the water line and the damp band up to
// the high-tide mark. With the state stub, a fake swash band stands in (beach.fakeWet).

import { MeshPhysicalNodeMaterial, Vector3, type DataTexture } from 'three/webgpu';
import {
  Fn,
  If,
  attribute,
  globalId,
  ivec2,
  floor,
  textureLoad,
  textureStore,
  dFdx,
  dFdy,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dot,
  exp2,
  float,
  fract,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  normalize,
  positionLocal,
  positionPrevious,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { GLContext, TSLNode } from '../core/contracts';
import { ssrOptIn } from '../post/ssr';
import { SWELL, WIND } from '../world/layout';
import type { SandTile } from './bake';
import { MORPH_END, MORPH_START, RANGE_K, S0 } from './cdlod';
import type { Ground } from './ground';
import { getCausticsHook } from './hooks';
import { voronoi2 } from './tsl-noise';
import { REEF_BOUNDS, REEF_TEXEL, type ReefBake } from './reef-bake';

export interface SandTextures {
  dryRipple: SandTile;
  waveRipple: SandTile;
  swash: SandTile;
  grain: SandTile;
  macro: SandTile;
  far: DataTexture;
  aux: DataTexture;
  /** [polish] GPU-baked reef field (reef-bake.ts); baked by the first createSandMaterial(). */
  reef?: ReefBake;
}

export interface SandUniforms {
  /** Centre of the LOD distance (the player camera, not the shadow camera). */
  lodCenter: TSLNode;
  /** Camera height above ground, the constant vertical term of the LOD distance. */
  lodCamH: TSLNode;
  /** CDLOD range multiplier (mirrors the CPU selector). */
  rangeK: TSLNode;
  time: TSLNode;
  fakeWet: TSLNode;
  sparkle: TSLNode;
  rippleAmp: TSLNode;
  wetDarken: TSLNode;
  albedo: TSLNode;
  highTide: TSLNode;
  swashTop: TSLNode;
  saturatedTop: TSLNode;
  filmTop: TSLNode;
  reefRelief: TSLNode;
  printFill: TSLNode;
  contactShadow: TSLNode;
  vegetation: TSLNode;
  debugView: TSLNode;
}

/** Where the material reads interaction data: state.sand() and its relief (mass - depression). */
export interface SandSource {
  sand(xz: TSLNode): TSLNode;
  height(xz: TSLNode): TSLNode;
  texel: number;
}

const norm2 = (x: number, z: number) => {
  const l = Math.hypot(x, z);
  return [x / l, z / l] as const;
};

export function createSandMaterial(ctx: GLContext, tx: SandTextures, u: SandUniforms, ground: Ground, src: SandSource) {
  const terrain = ctx.services.terrain;
  const atmos = ctx.services.atmosphere;

  const tDry = texture(tx.dryRipple.texture);
  const tWave = texture(tx.waveRipple.texture);
  const tSwash = texture(tx.swash.texture);
  const tGrain = texture(tx.grain.texture);
  const tMacro = texture(tx.macro.texture);
  const tAux = texture(tx.aux);
  const [ax0, az0, ax1, az1] = terrain.bounds;

  // Tile frames: dry ripples run across the wind; seabed ripples across the swell; swash marks
  // are shore-normal (+X).
  const [wdx, wdz] = norm2(WIND.dirX, WIND.dirZ);
  const [sdx, sdz] = norm2(SWELL.dirX, SWELL.dirZ);
  const toFrame = (xz: TSLNode, dx: number, dz: number, size: number) =>
    vec2(xz.x.mul(dx).add(xz.y.mul(dz)), xz.x.mul(-dz).add(xz.y.mul(dx))).div(size);
  /** Decode a tile's slope (tile axes) and rotate back to world XZ. */
  const slopeWorld = (s: TSLNode, range: number, dx: number, dz: number) => {
    const su = s.x.sub(0.5).mul(2 * range);
    const sv = s.y.sub(0.5).mul(2 * range);
    return vec2(su.mul(dx).sub(sv.mul(dz)), su.mul(dz).add(sv.mul(dx)));
  };
  /** Evaluate `body` only where `cond` holds (ALU-only bodies; textures inside use explicit LOD). */
  const branch = (cond: TSLNode, init: TSLNode, body: () => TSLNode): TSLNode =>
    Fn(() => {
      const v = init.toVar();
      If(cond, () => {
        v.assign(body());
      });
      return v;
    })();

  const auxUV = (xz: TSLNode) => xz.sub(vec2(ax0, az0)).div(vec2(ax1 - ax0, az1 - az0));
  const auxAt = (xz: TSLNode): TSLNode => tAux.sample(auxUV(xz)).level(float(0));

  /**
   * Reef structure: rounded coral heads (bommies) with knobbly tops, separated by grooves, over
   * a rough pavement with sand pockets where no head grew.
   * vec4(height m, head mask, cell id, sand pocket).
   */
  /** The field without the fine knobbles and relief scale: (height m, head mask, cell id, pocket). */
  const reefBase = (xz: TSLNode): TSLNode => {
    // Domain-warped cells (~1.7 m) so colonies don't sit on a visible lattice.
    const warp = vec2(mx_noise_float(vec3(xz.x.mul(0.45), xz.y.mul(0.45), 1.3)), mx_noise_float(vec3(xz.x.mul(0.45), xz.y.mul(0.45), 8.9))).mul(0.55);
    const v = voronoi2(xz.mul(0.6).add(warp));
    const isHead = smoothstep(0.28, 0.36, v.z);
    // Massive coral colony: a rounded dome whose radius varies per colony and with direction.
    const lobes = mx_noise_float(vec3(xz.x.mul(1.4), xz.y.mul(1.4), 2.2)).mul(0.1);
    const r = v.z.mul(0.2).add(0.3).add(lobes);
    const q = v.x.div(r);
    // Raised-cosine profile: rounded top, zero slope at the rim (no cliff for the grid to alias),
    // tapered to zero before the cell border so neighbouring cells never meet in a step.
    const dome = pow(max(float(1).sub(q.mul(q)), 0), 0.45).mul(smoothstep(1.0, 0.72, q)).mul(smoothstep(0.0, 0.18, v.y.sub(v.x)));
    const hh = v.z.mul(0.3).add(0.14);
    const head = dome.mul(hh).mul(isHead);
    // Between colonies: rubble pavement, and clean sand where the cell holds no colony.
    const pave = mx_noise_float(vec3(xz.x.mul(0.9), xz.y.mul(0.9), 5.3)).mul(0.06);
    // Sand pockets: continuous low-frequency patches (not per cell), where colonies don't grow.
    const pocket = smoothstep(0.1, 0.35, mx_noise_float(vec3(xz.x.mul(0.3), xz.y.mul(0.3), 4.7)));
    const h: TSLNode = head.mul(float(1).sub(pocket)).add(pave.mul(float(1).sub(pocket))).sub(pocket.mul(0.06));
    return (vec4 as TSLNode)(h, isHead.mul(smoothstep(0.0, 0.25, dome)).mul(float(1).sub(pocket)), v.z, pocket);
  };
  /** Brain/porites surface and fine pavement: the sub-25 cm detail the bake can't hold. */
  const reefFine = (xz: TSLNode, head: TSLNode, pocket: TSLNode): TSLNode => {
    const knob = mx_noise_float(vec3(xz.x.mul(5), xz.y.mul(5), 0.5)).mul(0.03).add(mx_noise_float(vec3(xz.x.mul(13), xz.y.mul(13), 3.1)).mul(0.012));
    const pave2 = mx_noise_float(vec3(xz.x.mul(4), xz.y.mul(4), 6.1)).mul(0.02);
    return knob.mul(head).add(pave2.mul(float(1).sub(pocket)));
  };
  // [polish] Bake the base field on the GPU once (reef-bake.ts); sample it afterwards.
  const rb = tx.reef;
  const [rx0, rz0, rx1, rz1] = REEF_BOUNDS;
  if (rb && !rb.baked) {
    const kernel = (Fn as unknown as (f: () => void) => () => { compute(d: number[], w: number[]): { setName(n: string): unknown } })(() => {
      const s = ivec2(globalId.xy);
      const xz = vec2(float(rx0).add(vec2(s).x.add(0.5).mul(REEF_TEXEL)), float(rz0).add(vec2(s).y.add(0.5).mul(REEF_TEXEL)));
      (textureStore as unknown as (...a: unknown[]) => { toWriteOnly(): void })(rb.tex, s, reefBase(xz)).toWriteOnly();
    })().compute([rb.w / 8, rb.h / 8, 1], [8, 8, 1]).setName('gl.beach.bakeReef');
    ctx.renderer.compute(kernel as never);
    rb.baked = true;
  }
  const reefT = rb ? texture(rb.tex) : null;
  // Manual bilinear from 4 loads: textureLoad needs no sampler (the fragment stage is at its 16).
  const reefBilinear = (xz: TSLNode): TSLNode => {
    const q = vec2(xz.x.sub(rx0).div(REEF_TEXEL).sub(0.5), xz.y.sub(rz0).div(REEF_TEXEL).sub(0.5));
    const i0 = clamp(floor(q), vec2(0, 0), vec2(rb!.w - 2, rb!.h - 2)).toVar();
    const f = clamp(q.sub(i0), 0, 1).toVar();
    const i = ivec2(i0).toVar();
    const L = (o: TSLNode) => (textureLoad as unknown as (...a: unknown[]) => TSLNode)(rb!.tex, i.add(o));
    return mix(mix(L(ivec2(0, 0)), L(ivec2(1, 0)), f.x), mix(L(ivec2(0, 1)), L(ivec2(1, 1)), f.x), f.y);
  };
  /** vec4(height m, head mask, cell id, sand pocket), relief-scaled; `fine` adds the knobbles. */
  const reefField = (xz: TSLNode, fine = true): TSLNode => {
    const b = (reefT ? reefBilinear(xz) : reefBase(xz)).toVar();
    const hF = fine ? b.x.add(reefFine(xz, b.y, b.w)) : b.x;
    return (vec4 as TSLNode)(hF.mul(u.reefRelief), b.y, b.z, b.w);
  };
  void rx1;
  void rz1;

  // Interaction relief, box-filtered over one state texel: the bilinear field convolved with a
  // texel-wide box is C1, so footprints get rounded walls instead of texel-aligned creases.
  const ht = src.texel * 0.5;
  const relief4 = (xz: TSLNode) => ({
    a: src.height(xz.add(vec2(ht, ht))),
    b: src.height(xz.add(vec2(ht, -ht))),
    c: src.height(xz.add(vec2(-ht, ht))),
    d: src.height(xz.add(vec2(-ht, -ht))),
  });

  const vN = varyingProperty('vec3', 'vTerrainN');
  const vDist = varyingProperty('float', 'vTerrainDist');

  const mat = new MeshPhysicalNodeMaterial();
  mat.name = 'goldenline.sand';

  /** CDLOD vertex position (morphed toward the coarser grid near the level's range). */
  const morphed = () => {
    const inst = attribute('iPatch', 'vec4');
    const grid = positionLocal.xz;
    const cell = inst.z;
    const o = inst.xy;
    const d0 = o.add(grid.mul(cell)).sub(u.lodCenter.xz);
    const dist = sqrt(dot(d0, d0).add(u.lodCamH.mul(u.lodCamH)));
    const range = exp2(inst.w).mul(u.rangeK).mul(S0);
    const k = clamp(dist.sub(range.mul(MORPH_START)).div(range.mul(MORPH_END - MORPH_START)), 0, 1);
    const odd = fract(grid.mul(0.5)).mul(2);
    return { xz: o.add(grid.sub(odd.mul(k)).mul(cell)).toVar(), dist };
  };

  mat.positionNode = Fn(() => {
    const { xz, dist } = morphed();
    // Height and gradient of the smooth base from the same 4 + 4 B-spline taps.
    const hg = ground.baseHG(xz).toVar();
    const h0 = hg.x;
    vN.assign(normalize(vec3(hg.y.negate(), 1, hg.z.negate())));
    vDist.assign(dist);

    // GPU detail that is large enough to be geometry.
    const near = float(1).sub(smoothstep(22, 46, dist));
    const under = float(1).sub(smoothstep(-0.7, -0.15, h0));
    const reef = auxAt(xz).r.mul(under);
    const waveW = under.mul(float(1).sub(reef)).mul(near);
    const wave = branch(waveW.greaterThan(0.001), float(0), () =>
      tWave.sample(toFrame(xz, sdx, sdz, tx.waveRipple.size)).level(float(0)).b.sub(0.5).mul(tx.waveRipple.amp).mul(waveW),
    );
    const reefH = branch(reef.greaterThan(0.002), float(0), () => reefField(xz).x.mul(reef));
    // Interaction relief only inside the state's sand window (51 m): skip it beyond.
    const relief = branch(dist.lessThan(30), float(0), () => {
      const r4 = relief4(xz);
      return r4.a.add(r4.b).add(r4.c).add(r4.d).mul(0.25);
    });
    const h = h0.add(wave).add(reefH).add(ground.dryDetail(xz, h0)).add(relief);
    const p = vec3(xz.x, h, xz.y);
    // The terrain is static in world space; tell the velocity pass so TRAA keeps its history.
    positionPrevious.assign(p);
    return p;
  })();

  // Shadow casters: the same morph and base, without the reef, seabed ripples or normals.
  mat.castShadowPositionNode = Fn(() => {
    const { xz, dist } = morphed();
    const h0 = ground.base(xz);
    const relief = branch(dist.lessThan(30), float(0), () => src.height(xz));
    return vec3(xz.x, h0.add(ground.dryDetail(xz, h0)).add(relief), xz.y);
  })();

  // ── Fragment ──
  const xz = positionWorld.xz;
  const y = positionWorld.y;
  const N0 = normalize(vN);
  const dist = vDist;

  const m1 = tMacro.sample(xz.div(tx.macro.size));
  const m2 = tMacro.sample(toFrame(xz, 0.8, 0.6, tx.macro.size / 4.9));
  const wob = m1.a.sub(0.5);
  const aux = auxAt(xz);

  // Wetness (state semantics) with the physical baseline on top.
  const under = float(1).sub(smoothstep(-0.3, 0.02, y.add(wob.mul(0.08))));
  const aboveW = float(1).sub(under);
  const sandS = src.sand(xz);
  const satBase = float(1).sub(smoothstep(u.saturatedTop.sub(0.25), u.saturatedTop, y.add(wob.mul(0.22)))).mul(0.9);
  // Post-swash film: a sheet up to filmTop, draining first in patches (the upper half breaks
  // into glossy pools and dull drying islands).
  const drain = mx_noise_float(vec3(xz.x.mul(0.35), xz.y.mul(0.22), 3.7)).mul(0.6).add(m2.a.sub(0.5).mul(0.5));
  const filmBase = float(1).sub(smoothstep(u.filmTop.sub(0.1), u.filmTop, y.add(wob.mul(0.08)).add(drain.max(0).mul(u.filmTop).mul(0.6))));
  const dampBase = float(1).sub(smoothstep(u.highTide.sub(0.35), u.highTide, y.add(wob.mul(0.35)))).mul(0.5);
  const fake = float(1).sub(smoothstep(u.swashTop.sub(0.45), u.swashTop, y.add(wob.mul(0.3)))).mul(0.9).mul(u.fakeWet);
  const wAll = max(max(sandS.x, satBase), max(max(dampBase, fake), filmBase));
  const w = max(wAll, under);
  const damp = smoothstep(0.08, 0.5, w);
  const sat = smoothstep(0.5, 0.88, w);
  const film = max(smoothstep(0.93, 0.985, wAll), filmBase).mul(aboveW);
  const dry = float(1).sub(damp);
  const reef: TSLNode = aux.r.mul(under);

  // Dune vegetation cover (baked in aux.b, shared with the grass/creeper instances), fringed.
  const veg: TSLNode = branch(aux.b.greaterThan(0.004).and(dry.greaterThan(0.01)), float(0), () => {
    const fringe = mx_noise_float(vec3(xz.x.mul(1.7), xz.y.mul(1.7), 2.9)).mul(0.22).add(mx_noise_float(vec3(xz.x.mul(6), xz.y.mul(6), 8.2)).mul(0.1));
    return smoothstep(0.22, 0.62, aux.b.add(fringe)).mul(u.vegetation).mul(dry);
  });
  const hasVeg = veg.greaterThan(0.002);

  // Wrack line band along the high-tide contour.
  const wy = y.sub(u.highTide).add(0.02).add(wob.mul(0.1));
  const wband = smoothstep(-0.14, -0.04, wy).mul(float(1).sub(smoothstep(0.0, 0.08, wy))).mul(aboveW);
  const hasWrack = wband.greaterThan(0.002);
  /** vec4(litter colour, amount). */
  const wrackOut = branch(hasWrack, vec4(0, 0, 0, 0), () => {
    // Windrows: stretched along the shore (z), broken into strands and gaps.
    const wn = mx_noise_float(vec3(xz.x.mul(4.5), xz.y.mul(0.6), 1.9)).add(mx_noise_float(vec3(xz.x.mul(14), xz.y.mul(3), 4.4)).mul(0.45));
    const gaps = smoothstep(-0.15, 0.25, mx_noise_float(vec3(xz.x.mul(0.3), xz.y.mul(0.35), 7.7)));
    // [polish] a lighter stain (0.8 → 0.5): up close the painted windrows read as blurred smudges
    const amount = smoothstep(0.25, 0.4, wn.add(wband.mul(0.4)).sub(0.45)).mul(wband).mul(gaps).mul(0.5);
    const fib = mx_noise_float(vec3(xz.x.mul(60), xz.y.mul(22), 2.0)).mul(0.5).add(0.5);
    return vec4(mix(vec3(0.14, 0.1, 0.055), vec3(0.36, 0.26, 0.13), smoothstep(0.35, 0.85, fib)), amount);
  });
  const wrack = wrackOut.w;
  const wrackBump = branch(hasWrack, vec3(0, 0, 0), () => mx_noise_vec3(vec3(xz.x.mul(30), xz.y.mul(30), 6.6)).mul(0.6).mul(wrack));

  // Slopes (world XZ, dh/dx, dh/dz).
  // [polish] The dry-ripple and swash tiles only matter above the water: under it (most of the
  // lineup's frame, fully shaded because the water's refraction copy breaks the render pass) they
  // were four wasted taps per pixel. Sampled with explicit gradients inside branches.
  const uvD1 = toFrame(xz, wdx, wdz, tx.dryRipple.size).toVar();
  const [w2x, w2z] = norm2(wdx * 0.99 - wdz * 0.14, wdz * 0.99 + wdx * 0.14);
  const uvD2 = toFrame(xz.add(vec2(13.7, 5.1)), w2x, w2z, tx.dryRipple.size * 1.13).toVar();
  const uvS1 = toFrame(xz, 1, 0, tx.swash.size).toVar();
  const uvS2 = toFrame(xz.add(vec2(3.1, 7.7)), 0.96, 0.28, tx.swash.size * 1.37).toVar();
  const gD1x = dFdx(uvD1).toVar();
  const gD1y = dFdy(uvD1).toVar();
  const gD2x = dFdx(uvD2).toVar();
  const gD2y = dFdy(uvD2).toVar();
  const gS1x = dFdx(uvS1).toVar();
  const gS1y = dFdy(uvS1).toVar();
  const gS2x = dFdx(uvS2).toVar();
  const gS2y = dFdy(uvS2).toVar();
  const pick = smoothstep(0.42, 0.58, m2.r);
  /** vec4(dry slope xz, ripple cavity, 0). */
  const dryOut = branch(dry.greaterThan(0.001), vec4(0, 0, 0.5, 0), () => {
    const dr1 = tDry.sample(uvD1).grad(gD1x, gD1y);
    const dr2 = tDry.sample(uvD2).grad(gD2x, gD2y);
    const sd = mix(slopeWorld(dr1, tx.dryRipple.slopeRange, wdx, wdz), slopeWorld(dr2, tx.dryRipple.slopeRange, w2x, w2z), pick);
    return vec4(sd, mix(dr1.a, dr2.a, pick), 0);
  });
  const sDry = dryOut.xy;
  const cavity = dryOut.z;
  // Ripples live on the flat, dry upper beach; the beach face and damp sand are trampled smooth.
  const rippleW = dry.mul(smoothstep(0.05, 0.6, m1.g.add(0.35))).mul(u.rippleAmp);

  /** vec4(swash slope xz, chip mask, 0). */
  const swOut = branch(aboveW.greaterThan(0.001), vec4(0, 0, 0.5, 0), () => {
    const sw = tSwash.sample(uvS1).grad(gS1x, gS1y);
    const sw2 = tSwash.sample(uvS2).grad(gS2x, gS2y);
    const ss = mix(slopeWorld(sw, tx.swash.slopeRange, 1, 0), slopeWorld(sw2, tx.swash.slopeRange, 0.96, 0.28), smoothstep(0.4, 0.6, m1.r));
    return vec4(ss, sw.a, 0);
  });
  const sSwash = swOut.xy;
  const sw = { a: swOut.z };
  const wvS = tWave.sample(toFrame(xz, sdx, sdz, tx.waveRipple.size));
  const sWave = slopeWorld(wvS, tx.waveRipple.slopeRange, sdx, sdz);

  const g1 = tGrain.sample(xz.div(tx.grain.size));
  const g2 = tGrain.sample(toFrame(xz, 0.6, 0.8, tx.grain.size * 0.37));
  const sGrain = slopeWorld(g1, tx.grain.slopeRange, 1, 0).add(slopeWorld(g2, tx.grain.slopeRange, 0.6, 0.8)).mul(0.5);

  // Footprints and other interaction relief: gradient of the box-filtered field (4 taps).
  // [polish] Only where there can be prints (above water, inside the state's sand window): under
  // the lineup's water these 4 taps ran for every seabed pixel.
  const sFoot = branch(aboveW.greaterThan(0.01).and(dist.lessThan(34)), vec2(0, 0), () => {
    const r4 = relief4(xz);
    return vec2(r4.a.add(r4.b).sub(r4.c).sub(r4.d), r4.a.add(r4.c).sub(r4.b).sub(r4.d)).div(4 * ht);
  });

  // Reef (only where there is reef): the field, and its per-pixel gradient + coral knobbles.
  const hasReef = reef.greaterThan(0.002).and(u.reefRelief.greaterThan(0.001));
  const rf = branch(hasReef, vec4(0, 0, 0, 0), () => reefField(xz));
  // [polish] The finite-difference gradient (2 more reef-field evaluations: warped Voronoi + ~9
  // noises each) only near the camera; beyond ~28 m, through the water, the knobbles are sub-pixel
  // and the refraction blurs them. It was ≈ 5 ms of the lineup frame on the M3 at 720p.
  const reefPert = branch(hasReef.and(dist.lessThan(28)), vec3(0, 0, 0), () => {
    const re = 0.05;
    const gx = reefField(xz.add(vec2(re, 0))).x.sub(rf.x).div(re);
    const gz = reefField(xz.add(vec2(0, re))).x.sub(rf.x).div(re);
    const coral = mx_noise_vec3(vec3(xz.x.mul(7), xz.y.mul(7), 2.1)).mul(0.3).mul(rf.y);
    return vec3(gx.negate(), 0, gz.negate()).add(coral).mul(reef).mul(smoothstep(28, 20, dist));
  });

  const smoothBy = float(1).sub(film.mul(0.92));
  const drySlope = sDry.mul(rippleW);
  const microW = damp.mul(0.85).add(0.15).mul(aboveW);
  const wetSlope = sSwash.mul(microW);
  const seaSlope = sWave.mul(under).mul(float(1).sub(reef.mul(float(1).sub(rf.w))));
  const grainSlope = sGrain.mul(mix(float(1), float(0.45), sat)).mul(smoothstep(60, 8, dist).mul(0.8).add(0.2));
  const slope = drySlope.add(wetSlope).add(seaSlope).add(grainSlope).mul(smoothBy).mul(float(1).sub(wrack)).add(sFoot);

  // Vegetation (only where it grows): plants as discrete ~35 cm cells whose presence follows the
  // cover, so fringes break into scattered clumps and dense cover merges into a mat.
  /** vec4(plant colour, plant amount). */
  const vegOut = branch(hasVeg, vec4(0, 0, 0, 0), () => {
    const pv = voronoi2(xz.mul(2.9));
    const lc = voronoi2(xz.mul(9));
    const plant = step(pv.z, veg.mul(1.15)).mul(float(1).sub(smoothstep(0.35, 0.75, pv.x)).mul(0.6).add(smoothstep(0.7, 0.95, veg).mul(0.4)).min(1));
    const leafTone = mx_noise_float(vec3(xz.x.mul(1.3), xz.y.mul(1.3), 5.5)).mul(0.5).add(0.5);
    const dryPatch = mx_noise_float(vec3(xz.x.mul(0.21), xz.y.mul(0.21), 7.1));
    const vegCol = mix(mix(vec3(0.045, 0.07, 0.025), vec3(0.095, 0.11, 0.04), leafTone), vec3(0.2, 0.17, 0.085), smoothstep(0.45, 0.9, dryPatch.add(0.3)).mul(0.7));
    const cluster = float(1).sub(smoothstep(0.15, 0.75, lc.x));
    const shade = mix(float(0.35), float(1.05), cluster).mul(mix(float(0.7), float(1), float(1).sub(pv.x)));
    return vec4(vegCol.mul(shade), plant);
  });
  // Geometry carries it within ~6 m; from there the painted mat fades in under the instances
  // (so the mat still reads at 15-30 m, where single leaves are sub-pixel).
  const farVeg = smoothstep(5, 16, dist).mul(0.65).add(smoothstep(24, 40, dist).mul(0.35));
  const leafN = branch(hasVeg, vec3(0, 0, 0), () => mx_noise_vec3(vec3(xz.x.mul(14), xz.y.mul(14), 0.7)).mul(0.45));

  // A standing film levels itself: its surface is flatter than the sand slope under it (on the
  // 1:6 foreshore the bare slope would tilt the mirror away from the viewer and reflect the sea).
  const N0f = normalize(mix(N0, vec3(0, 1, 0), film.mul(0.75)));
  const Nsand = normalize(N0f.add(vec3(slope.x.negate(), 0, slope.y.negate())).add(reefPert).add(wrackBump));
  const N = normalize(mix(Nsand, normalize(N0.add(leafN)), vegOut.w.mul(0.8).mul(farVeg)));
  mat.normalNode = cameraViewMatrix.mul(vec4(N, 0)).xyz;

  // Albedo: bright coral sand, darkening and saturating with water content.
  const base = u.albedo;
  const speck = mix(float(1), g1.b.mul(2), 0.55);
  const drift = m1.r.sub(0.5).mul(0.22).add(1);
  const shellTint = mix(vec3(1, 1, 1), vec3(1.06, 0.97, 0.93), m2.g);
  const chips = mix(float(1), sw.a.mul(0.45).add(0.77), damp.mul(0.8));
  const dryCol = base.mul(speck).mul(drift).mul(shellTint).mul(mix(float(1), cavity.mul(0.25).add(0.8), rippleW));
  const dampCol = pow(dryCol, vec3(1.25)).mul(0.45).mul(chips);
  const satCol = pow(dryCol, vec3(1.45)).mul(u.wetDarken).mul(chips);
  let col: TSLNode = mix(dryCol, dampCol, damp);
  col = mix(col, satCol, sat);

  // Foam residue at the drying edge of the swash: the bubble-wall network (Voronoi borders).
  const edge = smoothstep(0.66, 0.76, wAll).mul(float(1).sub(smoothstep(0.8, 0.88, wAll))).mul(aboveW);
  const residue = branch(edge.greaterThan(0.002), float(0), () => {
    // Bubble walls only in scattered patches (where the last bore left foam), thin and faint.
    const patch = smoothstep(0.25, 0.55, mx_noise_float(vec3(xz.x.mul(0.9), xz.y.mul(0.5), 4.0)).add(m2.a.sub(0.5).mul(0.6)));
    const wf = voronoi2(xz.mul(34));
    const lace = float(1).sub(smoothstep(0.0, 0.05, wf.y.sub(wf.x)));
    return edge.mul(lace).mul(patch).mul(0.45);
  });
  col = mix(col, vec3(0.78, 0.76, 0.7), residue);

  // Reef: per-head palette (dead coral ochre, algae olive, dusty violet, pale bleached), dark
  // grooves, turf-brown pavement, white sand in the pockets.
  const reefCol = branch(hasReef, vec3(0, 0, 0), () => {
    const id = rf.z;
    // Porites ochre, algae olive, dusky violet, brown, and the odd pale (bleached) colony.
    const palA = mix(vec3(0.25, 0.16, 0.07), vec3(0.11, 0.13, 0.045), smoothstep(0.4, 0.55, id));
    const palB = mix(vec3(0.19, 0.1, 0.16), vec3(0.16, 0.11, 0.06), smoothstep(0.7, 0.8, id));
    let headCol: TSLNode = mix(palA, palB, smoothstep(0.58, 0.68, id));
    headCol = mix(headCol, vec3(0.42, 0.39, 0.33), smoothstep(0.965, 0.985, id));
    const turf = vec3(0.1, 0.085, 0.045).mul(mx_noise_float(vec3(xz.x.mul(3), xz.y.mul(3), 9.1)).mul(0.35).add(1));
    const coralTex = mx_noise_float(vec3(xz.x.mul(13), xz.y.mul(13), 4.4)).mul(0.3).add(0.9);
    const c0 = mix(turf, headCol.mul(coralTex), smoothstep(0.02, 0.3, rf.y));
    return mix(c0, satCol, rf.w);
  });
  col = mix(col, reefCol, reef);
  // Within the instance draw distance the plants are real geometry: the ground there is sand
  // stained with organic litter and shaded by the mat; farther out the painted cover takes over.
  const litter = mix(float(0.62), float(0.9), smoothstep(0.3, 0.7, g1.b));
  col = mix(col, col.mul(litter).mul(vec3(0.95, 0.93, 0.85)), vegOut.w.mul(float(1).sub(farVeg)));
  col = mix(col, vegOut.xyz, vegOut.w.mul(farVeg));
  col = mix(col, wrackOut.xyz, wrack.mul(0.92));

  // Debug views (beach.debugView): 1 = wetness bands (R damp, G saturated, B film), 2 = reef.
  const dbgZones: TSLNode = (vec3 as TSLNode)(damp, sat, film);
  const dbgReef: TSLNode = (vec3 as TSLNode)(reef, rf.y, rf.w);
  col = mix(col, dbgZones, u.debugView.equal(1).select(float(1), float(0)));
  col = mix(col, dbgReef, u.debugView.equal(2).select(float(1), float(0)));
  mat.colorNode = vec4(col, 1);

  // Roughness: dry grains are matte; water fills the pores; the film is a near mirror.
  const glint = g1.a.max(g2.a).mul(dry).mul(u.sparkle).mul(smoothstep(40, 4, dist));
  let rough: TSLNode = mix(float(0.95), float(0.8), damp);
  rough = mix(rough, float(0.42), sat.mul(aboveW));
  rough = mix(rough, mix(float(0.03), float(0.09), smoothstep(0.3, 0.8, g1.b)), film);
  rough = mix(rough, float(0.62), under);
  rough = mix(rough, float(0.12), glint);
  rough = mix(rough, float(0.62), vegOut.w.mul(farVeg));
  mat.roughnessNode = rough;
  mat.metalnessNode = float(0);
  // Dry sand is a back-scatterer: grains shadow each other, so the forward specular lobe GGX
  // predicts at grazing angles barely exists. Water filling the pores brings it back.
  mat.specularIntensityNode = mix(mix(mix(float(0.18), float(0.5), damp), float(1), max(sat, film)).mul(aboveW).add(under), float(0.45), vegOut.w);

  // SSR opt-in for the film and saturated sand: weight = the env-reflection share (Fresnel).
  const V = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(max(dot(N, V), 0)), 5).mul(0.96).add(0.04);
  mat.mrtNode = ssrOptIn(fres.mul(max(film, sat.mul(0.5))).mul(aboveW), rough);

  // Contact shadows: march the interaction heightfield toward the sun (footprints self-shadow;
  // the shadow map can't resolve a 2 cm hollow). Near the camera only.
  const sun = atmos.sunDirNode;
  // [polish] never under water (the seabed has no prints; 11 state taps per pixel there)
  const contact = branch(dist.lessThan(16).and(u.contactShadow.greaterThan(0)).and(aboveW.greaterThan(0.01)), float(1), () => {
    const sd = normalize(vec2(sun.x, sun.z));
    const tanEl = sun.y.div(max(length(vec2(sun.x, sun.z)), 1e-3));
    const h0 = src.height(xz);
    let occ: TSLNode = float(0);
    for (let i = 1; i <= 10; i++) {
      const d = i * 0.017;
      const hs = src.height(xz.add(sd.mul(d)));
      occ = max(occ, smoothstep(0.0, 0.0025, hs.sub(h0).sub(tanEl.mul(d))));
    }
    return float(1).sub(occ.mul(smoothstep(16, 10, dist)).mul(u.contactShadow));
  });
  (mat as unknown as { receivedShadowNode: unknown }).receivedShadowNode = Fn(([shadow]: [TSLNode]) => shadow.mul(contact));

  // [polish] Sky fill in footprint hollows: the floor of a 2 cm print still sees most of the sky
  // dome, but the IBL (one irradiance for the whole beach) and the contact shadow left it
  // blue-black. A little lavender sky light on the depressed sand keeps it reading as shadowed sand.
  const printFill = branch(aboveW.greaterThan(0.01).and(dist.lessThan(30)), float(0), () => smoothstep(0.002, 0.012, src.height(xz).negate()));
  // (a uniform tint, not skyRadiance(): the fragment stage is at its 16-sampler limit)
  const skyFill = vec3(0.5, 0.56, 0.8).mul(dot(vec3(atmos.sunColorNode), vec3(0.3, 0.5, 0.2))).mul(col).mul(printFill).mul(u.printFill);
  const caustics = getCausticsHook();
  mat.emissiveNode = caustics ? caustics(positionWorld, N, col).mul(under).add(skyFill) : skyFill;

  return mat;
}

export interface SandParams {
  u: SandUniforms;
  /** Copy param values into the uniforms (per frame, zero-alloc). */
  sync(): void;
}

export function makeSandUniforms(ctx: GLContext, stateIsStub: boolean): SandParams {
  const p = ctx.params;
  const g = 'beach';
  const fake = p.toggle('beach.fakeWet', { label: 'fake swash band (no state)', group: g, value: stateIsStub });
  const sparkle = p.number('beach.sparkle', { label: 'grain sparkle', group: g, min: 0, max: 2, value: 1 });
  const ripple = p.number('beach.ripples', { label: 'wind ripples', group: g, min: 0, max: 2, value: 1 });
  const wetDarken = p.number('beach.wetDarken', { label: 'wet darkening', group: g, min: 0.2, max: 1, value: 0.3 });
  const printFill = p.number('beach.printFill', { label: 'footprint sky fill (polish)', group: g, min: 0, max: 1, value: 0.1 });
  const alb = p.number('beach.albedo', { label: 'sand albedo', group: g, min: 0.2, max: 1, value: 0.62 });
  const highTide = p.number('beach.highTide', { label: 'high-tide mark (m)', group: g, min: 0.4, max: 3, value: 1.45 });
  const swashTop = p.number('beach.swashTop', { label: 'fake swash top (m)', group: g, min: 0, max: 2, value: 0.75 });
  const satTop = p.number('beach.saturatedTop', { label: 'saturated strip top (m)', group: g, min: 0, max: 1.5, value: 0.65 });
  const filmTop = p.number('beach.filmTop', { label: 'glossy film top (m)', group: g, min: 0, max: 1.2, value: 0.62 });
  const reefRelief = p.number('beach.reefRelief', { label: 'reef relief', group: g, min: 0, max: 2, value: 1 });
  const contact = p.number('beach.contactShadow', { label: 'footprint contact shadow', group: g, min: 0, max: 1, value: 1 });
  const vegetation = p.number('beach.vegetation', { label: 'dune vegetation', group: g, min: 0, max: 1, value: 1 });
  const debugView = p.number('beach.debugView', { label: 'debug view (1 wet, 2 reef)', group: g, min: 0, max: 2, step: 1, value: 0 });
  const tint = new Vector3(1, 0.9, 0.74);
  const u: SandUniforms = {
    lodCenter: uniform(new Vector3()),
    lodCamH: uniform(0),
    rangeK: uniform(RANGE_K),
    time: uniform(0),
    fakeWet: uniform(0),
    sparkle: uniform(0),
    rippleAmp: uniform(0),
    wetDarken: uniform(0),
    albedo: uniform(new Vector3()),
    highTide: uniform(0),
    swashTop: uniform(0),
    saturatedTop: uniform(0),
    filmTop: uniform(0),
    reefRelief: uniform(0),
    printFill: uniform(0.05),
    contactShadow: uniform(0),
    vegetation: uniform(0),
    debugView: uniform(0),
  };
  const sync = () => {
    u.fakeWet.value = fake.value ? 1 : 0;
    u.sparkle.value = sparkle.value;
    u.rippleAmp.value = ripple.value;
    u.wetDarken.value = wetDarken.value;
    (u.albedo.value as Vector3).copy(tint).multiplyScalar(alb.value);
    u.highTide.value = highTide.value;
    u.swashTop.value = swashTop.value;
    u.saturatedTop.value = satTop.value;
    u.filmTop.value = filmTop.value;
    u.reefRelief.value = reefRelief.value;
    u.printFill.value = printFill.value;
    u.contactShadow.value = contact.value;
    u.vegetation.value = vegetation.value;
    u.debugView.value = debugView.value;
  };
  sync();
  return { u, sync };
}
