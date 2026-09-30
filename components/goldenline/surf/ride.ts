// The ride: A6's RideDriver for pop-up → ride → wipeout / kick-out (see player/README.md).
//
// Controls (the player's intent, keyboard or a surf script):
//   mouse look  the line: the board carves toward where you look
//   A / D       rail to rail: carve left / right (the head is carried round with it)
//   W           pump and trim (weight forward), S stall (weight back: slows, lets the curl catch up)
//   Space       kick out (sit back onto the board and paddle)
//
// Everything is analogue and eased: the yaw rate has a rail-to-rail rate limit, the rail angle
// and the body's lean follow the accelerations the physics produces, and the camera takes a
// share of the lean (horizon bank), the drop (pitch), speed (FOV) and impacts (shake).
//
// Allocation-free once optimised: per-frame state is plain number fields (never three Vector3
// fields, which are tagged in this app), the frame's dt and control share are fields rather than
// arguments, and the eases and clamps are written out inline (a call V8 doesn't inline boxes
// every double through it). The only boxing left is at the ocean/breaker calls (their API takes
// doubles) and the contract writes into rig.boardPosition / boardQuat / velocity.

import type { GLContext, OceanSample, PlayerMode, WaveInfo } from '../core/contracts';
import { type BreakerPoint, type BreakingApi, newBreakerPoint } from '../ocean/breaking/service';
import type { PlayerRig, RideDriver } from '../player/api';
import { BoardSim, type SimTune } from './sim';
import { WIPE_CAUGHT, WIPE_FALLS, WIPE_LANDING, WIPE_PILING, WIPE_RAIL, Wipeout } from './wipeout';

const G = 9.81;
const TAU = Math.PI * 2;

export interface RideTune extends SimTune {
  /** Look-steering gain (1/s): yaw rate per radian between the view and the board. */
  lookGain: number;
  /** Carve limit (g of lateral acceleration) and the rail-to-rail yaw acceleration (rad/s²). */
  carveG: number;
  railRate: number;
  /** Camera: share of the body's lean shown as horizon bank, FOV push at speed (deg). */
  bank: number;
  fov: number;
  /**
   * The pocket's power (m/s² at full): the curl here peels at ~16 m/s, far beyond what trim
   * physics gives a board on a 3 m face (~9 m/s), so a board trimming along the line on the face
   * near the curl is driven to keep its place relative to it (φ at the board, see ocean/breaking).
   * 0 = pure physics (the curl overtakes you).
   */
  pocket: number;
}

/** What the effects and the system read from the ride each frame (plain numbers: no boxing). */
export interface RideState {
  active: boolean;
  wiping: boolean;
  /** Seconds since the pop-up landed. */
  t: number;
  /** Board speed through the water (m/s), lateral accel (m/s², + right), skid (m/s²). */
  speed: number;
  aLat: number;
  skid: number;
  /** Rail angle (rad, + = right rail down) and the stall / pump effort (0..1). */
  rail: number;
  stall: number;
  pump: number;
  /** 0..1 how much of a barrel is over the rider, whitewater coverage at the board. */
  tube: number;
  breaking: number;
  /** Landing impact (m/s) this frame. */
  landing: number;
  airborne: boolean;
  /** Board frame this frame (world): position, forward, right, up, and its velocity. */
  px: number;
  py: number;
  pz: number;
  fx: number;
  fy: number;
  fz: number;
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
  vx: number;
  vy: number;
  vz: number;
  surfaceY: number;
  /** The breaker here (reused object). */
  bp: BreakerPoint;
}

