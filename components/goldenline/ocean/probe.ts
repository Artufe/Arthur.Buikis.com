// Debug probe: runs the exact vertex displacement TSL (swell + FFT) at given rest points in a
// compute pass and reads it back, so the CPU OceanService can be checked against what the GPU
// renders. Never used per frame; the shot tooling calls it through ocean.gpu.probe().

import { StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import type { OceanSurface } from './surface';
import { swellSumGPU, type SwellGPU } from './swell-gpu';

const { Fn, float, instanceIndex, storage, vec2, vec4 } = TSL as unknown as Record<string, (...args: any[]) => TSLNode> & {
  instanceIndex: TSLNode;
};

export const PROBE_N = 256;
/** Output layout per probe (4 vec4): displaced pos (w = depth), swell train-0 debug, swell dd, fft disp. */
export const PROBE_STRIDE = 4;

export interface OceanProbe {
  run(renderer: WebGPURenderer, restXZ: Float32Array): Promise<Float32Array>;
  dispose(renderer: WebGPURenderer): void;
}

export function createProbe(surface: OceanSurface, swell: SwellGPU): OceanProbe {
  const inAttr = new StorageBufferAttribute(new Float32Array(PROBE_N * 4), 4);
  const outAttr = new StorageBufferAttribute(new Float32Array(PROBE_N * 4 * PROBE_STRIDE), 4);
  const inNode = storage(inAttr, 'vec4', PROBE_N).toReadOnly();
  const outNode = storage(outAttr, 'vec4', PROBE_N * PROBE_STRIDE);
  const kernel = Fn(() => {
    const i = instanceIndex;
    const p = inNode.element(i);
    const xz = vec2(p.x, p.y).toVar();
    // Vertex spacing of the finest clipmap level, as near the player.
    const sEff = float(0.06);
    const sw = swellSumGPU(swell, xz, sEff);
    const f = surface.fftDisplacement(xz, sEff, sw.depth).toVar();
    const d = sw.d.add(f);
    const o = i.mul(PROBE_STRIDE);
    outNode.element(o).assign(vec4(xz.x.add(d.x), d.y, xz.y.add(d.z), sw.depth));
    outNode.element(o.add(1)).assign(sw.debug);
    outNode.element(o.add(2)).assign(sw.dd);
    outNode.element(o.add(3)).assign(vec4(f, 0));
  })().compute(PROBE_N);
  return {
    async run(renderer, restXZ) {
      const a = inAttr.array as Float32Array;
      a.fill(0);
      const n = Math.min(PROBE_N, restXZ.length >> 1);
      for (let i = 0; i < n; i++) {
        a[i * 4] = restXZ[i * 2];
        a[i * 4 + 1] = restXZ[i * 2 + 1];
      }
      inAttr.needsUpdate = true;
      renderer.compute(kernel);
      const buf = await renderer.getArrayBufferAsync(outAttr);
      return new Float32Array(buf.slice(0));
    },
    dispose(renderer) {
      kernel.dispose();
      const attrs = (renderer as unknown as { _attributes?: { delete(a: unknown): void } })._attributes;
      attrs?.delete(inAttr);
      attrs?.delete(outAttr);
    },
  };
}
