// The camera director end to end (D1): the real camera system against the real world, a synthetic
// plane and walker registered on the real track service, stepped at 60 fps (no renderer). Guards
// the hand-overs: entering a ride, cycling, the bird, and back to explore never jump.

import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { LBContext, TrackPose, Trackable } from '../../core/contracts';
import { createTrackService } from '../../core/track';
import { getCityIndex, getCityPlan } from '../../world/city';
import { fromSphere, planToDir } from '../../world/city/frame';
import { PLATEAU_HEIGHT, R, SEED } from '../../world/config';
import { getPlanet } from '../../world/planet';
import { sunDirection } from '../../world/sun';
import { createCameraSystem } from '../index';
import { birdRender } from '../bird/shared';

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
function standing(ctx: LBContext, x: number, z: number, dist: number): Trackable {
  const idx = ctx.world.cityIndex;
  let wx = x;
  let wz = z;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const px = x + Math.cos(a) * dist;
    const pz = z + Math.sin(a) * dist;
    if (idx.classify(px, pz) === 'sidewalk' && !idx.collide(px, pz, 0.6, { x: 0, z: 0 })) {
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
      out.speed = 0;
      return true;
    },
  };
}

/** The camera's turn per frame (rad) is capped at 170°/s in a transition: 2.83° a frame at 60 fps. */
const TURN_FRAME = (172 * Math.PI) / 180 / 60;

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
      // (The follower caps at 170°/s and 1400°/s²: 23°/s a frame; the plan keeps under ~120°/s.)
      expect(r.worstRate, name).toBeLessThan(150 * DEG);
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
    expect(ctx.camera.near).toBeLessThanOrEqual(0.06);
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
});
