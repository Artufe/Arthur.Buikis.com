// The GOLDENLINE water material: one node graph, lit through a custom lighting model so the
// sun arrives with its cascaded shadow (the pier's shadow darkens glitter, SSS and in-scatter).
//
//   direct (sun, shadowed):   GGX glitter with variance roughness, soft-kneed · SSS through thin
//                             crests (thickness × view × sun) · sun in-scatter of the water body ·
//                             sunlit foam
//   indirect (everything else): Fresnel sky reflection (SSR replaces it where the screen has the
//                             hit) · refracted seabed with per-channel Beer–Lambert along the
//                             refracted path · sky in-scatter · sky-lit foam
//
// Everything a lighting term needs is computed once in prepare() (colorNode stage) and read
// by the lighting model, so the graph is shared by the ocean surface and (A8) breaker meshes.

import { LightingModel, NodeMaterial, NoBlending, DoubleSide, type Texture } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { AtmosphereService, SurfaceStateService, TerrainService, TSLNode } from '../core/contracts';
import { GLOBAL_DRIFT } from '../state/shared';
import { WIND } from '../world/layout';
import { WATER_IOR } from './caustics';
import { refractScene, seabedHeight, type Refraction } from './refraction';
import { foamLayer, foamTestRamp } from './foam';
import { seabedVisibility } from './occluder';
import { glintFactor, glintFootprint } from './glitter';
import { jacobianFromDD, normalFromDD, surfaceSlopes, type SlopeSources } from './slopes';

const {
  Fn, If, clamp, dFdx, dFdy, dot, exp, float, fract, length, log2, max, mix, mrt, normalize, pow, reflect, refract, select, smoothstep, sqrt, texture, vec2, vec3, vec4, saturate,
} = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { positionWorld, cameraPosition, cameraViewMatrix, cameraWorldMatrix } = TSL as unknown as Record<string, TSLNode>;

export interface WaterUniforms {
  absorb: TSLNode; // vec3, /m
  backscatter: TSLNode; // vec3, /m (b_b)
  turbidity: TSLNode; // extra (flat) scattering, /m
  lagoon: TSLNode; // extra particle backscatter in the shallows (×0.006 /m)
  throughPath: TSLNode;
  seabedGain: TSLNode;
  sss: TSLNode;
  sssFloor: TSLNode;
  sssForward: TSLNode;
  sssScatter: TSLNode;
  glitter: TSLNode;
  glitterKnee: TSLNode;
  glintAmount: TSLNode;
  glintCap: TSLNode;
  glintSize: TSLNode;
  glintCells: TSLNode;
  glintTau: TSLNode;
  roughness: TSLNode;
  varScale: TSLNode;
  reflection: TSLNode;
  refraction: TSLNode;
  dispersion: TSLNode;
  foam: TSLNode;
  foamTest: TSLNode;
  whitecaps: TSLNode;
  boreFoam: TSLNode;
  slicks: TSLNode;
  micro: TSLNode;
  horizonLift: TSLNode;
  reflBlur: TSLNode;
  time: TSLNode;
  ssrFade: TSLNode;
  ssrGrazing: TSLNode;
  /** Seabed culled (occluder.ts) beyond this smoothed depth (m) and distance (m). */
  deepCull: TSLNode;
  farCull: TSLNode;
  debug: TSLNode;
  debugGain: TSLNode;
  /** 1 / cos of the refracted sun angle: vertical depth → sun path length under water. */
  sunPath: TSLNode;
}

