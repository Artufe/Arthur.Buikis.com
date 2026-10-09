// The camera system (BRIEF §4): drives camera/model.ts from input, owns ctx.view and the camera
// service (setView / flyTo). Stage 1, and first in systems.ts, so ctx.view is fresh for every
// other system's update.
//
// Feel, in one place:
//   - Zoom: wheel / pinch / Q-E / ± move a log-altitude target; a critically damped spring follows
//     it. The world point under the cursor is locked per gesture and held under it (map-style,
//     holdAnchor) down to ~24 m, letting go smoothly by 13 m.
//   - Drag: grab-spin (the grabbed point stays under the cursor, inertia on release) blending into
//     look-around near the ground. Off the planet's disc the grab slides onto the limb, so a drag
//     that starts in space still spins.
//   - Moving (keys, the touch stick): velocities ease in and out (no snap starts or stops); walking
//     slides along walls (CityIndex.collide) and never steps into the sea; ← → turn at street level.
//   - Roofs: the eye rises only over a roof under it (or within ~1 m), and ahead of a pan, through a
//     spring, so a tower passing underneath swells the camera up instead of jolting it; a facade
//     beside a low flight pushes the focus out toward the street instead (keepOffWalls), and a
//     zoom aimed at a tall building aims at its foot. No elevator rides.
//   - Landing: a zoom headed for the street picks a pavement spot (camera/landing.ts) facing what
//     the cursor aimed at, whose glide in clears every pole, lamp head, crown and wall, and glides
//     onto it (speed-capped, never a jolt), turning to look down the street. Fly-to does the same.
//     Over open water the floor is a seagull's 6 m, not eye height. Outside the city the camera
//     keeps out of A1's trunks and boulders.
//   - The lens: FOV by altitude fitted to the canvas aspect, plus a vertical lens shift at rooftop
//     heights (verticals stay upright: a model, not a fisheye).
//   - Pointer lock (page variant): a mouse click at street level takes it; lifting off releases it.
//
// v2 (D1): camera/director.ts layers the modes on top — rides (chase / eyes / alongside a
// Trackable), the bird, click-to-follow and hover picking, and the transitions between them. In
// explore it only watches; everything above runs exactly as in v1. Leaving a mode hands this model a
// placement that matches the camera (handoff), so explore carries on from wherever it is.

import { Matrix4, Vector3 } from 'three';
import type { LBContext, System, ViewSpec } from '../core/contracts';
import { ALT_MAX, CITY_PLAN_RADIUS, EYE_HEIGHT, PLATEAU_HEIGHT, R } from '../world/config';
import { fromSphere, planHeadingToWorld, planToDir, worldHeadingToPlan } from '../world/city/frame';
import {
  angleBetween,
  copy3,
  cross3,
  dirFromLatLon,
  dot3,
  headingVector,
  horizonDistance,
  latLonFromDir,
  normalize3,
  orthonormalizeTangent,
  raySphere,
  rotateAxis,
  slerpDir,
  v3,
  type Vec3,
} from '../world/sphere';
import { buildingDistance, glideMargin, solidsIn, LandingFinder, type Landing } from './landing';
import { CameraInput } from './input';
import { approach, clipPlanes, computePose, createCamState, createPose, lensFov, lensShift, orbitFitFov, liftRamp, lookBlend, moveSpeed, pitchForAlt, springStep, timeToBox } from './model';
import { createDirector } from './director';
import { hyp, hyp3 } from '../world/hyp';

const DEG = Math.PI / 180;
const LOG_MIN = Math.log(EYE_HEIGHT);
const LOG_MAX = Math.log(ALT_MAX);
const GRAVITY = 4.2; // tiny planet: jumps float
const JUMP_V = 3.4;
const BODY_R = 0.35;
/** Lowest zoom altitude over open water (m). */
const SEA_FLOOR_ALT = 6;
const LOG_SEA = Math.log(SEA_FLOOR_ALT);
/**
 * A zoom target below this (log of 10 m) is heading for the street: once the eye is below 28 m the
 * touchdown resolver starts gliding toward a pavement spot. Zooming back out past 12 m cancels it.
 */
const LOG_LAND = Math.log(10);
const LOG_UNLAND = Math.log(12);
/** Roof lift look-ahead horizon (s) and the climb rate it plans for (m/s). */
const LIFT_LOOKAHEAD = 1.6;
const CLIMB = 12;
/** Keyboard turn rate at street level (rad/s). */
const TURN_RATE = 1.7;
/** Body radius against the countryside's trunks and boulders (a little wider than the city's: trunks are fat). */
const NATURE_R = 0.55;
/** A pedestrian pushes the FPV body back by at most the step plus this (m). */
const PEOPLE_PUSH = 0.05;
/** The zoom anchor holds fully above ANCHOR_HI m and lets go by ANCHOR_LO m (smoothly in between). */
const ANCHOR_HI = 24;
const ANCHOR_LO = 13;
/** A wheel / pinch whose cursor moved more than this (CSS px) from where the anchor was picked re-picks it. */
const ANCHOR_REPICK_PX = 8;
/**
 * The landing glide is done at one of these fractions of the log-altitude it has to lose (tried in
 * order, the first whose glide is clear wins): a long diagonal glide, or one that crosses over high
 * and settles straight down onto the spot under the street canopy (lamp heads, crowns).
 */
const LAND_SHAPES = [0.75, 0.5, 0.32];
const FLY_SHAPES = [1];
/** Glide samples for the landing clearance test. */
const GLIDE_N = 48;
/**
 * The sea steer: a zoom heading below STEER_ALT over open sea (no land within STEER_CLEAR m) flies
 * on to the nearest land, or the city when it is nearly as close, instead of bottoming out in a
 * hover over flat blue (two thirds of the planet is water, so "spin, then scroll" mostly ended
 * there). Once per descent: re-armed when the zoom heads back above STEER_REARM.
 */
