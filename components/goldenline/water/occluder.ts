// Deep-water occluder. The water draws after the other opaques so its refraction copy holds the
// seabed, which means every seabed pixel under the water is shaded — even under 30 m of water
// or hundreds of metres out, where nothing of it can be seen (≈ 3–5 ms at 1440p on the M3 for
// the reef-and-channel views). This depth-only copy of the ocean surface draws FIRST and writes
// depth only where the seabed is invisible, so hidden-surface removal / early-z culls the seabed
// there. The water material fades the seabed out before the same boundary (seabedVisibility),
// so nothing it needs is ever culled. Depth-biased back so the real water always wins the test.

import { DoubleSide, Mesh, MeshBasicNodeMaterial, type BufferGeometry } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import type { OceanSurface } from '../ocean/surface';

const { Discard, Fn, If, float, length, smoothstep, vec4 } = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { cameraPosition, positionWorld } = TSL as unknown as Record<string, TSLNode>;

/** 0 where the seabed can't be seen through the water (culled), 1 where it can. */
export function seabedVisibility(depthSmoothed: TSLNode, dist: TSLNode, uDeep: TSLNode, uFar: TSLNode) {
  return float(1)
    .sub(smoothstep(uDeep.mul(0.72), uDeep, depthSmoothed))
    .mul(float(1).sub(smoothstep(uFar.mul(0.75), uFar, dist)));
}

export function createDeepOccluder(surface: OceanSurface, geometry: BufferGeometry, uDeep: TSLNode, uFar: TSLNode) {
  const mat = new MeshBasicNodeMaterial();
  mat.name = 'water.occluder';
  mat.colorWrite = false;
  mat.depthWrite = true;
  mat.side = DoubleSide;
  mat.fog = false;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 2;
  mat.polygonOffsetUnits = 8;
  mat.positionNode = surface.positionNode;
  mat.colorNode = Fn(() => {
    const dist = length(cameraPosition.sub(positionWorld));
    If(seabedVisibility(surface.vSwellX.z, dist, uDeep, uFar).greaterThan(0), () => {
      Discard();
    });
    return vec4(0, 0, 0, 1);
  })();
  const mesh = new Mesh(geometry, mat);
  mesh.name = 'water.occluder';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.renderOrder = -1e5;
  return { mesh, material: mat };
}