export interface WaterSurfaceInputs {
  /** Rest (undisplaced) XZ, depth, brokenness: the ocean's varyings. */
  rest: TSLNode;
  depth: TSLNode;
  broken: TSLNode;
  swellDD: TSLNode;
  swellDXZ: TSLNode;
  fftGain: TSLNode;
  /** (SSS path m, provider steepness or −1, wave dir x, z): water/thickness.ts. */
  thickness: TSLNode;
  /** Horizontal chord through the crest (m). */
  chord: TSLNode;
  /**
   * Optional world-space geometric normal (breaker meshes): the FFT detail is applied on top of
   * it instead of building the normal from the swell derivatives.
   */
  baseNormal?: TSLNode;
  /** [breaking] Optional extra foam (vec2 coverage 0-1, age 0-1) on top of state.foam(): whitewater. */
  foam?: TSLNode;
  /**
   * [breaking] With baseNormal: the unit surface tangent that rest-space +thickness.zw (the wave
   * direction) maps to. The sea's slopes are then applied in the surface's own frame, so a
   * vertical breaker face keeps its chop instead of losing it to the horizontal frame.
   */
  baseTangent?: TSLNode;
  /** [breaking] Scale of the foam's own structure (1 = open-water lace; > 1 = finer, e.g. swash). */
  foamScale?: TSLNode;
  /** [breaking] 0-1 gain on state.foam() (0 inside a breaker's tube, where the state's rest-space foam doesn't belong). */
  foamStateGain?: TSLNode;
  /**
   * [breaking] Radiance reflected where the mirror direction points below the horizon (a breaker's
   * lip seen from inside the tube reflects the water, not the sky; open water clamps to the horizon).
   */
  underReflect?: TSLNode;
  /**
   * [look] Bubbles and stirred-up sand in a breaking wave (0 = clear lagoon, ~1 = heavily aerated).
   * Veils the seabed seen through the face and turns the body milky; the thin lip's own
   * through-light is left alone.
   */
  aeration?: TSLNode;
  /**
   * [breaking] 0-1: let the chop's facets modulate the transmitted (SSS) glow. Light leaving a
   * backlit face refracts through the facets, so facets turned toward the viewer glow brighter;
   * without this a face lit mostly by SSS reads as smooth glass.
   */
  sssTexture?: TSLNode;
  /**
   * [breaking] Extra isotropic scattering in the SSS phase (× 1/4π): a thin, aerated breaker lip
   * multiple-scatters, so it glows seen from any side (the tube ceiling), not only toward the sun.
   */
  sssDiffuse?: TSLNode;
}

export interface WaterDeps {
  /** Debug (boot only): bitmask of features to leave out of the shader, for cost ablation. */
  ablate: number;
  u: WaterUniforms;
  atmos: AtmosphereService;
  terrain: TerrainService;
  state: () => SurfaceStateService;
  slopeSrc: SlopeSources;
  refraction: Refraction;
  foamTex: Texture;
  noiseTex: Texture;
  surface: WaterSurfaceInputs;
}

/** The per-pixel quantities the lighting model reads. */
interface Shading {
  N: TSLNode;
  V: TSLNode;
  NdV: TSLNode;
  F: TSLNode;
  alpha: TSLNode;
  foamA: TSLNode;
  foamAlb: TSLNode;
  foamN: TSLNode;
  foamGlint: TSLNode;
  glint: TSLNode;
  bodyR: TSLNode; // vec3: water-column reflectance × (1 − seabed transmittance), per π
  thick: TSLNode; // light path through the crest toward the sun (m)
  sssGain: TSLNode;
  /** [breaking] extra isotropic SSS phase (see WaterSurfaceInputs.sssDiffuse). */
  sssIso: TSLNode;
  shore: TSLNode;
  shadowFar: TSLNode;
  indirect: TSLNode;
  ssrWeight: TSLNode;
  debug: TSLNode;
  debugOn: TSLNode;
}

const PI = Math.PI;

/** Water meshes (ocean surface, breakers) render after other opaques and before the sky dome. */
export const WATER_RENDER_ORDER = 1e5;

/** Exact unpolarised Fresnel reflectance, air → water. */
export function fresnelWater(cosI: TSLNode) {
  const c = clamp(cosI, 1e-4, 1);
  const g = sqrt(float(WATER_IOR * WATER_IOR - 1).add(c.mul(c)));
  const a = g.sub(c).div(g.add(c));
  const b = c.mul(g.add(c)).sub(1).div(c.mul(g.sub(c)).add(1));
  return a.mul(a).mul(0.5).mul(b.mul(b).add(1));
}

function ggxD(NdH: TSLNode, a: TSLNode) {
  const a2 = a.mul(a);
  const d = NdH.mul(NdH).mul(a2.sub(1)).add(1);
  return a2.div(d.mul(d).mul(PI));
}

function smithVis(NdV: TSLNode, NdL: TSLNode, a: TSLNode) {
  const a2 = a.mul(a);
  const gv = NdL.mul(sqrt(NdV.mul(NdV).mul(a2.oneMinus()).add(a2)));
  const gl = NdV.mul(sqrt(NdL.mul(NdL).mul(a2.oneMinus()).add(a2)));
  return float(0.5).div(max(gv.add(gl), 1e-5));
}

/** Henyey–Greenstein phase. */
function hg(cosT: TSLNode, g: number) {
  const g2 = g * g;
  return float((1 - g2) / (4 * PI)).div(pow(max(float(1 + g2).sub(cosT.mul(2 * g)), 1e-4), 1.5));
}

class WaterLightingModel extends LightingModel {
  constructor(private readonly s: () => Shading, private readonly u: WaterUniforms, private readonly sunColor: TSLNode) {
    super();
  }

