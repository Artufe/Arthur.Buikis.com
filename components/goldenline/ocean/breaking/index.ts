// GOLDENLINE breaking waves (A8): real breaker geometry on the groundswell, whitewater, spray,
// the shore break and the swash. Driven from the ocean system (ocean/index.ts calls init /
// warmup / update / dispose), because it lives on the ocean's swell and surface.
// See ocean/breaking/README.md.

import { uploadFloatRGBA } from '../../core/upload';
import { MeshBasicNodeMaterial, type Material, type Mesh } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { GLContext, TSLNode } from '../../core/contracts';
import type { NumberParam, ToggleParam } from '../../core/params';
import type { WaterApi } from '../../water';
import type { OceanSurface } from '../surface';
import type { SwellField, SwellRuntime } from '../swell';
import type { SwellGPU } from '../swell-gpu';
import { createBreakGPU, type BreakGPU } from './gpu';
import { createHideHook } from './hook';
import { bakeProfiles } from './profile';
import { bakeRays, type Rays } from './rays';
import { createRibbon, type Ribbon } from './ribbon';
import { createTracker, DATA_W, GLOBAL_ROW, SLOTS, IN_CAMX, IN_CAMZ, IN_DT, IN_GSHORE, IN_PLUNGE, IN_SCALE, IN_TSCALE, type Tracker } from './tracker';
import { bakeBubbleTexture, createWhitewaterMaterial } from './whitewater';
import { createWhitewaterFx } from './emit';
import { createSwash, type SwashParams } from './swash';
import { wrapOceanService, type BreakingApi } from './service';
import { createSpray, SPRAY_MIST, type SprayService } from '../../vfx/spray';
import { WIND } from '../../world/layout';

const { float, uniform, uniformArray, vec3, mix, select, abs, fract, clamp, smoothstep } = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

const WARM_CLOCK = { dt: 1 / 60 };

export interface BreakingDeps {
  field: SwellField;
  env: Float32Array;
  rt: SwellRuntime;
  swell: SwellGPU;
  surface: OceanSurface;
  heightAt: (x: number, z: number) => number;
}

export interface Breaking {
  rays: Rays;
  tracker: Tracker;
  gpu: BreakGPU;
  warmup(ctx: GLContext): void;
  update(ctx: GLContext): void;
  /** Re-bake the rays after the swell field was re-baked (period / direction params). */
  rebake(): void;
  dispose(ctx: GLContext): void;
}

interface Params {
  enabled: ToggleParam;
  hide: ToggleParam;
  plunge: NumberParam;
  timeScale: NumberParam;
  gammaShore: NumberParam;
  edgeDrop: NumberParam;
  warp: NumberParam;
  debug: NumberParam;
  lipGlow: NumberParam;
  streaks: NumberParam;
  faceTexture: NumberParam;
  lipDiffuse: NumberParam;
  lipSheet: NumberParam;
  wwAlbedo: NumberParam;
  wwTranslucency: NumberParam;
  wwRagged: NumberParam;
  whitewater: ToggleParam;
  fxSpray: NumberParam;
  fxVeil: NumberParam;
  fxSmoke: NumberParam;
  fxFoam: NumberParam;
  swash: ToggleParam;
  runup: NumberParam;
  swashFoam: NumberParam;
}

