// STUB (orchestrator): a plain first-person walker so every system has a camera from day one.
// OWNER: player agent — replace wholesale. See docs/goldenline/TASKS.md.
import type { GLContext, GLSystem } from '../core/contracts';
import { clamp, damp } from '../core/pool';
import { stubPlayer } from '../core/stubs';
import { SPAWN, forwardX, forwardZ } from '../world/layout';

const EYE = 1.68;
const LOOK = 0.0022;

export function createPlayerSystem(): GLSystem {
  let vx = 0;
  let vz = 0;
  return {
    name: 'player',
    init(ctx: GLContext) {
      const p = stubPlayer(ctx);
      ctx.services.player = p;
      p.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, 'walk');
    },
    update(ctx: GLContext) {
      const p = ctx.services.player;
      const { input, time } = ctx;
      const dt = time.dt;
      if (ctx.debug.cameraLocked || dt === 0) return;
      p.yaw -= input.mouseDX * LOOK;
      p.pitch = clamp(p.pitch - input.mouseDY * LOOK, -1.45, 1.45);
      const fx = forwardX(p.yaw);
      const fz = forwardZ(p.yaw);
      let mx = 0;
      let mz = 0;
      if (input.down.has('KeyW')) (mx += fx), (mz += fz);
      if (input.down.has('KeyS')) (mx -= fx), (mz -= fz);
      if (input.down.has('KeyA')) (mx += fz), (mz -= fx);
      if (input.down.has('KeyD')) (mx -= fz), (mz += fx);
      const len = Math.hypot(mx, mz);
      const speed = input.down.has('ShiftLeft') ? 4.2 : 1.7;
      const tx = len > 0 ? (mx / len) * speed : 0;
      const tz = len > 0 ? (mz / len) * speed : 0;
      vx = damp(vx, tx, 8, dt);
      vz = damp(vz, tz, 8, dt);
      p.eye.x += vx * dt;
      p.eye.z += vz * dt;
      const ground = Math.max(ctx.services.terrain.height(p.eye.x, p.eye.z), -1.1);
      p.eye.y = damp(p.eye.y, ground + EYE, 14, dt);
      p.velocity.set(vx, 0, vz);
      ctx.camera.position.copy(p.eye);
      ctx.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    },
  };
}
