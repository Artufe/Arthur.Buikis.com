// Module-scope scratch math objects and a generic fixed-capacity pool. Per-frame code
// borrows from these instead of calling `new`.

import { Matrix4, Quaternion, Vector2, Vector3 } from 'three/webgpu';

/** Shared scratch. Only use inside a single function call; never hold across frames. */
export const V3A = new Vector3();
export const V3B = new Vector3();
export const V3C = new Vector3();
export const V3D = new Vector3();
export const V2A = new Vector2();
export const V2B = new Vector2();
export const QA = new Quaternion();
export const QB = new Quaternion();
export const M4A = new Matrix4();

export class Pool<T> {
  private readonly items: T[];
  private readonly free: T[];

  constructor(capacity: number, make: (i: number) => T) {
    this.items = new Array(capacity);
    this.free = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const it = make(i);
      this.items[i] = it;
      this.free[i] = it;
    }
  }

  /** Returns null when exhausted; callers drop the effect rather than allocate. */
  acquire(): T | null {
    return this.free.length > 0 ? (this.free.pop() as T) : null;
  }

  release(item: T) {
    this.free.push(item);
  }

  get all(): readonly T[] {
    return this.items;
  }
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent exponential approach: `damp(current, target, rate, dt)`. */
export const damp = (a: number, b: number, rate: number, dt: number) => b + (a - b) * Math.exp(-rate * dt);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
