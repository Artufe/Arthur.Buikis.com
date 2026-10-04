// The reveal clock behind ctx.reveal and the lbRevealClock uniform. See RevealAnimator in
// contracts.ts. Wall-clock driven (realDt), so a frozen sim still reveals; instant in shot mode.

import type { RevealAnimator } from './contracts';
import type { SharedUniforms } from './uniforms';

export const INSTANT_CLOCK = 1e6;

export interface RevealDriver extends RevealAnimator {
  start(): void;
  tick(realDt: number): void;
}

/** CPU twin of lbSpring (render/toon.ts). */
export function springEase(p: number): number {
  p = Math.min(1, Math.max(0, p));
  return 1 - Math.exp(-6.5 * p) * Math.cos(9 * p) * (1 - p);
}

export function createReveal(instant: boolean, uniforms: SharedUniforms): RevealDriver {
  let clock = instant ? INSTANT_CLOCK : 0;
  let running = instant;
  let nextSlot = 0;
  uniforms.lbRevealClock.value = clock;
  return {
    get clock() {
      return clock;
    },
    instant,
    start() {
      running = true;
    },
    tick(realDt) {
      if (!running || instant) return;
      clock += realDt;
      uniforms.lbRevealClock.value = clock;
    },
    slot(duration) {
      if (instant) return 0;
      const start = Math.max(clock + 0.05, nextSlot);
      // Cascade: the next system may start before this one finishes.
      nextSlot = start + Math.min(duration * 0.4, 0.35);
      return start;
    },
    spring: springEase,
    progress(start, duration) {
      return Math.min(1, Math.max(0, (clock - start) / Math.max(1e-6, duration)));
    },
  };
}
