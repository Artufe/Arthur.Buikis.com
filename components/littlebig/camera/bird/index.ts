// The bird system (D1): draws the cartoon bird the camera flies in bird mode (camera/director.ts
// writes its pose, wing beat and pop scale into birdRender()). A stage-2 system only so its one toon
// program compiles behind the reveal instead of on the first frame or mid-flow; one draw call (plus
// its shadow) while it is out, none otherwise.

import { Matrix4, type Mesh, Vector3 } from 'three';
import type { System } from '../../core/contracts';
import { birdRender } from './shared';
import { birdPatch, buildBirdGeometry } from './mesh';

export function createBirdSystem(): System {
  let mesh: Mesh | null = null;
  const uBird = { value: new Vector3() };
  const scale = new Vector3();
  const m4 = new Matrix4();

  return {
    name: 'bird',
    stage: 2,
    async init(ctx) {
      const geo = ctx.track(buildBirdGeometry());
      const mat = ctx.toon.material({ name: 'bird', vertexColors: true, rim: 0.45, patch: birdPatch(uBird) });
      // The colour program rotates the normals with the wings (the shadow twin has none).
      mat.defines = { ...mat.defines, LB_BIRD_COLOR: '' };
      mesh = ctx.toon.mesh(geo, mat, { cast: true, receive: true });
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      ctx.scene.add(mesh);
      await ctx.compile();
    },
    update(ctx) {
      if (!mesh) return;
      const st = birdRender(ctx);
      const on = st.show && st.scale > 1e-3;
      mesh.visible = on;
      if (!on) return;
      scale.setScalar(st.scale);
      m4.compose(st.pos, st.quat, scale);
      mesh.matrix.copy(m4);
      mesh.matrixWorld.copy(m4);
      uBird.value.set(st.phase, st.amp, st.tuck);
    },
    dispose(ctx) {
      if (mesh) {
        ctx.scene.remove(mesh);
        mesh.geometry.dispose();
      }
      mesh = null;
    },
  };
}
