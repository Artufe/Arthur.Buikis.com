// The track service's pick (D1f): a click anywhere on a walker's body picks the walker — head to
// feet, also when a truck stands behind them — and a truck in front of a walker hides them.

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { LBContext, TrackPose, Trackable } from './contracts';
import { closestOnSegment, createTrackService } from './track';
import { PLATEAU_HEIGHT, R, SEED } from '../world/config';
import { getCityIndex, getCityPlan } from '../world/city';
import { toSphere } from '../world/city/frame';
import { getPlanet } from '../world/planet';

const W = 1280;
const H = 800;
const GROUND = R + 2;
const UP = new Vector3(0, 0, 1);

/** World point at local (x east, y north) metres on the ground, h m up. */
const at = (x: number, y: number, h: number) => new Vector3(x, y, 0).addScaledVector(UP, GROUND + h);

function setup(camPos: Vector3, lookAt: Vector3) {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: W });
  Object.defineProperty(canvas, 'clientHeight', { value: H });
  const camera = new PerspectiveCamera(60, W / H, 0.05, 2000);
  camera.position.copy(camPos);
  camera.up.copy(UP);
  camera.lookAt(lookAt);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const ctx = { canvas, camera } as unknown as LBContext;
  return { ctx, track: createTrackService(ctx) };
}

/** A walker standing at local (x, y): eyes 1.46 m up (the people's eye anchor), radius 0.85. */
function walker(id: string, x: number, y: number): Trackable {
  return {
    id,
    kind: 'person',
    label: id,
    view: 'eyes',
    radius: 0.85,
    pose(_c, out: TrackPose) {
      out.pos.copy(at(x, y, 1.46));
      out.up.copy(UP);
      out.fwd.set(1, 0, 0);
      out.speed = 1.2;
      return true;
    },
  };
}

/** A truck (body centre 1.4 m up, bounding radius 4.4) at local (x, y), side-on to the camera. */
function truck(id: string, x: number, y: number): Trackable {
  return {
    id,
    kind: 'truck',
    label: id,
    view: 'chase',
    radius: 4.4,
    pose(_c, out: TrackPose) {
      out.pos.copy(at(x, y, 1.4));
      out.up.copy(UP);
      out.fwd.set(1, 0, 0);
      out.speed = 8;
      return true;
    },
  };
}

function screen(ctx: LBContext, p: Vector3) {
  const v = p.clone().project(ctx.camera);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}

