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
//   enter    a planned path (rides/path.ts) travelled on a clock (rides/blend.ts clockU) through a
//            time map that gives every stretch the time its view turn (≤ TURN_PLAN) and its metres
//            (≤ vMaxAt(h)) need; the gaze, its pitch kept off the vertical, and the roll (a level
//            horizon mid-way) are blended as angles; the clock slows where a target gone astray
//            would turn the view faster than planned. 1.2–3.6 s.
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
import { horizonDistance, latLonFromDir, v3 } from '../world/sphere';
import { hyp } from '../world/hyp';
import { BIRD_CAM, BirdCam } from './bird/cam';
import { BIRD, BirdFlight, type BirdEnv, type BirdInput } from './bird/flight';
import { birdRender } from './bird/shared';
import type { CameraInput } from './input';
import { SOLID, solidsIn } from './landing';
import { lensFov, springStep } from './model';
import { angularVelocity, blendPose, clockPeak, clockU, Coast, copyFramePose, createFramePose, ease, hopFor, LiftProfile, lookPointOf, lookQuat, transitionDuration, TurnFollower, type FramePose } from './rides/blend';
import { clearsPlanet, EnterPath, TimeMap, type PathEnv } from './rides/path';
import { horizonDip } from './rides/rig';
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
const vMaxAt = (h: number) => 2.4 * (Math.max(0, h) + 8);
/** The planned view never turns faster than this (rad/s): the time map gives every turn its time. */
const TURN_PLAN = 120 * DEG;
/** Longest enter transition (s; ×1.4 with reduced motion), before any slowing for a target gone astray. */
const DUR_MAX = 3.6;
/**
 * The look point's horizontal share of the gaze (cos of its pitch) under which the trip's heading
 * stops following its direction (nearly straight below: it would flip as the camera passes over).
 */
const AZ_LO = 0.04;
const AZ_HI = 0.2;
/** The clock's ramp in (s) and ramp out (fraction of the trip). */
const CLOCK_IN = 0.28;
const CLOCK_OUT = 0.42;
/**
 * The drawn camera follows the wanted orientation within these (rad/s, rad/s²): transitions (and
 * just after), the bird. A backstop: the planned turns stay under TURN_PLAN.
 */
const TURN_BLEND = 170 * DEG;
const ACC_BLEND = 1400 * DEG;
const TURN_BIRD = 200 * DEG;
const ACC_BIRD = 1400 * DEG;
/** How long after a transition the follower stays on (s), so a lag it caused is caught up gently. */
const TURN_TAIL = 0.6;
/** After a ride ends, ctx.view.rideFade eases 1 → 0 over this long (s). */
const RIDE_FADE = 1.5;
/** A bird launched from where the camera is starts this far ahead (m) and blends on this long (s). */
const LAUNCH_DIST = 2;
const LAUNCH_BLEND = 0.4;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
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
 * next door, ~1.7 s to the next car, ~2 s over a block, 2.4 s at most; +0.3 s through the cloud
 * layer (the user asked for the falling-through-clouds moment to last); ×1.4 with reduced motion.
 */