  direct(data: unknown) {
    const input = data as { lightDirection: TSLNode; lightColor: TSLNode; reflectedLight: { directSpecular: TSLNode; directDiffuse: TSLNode } };
    const s = this.s();
    const u = this.u;
    const L = normalize(cameraWorldMatrix.mul(vec4(input.lightDirection, 0)).xyz).toVar();
    // The sun arrives shadowed (CSM). Far out the last cascade is too coarse for the long grazing
    // shadows of distant casters (they break into patches), so the water lets go of them there.
    const E = mix(vec3(input.lightColor), vec3(this.sunColor), s.shadowFar).toVar();
    const N = s.N;
    const V = s.V;
    const NdL = max(dot(N, L), 0);
    // Glitter: GGX with the filtered-away slope variance in the roughness, widened by the sun's disc.
    const a = sqrt(s.alpha.mul(s.alpha).add(0.0055 * 0.0055)).toVar();
    const H = normalize(L.add(V));
    const NdH = max(dot(N, H), 0);
    const VdH = max(dot(V, H), 0);
    const spec = E.mul(ggxD(NdH, a).mul(smithVis(s.NdV, max(NdL, 1e-4), a)).mul(fresnelWater(VdH)).mul(NdL).mul(u.glitter)).toVar();
    // Soft knee on the peak channel (hue preserved) for the smooth lobe; the glint factor (mean 1)
    // then redistributes that energy into sparks, which get their own, much higher roll-off.
    const pk = max(max(spec.x, spec.y), spec.z);
    const specS = spec.mul(u.glitterKnee.div(u.glitterKnee.add(pk))).mul(s.glint).toVar();
    const pk2 = max(max(specS.x, specS.y), specS.z);
    const specK = specS.mul(u.glintCap.div(u.glintCap.add(pk2)));
    const water = s.foamA.oneMinus();
    const Ft = s.F.oneMinus();
    // Sun into the water column: transmitted through the surface, then scattered back up.
    const mu = max(L.y, 0.02);
    const Fsun = fresnelWater(mu);
    const cosV = dot(V, L.negate());
    // Body light scatters between the refracted sun and refracted view rays (≈ 85–180° here),
    // not between the rays in air: forward scattering barely reaches it.
    const Ts = refract(L.negate(), N, 1 / WATER_IOR);
    const Tv = refract(V.negate(), N, 1 / WATER_IOR);
    const phase = float(0.55).add(hg(dot(Ts, Tv.negate()), 0.7).mul(1.6));
    const body = E.mul(mu).mul(Fsun.oneMinus()).mul(s.bodyR).mul(phase);
    // SSS: sunlight that entered the back of a crest, crossed `path` metres of water and scattered
    // toward the viewer: σs·w·exp(−(σa+σs)·w) per channel. It peaks at a path of about a metre
    // (gold), turns green as red is absorbed over longer chords, and dies in thick water; the
    // forward lobe keeps it on the backlit side, `sssFace` on faces turned away from the sun.
    const sss = vec3(0).toVar();
    // [breaking] sssIso (thin aerated lips) glows from any side, so it isn't gated by the face term.
    If(s.sssGain.greaterThan(1e-3).or(s.sssIso.greaterThan(1e-3)), () => {
      const path = s.thick;
      // In-crest scattering is a little bluer than flat (water molecules + fine particles), which
      // pushes long paths from gold toward green.
      const sigS = vec3(0.85, 1, 1.12).mul(u.sssScatter);
      const tr = exp(vec3(u.absorb).add(u.turbidity).add(sigS).mul(path).negate());
      // Particle scattering is sharply forward (the glow concentrates around the sun behind the
      // crest), molecular scattering fills in the rest.
      const sssPhase = hg(cosV, 0.88).mul(u.sssForward).add(hg(cosV, 0.3).mul(float(1).sub(u.sssForward))).add(0.01);
      sss.assign(E.mul(tr).mul(sigS.mul(path)).mul(sssPhase.mul(s.sssGain).add(s.sssIso.mul(u.sss).mul(1 / (4 * PI)))));
    });
    const foam = vec3(0).toVar();
    If(s.foamA.greaterThan(1e-3), () => {
      // Foam is a volume of bubbles: lit from many angles, brighter than a Lambert sheet at a low sun.
      const fN = s.foamN;
      // [look] Multiple scattering in a bubble volume: nearly isotropic, and strongly forward
      // scattering when the sun is behind it (most shots look into the sun). A Lambert-ish sheet
      // under an 11° sun went beige.
      const vol = max(dot(fN, L), 0).mul(0.45).add(0.55);
      foam.assign(E.mul(s.foamAlb).mul(vol.mul(1.25 / PI).add(hg(cosV, 0.55).mul(0.32))));
      // A wet sheen on the foam and sharp glints off bubble rims (both through the soft knee).
      const fH = max(dot(fN, H), 0);
      const sheen = ggxD(fH, float(0.28)).mul(smithVis(max(dot(fN, V), 1e-3), max(dot(fN, L), 1e-4), float(0.28))).mul(fresnelWater(VdH)).mul(max(dot(fN, L), 0));
      const glint = pow(fH, 900).mul(s.foamGlint).mul(6);
      const fspec = E.mul(sheen.add(glint)).mul(u.glitter);
      const fpk = max(max(fspec.x, fspec.y), fspec.z);
      foam.addAssign(fspec.mul(u.glitterKnee.div(u.glitterKnee.add(fpk))));
    });
    input.reflectedLight.directSpecular.addAssign(specK.mul(water).mul(s.shore));
    input.reflectedLight.directDiffuse.addAssign(body.add(sss).mul(Ft).mul(water).add(foam.mul(s.foamA)));
  }

