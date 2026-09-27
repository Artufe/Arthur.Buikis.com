// What the ride writes into the world (CPU, zero allocation per frame):
//
//   foam trail   SPLAT_FOAM along the loaded rail and the tail, SPLAT_WAKE behind the fins: the
//                line the board draws stays on the face and in the soup after the wave has gone
//   spray fan    off the tail when the rail is loaded hard or lets go: a fan of droplets, clumps
//                and mist thrown outward and up (the shared spray system scatters the low sun
//                through it, so it glows backlit), plus a shadow-only proxy cloud that casts the
//                fan's shadow (sprites can't)
//   speed spray  a thin sheet peeling off the inside rail at speed, streaking back past the lens
//   tube         droplets and mist hanging in the barrel ahead of the camera
//   wipeout      the whiteout: clumps and mist boiling round the lens, a burst on the impact
//   landing      a splash when the board lands from the air
//
// Everything goes through the spray's and the state's bulk paths, and no double crosses a call:
// the frame step is a field, randomness is a table lookup, proxy spawns take their numbers from
// a scratch array (V8 boxes a double passed to or returned from a call it doesn't inline).

import { IcosahedronGeometry, InstancedMesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { bool, uniform, vec3 } from 'three/tsl';
import { SPLAT_FOAM, SPLAT_WAKE, type GLContext, type OceanSample, type SurfaceStateService } from '../core/contracts';
import { SPRAY_DROPLET, SPRAY_FOAM, SPRAY_MIST, type SprayService } from '../vfx/spray';
import type { PlayerRig } from '../player/api';
import type { Ride } from './ride';

const G = 9.81;
/** Shadow proxies (droplet clumps that only the sun sees). */
const NP = 384;
const RM = 4095;

export interface FxTune {
  /** × on the spray fan, the foam trail and the speed spray. */
  fan: number;
  trail: number;
  sheet: number;
}

// Numeric fields start at -0, not 0: -0 isn't a Smi, so V8 gives each field a double
// representation from the start. A field that sat at Smi 0 until its first fractional value (the
// first air, the first landing) changed the object's map then and deoptimised the ride.
export class RideFx {
  readonly proxies: InstancedMesh;
  private readonly geo: IcosahedronGeometry;
  private readonly mat: MeshBasicNodeMaterial;
  private readonly pp = new Float32Array(NP * 3);
  private readonly pv = new Float32Array(NP * 3);
  private readonly pl = new Float32Array(NP); // life left (s), ≤ 0 dead
  private readonly pr = new Float32Array(NP); // radius
  private readonly pw = new Float32Array(NP); // water y at spawn
  private head = 0;
  /** Uniform [0, 1) table (xorshift32, fixed seed: deterministic), read at R[ri = (ri + 1) & RM]. */
  private readonly R = new Float64Array(4096);
  private ri = 0;
  /** This frame's step (s). */
  private dt = -0;
  /** spawnProxy() arguments: x, y, z, vx, vy, vz, radius, water y. */
  private readonly ps = new Float64Array(8);
  private trailX = -0;
  private trailZ = -0;
  private trailOk = false;
  private wasWiping = false;
  private eyePrev = -0;
  private splashed = false;
  private sheet = -0;
  private readonly s: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 5 };
  /** Seconds of fan this frame (debug) and fan intensity. */
  fan = -0;
  /** Debug: 1 = draw the shadow proxies in the camera too. */
  readonly showU = uniform(0);
  /** Shadow clump size × (debug tuning). */
  shadowScale = 1;

  constructor(private readonly tune: FxTune) {
    this.geo = new IcosahedronGeometry(1, 1);
    const m = new MeshBasicNodeMaterial();
    // Discarded in every camera pass; drawn only into the shadow maps (surf.fx.proxies shows them).
    m.maskNode = this.showU.equal(1);
    m.maskShadowNode = bool(true);
    m.colorNode = vec3(1, 0.2, 0.6);
    this.mat = m;
    this.proxies = new InstancedMesh(this.geo, m, NP);
    this.proxies.name = 'surf.sprayShadow';
    this.proxies.castShadow = true;
    this.proxies.receiveShadow = false;
    this.proxies.frustumCulled = false;
    this.proxies.count = 0;
    const a = this.proxies.instanceMatrix.array as Float32Array;
    for (let i = 0; i < NP; i++) a[i * 16 + 15] = 1;
    let x = 0x2545f491;
    for (let i = 0; i < this.R.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      this.R[i] = x / 4294967296;
    }
  }

  /** Debug (surf.fx.test): a fan thrown continuously from a fixed spot (x, y, z) toward +X. */
  readonly test = new Float64Array([0, -110, 4.25, 48]);

  update(ctx: GLContext, rig: PlayerRig, ride: Ride) {
    const dt = ctx.time.dt;
    this.dt = dt;
    this.stepProxies();
    if (!(dt > 0)) return;
    const spray = (ctx.services.ocean.gpu as { spray?: SprayService }).spray;
    if (this.test[0] > 0 && spray) this.testFan(spray);
    const state = ctx.services.state;
    this.pierFx(ctx, rig, spray, state);
    const st = ride.state;
    const T = this.tune;
    this.fan = 0;
    if (st.active && !st.wiping && (rig.mode === 'ride' || rig.mode === 'popup')) {
      this.rideFx(ride, spray, state, T);
      this.wasWiping = false;
    } else this.trailOk = false;
    if (st.active && !st.wiping && (rig.mode === 'ride' || rig.mode === 'popup')) {
      // (ride effects done above)
    } else if (st.wiping && rig.mode === 'wipeout' && spray) {
      this.wipeFx(ride, spray);
    }
  }

  private rideFx(ride: Ride, spray: SprayService | undefined, state: SurfaceStateService, T: FxTune) {
    const dt = this.dt;
    const st = ride.state;
    const bx = st.px;
    const bz = st.pz;
    const fX = st.fx;
    const fZ = st.fz;
    const rX = st.rx;
    const rZ = st.rz;
    const vX = st.vx;
    const vZ = st.vz;
    const speed = st.speed;
    const wy = st.surfaceY;
    if (st.airborne) {
      this.trailOk = false;
      return;
    }
    // ── Foam trail and wake: the tail and the loaded rail write into the surface state ──
    // Every frame, and interpolated along the path so a fast board draws a line, not beads.
    const load = Math.min(1, Math.abs(st.aLat) / (1.4 * G));
    const side = st.aLat > 0 ? 1 : -1; // the loaded (inside) rail is on the turn's side
    const tx = bx - fX * 0.85;
    const tz = bz - fZ * 0.85;
    if (speed > 1.2 && this.trailOk) {
      const dx = tx - this.trailX;
      const dz = tz - this.trailZ;
      const seg = Math.sqrt(dx * dx + dz * dz);
      const n = seg > 0.25 ? Math.min(6, Math.ceil(seg / 0.25)) : 1;
      const sp = Math.min(1, speed / 9);
      // Per point of the path, not per frame: a board at 17 m/s crosses each point once, so a
      // frame-rate strength (A5's 3·dt for a lingering emitter) left no visible line. Splats land
      // every 0.25 m; a slow board's shorter step scales them down so the line's density holds.
      const fs = Math.min(0.9, (0.34 + 0.4 * load + st.skid * 0.01) * T.trail * (0.45 + 0.55 * sp)) * Math.min(1, seg / (0.25 * n));
      const o = state.reserve ? state.reserve(n + 2) : -1;
      if (o >= 0 && state.splatData) {
        const d = state.splatData;
        let k = o;
        for (let i = 0; i < n; i++) {
          const u = (i + 1) / n;
          d[k] = SPLAT_FOAM;
          d[k + 1] = this.trailX + dx * u;
          d[k + 2] = this.trailZ + dz * u;
          d[k + 3] = 0.24 + 0.1 * load;
          d[k + 4] = fs;
          d[k + 5] = 0;
          d[k + 6] = 0;
          d[k + 7] = 1;
          k += 8;
        }
        // The loaded rail, a little ahead of the tail.
        d[k] = SPLAT_FOAM;
        d[k + 1] = bx - fX * 0.35 + rX * side * 0.2;
        d[k + 2] = bz - fZ * 0.35 + rZ * side * 0.2;
        d[k + 3] = 0.2;
        d[k + 4] = Math.min(1, (0.6 + 3 * load) * dt * T.trail * sp);
        d[k + 5] = 0;
        d[k + 6] = 0;
        d[k + 7] = 1;
        k += 8;
        // Wake behind the fins: velocity in m/s.
        d[k] = SPLAT_WAKE;
        d[k + 1] = tx - fX * 0.3;
        d[k + 2] = tz - fZ * 0.3;
        d[k + 3] = 0.3;
        d[k + 4] = 0.03 + 0.02 * load;
        d[k + 5] = vX;
        d[k + 6] = vZ;
        d[k + 7] = 1;
      }
    }
    this.trailX = tx;
    this.trailZ = tz;
    this.trailOk = true;
    if (!spray) return;
    // ── The fan: off the tail when the rail is loaded hard (or the tail breaks loose) ──
    const fanK = Math.min(1, Math.max(0, (Math.abs(st.aLat) / G - 0.55) / 1.0) + st.skid * 0.03 + st.stall * 0.35 * Math.min(1, speed / 6)) * Math.min(1, speed / 5);
    this.fan = fanK * T.fan;
    if (fanK > 0.02 && speed > 2.5) {
      // Outward from the turn (away from the loaded rail), up, and back along the wake.
      const ox = -rX * side;
      const oz = -rZ * side;
      const tx = bx - fX * 0.9 + ox * 0.18;
      const tz = bz - fZ * 0.9 + oz * 0.18;
      const ty = wy + 0.05;
      const sub = 5;
      const total = (20 + 130 * fanK) * T.fan;
      for (let i = 0; i < sub; i++) {
        const a = (0.2 + (1.15 * (i + this.R[(this.ri = (this.ri + 1) & RM)])) / sub); // elevation of this slice of the fan (rad)
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const sp = 3.5 + 6 * fanK * (1 - 0.35 * (i / sub)) + speed * 0.12;
        const vx = vX * 0.45 - fX * 1.2 + ox * c * sp;
        const vz = vZ * 0.45 - fZ * 1.2 + oz * c * sp;
        const vy = sn * sp + 0.5;
        const n = (total / sub) | 0;
        const od = spray.reserve(SPRAY_DROPLET, n > 1 ? n : 1);
        if (od >= 0) {
          const e = spray.emitData;
          e[od] = tx;
          e[od + 1] = ty;
          e[od + 2] = tz;
          e[od + 4] = vx;
          e[od + 5] = vy;
          e[od + 6] = vz;
          e[od + 8] = 0.9 + 0.8 * fanK;
          e[od + 9] = 0.12;
          e[od + 11] = 0.007 + 0.009 * this.R[(this.ri = (this.ri + 1) & RM)];
          e[od + 12] = 0.7 + 0.5 * fanK;
          e[od + 13] = wy - 0.05;
        }
        // The shadow the fan casts: clumps of the same throw (the sheet is densest near the rail).
        const a2 = this.ps;
        a2[0] = tx;
        a2[1] = ty;
        a2[2] = tz;
        a2[3] = vx;
        a2[4] = vy;
        a2[5] = vz;
        a2[6] = (0.05 + 0.09 * fanK) * this.shadowScale;
        a2[7] = wy;
        this.spawnProxy();
        if (i < 2 && this.R[(this.ri = (this.ri + 1) & RM)] < fanK) {
          a2[3] = vx * 0.8;
          a2[4] = vy * 0.7;
          a2[5] = vz * 0.8;
          a2[6] = (0.07 + 0.1 * fanK) * this.shadowScale;
          this.spawnProxy();
        }
      }
      // The heavier, whiter core of the fan (a few clumps: most of a fan is droplets), and a
      // little mist that hangs out beyond it, away from the lens.
      const nc = (2 + 11 * fanK * T.fan) | 0;
      const oc = spray.reserve(SPRAY_FOAM, nc);
      if (oc >= 0) {
        const e = spray.emitData;
        e[oc] = tx;
        e[oc + 1] = ty;
        e[oc + 2] = tz;
        e[oc + 4] = vX * 0.4 + ox * (2.5 + 3 * fanK);
        e[oc + 5] = 1.5 + 2.5 * fanK;
        e[oc + 6] = vZ * 0.4 + oz * (2.5 + 3 * fanK);
        e[oc + 8] = 1.2;
        e[oc + 9] = 0.15;
        e[oc + 11] = 0.05 + 0.04 * fanK;
        e[oc + 12] = 0.7;
        e[oc + 13] = wy - 0.05;
      }
      if (this.R[(this.ri = (this.ri + 1) & RM)] < 0.7 * fanK) {
        const om = spray.reserve(SPRAY_MIST, 1);
        if (om >= 0) {
          const e = spray.emitData;
          e[om] = tx + ox * 1.8;
          e[om + 1] = ty + 0.35;
          e[om + 2] = tz + oz * 1.8;
          e[om + 4] = vX * 0.3 + ox * 1.8;
          e[om + 5] = 0.8;
          e[om + 6] = vZ * 0.3 + oz * 1.5;
          e[om + 8] = 0.6;
          e[om + 9] = 0.3;
          e[om + 11] = 0.35 + 0.3 * fanK;
          e[om + 12] = 2.2;
          e[om + 13] = wy - 2;
        }
      }
    }
    // ── Speed spray: a thin sheet off the inside rail streaming back past the lens ──
    if (speed > 7 && T.sheet > 0) {
      const k = Math.min(1, (speed - 7) / 8) * T.sheet;
      const n = (6 + 20 * k) | 0;
      const os = spray.reserve(SPRAY_DROPLET, n);
      if (os >= 0) {
        const e = spray.emitData;
        const sd = st.rail >= 0 ? 1 : -1;
        e[os] = bx + fX * 0.2 + rX * sd * 0.28;
        e[os + 1] = wy + 0.04;
        e[os + 2] = bz + fZ * 0.2 + rZ * sd * 0.28;
        e[os + 4] = vX * 0.25 + rX * sd * 1.8;
        e[os + 5] = 1.8 + 1.2 * k;
        e[os + 6] = vZ * 0.25 + rZ * sd * 1.8;
        e[os + 8] = 0.7;
        e[os + 9] = 0.06;
        e[os + 11] = 0.004 + 0.003 * this.R[(this.ri = (this.ri + 1) & RM)];
        e[os + 12] = 0.5;
        e[os + 13] = wy - 0.05;
      }
    }
    // ── The barrel: droplets falling off the ceiling ahead, and hanging mist ──
    if (st.tube > 0.3) {
      const b = st.bp;
      const ahead = 3 + 5 * this.R[(this.ri = (this.ri + 1) & RM)];
      const x = bx + b.peelX * ahead + b.dx * (0.3 + 0.8 * this.R[(this.ri = (this.ri + 1) & RM)]);
      const z = bz + b.peelZ * ahead + b.dz * (0.3 + 0.8 * this.R[(this.ri = (this.ri + 1) & RM)]);
      const y = Math.max(wy + 1.2, b.lipY - 0.2 - 0.5 * this.R[(this.ri = (this.ri + 1) & RM)]);
      const od = spray.reserve(SPRAY_DROPLET, (3 + 8 * st.tube) | 0);
      if (od >= 0) {
        const e = spray.emitData;
        e[od] = x;
        e[od + 1] = y;
        e[od + 2] = z;
        // Nearly still in the world: they hang in the barrel as the rider flies past them.
        e[od + 4] = b.dx * 0.6;
        e[od + 5] = -0.4;
        e[od + 6] = b.dz * 0.6;
        e[od + 8] = 0.35;
        e[od + 9] = 0.7;
        e[od + 11] = 0.004 + 0.004 * this.R[(this.ri = (this.ri + 1) & RM)];
        e[od + 12] = 1.1;
        e[od + 13] = wy - 0.1;
      }
      if (this.R[(this.ri = (this.ri + 1) & RM)] < 0.25 * st.tube) {
        const om = spray.reserve(SPRAY_MIST, 1);
        if (om >= 0) {
          const e = spray.emitData;
          e[om] = x;
          e[om + 1] = y - 0.4;
          e[om + 2] = z;
          e[om + 4] = b.dx * 1.5;
          e[om + 5] = 0;
          e[om + 6] = b.dz * 1.5;
          e[om + 8] = 0.3;
          e[om + 9] = 0.4;
          e[om + 11] = 0.3;
          e[om + 12] = 1.6;
          e[om + 13] = wy - 2;
        }
      }
    }
    // ── Landing from the air: a splash under the board ──
    if (st.landing > 1.2) {
      const k = Math.min(1, st.landing / 5);
      spray.burst(bx, wy + 0.05, bz, vX * 0.3, 1.5 + 2 * k, vZ * 0.3, 60 + 160 * k, 2 + 2 * k, 0.4, 0.4);
    }
  }

  private wipeFx(ride: Ride, spray: SprayService) {
    const w = ride.wipe;
    const e = spray.emitData;
    if (!this.wasWiping) {
      this.wasWiping = true;
      // The impact: a big burst where the rider went in.
      spray.burst(w.rpx, w.rpy - 0.2, w.rpz, w.rvx * 0.5, 2.5, w.rvz * 0.5, 420, 3.5, 0.6, 0.7);
    }
    if (w.whiteout < 0.05) return;
    // Whiteout: clumps and mist boiling round the lens (never right on it: the spray fades
    // particles within a few radii of the camera).
    const k = w.whiteout;
    for (let i = 0; i < 3; i++) {
      const a = this.R[(this.ri = (this.ri + 1) & RM)] * Math.PI * 2;
      const d = 0.9 + 1.4 * this.R[(this.ri = (this.ri + 1) & RM)];
      const x = w.eyeX + Math.cos(a) * d;
      const z = w.eyeZ + Math.sin(a) * d;
      const o = spray.reserve(i === 0 ? SPRAY_MIST : SPRAY_FOAM, i === 0 ? 1 : ((3 + 8 * k) | 0));
      if (o < 0) continue;
      e[o] = x;
      e[o + 1] = w.eyeY - 0.3 + 0.5 * this.R[(this.ri = (this.ri + 1) & RM)];
      e[o + 2] = z;
      e[o + 4] = w.rvx * 0.6;
      e[o + 5] = 1 + 1.5 * this.R[(this.ri = (this.ri + 1) & RM)];
      e[o + 6] = w.rvz * 0.6;
      e[o + 8] = 1.4;
      e[o + 9] = 0.4;
      e[o + 11] = i === 0 ? 0.6 : 0.16 + 0.12 * this.R[(this.ri = (this.ri + 1) & RM)];
      e[o + 12] = i === 0 ? 1.4 : 0.8;
      e[o + 13] = w.eyeY - 2;
    }
  }

  /** Jumping in off the pier (the entry splash) and climbing out (water streaming off). */
  private pierFx(ctx: GLContext, rig: PlayerRig, spray: SprayService | undefined, state: SurfaceStateService) {
    const dt = this.dt;
    const eye = rig.eye;
    const vy = (eye.y - this.eyePrev) / dt;
    this.eyePrev = eye.y;
    if (!spray) return;
    const e = spray.emitData;
    if (rig.mode === 'walk' || rig.mode === 'wade') {
      if (eye.y > 3.5) this.splashed = false;
      // Feet hitting the water from height: the entry.
      if (!this.splashed && vy < -5) {
        const s = ctx.services.ocean.sample(eye.x, eye.z, this.s);
        if (eye.y - s.height < 1.75) {
          this.splashed = true;
          this.sheet = 0.45;
          const k = Math.min(1.5, -vy / 9);
          spray.burst(eye.x, s.height + 0.05, eye.z, rig.velocity.x * 0.3, 3 + 2 * k, rig.velocity.z * 0.3, 380 + 300 * k, 2.6, 0.5, 0.7);
          const o = state.reserve ? state.reserve(3) : -1;
          if (o >= 0 && state.splatData) {
            const d = state.splatData;
            d[o] = SPLAT_FOAM;
            d[o + 1] = eye.x;
            d[o + 2] = eye.z;
            d[o + 3] = 0.8;
            d[o + 4] = 0.42;
            d[o + 5] = 0;
            d[o + 6] = 0;
            d[o + 7] = 1;
            d[o + 8] = SPLAT_WAKE;
            d[o + 9] = eye.x;
            d[o + 10] = eye.z;
            d[o + 11] = 0.9;
            d[o + 12] = 0.09;
            d[o + 13] = 0;
            d[o + 14] = 0;
            d[o + 15] = 1;
            d[o + 16] = SPLAT_FOAM;
            d[o + 17] = eye.x + rig.velocity.x * 0.3;
            d[o + 18] = eye.z + rig.velocity.z * 0.3;
            d[o + 19] = 0.5;
            d[o + 20] = 0.35;
            d[o + 21] = 0;
            d[o + 22] = 0;
            d[o + 23] = 1;
          }
        }
      }
    }
    // The sheet of water thrown up round the lens as the body goes in (the camera stops at the
    // surface inside it).
    if (this.sheet > 0) {
      this.sheet -= dt;
      for (let i = 0; i < 2; i++) {
        const a = this.R[(this.ri = (this.ri + 1) & RM)] * Math.PI * 2;
        const r = 0.7 + 0.9 * this.R[(this.ri = (this.ri + 1) & RM)];
        const o = spray.reserve(i === 0 ? SPRAY_FOAM : SPRAY_DROPLET, i === 0 ? 8 : 40);
        if (o < 0) continue;
        e[o] = eye.x + Math.cos(a) * r;
        e[o + 1] = eye.y - 0.35;
        e[o + 2] = eye.z + Math.sin(a) * r;
        e[o + 4] = Math.cos(a) * 1.2;
        e[o + 5] = 3.2 + 1.5 * this.R[(this.ri = (this.ri + 1) & RM)];
        e[o + 6] = Math.sin(a) * 1.2;
        e[o + 8] = 1.2;
        e[o + 9] = 0.3;
        e[o + 11] = i === 0 ? 0.14 : 0.008;
        e[o + 12] = 0.9;
        e[o + 13] = eye.y - 1.2;
      }
    }
    // Climbing out: water streams off the legs and shorts back into the channel.
    if (rig.mode === 'climb' && rig.modeTime < 2.6) {
      const k = 1 - rig.modeTime / 2.6;
      const o = spray.reserve(SPRAY_DROPLET, (4 + 14 * k) | 0);
      if (o >= 0) {
        const s = ctx.services.ocean.sample(eye.x, eye.z, this.s);
        e[o] = eye.x - Math.sin(rig.yaw) * 0.05;
        e[o + 1] = eye.y - 1.1 - 0.4 * this.R[(this.ri = (this.ri + 1) & RM)];
        e[o + 2] = eye.z - Math.cos(rig.yaw) * 0.05;
        e[o + 4] = 0;
        e[o + 5] = -0.3;
        e[o + 6] = 0;
        e[o + 8] = 0.25;
        e[o + 9] = 0.18;
        e[o + 11] = 0.005 + 0.004 * this.R[(this.ri = (this.ri + 1) & RM)];
        e[o + 12] = 1.2;
        e[o + 13] = s.height - 0.05;
      }
    }
  }

  private testFan(spray: SprayService) {
    const x = this.test[1];
    const y = this.test[2];
    const z = this.test[3];
    for (let i = 0; i < 5; i++) {
      const a = 0.25 + (1.1 * (i + this.R[(this.ri = (this.ri + 1) & RM)])) / 5;
      const vx = Math.cos(a) * 6;
      const vy = Math.sin(a) * 6;
      const vz = (this.R[(this.ri = (this.ri + 1) & RM)] - 0.5) * 2;
      const o = spray.reserve(SPRAY_DROPLET, 30);
      if (o >= 0) {
        const e = spray.emitData;
        e[o] = x;
        e[o + 1] = y;
        e[o + 2] = z;
        e[o + 4] = vx;
        e[o + 5] = vy;
        e[o + 6] = vz;
        e[o + 8] = 1.2;
        e[o + 9] = 0.12;
        e[o + 11] = 0.009;
        e[o + 12] = 0.9;
        e[o + 13] = y - 0.1;
      }
      const q = this.ps;
      q[0] = x;
      q[1] = y;
      q[2] = z;
      q[3] = vx;
      q[4] = vy;
      q[5] = vz;
      q[6] = 0.12;
      q[7] = y - 0.05;
      this.spawnProxy();
      q[3] = vx * 0.8;
      q[4] = vy * 0.8;
      q[6] = 0.14;
      this.spawnProxy();
    }
  }

  /** A shadow clump from this.ps (x, y, z, vx, vy, vz, radius, water y). */
  private spawnProxy() {
    const a = this.ps;
    const i = this.head;
    this.head = (this.head + 1) % NP;
    const j = i * 3;
    const s = 1.6;
    this.pp[j] = a[0];
    this.pp[j + 1] = a[1];
    this.pp[j + 2] = a[2];
    this.pv[j] = a[3] + (this.R[(this.ri = (this.ri + 1) & RM)] - 0.5) * s;
    this.pv[j + 1] = a[4] + (this.R[(this.ri = (this.ri + 1) & RM)] - 0.5) * s;
    this.pv[j + 2] = a[5] + (this.R[(this.ri = (this.ri + 1) & RM)] - 0.5) * s;
    this.pl[i] = 0.55 + 0.35 * this.R[(this.ri = (this.ri + 1) & RM)];
    this.pr[i] = a[6];
    this.pw[i] = a[7];
  }

  /** Ballistic clumps (the spray's droplet drag), written straight into the instance matrices. */
  private stepProxies() {
    const dt = this.dt;
    const a = this.proxies.instanceMatrix.array as Float32Array;
    let n = 0;
    const drag = dt > 0 ? 1 - Math.exp(-0.35 * dt) : 0;
    for (let i = 0; i < NP; i++) {
      if (this.pl[i] <= 0) continue;
      const j = i * 3;
      if (dt > 0) {
        this.pl[i] -= dt;
        this.pv[j] -= this.pv[j] * drag;
        this.pv[j + 1] -= this.pv[j + 1] * drag + G * dt;
        this.pv[j + 2] -= this.pv[j + 2] * drag;
        this.pp[j] += this.pv[j] * dt;
        this.pp[j + 1] += this.pv[j + 1] * dt;
        this.pp[j + 2] += this.pv[j + 2] * dt;
        if (this.pp[j + 1] < this.pw[i] - 0.1 && this.pv[j + 1] < 0) this.pl[i] = 0;
        if (this.pl[i] <= 0) continue;
      }
      // Clumps spread and thin out as they fly.
      const r = this.pr[i] * (0.7 + 0.6 * (1 - this.pl[i]));
      const o = n * 16;
      a[o] = r;
      a[o + 1] = 0;
      a[o + 2] = 0;
      a[o + 4] = 0;
      a[o + 5] = r;
      a[o + 6] = 0;
      a[o + 8] = 0;
      a[o + 9] = 0;
      a[o + 10] = r;
      a[o + 12] = this.pp[j];
      a[o + 13] = this.pp[j + 1];
      a[o + 14] = this.pp[j + 2];
      a[o + 15] = 1;
      n++;
    }
    this.proxies.count = n;
    if (n > 0 || dt > 0) this.proxies.instanceMatrix.needsUpdate = true;
  }

  /** Back to the start (a demo restarts): the same random sequence, no clumps, no trail. */
  reset() {
    this.ri = 0;
    this.head = 0;
    this.pl.fill(0);
    this.trailOk = false;
    this.wasWiping = false;
    this.splashed = false;
    this.sheet = 0;
    this.eyePrev = NaN; // no entry splash from a teleport
  }

  /** Pipeline warm-up: a few live proxies far under the sea for the loading frames. */
  warm() {
    const a = this.ps;
    a.fill(0);
    a[1] = -60;
    a[6] = 0.05;
    a[7] = -1e4;
    for (let i = 0; i < 4; i++) {
      a[0] = i * 0.5;
      this.spawnProxy();
      this.pl[(this.head + NP - 1) % NP] = 0.4;
    }
    this.dt = 0;
    this.stepProxies();
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.proxies.dispose();
  }
}
