// Opt-in screen-space reflections for water and wet sand. Materials write the `ssr` MRT channel
// (weight they gave skyRadiance(R), roughness); here, per opted-in pixel, a jittered view-space
// march finds the hit and the composite swaps the sky reflection for the hit colour:
//   color += weight * confidence * (hitColor - skyRadiance(R))
// Jitter is per pixel and per frame, so TRAA downstream resolves it. See atmosphere/README.md.

import type { PerspectiveCamera } from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  unpackRGBToNormal,
  float,
  getScreenPosition,
  getViewPosition,
  int,
  interleavedGradientNoise,
  max,
  min,
  mrt,
  normalize,
  reflect,
  screenCoordinate,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { TSLNode } from '../core/contracts';

/** The material side: `material.mrtNode = ssrOptIn(fresnelWeight, roughness)`. */
export function ssrOptIn(weight: TSLNode, roughness: TSLNode): TSLNode {
  return mrt({ ssr: vec4(float(weight), float(roughness), 0, 1) });
}

/** Default value of the `ssr` channel for every other material. */
export const SSR_DEFAULT = (): TSLNode => vec4(0, 1, 0, 1);

export interface SSRInputs {
  color: TSLNode; // pass texture node (HDR scene colour)
  depth: TSLNode; // pass depth texture node
  normal: TSLNode; // pass texture node, packNormalToRGB(normalView)
  mask: TSLNode; // pass texture node, the ssr channel
  camera: PerspectiveCamera;
  skyRadiance: (dir: TSLNode) => TSLNode;
}

export class SSR {
  readonly maxDistance = uniform(80);
  readonly intensity = uniform(1);
  readonly thickness = uniform(0.6);
  readonly frame = uniform(0);
  private readonly proj: TSLNode;
  private readonly projInv: TSLNode;
  private readonly camWorld: TSLNode;

  constructor(camera: PerspectiveCamera) {
    // uniforms bound to the live matrices (TRAA's jitter is already applied during the pipeline)
    this.proj = uniform(camera.projectionMatrix);
    this.projInv = uniform(camera.projectionMatrixInverse);
    this.camWorld = uniform(camera.matrixWorld);
  }

  /** Returns a vec4 node: the scene colour with SSR composited in. */
  composite(inp: SSRInputs, steps: number): TSLNode {
    const { color, depth, normal, mask, skyRadiance } = inp;
    return Fn(() => {
      const uvN = uv();
      const base = vec4(color.sample(uvN)).toVar();
      const m = mask.sample(uvN);
      const w = m.x.mul(this.intensity);
      const rough = m.y;
      const fadeRough = smoothstep(0.35, 0.12, rough);
      If(w.mul(fadeRough).greaterThan(0.002), () => {
        const d = depth.sample(uvN).x;
        const P = getViewPosition(uvN, d, this.projInv).toVar();
        const N = normalize(unpackRGBToNormal(normal.sample(uvN).xyz)).toVar();
        const V = normalize(P);
        const R = normalize(reflect(V, N)).toVar();
        const jitter = interleavedGradientNoise(screenCoordinate.xy.add(this.frame.mul(7.123))).toVar();
        const hitUV = vec2(0).toVar();
        const hit = float(0).toVar();
        const travelled = float(0).toVar();
        const prevT = float(0).toVar();
        // march in view space with quadratically growing steps (dense near the surface)
        Loop({ start: int(0), end: int(steps), type: 'int', condition: '<' }, ({ i }: { i: TSLNode }) => {
          const f = float(i).add(jitter).add(1).div(steps);
          const t = f.mul(f).mul(this.maxDistance);
          const Q = P.add(R.mul(t));
          If(Q.z.greaterThan(-0.05), () => {
            Break();
          });
          const suv = getScreenPosition(Q, this.proj).toVar();
          If(suv.x.lessThan(0).or(suv.x.greaterThan(1)).or(suv.y.lessThan(0)).or(suv.y.greaterThan(1)), () => {
            Break();
          });
          const sd = depth.sample(suv).x;
          If(sd.lessThan(0.99999), () => {
            const S = getViewPosition(suv, sd, this.projInv);
            const behind = S.z.sub(Q.z); // > 0: the ray went behind the depth buffer
            const stepLen = t.sub(prevT);
            If(behind.greaterThan(0).and(behind.lessThan(this.thickness.add(stepLen.mul(1.5)))), () => {
              // [polish] water reflecting water: a grazing ray from a water pixel that lands on
              // another water pixel (the next crest, the swash's own lip) is a false hit in screen
              // space (it showed as dark holes in the swash); give it the sky instead. Wet sand
              // still reflects the waves.
              const selfWater = m.z.greaterThan(0.5);
              const hitWater = mask.sample(suv).z.greaterThan(0.5);
              If(selfWater.and(hitWater).not(), () => {
                hitUV.assign(suv);
                hit.assign(1);
                travelled.assign(t);
              });
              Break();
            });
          });
          prevT.assign(t);
        });
        If(hit.greaterThan(0.5), () => {
          const edge = min(min(hitUV.x, hitUV.x.oneMinus()), min(hitUV.y, hitUV.y.oneMinus()));
          const edgeFade = smoothstep(0.0, 0.08, edge);
          const distFade = travelled.div(this.maxDistance).oneMinus().clamp(0, 1);
          const conf = edgeFade.mul(distFade).mul(fadeRough);
          const hitCol = color.sample(hitUV).rgb;
          const Rw = normalize(this.camWorld.mul(vec4(R, 0)).xyz);
          const sky = vec3(skyRadiance(Rw));
          base.rgb.addAssign(max(hitCol.sub(sky).mul(w.mul(conf)), vec3(sky).mul(w.mul(conf)).negate()));
        });
      });
      return base;
    })();
  }
}
