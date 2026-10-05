// The post pipeline (B4): the scene renders into an offscreen colour target with a depth texture;
// a ¼-res pass builds the bloom and tilt-shift pyramids; one composite adds the ink outlines (from
// depth), tilt-shift, bloom, the sun glow, Neutral tone mapping, a colour grade and dither; FXAA
// smooths the finished frame. See shaders.ts.
//
// Pass budget: on a busy GPU every extra dependent pass costs ~1 ms whatever its size, and an MSAA
// resolve of a half-float target (colour + depth blit) cost +5…10 ms on its own in the paired A/B
// bench, so: no MSAA by default (`?p.post.msaa=4` opts in), one FXAA pass instead, the bloom
// pyramid from hardware mipmaps of ONE ¼-res draw instead of down/up-sample chains, and the
// (subtle, ≤ 1.8 mip) tilt-shift blur as a 13-tap disc inside the composite, in the blurred bands
// only: no pass of its own. The ¼ pass runs only while lit windows can be in view (orbit / the
// eye's own night / a building past the terminator inside the frustum and over the horizon); by
// day nothing crosses the bloom threshold and the sun's glow is analytic.
//
// Tiers: `high` R11G11B10F scene target (RGBA16F without EXT_color_buffer_float), five bloom
// levels, tilt-shift, FXAA. `low` keeps the look (ink, grade, the night bloom with three levels)
// on an sRGB8 scene target, without tilt-shift, FXAA or the night-side darkening. Without
// renderable half-float targets createPost returns null and the engine renders directly.
//
// Zero per-frame allocation: every matrix, vector and target is made once; setSize() resizes.

