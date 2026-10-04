// The interactive descent, end to end: the real camera system against the real world, driven by
// wheel events on a jsdom canvas and stepped at 30 fps (no renderer). Guards the G1 flow fixes: the
// zoom holds what you aimed at, the lateral speed never snaps, the landing glide clears every
// camera solid and ends facing what the zoom aimed at.

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { LBContext } from '../core/contracts';
import { getCityIndex, getCityPlan } from '../world/city';
import { fromSphere } from '../world/city/frame';
import { EYE_HEIGHT, PLATEAU_HEIGHT, SEED } from '../world/config';
import { getPlanet } from '../world/planet';
import { sunDirection } from '../world/sun';
import { createCameraSystem } from './index';
import { cameraSolids, clearanceAt } from './landing';

const W = 1280;
const H = 800;
const DT = 1 / 30;

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
    view: { eye: new Vector3(), forward: new Vector3(), focus: new Vector3() },
    debug: { cameraLocked: false },
    time: { realDt: DT },
  } as unknown as LBContext;
  const sys = createCameraSystem();
  sys.init!(ctx);
  const step = () => sys.update!(ctx);
  const wheel = (x: number, y: number, dy: number) => canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  return { ctx, sys, step, wheel, canvas };
}

describe('interactive descent (camera system, 30 fps)', () => {
  it('a wheel dive from 120 m holds its aim, never snaps sideways, and lands clear, facing it', () => {
    const { ctx, sys, step, wheel, canvas } = setup();
    const cam = ctx.services.camera!;
    cam.setView({ lat: 20, lon: 10, alt: 120, heading: 0 });
    step();
    const at = { x: 820, y: 330 };
    const solids = cameraSolids(ctx.world.city);
    const near: number[] = [];
    const plan = { x: 0, z: 0 };
    let prev: { x: number; z: number } | null = null;
    let prevStep: { x: number; z: number } | null = null;
    let worstJerk = 0;
    let worstClear = Infinity;
    for (let k = 0; k < 150; k++) {
      if (k % 3 === 0 && k < 90) wheel(at.x, at.y, -100);
      step();
      fromSphere(ctx.view.focus, plan);
      const cur = { x: plan.x, z: plan.z };
      if (prev) {
        const st = { x: cur.x - prev.x, z: cur.z - prev.z };
        // Below 40 m (where a metre is a lot of screen) the lateral step never changes by more than
        // 0.15 m from one frame to the next: no stop-dead, no jump-start.
        if (prevStep && ctx.view.alt < 40) worstJerk = Math.max(worstJerk, Math.hypot(st.x - prevStep.x, st.z - prevStep.z));
        prevStep = st;
      }
      prev = cur;
      const eyeH = ctx.view.altSea - PLATEAU_HEIGHT;
      if (ctx.view.alt < 14) worstClear = Math.min(worstClear, clearanceAt(ctx.world.cityIndex, solids, cur.x, cur.z, eyeH, near, 3));
    }
    expect(ctx.view.alt).toBeCloseTo(EYE_HEIGHT, 1);
    expect(worstJerk).toBeLessThan(0.15);
    // Nothing in the lens on the way down (0.6 m is the touchdown allowance).
    expect(worstClear).toBeGreaterThan(0.55);
    // Facing what the zoom aimed at: its bearing within ~30° of the view.
    const dbg = (cam as unknown as { debug: () => { aimOn: boolean; landInfo: { aimX: number; aimZ: number } } }).debug();
    expect(Number.isFinite(dbg.landInfo.aimX)).toBe(true);
    const brg = Math.atan2(dbg.landInfo.aimX - prev!.x, -(dbg.landInfo.aimZ - prev!.z));
    const f = ctx.view.forward;
    const fp = { x: 0, z: 0 };
    const e = ctx.view.focus;
    const ahead = new Vector3(e.x + f.x * 1e-3, e.y + f.y * 1e-3, e.z + f.z * 1e-3).normalize();
    fromSphere(ahead, fp);
    let off = brg - Math.atan2(fp.x - prev!.x, -(fp.z - prev!.z));
    off -= Math.round(off / (2 * Math.PI)) * 2 * Math.PI;
    expect(Math.abs(off)).toBeLessThan((32 * Math.PI) / 180);
    sys.dispose!(ctx);
    canvas.remove();
  });
});