const LOG_STEER = Math.log(160);
const LOG_STEER_REARM = Math.log(260);
const STEER_CLEAR = 30;
/** The zoom may lower a steer flight's end altitude to this (m); further zoom carries on after it. */
const LOG_STEER_FLOOR = Math.log(14);

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export function createCameraSystem(): System {
  const s = createCamState();
  const pose = createPose();
  const spring = new Float64Array(2);
  const clip = { near: 0.1, far: 1000 };
  const ll = { lat: 0, lon: 0 };
  const plan = { x: 0, z: 0 };
  const planOut = { x: 0, z: 0 };
  const near: number[] = [];
  // scratch
  const tA = v3();
  const tB = v3();
  const axis = v3();
  const grab = v3();
  let hasGrab = false;
  let grabRadius = 0; // the grab sphere stays fixed for the whole drag
  const inertiaAxis = v3();
  let inertiaRate = 0; // rad/s
  // The zoom anchor (map-style zoom): the world point under the cursor, locked once per gesture
  // (re-picked only when the cursor moves), held under the cursor pixel (anchorPx) each frame.
  const anchor = v3();
  let anchorOn = false;
  let anchorR = 0; // its sphere's height above sea level
  let anchorK = 0; // how much it held this frame (0…1)
  const anchorPx = { x: 0, y: 0 };
  const lockPx = { x: 0, y: 0 };
  /** The last anchor held at full weight: the landing turns to face it. */
  const aim = v3();
  let aimOn = false;
  /** Log-altitude change of the current frame (before the anchor runs). */
  let frameDLog = 0;
  // fly-to
  let flyT = -1;
  let flyDur = 1.4;
  const flyFrom = v3();
  const flyTo = v3();
  let flyLogFrom = 0;
  let flyLogTo = 0;
  let lastLogAlt = s.logAlt;
  let lastNear = -1;
  let lastFar = -1;
  let lastFov = -1;
  let lastShift = -1;
  let lastAspect = -1;
  /** The vertical FOV actually used (the altitude FOV fitted to the canvas aspect), deg. */
  let lensV = 60;
  let input: CameraInput | null = null;
  const m4 = new Matrix4();
  const vx = new Vector3();
  const vy = new Vector3();
  const vz = new Vector3();
  const rayO = v3();
  const rayD = v3();
  const ndc = new Vector3();
  let interacted = false;
  // Smoothed movement (m/s, relative to the view heading: forward, right) and turn rate (rad/s).
  let velF = 0;
  let velR = 0;
  let yawVel = 0;
  // Plan-space velocity of the focus (m/s, smoothed): the roof lift looks ahead along it.
  let pvx = 0;
  let pvz = 0;
  // Plan position of the focus at the end of the last frame (also the landing glide's starting velocity).
  let prevPX = NaN;
  let prevPZ = NaN;
  // The touchdown resolver (resolveLanding): a descent toward the street glides the focus and the
  // heading from where it was (from*) to the chosen pavement spot (land*), progress tied to the
  // log-altitude lost since it started (landLog0).
  let finder: LandingFinder | null = null;
  let landOn = false;
  /** No (new) landing until the zoom heads back up: the user steered, or the descent already landed. */
  let landDone = false;
  /** No pavement to land on (open country): the zoom goes where it goes, the anchor keeps holding. */
  let landNone = false;
  /** The user dragged during the glide: the heading is theirs now (the position glide carries on). */
  let landFreeHeading = false;
  let landX = 0;
  let landZ = 0;
  let landHeading = 0;
  let fromX = 0;
  let fromZ = 0;
  let fromHeading = 0;
  let landLog0 = 0;
  /** Hermite start tangent of the glide (plan m per unit of glide progress): the focus's velocity when it began. */
  let landMX = 0;
  let landMZ = 0;
  /** keepOffWalls' push during a landing glide (plan m), added on top of the planned path. */
  let offX = 0;
  let offZ = 0;
  /** Glide progress and planned position on the last frame (the lateral speed cap). */
  let landP = 0;
  let landV = 0; // its lateral speed (m/s)
  const landPos = { x: 0, z: 0 };
  const glideTmp = { x: 0, z: 0 };
  // Glide sample scratch (the landing clearance test).
  const gx = new Float64Array(GLIDE_N + 1);
  const gz = new Float64Array(GLIDE_N + 1);
  const gh = new Float64Array(GLIDE_N + 1);
  const wallOut = { x: 0, z: 0 };
  /** Dev introspection of the last landing choice (player tests). */
  const landInfo = { n: 0, aimX: NaN, aimZ: NaN, margins: [] as number[], ms: 0 };
  // Fly-to into the street: the heading glides with the flight.
  let flyTurn = false;
  let flyHeadFrom = 0;
  let flyHeadTo = 0;
  /** The current fly-to is a sea steer (zooming adjusts its altitude instead of cancelling it). */
  let steer = false;
  let steerDone = false;
  /** Land directions for the sea steer (unit xyz; meadow-height land on a ~10 m lattice), built on first use. */
  let landDirs: Float32Array | null = null;
  const stickView = { visible: false, active: false, x: 0, y: 0, ox: 0, oy: 0, touch: false };
  /** Seconds since a mode handed the camera back with a held pitch (it then eases to the curve), or −1. */
  let exitRelease = -1;
  const director = createDirector({
    handoff: (ctx, pos, fwd, camUp) => handoff(ctx, pos, fwd, camUp),
    invalidate: () => {
      lastNear = lastFar = lastFov = lastShift = lastAspect = -1;
    },
    groundAt: (ctx, dir) => groundAt(ctx, dir),
    solids: () => finder?.solids ?? null,
  });

  /**
   * The altitude reference (m above sea level) under unit dir: terrain or water, and inside the city
   * its walking surface (road, curb, lawn). Roofs are NOT part of it — they only push the eye up
   * through `lift` — so zoom altitude never pumps when a tower passes under the camera.
   */
  function groundAt(ctx: LBContext, dir: Vec3): number {
    fromSphere(dir, plan);
    if (plan.x * plan.x + plan.z * plan.z < CITY_PLAN_RADIUS * CITY_PLAN_RADIUS) return PLATEAU_HEIGHT + ctx.world.cityIndex.groundH(plan.x, plan.z);
    return ctx.world.planet.surfaceAt(dir);
  }

  /** Roof top (m above sea level) of the building directly under unit dir, or −∞. */
  function roofUnder(ctx: LBContext, dir: Vec3): number {
    fromSphere(dir, plan);
    if (plan.x * plan.x + plan.z * plan.z >= (CITY_PLAN_RADIUS + 20) ** 2) return -Infinity;
    const roof = ctx.world.cityIndex.roofAt(plan.x, plan.z);
    return roof > 0 ? PLATEAU_HEIGHT + roof : -Infinity;
  }

  /**
   * Extra eye height that clears roofs at zoom altitude `alt` (m, ≥ 0). Each building near the
   * focus (or near where it is heading, 0.45 s ahead) asks for `roof + min(2.5, alt) − eye`; the ask
   * is scaled by liftRamp(distance to its footprint), which is 1 within a margin and falls to 0
   * over a width that grows with altitude. Below 7 m (walking height, where collisions apply) only
   * the building directly underneath counts, so walking past a wall never lifts you. Faded out between 40 and 80 m, where nothing is tall
   * enough to matter.
   */
  function liftTargetAt(ctx: LBContext, alt: number): number {
    const fade = 1 - smooth01((alt - 40) / 40);
    if (fade <= 0) return 0;
    fromSphere(s.focus, plan);
    const px = plan.x;
    const pz = plan.z;
    if (px * px + pz * pz >= (CITY_PLAN_RADIUS + 30) ** 2) return 0;
    const base = s.ground + alt;
    const clear = Math.min(2.5, alt);
    const idx = ctx.world.cityIndex;
    if (alt < 7) {
      // Walking height: collisions keep the body out of buildings; only a roof directly underneath counts.
      const roof = idx.roofAt(px, pz);
      return roof > 0 ? Math.max(0, PLATEAU_HEIGHT + roof + clear - base) * fade : 0;
    }
    // Beside you: only a roof under the eye or within ~1 m of it lifts it (keepOffWalls pushes the
    // focus away from a facade instead), so a tower beside a descent never turns it into an
    // elevator ride. Ahead of you (along the focus's plan velocity): the ask starts early enough that
    // the climb never exceeds ~CLIMB m/s, so a tower swells the camera up instead of jolting it.
    const margin = Math.min(0.6, (alt - 7) * 0.3);
    const width = Math.min(1.2, 0.3 + (alt - 7) * 0.06);
    const sp = hyp(pvx, pvz);
    // Only panning (keys, stick, a thrown spin) looks ahead; a zoom anchor or a landing glide aims
    // beside buildings by construction, and keepOffWalls holds it off their walls.
    const panning = Math.abs(velF) + Math.abs(velR) > 0.2 || inertiaRate !== 0;
    const moving = panning && !landOn && sp > 0.3 && Number.isFinite(sp);
    const reach = moving ? Math.min(60, sp * LIFT_LOOKAHEAD) : 0;
    const qx = moving ? px + (pvx / sp) * reach * 0.5 : px;
    const qz = moving ? pz + (pvz / sp) * reach * 0.5 : pz;
    const n = idx.buildingsNear(qx, qz, reach * 0.5 + margin + width, near);
    let best = 0;
    for (let i = 0; i < n; i++) {
      const b = idx.plan.buildings[near[i]];
      const need = PLATEAU_HEIGHT + b.h + clear - base;
      if (need <= best) continue;
      let wgt = liftRamp(buildingDistance(b, px, pz), margin, width);
      if (moving && wgt < 1) {
        const tHit = timeToBox(px, pz, pvx, pvz, b.x, b.z, b.angle, b.w / 2 + margin, b.d / 2 + margin);
        const lead = Math.min(LIFT_LOOKAHEAD, 0.45 + need / CLIMB); // + the spring's lag
        if (tHit < lead) wgt = Math.max(wgt, 1 - smooth01(tHit / lead));
      }
      const v = need * wgt;
      if (v > best) best = v;
    }
    return best * fade;
  }

  /** Hard floors: the eye stays ≥ 0.8 m above the terrain/water and above the roof directly under it. */
  function floors(ctx: LBContext, alt: number) {
    const terrain = ctx.world.planet.surfaceAt(s.focus);
    if (s.ground + alt < terrain + 0.8) s.ground = terrain + 0.8 - alt;
    const roof = roofUnder(ctx, s.focus);
    if (s.ground + s.lift + alt < roof + 0.8) s.lift = roof + 0.8 - s.ground - alt;
  }

  /** World ray through a canvas pixel (CSS px), from the camera's current matrices. */
  function screenRay(ctx: LBContext, px: number, py: number, w: number, h: number): void {
    const cam = ctx.camera;
    ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1, 0.5).unproject(cam);
    copy3(rayO, cam.position);
    rayD.x = ndc.x - cam.position.x;
    rayD.y = ndc.y - cam.position.y;
    rayD.z = ndc.z - cam.position.z;
    normalize3(rayD);
  }

  /**
   * Unit dir where the ray through (px, py) meets the planet: a sphere at the terrain/water height
   * under the camera (roofs ignored, so the grabbed point stays under the cursor over towers), or
   * at `radius` above sea level when given. On a miss: false, unless `limb` — then the ray's closest
   * approach to the centre (a point on the visible limb), so a grab that starts in space still spins.
   */
  function pick(ctx: LBContext, px: number, py: number, w: number, h: number, out: Vec3, radius = pickRadius(ctx), limb = false): boolean {
    screenRay(ctx, px, py, w, h);
    let t = raySphere(rayO, rayD, R + radius);
    if (t < 0) {
      if (!limb) return false;
      t = Math.max(0, -dot3(rayO, rayD));
    }
    out.x = rayO.x + rayD.x * t;
    out.y = rayO.y + rayD.y * t;
    out.z = rayO.z + rayD.z * t;
    normalize3(out);
    return true;
  }

  /** Rotate the whole camera state (focus and heading) about a world axis through the centre. */
  function rotateState(ax: Vec3, angle: number) {
    if (Math.abs(angle) < 1e-12) return;
    rotateAxis(s.focus, s.focus, ax, angle);
    normalize3(s.focus);
    rotateAxis(s.fwd, s.fwd, ax, angle);
    orthonormalizeTangent(s.fwd, s.focus);
  }

  /** Rotation taking unit a to unit b: writes the axis, returns the angle. */
  function arc(a: Vec3, b: Vec3, outAxis: Vec3): number {
    cross3(outAxis, a, b);
    const l = hyp3(outAxis.x, outAxis.y, outAxis.z);
    if (l < 1e-12) return 0;
    outAxis.x /= l;
    outAxis.y /= l;
    outAxis.z /= l;
    return Math.atan2(l, dot3(a, b));
  }

  /** Move the focus to plan point (x, z), carrying the heading. */
  function moveFocusToPlan(x: number, z: number) {
    planToDir(x, z, tB);
    const a = arc(s.focus, tB, axis);
    rotateState(axis, a);
  }

  function pickRadius(ctx: LBContext): number {
    return Math.max(0, ctx.world.planet.surfaceAt(s.focus));
  }

  function overSea(ctx: LBContext, dir: Vec3): boolean {
    return ctx.world.planet.heightAt(dir) < -0.3;
  }

  /** Lowest log-altitude allowed at the focus: eye height on land, a hover over open water. */
  function minLog(ctx: LBContext): number {
    return overSea(ctx, s.focus) ? LOG_SEA : LOG_MIN;
  }

  function snap(ctx: LBContext) {
    const alt = Math.exp(s.logAlt);
    s.ground = groundAt(ctx, s.focus);
    s.groundVel = 0;
    s.lift = liftTargetAt(ctx, alt);
    s.liftVel = 0;
    floors(ctx, alt);
  }

  function setView(ctx: LBContext, v: ViewSpec, glide?: number) {
    director.reset(ctx);
    exitRelease = -1;
    dirFromLatLon(v.lat, v.lon, s.focus);
    headingVector(s.focus, (v.heading ?? 0) * DEG, s.fwd);
    const alt = Math.min(ALT_MAX, Math.max(EYE_HEIGHT, v.alt));
    s.logAlt = s.logAltTarget = lastLogAlt = Math.log(alt);
    s.logAltVel = 0;
    s.lookPitch = 0;
    s.lookYaw = 0;
    s.pitchOverride = v.pitch === undefined ? NaN : v.pitch * DEG;
    s.overrideWeight = v.pitch === undefined ? 0 : 1;
    s.jump = 0;
    s.jumpVel = 0;
    flyT = -1;
    inertiaRate = 0;
    anchorOn = false;
    aimOn = false;
    hasGrab = false;
    interacted = false;
    velF = velR = yawVel = 0;
    landOn = false;
    landDone = false;
    landNone = false;
    pendingLand = null;
    flyTurn = false;
    steer = false;
    steerDone = false;
    if (glide !== undefined && glide > 0) {
      trackPlanVelocity(glide);
      stepReference(ctx, alt, glide);
    } else {
      prevPX = NaN;
      pvx = pvz = 0;
      snap(ctx);
    }
    apply(ctx);
  }

  /**
   * v2: hand the explore model over to a camera at `pos` looking along unit `fwd` (camera up
   * `camUp`), so explore carries on from there without a jump (the director blends the roll and
   * the lens across). Focus under the eye, zoom altitude = its height above the ground reference
   * (less any roof lift, so the eye stays put), heading from the view, and the pitch held: at street
   * level as the look offset, above it as a pitch override that eases back to the altitude curve
   * once the hand-over has settled (exitRelease). Every explore spring and gesture is reset.
   */
  function handoff(ctx: LBContext, pos: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }, camUp: { x: number; y: number; z: number }) {
    const len = hyp3(pos.x, pos.y, pos.z);
    if (!(len > 1e-6)) return;
    s.focus.x = pos.x / len;
    s.focus.y = pos.y / len;
    s.focus.z = pos.z / len;
    const sinP = Math.max(-1, Math.min(1, dot3(fwd as Vec3, s.focus)));
    tA.x = fwd.x - s.focus.x * sinP;
    tA.y = fwd.y - s.focus.y * sinP;
    tA.z = fwd.z - s.focus.z * sinP;
    if (tA.x * tA.x + tA.y * tA.y + tA.z * tA.z < 1e-4) {
      // Looking straight down: the camera's up is the heading.
      const u = dot3(camUp as Vec3, s.focus);
      tA.x = camUp.x - s.focus.x * u;
      tA.y = camUp.y - s.focus.y * u;
      tA.z = camUp.z - s.focus.z * u;
    }
    copy3(s.fwd, tA);
    orthonormalizeTangent(s.fwd, s.focus);
    const pitch = Math.asin(sinP);
    const altSea = len - R;
    s.ground = groundAt(ctx, s.focus);
    s.groundVel = 0;
    s.lift = 0;
    s.liftVel = 0;
    const lo = overSea(ctx, s.focus) ? SEA_FLOOR_ALT : EYE_HEIGHT;
    let alt = Math.min(ALT_MAX, Math.max(lo, altSea - s.ground));
    // A roof under the eye: the lift carries part of the height (twice, it depends on alt).
    for (let i = 0; i < 2; i++) {
      s.lift = liftTargetAt(ctx, alt);
      alt = Math.min(ALT_MAX, Math.max(lo, altSea - s.ground - s.lift));
    }
    s.logAlt = s.logAltTarget = lastLogAlt = Math.log(alt);
    s.logAltVel = 0;
    s.jump = 0;
    s.jumpVel = 0;
    s.lookYaw = 0;
    const w = lookBlend(alt);
    if (w > 0.95) {
      s.lookPitch = Math.max(-80 * DEG, Math.min(75 * DEG, (pitch - pitchForAlt(alt)) / w));
      s.pitchOverride = NaN;
      s.overrideWeight = 0;
      exitRelease = -1;
    } else {
      s.lookPitch = 0;
      s.pitchOverride = Math.max(-Math.PI / 2, Math.min(80 * DEG, pitch));
      s.overrideWeight = 1;
      exitRelease = 0;
    }
    flyT = -1;
    inertiaRate = 0;
    anchorOn = false;
    aimOn = false;
    hasGrab = false;
    interacted = false;
    velF = velR = yawVel = 0;
    landOn = false;
    landDone = false;
    landNone = false;
    pendingLand = null;
    flyTurn = false;
    steer = false;
    steerDone = false;
    prevPX = NaN;
    pvx = pvz = 0;
    floors(ctx, alt);
  }

  /** Smoothed plan-space velocity of the focus (the lift's look-ahead). */
  function trackPlanVelocity(dt: number) {
    fromSphere(s.focus, plan);
    if (Number.isFinite(prevPX) && dt > 0) {
      const k = 1 - Math.exp(-dt * 8);
      pvx += ((plan.x - prevPX) / dt - pvx) * k;
      pvz += ((plan.z - prevPZ) / dt - pvz) * k;
    }
    prevPX = plan.x;
    prevPZ = plan.z;
  }

  /** Advance the ground reference and the roof lift springs by dt, then apply the hard floors. */
  function stepReference(ctx: LBContext, alt: number, dt: number) {
    const target = groundAt(ctx, s.focus);
    springStep(s.ground, s.groundVel, target, alt < 3 ? 14 : target > s.ground ? 12 : 8, dt, spring);
    s.ground = spring[0];
    s.groundVel = spring[1];
    // Roofs: the (already ramped) target rises briskly and settles back gently once past.
    const lift = liftTargetAt(ctx, alt);
    springStep(s.lift, s.liftVel, lift, lift > s.lift ? 9 : 3, dt, spring);
    s.lift = Math.max(0, spring[0]);
    s.liftVel = spring[1];
    floors(ctx, alt);
  }

  function apply(ctx: LBContext) {
    computePose(s, pose);
    const cam = ctx.camera;
    cam.position.set(pose.eye.x, pose.eye.y, pose.eye.z);
    // The lens: the altitude FOV fitted to the canvas aspect, and a vertical shift (model.ts
    // lensShift): the camera axis pitches up by δ and the frustum shifts down to match, so the
    // frame's centre row still looks along pose.dir while verticals converge less.
    lensV = orbitFitFov(lensFov(pose.fov, cam.aspect || 1), cam.aspect || 1, pose.alt, hyp3(pose.eye.x, pose.eye.y, pose.eye.z));
    const k = lensShift(pose.alt, pose.pitch);
    const delta = Math.atan(2 * k * Math.tan((lensV * DEG) / 2));
    const cd = Math.cos(delta);
    const sd = Math.sin(delta);
    // three cameras look down −Z with +Y up: basis (right, up, −dir).
    vz.set(-(pose.dir.x * cd + pose.up.x * sd), -(pose.dir.y * cd + pose.up.y * sd), -(pose.dir.z * cd + pose.up.z * sd));
    vy.set(pose.up.x * cd - pose.dir.x * sd, pose.up.y * cd - pose.dir.y * sd, pose.up.z * cd - pose.dir.z * sd);
    vx.crossVectors(vy, vz).normalize();
    m4.makeBasis(vx, vy, vz);
    cam.quaternion.setFromRotationMatrix(m4);
    const altSea = hyp3(pose.eye.x, pose.eye.y, pose.eye.z) - R;
    clipPlanes(pose.alt, altSea, clip);
    if (clip.near !== lastNear || clip.far !== lastFar || lensV !== lastFov || k !== lastShift || cam.aspect !== lastAspect) {
      cam.near = clip.near;
      cam.far = clip.far;
      cam.fov = lensV;
      if (!cam.view) cam.view = { enabled: true, fullWidth: 1, fullHeight: 1, offsetX: 0, offsetY: 0, width: 1, height: 1 };
      cam.view.enabled = k > 0;
      cam.view.offsetY = k;
      cam.updateProjectionMatrix();
      lastNear = clip.near;
      lastFar = clip.far;
      lastFov = lensV;
      lastShift = k;
      lastAspect = cam.aspect;
    }
    cam.updateMatrixWorld();
    // ctx.view
    const view = ctx.view;
    view.eye.copy(cam.position);
    view.forward.set(pose.dir.x, pose.dir.y, pose.dir.z);
    view.focus.set(s.focus.x, s.focus.y, s.focus.z);
    view.alt = pose.alt;
    view.altTerrain = altSea - ctx.world.planet.surfaceAt(s.focus);
    view.altSea = altSea;
    view.ground = s.ground;
    latLonFromDir(s.focus, ll);
    view.lat = ll.lat;
    view.lon = ll.lon;
    view.heading = pose.heading;
    view.pitch = pose.pitch;
    view.fov = lensV;
    view.horizon = horizonDistance(R, Math.max(0, altSea));
    view.street = s.logAltTarget <= LOG_MIN + 1e-3 && s.logAlt < LOG_MIN + 0.05;
    fromSphere(s.focus, plan);
    view.cityX = plan.x;
    view.cityZ = plan.z;
    view.cityDist = hyp(plan.x, plan.z);
    ctx.uniforms.lbCamAlt.value = view.altTerrain;
    ctx.uniforms.lbCamPos.value.copy(cam.position);
  }

  /**
   * Landing candidates near plan (x, z) for a view heading (plan), best first (camera/landing.ts,
   * facing what the zoom aimed at), or null outside the city. `fromAlt`: the eye height the glide
   * starts at (the finder marks down spots behind tall buildings).
   */
  function findLandings(ctx: LBContext, x: number, z: number, heading: number, radius: number, fromAlt?: number): Landing[] | null {
    if (!finder || x * x + z * z > (CITY_PLAN_RADIUS + 4) ** 2) return null;
    let aimX: number | undefined;
    let aimZ: number | undefined;
    if (aimOn) {
      fromSphere(aim, plan);
      if (plan.x * plan.x + plan.z * plan.z < (CITY_PLAN_RADIUS + 30) ** 2) {
        aimX = plan.x;
        aimZ = plan.z;
      }
    }
    landInfo.aimX = aimX ?? NaN;
    landInfo.aimZ = aimZ ?? NaN;
    landRadius = radius;
    landCX = x;
    landCZ = z;
    return finder.find({ cx: x, cz: z, radius, heading, sun: ctx.uniforms.lbSunDir.value, dive: false, fromAlt, aimX, aimZ }, 10);
  }

  /**
   * The first candidate (in score order) whose planned glide in is clear: `glide` writes its eye
   * path into gx / gz / gh for a shape and returns the sample count; glideMargin checks it against
   * every camera solid and facade (1.5 m in flight, 0.6 m at walking height and in the last 3 m).
   * If none passes, the one with the most room. Sets chosenShape.
   */
  function pickClear(ctx: LBContext, list: Landing[], shapes: number[], fromX: number, fromZ: number, glide: (l: Landing, shape: number) => number): Landing | null {
    // Only the solids the glides can reach (the search area, the start, a margin for the glide's bulge).
    const t0 = performance.now();
    const pad = landRadius + 10;
    const local = solidsIn(finder!.solids, Math.min(landCX, fromX) - pad, Math.min(landCZ, fromZ) - pad, Math.max(landCX, fromX) + pad, Math.max(landCZ, fromZ) + pad, localSolids);
    let best: Landing | null = null;
    let bestM = -Infinity;
    let bestShape = shapes[0];
    landInfo.n = list.length;
    landInfo.margins.length = 0;
    for (const l of list) {
      for (const shape of shapes) {
        const m = glideMargin(ctx.world.cityIndex, local, gx, gz, gh, glide(l, shape), near, bestM);
        landInfo.margins.push(Math.round(m * 100) / 100);
        if (m >= 0) {
          chosenShape = shape;
          landInfo.ms = performance.now() - t0;
          return l;
        }
        if (m > bestM) {
          bestM = m;
          best = l;
          bestShape = shape;
        }
      }
    }
    chosenShape = bestShape;
    landInfo.ms = performance.now() - t0;
    return best;
  }

  /** The roof lift along a planned glide (plannedEye's state). */
  let gLift = 0;

  /**
   * Planned eye height (m above the plateau) at zoom altitude alt over plan (x, z), dt s after the
   * previous sample: the roof lift rises to keep it min(2.5, alt) over a roof and settles back at
   * its spring's pace (ω 3) once past, as stepReference does. Reset gLift to s.lift first.
   */
  function plannedEye(idx: LBContext['world']['cityIndex'], x: number, z: number, alt: number, dt: number): number {
    const base = idx.groundH(x, z) + alt;
    const roof = idx.roofAt(x, z);
    gLift = Math.max(roof > 0 ? roof + Math.min(2.5, alt) - base : 0, gLift * Math.exp(-3 * dt));
    return base + gLift;
  }

  const localSolids = { a: new Float64Array(0), n: 0 };
  // The last landing search's area (pickClear gathers the solids around it).
  let landRadius = 0;
  let landCX = 0;
  let landCZ = 0;
  /** Candidates found on the previous frame, checked (and the landing begun) on this one: the search and the checks are split over two frames. */
  let pendingLand: Landing[] | null = null;
  /** The glide shape pickClear settled on (a LAND_SHAPES entry). */
  let chosenShape = LAND_SHAPES[0];
  /** The current landing's shape. */
  let landShape = LAND_SHAPES[0];

  /** Fly-to duration (s) for an arc of `ang` rad and a log-altitude change. */
  const flyDuration = (ang: number, dLog: number) => 0.9 + Math.min(1.4, ang * 1.2) + Math.abs(dLog) * 0.12;

  /**
   * The planned eye path of a fly-to from plan (fx, fz) at log-altitude logFrom onto landing l at eye
   * height (glide samples, see pickClear): the eased track, the hop, and the altitude spring's
   * lag, then the settle at the spot.
   */
  function flyGlide(ctx: LBContext, fx: number, fz: number, logFrom: number, l: Landing): number {
    const idx = ctx.world.cityIndex;
    const logTo = LOG_MIN;
    const ang = hyp(l.x - fx, l.z - fz) / (R + PLATEAU_HEIGHT);
    const dur = flyDuration(ang, logTo - logFrom);
    const hopA = Math.min(1.2, ang * 1.5);
    const total = dur + 0.6;
    const dt = total / GLIDE_N;
    let lg = logFrom;
    let lv = 0;
    gLift = s.lift;
    for (let i = 0; i <= GLIDE_N; i++) {
      const t = Math.min(1, (i * dt) / dur);
      const e = t * t * (3 - 2 * t);
      const x = fx + (l.x - fx) * e;
      const z = fz + (l.z - fz) * e;
      if (i > 0) {
        springStep(lg, lv, logFrom + (logTo - logFrom) * e + hopA * Math.sin(Math.PI * t), 6.5, dt, spring);
        lg = spring[0];
        lv = spring[1];
      }
      gx[i] = x;
      gz[i] = z;
      gh[i] = plannedEye(idx, x, z, Math.exp(Math.max(LOG_MIN, lg)), i > 0 ? dt : 0);
    }
    return GLIDE_N + 1;
  }

  /** Glide progress (0…1, done at 1) for the landing's descent progress p (0…1). */
  const glideAt = (p: number, shape = landShape) => Math.min(1, Math.max(0, p / shape));

  /**
   * The planned eye path of the touchdown glide from plan (x0, z0) with start tangent (mx, mz),
   * descending from log-altitude log0 to eye height, onto landing l (glide samples).
   */
  function landGlide(ctx: LBContext, x0: number, z0: number, mx: number, mz: number, log0: number, l: Landing, shape: number): number {
    const idx = ctx.world.cityIndex;
    const span = log0 - LOG_MIN;
    gLift = s.lift;
    // (~1.5 s for the whole glide: the altitude spring's pace for a typical descent.)
    const dt = 1.5 / GLIDE_N;
    for (let i = 0; i <= GLIDE_N; i++) {
      const p = i / GLIDE_N;
      const g = glideAt(p, shape);
      const h01 = g * g * (3 - 2 * g);
      const h10 = g * (1 - g) * (1 - g);
      const x = x0 + (l.x - x0) * h01 + mx * shape * h10;
      const z = z0 + (l.z - z0) * h01 + mz * shape * h10;
      gx[i] = x;
      gz[i] = z;
      gh[i] = plannedEye(idx, x, z, Math.exp(log0 - p * span), i > 0 ? dt : 0);
    }
    return GLIDE_N + 1;
  }

  function startFly(ctx: LBContext, dir: Vec3, alt: number) {
    copy3(flyTo, dir);
    alt = Math.min(ALT_MAX, Math.max(EYE_HEIGHT, alt));
    flyTurn = false;
    copy3(flyFrom, s.focus);
    flyLogFrom = s.logAlt;
    // Into the street: fly to the best pavement spot near the point whose flight in is clear of
    // poles, lamp heads, crowns and walls, turning to look down the street.
    if (alt < 4.5) {
      fromSphere(flyTo, plan);
      const tx = plan.x;
      const tz = plan.z;
      fromSphere(s.focus, plan);
      const fx = plan.x;
      const fz = plan.z;
      const hView = worldHeadingToPlan(fx, fz, pose.heading);
      const list = findLandings(ctx, tx, tz, hView, 14);
      const l = list && pickClear(ctx, list, FLY_SHAPES, fx, fz, (c) => flyGlide(ctx, fx, fz, flyLogFrom, c));
      if (l) {
        planToDir(l.x, l.z, flyTo);
        flyTurn = true;
        flyHeadFrom = hView;
        flyHeadTo = l.heading;
        alt = EYE_HEIGHT;
      }
    }
    if (overSea(ctx, flyTo)) alt = Math.max(alt, SEA_FLOOR_ALT);
    flyLogTo = Math.log(alt);
    flyDur = flyDuration(angleBetween(flyFrom, flyTo), flyLogTo - flyLogFrom);
    flyT = 0;
    inertiaRate = 0;
    anchorOn = false;
    landOn = false;
    landDone = alt < 4.5;
    velF = velR = 0;
  }

  /** Point the view at a plan heading (at the focus), keeping pitch offsets. */
  function setPlanHeading(h: number) {
    fromSphere(s.focus, plan);
    headingVector(s.focus, planHeadingToWorld(plan.x, plan.z, h), s.fwd);
  }

  /** Move the focus along a tangent direction (heading-relative fwd/right components) by `dist`. */
  function walk(ctx: LBContext, f: number, r: number, dist: number, street: boolean) {
    copy3(tA, s.fwd);
    cross3(tB, tA, s.focus); // right = fwd × up
    normalize3(tB);
    const l = hyp(f, r);
    if (l < 1e-9) return;
    axis.x = (tA.x * f + tB.x * r) / l;
    axis.y = (tA.y * f + tB.y * r) / l;
    axis.z = (tA.z * f + tB.z * r) / l;
    const ang = dist / (R + s.ground);
    cross3(tB, s.focus, axis); // rotation axis
    normalize3(tB);
    const oldX = s.focus.x;
    const oldY = s.focus.y;
    const oldZ = s.focus.z;
    const wasSea = overSea(ctx, s.focus);
    rotateState(tB, ang);
    if (!street) return;
    // Walls: slide along building footprints and around lamps and trunks.
    fromSphere(s.focus, plan);
    if (plan.x * plan.x + plan.z * plan.z < (CITY_PLAN_RADIUS + 5) ** 2 && ctx.world.cityIndex.collide(plan.x, plan.z, BODY_R, planOut)) {
      moveFocusToPlan(planOut.x, planOut.z);
      fromSphere(s.focus, plan);
    }
    // Pedestrians: a soft body (slide round them, pushed back at most the step plus PEOPLE_PUSH,
    // so a walker who steps into the player nudges instead of shoving); then the walls again.
    if (ctx.services.people?.pushOut(plan.x, plan.z, BODY_R, planOut)) {
      const dx = planOut.x - plan.x;
      const dz = planOut.z - plan.z;
      const k = Math.min(1, (dist + PEOPLE_PUSH) / (Math.sqrt(dx * dx + dz * dz) || 1));
      plan.x += dx * k;
      plan.z += dz * k;
      if (!ctx.world.cityIndex.collide(plan.x, plan.z, BODY_R, planOut)) moveFocusToPlan(plan.x, plan.z);
    }
    // v2 (T2): the towns' people, the same soft body, in world space (the capital's plan stretches
    // far from it: near its antipode a metre across is ~9 plan units, so a push limited there would
    // let the player walk through them).
    if (ctx.services.townsfolk?.pushOut(s.focus, BODY_R, tB)) rotateState(axis, Math.min(arc(s.focus, tB, axis), (dist + PEOPLE_PUSH) / (R + s.ground)));
    // The countryside's trunks and boulders (A1's scatter; city trees are CityIndex obstacles).
    if (ctx.services.nature?.collide(s.focus, NATURE_R, s.focus)) orthonormalizeTangent(s.fwd, s.focus);
    // Never walk from the land into the sea.
    if (!wasSea && ctx.world.planet.heightAt(s.focus) < -0.2) {
      s.focus.x = oldX;
      s.focus.y = oldY;
      s.focus.z = oldZ;
      orthonormalizeTangent(s.fwd, s.focus);
      velF *= 0.5;
      velR *= 0.5;
    }
  }

  /** Land points on a Fibonacci lattice (~10 m apart): firm, low ground (no beach, no peaks). */
  function getLandDirs(ctx: LBContext): Float32Array {
    if (landDirs) return landDirs;
    const N = 3000;
    const tmp = new Float32Array(N * 3);
    const d = v3();
    let n = 0;
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N;
      const r = Math.sqrt(1 - y * y);
      d.x = Math.cos(ga * i) * r;
      d.y = y;
      d.z = Math.sin(ga * i) * r;
      const h = ctx.world.planet.heightAt(d);
      if (h < 1 || h > 10) continue;
      tmp[n * 3] = d.x;
      tmp[n * 3 + 1] = d.y;
      tmp[n * 3 + 2] = d.z;
      n++;
    }
    landDirs = tmp.slice(0, n * 3);
    return landDirs;
  }

  /**
   * Where a zoom aimed at `dir` over open sea should go instead (into out): the nearest land, or the
   * city when it is not much further. False if `dir` is not open sea (land within STEER_CLEAR m).
   */
  function steerTarget(ctx: LBContext, dir: Vec3, out: Vec3): boolean {
    if (!overSea(ctx, dir)) return false;
    const L = getLandDirs(ctx);
    let best = -2;
    let bi = -1;
    for (let i = 0; i < L.length; i += 3) {
      const d = L[i] * dir.x + L[i + 1] * dir.y + L[i + 2] * dir.z;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (bi < 0) return false;
    const angL = Math.acos(Math.min(1, best));
    if (angL * R < STEER_CLEAR) return false;
    planToDir(0, 0, tB);
    const angC = angleBetween(dir, tB);
    if (angC < angL * 1.5 + 0.25) copy3(out, tB);
    else {
      out.x = L[bi];
      out.y = L[bi + 1];
      out.z = L[bi + 2];
    }
    return true;
  }

  /** Start the sea steer once per descent when the zoom heads below LOG_STEER over open sea. */
  function seaSteer(ctx: LBContext) {
    if (s.logAltTarget > LOG_STEER_REARM) steerDone = false;
    if (steerDone || flyT >= 0 || landOn || s.logAltTarget >= LOG_STEER || s.logAltTarget > s.logAlt - 0.02) return;
    steerDone = true;
    if (!steerTarget(ctx, anchorOn ? anchor : s.focus, tA)) return;
    copy3(steerTo, tA);
    startFly(ctx, steerTo, Math.max(Math.exp(LOG_STEER_FLOOR), Math.exp(s.logAltTarget)));
    steer = true;
  }
  const steerTo = v3();

  function handleInput(ctx: LBContext, dt: number) {
    const inp = input!;
    const W = inp.width;
    const H = inp.height;
    const alt = Math.exp(s.logAlt);
    const w = lookBlend(alt);
    const st = inp.stick;
    const any = inp.wheel !== 0 || inp.pinch !== 1 || inp.dragging || inp.lockDX !== 0 || inp.lockDY !== 0 || inp.doubleClick || st.active;

    // Zoom: wheel / pinch / keys move the log-altitude target; zoom toward the cursor.
    let dz = 0;
    if (inp.wheel !== 0) dz += inp.wheel * 0.0018;
    if (inp.pinch !== 1) dz -= Math.log(inp.pinch) * 1.3;
    const zoomKeys = (inp.key('KeyE') || inp.key('Equal') || inp.key('NumpadAdd') ? -1 : 0) + (inp.key('KeyQ') || inp.key('Minus') || inp.key('NumpadSubtract') ? 1 : 0);
    if (zoomKeys) dz += zoomKeys * dt * 1.4;
    if (dz !== 0 && steer && flyT >= 0) {
      // A sea steer in flight: the zoom sets where it ends (not below LOG_STEER_FLOOR: it has not
      // looked for a landing spot); zooming out past where it started calls it off.
      interacted = true;
      flyLogTo = Math.min(LOG_MAX, Math.max(LOG_STEER_FLOOR, flyLogTo + dz));
      if (flyLogTo > LOG_STEER_REARM) {
        flyT = -1;
        steer = false;
        s.logAltTarget = flyLogTo;
      }
    } else if (dz !== 0) {
      s.logAltTarget = Math.min(LOG_MAX, Math.max(minLog(ctx), s.logAltTarget + dz));
      flyT = -1;
      interacted = true;
      if (landOn || landDone) anchorOn = false; // touching down: the landing owns the focus
      else if (dz > 0 && pose.pitch > -55 * DEG) {
        // Zooming out from a low, level view: straight up. The cursor ray grazes the horizon there,
        // and its far ground point, held as the view tipped down, dragged the climb kilometres
        // along the look direction (out of the street to an orbit far from the city).
        anchorOn = false;
      } else if (inp.wheel !== 0 || inp.pinch !== 1) {
        // Map-style: the world point under the cursor is locked once per gesture and held under the
        // cursor (holdAnchor). It is re-picked only when the cursor (or the pinch centre) moves more
        // than a few px; a small move pans with it. Keys, or a cursor on the sky, zoom straight.
        const at = inp.pinch !== 1 ? inp.pinchAt : inp.wheelAt;
        if (!anchorOn || hyp(at.x - lockPx.x, at.y - lockPx.y) > ANCHOR_REPICK_PX) {
          anchorR = pickRadius(ctx);
          anchorOn = pick(ctx, at.x, at.y, W, H, anchor, anchorR);
          lockPx.x = at.x;
          lockPx.y = at.y;
          aimOn = anchorOn;
          if (anchorOn) aimAlongRay(ctx);
        }
        anchorPx.x = at.x;
        anchorPx.y = at.y;
      } else anchorOn = false;
    }

    // Drag: grab-spin in orbit, look-around near the ground, blended by altitude.
    if (inp.dragStarted) {
      inertiaRate = 0;
      flyT = -1;
      grabRadius = pickRadius(ctx);
      hasGrab = pick(ctx, inp.cursor.x, inp.cursor.y, W, H, grab, grabRadius, true);
    }
    if (inp.dragging && (inp.dragDX !== 0 || inp.dragDY !== 0)) {
      interacted = true;
      if (w < 1 && hasGrab && pick(ctx, inp.cursor.x, inp.cursor.y, W, H, tA, grabRadius, true)) {
        // Rotate so the grabbed point returns under the cursor: H → G.
        const ang = arc(tA, grab, axis) * (1 - w);
        rotateState(axis, ang);
        if (dt > 0) {
          // inertia: smoothed angular velocity
          const rate = ang / dt;
          if (inertiaRate === 0) copy3(inertiaAxis, axis);
          else slerpDir(inertiaAxis, inertiaAxis, axis, 0.5);
          inertiaRate += (rate - inertiaRate) * 0.5;
        }
      }
      if (w > 0) {
        // Look-around ("grab the world"): yaw turns the heading itself (so it survives lifting
        // off), pitch is an offset on top of the altitude curve.
        const k = ((lensV * DEG) / H) * w;
        rotateAxis(s.fwd, s.fwd, s.focus, inp.dragDX * k);
        orthonormalizeTangent(s.fwd, s.focus);
        s.lookPitch += inp.dragDY * k;
      }
    }
    if (inp.dragEnded) {
      hasGrab = false;
      // Release with inertia only if the pointer was still moving.
      if (Math.abs(inertiaRate) < 0.02) inertiaRate = 0;
    }
    // (The release frame already coasts: no one-frame freeze between the drag and the throw.)
    if (!inp.dragging && inertiaRate !== 0) {
      rotateState(inertiaAxis, inertiaRate * dt);
      inertiaRate *= Math.exp(-dt * (ctx.reducedMotion ? 6 : 3.2));
      if (Math.abs(inertiaRate) < 0.002) inertiaRate = 0;
    }
    if (inp.dragging && inp.dragDX === 0 && inp.dragDY === 0) inertiaRate *= Math.exp(-dt * 12);

    // Pointer lock look (page variant, at street level).
    if (inp.lockDX !== 0 || inp.lockDY !== 0) {
      const k = (lensV * DEG) / H;
      rotateAxis(s.fwd, s.fwd, s.focus, -inp.lockDX * k);
      orthonormalizeTangent(s.fwd, s.focus);
      s.lookPitch -= inp.lockDY * k;
    }
    s.lookPitch = Math.max(-80 * DEG, Math.min(75 * DEG, s.lookPitch));
    if (inp.click && inp.clickMouse && ctx.variant === 'page' && w > 0.9) inp.requestLock();
    if (inp.locked && w < 0.5) inp.releaseLock();

    // Double-click / double-tap: fly to the point.
    if (inp.doubleClick && pick(ctx, inp.doubleAt.x, inp.doubleAt.y, W, H, tB)) {
      startFly(ctx, tB, Math.max(EYE_HEIGHT, Math.min(alt * 0.4, 60)));
      interacted = true;
    }

    // Keys and the touch stick: walk at street level, pan (scaled by altitude) above it. Velocity
    // eases toward the wanted one, so starts and stops never snap.
    const streetish = w > 0.95;
    const turnKeys = streetish ? (inp.key('ArrowRight') ? 1 : 0) - (inp.key('ArrowLeft') ? 1 : 0) : 0;
    let fwdIn = (inp.key('KeyW') || inp.key('ArrowUp') ? 1 : 0) - (inp.key('KeyS') || inp.key('ArrowDown') ? 1 : 0);
    let sideIn = (inp.key('KeyD') || (!streetish && inp.key('ArrowRight')) ? 1 : 0) - (inp.key('KeyA') || (!streetish && inp.key('ArrowLeft')) ? 1 : 0);
    const kl = hyp(fwdIn, sideIn);
    if (kl > 1) {
      fwdIn /= kl;
      sideIn /= kl;
    }
    if (st.active && streetish) {
      fwdIn = -st.y;
      sideIn = st.x;
    }
    const mag = Math.min(1, hyp(fwdIn, sideIn));
    const run = inp.key('ShiftLeft') || inp.key('ShiftRight') || (st.active && mag > 0.97);
    const speed = moveSpeed(alt, w, run);
    const wantF = fwdIn * speed;
    const wantR = sideIn * speed;
    if (landOn && (mag > 0 || turnKeys)) {
      landOn = false;
      landDone = true;
    }
    if (landOn && (inp.dragging || inp.locked) && (inp.dragDX !== 0 || inp.dragDY !== 0 || inp.lockDX !== 0)) landFreeHeading = true;
    if (mag > 0 || turnKeys) {
      interacted = true;
      flyT = -1;
      anchorOn = false;
    }
    velF = approach(velF, wantF, mag > 0 ? (streetish ? 9 : 6) : streetish ? 11 : 5, dt);
    velR = approach(velR, wantR, mag > 0 ? (streetish ? 9 : 6) : streetish ? 11 : 5, dt);
    yawVel = approach(yawVel, turnKeys * TURN_RATE, 10, dt);
    if (Math.abs(yawVel) > 1e-4) {
      rotateAxis(s.fwd, s.fwd, s.focus, -yawVel * dt);
      orthonormalizeTangent(s.fwd, s.focus);
    } else yawVel = 0;
    const vel = hyp(velF, velR);
    if (vel > 1e-3) walk(ctx, velF, velR, vel * dt, streetish);
    else velF = velR = 0;

    if ((inp.pressed('Space') || inp.key('Space')) && streetish && s.jump === 0 && s.jumpVel === 0) s.jumpVel = JUMP_V;
    if (any && s.overrideWeight > 0) interacted = true;
  }

  /**
   * Map-style zoom: hold the locked anchor under the cursor pixel at this frame's altitude, pitch
   * and lens. The camera is re-posed, the cursor ray is cast at the anchor's sphere, and the whole
   * state rotates rigidly so that ray meets the anchor again (grab-spin's trick, so the solve is
   * exact). The hold weighs in fully above ANCHOR_HI m and lets go smoothly by ANCHOR_LO m, and on
   * a grazing cursor ray (ill-conditioned: a tiny tilt moves its ground point metres); while partly
   * held the anchor follows the cursor's ground point, so no error piles up and the focus speed
   * ramps instead of snapping, whichever way the zoom goes. Lateral speed is capped by altitude.
   */
  function holdAnchor(ctx: LBContext, dt: number) {
    const alt = Math.exp(s.logAlt);
    const kAlt = smooth01((alt - ANCHOR_LO) / (ANCHOR_HI - ANCHOR_LO));
    apply(ctx);
    const inp = input!;
    if (!pick(ctx, anchorPx.x, anchorPx.y, inp.width, inp.height, tA, anchorR)) return; // on the sky: nothing to hold
    const dep = -dot3(rayD, rayO) / hyp3(rayO.x, rayO.y, rayO.z);
    const k = kAlt * smooth01((Math.asin(Math.max(-1, Math.min(1, dep))) - 4 * DEG) / (10 * DEG));
    anchorK = k;
    const ang = arc(tA, anchor, axis);
    if (k > 0 && ang > 1e-9) rotateState(axis, Math.min(ang * k, (Math.max(15, 2.5 * alt) * dt) / (R + s.ground)));
    if (k < 0.999) slerpDir(anchor, tA, anchor, k);
  }

  /**
   * What the cursor ray (rayO / rayD from the last pick) actually shows: the first building it
   * enters (a tower's roof or facade, marched in 0.75 m steps and refined), else the ground anchor.
   * The landing turns to face it; aiming at a tower's top must not land you facing the street behind it.
   */
  function aimAlongRay(ctx: LBContext) {
    copy3(aim, anchor);
    const idx = ctx.world.cityIndex;
    const top = R + PLATEAU_HEIGHT + 40;
    const o = hyp3(rayO.x, rayO.y, rayO.z);
    let t = o <= top ? 0 : raySphere(rayO, rayD, top);
    const tEnd = raySphere(rayO, rayD, R + anchorR);
    if (t < 0 || tEnd < 0) return;
    const inside = (tt: number) => {
      tB.x = rayO.x + rayD.x * tt;
      tB.y = rayO.y + rayD.y * tt;
      tB.z = rayO.z + rayD.z * tt;
      const len = hyp3(tB.x, tB.y, tB.z);
      normalize3(tB);
      fromSphere(tB, plan);
      if (plan.x * plan.x + plan.z * plan.z > CITY_PLAN_RADIUS * CITY_PLAN_RADIUS) return false;
      const roof = idx.roofAt(plan.x, plan.z);
      return roof > 0 && len - R - PLATEAU_HEIGHT <= roof;
    };
    for (; t < tEnd; t += 0.75) {
      if (!inside(t)) continue;
      let lo = Math.max(0, t - 0.75);
      let hi = t;
      for (let i = 0; i < 6; i++) {
        const m = (lo + hi) / 2;
        if (inside(m)) hi = m;
        else lo = m;
      }
      inside(hi);
      copy3(aim, tB);
      return;
    }
  }

  /**
   * The touchdown resolver. Once a zoom heading for the street (target below ~10 m) passes 28 m
   * inside the city, it picks the best pavement spot within ~24 m (camera/landing.ts: nothing in the
   * face, a view down the street, facing what the zoom aimed at, sun, close by, little turning)
   * whose glide in clears every pole, lamp head, crown and wall — whatever is under the focus: a
   * roof, a lot, the carriageway or a junction — and glides the focus and the heading onto it as the
   * altitude falls (done by ~3.5 m). The glide is a Hermite curve that starts with the focus's
   * current velocity (the zoom anchor's pull), so the hand-over never jolts. Keys cancel it; a drag
   * hands the heading back to the user.
   */
  function resolveLanding(ctx: LBContext, alt: number, dt: number) {
    if (flyT >= 0) return;
    if (s.logAltTarget > LOG_UNLAND) {
      landOn = false;
      landDone = false;
      landNone = false;
      pendingLand = null;
      return;
    }
    if (landDone || landNone) return;
    if (!landOn) {
      // A zoom anchor still pulling waits until it has let go (by ANCHOR_LO): the focus is then
      // nearly at rest, so the glide starts without a jolt in speed or direction.
      if (alt > 28 || s.logAltTarget > LOG_LAND || (anchorOn && anchorK > 0.02)) {
        pendingLand = null;
        return;
      }
      fromSphere(s.focus, plan);
      const x0 = plan.x;
      const z0 = plan.z;
      const hView = worldHeadingToPlan(x0, z0, pose.heading);
      // Frame 1: the search (~3 ms); frame 2: the glide checks and the start (one frame later the
      // focus has barely moved).
      if (!pendingLand) {
        pendingLand = findLandings(ctx, x0, z0, hView, 24, s.ground - PLATEAU_HEIGHT + s.lift + alt);
        if (!pendingLand || !pendingLand.length) {
          pendingLand = null;
          landNone = true; // open country: land where the zoom goes
        }
        return;
      }
      const list = pendingLand;
      pendingLand = null;
      const log0 = Math.max(s.logAlt, LOG_MIN + 0.05);
      // Start tangent: this frame's focus motion per unit of descent progress made this frame
      // (× the shape: per unit of glide progress).
      let mx = 0;
      let mz = 0;
      const dg = -frameDLog / (log0 - LOG_MIN);
      if (Number.isFinite(prevPX) && dg > 1e-4) {
        mx = (x0 - prevPX) / dg;
        mz = (z0 - prevPZ) / dg;
        const ml = hyp(mx, mz);
        if (ml > 40) {
          mx *= 40 / ml;
          mz *= 40 / ml;
        }
      }
      const l = pickClear(ctx, list, LAND_SHAPES, x0, z0, (c, shape) => landGlide(ctx, x0, z0, mx, mz, log0, c, shape));
      if (!l) {
        landNone = true;
        return;
      }
      landOn = true;
      landFreeHeading = false;
      landX = l.x;
      landZ = l.z;
      landHeading = l.heading;
      fromX = x0;
      fromZ = z0;
      fromHeading = hView;
      landLog0 = log0;
      landShape = chosenShape;
      landMX = mx * landShape;
      landMZ = mz * landShape;
      offX = offZ = 0;
      landP = 0;
      landPos.x = x0;
      landPos.z = z0;
      landV = dt > 0 ? (hyp(mx, mz) * Math.max(0, dg)) / dt : 0;
    }
    const span = landLog0 - LOG_MIN;
    // Monotone: zooming back up holds the glide where it is (no retracing, and nothing to stop when
    // the landing is called off at 12 m).
    let p = Math.min(1, Math.max(landP, (landLog0 - s.logAlt) / span));
    // Lateral speed cap: 3 m/s + 1.5 m/s per metre of altitude (a fast pinch must not fling the glide
    // sideways at 30+ m/s near the ground), easing into the spot (3.5/s of the distance left), and
    // changing by at most 90 m/s² either way (0.1 m per frame at 30 fps). The descent is held back to the glide's
    // pace; the altitude spring carries on from the held-back state (no kink in its velocity).
    const left = hyp(landX - landPos.x, landZ - landPos.z);
    const vmax = Math.max(landV - 90 * dt, Math.min(3 + 1.5 * alt, 0.6 + 3.5 * left, landV + 90 * dt)) * dt;
    if (p > landP && glidePos(p, glideTmp) && hyp(glideTmp.x - landPos.x, glideTmp.z - landPos.z) > vmax) {
      let lo = landP;
      let hi = p;
      for (let i = 0; i < 14; i++) {
        const m = (lo + hi) / 2;
        glidePos(m, glideTmp);
        if (hyp(glideTmp.x - landPos.x, glideTmp.z - landPos.z) > vmax) hi = m;
        else lo = m;
      }
      p = lo;
      const prev = s.logAlt - frameDLog;
      s.logAlt = landLog0 - p * span;
      if (dt > 0) s.logAltVel = (s.logAlt - prev) / dt;
      lastLogAlt = s.logAlt;
    }
    landP = p;
    glideTmp.x = landPos.x;
    glideTmp.z = landPos.z;
    glidePos(p, landPos);
    if (dt > 0) landV = hyp(landPos.x - glideTmp.x, landPos.z - glideTmp.z) / dt;
    const g = glideAt(p);
    const h01 = g * g * (3 - 2 * g);
    // A facade above the eye still pushes the path off: keepOffWalls' berth at the start (so the
    // hand-over is seamless), easing to the touchdown allowance; the push relaxes as it ends.
    const decay = Math.exp(-dt * 1.5);
    offX *= decay;
    offZ *= decay;
    let tx = landPos.x + offX;
    let tz = landPos.z + offZ;
    const eyeH = s.ground - PLATEAU_HEIGHT + s.lift + alt;
    if (wallStep(ctx, tx, tz, eyeH, (1 - g) * Math.min(4.5, Math.max(2.5, 1.5 + alt * 0.2)) + g * 0.6, alt, dt)) {
      offX += wallOut.x;
      offZ += wallOut.z;
      tx += wallOut.x;
      tz += wallOut.z;
    }
    moveFocusToPlan(tx, tz);
    if (!landFreeHeading) {
      let d = landHeading - fromHeading;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      setPlanHeading(fromHeading + d * h01);
    }
    anchorOn = false; // the landing spot wins over the zoom anchor
    if (p >= 0.999) {
      landOn = false;
      landDone = true;
    }
  }

  /** The planned (Hermite) glide position at landing progress p, into out. */
  function glidePos(p: number, out: { x: number; z: number }): boolean {
    const g = glideAt(p);
    const h01 = g * g * (3 - 2 * g);
    const h10 = g * (1 - g) * (1 - g);
    out.x = fromX + (landX - fromX) * h01 + landMX * h10;
    out.z = fromZ + (landZ - fromZ) * h01 + landMZ * h10;
    return true;
  }

  /**
   * The push (plan m, into out) that moves plan (px, pz) out to `want` m from every facade whose roof
   * is above the eye (eyeH m above the plateau). False if none is closer.
   */
  function wallPush(ctx: LBContext, px: number, pz: number, eyeH: number, want: number, out: { x: number; z: number }): boolean {
    if (px * px + pz * pz >= (CITY_PLAN_RADIUS + 5) ** 2) return false;
    const idx = ctx.world.cityIndex;
    const n = idx.buildingsNear(px, pz, want, near);
    let pushX = 0;
    let pushZ = 0;
    for (let i = 0; i < n; i++) {
      const b = idx.plan.buildings[near[i]];
      if (b.h + 0.5 < eyeH) continue; // below the eye: the lift's business
      const c = Math.cos(b.angle);
      const sn = Math.sin(b.angle);
      const dx = px - b.x;
      const dz = pz - b.z;
      const lx = dx * c + dz * sn;
      const lz = -dx * sn + dz * c;
      const ox = lx - Math.max(-b.w / 2, Math.min(b.w / 2, lx));
      const oz = lz - Math.max(-b.d / 2, Math.min(b.d / 2, lz));
      const d = hyp(ox, oz);
      if (d <= 1e-6 || d >= want) continue; // inside (the roof floor's business) or clear
      // (Weighed in as the roof rises from 0.5 m below the eye to 1.5 m above it: no jolt when a
      // descent sinks below a roof line.)
      const k = ((want - d) / d) * smooth01((b.h + 0.5 - eyeH) / 2);
      pushX += (ox * c - oz * sn) * k;
      pushZ += (ox * sn + oz * c) * k;
    }
    out.x = pushX;
    out.z = pushZ;
    return pushX !== 0 || pushZ !== 0;
  }

  /**
   * Keep clear of walls while flying low (not walking; a landing glide has its own): a facade beside
   * the eye — a building whose roof is above it — pushes the focus out to 2.5–4.5 m (growing with
   * altitude), toward the street. Lifting off from the pavement therefore drifts out over the road
   * instead of sliding up a wall 1 m from the lens; a tower beside a descent pushes you aside
   * instead of lifting you over it.
   */
  function keepOffWalls(ctx: LBContext, alt: number, dt: number) {
    if (landOn || flyT >= 0 || alt < 2.2 || alt > 45) return;
    if (s.logAltTarget <= LOG_MIN + 1e-3 && s.logAlt < LOG_MIN + 0.25) return; // standing / walking
    fromSphere(s.focus, plan);
    const px = plan.x;
    const pz = plan.z;
    const eyeH = s.ground - PLATEAU_HEIGHT + s.lift + alt;
    if (wallStep(ctx, px, pz, eyeH, Math.min(4.5, Math.max(2.5, 1.5 + alt * 0.2)), alt, dt, anchorK > 0 ? 7 : 3.5)) moveFocusToPlan(px + wallOut.x, pz + wallOut.z);
  }

  /**
   * This frame's step (into wallOut) of the push off facades above the eye: an exponential ease
   * (3.5/s; 7/s against a zoom anchor dragging the focus toward the wall) whose strength also ramps in over 2.2–4.7 m of altitude, so lifting off beside a wall
   * starts drifting instead of jumping. False if there is nothing to do, or the step would enter
   * another building taller than the eye (low roofs are the lift's business).
   */
  function wallStep(ctx: LBContext, px: number, pz: number, eyeH: number, want: number, alt: number, dt: number, rate = 3.5): boolean {
    if (!wallPush(ctx, px, pz, eyeH, want, wallOut)) return false;
    const f = (1 - Math.exp(-dt * rate)) * smooth01((alt - 2.2) / 2.5);
    wallOut.x *= f;
    wallOut.z *= f;
    return f > 0 && ctx.world.cityIndex.roofAt(px + wallOut.x, pz + wallOut.z) < eyeH - 0.5;
  }

  /**
   * Outside the city, a low camera keeps out of the countryside's trees and boulders (A1's
   * collider): a wide berth while the eye is still at crown height, the body radius on the ground.
   * In flight the focus eases out of the discs (no snap as a descent reaches them); walking slides.
   */
  function keepOffTrees(ctx: LBContext, alt: number, dt: number) {
    const nat = ctx.services.nature;
    if (!nat || alt > 9) return;
    fromSphere(s.focus, plan);
    if (plan.x * plan.x + plan.z * plan.z < CITY_PLAN_RADIUS * CITY_PLAN_RADIUS) return;
    if (!nat.collide(s.focus, NATURE_R + 1.2 * smooth01((alt - 2) / 4), tA)) return;
    slerpDir(tB, s.focus, tA, alt < 2.2 ? 1 : 1 - Math.exp(-dt * 5));
    rotateState(axis, arc(s.focus, tB, axis));
  }

  /** The v1 explore update (BRIEF §4), unchanged: input, fly-to, springs, landing, walls, apply. */
  function exploreUpdate(ctx: LBContext, dt: number, locked: boolean) {
    if (input && !locked) {
      handleInput(ctx, dt);
      seaSteer(ctx);
    }
    if (flyT < 0) steer = false;

    // Fly-to: slerp the focus with an ease, arc the altitude up and back down.
    if (flyT >= 0) {
      flyT = Math.min(1, flyT + dt / (ctx.reducedMotion ? flyDur * 1.4 : flyDur));
      const e = flyT * flyT * (3 - 2 * flyT);
      const ang = angleBetween(flyFrom, flyTo);
      slerpDir(tA, flyFrom, flyTo, e);
      // Move the state (carrying fwd) to the slerped point.
      const a = arc(s.focus, tA, axis);
      rotateState(axis, a);
      // Down in the street the flight slides round lamp posts and trunks like a walk would.
      if (s.logAlt < Math.log(3)) {
        fromSphere(s.focus, plan);
        if (plan.x * plan.x + plan.z * plan.z < (CITY_PLAN_RADIUS + 5) ** 2 && ctx.world.cityIndex.collide(plan.x, plan.z, BODY_R, planOut)) moveFocusToPlan(planOut.x, planOut.z);
      }
      const hop = Math.min(1.2, ang * 1.5) * Math.sin(Math.PI * flyT);
      s.logAltTarget = Math.min(LOG_MAX, flyLogFrom + (flyLogTo - flyLogFrom) * e + hop);
      if (flyTurn) {
        let d = flyHeadTo - flyHeadFrom;
        d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
        setPlanHeading(flyHeadFrom + d * e);
      }
      if (flyT >= 1) {
        flyT = -1;
        flyTurn = false;
        s.logAltTarget = flyLogTo;
      }
    }
    // Never down to eye height over open water.
    const lo = minLog(ctx);
    if (s.logAltTarget < lo) s.logAltTarget = lo;

    // Altitude spring (critically damped, in log space).
    const omega = ctx.reducedMotion ? 4 : 6.5;
    springStep(s.logAlt, s.logAltVel, s.logAltTarget, omega, dt, spring);
    s.logAlt = Math.min(LOG_MAX, Math.max(LOG_MIN, spring[0]));
    s.logAltVel = spring[1];
    frameDLog = s.logAlt - lastLogAlt;
    lastLogAlt = s.logAlt;
    // Zoom toward the cursor: hold the anchor under it (map-style).
    if (anchorOn && !landOn && input && !ctx.debug.cameraLocked) holdAnchor(ctx, dt);
    if (anchorOn && Math.abs(s.logAltTarget - s.logAlt) < 1e-3) anchorOn = false;
    if (!anchorOn) anchorK = 0;
    let alt = Math.exp(s.logAlt);
    if (!ctx.debug.cameraLocked) {
      resolveLanding(ctx, alt, dt);
      alt = Math.exp(s.logAlt); // the glide's speed cap may hold the descent back
      keepOffWalls(ctx, alt, dt);
      keepOffTrees(ctx, alt, dt);
    }

    // Pitch override (setView) blends back to the altitude curve once the user interacts.
    if (interacted && s.overrideWeight > 0) {
      s.overrideWeight = Math.max(0, s.overrideWeight - dt * 2);
    }
    // A mode's hand-back holds its pitch a moment, then eases it onto the curve (v2).
    if (exitRelease >= 0) {
      exitRelease += dt;
      const k = 1 - smooth01((exitRelease - 0.5) / (ctx.reducedMotion ? 2.4 : 1.7));
      s.overrideWeight = Math.min(s.overrideWeight, k);
      if (k <= 0) exitRelease = -1;
    }
    // Look offsets relax when climbing away from the ground.
    const w = lookBlend(alt);
    if (w < 0.02) {
      s.lookPitch *= Math.exp(-dt * 2);
      s.lookYaw *= Math.exp(-dt * 2);
    }

    // Ground reference (terrain / city ground) and the roof-clearing lift.
    trackPlanVelocity(dt);
    stepReference(ctx, alt, dt);

    // FPV jump.
    if (s.jumpVel !== 0 || s.jump > 0) {
      s.jumpVel -= GRAVITY * dt;
      s.jump += s.jumpVel * dt;
      if (s.jump <= 0) {
        s.jump = 0;
        s.jumpVel = 0;
      }
    }
    apply(ctx);
  }

  return {
    name: 'camera',
    stage: 1,
    init(ctx) {
      input = new CameraInput(ctx.canvas, ctx.variant);
      finder = new LandingFinder(ctx.world.city, ctx.world.cityIndex);
      input.escapeWanted = () => director.mode !== 'explore' && !ctx.debug.cameraLocked;
      const modeOut = { mode: 'explore' as LBContext['view']['mode'], ride: null as string | null, blend: 1 };
      ctx.services.camera = {
        snapshot: () => director.snapshot(),
        restore: (state) => director.restore(ctx, state),
        setView: (v, o) => setView(ctx, v, o?.glide),
        getView: () => {
          if (director.mode !== 'explore' || director.blending) {
            const v = ctx.view;
            return { lat: v.lat, lon: v.lon, alt: Math.max(EYE_HEIGHT, v.alt), heading: v.heading / DEG, pitch: v.pitch / DEG };
          }
          latLonFromDir(s.focus, ll);
          return { lat: ll.lat, lon: ll.lon, alt: Math.exp(s.logAlt), heading: pose.heading / DEG, pitch: pose.pitch / DEG };
        },
        flyTo: (dir, alt) => {
          if (director.mode !== 'explore') director.exitMode(ctx);
          startFly(ctx, dir, alt ?? Math.exp(s.logAlt));
        },
        releaseLock: () => input?.releaseLock(),
        lastInputAt: () => input?.lastInput ?? 0,
        stick: () => stickView,
        mode: () => {
          modeOut.mode = director.mode;
          modeOut.ride = director.rideId;
          modeOut.blend = director.blend;
          return modeOut;
        },
        ride: (id) => {
          input?.releaseLock();
          return director.ride(ctx, id);
        },
        cycle: (d) => director.cycle(ctx, d),
        fly: () => {
          input?.releaseLock();
          director.fly(ctx);
        },
        exitMode: () => director.exitMode(ctx),
        hover: () => director.hoverId,
        subject: (out) => director.subject(out),
      };
      // Dev introspection for player tests and the review hooks (not part of the contract).
      Object.assign(ctx.services.camera, {
        debug: () => ({ landOn, landDone, landX, landZ, landHeading, fromX, fromZ, lift: s.lift, anchorOn, aimOn, landInfo, target: Math.exp(s.logAltTarget), input: input?.debugState(), override: s.overrideWeight, pitchOverride: s.pitchOverride, exitRelease, posePitch: pose.pitch, poseAlt: pose.alt, mode: director.mode, ride: director.rideId, blend: director.blend, birdOn: director.birdOn, bird: { alt: director.bird.alt, speed: director.bird.speed, bank: director.bird.bank, gamma: director.bird.gamma, hardHits: director.bird.hardHits, crashes: director.bird.crashes, landings: director.bird.landings, grounded: director.bird.grounded, onWater: director.bird.onWater, stand: director.bird.stand, legs: director.bird.legs, takingOff: director.bird.takingOff, crash: director.bird.crash, floor: director.bird.floorH } }),
        director,
      });
      setView(ctx, { lat: 20, lon: 10, alt: 380, heading: 0 });
    },
    update(ctx) {
      const dt = ctx.time.realDt;
      const locked = ctx.debug.cameraLocked;
      if (input) {
        // The stick is offered only on touch: at street level, and to steer the bird.
        input.stick.enabled = input.touchSeen && !locked && (director.mode === 'bird' || (director.mode === 'explore' && lookBlend(Math.exp(s.logAlt)) > 0.95));
        input.poll();
      }
      // v2: modes, picking and transitions (camera/director.ts). Explore runs only while it is the mode.
      // With time frozen (?shot=1) the camera moves only with the sim (step / advance / dive frames),
      // so review frames are deterministic whatever the rAF loop does in between (a hand-back's
      // pitch release, a ride, the bird). v1's shots snap every spring, so they are unchanged.
      const ddt = ctx.time.frozen ? ctx.time.dt : dt;
      if (director.frameStart(ctx, input, ddt, locked)) exploreUpdate(ctx, ddt, locked);
      director.frameEnd(ctx, ddt, ctx.camera.near);
      if (input) {
        const st = input.stick;
        stickView.visible = st.enabled;
        stickView.active = st.active;
        stickView.x = st.x;
        stickView.y = st.y;
        stickView.ox = st.ox;
        stickView.oy = st.oy;
        stickView.touch = input.touchSeen;
        input.endFrame();
      }
    },
    dispose(ctx) {
      director.dispose(ctx);
      input?.dispose();
      input = null;
    },
  };
}
