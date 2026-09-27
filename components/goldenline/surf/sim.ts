// Board physics on the moving water surface (CPU, zero allocation per step).
//
// The board is a point on the ridable surface (`ocean.sample()`: the breaker's face, tube floor or
// trough, never the lip overhead) with a full 3-D velocity. Each substep:
//
//   1. re-sample the surface under the board: height, normal, water velocity, whitewater
//   2. contact: the surface translates with the wave (U, from the breaker's crest speed), so the
//      board keeps the surface's normal velocity U·n. Relative motion into the surface is removed
//      without loss in the wave's frame (a frictionless constraint conserves energy there), so a
//      face rising under a slow board shoves it forward and up: that is how a wave picks a board up
//      and carries it. Moving off the surface faster than it follows (a convex crest, the lip)
//      makes the board airborne until it lands again.
//   3. tangential forces: gravity along the surface, planing drag against the water, the fins'
//      and rail's lateral grip (with a skid limit), the rider's pump and stall, and in whitewater
//      the drag of aerated water moving with the bore
//   4. integrate
//
// Allocation-free in optimised code: the state is plain number fields (three's Vector3 fields are
// tagged in this app, so every changing store into one boxes a new HeapNumber), the step count
// and length are fields, not arguments, and the only external call per substep is
// ocean.sample() (its two coordinates are boxed at that call: the API takes doubles).

import type { OceanSample, OceanService } from '../core/contracts';

const G = 9.81;

export interface SimTune {
  /** Linear planing drag (1/s) and quadratic (1/m), against the water. */
  drag1: number;
  drag2: number;
  /** Fin/rail lateral grip: rate (1/s) at rest, plus per m/s of speed. */
  grip0: number;
  gripV: number;
  /** Lateral acceleration the fins hold before the tail breaks loose (m/s²). */
  latMax: number;
  /** Pump thrust (m/s²) at full effort on a steep face; stall drag (1/s). */
  pump: number;
  stall: number;
  /** Extra drag (1/s) in fully aerated whitewater. */
  soup: number;
  /** Relative speed off the surface (m/s) needed to leave it (airs off the lip). */
  sepV: number;
}