function registerParams(ctx: GLContext): Params {
  const p = ctx.params;
  const g = 'breaking';
  return {
    enabled: p.toggle('breaking.enabled', { label: 'breaking waves', group: g, value: true }),
    hide: p.toggle('breaking.hide', { label: 'hide the swell under breakers (debug)', group: g, value: true }),
    plunge: p.number('breaking.plunge', { label: 'plunge (hollowness) ×', group: g, min: 0, max: 2, value: 1 }),
    timeScale: p.number('breaking.timeScale', { label: 'breaking time ×', group: g, min: 0.4, max: 2.5, value: 1 }),
    gammaShore: p.number('breaking.gammaShore', { label: 'shore-break index', group: g, min: 0.5, max: 1.4, value: 0.9 }),
    edgeDrop: p.number('breaking.edgeDrop', { label: 'ribbon edge drop (m)', group: g, min: 0, max: 0.3, value: 0.06 }),
    warp: p.number('breaking.warp', { label: 'along-crest detail near camera', group: g, min: 0.5, max: 20, value: 3 }),
    lipGlow: p.number('breaking.lipGlow', { label: 'lip / tube-ceiling glow', group: g, min: 0, max: 4, value: 1.8 }),
    streaks: p.number('breaking.streaks', { label: 'flow streaks on lip / face', group: g, min: 0, max: 1.5, value: 0.6 }),
    faceTexture: p.number('breaking.faceTexture', { label: 'chop texture in the backlit glow', group: g, min: 0, max: 2, value: 1 }),
    lipSheet: p.number('breaking.lipSheet', { label: 'lip / tube-ceiling transmission (polish)', group: g, min: 0, max: 3, value: 1 }),
    lipDiffuse: p.number('breaking.lipDiffuse', { label: 'lip multiple scattering (tube ceiling)', group: g, min: 0, max: 20, value: 1.4 }),
    whitewater: p.toggle('breaking.whitewater', { label: 'whitewater shell', group: g, value: true }),
    wwAlbedo: p.number('breaking.wwAlbedo', { label: 'whitewater albedo', group: g, min: 0.2, max: 1.2, value: 0.9 }),
    wwTranslucency: p.number('breaking.wwTranslucency', { label: 'whitewater backlit glow', group: g, min: 0, max: 3, value: 1.8 }),
    wwRagged: p.number('breaking.wwRagged', { label: 'whitewater ragged edges', group: g, min: 0, max: 2, value: 1 }),
    fxSpray: p.number('breaking.spray', { label: 'impact spray ×', group: g, min: 0, max: 3, value: 1 }),
    fxVeil: p.number('breaking.veil', { label: 'offshore spray veils ×', group: g, min: 0, max: 3, value: 1 }),
    fxSmoke: p.number('breaking.smoke', { label: 'whitewater smoke ×', group: g, min: 0, max: 3, value: 1 }),
    fxFoam: p.number('breaking.foam', { label: 'foam left on the water ×', group: g, min: 0, max: 3, value: 1 }),
    swash: p.toggle('breaking.swash', { label: 'swash', group: g, value: true }),
    runup: p.number('breaking.runup', { label: 'swash run-up ×', group: g, min: 0.2, max: 2, value: 1 }),
    swashFoam: p.number('breaking.swashFoam', { label: 'swash bubble line ×', group: g, min: 0, max: 2, value: 1 }),
    debug: p.number('breaking.debug', { label: 'debug view (1 stage 2 normal 3 blend/tube 4 foam)', group: g, min: 0, max: 4, step: 1, value: 0 }),
  };
}

