// The player's state machine and locomotion: walk (sand and pier), wade, paddle, catch, pop-up,
// and the ride/wipeout hand-off. Pure CPU, zero allocation per frame. Poses are built from this
// state by poses.ts; transitions are blended there, so a mode change never snaps.

import { Vector3 } from 'three/webgpu';
import type { GLContext, OceanSample, PlayerMode, WaveInfo } from '../core/contracts';
import { SPLAT_FOOTPRINT, SPLAT_WAKE, SPLAT_WET } from '../core/contracts';
import { clamp, damp } from '../core/pool';
import { PIER, TERRAIN_BOUNDS } from '../world/layout';
import type { RideDriver } from './api';
import { Gait } from './gait';
import type { Intent } from './intent';
import { TAU, wrapAngle } from './rigmath';

export const EYE_H = 1.66;
const WALK = 1.45;
const RUN = 3.4;
const G = 9.81;

/** Default blend (s) into each mode. */
const BLEND: Record<PlayerMode, number> = {
  walk: 0.45,
  wade: 0.5,
  paddle: 0.95,
  catch: 0.45,
  popup: 0.12,
  ride: 0.25,
  wipeout: 0.3,
};

export interface Tunables {
  walkSpeed: number;
  runSpeed: number;
  paddleThrust: number;
  bob: number;
  catchAssist: number;
}

export class PlayerCore {
  mode: PlayerMode = 'walk';
  from: PlayerMode = 'walk';
  /** 0..1 progress of the blend from `from` into `mode`. */
  blend = 1;
  blendDur = 0.5;
  modeTime = 0;
  t = 0;

  /** Walk/wade: the ground point under the body. Prone/ride: the board origin (x, z), water y. */
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  /** Body / board heading (layout yaw convention). */
  heading = 0;
  /** View. */
  yaw = 0;
  pitch = 0;

  // Standing
  feetY = 0;
  vy = 0;
  airborne = false;
  onPier = false;
  groundY = 0;
  waterY = 0;
  /** Water depth above the feet / under the board. */
  depth = 0;
  readonly gait = new Gait();
  /** 0..1 how far into the water the board is (carry → floating alongside). */
  boardFloat = 0;
  speed = 0;
  bobPhase = 0;

  // Prone
  stroke = 0;
  strokeRate = 0;
  paddleW = 0;
  push = 0;
  readonly boardN = new Vector3(0, 1, 0);
  boardPitch = 0;
  boardRoll = 0;
  catchProgress = 0;
  whitewater = 0;

  // Ride hand-off
  driver: RideDriver | null = null;
  rideSpeed = 0;
  wipeT = 0;