export function enterDuration(eff: number, crosses: boolean, reduced: boolean): number {
  const d = Math.min(2.4, Math.max(1.2, 0.85 + 0.45 * Math.log(1 + eff))) + (crosses ? 0.3 : 0);
  return d * (reduced ? 1.4 : 1);
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
  // enter transitions: a planned path (rides/path.ts)
  const path = new EnterPath();
  let pathOn = false;
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
  function solidTop(x: number, z: number, pad: number): number {
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
      if (dx * dx + dz * dz < r * r && S[k + 4] > top) top = S[k + 4];
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
      const roof = idx.maxRoofNear(plan.x, plan.z, 1);
      if (roof > 0) f = Math.max(f, PLATEAU_HEIGHT + roof);
      // Lamp heads, crowns, poles: their real tops, widened by the bird's body.
      const top = solidTop(plan.x, plan.z, 0.7);
      if (top > 0) f = Math.max(f, PLATEAU_HEIGHT + top);
    } else if (ctx.services.nature) {
      vA.x = dir.x;
      vA.y = dir.y;
      vA.z = dir.z;
      if (ctx.services.nature.collide(vA, 2.6, vA)) f = Math.max(f, ctx.world.planet.surfaceAt(dir) + 9.5);
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

  let ctxRef: LBContext | null = null;
  /**
   * The enter path's clearance (rides/path.ts): terrain + 1.2 m, roofs within r + 3.5 m, lamp heads and
   * crowns + 1.2 m, the countryside's crowns.
   */
  const clearEnv: PathEnv = {
    clear: (d, r) => {
      const ctx = ctxRef!;
      let f = ctx.world.planet.surfaceAt(d) + 1.2;
      if (inCity(d, 20)) {
        const idx = ctx.world.cityIndex;
        const roof = r > 0.05 ? idx.maxRoofNear(plan.x, plan.z, r) : idx.roofAt(plan.x, plan.z);
        if (roof > 0) f = Math.max(f, PLATEAU_HEIGHT + roof + 3.5);
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
  };
  const rideEnv: RideEnv = {
    floor: (d) => hardFloor(ctxRef!, d),
    free: (a, b) => free(ctxRef!, a, b),
    wall: (d, h, r, o) => wall(ctxRef!, d, h, r, o),
    reduced: false,
  };
  const birdEnv: BirdEnv = {
    floor: (d) => softFloor(ctxRef!, d),
    hard: (d) => hardFloor(ctxRef!, d),
    wall: (d, h, r, o) => wall(ctxRef!, d, h, r, o),
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
    const nearP = Math.min(30, Math.max(0.05, Math.min(nearWanted, Math.max(0.05, altTerrain * 0.03))));
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
    floorLift = floorLiftVel = 0;
    captureFrom(ctx);
    blendT = 0;
    blendAge = 0;
    blendDur = Math.max(0.05, dur);
    blendLift.hop(0);
  }

  /**
   * Start an enter transition from the camera as it is now to the new mode's pose in `target`
   * (rides/path.ts): the target moves at vT (m/s) meanwhile; the last stretch comes in straight along
   * the new view's axis from ≥ aMin m behind it. Then the timing (refine 2): 1.2–2.4 s by the path's
   * effective length (+0.3 s through the cloud band), stretched (up to DUR_MAX) until the planned view
   * never turns faster than TURN_PLAN nor moves faster than vMaxAt; the clock ramps in over CLOCK_IN s
   * (a click is answered at once) and out over CLOCK_OUT of the trip (×1.4 with reduced motion).
   */
  function beginEnter(ctx: LBContext, vT: Vector3, aMin: number, eyes = false) {
    launching = false;
    enterEyes = eyes;
    floorLift = floorLiftVel = 0;
    captureFrom(ctx);
    blendT = 0;
    blendAge = 0;
    pathOn = true;
    const reduced = ctx.reducedMotion;
    const dist0 = from.pos.distanceTo(target.pos);
    tA.copy(from.pos).normalize();
    tC.copy(target.pos).normalize();
    const ang = Math.acos(Math.max(-1, Math.min(1, tA.dot(tC))));
    let dur = transitionDuration(dist0, ang, reduced) * 1.3;
    // (Moving: planned twice, the second time for when it really gets there.)
    const passes = vT.length() > 1.5 ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      dur = planEnter(ctx, vT, aMin, eyes, dur, ang);
    }
    blendDur = dur;
    clockK = 1;
    planQValid = false;
  }

  /**
   * Plan the enter path to where the target will be in `dur` s (its own motion, ≤ 80 m) and time it;
   * returns the duration.
   */
  function planEnter(ctx: LBContext, vT: Vector3, aMin: number, eyes: boolean, durGuess: number, ang: number): number {
    const reduced = ctx.reducedMotion;
    const dist0 = from.pos.distanceTo(target.pos);
    let dur = durGuess;
    tPlan.copy(vT).multiplyScalar(dur);
    if (tPlan.length() > 80) tPlan.setLength(80);
    tPlan.add(target.pos);
    // The approach: straight in along the new view's axis, from a little behind it (none next door).
    tB.subVectors(target.look, target.pos);
    if (tB.lengthSq() < 1e-8) tB.set(0, 0, -1).applyQuaternion(target.quat);
    tB.normalize();
    let a = dist0 < 8 ? 0 : Math.min(45, Math.max(aMin, dist0 * 0.25));
    if (a > 0) {
      tD.copy(tPlan).addScaledVector(tB, -a);
      const f = free(ctx, tPlan, tD);
      if (f < 1) a = Math.max(Math.min(a, 1.5), a * f - 0.8);
    }
    tD.copy(tPlan).addScaledVector(tB, -a);
    // Into someone's eyes: down over their shoulder at ~45° (their head stays under the frame, and
    // is hidden before the lens reaches it), not into the back of it.
    if (eyes && a > 0) tD.addScaledVector(tE.copy(tPlan).normalize(), a * 1.0);
    // (A hop over the planet only between low ends: a trip up to space is high anyway.)
    const hHigh = Math.max(from.pos.length(), tD.length()) - R;
    farLook(tF).sub(target.pos).add(tPlan);
    // Something up in space behind the planet: the path stays under the clouds until it shows.
    const far = !clearsPlanet(from.pos, tPlan) ? tPlan : null;
    path.plan(from.pos, tD, tPlan, clearEnv, hopFor(ang) * (1 - smoothstep(40, 150, hHigh)), tF, far);
    dur = enterDuration(path.effLength, path.crosses, reduced);
    // The gaze: kept on where it was while the camera pops up out of a street, then swung onto the
    // subject before the approach — and before the cloud band, so what you follow is on screen,
    // over the falling-through-clouds overlay. (Something up in the sky — a plane, a satellite — is
    // looked up at while rising; anything else waits until the camera is up at the roofs, or it
    // would turn to face the facade.) The time map gives the turn the time it needs.
    tB.subVectors(target.look, from.pos).normalize();
    const skyward = tB.dot(tA.copy(from.pos).normalize()) > Math.sin(12 * DEG);
    // (Never later than 0.4 in, and never crammed into less than 0.3 of the way: a big turn squeezed
    // into a short stretch stalled the camera while it panned.)
    eAim0 = skyward ? 0 : Math.max(path.ePop, Math.min(0.4, firstSight(ctx, tF)));
    eAim = Math.max(eAim0 + 0.3, 0.85 * path.eQ);
    if (path.crosses && path.eCross > 0 && path.at(path.eCross, tE) && seen(tE, tPlan)) {
      eAim0 = Math.min(eAim0, Math.max(0, path.eCross - 0.2));
      eAim = Math.min(eAim, Math.max(eAim0 + 0.12, path.eCross));
    }
    // The time map from the planned turns and metres (the target where it is predicted to be).
    sampleTurns();
    const rm = reduced ? 1.4 : 1;
    for (let pass = 0; pass < 2; pass++) {
      clockOut = CLOCK_OUT * dur;
      planStretch = tmap.build(smpTurn, smpLen, smpH, clockPeak(dur, CLOCK_IN * rm, clockOut), TURN_PLAN * (reduced ? 0.8 : 1), vMaxAt);
      if (planStretch <= 1.02 || dur >= DUR_MAX * rm - 1e-3) break;
      dur = Math.min(DUR_MAX * rm, dur * planStretch);
    }
    return dur;
  }

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
    for (let i = 0; i <= N; i++) {
      const e = i / N;
      enterPos(e, 1 - e, tG);
      // The target's look point where it is predicted to be by then (linear in e).
      farLook(tH).addScaledVector(tK.subVectors(tPlan, target.pos), e);
      rollRefTrip = i === 0 ? 0 : rTripA[i - 1];
      rollRefDiff = i === 0 ? 0 : rDiffA[i - 1];
      orientAt(e, tG, from.look, from.quat, tH, target.quat, tI, qS);
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
      } else {
        smpTurn[i] = smpQ.angleTo(qS);
        smpLen[i] = tG.distanceTo(tF);
        smpH[i] = tG.length() - R;
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
    else o.addScaledVector(tK.subVectors(target.pos, tPlan), w);
    return o;
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
  function orientAt(e: number, pos: Vector3, fLook: Vector3, fQuat: Quaternion, tLook: Vector3, tQuat: Quaternion, outLook: Vector3, outQuat: Quaternion) {
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
    oB.subVectors(tLook, pos);
    const dLook = oB.length();
    if (oB.lengthSq() < 1e-8) oB.set(0, 0, -1).applyQuaternion(tQuat);
    oB.normalize();
    oU.copy(pos).normalize();
    const h = pos.length() - R;
    const occl = !clearsPlanet(pos, tLook);
    if (occl) {
      // Behind the planet: on the horizon in its direction (where it will rise).
      const dip = horizonDip(h);
      oC.copy(oB).addScaledVector(oU, -oB.dot(oU));
      if (oC.lengthSq() > 1e-8) oB.copy(oC.normalize()).multiplyScalar(Math.cos(dip)).addScaledVector(oU, -Math.sin(dip));
    }
    slerpDir(oA, oB, wA, pos, oG);
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
    // planet's limb in the lower frame, not a black sky.
    const pMax = -horizonDip(h) + 16 * DEG;
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
    outLook.copy(pos).addScaledVector(oG, Math.max(1, dLook));
    // Orientation: from the start's own (swung the least onto the gaze) to the trip's own frame as
    // the gaze leaves the start, onto the end's own over the last stretch. The trip's frame keeps
    // the horizon level, or — looking steeply down, where "level" is undefined — the way the trip
    // heads at the top of the frame (which agrees with the gaze's own heading wherever that exists).
    // All three look along the gaze and differ only by a roll about it: the rolls are blended as
    // angles, kept continuous against the plan (a quaternion slerp between frames half a turn apart
    // took the short way round one frame and the other way the next: a flip).
    oC.set(0, 0, -1).applyQuaternion(fQuat);
    outQuat.setFromUnitVectors(oC, oG).multiply(fQuat);
    // (The heading only tips the balance within a few degrees of straight down, where "level" alone
    // is undefined; anywhere else the level frame rules.)
    oT.copy(oU).addScaledVector(oAz, 0.04);
    lookQuat(oG, oT, 0, oQ1);
    oC.set(0, 0, -1).applyQuaternion(tQuat);
    oQ2.setFromUnitVectors(oC, oG).multiply(tQuat);
    oC.set(0, 1, 0).applyQuaternion(outQuat); // the start's up
    oV.set(0, 1, 0).applyQuaternion(oQ1); // the trip frame's up
    let rTrip = Math.atan2(oT.crossVectors(oC, oV).dot(oG), oC.dot(oV));
    oC.copy(oV);
    oV.set(0, 1, 0).applyQuaternion(oQ2); // the end's up, from the trip frame's
    let rDiff = Math.atan2(oT.crossVectors(oC, oV).dot(oG), oC.dot(oV));
    rTrip += Math.round((rollRefTrip - rTrip) / (2 * Math.PI)) * 2 * Math.PI;
    rDiff += Math.round((rollRefDiff - rDiff) / (2 * Math.PI)) * 2 * Math.PI;
    lastRollTrip = rTrip;
    lastRollDiff = rDiff;
    const wS = smoothstep(0, 0.3, e);
    const wE = smoothstep(0.72, 1, e);
    // (rEnd = rTrip + rDiff; blended: rTrip·wS → rEnd by wE.)
    const roll = rTrip * wS + (rTrip + rDiff - rTrip * wS) * wE;
    if (Math.abs(roll) > 1e-7) {
      oQ1.setFromAxisAngle(oG, roll);
      outQuat.premultiply(oQ1);
    }
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

  /** The enter transition's pose at path progress e into out (from: the coasting start). */
  function enterPose(e: number) {
    coast.at(blendAge, from);
    enterPos(e, -1, out.pos);
    // The start's own motion: carried on at first. (The coast bleeds it off; its offset fades.)
    out.pos.addScaledVector(tA.subVectors(from.pos, coast.p0), 1 - ease(e / 0.45));
    planRefs(e);
    orientAt(e, out.pos, from.look, from.quat, farLook(tL), target.quat, out.look, out.quat);
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
    return tmap.eAt(clockU(bt * blendDur, blendDur, CLOCK_IN * (ctx.reducedMotion ? 1.4 : 1), clockOut));
  }

  /**
   * Advance the enter transition's clock by dt (dilated) and pose it into out; returns e. The plan
   * keeps the view's turns under TURN_PLAN for the target where it was predicted to go; a target that
   * goes elsewhere (a car turning a corner) is followed live, so where that would turn the view faster,
   * the clock slows (quickly, and recovers gently: never a step in speed) instead of whipping round.
   */
  function stepEnter(ctx: LBContext, dt: number): number {
    if (!(dt > 0)) {
      const e = eOfClock(blendT, ctx);
      enterPose(e);
      return e;
    }
    const lim = TURN_PLAN * 1.25 * dt * (ctx.reducedMotion ? 0.8 : 1);
    // (At most half speed, and never more than ~1.4× the planned length in all: the target keeps
    // moving meanwhile.)
    const kMin = 0.5 + 0.5 * smoothstep(1.15 * blendDur, 1.4 * blendDur, blendAge);
    let k = 1;
    let e = 0;
    for (let it = 0; it < 4; it++) {
      e = eOfClock(Math.min(1, blendT + (dt * k) / blendDur), ctx);
      enterPose(e);
      if (!planQValid) break;
      const a = planQ.angleTo(out.quat);
      if (a <= lim || k <= kMin) break;
      k = Math.max(kMin, k * (lim / a) * 0.9);
    }
    const kNew = clockK + Math.max(-6 * dt, Math.min(2 * dt, k - clockK));
    clockK = kNew;
    blendT = Math.min(1, blendT + (dt * clockK) / blendDur);
    e = eOfClock(blendT, ctx);
    enterPose(e);
    planQ.copy(out.quat);
    planQValid = true;
    return e;
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
    rig.begin(t.view, t.radius, tp, rideEnv, target);
    if (!instant) {
      // Framed at first from the side the camera comes from (it swings round behind once there):
      // no half-turn of the whole view on the way down.
      rig.entryYaw = entryYawFor(ctx, tp, t.view === 'eyes' ? 95 * DEG : t.view === 'alongside' ? 120 * DEG : 75 * DEG, t.view === 'chase' ? 0 : rig.framing.yaw);
      rig.holdEntry = true;
      rig.settle(tp, rideEnv, target);
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
   * The angle (rad, counter-clockwise about the local up, clamped to ±max) from a trackable's travel
   * to the heading the camera looks along now, at the trackable (straight down: the camera's up).
   */
  function entryYawFor(ctx: LBContext, p: TrackPose, max: number, offset = 0): number {
    tA.copy(p.pos).normalize();
    tB.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    tB.addScaledVector(tA, -tB.dot(tA));
    if (tB.lengthSq() < 0.04) {
      tB.set(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
      tB.addScaledVector(tA, -tB.dot(tA));
    }
    // The way the camera will come in (from where it is to the target, along the ground) counts
    // most once it is more than a few metres off to the side: the ride is framed along it, so the
    // trip never loops round the target, nor passes over the point it will look at.
    tE.subVectors(p.pos, ctx.camera.position).addScaledVector(tA, -tE.dot(tA));
    const hd = tE.length();
    if (hd > 1e-3 && tB.lengthSq() > 1e-8) tB.normalize().multiplyScalar(0.35).addScaledVector(tE, smoothstep(4, 20, hd) / hd);
    tC.copy(p.fwd).addScaledVector(tA, -p.fwd.dot(tA));
    if (tB.lengthSq() < 1e-8 || tC.lengthSq() < 1e-8) return 0;
    tB.normalize();
    tC.normalize();
    tD.crossVectors(tC, tB);
    let a = Math.atan2(tD.dot(tA), tC.dot(tB)) - offset;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    return Math.max(-max, Math.min(max, a));
  }

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
      bird.reset(tD, tC, launch ? BIRD.min + 1.5 : BIRD.cruise);
      // Near the ground: a take-off, nose up (it flaps on its own while slow and climbing).
      if (hb - fl < 8) bird.gamma = 14 * DEG;
      birdPop = 0;
    }
    birdOn = true;
    birdAway = 0;
    birdPopDir = 1;
    joyX = joyY = 0;
    birdCam.logDistT = Math.log(launch ? LAUNCH_DIST : BIRD_CAM.dist);
    birdCam.settle(bird, rideEnv, target, !launch);
    birdCam.logDistT = Math.log(BIRD_CAM.dist);
    launching = launch && !instant;
    target.fov = fit(ctx, target.fov);
    stopPush = 0;
    stopArmed = false;
    if (instant) {
      birdCam.settle(bird, rideEnv, target);
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
      // A click (not a drag) on anything that moves rides it (explore or another ride).
      if (inp.click && mode !== 'bird' && !inp.doubleClick) {
        const hit = ctx.services.track?.pick(inp.clickAt.x, inp.clickAt.y);
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
    else if (inp.doubleClick && !ctx.services.track?.pick(inp.doubleAt.x, inp.doubleAt.y)) exitMode(ctx);
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

  /** ≤ 10 Hz: what is under the cursor (pointer cursor, the UI's hover label). */
  function hover(ctx: LBContext, inp: CameraInput, dt: number) {
    hoverT -= dt;
    const canPick = mode !== 'bird' && inp.hover && !inp.dragging && !inp.locked && !inp.pinching;
    if (!canPick) {
      if (hoverId !== null) hoverId = null;
      if (cursorSet && !inp.dragging) ctx.canvas.style.cursor = cursorSet = '';
      return;
    }
    if (hoverT > 0) return;
    hoverT = HOVER_DT;
    const hit = ctx.services.track?.pick(inp.cursor.x, inp.cursor.y) ?? null;
    hoverId = hit && hit.id !== rideId ? hit.id : null;
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
    if (mode === 'ride') {
      rig.holdEntry = blendT < 1;
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
      if (dt > 0) birdCam.update(dt, bird, rideEnv, target);
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
      if (pathOn) e = stepEnter(ctx, dt);
      else {
        blendT = Math.min(1, blendT + dt / blendDur);
        e = ease(blendT);
        // Back to explore: the coasting snapshot eases onto explore's own pose.
        coast.at(blendAge, from);
        // (A launch looks at the bird from the first frame: the follower eases the turn.)
        blendPose(from, target, e, blendLift, out, launching ? 1 : ease(Math.min(1, blendT * 1.2)));
      }
      // Last resort (the target moved far off what was planned): never through a roof or the
      // ground on the way — seen a moment ahead and risen to through a spring, so a roof edge is
      // climbed, not jumped; it fades out with the blend so the landing is exact.
      tA.copy(out.pos).normalize();
      let need = hardFloor(ctx, tA) + 0.5 - (out.pos.length() - R);
      if (pathOn && dt > 0 && blendT < 1) {
        enterPos(eOfClock(Math.min(1, blendT + 0.15 / blendDur), ctx), -1, tB);
        tB.normalize();
        need = Math.max(need, hardFloor(ctx, tB) + 0.5 - (out.pos.length() - R));
      }
      need *= 1 - e * e;
      if (dt > 0) {
        springStep(floorLift, floorLiftVel, Math.max(0, need), need > floorLift ? 14 : 5, dt, spT);
        floorLift = Math.max(0, spT[0]);
        floorLiftVel = spT[1];
        if (floorLift < need - 0.4) floorLift = need - 0.4;
      }
      if (floorLift > 0) out.pos.addScaledVector(tA, floorLift);
      dbgStep.e = e;
      dbgStep.k = clockK;
      dbgStep.need = floorLift;
      if (blendT >= 1) turnTail = TURN_TAIL;
      tailOver = 0;
      present(ctx, follow(out, dt, TURN_BLEND, ACC_BLEND), Math.min(nearW, Math.max(0.05, (out.pos.length() - R) * 0.03)), mode === 'explore');
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

  /** The bird: steered in bird mode, on autopilot once let go; its render state for the bird system. */
  function stepBird(ctx: LBContext, dt: number) {
    const rs = birdRender(ctx);
    if (!birdOn) {
      rs.show = false;
      rs.scale = 0;
      return;
    }
    if (mode === 'bird') {
      const src = birdOverride ?? birdIn;
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
      return ease(blendT);
    },
    get blending() {
      return blendT < 1;
    },
    get hoverId() {
      return hoverId;
    },
    /** Review: the last enter path's height profile. */
    pathDump: () => path.dump(),
    /** Review: the last enter plan. */
    get plan() {
      return { dur: blendDur, eAim0, eAim, ePop: path.ePop, eQ: path.eQ, eCross: path.eCross, crosses: path.crosses, length: path.length, eff: path.effLength, popUp: path.popUp, drop: path.dropDown, turn: path.turnSum, n: path.n, bulge: path.bulge, low: path.lowRoute, stretch: planStretch, limited: tmap.limited, peak: path.peak };
    },
    /** Review: the last plan's sampled turns (rad), metres and heights, and its time map. */
    planSamples: () => ({ turn: Array.from(smpTurn), len: Array.from(smpLen), h: Array.from(smpH), u: Array.from(tmap.u), rTrip: Array.from(rTripA), rDiff: Array.from(rDiffA) }),
    /** Review: the enter transition's path progress, clock dilation and last-resort lift last frame. */
    dbgStep,
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
    reset() {
      if (mode === 'bird' || birdOn) {
        birdOn = false;
        birdPop = 0;
      }
      release();
      mode = 'explore';
      blendT = 1;
      pathOn = false;
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
        birdCam.settle(bird, rideEnv, target);
        target.fov = fit(ctx, target.fov);
        birdPop = 1;
      }
      blendT = 1;
      fol.valid = false;
      teleported = true;
      turnTail = 0;
    },
    dispose(ctx: LBContext) {
      release();
      if (cursorSet) ctx.canvas.style.cursor = cursorSet = '';
      const rs = birdRender(ctx);
      rs.show = false;
    },
  };
}

export type Director = ReturnType<typeof createDirector>;
