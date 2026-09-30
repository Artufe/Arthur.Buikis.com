// Wipeouts: a short, violent tumble that stays above the surface, then an eased hand-back to
// paddling (the player blends from this pose to prone). The body is thrown and dragged along by
// the whitewater; the camera rolls and pitches with it (much gentler under reduced motion) while
// spray and foam boil round the lens; the board flies free, then the leash brings it back under
// the rider's chest for the hand-off.
//
// Allocation-free once optimised, like the ride: plain number fields, inline quaternion maths,
// dt in a field.

import type { GLContext, OceanSample, PlayerMode } from '../core/contracts';
import type { PlayerRig } from '../player/api';

const G = 9.81;
/** Tumble length (s); the leash starts reeling the board in at LEASH. */
export const TUMBLE_S = 1.75;
const LEASH = 0.85;

export const WIPE_CAUGHT = 1;
export const WIPE_FALLS = 2;
export const WIPE_RAIL = 3;
export const WIPE_PILING = 4;
export const WIPE_LANDING = 5;

// Numeric fields start at -0, not 0: -0 isn't a Smi, so V8 gives each field a double
// representation from the start. A field that sat at Smi 0 until its first fractional value (the
// first air, the first landing) changed the object's map then and deoptimised the ride.
export class Wipeout {
  t = -0;
  reason = 0;
  /** This frame's step (s), set by the caller before update(). */
  dt = -0;
  /** Rider (head) position and velocity. */
  rpx = -0;
  rpy = -0;
  rpz = -0;
  rvx = -0;
  rvy = -0;
  rvz = -0;
  /** Board position, velocity, orientation (quaternion) and spin (rad/s about board axes). */
  private bpx = -0;
  private bpy = -0;
  private bpz = -0;
  private bvx = -0;
  private bvy = -0;
  private bvz = -0;
  private qx = -0;
  private qy = -0;
  private qz = -0;
  private qw = 1;
  private sx = -0;
  private sy = -0;
  private sz = -0;
  /** Heading the rider ends up paddling (layout yaw). */
  yaw = -0;
  /** 0..1 how much the camera is in heavy spray (read by the effects). */
  whiteout = -0;
  /** The eye this frame (the tumbling head). */
  eyeX = -0;
  eyeY = -0;
  eyeZ = -0;
  private readonly s: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 5 };
  private seed = 0;

  start(ctx: GLContext, rig: PlayerRig, reason: number, eyeX: number, eyeY: number, eyeZ: number) {
    this.t = 0;
    this.reason = reason;
    this.seed = (this.seed + 1) % 7;
    this.rpx = eyeX;
    this.rpy = eyeY;
    this.rpz = eyeZ;
    this.eyeX = eyeX;
    this.eyeY = eyeY;
    this.eyeZ = eyeZ;
    const v = rig.velocity;
    // Thrown forward and down with the lip (over the falls: up and over first).
    this.rvx = v.x * 0.55;
    this.rvy = reason === WIPE_FALLS ? 2.2 : 0.4;
    this.rvz = v.z * 0.55;
    const b = rig.boardPosition;
    this.bpx = b.x;
    this.bpy = b.y;
    this.bpz = b.z;
    this.bvx = v.x * 0.8;
    this.bvy = 1.2 + (reason === WIPE_FALLS ? 1.5 : 0);
    this.bvz = v.z * 0.8;
    const q = rig.boardQuat;
    this.qx = q.x;
    this.qy = q.y;
    this.qz = q.z;
    this.qw = q.w;
    const k = this.seed / 7;
    this.sx = 5 + 4 * k;
    this.sy = 2.5 - 3 * k;
    this.sz = 7 - 5 * k;
    this.yaw = rig.yaw;
    this.whiteout = 1;
    rig.cam.shake(0.45);
    rig.cam.impulse(v.x * 0.15, -1.5, v.z * 0.15);
    void ctx;
  }

  update(ctx: GLContext, rig: PlayerRig): PlayerMode {
    const dt = this.dt;
    this.t += dt;
    const t = this.t;
    const o = ctx.services.ocean;
    const reduced = ctx.reducedMotion;
    // ── The rider: thrown, then dragged along the surface by the whitewater, head up ──
    const s = o.sample(this.rpx, this.rpz, this.s);
    const floatY = s.height + 0.3;
    this.rvy -= G * dt;
    this.rpx += this.rvx * dt;
    this.rpy += this.rvy * dt;
    this.rpz += this.rvz * dt;
    if (this.rpy < floatY) {
      this.rpy = floatY + (this.rpy - floatY) * Math.exp(-14 * dt);
      if (this.rvy < 0) this.rvy *= 0.2;
      // Carried by the bore, slowing as it lets go.
      const k = Math.min(1, dt * 2.6);
      this.rvx += (s.vx * 0.85 - this.rvx) * k;
      this.rvz += (s.vz * 0.85 - this.rvz) * k;
    }
    // Tumble: the head is thrown round a small circle while it rolls; it settles as it surfaces.
    const env = Math.min(1, t / 0.12) * (1 - Math.min(1, Math.max(0, (t - 0.9) / 0.65)));
    const amp = (reduced ? 0.3 : 1) * env;
    const ph = t * 8.5 + this.seed;
    this.eyeX = this.rpx + Math.sin(ph) * 0.22 * amp;
    this.eyeY = this.rpy + (0.08 + Math.cos(ph * 1.3) * 0.12) * amp;
    this.eyeZ = this.rpz + Math.cos(ph * 0.8) * 0.22 * amp;
    const cam = rig.cam;
    const roll = (Math.sin(t * 6.2 + this.seed) * 1.1 + Math.sin(t * 13.1) * 0.25) * amp;
    cam.roll = roll;
    cam.pitchOffset = (-0.35 + Math.sin(t * 5.1 + 1 + this.seed) * 0.45) * amp;
    cam.fovKick = 0;
    const wt = t < 1.0 ? 1 : 0;
    this.whiteout = wt + (this.whiteout - wt) * Math.exp(-3 * dt);

    // ── The board: flies, skips, then the leash reels it in under the chest ──
    const sb = o.sample(this.bpx, this.bpz, this.s);
    const sbh = sb.height;
    this.bvy -= G * dt;
    this.bpx += this.bvx * dt;
    this.bpy += this.bvy * dt;
    this.bpz += this.bvz * dt;
    if (this.bpy < sbh + 0.03) {
      // Carried up by the water, at most 8 m/s (a face jumping up under it mustn't pop it).
      this.bpy = Math.min(sbh + 0.03, this.bpy + 8 * dt);
      if (this.bvy < 0) this.bvy = -this.bvy * 0.25;
      const e = Math.exp(-2 * dt);
      this.bvx = sb.vx + (this.bvx - sb.vx) * e;
      this.bvz = sb.vz + (this.bvz - sb.vz) * e;
      const es = Math.exp(-3 * dt);
      this.sx *= es;
      this.sy *= es;
      this.sz *= es;
    }
    // Spin in the board's own frame: q ← q · (axis-angle of spin·dt).
    {
      const sl = Math.sqrt(this.sx * this.sx + this.sy * this.sy + this.sz * this.sz);
      if (sl > 1e-4) {
        const h = 0.5 * sl * dt;
        const k = Math.sin(h) / sl;
        const bx = this.sx * k;
        const by = this.sy * k;
        const bz = this.sz * k;
        const bw = Math.cos(h);
        const ax = this.qx;
        const ay = this.qy;
        const az = this.qz;
        const aw = this.qw;
        this.qx = ax * bw + aw * bx + ay * bz - az * by;
        this.qy = ay * bw + aw * by + az * bx - ax * bz;
        this.qz = az * bw + aw * bz + ax * by - ay * bx;
        this.qw = aw * bw - ax * bx - ay * by - az * bz;
      }
    }
    const tx = this.rpx - Math.sin(this.yaw) * 0.25;
    const tz = this.rpz - Math.cos(this.yaw) * 0.25;
    if (t > LEASH) {
      // Leash: pull toward the rider's chest (a spring that tightens), and settle flat, heading on.
      const k = Math.min(1, (t - LEASH) / (TUMBLE_S - LEASH));
      const e = k * k * (3 - 2 * k);
      const kp = Math.min(1, dt * (2 + 30 * e));
      this.bpx += (tx - this.bpx) * kp;
      this.bpy += (sbh - this.bpy) * kp;
      this.bpz += (tz - this.bpz) * kp;
      const ev = Math.exp(-4 * e * dt);
      this.bvx *= ev;
      this.bvy *= ev;
      this.bvz *= ev;
      const es = Math.exp(-6 * e * dt);
      this.sx *= es;
      this.sy *= es;
      this.sz *= es;
      // Flat on the water, nose along the heading: a rotation about +Y by yaw + π/2.
      const a = 0.5 * (this.yaw + Math.PI / 2);
      let gy = Math.sin(a);
      let gw = Math.cos(a);
      if (this.qy * gy + this.qw * gw < 0) {
        gy = -gy;
        gw = -gw;
      }
      const kq = Math.min(1, dt * (1.5 + 20 * e));
      let qx = this.qx * (1 - kq);
      let qy = this.qy + (gy - this.qy) * kq;
      let qz = this.qz * (1 - kq);
      let qw = this.qw + (gw - this.qw) * kq;
      const lq = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
      qx /= lq;
      qy /= lq;
      qz /= lq;
      qw /= lq;
      this.qx = qx;
      this.qy = qy;
      this.qz = qz;
      this.qw = qw;
    }
    rig.boardQuat.set(this.qx, this.qy, this.qz, this.qw);

    // ── The body in the tumble pose ──
    const st = rig.stance;
    st.tumble = Math.min(1, t / TUMBLE_S);
    st.eyeX = this.eyeX;
    st.eyeY = this.eyeY;
    st.eyeZ = this.eyeZ;
    // The body stays upright in the pose frame: the camera's roll is eased and lags this target, so a
    // body rolled with the target swung the tucked limbs into view (see poses.ts tumblePose).
    st.bodyX = 0;
    st.bodyY = 1;
    st.bodyZ = 0;

    if (t >= TUMBLE_S) {
      // Hand-off: the board lies under the chest, heading where the rider looks.
      cam.roll = 0;
      cam.pitchOffset = 0;
      rig.boardPosition.set(tx, sbh - 0.012, tz);
      rig.velocity.set(this.rvx, 0, this.rvz);
      rig.speed = Math.sqrt(this.rvx * this.rvx + this.rvz * this.rvz);
      this.whiteout = 0;
      return 'paddle';
    }
    rig.boardPosition.set(this.bpx, this.bpy, this.bpz);
    rig.velocity.set(this.rvx, this.rvy, this.rvz);
    rig.speed = Math.sqrt(this.rvx * this.rvx + this.rvz * this.rvz);
    return 'wipeout';
  }
}
