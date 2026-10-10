// Camera avoidance policy; pure fixed-step history, independent of walker routing.
import { CURB_H, EYE_HEIGHT, ROAD_H } from '../world/config';

/** Below this altitude (m) a camera settling onto the street, or standing still, is a lens walkers make way for. */
const LENS_ALT = 6;
/** The berth (m) walkers give a lens: past it at this much, or (narrow pavements) they turn round before it. */
const LENS_R = 1.6;
/** Fixed steps between the speed samples (0.1 s at 60 Hz), the history ring, and the furthest look ahead (m). */
const LENS_LAG = 6;
const LENS_HIST = 16;
const LENS_RUN = 15;
/** A settling camera comes to rest at eye height over the pavement (m, ViewState.altTerrain). */
const LENS_EYE = EYE_HEIGHT + ROAD_H + CURB_H;

/**
 * How walkers see the camera, from its plan position and altitude each fixed step (`step`'s camOn,
 * camX/camZ, camR and lens). A walking player is avoided like a standing person (r 0.75, below
 * 3 m). A camera standing still, or settling down onto the pavement (the dive, scroll or fly-to: a
 * continuous descent, so no cut clears the lens), is a lens from LENS_ALT down: seen from further
 * ahead and given LENS_R, so nobody walks up to it, parks in front of it, or brushes past it at
 * arm's length. While it settles, the lens is where it will come to rest (x, z): its plan position
 * run on by its glide (horizontal / vertical speed × the height left to eye level, × 1.5 for the
 * flare: on the scripted dive it closes from 4.6 m short of the landing at 5.5 m up to within 0.1 m
 * from 2.4 m), or by its
 * stopping distance (v² / 2a) once it brakes, whichever is shorter. Walkers near the landing then
 * turn round before it touches down, not as the camera sweeps up to them.
 */
export class LensWatch {
  on = false;
  r = 0.75;
  lens = false;
  /** Where walkers see the camera (plan m). */
  x = 0;
  z = 0;
  /** Recent plan positions (a ring of fixed steps), for the speed and braking now and 0.1 s ago. */
  private readonly hx = new Float64Array(LENS_HIST);
  private readonly hz = new Float64Array(LENS_HIST);
  private readonly ha = new Float64Array(LENS_HIST);
  private n = 0;
  private alt = Infinity;
  private still = 0;
  private settle = 0;

  update(dt: number, x: number, z: number, alt: number, inCity: boolean): void {
    // a camera cut (> 4 m in one step): the speed history starts over
    if (this.n > 0) {
      const l = (this.n - 1) % LENS_HIST;
      if ((x - this.hx[l]) ** 2 + (z - this.hz[l]) ** 2 > 16) this.n = 0;
    }
    const k = this.n % LENS_HIST;
    this.hx[k] = x;
    this.hz[k] = z;
    this.ha[k] = alt;
    this.n++;
    const p1 = (this.n - 1 - LENS_LAG + LENS_HIST * 4) % LENS_HIST;
    const mx = x - this.hx[(this.n - 2 + LENS_HIST) % LENS_HIST];
    const mz = z - this.hz[(this.n - 2 + LENS_HIST) % LENS_HIST];
    this.still = this.n > 1 && mx * mx + mz * mz < (0.3 * dt) ** 2 ? Math.min(1, this.still + dt) : 0;
    // (a scripted 30 fps descent moves on every other 60 Hz step: the settle flag holds 0.6 s)
    this.settle = inCity && alt < LENS_ALT && alt < this.alt - 0.02 * dt ? 0.6 : Math.max(0, this.settle - dt);
    this.alt = alt;
    const still = this.still >= 0.5;
    this.lens = inCity && alt < LENS_ALT && (still || this.settle > 0);
    this.on = inCity && (alt < 3 || this.lens);
    this.r = this.lens ? LENS_R : 0.75;
    this.x = x;
    this.z = z;
    if (!this.lens || still || this.n <= 2 * LENS_LAG) return;
    // speed over the last LENS_LAG steps and the LENS_LAG before
    const p2 = (p1 - LENS_LAG + LENS_HIST * 4) % LENS_HIST;
    const w = LENS_LAG * dt;
    const vx = (x - this.hx[p1]) / w;
    const vz = (z - this.hz[p1]) / w;
    const v1x = (this.hx[p1] - this.hx[p2]) / w;
    const v1z = (this.hz[p1] - this.hz[p2]) / w;
    const v = Math.sqrt(vx * vx + vz * vz);
    if (v < 0.05) return;
    const brake = (Math.sqrt(v1x * v1x + v1z * v1z) - v) / w;
    const sink = (this.ha[p1] - alt) / w;
    let run = sink > 0.05 ? (1.5 * v * Math.max(0, alt - LENS_EYE)) / sink : LENS_RUN;
    if (brake > 0.5) run = Math.min(run, (v * v) / (2 * brake));
    run = Math.min(run, LENS_RUN);
    this.x = x + (vx / v) * run;
    this.z = z + (vz / v) * run;
  }
}
