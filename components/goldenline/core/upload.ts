// [polish] Per-frame DataTexture uploads without bumping three's texture version. A
// `needsUpdate = true` every frame changes the version sum three keys its bind-group cache on,
// so every material that samples the texture rebuilt its bind group every frame (≈ 25 KB of
// garbage per frame across the breakers, swash, water and sand). Once three has created the GPU
// texture, write the new texels straight into it with queue.writeTexture (same data, same layout).

import type { DataTexture, WebGPURenderer } from 'three/webgpu';

type Backend = { device?: GPUDevice; get(o: unknown): { texture?: GPUTexture } };

const dst: GPUTexelCopyTextureInfo = { texture: null as unknown as GPUTexture };
const layout: GPUTexelCopyBufferLayout = { offset: 0, bytesPerRow: 0, rowsPerImage: 0 };
const size = { width: 0, height: 0, depthOrArrayLayers: 1 };

/** Upload `tex.image.data` (RGBA32F, 16 B/texel) for this frame. */
export function uploadFloatRGBA(renderer: WebGPURenderer, tex: DataTexture) {
  const b = renderer.backend as unknown as Backend;
  const gpu = tex.version > 0 ? b.get(tex).texture : undefined;
  const img = tex.image as { data: Float32Array; width: number; height: number };
  if (!gpu || !b.device || gpu.width !== img.width || gpu.height !== img.height) {
    tex.needsUpdate = true;
    return;
  }
  dst.texture = gpu;
  layout.bytesPerRow = img.width * 16;
  layout.rowsPerImage = img.height;
  size.width = img.width;
  size.height = img.height;
  b.device.queue.writeTexture(dst, img.data, layout, size);
}
