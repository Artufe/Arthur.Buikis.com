// The camera director (D1, V2 §4): modes on top of the v1 explore flow (camera/index.ts).
//
//   explore  v1's orbit ↔ street model, untouched; the director only watches the clicks (a click on
//            anything that moves rides it) and the hover (the cursor turns to a pointer over a
//            pickable, ≤ 10 Hz).
//   ride     camera/rides/rig.ts: chase / eyes / alongside a registered Trackable.
//   bird     camera/bird/: an arcade bird (flight.ts) and its chase camera (cam.ts); the bird mesh
//            is drawn by the stage-2 bird system from birdRender().
//
// Every switch is a transition from a coasting snapshot of the camera as it was (it carries on at its
// own speed and bleeds it off: never a dead stop) to the live pose of the new mode.
//   enter    a planned path (rides/path.ts) to the ride's own settled framing — swung round the
//            subject when coming from its far side — travelled on a clock (rides/blend.ts clockU)
//            through a time map that gives every stretch the time its view turn (≤ TURN_PLAN) and its
//            metres (≤ vMaxAt(h)) need; the gaze — the ridden thing held in frame once it is in, its
//            pitch kept off the vertical and the planet's limb in frame — and the roll (a level horizon
//            mid-way) are blended as angles; carried live in
//            the subject's frame; the clock slows where a target gone astray would turn the view
//            faster than planned. Planned over the two frames after the click. ≤ 2 s across town,
//            ≤ 2.5 s up to space or round the planet; once blend = 1 the ride is settled. Reduced
//            motion: a short direct move, dipped through the middle (directPose).
//   exit     explore is handed a placement where the glide comes to rest (camera/index.ts handoff),
//            looking back down at the world, and the roll, pitch and lens blend over in under a
//            second: no jump, whichever altitude it ends at (orbit or street).
//   bird     from orbit, an enter; from anywhere lower, a launch: the bird appears just ahead and
//            its chase runs from the first frame.
// What is drawn follows the wanted orientation within a turn rate and a turn acceleration
// (rides/blend.ts TurnFollower): a backstop, so a turn always eases in and out.

import { Quaternion, Vector3 } from 'three';
import type { CameraMode, LBContext, Trackable, TrackPose } from '../core/contracts';
import { CITY_PLAN_RADIUS, PLATEAU_HEIGHT, R, SPACE_MAX, SPACE_MIN } from '../world/config';
import { fromSphere, planToDir } from '../world/city/frame';
import { footprintDistance } from '../world/city/index-grid';
import type { Building } from '../world/city/types';
import { horizonDistance, latLonFromDir, v3 } from '../world/sphere';
import { hyp } from '../world/hyp';
import { BIRD_CAM, BirdCam } from './bird/cam';
import { BIRD, BirdFlight, type BirdEnv, type BirdInput } from './bird/flight';
import { birdRender } from './bird/shared';
import type { CameraInput } from './input';
import { SOLID, solidsIn } from './landing';
import { lensFov, springStep } from './model';
import { angularVelocity, arcPoint, blendPose, clockPeak, clockU, Coast, copyFramePose, createFramePose, ease, hopFor, LiftProfile, lookPointOf, lookQuat, transitionDuration, TurnFollower, type FramePose } from './rides/blend';
import { CLOUD_HI, CLOUD_LO, EnterPath, spiralCost, TimeMap, type PathEnv } from './rides/path';
import { NEAR_D, NearTrip, type NearEnv } from './rides/near';
import { elevationFor, horizonDip } from './rides/rig';
import { RideRig, type RideEnv } from './rides/rig';

const DEG = Math.PI / 180;
/** The bird tops out this far under the space layer (m above sea level). */
export const BIRD_CEILING = SPACE_MIN - 12;
/** Hover picking interval (s): ≤ 10 Hz. */
const HOVER_DT = 0.1;
/** Exit blend length (s). */
const EXIT_DUR = 0.95;
/** A ridden trackable that stops drawing is held this long before the ride lets go (s). */
const LOST_HOLD = 0.6;
/**
 * The widest framing is a stop: zooming on out past it exits only on a NEW gesture (after this long
 * at rest there, s) or after this long of continued zooming out against it (s).
 */
const STOP_REST = 0.3;
const STOP_PUSH = 0.4;
/**
 * A transition's top speed (m/s) at h m above sea level: the ground streams past at a bounded rate
 * (≈ 2.4 heights a second low down: 24 m/s rising out of a street, ~390 m/s at the station's height).
 */
const vMaxAt = (h: number) => 2.8 * (Math.max(0, h) + 8);
/** The planned view never turns faster than this (rad/s): the time map gives every turn its time. */
const TURN_PLAN = 150 * DEG;
/**
 * Longest enter transition (s), before any slowing for a target gone astray (D1f: trips are snappy —
 * ~1.2–2 s next door and across town, ≤ 2.5 s up to space or round the planet, no dead air).
 */
const DUR_MAX = 2.5;
/** Longest ordinary enter (s) before its turns ask for more: across town, onto a car, into someone's eyes. */
const DUR_ORD = 1.85;
/**
 * (D1f r5) The plan's caps (s from the click, the two planning frames included): an ordinary trip,
 * one into someone's eyes, a far one (through the cloud band, up to space, round the planet). It takes
 * more than DUR_ORD only as far as its turns ask, up to these.
 */
const CAP_ORD = 2.1;
const CAP_EYES = 2.4;
const CAP_FAR = 2.5;
/** (D1f r5) Live, a target gone astray (a car U-turning as the camera reaches it) may slow any trip up to this (s; it lands by 2.5 s). */
const CAP_HARD = 2.45;
/** Above this a trip counts as a far one (m above sea level: over the cloud band). */
const CLOUD_HI_M = 52;
/**
 * The look point's horizontal share of the gaze (cos of its pitch) under which the trip's heading
 * stops following its direction (nearly straight below: it would flip as the camera passes over).
 */
const AZ_LO = 0.04;
const AZ_HI = 0.2;
/**
 * The gaze's limits against the planet's limb (rad): an aim behind the planet looks this far under
 * the horizon (the limb at the frame's upper third with a ~50° lens), and a look up at something in
 * the sky stays within this of the horizon unless the subject itself is higher (the planet fills at
 * least the lower third).
 */
const LIMB_DROP = Math.atan(Math.tan(25 * DEG) / 3);
const LIMB_UP = 5 * DEG;
/**
 * The approach swings round the subject (path.ts pivot) when the camera starts more than PIVOT_FROM
 * round from the side it comes in from, to PIVOT_TO from the camera's side (rad).
 */
const PIVOT_FROM = 75 * DEG;
const PIVOT_TO = 55 * DEG;
const PIVOT_TRY = [1, 0.66, 0.33] as const;
/** The near trip's clear-view rays (rad either side of the sight line). */
const NEAR_RAYS = [-20 * DEG, -10 * DEG, 10 * DEG, 20 * DEG] as const;
/** A raised spiral comes down as t^PIVOT_LATE (late: it swings round up high first). */
const PIVOT_LATE = 2.6;
/**
 * The clock's ramp in (s) and ramp out (fraction of the trip). (D1f r5: the ramp in is 0.22 s from
 * the street and down to 0.12 s from high up — from the city view the first 0.3 s barely moved, the
 * click read as lag.)
 */
const CLOCK_IN = 0.22;
const CLOCK_IN_HIGH = 0.12;
const CLOCK_OUT = 0.42;
/**
 * The drawn camera follows the wanted orientation within these (rad/s, rad/s²): transitions (and
 * just after), the bird. A backstop: the planned turns stay under TURN_PLAN.
 */
const TURN_BLEND = 240 * DEG;
/** A plan that turns faster than this (rad/s) is given more time (up to its cap): the follower keeps up. */
const TURN_FOLLOW = 245 * DEG;
const ACC_BLEND = 2000 * DEG;
const TURN_BIRD = 200 * DEG;
const ACC_BIRD = 1400 * DEG;
/** How long after a transition the follower stays on (s), so a lag it caused is caught up gently. */
const TURN_TAIL = 0.6;
/** After a ride ends, ctx.view.rideFade eases 1 → 0 over this long (s). */
const RIDE_FADE = 1.5;
/** The near plane in someone's eyes (m): props closer to the lens are clipped. */
const EYES_NEAR = 0.5;
/** A bird launched from where the camera is starts this far ahead (m) and blends on this long (s). */
const LAUNCH_DIST = 2;
const LAUNCH_BLEND = 0.4;
/** A launch near the ground climbs out for this long (s), the climb easing off, and holds off the swerve for that and this much more (s). */
const TAKEOFF = 1.1;
const TAKEOFF_CALM = 0.6;
/** (D1f r3) Once in frame, the ridden thing is held within this of the transition's axis (rad). */
const KEEP_IN = 20 * DEG;
/** (D1f r4) A transition's roll off a level horizon (beyond the end's own), under orbit heights (rad). */
const ROLL_LIM = 20 * DEG;
/** (D1f r4) Into someone's eyes: the approach comes down over the shoulder at this slope (rad), from ≤ this far (m). */
const EYES_SLOPE = 32 * DEG;
const EYES_APPROACH = 14;
/** (D1f r5) Into someone's eyes the path keeps under this cone over them (tan of its slope): never high over them. */
const EYES_CONE = 1;
/** (D1f r3) Left alone after a launch near the ground, the bird is guided into the open this long (s). */
const GUIDE = 3.2;
/**
 * (D1f r4) Left alone at any time, the bird looks this far (m) down its heading; when less than
 * IDLE_ON of it is clear it turns for the clearest heading, until IDLE_OFF is clear again.
 */
const IDLE_RUN = 34;
const IDLE_ON = 26;
const IDLE_OFF = 32;
/** (D1f r4) A slender tall building (the clock tower, the church) gets this much more berth (m). */
const TOWER_BERTH = 2.4;
/** (D1f r4) Left alone in town, the bird climbs until it is this far (m) over the roofs within SKY_R m. */
const SKY_OVER = 6;
const SKY_R = 24;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const _sb = new Vector3();
/** How far (m) under sea level the segment a → b passes at its lowest (negative: over it). */
function underDepth(a: Vector3, b: Vector3): number {
  _sb.subVectors(b, a);
  const len2 = _sb.lengthSq();
  if (len2 < 1e-9) return R - a.length();
  const t = Math.max(0, Math.min(1, -a.dot(_sb) / len2));
  _sb.multiplyScalar(t).add(a);
  return R - _sb.length();
}

const _sv = new Vector3();
/** True when b is in sight from a: the segment clears the planet (sea level + 4 m). */
function seen(a: Vector3, b: Vector3): boolean {
  _sv.subVectors(b, a);
  const len2 = _sv.lengthSq();
  if (len2 < 1e-9) return true;
  const t = Math.max(0, Math.min(1, -a.dot(_sv) / len2));
  _sv.multiplyScalar(t).add(a);
  return _sv.length() > R + 4;
}

/**
 * Length (s) of an enter transition whose path has effective length `eff` (rides/path.ts): 1.2 s
 * next door, ~1.6 s to the next car, 1.85 s at most over land; +0.25 s through the cloud layer (the user
 * asked for the falling-through-clouds moment to last ~0.25 s), so ≤ 2.25 s before the time map's
 * stretch (≤ DUR_MAX). (Reduced motion never comes here: it takes a short direct move.)
 */
export function enterDuration(eff: number, crosses: boolean): number {
  return Math.min(DUR_ORD, Math.max(1.2, 0.85 + 0.42 * Math.log(1 + eff))) + (crosses ? 0.25 : 0);
}

const _sa = new Vector3();
/**
 * Unit direction a turned toward unit b by fraction t of the angle between them, into out (may
 * alias a). Nearly opposite: the turn goes round the local up at `pos` (a stable, level swing).
 */
function slerpDir(a: Vector3, b: Vector3, t: number, pos: Vector3, out: Vector3): Vector3 {
  const c = Math.max(-1, Math.min(1, a.dot(b)));
  const ang = Math.acos(c);
  if (ang < 1e-6 || t <= 0) return out.copy(a);
  if (t >= 1) return out.copy(b);
  _sa.crossVectors(a, b);
  if (_sa.lengthSq() < 1e-6) {
    // (a ≈ −b) a level swing about the radial up, made perpendicular to a.
    _sa.copy(pos).normalize().addScaledVector(a, -a.dot(pos) / Math.max(1e-9, pos.length()));
    if (_sa.lengthSq() < 1e-8) _sa.set(Math.abs(a.x) < 0.9 ? 1 : 0, Math.abs(a.x) < 0.9 ? 0 : 1, 0).cross(a);
  }
  _sa.normalize();
  return out.copy(a).applyAxisAngle(_sa, ang * t);
}

export interface DirectorHost {
  /**
   * Hand the explore model over to a camera at `pos` looking along unit `fwd` (camera up `camUp`):
   * focus, altitude, heading and pitch set to match, every explore spring at rest.
   */
  handoff(ctx: LBContext, pos: Vector3, fwd: Vector3, camUp: Vector3): void;
  /** The explore apply() caches the projection: call after presenting a director pose. */
  invalidate(): void;
  /** The explore model's ground reference under unit dir (m above sea level). */
  groundAt(ctx: LBContext, dir: Vector3): number;
  /** The city's camera solids (camera/landing.ts: lamp heads, crowns, poles), or null. */
  solids(): Float64Array | null;
}

export interface BirdOverride {
  steer: number;
  climb: number;
  flap: boolean;
  dive: boolean;
}

