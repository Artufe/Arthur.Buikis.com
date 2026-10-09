// The camera director end to end (D1): the real camera system against the real world, a synthetic
// plane and walker registered on the real track service, stepped at 60 fps (no renderer). Guards
// the hand-overs: entering a ride, cycling, the bird, and back to explore never jump.

import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { LBContext, TrackPose, Trackable } from '../../core/contracts';
import { createTrackService } from '../../core/track';
import { getCityIndex, getCityPlan } from '../../world/city';
import { fromSphere, planHeadingToWorld, planToDir } from '../../world/city/frame';
import { PLATEAU_HEIGHT, R, SEED } from '../../world/config';
import { getPlanet } from '../../world/planet';
import { dirFromLatLon } from '../../world/sphere';
import { sunDirection } from '../../world/sun';
import { createCameraSystem } from '../index';
import { birdRender } from '../bird/shared';
import { BIRD_CAM } from '../bird/cam';
import type { Director } from '../director';

const W = 1280;
const H = 800;
const DT = 1 / 60;

function setup() {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: W });
  Object.defineProperty(canvas, 'clientHeight', { value: H });
  document.body.appendChild(canvas);
  const camera = new PerspectiveCamera(40, W / H, 0.1, 1000);
  const s = sunDirection(0);
  const ctx = {
    canvas,
    variant: 'window',
    reducedMotion: false,
    world: { seed: SEED, planet: getPlanet(SEED), city: getCityPlan(), cityIndex: getCityIndex() },
    services: {},
    uniforms: { lbSunDir: { value: new Vector3(s.x, s.y, s.z) }, lbCamAlt: { value: 0 }, lbCamPos: { value: new Vector3() } },
    camera,
    view: { eye: new Vector3(), forward: new Vector3(), focus: new Vector3(), mode: 'explore', ride: null },
    debug: { cameraLocked: false },
    time: { realDt: DT, dt: DT, frozen: false, render: 0 },
  } as unknown as LBContext;
  (ctx.services as { track: unknown }).track = createTrackService(ctx);
  const sys = createCameraSystem();
  sys.init!(ctx);
  const step = () => {
    (ctx.time as { render: number }).render += DT;
    sys.update!(ctx);
  };
  return { ctx, sys, step, canvas };
}

/** A plane on a circle 70 m up through the city, 18 m/s. */
function plane(): Trackable {
  const c = new Vector3();
  const centre = planToDir(0, 0);
  c.set(centre.x, centre.y, centre.z);
  const ax = new Vector3(0, 1, 0).cross(c).normalize();
  return {
    id: 'plane:900',
    kind: 'plane',
    label: 'test plane',
    view: 'chase',
    radius: 4.6,
    pose(cx: LBContext, out: TrackPose) {
      const th = (cx.time.render * 18) / (R + 70);
      out.up.copy(c).applyAxisAngle(ax, th);
      out.pos.copy(out.up).multiplyScalar(R + 70);
      out.fwd.crossVectors(ax, out.up).normalize();
      out.speed = 18;
      return true;
    },
  };
}

/** A walker strolling a straight line across the plaza at eye height, 1.3 m/s. */
function walker(): Trackable {
  return {
    id: 'person:900',
    kind: 'person',
    label: 'test walker',
    view: 'eyes',
    radius: 0.8,
    pose(cx: LBContext, out: TrackPose) {
      const x = -6 + ((cx.time.render * 1.3) % 12);
      const d = planToDir(x, 2);
      out.up.set(d.x, d.y, d.z);
      out.pos.copy(out.up).multiplyScalar(R + PLATEAU_HEIGHT + 0.2 + 1.55);
      const d2 = planToDir(x + 0.1, 2);
      out.fwd.set(d2.x - d.x, d2.y - d.y, d2.z - d.z);
      out.fwd.addScaledVector(out.up, -out.fwd.dot(out.up)).normalize();
      out.speed = 1.3;
      return true;
    },
  };
}

/**
 * Run n frames. Returns the worst velocity change between frames relative to the camera's speed
 * scale (a jump shows as a spike: one frame's change far above its neighbours'), the worst absolute
 * velocity change (m/s per frame) and the worst look turn per frame (rad).
 */
function watch(step: () => void, ctx: LBContext, n: number) {
  const prev = ctx.camera.position.clone();
  const prevF = new Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
  const vs: Vector3[] = [];
  let worstTurn = 0;
  for (let i = 0; i < n; i++) {
    step();
    vs.push(ctx.camera.position.clone().sub(prev).divideScalar(DT));
    prev.copy(ctx.camera.position);
    const f = new Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    worstTurn = Math.max(worstTurn, f.angleTo(prevF));
    prevF.copy(f);
    expect(Number.isFinite(ctx.camera.position.x + ctx.camera.quaternion.w)).toBe(true);
  }
  const acc = vs.slice(1).map((v, i) => v.distanceTo(vs[i]));
  let worstAcc = 0;
  let worstSpike = 0;
  for (let i = 0; i < acc.length; i++) {
    worstAcc = Math.max(worstAcc, acc[i]);
    // A spike: this frame's change against the larger of its neighbours' (+1 m/s of slack).
    const nb = Math.max(acc[i - 1] ?? 0, acc[i + 1] ?? 0);
    if (i > 0 && i < acc.length - 1) worstSpike = Math.max(worstSpike, acc[i] / (nb + 1));
  }

  return { worstAcc, worstSpike, worstTurn };
}

/** Distance (m) from a camera at world `pos` to the nearest facade taller than it (99 if none within 12 m). */
function facadeDist(ctx: LBContext, pos: Vector3): number {
  const d = pos.clone().normalize();
  const p = fromSphere(d);
  const hp = pos.length() - R - PLATEAU_HEIGHT;
  const idx = ctx.world.cityIndex;
  const near: number[] = [];
  const tall = (r: number) => {
    const n = idx.buildingsNear(p.x, p.z, r, near);
    for (let i = 0; i < n; i++) if (idx.plan.buildings[near[i]].h > hp - 0.2) return true;
    return false;
  };
  if (!tall(12)) return 99;
  let lo = 0;
  let hi = 12;
  for (let k = 0; k < 14; k++) {
    const m = (lo + hi) / 2;
    if (tall(m)) hi = m;
    else lo = m;
  }
  return hi;
}

