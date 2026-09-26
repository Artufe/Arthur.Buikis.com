// The post chain (RenderPipeline):
//   scene pass (MRT: colour, normal, velocity, ssr mask)
//   → GTAO + SSR composite (before TRAA, so TRAA also resolves their noise)
//   → TRAA → DOF → motion blur → bloom → light shafts → grade → AgX + sRGB
//   → post-TAA sharpen → vignette + grain.
// Every stage is a `post.*` toggle; toggles and quality changes rebuild the chain.
// GPU time comes from timestamp queries, resolved at a throttled rate into ctx.perf.gpuMs.

import { RenderPipeline, UnsignedByteType, type Texture } from 'three/webgpu';
import {
  unpackRGBToNormal,
  convertToTexture,
  packNormalToRGB,
  float,
  int,
  mix,
  mrt,
  normalView,
  output,
  pass,
  sample,
  screenUV,
  select,
  uniform,
  vec2,
  vec4,
  velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import type { GLContext, GLSystem, PostService, Quality, TSLNode } from '../core/contracts';
import type { NumberParam, Param, ToggleParam } from '../core/params';
import { AgXLook } from './agx';
import { Godrays } from './godrays';
import { Grade } from './grade';
import { SSR, SSR_DEFAULT } from './ssr';

const SSR_STEPS: Record<Quality, number> = { low: 12, medium: 18, high: 24, ultra: 32 };
const GPU_RESOLVE_EVERY = 30;

interface PostParams {
  traa: ToggleParam;
  gtao: ToggleParam;
  ssr: ToggleParam;
  dof: ToggleParam;
  motionBlur: ToggleParam;
  bloom: ToggleParam;
  godrays: ToggleParam;
  grade: ToggleParam;
  sharpen: ToggleParam;
  grain: ToggleParam;
  aoStrength: NumberParam;
  aoRadius: NumberParam;
  ssrIntensity: NumberParam;
  ssrDistance: NumberParam;
  dofFocus: NumberParam;
  dofRange: NumberParam;
  dofBokeh: NumberParam;
  shutter: NumberParam;
  bloomStrength: NumberParam;
  bloomRadius: NumberParam;
  bloomThreshold: NumberParam;
  godraysIntensity: NumberParam;
  temperature: NumberParam;
  tint: NumberParam;
  saturation: NumberParam;
  punch: NumberParam;
  lookWarmth: NumberParam;
  lookPower: NumberParam;
  lookSaturation: NumberParam;
  splitTone: NumberParam;
  contrast: NumberParam;
  vignette: NumberParam;
  grainAmount: NumberParam;
  sharpness: NumberParam;
}

function registerParams(ctx: GLContext): PostParams {
  const p = ctx.params;
  const g = 'post';
  const t = (key: string, label: string, value: boolean) => p.toggle(`post.${key}`, { label, group: g, value });
  const n = (key: string, label: string, min: number, max: number, value: number, step?: number) =>
    p.number(`post.${key}`, { label, group: g, min, max, value, step });
  return {
    traa: t('traa', 'TRAA', true),
    gtao: t('gtao', 'GTAO', true),
    ssr: t('ssr', 'SSR (opt-in)', true),
    dof: t('dof', 'depth of field', false),
    motionBlur: t('motionBlur', 'motion blur', true),
    bloom: t('bloom', 'bloom', true),
    godrays: t('godrays', 'light shafts', false),
    grade: t('grade', 'grade', true),
    sharpen: t('sharpen', 'sharpen', true),
    grain: t('grain', 'film grain', true),
    aoStrength: n('aoStrength', 'AO strength', 0, 1, 0.65, 0.01),
    aoRadius: n('aoRadius', 'AO radius m', 0.05, 3, 0.6, 0.01),
    ssrIntensity: n('ssrIntensity', 'SSR intensity', 0, 1.5, 1, 0.01),
    ssrDistance: n('ssrDistance', 'SSR max distance m', 5, 300, 90, 1),
    dofFocus: n('dofFocus', 'DOF focus m', 0.3, 200, 12, 0.1),
    dofRange: n('dofRange', 'DOF range m', 1, 400, 80, 1),
    dofBokeh: n('dofBokeh', 'DOF bokeh', 0, 4, 0.8, 0.01),
    shutter: n('shutter', 'MB shutter (frames)', 0, 1.5, 0.45, 0.01),
    bloomStrength: n('bloomStrength', 'bloom strength', 0, 1, 0.05, 0.005),
    bloomRadius: n('bloomRadius', 'bloom radius', 0, 1, 0.55, 0.01),
    bloomThreshold: n('bloomThreshold', 'bloom threshold', 0, 8, 3, 0.01),
    godraysIntensity: n('godraysIntensity', 'light shafts', 0, 2, 0.35, 0.01),
    temperature: n('temperature', 'white balance (warm +)', -1, 1, 0.05, 0.01),
    tint: n('tint', 'tint (magenta +)', -1, 1, 0, 0.01),
    saturation: n('saturation', 'saturation', 0, 2, 1.1, 0.01),
    punch: n('punch', 'display saturation', 0, 2, 1.1, 0.01),
    lookWarmth: n('lookWarmth', 'AgX look warmth', -1, 1, 0.15, 0.01),
    lookPower: n('lookPower', 'AgX look power', 0.5, 2, 1.05, 0.01),
    lookSaturation: n('lookSaturation', 'AgX look saturation', 0, 2, 1.15, 0.01),
    splitTone: n('splitTone', 'cool shadows (split tone)', 0, 1, 0.5, 0.01),
    contrast: n('contrast', 'contrast', -0.5, 1, 0.15, 0.01),
    vignette: n('vignette', 'vignette', 0, 1, 0.22, 0.01),
    grainAmount: n('grainAmount', 'grain', 0, 0.1, 0.015, 0.001),
    sharpness: n('sharpness', 'sharpen', 0, 1, 0.22, 0.01),
  };
}

type Disposable = { dispose(): void };

export function createPostSystem(): GLSystem {
  let prm: PostParams;
  let pipeline: RenderPipeline | null = null;
  let disposables: Disposable[] = [];
  const grade = new Grade();
  const agx = new AgXLook();
  const godrays = new Godrays();
  let ssr: SSR | null = null;
  let unsub: (() => void) | null = null;
  // live uniforms shared across rebuilds
  const aoStrength = uniform(0.65);
  const shutter = uniform(0.45);
  const bloomStrength = uniform(0.12);
  const bloomRadius = uniform(0.55);
  const bloomThreshold = uniform(1.2);
  const dofFocus = uniform(12);
  const dofRange = uniform(80);
  const dofBokeh = uniform(0.8);
  const sharpAmount = uniform(0.22);
  let aoNodeRef: { radius: { value: number } } | null = null;
  let gpuPending = false;
  let perfRef: GLContext['perf'] | null = null;
  let rendererRef: GLContext['renderer'] | null = null;
  // GPU timing. three keys each timestamp as "r:<call>:<contextId>:f<n>" where <call> is the
  // render call's index within our frame (core resets renderer.info every frame) and "frame" <n>
  // is really one render() call. So: average per call slot; the heaviest slot is the scene pass,
  // the slots after it are the post chain, the ones before are shadow maps and other systems'
  // offscreen passes. Throttled (every 30 frames), so the key parsing isn't per-frame work.
  type Pool = { timestamps: Map<string, number> };
  const SLOTS = 256;
  const slotSum = new Float64Array(SLOTS);
  const slotN = new Uint16Array(SLOTS);
  const slotAvg = new Float32Array(SLOTS);
  // a typed-array cell: a closure `let` double would box a new HeapNumber on every +=
  const acc = new Float64Array(1);
  const accumulate = (v: number, key: string) => {
    acc[0] += v;
    // key = "r:<call>:..." — read the digits in place (no substring allocation)
    let k = 0;
    for (let i = 2; i < key.length; i++) {
      const d = key.charCodeAt(i) - 48;
      if (d < 0 || d > 9) break;
      k = k * 10 + d;
    }
    if (k >= 0 && k < SLOTS) {
      slotSum[k] += v;
      slotN[k]++;
    }
  };
  const readPool = (type: 'render' | 'compute') => {
    const pools = (rendererRef as unknown as { backend: { timestampQueryPool?: Record<string, Pool | undefined> } }).backend.timestampQueryPool;
    const pool = pools ? pools[type] : undefined;
    acc[0] = 0;
    slotSum.fill(0);
    slotN.fill(0);
    if (pool) pool.timestamps.forEach(accumulate);
    let frames = 0;
    for (let i = 0; i < SLOTS; i++) if (slotN[i] > frames) frames = slotN[i];
    return frames;
  };
  const onGpuResolved = () => {
    gpuPending = false;
    const frames = readPool('render');
    if (!perfRef || frames === 0) return;
    let sceneIdx = 0;
    for (let i = 0; i < SLOTS; i++) {
      slotAvg[i] = slotN[i] > 0 ? slotSum[i] / slotN[i] : 0;
      if (slotAvg[i] > slotAvg[sceneIdx]) sceneIdx = i;
    }
    let pre = 0;
    let post = 0;
    for (let i = 0; i < SLOTS; i++) {
      if (i < sceneIdx) pre += slotAvg[i];
      else if (i > sceneIdx) post += slotAvg[i];
    }
    const g = perfRef.gpuMs;
    g.frame = acc[0] / frames;
    g.scene = slotAvg[sceneIdx];
    g.post = post;
    g.preScene = pre;
    (perfRef as unknown as { gpuSlots?: Float32Array }).gpuSlots = slotAvg;
  };
  const onComputeResolved = () => {
    const frames = readPool('compute');
    if (perfRef && frames > 0) perfRef.gpuMs.compute = acc[0] / frames;
  };
  const onGpuError = () => {
    gpuPending = false;
  };

  const applyLive = () => {
    aoStrength.value = prm.aoStrength.value;
    if (aoNodeRef) aoNodeRef.radius.value = prm.aoRadius.value;
    shutter.value = prm.shutter.value;
    bloomStrength.value = prm.bloomStrength.value;
    bloomRadius.value = prm.bloomRadius.value;
    bloomThreshold.value = prm.bloomThreshold.value;
    dofFocus.value = prm.dofFocus.value;
    dofRange.value = prm.dofRange.value;
    dofBokeh.value = prm.dofBokeh.value;
    sharpAmount.value = prm.sharpness.value;
    godrays.intensity.value = prm.godraysIntensity.value;
    if (ssr) {
      ssr.intensity.value = prm.ssrIntensity.value;
      ssr.maxDistance.value = prm.ssrDistance.value;
    }
    // white balance: temperature shifts red/blue, tint green/magenta; normalised to keep luminance
    const tmp = prm.temperature.value;
    const tn = prm.tint.value;
    const r = 1 + tmp * 0.18;
    const b = 1 - tmp * 0.22;
    const gg = 1 - tn * 0.1;
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    grade.gain.value.set(r / l, gg / l, b / l);
    grade.saturation.value = prm.saturation.value;
    grade.contrast.value = prm.contrast.value;
    const lw = prm.grade.value ? prm.lookWarmth.value : 0;
    agx.slope.value.set(1, 1 - 0.24 * lw, 1 - 0.55 * lw);
    const st = prm.grade.value ? prm.splitTone.value : 0;
    agx.shadowSlope.value.set(1 - 0.07 * st, 1 - 0.02 * st, 1 + 0.1 * st);
    const lp = prm.grade.value ? prm.lookPower.value : 1;
    agx.power.value.set(lp, lp, lp);
    agx.saturation.value = prm.grade.value ? prm.lookSaturation.value : 1;
    grade.punch.value = prm.grade.value ? prm.punch.value : 1;
    grade.vignette.value = prm.vignette.value;
    grade.grain.value = prm.grain.value ? prm.grainAmount.value : 0;
  };

  const disposeChain = () => {
    for (let i = 0; i < disposables.length; i++) disposables[i].dispose();
    disposables = [];
    godrays.disposeNodes();
    pipeline?.dispose();
    pipeline = null;
    aoNodeRef = null;
  };

  const build = (ctx: GLContext) => {
    disposeChain();
    const { scene, camera, renderer } = ctx;
    const atmos = ctx.services.atmosphere;
    const useTraa = prm.traa.value;
    const useAO = prm.gtao.value && ctx.quality !== 'low';
    const useSSR = prm.ssr.value;
    const useMB = prm.motionBlur.value;
    const needNormal = useAO || useSSR;
    const needVel = useTraa || useMB;

    const scenePass = pass(scene, camera);
    disposables.push(scenePass as unknown as Disposable);
    const outputs: Record<string, TSLNode> = { output };
    if (needNormal) outputs.normal = packNormalToRGB(normalView);
    if (needVel) outputs.velocity = velocity;
    if (useSSR) outputs.ssr = SSR_DEFAULT();
    scenePass.setMRT(mrt(outputs));
    if (needNormal) (scenePass.getTexture('normal') as Texture).type = UnsignedByteType;
    if (useSSR) (scenePass.getTexture('ssr') as Texture).type = UnsignedByteType;

    const colorTex = scenePass.getTextureNode('output');
    const depthTex = scenePass.getTextureNode('depth');
    const normalTex = needNormal ? scenePass.getTextureNode('normal') : null;
    const velTex = needVel ? scenePass.getTextureNode('velocity') : null;

    let c: TSLNode = colorTex;

    if (useSSR && normalTex) {
      ssr = new SSR(camera);
      c = ssr.composite(
        {
          color: colorTex,
          depth: depthTex,
          normal: normalTex,
          mask: scenePass.getTextureNode('ssr'),
          camera,
          skyRadiance: (dir: TSLNode) => atmos.skyRadiance(dir),
        },
        SSR_STEPS[ctx.quality],
      );
    } else {
      ssr = null;
    }

    if (useAO && normalTex) {
      const sceneNormal = sample((uvN: TSLNode) => unpackRGBToNormal(normalTex.sample(uvN)));
      const aoPass = ao(depthTex, sceneNormal, camera);
      aoPass.resolutionScale = 0.5;
      aoPass.useTemporalFiltering = useTraa;
      aoPass.radius.value = prm.aoRadius.value;
      aoPass.thickness.value = 1;
      aoPass.distanceExponent.value = 1.5;
      aoNodeRef = aoPass as unknown as { radius: { value: number } };
      disposables.push(aoPass as unknown as Disposable);
      const aoVal = aoPass.getTextureNode().sample(screenUV).r;
      const d = depthTex.sample(screenUV).x;
      const occl = select(d.greaterThanEqual(0.99999), float(1), mix(float(1), aoVal, aoStrength));
      c = vec4(vec4(c).rgb.mul(occl), 1);
    }

    if (useTraa && velTex) {
      const t = traa(c, depthTex, velTex, camera);
      disposables.push(t as unknown as Disposable);
      c = (t as unknown as { getTextureNode(): TSLNode }).getTextureNode();
    }

    if (prm.dof.value) {
      const d = dof(c, scenePass.getViewZNode(), dofFocus, dofRange, dofBokeh);
      disposables.push(d as unknown as Disposable);
      // the node itself, not getTextureNode(): DOF's texture is a plain texture() and would drop
      // the effect out of the graph (its updateBefore would never run)
      c = d;
    }

    if (useMB && velTex) {
      const v = velTex.sample(screenUV).xy.mul(vec2(0.5, -0.5)).mul(shutter);
      c = motionBlur(toTexture(c, disposables), v, int(8));
    }

    if (prm.bloom.value) {
      // clamp the bloom input: one firefly glint must not flood the frame
      const b = bloom(vec4(vec4(c).rgb.min(24), 1), bloomStrength, bloomRadius, bloomThreshold);
      disposables.push(b as unknown as Disposable);
      c = vec4(vec4(c).rgb.add(b.rgb), 1);
    }

    if (prm.godrays.value) {
      c = vec4(vec4(c).rgb.add(godrays.build(colorTex, depthTex)), 1);
    }

    if (prm.grade.value) c = grade.scene(c);
    c = agx.apply(c);
    if (prm.sharpen.value) {
      const s = sharpen(c, sharpAmount);
      disposables.push(s as unknown as Disposable);
      c = s;
    }
    c = grade.display(c);

    pipeline = new RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = c;
    applyLive();
  };

  const service: PostService = {
    render(ctx: GLContext) {
      // CPU cost of encoding the frame (three's render + the post chain), shown as systemMs.render
      ctx.perf.begin();
      if (!pipeline) ctx.renderer.render(ctx.scene, ctx.camera);
      else pipeline.render();
      ctx.perf.end('render');
    },
    rebuild(ctx: GLContext) {
      build(ctx);
    },
  };

  return {
    name: 'post',
    init(ctx: GLContext) {
      prm = registerParams(ctx);
      perfRef = ctx.perf;
      ctx.perf.register('render');
      rendererRef = ctx.renderer;
      ctx.perf.gpuMs.frame = 0;
      ctx.perf.gpuMs.compute = 0;
      ctx.perf.gpuMs.scene = 0;
      ctx.perf.gpuMs.post = 0;
      ctx.perf.gpuMs.preScene = 0;
      ctx.services.post = service;
      build(ctx);
      const rebuildKeys = new Set<Param>([prm.traa, prm.gtao, prm.ssr, prm.dof, prm.motionBlur, prm.bloom, prm.godrays, prm.grade, prm.sharpen]);
      unsub = ctx.params.onChange((p: Param) => {
        if (p.group !== 'post') return;
        if (rebuildKeys.has(p)) build(ctx);
        else applyLive();
      });
    },
    update(ctx: GLContext) {
      const f = ctx.time.frame;
      grade.frame.value = f % 997;
      if (ssr) ssr.frame.value = f % 64;
      godrays.update(ctx.camera, ctx.services.atmosphere.sunDir);
      // GPU timestamps: resolve at a throttled rate (the resolve itself allocates in three)
      const r = rendererRef as unknown as { backend: { trackTimestamp?: boolean } } | null;
      if (r && r.backend.trackTimestamp && !gpuPending && f % GPU_RESOLVE_EVERY === 0) {
        gpuPending = true;
        ctx.renderer.resolveTimestampsAsync('compute').then(onComputeResolved, onGpuError);
        ctx.renderer.resolveTimestampsAsync('render').then(onGpuResolved, onGpuError);
      }
    },
    setQuality(ctx: GLContext) {
      build(ctx);
    },
    dispose() {
      unsub?.();
      disposeChain();
    },
  };
}

/** motionBlur samples its input at offsets, so it must be a texture; RTTs are disposed on rebuild. */
function toTexture(node: TSLNode, d: Disposable[]): TSLNode {
  const t = convertToTexture(node);
  if ((t as { isRTTNode?: boolean }).isRTTNode) d.push(t as unknown as Disposable);
  return t;
}
