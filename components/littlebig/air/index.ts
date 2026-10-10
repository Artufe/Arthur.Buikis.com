// Air (B3): planes on tilted great circles above the cloud layer, banking through gentle S-turns,
// with soft twin contrails and blinking nav lights at night; hot-air balloons drifting slow loops
// over the town's outskirts below the clouds, their envelopes glowing when the burner fires.
//
//   - Schedules are closed-form in sim time (routes.ts): persistent, deterministic, no replay.
//   - One toon program for planes and balloons (two instanced meshes), one contrail draw (an
//     instanced ribbon per plane whose shape the vertex shader evaluates from the route at past
//     times, so the trail lies exactly where the plane flew, at zero CPU cost), one points draw
//     for every light. Contrails and lights are LAYER_NO_INK and write no depth.
//   - Nothing ever flies through the camera: a plane near the eye slides past sideways to its
//     flight, a balloon is pushed smoothly away (routes.ts dodgeAcross / dodge; the contrail's head
//     follows).
//   - v2 (L1): every plane ('plane:<i>') and balloon ('balloon:<i>') is a Trackable (view 'chase';
//     air/track.ts). The one being ridden (ctx.view.ride) never dodges: its chase camera sits inside
//     the dodge radius on purpose, and the plane must stay where the camera expects it.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  type InstancedMesh,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { LAYER_NO_INK, type LBContext, type System } from '../core/contracts';
import { PALETTE } from '../render/palette';
import { planFrame, toSphere } from '../world/city/frame';
import { cross3, v3, type Vec3 } from '../world/sphere';
import { BALLOON_BELLY, BALLOONS, balloonAt, dodge, dodgeAcross, newBalloon, newPose, planePose, ROUTES, routeTheta } from './routes';
import { BEACON, BURNER_Y, balloonGeometry, planeGeometry, TAIL_TIP, WING_TIP } from './geometry';
import { AIR_PATCH, contrailFrag, contrailVert, lightsFrag, lightsVert, NP } from './shaders';
import { airSpace, skyDipSin } from '../sky/rig';
import { BALLOON_CARDS, balloonDetail, PLANE_CARDS, planeDetail } from './track';
import { R } from '../world/config';

/** Plane liveries: cheatline + fin (A), engines (B). */
const LIVERIES: Array<[Color, Color]> = [
  [PALETTE.walls[4], PALETTE.walls[2]], // coral / teal
  [PALETTE.walls[2], PALETTE.accent], // teal / amber
  [PALETTE.accent, PALETTE.roofs[1]], // amber / slate
  [PALETTE.walls[5], PALETTE.walls[4]], // lilac / coral
];
/** Balloon gores (A, also the crown) and (B). */
const BALLOON_COLORS: Array<[Color, Color]> = [
  [PALETTE.roofs[0], PALETTE.walls[3]], // red / mustard
  [PALETTE.walls[2], PALETTE.walls[0]], // teal / cream
  [PALETTE.walls[5], PALETTE.walls[4]], // lilac / coral
];

/** Contrail length (s of flight) and ribbon segments. */
const TRAIL = 9;
const TRAIL_SEGS = 64;
/** Planes keep ≥ 9 m from the eye (pushed from 27 m), balloons ≥ 7.5 m (from 22 m). */
const PLANE_DODGE = [9, 27] as const;
const BALLOON_DODGE = [7.5, 22] as const;
const LIGHTS_PER_PLANE = 7;

const RED = new Color(1, 0.1, 0.06);
const GREEN = new Color(0.12, 1, 0.3);
const WHITE = new Color(1, 1, 1);
const FLAME = new Color(1, 0.5, 0.12);