import {
  BufferGeometry,
  Color,
  DepthTexture,
  Float32BufferAttribute,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RGBAFormat,
  RGBFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import type { LBContext } from '../../core/contracts';
import type { ParamRegistry } from '../../core/params';
import type { SharedUniforms } from '../../core/uniforms';
import { toSphere } from '../../world/city/frame';
import { CITY_SURFACE_R, R } from '../../world/config';
import { PALETTE } from '../palette';
import { bloomFar, nightInView, smooth, tiltAmount } from './curves';
import { COMPOSITE_FRAG, FULLSCREEN_VERT, FXAA_FRAG, PREFILTER_FRAG } from './shaders';

export interface Post {
  /** Draw the frame through the chain (installed as ctx.services.render). */
  render(ctx: LBContext): void;
  /** Drawing-buffer size changed (device px). */
  setSize(width: number, height: number): void;
  /** Whether scene programs draw into the offscreen target (false while the chain is toggled off). */
  readonly offscreen: boolean;
  /** Last frame's reasons for the ¼-res pass (review tooling): ground night, city night, tilt. */
  readonly stats: { ground: number; city: number; tilt: number };
  /** Compile every post program (call during the boot warm-up). */
  compile(): Promise<unknown>;
  dispose(): void;
}

const SHADOW_COOL = new Color(0.16, 0.12, 0.42);
const SHADOW_DUSK = new Color(0.3, 0.2, 0.42);

/**
 * `full` is QualitySettings.post (high tier): tilt-shift, five bloom levels, FXAA, a float scene
 * target. Without it the chain keeps the look (ink, grade, night bloom) on the cheapest targets.
 */
export function createPost(renderer: WebGLRenderer, full: boolean, params: ParamRegistry, uniforms: SharedUniforms): Post | null {
  const ext = renderer.extensions;
  const float32 = ext.has('EXT_color_buffer_float');
  if (!float32 && !ext.has('EXT_color_buffer_half_float')) return null;
  const high = full;
  const n = (key: string, label: string, min: number, max: number, value: number) => params.number(`post.${key}`, { label, min, max, value });

  const p = {
    on: params.toggle('post.on', { label: 'post chain', value: true }),
    // FXAA is for 1× screens: at DPR ≥ 1.75 the pixels are too small to stair-step visibly and its
    // full-res pass costs ~4× as much.
    fxaa: params.toggle('post.fxaa', { label: 'FXAA', value: high && renderer.getPixelRatio() < 1.75 }),
    ink: n('ink', 'ink strength', 0, 1, 1),
    inkDist: n('inkDist', 'ink fade distance (m)', 20, 800, 230),
    inkCrease: n('inkCrease', 'ink crease damping (× pixel angle)', 0, 20, 4),
    inkJump: n('inkJump', 'ink min relative depth step', 0, 0.05, 0.006),
    inkLo: n('inkLo', 'ink edge lo', 0, 1, 0.32),
    inkHi: n('inkHi', 'ink edge hi', 0, 1, 0.6),
    inkOuter: n('inkOuter', 'ink far-side weight', 0, 1, 0.5),
    bloom: n('bloom', 'bloom', 0, 3, 1.7),
    bloomDay: n('bloomDay', 'bloom threshold (day)', 0, 8, 1.8),
    bloomNight: n('bloomNight', 'bloom threshold (night, orbit)', 0, 4, 0.15),
    bloomNightNear: n('bloomNightNear', 'bloom threshold (night, street)', 0, 4, 0.45),
    bloomKnee: n('bloomKnee', 'bloom knee', 0, 1, 0.5),
    bloomGain: n('bloomGain', 'bloom night gain (orbit)', 0, 12, 7),
    bloomGainNear: n('bloomGainNear', 'bloom night gain (street)', 0, 12, 1),
    bloomCap: n('bloomCap', 'bloom source cap (per ¼-res px)', 0.1, 8, 1.2),
    bloomClip: n('bloomClip', 'bloom soft clip', 0.1, 8, 1.2),
    bloomWide: n('bloomWide', 'bloom per-level weight (orbit)', 0.3, 2, 1),
    bloomWideGain: n('bloomWideGain', 'bloom wide-level gain for amber (orbit)', 0, 2, 0.3),
    bloomWideNear: n('bloomWideNear', 'bloom per-level weight (street)', 0.3, 2, 0.6),
    nightDim: n('nightDim', 'night-side darkening (orbit)', 0, 0.8, 0.3),
    nightDimNear: n('nightDimNear', 'night-side darkening (street)', 0, 0.8, 0.08),
    sun: n('sun', 'sun glow', 0, 3, 1),
    tilt: n('tilt', 'tilt-shift', 0, 1.5, high ? 0.85 : 0),
    tiltWidth: n('tiltWidth', 'tilt sharp band', 0, 0.5, 0.24),
    tiltLod: n('tiltLod', 'tilt max blur (mip level)', 0.5, 4, 1.8),
    vibrance: n('vibrance', 'vibrance', -1, 1, 0.12),
    vignette: n('vignette', 'vignette', 0, 1, 0.16),
    shadowTint: n('shadowTint', 'shadow tint', 0, 0.2, 0.035),
    warmth: n('warmth', 'highlight warmth', 0, 2, 1),
    debug: n('debug', 'debug (1 ink, 2 bloom, 3 NaN pixels from the scene)', 0, 3, 0),
  };
  const levels = high ? 5 : 3;

  // ── targets ── (GPU storage is allocated on first use)
  const depth = new DepthTexture(1, 1, UnsignedIntType); // DEPTH_COMPONENT24
  depth.minFilter = NearestFilter;
  depth.magFilter = NearestFilter;
  const sceneRT = new WebGLRenderTarget(1, 1, {
    type: high ? HalfFloatType : UnsignedByteType,
    format: high && float32 ? RGBFormat : RGBAFormat,
    internalFormat: high && float32 ? 'R11F_G11F_B10F' : null,
    colorSpace: high ? '' : SRGBColorSpace,
    samples: Math.round(n('msaa', 'MSAA samples (read at boot)', 0, 8, 0).value),
    depthBuffer: true,
    depthTexture: depth,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
  });
  const mipOpts = { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, generateMipmaps: true } as const;
  // ¼ res: the bloom source.
  const quarterRT = new WebGLRenderTarget(1, 1, mipOpts);
  // The finished frame before FXAA (sRGB-encoded bytes, luma in alpha).
  const ldrRT = new WebGLRenderTarget(1, 1, { type: UnsignedByteType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
  let mipCount = 1;

  // ── passes ──
  const tri = new BufferGeometry();
  tri.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new Mesh(tri);
  quad.frustumCulled = false;
  const postScene = new Scene();
  postScene.add(quad);
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const projInv = { value: new Matrix4() };
  const camWorld = { value: new Matrix4() };
  const px = { value: new Vector2() };
  const pass = (name: string, frag: string, u: Record<string, { value: unknown }>, glsl3 = false) => {
    const m = new ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms: { ...uniforms, ...u }, depthTest: false, depthWrite: false, toneMapped: false, blending: NoBlending });
    if (glsl3) m.glslVersion = GLSL3;
    m.name = name;
    return m;
  };
  const pre = pass('post:quarter', PREFILTER_FRAG, { tSrc: { value: sceneRT.texture }, tDepth: { value: depth }, uPx: px, uProjInv: projInv, uCamWorld: camWorld, uThresh: { value: new Vector4() }, uCap: { value: 1 } }, true);
  const comp = pass('post:composite', COMPOSITE_FRAG, {
    tColor: { value: sceneRT.texture },
    tDepth: { value: depth },
    tBloom: { value: quarterRT.texture },
    uPx: px,
    uProjInv: projInv,
    uCamWorld: camWorld,
    uInkPx: { value: 1 },
    uNear: { value: 1 },
    uFar: { value: 1000 },
    uInk: { value: new Vector4() },
    uInkEdge: { value: new Vector2() },
    uInkColor: { value: new Color().copy(PALETTE.ink) },
    uFogRange: { value: new Vector2(1e4, 2e4) },
    uTilt: { value: new Vector4() },
    uBloom: { value: 0 },
    uBloomW: { value: new Vector4() },
    uSun: { value: new Vector4() },
    uSunLow: { value: 0 },
    uExposure: { value: 1 },
    uGrade: { value: new Vector4() },
    uShadowTint: { value: new Color().copy(SHADOW_COOL) },
    uNightDim: { value: new Vector3(1, R, 0) },
    uAlphaLuma: { value: 0 },
    uDebug: { value: 0 },
  });
  const fxaa = pass('post:fxaa', FXAA_FRAG, { tSrc: { value: ldrRT.texture }, uPx: px });
  const materials = [pre, comp, fxaa];
  const cu = comp.uniforms;
  const size = new Vector2(1, 1);
  const sunP = new Vector3();

  const draw = (mat: ShaderMaterial, target: WebGLRenderTarget | null) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(postScene, ortho);
  };

  function setSize(width: number, height: number) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === size.x && h === size.y) return;
    size.set(w, h);
    sceneRT.setSize(w, h);
    ldrRT.setSize(w, h);
    quarterRT.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    mipCount = Math.floor(Math.log2(Math.max(1, Math.max(w, h) >> 2))) + 1;
    px.value.set(1 / w, 1 / h);
    // BRIEF §3: ~1.5 px lines at 1440p, i.e. 1 px taps (+ half a px on the far side) up to ~1500 px
    // tall, 2 px taps on a retina laptop: the line keeps its size in CSS pixels.
    cu.uInkPx.value = Math.max(1, Math.round(h / 1000));
  }

  // Lit windows beyond the horizon: one probe per building (its roof centre and the angle its roof
  // can be seen over the plateau's horizon from; the frustum test uses the point two thirds up).
  // Built on first use from the shared plan; a few hundred dot products a frame, no allocation.
  let probes: Float32Array | null = null;
  const stats = { ground: 0, city: 0, tilt: 0 };
  const pv = new Vector3();
  const tmp = { x: 0, y: 0, z: 0 };
  /** 0..1: how far into the night the darkest building the eye can see is (smooth, never pops). */
  function cityNight(ctx: LBContext): number {
    if (!probes) {
      const b = ctx.world.city.buildings;
      probes = new Float32Array(b.length * 5);
      for (let i = 0; i < b.length; i++) {
        toSphere(b[i].x, b[i].z, b[i].h, tmp);
        const o = i * 5;
        probes[o] = tmp.x;
        probes[o + 1] = tmp.y;
        probes[o + 2] = tmp.z;
        probes[o + 3] = CITY_SURFACE_R + b[i].h;
        probes[o + 4] = Math.acos(CITY_SURFACE_R / (CITY_SURFACE_R + Math.max(b[i].h, 0.1)));
      }
    }
    const cam = ctx.camera;
    const eye = cam.position;
    const el = eye.length();
    const capEye = el > CITY_SURFACE_R ? Math.acos(CITY_SURFACE_R / el) : 0;
    const sun = uniforms.lbSunDir.value;
    let best = 0;
    for (let o = 0; o < probes.length; o += 5) {
      const rt = probes[o + 3];
      const nd = (probes[o] * sun.x + probes[o + 1] * sun.y + probes[o + 2] * sun.z) / rt;
      const night = 1 - smooth(-0.18, 0.12, nd);
      if (night <= best + 0.02) continue;
      const ca = (probes[o] * eye.x + probes[o + 1] * eye.y + probes[o + 2] * eye.z) / (rt * el);
      if (Math.acos(Math.max(-1, Math.min(1, ca))) > capEye + probes[o + 4]) continue;
      const k = (CITY_SURFACE_R + (rt - CITY_SURFACE_R) * 0.66) / rt;
      pv.set(probes[o] * k, probes[o + 1] * k, probes[o + 2] * k).applyMatrix4(cam.matrixWorldInverse);
      if (pv.z > -cam.near) continue;
      pv.applyMatrix4(cam.projectionMatrix);
      if (Math.abs(pv.x) > 1.25 || Math.abs(pv.y) > 1.25) continue;
      best = night;
    }
    return smooth(0.25, 0.55, best);
  }

  function render(ctx: LBContext) {
    const { scene, camera, view } = ctx;
    if (!p.on.value) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    const sky = ctx.services.sky;
    const veil = Math.min(1, Math.max(0, sky.veil ?? 0));
    const alt = view.altTerrain;
    const far = bloomFar(alt);
    const sunDir = uniforms.lbSunDir.value;
    const eye = camera.position;
    const eyeLen = eye.length();
    const cosSun = eyeLen > 0 ? eye.dot(sunDir) / eyeLen : 1;

    // 1. Scene → offscreen colour + depth (linear: three never tone-maps into a render target).
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    projInv.value.copy(camera.projectionMatrixInverse);
    camWorld.value.copy(camera.matrixWorld);

    // 2. The ¼-res bloom pyramid, only while lit windows can be in view — the visible ground
    // reaching the night side, or a building in the frustum, over the horizon and past the
    // terminator (towers peek over this planet's short horizon). By day the frame is shadow +
    // scene + composite + FXAA at every altitude.
    // (Tilt below ~0.15 mip of blur is under a tenth of a pixel: skipped, so no taps are spent.)
    let tilt = high ? p.tilt.value * tiltAmount(alt) * (1 - veil) : 0;
    if (tilt * p.tiltLod.value < 0.15) tilt = 0;
    // The visible ground reaching the night side counts from orbit (lit windows are pixels there and
    // the frustum holds the whole disc) or under the eye itself; in between, the city's lights are
    // the per-building test (frustum-aware), and the few lights outside it do not need the pass.
    stats.ground = p.bloom.value > 0 ? Math.max(nightInView(eyeLen, cosSun, R, 0) * smooth(0.25, 0.6, far), nightInView(R, cosSun, R, 0)) : 0;
    stats.city = p.bloom.value > 0 && stats.ground < 1 ? cityNight(ctx) : 0;
    stats.tilt = tilt;
    const nightK = Math.max(stats.ground, stats.city);
    if (nightK > 0) {
      pre.uniforms.uThresh.value.set(
        p.bloomDay.value,
        p.bloomNightNear.value + (p.bloomNight.value - p.bloomNightNear.value) * far,
        p.bloomKnee.value,
        p.bloomGainNear.value + (p.bloomGain.value - p.bloomGainNear.value) * far * far,
      );
      pre.uniforms.uCap.value = p.bloomCap.value;
      draw(pre, quarterRT);
    }

    // 3. Composite (to the canvas, or to the LDR target FXAA reads).
    const fog = sky.fog;
    cu.uNear.value = camera.near;
    cu.uFar.value = camera.far;
    const pxAngle = cu.uInkPx.value * px.value.y * 2 * Math.tan((camera.fov * Math.PI) / 360);
    cu.uInk.value.set(p.ink.value * (1 - veil), p.inkDist.value, p.inkCrease.value * pxAngle + p.inkJump.value, p.inkOuter.value);
    cu.uInkEdge.value.set(p.inkLo.value, Math.max(p.inkLo.value + 1e-3, p.inkHi.value));
    if (fog) cu.uFogRange.value.set(fog.near, fog.far);
    cu.uTilt.value.set(tilt, 0.5, p.tiltWidth.value, Math.min(p.tiltLod.value, mipCount + 1));
    // Bloom: Σ wᵢ·levelᵢ / Σ wᵢ, the per-level weight decaying (a local amber glow, not a halo
    // over the whole city), soft-clipped in the shader.
    const lv = Math.min(levels, mipCount);
    // From orbit the two widest levels also get a gain on amber light (a city-scale warm haze over
    // the dense blocks, not just pinpricks); the soft clip caps the sum.
    const growth = p.bloomWideNear.value + (p.bloomWide.value - p.bloomWideNear.value) * far;
    let wsum = 0;
    for (let i = 0, w = 1; i < lv; i++, w *= growth) wsum += w;
    cu.uBloom.value = (p.bloom.value * nightK) / wsum;
    cu.uBloomW.value.set(growth, lv, p.bloomClip.value, p.bloomWideGain.value * smooth(0.5, 0.9, far));
    // Sun glow: on while the sun is in front of the camera, fading out as it leaves the frame and
    // inside clouds; the shader tests occlusion at the sun's own pixel. Stronger for a low sun.
    let sunK = 0;
    if (p.sun.value > 0) {
      sunP.copy(sunDir).multiplyScalar(camera.far * 0.5).add(eye).project(camera);
      const ahead = sunP.z < 1;
      const off = Math.max(Math.abs(sunP.x), Math.abs(sunP.y));
      sunK = ahead ? p.sun.value * (1 - smooth(0.95, 1.05, off)) * (1 - veil) : 0;
    }
    cu.uSun.value.set(sunP.x * 0.5 + 0.5, sunP.y * 0.5 + 0.5, sunK, size.x / size.y);
    // (Low sun as the eye sees it: the horizon dips ~8° at eye height on this planet.)
    const dusk = smooth(-0.3, -0.1, cosSun) * (1 - smooth(0.05, 0.35, cosSun));
    cu.uSunLow.value = dusk;
    cu.uExposure.value = renderer.toneMappingExposure;
    // Shadow tint: the eye's dusk boost is a street-level grade (the dusk street's shade reads warm
    // lilac); from orbit the eye's time of day says nothing about the frame, and a 4× lift there
    // laid a milky lavender film over the whole night side (57,50,74 for 3,18,32). Fades by orbit.
    const duskNear = dusk * (1 - far);
    cu.uGrade.value.set(p.vibrance.value, p.vignette.value, p.shadowTint.value * (1 - 0.6 * uniforms.lbNight.value * (1 - duskNear)) * (1 + 3 * duskNear) * (1 - 0.75 * far), p.warmth.value);
    cu.uShadowTint.value.copy(SHADOW_COOL).lerp(SHADOW_DUSK, duskNear);
    cu.uNightDim.value.x = high ? 1 - (p.nightDimNear.value + (p.nightDim.value - p.nightDimNear.value) * far) : 1;
    cu.uDebug.value = Math.round(p.debug.value);
    const aa = p.fxaa.value;
    cu.uAlphaLuma.value = aa ? 1 : 0;
    draw(comp, aa ? ldrRT : null);
    if (aa) draw(fxaa, null);
  }

  return {
    render,
    setSize,
    stats,
    get offscreen() {
      return p.on.value;
    },
    compile() {
      // Programs depend on the bound target's colour space: compile each pass against the target
      // it draws into.
      const prev = renderer.getRenderTarget();
      const jobs: Promise<unknown>[] = [];
      const aa = p.fxaa.value;
      try {
        for (const [m, t] of [[pre, quarterRT], [comp, aa ? ldrRT : null], [fxaa, null]] as const) {
          if (m === fxaa && !aa) continue;
          quad.material = m;
          renderer.setRenderTarget(t);
          jobs.push(renderer.compileAsync(postScene, ortho).catch(() => {}));
        }
      } finally {
        renderer.setRenderTarget(prev);
      }
      return Promise.all(jobs);
    },
    dispose() {
      sceneRT.dispose();
      depth.dispose();
      quarterRT.dispose();
      ldrRT.dispose();
      for (const m of materials) m.dispose();
      tri.dispose();
    },
  };
}
