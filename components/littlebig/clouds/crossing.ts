// The falling-through-the-clouds episode (v2, S1): a pure state machine, stepped once a frame by the
// clouds system and mirrored by the overlay shader (shaders.ts crossFrag).
//
// An episode starts on a TRIGGER (the eye crossing the cloud layer while moving, or about to enter a
// puff) and runs three stages:
//   in    the cloud fills the frame from the focus of expansion outward (the front `fill` sweeps
//         from 0 past the farthest corner), `tIn` s: ~6 frames at 30 fps, so the puffs are seen
//         blooming out of the point the eye flies into (at 0.08 s it read as a one-frame cut);
//   hold  covered, at least `hold` s after the frame is covered, and for as long as the eye is
//         inside a puff; cut short once the eye is well clear of the layer (`clear`), so a fast zoom
//         shows the city rising, not a white wall;
//   out   a hole opens at the focus of expansion and sweeps outward (`open`), the last puffs
//         streaming off the edges, `tOut` s, with a short overall fade at its end; then idle.
// Flying BACKWARD (climbing out while looking down: the focus is one of contraction) both fronts run
// the other way (`dir` = −1, latched when the episode starts): the cloud closes in from the corners
// like an iris and, leaving, shrinks away into the point the eye climbs from.
// So even a crossing that takes one frame shows ~0.3 s of cloud, eased in and out. A trigger while
// it is opening closes the hole again from where it is (never a second white-out on top of the
// first, never a dip). Contact (the eye inside a puff right now) is a separate floor the shader
// takes the max with.
//
// Radii are ON-SCREEN fractions: 0 at the screen point nearest the focus of expansion (the focus
// itself when it is in frame), 1 at the farthest corner (`frontRange`). So the whole fill and the
// whole opening play out on screen wherever the eye is flying: with the focus off-screen the
// opening used to sweep mostly outside the frame and the overlay vanished in a frame or two.

export interface CrossTiming {
  /** Ease-in (s): the fill front sweeps out from the focus of expansion. */
  tIn: number;
  /** Minimum time fully covered (s). */
  hold: number;
  /** Ease-out (s): the hole opens and sweeps outward. */
  tOut: number;
}

/**
 * ~0.3 s with at least half the frame covered; ~0.55 s from the first puff to clear: ~0.2 s of puffs
 * blooming, a short hold, ~0.3 s of the hole opening on the city.
 */
export const CROSS_TIMING: CrossTiming = { tIn: 0.24, hold: 0.02, tOut: 0.34 };
/** Reduced motion: a still fade, slower in and out (no brightness flash), a short hold. */
export const CROSS_TIMING_RM: CrossTiming = { tIn: 0.2, hold: 0.04, tOut: 0.3 };

/** Contact above this keeps an episode in its hold. */
export const CONTACT_HOLD = 0.45;
/** How far past the farthest corner the fill front travels (fraction): the corner puffs grow full. */
const MARGIN = 0.18;
/** The opening runs from just inside the nearest point to just past the farthest corner. */
const OPEN_MARGIN = 0.12;
/** The overall fade runs over the last part of the opening (linear progress). */
const FADE_FROM = 0.72;

/** Episode stages. */
export const Stage = { Idle: 0, In: 1, Hold: 2, Out: 3 } as const;
export type Stage = (typeof Stage)[keyof typeof Stage];

export interface Crossing {
  stage: Stage;
  /** Linear progress of the fill front (0 → 1) and of the opening (0 → 1). */
  fillK: number;
  openK: number;
  /** Seconds of hold left. */
  holdLeft: number;
  /**
   * Outputs (eased): how much cloud overall 0..1 (the reduced-motion fade's level), the fill front
   * and the hole radius (fractions, see top).
   */
  cover: number;
  fill: number;
  open: number;
  /** Overall opacity: 1, easing to 0 over the end of the opening (no puff ever pops off). */
  fade: number;
  /** +1: the fronts run outward from the focus (flying forward); −1: inward (flying backward). */
  dir: number;
}

export function createCrossing(): Crossing {
  return { stage: Stage.Idle, fillK: 0, openK: 0, holdLeft: 0, cover: 0, fill: 0, open: -MARGIN, fade: 1, dir: 1 };
}

const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** End the episode at once (a teleport: setView, shots). */
export function resetCrossing(s: Crossing): void {
  s.stage = Stage.Idle;
  s.dir = 1;
  s.fillK = s.openK = s.holdLeft = 0;
  s.cover = 0;
  s.fill = 0;
  s.open = -MARGIN;
  s.fade = 1;
}

/** Hold an episode at a given cover (debug: `clouds.force`, for paired perf A/B and stills). */
export function forceCrossing(s: Crossing, k: number): void {
  s.stage = Stage.Hold;
  s.fillK = 1;
  s.openK = 0;
  s.holdLeft = 1;
  s.cover = 1;
  s.fill = 1 + MARGIN;
  // k < 1 opens a hole of the matching size.
  s.open = (1 - Math.min(1, k)) * (1 + 2 * OPEN_MARGIN) - OPEN_MARGIN;
  s.fade = 1;
}

