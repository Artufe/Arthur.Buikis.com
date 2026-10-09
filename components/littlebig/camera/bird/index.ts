// The bird system (D1, v2-BA): draws the cartoon bird the camera flies in bird mode (the camera
// writes its pose, wingbeat, flare, stoop, turn, speed and crash into birdRender()). pose.ts solves
// the skeleton's angles on the CPU each frame; mesh.ts skins it in the vertex shader. A stage-2
// system only so its one toon program compiles behind the reveal instead of on the first frame or
// mid-flow; one draw call (plus its shadow) while it is out, none otherwise. The crash daze (stars
// round the head, feathers puffed out at the impact) is part of the same mesh and draw call.

import { Matrix4, type Mesh, Quaternion, Vector3 } from 'three';
import type { System } from '../../core/contracts';
import { birdRender, type BirdRender } from './shared';
import { BIRD_RADIUS, birdPatch, buildBirdGeometry } from './mesh';
import { POSE_FLOATS, solvePose } from './pose';

/**
 * Review only (core/debug.ts birdPose): set on the mesh's userData.hold, called at the start of
 * each update; it may overwrite the render state and set dev.clock / dev.daze (s since impact).
 */
export type BirdHold = (st: BirdRender, dev: { clock: number; daze: number }) => void;

/** How long the daze's feathers drift (s); the stars last while the crash is above ~0.2. */
const DAZE = 2.2;

export function createBirdSystem(): System {
  let mesh: Mesh | null = null;
  const uBd = { value: new Float32Array(POSE_FLOATS) };
  const scale = new Vector3();
  const m4 = new Matrix4();
  const up = new Vector3();
  const ax = new Vector3();
  const az = new Vector3();
  const qi = new Quaternion();
  // The daze: the impact point and the world-level frame there (x, up, z), fixed at the impact.
  const hit = new Vector3();
  const fx = new Vector3();
  const fy = new Vector3();
  const fz = new Vector3();
  const dev = { clock: NaN, daze: NaN };
  let clock = 0;
  let daze = DAZE;
  let lastCrash = 0;

  return {
    name: 'bird',
    stage: 2,
    async init(ctx) {
      const geo = ctx.track(buildBirdGeometry());
      const mat = ctx.toon.material({ name: 'bird', vertexColors: true, rim: 0.45, patch: birdPatch(uBd) });
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
      const hold = mesh.userData.hold as BirdHold | undefined;
      dev.clock = dev.daze = NaN;
      if (hold) hold(st, dev);
      const on = st.show && st.scale > 1e-3;
      mesh.visible = on;
      if (!on) {
        lastCrash = 0;
        return;
      }
      const dt = ctx.time.dt;
      clock = dev.clock === dev.clock ? dev.clock : clock + dt;
      scale.setScalar(st.scale);
      m4.compose(st.pos, st.quat, scale);
      mesh.matrix.copy(m4);
      mesh.matrixWorld.copy(m4);
      // The body's attitude against the local horizon, for the head to hold level.
      up.copy(st.pos).normalize();
      az.set(0, 0, 1).applyQuaternion(st.quat);
      ax.set(1, 0, 0).applyQuaternion(st.quat);
      const o = uBd.value;
      solvePose(o, st, clock, Math.asin(Math.max(-1, Math.min(1, az.dot(up)))), Math.asin(Math.max(-1, Math.min(1, ax.dot(up)))));

      // The daze starts at an impact (the crash jumps up) and runs DAZE s.
      const held = dev.daze === dev.daze;
      if (held || (st.crash > 0.5 && st.crash > lastCrash + 0.05)) {
        daze = held ? dev.daze : 0;
        hit.copy(st.pos);
        fy.copy(up);
        fz.copy(az).addScaledVector(up, -az.dot(up));
        if (fz.lengthSq() < 1e-6) fz.set(1, 0, 0).addScaledVector(up, -up.x);
        fz.normalize();
        fx.crossVectors(fy, fz);
      } else daze = Math.min(DAZE, daze + dt);
      lastCrash = st.crash;
      const t = daze;
      const stars = t < DAZE ? Math.min(1, t / 0.12) * Math.min(1, Math.max(0, (st.crash - 0.15) / 0.25)) : 0;
      const puffs = t < DAZE ? Math.min(1, t / 0.06) * Math.min(1, (DAZE - t) / 0.5) : 0;
      o[33] = t;
      o[34] = stars;
      o[35] = puffs;
      let radius = BIRD_RADIUS;
      if (stars > 0 || puffs > 0) {
        // World-level axes and the impact point in model space.
        qi.copy(st.quat).invert();
        const k = 1 / st.scale;
        for (let i = 0; i < 3; i++) {
          ax.copy(i === 0 ? fx : i === 1 ? fy : fz).applyQuaternion(qi);
          o[36 + 4 * i] = ax.x;
          o[37 + 4 * i] = ax.y;
          o[38 + 4 * i] = ax.z;
        }
        ax.copy(hit).sub(st.pos).applyQuaternion(qi).multiplyScalar(k);
        o[39] = ax.x;
        o[43] = ax.y;
        o[47] = ax.z;
        // The feathers drift up to ~1.6 model units from the impact.
        radius = Math.max(BIRD_RADIUS, ax.length() + 1.7);
      }
      mesh.geometry.boundingSphere!.radius = radius;
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
