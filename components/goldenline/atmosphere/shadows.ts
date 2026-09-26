// Sun shadows: 4 cascades (CSMShadowNode) with hand-placed splits so footprints and plank
// gaps stay crisp near the camera while the pier's long shadow still reaches across the water.
// The two near cascades use PCSS (blocker search -> penumbra from the sun's real angular size),
// the far ones a cheaper rotated-disk PCF. Both rotate their sample pattern per pixel and per
// frame, so TRAA integrates the noise into a smooth penumbra.

import { PCFShadowMap, type DirectionalLight, type PerspectiveCamera, type WebGPURenderer, type LightShadow } from 'three/webgpu';
import { Fn, float, interleavedGradientNoise, max, reference as referenceTyped, renderGroup, ivec2, screenCoordinate, select, step, texture, textureLoad, uniform, vec2, vogelDiskSample as vogelTyped } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import type { TSLNode } from '../core/contracts';

// The three typings for these are narrower than the runtime (plain numbers, setGroup).
const reference = referenceTyped as unknown as (name: string, type: string, object: unknown) => TSLNode;
const vogelDiskSample = vogelTyped as unknown as (i: number, n: number, phi: TSLNode) => TSLNode;

/** Cascade far edges (m). The last one is maxFar. */
export const CASCADE_SPLITS = [7, 26, 95, 420];

export class SunShadows {
  readonly frame = uniform(0);
  /** Multiplier on the sun's angular size for the penumbra (1 = physical 0.53 deg). */
  readonly softness = uniform(1);
  csm: CSMShadowNode | null = null;
  private lastAspect = 0;
  private lastFov = 0;

