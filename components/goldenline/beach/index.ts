// STUB (orchestrator). OWNER: beach agent — replace wholesale. See docs/goldenline/TASKS.md.
import { Mesh, MeshStandardNodeMaterial, PlaneGeometry } from 'three/webgpu';
import type { GLContext, GLSystem } from '../core/contracts';

export function createBeachSystem(): GLSystem {
  let mesh: Mesh | null = null;
  return {
    name: 'beach',
    init(ctx: GLContext) {
      const { bounds, height } = ctx.services.terrain;
      const [minX, minZ, maxX, maxZ] = bounds;
      const geo = new PlaneGeometry(maxX - minX, maxZ - minZ, 384, 384);
      geo.rotateX(-Math.PI / 2);
      geo.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)));
      geo.computeVertexNormals();
      const mat = new MeshStandardNodeMaterial({ color: 0xe3cfa8, roughness: 0.92 });
      mesh = new Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
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
