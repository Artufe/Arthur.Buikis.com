// AgX with a look. three's AgXToneMapping is "AgX base": by design it bleaches bright saturated
// colours toward white, which turns a low sun's orange aureole cream. Here the same AgX pipeline
// (Rec.2020 inset, log2 encoding, sigmoid, outset) applies an ASC-CDL look between the sigmoid and
// the outset, like Blender's AgX looks: slope/power/saturation in AgX space keep the golden-hour
// glow golden while highlights still roll off to white rather than clipping per channel.

import { Vector3 } from 'three/webgpu';
import { Fn, clamp, dot, log2, mat3, max, mix, pow, smoothstep, sRGBTransferOETF, toneMappingExposure, uniform, vec3, vec4 } from 'three/tsl';
import type { TSLNode } from '../core/contracts';

const SRGB_TO_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.088), vec3(0.0433, 0.0113, 0.8956));
const REC2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859),
);
const OUTSET = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405),
);
const MIN_EV = -12.47393;
const MAX_EV = 4.026069;

export class AgXLook {
  /** Slope applied to highlights (warm look) and to shadows (cool split tone), blended by luma. */
  readonly slope = uniform(new Vector3(1, 1, 1));
  readonly shadowSlope = uniform(new Vector3(1, 1, 1));
  readonly power = uniform(new Vector3(1, 1, 1));
  readonly saturation = uniform(1);

  /** Linear scene colour in, sRGB-encoded display colour out (includes renderer exposure). */
  apply(c: TSLNode): TSLNode {
    return Fn(() => {
      const col = vec4(c);
      let x: TSLNode = (col.rgb as TSLNode).mul(toneMappingExposure);
      x = SRGB_TO_2020.mul(x);
      x = INSET.mul(x);
      x = max(x, 1e-10);
      x = log2(x).sub(MIN_EV).div(MAX_EV - MIN_EV).clamp(0, 1);
      const x2 = x.mul(x);
      const x4 = x2.mul(x2);
      x = x4.mul(x2).mul(15.5).sub(x4.mul(x).mul(40.14)).add(x4.mul(31.96)).sub(x2.mul(x).mul(6.868)).add(x2.mul(0.4298)).add(x.mul(0.1191)).sub(0.00232);
      // look (ASC CDL in AgX space)
      const lx = dot(x, vec3(0.2126, 0.7152, 0.0722));
      const slope = mix(vec3(this.shadowSlope), vec3(this.slope), smoothstep(0.1, 0.42, lx));
      x = pow(max(x.mul(slope), 0), this.power);
      const l = dot(x, vec3(0.2126, 0.7152, 0.0722));
      x = mix(vec3(l), x, this.saturation);
      x = OUTSET.mul(x);
      x = pow(max(vec3(0), x), vec3(2.2));
      x = REC2020_TO_SRGB.mul(x);
      x = clamp(x, 0, 1);
      return vec4((sRGBTransferOETF as (v: TSLNode) => TSLNode)(x), col.a);
    })();
  }
}

