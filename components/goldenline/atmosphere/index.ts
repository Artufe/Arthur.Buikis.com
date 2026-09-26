// Atmosphere, sky and sun: a Hillaire-style physically based sky (CPU-baked LUTs, per-pixel
// phase), golden-hour cloud layers, the limb-darkened sun disc, analytic aerial perspective,
// the reflection panorama + PMREM IBL, and the cascaded, PCSS-filtered sun shadows.
// See atmosphere/README.md for how other materials use it.

import { BackSide, type Color, DirectionalLight, LessEqualDepth, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { Fn, cameraProjectionMatrix, modelViewMatrix, normalize, output, positionLocal, positionWorld, select, varying, vec3, vec4 } from 'three/tsl';
import type { AtmosphereService, GLContext, GLSystem, TSLNode } from '../core/contracts';
import type { NumberParam, Param, ToggleParam } from '../core/params';
import { SUN } from '../world/layout';
import { sunDirection } from '../world/sun';
import { Clouds } from './clouds';
import { SkyProducts } from './env';
import { Fog } from './fog';
import { setHaze } from './model';
import { createProbes } from './probes';
import { SunShadows } from './shadows';
import { SkyGPU } from './sky';

const DEG = Math.PI / 180;
const SHADOW_SIZE = { low: 1024, medium: 2048, high: 2048, ultra: 4096 } as const;
/** Frames to wait after the last param change before re-baking (the bake takes ~100 ms). */
const REBAKE_DEBOUNCE = 6;
/** Reflection panorama refresh (frames): clouds drift a fraction of a texel per second. */
const PANO_EVERY = 30;

interface AtmosParams {
  sunElevation: NumberParam;
  sunAzimuth: NumberParam;
  sunIntensity: NumberParam;
  haze: NumberParam;
  hazeHeight: NumberParam;
  turbidity: NumberParam;
  hazeAlbedo: NumberParam;
  aerialScale: NumberParam;
  mieG: NumberParam;
  sunGlow: NumberParam;
  sunDisc: NumberParam;
  sunSize: NumberParam;
  bank: NumberParam;
  bankHeight: NumberParam;
  cirrus: NumberParam;
  cloudWarmth: NumberParam;
  envIntensity: NumberParam;
  iblCircumsolar: NumberParam;
  shadowSoftness: NumberParam;
  fog: ToggleParam;
  clouds: ToggleParam;
  shadows: ToggleParam;
  probes: ToggleParam;
}

function registerParams(ctx: GLContext): AtmosParams {
  const p = ctx.params;
  const g = 'atmosphere';
  return {
    sunElevation: p.number('atmosphere.sunElevation', { label: 'sun elevation °', group: g, min: 2, max: 40, step: 0.1, value: SUN.elevationDeg }),
    sunAzimuth: p.number('atmosphere.sunAzimuth', { label: 'sun azimuth °', group: g, min: -60, max: 60, step: 0.1, value: SUN.azimuthDeg }),
    sunIntensity: p.number('atmosphere.sunIntensity', { label: 'sun intensity', group: g, min: 1, max: 60, step: 0.1, value: 5.5 }),
    haze: p.number('atmosphere.haze', { label: 'haze density /km', group: g, min: 0, max: 0.6, step: 0.005, value: 0.18 }),
    hazeHeight: p.number('atmosphere.hazeHeight', { label: 'haze height m', group: g, min: 100, max: 2000, step: 10, value: 350 }),
    turbidity: p.number('atmosphere.turbidity', { label: 'aerosol turbidity', group: g, min: 0, max: 6, step: 0.05, value: 0.7 }),
    hazeAlbedo: p.number('atmosphere.hazeAlbedo', { label: 'haze scattering albedo', group: g, min: 0.5, max: 1, step: 0.005, value: 0.8 }),
    aerialScale: p.number('atmosphere.aerialScale', { label: 'aerial perspective', group: g, min: 0, max: 12, step: 0.1, value: 3 }),
    mieG: p.number('atmosphere.mieG', { label: 'mie anisotropy', group: g, min: 0.5, max: 0.95, step: 0.005, value: 0.88 }),
    sunGlow: p.number('atmosphere.sunGlow', { label: 'haze sun glow', group: g, min: 0, max: 3, step: 0.01, value: 1 }),
    sunDisc: p.number('atmosphere.sunDisc', { label: 'sun disc radiance', group: g, min: 0, max: 60, step: 0.1, value: 15 }),
    sunSize: p.number('atmosphere.sunSize', { label: 'sun disc size', group: g, min: 0.5, max: 4, step: 0.01, value: 1.25 }),
    bank: p.number('atmosphere.bank', { label: 'cloud bank cover', group: g, min: 0, max: 1, step: 0.01, value: 0.48 }),
    bankHeight: p.number('atmosphere.bankHeight', { label: 'cloud bank height °', group: g, min: 0.5, max: 15, step: 0.1, value: 5.5 }),
    cirrus: p.number('atmosphere.cirrus', { label: 'cirrus cover', group: g, min: 0, max: 1, step: 0.01, value: 0.56 }),
    cloudWarmth: p.number('atmosphere.cloudWarmth', { label: 'cloud warmth', group: g, min: 0.5, max: 3, step: 0.01, value: 1.35 }),
    envIntensity: p.number('atmosphere.envIntensity', { label: 'sky light (IBL)', group: g, min: 0, max: 3, step: 0.01, value: 1 }),
    iblCircumsolar: p.number('atmosphere.iblCircumsolar', { label: 'IBL keeps aureole', group: g, min: 0, max: 1, step: 0.01, value: 0.15 }),
    shadowSoftness: p.number('atmosphere.shadowSoftness', { label: 'shadow softness', group: g, min: 0.2, max: 6, step: 0.05, value: 1 }),
    fog: p.toggle('atmosphere.fog', { label: 'aerial perspective', group: g, value: true }),
    clouds: p.toggle('atmosphere.clouds', { label: 'clouds', group: g, value: true }),
    shadows: p.toggle('atmosphere.shadows', { label: 'sun shadows', group: g, value: true }),
    probes: p.toggle('atmosphere.probes', { label: 'lighting probes (debug)', group: g, value: false }),
  };
}

export function createAtmosphereSystem(): GLSystem {
  let prm: AtmosParams;
  let sky: SkyGPU;
  let clouds: Clouds;
  let fog: Fog;
  let products: SkyProducts;
  let shadows: SunShadows;
  let dome: Mesh | null = null;
  let domeMat: MeshBasicNodeMaterial | null = null;
  let light: DirectionalLight;
  let unsub: (() => void) | null = null;
  let service: AtmosphereService;
  let probes: { dispose(): void } | null = null;
  let dirtySun = false;
  let dirtyMedium = false;
  let debounce = 0;
  const tmp3 = new Float32Array(3);
  const tmpMS = new Float32Array(3);

  const applyMedium = () => {
    const m = sky.model.medium;
    const tb = prm.turbidity.value;
    m.mieScatter = 3.996e-3 * tb;
    m.mieAbsorb = 0.444e-3 * tb;
    setHaze(m, prm.haze.value, prm.hazeHeight.value / 1000);
    // absorption from the single-scattering albedo: sea-salt + a little soot/organics
    m.hazeAbsorb = (m.haze[1] * (1 - prm.hazeAlbedo.value)) / Math.max(0.05, prm.hazeAlbedo.value);
    // the analytic near-ground fog uses the same medium, in metres
    fog.extR.value.set(m.rayleigh[0] * 1e-3, m.rayleigh[1] * 1e-3, m.rayleigh[2] * 1e-3);
    const mieE = (m.mieScatter + m.mieAbsorb) * 1e-3;
    fog.extM.value.set(mieE, mieE, mieE);
    fog.albM.value = m.mieScatter / Math.max(1e-9, m.mieScatter + m.mieAbsorb);
    fog.extH.value.set((m.haze[0] + m.hazeAbsorb) * 1e-3, (m.haze[1] + m.hazeAbsorb) * 1e-3, (m.haze[2] + m.hazeAbsorb) * 1e-3);
    fog.albH.value.set(m.haze[0] / (m.haze[0] + m.hazeAbsorb + 1e-9), m.haze[1] / (m.haze[1] + m.hazeAbsorb + 1e-9), m.haze[2] / (m.haze[2] + m.hazeAbsorb + 1e-9));
    fog.hR.value = m.rayleighH * 1000;
    fog.hM.value = m.mieH * 1000;
    fog.hH.value = m.hazeH * 1000;
  };

  /** Vertical optical depth (per channel) from the ground to altitude h (km). */
  const verticalTau = (h: number, out: { set(x: number, y: number, z: number): unknown }) => {
    const m = sky.model.medium;
    const kR = m.rayleighH * (1 - Math.exp(-h / m.rayleighH));
    const kM = m.mieH * (1 - Math.exp(-h / m.mieH));
    const kH = m.hazeH * (1 - Math.exp(-h / m.hazeH));
    const mie = (m.mieScatter + m.mieAbsorb) * kM;
    out.set(
      m.rayleigh[0] * kR + mie + (m.haze[0] + m.hazeAbsorb) * kH,
      m.rayleigh[1] * kR + mie + (m.haze[1] + m.hazeAbsorb) * kH,
      m.rayleigh[2] * kR + mie + (m.haze[2] + m.hazeAbsorb) * kH,
    );
  };

  const applySun = () => {
    const el = prm.sunElevation.value * DEG;
    sunDirection(service.sunDir, prm.sunElevation.value, prm.sunAzimuth.value);
    sky.model.groundTerms(el, tmp3, tmpMS);
    const E = prm.sunIntensity.value;
    sky.sunE.value = E;
    sky.sunT0.value.set(tmp3[0], tmp3[1], tmp3[2]);
    sky.ms0.value.set(tmpMS[0], tmpMS[1], tmpMS[2]);
    service.sunColor.setRGB(tmp3[0] * E, tmp3[1] * E, tmp3[2] * E);
    light.color.copy(service.sunColor);
    light.intensity = 1;
    // clouds: sun at their altitude, pushed warmer by an artist exponent (golden-hour pink/orange)
    const w = prm.cloudWarmth.value;
    sky.model.sunTransmittanceAt(1.6, el, tmp3);
    clouds.sunLow.value.set(Math.pow(tmp3[0], w) * E, Math.pow(tmp3[1], w) * E, Math.pow(tmp3[2], w) * E);
    sky.model.sunTransmittanceAt(8, el, tmp3);
    clouds.sunHigh.value.set(Math.pow(tmp3[0], w) * E, Math.pow(tmp3[1], w) * E, Math.pow(tmp3[2], w) * E);
    verticalTau(1.6, clouds.tauLow.value);
    verticalTau(8, clouds.tauHigh.value);
  };

  const rebake = (ctx: GLContext, medium: boolean) => {
    if (medium) {
      applyMedium();
      sky.model.bakeTransmittance();
      sky.model.bakeMultiScatter();
    }
    applySun();
    sky.model.bakeSkyView(prm.sunElevation.value * DEG);
    products.circumsolar.value = prm.iblCircumsolar.value;
    sky.uploadSkyView();
    products.renderPano(ctx.renderer);
    ctx.scene.environment = products.bakeEnv(ctx.renderer);
    service.envTexture = ctx.scene.environment;
  };

  const applyLive = () => {
    sky.mieG.value = prm.mieG.value;
    sky.sunDiscScale.value = prm.sunDisc.value;
    sky.sunSize.value = prm.sunSize.value;
    fog.aerialScale.value = prm.aerialScale.value;
    fog.sunGlow.value = prm.sunGlow.value;
    fog.enabled.value = prm.fog.value ? 1 : 0;
    clouds.bankCover.value = prm.bank.value;
    clouds.bankHeight.value = prm.bankHeight.value;
    clouds.cirrusCover.value = prm.cirrus.value;
    clouds.enabled.value = prm.clouds.value ? 1 : 0;
    shadows.softness.value = prm.shadowSoftness.value;
  };

  return {
    name: 'atmosphere',
    init(ctx: GLContext) {
      prm = registerParams(ctx);
      sky = new SkyGPU();
      clouds = new Clouds(sky);
      fog = new Fog(sky);
      products = new SkyProducts(sky, clouds);
      shadows = new SunShadows();

      const sunDir = sky.sunDir.value as Vector3;
      sunDirection(sunDir, prm.sunElevation.value, prm.sunAzimuth.value);
      const sunColor = sky.sunColor.value as Color;
      light = new DirectionalLight(0xffffff, 1);
      light.name = 'goldenline.sun';
      light.position.copy(sunDir).multiplyScalar(200);
      light.target.position.set(0, 0, 0);
      ctx.scene.add(light, light.target);

      service = {
        sunDir,
        sunColor,
        sunLight: light,
        sunDirNode: sky.sunDir,
        sunColorNode: sky.sunColor,
        applyFog: (color: TSLNode, worldPos: TSLNode) => fog.apply(color, worldPos),
        skyRadiance: (dir: TSLNode) => products.skyRadiance(dir),
        envTexture: null,
      };
      ctx.services.atmosphere = service;

      applyLive();
      rebake(ctx, true);
      ctx.scene.environmentIntensity = prm.envIntensity.value;

      if (prm.shadows.value) shadows.setup(ctx.renderer, ctx.camera, light, SHADOW_SIZE[ctx.quality]);

      // sky dome: drawn after the opaque pass at the far plane, so only sky pixels pay for it
      domeMat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false });
      domeMat.name = 'goldenline.sky';
      domeMat.fog = false;
      domeMat.depthFunc = LessEqualDepth;
      const clip = cameraProjectionMatrix.mul(vec4(modelViewMatrix.mul(vec4(positionLocal, 0)).xyz, 1));
      domeMat.vertexNode = vec4(clip.xy, clip.w, clip.w);
      const vDir = varying(positionLocal);
      domeMat.colorNode = Fn(() => {
        const dir = normalize(vDir);
        const base = sky.atmosphere(dir);
        const withClouds = clouds.apply(dir, base, 0.00055);
        const disc = sky.sunDisc(dir).mul(withClouds.a.oneMinus());
        // Below the horizon the dome only shows past the end of the ocean mesh: the far sea there
        // is seen at grazing incidence, so it mirrors the horizon sky (matched to the fogged ocean edge).
        const farSea: TSLNode = sky.atmosphere(normalize(vec3(dir.x, 0.0015, dir.z))).mul(0.97);
        const above = withClouds.rgb.add(disc);
        return vec4((select as (...a: TSLNode[]) => TSLNode)(dir.y.lessThan(0), farSea, above), 1);
      })();
      dome = new Mesh(new SphereGeometry(1, 96, 48), domeMat);
      dome.name = 'goldenline.skyDome';
      dome.frustumCulled = false;
      dome.renderOrder = 1e6;
      dome.scale.setScalar(4000);
      ctx.scene.add(dome);

      ctx.scene.fogNode = Fn(() => vec4(fog.apply(output.rgb, positionWorld), output.a))();
      if (prm.probes.value) probes = createProbes(ctx.scene, ctx.services.terrain);

      unsub = ctx.params.onChange((p: Param) => {
        if (p.group !== 'atmosphere') return;
        if (p === prm.haze || p === prm.hazeHeight || p === prm.turbidity || p === prm.hazeAlbedo) {
          dirtyMedium = true;
          debounce = REBAKE_DEBOUNCE;
        } else if (p === prm.sunElevation || p === prm.sunAzimuth || p === prm.sunIntensity || p === prm.cloudWarmth || p === prm.iblCircumsolar) {
          dirtySun = true;
          debounce = REBAKE_DEBOUNCE;
        } else if (p === prm.probes) {
          if (prm.probes.value && !probes) probes = createProbes(ctx.scene, ctx.services.terrain);
          else if (!prm.probes.value && probes) {
            probes.dispose();
            probes = null;
          }
        } else if (p === prm.envIntensity) {
          ctx.scene.environmentIntensity = prm.envIntensity.value;
        } else if (p === prm.shadows) {
          light.castShadow = prm.shadows.value;
          if (prm.shadows.value && !shadows.csm) shadows.setup(ctx.renderer, ctx.camera, light, SHADOW_SIZE[ctx.quality]);
        } else {
          applyLive();
        }
      });
    },
    warmup(ctx: GLContext) {
      products.renderPano(ctx.renderer);
    },
    update(ctx: GLContext) {
      if (debounce > 0 && --debounce === 0 && (dirtySun || dirtyMedium)) {
        rebake(ctx, dirtyMedium);
        dirtySun = dirtyMedium = false;
      }
      const cam = ctx.camera.position;
      if (dome) dome.position.copy(cam);
      // the light only encodes direction; keep it at a fixed offset from the origin
      light.position.copy(service.sunDir).multiplyScalar(200);
      clouds.time.value = ctx.time.t;
      shadows.update(ctx.camera, ctx.time.frame);
      if (ctx.time.frame % PANO_EVERY === 0) products.renderPano(ctx.renderer);
    },
    setQuality(ctx: GLContext, q) {
      if (!shadows.csm) return;
      const size = SHADOW_SIZE[q];
      for (let i = 0; i < shadows.csm.lights.length; i++) {
        const s = shadows.csm.lights[i].shadow!;
        if (s.mapSize.x !== size) {
          s.mapSize.set(size, size);
          s.map?.dispose();
          s.map = null;
        }
      }
      void ctx;
    },
    dispose(ctx: GLContext) {
      unsub?.();
      probes?.dispose();
      probes = null;
      if (dome) {
        ctx.scene.remove(dome);
        dome.geometry.dispose();
        domeMat?.dispose();
      }
      ctx.scene.remove(light, light.target);
      shadows.dispose();
      light.shadow.map?.dispose();
      light.dispose();
      products.dispose();
      sky.texR.dispose();
      sky.texM.dispose();
      sky.texMS.dispose();
      ctx.scene.environment = null;
      ctx.scene.fogNode = null;
    },
  };
}