/**
 * Advance by dt seconds. `trigger`: a crossing event this frame. `contact`: 0..1, how far the eye is
 * inside a cloud right now. `clear`: the eye is well clear of the layer (ends the hold early).
 * `sign`: +1 flying forward, −1 backward (latched as `dir` when an episode starts). Zero allocation.
 */
export function stepCrossing(s: Crossing, dt: number, trigger: boolean, contact: number, t: CrossTiming = CROSS_TIMING, clear = false, sign = 1): void {
  if (trigger) {
    if (s.stage === Stage.Idle) {
      s.fillK = 0;
      s.openK = 0;
      s.dir = sign < 0 ? -1 : 1;
    }
    s.stage = s.fillK >= 1 && s.openK <= 0 ? Stage.Hold : Stage.In;
    // The hold counts from when the frame is covered (again: closing an opening hole takes as long
    // as it took to open at the ease-in rate), so a trigger always buys the rest of the fill + hold.
    s.holdLeft = t.hold + t.tIn * (1 - s.fillK + s.openK);
  }
  if (s.stage !== Stage.Idle) {
    s.holdLeft = Math.max(0, s.holdLeft - dt);
    // Well clear of the layer: the hold ends as soon as the frame is covered.
    if (clear && contact <= CONTACT_HOLD) s.holdLeft = Math.min(s.holdLeft, t.tIn * (1 - s.fillK));
    const holding = s.holdLeft > 0 || contact > CONTACT_HOLD;
    // Fill: always toward 1 during an episode.
    s.fillK = Math.min(1, s.fillK + dt / Math.max(1e-3, t.tIn));
    if (holding) {
      // Close any opening back up (a re-trigger while fading out) at the ease-in rate.
      s.openK = Math.max(0, s.openK - dt / Math.max(1e-3, t.tIn));
      s.stage = s.fillK < 1 || s.openK > 0 ? Stage.In : Stage.Hold;
    } else {
      s.stage = Stage.Out;
      s.openK = Math.min(1, s.openK + dt / Math.max(1e-3, t.tOut));
      if (s.openK >= 1) {
        s.stage = Stage.Idle;
        s.fillK = 0;
        s.openK = 0;
      }
    }
  }
  if (s.stage === Stage.Idle) {
    s.cover = 0;
    s.fill = 0;
    s.open = -MARGIN;
    s.fade = 1;
    return;
  }
  // The fill front's radius goes as an eased progress to the ¾ power: the area it covers (∝ r²)
  // then grows evenly, so the puffs blooming round the focus are seen over several frames instead of
  // the frame filling in the middle two. The hole's radius eases out a little (x^0.75) for the same
  // reason: a quick start and a slower finish clear the frame at an even pace, the last puffs
  // lingering at the corners. Backward the fronts run from the corners in, where the area is: the
  // fill's mirror-image curve (the gap left round the focus shrinks as (1 − x)^¾), and a near-linear
  // opening that shrinks the last cloud into the focus at an even pace.
  const e = ease(s.fillK);
  const f = s.dir > 0 ? Math.pow(e, 0.75) : 1 - Math.pow(1 - e, 0.75);
  const o = s.dir > 0 ? Math.pow(s.openK, 0.75) : Math.pow(s.openK, 0.7);
  s.cover = e * (1 - ease(s.openK));
  s.fill = f * (1 + MARGIN);
  // (Backward the last cloud shrinks to nothing exactly as the opening ends: no margin at the focus.)
  s.open = o * (1 + (s.dir > 0 ? 2 : 1) * OPEN_MARGIN) - OPEN_MARGIN;
  s.fade = 1 - ease((s.openK - FADE_FROM) / (1 - FADE_FROM));
}

/**
 * The fronts' on-screen radius range for a focus of expansion at uv (fx, fy) (0..1 across the frame,
 * may lie outside it) and aspect w/h, in frame-height units: [nearest screen point, farthest
 * corner]. Into out (x = near, y = far).
 */
export function frontRange(fx: number, fy: number, aspect: number, out: { x: number; y: number }): { x: number; y: number } {
  const dx = Math.max(0, -fx, fx - 1) * aspect;
  const dy = Math.max(0, -fy, fy - 1);
  out.x = Math.hypot(dx, dy);
  out.y = Math.max(out.x + 0.3, Math.hypot(Math.max(fx, 1 - fx) * aspect, Math.max(fy, 1 - fy)));
  return out;
}

/**
 * Coverage the overlay draws at on-screen radius fraction r (see top): the TS twin of the shader's
 * front test, for the specs. `soft` is the fronts' half width.
 */
export function coverageAt(s: Crossing, r: number, soft = 0.12): number {
  if (s.stage === Stage.Idle) return 0;
  // Backward: the fronts are measured from the farthest corner (the shader's lbRR does the same).
  if (s.dir < 0) r = 1 - r;
  const inFill = 1 - ease((r - s.fill + soft) / (2 * soft));
  const outOpen = ease((r - s.open + soft) / (2 * soft));
  return Math.min(inFill, outOpen) * s.fade;
}