export function createAirSystem(): System {
  let planes: InstancedMesh | null = null;
  let balloons: InstancedMesh | null = null;
  let trails: Mesh | null = null;
  let lights: Points | null = null;
  let trailMat: ShaderMaterial | null = null;
  let lightMat: ShaderMaterial | null = null;
  let lightPos: BufferAttribute | null = null;
  let revealAt = 0;
  let ready = false;

  const nP = ROUTES.length;
  const nB = BALLOONS.length;
  const pose = newPose();
  const bal = newBalloon();
  const off = v3();
  const tmp = v3();
  const frame = { up: v3(), ax: v3(), az: v3() };
  const X = v3();
  const Z = v3();
  const U = v3();
  const viewSize = new Vector2();
  const untrack: Array<() => void> = [];
  const planeIds = ROUTES.map((_, i) => `plane:${i}`);
  const balloonIds = BALLOONS.map((_, i) => `balloon:${i}`);
  // the trackables' own scratch (pose() may run before or after place() in a frame)
  const tPose = newPose();
  const tBal = newBalloon();
  const tOff = v3();
  const tFrame = { up: v3(), ax: v3(), az: v3() };
  const tX = v3();
  const tU = v3();
  const tZ = v3();
  const tP = v3();
  const thetaU = Array.from({ length: NP }, () => new Vector4());
  const dodgeU = Array.from({ length: NP }, () => new Vector3());
  const viewH = { value: 800 };
  /** The eye's dip-aware sun elevation sine and its airSpace (shaders.ts airSunE). */
  const airEye = { value: new Vector2(0.5, 1) };
  const reveal = { value: 0 };

  /** Write a column-major instance matrix [X·s, Y·s, Z·s, P]. */
  function writeMatrix(arr: Float32Array, i: number, x: Vec3, y: Vec3, z: Vec3, p: Vec3, s: number) {
    const o = i * 16;
    arr[o] = x.x * s; arr[o + 1] = x.y * s; arr[o + 2] = x.z * s; arr[o + 3] = 0;
    arr[o + 4] = y.x * s; arr[o + 5] = y.y * s; arr[o + 6] = y.z * s; arr[o + 7] = 0;
    arr[o + 8] = z.x * s; arr[o + 9] = z.y * s; arr[o + 10] = z.z * s; arr[o + 11] = 0;
    arr[o + 12] = p.x; arr[o + 13] = p.y; arr[o + 14] = p.z; arr[o + 15] = 1;
  }

  /** A light at local (lx, ly, lz) on the posed plane. */
  function setLight(k: number, lx: number, ly: number, lz: number, s: number) {
    const a = lightPos!.array as Float32Array;
    const p = pose.pos;
    a[k * 3] = p.x + (pose.left.x * lx + pose.up.x * ly + pose.fwd.x * lz) * s;
    a[k * 3 + 1] = p.y + (pose.left.y * lx + pose.up.y * ly + pose.fwd.y * lz) * s;
    a[k * 3 + 2] = p.z + (pose.left.z * lx + pose.up.z * ly + pose.fwd.z * lz) * s;
  }

  /** Plane i at time t into `p`, pushed clear of the eye unless it is the one being ridden; the push into `o`. */
  function planeAt(i: number, t: number, eye: Vec3, ridden: boolean, p: typeof pose, o: Vec3) {
    const r = ROUTES[i];
    planePose(r, t, p);
    if (ridden) o.x = o.y = o.z = 0;
    else dodgeAcross(p.pos, p.fwd, eye, PLANE_DODGE[0] * r.scale, PLANE_DODGE[1] * r.scale, o);
    p.pos.x += o.x;
    p.pos.y += o.y;
    p.pos.z += o.z;
  }

  /**
   * Balloon i at time t: its basket origin into p and its basis (X across, U up the swaying
   * envelope, Z = X × U), pushed clear of the eye (never downward) unless it is the one ridden.
   */
  function balloonPlace(i: number, t: number, eye: Vec3, ridden: boolean, st: typeof bal, fr: typeof frame, p: Vec3, x: Vec3, u: Vec3, z: Vec3, o: Vec3) {
    const b = BALLOONS[i];
    balloonAt(b, t, st);
    toSphere(st.x, st.z, st.h, p);
    planFrame(st.x, st.z, fr);
    // Yaw about the local up, then a slow pendulum sway about the envelope's belly.
    const cy = Math.cos(st.yaw);
    const sy = Math.sin(st.yaw);
    x.x = fr.ax.x * cy + fr.az.x * sy;
    x.y = fr.ax.y * cy + fr.az.y * sy;
    x.z = fr.ax.z * cy + fr.az.z * sy;
    cross3(z, x, fr.up);
    const cs = Math.cos(st.sway);
    const ss = Math.sin(st.sway);
    u.x = fr.up.x * cs + z.x * ss;
    u.y = fr.up.y * cs + z.y * ss;
    u.z = fr.up.z * cs + z.z * ss;
    cross3(z, x, u);
    const belly = BALLOON_BELLY * b.scale;
    p.x += (fr.up.x - u.x) * belly;
    p.y += (fr.up.y - u.y) * belly;
    p.z += (fr.up.z - u.z) * belly;
    if (ridden) {
      o.x = o.y = o.z = 0;
      return;
    }
    tmp.x = p.x + u.x * belly;
    tmp.y = p.y + u.y * belly;
    tmp.z = p.z + u.z * belly;
    dodge(tmp, eye, BALLOON_DODGE[0] * b.scale, BALLOON_DODGE[1] * b.scale, o);
    // A balloon never sinks to dodge (it would sink into the roofs it clears by ~4 m): the downward
    // part of the push turns sideways, away from the eye (or along the envelope's own x).
    const up = fr.up;
    const down = o.x * up.x + o.y * up.y + o.z * up.z;
    if (down < 0) {
      let hx = tmp.x - eye.x;
      let hy = tmp.y - eye.y;
      let hz = tmp.z - eye.z;
      const hu = hx * up.x + hy * up.y + hz * up.z;
      hx -= up.x * hu;
      hy -= up.y * hu;
      hz -= up.z * hu;
      const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const k = hl > 0.5 ? -down / hl : 0;
      o.x += -up.x * down + (k ? hx * k : -x.x * down);
      o.y += -up.y * down + (k ? hy * k : -x.y * down);
      o.z += -up.z * down + (k ? hz * k : -x.z * down);
    }
    p.x += o.x;
    p.y += o.y;
    p.z += o.z;
  }

  function place(ctx: LBContext) {
    if (!planes || !balloons || !lightPos) return;
    const t = ctx.time.render;
    const eye = ctx.view.eye;
    const ride = ctx.view.ride;
    const pm = planes.instanceMatrix.array as Float32Array;
    for (let i = 0; i < nP; i++) {
      const r = ROUTES[i];
      planeAt(i, t, eye, ride === planeIds[i], pose, off);
      writeMatrix(pm, i, pose.left, pose.up, pose.fwd, pose.pos, r.scale);
      thetaU[i].x = routeTheta(r, t);
      dodgeU[i].set(off.x, off.y, off.z);
      const k = i * LIGHTS_PER_PLANE;
      setLight(k, WING_TIP.x + 0.08, WING_TIP.y, WING_TIP.z, r.scale);
      setLight(k + 1, -WING_TIP.x - 0.08, WING_TIP.y, WING_TIP.z, r.scale);
      setLight(k + 2, WING_TIP.x + 0.06, WING_TIP.y, WING_TIP.z - 0.12, r.scale);
      setLight(k + 3, -WING_TIP.x - 0.06, WING_TIP.y, WING_TIP.z - 0.12, r.scale);
      setLight(k + 4, TAIL_TIP.x, TAIL_TIP.y, TAIL_TIP.z - 0.06, r.scale);
      setLight(k + 5, BEACON.x, BEACON.y + 0.06, BEACON.z, r.scale);
      setLight(k + 6, BEACON.x, -BEACON.y - 0.08, BEACON.z, r.scale);
    }
    planes.instanceMatrix.needsUpdate = true;

    const bm = balloons.instanceMatrix.array as Float32Array;
    const la = lightPos.array as Float32Array;
    for (let i = 0; i < nB; i++) {
      const b = BALLOONS[i];
      const p = pose.pos;
      balloonPlace(i, t, eye, ride === balloonIds[i], bal, frame, p, X, U, Z, off);
      writeMatrix(bm, i, X, U, Z, p, b.scale);
      const k = (nP * LIGHTS_PER_PLANE + i) * 3;
      const fy = (BURNER_Y + 0.42) * b.scale; // above the can, toward the mouth
      la[k] = p.x + U.x * fy;
      la[k + 1] = p.y + U.y * fy;
      la[k + 2] = p.z + U.z * fy;
    }
    balloons.instanceMatrix.needsUpdate = true;
    lightPos.needsUpdate = true;
  }

  return {
    name: 'air',
    stage: 2,
    async init(ctx: LBContext) {
      const planeGeo = ctx.track(planeGeometry());
      const balloonGeo = ctx.track(balloonGeometry());
      await ctx.yield();

      const liv = (n: number, pick: (i: number) => [Color, Color], phase: (i: number) => number, kind: number) => {
        const a = new Float32Array(n * 4);
        const b = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          const [ca, cb] = pick(i);
          a.set([ca.r, ca.g, ca.b, phase(i)], i * 4);
          b.set([cb.r, cb.g, cb.b, kind], i * 4);
        }
        return [new InstancedBufferAttribute(a, 4), new InstancedBufferAttribute(b, 4)];
      };
      const [pa, pb] = liv(nP, (i) => LIVERIES[ROUTES[i].livery % LIVERIES.length], () => 0, 0);
      planeGeo.setAttribute('aLivA', pa);
      planeGeo.setAttribute('aLivB', pb);
      const [ba, bb] = liv(nB, (i) => BALLOON_COLORS[BALLOONS[i].colors % BALLOON_COLORS.length], (i) => i * 0.37, 1);
      balloonGeo.setAttribute('aLivA', ba);
      balloonGeo.setAttribute('aLivB', bb);
      // Hidden until the reveal slot is known.
      const planeReveal = new InstancedBufferAttribute(new Float32Array(nP).fill(1e7), 1);
      const balloonReveal = new InstancedBufferAttribute(new Float32Array(nB).fill(1e7), 1);
      planeGeo.setAttribute('aReveal', planeReveal);
      balloonGeo.setAttribute('aReveal', balloonReveal);

      const mat = ctx.toon.material({ name: 'air', vertexColors: true, reveal: 'instance', rim: 0.45, patch: { ...AIR_PATCH, uniforms: { uAirEye: airEye } } });
      planes = ctx.toon.instanced(planeGeo, mat, nP, { cast: true, receive: true });
      balloons = ctx.toon.instanced(balloonGeo, mat, nB, { cast: true, receive: true });
      for (const m of [planes, balloons]) {
        m.frustumCulled = false; // instances move every frame; the set is tiny
        m.instanceMatrix.setUsage(DynamicDrawUsage);
      }
      planes.name = 'air:planes';
      balloons.name = 'air:balloons';

      // Contrails: one ribbon (TRAIL_SEGS × 2 vertices: x = u along, y = side) instanced per plane.
      const tg = new InstancedBufferGeometry();
      const tp = new Float32Array((TRAIL_SEGS + 1) * 2 * 3);
      const ti: number[] = [];
      for (let k = 0; k <= TRAIL_SEGS; k++) {
        const u = Math.pow(k / TRAIL_SEGS, 1.25); // denser near the plane, where it is narrow
        tp.set([u, -1, 0, u, 1, 0], k * 6);
        if (k < TRAIL_SEGS) ti.push(k * 2, k * 2 + 1, k * 2 + 3, k * 2, k * 2 + 3, k * 2 + 2);
      }
      tg.setAttribute('position', new BufferAttribute(tp, 3));
      tg.setIndex(ti);
      tg.instanceCount = nP;
      ctx.track(tg);
      const vec3s = (f: (i: number) => Vec3) => Array.from({ length: NP }, (_, i) => (i < nP ? new Vector3(f(i).x, f(i).y, f(i).z) : new Vector3()));
      const vec4s = (f: (i: number) => [number, number, number, number]) => Array.from({ length: NP }, (_, i) => (i < nP ? new Vector4(...f(i)) : new Vector4()));
      for (let i = 0; i < nP; i++) thetaU[i].set(0, ROUTES[i].omega, 0.8, 0);
      trailMat = ctx.track(
        new ShaderMaterial({
          name: 'air:contrails',
          vertexShader: contrailVert,
          fragmentShader: contrailFrag,
          transparent: true,
          depthWrite: false,
          side: DoubleSide, // the ribbon faces the eye either way round
          fog: true,
          uniforms: {
            ...UniformsUtils.clone(UniformsLib.fog),
            ...ctx.uniforms,
            uA: { value: vec3s((i) => ROUTES[i].a) },
            uB: { value: vec3s((i) => ROUTES[i].b) },
            uN: { value: vec3s((i) => ROUTES[i].n) },
            uW: { value: vec4s((i) => [ROUTES[i].weave, ROUTES[i].weaveK, ROUTES[i].weavePh, ROUTES[i].alt]) },
            uH: { value: vec4s((i) => [ROUTES[i].altAmp, ROUTES[i].altK, ROUTES[i].altPh, ROUTES[i].scale]) },
            uS: { value: thetaU },
            uDodge: { value: dodgeU },
            uTrail: { value: TRAIL },
            uViewH: viewH,
            uReveal: reveal,
            uAirEye: airEye,
          },
        }),
      );
      trails = new Mesh(tg, trailMat);
      trails.name = 'air:contrails';
      trails.frustumCulled = false;
      trails.layers.set(LAYER_NO_INK);

      // Lights: per plane two nav (red left, green right), two wingtip strobes, a tail light, a red
      // top beacon and a belly beacon; per balloon its burner flame.
      const nL = nP * LIGHTS_PER_PLANE + nB;
      const lg = new BufferGeometry();
      lightPos = new BufferAttribute(new Float32Array(nL * 3), 3);
      lightPos.setUsage(DynamicDrawUsage);
      const col = new Float32Array(nL * 4);
      const meta = new Float32Array(nL * 3);
      const put = (k: number, c: Color, pattern: number, size: number, phase: number, minPx: number) => {
        col.set([c.r, c.g, c.b, pattern], k * 4);
        meta.set([size, phase, minPx], k * 3);
      };
      for (let i = 0; i < nP; i++) {
        const k = i * LIGHTS_PER_PLANE;
        const ph = i * 0.41;
        put(k, RED, 0, 0.6, ph, 7);
        put(k + 1, GREEN, 0, 0.6, ph, 7);
        put(k + 2, WHITE, 2, 1.3, ph, 11);
        put(k + 3, WHITE, 2, 1.3, ph, 11);
        put(k + 4, WHITE, 0, 0.5, ph, 5);
        put(k + 5, RED, 1, 1.0, ph * 1.7, 8);
        put(k + 6, RED, 1, 1.0, ph * 1.7 + 0.65, 8); // belly beacon, in antiphase: the one seen from the street
      }
      for (let i = 0; i < nB; i++) put(nP * LIGHTS_PER_PLANE + i, FLAME, 3, 1.5, i * 0.37, 6);
      lg.setAttribute('position', lightPos);
      lg.setAttribute('aCol', new BufferAttribute(col, 4));
      lg.setAttribute('aMeta', new BufferAttribute(meta, 3));
      ctx.track(lg);
      lightMat = ctx.track(
        new ShaderMaterial({
          name: 'air:lights',
          vertexShader: lightsVert,
          fragmentShader: lightsFrag,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          uniforms: { ...ctx.uniforms, uViewH: viewH, uReveal: reveal, uAirEye: airEye },
        }),
      );
      lights = new Points(lg, lightMat);
      lights.name = 'air:lights';
      lights.frustumCulled = false;
      lights.layers.set(LAYER_NO_INK);
      lights.renderOrder = 2;
      trails.renderOrder = 1;

      place(ctx);
      ctx.scene.add(planes, balloons, trails, lights);
      await ctx.compile();

      revealAt = ctx.reveal.slot(1.2);
      for (let i = 0; i < nP; i++) planeReveal.array[i] = revealAt + i * 0.12;
      for (let i = 0; i < nB; i++) balloonReveal.array[i] = revealAt + 0.25 + i * 0.15;
      planeReveal.needsUpdate = true;
      balloonReveal.needsUpdate = true;
      ready = true;

      // v2 (L1): planes and balloons as Trackables (chase)
      for (let i = 0; i < nP; i++) {
        const r = ROUTES[i];
        const card = PLANE_CARDS[i % PLANE_CARDS.length];
        untrack.push(
          ctx.services.track.register({
            id: planeIds[i],
            kind: 'plane',
            label: card.label,
            sub: card.sub,
            view: 'chase',
            radius: Math.round(460 * r.scale) / 100,
            pose(c, out) {
              planeAt(i, c.time.render, c.view.eye, c.view.ride === planeIds[i], tPose, tOff);
              out.pos.set(tPose.pos.x, tPose.pos.y, tPose.pos.z);
              out.fwd.set(tPose.fwd.x, tPose.fwd.y, tPose.fwd.z);
              out.up.set(tPose.up.x, tPose.up.y, tPose.up.z);
              out.speed = r.omega * Math.sqrt(tPose.pos.x * tPose.pos.x + tPose.pos.y * tPose.pos.y + tPose.pos.z * tPose.pos.z);
              return true;
            },
            detail: (c) => planeDetail(c, i),
          }),
        );
      }
      for (let i = 0; i < nB; i++) {
        const b = BALLOONS[i];
        const card = BALLOON_CARDS[i % BALLOON_CARDS.length];
        untrack.push(
          ctx.services.track.register({
            id: balloonIds[i],
            kind: 'balloon',
            label: card.label,
            sub: card.sub,
            view: 'chase',
            radius: Math.round(500 * b.scale) / 100,
            pose(c, out) {
              const t = c.time.render;
              balloonPlace(i, t, c.view.eye, c.view.ride === balloonIds[i], tBal, tFrame, tP, tX, tU, tZ, tOff);
              // anchored at the envelope's belly; forward along its drift (the envelope's own yaw spins slowly)
              const belly = BALLOON_BELLY * b.scale;
              out.pos.set(tP.x + tU.x * belly, tP.y + tU.y * belly, tP.z + tU.z * belly);
              const up = tFrame.up;
              out.up.set(up.x, up.y, up.z);
              balloonAt(b, t + 0.5, tBal);
              toSphere(tBal.x, tBal.z, tBal.h, tX);
              balloonAt(b, t - 0.5, tBal);
              toSphere(tBal.x, tBal.z, tBal.h, tZ);
              let fx = tX.x - tZ.x;
              let fy = tX.y - tZ.y;
              let fz = tX.z - tZ.z;
              out.speed = Math.sqrt(fx * fx + fy * fy + fz * fz);
              const fu = fx * up.x + fy * up.y + fz * up.z;
              fx -= up.x * fu;
              fy -= up.y * fu;
              fz -= up.z * fu;
              const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
              out.fwd.set(fx / fl, fy / fl, fz / fl);
              return true;
            },
            detail: (c) => balloonDetail(c, i),
          }),
        );
      }
    },

    update(ctx: LBContext) {
      if (!ready) return;
      ctx.renderer.getDrawingBufferSize(viewSize);
      viewH.value = viewSize.y;
      reveal.value = ctx.reveal.instant ? 1 : ctx.reveal.progress(revealAt + 0.2, 1.0);
      // The eye's time of day as the sky computes it (A3: sky/index.ts, clouds/index.ts).
      const v = ctx.view;
      const sun = ctx.uniforms.lbSunDir.value;
      airEye.value.set(v.focus.dot(sun) + skyDipSin(v.ground, v.altTerrain, v.altSea, R) + 0.04, airSpace(v.altSea));
      place(ctx);
    },

    dispose(ctx: LBContext) {
      for (const off of untrack) off();
      untrack.length = 0;
      for (const o of [planes, balloons, trails, lights]) o?.removeFromParent();
      planes?.dispose();
      balloons?.dispose();
      planes = balloons = null;
      trails = lights = null;
      lightPos = null;
      ready = false;
      void ctx;
    },
  };
}
