// The camera system (BRIEF §4): drives camera/model.ts from input, owns ctx.view and the camera
// service (setView / flyTo). Stage 1, and first in systems.ts, so ctx.view is fresh for every
// other system's update. F0 builds the full model; A4 polishes the feel.

import { Matrix4, Vector3 } from 'three';
import type { LBContext, System, ViewSpec } from '../core/contracts';
import { ALT_MAX, CITY_PLAN_RADIUS, EYE_HEIGHT, PLATEAU_HEIGHT, R } from '../world/config';
import { fromSphere, planToDir } from '../world/city/frame';
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
import { CameraInput } from './input';
import { clipPlanes, computePose, createCamState, createPose, lookBlend, springStep } from './model';

const DEG = Math.PI / 180;
const LOG_MIN = Math.log(EYE_HEIGHT);
const LOG_MAX = Math.log(ALT_MAX);
const WALK = 4.2;
const RUN = 9;
const GRAVITY = 4.2; // tiny planet: jumps float
const JUMP_V = 3.4;
const BODY_R = 0.35;

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
  // scratch
  const tA = v3();
  const tB = v3();
  const axis = v3();
  const grab = v3();
  let hasGrab = false;
  let grabRadius = 0; // the grab sphere stays fixed for the whole drag
  const inertiaAxis = v3();
  let inertiaRate = 0; // rad/s
  const anchor = v3();
  let anchorOn = false;
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
  let input: CameraInput | null = null;
  const m4 = new Matrix4();
  const vx = new Vector3();
  const vy = new Vector3();
  const vz = new Vector3();
  const rayO = v3();
  const rayD = v3();
  const ndc = new Vector3();
  let interacted = false;

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

  /** Highest roof top (m above sea level) within `radius` of unit dir (0 = the point itself), or −∞. */
  function roofTopAt(ctx: LBContext, dir: Vec3, radius: number): number {
    fromSphere(dir, plan);
    if (plan.x * plan.x + plan.z * plan.z >= (CITY_PLAN_RADIUS + 20) ** 2) return -Infinity;
    const roof = radius > 0 ? ctx.world.cityIndex.maxRoofNear(plan.x, plan.z, radius) : ctx.world.cityIndex.roofAt(plan.x, plan.z);
    return roof > 0 ? PLATEAU_HEIGHT + roof : -Infinity;
  }

  /**
   * Extra eye height needed to clear roofs at zoom altitude `alt`: keep `min(2.5, alt)` above the
   * highest roof within a radius that grows with altitude (a point query at street level, where
   * FPV collision keeps the body out of buildings; standing on a roof puts the eye at roof + alt).
   * Faded out between 40 and 80 m, where nothing is tall enough to matter.
   */
  function liftTargetAt(ctx: LBContext, alt: number): number {
    const fade = 1 - smooth01((alt - 40) / 40);
    if (fade <= 0) return 0;
    const top = roofTopAt(ctx, s.focus, alt < 3 ? 0 : Math.min(6, 1.2 + alt * 0.08));
    if (top === -Infinity) return 0;
    return Math.max(0, top + Math.min(2.5, alt) - (s.ground + alt)) * fade;
  }

  /** Hard floors: the eye stays ≥ 0.8 m above the terrain/water and above the roof directly under it. */
  function floors(ctx: LBContext, alt: number) {
    const terrain = ctx.world.planet.surfaceAt(s.focus);
    if (s.ground + alt < terrain + 0.8) s.ground = terrain + 0.8 - alt;
    const roof = roofTopAt(ctx, s.focus, 0);
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
   * at `radius` above sea level when given. False on a miss.
   */
  function pick(ctx: LBContext, px: number, py: number, w: number, h: number, out: Vec3, radius = pickRadius(ctx)): boolean {
    screenRay(ctx, px, py, w, h);
    const t = raySphere(rayO, rayD, R + radius);
    if (t < 0) return false;
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
    const l = Math.hypot(outAxis.x, outAxis.y, outAxis.z);
    if (l < 1e-12) return 0;
    outAxis.x /= l;
    outAxis.y /= l;
    outAxis.z /= l;
    return Math.atan2(l, dot3(a, b));
  }

  function pickRadius(ctx: LBContext): number {
    return Math.max(0, ctx.world.planet.surfaceAt(s.focus));
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
    hasGrab = false;
    interacted = false;
    if (glide !== undefined && glide > 0) {
      stepReference(ctx, alt, glide);
    } else snap(ctx);
    apply(ctx);
  }

  /** Advance the ground reference and the roof lift springs by dt, then apply the hard floors. */
  function stepReference(ctx: LBContext, alt: number, dt: number) {
    const target = groundAt(ctx, s.focus);
    springStep(s.ground, s.groundVel, target, alt < 3 ? 14 : target > s.ground ? 12 : 8, dt, spring);
    s.ground = spring[0];
    s.groundVel = spring[1];
    // Roofs: the lift rises fast (never clip) and settles back gently once past.
    const lift = liftTargetAt(ctx, alt);
    springStep(s.lift, s.liftVel, lift, lift > s.lift ? 12 : 3, dt, spring);
    s.lift = Math.max(0, spring[0]);
    s.liftVel = spring[1];
    floors(ctx, alt);
  }

  function apply(ctx: LBContext) {
    computePose(s, pose);
    const cam = ctx.camera;
    cam.position.set(pose.eye.x, pose.eye.y, pose.eye.z);
    // three cameras look down −Z with +Y up: basis (right, up, −dir).
    vz.set(-pose.dir.x, -pose.dir.y, -pose.dir.z);
    vy.set(pose.up.x, pose.up.y, pose.up.z);
    vx.crossVectors(vy, vz).normalize();
    m4.makeBasis(vx, vy, vz);
    cam.quaternion.setFromRotationMatrix(m4);
    const altSea = Math.hypot(pose.eye.x, pose.eye.y, pose.eye.z) - R;
    clipPlanes(pose.alt, altSea, clip);
    if (clip.near !== lastNear || clip.far !== lastFar || pose.fov !== lastFov) {
      cam.near = clip.near;
      cam.far = clip.far;
      cam.fov = pose.fov;
      cam.updateProjectionMatrix();
      lastNear = clip.near;
      lastFar = clip.far;
      lastFov = pose.fov;
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
    view.fov = pose.fov;
    view.horizon = horizonDistance(R, Math.max(0, altSea));
    view.street = s.logAltTarget <= LOG_MIN + 1e-3 && s.logAlt < LOG_MIN + 0.05;
    fromSphere(s.focus, plan);
    view.cityX = plan.x;
    view.cityZ = plan.z;
    view.cityDist = Math.hypot(plan.x, plan.z);
    ctx.uniforms.lbCamAlt.value = view.altTerrain;
    ctx.uniforms.lbCamPos.value.copy(cam.position);
  }

  function startFly(dir: Vec3, alt: number) {
    copy3(flyFrom, s.focus);
    copy3(flyTo, dir);
    flyLogFrom = s.logAlt;
    flyLogTo = Math.log(Math.min(ALT_MAX, Math.max(EYE_HEIGHT, alt)));
    const ang = angleBetween(flyFrom, flyTo);
    flyDur = 0.9 + Math.min(1.4, ang * 1.2) + Math.abs(flyLogTo - flyLogFrom) * 0.12;
    flyT = 0;
    inertiaRate = 0;
    anchorOn = false;
  }

  function handleInput(ctx: LBContext, dt: number) {
    const inp = input!;
    const W = inp.width;
    const H = inp.height;
    const alt = Math.exp(s.logAlt);
    const w = lookBlend(alt);
    const any = inp.wheel !== 0 || inp.pinch !== 1 || inp.dragging || inp.lockDX !== 0 || inp.lockDY !== 0 || inp.doubleClick;

    // Zoom: wheel / pinch / keys move the log-altitude target; zoom toward the cursor.
    let dz = 0;
    if (inp.wheel !== 0) dz += inp.wheel * 0.0016;
    if (inp.pinch !== 1) dz -= Math.log(inp.pinch) * 1.6;
    const zoomKeys = (inp.key('KeyE') || inp.key('Equal') || inp.key('NumpadAdd') ? -1 : 0) + (inp.key('KeyQ') || inp.key('Minus') || inp.key('NumpadSubtract') ? 1 : 0);
    if (zoomKeys) dz += zoomKeys * dt * 1.4;
    if (dz !== 0) {
      s.logAltTarget = Math.min(LOG_MAX, Math.max(LOG_MIN, s.logAltTarget + dz));
      flyT = -1;
      interacted = true;
      const at = inp.pinch !== 1 ? inp.pinchAt : inp.wheelAt;
      if ((inp.wheel !== 0 || inp.pinch !== 1) && w < 0.6 && pick(ctx, at.x, at.y, W, H, anchor)) anchorOn = true;
      else if (zoomKeys) anchorOn = false;
    }

    // Drag: grab-spin in orbit, look-around near the ground, blended by altitude.
    if (inp.dragStarted) {
      inertiaRate = 0;
      flyT = -1;
      grabRadius = pickRadius(ctx);
      hasGrab = pick(ctx, inp.cursor.x, inp.cursor.y, W, H, grab, grabRadius);
    }
    if (inp.dragging && (inp.dragDX !== 0 || inp.dragDY !== 0)) {
      interacted = true;
      if (w < 1 && hasGrab && pick(ctx, inp.cursor.x, inp.cursor.y, W, H, tA, grabRadius)) {
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
        // Look-around: yaw turns the heading itself (so it survives lifting off), pitch is an
        // offset on top of the altitude curve.
        const k = ((pose.fov * DEG) / H) * w;
        rotateAxis(s.fwd, s.fwd, s.focus, inp.dragDX * k);
        orthonormalizeTangent(s.fwd, s.focus);
        s.lookPitch += inp.dragDY * k;
      }
    }
    if (inp.dragEnded) {
      hasGrab = false;
      // Release with inertia only if the pointer was still moving.
      if (Math.abs(inertiaRate) < 0.02) inertiaRate = 0;
    } else if (!inp.dragging && inertiaRate !== 0) {
      rotateState(inertiaAxis, inertiaRate * dt);
      inertiaRate *= Math.exp(-dt * (ctx.reducedMotion ? 6 : 3.2));
      if (Math.abs(inertiaRate) < 0.002) inertiaRate = 0;
    }
    if (inp.dragging && inp.dragDX === 0 && inp.dragDY === 0) inertiaRate *= Math.exp(-dt * 12);

    // Pointer lock look (page variant, at street level).
    if (inp.lockDX !== 0 || inp.lockDY !== 0) {
      const k = (pose.fov * DEG) / H;
      rotateAxis(s.fwd, s.fwd, s.focus, -inp.lockDX * k);
      orthonormalizeTangent(s.fwd, s.focus);
      s.lookPitch -= inp.lockDY * k;
    }
    s.lookPitch = Math.max(-80 * DEG, Math.min(75 * DEG, s.lookPitch));
    if (inp.click && ctx.variant === 'page' && w > 0.9) inp.requestLock();

    // Double-click: fly to the point.
    if (inp.doubleClick && pick(ctx, inp.doubleAt.x, inp.doubleAt.y, W, H, tB)) {
      startFly(tB, Math.max(EYE_HEIGHT, Math.min(alt * 0.4, 60)));
      interacted = true;
    }

    // WASD / arrows: walk at street level, pan (scaled by altitude) above it.
    const fwdIn = (inp.key('KeyW') || inp.key('ArrowUp') ? 1 : 0) - (inp.key('KeyS') || inp.key('ArrowDown') ? 1 : 0);
    const sideIn = (inp.key('KeyD') || inp.key('ArrowRight') ? 1 : 0) - (inp.key('KeyA') || inp.key('ArrowLeft') ? 1 : 0);
    if (fwdIn || sideIn) {
      interacted = true;
      flyT = -1;
      const run = inp.key('ShiftLeft') || inp.key('ShiftRight');
      const speed = w > 0.95 ? (run ? RUN : WALK) : Math.max(WALK, alt * 0.9) * (run ? 2 : 1);
      // Move direction: the view heading (fwd turned by the look yaw).
      copy3(tA, s.fwd);
      rotateAxis(tA, tA, s.focus, -w * s.lookYaw);
      orthonormalizeTangent(tA, s.focus);
      cross3(tB, tA, s.focus); // right = fwd × up
      normalize3(tB);
      const l = Math.hypot(fwdIn, sideIn);
      const mx = (tA.x * fwdIn + tB.x * sideIn) / l;
      const my = (tA.y * fwdIn + tB.y * sideIn) / l;
      const mz = (tA.z * fwdIn + tB.z * sideIn) / l;
      axis.x = mx;
      axis.y = my;
      axis.z = mz;
      const step = speed * dt;
      // Geodesic move of the focus along the move direction, carrying fwd with it.
      const ang = step / (R + s.ground);
      cross3(tB, s.focus, axis); // rotation axis
      normalize3(tB);
      const oldX = s.focus.x;
      const oldY = s.focus.y;
      const oldZ = s.focus.z;
      rotateState(tB, ang);
      // Walls: slide along building footprints at street level.
      if (w > 0.9) {
        fromSphere(s.focus, plan);
        if (plan.x * plan.x + plan.z * plan.z < (CITY_PLAN_RADIUS + 5) ** 2 && ctx.world.cityIndex.collide(plan.x, plan.z, BODY_R, planOut)) {
          planToDir(planOut.x, planOut.z, s.focus);
          orthonormalizeTangent(s.fwd, s.focus);
        }
        // Never walk into the sea.
        if (ctx.world.planet.heightAt(s.focus) < -0.2) {
          s.focus.x = oldX;
          s.focus.y = oldY;
          s.focus.z = oldZ;
          orthonormalizeTangent(s.fwd, s.focus);
        }
      }
    }
    if (inp.key('Space') && w > 0.95 && s.jump === 0 && s.jumpVel === 0) s.jumpVel = JUMP_V;
    if (any && s.overrideWeight > 0) interacted = true;
  }

  return {
    name: 'camera',
    stage: 1,
    init(ctx) {
      input = new CameraInput(ctx.canvas, ctx.variant);
      ctx.services.camera = {
        setView: (v, o) => setView(ctx, v, o?.glide),
        getView: () => {
          latLonFromDir(s.focus, ll);
          return { lat: ll.lat, lon: ll.lon, alt: Math.exp(s.logAlt), heading: pose.heading / DEG, pitch: pose.pitch / DEG };
        },
        flyTo: (dir, alt) => startFly(dir, alt ?? Math.exp(s.logAlt)),
        releaseLock: () => input?.releaseLock(),
        lastInputAt: () => input?.lastInput ?? 0,
      };
      setView(ctx, { lat: 20, lon: 10, alt: 380, heading: 0 });
    },
    update(ctx) {
      const dt = ctx.time.realDt;
      if (input && !ctx.debug.cameraLocked) handleInput(ctx, dt);

      // Fly-to: slerp the focus with an ease, arc the altitude up and back down.
      if (flyT >= 0) {
        flyT = Math.min(1, flyT + dt / (ctx.reducedMotion ? flyDur * 1.4 : flyDur));
        const e = flyT * flyT * (3 - 2 * flyT);
        const ang = angleBetween(s.focus, flyTo);
        slerpDir(tA, flyFrom, flyTo, e);
        // Move the state (carrying fwd) to the slerped point.
        const a = arc(s.focus, tA, axis);
        rotateState(axis, a);
        const hop = Math.min(1.2, ang * 1.5) * Math.sin(Math.PI * flyT);
        s.logAltTarget = Math.min(LOG_MAX, flyLogFrom + (flyLogTo - flyLogFrom) * e + hop);
        if (flyT >= 1) {
          flyT = -1;
          s.logAltTarget = flyLogTo;
        }
      }

      // Altitude spring (critically damped, in log space).
      const omega = ctx.reducedMotion ? 4 : 6.5;
      springStep(s.logAlt, s.logAltVel, s.logAltTarget, omega, dt, spring);
      s.logAlt = Math.min(LOG_MAX, Math.max(LOG_MIN, spring[0]));
      s.logAltVel = spring[1];
      // Zoom toward the anchor: move the focus by the fraction of altitude just lost.
      const dLog = s.logAlt - lastLogAlt;
      lastLogAlt = s.logAlt;
      if (anchorOn) {
        const frac = 1 - Math.exp(dLog);
        const ang = arc(s.focus, anchor, axis);
        if (ang > 1e-6 && Math.abs(frac) > 1e-7) rotateState(axis, ang * Math.max(-1, Math.min(0.9, frac)));
        if (Math.abs(s.logAltTarget - s.logAlt) < 1e-3) anchorOn = false;
      }

      // Pitch override (setView) blends back to the altitude curve once the user interacts.
      if (interacted && s.overrideWeight > 0) {
        s.overrideWeight = Math.max(0, s.overrideWeight - dt * 2);
      }
      // Look offsets relax when climbing away from the ground.
      const w = lookBlend(Math.exp(s.logAlt));
      if (w < 0.02) {
        s.lookPitch *= Math.exp(-dt * 2);
        s.lookYaw *= Math.exp(-dt * 2);
      }

      // Ground reference (terrain / city ground) and the roof-clearing lift.
      stepReference(ctx, Math.exp(s.logAlt), dt);

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
      input?.endFrame();
    },
    dispose() {
      input?.dispose();
      input = null;
    },
  };
}
