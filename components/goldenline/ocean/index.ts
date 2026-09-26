// STUB (orchestrator). OWNER: ocean agent — replace wholesale. See docs/goldenline/TASKS.md.
import { Mesh, MeshStandardNodeMaterial, PlaneGeometry } from 'three/webgpu';
import type { GLContext, GLSystem } from '../core/contracts';
import { stubOcean } from '../core/stubs';

export function createOceanSystem(): GLSystem {
  let mesh: Mesh | null = null;
  return {
    name: 'ocean',
    init(ctx: GLContext) {
      ctx.services.ocean = stubOcean();
      const geo = new PlaneGeometry(8000, 8000, 1, 1);
      geo.rotateX(-Math.PI / 2);
      const mat = new MeshStandardNodeMaterial({ color: 0x0d5a66, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.82 });
      mesh = new Mesh(geo, mat);
      mesh.receiveShadow = true;
      ctx.scene.add(mesh);
    },
    dispose(ctx: GLContext) {
      if (!mesh) return;
      ctx.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as MeshStandardNodeMaterial).dispose();
    },
  };
}