  indirect(builder: unknown) {
    const ctx = (builder as { context: { reflectedLight: { indirectDiffuse: TSLNode } } }).context;
    ctx.reflectedLight.indirectDiffuse.addAssign(this.s().indirect);
  }
}

export class WaterMaterial extends NodeMaterial {
  private shading: Shading | null = null;
  private readonly deps: WaterDeps;

  constructor(deps: WaterDeps) {
    super();
    this.deps = deps;
    this.name = 'water';
    this.lights = true;
    this.fog = false;
    this.side = DoubleSide;
    // Opaque, drawn at renderOrder WATER_RENDER_ORDER: after every other opaque (so the refraction
    // copy holds the seabed, reef and pilings) but BEFORE the sky dome (renderOrder 1e6), which
    // only shades what is still at the far plane. In the transparent list the dome would shade
    // every pixel behind the water first (≈ 5 ms at 1440p on the M3).
    this.transparent = false;
    this.blending = NoBlending;
    this.depthWrite = true;
    this.colorNode = Fn(() => {
      this.getShading();
      return vec4(1, 1, 1, 1);
    })();
    this.normalNode = Fn(() => {
      const s = this.getShading();
      return normalize(cameraViewMatrix.mul(vec4(s.N, 0)).xyz);
    })();
    // SSR opt-in (post/ssr.ts contract: x = the weight given to skyRadiance(R), y = roughness).
    // z = 1 marks the pixel as water, so the composite can reject rays that land on the water
    // itself (grazing rays skimming the next crest), which otherwise read as dark stipple.
    this.mrtNode = mrt({
      ssr: vec4(
        Fn(() => this.getShading().ssrWeight)(),
        Fn(() => this.getShading().alpha.add(0.02))(),
        1,
        1,
      ),
    });
  }

  // Whichever of colour / normal / MRT / lighting the builder reaches first runs prepare();
  // the rest reuse its vars. Reset per build (setup runs once per compiled pipeline).
  private getShading(): Shading {
    if (!this.shading) this.shading = prepare(this.deps);
    return this.shading;
  }

  setup(builder: Parameters<NodeMaterial['setup']>[0]) {
    this.shading = null;
    super.setup(builder);
    this.shading = null;
  }

  setupLightingModel(): LightingModel {
    return new WaterLightingModel(() => this.getShading(), this.deps.u, this.deps.atmos.sunColorNode);
  }

  setupOutput(builder: unknown, outputNode: TSLNode) {
    const s = this.getShading();
    const lit = this.deps.atmos.applyFog(vec3(outputNode.xyz), positionWorld);
    const out = mix(lit, s.debug, s.debugOn);
    return super.setupOutput(builder as never, vec4(out, 1));
  }
}