  setup(renderer: WebGPURenderer, camera: PerspectiveCamera, light: DirectionalLight, mapSize: number) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    light.castShadow = true;
    const s = light.shadow;
    s.mapSize.set(mapSize, mapSize);
    s.camera.near = 0.5;
    s.camera.far = 1400;
    s.bias = -0.00006;
    s.normalBias = 0;
    const csm = new CSMShadowNode(light, {
      cascades: CASCADE_SPLITS.length,
      maxFar: CASCADE_SPLITS[CASCADE_SPLITS.length - 1],
      mode: 'custom',
      lightMargin: 320,
      customSplitsCallback: (_n: number, _near: number, far: number, target: number[]) => {
        for (let i = 0; i < CASCADE_SPLITS.length; i++) target.push(CASCADE_SPLITS[i] / far);
      },
    });
    csm.fade = true;
    s.shadowNode = csm;
    // Initialise now (instead of lazily at first build) so the per-cascade shadows can be tuned.
    (csm as unknown as { _init(o: { camera: PerspectiveCamera; renderer: WebGPURenderer }): void })._init({ camera, renderer });
    const normalBias = [0.012, 0.03, 0.09, 0.32];
    const bias = [-0.00004, -0.00006, -0.0001, -0.0002];
    for (let i = 0; i < csm.lights.length; i++) {
      const ls = csm.lights[i].shadow as LightShadow & { filterNode?: unknown };
      ls.normalBias = normalBias[i];
      ls.bias = bias[i];
      ls.filterNode = i < 2 ? this.pcss() : this.pcf();
    }
    this.csm = csm;
    this.lastAspect = camera.aspect;
    this.lastFov = camera.fov;
  }

  /** Re-split when the projection changes (resize, FOV kick). Zero-alloc after the first call. */
  update(camera: PerspectiveCamera, frame: number) {
    this.frame.value = frame % 64;
    if (!this.csm) return;
    if (camera.aspect !== this.lastAspect || camera.fov !== this.lastFov) {
      this.lastAspect = camera.aspect;
      this.lastFov = camera.fov;
      this.csm.updateFrustums();
    }
  }

  private noisePhi(): TSLNode {
    return interleavedGradientNoise(screenCoordinate.xy.add(vec2(this.frame.mul(5.588238), this.frame.mul(3.1)))).mul(6.28318530718);
  }

  private pcss() {
    const self = this;
    return Fn(({ depthTexture, shadowCoord, shadow }: { depthTexture: TSLNode; shadowCoord: TSLNode; shadow: TSLNode }) => {
      const cam = shadow.camera;
      const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
      const left = reference('left', 'float', cam).setGroup(renderGroup);
      const right = reference('right', 'float', cam).setGroup(renderGroup);
      const near = reference('near', 'float', cam).setGroup(renderGroup);
      const far = reference('far', 'float', cam).setGroup(renderGroup);
      const widthW = right.sub(left);
      const depthRange = far.sub(near);
      const texel = float(1).div(mapSize.x);
      const phi = self.noisePhi();
      // blocker search over a disk the size of the widest penumbra we allow (~0.9 m)
      const searchUV = max(float(0.9).div(widthW), texel.mul(3));
      // Build a compare tap first: the depth texture's binding takes its sampler type from the
      // first node that registers it, and textureLoad (blocker search) needs no sampler at all.
      const first = texture(depthTexture, shadowCoord.xy).compare(shadowCoord.z);
      let blockSum: TSLNode = float(0);
      let blockN: TSLNode = first.mul(0);
      const NB = 8;
      for (let i = 0; i < NB; i++) {
        const o = vogelDiskSample(i, NB, phi).mul(searchUV);
        // textureLoad needs no sampler, so it can share the depth texture with the compare taps
        const z = textureLoad(depthTexture, ivec2(shadowCoord.xy.add(o).clamp(0, 1).mul(mapSize).min(mapSize.sub(1)))).x;
        const isB = step(z, shadowCoord.z.sub(texel.mul(0.5)));
        blockSum = blockSum.add(z.mul(isB));
        blockN = blockN.add(isB);
      }
      const avg = blockSum.div(max(blockN, 1));
      const distW = shadowCoord.z.sub(avg).max(0).mul(depthRange);
      // tan(0.533 deg) = 0.0093; penumbra width = distance to blocker x sun angular diameter
      const penW = distW.mul(self.softness.mul(0.0093)).add(texel.mul(widthW).mul(1.1));
      const radius = penW.div(widthW).clamp(texel, searchUV);
      let lit: TSLNode = float(0);
      const NP = 12;
      for (let i = 0; i < NP; i++) {
        const o = vogelDiskSample(i, NP, phi.add(1.3)).mul(radius);
        lit = lit.add(texture(depthTexture, shadowCoord.xy.add(o)).compare(shadowCoord.z));
      }
      return select(blockN.lessThan(0.5), float(1), lit.mul(1 / NP));
    });
  }

  private pcf() {
    const self = this;
    return Fn(({ depthTexture, shadowCoord, shadow }: { depthTexture: TSLNode; shadowCoord: TSLNode; shadow: TSLNode }) => {
      const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
      const texel = float(1).div(mapSize.x);
      const phi = self.noisePhi();
      const r = texel.mul(1.6);
      let lit: TSLNode = float(0);
      const N = 6;
      for (let i = 0; i < N; i++) {
        const o = vogelDiskSample(i, N, phi).mul(r);
        lit = lit.add(texture(depthTexture, shadowCoord.xy.add(o)).compare(shadowCoord.z));
      }
      return lit.mul(1 / N);
    });
  }

  dispose() {
    const csm = this.csm;
    if (!csm) return;
    // CSMShadowNode.dispose() only detaches the cascade lights; free their maps and nodes too,
    // or every mount/unmount of the floating window leaks four shadow render targets.
    const nodes = (csm as unknown as { _shadowNodes: { dispose(): void }[] })._shadowNodes;
    for (let i = 0; i < csm.lights.length; i++) {
      const sh = csm.lights[i].shadow;
      sh?.map?.dispose();
      sh?.dispose();
    }
    for (let i = 0; i < nodes.length; i++) nodes[i].dispose();
    csm.dispose();
    this.csm = null;
  }
}
