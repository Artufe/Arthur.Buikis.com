// Sky products for other materials:
// - a reflection panorama (sky + clouds, no sun disc), horizon-concentrated, re-rendered every
//   few frames so reflected clouds drift with the sky. `skyRadiance(dir)` is one fetch of it.
// - a PMREM of the sky dome plus a coarse ground (sand landward, dark water seaward) for IBL,
//   rebuilt only when the sun or the medium changes.

import {
  BackSide,
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NodeMaterial,
  PMREMGenerator,
  QuadMesh,
  RenderTarget,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  type WebGPURenderer,
} from 'three/webgpu';
import { Fn, atan, clamp, cos, max, mix, normalize, positionLocal, sin, smoothstep, sqrt, texture, uniform, uv, varying, vec2, vec3, vec4 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import type { Clouds } from './clouds';
import type { SkyGPU } from './sky';

const PANO_W = 1024;
const PANO_H = 384;

export class SkyProducts {
  readonly pano: RenderTarget;
  private readonly panoQuad: QuadMesh;
  private readonly panoMat: NodeMaterial;
  private readonly envScene = new Scene();
  private readonly envMesh: Mesh;
  private readonly envMat: MeshBasicNodeMaterial;
  private pmrem: PMREMGenerator | null = null;
  envRT: RenderTarget | null = null;
  /** How much of the sun's aureole the IBL keeps (see SkyGPU.atmosphere). */
  readonly circumsolar = uniform(0.15);

  constructor(private readonly sky: SkyGPU, private readonly clouds: Clouds) {
    this.pano = new RenderTarget(PANO_W, PANO_H, { type: HalfFloatType, depthBuffer: false });
    const t = this.pano.texture;
    t.wrapS = RepeatWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.generateMipmaps = false;
    t.name = 'goldenline.skyPano';

    this.panoMat = new NodeMaterial();
    this.panoMat.name = 'goldenline.skyPano';
    const panoFrag = Fn(() => {
      const dir = panoDirection(uv());
      const base = sky.atmosphere(dir);
      return vec4(clouds.apply(dir, base, 0.012).rgb, 1);
    });
    this.panoMat.fragmentNode = panoFrag();
    this.panoQuad = new QuadMesh(this.panoMat);

    this.envMat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, depthTest: false });
    this.envMat.name = 'goldenline.skyEnv';
    this.envMat.fog = false;
    const vDir = varying(positionLocal);
    this.envMat.colorNode = Fn(() => {
      const dir = normalize(vDir);
      const up = vec3(dir.x, max(dir.y, 0.002), dir.z).normalize();
      const skyC = clouds.apply(up, sky.atmosphere(up, this.circumsolar), 0.03).rgb;
      // coarse ground: bright sand landward (+X), dark clear water seaward
      const zen = sky.atmosphere(vec3(0, 1, 0));
      const irr = sky.sunColor.mul(max(sky.sunDir.y, 0)).add(zen.mul(Math.PI * 0.9));
      const land = smoothstep(-0.2, 0.35, dir.x);
      const albedo = mix(vec3(0.012, 0.03, 0.036), vec3(0.62, 0.52, 0.4), land);
      const ground = irr.mul(albedo).mul(1 / Math.PI);
      const horizonBlend = smoothstep(-0.02, 0.0, dir.y);
      return mix(ground, skyC, horizonBlend);
    })();
    this.envMesh = new Mesh(new SphereGeometry(1, 64, 32), this.envMat);
    this.envMesh.frustumCulled = false;
    this.envScene.add(this.envMesh);
  }

  /** TSL: reflected sky radiance along a world direction (no sun disc). */
  skyRadiance(dir: TSLNode): TSLNode {
    const d = normalize(dir);
    const c = texture(this.pano.texture, panoUV(d)).rgb;
    // below the horizon a reflection sees the sea surface beyond; darken smoothly
    return c.mul(clamp(d.y.mul(4).add(1), 0.35, 1));
  }

  renderPano(renderer: WebGPURenderer) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.pano);
    this.panoQuad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  /** Build or rebuild the IBL. Returns the PMREM texture. */
  bakeEnv(renderer: WebGPURenderer) {
    if (!this.pmrem) this.pmrem = new PMREMGenerator(renderer);
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 10, { size: 256, renderTarget: this.envRT });
    return this.envRT.texture;
  }

  get warmObjects() {
    return { mesh: this.envMesh, quad: this.panoQuad };
  }

  dispose() {
    this.pano.dispose();
    this.panoMat.dispose();
    this.envMat.dispose();
    this.envMesh.geometry.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
  }
}

/** Panorama mapping: u = world azimuth, v = sqrt(elevation / 90deg) (dense at the horizon). */
export function panoUV(dir: TSLNode): TSLNode {
  const u = atan(dir.z, dir.x).mul(1 / (2 * Math.PI)).add(0.5);
  const lat = dir.y.clamp(0, 1).asin();
  const v = sqrt(lat.mul(2 / Math.PI));
  return vec2(u, v.mul((PANO_H - 1) / PANO_H).add(0.5 / PANO_H));
}

function panoDirection(uvN: TSLNode): TSLNode {
  const az = uvN.x.sub(0.5).mul(2 * Math.PI);
  const v = uvN.y.sub(0.5 / PANO_H).div((PANO_H - 1) / PANO_H).clamp(0, 1);
  const lat = v.mul(v).mul(Math.PI / 2);
  const cl = cos(lat);
  return vec3(cos(az).mul(cl), sin(lat), sin(az).mul(cl));
}