describe('track pick', () => {
  it('a walker is picked anywhere on the body, also in front of a truck', () => {
    // The camera 8 m from the walker at eye height; a truck parked 1.5 m behind them.
    const { ctx, track } = setup(at(0, -8, 1.7), at(0, 0, 1));
    track.register(walker('person:1', 0, 0));
    track.register(truck('truck:1', 0, 2.7));
    for (const h of [1.6, 1.45, 1.2, 0.9, 0.6, 0.3, 0.1]) {
      const s = screen(ctx, at(0, 0, h));
      expect(track.pick(s.x, s.y)?.id, `at ${h} m`).toBe('person:1');
    }
    // Beside the walker, on the truck: the truck.
    const side = screen(ctx, at(2.2, 1.6, 1.4));
    expect(track.pick(side.x, side.y)?.id).toBe('truck:1');
  });

  it('a truck in front of a walker hides them, and a crowd picks the nearest', () => {
    const { ctx, track } = setup(at(0, -10, 1.7), at(0, 0, 1));
    track.register(walker('person:2', 0, 3));
    track.register(truck('truck:2', 0, 0));
    const s = screen(ctx, at(0, 3, 1.0));
    expect(track.pick(s.x, s.y)?.id).toBe('truck:2');
    const { ctx: c2, track: t2 } = setup(at(0, -10, 1.7), at(0, 0, 1));
    t2.register(walker('person:3', 0.2, 4));
    t2.register(walker('person:4', 0, 0));
    const s2 = screen(c2, at(0, 0, 1.0));
    expect(t2.pick(s2.x, s2.y)?.id).toBe('person:4');
  });

  it('nothing through a wall: a walker behind a building is not picked, one in front of it is (real city)', () => {
    const idx = getCityIndex();
    const plan = getCityPlan();
    const world = { seed: SEED, planet: getPlanet(SEED), city: plan, cityIndex: idx };
    // A building at least 8 m tall with open ground 10 m in front of a face and 4 m behind it.
    let tested = 0;
    for (const b of plan.buildings) {
      if (b.h < 8 || tested >= 4) continue;
      const nx = -Math.sin(b.angle);
      const nz = Math.cos(b.angle);
      const cx = b.x + nx * (b.d / 2 + 10);
      const cz = b.z + nz * (b.d / 2 + 10);
      const wx = b.x - nx * (b.d / 2 + 3);
      const wz = b.z - nz * (b.d / 2 + 3);
      const fx = b.x + nx * (b.d / 2 + 3);
      const fz = b.z + nz * (b.d / 2 + 3);
      if (idx.roofAt(cx, cz) > 0 || idx.roofAt(wx, wz) > 0 || idx.roofAt(fx, fz) > 0) continue;
      // (Open ground all the way from the camera to the walker in front.)
      let open = true;
      for (let k = 0; k <= 20; k++) if (idx.roofAt(cx + ((fx - cx) * k) / 20, cz + ((fz - cz) * k) / 20) > 0) open = false;
      if (!open) continue;
      if (Math.hypot(cx, cz) > 80 || Math.hypot(wx, wz) > 80) continue;
      const w3 = (x: number, z: number, h: number) => {
        const v = toSphere(x, z, h);
        return new Vector3(v.x, v.y, v.z);
      };
      const cam = w3(cx, cz, 1.7);
      const canvas = document.createElement('canvas');
      Object.defineProperty(canvas, 'clientWidth', { value: W });
      Object.defineProperty(canvas, 'clientHeight', { value: H });
      const camera = new PerspectiveCamera(60, W / H, 0.05, 2000);
      camera.position.copy(cam);
      camera.up.copy(cam).normalize();
      camera.lookAt(w3(b.x, b.z, 2));
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      const ctx = { canvas, camera, world } as unknown as LBContext;
      const track = createTrackService(ctx);
      const standing = (id: string, x: number, z: number): Trackable => ({
        id,
        kind: 'person',
        label: id,
        view: 'eyes',
        radius: 0.85,
        pose(_c, out: TrackPose) {
          out.pos.copy(w3(x, z, 0.2 + 1.46));
          out.up.copy(out.pos).normalize();
          out.fwd.set(1, 0, 0).addScaledVector(out.up, -out.up.x).normalize();
          out.speed = 0;
          return true;
        },
      });
      track.register(standing('person:behind', wx, wz));
      const sB = screen(ctx, w3(wx, wz, 1.2));
      expect(track.pick(sB.x, sB.y), `building ${b.id}`).toBe(null);
      track.register(standing('person:front', fx, fz));
      const sF = screen(ctx, w3(fx, fz, 1.2));
      expect(track.pick(sF.x, sF.y)?.id, `building ${b.id}`).toBe('person:front');
      tested++;
    }
    expect(tested).toBeGreaterThanOrEqual(2);
    expect(PLATEAU_HEIGHT).toBeGreaterThan(0);
  });

  it('a plane in the sky is picked looking up from the street', () => {
    const { ctx, track } = setup(at(0, 0, 1.7), at(0, 60, 40));
    track.register({
      id: 'plane:1',
      kind: 'plane',
      label: 'plane',
      view: 'chase',
      radius: 4.6,
      pose(_c, out: TrackPose) {
        out.pos.copy(at(0, 80, 50));
        out.up.copy(UP);
        out.fwd.set(1, 0, 0);
        out.speed = 18;
        return true;
      },
    });
    const s = screen(ctx, at(0, 80, 50));
    expect(track.pick(s.x, s.y)?.id).toBe('plane:1');
  });

  it('closestOnSegment: the segment point nearest a ray', () => {
    const o = new Vector3(0, -5, 1);
    const d = new Vector3(0, 1, 0);
    const p = closestOnSegment(o, d, new Vector3(0, 0, 2), new Vector3(0, 0, 0), new Vector3());
    expect(p.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-9);
    // Past the segment's end: clamped to it.
    const q = closestOnSegment(o, d, new Vector3(0, 0, 3), new Vector3(0, 0, 2), new Vector3());
    expect(q.distanceTo(new Vector3(0, 0, 2))).toBeLessThan(1e-9);
  });
});