// Numeric fields start at -0, not 0: -0 isn't a Smi, so V8 gives each field a double
// representation from the start. A field that sat at Smi 0 until its first fractional value (the
// first air, the first landing) changed the object's map then and deoptimised the ride.
export class BoardSim {
  /** Board reference point (bottom centre at mid-length) on the surface, world. */
  px = -0;
  py = -0;
  pz = -0;
  /** Ground-frame velocity (m/s). */
  vx = -0;
  vy = -0;
  vz = -0;
  /** Heading (layout convention: forward = (−sin yaw, 0, −cos yaw)) and yaw rate (rad/s, + = left). */
  yaw = -0;
  omega = -0;
  /** Surface translation velocity (horizontal, m/s): the wave's crest speed along its direction. */
  Ux = -0;
  Uz = -0;
  /** Rider controls for this step: pump 0..1, stall 0..1. */
  pump = -0;
  stall = -0;
  /** Extra thrust along the board this step (m/s²): the pocket's power, set by the ride. */
  drive = -0;
  /** 0..1 how much of the surface here is a breaker's face (its water travels with it). */
  onBreaker = -0;
  airborne = false;
  airTime = -0;
  /** Outputs of the last step: surface normal, board forward and right on it. */
  nx = -0;
  ny = 1;
  nz = -0;
  fx = 1;
  fy = -0;
  fz = -0;
  rx = -0;
  ry = -0;
  rz = 1;
  /** Speed through the water along the board, lateral slip (m/s), lateral accel (m/s², + = right). */
  speedWater = -0;
  slip = -0;
  aLat = -0;
  /** How far past the fins' limit the lateral demand is (m/s², 0 = holding). */
  skid = -0;
  /** Largest normal speed lost to a landing this frame (m/s, ≥ 0). */
  landing = -0;
  /** Whitewater coverage and water depth at the board, the surface height, the water's velocity. */
  breaking = -0;
  depth = 5;
  surfaceY = -0;
  wx = -0;
  wz = -0;
  /** The frame's length (s), set by the caller before run(). */
  dt = -0;
  private h = -0;
  readonly s: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 5 };

  constructor(private readonly tune: SimTune) {}

  reset(x: number, y: number, z: number, vx: number, vy: number, vz: number, yaw: number) {
    this.px = x;
    this.py = y;
    this.pz = z;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.yaw = yaw;
    this.omega = 0;
    this.airborne = false;
    this.airTime = 0;
    this.landing = 0;
    this.skid = 0;
  }

  /** One frame (this.dt) in substeps of ≤ 1/180 s (at least two) on `ocean` (fresh from ctx). */
  run(ocean: OceanService) {
    const n = Math.max(2, Math.ceil(this.dt * 180));
    this.h = this.dt / n;
    this.landing = 0;
    for (let i = 0; i < n; i++) this.step(ocean);
    // Keep the numbers sane whatever the surface does.
    const vl = Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz);
    if (!(vl < 26)) {
      const k = vl > 0 ? 26 / vl : 0;
      this.vx *= k;
      this.vy *= k;
      this.vz *= k;
    }
  }

  private step(ocean: OceanService) {
    const T = this.tune;
    const h = this.h;
    const s = ocean.sample(this.px, this.pz, this.s);
    let nx = s.nx;
    let ny = s.ny;
    let nz = s.nz;
    // A near-vertical wall is still a wall: keep the normal from tipping past ~80° so the contact
    // stays well-conditioned at the top of a pitching face.
    if (ny < 0.17) {
      ny = 0.17;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= l;
      ny /= l;
      nz /= l;
    }
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.breaking = s.breaking;
    this.depth = s.depth;
    this.surfaceY = s.height;
    const wx = s.vx;
    const wz = s.vz;
    this.wx = wx;
    this.wz = wz;
    const Ux = this.Ux;
    const Uz = this.Uz;
    const Vn = Ux * nx + Uz * nz;
    let vx = this.vx;
    let vy = this.vy;
    let vz = this.vz;
    this.yaw += this.omega * h;

    if (this.airborne) {
      this.airTime += h;
      if (this.py <= s.height && this.airTime > 0.04) {
        this.py = s.height;
        const vn = vx * nx + vy * ny + vz * nz - Vn;
        if (vn < 0) {
          if (-vn > this.landing) this.landing = -vn;
          vx -= nx * vn;
          vy -= ny * vn;
          vz -= nz * vn;
        }
        this.airborne = false;
        this.airTime = 0;
      } else {
        this.fly();
        return;
      }
    }

    // Contact with the moving surface (U is horizontal).
    this.py = s.height;
    let ex = vx - Ux;
    let ey = vy;
    let ez = vz - Uz;
    const vn = ex * nx + ey * ny + ez * nz;
    if (vn > T.sepV) {
      // Faster off the surface than it follows: fly (off the lip, over a crest).
      this.airborne = true;
      this.airTime = 0;
      this.fly();
      return;
    }
    // Into the surface: remove the normal part. While following a curved surface (a small normal
    // part each substep) keep the magnitude, since a frictionless curve does no work; an impact
    // (the face slamming into a slow board, a landing) is inelastic.
    const m0 = Math.sqrt(ex * ex + ey * ey + ez * ez);
    ex -= nx * vn;
    ey -= ny * vn;
    ez -= nz * vn;
    if (vn < 0 && -vn < 0.25 * m0) {
      const m1 = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (m1 > 1e-6) {
        const k = m0 / m1;
        ex *= k;
        ey *= k;
        ez *= k;
      }
    }
    vx = ex + Ux;
    vy = ey;
    vz = ez + Uz;

    // Board axes on the surface.
    this.axes();
    const fx = this.fx;
    const fy = this.fy;
    const fz = this.fz;
    const rx = this.rx;
    const ry = this.ry;
    const rz = this.rz;

    // Gravity along the surface: (0, −G, 0) + n·(G n.y).
    const gn = G * ny;
    let ax = nx * gn;
    let ay = -G + ny * gn;
    let az = nz * gn;

    // Hydrodynamics against the water (its horizontal velocity; the orbital lift up the face is
    // the surface's own motion, handled by the contact above).
    const rf = (vx - wx) * fx + vy * fy + (vz - wz) * fz;
    // The fins hold the line across the face in the wave's own frame: the water on a breaking face
    // travels with it (and rushes up it), so a board crossing the face at the wave's speed isn't
    // slipping sideways through anything. Measured against the still water instead, the fins
    // would haul every trimming board up into the lip.
    // On the flat ahead of the face the water is (nearly) still, so the frame blends with the slope.
    const kf = Math.min(1, Math.max(0, (0.985 - ny) / 0.12)) * this.onBreaker;
    const qx = wx + (Ux - wx) * kf;
    const qz = wz + (Uz - wz) * kf;
    const rr = (vx - qx) * rx + vy * ry + (vz - qz) * rz;
    const soup = s.breaking * T.soup;
    const arf = rf < 0 ? -rf : rf;
    let along = -(T.drag1 + soup + this.stall * T.stall + T.drag2 * arf) * rf;
    // Pumping: thrust along the board, worth more on a steep face (unweight / weight the rail).
    const steep = Math.min(1, Math.sqrt(Math.max(0, 1 - ny * ny)) * 2.2);
    along += this.pump * T.pump * (0.35 + 0.65 * steep) * (rf > -0.5 ? 1 : 0) + this.drive;
    // Fins and rail: lateral grip up to a limit; beyond it the tail breaks loose (skid).
    // A face steeper than ~60° can't be held on a rail: the fins let go and the board slides down
    // it (without this, on a vertical barrel wall the lateral axis is vertical and the fins would
    // pin the board to the wall).
    const hold = Math.min(1, Math.max(0, (ny - 0.42) / 0.26));
    const grip = (T.grip0 + T.gripV * Math.min(9, arf)) * (0.15 + 0.85 * hold);
    let al = -grip * rr;
    const lim = T.latMax * (1 - 0.6 * s.breaking) * (0.25 + 0.75 * hold);
    let skid = 0;
    if (al > lim) {
      skid = al - lim;
      al = lim;
    } else if (al < -lim) {
      skid = -al - lim;
      al = -lim;
    }
    // Turning the fins costs speed (induced drag).
    along -= 0.045 * (al < 0 ? -al : al) * (rf > 0 ? 1 : -1);
    ax += fx * along + rx * al;
    ay += fy * along + ry * al;
    az += fz * along + rz * al;

    vx += ax * h;
    vy += ay * h;
    vz += az * h;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.px += vx * h;
    this.py += vy * h;
    this.pz += vz * h;
    this.skid = skid;
    this.speedWater = rf;
    this.slip = rr;
    this.aLat = al;
  }

  /** Ballistic substep (the velocity fields are this step's). */
  private fly() {
    const h = this.h;
    this.vy -= G * h;
    this.px += this.vx * h;
    this.py += this.vy * h;
    this.pz += this.vz * h;
    this.axes();
  }

  /** Board forward/right on the surface (n) from the heading. */
  private axes() {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const hx = -Math.sin(this.yaw);
    const hz = -Math.cos(this.yaw);
    const d = hx * nx + hz * nz;
    let fx = hx - nx * d;
    let fy = -ny * d;
    let fz = hz - nz * d;
    let l = fx * fx + fy * fy + fz * fz;
    if (l < 1e-8) {
      fx = hx;
      fy = 0;
      fz = hz;
      l = 1;
    }
    l = Math.sqrt(l);
    fx /= l;
    fy /= l;
    fz /= l;
    // right = forward × normal
    let rx = fy * nz - fz * ny;
    let ry = fz * nx - fx * nz;
    let rz = fx * ny - fy * nx;
    const lr = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    rx /= lr;
    ry /= lr;
    rz /= lr;
    this.fx = fx;
    this.fy = fy;
    this.fz = fz;
    this.rx = rx;
    this.ry = ry;
    this.rz = rz;
  }
}
