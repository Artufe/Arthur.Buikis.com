// GOLDENLINE water shading (A7): the water material on A2's ocean surface, the seabed and pier
// caustics, and the reusable node graph A8 puts on breaker geometry. See water/README.md.

import { Vector3, Vector4, type Material, type Mesh, type DataTexture } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { GLContext, GLSystem, TSLNode } from '../core/contracts';
import type { NumberParam, Param, ToggleParam } from '../core/params';
import { setCausticsHook } from '../beach/hooks';
import type { OceanSurface } from '../ocean/surface';
import type { SwellGPU } from '../ocean/swell-gpu';
import { createPierCaustics, createSeabedCaustics, rayMatrix, WATER_IOR, type CausticSources } from './caustics';
import { WATER_RENDER_ORDER, WaterMaterial, type WaterSurfaceInputs, type WaterUniforms } from './material';
import type { SlopeSources } from './slopes';
import { SWELL } from '../world/layout';
import { createHessian, type Hessian } from './hessian';
import { createDeepOccluder } from './occluder';
import { copyStats, createRefraction, type Refraction } from './refraction';
import { bakeFoamTexture, bakeNoiseTexture } from './textures';
import { createTestCrest } from './testcrest';
import { createThicknessHook, type SSSProvider } from './thickness';
import { slopeVarianceTable, VAR_LEVELS } from './variance';
import { FFT_N } from '../ocean/spectrum';

const { float, uniform, uniformArray, vec4 } = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { normalWorld, positionWorld } = TSL as unknown as Record<string, TSLNode>;

/** Base absorption (/m, R G B): pure water plus a little tropical CDOM/chlorophyll in the blue. */
const ABSORB = [0.29, 0.056, 0.021];
/** Base backscatter b_b (/m): fine white carbonate particles (flat) plus the water itself (blue). */
const BACKSCATTER = [0.0032, 0.0042, 0.0068];

interface Params {
  enabled: ToggleParam;
  absorb: NumberParam;
  scatter: NumberParam;
  turbidity: NumberParam;
  lagoon: NumberParam;
  throughPath: NumberParam;
  seabedGain: NumberParam;
  sss: NumberParam;
  sssScatter: NumberParam;
  glitter: NumberParam;
  glitterKnee: NumberParam;
  glintAmount: NumberParam;
  glintCap: NumberParam;
  glintSize: NumberParam;
  glintCells: NumberParam;
  glintTau: NumberParam;
  roughness: NumberParam;
  varScale: NumberParam;
  reflection: NumberParam;
  horizonLift: NumberParam;
  refraction: NumberParam;
  dispersion: NumberParam;
  caustics: NumberParam;
  causticDepth: NumberParam;
  causticBlur: NumberParam;
  pierCaustics: NumberParam;
  foam: NumberParam;
  foamTest: ToggleParam;
  testCrest: ToggleParam;
  ablate: NumberParam;
  sssFloor: NumberParam;
  sssForward: NumberParam;
  whitecaps: NumberParam;
  boreFoam: NumberParam;
  slicks: NumberParam;
  micro: NumberParam;
  debug: NumberParam;
  debugGain: NumberParam;
  ssrFade: NumberParam;
  ssrGrazing: NumberParam;
  deepCull: NumberParam;
  cull: ToggleParam;
  farCull: NumberParam;
}