/** A walker standing on a sidewalk about `dist` m from plan point (x, z), facing away from it. */
function standing(ctx: LBContext, x: number, z: number, dist: number, toward = false): Trackable {
  const idx = ctx.world.cityIndex;
  let wx = x;
  let wz = z;
  // (Facing the camera: somewhere with room behind them — no building within 14 m further out.)
  const roomBehind = (px: number, pz: number, ux: number, uz: number) => {
    for (let s = 2; s <= 14; s += 1) if (idx.roofAt(px + ux * s, pz + uz * s) > 0) return false;
    return true;
  };
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const px = x + Math.cos(a) * dist;
    const pz = z + Math.sin(a) * dist;
    if (idx.classify(px, pz) === 'sidewalk' && !idx.collide(px, pz, 0.6, { x: 0, z: 0 }) && (!toward || roomBehind(px, pz, Math.cos(a), Math.sin(a)))) {
      wx = px;
      wz = pz;
      break;
    }
  }
  const d = planToDir(wx, wz);
  const d2 = planToDir(wx + (wx - x) * 0.01, wz + (wz - z) * 0.01);
  return {
    id: 'person:901',
    kind: 'person',
    label: 'test walker',
    view: 'eyes',
    radius: 0.8,
    pose(_cx: LBContext, out: TrackPose) {
      out.up.set(d.x, d.y, d.z);
      out.pos.copy(out.up).multiplyScalar(R + PLATEAU_HEIGHT + 0.2 + 1.55);
      out.fwd.set(d2.x - d.x, d2.y - d.y, d2.z - d.z);
      out.fwd.addScaledVector(out.up, -out.fwd.dot(out.up)).normalize();
      if (toward) out.fwd.negate();
      out.speed = 0;
      return true;
    },
  };
}

/** The camera's turn per frame (rad) is capped at 240°/s in a transition (D1f r5; 210 in r4, 190 before): 4° a frame at 60 fps. */
const TURN_FRAME = (242 * Math.PI) / 180 / 60;

/** A car driving a street at 9 m/s that turns 90° half way (the prediction goes straight on). */
function turningCar(): Trackable {
  return {
    id: 'car:900',
    kind: 'car',
    label: 'test car',
    view: 'chase',
    radius: 2.3,
    pose(cx: LBContext, out: TrackPose) {
      const t = cx.time.render;
      const s = t * 9;
      const x = s < 30 ? -30 + s : 0;
      const z = s < 30 ? -20 : -20 + (s - 30);
      const d = planToDir(x, z);
      const d2 = s < 30 ? planToDir(x + 0.1, z) : planToDir(x, z + 0.1);
      out.up.set(d.x, d.y, d.z);
      out.pos.copy(out.up).multiplyScalar(R + PLATEAU_HEIGHT + 0.7);
      out.fwd.set(d2.x - d.x, d2.y - d.y, d2.z - d.z);
      out.fwd.addScaledVector(out.up, -out.fwd.dot(out.up)).normalize();
      out.speed = 9;
      return true;
    },
  };
}

/**
 * Step until the transition settles (≤ n frames): the worst turn (rad/s) and the worst change of the
 * angular velocity from one frame to the next (rad/s per frame).
 */
function turns(step: () => void, ctx: LBContext, cam: LBContext['services']['camera'], n: number) {
  const prevQ = ctx.camera.quaternion.clone();
  let prevW: Vector3 | null = null;
  let worstRate = 0;
  let worstJerk = 0;
  const q = new Quaternion();
  for (let i = 0; i < n && cam.mode!().blend < 1; i++) {
    step();
    q.copy(prevQ).invert().premultiply(ctx.camera.quaternion);
    if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    const sn = Math.hypot(q.x, q.y, q.z);
    const ang = 2 * Math.atan2(sn, q.w);
    const w = sn > 1e-9 ? new Vector3(q.x, q.y, q.z).multiplyScalar(ang / sn / DT) : new Vector3();
    worstRate = Math.max(worstRate, w.length());
    if (prevW) worstJerk = Math.max(worstJerk, w.distanceTo(prevW));
    prevW = w;
    prevQ.copy(ctx.camera.quaternion);
  }
  return { worstRate, worstJerk };
}

const DEG = Math.PI / 180;

/** The `street` shot's placement (core/shots.ts streetView: A2's viewpoint stepped 0.9 m, turned 6°). */
function streetShot(ctx: LBContext) {
  const vp = ctx.world.city.viewpoints.street;
  const x = vp.x + Math.cos(vp.heading) * 0.9;
  const z = vp.z + Math.sin(vp.heading) * 0.9;
  const d = planToDir(x, z);
  const heading = (planHeadingToWorld(x, z, vp.heading + 6 * DEG) * 180) / Math.PI;
  ctx.services.camera.setView({ lat: (Math.asin(d.y) * 180) / Math.PI, lon: (Math.atan2(d.x, d.z) * 180) / Math.PI, alt: 1.7, heading });
}

const directorOf = (ctx: LBContext) => (ctx.services.camera as unknown as { director: Director }).director;

/**
 * A car driving a real downtown lane of the city plan at 7 m/s from its start (the longest lane
 * whose middle is within 60 m of the centre), holding at its end. `at(s)` gives a plan point s m
 * along it.
 */
function laneCar(ctx: LBContext): Trackable & { at(s: number): { x: number; z: number; fx: number; fz: number } } {
  const lanes = ctx.world.city.lanes.filter((l) => {
    const p = l.path.pts;
    const m = (p.length >> 2) << 1;
    return l.path.length > 50 && Math.hypot(p[m], p[m + 1]) < 60;
  });
  lanes.sort((a, b) => b.path.length - a.path.length);
  const path = lanes[0].path;
  const at = (s: number) => {
    const S = Math.max(0, Math.min(path.length - 0.01, s));
    let i = 0;
    while (i < path.s.length - 2 && path.s[i + 1] < S) i++;
    const f = (S - path.s[i]) / Math.max(1e-6, path.s[i + 1] - path.s[i]);
    const x0 = path.pts[i * 2];
    const z0 = path.pts[i * 2 + 1];
    const x1 = path.pts[i * 2 + 2];
    const z1 = path.pts[i * 2 + 3];
    const l = Math.hypot(x1 - x0, z1 - z0) || 1;
    return { x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f, fx: (x1 - x0) / l, fz: (z1 - z0) / l };
  };
  return {
    id: 'car:901',
    kind: 'car',
    label: 'test car',
    view: 'chase',
    radius: 2.3,
    at,
    pose(cx: LBContext, out: TrackPose) {
      const p = at(cx.time.render * 7);
      const d = planToDir(p.x, p.z);
      const d2 = planToDir(p.x + p.fx * 0.1, p.z + p.fz * 0.1);
      out.up.set(d.x, d.y, d.z);
      out.pos.copy(out.up).multiplyScalar(R + PLATEAU_HEIGHT + 0.7);
      out.fwd.set(d2.x - d.x, d2.y - d.y, d2.z - d.z);
      out.fwd.addScaledVector(out.up, -out.fwd.dot(out.up)).normalize();
      out.speed = 7;
      return true;
    },
  };
}