// Numeric fields start at -0, not 0: -0 isn't a Smi, so V8 gives each field a double
// representation from the start. A field that sat at Smi 0 until its first fractional value (the
// first air, the first landing) changed the object's map then and deoptimised the ride.
export class Ride implements RideDriver {
  readonly handlesWipeout = true;
  readonly sim: BoardSim;
  readonly state: RideState;
  readonly bp = newBreakerPoint();
  private readonly wv: WaveInfo = { stage: 0, dirX: 1, dirZ: 0, peelX: 0, peelZ: 1, peelSpeed: 0, crestDistance: 1e9, faceHeight: 0, hollowness: 0 };
  private readonly s: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 5 };
  // This frame's step and control share (fields, not arguments: see the header).
  private dt = -0;
  private control = 1;
  // Smoothed surface normal, the body's lean axis and the board's acceleration.
  private nSx = -0;
  private nSy = 1;
  private nSz = -0;
  private bodyX = -0;
  private bodyY = 1;
  private bodyZ = -0;
  private accX = -0;
  private accY = -0;
  private accZ = -0;
  private pitchS = -0;
  private railS = -0;
  private stallS = -0;
  private pumpS = -0;
  private pumpPh = -0;
  private crouchS = 0.5;
  private leanS = -0;
  private armsS = 0.5;
  private slowT = -0;
  private backT = -0;
  private dropK = -0;
  private popupDriven = false;
  private phiPrev = -0;
  /** Smoothed dφ/dt at the board (1/s): 0 = keeping pace with the peel. */
  dphiS = -0;
  /** Estimated peel speed along the line here (m/s, smoothed). */
  peelS = -0;
  /** The pocket drive this frame (m/s², debug). */
  drive = -0;
  t = -0;
  mode: 'ride' | 'wipeout' = 'ride';
  /** Why the last ride ended (debug log). */
  endReason = '';
  readonly wipe = new Wipeout();
  private caughtT = -0;
  private fallsT = -0;
  private railT = -0;

  constructor(private readonly tune: RideTune) {
    this.sim = new BoardSim(tune);
    this.state = {
      active: false,
      wiping: false,
      t: -0,
      speed: -0,
      aLat: -0,
      skid: -0,
      rail: -0,
      stall: -0,
      pump: -0,
      tube: -0,
      breaking: -0,
      landing: -0,
      airborne: false,
      px: -0,
      py: -0,
      pz: -0,
      fx: 1,
      fy: -0,
      fz: -0,
      rx: -0,
      ry: -0,
      rz: 1,
      ux: -0,
      uy: 1,
      uz: -0,
      vx: -0,
      vy: -0,
      vz: -0,
      surfaceY: -0,
      bp: this.bp,
    };
  }

  begin(ctx: GLContext, rig: PlayerRig) {
    // Already riding since the pop-up started: carry straight on.
    if (this.popupDriven && this.state.active) {
      this.popupDriven = false;
      return;
    }
    this.popupDriven = false;
    rig.stance.tumble = -1;
    this.caughtT = 0;
    this.fallsT = 0;
    this.railT = 0;
    const b = rig.boardPosition;
    // The board's nose (+X in the board frame) in the world.
    const q = rig.boardQuat;
    const ax = 1 - 2 * (q.y * q.y + q.z * q.z);
    const ay = 2 * (q.x * q.y + q.w * q.z);
    const az = 2 * (q.x * q.z - q.w * q.y);
    const yaw = Math.atan2(-ax, -az);
    const o = ctx.services.ocean;
    const s = o.sample(b.x, b.z, this.s);
    this.sim.reset(b.x, s.height, b.z, rig.velocity.x, 0, rig.velocity.z, yaw);
    this.nSx = s.nx;
    this.nSy = s.ny;
    this.nSz = s.nz;
    this.bodyX = 0;
    this.bodyY = 1;
    this.bodyZ = 0;
    this.accX = 0;
    this.accY = 0;
    this.accZ = 0;
    this.pitchS = Math.asin(Math.min(1, Math.max(-1, ay)));
    this.railS = 0;
    this.stallS = 0;
    this.pumpS = 0;
    this.pumpPh = 0;
    this.state.tube = 0;
    this.crouchS = 0.75;
    this.leanS = 0;
    this.armsS = 0.8;
    this.slowT = 0;
    this.backT = 0;
    this.dropK = 1;
    this.phiPrev = 0;
    this.dphiS = 0;
    this.peelS = 0;
    this.drive = 0;
    this.t = 0;
    this.mode = 'ride';
    this.endReason = '';
    this.state.active = true;
    this.state.wiping = false;
  }

  end() {
    this.state.active = false;
    this.state.wiping = false;
  }

  /** The pop-up: the board is already riding (the drop starts while the rider stands up). */
  popup(ctx: GLContext, rig: PlayerRig, dt: number, first: boolean) {
    if (first || !this.state.active) {
      this.begin(ctx, rig);
      this.popupDriven = true;
    }
    this.dt = dt;
    this.control = 0.35;
    this.frame(ctx, rig);
  }

  update(ctx: GLContext, rig: PlayerRig, dt: number): PlayerMode {
    if (this.mode === 'wipeout') {
      this.wipe.dt = dt;
      const m = this.wipe.update(ctx, rig);
      if (m !== 'wipeout') {
        this.mode = 'ride';
        this.state.active = false;
        this.state.wiping = false;
      }
      return m;
    }
    this.dt = dt;
    this.control = 1;
    return this.frame(ctx, rig);
  }

  /** One frame of riding. `control` < 1 during the pop-up (steering only, no pump or stall). */
  private frame(ctx: GLContext, rig: PlayerRig): PlayerMode {
    const dt = this.dt;
    const control = this.control;
    this.t += dt;
    const T = this.tune;
    const sim = this.sim;
    const st = this.state;
    const ocean = ctx.services.ocean;
    const brk = (ocean.gpu as { breaking?: BreakingApi }).breaking;
    const bp = this.bp;
    const it = rig.intent;

    // ── The wave here ──
    if (brk) brk.breaker(sim.px, sim.pz, bp);
    else bp.active = 0;
    const wv = ocean.wave(sim.px, sim.pz, this.wv);
    // The surface's translation: the breaker's crest speed, or the swell's (shallow-water) speed.
    const act = bp.active > 0.02 ? Math.min(1, bp.active * 1.6) : 0;
    const cSwell = Math.min(12, Math.sqrt(G * Math.max(1, sim.depth)));
    const um = act > 0 || wv.stage > 0 ? 1 : 0.6;
    sim.Ux = (bp.dx * bp.c * act + wv.dirX * cSwell * (1 - act)) * um;
    sim.Uz = (bp.dz * bp.c * act + wv.dirZ * cSwell * (1 - act)) * um;
    sim.onBreaker = act;

    // ── Controls ──
    const speed = sim.speedWater > 0 ? sim.speedWater : 0;
    const wantPump = it.fwd > 0.2 && control >= 1 ? 1 : 0;
    const wantStall = it.fwd < -0.2 && control >= 1 ? 1 : 0;
    this.pumpS = wantPump + (this.pumpS - wantPump) * Math.exp((wantPump > this.pumpS ? -6 : -4) * dt);
    this.stallS = wantStall + (this.stallS - wantStall) * Math.exp((wantStall > this.stallS ? -5 : -3.5) * dt);
    // Pumping is rhythmic (~1.4 Hz): thrust on the down-weighting half of each cycle.
    this.pumpPh = (this.pumpPh + dt * 1.4 * (this.pumpS > 0.05 ? 1 : 0)) % 1;
    const pumpWave = 0.5 + 0.5 * Math.sin(this.pumpPh * TAU);
    sim.pump = this.pumpS * (0.4 + 0.9 * pumpWave);
    sim.stall = this.stallS;
    // Turn: toward the view, plus the rails (A/D) which also carry the head round.
    // The carve limit: the fins' grip (carveG) at speed; slow, a board barely planes and pivots little.
    const omegaMax = sim.airborne ? 0.4 : Math.min(2.9, (T.carveG * G) / Math.max(3.2, speed), 0.4 + speed / 1.6) * (1 - 0.5 * sim.breaking);
    let look = (rig.yaw - sim.yaw + Math.PI) % TAU;
    if (look < 0) look += TAU;
    look -= Math.PI;
    const wRail = -it.side * omegaMax * 0.85 * control;
    // A look over the shoulder (beyond ~75°) is a glance, not a line: its pull fades out by ~115°.
    const al = look < 0 ? -look : look;
    const glance = al < 1.3 ? 1 : al > 2.0 ? 0 : (2.0 - al) / 0.7;
    const wT = Math.min(omegaMax, Math.max(-omegaMax, T.lookGain * look * control * glance + wRail));
    const dw = T.railRate * dt;
    sim.omega += Math.min(dw, Math.max(-dw, wT - sim.omega));
    // The A/D share of the turn carries the view.
    if (it.side !== 0) rig.viewTurn += Math.min(omegaMax, Math.max(-omegaMax, wRail)) * dt * 0.85;

    // ── The pocket: keep the board's place relative to the curl ──
    // φ at the board says where it is along the breaking wave: < 0 ahead of the curl on the open
    // face, 0 where the lip pitches, 1–3 under the thrown lip (the tube), > 3 the collapse. At a
    // point φ grows at 1/T_s; riding along the line at the peel speed holds it still, so
    // dφ/dt = (1 − v_line / peel) / T_s gives the peel speed from the board's own motion (the
    // tracker's per-column peel is too ripply to steer by).
    {
      const fresh = bp.active > 0.3 && Math.abs(bp.phi - this.phiPrev) < 0.6 && dt > 0;
      const dphi = fresh ? Math.min(4, Math.max(-4, (bp.phi - this.phiPrev) / dt)) : 0;
      this.dphiS = dphi + (this.dphiS - dphi) * Math.exp(-6 * dt);
      this.phiPrev = bp.phi;
      const vLine = sim.vx * bp.peelX + sim.vz * bp.peelZ;
      if (fresh) {
        const den = 1 - bp.Ts * this.dphiS;
        const est = den > 0.35 ? Math.min(22, Math.max(6, vLine / den)) : 22;
        this.peelS = this.peelS > 0 ? est + (this.peelS - est) * Math.exp(-1.2 * dt) : Math.min(20, Math.max(8, bp.peelSpeed));
      }
      let drive = 0;
      if (fresh && T.pocket > 0) {
        const align = -Math.sin(sim.yaw) * bp.peelX - Math.cos(sim.yaw) * bp.peelZ;
        // On the face (not the flat trough ahead or the back), near the curl.
        const face = Math.min(1, Math.max(0, (1 - sim.ny) / 0.12)) * (bp.u > -0.8 && bp.u < 2.4 * bp.H ? 1 : 0);
        const zone = Math.min(1, Math.max(0, (bp.phi + 4.2) / 1.5)) * Math.min(1, Math.max(0, (4.6 - bp.phi) / 1.2));
        // Only along the line: pointing down the face or up it, the board is on its own.
        const along = Math.min(1, Math.max(0, (align - 0.45) / 0.4));
        if (along > 0 && face * zone > 0) {
          // Where the rider asks to be: stalling sits back into the tube, pumping runs ahead.
          const target = -0.8 - 1.2 * this.pumpS + 2.8 * this.stallS;
          const ff = (T.drag1 + T.drag2 * speed) * speed;
          const pd = 3.2 * (bp.phi - target) + 5 * this.dphiS;
          // Never much faster than the curl itself: the pocket's power is the wave's.
          const cap = Math.min(1, Math.max(0, (this.peelS * (1.06 + 0.06 * this.pumpS) - vLine) / 1.5));
          drive = Math.min(T.pocket, Math.max(0, ff * 0.92 + pd)) * cap * face * zone * along * along * (3 - 2 * along) * (1 - 0.85 * this.stallS);
        }
      }
      this.drive = drive + (this.drive - drive) * Math.exp(-10 * dt);
      sim.drive = this.drive;
    }

    // ── Physics ──
    const v0x = sim.vx;
    const v0y = sim.vy;
    const v0z = sim.vz;
    sim.dt = dt;
    sim.run(ocean);
    if (dt > 0) {
      const e = Math.exp(-14 * dt);
      const ax = (sim.vx - v0x) / dt;
      const ay = (sim.vy - v0y) / dt;
      const az = (sim.vz - v0z) / dt;
      this.accX = ax + (this.accX - ax) * e;
      this.accY = ay + (this.accY - ay) * e;
      this.accZ = az + (this.accZ - az) * e;
    }

    // ── Board attitude: nose/tail on the water, rail angle from the carve ──
    const hN = ocean.sample(sim.px + sim.fx * 0.8, sim.pz + sim.fz * 0.8, this.s).height;
    const hT = ocean.sample(sim.px - sim.fx * 0.8, sim.pz - sim.fz * 0.8, this.s).height;
    let nsx;
    let nsy;
    let nsz;
    {
      const e = Math.exp(-16 * dt);
      nsx = sim.nx + (this.nSx - sim.nx) * e;
      nsy = sim.ny + (this.nSy - sim.ny) * e;
      nsz = sim.nz + (this.nSz - sim.nz) * e;
      const l = Math.sqrt(nsx * nsx + nsy * nsy + nsz * nsz) || 1;
      nsx /= l;
      nsy /= l;
      nsz /= l;
      this.nSx = nsx;
      this.nSy = nsy;
      this.nSz = nsz;
    }
    const hx = -Math.sin(sim.yaw);
    const hz = -Math.cos(sim.yaw);
    let pitchT = sim.airborne ? this.pitchS : Math.atan2(hN - hT, 1.6);
    // Stall: weight on the tail, nose up; planing lifts the nose a touch at low speed.
    pitchT += 0.14 * this.stallS + 0.05 * (1 - Math.min(1, speed / 6)) - 0.03 * this.pumpS * pumpWave;
    this.pitchS = pitchT + (this.pitchS - pitchT) * Math.exp((sim.airborne ? -3 : -14) * dt);
    const cp = Math.cos(this.pitchS);
    const fwx = hx * cp;
    const fwy = Math.sin(this.pitchS);
    const fwz = hz * cp;
    // Rail: bank into the turn (coordinated: tan ρ = v·ω / g_n) and bite the uphill rail on a steep face.
    {
      const bankT = Math.min(1.05, Math.max(-1.05, Math.atan2(-sim.omega * Math.max(2, speed), G * Math.max(0.3, nsy))));
      this.railS = bankT + (this.railS - bankT) * Math.exp(-9 * dt);
    }
    // Board up: the surface normal, square to the nose ...
    const dn = nsx * fwx + nsy * fwy + nsz * fwz;
    let upx = nsx - fwx * dn;
    let upy = nsy - fwy * dn;
    let upz = nsz - fwz * dn;
    let l = Math.sqrt(upx * upx + upy * upy + upz * upz) || 1;
    upx /= l;
    upy /= l;
    upz /= l;
    // ... and its right (nose × up).
    let rgx = fwy * upz - fwz * upy;
    let rgy = fwz * upx - fwx * upz;
    let rgz = fwx * upy - fwy * upx;
    l = Math.sqrt(rgx * rgx + rgy * rgy + rgz * rgz) || 1;
    rgx /= l;
    rgy /= l;
    rgz /= l;
    // Rolled about the nose by the rail (+ = right rail down), and the bite: level the board part
    // way on a traverse (its uphill rail digs into the face).
    {
      const roll = this.railS + 0.4 * Math.asin(Math.min(1, Math.max(-1, rgy)));
      const c = Math.cos(roll);
      const sn = Math.sin(roll);
      const ux = upx * c + rgx * sn;
      const uy = upy * c + rgy * sn;
      const uz = upz * c + rgz * sn;
      rgx = rgx * c - upx * sn;
      rgy = rgy * c - upy * sn;
      rgz = rgz * c - upz * sn;
      upx = ux;
      upy = uy;
      upz = uz;
    }
    // The board's frame → world: columns nose (+X), up (+Y), right (+Z) → quaternion.
    {
      const m11 = fwx;
      const m21 = fwy;
      const m31 = fwz;
      const m12 = upx;
      const m22 = upy;
      const m32 = upz;
      const m13 = rgx;
      const m23 = rgy;
      const m33 = rgz;
      const tr = m11 + m22 + m33;
      let qx;
      let qy;
      let qz;
      let qw;
      if (tr > 0) {
        const k = 0.5 / Math.sqrt(tr + 1);
        qw = 0.25 / k;
        qx = (m32 - m23) * k;
        qy = (m13 - m31) * k;
        qz = (m21 - m12) * k;
      } else if (m11 > m22 && m11 > m33) {
        const k = 2 * Math.sqrt(1 + m11 - m22 - m33);
        qw = (m32 - m23) / k;
        qx = 0.25 * k;
        qy = (m12 + m21) / k;
        qz = (m13 + m31) / k;
      } else if (m22 > m33) {
        const k = 2 * Math.sqrt(1 + m22 - m11 - m33);
        qw = (m13 - m31) / k;
        qx = (m12 + m21) / k;
        qy = 0.25 * k;
        qz = (m23 + m32) / k;
      } else {
        const k = 2 * Math.sqrt(1 + m33 - m11 - m22);
        qw = (m21 - m12) / k;
        qx = (m13 + m31) / k;
        qy = (m23 + m32) / k;
        qz = 0.25 * k;
      }
      rig.boardQuat.set(qx, qy, qz, qw);
    }
    // Planing: the board rides a little higher at speed.
    const bpy = sim.py - (0.02 - 0.018 * Math.min(1, speed / 8));
    rig.boardPosition.set(sim.px, bpy, sim.pz);
    rig.velocity.set(sim.vx, sim.vy, sim.vz);
    rig.speed = speed;

    // ── Rider: the lean follows the carve (v·ω toward the turn centre), the drop and the push or
    // brake along the board (effective gravity) — not the rail's holding force, which on a face
    // balances gravity and doesn't tip a rider over. The eye stays out of the face. ──
    let cx;
    let cy;
    let cz;
    {
      // Horizontal right of the heading: (−hz, 0, hx).
      const ac = -sim.omega * speed;
      const along = Math.min(6, Math.max(-6, this.accX * hx + this.accZ * hz)) * 0.35;
      const vert = Math.min(6, Math.max(-7, this.accY)) * 0.45;
      cx = -hz * ac + hx * along;
      cy = G + vert;
      cz = hx * ac + hz * along;
      if (cy < 3) cy = 3;
      const lc = Math.sqrt(cx * cx + cy * cy + cz * cz);
      cx /= lc;
      cy /= lc;
      cz /= lc;
    }
    // At most ~52° off vertical.
    if (cy < 0.62) {
      const k = Math.sqrt((1 - 0.62 * 0.62) / Math.max(1e-6, 1 - cy * cy));
      cx *= k;
      cz *= k;
      cy = 0.62;
    }
    {
      const e = Math.exp(-7 * dt);
      let bx = cx + (this.bodyX - cx) * e;
      let by = cy + (this.bodyY - cy) * e;
      let bz = cz + (this.bodyZ - cz) * e;
      let lb = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
      bx /= lb;
      by /= lb;
      bz /= lb;
      // Keep the head clear of a steep face: probe where the eye will be and lean away if it is in it.
      const eh = 1.5 - 0.4 * this.crouchS;
      const se = ocean.sample(sim.px + bx * eh, sim.pz + bz * eh, this.s);
      const clear = sim.py + by * eh - se.height;
      if (clear < 0.45) {
        const k = Math.min(0.8, (0.45 - clear) * 1.2);
        bx += se.nx * k;
        bz += se.nz * k;
        lb = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
        bx /= lb;
        by /= lb;
        bz /= lb;
      }
      this.bodyX = bx;
      this.bodyY = by;
      this.bodyZ = bz;
    }

    // ── Tube: how much barrel is over the rider ──
    let tube = 0;
    if (bp.active > 0.05 && bp.tube > 0.05) {
      // Inside when the rider is under the thrown lip: between the face and the lip tip, low.
      const du = bp.u;
      const lipU = (bp.lipX - bp.cx) * bp.dx + (bp.lipZ - bp.cz) * bp.dz;
      tube = du > -0.6 && du < lipU + 0.3 ? bp.tube : 0;
    }
    st.tube = tube + (st.tube - tube) * Math.exp((tube > st.tube ? -5 : -3) * dt);

    // ── Stance ──
    const gLoad = Math.sqrt(cx * cx + cz * cz) / Math.max(0.3, cy);
    {
      const dk = sim.airborne || -sim.vy > 2.5 ? 1 : 0;
      this.dropK = dk + (this.dropK - dk) * Math.exp(-4 * dt);
    }
    const g1 = Math.min(1, gLoad);
    let crouchT = 0.38 + 0.35 * Math.min(1, gLoad * 1.3) + 0.3 * this.stallS + 0.25 * this.dropK + 0.55 * st.tube;
    crouchT += this.pumpS * 0.16 * (pumpWave - 0.5);
    crouchT = Math.min(0.86, Math.max(0.15, crouchT));
    this.crouchS = crouchT + (this.crouchS - crouchT) * Math.exp(-6 * dt);
    // Heel/toe: a right turn is on the toes (regular foot faces the right rail).
    const leanT = Math.min(1, Math.max(-1, this.railS * 1.4));
    this.leanS = leanT + (this.leanS - leanT) * Math.exp(-7 * dt);
    const armsT = Math.min(1, 0.35 + 0.5 * g1 + 0.3 * this.dropK + 0.2 * this.stallS);
    this.armsS = armsT + (this.armsS - armsT) * Math.exp(-4 * dt);
    const sp = rig.stance;
    sp.crouch = this.crouchS;
    sp.lean = this.leanS;
    sp.fore = Math.min(1, Math.max(-1, 0.35 * this.pumpS - 0.6 * this.stallS + 0.25 * this.dropK));
    sp.arms = this.armsS;
    sp.bodyX = this.bodyX;
    sp.bodyY = this.bodyY;
    sp.bodyZ = this.bodyZ;

    // ── Camera ──
    const cam = rig.cam;
    // View right (horizontal): forward × up = (−fz, 0, fx) for the view forward (fx, 0, fz).
    const lean = this.bodyX * Math.cos(rig.yaw) - this.bodyZ * Math.sin(rig.yaw); // + = leaning right
    cam.roll = -Math.asin(Math.min(1, Math.max(-1, lean))) * T.bank;
    cam.fovKick = T.fov * Math.min(1, Math.max(0, (speed - 4) / 10));
    // The head follows the board down the face (more of it while dropping: the horizon falls away).
    cam.pitchOffset = Math.min(0.3, Math.max(-0.7, this.pitchS)) * (0.3 + 0.5 * this.dropK);
    // (Branch-free sums: optimised code deopts the first time a cold branch's arithmetic runs.)
    const shake =
      Math.min(0.5, sim.landing * 0.12) * (sim.landing > 0.8 ? 1 : 0) +
      Math.min(0.08, sim.skid * 0.004) * (sim.skid > 2 ? 1 : 0) +
      (this.dropK > 0.5 && -sim.vy > 3 ? 0.012 : 0) +
      0.02 * sim.breaking * (sim.breaking > 0.5 ? 1 : 0);
    if (shake > 0) cam.shake(shake);

    // ── Outputs ──
    st.t = this.t;
    st.speed = speed;
    st.aLat = sim.aLat;
    st.skid = sim.skid;
    st.rail = this.railS;
    st.stall = this.stallS;
    st.pump = this.pumpS;
    st.breaking = sim.breaking;
    st.landing = sim.landing;
    st.airborne = sim.airborne;
    st.px = sim.px;
    st.py = bpy;
    st.pz = sim.pz;
    st.fx = fwx;
    st.fy = fwy;
    st.fz = fwz;
    st.ux = upx;
    st.uy = upy;
    st.uz = upz;
    st.rx = rgx;
    st.ry = rgy;
    st.rz = rgz;
    st.vx = sim.vx;
    st.vy = sim.vy;
    st.vz = sim.vz;
    st.surfaceY = sim.surfaceY;

    // ── Endings ── (the player owns the pop-up's timing)
    if (control < 1) return 'ride';
    // Wipeouts. The lip lands on a rider who falls back into a collapsing section; one caught
    // high at a pitching lip goes over with it; a buried rail at low speed, a piling, a flat
    // landing from height all throw the rider.
    if (bp.active > 0.3) {
      const kap = bp.kappa;
      const vy0 = 0.1 + 0.2 * kap;
      const collapse = 0.45 + vy0 + Math.sqrt(vy0 * vy0 + 2) + 0.35 + 0.6 * kap;
      const caught = bp.phi > collapse + 0.3 && sim.breaking > 0.5;
      this.caughtT = caught ? this.caughtT + dt : Math.max(0, this.caughtT - dt);
      const atLip = bp.phi > -0.3 && bp.phi < collapse && sim.py > bp.crestY - 0.3 * bp.H && bp.u < 0.5;
      this.fallsT = atLip ? this.fallsT + dt : Math.max(0, this.fallsT - dt);
    } else {
      this.caughtT = Math.max(0, this.caughtT - dt);
      this.fallsT = 0;
    }
    this.railT = Math.abs(this.railS) > 1.0 && speed < 4.5 ? this.railT + dt : 0;
    let wipe = 0;
    if (this.caughtT > 0.25) wipe = WIPE_CAUGHT;
    else if (this.fallsT > 0.15) wipe = WIPE_FALLS;
    else if (this.railT > 0.3) wipe = WIPE_RAIL;
    else if (sim.landing > 5.5) wipe = WIPE_LANDING;
    else {
      const pier = ctx.services.pier;
      const pl = pier.pilings;
      const rr = pier.pilingRadius + 0.32;
      for (let i = 0; i < pl.length; i += 2) {
        const dx = sim.px - pl[i];
        const dz = sim.pz - pl[i + 1];
        if (dx * dx + dz * dz < rr * rr) {
          wipe = WIPE_PILING;
          break;
        }
      }
    }
    if (wipe > 0) {
      this.endReason = wipe === WIPE_CAUGHT ? 'caught inside' : wipe === WIPE_FALLS ? 'over the falls' : wipe === WIPE_RAIL ? 'caught a rail' : wipe === WIPE_PILING ? 'piling' : 'landing';
      this.mode = 'wipeout';
      this.state.wiping = true;
      this.wipe.start(ctx, rig, wipe, rig.eye.x, rig.eye.y, rig.eye.z);
      return 'wipeout';
    }
    if (sim.depth < 0.45) return this.finish('shallow', 'paddle');
    if (it.action && this.t > 0.5) return this.finish('kick-out', 'paddle');
    // Over the back / the wave has gone: slow for a while.
    this.slowT = speed < 1.6 ? this.slowT + dt : 0;
    if (this.slowT > 0.7) return this.finish('slow', 'paddle');
    const behind = bp.active > 0.2 && bp.u < -1.2 && sim.vx * bp.dx + sim.vz * bp.dz < bp.c * 0.6;
    this.backT = behind ? this.backT + dt : 0;
    if (this.backT > 0.6) return this.finish('over the back', 'paddle');
    return 'ride';
  }

  private finish(reason: string, m: PlayerMode): PlayerMode {
    this.endReason = reason;
    this.state.active = false;
    return m;
  }
}
