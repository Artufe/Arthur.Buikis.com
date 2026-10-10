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
//         streaming off the edges, `tOut` s; over its end the hole runs ahead and the last cloud
//         shrinks away (then a short fade); then idle.
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
 * ~0.3 s with at least half the frame covered; ~0.65 s from the first puff to clear: ~0.2 s of puffs
 * blooming, a short hold, ~0.4 s of the hole opening on the city (the last of it the hole running
 * ahead while the last cloud shrinks away solid: see `alpha`).
 */
export const CROSS_TIMING: CrossTiming = { tIn: 0.24, hold: 0.02, tOut: 0.42 };
/** Reduced motion: a still fade, slower in and out (no brightness flash: see stepRmLevel), a short hold. */
export const CROSS_TIMING_RM: CrossTiming = { tIn: 0.2, hold: 0.04, tOut: 0.3 };

/** Reduced motion: the still fade's ceiling (the fogged city stays faintly visible). */
export const RM_CAP = 0.85;
/**
 * Reduced motion: the fade's level never rises faster than 0 → 1 in RM_RISE s, nor falls faster than
 * 1 → 0 in RM_FALL s (≤ 0.14 a frame at 30 fps). Its target (the episode's cover, or the eye's
 * contact with a puff, which comes in at once) could step 0 → 1 within a frame at dive speed: a
 * brightness flash, exactly what reduced motion must not show.
 */
export const RM_RISE = 0.24;
export const RM_FALL = 0.3;

/** One frame of the reduced-motion fade: `level` toward `target` (capped at RM_CAP), rate-limited. */
export function stepRmLevel(level: number, target: number, dt: number): number {
  const t = Math.min(RM_CAP, Math.max(0, target));
  if (t > level) return Math.min(t, level + dt / RM_RISE);
  return Math.max(t, level - dt / RM_FALL);
}

/**
 * One frame of the reduced-motion fade, teleports included: a jump (a ride's cut, setView) ramps the
 * fade out like any other frame instead of zeroing it (0.49 → 0 in a frame was a cut). Only a frozen
 * frame (dt = 0: the shot tool's setup) takes the target at once.
 */
export function rmFadeStep(level: number, target: number, dt: number, jump: boolean): number {
  if (jump && dt <= 0) return Math.min(RM_CAP, Math.max(0, target));
  return stepRmLevel(level, target, dt);
}

/** Moved further than this (m) in one frame: a teleport even with time running (no camera move is that fast). */
export const JUMP_DIST = 400;

/**
 * Was this frame's camera move a teleport (setView, a shot, an instant ride: the camera placed on a
 * frozen frame), which ends any episode? Motion is never one, however fast: a ride's transition climbs
 * through the layer at 15–25 m a frame at 30 fps, and a distance threshold (25 m) once took its
 * crossing for a teleport and popped a third-grown overlay off in one frame. `moved2`: the squared
 * distance moved (m²); `dt`: the frame's time step (s).
 */
export function isTeleport(moved2: number, dt: number): boolean {
  return (dt <= 0 && moved2 > 1) || moved2 > JUMP_DIST * JUMP_DIST;
}

/** Contact above this keeps an episode in its hold. */
export const CONTACT_HOLD = 0.45;
/** How far past the farthest corner the fill front travels (fraction): the corner puffs grow full. */
const MARGIN = 0.18;
/** The opening runs from just inside the nearest point to just past the farthest corner. */
const OPEN_MARGIN = 0.12;
/**
 * The overall fade runs over the last part of the opening (linear progress). Backward it starts
 * sooner: the last cloud shrinks away into the focus, and solid it read as a lump sliding out of the
 * frame for ~5 frames; fading as it goes, it dissolves.
 */
const FADE_FROM = 0.72;
/** How far (front fraction) the hole runs ahead of its sweep by the end of the fade. */
const RETREAT = 0.22;
const FADE_FROM_BACK = 0.55;
const FADE_TO_BACK = 0.95;

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
  /** How far the episode has faded: 1, easing to 0 over the end of the opening. */
  fade: number;
  /**
   * The overlay's opacity: 1 until the fade is half done, then to 0. The rest of the fade is the hole
   * opening faster (RETREAT): the last cloud shrinks away solid instead of thinning, since puffs faded
   * by alpha showed every overlap and ink line through each other (a heap of glass bubbles).
   */
  alpha: number;
  /** +1: the fronts run outward from the focus (flying forward); −1: inward (flying backward). */
  dir: number;
}

export function createCrossing(): Crossing {
  return { stage: Stage.Idle, fillK: 0, openK: 0, holdLeft: 0, cover: 0, fill: 0, open: -MARGIN, fade: 1, alpha: 1, dir: 1 };
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
  s.alpha = 1;
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
  s.alpha = 1;
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
    s.alpha = 1;
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
  // (Backward the fade is done a little before the last cloud has shrunk to nothing: its last few
  // frames were a small translucent scalloped disc at the focus.)
  const ff = s.dir > 0 ? FADE_FROM : FADE_FROM_BACK;
  const fe = s.dir > 0 ? 1 : FADE_TO_BACK;
  s.fade = 1 - ease((s.openK - ff) / (fe - ff));
  s.alpha = ease(s.fade * 1.6);
  // (Backward the last cloud shrinks to nothing exactly as the opening ends: no margin at the focus.)
  // While it fades the hole runs ahead (RETREAT), so what is left shrinks away solid.
  s.open = o * (1 + (s.dir > 0 ? 2 : 1) * OPEN_MARGIN) - OPEN_MARGIN + (1 - s.fade) * RETREAT;
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
  return Math.min(inFill, outOpen) * s.alpha;
}