/** Place the camera at plan point (x, z), alt m up, facing heading (deg). */
function placeAt(ctx: LBContext, x: number, z: number, alt: number, heading = 0) {
  const d = planToDir(x, z);
  ctx.services.camera.setView({ lat: (Math.asin(d.y) * 180) / Math.PI, lon: (Math.atan2(d.x, d.z) * 180) / Math.PI, alt, heading });
}

describe('camera director (system, 60 fps)', { timeout: 30_000 }, () => {
  it('every way in eases its turns: no hard stop in rotation, nothing near the turn cap', () => {
    const cases: Array<[string, (ctx: LBContext) => void]> = [
      ['orbit → plane', (ctx) => ctx.services.camera.setView({ lat: 10, lon: -20, alt: 380, heading: 0 })],
      ['high over the city → turning car', (ctx) => {
        const d = planToDir(20, 30);
        ctx.services.camera.setView({ lat: (Math.asin(d.y) * 180) / Math.PI, lon: (Math.atan2(d.x, d.z) * 180) / Math.PI, alt: 120, heading: 30 });
      }],
      ['street → walker 50 m off', (ctx) => {
        const vp = ctx.world.city.viewpoints.street;
        const vd = planToDir(vp.x + Math.cos(vp.heading) * 0.9, vp.z + Math.sin(vp.heading) * 0.9);
        ctx.services.camera.setView({ lat: (Math.asin(vd.y) * 180) / Math.PI, lon: (Math.atan2(vd.x, vd.z) * 180) / Math.PI, alt: 1.7, heading: 0 });
      }],
    ];
    for (const [name, place] of cases) {
      const { ctx, sys, step, canvas } = setup();
      const cam = ctx.services.camera;
      ctx.services.track.register(plane());
      ctx.services.track.register(turningCar());
      place(ctx);
      step();
      let id = name.includes('plane') ? 'plane:900' : 'car:900';
      if (name.includes('walker')) {
        const p0 = fromSphere(ctx.camera.position.clone().normalize());
        ctx.services.track.register(standing(ctx, p0.x, p0.z, 50));
        id = 'person:901';
      }
      expect(cam.ride!(id), name).toBe(true);
      const r = turns(step, ctx, cam, 500);
      expect(cam.mode!().blend, name).toBe(1);
      // (D1f: snappier trips. The follower caps at 240°/s and 2000°/s² (D1f r5; 210 / 1700 in r4,
      // 190 / 1500 before): 33°/s a frame; the plan keeps under ~150°/s where it has the time.)
      expect(r.worstRate, name).toBeLessThan(245 * DEG);
      expect(r.worstJerk, name).toBeLessThan(40 * DEG);
      sys.dispose!(ctx);
      canvas.remove();
    }
  });

  it('Esc half way through a fast trip glides on and bleeds the speed off: never a dead stop', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    ctx.services.track.register(plane());
    cam.setView({ lat: 10, lon: -20, alt: 380, heading: 0 });
    step();
    cam.ride!('plane:900');
    const prev = ctx.camera.position.clone();
    let v = 0;
    for (let i = 0; i < 70; i++) {
      step();
      v = ctx.camera.position.distanceTo(prev) / DT;
      prev.copy(ctx.camera.position);
    }
    expect(v).toBeGreaterThan(60); // it was really moving
    cam.exitMode!();
    let last = v;
    for (let i = 0; i < 120; i++) {
      step();
      const vi = ctx.camera.position.distanceTo(prev) / DT;
      prev.copy(ctx.camera.position);
      // Each frame keeps most of the last one's speed (an exponential bleed, no step to zero)...
      if (last > 5) expect(vi, `frame ${i}`).toBeGreaterThan(last * 0.75);
      last = vi;
    }
    // ...and it comes to rest, looking down at the world.
    expect(last).toBeLessThan(3);
    expect(ctx.view.pitch).toBeLessThan(-10 * DEG);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('rides a plane from orbit along a smooth arc, follows it, and hands back to explore without a jump', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    ctx.services.track.register(plane());
    cam.setView({ lat: 10, lon: -20, alt: 380, heading: 0 });
    step();
    expect(cam.ride!('plane:900')).toBe(true);
    expect(cam.mode!().mode).toBe('ride');
    expect(ctx.view.mode).toBe('ride');
    expect(ctx.view.ride).toBe('plane:900');
    // The transition: no velocity jump bigger than a few m/s per frame across a ~300 m trip.
    const enter = watch(step, ctx, 200);
    expect(cam.mode!().blend).toBe(1);
    // (A trip over the planet peaks near 400 m/s: no single frame jumps out of it.)
    expect(enter.worstSpike).toBeLessThan(2);
    expect(enter.worstTurn).toBeLessThan(TURN_FRAME);
    // Riding: framed at first from the side it came from, then swung round behind it; the plane in
    // front of the lens.
    for (let i = 0; i < 60 * 5; i++) step();
    const p: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
    ctx.services.track.get('plane:900')!.pose(ctx, p);
    const toPlane = p.pos.clone().sub(ctx.camera.position);
    expect(toPlane.dot(p.fwd)).toBeGreaterThan(0);
    expect(toPlane.length()).toBeLessThan(30);
    // Esc-style exit: explore takes over where the camera comes to rest.
    cam.exitMode!();
    expect(cam.mode!().mode).toBe('explore');
    expect(ctx.view.ride).toBe(null);
    const exit = watch(step, ctx, 180);
    expect(exit.worstAcc).toBeLessThan(1.5); // gliding to rest from 18 m/s: no jolt
    expect(exit.worstSpike).toBeLessThan(2);
    expect(exit.worstTurn).toBeLessThan(0.06);
    // It ended up exploring near where it left (coasted a few metres), at about the plane's height.
    expect(ctx.camera.position.distanceTo(p.pos)).toBeLessThan(40);
    expect(ctx.view.alt).toBeGreaterThan(50);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('rides a walker into their eyes (the body hidden), and the walker cannot be ridden once unregistered', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    const w = walker();
    let ridden = false;
    w.setRidden = (on) => (ridden = on);
    const off = ctx.services.track.register(w);
    const d = planToDir(0, -8);
    const ll = { lat: (Math.asin(d.y) * 180) / Math.PI, lon: (Math.atan2(d.x, d.z) * 180) / Math.PI };
    cam.setView({ lat: ll.lat, lon: ll.lon, alt: 14, heading: 0 });
    step();
    expect(cam.ride!('person:900')).toBe(true);
    const enter = watch(step, ctx, 200);
    for (let i = 0; i < 200 && cam.mode!().blend < 1; i++) step();
    expect(enter.worstSpike).toBeLessThan(2);
    expect(enter.worstTurn).toBeLessThan(TURN_FRAME);
    const p: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
    w.pose(ctx, p);
    expect(ctx.camera.position.distanceTo(p.pos)).toBeLessThan(0.3);
    expect(ridden).toBe(true);
    // (D1f r2) Settled in the eyes the near plane steps out over half a second — a crown, a lamp
    // post or a bench at the lens is clipped — never so far it cuts the ground (≥ 1.4 m off) or a
    // passer-by's head open (D1f r5: 0.5 m, L1f's ride measurements).
    for (let i = 0; i < 40; i++) step();
    expect(ctx.camera.near).toBeGreaterThan(0.45);
    expect(ctx.camera.near).toBeLessThanOrEqual(0.5);
    // Gone (its owner unregistered it): the ride lets go, the body is shown again.
    off();
    step();
    expect(cam.mode!().mode).toBe('explore');
    expect(ridden).toBe(false);
    expect(cam.ride!('person:900')).toBe(false);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('flies the bird from the street and lands back in explore', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    const d = planToDir(10, 30);
    cam.setView({ lat: (Math.asin(d.y) * 180) / Math.PI, lon: (Math.atan2(d.x, d.z) * 180) / Math.PI, alt: 1.7, heading: 90 });
    step();
    cam.fly!();
    expect(cam.mode!().mode).toBe('bird');
    const fly = watch(step, ctx, 240);
    expect(fly.worstSpike).toBeLessThan(2.5);
    expect(fly.worstTurn).toBeLessThan(TURN_FRAME);
    const rs = birdRender(ctx);
    expect(rs.show).toBe(true);
    expect(rs.scale).toBeGreaterThan(0.9);
    // The camera never dipped under the ground or a roof on the way.
    expect(ctx.view.altTerrain).toBeGreaterThan(0.5);
    cam.exitMode!();
    watch(step, ctx, 120);
    expect(cam.mode!().mode).toBe('explore');
    // The bird flew off and popped away after a while.
    for (let i = 0; i < 60 * 9; i++) step();
    expect(rs.show).toBe(false);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('from the street, pops up clear of the facade beside it and never skims another on the way to a walker', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    // The `street` shot's viewpoint (core/shots.ts streetView, a sidewalk beside a facade).
    const vp = ctx.world.city.viewpoints.street;
    const vd = planToDir(vp.x + Math.cos(vp.heading) * 0.9, vp.z + Math.sin(vp.heading) * 0.9);
    cam.setView({ lat: (Math.asin(vd.y) * 180) / Math.PI, lon: (Math.atan2(vd.x, vd.z) * 180) / Math.PI, alt: 1.7, heading: 0 });
    step();
    const start = ctx.camera.position.clone();
    const startFacade = facadeDist(ctx, start);
    const p0 = fromSphere(start.clone().normalize());
    ctx.services.track.register(standing(ctx, p0.x, p0.z, 60));
    expect(cam.ride!('person:901')).toBe(true);
    let worstFar = 99;
    let worstNear = 99;
    let worstTurn = 0;
    const prevF = new Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    for (let i = 0; i < 400 && cam.mode!().blend < 1; i++) {
      step();
      const pos = ctx.camera.position;
      const f = facadeDist(ctx, pos);
      // Next to the start (rising out of the street) it may not come any closer than it was;
      // anywhere else on the way, at least 2 m from any facade taller than the lens.
      const up = start.clone().normalize();
      const off = pos.clone().sub(start).addScaledVector(up, -pos.clone().sub(start).dot(up)).length();
      if (off < 3) worstNear = Math.min(worstNear, f);
      else if (pos.distanceTo(ctx.view.eye) >= 0 && cam.mode!().blend < 0.97) worstFar = Math.min(worstFar, f);
      const fw = new Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      worstTurn = Math.max(worstTurn, fw.angleTo(prevF));
      prevF.copy(fw);
    }
    expect(cam.mode!().blend).toBe(1);
    expect(worstNear).toBeGreaterThanOrEqual(Math.min(startFacade, 2) - 0.05);
    expect(worstFar).toBeGreaterThan(2);
    expect(worstTurn).toBeLessThan(TURN_FRAME);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('the wheel stops at the widest framing: one flick holds there, a new gesture leaves', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    ctx.services.track.register(plane());
    cam.setView({ lat: 10, lon: -20, alt: 380, heading: 0 });
    step();
    cam.ride!('plane:900');
    for (let i = 0; i < 200; i++) step();
    const wheel = (dy: number) => canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
    // A long flick: 15 notches over a quarter of a second (it reaches the stop half way).
    for (let i = 0; i < 15; i++) {
      wheel(120);
      step();
    }
    expect(cam.mode!().mode).toBe('ride');
    // A rest at the stop, then the next notch leaves.
    for (let i = 0; i < 30; i++) step();
    wheel(120);
    step();
    expect(cam.mode!().mode).toBe('explore');
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('rides arrive settled: once the blend reports 1 the view turns < 15°/s over the next second', () => {
    // (The car cases start in front of it, so the way in has to come round behind it.)
    const ahead = (ctx: LBContext, alt: number) => {
      const p = laneCar(ctx).at(7 * 2.5 + 35);
      placeAt(ctx, p.x, p.z, alt, 0);
    };
    const cases: Array<[string, string, (ctx: LBContext) => void]> = [
      ['orbit → plane', 'plane:900', (ctx) => ctx.services.camera.setView({ lat: 10, lon: -20, alt: 380, heading: 0 })],
      ['high over the city → an oncoming car', 'car:901', (ctx) => ahead(ctx, 120)],
      ['rooftops → an oncoming car', 'car:901', (ctx) => ahead(ctx, 16)],
      ['street → walker 50 m off', 'person:901', streetShot],
    ];
    for (const [name, id, place] of cases) {
      const { ctx, sys, step, canvas } = setup();
      const cam = ctx.services.camera;
      ctx.services.track.register(plane());
      ctx.services.track.register(laneCar(ctx));
      place(ctx);
      step();
      if (id === 'person:901') {
        const p0 = fromSphere(ctx.camera.position.clone().normalize());
        ctx.services.track.register(standing(ctx, p0.x, p0.z, 50));
      }
      expect(cam.ride!(id), name).toBe(true);
      let frames = 0;
      while (cam.mode!().blend < 1 && frames < 400) {
        step();
        frames++;
      }
      // Snappy (D1f r5): landed by 2.5 s from the click whatever happens on the way — a car that
      // turns off its predicted course may slow the clock (stepEnter), only within that.
      expect(frames / 60, name).toBeLessThanOrEqual(2.5);
      // (Over and above what the ridden thing itself turns: a car rounding a bend is followed.)
      const prevQ = ctx.camera.quaternion.clone();
      const tp: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
      const t = ctx.services.track.get(id)!;
      t.pose(ctx, tp);
      const f0 = tp.fwd.clone();
      let worst = 0;
      for (let i = 0; i < 60; i++) {
        step();
        worst = Math.max(worst, prevQ.angleTo(ctx.camera.quaternion) / DT);
        prevQ.copy(ctx.camera.quaternion);
      }
      t.pose(ctx, tp);
      const own = f0.angleTo(tp.fwd); // rad over the second
      expect(worst, name).toBeLessThan(15 * DEG + own);
      sys.dispose!(ctx);
      canvas.remove();
    }
  });

  it('once what it rides is in frame it stays in frame: orbit → plane', () => {
    // (D1f r3: the gaze stayed on the planet while the plane slid out of the top of the frame for a
    // second; the transition's gaze now holds it within 20° once it is in, timed like any turn.)
    // (Two ways in where the plane left the frame for 15–17 % of the trip without the hold.)
    for (const v of [{ lat: -15, lon: 30, alt: 380, heading: 180 }, { lat: 20, lon: -40, alt: 120, heading: 45 }]) {
      const { ctx, sys, step, canvas } = setup();
      const cam = ctx.services.camera;
      ctx.services.track.register(plane());
      cam.setView(v);
      step();
      expect(cam.ride!('plane:900')).toBe(true);
      const tp: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
      const t = ctx.services.track.get('plane:900')!;
      let seen = false;
      let after = 0;
      let lost = 0;
      let frames = 0;
      while (cam.mode!().blend < 1 && frames < 400) {
        step();
        frames++;
        t.pose(ctx, tp);
        const nd = tp.pos.clone().project(ctx.camera);
        const inFrame = Math.abs(nd.x) < 1 && Math.abs(nd.y) < 1 && nd.z < 1;
        if (inFrame) seen = true;
        if (seen) {
          after++;
          if (!inFrame) lost++;
        }
      }
      expect(seen).toBe(true);
      expect(lost / after, `${lost} of ${after} frames without the plane`).toBeLessThan(0.08);
      sys.dispose!(ctx);
      canvas.remove();
    }
  });

  it('a boat out at sea sailing at the camera: the swing round behind it keeps it in frame, the horizon level', () => {
    // (D1f r3: the swing round onto a boat that came at the camera spun a full barrel roll — the end
    // frame swung onto a gaze facing the other way is singular — the drawn camera fell behind, tipped
    // into the sea and lost the boat for 0.8 s.)
    const planet = getPlanet(SEED);
    const AHEAD = 110;
    let boatDir: Vector3 | null = null;
    let travel: Vector3 | null = null;
    for (let lat = -50; lat <= 50 && !boatDir; lat += 5) {
      for (let lon = -180; lon < 180 && !boatDir; lon += 5) {
        const b = new Vector3();
        dirFromLatLon(lat, lon, b);
        for (const az of [0, 90, 180, 270]) {
          const east = new Vector3(0, 1, 0).cross(b).normalize();
          const north = b.clone().cross(east);
          const t = east.clone().multiplyScalar(Math.cos((az * Math.PI) / 180)).addScaledVector(north, Math.sin((az * Math.PI) / 180));
          const axis = b.clone().cross(t).normalize();
          let sea = true;
          for (let k = -4; k <= 14 && sea; k++) {
            const d = b.clone().applyAxisAngle(axis, ((k / 12) * AHEAD) / R);
            for (const side of [-12, 0, 12]) if (planet.heightAt(d.clone().addScaledVector(t.clone().cross(d), side / R).normalize()) > -1.5) sea = false;
          }
          if (sea) {
            boatDir = b;
            travel = t;
            break;
          }
        }
      }
    }
    expect(boatDir, 'open sea').not.toBeNull();
    const b0 = boatDir!;
    const t0 = travel!;
    const axis = b0.clone().cross(t0).normalize();
    const boat: Trackable = {
      id: 'boat:900',
      kind: 'boat',
      label: 'test boat',
      view: 'chase',
      radius: 2.2,
      pose(cx: LBContext, out: TrackPose) {
        const a = (cx.time.render * 1.2) / R;
        out.up.copy(b0).applyAxisAngle(axis, a);
        out.pos.copy(out.up).multiplyScalar(R + 0.6);
        out.fwd.copy(t0).applyAxisAngle(axis, a);
        out.speed = 1.2;
        return true;
      },
    };
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    ctx.services.track.register(boat);
    // The camera 110 m ahead of it, 9 m over the sea, looking along its course (away from it).
    const c = b0.clone().applyAxisAngle(axis, AHEAD / R);
    const tc = t0.clone().applyAxisAngle(axis, AHEAD / R);
    const east = new Vector3(0, 1, 0).cross(c).normalize();
    const north = c.clone().cross(east);
    const heading = (Math.atan2(tc.dot(east), tc.dot(north)) * 180) / Math.PI;
    cam.setView({ lat: (Math.asin(c.y) * 180) / Math.PI, lon: (Math.atan2(c.x, c.z) * 180) / Math.PI, alt: 9, heading });
    step();
    expect(cam.ride!('boat:900')).toBe(true);
    const tp: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
    const f = new Vector3();
    const u = new Vector3();
    const r = new Vector3();
    let frames = 0;
    let worstRoll = 0;
    let lostLate = 0;
    let lateFrames = 0;
    while (cam.mode!().blend < 1 && frames < 400) {
      step();
      frames++;
      f.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      u.set(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
      r.copy(ctx.camera.position).normalize();
      // The roll off level (where level is defined: the gaze not within 25° of straight down).
      if (Math.abs(f.dot(r)) < Math.cos(25 * DEG)) {
        const right = f.clone().cross(r).normalize();
        worstRoll = Math.max(worstRoll, Math.abs(Math.asin(Math.max(-1, Math.min(1, u.dot(right))))));
      }
      if (cam.mode!().blend > 0.6) {
        boat.pose(ctx, tp);
        const nd = tp.pos.clone().project(ctx.camera);
        lateFrames++;
        if (!(Math.abs(nd.x) < 1 && Math.abs(nd.y) < 1 && nd.z < 1)) lostLate++;
      }
    }
    expect(frames / 60).toBeLessThan(2.6);
    expect(worstRoll / DEG).toBeLessThan(12);
    expect(lostLate, `${lostLate} of ${lateFrames} late frames without the boat`).toBe(0);
    // Settled: the view turns < 15°/s over the next second.
    const prevQ = ctx.camera.quaternion.clone();
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      step();
      worst = Math.max(worst, prevQ.angleTo(ctx.camera.quaternion) / DT);
      prevQ.copy(ctx.camera.quaternion);
    }
    expect(worst / DEG).toBeLessThan(15);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('near trips: a walker beside or behind the camera — turned to, then glided round, in frame once in', () => {
    // An open spot on a plaza (no building within 9 m).
    const idx = getCityIndex();
    const near: number[] = [];
    let P = { x: 0, z: 0 };
    for (let r = 0; r < 60 && P.x === 0; r += 1)
      for (let k = 0; k < 24; k++) {
        const x = Math.cos((k / 24) * Math.PI * 2) * r;
        const z = Math.sin((k / 24) * Math.PI * 2) * r;
        if (idx.classify(x, z) === 'plaza' && idx.buildingsNear(x, z, 9, near) === 0 && idx.isClear(x, z, 0.1)) {
          P = { x, z };
          break;
        }
      }
    expect(P.x !== 0 || P.z !== 0).toBe(true);
    /**
     * A walker at (a, b) m from P along the camera's (forward, right) in plan, walking along
     * (fa, fb) in the same frame at 1.3 m/s.
     */
    const walkerOff = (F: { x: number; z: number }, a: number, b: number, fa: number, fb: number, t0: number): Trackable => {
      const Rt = { x: -F.z, z: F.x };
      const dx = F.x * a + Rt.x * b;
      const dz = F.z * a + Rt.z * b;
      const wx = F.x * fa + Rt.x * fb;
      const wz = F.z * fa + Rt.z * fb;
      return {
        id: 'person:902',
        kind: 'person',
        label: 'near walker',
        view: 'eyes',
        radius: 0.8,
        pose(cx: LBContext, out: TrackPose) {
          const t = cx.time.render - t0;
          const x = P.x + dx + wx * 1.3 * t;
          const z = P.z + dz + wz * 1.3 * t;
          const d = planToDir(x, z);
          const d2 = planToDir(x + wx * 0.1, z + wz * 0.1);
          out.up.set(d.x, d.y, d.z);
          out.pos.copy(out.up).multiplyScalar(R + PLATEAU_HEIGHT + 0.2 + 1.55);
          out.fwd.set(d2.x - d.x, d2.y - d.y, d2.z - d.z);
          out.fwd.addScaledVector(out.up, -out.fwd.dot(out.up)).normalize();
          out.speed = 1.3;
          return true;
        },
      };
    };
    // Cases (forward, right, walking): 2 m behind walking across, 8 m ahead walking toward the
    // camera, 6 m off to the side walking away.
    const cases: Array<[string, number, number, number, number, boolean]> = [
      ['2 m behind', -2, 0.8, 0, 1, false],
      ['8 m ahead, oncoming', 8, 0.5, -1, 0, true],
      ['6 m off to the side, walking off', 5, -3.5, 0.6, -0.8, true],
    ];
    for (const [name, a, b, fa, fb, ahead] of cases) {
      const { ctx, sys, step, canvas } = setup();
      const cam = ctx.services.camera;
      const d = planToDir(P.x, P.z);
      cam.setView({ lat: (Math.asin(d.y) * 180) / Math.PI, lon: (Math.atan2(d.x, d.z) * 180) / Math.PI, alt: 1.7, heading: 30 });
      step();
      // The camera's forward in plan.
      const f3 = new Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      const p0 = fromSphere(ctx.camera.position.clone().normalize());
      const p1 = fromSphere(ctx.camera.position.clone().addScaledVector(f3, 1).normalize());
      const fl = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const F = { x: (p1.x - p0.x) / fl, z: (p1.z - p0.z) / fl };
      const w = walkerOff(F, a, b, fa, fb, (ctx.time as { render: number }).render);
      ctx.services.track.register(w);
      expect(cam.ride!(w.id), name).toBe(true);
      const tp: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
      const inFrame: boolean[] = [];
      let frames = 0;
      while (cam.mode!().blend < 1 && frames < 300) {
        step();
        frames++;
        w.pose(ctx, tp);
        const v = tp.pos.clone().addScaledVector(tp.up, -0.5).project(ctx.camera);
        inFrame.push(v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1);
      }
      expect(directorOf(ctx).plan.near, name + ' ' + directorOf(ctx).plan.nearWhy + ' ' + JSON.stringify(directorOf(ctx).plan.nearBlocked)).not.toBe(null);

      // Snappy: ≤ 2.2 s (+ the planning frames).
      expect(frames / 60, name).toBeLessThan(2.3);
      // In frame from when it first comes in until the drop into the eyes (the last ~0.55 s).
      const first = inFrame.indexOf(true);
      const until = Math.max(first, inFrame.length - 36);
      expect(first, name).toBeGreaterThanOrEqual(0);
      expect(inFrame.slice(first, until).filter(Boolean).length / Math.max(1, until - first), name).toBeGreaterThan(0.97);
      if (ahead) expect(inFrame.slice(0, until).filter(Boolean).length / Math.max(1, until), name).toBeGreaterThan(0.85);
      sys.dispose!(ctx);
      canvas.remove();
    }
  });

  it('reduced motion: a short direct move into the ride, no turn beyond the direct one', () => {
    const { ctx, sys, step, canvas } = setup();
    (ctx as { reducedMotion: boolean }).reducedMotion = true;
    const cam = ctx.services.camera;
    streetShot(ctx);
    step();
    const p0 = fromSphere(ctx.camera.position.clone().normalize());
    ctx.services.track.register(standing(ctx, p0.x, p0.z, 50));
    const q0 = ctx.camera.quaternion.clone();
    expect(cam.ride!('person:901')).toBe(true);
    const t = ctx.services.track.get('person:901')!;
    const tp: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
    t.pose(ctx, tp);
    const prevRel = ctx.camera.position.clone().sub(tp.pos);
    let frames = 0;
    let turned = 0;
    let worstStep = 0;
    let worstTurn = 0;
    let peaks = 0;
    const alts: number[] = [];
    const prevQ = ctx.camera.quaternion.clone();
    while (cam.mode!().blend < 1 && frames < 200) {
      step();
      frames++;
      const a = prevQ.angleTo(ctx.camera.quaternion);
      turned += a;
      prevQ.copy(ctx.camera.quaternion);
      // (D1f r5) What is seen (the canvas dimmed less than 70 %) barely moves: ≤ 0.1 m and 1° a frame
      // against the walker; the move itself is made while it is dim, over one single rise.
      t.pose(ctx, tp);
      const rel = ctx.camera.position.clone().sub(tp.pos);
      const op = canvas.style.opacity === '' ? 1 : parseFloat(canvas.style.opacity);
      if (op > 0.3) {
        worstStep = Math.max(worstStep, rel.distanceTo(prevRel));
        worstTurn = Math.max(worstTurn, a);
      }
      prevRel.copy(rel);
      alts.push(ctx.camera.position.length() - R);
    }
    for (let i = 1; i < alts.length - 1; i++) if (alts[i] > alts[i - 1] + 0.05 && alts[i] >= alts[i + 1]) peaks++;
    expect(frames / 60).toBeLessThanOrEqual(1.0);
    // All the turning it does is (about) the one from where it looked to where it looks now.
    expect(turned).toBeLessThan(q0.angleTo(ctx.camera.quaternion) * 1.25 + 0.1);
    expect(worstStep).toBeLessThanOrEqual(0.1);
    expect(worstTurn).toBeLessThanOrEqual(1 * DEG);
    expect(peaks).toBeLessThanOrEqual(1);
    expect(canvas.style.opacity).toBe('');
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('reduced motion: a short move with nothing in the way is made straight — no lift over the facade beside it', () => {
    const { ctx, sys, step, canvas } = setup();
    (ctx as { reducedMotion: boolean }).reducedMotion = true;
    const cam = ctx.services.camera;
    streetShot(ctx);
    step();
    const p0 = fromSphere(ctx.camera.position.clone().normalize());
    const idx = ctx.world.cityIndex;
    // (D1f r6) A walker 8–10 m along the pavement, no building on the line to them: the clearance
    // round the street camera — a facade a metre beside it — lifted this move 15 m and back down.
    let wx = NaN;
    let wz = NaN;
    for (let k = 0; k < 72 && Number.isNaN(wx); k++) {
      const a = (k / 72) * Math.PI * 2;
      for (const dist of [8, 10]) {
        const px = p0.x + Math.cos(a) * dist;
        const pz = p0.z + Math.sin(a) * dist;
        if (idx.classify(px, pz) !== 'sidewalk' || idx.collide(px, pz, 0.6, { x: 0, z: 0 })) continue;
        let clear = true;
        for (let s = 0; s <= 1 && clear; s += 0.05) if (idx.roofAt(p0.x + (px - p0.x) * s, p0.z + (pz - p0.z) * s) > 0) clear = false;
        if (clear) {
          wx = px;
          wz = pz;
          break;
        }
      }
    }
    expect(Number.isNaN(wx)).toBe(false);
    const d = planToDir(wx, wz);
    const d2 = planToDir(wx + (wx - p0.x) * 0.01, wz + (wz - p0.z) * 0.01);
    ctx.services.track.register({
      id: 'person:902',
      kind: 'person',
      label: 'test walker',
      view: 'eyes',
      radius: 0.8,
      pose(_cx: LBContext, out: TrackPose) {
        out.up.set(d.x, d.y, d.z);
        out.pos.copy(out.up).multiplyScalar(R + PLATEAU_HEIGHT + 0.2 + 1.55);
        out.fwd.set(d2.x - d.x, d2.y - d.y, d2.z - d.z);
        out.fwd.addScaledVector(out.up, -out.fwd.dot(out.up)).normalize();
        out.speed = 0;
        return true;
      },
    });
    const a0 = ctx.camera.position.length() - R;
    expect(cam.ride!('person:902')).toBe(true);
    let top = a0;
    let frames = 0;
    while (cam.mode!().blend < 1 && frames < 200) {
      step();
      frames++;
      top = Math.max(top, ctx.camera.position.length() - R);
    }
    const a1 = ctx.camera.position.length() - R;
    expect(top).toBeLessThanOrEqual(Math.max(a0, a1) + 0.3);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('a satellite at local midnight is framed against the stars over the limb, not on the night disc', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    streetShot(ctx);
    step();
    // (D1f r6) In the planet's shadow, no sunlit ground within its horizon: navy on the navy disc.
    const sun = (ctx.uniforms as { lbSunDir: { value: Vector3 } }).lbSunDir.value;
    const ax = new Vector3(0, 1, 0).cross(sun).normalize();
    ctx.services.track.register({
      id: 'satellite:900',
      kind: 'satellite',
      label: 'test satellite',
      view: 'alongside',
      radius: 3,
      pose(cx: LBContext, out: TrackPose) {
        const th = (cx.time.render * 20) / (R + 127);
        out.up.copy(sun).negate().applyAxisAngle(ax, th);
        out.pos.copy(out.up).multiplyScalar(R + 127);
        out.fwd.crossVectors(ax, out.up).normalize();
        out.speed = 20;
        return true;
      },
    });
    expect(cam.ride!('satellite:900')).toBe(true);
    for (let i = 0; i < 60 * 4 && cam.mode!().blend < 1; i++) step();
    for (let i = 0; i < 30; i++) step();
    const t = ctx.services.track.get('satellite:900')!;
    const tp: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
    t.pose(ctx, tp);
    // The line from the lens through it, beyond it: its closest approach to the planet's centre.
    const v = tp.pos.clone().sub(ctx.camera.position).normalize();
    const b = tp.pos.dot(v);
    const closest = tp.pos.clone().addScaledVector(v, Math.max(0, -b)).length() - R;
    expect(closest).toBeGreaterThan(25);
    // ...and the planet still fills the lower part of the frame (its limb in view).
    const down = tp.pos.clone().normalize().negate();
    const f = new Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    expect(f.dot(down)).toBeGreaterThan(Math.sin(25 * DEG));
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('a bird launched from the street shot: the boom is never pinned, its occlusion spring never winds up', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    streetShot(ctx);
    step();
    cam.fly!();
    const dir = directorOf(ctx);
    // The keys the critic held (A + S): steer left, descend.
    dir.override = { steer: -0.7, climb: -1, flap: false, dive: false };
    const want = BIRD_CAM.dist;
    let short = 0;
    let worstShort = 0;
    for (let i = 0; i < 60 * 8; i++) {
      step();
      const occ = dir.birdCam.occ;
      expect(Number.isFinite(occ)).toBe(true);
      expect(occ).toBeGreaterThanOrEqual(BIRD_CAM.minDist * 0.5 - 1e-9);
      expect(occ).toBeLessThanOrEqual(Math.exp(dir.birdCam.logDistT) * 1.5 + 1e-6);
      // (After the launch's own short boom eases out.)
      const boom = ctx.camera.position.distanceTo(dir.bird.pos);
      if (i > 60 && boom < 0.8 * want) short += DT;
      else short = 0;
      worstShort = Math.max(worstShort, short);
    }
    // A blocker may pull it in for a moment, never for seconds.
    expect(worstShort).toBeLessThan(1.5);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('a bird launched from the street with no input takes off into the open: never into a facade', () => {
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    streetShot(ctx);
    step();
    cam.fly!();
    const dir = directorOf(ctx);
    dir.override = { steer: 0, climb: 0, flap: false, dive: false };
    let nearest = 99;
    let later = 99;
    let alt90 = 0;
    // (D1f r4) Left alone for 10 s: once the take-off guide ends (3.2 s) the idle guide keeps it off
    // the buildings — it flew straight at the clock tower's face at ~5 s and skimmed its spire.
    for (let i = 0; i < 600; i++) {
      step();
      const f = facadeDist(ctx, dir.bird.pos);
      if (i < 90) nearest = Math.min(nearest, f);
      if (i === 89) alt90 = dir.bird.alt;
      if (i > 20) later = Math.min(later, f);
    }
    // It keeps a bird's berth (the wall push never had to step in) and is climbing away.
    expect(nearest).toBeGreaterThan(1.2);
    expect(alt90 - PLATEAU_HEIGHT).toBeGreaterThan(4);
    expect(later).toBeGreaterThan(3);
    expect(dir.bird.wallHits).toBe(0);
    sys.dispose!(ctx);
    canvas.remove();
  });
  it('into the eyes of a walker facing the camera: swung round behind, in frame until the drop, settled by 2.5 s', () => {
    // (D1f r4: the approach went over the walker's head and spun 160° round at 8 m, looking down at
    // the paving with the walker out of the frame for 0.65 s; it now swings round behind on the
    // walker's own slope, the walker held in frame until the lens is about to drop into the head.)
    const { ctx, sys, step, canvas } = setup();
    const cam = ctx.services.camera;
    streetShot(ctx);
    step();
    const p0 = fromSphere(ctx.camera.position.clone().normalize());
    ctx.services.track.register(standing(ctx, p0.x, p0.z, 45, true));
    expect(cam.ride!('person:901')).toBe(true);
    const t = ctx.services.track.get('person:901')!;
    const tp: TrackPose = { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), speed: 0 };
    let seen = false;
    let after = 0;
    let lost = 0;
    let frames = 0;
    let behind = false;
    let steep = 0;
    let roll = 0;
    const f = new Vector3();
    const up = new Vector3();
    const cu = new Vector3();
    while (cam.mode!().blend < 1 && frames < 400) {
      step();
      frames++;
      t.pose(ctx, tp);
      const d = ctx.camera.position.distanceTo(tp.pos);
      const nd = tp.pos.clone().project(ctx.camera);
      const inFrame = Math.abs(nd.x) < 1 && Math.abs(nd.y) < 1 && nd.z < 1;
      if (inFrame) seen = true;
      // (D1f r5: while the walker's body is drawn — the owner hides it within 1.6 m of the lens.)
      if (seen && d > 1.8) {
        after++;
        if (!inFrame) lost++;
      }
      // Behind the walker before the drop (the camera on its back side, 3–6 m off).
      const rel = ctx.camera.position.clone().sub(tp.pos);
      if (d > 3 && d < 6 && rel.dot(tp.fwd) < -1) behind = true;
      // (D1f r5) Never long looking straight down at them, the horizon never much rolled.
      f.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      up.copy(ctx.camera.position).normalize();
      if (f.dot(up) < -Math.sin(50 * DEG)) steep += DT;
      cu.set(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
      const lv = up.clone().addScaledVector(f, -up.dot(f));
      if (lv.length() > 0.3) roll = Math.max(roll, lv.normalize().angleTo(cu));
    }
    expect(cam.mode!().blend).toBe(1);
    expect(frames / 60).toBeLessThanOrEqual(2.45);
    expect(seen).toBe(true);
    expect(behind).toBe(true);
    expect(lost, `${lost} of ${after} frames without the walker while drawn`).toBeLessThanOrEqual(3);
    expect(steep, 'seconds looking more than 50° down').toBeLessThanOrEqual(0.25);
    expect(roll).toBeLessThan(20 * DEG);
    sys.dispose!(ctx);
    canvas.remove();
  });

  it('a bird launched from the street with a dive held, or steered into the blocks, keeps a bird\'s berth', () => {
    // (D1f r5, critic r2: Shift held with no steer pressed the bird against a glass facade, the wall
    // filling 70 % of the frame, 2.1 m off; the guide now keeps the heading in a dive and a soft
    // wall eases it back out, so steered at a facade it slides along it.)
    const cases: Array<[string, { steer: number; climb: number; flap: boolean; dive: boolean }, number]> = [
      ['dive', { steer: 0, climb: 0, flap: false, dive: true }, 3],
      ['A+S', { steer: -0.7, climb: -1, flap: false, dive: false }, 2.5],
      ['dive+A', { steer: -0.6, climb: 0, flap: false, dive: true }, 2.5],
    ];
    for (const [name, input, berth] of cases) {
      const { ctx, sys, step, canvas } = setup();
      streetShot(ctx);
      step();
      ctx.services.camera.fly!();
      const dir = directorOf(ctx);
      dir.override = input;
      let nearest = 99;
      for (let i = 0; i < 60 * 9; i++) {
        step();
        if (i > 20) nearest = Math.min(nearest, facadeDist(ctx, dir.bird.pos));
      }
      expect(nearest, name).toBeGreaterThan(berth);
      expect(dir.bird.wallHits, name).toBe(0);
      sys.dispose!(ctx);
      canvas.remove();
    }
  });

  it('ordinary trips are snappy: a car down the street or a walker across town in ≤ 2.15 s', () => {
    // (D1f r5, critic r2: in-town trips landed at 2.45–2.57 s; ordinary ones plan to ≤ 1.85 s and take
    // more only as far as their turns ask, up to 2.1 s.)
    const cases: Array<[string, string]> = [
      ['street → a car down the street', 'car:901'],
      ['street → a walker 50 m off', 'person:902'],
    ];
    for (const [name, id] of cases) {
      const { ctx, sys, step, canvas } = setup();
      const cam = ctx.services.camera;
      const car = laneCar(ctx);
      ctx.services.track.register(car);
      const p = car.at(30);
      placeAt(ctx, p.x - p.fz * 4, p.z + p.fx * 4, 1.7, 0);
      step();
      if (id === 'person:902') {
        const p0 = fromSphere(ctx.camera.position.clone().normalize());
        const w = standing(ctx, p0.x, p0.z, 50);
        ctx.services.track.register({ ...w, id: 'person:902', view: 'chase' });
      }
      expect(cam.ride!(id), name).toBe(true);
      let frames = 0;
      while (cam.mode!().blend < 1 && frames < 400) {
        step();
        frames++;
      }
      expect(frames / 60, name).toBeLessThanOrEqual(2.15);
      sys.dispose!(ctx);
      canvas.remove();
    }
  });
});
