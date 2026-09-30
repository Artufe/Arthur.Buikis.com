// Restrained screen-space light shafts (Mitchell-style radial scattering) from the sun: bright
// sky pixels near the sun are blurred radially toward it, so anything silhouetted against the
// low sun (pilings, spray veils, palm fronds) sheds shafts. Half resolution, 28 taps. Off by
// default; B2 decides where it earns its pixels.

import { Vector2, Vector3, type PerspectiveCamera } from 'three/webgpu';
import { Fn, float, luminance, max, min, rtt, select, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';

const _v = new Vector3();

export class Godrays {
  readonly sunUV = uniform(new Vector2(0.5, 0.5));
  /** 1 when the sun is in front of the camera, fading at the screen edge. */
  readonly visible = uniform(0);
  readonly intensity = uniform(0.35);
  readonly decay = uniform(0.955);
  readonly length = uniform(0.55);
  readonly tint = uniform(new Vector3(1, 0.8, 0.55));
  private nodes: { dispose(): void }[] = [];

  update(camera: PerspectiveCamera, sunDir: Vector3) {
    _v.copy(sunDir).multiplyScalar(1000).add(camera.position).project(camera);
    const inFront = _v.z < 1 ? 1 : 0;
    this.sunUV.value.set(_v.x * 0.5 + 0.5, 0.5 - _v.y * 0.5);
    const off = Math.max(Math.abs(_v.x), Math.abs(_v.y));
    this.visible.value = inFront * Math.max(0, Math.min(1, (1.6 - off) / 0.6));
  }

  build(color: TSLNode, depth: TSLNode): TSLNode {
    const mask = rtt(
      Fn(() => {
        const u = uv();
        const d = depth.sample(u).x;
        const c = color.sample(u).rgb;
        const r = u.sub(this.sunUV).mul(vec3(16 / 9, 1, 0).xy).length();
        const near = smoothstep(0.45, 0.0, r);
        const l = min(luminance(c), 12);
        return vec4(select(d.greaterThanEqual(0.99999), c.mul(l.div(max(luminance(c), 1e-4))).mul(near), vec3(0)), 1);
      })(),
      null,
      null,
      { resolutionScale: 0.5 },
    );
    const N = 28;
    const rays = rtt(
      Fn(() => {
        const u = uv();
        const delta = this.sunUV.sub(u).mul(this.length.div(N));
        let sum: TSLNode = vec3(0);
        let w = 1;
        let wsum = 0;
        for (let i = 0; i < N; i++) {
          const s = mask.sample(u.add(delta.mul(i)));
          sum = sum.add(s.rgb.mul(float(w)));
          wsum += w;
          w *= 0.955;
        }
        return vec4(sum.mul(1 / wsum), 1);
      })(),
      null,
      null,
      { resolutionScale: 0.5 },
    );
    this.nodes.push(mask as unknown as { dispose(): void }, rays as unknown as { dispose(): void });
    return vec3(rays.sample(uv()).rgb).mul(this.tint).mul(this.intensity.mul(this.visible));
  }

  disposeNodes() {
    for (let i = 0; i < this.nodes.length; i++) this.nodes[i].dispose();
    this.nodes.length = 0;
  }
}