function registerParams(ctx: GLContext): Params {
  const p = ctx.params;
  const g = 'water';
  const n = (key: string, label: string, min: number, max: number, value: number, step?: number) =>
    p.number(`water.${key}`, { label, group: g, min, max, value, step });
  return {
    enabled: p.toggle('water.enabled', { label: 'water material', group: g, value: true }),
    absorb: n('absorb', 'absorption ×', 0, 4, 1, 0.01),
    scatter: n('scatter', 'backscatter ×', 0, 6, 1, 0.01),
    turbidity: n('turbidity', 'turbidity /m', 0, 0.5, 0.012, 0.001),
    throughPath: n('throughPath', 'light path through crests ×', 0.5, 6, 2.5, 0.05),
    lagoon: n('lagoon', 'lagoon particles (shallows)', 0, 5, 1.5, 0.01),
    seabedGain: n('seabedGain', 'seabed interreflection', 0.5, 2, 1.15, 0.01),
    sss: n('sss', 'SSS strength', 0, 8, 3, 0.01),
    sssScatter: n('sssScatter', 'SSS scattering /m', 0.02, 2, 0.12, 0.005),
    glitter: n('glitter', 'glitter intensity', 0, 4, 1, 0.01),
    glitterKnee: n('glitterKnee', 'glitter roll-off knee', 1, 80, 14, 0.1),
    glintAmount: n('glintAmount', 'glint sparkle', 0, 1, 1, 0.01),
    glintCap: n('glintCap', 'glint spark roll-off', 5, 300, 60, 1),
    glintSize: n('glintSize', 'glint facet size (slope)', 0.002, 0.08, 0.03, 0.001),
    glintCells: n('glintCells', 'glint cell (px footprints)', 1, 8, 4, 0.1),
    glintTau: n('glintTau', 'glint redraw (s)', 0.03, 1, 0.14, 0.01),
    roughness: n('roughness', 'base roughness', 0.002, 0.12, 0.014, 0.001),
    varScale: n('varScale', 'filtered-slope roughness ×', 0, 3, 1, 0.01),
    reflection: n('reflection', 'reflection ×', 0, 1.5, 1, 0.01),
    horizonLift: n('horizonLift', 'rough horizon lift', 0, 4, 1, 0.01),
    refraction: n('refraction', 'refraction ×', 0, 2, 1, 0.01),
    dispersion: n('dispersion', 'dispersion (× physical)', 0, 8, 0.35, 0.01),
    caustics: n('caustics', 'caustics', 0, 3, 1, 0.01),
    causticDepth: n('causticDepth', 'caustics max depth m', 1, 40, 22, 0.1),
    causticBlur: n('causticBlur', 'caustics blur / m depth', 0, 0.2, 0.03, 0.001),
    pierCaustics: n('pierCaustics', 'pier underside caustics', 0, 2, 1, 0.01),
    foam: n('foam', 'foam', 0, 2, 1, 0.01),
    foamTest: p.toggle('water.foamTest', { label: 'debug: foam coverage × age ramp', group: g, value: false }),
    ablate: n('ablate', 'debug: ablation bitmask (boot)', 0, 1023, 0, 1),
    testCrest: p.toggle('water.testCrest', { label: 'debug: steep test crest (boot only)', group: g, value: false }),
    sssFloor: n('sssFloor', 'SSS on gentle crests', 0, 1, 0, 0.01),
    sssForward: n('sssForward', 'SSS forward peak share', 0, 1, 0.5, 0.01),
    whitecaps: n('whitecaps', 'whitecaps (chop Jacobian)', 0, 2, 0, 0.01),
    boreFoam: n('boreFoam', 'bore foam (swell Jacobian)', 0, 1, 0, 0.01),
    slicks: n('slicks', 'wind slicks', 0, 1, 0.6, 0.01),
    micro: n('micro', 'capillary normals', 0, 2, 1, 0.01),
    ssrFade: n('ssrFade', 'SSR fade-out distance m', 20, 400, 90, 1),
    cull: p.toggle('water.cull', { label: 'deep-seabed culling', group: g, value: true }),
    deepCull: n('deepCull', 'seabed culled below (m)', 5, 60, 24, 0.5),
    farCull: n('farCull', 'seabed culled beyond (m)', 60, 1000, 320, 1),
    ssrGrazing: n('ssrGrazing', 'SSR fade for skimming rays (R.y)', 0, 0.3, 0.04, 0.005),
    debugGain: n('debugGain', 'debug view gain', 0.01, 2, 0.12, 0.01),
    debug: n('debug', 'debug view (1 sss 2 foam 3 path 4 rough 5 refr 6 N 7 T 8 shore 9 ssr 10 refr-dbg 11 glint 12 seabed vis)', 0, 12, 0, 1),
  };
}