export function createBreaking(ctx: GLContext, deps: BreakingDeps): Breaking {
  const P = registerParams(ctx);
  const rays = bakeRays(deps.field, deps.heightAt, 'reef');
  const shoreRays = bakeRays(deps.field, deps.heightAt, 'shore');
  const prof = bakeProfiles();
  const tracker = createTracker(deps.field, rays, shoreRays);
  const gpu = createBreakGPU(tracker.data, rays, prof);
  const uHide = uniform(1);
  const ru = { edgeDrop: uniform(0.06), enabled: uniform(1), warp: uniform(3), lipGlow: uniform(1.8), streaks: uniform(0.6), faceTexture: uniform(1), lipDiffuse: uniform(1.4), lipSheet: uniform(1) };
  const hide = createHideHook(deps.swell, gpu, uHide);
  deps.surface.addHook(hide.hook);
  // The shared spray system (vfx/spray), published for B1 / A4 on ocean.gpu.spray.
  const spray: SprayService = createSpray(ctx.services.atmosphere);
  spray.wind.x = WIND.dirX * WIND.speed;
  spray.wind.z = WIND.dirZ * WIND.speed;
  ctx.scene.add(spray.sprite);
  (ctx.services.ocean.gpu as { spray?: SprayService }).spray = spray;
  const fx = createWhitewaterFx(tracker, prof, spray);
  const swash = createSwash(ctx, tracker);
  // sample() / wave() with the breakers in them (B1 rides this), plus the richer breaker query.
  const wrapped = wrapOceanService(ctx.services.ocean, tracker, prof, deps.field, deps.env, deps.rt);
  ctx.services.ocean = wrapped.service;
  (ctx.services.ocean.gpu as { breaking?: BreakingApi }).breaking = wrapped.api;
  const sp: SwashParams = { runup: 1, foam: 1 };
  let ribbon: Ribbon | null = null;
  let waterMat: Material | null = null;
  let debugMat: MeshBasicNodeMaterial | null = null;
  const uDebug = uniform(0);
  // Sim time as a 1-element uniform array (stores unboxed; a number uniform would allocate).
  const timeVals = [0.5];
  const timeArr = uniformArray(timeVals, 'float');
  const wu = { albedo: uniform(0.9), translucency: uniform(1.8), ragged: uniform(1), time: timeArr.element(0) };
  const bubbles = bakeBubbleTexture();

  const sync = () => {
    tracker.inp[IN_PLUNGE] = P.plunge.value;
    tracker.inp[IN_GSHORE] = P.gammaShore.value;
    tracker.inp[IN_TSCALE] = P.timeScale.value;
    ru.edgeDrop.value = P.edgeDrop.value;
    ru.warp.value = P.warp.value;
    ru.lipGlow.value = P.lipGlow.value;
    ru.streaks.value = P.streaks.value;
    ru.faceTexture.value = P.faceTexture.value;
    ru.lipDiffuse.value = P.lipDiffuse.value;
    ru.lipSheet.value = P.lipSheet.value;
    ru.enabled.value = P.enabled.value ? 1 : 0;
    uHide.value = P.enabled.value && P.hide.value ? 1 : 0;
    fx.rates[0] = P.fxSpray.value;
    fx.rates[1] = P.fxVeil.value;
    fx.rates[2] = P.fxSmoke.value;
    fx.rates[3] = P.fxFoam.value;
    sp.runup = P.runup.value;
    sp.foam = P.swashFoam.value;
    uDebug.value = P.debug.value;
    wu.albedo.value = P.wwAlbedo.value;
    wu.translucency.value = P.wwTranslucency.value;
    wu.ragged.value = P.wwRagged.value;
    if (ribbon && debugMat && waterMat) ribbon.mesh.material = P.debug.value > 0 ? debugMat : waterMat;
  };
  sync();
  const unlisten = ctx.params.onChange((p) => {
    if (p.group === 'breaking') sync();
  });

  const breaking: Breaking = {
    rays,
    tracker,
    gpu,
    warmup(c) {
      const water = (c.services.ocean.gpu as { water?: WaterApi }).water;
      ribbon = createRibbon(gpu, deps.swell, deps.surface, ru);
      if (water) {
        const v = ribbon.v;
        const mat = water.createMaterial({
          rest: v.vRest,
          depth: v.vSwX.z,
          broken: v.vSwX.y,
          swellDD: v.vSwD,
          swellDXZ: v.vSwX.x,
          thickness: v.vThick,
          chord: v.vChord,
          baseNormal: v.vN,
          baseTangent: v.vT,
          foam: v.vFoam.xy,
          foamScale: float(1.7),
          foamStateGain: v.vFoam.z,
          // Seen from inside the tube the lip mirrors the dim green water of the barrel.
          // (the barrel's water below is lit by the low sky through the opening and the lip)
          underReflect: vec3(c.services.atmosphere.skyRadiance(vec3(0.9, 0.12, 0.2).normalize())).mul(vec3(0.3, 0.52, 0.48)),
          sssTexture: ru.faceTexture,
          // [polish] faded in with the blend weight W (vBillow.x): the lip flag switches at W = 0.5
          sssDiffuse: select(v.vThick.y.greaterThan(0), ru.lipDiffuse.mul(smoothstep(0.5, 0.9, v.vBillow.x)), float(0)),
          // [polish] the lip / tube ceiling transmits the sun as a thin aerated sheet
          sheet: select(v.vThick.y.greaterThan(0), ru.lipSheet.mul(smoothstep(0.5, 0.9, v.vBillow.x)), float(0)),
          // [look] A breaking wave over a reef is full of bubbles and sand: the reef mustn't show
          // crisply through the face (it read as stucco and dark ledges).
          // [polish] × the blend weight: where the ribbon fades into the swell it must shade like the
          // ocean (a milky W≈0 section showed as a flat pale rectangle with hard ends)
          aeration: float(0.45).add(v.vSwX.y.mul(0.6)).mul(smoothstep(0.05, 0.6, v.vBillow.x)),
        });
        mat.positionNode = ribbon.positionNode;
        ribbon.mesh.material = mat;
        ribbon.mesh.renderOrder = water.renderOrder;
        waterMat = mat;
      }
      // Debug view (breaking.debug): stage colours, normals, blend/tube, foam.
      debugMat = new MeshBasicNodeMaterial();
      debugMat.positionNode = ribbon.positionNode;
      debugMat.side = 2;
      debugMat.fog = false;
      {
        const v = ribbon.v;
        const phi = v.vFoam.w;
        const stage = select(phi.lessThan(0), vec3(0.2, 0.4, 1), select(phi.lessThan(1), vec3(1, 0.9, 0.2), select(phi.lessThan(2.3), vec3(1, 0.45, 0.1), select(phi.lessThan(5.5), vec3(1, 0.1, 0.1), vec3(0.9, 0.9, 0.9)))));
        const bands = fract(phi).mul(0.25).add(0.75);
        const c1 = mix(vec3(0.05), stage.mul(bands), v.vBillow.x);
        const c2 = v.vN.mul(0.5).add(0.5);
        const c3 = vec3(v.vBillow.x, v.vBillow.y, clamp(v.vThick.x.div(3), 0, 1));
        const c4 = vec3(v.vFoam.x);
        const d = uDebug;
        debugMat.colorNode = select(d.lessThan(1.5), c1, select(d.lessThan(2.5), c2, select(d.lessThan(3.5), c3, c4)));
        void abs;
      }
      if (P.debug.value > 0) ribbon.mesh.material = debugMat;
      const shellMat = createWhitewaterMaterial(ribbon.shell, wu, bubbles, c.services.atmosphere);
      ribbon.shell.mesh.material = shellMat;
      ribbon.shell.mesh.renderOrder = (water?.renderOrder ?? 0) + 1;
      c.scene.add(ribbon.shell.mesh);
      swash.warmup(c, water);
      c.scene.add(swash.mesh);
      // Exercise the spray's spawn path and keep its sprite visible through the warm frames.
      spray.emit(SPRAY_MIST, 0, -50, 0, 0, 0, 0, 4, 0, 0.1, 0.1, 0.2, -60);
      spray.step(c.renderer, WARM_CLOCK);
      spray.emit(SPRAY_MIST, 0, -50, 0, 0, 0, 0, 4, 0, 0.1, 0.1, 0.2, -60);
      c.scene.add(ribbon.mesh);
      breaking.update(c);
    },
    update(c) {
      const cam = c.camera.position;
      const inp = tracker.inp;
      inp[IN_SCALE] = deps.rt.scale;
      inp[IN_DT] = c.time.dt;
      inp[IN_CAMX] = cam.x;
      inp[IN_CAMZ] = cam.z;
      tracker.update(deps.rt, deps.env);
      // Disabled: no breaker anywhere (the hook, the ribbon and sample() all read the headers).
      if (!P.enabled.value) for (let s = 0; s < SLOTS; s++) tracker.data[(GLOBAL_ROW * DATA_W + s) * 4 + 3] = 0;
      timeVals[0] = c.time.t;
      uploadFloatRGBA(c.renderer, gpu.dataTex); // [polish] no version bump (core/upload.ts)
      if (P.enabled.value) fx.update(c.time, c.services.state);
      if (P.swash.value) swash.update(c, sp);
      swash.mesh.visible = swash.mesh.visible && P.swash.value;
      spray.step(c.renderer, c.time);
      if (ribbon) {
        ribbon.mesh.visible = P.enabled.value;
        ribbon.shell.mesh.visible = P.enabled.value && P.whitewater.value;
      }
    },
    rebake() {
      // Same sizes: copy in place so every texture and the tracker keep their arrays.
      const copy = (dst: Rays, src: Rays) => {
        dst.px.set(src.px);
        dst.pz.set(src.pz);
        dst.dx.set(src.dx);
        dst.dz.set(src.dz);
        dst.k.set(src.k);
        dst.S.set(src.S);
        dst.K.set(src.K);
        dst.tau.set(src.tau);
        dst.Qh.set(src.Qh);
        dst.h.set(src.h);
        dst.hr.set(src.hr);
        dst.mEnd.set(src.mEnd);
        dst.mNear.set(src.mNear);
        dst.plunge.set(src.plunge);
        dst.label.set(src.label);
      };
      copy(rays, bakeRays(deps.field, deps.heightAt, 'reef'));
      copy(shoreRays, bakeRays(deps.field, deps.heightAt, 'shore'));
      tracker.refresh();
      gpu.labelTex.needsUpdate = true;
    },
    dispose(c) {
      unlisten();
      if (ribbon) {
        c.scene.remove(ribbon.shell.mesh);
        c.scene.remove(ribbon.mesh);
        ribbon.dispose();
        ribbon = null;
      }
      swash.dispose(c);
      c.scene.remove(spray.sprite);
      spray.dispose();
      delete (c.services.ocean.gpu as { spray?: SprayService }).spray;
      bubbles.dispose();
      waterMat?.dispose();
      debugMat?.dispose();
      waterMat = debugMat = null;
      gpu.dispose();
    },
  };
  return breaking;
}

export type { Mesh };
