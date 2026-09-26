// First-person camera: the pose's eye plus a spring-damped head offset (driven by the eye's
// own acceleration and by impulses), trauma-based shake, eased FOV kick / roll / pitch offsets,
// and a hard guarantee that the lens never dips below the water surface.
// Reduced motion: no shake and no FOV kick (bob is already removed by the poses).

import { type PerspectiveCamera, Vector3 } from 'three/webgpu';
import type { GLContext, OceanSample } from '../core/contracts';
import { damp } from '../core/pool';
import type { CameraFx } from './api';
import { wobble } from './rigmath';

const BASE_FOV = 72;

export class CameraRig implements CameraFx {
  fovKick = 0;
  roll = 0;
  pitchOffset = 0;
  readonly offset = new Vector3();
  private trauma = 0;
  private readonly spring = new Vector3();
  private readonly springV = new Vector3();
  private readonly prevEye = new Vector3();
  private readonly prevVel = new Vector3();
  private readonly vel = new Vector3();
  private hasPrev = false;
  private fov = BASE_FOV;
  private rollS = 0;
  private pitchS = 0;
  private t = 0;
  readonly final = new Vector3();
  private readonly s: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 0 };
  /** Clearance kept between the lens and the water (m). */
  clearance = 0.14;

  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  impulse(x: number, y: number, z: number) {
    this.springV.x += x;
    this.springV.y += y;
    this.springV.z += z;
  }

  /** Snap the springs (teleports). */
  reset(eye: Vector3) {
    this.prevEye.copy(eye);
    this.prevVel.set(0, 0, 0);
    this.spring.set(0, 0, 0);
    this.springV.set(0, 0, 0);
    this.hasPrev = true;
  }

  /** `waterHint`: water height near the body; the lens is only probed when it is close to it. */
  apply(ctx: GLContext, eye: Vector3, yaw: number, pitch: number, camPitch: number, camRoll: number, dt: number, waterHint = 0) {
    const cam: PerspectiveCamera = ctx.camera;
    const reduced = ctx.reducedMotion;
    this.t += dt;
    if (!this.hasPrev) this.reset(eye);
    if (dt > 0) {
      // Head lag: the neck is a spring; the eye's acceleration drives it.
      this.vel.subVectors(eye, this.prevEye).divideScalar(dt);
      const ax = (this.vel.x - this.prevVel.x) / dt;
      const ay = (this.vel.y - this.prevVel.y) / dt;
      const az = (this.vel.z - this.prevVel.z) / dt;
      this.prevEye.copy(eye);
      this.prevVel.copy(this.vel);
      const w = 13;
      const z = 0.75;
      const steps = Math.max(1, Math.ceil(dt * 120));
      const h = dt / steps;
      // Clamp spikes (teleports, mode snaps) so they can't kick the head.
      const lim = 40;
      const fx = Math.max(-lim, Math.min(lim, ax));
      const fy = Math.max(-lim, Math.min(lim, ay));
      const fz = Math.max(-lim, Math.min(lim, az));
      for (let i = 0; i < steps; i++) {
        this.springV.x += (-w * w * this.spring.x - 2 * z * w * this.springV.x - fx * 0.5) * h;
        this.springV.y += (-w * w * this.spring.y - 2 * z * w * this.springV.y - fy * 0.5) * h;
        this.springV.z += (-w * w * this.spring.z - 2 * z * w * this.springV.z - fz * 0.5) * h;
        this.spring.addScaledVector(this.springV, h);
      }
      const len = this.spring.length();
      if (len > 0.06) this.spring.multiplyScalar(0.06 / len);
      this.trauma = Math.max(0, this.trauma - dt * 1.4);
      this.fov = damp(this.fov, BASE_FOV + (reduced ? 0 : this.fovKick), 3, dt);
      this.rollS = damp(this.rollS, this.roll + camRoll, 6, dt);
      this.pitchS = damp(this.pitchS, this.pitchOffset + camPitch, 6, dt);
    }
    const f = this.final.copy(eye).add(this.spring).add(this.offset);
    let sp = 0;
    let sy = 0;
    let sr = 0;
    if (!reduced && this.trauma > 0) {
      const k = this.trauma * this.trauma;
      const tt = this.t * 22;
      sp = k * 0.022 * wobble(tt, 1);
      sy = k * 0.022 * wobble(tt, 2);
      sr = k * 0.03 * wobble(tt, 3);
      f.y += k * 0.012 * wobble(tt, 4);
    }
    // Never under the water: probe at the lens and just ahead of it whenever the lens is within
    // reach of a wave crest (the swell is at most ~2.5 m above the body's water level).
    if (f.y - waterHint < 3) {
      const o = ctx.services.ocean;
      const fwdX = -Math.sin(yaw) * 0.18;
      const fwdZ = -Math.cos(yaw) * 0.18;
      const h0 = o.sample(f.x, f.z, this.s).height;
      const h1 = o.sample(f.x + fwdX, f.z + fwdZ, this.s).height;
      const floor = Math.max(h0 + this.clearance, h1 + this.clearance * 0.7);
      const band = 0.06;
      const x = (f.y - floor) / band;
      // Soft floor (softplus): identity well above it, eases onto it, never below it.
      if (x < 3) f.y = floor + (band * Math.log(1 + Math.exp(3 * x))) / 3;
    }
    cam.position.copy(f);
    cam.rotation.set(pitch + this.pitchS + sp, yaw + sy, this.rollS + sr, 'YXZ');
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