interface OceanGpu {
  mesh: Mesh;
  material: Material;
  surface: OceanSurface;
  swellGPU: SwellGPU;
  fft: { disp: unknown; deriv: unknown };
  cpu: { spec: { h0: Float32Array } };
  pierCaustics?: (p: TSLNode) => TSLNode;
  /** SSS path providers for geometry other systems add to the surface (A8). */
  waterSSS?: SSSProvider[];
  water?: WaterApi;
}

/** ocean.gpu.water: the water graph for other systems' geometry (see water/README.md). */
export interface WaterApi {
  createMaterial(inputs: Partial<WaterSurfaceInputs>): WaterMaterial;
  renderOrder: number;
  sssProviders: SSSProvider[];
}

export function createWaterSystem(): GLSystem {
  let P: Params | null = null;
  let u: WaterUniforms | null = null;
  let mat: WaterMaterial | null = null;
  let refraction: Refraction | null = null;
  let hessian: Hessian | null = null;
  let occluder: ReturnType<typeof createDeepOccluder> | null = null;
  let foamTex: DataTexture | null = null;
  let noiseTex: DataTexture | null = null;
  let gpu: OceanGpu | null = null;
  let oceanView: Param | undefined;
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const varVecs: Vector4[] = [];
  for (let i = 0; i < VAR_LEVELS; i++) varVecs.push(new Vector4());
  const varTable = new Float32Array(VAR_LEVELS * 4);
  const varResp = new Float64Array((VAR_LEVELS - 1) * FFT_N);
  const mRefr = new Float32Array(6);
  const mRefl = new Float32Array(6);
  let cs: CausticSources | null = null;
  // Uniforms mirror params only when one changes (a per-frame write boxes every double).
  let dirty = true;
  let unlistenWater: (() => void) | null = null;
  const lastSun = new Float64Array(3);
  // Time as a 1-element uniform array: a double-elements JS array stores t unboxed (a number
  // uniform's .value would allocate a HeapNumber every frame).
  const timeValues = [0.5];
  const timeArr = uniformArray(timeValues, 'float');

  let slopeSrc: SlopeSources | null = null;
  const made: WaterMaterial[] = [];

  /** The water graph on any surface: the ocean's, or (A8) breaker geometry via ocean.gpu.water. */
  const makeMaterial = (ctx: GLContext, ablate: number, surface: WaterSurfaceInputs) => {
    if (!u || !refraction || !foamTex || !noiseTex || !slopeSrc) throw new Error('water: createMaterial before water init');
    const m = new WaterMaterial({
      ablate,
      u,
      atmos: ctx.services.atmosphere,
      terrain: ctx.services.terrain,
      state: () => ctx.services.state,
      slopeSrc,
      refraction,
      foamTex,
      noiseTex,
      surface,
    });
    made.push(m);
    return m;
  };

  const refreshVariance = () => {
    if (!gpu) return;
    slopeVarianceTable(gpu.cpu.spec.h0, varTable, varResp);
    for (let i = 0; i < VAR_LEVELS; i++) varVecs[i].set(varTable[i * 4], varTable[i * 4 + 1], varTable[i * 4 + 2], varTable[i * 4 + 3]);
  };

  return {
    name: 'water',
    init(ctx: GLContext) {
      P = registerParams(ctx);
      gpu = ctx.services.ocean.gpu as unknown as OceanGpu;
      if (!gpu || !gpu.surface) throw new Error('water: ocean.gpu.surface missing');
      oceanView = ctx.params.get('ocean.view');
      // Breakers (A8) push their SSS path providers here before the first compile.
      if (!gpu.waterSSS) gpu.waterSSS = [];
      u = {
        absorb: uniform(new Vector3(ABSORB[0], ABSORB[1], ABSORB[2])),
        backscatter: uniform(new Vector3(BACKSCATTER[0], BACKSCATTER[1], BACKSCATTER[2])),
        turbidity: uniform(0.012),
        lagoon: uniform(1.5),
        throughPath: uniform(2.5),
        seabedGain: uniform(1.15),
        sss: uniform(3),
        sssFloor: uniform(0),
        sssForward: uniform(0.5),
        sssScatter: uniform(0.12),
        glitter: uniform(1),
        glitterKnee: uniform(14),
        glintAmount: uniform(1),
        glintCap: uniform(60),
        glintSize: uniform(0.03),
        glintCells: uniform(4),
        glintTau: uniform(0.14),
        roughness: uniform(0.014),
        varScale: uniform(1),
        reflection: uniform(1),
        refraction: uniform(1),
        dispersion: uniform(0.35),
        foam: uniform(1),
        foamTest: uniform(0),
        whitecaps: uniform(0.5),
        boreFoam: uniform(0.6),
        slicks: uniform(0.6),
        micro: uniform(1),
        horizonLift: uniform(1),
        time: timeArr.element(0),
        ssrFade: uniform(90),
        ssrGrazing: uniform(0.04),
        deepCull: uniform(24),
        farCull: uniform(320),
        debug: uniform(0),
        debugGain: uniform(0.12),
        sunPath: uniform(1.45),
      };
      foamTex = bakeFoamTexture();
      noiseTex = bakeNoiseTexture();
      refreshVariance();
      refraction = createRefraction();
      slopeSrc = { disp: gpu.fft.disp, deriv: gpu.fft.deriv, varTable: uniformArray(varVecs, 'vec4') };

      const atmos = ctx.services.atmosphere;
      hessian = createHessian(gpu.fft.deriv as never);
      cs = {
        hess: hessian.texture,
        uRun: uniform(new Vector4()),
        uM: uniform(new Vector4()),
        uRunR: uniform(new Vector4()),
        uMR: uniform(new Vector4()),
        uStrength: uniform(1),
        uPierStrength: uniform(1),
        uMaxDepth: uniform(22),
        uBlur: uniform(0.03),
        sunDir: atmos.sunDirNode,
        sunColor: atmos.sunColorNode,
      };
      syncSun(ctx);
      // The beach builds its seabed material in its own init (after ours); the pier reads
      // ocean.gpu.pierCaustics in its init.
      setCausticsHook(createSeabedCaustics(cs));
      gpu.pierCaustics = createPierCaustics(cs);
      (gpu as unknown as { waterCopyStats: typeof copyStats }).waterCopyStats = copyStats;
      const surf = gpu.surface;
      const api: WaterApi = {
        createMaterial: (inputs) =>
          makeMaterial(ctx, 0, {
            rest: inputs.rest ?? positionWorld.xz,
            depth: inputs.depth ?? float(3),
            broken: inputs.broken ?? float(1),
            swellDD: inputs.swellDD ?? vec4(0, 0, 0, 0),
            swellDXZ: inputs.swellDXZ ?? float(0),
            fftGain: inputs.fftGain ?? surf.uFftGain,
            thickness: inputs.thickness ?? vec4(0.6, 1, SWELL.dirX, SWELL.dirZ),
            chord: inputs.chord ?? float(1.5),
            baseNormal: inputs.baseNormal ?? normalWorld,
            foam: inputs.foam, // [breaking]
            baseTangent: inputs.baseTangent, // [breaking]
            foamScale: inputs.foamScale, // [breaking]
            foamStateGain: inputs.foamStateGain, // [breaking]
            underReflect: inputs.underReflect, // [breaking]
            sssTexture: inputs.sssTexture, // [breaking]
            sssDiffuse: inputs.sssDiffuse, // [breaking]
          }),
        renderOrder: WATER_RENDER_ORDER,
        sssProviders: gpu.waterSSS!,
      };
      gpu.water = api;

      unlistenWater = ctx.params.onChange((p) => {
        if (p.group === 'water') dirty = true;
      });
      const heavy = new Set(['ocean.seaWind', 'ocean.windSea', 'ocean.chop', 'ocean.capillary', 'ocean.localWind']);
      unlisten = ctx.params.onChange((p) => {
        if (!heavy.has(p.key)) return;
        if (timer) clearTimeout(timer);
        // after the ocean's own debounced spectrum rebake (120 ms)
        timer = setTimeout(() => {
          timer = null;
          refreshVariance();
        }, 400);
      });
    },

    warmup(ctx: GLContext) {
      if (!gpu || !u || !foamTex || !noiseTex) return;
      for (let i = 0; i < 3; i++) hessian?.dispatch(ctx.renderer);
      const surface = gpu.surface;
      // Registered here, after every system's init, so the chord sees breaker hooks added in init().
      if (P && P.testCrest.value) {
        const tc = createTestCrest();
        surface.addHook(tc.hook);
        gpu.waterSSS!.push(tc.provider);
      }
      const th = createThicknessHook(gpu.swellGPU, ctx.services.atmosphere.sunDirNode, gpu.waterSSS!);
      surface.addHook(th.hook);
      const ablate = Math.round((ctx.params.get('water.ablate')?.value as number) ?? 0);
      mat = makeMaterial(ctx, ablate, {
        rest: surface.vRest,
        depth: surface.vSwellX.z,
        broken: surface.vSwellX.y,
        swellDD: surface.vSwellD,
        swellDXZ: surface.vSwellX.x,
        fftGain: surface.uFftGain,
        thickness: th.vThick,
        chord: th.vChord,
      });
      mat.positionNode = surface.positionNode;
      if (ablate & 32) gpu.mesh.receiveShadow = false;
      occluder = createDeepOccluder(surface, gpu.mesh.geometry, u.deepCull, u.farCull);
      ctx.scene.add(occluder.mesh);
      gpu.mesh.material = mat;
      gpu.mesh.renderOrder = WATER_RENDER_ORDER;
      gpu.material.needsUpdate = true;
    },

    update(ctx: GLContext) {
      if (!P || !u || !gpu || !cs) return;
      const use = P.enabled.value && !(oceanView && oceanView.value !== 0) && mat;
      const want = use ? (mat as Material) : gpu.material;
      if (gpu.mesh.material !== want) {
        gpu.mesh.material = want;
        // A2's placeholder is opaque and cheapest drawn first (it occludes the seabed).
        gpu.mesh.renderOrder = use ? WATER_RENDER_ORDER : 0;
      }
      if (occluder) occluder.mesh.visible = !!use && gpu.mesh.visible && P.cull.value;
      if (dirty) {
        dirty = false;
        syncUniforms();
      }
      timeValues[0] = ctx.time.t;
      syncSun(ctx);
      // After the ocean's FFT dispatch (ocean updates before water): curvature for the caustics.
      if (hessian && P.caustics.value + P.pierCaustics.value > 0) hessian.dispatch(ctx.renderer);
    },

    dispose(ctx: GLContext) {
      unlisten?.();
      unlisten = null;
      unlistenWater?.();
      unlistenWater = null;
      if (timer) clearTimeout(timer);
      timer = null;
      setCausticsHook(null);
      if (gpu) {
        if (gpu.mesh.material === mat) gpu.mesh.material = gpu.material;
        delete gpu.pierCaustics;
        delete gpu.waterSSS;
        delete gpu.water;
      }
      for (let i = 0; i < made.length; i++) made[i].dispose();
      made.length = 0;
      if (occluder) {
        ctx.scene.remove(occluder.mesh);
        occluder.material.dispose();
        occluder = null;
      }
      refraction?.dispose();
      hessian?.dispose();
      hessian = null;
      foamTex?.dispose();
      noiseTex?.dispose();
      mat = null;
      refraction = null;
      foamTex = noiseTex = null;
      gpu = null;
      cs = null;
      void ctx;
    },
  };

  function syncUniforms() {
    if (!P || !u || !cs) return;
    (u.absorb.value as Vector3).set(ABSORB[0] * P.absorb.value, ABSORB[1] * P.absorb.value, ABSORB[2] * P.absorb.value);
    (u.backscatter.value as Vector3).set(BACKSCATTER[0] * P.scatter.value, BACKSCATTER[1] * P.scatter.value, BACKSCATTER[2] * P.scatter.value);
    u.turbidity.value = P.turbidity.value;
    u.lagoon.value = P.lagoon.value;
    u.throughPath.value = P.throughPath.value;
    u.seabedGain.value = P.seabedGain.value;
    u.sss.value = P.sss.value;
    u.sssFloor.value = P.sssFloor.value;
    u.sssForward.value = P.sssForward.value;
    u.sssScatter.value = P.sssScatter.value;
    u.glitter.value = P.glitter.value;
    u.glitterKnee.value = P.glitterKnee.value;
    u.glintAmount.value = P.glintAmount.value;
    u.glintCap.value = P.glintCap.value;
    u.glintSize.value = P.glintSize.value;
    u.glintCells.value = P.glintCells.value;
    u.glintTau.value = P.glintTau.value;
    u.roughness.value = P.roughness.value;
    u.varScale.value = P.varScale.value;
    u.reflection.value = P.reflection.value;
    u.horizonLift.value = P.horizonLift.value;
    u.refraction.value = P.refraction.value;
    u.dispersion.value = P.dispersion.value;
    u.foam.value = P.foam.value;
    u.foamTest.value = P.foamTest.value ? 1 : 0;
    u.whitecaps.value = P.whitecaps.value;
    u.boreFoam.value = P.boreFoam.value;
    u.slicks.value = P.slicks.value;
    u.micro.value = P.micro.value;
    u.debug.value = P.debug.value;
    u.ssrFade.value = P.ssrFade.value;
    u.ssrGrazing.value = P.ssrGrazing.value;
    u.deepCull.value = P.deepCull.value;
    u.farCull.value = P.farCull.value;
    u.debugGain.value = P.debugGain.value;
    cs.uStrength.value = P.caustics.value;
    cs.uPierStrength.value = P.pierCaustics.value;
    cs.uMaxDepth.value = P.causticDepth.value;
    cs.uBlur.value = P.causticBlur.value;
  }

  function syncSun(ctx: GLContext) {
    if (!u || !cs) return;
    const sd = ctx.services.atmosphere.sunDir;
    if (sd.x === lastSun[0] && sd.y === lastSun[1] && sd.z === lastSun[2]) return;
    lastSun[0] = sd.x;
    lastSun[1] = sd.y;
    lastSun[2] = sd.z;
    rayMatrix(sd, false, mRefr);
    rayMatrix(sd, true, mRefl);
    (cs.uRun.value as Vector4).set(mRefr[0], mRefr[1], 0, 0);
    (cs.uM.value as Vector4).set(mRefr[2], mRefr[3], mRefr[4], mRefr[5]);
    (cs.uRunR.value as Vector4).set(mRefl[0], mRefl[1], 0, 0);
    (cs.uMR.value as Vector4).set(mRefl[2], mRefl[3], mRefl[4], mRefl[5]);
    const sinI = Math.sqrt(Math.max(0, 1 - sd.y * sd.y));
    const sinT = sinI / WATER_IOR;
    u.sunPath.value = 1 / Math.sqrt(1 - sinT * sinT);
  }
}
