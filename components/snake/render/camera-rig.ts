import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { GameStatus, Vec2 } from '../engine/types';

const PITCH = (48 * Math.PI) / 180;
const LOOK_AHEAD = 3.5;
const FOOD_PULL = 0.5; // share of the way the focus leans toward nearby food
const FOOD_PULL_R = 24;
const CRASH_OFFSET = 4.5; // on game over the focus sits below the head, so the crash shows above the panel
const MAX_FOCUS_R = 11;
const FOLLOW_TIME = 0.35;
const BLEND_TIME = 1.2;

export function playFocusGoal(head: Vec2, heading: number): Vec2 {
  const x = head.x + Math.cos(heading) * LOOK_AHEAD;
  const z = head.z + Math.sin(heading) * LOOK_AHEAD;
  const r = Math.hypot(x, z);
  return r > MAX_FOCUS_R ? { x: (x / r) * MAX_FOCUS_R, z: (z / r) * MAX_FOCUS_R } : { x, z };
}

/** Critically damped follow (Game Programming Gems 4, 1.10). */
export function smoothDamp(current: number, target: number, state: { v: number }, smoothTime: number, dt: number): number {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * decay;
  return target + (change + temp) * decay;
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(42, 1, 0.5, 1200);
  private fx = 0;
  private fz = 0;
  private vx = { v: 0 };
  private vz = { v: 0 };
  private blend = 0; // 0 = idle orbit, 1 = play follow
  private dist = 30;
  private idleTime = 0;
  private shakeAmp = 0;
  private reduced = false;
  private sunAzimuth = 0;
  private readonly raycaster = new Raycaster();
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private readonly tmpPos = new Vector3();
  private readonly tmpLook = new Vector3();
  private readonly idlePos = new Vector3();
  private readonly idleLook = new Vector3();
  private readonly hit = new Vector3();

  setAspect(aspect: number): void {
    const portrait = aspect < 0.8;
    this.camera.aspect = aspect;
    this.camera.fov = portrait ? 50 : 42;
    this.dist = portrait ? 34 : 27;
    this.camera.updateProjectionMatrix();
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
    if (on) this.shakeAmp = 0;
  }

  setSunAzimuth(rad: number): void {
    this.sunAzimuth = rad;
  }

  shake(amount: number): void {
    if (!this.reduced) this.shakeAmp = Math.max(this.shakeAmp, amount);
  }

  focus(): Vec2 {
    return { x: this.fx, z: this.fz };
  }

  update(dt: number, head: Vec2, heading: number, status: GameStatus, food: Vec2 | null = null): void {
    const want = status === 'idle' ? 0 : 1;
    this.blend = this.reduced ? want : Math.max(0, Math.min(1, this.blend + Math.sign(want - this.blend) * (dt / BLEND_TIME)));

    const goal = status === 'gameover' ? { x: head.x, z: head.z + CRASH_OFFSET } : playFocusGoal(head, heading);
    // Lean toward the food so it tends to stay in frame instead of trailing off an edge.
    if (food && status === 'playing') {
      const d = Math.hypot(food.x - goal.x, food.z - goal.z);
      const w = FOOD_PULL * Math.max(0, 1 - d / FOOD_PULL_R);
      goal.x += (food.x - goal.x) * w;
      goal.z += (food.z - goal.z) * w;
    }
    if (this.reduced) {
      this.fx = goal.x;
      this.fz = goal.z;
    } else {
      const follow = status === 'gameover' ? FOLLOW_TIME * 0.5 : FOLLOW_TIME;
      this.fx = smoothDamp(this.fx, goal.x, this.vx, follow, dt);
      this.fz = smoothDamp(this.fz, goal.z, this.vz, follow, dt);
    }

    const d = this.dist * (status === 'gameover' ? 0.8 : 1);
    this.tmpPos.set(this.fx, d * Math.sin(PITCH), this.fz + d * Math.cos(PITCH));
    this.tmpLook.set(this.fx, 0, this.fz);

    // Idle: a close front three-quarter shot of the resting snake, side-lit (90° from the sun) so
    // the ripples rake and the snake is not a backlit silhouette, with the horizon high in frame.
    this.idleTime += dt;
    const swing = this.reduced ? 0 : Math.sin(this.idleTime * 0.12) * 0.2;
    const a = this.sunAzimuth + Math.PI / 2 + swing;
    // The camera looks past the snake (pitch ≈ 9°), which puts the snake in the lower middle
    // and the horizon about 30% down, leaving real sky for the sun or moon and the stars.
    const idleDist = this.dist * 0.5;
    const sx = head.x;
    const sz = head.z + 1.2;
    this.idlePos.set(sx + Math.cos(a) * idleDist, idleDist * 0.36, sz + Math.sin(a) * idleDist);
    const beyond = idleDist * 1.27;
    this.idleLook.set(sx - Math.cos(a) * beyond, 0, sz - Math.sin(a) * beyond);

    const t = this.blend * this.blend * (3 - 2 * this.blend);
    this.camera.position.lerpVectors(this.idlePos, this.tmpPos, t);
    this.tmpLook.lerpVectors(this.idleLook, this.tmpLook, t);

    if (this.shakeAmp > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmp;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmp;
      this.shakeAmp *= Math.exp(-dt * 7);
    }
    this.camera.lookAt(this.tmpLook);
  }

  screenToGround(ndcX: number, ndcY: number): Vec2 | null {
    this.raycaster.setFromCamera(new Vector2(ndcX, ndcY), this.camera);
    const p = this.raycaster.ray.intersectPlane(this.ground, this.hit);
    return p ? { x: p.x, z: p.z } : null;
  }
}
