// STUB (orchestrator). OWNER: atmosphere agent — replace wholesale. See docs/goldenline/TASKS.md.
import { HemisphereLight } from 'three/webgpu';
import { fog, rangeFogFactor, vec3 } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import type { GLContext, GLSystem } from '../core/contracts';
import { stubAtmosphere } from '../core/stubs';

export function createAtmosphereSystem(): GLSystem {
  let sky: SkyMesh | null = null;
  let hemi: HemisphereLight | null = null;
  return {
    name: 'atmosphere',
    init(ctx: GLContext) {
      const atmos = stubAtmosphere();
      ctx.services.atmosphere = atmos;
      const light = atmos.sunLight;
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      const cam = light.shadow.camera;
      cam.left = -60;
      cam.right = 60;
      cam.top = 60;
      cam.bottom = -60;
      cam.near = 1;
      cam.far = 600;
      ctx.scene.add(light, light.target);
      hemi = new HemisphereLight(0x9fb8e0, 0xc9a27a, 0.9);
      ctx.scene.add(hemi);
      sky = new SkyMesh();
      sky.scale.setScalar(9000);
      sky.sunPosition.value.copy(atmos.sunDir);
      sky.turbidity.value = 4;
      sky.rayleigh.value = 1.6;
      ctx.scene.add(sky);
      ctx.scene.fogNode = fog(vec3(1.0, 0.7, 0.5), rangeFogFactor(300, 4000));
    },
    update(ctx: GLContext) {
      const a = ctx.services.atmosphere;
      const e = ctx.camera.position;
      a.sunLight.position.set(e.x + a.sunDir.x * 300, a.sunDir.y * 300, e.z + a.sunDir.z * 300);
      a.sunLight.target.position.set(e.x, 0, e.z);
    },
    dispose(ctx: GLContext) {
      if (sky) {
        ctx.scene.remove(sky);
        sky.geometry.dispose();
        sky.material.dispose();
      }
      if (hemi) ctx.scene.remove(hemi);
    },
  };
}