/** Builds every per-pixel input (runs inside the colorNode Fn). */
function prepare(d: WaterDeps): Shading {
  const { u, atmos } = d;
  const sf = d.surface;
  const state = d.state();
  const P = positionWorld;
  const toCam = cameraPosition.sub(P).toVar();
  const dist = length(toCam).toVar();
  const V = toCam.div(dist).toVar();
  const rest = sf.rest;
  const depth = sf.depth;

  // Wind slicks: long surfactant streaks along the breeze where the capillaries are damped.
  const wx = WIND.dirX;
  const wz = WIND.dirZ;
  const along = rest.x.mul(wx).add(rest.y.mul(wz));
  const across = rest.y.mul(wx).sub(rest.x.mul(wz));
  const suv = vec2(along.div(160).sub(u.time.mul(0.14 / 160)), across.div(26)).toVar();
  const sn = texture(d.noiseTex, suv).x.mul(0.65).add(texture(d.noiseTex, suv.mul(2.7).add(0.31)).y.mul(0.35));
  const slick = smoothstep(0.54, 0.64, sn).mul(u.slicks).mul(smoothstep(3, 10, depth)).mul(sf.broken.oneMinus()).toVar();

  // Wake field (boards, paddles, pilings): height → normals, velocity → capillary flow.
  // (The near field is ±51 m around the camera; its readers use explicit LOD, so they branch.)
  const wk = vec4(0).toVar();
  const gx = float(0).toVar();
  const gz = float(0).toVar();
  if (!(d.ablate & 16)) If(dist.lessThan(60), () => {
    wk.assign(state.wake(rest));
    const dW = 0.12;
    gx.assign(state.wake(rest.add(vec2(dW, 0))).x.sub(wk.x).div(dW));
    gz.assign(state.wake(rest.add(vec2(0, dW))).x.sub(wk.x).div(dW));
  });
  const flow = vec2(GLOBAL_DRIFT.x, GLOBAL_DRIFT.z).add(vec2(wk.y, wk.z).mul(0.8));

  const sl = surfaceSlopes(d.slopeSrc, {
    rest,
    depth,
    swellDD: sf.swellDD,
    swellDXZ: sf.swellDXZ,
    fftGain: sf.fftGain,
    weights: [float(1), float(1), float(1).sub(slick.mul(0.55)), u.micro.mul(float(1).sub(slick.mul(0.92)))],
    flow,
    time: u.time,
    flowPeriod: 2.4,
    // [look] Capillaries only where they're resolved: at grazing angles beyond a few metres the 1.4 m tile
    // aliases into radial streaks (the lost slope still roughens the surface via the variance table).
    near: float(1).sub(smoothstep(2.5, 7, dist)),
  });
  const dd = sl.dd.add(vec4(gx, gz, 0, 0));
  const up = vec3(0, 1, 0);
  const bn = sf.baseNormal;
  // [breaking] rotate a horizontal-frame slope perturbation into the breaker surface's frame.
  const bt = sf.baseTangent;
  const toFrame = (p: TSLNode) => {
    if (!bt || !bn) return p;
    const dW = normalize(vec3(sf.thickness.z, 0, sf.thickness.w));
    const eW = vec3(dW.z.negate(), 0, dW.x);
    return vec3(bt).mul(dot(p, dW)).add(eW.mul(dot(p, eW))).add(vec3(bn).mul(p.y));
  };
  // Breaker geometry: its own normal, with the sea's detail added as a perturbation.
  const n0 = (bn ? normalize(vec3(bn).add(toFrame(normalFromDD(dd, sl.dxz).sub(up)))) : normalFromDD(dd, sl.dxz)).toVar();
  const N = select(dot(n0, V).lessThan(0), n0.negate(), n0).toVar();
  const nm0 = bn ? normalize(vec3(bn).add(toFrame(normalFromDD(sl.ddMacro, sl.dxzMacro).sub(up)))) : normalFromDD(sl.ddMacro, sl.dxzMacro);
  const Nm = select(dot(nm0, V).lessThan(0), nm0.negate(), nm0).toVar();
  const NdV = clamp(dot(N, V), 1e-4, 1).toVar();

  // Refraction + Beer–Lambert along the refracted path (view leg + the sun's leg down to it).
  const Nr = normalize(mix(Nm, N, 0.4));
  // Water column under P: the exact 1 m seabed bake where there is one, else the ocean's smoothed depth.
  const seabedAt = (xz: TSLNode) => seabedHeight(d.terrain.heightTexture, d.terrain.bounds, d.terrain.texel, xz, depth.negate());
  const colDepth = P.y.sub(seabedAt(P.xz)).toVar();
  // Only where the seabed can show; beyond that boundary occluder.ts culls it.
  const seeBed = seabedVisibility(depth, dist, u.deepCull, u.farCull).toVar();
  const rr = {
    color: vec3(0).toVar(),
    path: float(200).toVar(),
    hitDepth: float(60).toVar(),
    hit: float(0).toVar(),
    thin: float(100).toVar(),
    scale: float(0).toVar(),
    dbg: vec3(0).toVar(),
  };
  if (!(d.ablate & 1)) If(seeBed.greaterThan(0), () => {
    const r = refractScene(d.refraction, {
      P,
      V,
      N: Nr,
      depthEst: colDepth,
      depthAt: (xz: TSLNode) => P.y.sub(seabedAt(xz)),
      dispersion: u.dispersion,
      strength: u.refraction,
    }, (d.ablate & 128) !== 0);
    rr.color.assign(r.color);
    rr.path.assign(r.path);
    rr.hitDepth.assign(r.hitDepth);
    rr.hit.assign(r.hit);
    rr.thin.assign(r.thin);
    rr.scale.assign(r.scale);
    rr.dbg.assign(r.dbg);
  });
  // The last centimetres of water at the waterline: fade the surface itself out (no hard line
  // where the mesh meets the sand; the wet sand carries its own film reflection).
  const shore = smoothstep(0.004, 0.07, rr.thin).toVar();

  // Roughness: base + the slope variance the mips averaged away (+ wake turbulence).
  const lostVar = sl.lostVar.mul(u.varScale).add(wk.w.mul(0.012)).toVar();
  const a0 = u.roughness.mul(float(1).sub(slick.mul(0.5)));
  const alpha = clamp(sqrt(a0.mul(a0).add(lostVar)), 0.004, 0.6).toVar();
  const sigma = sqrt(lostVar);
  const Hs = normalize(atmos.sunDirNode.add(V));
  const gfp = glintFootprint(rest);
  const glint = float(1).toVar();
  // Only inside the sun lobe (where the smooth lobe is > ~2% of its peak).
  const aS = sqrt(alpha.mul(alpha).add(0.0055 * 0.0055));
  const lobeCos = dot(N, Hs);
  if (!(d.ablate & 4)) If(lobeCos.greaterThan(float(1).sub(aS.mul(aS).mul(2.2))).and(u.glintAmount.greaterThan(0)), () => {
    glint.assign(glintFactor({ amount: u.glintAmount, size: u.glintSize, cells: u.glintCells, tau: u.glintTau, time: u.time }, rest, gfp, N, Hs, lostVar));
  });

  // Reflection: facets tilt the mirror; at grazing the average reflects higher, darker sky and
  // sees less Fresnel than the mean normal would.
  const R0 = reflect(V.negate(), N).toVar();
  const R = normalize(vec3(R0.x, max(R0.y, 0).add(sigma.mul(u.horizonLift)), R0.z)).toVar();
  const F = fresnelWater(max(NdV, sigma.mul(0.6))).mul(shore).toVar();
  // [look] Rough water reflects a blurred sky: blur width ≈ 2·(filtered + micro slope) rad over a
  // ~0.006 rad panorama texel. A sharp fetch mirrored every cirrus fibre as smooth streaks.
  const reflLod = log2(float(1).add(sigma.add(u.reflBlur).mul(330)));
  const skyR = vec3(atmos.skyRadiance(R, reflLod));
  // [breaking] a surface facing down mirrors the water below it, not the sky.
  const sky = sf.underReflect ? mix(skyR, vec3(sf.underReflect), float(1).sub(smoothstep(-0.35, 0, R0.y))) : skyR;

  // Sky irradiance on the water (for the body colour and foam): zenith + the sunward mid sky.
  const sd = atmos.sunDirNode;
  const skyUp = vec3(atmos.skyRadiance(vec3(0, 1, 0)));
  const skyMid = vec3(atmos.skyRadiance(normalize(vec3(sd.x, 0.45, sd.z))));
  const Esky = skyUp.add(skyMid).mul(0.5 * PI).toVar();

  // Foam: state coverage/age + whitecaps (chop Jacobian) + bore crests (swell Jacobian × broken).
  const fs = (sf.foamStateGain ? state.foam(rest).mul(vec2(sf.foamStateGain, 1)) : state.foam(rest)).toVar();
  const Jc = jacobianFromDD(sl.ddChop, sl.dxzChop);
  const Js = jacobianFromDD(sf.swellDD, sf.swellDXZ);
  const whitecap = saturate(float(0.5).sub(Jc).mul(3)).mul(u.whitecaps);
  const bore = sf.broken.mul(saturate(float(0.985).sub(Js).mul(9))).mul(u.boreFoam);
  // [breaking] a breaker's own whitewater adds to the state's coverage; its age wins where it dominates.
  const ex = sf.foam ? vec2(sf.foam).toVar() : null;
  const covS = saturate(ex ? fs.x.add(whitecap).add(bore).add(ex.x) : fs.x.add(whitecap).add(bore));
  const ageS0 = mix(float(0.15), fs.y, smoothstep(0, 0.2, fs.x));
  const ageS = ex ? mix(ageS0, ex.y, saturate(ex.x.div(fs.x.add(ex.x).add(1e-3)))) : ageS0;
  const ramp = foamTestRamp(rest);
  const testOn = select(u.foamTest.greaterThan(0.5), float(1), float(0));
  const cov = mix(covS, ramp.cov, testOn).toVar();
  const age = mix(ageS, ramp.age, testOn).toVar();
  // [breaking] optional finer foam structure (the swash's lace is centimetres, not metres).
  const fsc = sf.foamScale ?? float(1);
  const drift = rest.sub(vec2(GLOBAL_DRIFT.x, GLOBAL_DRIFT.z).mul(u.time)).mul(fsc).toVar();
  const ddx = dFdx(rest).mul(fsc).toVar();
  const ddy = dFdy(rest).mul(fsc).toVar();
  const foamA = float(0).toVar();
  const foamAlb = vec3(0.9).toVar();
  const foamN = vec3(N).toVar();
  const foamGlint = float(0).toVar();
  const fresh = float(0).toVar();
  if (!(d.ablate & 8)) If(cov.greaterThan(0.002), () => {
    const fl = foamLayer({ tex: d.foamTex, xz: drift, dx: ddx, dy: ddy, cov, age, N, gain: u.foam });
    foamA.assign(fl.alpha);
    foamAlb.assign(fl.albedo);
    foamN.assign(fl.normal);
    foamGlint.assign(fl.glint);
    fresh.assign(fl.fresh);
  });

  const sigT = vec3(u.absorb).add(u.turbidity).toVar();
  // Direct light through a crest loses what the water scatters as well as what it absorbs.
  const sigThrough = sigT.add(vec3(0.85, 1, 1.12).mul(u.sssScatter));
  // Seen through a crest: where the refracted view ray runs nearly horizontally (a steep face seen
  // edge-on) it crosses the crest along its chord and leaves through the back into the diffuse
  // sky behind; where it descends steeply (flat water, views from above) it reaches the seabed.
  const Tv0 = refract(V.negate(), Nm, 1 / WATER_IOR);
  // Only thin crests pass light through: across a swell's full chord nothing survives but a
  // saturated blue remainder (which read as blue streaks on distant swell backs).
  const wThru = float(1).sub(smoothstep(0.22, 0.55, Tv0.y.negate())).mul(float(1).sub(smoothstep(2.5, 6, sf.chord))).toVar();
  const aer = sf.aeration ? sf.aeration.max(0) : float(0);
  const sigBed = sigT.add(aer.mul(0.7)); // [look] scattering on the long path down to the reef
  const Tbed = exp(sigBed.mul(rr.path.add(rr.hitDepth.mul(u.sunPath))).negate()).mul(rr.hit).mul(seeBed);
  const Tthru = exp(sigThrough.mul(sf.chord.mul(u.throughPath)).negate());
  const Tseen = mix(Tbed, Tthru, wThru).toVar();
  const backDir = normalize(vec3(V.x.negate(), max(V.y.negate(), 0.02).add(0.06), V.z.negate()));
  const skyBack = vec3(atmos.skyRadiance(normalize(backDir.add(vec3(0, 0.12, 0)))));
  // The seabed in the copy was lit as if in air: the full sun plus sky. Under water the sun's
  // horizontal irradiance loses ~35% to Fresnel at this incidence, the sky only ~7%, so the lit
  // seabed seen through the water is bluer than the same sand on land.
  const EsunH = vec3(atmos.sunColorNode).mul(max(sd.y, 0.02));
  const FsunIn = fresnelWater(max(sd.y, 0.02));
  const underLight = EsunH.mul(FsunIn.oneMinus()).add(Esky.mul(0.93)).div(max(EsunH.add(Esky), 1e-4));
  const seabed = mix(rr.color.mul(Tbed).mul(underLight).mul(u.seabedGain), skyBack.mul(Tthru), wThru);
  // Water-column reflectance at infinite depth (≈ 0.33·b_b/(a+b_b)), minus what the seabed
  // shows through; the bubble cloud under fresh whitewater scatters milky turquoise.
  const bubbles = cov.mul(fresh).mul(0.8).add(wk.w.mul(0.3));
  // Wave-stirred shallows carry far more suspended carbonate than the open ocean (the lagoon's
  // milky turquoise); the particles scatter flat, so the water's own absorption colours them.
  // (masked by the depth along the path seen: a view that runs out over the reef edge sees deep water)
  const lagoon = float(1).sub(smoothstep(2.5, 10, max(colDepth, rr.hitDepth))).mul(u.lagoon);
  const bb = vec3(u.backscatter).add(lagoon.mul(0.006)).add(vec3(0.004, 0.009, 0.01).mul(bubbles)).add(vec3(0.006, 0.011, 0.01).mul(aer));
  const Rinf = bb.div(max(vec3(u.absorb).add(bb), 1e-5)).mul(0.33);
  const bodyR = Rinf.mul(float(1).sub(Tseen)).mul(1 / PI).toVar();

  const waterK = foamA.oneMinus();
  const Ft = F.oneMinus();
  const reflected = sky.mul(F).mul(u.reflection);
  const indirect = reflected
    .add(seabed.mul(Ft))
    .add(Esky.mul(0.934).mul(bodyR).mul(Ft))
    .mul(waterK)
    .add(Esky.mul(foamAlb).mul(1 / PI).mul(1.25).mul(foamA)) // [look] foam is lit by the whole sky dome
    .toVar();

  // SSS path from water/thickness.ts (swell estimate, or a provider's for breakers). Where no
  // provider set the steepness, take it from the macro normal along the wave's travel: light only
  // crosses crests whose front face is steeper than the refracted sun (see thickness.ts).
  const th = sf.thickness;
  const Lh = normalize(vec3(sd.x, 0, sd.z));
  // Chop on the face ribs the glow: its crests shorten the path, its troughs lengthen it.
  const thick = max(th.x.sub(sl.chopH.mul(3)), 0.02).toVar();
  const faceSlope = dot(vec2(Nm.x, Nm.z), vec2(th.z, th.w)).div(max(Nm.y, 0.2));
  const steepF = smoothstep(0.08, 0.55, faceSlope).mul(float(1).sub(u.sssFloor)).add(u.sssFloor);
  const steep = select(th.y.greaterThanEqual(0), th.y, steepF);
  // Light leaves through faces turned away from the sun (the side a backlit viewer sees).
  const face = saturate(dot(vec3(N.x, 0, N.z), Lh.negate()).mul(4).add(0.4));
  // [breaking] optional facet modulation of the glow (breaker faces).
  const facet = sf.sssTexture ? clamp(float(1).add(dot(N, V).sub(dot(Nm, V)).mul(sf.sssTexture).mul(5)), 0.35, 2) : float(1);
  const sssGain = u.sss.mul(steep).mul(face).mul(facet).toVar();

  // Debug views (water.debug).
  const dv = u.debug;
  const pick = (i: number, c: TSLNode) => mix(vec3(0), c, select(dv.equal(i), float(1), float(0)));
  const debug = pick(1, vec3(exp(thick.mul(-0.4)), steep, face))
    .add(pick(2, vec3(foamA, cov, age)))
    .add(pick(3, vec3(rr.path.div(10), rr.hitDepth.div(5), rr.scale)))
    .add(pick(4, vec3(alpha.mul(4), sqrt(lostVar).mul(4), slick)))
    .add(pick(5, rr.color))
    .add(pick(6, N.mul(0.5).add(0.5)))
    .add(pick(7, Tseen))
    .add(pick(8, vec3(rr.thin.div(0.5), shore, wThru)))
    .add(pick(11, vec3(glint.div(20), sigma.div(u.glintSize).div(4), 0)))
    .add(pick(10, rr.dbg))
    .add(pick(12, vec3(seeBed, colDepth.div(30), depth.div(30))))
    .add(pick(9, vec3(F.mul(u.reflection).mul(foamA.oneMinus()).mul(float(1).sub(smoothstep(u.ssrFade.mul(0.6), u.ssrFade, dist))).mul(8), fract(dist.div(50)), 0)))
    .mul(u.debugGain)
    .toVar();
  const debugOn = select(dv.greaterThan(0.5), float(1), float(0));

  return {
    N,
    V,
    NdV,
    F,
    alpha,
    foamA,
    foamAlb,
    foamN,
    foamGlint,
    glint,
    bodyR,
    thick,
    sssGain,
    sssIso: sf.sssDiffuse ?? float(0),
    shore,
    shadowFar: smoothstep(220, 420, dist),
    indirect,
    // SSR at grazing range false-hits the water's own depth (depth24 precision): sky out there.
    // Rays that skim the surface mostly find the next wave crest (a false hit in screen space).
    ssrWeight: F.mul(u.reflection).mul(waterK).mul(float(1).sub(smoothstep(u.ssrFade.mul(0.6), u.ssrFade, dist))).mul(smoothstep(0, u.ssrGrazing.max(1e-4), R0.y)),
    debug,
    debugOn,
  };
}