  // Surfaces
  wet = 0;
  feetWet = 0;
  readonly sample: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 2 };
  readonly wave: WaveInfo = { stage: 0, dirX: 1, dirZ: 0, peelX: 0, peelZ: 1, peelSpeed: 0, crestDistance: 1e9, faceHeight: 0, hollowness: 0 };
  private readonly clampOut = new Float32Array(2);
  /** Set by the ride hand-off when a mode change is requested from outside. */
  requested: PlayerMode | null = null;
  requestedBlend = 0;

  private readonly ctx: GLContext;
  private readonly tune: Tunables;

  constructor(ctx: GLContext, tune: Tunables) {
    this.ctx = ctx;
    this.tune = tune;
  }

  /** Walkable height under (x, z) for feet near y: pier deck/steps if close, else terrain. */
  ground = (x: number, z: number): number => {
    const t = this.ctx.services.terrain.height(x, z);
    const p = this.ctx.services.pier.surfaceAt(x, z, this.feetY);
    if (p === p && p > t - 0.05 && p <= this.feetY + 0.5) return p;
    return t;
  };

  private onPierAt(x: number, z: number) {
    const t = this.ctx.services.terrain.height(x, z);
    const p = this.ctx.services.pier.surfaceAt(x, z, this.feetY);
    return p === p && p > t + 0.05 && p <= this.feetY + 0.5;
  }

  /** Debug: log every mode change (player.log). */
  logModes = false;

  setMode(m: PlayerMode, blend?: number) {
    if (m === this.mode) return;
    if (this.logModes) console.warn(`[player] ${this.mode} → ${m} at t=${this.t.toFixed(2)} speed=${this.speed.toFixed(2)}`);
    this.from = this.mode;
    this.mode = m;
    this.blend = 0;
    this.blendDur = blend ?? BLEND[m];
    this.modeTime = 0;
    if (m === 'walk' || m === 'wade') {
      if (this.from !== 'walk' && this.from !== 'wade') {
        // Coming off the board: stand where the chest was.
        this.feetY = this.ground(this.pos.x, this.pos.z);
        this.gait.reset(this.pos.x, this.pos.z, this.heading, this.ground);
      }
    }
    if (m === 'paddle' && (this.from === 'walk' || this.from === 'wade')) {
      this.stroke = 0.62;
    }
    if (m === 'catch') this.catchProgress = 0;
    if (m === 'ride' && this.driver) this.driver.begin(this.ctx, this.ctx.services.player as never);
    if (this.from === 'ride' && this.driver?.end) this.driver.end(this.ctx, this.ctx.services.player as never);
  }

  teleport(x: number, z: number, yaw: number, mode: PlayerMode) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.heading = yaw;
    this.yaw = yaw;
    this.pitch = 0;
    this.mode = mode;
    this.from = mode;
    this.blend = 1;
    this.modeTime = 0;
    this.vy = 0;
    this.airborne = false;
    this.feetY = this.ctx.services.terrain.height(x, z);
    this.feetY = this.ground(x, z);
    this.gait.reset(x, z, yaw, this.ground);
    this.paddleW = 0;
    this.push = 0;
    this.boardFloat = mode === 'walk' ? 0 : 1;
    this.wet = mode === 'walk' ? 0 : 1;
    this.feetWet = this.wet;
    this.sampleWater();
    this.boardN.set(this.sample.nx, this.sample.ny, this.sample.nz);
  }

  private sampleWater() {
    const o = this.ctx.services.ocean;
    o.sample(this.pos.x, this.pos.z, this.sample);
    if (this.lab.on) this.labSample();
    this.waterY = this.sample.height;
    return this.sample;
  }

  /**
   * Lab stand-in for a breaking wave until the breaker system exists: a head-high swell hump
   * travelling along `lab.dir`, added to the CPU sample and reported by wave(). It only moves
   * the player (the rendered water doesn't show it); use it to review catch / pop-up motion.
   */
  readonly lab = { on: false, t: 0, x0: 0, z0: 0, dirX: 1, dirZ: 0, c: 5.2, amp: 0.85, sigma: 4.5 };

  startLabWave(behind: number) {
    const hx = -Math.sin(this.heading);
    const hz = -Math.cos(this.heading);
    this.lab.on = true;
    this.lab.t = 0;
    this.lab.dirX = hx;
    this.lab.dirZ = hz;
    this.lab.x0 = this.pos.x - hx * behind;
    this.lab.z0 = this.pos.z - hz * behind;
  }

  private labCrest() {
    const L = this.lab;
    return (this.pos.x - (L.x0 + L.dirX * L.c * L.t)) * L.dirX + (this.pos.z - (L.z0 + L.dirZ * L.c * L.t)) * L.dirZ;
  }

  private labSample() {
    const L = this.lab;
    const sd = this.labCrest(); // + = shoreward of the crest
    const g = Math.exp(-(sd * sd) / (L.sigma * L.sigma));
    const h = L.amp * g;
    const dh = (-2 * sd * h) / (L.sigma * L.sigma);
    const s = this.sample;
    s.height += h;
    const nx = s.nx - dh * L.dirX;
    const nz = s.nz - dh * L.dirZ;
    const len = Math.hypot(nx, s.ny, nz);
    s.nx = nx / len;
    s.ny = s.ny / len;
    s.nz = nz / len;
    s.vx += L.dirX * L.c * (h / Math.max(1.5, s.depth)) * 1.2;
    s.vz += L.dirZ * L.c * (h / Math.max(1.5, s.depth)) * 1.2;
  }

  private waveAt(): WaveInfo {
    const w = this.ctx.services.ocean.wave(this.pos.x, this.pos.z, this.wave);
    if (this.lab.on && w.stage === 0) {
      const sd = this.labCrest();
      w.stage = Math.abs(sd) < 12 ? 0.6 : 0;
      w.dirX = this.lab.dirX;
      w.dirZ = this.lab.dirZ;
      w.crestDistance = -sd;
      w.faceHeight = this.lab.amp * 1.6;
      w.hollowness = 0.3;
    }
    return w;
  }

  update(dt: number, it: Intent) {
    this.t += dt;
    if (this.lab.on) {
      this.lab.t += dt;
      if (this.lab.t > 25) this.lab.on = false;
    }
    this.modeTime += dt;
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / Math.max(1e-3, this.blendDur));
    if (this.requested) {
      const m = this.requested;
      this.requested = null;
      this.setMode(m, this.requestedBlend || undefined);
    }
    switch (this.mode) {
      case 'walk':
      case 'wade':
        this.updateStanding(dt, it);
        break;
      case 'paddle':
      case 'catch':
        this.updateProne(dt, it);
        break;
      case 'popup':
        this.updatePopup(dt, it);
        break;
      case 'ride':
        this.updateRide(dt, it);
        break;
      case 'wipeout':
        this.updateWipeout(dt, it);
        break;
    }
    // Skin and board dry slowly out of the water; salt shows as they dry.
    const inWater = this.mode !== 'walk' || this.depth > 0.25;
    this.wet = inWater ? damp(this.wet, 1, 3, dt) : Math.max(0, this.wet - dt / 150);
  }

  // ── Walk / wade ──────────────────────────────────────────────────────────────────────

  private updateStanding(dt: number, it: Intent) {
    const wading = this.mode === 'wade';
    this.yaw -= it.lookX;
    this.pitch = clamp(this.pitch - it.lookY, -1.1, 1.35);
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    let mx = fx * it.fwd + -fz * it.side;
    let mz = fz * it.fwd + fx * it.side;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    const s = this.sampleWater();
    this.depth = Math.max(0, this.waterY - this.feetY);
    const dFac = clamp(this.depth / 1.1, 0, 1);
    const top = (it.run ? this.tune.runSpeed : this.tune.walkSpeed) * (1 - 0.62 * dFac);
    const accel = this.airborne ? 0.6 : 8 - 5 * dFac;
    this.vel.x = damp(this.vel.x, mx * top, accel, dt);
    this.vel.z = damp(this.vel.z, mz * top, accel, dt);
    if (this.depth > 0.03) {
      // The swash drags at the legs: pull toward the water's own velocity.
      const tug = 1.4 * Math.min(1, this.depth / 0.5);
      this.vel.x += (s.vx - this.vel.x) * Math.min(1, tug * dt);
      this.vel.z += (s.vz - this.vel.z) * Math.min(1, tug * dt);
    }
    let nx = this.pos.x + this.vel.x * dt;
    let nz = this.pos.z + this.vel.z * dt;
    // Pier railings, pilings, world bounds.
    const pier = this.ctx.services.pier;
    pier.clampToDeck(nx, nz, this.feetY, this.clampOut);
    nx = this.clampOut[0];
    nz = this.clampOut[1];
    if (this.feetY < PIER.deckHeight - 0.8) {
      const pl = pier.pilings;
      const r = pier.pilingRadius + 0.28;
      for (let i = 0; i < pl.length; i += 2) {
        const dx = nx - pl[i];
        const dz = nz - pl[i + 1];
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          nx = pl[i] + (dx / d) * r;
          nz = pl[i + 1] + (dz / d) * r;
        }
      }
    }
    const b = TERRAIN_BOUNDS;
    nx = clamp(nx, b[0] + 10, b[2] - 10);
    nz = clamp(nz, b[1] + 10, b[3] - 10);
    this.vel.x = (nx - this.pos.x) / Math.max(dt, 1e-6);
    this.vel.z = (nz - this.pos.z) / Math.max(dt, 1e-6);
    this.pos.x = nx;
    this.pos.z = nz;

    // Vertical: step up onto stairs/deck, fall off edges.
    const g = this.ground(nx, nz);
    this.groundY = g;
    this.onPier = this.onPierAt(nx, nz);
    if (this.airborne) {
      this.vy -= G * dt;
      this.feetY += this.vy * dt;
      const water = this.waterY;
      if (this.feetY <= g) {
        this.feetY = g;
        this.airborne = false;
        this.vy = 0;
      } else if (this.feetY < water - 0.9 && water - g > 1.4) {
        // Jumped into deep water: surface onto the board.
        this.airborne = false;
        this.vy = 0;
        this.pos.y = water;
        this.setMode('paddle', 1.1);
        return;
      }
    } else if (g < this.feetY - 0.35) {
      this.airborne = true;
      this.vy = 0;
    } else {
      this.feetY = g > this.feetY ? damp(this.feetY, g, 22, dt) : damp(this.feetY, g, 16, dt);
    }
    this.pos.y = this.feetY;

    // Body heading follows the look direction while moving; turns in place past ~50°.
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    const dYaw = wrapAngle(this.yaw - this.heading);
    const rate = this.speed > 0.2 ? 7 : Math.abs(dYaw) > 0.85 ? 5 : 0;
    this.heading += dYaw * Math.min(1, rate * dt);

    // Gait: stride grows with speed; footprints on the exact landing frame.
    const stride = clamp(0.36 + 0.27 * this.speed, 0.3, 1.15);
    this.gait.update(dt, this.pos.x, this.pos.z, this.heading, this.vel.x, this.vel.z, stride, this.ground, wading ? 0.7 : 1);
    this.bobPhase = this.gait.phase;
    const st = this.ctx.services.state;
    for (let i = 0; i < 2; i++) {
      const f = this.gait.feet[i];
      if (!f.landed || this.onPier) continue;
      const dx = -Math.sin(f.yaw);
      const dz = -Math.cos(f.yaw);
      const fw = this.feetWet;
      st.splat(SPLAT_FOOTPRINT, f.pos.x, f.pos.z, 0.13, this.depth > 0.05 ? 0.6 : 1, dx, dz);
      if (fw > 0.05 && this.depth < 0.02) st.splat(SPLAT_WET, f.pos.x, f.pos.z, 0.12, fw * 0.6, dx, dz);
      if (this.depth > 0.05) st.splat(SPLAT_WAKE, f.pos.x, f.pos.z, 0.25, Math.min(1, this.depth), this.vel.x, this.vel.z);
    }
    this.feetWet = this.depth > 0.03 ? 1 : Math.max(0, this.feetWet - dt / 45);

    // Board: floats alongside once the water is deep enough.
    this.boardFloat = damp(this.boardFloat, this.depth > 0.3 ? 1 : 0, 2.5, dt);

    // Mode changes.
    if (this.mode === 'walk' && this.depth > 0.14) this.setMode('wade');
    else if (this.mode === 'wade') {
      if (this.depth < 0.07) this.setMode('walk');
      else if (this.depth > 1.05 || (this.depth > 0.62 && (it.action || (it.fwd > 0.3 && this.movingSeaward())))) {
        this.pos.y = this.waterY;
        this.setMode('paddle');
      }
    }
  }

  private movingSeaward() {
    // Seaward = down the depth gradient; with the layout that is -X.
    return this.vel.x < -0.2;
  }

  // ── Paddle / catch ───────────────────────────────────────────────────────────────────

  private updateProne(dt: number, it: Intent) {
    const catching = this.mode === 'catch';
    // Look: free head within limits around the board heading.
    this.yaw -= it.lookX;
    this.pitch = clamp(this.pitch - it.lookY, -1.05, 0.85);
    let rel = wrapAngle(this.yaw - this.heading);
    rel = clamp(rel, -2.1, 2.1);
    this.yaw = this.heading + rel;

    const paddling = it.fwd > 0.2;
    // A/D turn the board (sculling); paddling also steers toward the view.
    const turnRate = 1.15 - 0.35 * Math.min(1, this.speed / 2);
    let turn = -it.side * turnRate;
    if (paddling && Math.abs(rel) < 1.6) turn += clamp(rel, -0.8, 0.8) * 0.9;
    if (catching) turn *= 0.35;
    this.heading += turn * dt;
    this.yaw += turn * dt;

    // Strokes: cadence up when sprinting; arms settle when idle.
    const cad = paddling ? (it.run || catching ? 1.4 : 0.98) : 0;
    this.strokeRate = damp(this.strokeRate, cad, 4, dt);
    this.paddleW = damp(this.paddleW, paddling ? 1 : 0, paddling ? 5 : 2.2, dt);
    if (this.strokeRate > 0.02 || this.paddleW > 0.02) this.stroke = (this.stroke + Math.max(this.strokeRate, 0.35 * this.paddleW) * dt) % 1;

    const s = this.sampleWater();
    this.depth = s.depth;
    this.whitewater = damp(this.whitewater, s.breaking, 6, dt);
    const pushT = it.actionHeld && !catching ? 1 : this.whitewater > 0.55 ? 1 : 0;
    this.push = damp(this.push, pushT, pushT > this.push ? 7 : 3, dt);

    const hx = -Math.sin(this.heading);
    const hz = -Math.cos(this.heading);
    // Relative to the water: along-board drag is low, lateral drag high (rails and fins).
    const rvx = this.vel.x - s.vx;
    const rvz = this.vel.z - s.vz;
    const along = rvx * hx + rvz * hz;
    const lat = -rvx * hz + rvz * hx;
    const aDrag = (0.42 + 0.3 * Math.abs(along)) * along * (1 - 0.6 * this.push);
    const lDrag = 3.2 * lat;
    let ax = -aDrag * hx + lDrag * hz;
    let az = -aDrag * hz - lDrag * hx;
    // Stroke thrust peaks mid-pull on each arm.
    const pull = strokePull(this.stroke) + strokePull((this.stroke + 0.5) % 1);
    const thrust = this.tune.paddleThrust * pull * this.paddleW * (1 - 0.8 * this.push) * (it.run || catching ? 1.25 : 1);
    ax += hx * thrust;
    az += hz * thrust;
    // Gravity along the face: what lets a paddling board get picked up by a wave.
    const slopeK = catching ? 0.95 : 0.55;
    ax += -G * s.nx * slopeK;
    az += -G * s.nz * slopeK;

    // Catch: position + paddle timing, with a generous assist once the wave has you.
    const w = this.waveAt();
    const c = Math.min(6, Math.sqrt(G * Math.max(0.8, s.depth)) * 0.9);
    const dirDot = hx * w.dirX + hz * w.dirZ;
    const vAlongWave = this.vel.x * w.dirX + this.vel.z * w.dirZ;
    const onFace = w.stage > 0 && w.faceHeight > 0.5 && w.crestDistance > -w.faceHeight * 3.5 && w.crestDistance < 0.6;
    if (this.logModes && Math.floor(this.t * 2) !== Math.floor((this.t - dt) * 2))
      console.warn(`[player] prone t=${this.t.toFixed(1)} stage=${w.stage.toFixed(2)} crest=${w.crestDistance.toFixed(1)} face=${w.faceHeight.toFixed(2)} vW=${vAlongWave.toFixed(2)} c=${c.toFixed(2)} dot=${dirDot.toFixed(2)} pad=${paddling} lab=${this.lab.on}`);
    if (!catching) {
      if (onFace && dirDot > 0.55 && ((paddling && vAlongWave > 0.28 * c) || vAlongWave > 0.6 * c)) this.setMode('catch');
    } else {
      const assist = this.tune.catchAssist * (onFace ? 1 : 0.2) * Math.max(0, dirDot);
      const deficit = Math.max(0, c - vAlongWave);
      ax += w.dirX * deficit * assist;
      az += w.dirZ * deficit * assist;
      this.catchProgress = clamp(this.catchProgress + (vAlongWave / c - 0.55) * dt * 2.2, 0, 1);
      if (it.action && this.catchProgress > 0.25) {
        this.setMode('popup');
      } else if (!onFace && this.modeTime > 0.6) {
        this.setMode('paddle', 0.6);
      }
    }

    this.vel.x += ax * dt;
    this.vel.z += az * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.collideBoard();
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // Board attitude: float on the smoothed surface, heave on a spring, nose up with thrust.
    this.boardN.x = damp(this.boardN.x, s.nx, 5, dt);
    this.boardN.y = damp(this.boardN.y, s.ny, 5, dt);
    this.boardN.z = damp(this.boardN.z, s.nz, 5, dt);
    this.boardN.normalize();
    this.pos.y = this.waterY;
    const strokeRoll = Math.sin(this.stroke * TAU) * 0.035 * this.paddleW;
    this.boardRoll = damp(this.boardRoll, strokeRoll - turn * 0.06, 6, dt);
    const surge = clamp(along * 0.012, -0.03, 0.05);
    this.boardPitch = damp(this.boardPitch, surge + this.push * 0.05 - (catching ? 0.08 * this.catchProgress : 0), 4, dt);

    // Wake from the board and the hands.
    const st = this.ctx.services.state;
    if (this.speed > 0.3) st.splat(SPLAT_WAKE, this.pos.x - hx * 0.9, this.pos.z - hz * 0.9, 0.35, Math.min(1, this.speed / 3), this.vel.x, this.vel.z);

    // Back to standing in the shallows.
    if (!catching && s.depth < 0.55 && this.modeTime > 0.8) {
      this.feetY = this.ctx.services.terrain.height(this.pos.x, this.pos.z);
      this.setMode('wade', 0.9);
    }
  }

  private collideBoard() {
    const pl = this.ctx.services.pier.pilings;
    const r = this.ctx.services.pier.pilingRadius + 0.45;
    for (let i = 0; i < pl.length; i += 2) {
      const dx = this.pos.x - pl[i];
      const dz = this.pos.z - pl[i + 1];
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        this.pos.x = pl[i] + (dx / d) * r;
        this.pos.z = pl[i + 1] + (dz / d) * r;
        const vn = (this.vel.x * dx + this.vel.z * dz) / d;
        if (vn < 0) {
          this.vel.x -= (vn * dx) / d;
          this.vel.z -= (vn * dz) / d;
        }
      }
    }
  }

  // ── Pop-up and the ride hand-off ─────────────────────────────────────────────────────

  static readonly POPUP_S = 0.55;

  private updatePopup(dt: number, it: Intent) {
    this.yaw -= it.lookX;
    this.pitch = clamp(this.pitch - it.lookY, -1.2, 0.9);
    this.glide(dt, 0.25);
    if (this.modeTime >= PlayerCore.POPUP_S) this.setMode('ride');
  }

  /** Planing glide used by the pop-up and the fallback ride: slope gravity, low drag. */
  private glide(dt: number, dragK: number) {
    const s = this.sampleWater();
    this.depth = s.depth;
    const hx = -Math.sin(this.heading);
    const hz = -Math.cos(this.heading);
    const rvx = this.vel.x - s.vx;
    const rvz = this.vel.z - s.vz;
    const along = rvx * hx + rvz * hz;
    const lat = -rvx * hz + rvz * hx;
    const aDrag = dragK * along * (1 + 0.1 * Math.abs(along));
    const lDrag = 4 * lat;
    this.vel.x += (-aDrag * hx + lDrag * hz - G * s.nx) * dt;
    this.vel.z += (-aDrag * hz - lDrag * hx - G * s.nz) * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.collideBoard();
    this.pos.y = this.waterY;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.boardN.x = damp(this.boardN.x, s.nx, 7, dt);
    this.boardN.y = damp(this.boardN.y, s.ny, 7, dt);
    this.boardN.z = damp(this.boardN.z, s.nz, 7, dt);
    this.boardN.normalize();
    return s;
  }

  private updateRide(dt: number, it: Intent) {
    if (this.driver) {
      // The view stays the player's (mouse); the driver shapes the camera through rig.cam.
      this.yaw -= it.lookX;
      this.pitch = clamp(this.pitch - it.lookY, -1.0, 1.0);
      const next = this.driver.update(this.ctx, this.ctx.services.player as never, dt);
      if (next !== 'ride' && !(next === 'wipeout' && this.driver.handlesWipeout && this.mode === 'wipeout')) this.setMode(next);
      return;
    }
    // Fallback until the surf system registers: trim straight, steer with A/D and the view.
    this.yaw -= it.lookX;
    this.pitch = clamp(this.pitch - it.lookY, -1.3, 1.0);
    const rel = wrapAngle(this.yaw - this.heading);
    this.heading += (clamp(rel, -0.6, 0.6) * 0.8 - it.side * 1.2) * dt;
    this.glide(dt, 0.18);
    this.boardRoll = damp(this.boardRoll, it.side * 0.25, 4, dt);
    this.boardPitch = damp(this.boardPitch, 0, 4, dt);
    if (this.speed < 1.0 && this.modeTime > 1.2) this.setMode('paddle', 1.0);
    else if (this.depth < 0.45) this.setMode('wade', 1.0);
  }

  private updateWipeout(dt: number, it: Intent) {
    if (this.driver?.handlesWipeout) {
      const next = this.driver.update(this.ctx, this.ctx.services.player as never, dt);
      if (next !== 'wipeout') this.setMode(next);
      return;
    }
    this.yaw -= it.lookX * 0.4;
    this.pitch = clamp(this.pitch - it.lookY * 0.4, -1.0, 0.8);
    const s = this.glide(dt, 1.6);
    void s;
    if (this.modeTime > 1.7) this.setMode('paddle', 1.2);
  }
}

/** Pull strength of one arm over its stroke cycle (0 outside the underwater pull). */
export function strokePull(ph: number) {
  if (ph < 0.08 || ph > 0.5) return 0;
  const x = (ph - 0.08) / 0.42;
  return Math.sin(Math.PI * x) * (0.8 + 0.4 * x);
}
