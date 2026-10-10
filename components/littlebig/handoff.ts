// The window → /planet handoff and the one canvas loader. Tiny and engine-free: the window host and
// app/planet import it statically, so it must not pull in anything of the game.

import type { PlanetSession } from './core/session';

/** Where a player is: what EngineOptions.resume takes. */
export type PlanetResume = PlanetSession;

/**
 * The one dynamic import of the canvas wrapper. next/dynamic and the prefetch must share this call
 * site: two `import('./littlebig-canvas')` expressions became two chunks with the same module, so a
 * prefetched open still waited on a second request.
 */
export const loadLittlebigCanvas = () => import('./littlebig-canvas');

/** Warm the LITTLEBIG chunks (JS only; the world is generated on open). Safe to call repeatedly. */
export function prefetchLittlebig() {
  void loadLittlebigCanvas();
  void import('./core/engine');
}

// A running window canvas registers how to read its player's place; ↗ expand takes it, and the
// /planet canvas boots there (same view, same sim time, no second reveal) instead of at orbit.
let reader: (() => PlanetResume | null) | null = null;
let pending: (PlanetResume & { at: number }) | null = null;

/** The window canvas, while its engine runs. Returns the unregister function. */
export function provideHandoff(read: () => PlanetResume | null): () => void {
  reader = read;
  return () => {
    if (reader === read) reader = null;
  };
}

/** ↗ expand: remember where the window's player is, for the /planet page to pick up. */
export function stashHandoff() {
  const r = reader?.();
  pending = r ? { ...r, at: Date.now() } : null;
}

/** The /planet canvas, once at boot. */
export function takeHandoff(): PlanetResume | null {
  const p = pending;
  pending = null;
  // (A handoff the page never picked up promptly is stale: /planet reached some other way later.)
  return p && Date.now() - p.at < 30_000 ? { view: p.view, t: p.t, camera: p.camera } : null;
}
