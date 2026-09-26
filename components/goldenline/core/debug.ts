// window.__goldenline — the hook scripts/goldenline-shot.mjs drives for deterministic
// screenshots, frame sequences and perf runs. Installed in dev, and in prod only with ?shot.

import { SHOTS, applyShot } from '../lab/shots';
import type { GLContext } from './contracts';

export interface DebugHook {
  ctx: GLContext;
  freeze(on: boolean): void;
  /** Advance n frames of dt seconds each, then render once. */
  step(n: number, dt?: number): void;
  setTime(t: number): void;
  /** Lock the camera (player stops driving it). yaw/pitch in radians; see layout.ts yaw convention. */
  camera(x: number, y: number, z: number, yaw: number, pitch?: number): void;
  releaseCamera(): void;
  shot(name: string): boolean;
  shots(): string[];
  setParam(key: string, value: number | boolean): void;
  params(): Array<{ key: string; value: number | boolean }>;
  render(): void;
  perf(): { median: number; p99: number; fps: number; low1: number; max: number; hitches: number; drawCalls: number; triangles: number; systemMs: Record<string, number>; gpuMs: Record<string, number> };
  resetPerf(): void;
  /** Where startup time went: stage → ms (plus 'total'). */
  boot(): Array<{ stage: string; ms: number }>;
}

declare global {
  interface Window {
    __goldenline?: DebugHook;
  }
}

export function installDebugHook(
  ctx: GLContext,
  deps: { stepFrames(n: number, dt: number): void; renderFrame(): void; enabled: boolean },
) {
  if (!deps.enabled || typeof window === 'undefined') return () => {};
  const hook: DebugHook = {
    ctx,
    freeze(on) {
      ctx.time.frozen = on;
    },
    step(n, dt = 1 / 60) {
      deps.stepFrames(n, dt);
    },
    setTime(t) {
      ctx.time.t = t;
    },
    camera(x, y, z, yaw, pitch = 0) {
      ctx.debug.cameraLocked = true;
      ctx.camera.position.set(x, y, z);
      ctx.camera.rotation.set(pitch, yaw, 0, 'YXZ');
      ctx.camera.updateMatrixWorld();
    },
    releaseCamera() {
      ctx.debug.cameraLocked = false;
    },
    shot(name) {
      const s = SHOTS[name];
      if (!s) return false;
      applyShot(ctx, s, hook);
      return true;
    },
    shots: () => Object.keys(SHOTS),
    setParam(key, value) {
      ctx.params.set(key, value);
    },
    params: () => ctx.params.list.map((p) => ({ key: p.key, value: p.value })),
    render() {
      deps.renderFrame();
    },
    perf() {
      const s = ctx.perf.summarize();
      const info = ctx.renderer.info.render as unknown as { drawCalls?: number; calls?: number; triangles: number };
      return {
        ...s,
        drawCalls: info.drawCalls ?? info.calls ?? 0,
        triangles: info.triangles,
        systemMs: { ...ctx.perf.systemMs },
        gpuMs: { ...ctx.perf.gpuMs },
      };
    },
    resetPerf() {
      ctx.perf.reset();
    },
    boot: () => ctx.perf.boot.slice(),
  };
  window.__goldenline = hook;
  return () => {
    if (window.__goldenline === hook) delete window.__goldenline;
  };
}