/** Review: the last enter plan's slices (ms): (into someone's eyes, the approach), the path, its gaze and timing. */
export const PT = { plan: 0, turns: 0, warm: 0, guide: 0, eyes: 0, path: 0 };
export function createDirector(host: DirectorHost) {
  let mode: CameraMode = 'explore';
  let rideId: string | null = null;
  let ridden: Trackable | null = null;
  let riddenOn = false;
  let lostT = 0;
  // transition
  let blendT = 1;
  let blendDur = 1;
  const blendLift = new LiftProfile();
  let blendAge = 0;
  const coast = new Coast();
  const from = createFramePose();
  const target = createFramePose();
  const out = createFramePose();
  // enter transitions: a planned path (rides/path.ts), planned over the frames after the switch
  const path = new EnterPath();
  let pathOn = false;
  let planStage = 0;
  const planVT = new Vector3();
  const planQ0 = new Vector3();
  let planAMin = 0;
  let planAng = 0;
  let planPivot = 0;
  const apS = new Vector3();
  const spMax = [0];
  const apQ = new Vector3();
  const apT = new Vector3();
  // the live frame of a ride's approach: the planned subject and heading, the turn since, the rest
  const planK = new Vector3();
  const planKUp = new Vector3(0, 0, 1);
  const planFwd = new Vector3();
  const liveRes = new Vector3();
  let livePsi = 0;
  let liveOn = false;
  // a near trip (rides/near.ts): onto something a few metres away in clear sight
  const nearTrip = new NearTrip();
  let nearOn = false;
  const nearAhead = createFramePose();
  // reduced motion: the canvas dips to the space colour through the middle of a long direct move
  let dipOn = false;
  let dipSet = false;
  const tPlan = new Vector3();
  const vTgt = new Vector3();
  let eAim0 = 0;
  let eAim = 0.6;
  const qS = new Quaternion();
  const qT = new Quaternion();
  // the time map (clock → path progress) and its plan-time samples
  const tmap = new TimeMap();
  const smpTurn = new Float64Array(TimeMap.N + 1);
  const smpLen = new Float64Array(TimeMap.N + 1);
  const smpH = new Float64Array(TimeMap.N + 1);
  const smpQ = new Quaternion();
  const azX = new Float64Array(TimeMap.N + 1);
  const azY = new Float64Array(TimeMap.N + 1);
  const azZ = new Float64Array(TimeMap.N + 1);
  // the planned rolls (rad, unwrapped along the path) and orientAt's references / results
  const rTripA = new Float64Array(TimeMap.N + 1);
  const rDiffA = new Float64Array(TimeMap.N + 1);
  let rollRefTrip = 0;
  let rollRefDiff = 0;
  let lastRollTrip = 0;
  let lastRollDiff = 0;
  const azIn = new Vector3();
  let clockOut = 1;
  let planStretch = 1;
  // the clock's dilation (slowed where the live view would turn faster than planned) and the
  // planned orientation last frame
  let clockK = 1;
  const planQ = new Quaternion();
  let planQValid = false;
  // the follower of the wanted orientation (what is drawn)
  const fol = new TurnFollower();
  let turnTail = 0;
  let folLagging = false;
  let tailOver = 0;
  const lim = createFramePose();
  // (review: the wanted orientation's turn last frame, rad)
  const wantQ = new Quaternion();
  let wantValid = false;
  let dbgWant = 0;
  // the presented camera jumped (setView, a shot, an instant switch): no velocity across it
  let teleported = true;
  const dbgStep = { e: 0, k: 1, need: 0 };
  // the enter transition's last-resort lift over a roof the live target drew it under
  let floorLift = 0;
  let floorLiftVel = 0;
  const spT = [0, 0];
  // the short blend onto a bird launched from where the camera is
  let launching = false;
  // the enter transition goes into someone's eyes
  let enterEyes = false;
  // the "just exited" signal (ctx.view.lastRide / rideFade)
  let lastRide: string | null = null;
  let rideFade = 0;
  // velocity of the presented camera (for coasting snapshots)
  const prevPos = new Vector3();
  const prevQuat = new Quaternion();
  let prevValid = false;
  const vel = new Vector3();
  const angAxis = new Vector3(0, 1, 0);
  let angRate = 0;
  const tmpAxis = new Vector3();
  // rides
  const rig = new RideRig();
  const tp: TrackPose = { pos: new Vector3(), fwd: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1), speed: 0 };
  const lastTp: TrackPose = { pos: new Vector3(), fwd: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1), speed: 0 };
  let zoomIdle = 1;
  let stopPush = 0;
  let stopArmed = false;
  // bird
  const bird = new BirdFlight();
  const birdCam = new BirdCam();
  let birdOn = false; // the bird exists (flying, or flying off after an exit)
  let birdAway = 0; // seconds since the bird was let go (autopilot)
  let birdPop = 0; // 0 … 1 pop-in / pop-out progress
  let birdPopDir = 0;
  const birdIn: BirdInput = { steer: 0, climb: 0, flap: false, dive: false };
  // a launch near the ground: seconds left of its take-off climb, and the input it flies meanwhile
  let takeoff = 0;
  const tkIn: BirdInput = { steer: 0, climb: 0, flap: false, dive: false };
  /** (D1f r3) The take-off guide: seconds left, the next re-pick, the heading it steers for. */
  let guide = 0;
  let guideT = 0;
  const guideH = new Vector3();
  /** (D1f r4) The idle guide: turning for guideH (with weight guideW), the skyline it climbs to. */
  let guideOn = false;
  let guideW = 0;
  let guideSky = -Infinity;
  let guideRun = IDLE_RUN;
  /** (D1f r5) 0 … 1: down or a dive held (eased over ~0.3 s): the take-off's climb gives way to it. */
  let downK = 0;
  const gIn: BirdInput = { steer: 0, climb: 0, flap: false, dive: false };
  let birdOverride: BirdOverride | null = null;
  let joyX = 0;
  let joyY = 0;
  let tapFlap = 0;
  // hover
  let hoverT = 0;
  let hoverId: string | null = null;
  let cursorSet = '';
  // scratch
  const tA = new Vector3();
  const tB = new Vector3();
  const tC = new Vector3();
  const tD = new Vector3();
  const tE = new Vector3();
  const tF = new Vector3();
  const tG = new Vector3();
  const tH = new Vector3();
  const tI = new Vector3();
  const tJ = new Vector3();
  const tK = new Vector3();
  const tL = new Vector3();
  const oA = new Vector3();
  const oB = new Vector3();
  const oC = new Vector3();
  const oG = new Vector3();
  const oU = new Vector3();
  const oT = new Vector3();
  const oAz = new Vector3();
  const oV = new Vector3();
  const oQ1 = new Quaternion();
  const oQ2 = new Quaternion();
  const oQ3 = new Quaternion();
  const vA = v3();
  const plan = { x: 0, z: 0 };
  const planOut = { x: 0, z: 0 };
  const near: number[] = [];
  const ll = { lat: 0, lon: 0 };

  // ── World queries (the floor, occlusion, walls) ──

  /** Inside the capital's plan (plan coords in `plan`). */
  function inCity(dir: Vector3, pad = 0): boolean {
    fromSphere(dir, plan);
    return plan.x * plan.x + plan.z * plan.z < (CITY_PLAN_RADIUS + pad) ** 2;
  }

  // ── The city's camera solids (lamp heads, crowns, poles) on a grid, built on first use ──
  const GRID = 6;
  const GRID_HALF = Math.ceil((CITY_PLAN_RADIUS + 12) / GRID);
  const GRID_N = GRID_HALF * 2;
  let gridSolids: Float64Array | null = null;
  let gridStart: Int32Array | null = null;
  let gridItems: Int32Array | null = null;

  function buildGrid(all: Float64Array) {
    const counts = new Int32Array(GRID_N * GRID_N + 1);
    const each = (fn: (cell: number, k: number) => void) => {
      for (let k = 0; k < all.length; k += SOLID) {
        const r = all[k + 2] + 1;
        const x0 = Math.max(0, Math.floor((all[k] - r) / GRID) + GRID_HALF);
        const x1 = Math.min(GRID_N - 1, Math.floor((all[k] + r) / GRID) + GRID_HALF);
        const z0 = Math.max(0, Math.floor((all[k + 1] - r) / GRID) + GRID_HALF);
        const z1 = Math.min(GRID_N - 1, Math.floor((all[k + 1] + r) / GRID) + GRID_HALF);
        for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) fn(gz * GRID_N + gx, k);
      }
    };
    each((c) => counts[c + 1]++);
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const items = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, GRID_N * GRID_N);
    each((c, k) => (items[fill[c]++] = k));
    gridSolids = all;
    gridStart = counts;
    gridItems = items;
  }

  /**
   * Top (m above the plateau) of the highest camera solid whose disc, widened by `pad`, contains
   * plan (x, z), or −1. Zero-alloc after the first call.
   */
  function solidTop(x: number, z: number, pad: number, crownExtra = 0): number {
    const all = host.solids();
    if (!all) return -1;
    if (gridSolids !== all) buildGrid(all);
    const gx = Math.floor(x / GRID) + GRID_HALF;
    const gz = Math.floor(z / GRID) + GRID_HALF;
    if (gx < 0 || gz < 0 || gx >= GRID_N || gz >= GRID_N) return -1;
    const c = gz * GRID_N + gx;
    const S = gridSolids!;
    let top = -1;
    for (let i = gridStart![c]; i < gridStart![c + 1]; i++) {
      const k = gridItems![i];
      const r = S[k + 2] + pad;
      const dx = S[k] - x;
      const dz = S[k + 1] - z;
      if (dx * dx + dz * dz < r * r) {
        // (Crowns — the wide solids — may ask for some extra headroom.)
        const t = S[k + 4] + (S[k + 2] >= 1.2 ? crownExtra : 0);
        if (t > top) top = t;
      }
    }
    return top;
  }

  /** Terrain or water, and the roof directly under (m above sea level). */
  function hardFloor(ctx: LBContext, dir: Vector3): number {
    let f = ctx.world.planet.surfaceAt(dir);
    if (inCity(dir, 20)) {
      const roof = ctx.world.cityIndex.roofAt(plan.x, plan.z);
      if (roof > 0) f = Math.max(f, PLATEAU_HEIGHT + roof);
    }
    return f;
  }

  /**
   * The bird's soft floor: + roofs within 1 m (its body; the look-ahead samples see a building
   * coming, the wall push keeps it off a facade), lamp heads and crowns in the city, the
   * countryside's crowns.
   */
  function softFloor(ctx: LBContext, dir: Vector3): number {
    let f = ctx.world.planet.surfaceAt(dir);
    if (inCity(dir, 20)) {
      const idx = ctx.world.cityIndex;
      // (D1f r4) The roofs' real tops: the clock tower's spire stands 3 m over its walls.
      const roof = roofNear(ctx, plan.x, plan.z, 1);
      if (roof > 0) f = Math.max(f, PLATEAU_HEIGHT + roof);
      // Lamp heads, crowns, poles: their real tops, widened by the bird's body; crowns + 1.5 m (a
      // dive skimmed through the top of one).
      const top = solidTop(plan.x, plan.z, 0.7, 1.5);
      if (top > 0) f = Math.max(f, PLATEAU_HEIGHT + top);
    } else if (ctx.services.nature) {
      vA.x = dir.x;
      vA.y = dir.y;
      vA.z = dir.z;
      if (ctx.services.nature.collide(vA, 2.6, vA)) f = Math.max(f, ctx.world.planet.surfaceAt(dir) + 9.5);
    }
    // Walkers near a low bird (their eyes + 0.75 m: over the head), within 1.1 m of the point; cars,
    // buses and trucks (over the roof), within their half length.
    for (let i = 0; i < crowdN; i++) {
      const x = crowdXYZ[i * 3];
      const y = crowdXYZ[i * 3 + 1];
      const z = crowdXYZ[i * 3 + 2];
      const r = Math.hypot(x, y, z);
      const c = (dir.x * x + dir.y * y + dir.z * z) / r;
      if (c < 0.9999) {
        const d = Math.acos(Math.min(1, c)) * r;
        if (d > crowdReach[i]) continue;
      }
      f = Math.max(f, r - R + crowdTop[i]);
    }
    return f;
  }

  // (D1f r6) The cars, buses and trucks under a low enter transition into someone's eyes: where
  // they were (gathered at ≤ 10 Hz), their velocity, the height to clear over them (m above sea
  // level: the roof + ~3 m) and their reach round it (m).
  const TV_MAX = 24;
  const tvP = new Float64Array(TV_MAX * 3);
  const tvV = new Float64Array(TV_MAX * 3);
  const tvTop = new Float64Array(TV_MAX);
  const tvReach = new Float64Array(TV_MAX);
  let tvN = 0;
  let tvT = 0;
  let tvAge = 0;
  const tvPose: TrackPose = { pos: new Vector3(), fwd: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1), speed: 0 };
  function gatherTransitVehicles(ctx: LBContext, dt: number, dir: Vector3, h: number) {
    tvT -= dt;
    tvAge += dt;
    if (tvT > 0) return;
    tvT = 0.1;
    tvAge = 0;
    tvN = 0;
    if (!ctx.services.track || h - ctx.world.planet.surfaceAt(dir) > 9) return;
    for (let kk = 1; kk < CROWD_KINDS.length; kk++) {
      for (const t of ctx.services.track.list(CROWD_KINDS[kk])) {
        if (tvN >= TV_MAX) break;
        if (t === ridden || !t.pose(ctx, tvPose)) continue;
        if (tvPose.pos.distanceToSquared(out.pos) > 22 * 22) continue;
        const k = tvN * 3;
        tvP[k] = tvPose.pos.x;
        tvP[k + 1] = tvPose.pos.y;
        tvP[k + 2] = tvPose.pos.z;
        const sp = Number.isFinite(tvPose.speed) ? Math.min(16, tvPose.speed) : 0;
        tvV[k] = tvPose.fwd.x * sp;
        tvV[k + 1] = tvPose.fwd.y * sp;
        tvV[k + 2] = tvPose.fwd.z * sp;
        // (The anchor is the body's centre: ~3 m over the roof — at 1.2 m a truck's box filled the
        // bottom third of the frame.)
        tvTop[tvN] = tvPose.pos.length() - R + 0.4 * t.radius + 3;
        tvReach[tvN] = 0.55 * t.radius + 1;
        tvN++;
      }
    }
  }
  /** Height (m above sea level) to keep over the vehicles about unit `dir`, `ahead` s from now (0: none). */
  function vehicleFloor(dir: Vector3, ahead: number): number {
    let f = 0;
    const s = tvAge + ahead;
    for (let i = 0; i < tvN; i++) {
      const k = i * 3;
      const x = tvP[k] + tvV[k] * s;
      const y = tvP[k + 1] + tvV[k + 1] * s;
      const z = tvP[k + 2] + tvV[k + 2] * s;
      const r = Math.hypot(x, y, z);
      // (Ground distance; the need eases in over 2 m beyond the reach, so it is climbed, not jumped.)
      const c = (dir.x * x + dir.y * y + dir.z * z) / r;
      const d = Math.acos(Math.min(1, c)) * r;
      const w = 1 - smoothstep(tvReach[i], tvReach[i] + 2, d);
      if (w > 0) f = Math.max(f, (tvTop[i] - (r - R)) * w + (r - R));
    }
    return f;
  }

  /** Push a low body out of facades taller than it (city only). */
  function wall(ctx: LBContext, dir: Vector3, h: number, r: number, o: Vector3): boolean {
    if (!inCity(dir, 8)) return false;
    const idx = ctx.world.cityIndex;
    const n = idx.buildingsNear(plan.x, plan.z, r, near);
    let tall = false;
    for (let i = 0; i < n; i++) {
      if (PLATEAU_HEIGHT + idx.plan.buildings[near[i]].h > h - 0.3) {
        tall = true;
        break;
      }
    }
    if (!tall || !idx.collide(plan.x, plan.z, r, planOut)) return false;
    planToDir(planOut.x, planOut.z, vA);
    o.set(vA.x, vA.y, vA.z);
    return true;
  }

  /** (D1f r4) The top of a building's roof (m above the plateau): a spire, a gable or a dome over its walls. */
  function roofTop(b: Building): number {
    switch (b.roof) {
      case 'spire':
        return b.h + 3;
      case 'gable':
      case 'hip':
      case 'dome':
        return b.h + 2.5;
      case 'stepped':
        return b.h + 1.5;
      default:
        return b.h + 0.6;
    }
  }

  /** (D1f r4) The extra berth (m) the bird keeps off a slender tall building: the clock tower, the church, a thin tower. */
  function towerBerth(b: Building): number {
    return b.landmark === 'clocktower' || b.landmark === 'church' || (b.h > 18 && Math.max(b.w, b.d) < 10) ? TOWER_BERTH : 0;
  }

  /** (D1f r4) The highest roof top (m above the plateau) within r of plan (x, z), or 0. */
  function roofNear(ctx: LBContext, x: number, z: number, r: number): number {
    const idx = ctx.world.cityIndex;
    const n = idx.buildingsNear(x, z, r, near);
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, roofTop(idx.plan.buildings[near[i]]));
    return top;
  }

  /**
   * (D1f r4) The bird's walls: wall() by the roofs' real tops, and for its look-ahead (r > 1.5 m) a
   * slender tall building keeps TOWER_BERTH more — it flew at the clock tower's face 2 m off and
   * skimmed its spire.
   */
  function birdWall(ctx: LBContext, dir: Vector3, h: number, r: number, o: Vector3): boolean {
    const wide = r > 1.5;
    if (!inCity(dir, 8 + (wide ? TOWER_BERTH : 0))) return false;
    const px = plan.x;
    const pz = plan.z;
    const idx = ctx.world.cityIndex;
    const B = idx.plan.buildings;
    const n = idx.buildingsNear(px, pz, r + (wide ? TOWER_BERTH : 0), near);
    let tall = false;
    let tower = -1;
    let push = 0;
    for (let i = 0; i < n; i++) {
      const b = B[near[i]];
      if (PLATEAU_HEIGHT + roofTop(b) <= h - 0.3) continue;
      const d = footprintDistance(b, px, pz);
      if (d < r) tall = true;
      else if (wide) {
        const ex = towerBerth(b);
        if (ex > 0 && d < r + ex && r + ex - d > push) {
          push = r + ex - d;
          tower = near[i];
        }
      }
    }
    if (tall && idx.collide(px, pz, r, planOut)) {
      planToDir(planOut.x, planOut.z, vA);
      o.set(vA.x, vA.y, vA.z);
      return true;
    }
    if (tower < 0) return false;
    const b = B[tower];
    const dx = px - b.x;
    const dz = pz - b.z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) return false;
    planToDir(px + (dx / L) * push, pz + (dz / L) * push, vA);
    o.set(vA.x, vA.y, vA.z);
    return true;
  }

  /**
   * Fraction of the segment a → b clear of buildings, hills, crowns and lamp heads (the countryside's
   * trees too), from a (the chase / shoulder / bird occlusion). The first 0.8 m is skipped: a walker
   * under a tree, a car beside a lamp post.
   */
  function free(ctx: LBContext, a: Vector3, b: Vector3): number {
    const len = a.distanceTo(b);
    if (len < 0.5) return 1;
    const n = Math.min(24, Math.max(4, Math.ceil(len / 1.2)));
    // The camera solids near the segment, once (city only).
    let local = 0;
    const all = host.solids();
    if (all && (inCity(a, 12) || inCity(b, 12))) {
      fromSphere(tD.copy(a).normalize(), plan);
      const ax = plan.x;
      const az = plan.z;
      fromSphere(tD.copy(b).normalize(), plan);
      solidsIn(all, Math.min(ax, plan.x) - 1, Math.min(az, plan.z) - 1, Math.max(ax, plan.x) + 1, Math.max(az, plan.z) + 1, localSolids);
      local = localSolids.n;
    }
    const L = localSolids.a;
    const nat = local === 0 && !inCity(a, 0) ? ctx.services.nature : undefined;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      tD.lerpVectors(a, b, t);
      const h = tD.length() - R;
      tD.normalize();
      if (hardFloor(ctx, tD) > h - 0.4) return Math.max(0, (i - 1) / n);
      if (t * len < 0.8) continue;
      // The countryside's trees (trunk discs from nature; crowns up to ~9 m over a ~2 m radius).
      if (local === 0 && nat && h - ctx.world.planet.surfaceAt(tD) < 9.5) {
        vA.x = tD.x;
        vA.y = tD.y;
        vA.z = tD.z;
        if (nat.collide(vA, 2, vA)) return Math.max(0, (i - 1) / n);
      }
      if (local === 0) continue;
      fromSphere(tD, plan);
      const hp = h - PLATEAU_HEIGHT;
      for (let k = 0; k < local; k += SOLID) {
        if (hp < L[k + 3] - 0.35 || hp > L[k + 4] + 0.35) continue;
        const r = L[k + 2] + 0.35;
        const dx = L[k] - plan.x;
        const dz = L[k + 1] - plan.z;
        if (dx * dx + dz * dz < r * r) return Math.max(0, (i - 1) / n);
      }
    }
    return 1;
  }
  const localSolids = { a: new Float64Array(SOLID * 32), n: 0 };

  /**
   * (D1f r2) True when a camera at world p would be within `berth` m of a building not 3.5 m under it,
   * inside (or within 0.45 m of) a pole, lamp head or crown — by their real heights: passing under a
   * crown is fine — or within 1 m of the terrain (outside the city).
   */
  function nearBlocked(ctx: LBContext, p: Vector3, berth: number): boolean {
    const h = p.length() - R;
    tJ.copy(p).normalize();
    if (!inCity(tJ, 4)) return h < ctx.world.planet.surfaceAt(tJ) + 1;
    const idx = ctx.world.cityIndex;
    const n = idx.buildingsNear(plan.x, plan.z, berth, near);
    // (A facade taller than the lens, or a roof less than 3.5 m under it: skimming a roof, it
    // filled the bottom of the frame.)
    for (let i = 0; i < n; i++) if (PLATEAU_HEIGHT + idx.plan.buildings[near[i]].h > h - 3.5) return true;
    if (h < PLATEAU_HEIGHT + 0.6) return true;
    const all = host.solids();
    if (!all) return false;
    if (gridSolids !== all) buildGrid(all);
    const gx = Math.floor(plan.x / GRID) + GRID_HALF;
    const gz = Math.floor(plan.z / GRID) + GRID_HALF;
    if (gx < 0 || gz < 0 || gx >= GRID_N || gz >= GRID_N) return false;
    const c = gz * GRID_N + gx;
    const S = gridSolids!;
    const hp = h - PLATEAU_HEIGHT;
    for (let i = gridStart![c]; i < gridStart![c + 1]; i++) {
      const k = gridItems![i];
      if (hp < S[k + 3] - 0.4 || hp > S[k + 4] + 0.4) continue;
      const r = S[k + 2] + 0.45;
      const dx = S[k] - plan.x;
      const dz = S[k + 1] - plan.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /** (D1f r2) True when no building or hill stands between a and b (poles and crowns don't count). */
  function sight(ctx: LBContext, a: Vector3, b: Vector3): boolean {
    const len = a.distanceTo(b);
    const n = Math.min(80, Math.max(2, Math.ceil(len / 0.5)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (t * len < 0.6 || (1 - t) * len < 0.6) continue;
      tJ.lerpVectors(a, b, t);
      const h = tJ.length() - R;
      tJ.normalize();
      if (hardFloor(ctx, tJ) > h + 0.05) return false;
    }
    return true;
  }

  let ctxRef: LBContext | null = null;
  /**
   * The enter path's clearance (rides/path.ts): terrain + 1.2 m, roofs within r + 3.5 m, lamp heads and
   * crowns + 1.2 m, the countryside's crowns.
   */
  const PC_MAX = 64;
  const pcP = new Float64Array(PC_MAX * 3);
  const pcV = new Float64Array(PC_MAX * 3);
  const pcH = new Float64Array(PC_MAX);
  /** (D1f r5) Per crowd entry: its reach (unit-sphere radians) — pcH is the height to clear. */
  const pcR = new Float64Array(PC_MAX);
  /** (D1f r5) Vehicles first: in a busy plaza 48 walkers filled the list and no car was ever in it. */
  const PC_KINDS = ['car', 'bus', 'truck', 'person'] as const;
  let pcN = 0;
  let dbgCrowd = 0;
  /**
   * (D1f r3) The walkers (not the one ridden) within 30 m of either end of an enter that starts or
   * ends low (≤ 5 m over the ground), for the path's clearance: unit direction, velocity in unit
   * directions per second, the height to clear (m above sea level) and (D1f r5) the reach round it;
   * and the cars, buses and trucks.
   */
  function gatherPathCrowd(ctx: LBContext) {
    pcN = 0;
    if (!ctx.services.track) return;
    tA.copy(from.pos).normalize();
    tB.copy(target.pos).normalize();
    const lowS = from.pos.length() - R - ctx.world.planet.surfaceAt(tA) < 5;
    const lowE = target.pos.length() - R - ctx.world.planet.surfaceAt(tB) < 5;
    if (!lowS && !lowE) return;
    const eyesIn = enterEyes;
    // (Into someone's eyes, walkers only: the swing round them comes down over the street, and lifted
    // over the cars on it, it was the steep drop again — street → person:90 looked 59° down.)
    for (let kk = eyesIn ? 3 : 0; kk < PC_KINDS.length; kk++) {
      const person = kk === 3;
      for (const t of ctx.services.track.list(PC_KINDS[kk])) {
        if (pcN >= PC_MAX) break;
        if (t === ridden || !t.pose(ctx, cp)) continue;
        if (!(lowS && cp.pos.distanceToSquared(from.pos) < 900) && !(lowE && cp.pos.distanceToSquared(target.pos) < 900)) continue;
        // (D1f r5) Into someone's eyes, those right beside them (on their bench, at their table) are
        // the last metres' business: over them the swing round ended with a steep drop.
        if (eyesIn && person && cp.pos.distanceToSquared(target.pos) < 1.8 * 1.8) continue;
        const len = cp.pos.length();
        const k = pcN * 3;
        pcP[k] = cp.pos.x / len;
        pcP[k + 1] = cp.pos.y / len;
        pcP[k + 2] = cp.pos.z / len;
        const sp = Number.isFinite(cp.speed) ? Math.min(person ? 3 : 14, cp.speed) / R : 0;
        pcV[k] = cp.fwd.x * sp;
        pcV[k + 1] = cp.fwd.y * sp;
        pcV[k + 2] = cp.fwd.z * sp;
        // Walkers (their eyes): 2 m over their heads within 3 m — into someone's eyes, 1.4 m within 2 m
        // (a swing round a walker in a crowded plaza found no way at all). (D1f r5) Cars, buses and
        // trucks (their anchor on the road): ~1.5 m over the roof within half their length + 1.5 m —
        // a truck passing under the lens filled the bottom of the frame for 0.4 s.
        pcH[pcN] = len - R + (person ? (eyesIn ? 1.4 : 2.2) : 0.7 * t.radius + 1.6);
        pcR[pcN] = (person ? (eyesIn ? 2 : 3) : 0.5 * t.radius + 1.5) / R;
        pcN++;
      }
    }
  }
  const clearEnv: PathEnv = {
    clear: (d, r) => {
      const ctx = ctxRef!;
      let f = ctx.world.planet.surfaceAt(d) + 1.2;
      // (D1f r3) The walkers about the ends of a low trip, where they will be over the next 1.2 s:
      // the camera passes well over their heads (1.3 m), not through a face at eye height — a head
      // a metre from the lens filled a third of the frame. (D1f r4: 2 m over them within 3 m: at
      // 1.3 m within 2.4 m a kid walking away still filled the middle of the frame at 1.6 m.)
      if (pcN > 0) {
        for (let i = 0; i < pcN; i++) {
          const k = i * 3;
          const rr2 = pcR[i] * pcR[i];
          for (let s = 0; s <= 1.2; s += 0.4) {
            const dx = d.x - pcP[k] - pcV[k] * s;
            const dy = d.y - pcP[k + 1] - pcV[k + 1] * s;
            const dz = d.z - pcP[k + 2] - pcV[k + 2] * s;
            if (dx * dx + dy * dy + dz * dz < rr2) {
              f = Math.max(f, pcH[i]);
              break;
            }
          }
        }
      }
      if (inCity(d, 20)) {
        const idx = ctx.world.cityIndex;
        const roof = r > 0.05 ? idx.maxRoofNear(plan.x, plan.z, r) : idx.roofAt(plan.x, plan.z);
        // (D1f r2: mid-way — the full clearance radius — a roof is crossed 6 m up, not 3.5: passing
        // just over one, it filled the lower half of the frame for most of a second.)
        if (roof > 0) f = Math.max(f, PLATEAU_HEIGHT + roof + (r >= 3.9 ? 6 : 3.5));
        const top = solidTop(plan.x, plan.z, 0.4 + Math.min(1, r));
        if (top > 0) f = Math.max(f, PLATEAU_HEIGHT + top + 1.2);
      } else if (ctx.services.nature) {
        vA.x = d.x;
        vA.y = d.y;
        vA.z = d.z;
        if (ctx.services.nature.collide(vA, 2 + r, vA)) f = Math.max(f, ctx.world.planet.surfaceAt(d) + 10.5);
      }
      return f;
    },
    top: (d) => hardFloor(ctxRef!, d),
  };
  const nearEnv: NearEnv = {
    blocked: (p, berth) => nearBlocked(ctxRef!, p, berth),
    sight: (a, b) => sight(ctxRef!, a, b),
  };
  const rideEnv: RideEnv = {
    floor: (d) => hardFloor(ctxRef!, d),
    free: (a, b) => free(ctxRef!, a, b),
    wall: (d, h, r, o) => wall(ctxRef!, d, h, r, o),
    reduced: false,
  };
  /**
   * (D1f r5) The bird's chase camera: as a ride's, but its floor is the roofs' real tops + 1.5 m (a
   * gable's ridge stands 2.5 m over its walls): steered low over a red gable, the lens skimmed the
   * roof, its slope filling the lower half of the frame.
   */
  const birdCamEnv: RideEnv = {
    floor: (d) => {
      const ctx = ctxRef!;
      let f = hardFloor(ctx, d);
      if (inCity(d, 20)) {
        const top = roofNear(ctx, plan.x, plan.z, 1.2);
        if (top > 0) f = Math.max(f, PLATEAU_HEIGHT + top + 1.5);
      }
      return f;
    },
    free: (a, b) => free(ctxRef!, a, b),
    wall: (d, h, r, o) => wall(ctxRef!, d, h, r, o),
    get reduced() {
      return rideEnv.reduced;
    },
  };
  const birdEnv: BirdEnv = {
    floor: (d) => softFloor(ctxRef!, d),
    hard: (d) => hardFloor(ctxRef!, d),
    wall: (d, h, r, o) => birdWall(ctxRef!, d, h, r, o),
    ceiling: BIRD_CEILING,
  };

  // ── Presenting a pose ──

  /** Lens-fit a nominal vertical FOV to the canvas aspect (wide and portrait canvases). */
  function fit(ctx: LBContext, fov: number): number {
    return lensFov(fov, ctx.camera.aspect || 1);
  }

  /** Write a pose to the camera and ctx.view (everything other systems read). */
  function present(ctx: LBContext, fp: FramePose, nearWanted: number, explore: boolean) {
    const cam = ctx.camera;
    cam.position.copy(fp.pos);
    cam.quaternion.copy(fp.quat);
    const altSea = fp.pos.length() - R;
    tA.copy(fp.pos).normalize();
    const surface = ctx.world.planet.surfaceAt(tA);
    const altTerrain = altSea - surface;
    // (In someone's eyes the near plane steps out to EYES_NEAR: a crown, a lamp post or a bench at
    // the lens is clipped instead of filling the view. The ground is ≥ 1.4 m off the lens there.)
    // (D1f r5: 0.5 m, was 0.75 — L1f measured a passer-by's head cut open by it in 0.19 % of ride
    // frames at 0.75 m, 0.007 % at 0.5; their berth keeps props ≥ 0.6 m and heads ≥ ~0.9 m off.)
    const nearP = eyesNearK > 0 ? 0.05 + (EYES_NEAR - 0.05) * eyesNearK : Math.min(30, Math.max(0.05, Math.min(nearWanted, Math.max(0.05, altTerrain * 0.03))));
    const farP = horizonDistance(R, Math.max(0, altSea)) + horizonDistance(R, SPACE_MAX) + 40;
    // (Compared with the camera's own fields: explore's apply() changes them between our frames.)
    const shiftNow = cam.view?.enabled ? cam.view.offsetY : 0;
    if (nearP !== cam.near || farP !== cam.far || fp.fov !== cam.fov || fp.shift !== shiftNow) {
      cam.near = nearP;
      cam.far = farP;
      cam.fov = fp.fov;
      if (!cam.view) cam.view = { enabled: true, fullWidth: 1, fullHeight: 1, offsetX: 0, offsetY: 0, width: 1, height: 1 };
      cam.view.enabled = fp.shift > 0;
      cam.view.offsetY = fp.shift;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    host.invalidate();
    const view = ctx.view;
    view.eye.copy(cam.position);
    // Forward: the camera axis, turned back down by the lens shift (camera/index.ts apply()).
    tB.set(0, 0, -1).applyQuaternion(fp.quat);
    if (fp.shift > 0) {
      const delta = Math.atan(2 * fp.shift * Math.tan((fp.fov * DEG) / 2));
      tC.set(0, 1, 0).applyQuaternion(fp.quat);
      tB.multiplyScalar(Math.cos(delta)).addScaledVector(tC, -Math.sin(delta)).normalize();
    }
    view.forward.copy(tB);
    view.focus.copy(tA);
    view.altSea = altSea;
    view.altTerrain = altTerrain;
    const ground = host.groundAt(ctx, tA);
    if (!explore) {
      view.ground = ground;
      view.alt = Math.max(0, altSea - ground);
    }
    vA.x = tA.x;
    vA.y = tA.y;
    vA.z = tA.z;
    latLonFromDir(vA, ll);
    view.lat = ll.lat;
    view.lon = ll.lon;
    // Heading of the view's tangent part (the camera's up when looking straight down).
    const sinP = Math.max(-1, Math.min(1, tB.dot(tA)));
    view.pitch = Math.asin(sinP);
    tC.copy(tB).addScaledVector(tA, -sinP);
    if (tC.lengthSq() < 1e-8) {
      tC.set(0, 1, 0).applyQuaternion(fp.quat);
      tC.addScaledVector(tA, -tC.dot(tA));
    }
    tC.normalize();
    view.heading = headingOfTangent(tA, tC);
    view.fov = fp.fov;
    view.horizon = horizonDistance(R, Math.max(0, altSea));
    if (!explore) view.street = false;
    fromSphere(tA, plan);
    view.cityX = plan.x;
    view.cityZ = plan.z;
    view.cityDist = hyp(plan.x, plan.z);
    ctx.uniforms.lbCamAlt.value = altTerrain;
    ctx.uniforms.lbCamPos.value.copy(cam.position);
  }

  /** Compass heading (rad, 0 = north, clockwise) of unit tangent t at unit up u. */
  const north = new Vector3();
  const eastV = new Vector3();
  function headingOfTangent(u: Vector3, t: Vector3): number {
    // north = projection of +Y onto the tangent plane (fallback +Z at the poles)
    north.set(0, 1, 0).addScaledVector(u, -u.y);
    if (north.lengthSq() < 1e-10) north.set(0, 0, 1).addScaledVector(u, -u.z);
    north.normalize();
    eastV.crossVectors(north, u); // north × up = east
    return Math.atan2(t.dot(eastV), t.dot(north));
  }

  /** The camera as presented on the last frame (or right now, if nothing has been). */
  function current(ctx: LBContext, o: FramePose): FramePose {
    o.pos.copy(ctx.camera.position);
    o.quat.copy(ctx.camera.quaternion);
    lookPointOf(o.pos, o.quat, o.look);
    o.fov = ctx.camera.fov;
    o.shift = ctx.camera.view?.enabled ? ctx.camera.view.offsetY : 0;
    return o;
  }

  /**
   * How far (m) a coasting snapshot may glide on at altitude h (m above the terrain): a camera
   * leaving a fast trip keeps its speed and bleeds it off within this.
   */
  function glideFor(h: number): number {
    return Math.min(150, Math.max(6, 0.3 * h + 6));
  }

  /** Capture the camera as it is now (from) with its motion, coasting. */
  function captureFrom(ctx: LBContext) {
    current(ctx, from);
    tA.copy(from.pos).normalize();
    const hT = from.pos.length() - R - ctx.world.planet.surfaceAt(tA);
    const moving = prevValid && !teleported;
    coast.capture(from, moving ? vel : tB.set(0, 0, 0), angAxis, moving ? angRate : 0, 3, glideFor(hT));
  }

  /**
   * Start a hand-back from the camera as it is now (coasting on with its motion, easing to rest) to
   * explore's own pose, which takes over where the glide ends (enter transitions: beginEnter).
   */
  function beginExit(ctx: LBContext, dur: number) {
    pathOn = false;
    nearOn = false;
    planStage = 0;
    directOn = false;
    floorLift = floorLiftVel = 0;
    tvN = tvT = 0;
    captureFrom(ctx);
    blendT = 0;
    blendAge = 0;
    blendDur = Math.max(0.05, dur);
    blendLift.hop(0);
  }

  /**
   * Start an enter transition from the camera as it is now to the new mode's pose in `target`
   * (rides/path.ts): the target moves at vT (m/s) meanwhile; the last stretch comes in straight along
   * the new view's axis from ≥ aMin m behind it. The planning is spread over the next two frames
   * (D1f: planned on the click's frame it dropped a frame — 15–20 ms on a first, cold click): the
   * path on the first, its gaze and timing on the second; meanwhile the camera coasts on as it was
   * (it has barely begun to move by then anyway: the clock ramps in over clockIn). Reduced motion
   * takes a short direct move instead (beginDirect).
   */
  function beginEnter(ctx: LBContext, vT: Vector3, aMin: number, eyes = false) {
    if (ctx.reducedMotion) {
      beginDirect(ctx);
      return;
    }
    launching = false;
    enterEyes = eyes;
    nearOn = false;
    floorLift = floorLiftVel = 0;
    tvN = tvT = 0;
    captureFrom(ctx);
    blendT = 0;
    blendAge = 0;
    pathOn = true;
    dipOn = false;
    directOn = false;
    planVT.copy(vT);
    planAMin = aMin;
    tA.copy(from.pos).normalize();
    tC.copy(target.pos).normalize();
    planAng = Math.acos(Math.max(-1, Math.min(1, tA.dot(tC))));
    // (The target is predicted for this long; one pass — the drift from a wrong guess is carried in
    // live by the approach, enterPos.)
    blendDur = Math.min(DUR_MAX, transitionDuration(from.pos.distanceTo(target.pos), planAng, false) * 1.2);
    planStage = 1;
    liveOn = false;
    clockK = 1;
    planQValid = false;
    keepIn = 2;
    holdUsed = 0;
    holdT = 0;
    holdOn = false;
    holdIds.fill(null);
  }

  /**
   * Reduced motion (D1f): a short direct move to the ride (≤ 1.2 s; no crane, no swoop round the
   * subject, no turn longer than the shortest one). (D1f r5, critic r2: into someone's eyes it rose
   * from 4 m to 21 m in four frames at full brightness, dropped back and bounced up again.) Now
   * anything more than a small step is a fade through the dark: the canvas dims first (to ≤ 20 %),
   * the camera holds meanwhile (the start's own motion bleeding out), the move and the turn are made
   * while it is dim — over one single-peaked lift — and it fades back in on the ride. A small step
   * (< 3.5 m, < 35° of turn) is a gentle glide in sight, ≤ ~6 m/s.
   */
  function beginDirect(ctx: LBContext) {
    launching = false;
    pathOn = false;
    nearOn = false;
    planStage = 0;
    floorLift = floorLiftVel = 0;
    tvN = tvT = 0;
    captureFrom(ctx);
    blendT = 0;
    blendAge = 0;
    const dist = from.pos.distanceTo(target.pos);
    const turn = from.quat.angleTo(target.quat);
    // (D1f r6) Nothing in the way of a short move, no lift: the clearance round the start — a facade
    // a metre beside the street camera — lifted the move to a walker 8 m along the pavement 15 m up
    // and back down inside the dim, faintly seen at 20 %; altitude now goes straight to the target.
    if (dist < 40 && free(ctx, from.pos, target.pos) >= 0.999) blendLift.hop(0);
    else {
      blendLift.plan(from.pos, target.pos, directFloor, 0);
      singlePeak(blendLift.v);
    }
    directSign = from.quat.dot(target.quat) < 0 ? -1 : 1;
    dipOn = dist >= 3.5 || turn >= 35 * DEG;
    blendDur = dipOn ? 0.9 : Math.max(0.5, dist / 3.2, turn / (60 * DEG));
    dipDepth = 0.8 + 0.12 * smoothstep(60 * DEG, 150 * DEG, turn);
    // (D1f r2) Through the cloud band: longer, so S1's still cloud fade (~0.55 s from the crossing) is
    // over before the canvas fades back in (it washed the frame white as the dip lifted: dark → white
    // → the ride, two fades for one).
    const hF = from.pos.length() - R;
    const hT = target.pos.length() - R;
    directCross = Math.min(hF, hT) < CLOUD_HI + 4 && Math.max(hF, hT) > CLOUD_LO - 4 && Math.abs(hF - hT) > 6;
    if (directCross) {
      dipOn = true;
      blendDur = 1.2;
    }
    directOn = true;
  }
  let directOn = false;
  let directCross = false;
  /** (D1f r5) The dim move's windows (fractions of the blend): dimmed by, moved over, back in from. */
  const DIM_IN = 0.3;
  const MOVE_A = 0.32;
  const MOVE_B = 0.58;
  const DIM_OUT = 0.62;

  /** (D1f r5) A lift profile made single-peaked in place: up to its highest sample, then down. */
  function singlePeak(v: Float64Array) {
    let pk = 0;
    for (let i = 1; i < v.length; i++) if (v[i] > v[pk]) pk = i;
    for (let i = 1; i < pk; i++) v[i] = Math.max(v[i], v[i - 1]);
    for (let i = v.length - 2; i > pk; i--) v[i] = Math.max(v[i], v[i + 1]);
  }

  /**
   * Reduced motion's direct move at eased progress e, into out: round the planet centre, the height
   * evenly (not in log space: a climb through the cloud band is made mid-way, inside the dip), lifted
   * over what lies between; the orientation slerped the short way. Dimmed: both made inside the dim
   * window only.
   */
  function directPose(e: number) {
    coast.at(blendAge, from);
    const eP = directCross ? smoothstep(0.26, 0.45, blendT) : dipOn ? smoothstep(MOVE_A, MOVE_B, blendT) : e;
    arcPoint(from.pos, target.pos, eP, blendLift.at(eP), out.pos, false);
    const w = directCross ? smoothstep(0.28, 0.5, blendT) : eP;
    // (D1f r4) The short way as it was at the start, kept: three's slerp picks the hemisphere each
    // frame, and with the start coasting a turn near 180° flipped to the other way round in a frame
    // (city → a car: 62° in one frame inside the dip).
    oQ2.copy(target.quat);
    if (directSign < 0) oQ2.set(-oQ2.x, -oQ2.y, -oQ2.z, -oQ2.w);
    slerpKept(from.quat, oQ2, w, out.quat);
    lookPointOf(out.pos, out.quat, out.look);
    out.fov = from.fov + (target.fov - from.fov) * w;
    out.shift = from.shift + (target.shift - from.shift) * w;
  }
  /** The reduced-motion dip at blend progress bt (0 … 1 of its depth). */
  function dipAt(bt: number): number {
    if (directCross) return smoothstep(0.04, 0.26, bt) * (1 - smoothstep(0.8, 0.98, bt));
    return smoothstep(0, DIM_IN, bt) * (1 - smoothstep(DIM_OUT, 1, bt));
  }
  const directFloor = (d: Vector3) => clearEnv.clear(d, 1);
  /** (D1f r4) The hemisphere of the direct move's turn, fixed at its start; how deep its dip goes. */
  let directSign = 1;
  let dipDepth = 0.7;

  /** Slerp a → b by t into out without choosing the hemisphere (b's sign is the caller's). */
  function slerpKept(a: Quaternion, b: Quaternion, t: number, out: Quaternion) {
    const c = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
    const th = Math.acos(c);
    const sn = Math.sin(th);
    if (sn < 1e-4) {
      out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, a.w + (b.w - a.w) * t).normalize();
      return;
    }
    const wa = Math.sin((1 - t) * th) / sn;
    const wb = Math.sin(t * th) / sn;
    out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb, a.w * wa + b.w * wb).normalize();
  }

  /**
   * The next slice of a pending enter plan (planStage 1: the path, or into someone's eyes the
   * approach and then 2: the path; 3: its gaze and timing, then the clock starts).
   */
  function planStep(ctx: LBContext) {
    const t0 = performance.now();
    if (planStage === 1) {
      // (D1f r5) Into someone's eyes the approach's search (planEyes) takes a frame of its own: with
      // the path on the same frame the click's frame cost ~10 ms.
      nearDone = eyesReady = false;
      if (enterEyes && prePlanEyes(ctx)) {
        planStage = 2;
        PT.eyes = performance.now() - t0;
        return;
      }
      planPath(ctx);
      planStage = 3;
      PT.plan = performance.now() - t0;
    } else if (planStage === 2) {
      planPath(ctx);
      planStage = 3;
      PT.plan = performance.now() - t0;
    } else if (planStage === 3) {
      planTiming(ctx);
      planStage = 0;
      PT.turns = performance.now() - t0;
    }
  }
  /** (D1f r5) The near test and the eyes approach were made on the frame before the path's. */
  let nearDone = false;
  let eyesReady = false;

  /** The enter plan's shared setup: the predicted end, the new view's axis, the live frame. */
  function planSetup() {
    tPlan.copy(planVT).multiplyScalar(blendDur);
    if (tPlan.length() > 80) tPlan.setLength(80);
    tPlan.add(target.pos);
    tB.subVectors(target.look, target.pos);
    if (tB.lengthSq() < 1e-8) tB.set(0, 0, -1).applyQuaternion(target.quat);
    tB.normalize();
    planK.copy(tp.pos).add(tPlan).sub(target.pos);
    planKUp.copy(planK).normalize();
    planFwd.set(0, 0, -1).applyQuaternion(target.quat);
    planFwd.addScaledVector(planKUp, -planFwd.dot(planKUp));
    if (planFwd.lengthSq() > 1e-8) planFwd.normalize();
  }

  /** (D1f r5) The first planning frame into someone's eyes: the near test, then the approach. */
  function prePlanEyes(ctx: LBContext): boolean {
    nearOn = planNear(ctx);
    nearDone = true;
    if (nearOn || mode !== 'ride' || !ridden || ridden.view === 'alongside') return false;
    planSetup();
    eyT.copy(tB);
    gatherPathCrowd(ctx);
    tB.copy(eyT);
    planEyes(ctx);
    pcN = 0;
    eyesReady = true;
    return true;
  }

  /** Plan the enter path to where the target will be in blendDur s (its own motion, ≤ 80 m). */
  function planPath(ctx: LBContext) {
    // (D1f r2) Something a few metres away in clear sight: turn to it, then glide round it.
    if (!nearDone) nearOn = planNear(ctx);
    nearDone = false;
    if (nearOn) {
      planPivot = 0;
      return;
    }
    const eyes = enterEyes;
    const dist0 = from.pos.distanceTo(target.pos);
    // The approach: straight in along the new view's axis, from a little behind it (none next door);
    // the subject where it is predicted to be, and the ride's heading there (the live frame).
    planSetup();
    livePsi = 0;
    liveOn = false;
    liveRes.set(0, 0, 0);
    let a = dist0 < 8 ? 0 : Math.min(45, Math.max(planAMin, dist0 * 0.25));
    let pAng = 0;
    let pLate = 1;
    pivDbg.length = 0;
    const riding = mode === 'ride' && !!ridden && ridden.view !== 'alongside';
    if (eyes && riding) {
      // (D1f r5) Into someone's eyes: the approach axis, the swing round them and its radius chosen
      // together (planEyes, on the frame before: prePlanEyes) — never a tight orbit looking down at
      // them. The walkers about are in its clearance (path.ts would otherwise lift the swing over
      // them as it ends: a steep drop).
      if (!eyesReady) {
        eyT.copy(tB);
        gatherPathCrowd(ctx);
        tB.copy(eyT);
        planEyes(ctx);
        pcN = 0;
      }
      eyesReady = false;
      apS.copy(eyAx);
      a = eyR;
      pAng = eyAng;
      pLate = eyLate;
      tD.copy(eyQ);
      tI.copy(planKUp);
    } else {
      // The approach line, from the subject out to the approach point (unit): back along the axis.
      apS.copy(tB).negate();
      // (D1f r3) Out in the open (not in the capital's streets), a pivot's spiral is swung off this
      // axis, so what blocks the axis itself does not shorten it: the spiral is checked on its own
      // (spiralCost). Shortened to 1.5 m behind a boat (an island behind it), the swing round was made
      // at 8 m in the last tenth of the trip. (In a street canyon the wide swing ends across a block:
      // the track then went over its roof.)
      const aFull = !inCity(tE.copy(target.pos).normalize(), 10) ? a : 0;
      if (a > 0) {
        tD.copy(tPlan).addScaledVector(apS, a);
        const f = free(ctx, tPlan, tD);
        if (f < 1) a = Math.max(Math.min(a, 1.5), a * f - 0.8);
      }
      tD.copy(tPlan).addScaledVector(apS, a);
      // Coming from the far side of what it rides (a car driving at the camera): the approach swings
      // round onto the camera's side and spirals back round behind it (path.ts pivot), so the track
      // never passes over or right beside the subject.
      if (riding) {
        tK.copy(planK);
        tI.copy(tK).normalize();
        tG.subVectors(tD, tK);
        tG.addScaledVector(tI, -tG.dot(tI));
        tH.subVectors(from.pos, tK);
        const above = tH.dot(tI);
        tH.addScaledVector(tI, -above);
        if (tG.length() > 0.5 && tH.length() > Math.max(4, 0.5 * above)) {
          const phi = Math.atan2(tJ.crossVectors(tG, tH).dot(tI), tG.dot(tH));
          if (Math.abs(phi) > PIVOT_FROM) pAng = phi - Math.sign(phi) * PIVOT_TO;
        }
        // (A spiral through a facade — a car in a street canyon, 7 m to its side is in the
        // buildings — swings less: the first clear of a full, two-thirds and a third of the pivot;
        // none clear, no pivot: the path then goes over, high, and the gaze turns over the top.)
        pivDbg.push(pAng / DEG, aFull, a);
        if (pAng !== 0) {
          let ok = 0;
          for (const f of PIVOT_TRY) {
            for (let ri = 0; ri < 3 && ok === 0; ri++) {
              const r = ri === 0 ? aFull : ri === 1 ? (aFull > a + 4 ? 0.5 * (aFull + a) : -1) : a;
              if (r < 0 || (ri === 0 && aFull <= a + 1)) continue;
              apQ.copy(tPlan).addScaledVector(apS, r);
              const c = spiralCost(apQ, tPlan, tI, pAng * f, clearEnv, 1, null);
              pivDbg.push(r, c);
              if (c < 0.3) {
                ok = f;
                tD.copy(apQ);
              }
            }
            if (ok !== 0) break;
          }
          if (ok === 0) {
            // A raised spiral: the approach point lifted over what the spiral meets, the swing round
            // made up there, and the drop in behind the subject comes last.
            // (free() and the clearance use tD and tG as scratch: the candidate lives in apQ.)
            spiralCost(tD, tPlan, tI, pAng, clearEnv, PIVOT_LATE, spMax);
            const lift = Math.min(40, spMax[0] + 1.5);
            apQ.copy(tD).addScaledVector(tI, lift);
            apT.copy(tD);
            if (free(ctx, tPlan, apQ) >= 0.999 && spiralCost(apQ, tPlan, tI, pAng, clearEnv, PIVOT_LATE) < 0.3) {
              apT.copy(apQ);
              ok = 1;
              pLate = PIVOT_LATE;
            }
            tD.copy(apT);
          }
          pAng *= ok;
        }
      }
    }
    planQ0.copy(tD);
    // (A hop over the planet only between low ends: a trip up to space is high anyway.)
    const hHigh = Math.max(from.pos.length(), tD.length()) - R;
    farLook(tF).sub(target.pos).add(tPlan);
    // (The line of sight to the subject — where it is predicted to be — kept over nearby roofs.)
    tL.copy(tp.pos).add(tPlan).sub(target.pos);
    gatherPathCrowd(ctx);
    dbgCrowd = pcN;
    const tPath = performance.now();
    path.plan(from.pos, tD, tPlan, clearEnv, hopFor(planAng) * (1 - smoothstep(40, 150, hHigh)), tF, null, pAng !== 0 || pLate !== 1 ? tI : null, pAng, pLate, tL, eyes && riding ? EYES_CONE : 0, eyes && riding ? EY_TAIL : 0);
    pcN = 0;
    planPivot = pAng;
    PT.path = performance.now() - tPath;
  }

  // ── (D1f r5) Into someone's eyes: the approach ──
  /** The chosen approach: its axis (unit, from the eye out), radius (m), swing (rad), late, its point. */
  const eyAx = new Vector3();
  const eyQ = new Vector3();
  let eyR = 0;
  let eyAng = 0;
  let eyLate = 1;
  /** Candidate axes: yaw off straight behind (rad), slope over the level (rad); and radii (m). */
  const EY_YAW = [0, 22 * DEG, -22 * DEG, 45 * DEG, -45 * DEG];
  const EY_SLOPE = [EYES_SLOPE, 22 * DEG, 44 * DEG];
  const EY_R = [EYES_APPROACH, 9.5, 6.5];
  /** The last metres into the head (m): past a lamp or a crown over them (the near plane clips it). */
  const EY_TAIL = 2.2;
  /**
   * The approach's height comes down as t^EY_FLARE along it (spiralAt `late`): early, so the last
   * metres come in nearly level over the shoulder and the head stays in the lower frame until the lens
   * is in it (down the straight 32° line it left the bottom of the frame 1.5 m out).
   */
  const EY_FLARE = 0.6;
  /** Steepest a raised swing may look down at them (rad). */
  const EY_STEEP = 48 * DEG;
  const EY_N = EY_YAW.length * EY_SLOPE.length * EY_R.length;
  const eyBase = new Float64Array(EY_N);
  const eyPA = new Float64Array(EY_N);
  const eyOrd = new Int32Array(EY_N);
  const eyClear = new Float64Array(EY_YAW.length * EY_SLOPE.length);
  const eyF = new Vector3();
  const eyU = new Vector3();
  const eyC = new Vector3();
  const eyD = new Vector3();
  const eyP = new Vector3();
  const eyS = new Vector3();
  const eyT = new Vector3();
  /** Review: [chosen candidate (yaw°, slope°, r, swing°), its base score, candidates tried, raised lift]. */
  const eyDbg: number[] = [];
  /** Review: per candidate tried, [yaw°, slope°, r, swing°, axis clear m, swing cost (−1: axis)]. */
  const eyTry: number[] = [];

  /** Candidate axis (yaw index, slope index) into o: behind the walker, yawed, sloped up. */
  function eyAxis(yi: number, si: number, o: Vector3): Vector3 {
    o.copy(eyF).negate().applyAxisAngle(eyU, EY_YAW[yi]);
    return o.multiplyScalar(Math.cos(EY_SLOPE[si])).addScaledVector(eyU, Math.sin(EY_SLOPE[si]));
  }

  /** The clear metres (≤ EYES_APPROACH) out along unit axis d from the eye, from EY_TAIL on. */
  function eyAxisClear(d: Vector3): number {
    // (Walkers about are left to the swing's own check: one sitting beside them on their bench
    // would block every axis.)
    const n = pcN;
    pcN = 0;
    const c = eyAxisClearBody(d);
    pcN = n;
    return c;
  }
  function eyAxisClearBody(d: Vector3): number {
    // (The last metres into the head pass no pole, lamp or crown: a lamp head passed a metre from the
    // lens on the way into a seated walker's eyes. Their own bench, under the eye, is left out.)
    if (ctxRef && free(ctxRef, eyS.copy(tPlan).addScaledVector(d, EY_TAIL), eyT.copy(tPlan).addScaledVector(d, 0.7)) < 0.999) return 0;
    for (let s = EY_TAIL; s <= EYES_APPROACH + 1e-6; s += 1) {
      eyP.copy(tPlan).addScaledVector(d, s);
      const h = eyP.length() - R;
      eyP.normalize();
      // (Beyond 4 m out a facade keeps 1.2 m off the lens.)
      if (clearEnv.clear(eyP, s > 4 ? 1.2 : 0.6) > h) return Math.max(0, s - 1);
    }
    return EYES_APPROACH;
  }

  /**
   * (D1f r5) The approach into someone's eyes (critic r2: street → a walker seated beside the clock
   * tower orbited their bench 2.5 m out, looking straight down for 1.3 s; another dropped onto a
   * walker past a truck at −64°). Candidates — the axis out behind them yawed up to 45° either way,
   * sloped 22–44°, at 14, 9.5 or 6.5 m — are scored on how far they are from straight behind at 32°
   * and full radius and on the swing round they need (from the camera's side: path.ts pivot), and
   * tried best first: the first whose axis and swing are clear is taken. The swing runs on the cone
   * of its slope (spiralAt keeps the height in proportion), so the walker is looked at 22–44° down
   * all the way round. None clear: the best whose swing, lifted over what it meets, still looks no
   * more than EY_STEEP down; else the straight-behind axis at its clear length (path.ts lifts the
   * spiral as a last resort). Writes eyAx, eyR, eyAng, eyLate, eyQ.
   */
  function planEyes(ctx: LBContext) {
    eyDbg.length = 0;
    eyTry.length = 0;
    eyU.copy(planKUp);
    eyF.copy(tB).addScaledVector(eyU, -tB.dot(eyU));
    if (eyF.lengthSq() < 1e-8) eyF.copy(planFwd);
    eyF.normalize();
    // The camera's side, level, from the subject.
    eyC.subVectors(from.pos, planK);
    const above = eyC.dot(eyU);
    eyC.addScaledVector(eyU, -above);
    const side = eyC.length() > Math.max(4, 0.5 * above);
    const nS = EY_SLOPE.length;
    const nR = EY_R.length;
    for (let yi = 0; yi < EY_YAW.length; yi++) {
      for (let si = 0; si < nS; si++) {
        eyAxis(yi, si, eyD);
        let pa = 0;
        if (side) {
          eyS.copy(eyD).addScaledVector(eyU, -eyD.dot(eyU));
          const phi = Math.atan2(eyT.crossVectors(eyS, eyC).dot(eyU), eyS.dot(eyC));
          if (Math.abs(phi) > PIVOT_FROM) pa = phi - Math.sign(phi) * PIVOT_TO;
        }
        for (let ri = 0; ri < nR; ri++) {
          const k = (yi * nS + si) * nR + ri;
          eyPA[k] = pa;
          eyBase[k] = (0.45 * Math.abs(EY_YAW[yi])) / (22 * DEG) + (0.35 * Math.abs(EY_SLOPE[si] - EYES_SLOPE)) / (10 * DEG) + 0.07 * (EYES_APPROACH - EY_R[ri]) + 0.5 * Math.abs(pa);
          eyOrd[k] = k;
        }
      }
    }
    // Best first (insertion sort: 45 entries, no allocation).
    for (let i = 1; i < EY_N; i++) {
      const k = eyOrd[i];
      let j = i - 1;
      while (j >= 0 && eyBase[eyOrd[j]] > eyBase[k]) {
        eyOrd[j + 1] = eyOrd[j];
        j--;
      }
      eyOrd[j + 1] = k;
    }
    eyClear.fill(-1);
    let chosen = -1;
    let tried = 0;
    let lift = 0;
    for (let i = 0; i < EY_N && chosen < 0; i++) {
      const k = eyOrd[i];
      const ai = Math.floor(k / nR);
      const r = EY_R[k % nR];
      eyAxis(Math.floor(ai / nS), ai % nS, eyD);
      if (eyClear[ai] < 0) eyClear[ai] = eyAxisClear(eyD);
      // (A straight approach needs its whole axis clear; a swing round comes onto the axis only over
      // its last metres — the swing itself is checked — so it needs the last metres in clear.)
      if (eyClear[ai] < (eyPA[k] === 0 ? r - 0.5 : EY_TAIL + 1)) {
        if (eyTry.length < 60) eyTry.push(EY_YAW[Math.floor(ai / nS)] / DEG, EY_SLOPE[ai % nS] / DEG, r, eyPA[k] / DEG, eyClear[ai], -1);
        continue;
      }
      tried++;
      eyP.copy(tPlan).addScaledVector(eyD, r);
      const cost = spiralCost(eyP, tPlan, eyU, eyPA[k], clearEnv, EY_FLARE, null, EY_TAIL, 0.3);
      if (eyTry.length < 60) eyTry.push(EY_YAW[Math.floor(ai / nS)] / DEG, EY_SLOPE[ai % nS] / DEG, r, eyPA[k] / DEG, eyClear[ai], cost);
      if (cost < 0.3) chosen = k;
    }
    // None clear: a raised swing that still looks no more than EY_STEEP down, best first.
    if (chosen < 0) {
      for (let i = 0; i < EY_N && chosen < 0 && tried < 40; i++) {
        const k = eyOrd[i];
        if (eyPA[k] === 0) continue;
        const ai = Math.floor(k / nR);
        const si = ai % nS;
        const r = EY_R[k % nR];
        eyAxis(Math.floor(ai / nS), si, eyD);
        if (eyClear[ai] < 0) eyClear[ai] = eyAxisClear(eyD);
        if (eyClear[ai] < EY_TAIL + 1) continue;
        tried++;
        eyP.copy(tPlan).addScaledVector(eyD, r);
        spiralCost(eyP, tPlan, eyU, eyPA[k], clearEnv, PIVOT_LATE, spMax, EY_TAIL);
        const up = spMax[0] + 1.5;
        if (Math.atan2(r * Math.sin(EY_SLOPE[si]) + up, r * Math.cos(EY_SLOPE[si])) > EY_STEEP) continue;
        eyS.copy(eyP).addScaledVector(eyU, up);
        // (The drop from up there: clear down to the last metres into the head.)
        eyT.copy(tPlan).addScaledVector(eyT.subVectors(eyS, tPlan).normalize(), EY_TAIL);
        if (free(ctx, eyS, eyT) < 0.999) continue;
        if (spiralCost(eyS, tPlan, eyU, eyPA[k], clearEnv, PIVOT_LATE, null, EY_TAIL, 0.3) < 0.3) {
          chosen = k;
          lift = up;
        }
      }
    }
    if (chosen >= 0) {
      const ai = Math.floor(chosen / nR);
      eyAxis(Math.floor(ai / nS), ai % nS, eyAx);
      eyR = EY_R[chosen % nR];
      eyAng = eyPA[chosen];
      eyLate = lift > 0 ? PIVOT_LATE : EY_FLARE;
      eyQ.copy(tPlan).addScaledVector(eyAx, eyR).addScaledVector(eyU, lift);
      eyDbg.push(EY_YAW[Math.floor(ai / nS)] / DEG, EY_SLOPE[ai % nS] / DEG, eyR, eyAng / DEG, eyBase[chosen], tried, lift);
      return;
    }
    // Nothing clear: straight behind at 32°, as far out as it is clear; the swing as it comes.
    eyAxis(0, 0, eyAx);
    if (eyClear[0] < 0) eyClear[0] = eyAxisClear(eyAx);
    eyR = Math.max(EY_TAIL, eyClear[0]);
    eyAng = eyPA[0];
    eyLate = 1;
    eyQ.copy(tPlan).addScaledVector(eyAx, eyR);
    eyDbg.push(0, EYES_SLOPE / DEG, eyR, eyAng / DEG, -1, tried, 0);
  }

  /**
   * A near trip (rides/near.ts), if the subject is within NEAR_D m of a low camera and in clear
   * sight: the camera turns on the spot until it is in frame, then glides round it onto the ride's
   * rest framing, looking at it all the way (the general planner craned up out of the street and
   * spun over it, the subject off screen). False: the general planner takes the trip.
   */
  function planNear(ctx: LBContext): boolean {
    nearWhy = 'mode';
    if (mode !== 'ride' || !ridden || ridden.view === 'alongside') return false;
    nearWhy = 'far';
    if (from.pos.distanceTo(tp.pos) > NEAR_D) return false;
    tA.copy(from.pos).normalize();
    nearWhy = 'high';
    if (from.pos.length() - R - ctx.world.planet.surfaceAt(tA) > 30) return false;
    tB.copy(tp.pos);
    if (enterEyes) tB.addScaledVector(tp.up, -0.45);
    nearWhy = 'hidden';
    if (!sight(ctx, from.pos, tB)) return false;
    // (A clear view, not a sliver past a corner: of four rays 10° and 20° either side of the sight
    // line, at most one meets a wall within 4 m — a truck just round a corner had the turn face the
    // wall from 2 m for half a second. A facade the view runs along is fine.)
    nearWhy = 'tight';
    tA.copy(from.pos).normalize();
    tD.subVectors(tB, from.pos);
    const len = tD.length();
    const dz = tD.dot(tA) / Math.max(1e-6, len);
    tD.addScaledVector(tA, -tD.dot(tA));
    if (tD.lengthSq() > 1e-8) {
      tD.normalize();
      let hits = 0;
      for (const a of NEAR_RAYS) {
        tE.copy(tD).applyAxisAngle(tA, a);
        for (let s = 0.5; s <= Math.min(4, len - 1); s += 0.5) {
          tC.copy(from.pos).addScaledVector(tE, s * Math.sqrt(Math.max(0, 1 - dz * dz))).addScaledVector(tA, s * dz);
          const h = tC.length() - R;
          tC.normalize();
          if (hardFloor(ctx, tC) > h) {
            hits++;
            break;
          }
        }
      }
      if (hits >= 2) return false;
    }
    tC.subVectors(target.pos, tp.pos);
    nearWhy = 'blocked';
    const ok = nearTrip.plan(from.pos, from.quat, tp.pos, planVT, tC, target.quat, enterEyes, nearEnv);
    if (ok) nearWhy = '';
    return ok;
  }

  let nearWhy = '';
  /** The near trip's pose at t s into out (the coasting start, the live subject and ride framing). */
  function nearPose(t: number, o: FramePose) {
    coast.at(blendAge, from);
    tK.subVectors(target.pos, tp.pos);
    nearTrip.pose(t, from.pos, from.quat, tp.pos, tK, target.quat, from.fov, target.fov, from.shift, target.shift, o);
  }

  /** The enter path's gaze and timing (the time map); starts the clock. */
  function planTiming(ctx: LBContext) {
    if (nearOn) {
      blendDur = nearTrip.T;
      planPeakTurn = nearTrip.peak;
      blendT = 0;
      clockK = 1;
      planQValid = false;
      return;
    }
    let dur = enterDuration(path.effLength, path.crosses);
    // The gaze: kept on where it was while the camera pops up out of a street, then swung onto the
    // subject before the approach — and before the cloud band, so what you follow is on screen,
    // over the falling-through-clouds overlay. (Something up in the sky — a plane, a satellite — is
    // looked up at while rising; anything else waits until the camera is up at the roofs, or it
    // would turn to face the facade.) The time map gives the turn the time it needs.
    farLook(tF).sub(target.pos).add(tPlan);
    tB.subVectors(target.look, from.pos).normalize();
    const skyward = tB.dot(tA.copy(from.pos).normalize()) > Math.sin(12 * DEG);
    // (Never later than 0.4 in, and never crammed into less than 0.3 of the way: a big turn squeezed
    // into a short stretch stalled the camera while it panned.)
    // (D1f: from where the way to the subject is clear — firstSight — even while still rising out of
    // the street, not only once the rise is over: the turn overlaps the climb, so the trip is short.)
    eAim0 = skyward ? 0 : Math.min(0.4, firstSight(ctx, tF));
    eAim = Math.max(eAim0 + 0.3, 0.85 * path.eQ);
    if (path.crosses && path.eCross > 0 && path.at(path.eCross, tE) && seen(tE, tPlan)) {
      eAim0 = Math.min(eAim0, Math.max(0, path.eCross - 0.2));
      eAim = Math.min(eAim, Math.max(eAim0 + 0.12, path.eCross));
    }
    // The time map from the planned turns and metres (the target where it is predicted to be).
    // Ordinary trips (across town, onto a car, into someone's eyes) take ≤ 2 s; only a trip through
    // the cloud band, up to space or round the planet may take up to DUR_MAX.
    sampleTurns();
    tA.copy(from.pos).normalize();
    clockIn = CLOCK_IN + (CLOCK_IN_HIGH - CLOCK_IN) * smoothstep(15, 100, from.pos.length() - R - ctx.world.planet.surfaceAt(tA));
    const far = path.crosses || path.length > 250 || path.peak > CLOUD_HI_M;
    // (D1f r5) The hard cap from the click, less the time already spent planning and the frame the
    // clock starts on.
    capT = far ? Math.min(CAP_FAR, CAP_HARD) : enterEyes ? CAP_EYES : CAP_ORD;
    const most = capT - blendAge - 0.04;
    const cap = Math.min(most, far ? DUR_MAX : DUR_ORD);
    for (let pass = 0; pass < 2; pass++) {
      clockOut = CLOCK_OUT * dur;
      planStretch = tmap.build(smpTurn, smpLen, smpH, clockPeak(dur, clockIn, clockOut), TURN_PLAN, vMaxAt);
      if (planStretch <= 1.02 || dur >= cap - 1e-3) break;
      dur = Math.min(cap, dur * planStretch);
    }
    // Squeezed into the cap, the plan may turn faster than the drawn camera can follow (it would
    // still be catching up after arriving): then it takes what it needs, up to the hard cap.
    for (let pass = 0; pass < 2 && dur < most - 1e-3; pass++) {
      const peak = peakTurnRate(dur);
      if (peak <= TURN_FOLLOW) break;
      dur = Math.min(most, dur * Math.min(1.5, (peak / TURN_FOLLOW) * 1.04));
      clockOut = CLOCK_OUT * dur;
      planStretch = tmap.build(smpTurn, smpLen, smpH, clockPeak(dur, clockIn, clockOut), TURN_PLAN, vMaxAt);
    }
    if (dur > most) {
      dur = most;
      clockOut = CLOCK_OUT * dur;
      planStretch = tmap.build(smpTurn, smpLen, smpH, clockPeak(dur, clockIn, clockOut), TURN_PLAN, vMaxAt);
    }
    blendDur = dur;
    planPeakTurn = peakTurnRate(dur);
    blendT = 0;
    clockK = 1;
    planQValid = false;
  }
  let planPeakTurn = 0;
  /** (D1f r5) This trip's clock ramp in (s). */
  let clockIn = CLOCK_IN;
  /** (D1f r5) The trip's hard cap (s from the click): CAP_ORD / CAP_EYES / CAP_FAR. */
  let capT = CAP_FAR;
  /** Review (D1f r4): the last plan's pivot: [angle°, aFull, a, per try: wide cost, axis cost, …, raised: lift, free, cost]. */
  const pivDbg: number[] = [];
  /** (D1f r3) Path progress from which the subject is held in frame (> 1: never), and its scratch. */
  let keepIn = 2;
  let keepOff = 0;
  let keepFind = false;
  const keepS = new Vector3();

  /**
   * The planned view's fastest turn (rad/s) over a trip of dur s with the current time map: each
   * sample's turn over the time the clock takes to cover it (≈ its share of the clock at cruise).
   */
  function peakTurnRate(dur: number): number {
    const peakU = clockPeak(dur, clockIn, clockOut);
    let m = 0;
    for (let i = 1; i <= TimeMap.N; i++) {
      const du = tmap.u[i] - tmap.u[i - 1];
      if (du > 1e-9) m = Math.max(m, (smpTurn[i] * peakU) / du);
    }
    return m;
  }

  /** The planned view turn (rad) between path progress e0 and e1 (the plan's samples, summed). */
  function plannedTurn(e0: number, e1: number): number {
    return turnAt(e1) - turnAt(e0);
  }
  function turnAt(e: number): number {
    const N = TimeMap.N;
    const x = Math.min(N, Math.max(0, e * N));
    const i = Math.min(N - 1, Math.floor(x));
    return cumTurn[i] + (cumTurn[i + 1] - cumTurn[i]) * (x - i);
  }
  const cumTurn = new Float64Array(TimeMap.N + 1);

  /** The enter path's planned orientation turns, metres and heights per time-map sample. */
  function sampleTurns() {
    const N = TimeMap.N;
    // One pass along the path, in order: the planned heading follows the gaze's own heading (as fast
    // as that is off the vertical: it holds still while the gaze looks straight down, never flipping
    // as the camera passes over the look point), the rolls kept continuous from sample to sample, and
    // the end's roll taken the short way round where the last stretch begins.
    tJ.set(0, 0, -1).applyQuaternion(from.quat);
    tE.copy(from.pos).normalize();
    if (Math.abs(tJ.dot(tE)) > 0.9) tJ.set(0, 1, 0).applyQuaternion(from.quat);
    tJ.addScaledVector(tE, -tJ.dot(tE));
    if (tJ.lengthSq() < 1e-12) tJ.set(0, 1, 0).applyQuaternion(from.quat).addScaledVector(tE, -tE.y);
    azIn.copy(tJ.normalize());
    let wrapped = false;
    keepIn = 2;
    keepFind = mode === 'ride' && !!ridden;
    for (let i = 0; i <= N; i++) {
      const e = i / N;
      enterPos(e, 1 - e, tG);
      // The target's look point where it is predicted to be by then (linear in e).
      farLook(tH).addScaledVector(tK.subVectors(tPlan, target.pos), e);
      rollRefTrip = i === 0 ? 0 : rTripA[i - 1];
      rollRefDiff = i === 0 ? 0 : rDiffA[i - 1];
      // (The subject where it is predicted to be by then.)
      keepS.copy(tp.pos).addScaledVector(tK.subVectors(tPlan, target.pos), e);
      if (keepFind) standOff(e, tG, keepS, planFwd);
      orientAt(e, tG, from.look, from.quat, tH, target.quat, tI, qS, keepFind ? keepS : null);
      rTripA[i] = lastRollTrip;
      rDiffA[i] = lastRollDiff;
      if (!wrapped && e >= 0.7) {
        rDiffA[i] = Math.atan2(Math.sin(lastRollDiff), Math.cos(lastRollDiff));
        wrapped = true;
      }
      // The heading: toward the gaze's own, by its horizontal share squared (≤ 6° a sample).
      tE.copy(tG).normalize();
      tK.set(0, 0, -1).applyQuaternion(qS);
      tK.addScaledVector(tE, -tK.dot(tE));
      const m = tK.length();
      tJ.copy(azIn).addScaledVector(tE, -azIn.dot(tE)).normalize();
      if (m > 1e-6) {
        tK.divideScalar(m);
        const a = Math.atan2(tC.crossVectors(tJ, tK).dot(tE), tJ.dot(tK));
        const k = Math.min(1, (m / 0.3) ** 2);
        tJ.applyAxisAngle(tE, Math.max(-6 * DEG, Math.min(6 * DEG, a * k)));
      }
      azIn.copy(tJ);
      azX[i] = tJ.x;
      azY[i] = tJ.y;
      azZ[i] = tJ.z;
      if (i === 0) {
        smpTurn[0] = smpLen[0] = 0;
        smpH[0] = tG.length() - R;
        cumTurn[0] = 0;
      } else {
        smpTurn[i] = smpQ.angleTo(qS);
        smpLen[i] = tG.distanceTo(tF);
        smpH[i] = tG.length() - R;
        cumTurn[i] = cumTurn[i - 1] + smpTurn[i];
      }
      smpQ.copy(qS);
      tF.copy(tG);
    }
  }

  /**
   * The enter transition's camera position at path progress e, into o: the planned path, the
   * target's drift off its predicted course carried in by the approach (`lagT`: the fraction of the
   * prediction not yet run — live, target.pos − tPlan; planned, (1 − e) of it).
   */
  function enterPos(e: number, lagT: number, o: Vector3) {
    path.at(e, o);
    const w = ease((e - path.ePop) / Math.max(1e-3, path.eQ - path.ePop));
    if (lagT >= 0) o.addScaledVector(tK.subVectors(target.pos, tPlan), lagT * w);
    else if (liveOn) {
      // (D1f) Live, riding: the approach is carried in the subject's own frame — moved with it and
      // turned with its heading (a car's U-turn in a turnaround swings the approach round it, it
      // never passes over the roof) — and what is left (its height, the rig's smoothing) is taken
      // up over the last stretch, so it lands exactly on the ride.
      // (D1f r5: into someone's eyes, a third of it — a walker sitting or looking about turns 15–20°
      // in a second, and the swing round them, turned with it, met the clock tower's base.)
      o.sub(planK).applyAxisAngle(planKUp, livePsi * w * (enterEyes ? 0.35 : 1)).add(planK);
      o.addScaledVector(tK.subVectors(tp.pos, planK), w);
      o.addScaledVector(liveRes, ease((e - 0.75) / 0.25));
    } else o.addScaledVector(tK.subVectors(target.pos, tPlan), w);
    return o;
  }

  /**
   * Once a frame while an enter runs (riding): the subject's heading change since the plan (about
   * its up, unwrapped frame to frame) and what the turned, moved plan still misses at its end.
   */
  function updateLive() {
    liveOn = mode === 'ride' && !!ridden;
    if (!liveOn) return;
    tK.set(0, 0, -1).applyQuaternion(target.quat);
    tK.addScaledVector(planKUp, -tK.dot(planKUp));
    if (tK.lengthSq() > 1e-8 && planFwd.lengthSq() > 1e-8) {
      tK.normalize();
      const raw = Math.atan2(tJ.crossVectors(planFwd, tK).dot(planKUp), planFwd.dot(tK));
      livePsi += Math.atan2(Math.sin(raw - livePsi), Math.cos(raw - livePsi));
    }
    // The end of the turned, moved plan, against the live ride pose.
    liveRes.subVectors(tPlan, planK).applyAxisAngle(planKUp, livePsi).add(tp.pos);
    liveRes.subVectors(target.pos, liveRes);
  }

  /**
   * The gaze and orientation of the enter transition at progress e from camera position `pos`
   * (from: the old look point and orientation; to: the new look point and orientation), into
   * outLook / outQuat:
   *   - the gaze turns evenly from the direction of the old look point to that of the new one (a
   *     look point behind the planet is aimed at on the horizon below it: it rises into the aim);
   *   - mid-way it is never steeper than ~65° (more high up, where the planet fills the view):
   *     looking straight down the heading could only change as a spin of the whole city;
   *   - its roll is a level horizon mid-way, each end's own orientation at the ends.
   */
  function orientAt(e: number, pos: Vector3, fLook: Vector3, fQuat: Quaternion, tLook: Vector3, tQuat: Quaternion, outLook: Vector3, outQuat: Quaternion, subj: Vector3 | null = null) {
    const wA = smoothstep(eAim0, Math.max(eAim0 + 1e-3, eAim), e);
    // The old look point: kept while the camera is near where it was, then carried along with it
    // (its direction kept): looking back at a street 200 m behind swung the gaze round through the
    // ground on a long trip.
    // (A start looking steeply down — orbit, the city view — keeps its direction from the first
    // metre: the point under it, left behind, would tip the gaze back past the vertical.)
    oA.subVectors(fLook, from.pos);
    const dl = Math.max(1, oA.length());
    oV.subVectors(pos, from.pos);
    oC.copy(from.pos).normalize();
    const steepStart = smoothstep(0.85, 0.97, Math.abs(oA.dot(oC)) / dl);
    oA.add(from.pos).addScaledVector(oV, Math.max(steepStart, smoothstep(0.4, 1.6, oV.length() / dl)));
    oA.sub(pos);
    if (oA.lengthSq() < 1e-8) oA.set(0, 0, -1).applyQuaternion(fQuat);
    oA.normalize();
    // (D1f) A start looking straight down at the planet keeps looking down at it from wherever the
    // camera has got to — not along the world direction it had: on a trip round the planet that
    // direction swung off the disc and half the trip looked at black sky.
    if (steepStart > 0) {
      oC.copy(pos).normalize().negate();
      oA.lerp(oC, steepStart).normalize();
    }
    oB.subVectors(tLook, pos);
    const dLook = oB.length();
    if (oB.lengthSq() < 1e-8) oB.set(0, 0, -1).applyQuaternion(tQuat);
    oB.normalize();
    oU.copy(pos).normalize();
    // (D1f r4) Into someone's eyes the trip looks at them, not at where they look — until the drop
    // (D1f r5: 3.6 → 1.6 m, where their body is hidden; from 4.5 m their head left the frame while
    // still drawn): toward a walker facing the camera, their look point is back past the camera and
    // the gaze turned away from them for the whole trip.
    if (enterEyes && subj) {
      oC.subVectors(subj, pos);
      const dS = oC.length();
      const wS = smoothstep(1.6, 3.6, dS);
      if (wS > 1e-4 && dS > 1e-3) slerpDir(oB, oC.divideScalar(dS), wS, pos, oB);
    }
    const h = pos.length() - R;
    // (Behind the planet means really behind it: a boat's look point at sea level, a few metres off,
    // grazes the sea-level sphere and must not count — aimed under the horizon it ended 8° off.)
    // (D1f r3: eased in by how deep the line passes under the sea and how far the look point is,
    // not switched: a boat 130 m off, rising over the horizon as the camera came down to it, turned
    // the gaze 5° in a frame.)
    const occl = dLook > 30 ? smoothstep(1, 4, underDepth(pos, tLook)) * smoothstep(30, 45, dLook) : 0;
    if (occl > 0) {
      // Behind the planet: below the horizon in its direction, so the limb — where it will rise —
      // sits at the upper third of the frame and the planet fills the rest (D1f: aimed at the
      // horizon itself, half of a long trip round the planet was black sky).
      const dip = horizonDip(h) + LIMB_DROP;
      // (D1f r2: the way to it is the way the path goes — the planned track a little ahead — not the
      // straight line's own heading, which for something near the far pole of the planet is no
      // heading at all: it swung 160° in 0.4 s as the camera moved off the city.)
      path.at(Math.min(1, e + 0.08), oT);
      oC.subVectors(oT, pos).addScaledVector(oU, -oT.sub(pos).dot(oU));
      oT.copy(oB).addScaledVector(oU, -oB.dot(oU));
      if (oC.lengthSq() < 1e-4 && oT.lengthSq() > 1e-8) oC.copy(oT);
      if (oC.lengthSq() > 1e-8) {
        oC.normalize().multiplyScalar(Math.cos(dip)).addScaledVector(oU, -Math.sin(dip));
        slerpDir(oB, oC, occl, pos, oB);
      }
    }
    slerpDir(oA, oB, wA, pos, oG);
    // (D1f r3) Once what it rides is in frame it stays in frame: the gaze is turned toward it just
    // enough to hold it within KEEP_IN of the axis (not through the planet, not at the lens: into
    // someone's eyes the subject is where the camera lands). Before the pitch limits below, which
    // still hold (passing over it, the gaze is not tipped straight down into a spin). Planned
    // (sampleTurns finds where it is first in: keepIn) and timed like any other turn. From orbit the
    // plane slid out of the top of the frame for a second while the gaze stayed on the planet.
    if (subj) keepClamp(e, pos, subj, oG, -Math.PI / 2);
    // The way the trip heads (an azimuth, continuous everywhere): the gaze's own heading, or — where
    // the gaze looks within a few degrees of straight down and has none to speak of — the planned
    // heading there (sampleTurns: it follows the gaze's and holds still over the vertical).
    oT.copy(azIn).addScaledVector(oU, -azIn.dot(oU));
    oC.copy(oG).addScaledVector(oU, -oG.dot(oU));
    const wB = smoothstep(0.03, 0.15, oC.length());
    if (oT.lengthSq() > 1e-12) oT.normalize();
    if (oC.lengthSq() > 1e-12) oC.normalize();
    oC.multiplyScalar(wB).addScaledVector(oT, 1 - wB);
    if (oC.lengthSq() < 1e-12) oC.copy(oT);
    if (oC.lengthSq() < 1e-12) oC.set(0, 1, 0).applyQuaternion(fQuat).addScaledVector(oU, -oU.dot(oC));
    oAz.copy(oC.normalize());
    // Never steeper than pMin mid-way: a steep gaze is lifted (its heading kept) to pMin, softly,
    // faded in and out at the ends. (Low down, a drone's 50°: from 20 m up, looking straight down at
    // a walker turned into a spin; never within 10° of straight down, where the level frame's heading
    // would wobble with the gaze.)
    const c = smoothstep(0, 0.12, e) * (1 - smoothstep(0.85, 1, e));
    const sp = Math.max(-1, Math.min(1, oG.dot(oU)));
    const pitch = Math.asin(sp);
    const pMin = -Math.min(80 * DEG, Math.max(50 * DEG + 15 * DEG * smoothstep(15, 60, h), horizonDip(h) + 12 * DEG));
    if (c > 1e-4) {
      const W = 6 * DEG;
      const x = (pitch - pMin) / W;
      const soft = pMin + W * (x > 20 ? x : Math.log1p(Math.exp(x)));
      const np = pitch + Math.max(0, soft - pitch) * c;
      // (The heading is the gaze's own unless it is nearly vertical: then it comes from oAz.)
      if (np > pitch + 1e-6 || wB < 1) {
        const p2 = wB < 1 ? Math.max(np, pitch) : np;
        oG.copy(oAz).multiplyScalar(Math.cos(p2)).addScaledVector(oU, Math.sin(p2));
      }
    }
    // Looking up at something in the sky (a plane, a satellite), the gaze dips a little under it
    // (≤ 16°: it stays well inside the frame, over the falling-through-clouds overlay) to keep the
    // planet's limb in the frame — no higher than LIMB_UP over the horizon, so the planet fills at
    // least the lower ~third (D1f: at 16° over it, the planet was a sliver under a black sky).
    const pMax = -horizonDip(h) + LIMB_UP;
    const sp2 = Math.max(-1, Math.min(1, oG.dot(oU)));
    const pitch2 = Math.asin(sp2);
    if (c > 1e-4 && pitch2 > pMax - 4 * DEG) {
      const pB = Math.asin(Math.max(-1, Math.min(1, oB.dot(oU))));
      const want = Math.max(pMax, Math.min(pitch2, pB - 16 * DEG));
      const w2 = c * smoothstep(pMax - 4 * DEG, pMax + 8 * DEG, pitch2);
      if (want < pitch2 - 1e-5 && w2 > 1e-4) {
        oT.copy(oG).addScaledVector(oU, -sp2);
        if (oT.lengthSq() > 1e-10) {
          oT.normalize().multiplyScalar(Math.cos(want)).addScaledVector(oU, Math.sin(want));
          slerpDir(oG, oT, w2, pos, oG);
        }
      }
    }
    // (Again after the limits, never tipping the gaze under the mid-way pitch floor, nor lifting it
    // over the limb's ceiling — a satellite over the night side pulled the planet out of the frame:
    // the limits above rebuild a steep gaze along the planned heading, which may not be the
    // subject's.)
    if (subj) keepClamp(e, pos, subj, oG, c > 1e-4 ? pMin * c - (Math.PI / 2) * (1 - c) : -Math.PI / 2, c > 1e-4 ? pMax : Math.PI / 2);
    outLook.copy(pos).addScaledVector(oG, Math.max(1, dLook));
    // Orientation: from the start's own (swung the least onto the gaze) to the trip's own frame as
    // the gaze leaves the start, onto the end's own over the last stretch. The trip's frame keeps
    // the horizon level, or — looking steeply down, where "level" is undefined — the way the trip
    // heads at the top of the frame (which agrees with the gaze's own heading wherever that exists).
    // All three look along the gaze and differ only by a roll about it: the rolls are blended as
    // angles, kept continuous against the plan (a quaternion slerp between frames half a turn apart
    // took the short way round one frame and the other way the next: a flip).
    // (D1f r3) An end is swung onto the gaze by the least rotation only while the gaze is within
    // ~80° of its axis; turned further, it is carried as its own roll against its level frame
    // (endRoll). The least rotation is singular where the gaze faces the other way from the end's:
    // spiralling round behind a boat that came at the camera, the end frame swung onto a gaze
    // looking back at the bow spun a full barrel roll (the drawn camera, capped at 190°/s, fell
    // behind, tipped into the sea and lost the boat for 0.8 s).
    // (The heading only tips the balance within a few degrees of straight down, where "level" alone
    // is undefined; anywhere else the level frame rules.)
    oT.copy(oU).addScaledVector(oAz, 0.04);
    lookQuat(oG, oT, 0, oQ3);
    let rTrip = -endRoll(fQuat, oG);
    let rDiff = endRoll(tQuat, oG);
    rTrip += Math.round((rollRefTrip - rTrip) / (2 * Math.PI)) * 2 * Math.PI;
    rDiff += Math.round((rollRefDiff - rDiff) / (2 * Math.PI)) * 2 * Math.PI;
    lastRollTrip = rTrip;
    lastRollDiff = rDiff;
    const wS = smoothstep(0, 0.3, e);
    const wE = smoothstep(0.72, 1, e);
    // (From the start rolled as it was (−rTrip), to the level trip frame (0), to the end's roll
    // (rDiff): rEnd = rTrip + rDiff blended from rTrip·wS by wE, measured from the start's.)
    let roll = rTrip * wS + (rTrip + rDiff - rTrip * wS) * wE - rTrip;
    // (D1f r4) Under orbit heights, wherever the gaze has a horizon, the horizon is never rolled more
    // than ~20° off level beyond the end's own roll (a plane's bank): leaving the city view (looking
    // straight down, its "up" any heading) the start's roll showed as a 55° tilt as the gaze came up
    // off the vertical. (Soft: tanh; ~45° in orbit, free looking near straight down.)
    const pitchG = Math.abs(Math.asin(Math.max(-1, Math.min(1, oG.dot(oU)))));
    const rLim = ROLL_LIM + 25 * DEG * smoothstep(120, 180, h) + Math.PI * smoothstep(80 * DEG, 88 * DEG, pitchG);
    const rEnd = rDiff * wE;
    roll = rEnd + rLim * Math.tanh((roll - rEnd) / rLim);
    outQuat.copy(oQ3);
    if (Math.abs(roll) > 1e-9) {
      oQ1.setFromAxisAngle(oG, roll);
      outQuat.premultiply(oQ1);
    }
  }

  /**
   * (D1f r3) Hold the subject in frame round gaze g (in place; from where it is first in: keepIn,
   * found while planning), never tipping g under pitch `floor` nor lifting it over `ceil` (rad) —
   * (D1f r4) except as far as it takes to keep the subject inside the frame's edge.
   * (D1f r4) The frame is the lens's own: the subject's angles across and up the view against the
   * half field of view (wider across), not a cone — at the left edge of a wide frame it was "not yet
   * seen" at 39° and slid out while the gaze turned the other way; under a pitch floor it left
   * through the bottom while the camera passed over it.
   */
  function keepClamp(e: number, pos: Vector3, subj: Vector3, g: Vector3, floor: number, ceil = Math.PI / 2) {
    oT.subVectors(subj, pos);
    const dS = oT.length();
    // (D1f r4: into someone's eyes held to 4.5 m, let go by 1.5 m — the drop into the head; it let go
    // from 12 m and the walker left the bottom of the frame for 0.65 s. D1f r5: held to 2.6 m and let
    // go by 1.6 m, where the owner hides the body: their head left the frame from 2.7 m.)
    const near = enterEyes ? smoothstep(1.6, 2.6, dS) : smoothstep(1.5, 4, dS);
    // (D1f r4: eased in from while the line still passes 6 m under the sea — the gaze is on the limb
    // where it will rise — to fully held just over it: switched on as it rose, a plane seen from orbit
    // slid out of the bottom of the frame for 0.3 s while the drawn camera caught up.)
    const vis = 1 - smoothstep(-1, 6, underDepth(pos, subj));
    if (near * vis <= 1e-4) return;
    oT.divideScalar(dS);
    // The view's own axes (up: away from the planet; looking straight down, the planned heading's).
    oV.copy(pos).normalize();
    oA.crossVectors(g, oV);
    if (oA.lengthSq() < 1e-6) oA.crossVectors(g, azIn);
    if (oA.lengthSq() < 1e-12) return;
    oA.normalize();
    oC.crossVectors(oA, g);
    const fz = oT.dot(g);
    const ax = Math.atan2(Math.abs(oT.dot(oA)), fz);
    const ay = Math.atan2(Math.abs(oT.dot(oC)), fz);
    const vHalf = 0.5 * (from.fov + (target.fov - from.fov) * e) * DEG;
    const hHalf = Math.atan(Math.tan(vHalf) * (ctxRef?.camera.aspect || 1.6));
    // (D1f r5: looking nearly straight down the frame's roll is the trip's, not up's: the narrower
    // limit both ways — a plane seen from orbit sat on the bottom edge, held to the wider one.)
    const yl = Math.min(KEEP_IN, vHalf - 5 * DEG);
    const xl = Math.min(KEEP_IN * 1.4, hHalf - 5 * DEG) + (yl - Math.min(KEEP_IN * 1.4, hHalf - 5 * DEG)) * smoothstep(0.92, 0.985, Math.abs(g.dot(oV)));
    const rho = Math.hypot(ax / xl, ay / yl);
    // (From just outside the frame's edge — it is drawn in from there as the gaze turns. Live, the
    // subject may come by before the plan's linear guess had it: the hold starts there, from where it
    // is — D1f r4, a plane on a curve slid in at the top and out again for 0.3 s first.)
    if (e < keepIn && ax < hHalf + 10 * DEG && ay < vHalf + 12 * DEG && near * vis > 0.5) {
      keepIn = e;
      // (D1f r5: in frame already, it is held a little inside the edge — held right on it, a plane
      // seen from orbit sat on the bottom edge for half a second and slipped out for five frames.)
      const edge0 = Math.min(hHalf / xl, vHalf / yl);
      keepOff = Math.max(1, rho <= edge0 ? Math.min(rho, 0.88 * edge0) : rho);
    }
    // (Held where it was first seen — at the frame's edge, perhaps — and drawn in to the middle.)
    const lim = 1 + (keepOff - 1) * (1 - smoothstep(keepIn, keepIn + 0.15, e));
    // (Let go over the last tenth: the trip lands exactly on the ride's own framing.)
    // (Into someone's eyes the distance lets go — the drop into the head is the approach's last
    // metres, all of its last tenth: D1f r4, the head left the bottom of the frame from 3.3 m.)
    const w = e >= keepIn ? near * vis * (1 - smoothstep(enterEyes ? 0.985 : 0.9, 1, e)) : 0;
    if (rho <= lim || w <= 1e-4) return;
    const p0 = Math.asin(Math.max(-1, Math.min(1, g.dot(oV))));
    slerpDir(g, oT, (1 - lim / rho) * w, pos, g);
    const p1 = Math.asin(Math.max(-1, Math.min(1, g.dot(oV))));
    // (The limits give way as far as the subject's own pitch, less the frame's half height, asks.)
    const ps = Math.asin(Math.max(-1, Math.min(1, oT.dot(oV))));
    const edge = (vHalf - 4 * DEG) * w;
    const fl = Math.min(p0, floor, ps + edge);
    const cl = Math.max(p0, ceil, ps - edge);
    if (p1 < fl || p1 > cl) {
      const pc = p1 < fl ? fl : cl;
      oA.copy(g).addScaledVector(oV, -g.dot(oV));
      if (oA.lengthSq() > 1e-10) g.copy(oA.normalize()).multiplyScalar(Math.cos(pc)).addScaledVector(oV, Math.sin(pc));
    }
  }

  /**
   * An end orientation q carried onto gaze g (unit; up hint oT, its level frame in oQ3), as a roll
   * (rad) about g from that level frame: q's own roll against its level frame (rotation(axis, roll) ·
   * lookQuat(axis, oT) = q) — or, for an end looking within ~15° of straight down (the orbit view,
   * whose level frame is undefined) and g within ~80° of its axis, q swung onto g by the least
   * rotation (eased between the two; turned further the least rotation is singular).
   */
  function endRoll(q: Quaternion, g: Vector3): number {
    oC.set(0, 0, -1).applyQuaternion(q);
    // (D1f r5) Its own roll against its level frame wherever that frame is defined (its axis not
    // within ~15° of the vertical): the least rotation onto a gaze 50° down and 70° round rolled a
    // level end — someone's eyes — 28° while the trip swung round them.
    const lvl = Math.max(smoothstep(0.17, -0.5, oC.dot(g)), 1 - smoothstep(0.93, 0.98, Math.abs(oC.dot(oT)) / Math.max(1e-6, oT.length())));
    let r = 0;
    if (lvl < 1) {
      oQ2.setFromUnitVectors(oC, g).multiply(q);
      oV.set(0, 1, 0).applyQuaternion(oQ3);
      oA.set(0, 1, 0).applyQuaternion(oQ2);
      r = Math.atan2(oB.crossVectors(oV, oA).dot(g), oV.dot(oA));
    }
    if (lvl > 0) {
      lookQuat(oC, oT, 0, oQ2);
      oV.set(0, 1, 0).applyQuaternion(oQ2);
      oA.set(0, 1, 0).applyQuaternion(q);
      const rl = Math.atan2(oB.crossVectors(oV, oA).dot(oC), oV.dot(oA));
      r += lvl * Math.atan2(Math.sin(rl - r), Math.cos(rl - r));
    }
    return r;
  }

  /**
   * The point the transition's gaze aims for: the new view's own look point (on the subject, so it
   * stays in frame over the falling-through-clouds overlay) — into someone's eyes, at least 25 m out
   * along the view's axis (the eyes' own look point is 8 m ahead of the walker: coming down onto
   * them the gaze swung round it; far out along the same axis, the last stretch still looks straight
   * down it).
   */
  function farLook(o: Vector3): Vector3 {
    o.subVectors(target.look, target.pos);
    const d = o.length();
    if (d < 1e-6) o.set(0, 0, -1).applyQuaternion(target.quat);
    else o.divideScalar(d);
    return o.multiplyScalar(Math.max(enterEyes ? 25 : 0, d)).add(target.pos);
  }

  /** The planned heading and roll references at progress e (runtime), into azIn / rollRef*. */
  function planRefs(e: number) {
    const N = TimeMap.N;
    const x = Math.min(N, Math.max(0, e * N));
    const i0 = Math.min(N - 1, Math.floor(x));
    const f = x - i0;
    rollRefTrip = rTripA[i0] + (rTripA[i0 + 1] - rTripA[i0]) * f;
    rollRefDiff = rDiffA[i0] + (rDiffA[i0 + 1] - rDiffA[i0]) * f;
    azIn.set(azX[i0] + (azX[i0 + 1] - azX[i0]) * f, azY[i0] + (azY[i0 + 1] - azY[i0]) * f, azZ[i0] + (azZ[i0 + 1] - azZ[i0]) * f);
  }

  /**
   * (D1f r4) A camera passing over what it rides keeps a stand-off: within ~0.55 × its height over
   * it (the subject never more than ~60° under the horizon, inside the frame under the pitch floor),
   * it is eased out sideways — away from it, leaning back toward its tail — over the middle of the
   * trip (a chase only: into someone's eyes the trip ends in them). Street → a car that came round
   * the corner passed 0.6 m over its roof, the car a sliver at the bottom of the frame for 0.5 s.
   */
  function standOff(e: number, o: Vector3, subj: Vector3, fwd: Vector3) {
    if (!ridden || ridden.view !== 'chase') return;
    const w = smoothstep(0.08, 0.25, e) * (1 - smoothstep(0.88, 1, e));
    if (w <= 1e-4) return;
    soU.copy(subj).normalize();
    soV.subVectors(o, subj);
    const dh = soV.dot(soU);
    // (D1f r5: ~0.8 × its height over it plus half its size, was 0.55 × the height: street → car:5
    // still passed 3 m over the roof, the roof a band cut off at the bottom of the frame.)
    const r0 = Math.min(6, 0.8 * (dh - 0.5) + 0.5 * ridden.radius);
    if (r0 <= 0.2) return;
    soV.addScaledVector(soU, -dh);
    const hd = soV.length();
    if (hd >= r0) return;
    soF.copy(fwd).addScaledVector(soU, -fwd.dot(soU));
    if (soF.lengthSq() > 1e-8) soF.normalize();
    soD.copy(soV).divideScalar(r0).addScaledVector(soF, -0.5);
    if (soD.lengthSq() < 1e-8) return;
    soD.normalize();
    // (Soft and continuous: none at r0, all of it from 0.6 r0 in — to r0 · √((1 + (hd/r0)²)/2) —
    // eased by w at the ends of the trip.)
    const want = r0 * Math.sqrt(0.5 * (1 + (hd / r0) ** 2));
    const k = w * smoothstep(r0, 0.6 * r0, hd);
    soD.multiplyScalar(want).sub(soV);
    o.copy(subj).addScaledVector(soU, dh).add(soV).addScaledVector(soD, k);
  }
  const soU = new Vector3();
  const soV = new Vector3();
  const soF = new Vector3();
  const soD = new Vector3();

  /** The enter transition's pose at path progress e into out (from: the coasting start). */
  function enterPose(e: number) {
    coast.at(blendAge, from);
    enterPos(e, -1, out.pos);
    if (mode === 'ride' && ridden) standOff(e, out.pos, tp.pos, tp.fwd);
    // The start's own motion: carried on at first. (The coast bleeds it off; its offset fades.)
    out.pos.addScaledVector(tA.subVectors(from.pos, coast.p0), 1 - ease(e / 0.45));
    planRefs(e);
    orientAt(e, out.pos, from.look, from.quat, farLook(tL), target.quat, out.look, out.quat, mode === 'ride' && ridden ? tp.pos : null);
    out.fov = from.fov + (target.fov - from.fov) * e;
    out.shift = from.shift + (target.shift - from.shift) * e;
  }

  /**
   * The first point of the planned path (effective fraction, ≤ 0.6 of the way to the approach)
   * from which the next 30 m toward `look` are clear of buildings, hills and crowns: the gaze turns
   * toward the subject from there, not into the facade it is behind.
   */
  function firstSight(ctx: LBContext, look: Vector3): number {
    const end = path.eQ * 0.6;
    for (let i = 0; i <= 24; i++) {
      const e = (i / 24) * end;
      path.at(e, tG);
      tH.subVectors(look, tG);
      const d = tH.length();
      if (d < 1e-3) return e;
      tH.multiplyScalar(Math.min(1, 30 / d)).add(tG);
      if (free(ctx, tG, tH) >= 0.999) return e;
    }
    return end;
  }

  /** Path progress at clock time blendT (0 … 1). */
  function eOfClock(bt: number, ctx: LBContext): number {
    return tmap.eAt(clockU(bt * blendDur, blendDur, clockIn, clockOut));
  }

  /**
   * Advance the enter transition's clock by dt (dilated) and pose it into out; returns e. The plan
   * keeps the view's turns under TURN_PLAN for the target where it was predicted to go; a target that
   * goes elsewhere (a car turning a corner) is followed live, so where that would turn the view faster,
   * the clock slows (quickly, and recovers gently: never a step in speed) instead of whipping round.
   */
  function stepEnter(ctx: LBContext, dt: number): number {
    if (nearOn) {
      if (dt > 0) blendT = Math.min(1, blendT + dt / blendDur);
      nearPose(blendT * blendDur, out);
      return blendT;
    }
    if (dt > 0) updateLive();
    if (!(dt > 0)) {
      const e = eOfClock(blendT, ctx);
      enterPose(e);
      return e;
    }
    // (At most half speed, and never more than ~1.4× the planned length in all: the target keeps
    // moving meanwhile.)
    // (D1f r2: the plan itself lands by DUR_MAX; only a target gone astray — a car U-turning in a
    // turnaround as the camera reaches it — stretches it, rather than squeeze the swing round it
    // into a whip the drawn camera would still be catching up with after arriving.)
    const kMin = 0.5 + 0.5 * smoothstep(1.15 * blendDur, 1.4 * blendDur, blendAge);
    const e0 = eOfClock(blendT, ctx);
    let k = 1;
    let e = 0;
    for (let it = 0; it < 4; it++) {
      e = eOfClock(Math.min(1, blendT + (dt * k) / blendDur), ctx);
      enterPose(e);
      if (!planQValid) break;
      const a = planQ.angleTo(out.quat);
      // Slower only where the live view turns faster than the plan does there (×1.25): a trip whose
      // plan already turns fast where it had to fit 2.5 s is not stretched past it (D1f).
      const lim = 1.25 * Math.max(TURN_PLAN * dt, plannedTurn(e0, e));
      if (a <= lim || k <= kMin) break;
      k = Math.max(kMin, k * (lim / a) * 0.9);
    }
    // (D1f r5) And while what is drawn lags far behind the wanted view (a car U-turning as the camera
    // swings round it: 75° behind, the car out of frame for 0.4 s), the clock waits for it.
    if (fol.valid) {
      const lag = fol.q.angleTo(out.quat);
      if (lag > 12 * DEG) k = Math.max(kMin, Math.min(k, 1 - (0.6 * (lag - 12 * DEG)) / (30 * DEG)));
    }
    // (D1f r4) Into someone's eyes: over their shoulder, just before the drop, hold back (the clock
    // at a fifth, ≤ HOLD_MAX s in all) while a car, a bus or a walker is about to cross right in
    // front of their face — it otherwise filled 60 % of the first view for 0.7 s (a taxi at a kerb).
    const dFace = ctx.camera.position.distanceTo(tp.pos);
    if (enterEyes && holdUsed < HOLD_MAX && e0 < 0.975 && dFace < 12) {
      holdT -= dt;
      if (holdT <= 0) {
        holdT = 0.1;
        holdOn = faceBlocked(ctx, dFace < 6);
      }
      if (holdOn) {
        k = Math.min(k, 0.2);
        holdUsed += dt;
      }
    }
    let kNew = clockK + Math.max(-6 * dt, Math.min(2 * dt, k - clockK));
    // (D1f r5) Never past CAP_HARD from the click: the clock runs at least fast enough to land by then
    // (a target gone astray, the hold before the drop and the rest of the trip share the slack).
    // (Slow now only as far as running a little fast, ×1.1, over what is left still lands in time.)
    // (Inside the last 0.4 s, what is left over the time left: a fixed 0.4 s there only ever halved
    // the gap, landing 2.52 s from the click.)
    const left = CAP_HARD - blendAge;
    const rem = (1 - blendT) * blendDur;
    const need = left > 0.4 ? (rem - 1.1 * (left - 0.4)) / 0.4 : rem / Math.max(dt, left);
    kNew = Math.max(kNew, Math.min(1.25, need));
    clockK = kNew;
    blendT = Math.min(1, blendT + (dt * clockK) / blendDur);
    e = eOfClock(blendT, ctx);
    enterPose(e);
    planQ.copy(out.quat);
    planQValid = true;
    return e;
  }

  /** (D1f r4) The hold before the drop into someone's eyes (stepEnter): used (s), the 10 Hz test, its result. */
  let holdUsed = 0;
  let holdT = 0;
  let holdOn = false;
  const HOLD_MAX = 0.7;
  const HOLD_KINDS = ['car', 'bus', 'truck', 'person'] as const;
  const holdP: TrackPose = { pos: new Vector3(), fwd: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1), speed: 0 };

  /**
   * (D1f r4) True when, over the next 0.75 s (straight lines, both moving), a car, a bus, a truck or
   * another walker passes within ~1 m of the ridden walker's line of sight 0.3–3.5 m in front of
   * their eyes — and is out of it 1.5 s later (along the arc it is turning on).
   */
  function faceBlocked(ctx: LBContext, watch = true): boolean {
    const tr = ctx.services.track;
    if (!tr || !ridden) return false;
    tE.copy(tp.fwd).addScaledVector(tF.copy(tp.pos).normalize(), -tp.fwd.dot(tF));
    if (tE.lengthSq() < 1e-8) return false;
    tE.normalize();
    const now = ctx.time.render;
    let hit = false;
    for (let kk = 0; kk < HOLD_KINDS.length; kk++) {
      for (const t of tr.list(HOLD_KINDS[kk])) {
        if (t === ridden || !t.pose(ctx, holdP) || holdP.pos.distanceToSquared(tp.pos) > 15 * 15) continue;
        // (D1f r5) Its turn rate, from its heading the last time it was looked at (a taxi turning
        // round slowly at the kerb is not on a straight line: it filled the first view for 0.5 s).
        holdW = 0;
        let slot = holdIds.indexOf(t);
        if (slot >= 0) {
          const dtS = now - holdTs[slot];
          if (dtS > 0.02 && dtS < 0.5) {
            hU.copy(holdP.pos).normalize();
            hV.set(holdFs[slot * 3], holdFs[slot * 3 + 1], holdFs[slot * 3 + 2]);
            holdW = Math.atan2(hW.crossVectors(hV, holdP.fwd).dot(hU), hV.dot(holdP.fwd)) / dtS;
          }
        } else {
          slot = holdNext;
          holdNext = (holdNext + 1) % holdIds.length;
          holdIds[slot] = t;
        }
        holdFs[slot * 3] = holdP.fwd.x;
        holdFs[slot * 3 + 1] = holdP.fwd.y;
        holdFs[slot * 3 + 2] = holdP.fwd.z;
        holdTs[slot] = now;
        if (hit || !watch) continue;
        const half = kk === 3 ? 0.35 : 0.5 * Math.min(2.4, t.radius);
        // (D1f r5) Only what crosses and is gone within 1.5 s: someone walking on ahead of them, the
        // same way, stays in front — waiting for them only made the trip 0.45 s longer.
        for (let s = 0; s <= 0.75; s += 0.25) {
          if (inFace(half, s) && !inFace(half, s + 1.5)) {
            hit = true;
            break;
          }
        }
      }
    }
    return hit;
  }
  /** (D1f r5) Blockers' headings the last time they were looked at (turn rates), a ring of 16. */
  const holdIds: (Trackable | null)[] = new Array(16).fill(null);
  const holdFs = new Float64Array(16 * 3);
  const holdTs = new Float64Array(16);
  let holdNext = 0;
  let holdW = 0;
  const hU = new Vector3();
  const hV = new Vector3();
  const hW = new Vector3();

  /** (D1f r5) True when the blocker in holdP (half width `half` m) is in front of the ridden face s s from now. */
  function inFace(half: number, s: number): boolean {
    // Along the arc it is turning on (holdW, rad/s about its up), or straight on.
    const v = holdP.speed;
    if (Math.abs(holdW) < 1e-3) tG.copy(holdP.pos).addScaledVector(holdP.fwd, v * s);
    else {
      hV.crossVectors(hU.copy(holdP.pos).normalize(), holdP.fwd);
      tG.copy(holdP.pos).addScaledVector(holdP.fwd, (v / holdW) * Math.sin(holdW * s)).addScaledVector(hV, (v / holdW) * (1 - Math.cos(holdW * s)));
    }
    tG.sub(tp.pos);
    tG.addScaledVector(tp.fwd, -tp.speed * s);
    const along = tG.dot(tE);
    if (along < 0.3 || along > 3.5) return false;
    tG.addScaledVector(tE, -along);
    tG.addScaledVector(tF, -tG.dot(tF));
    return tG.length() < 0.8 + half;
  }

  /**
   * The pose to draw: the wanted one, its orientation followed within `rate` (rad/s) and `acc`
   * (rad/s²) — Infinity: as it is.
   */
  function follow(fp: FramePose, dt: number, rate: number, acc: number): FramePose {
    if (dt > 0) {
      dbgWant = wantValid ? wantQ.angleTo(fp.quat) : 0;
      wantQ.copy(fp.quat);
      wantValid = true;
    }
    if (!fol.valid) {
      fol.reset(fp.quat);
      folLagging = false;
      return fp;
    }
    if (dt <= 0) {
      // A frame with no time step redraws what was drawn.
      copyFramePose(lim, fp);
      lim.quat.copy(fol.q);
      return lim;
    }
    const k = ctxRef?.reducedMotion ? 0.75 : 1;
    fol.step(fp.quat, dt, rate * k, acc * k);
    folLagging = fol.q.angleTo(fp.quat) > 0.0005;
    if (fol.q.equals(fp.quat)) return fp;
    copyFramePose(lim, fp);
    lim.quat.copy(fol.q);
    return lim;
  }

  /** ctx.view mirrors the mode (every frame in frameEnd, and at once on a switch). */
  function mirror(ctx: LBContext) {
    ctx.view.mode = mode;
    ctx.view.ride = mode === 'ride' ? rideId : null;
    if (mode === 'ride' && rideId) {
      lastRide = rideId;
      rideFade = 1;
    }
    ctx.view.lastRide = lastRide;
    ctx.view.rideFade = rideFade;
  }

  /**
   * Falling through the clouds on the way in (S1's overlay, sky.cross > 0), the lens narrows onto
   * the subject so its body reads at ≥ ~12 % of the frame's height over the overlay — never so far that
   * it leaves the frame, never under 0.4× — and widens back as the hole opens (a spring: no snap).
   * D1f: from the city view a car 40 m below the band was a 30 px porthole in a white screen.
   */
  function crossZoom(ctx: LBContext, dt: number, e: number) {
    let want = 1;
    let cross = ctx.services.sky?.cross ?? 0;
    // (D1f r2) Led: narrowing from ~0.35 s before the planned path enters the band, so the lens is
    // at its narrowest as the overlay closes, not after (it reached 37° only as the hole opened).
    if (pathOn && !nearOn && planStage === 0 && path.crosses && path.eCross > 0 && blendT < 1 && e < path.eCross + 0.2) {
      const eAhead = eOfClock(Math.min(1, blendT + 0.35 / blendDur), ctx);
      if (eAhead >= path.eCross) cross = Math.max(cross, Math.min(1, 0.25 + (eAhead - path.eCross) / Math.max(1e-3, eAhead - e)));
    }
    // (D1f r2) Up to the station or a satellite, the lens closes in on it through the middle of the
    // trip while it is still a speck (against a night-side starfield it was 2–3 px for 0.7 s), and
    // opens back out well before arriving.
    if (pathOn && !nearOn && planStage === 0 && mode === 'ride' && ridden?.view === 'alongside' && blendT < 1) {
      cross = Math.max(cross, 0.66 * smoothstep(0.25, 0.4, e) * (1 - smoothstep(0.62, 0.78, e)));
    }
    if (cross > 0.02 && e < 0.85 && mode === 'ride' && ridden) {
      tA.subVectors(tp.pos, out.pos);
      const dist = tA.length();
      if (dist > 1e-3) {
        tA.divideScalar(dist);
        tB.set(0, 0, -1).applyQuaternion(out.quat);
        const c = tA.dot(tB);
        if (c > 0.2) {
          const off = Math.acos(Math.min(1, c));
          const f = out.fov * DEG;
          // (The bounding sphere is about twice what shows: a car from above is ~half its 2.3 m
          // radius wide. Its diameter at a quarter of the frame shows the body at ~12 %.)
          const need = (2 * Math.atan(ridden.radius / dist)) / 0.25;
          const keep = 2 * Math.atan(Math.tan(off) / 0.7);
          want = Math.min(f, Math.max(need, keep, 0.4 * f)) / f;
          want = 1 + (want - 1) * Math.min(1, cross * 1.5) * (1 - smoothstep(0.68, 0.85, e));
        }
      }
    }
    if (dt > 0) {
      springStep(zoomK, zoomV, want, 7, dt, spT);
      zoomK = Math.min(1, Math.max(0.35, spT[0]));
      zoomV = spT[1];
    }
    if (blendT >= 1 || !pathOn) {
      zoomK = 1;
      zoomV = 0;
    }
    if (zoomK < 0.999) out.fov *= zoomK;
  }
  let zoomK = 1;
  let zoomV = 0;
  let eyesNearK = 0;

  /** The reduced-motion dip: the canvas faded toward its wrapper's space colour by k (0 … 1). */
  function setDip(ctx: LBContext, k: number) {
    const on = k > 0.002;
    if (!on && !dipSet) return;
    // (D1f r4: dim rather than black — at 6 % it read as the page going dark. D1f r5: to 20 %, 8 % for
    // a turn past 150°: the move is made while it is that dim.)
    ctx.canvas.style.opacity = on ? (1 - dipDepth * k).toFixed(3) : '';
    dipSet = on;
    dipNow = on ? dipDepth * k : 0;
  }
  /** Review (D1f r6): how far reduced motion's dip has dimmed the canvas (0 … 1: 0.8 = at 20 %). */
  let dipNow = 0;

  function setRidden(on: boolean) {
    if (on === riddenOn) return;
    riddenOn = on;
    ridden?.setRidden?.(on);
  }

  function release() {
    setRidden(false);
    ridden = null;
    rideId = null;
  }

  // ── Mode switches ──

  function ride(ctx: LBContext, id: string, instant = false): boolean {
    const t = ctx.services.track?.get(id);
    if (!t || !t.pose(ctx, tp)) return false;
    ctxRef = ctx;
    rideEnv.reduced = ctx.reducedMotion;
    const same = mode === 'ride' && rideId === id;
    if (same && !instant) return true;
    if (mode === 'bird') letBirdGo();
    if (ridden && ridden !== t) setRidden(false);
    ridden = t;
    rideId = id;
    lostT = 0;
    copyPose(lastTp, tp);
    // (D1f) The ride's own settled framing — behind a car or a plane, the station's high side view,
    // ahead in someone's eyes — is where the trip ends: once the transition reports blend = 1 the
    // ride is settled. Round 1–2 arrived framed from the side the camera came from and swung round
    // after arriving (60–95° more, 1–2 s): the felt trip was 4–6 s.
    rig.begin(t.view, t.radius, tp, rideEnv, target);
    // Beside the station or a satellite every side is a good view (high above it, the planet below):
    // it is framed from the side the camera comes from, and stays so (drag orbits).
    if (t.view === 'alongside' && !instant) {
      tA.copy(tp.pos).normalize();
      tB.subVectors(ctx.camera.position, tp.pos).addScaledVector(tA, -tB.dot(tA));
      tC.copy(tp.fwd).addScaledVector(tA, -tp.fwd.dot(tA));
      if (tB.lengthSq() > 1 && tC.lengthSq() > 1e-8) {
        tC.normalize();
        tD.crossVectors(tC, tA).normalize(); // right
        const ya = Math.atan2(tB.dot(tD), -tB.dot(tC)) - rig.framing.yaw;
        // (D1f r5) Of eight sides round it, the one where it reads: lit by the sun, or else dark
        // against the sunlit planet or its glowing limb — a satellite in the planet's shadow, framed
        // from the side the camera came from, was navy on the navy night side. The side the camera
        // comes from wins ties (a shorter swing in).
        let best = -Infinity;
        let bestYa = ya;
        let bestBd = -1;
        const sun = ctx.uniforms.lbSunDir.value;
        const satLit = smoothstep(-0.1, 0.3, tA.dot(sun));
        for (let k = -4; k < 4; k++) {
          const cand = ya + k * 45 * DEG;
          rig.yawT = Math.atan2(Math.sin(cand), Math.cos(cand));
          rig.settle(tp, rideEnv, target);
          const bd = backdropLight(target.pos, tp.pos, sun);
          const sc = Math.max(satLit, bd) - 0.12 * Math.abs(k * 45 * DEG);
          if (sc > best + 1e-6) {
            best = sc;
            bestYa = cand;
            bestBd = bd;
          }
        }
        rig.yawT = Math.atan2(Math.sin(bestYa), Math.cos(bestYa));
        // (D1f r6) In the planet's shadow with nothing lit behind it from any side (a satellite at
        // local midnight: no sunlit ground within its horizon), it is framed from lower down — the
        // line through it passing ~45 m over the sea, over the limb's glow — so it stands against the
        // stars over the night disc's rim, not navy on the navy disc (critic r2: "dark on dark").
        if (satLit < 0.3 && bestBd < 0.1) {
          const rs = tp.pos.length();
          const elNow = elevationFor(rig.framing.el, rs - R, rig.framing.fov);
          const elWant = Math.acos(Math.min(1, (R + 45) / rs));
          if (elWant < elNow) rig.pitchT = Math.max(rig.framing.minEl - rig.framing.el, elWant - elNow);
        }
        rig.settle(tp, rideEnv, target);
      }
    }
    target.fov = fit(ctx, target.fov);
    stopPush = 0;
    stopArmed = false;
    if (instant) {
      blendT = 1;
      fol.valid = false;
      teleported = true;
    } else {
      vTgt.copy(tp.fwd).multiplyScalar(tp.speed);
      beginEnter(ctx, vTgt, t.view === 'eyes' ? 3 : Math.max(2.5, rig.camDist * 0.6), t.view === 'eyes');
    }
    mode = 'ride';
    mirror(ctx);
    return true;
  }

  /**
   * (D1f r5) How lit (−1 … 1) the backdrop is behind world point `subj` seen from `eye`: the sunlit
   * side of the planet where the line through it meets the planet, its limb's glow where it grazes
   * the atmosphere, dark space beyond.
   */
  function backdropLight(eye: Vector3, subj: Vector3, sun: Vector3): number {
    bdV.subVectors(subj, eye).normalize();
    const b = subj.dot(bdV);
    const c = subj.lengthSq() - R * R;
    const disc = b * b - c;
    if (disc >= 0 && -b - Math.sqrt(disc) > 0) {
      bdP.copy(subj).addScaledVector(bdV, -b - Math.sqrt(disc)).normalize();
      return bdP.dot(sun);
    }
    // Missed: the closest the line comes to the planet ahead of the subject.
    bdP.copy(subj).addScaledVector(bdV, Math.max(0, -b));
    const h = bdP.length() - R;
    const glow = 1 - smoothstep(0, 40, h);
    return glow * 0.8 * bdP.normalize().dot(sun) - 0.4 * (1 - glow);
  }
  const bdV = new Vector3();
  const bdP = new Vector3();

  function copyPose(o: TrackPose, a: TrackPose) {
    o.pos.copy(a.pos);
    o.fwd.copy(a.fwd);
    o.up.copy(a.up);
    o.speed = a.speed;
  }

  /** Back to explore from wherever the camera is (it coasts to rest, explore takes over there). */
  function exitMode(ctx: LBContext, instant = false) {
    if (mode === 'explore') return;
    if (mode === 'bird') letBirdGo();
    release();
    mode = 'explore';
    mirror(ctx);
    if (instant) {
      current(ctx, out);
      tB.set(0, 0, -1).applyQuaternion(out.quat);
      tC.set(0, 1, 0).applyQuaternion(out.quat);
      host.handoff(ctx, out.pos, tB, tC);
      blendT = 1;
      fol.valid = false;
      teleported = true;
      return;
    }
    const midway = pathOn && blendT < 1;
    launching = false;
    dipOn = false;
    beginExit(ctx, EXIT_DUR * (ctx.reducedMotion ? 1.3 : 1));
    coast.rest(out);
    tB.set(0, 0, -1).applyQuaternion(out.quat);
    tC.set(0, 1, 0).applyQuaternion(out.quat);
    // Up in the air (or half way through a trip, gazing off at the sky): explore takes over looking
    // back down at the world, at least 20° below the horizon.
    tA.copy(out.pos).normalize();
    const hT = out.pos.length() - R - ctx.world.planet.surfaceAt(tA);
    const sp = tB.dot(tA);
    if ((midway || hT > 12) && sp > -Math.sin(20 * DEG)) {
      tD.copy(tB).addScaledVector(tA, -sp);
      if (tD.lengthSq() < 1e-8) tD.copy(tC).addScaledVector(tA, -tC.dot(tA));
      tD.normalize();
      tB.copy(tD).multiplyScalar(Math.cos(20 * DEG)).addScaledVector(tA, -Math.sin(20 * DEG));
      tC.copy(tA).addScaledVector(tB, -tA.dot(tB)).normalize();
    }
    host.handoff(ctx, out.pos, tB, tC);
  }

  /** Bird flight from the current pose. */
  function fly(ctx: LBContext, instant = false) {
    if (mode === 'bird') return;
    ctxRef = ctx;
    release();
    const cam = ctx.camera;
    const h = cam.position.length() - R;
    tA.copy(cam.position).normalize(); // up at the camera
    tB.set(0, 0, -1).applyQuaternion(cam.quaternion); // forward
    tC.copy(tB).addScaledVector(tA, -tB.dot(tA));
    if (tC.lengthSq() < 0.01) {
      // Looking straight down (orbit): the camera's up is the heading.
      tC.set(0, 1, 0).applyQuaternion(cam.quaternion);
      tC.addScaledVector(tA, -tC.dot(tA));
    }
    tC.normalize(); // heading
    const takeBack = birdOn && bird.pos.distanceTo(cam.position) < 70;
    guide = 0;
    guideT = 0;
    guideOn = false;
    guideW = 0;
    guideSky = -Infinity;
    downK = 0;
    // In the air already (or on the street): a launch. The bird appears just ahead of and under the
    // lens, where its chase camera, 2 m back, puts the camera about where it is now; the chase runs
    // from the first frame and lets the bird pull out to its 3.5 m (it used to fly off to a speck
    // while a 1 s transition caught up with it).
    const launch = !takeBack && h < BIRD_CEILING - 4;
    if (!takeBack) {
      if (launch) {
        tD.copy(cam.position).addScaledVector(tC, LAUNCH_DIST * Math.cos(BIRD_CAM.el)).addScaledVector(tA, -LAUNCH_DIST * Math.sin(BIRD_CAM.el) - 0.25);
      } else {
        // From orbit: down under the view, in the open air above the town or the sea.
        tD.copy(tA).multiplyScalar(R + 72);
      }
      const dir = tB.copy(tD).normalize();
      const fl = hardFloor(ctx, dir);
      const hb = Math.min(BIRD_CEILING - 8, Math.max(tD.length() - R, fl + (launch ? 1.4 : 2.6)));
      tD.copy(dir).multiplyScalar(R + hb);
      // A launch heads for open space (D1f: along the lens it flew into the facade the camera was
      // looking at and slid up it for a second — a collision, not a take-off): the clearest of a
      // fan of headings round the lens's, biased toward it, climbing. The chase camera starts
      // along the lens and swings round after the bird.
      if (launch) launchHeading(ctx, tD, tC, tH);
      else tH.copy(tC);
      bird.reset(tD, tH, launch ? BIRD.min + 1.5 : BIRD.cruise);
      // Near the ground: a take-off, nose up (it flaps on its own while slow and climbing), and
      // for its first second it climbs out whatever is held (down included), easing off.
      if (hb - fl < 8) {
        bird.gamma = 15 * DEG;
        takeoff = TAKEOFF + TAKEOFF_CALM;
        guide = GUIDE;
        guideT = 0;
      } else takeoff = guide = 0;
      // Its wall berth is on from the first frame (it used to ease in over a quarter second).
      bird.primeWalls(birdEnv);
      birdPop = 0;
    }
    birdOn = true;
    birdAway = 0;
    birdPopDir = 1;
    joyX = joyY = 0;
    birdCam.logDistT = Math.log(launch ? LAUNCH_DIST : BIRD_CAM.dist);
    birdCam.settle(bird, birdCamEnv, target, !launch, launch ? tC : null);
    birdCam.logDistT = Math.log(BIRD_CAM.dist);
    launching = launch && !instant;
    target.fov = fit(ctx, target.fov);
    stopPush = 0;
    stopArmed = false;
    if (instant) {
      birdCam.settle(bird, birdCamEnv, target);
      target.fov = fit(ctx, target.fov);
      blendT = 1;
      birdPop = 1;
      fol.valid = false;
      teleported = true;
    } else if (launch || cam.position.distanceTo(target.pos) < 8) {
      // A short blend from the camera onto the running chase (no planned path: it is right there).
      beginExit(ctx, LAUNCH_BLEND * (ctx.reducedMotion ? 1.3 : 1));
    } else {
      vTgt.copy(bird.dir).multiplyScalar(bird.speed);
      beginEnter(ctx, vTgt, 3);
    }
    mode = 'bird';
    mirror(ctx);
  }

  /**
   * The free metres (≤ span) from `p` along unit tangent `k`, climbing at `climb` (tan) but never
   * under the ground + 1.4 m, before a facade (a berth growing to 3.4 m with the distance: down the
   * middle of a street, not along a wall; a slender tower keeps TOWER_BERTH more); lamp heads and
   * crowns cost only the metres they block (the soft floor lifts the bird over them).
   */
  function freeRun(ctx: LBContext, p: Vector3, k: Vector3, climb: number, span: number): number {
    const h0 = p.length() - R;
    let run = 0;
    for (let s = 2; s <= span; s += 2) {
      tL.copy(p).addScaledVector(k, s).normalize();
      const hs = Math.max(h0 + s * climb, ctx.world.planet.surfaceAt(tL) + 1.4);
      if (birdWall(ctx, tL, hs, Math.min(3.4, 1.2 + s * 0.25), oV)) break;
      if (softFloor(ctx, tL) <= hs - 0.6) run += 2;
    }
    return run;
  }

  /**
   * The clearest heading (unit tangent into out): of 19 headings within ±90° of `look`, the one
   * with the most free metres (freeRun), weighted toward `look`. Returns its run.
   */
  function clearHeading(ctx: LBContext, p: Vector3, look: Vector3, climb: number, span: number, o: Vector3): number {
    tI.copy(p).normalize();
    tJ.crossVectors(look, tI).normalize(); // right
    let best = -1;
    let bestRun = 0;
    o.copy(look);
    for (let k = -9; k <= 9; k++) {
      const a = k * 10 * DEG;
      tK.copy(look).multiplyScalar(Math.cos(a)).addScaledVector(tJ, Math.sin(a));
      const run = freeRun(ctx, p, tK, climb, span);
      const score = run * (0.55 + 0.45 * Math.cos(a)) - Math.abs(k) * 0.01;
      dbgLaunch[k + 9] = run;
      if (score > best) {
        best = score;
        bestRun = run;
        o.copy(tK);
      }
    }
    return bestRun;
  }

  /** The launch heading: the clearest within ±90° of the lens, climbing at 15°, over 30 m. */
  function launchHeading(ctx: LBContext, p: Vector3, look: Vector3, o: Vector3) {
    clearHeading(ctx, p, look, Math.tan(15 * DEG), 30, o);
  }

  /**
   * (D1f r4) The idle guide's 4 Hz look: is the way ahead clear (IDLE_ON / IDLE_OFF m of IDLE_RUN, at
   * the climb it is flying), and if not, the clearest heading; and the skyline it climbs to in town.
   */
  function idleLook(ctx: LBContext, climbIn: number, dive = false) {
    const t0 = performance.now();
    idleLookBody(ctx, climbIn, dive);
    PT.guide = Math.max(PT.guide, performance.now() - t0);
  }
  function idleLookBody(ctx: LBContext, climbIn: number, dive: boolean) {
    tA.copy(bird.pos).normalize();
    const h = bird.pos.length() - R;
    guideSky = inCity(tA, 0) ? PLATEAU_HEIGHT + roofNear(ctx, plan.x, plan.z, SKY_R) + SKY_OVER : -Infinity;
    // (D1f r5: diving, the way ahead is measured level — the soft floor holds it up off the street
    // anyway, and measured diving every heading met the ground and the guide wandered.)
    const climbing = dive ? 0 : climbIn < -0.05 ? -0.2 : climbIn > 0.05 || h < guideSky ? 0.22 : Math.tan(Math.max(-10 * DEG, Math.min(12 * DEG, bird.gamma)));
    guideRun = freeRun(ctx, bird.pos, bird.fwd, climbing, IDLE_RUN);
    if (guideRun < IDLE_ON) guideOn = true;
    else if (guideRun >= IDLE_OFF) guideOn = false;
    if (guideOn || guide > 0) clearHeading(ctx, bird.pos, bird.fwd, guide > 0 ? Math.tan(15 * DEG) : climbing, guide > 0 ? 30 : IDLE_RUN, guideH);
  }

  const dbgLaunch = new Array<number>(19).fill(0);

  /** The bird flies on by itself (an exit, or a ride starting): it heads off and pops out of sight. */
  function letBirdGo() {
    birdAway = 0.001;
  }

  function cycle(ctx: LBContext, dirn: 1 | -1) {
    if (mode !== 'ride' || !ridden) return;
    const list = ctx.services.track.list(ridden.kind);
    const n = list.length;
    let i = list.indexOf(ridden);
    for (let k = 0; k < n; k++) {
      i = (i + dirn + n) % n;
      const t = list[i];
      if (t !== ridden && t.pose(ctx, tp)) {
        ride(ctx, t.id);
        return;
      }
    }
  }

  // ── Per frame ──

  /**
   * Before the explore update: Esc, [ ], picking clicks, hover, the zoom-out exit. May switch mode.
   * Returns true when the explore update should run this frame.
   */
  function frameStart(ctx: LBContext, inp: CameraInput | null, dt: number, locked: boolean): boolean {
    ctxRef = ctx;
    rideEnv.reduced = ctx.reducedMotion;
    if (inp && !locked) {
      if (inp.escape && mode !== 'explore') exitMode(ctx);
      if (mode === 'ride') {
        if (inp.pressed('BracketRight')) cycle(ctx, 1);
        if (inp.pressed('BracketLeft')) cycle(ctx, -1);
      }
      // A click (not a drag) on anything that moves rides it (explore or another ride). What the
      // pointer cursor and the hover tip showed is what a click near it rides (a plane seen from
      // orbit drifts out of a small pick disc in a third of a second; a walker steps aside and the
      // truck behind them was ridden instead); otherwise whatever is under the click.
      if (inp.click && mode !== 'bird' && !inp.doubleClick) {
        const held = hoverId && nearHovered(ctx, hoverId, inp.clickAt.x, inp.clickAt.y) ? ctx.services.track.get(hoverId) : undefined;
        let hit = held ?? pickAt(ctx, inp.clickAt.x, inp.clickAt.y);
        // (D1f r2) A plane seen from orbit drifts off the cursor held still over it: what was
        // hovered in the last 1.5 s and is still within 5× its disc of the click is ridden, not
        // the explore click under it (that dived toward the planet).
        if (!hit && lastHoverId && lastHoverAge < 1.5 && nearHovered(ctx, lastHoverId, inp.clickAt.x, inp.clickAt.y, 5)) hit = ctx.services.track.get(lastHoverId) ?? null;
        if (hit && ride(ctx, hit.id)) inp.click = false;
      }
      if (mode === 'ride') rideInput(ctx, inp, dt);
      else if (mode === 'bird') birdInput(ctx, inp, dt);
      hover(ctx, inp, dt);
    } else if (cursorSet) {
      ctx.canvas.style.cursor = cursorSet = '';
    }
    return mode === 'explore';
  }

  /** Ride-mode input: drag orbits / looks, wheel and pinch set the distance, keys take over. */
  function rideInput(ctx: LBContext, inp: CameraInput, dt: number) {
    const H = inp.height;
    if (inp.dragging && (inp.dragDX !== 0 || inp.dragDY !== 0)) {
      const k = ((ctx.camera.fov * DEG) / H) * (rig.view === 'eyes' && rig.dist < 0.5 ? 1 : 1.6);
      rig.yawT -= inp.dragDX * k;
      rig.pitchT += inp.dragDY * k;
      rig.idle = 0;
    }
    let dz = 0;
    if (inp.wheel !== 0) dz += inp.wheel * 0.0018;
    if (inp.pinch !== 1) dz -= Math.log(inp.pinch) * 1.3;
    const zk = (inp.key('KeyE') || inp.key('Equal') || inp.key('NumpadAdd') ? -1 : 0) + (inp.key('KeyQ') || inp.key('Minus') || inp.key('NumpadSubtract') ? 1 : 0);
    if (zk) dz += zk * dt * 1.4;
    rig.logDistT = zoom(ctx, rig.logDistT, rig.maxLog, dz, dt);
    if (mode !== 'ride') return;
    // Movement keys take over: back to explore here (walking on from a walker's eyes, panning on
    // from a plane), the keys then carry on in explore.
    const move = inp.key('KeyW') || inp.key('KeyA') || inp.key('KeyS') || inp.key('KeyD') || inp.key('ArrowUp') || inp.key('ArrowDown') || inp.key('ArrowLeft') || inp.key('ArrowRight');
    if (move) exitMode(ctx);
    // A double-click on the ground (not on something to ride) leaves the ride and flies there.
    else if (inp.doubleClick && !pickAt(ctx, inp.doubleAt.x, inp.doubleAt.y)) exitMode(ctx);
  }

  /**
   * The log distance after a zoom of dz from `cur`. The widest framing is a stop: a flick of the
   * wheel that reaches it holds there; zooming out again after a rest at the stop (a new gesture),
   * or pushing on against it for STOP_PUSH, exits.
   */
  function zoom(ctx: LBContext, cur: number, max: number, dz: number, dt: number): number {
    const atStop = cur >= max - 0.02;
    if (dz > 0 && atStop) {
      zoomIdle = 0;
      if (stopArmed) {
        exitMode(ctx);
        return max;
      }
      stopPush += Math.max(dt, 1 / 120);
      if (stopPush > STOP_PUSH) exitMode(ctx);
      return max;
    }
    if (dz !== 0) {
      zoomIdle = 0;
      stopArmed = false;
      if (dz < 0) stopPush = 0;
      return Math.min(max, cur + dz);
    }
    zoomIdle += dt;
    if (zoomIdle > 0.15) stopPush = 0;
    if (zoomIdle > STOP_REST && atStop) stopArmed = true;
    return cur;
  }

  /** Bird-mode input: keys, a drag as a joystick, the touch stick; a click / tap flaps. */
  function birdInput(ctx: LBContext, inp: CameraInput, dt: number) {
    if (inp.dragStarted) joyX = joyY = 0;
    if (inp.dragging) {
      joyX += inp.dragDX;
      joyY += inp.dragDY;
    } else {
      joyX = joyY = 0;
    }
    const st = inp.stick;
    const right = (inp.key('KeyD') || inp.key('ArrowRight') ? 1 : 0) - (inp.key('KeyA') || inp.key('ArrowLeft') ? 1 : 0);
    const up = (inp.key('KeyW') || inp.key('ArrowUp') ? 1 : 0) - (inp.key('KeyS') || inp.key('ArrowDown') ? 1 : 0);
    const J = Math.max(60, Math.min(140, inp.height * 0.18));
    birdIn.steer = Math.max(-1, Math.min(1, right + joyX / J + (st.active ? st.x : 0)));
    birdIn.climb = Math.max(-1, Math.min(1, up - joyY / J - (st.active ? st.y : 0)));
    if (inp.click) tapFlap = 0.2;
    tapFlap = Math.max(0, tapFlap - dt);
    birdIn.flap = inp.key('Space') || inp.pressed('Space') || tapFlap > 0;
    birdIn.dive = inp.key('ShiftLeft') || inp.key('ShiftRight');
    let dz = 0;
    if (inp.wheel !== 0) dz += inp.wheel * 0.0018;
    if (inp.pinch !== 1) dz -= Math.log(inp.pinch) * 1.3;
    const zk = (inp.key('KeyE') || inp.key('Equal') || inp.key('NumpadAdd') ? -1 : 0) + (inp.key('KeyQ') || inp.key('Minus') || inp.key('NumpadSubtract') ? 1 : 0);
    if (zk) dz += zk * dt * 1.4;
    birdCam.logDistT = zoom(ctx, birdCam.logDistT, birdCam.maxLog, dz, dt);
  }

  /** The pick disc's minimum (CSS px): wider up high, where everything that moves is small and fast. */
  function pickPx(ctx: LBContext): number {
    return 14 + 8 * smoothstep(30, 60, ctx.view.altTerrain);
  }

  function pickAt(ctx: LBContext, x: number, y: number): Trackable | null {
    return ctx.services.track?.pick(x, y, pickPx(ctx)) ?? null;
  }

  /**
   * True while canvas point (x, y) is within k× trackable `id`'s pick disc (zero-alloc): 2× by
   * default, 4× for something in the air or in space seen from high up (it drifts across the view).
   */
  function nearHovered(ctx: LBContext, id: string, x: number, y: number, k = 0): boolean {
    const t = ctx.services.track?.get(id);
    if (!t || !t.pose(ctx, hp)) return false;
    // (Someone's eyes are their anchor: the body's middle is lower.)
    if (t.view === 'eyes') hp.pos.addScaledVector(hp.up, -t.radius * 0.75);
    const cam = ctx.camera;
    const dist = cam.position.distanceTo(hp.pos);
    hpS.copy(hp.pos).project(cam);
    if (!(hpS.z < 1) || dist < 0.3) return false;
    const W = ctx.canvas.clientWidth || 1;
    const H = ctx.canvas.clientHeight || 1;
    const sx = ((hpS.x + 1) / 2) * W;
    const sy = ((1 - hpS.y) / 2) * H;
    const pxWorld = (2 * Math.tan((cam.fov * DEG) / 2)) / H;
    const rPx = Math.max((t.view === 'eyes' ? t.radius * 1.1 : t.radius) / (pxWorld * dist), t.kind === 'person' ? 18 : pickPx(ctx));
    const air = t.kind === 'plane' || t.kind === 'balloon' || t.kind === 'satellite' || t.kind === 'station';
    const f = k > 0 ? k : air && ctx.view.altTerrain > 60 ? 4 : 2;
    return Math.hypot(x - sx, y - sy) <= f * rPx;
  }
  let lastHoverId: string | null = null;
  let lastHoverAge = 99;
  const hp: TrackPose = { pos: new Vector3(), fwd: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1), speed: 0 };
  const hpS = new Vector3();

  /** ≤ 10 Hz: what is under the cursor (pointer cursor, the UI's hover label). */
  function hover(ctx: LBContext, inp: CameraInput, dt: number) {
    hoverT -= dt;
    const canPick = mode !== 'bird' && inp.hover && !inp.dragging && !inp.locked && !inp.pinching;
    if (!canPick) {
      if (hoverId !== null) hoverId = null;
      if (cursorSet && !inp.dragging) ctx.canvas.style.cursor = cursorSet = '';
      return;
    }
    lastHoverAge += dt;
    if (hoverT > 0) return;
    hoverT = HOVER_DT;
    // (Sticky: kept while the cursor stays within 2× of the hovered thing's disc, 3× up high.)
    if (!hoverId || !nearHovered(ctx, hoverId, inp.cursor.x, inp.cursor.y)) {
      const hit = pickAt(ctx, inp.cursor.x, inp.cursor.y);
      hoverId = hit && hit.id !== rideId ? hit.id : null;
    }
    if (hoverId) {
      lastHoverId = hoverId;
      lastHoverAge = 0;
    }
    const want = hoverId ? 'pointer' : '';
    if (want !== cursorSet) ctx.canvas.style.cursor = cursorSet = want;
  }

  /**
   * After the explore update: run the ride / bird, blend any transition, present, mirror the mode
   * into ctx.view, and hand the bird's render state over.
   */
  function frameEnd(ctx: LBContext, dt: number, exploreNear: number) {
    ctxRef = ctx;
    let nearW = exploreNear;
    if (mode !== 'ride') eyesNearK = 0;
    if (mode === 'ride') {
      const t = ridden;
      const ok = !!t && ctx.services.track.get(t.id) === t && t.pose(ctx, tp);
      if (ok) {
        lostT = 0;
        copyPose(lastTp, tp);
      } else {
        lostT += dt;
        copyPose(tp, lastTp);
      }
      if (!t || ctx.services.track.get(t.id) !== t || lostT > LOST_HOLD) {
        exitMode(ctx);
      } else {
        // (A frame with no time step — the review tool's rAFs with time frozen — only redraws.)
        rig.stiff = blendT < 1 ? 1 : Math.max(0, rig.stiff - dt / 1.2);
        const eyesIn = t.view === 'eyes' && blendT >= 1 && rig.dist < 0.45;
        eyesNearK = eyesIn ? (dt > 0 ? Math.min(1, eyesNearK + dt / 0.5) : teleported ? 1 : eyesNearK) : 0;
        if (dt > 0) rig.update(dt, tp, rideEnv, target);
        target.fov = fit(ctx, target.fov);
        nearW = rig.near;
        // The eyes: hide the head the camera is coming into before the lens gets to it (the owner
        // hides it within 1.2 m of the lens once told): coming down over the shoulder it is under
        // the frame by then — by where the camera is drawn.
        setRidden(t.view === 'eyes' && rig.dist < 0.45 && ctx.camera.position.distanceTo(tp.pos) < 1.6);
      }
    }
    stepBird(ctx, dt);
    if (mode === 'bird') {
      if (dt > 0) birdCam.update(dt, bird, birdCamEnv, target);
      target.fov = fit(ctx, target.fov);
      nearW = birdCam.near;
    }
    if (mode === 'explore') {
      current(ctx, target); // explore has just presented its own pose
      if (blendT < 1) nearW = Math.min(nearW, ctx.camera.near);
    }
    // Transition blend.
    if (blendT < 1) {
      blendAge += dt;
      let e: number;
      if (pathOn && planStage > 0) {
        // Planning (the frames after the switch): the camera coasts on as it was.
        planStep(ctx);
        coast.at(blendAge, out);
        e = 0;
      } else if (pathOn) e = stepEnter(ctx, dt);
      else {
        blendT = Math.min(1, blendT + dt / blendDur);
        e = ease(blendT);
        if (directOn) directPose(e);
        else {
          // Back to explore: the coasting snapshot eases onto explore's own pose.
          coast.at(blendAge, from);
          // (A launch looks at the bird from the first frame: the follower eases the turn.)
          blendPose(from, target, e, blendLift, out, launching ? 1 : ease(Math.min(1, blendT * 1.2)));
        }
        // Reduced motion, a long direct move: the canvas dips to the space colour behind it through
        // the middle (the fast part is never seen).
        if (dipOn) setDip(ctx, dipAt(blendT));
      }
      // Last resort (the target moved far off what was planned): never through a roof or the
      // ground on the way — seen a moment ahead and risen to through a spring, so a roof edge is
      // climbed, not jumped; it fades out with the blend so the landing is exact.
      tA.copy(out.pos).normalize();
      const hNow = out.pos.length() - R;
      let need = hardFloor(ctx, tA) + 0.5 - hNow;
      let needV = 0;
      if (pathOn && planStage === 0 && dt > 0 && blendT < 1) {
        if (nearOn) {
          nearPose(Math.min(blendDur, (blendT + 0.15 / blendDur) * blendDur), nearAhead);
          tB.copy(nearAhead.pos);
        } else enterPos(eOfClock(Math.min(1, blendT + 0.15 / blendDur), ctx), -1, tB);
        tB.normalize();
        need = Math.max(need, hardFloor(ctx, tB) + 0.5 - hNow);
        // (D1f r6) Into someone's eyes, low: the cars, buses and trucks passing under the lens are
        // risen over (their roof + ~3 m), softly. Planning leaves vehicles out of an eyes trip (lifted
        // over them, the swing ended in a steep drop); a box truck crossing the street under the swing
        // then slid a metre under the lens, filling a third of the frame. Gone within ~3 m of the
        // eyes: the drop over the shoulder is left as planned (faceBlocked holds it for what crosses
        // there). (The path's progress is no measure of that: the crane and the way over are most of
        // its length — e is 0.8 six metres out.)
        const kv = enterEyes && !nearOn && !directOn ? smoothstep(3, 5.5, out.pos.distanceTo(tp.pos)) : 0;
        if (kv > 0) {
          gatherTransitVehicles(ctx, dt, tA, hNow);
          const vf = Math.max(vehicleFloor(tA, 0), vehicleFloor(tB, 0.15));
          if (vf > 0) needV = kv * (vf - hNow);
        } else tvN = tvT = 0;
      }
      need *= 1 - e * e;
      if (dt > 0) {
        // (D1f r5: let down at ω 9, was 5 — lingering 4 m up, the drop into someone's eyes came last
        // and steep.)
        const want = Math.max(need, needV);
        springStep(floorLift, floorLiftVel, Math.max(0, want), want > floorLift ? 14 : 9, dt, spT);
        floorLift = Math.max(0, spT[0]);
        floorLiftVel = spT[1];
        if (floorLift < need - 0.4) floorLift = need - 0.4;
      }
      // (D1f r5) Not in reduced motion's direct move: its lift profile clears what lies between, and a
      // lift still letting down as it landed made the ride jump a metre on the frame it settled.
      if (directOn) floorLift = floorLiftVel = 0;
      if (floorLift > 0) out.pos.addScaledVector(tA, floorLift);
      crossZoom(ctx, dt, pathOn && planStage === 0 ? e : 1);
      dbgStep.e = e;
      dbgStep.k = clockK;
      dbgStep.need = floorLift;
      if (blendT >= 1) {
        turnTail = directOn ? 0 : TURN_TAIL;
        directOn = false;
      }
      tailOver = 0;
      // (Reduced motion's direct move is drawn as it is: its turn is made inside the dip, and a
      // follower lagging behind it would still be turning after it arrived.)
      const fr = directOn ? Infinity : TURN_BLEND;
      const fa = directOn ? Infinity : ACC_BLEND;
      present(ctx, follow(out, dt, fr, fa), Math.min(nearW, Math.max(0.05, (out.pos.length() - R) * 0.03)), mode === 'explore');
    } else {
      // Settled: the follower stays on a moment after a transition (and until it has caught up),
      // always for the bird; a steady ride is drawn as it is.
      // (Still catching up once the tail is over: the limits open up over ~0.3 s, then let go.)
      const tail = turnTail > 0 || (folLagging && tailOver < 0.45);
      if (turnTail <= 0 && tail) tailOver += dt;
      else if (!tail) tailOver = 0;
      const open = 1 + 8 * tailOver;
      const rate = mode === 'bird' ? (tail ? TURN_BLEND * open : TURN_BIRD) : tail ? TURN_BLEND * open : Infinity;
      const acc = mode === 'bird' ? (tail ? ACC_BLEND * open : ACC_BIRD) : tail ? ACC_BLEND * open : Infinity;
      if (mode !== 'explore') present(ctx, follow(target, dt, rate, acc), nearW, false);
      else {
        // Explore (its own pose, presented already): followed while the tail lasts.
        current(ctx, out);
        const c = follow(out, dt, rate, acc);
        if (c !== out) present(ctx, c, ctx.camera.near, true);
      }
    }
    turnTail = Math.max(0, turnTail - dt);
    // (D1f r2) Once the world runs, an idle moment plans and drops a dummy trip, so the first real
    // click does not pay for compiling the planner (~6 ms + a 12 ms frame cold, against ~1.6 warm).
    if (warmState === 0 && ++warmFrames > 30) {
      warmState = 1;
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) warmHandle = ric(() => warm(ctx), { timeout: 1500 });
      else warmHandle = setTimeout(() => warm(ctx), 300) as unknown as number;
    }
    if (dipSet && (blendT >= 1 || !dipOn)) setDip(ctx, 0);
    // The "just exited" signal fades after a ride.
    if (mode !== 'ride' && rideFade > 0) {
      rideFade = Math.max(0, rideFade - dt / RIDE_FADE);
      if (rideFade === 0) lastRide = null;
    }
    // Velocity of what was shown (for the next snapshot).
    // (A jump — setView, a shot, an instant switch — is flagged where it happens, never guessed from
    // the speed: a 900 m/s trip is real motion, and Esc in the middle of it must glide on.)
    if (dt > 0) {
      if (prevValid && !teleported) {
        tA.copy(ctx.camera.position).sub(prevPos).divideScalar(dt);
        vel.lerp(tA, 0.6);
        const r = angularVelocity(prevQuat, ctx.camera.quaternion, dt, tmpAxis);
        if (r > 1e-4) {
          angAxis.copy(tmpAxis);
          angRate += (r - angRate) * 0.6;
        } else angRate *= 0.4;
      } else {
        vel.set(0, 0, 0);
        angRate = 0;
      }
      prevPos.copy(ctx.camera.position);
      prevQuat.copy(ctx.camera.quaternion);
      prevValid = true;
      teleported = false;
    }
    mirror(ctx);
  }

  let warmState = 0;
  let warmFrames = 0;
  let warmHandle = 0;
  let disposed = false;
  /** Plan a dummy trip from the camera (explore, at rest) and drop it: the planner's first, cold run. */
  function warm(ctx: LBContext) {
    if (disposed || warmState !== 1) return;
    warmState = 2;
    if (mode !== 'explore' || blendT < 1) return;
    ctxRef = ctx;
    const t0 = performance.now();
    current(ctx, from);
    copyFramePose(target, from);
    tA.copy(from.pos).normalize();
    tB.set(0, 0, -1).applyQuaternion(from.quat).addScaledVector(tA, -0.5);
    target.pos.addScaledVector(tB.normalize(), 60);
    target.look.copy(target.pos).addScaledVector(tB, 20);
    planVT.set(0, 0, 0);
    planAMin = 3;
    enterEyes = false;
    tC.copy(target.pos).normalize();
    planAng = Math.acos(Math.max(-1, Math.min(1, tA.dot(tC))));
    blendDur = 2;
    planPath(ctx);
    planTiming(ctx);
    // (and one up through the clouds into the space layer, a quarter of the way round)
    tC.crossVectors(tA, tB).normalize();
    target.pos.copy(tA).applyAxisAngle(tC, 0.8).multiplyScalar(R + 150);
    target.look.copy(target.pos).multiplyScalar(0.98);
    tC.copy(target.pos).normalize();
    planAng = Math.acos(Math.max(-1, Math.min(1, tA.dot(tC))));
    planPath(ctx);
    planTiming(ctx);
    tK.set(0, 0, 0);
    nearTrip.plan(from.pos, from.quat, target.pos, planVT, tK, target.quat, false, nearEnv);
    blendT = 1;
    pathOn = false;
    nearOn = false;
    planStage = 0;
    PT.warm = performance.now() - t0;
  }

  const CROWD_MAX = 32;
  const CROWD_KINDS = ['person', 'car', 'bus', 'truck'] as const;
  const crowdXYZ = new Float64Array(CROWD_MAX * 3);
  /** (D1f r4) Per crowd entry: the floor over its anchor (m) and its reach round it (m). */
  const crowdTop = new Float64Array(CROWD_MAX);
  const crowdReach = new Float64Array(CROWD_MAX);
  let crowdN = 0;
  let crowdT = 0;
  const cp: TrackPose = { pos: new Vector3(), fwd: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1), speed: 0 };

  /** The bird: steered in bird mode, on autopilot once let go; its render state for the bird system. */
  function stepBird(ctx: LBContext, dt: number) {
    const rs = birdRender(ctx);
    if (!birdOn) {
      rs.show = false;
      rs.scale = 0;
      crowdN = 0;
      return;
    }
    // (D1f r2) Low over a street, the walkers near the bird join its soft floor (their heads + 0.6 m):
    // a dive or a take-off among a crowd skimmed through their heads. Gathered at ≤ 10 Hz.
    crowdT -= dt;
    if (dt > 0 && crowdT <= 0) {
      crowdT = 0.1;
      crowdN = 0;
      tA.copy(bird.pos).normalize();
      if (bird.pos.length() - R - ctx.world.planet.surfaceAt(tA) < 7 && ctx.services.track) {
        // (D1f r4) And the cars, buses and trucks: a dive down the street skimmed a taxi's roof.
        for (let kk = 0; kk < CROWD_KINDS.length; kk++) {
          const person = kk === 0;
          for (const t of ctx.services.track.list(CROWD_KINDS[kk])) {
            if (crowdN >= CROWD_MAX) break;
            if (!t.pose(ctx, cp) || cp.pos.distanceToSquared(bird.pos) > 16 * 16) continue;
            crowdXYZ[crowdN * 3] = cp.pos.x;
            crowdXYZ[crowdN * 3 + 1] = cp.pos.y;
            crowdXYZ[crowdN * 3 + 2] = cp.pos.z;
            crowdTop[crowdN] = person ? 0.75 : 0.35 * t.radius + 0.75;
            crowdReach[crowdN] = person ? 1.1 : 0.55 * t.radius + 1.3;
            crowdN++;
          }
        }
      }
    }
    if (mode === 'bird') {
      let src = birdOverride ?? birdIn;
      // (D1f r3) For its first few seconds off the street, left alone, the bird heads for the open
      // (the clearest heading, re-picked 4× a second) and keeps climbing: flying straight on, it met
      // the tower across the plaza and climbed its face for 1.7 s, the facade filling the frame.
      // (D1f r4) And left alone at any time after that, it looks IDLE_RUN m ahead 4× a second and
      // turns for the clearest heading when the way is blocked (once the take-off guide ended it
      // flew straight at the clock tower), and in town it climbs until it is over the roofs round it.
      // A steer from the player (or a dive) hands over at once; down or up held is respected.
      if (dt > 0) {
        guide = Math.max(0, guide - dt);
        // (D1f r5) Down or a dive held fades the take-off's climb out within ~0.3 s (it climbed on to
        // 10 m for 2 s whatever was held).
        downK = Math.max(0, Math.min(1, downK + (src.climb < -0.05 || src.dive ? dt : -dt) / 0.3));
        // (D1f r5) A dive held with no steer still has the guide's heading: a dive changes the pitch,
        // not who steers (Shift from the street pressed the bird against a glass facade for a second).
        if (Math.abs(src.steer) < 0.05) {
          guideT -= dt;
          if (guideT <= 0) {
            guideT = 0.25;
            idleLook(ctx, src.climb, src.dive);
          }
          const want = guide > 0 ? Math.min(1, guide / 0.8) : guideOn ? 1 : 0;
          guideW += Math.max(-2.5 * dt, Math.min(2.5 * dt, want - guideW));
          tA.copy(bird.pos).normalize();
          const a = Math.atan2(tB.crossVectors(bird.fwd, guideH).dot(tA), bird.fwd.dot(guideH));
          gIn.steer = Math.max(-1, Math.min(1, -a / (35 * DEG))) * Math.max(guideW, guide > 0 ? Math.min(1, guide / 0.8) : 0);
          const h = bird.pos.length() - R;
          const lift = guide > 0 ? 0.5 * Math.min(1, guide / 0.8) : 0;
          const sky = h < guideSky ? 0.45 * Math.min(1, (guideSky - h) / 3) : 0;
          gIn.climb = src.climb < -0.05 || src.dive ? src.climb : Math.max(src.climb, lift, sky);
          gIn.flap = src.flap;
          gIn.dive = src.dive;
          src = gIn;
        } else {
          guide = 0;
          guideOn = false;
          guideW = 0;
          guideT = 0;
        }
      }
      if (takeoff > 0 && dt > 0) {
        // (The climb assist for the first TAKEOFF s; the swerve held off a little longer.)
        const w = (Math.max(0, takeoff - TAKEOFF_CALM) / TAKEOFF) * (1 - downK);
        tkIn.steer = src.steer * (1 - 0.5 * w);
        tkIn.climb = Math.max(src.climb, 0.75 * w);
        tkIn.flap = src.flap;
        tkIn.dive = src.dive && w < 0.5;
        src = tkIn;
        bird.calm = Math.min(1, takeoff / TAKEOFF_CALM);
        takeoff = Math.max(0, takeoff - dt);
      } else if (dt > 0) bird.calm = 0;
      bird.step(dt, src, birdEnv);
    } else {
      // Let go: it flies on, climbing gently with a flap now and then, and pops away out there.
      birdAway += dt;
      birdIn.steer = 0.15;
      birdIn.climb = 0.35;
      birdIn.flap = birdAway % 1.4 < 0.05;
      birdIn.dive = false;
      bird.step(dt, birdIn, birdEnv);
      const far = bird.pos.distanceTo(ctx.camera.position);
      if (birdAway > 7 || far > 55) birdPopDir = -1;
    }
    birdPop = Math.min(1, Math.max(0, birdPop + birdPopDir * dt / 0.45));
    if (birdPopDir < 0 && birdPop <= 0) {
      birdOn = false;
      rs.show = false;
      rs.scale = 0;
      return;
    }
    rs.show = true;
    rs.pos.copy(bird.pos);
    // Body frame: +Z along the flight, +Y the banked up, +X left.
    tA.copy(bird.dir).negate();
    lookQuat(tA, bird.up, 0, rs.quat); // camera-style basis looks down −Z: aim −Z backwards so +Z is forward
    rs.scale = popScale(birdPop, birdPopDir > 0, ctx.reducedMotion);
    rs.phase = bird.flapPhase;
    rs.amp = bird.flapAmp;
    rs.tuck = bird.tuck;
  }

  /** Cartoon pop: springs in with a little overshoot; shrinks away. Reduced motion: a plain ease. */
  function popScale(p: number, growing: boolean, reduced: boolean): number {
    if (reduced || !growing) return p * p * (3 - 2 * p);
    return 1 - Math.exp(-6.5 * p) * Math.cos(9 * p) * (1 - p);
  }

  return {
    get mode() {
      return mode;
    },
    get rideId() {
      return rideId;
    },
    /** 0 → 1 progress of the current transition (1 = settled). */
    get blend() {
      return blendT >= 1 ? 1 : Math.min(0.9999, ease(blendT));
    },
    get blending() {
      return blendT < 1;
    },
    get hoverId() {
      return hoverId;
    },
    /** Review: the last enter path's height profile. */
    pathDump: () => path.dump(),
    /** Review: the last enter path's point at progress e (planned frame) into out. */
    pathAt: (e: number, o: Vector3) => path.at(e, o),
    /** Review: the last plan's predicted subject position and ride heading. */
    planFrame: { k: planK, up: planKUp, fwd: planFwd, q0: planQ0 },
    PT,
    /** Review: the last enter plan. */
    get plan() {
      return { keepIn, keepOff, eyes: eyDbg.map((x) => +x.toFixed(2)), eyTry: eyTry.map((x) => +x.toFixed(1)), piv: pivDbg.map((x) => +x.toFixed(2)), crowd: dbgCrowd, nearWhy, nearPeaks: nearTrip.peaks.slice(), nearBlocked: nearTrip.blockedAt.slice(), near: nearOn ? { T: nearTrip.T, ta: nearTrip.ta, t0: nearTrip.t0, tm: nearTrip.tm, dphi: nearTrip.dphi / DEG, lift: nearTrip.lift, turn: nearTrip.turn / DEG } : null, dur: blendDur, peakTurn: planPeakTurn / DEG, pivot: planPivot, pivotLift: path.pivotLift, eAim0, eAim, ePop: path.ePop, eQ: path.eQ, eCross: path.eCross, crosses: path.crosses, length: path.length, eff: path.effLength, popUp: path.popUp, drop: path.dropDown, turn: path.turnSum, n: path.n, bulge: path.bulge, low: path.lowRoute, cost: path.dbgCost.map((x) => Math.round(x)), stretch: planStretch, limited: tmap.limited, peak: path.peak };
    },
    /** Review: the last plan's sampled turns (rad), metres and heights, and its time map. */
    planSamples: () => ({ turn: Array.from(smpTurn), len: Array.from(smpLen), h: Array.from(smpH), u: Array.from(tmap.u), rTrip: Array.from(rTripA), rDiff: Array.from(rDiffA) }),
    /** Review: the enter transition's path progress, clock dilation and last-resort lift last frame. */
    dbgStep,
    /** Review: the transition's pose and the new mode's live pose (read-only). */
    dbgPoses: { out, target },
    dbgLaunch,
    /** Review (D1f r4): the nearest facade (m, footprint) taller than world point p, ≤ 20 m; and the idle guide. */
    probeFacade(p: Vector3): number {
      tA.copy(p).normalize();
      if (!ctxRef || !inCity(tA, 20)) return 99;
      const idx = ctxRef.world.cityIndex;
      const h = p.length() - R;
      const px = plan.x;
      const pz = plan.z;
      const n = idx.buildingsNear(px, pz, 20, near);
      let best = 99;
      for (let i = 0; i < n; i++) {
        const b = idx.plan.buildings[near[i]];
        if (PLATEAU_HEIGHT + roofTop(b) < h) continue;
        best = Math.min(best, footprintDistance(b, px, pz));
      }
      return best;
    },
    /** Review (D1f r4): the bird's floors under world point p (m above sea level) and its plan point. */
    probeFloor(p: Vector3) {
      tA.copy(p).normalize();
      if (!ctxRef) return null;
      const soft = softFloor(ctxRef, tA);
      const hard = hardFloor(ctxRef, tA);
      inCity(tA, 0);
      return { soft, hard, x: plan.x, z: plan.z, solid: solidTop(plan.x, plan.z, 0.7, 1.5), h: p.length() - R, plateau: PLATEAU_HEIGHT };
    },
    /** Review (D1f r4): the hold before the drop into someone's eyes (s used, on now). */
    get hold() {
      return { used: holdUsed, on: holdOn };
    },
    /** Review (D1f r4): the live approach's turn with the subject's heading (deg). */
    get livePsi() {
      return livePsi / DEG;
    },
    get guideState() {
      return { guide, on: guideOn, w: guideW, sky: guideSky, run: guideRun };
    },
    /** Review (D1f r6): reduced motion's dip, how dimmed the canvas is now (0 … 1). */
    get dip() {
      return dipNow;
    },
    /** Review: the turn (rad) the uncapped pose made last frame. */
    get wantTurn() {
      return dbgWant;
    },
    rig,
    bird,
    birdCam,
    get birdOn() {
      return birdOn;
    },
    set override(o: BirdOverride | null) {
      birdOverride = o;
    },
    get override(): BirdOverride | null {
      return birdOverride;
    },
    /** The followed thing (ride or bird): position into out, returns its radius (0 if none). */
    subject(out: Vector3): number {
      if (mode === 'ride' && ridden) {
        out.copy(tp.pos);
        return ridden.radius;
      }
      if (mode === 'bird' && birdOn) {
        out.copy(bird.pos);
        return BIRD.span * 0.5;
      }
      return 0;
    },
    ride,
    exitMode,
    fly,
    cycle,
    frameStart,
    frameEnd,
    /** setView: snap back to explore, no transition, nothing ridden. */
    reset(ctx: LBContext) {
      if (mode === 'bird' || birdOn) {
        birdOn = false;
        birdPop = 0;
      }
      release();
      mode = 'explore';
      blendT = 1;
      pathOn = false;
      nearOn = false;
      planStage = 0;
      dipOn = false;
      directOn = false;
      if (dipSet) ctx.canvas.style.opacity = '';
      dipSet = false;
      dipNow = 0;
      fol.valid = false;
      teleported = true;
      turnTail = 0;
      lastRide = null;
      rideFade = 0;
      prevValid = false;
      vel.set(0, 0, 0);
      angRate = 0;
    },
    /** Settle the ride / bird camera at once (deterministic shots). */
    settle(ctx: LBContext) {
      ctxRef = ctx;
      if (mode === 'ride' && ridden && ridden.pose(ctx, tp)) {
        rig.settle(tp, rideEnv, target);
        target.fov = fit(ctx, target.fov);
      } else if (mode === 'bird') {
        birdCam.settle(bird, birdCamEnv, target);
        target.fov = fit(ctx, target.fov);
        birdPop = 1;
      }
      blendT = 1;
      fol.valid = false;
      teleported = true;
      turnTail = 0;
    },
    dispose(ctx: LBContext) {
      disposed = true;
      if (warmState === 1) {
        const cic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
        if (cic) cic(warmHandle);
        else clearTimeout(warmHandle);
      }
      release();
      if (dipSet) ctx.canvas.style.opacity = '';
      dipSet = false;
      dipNow = 0;
      if (cursorSet) ctx.canvas.style.cursor = cursorSet = '';
      const rs = birdRender(ctx);
      rs.show = false;
    },
  };
}

export type Director = ReturnType<typeof createDirector>;
