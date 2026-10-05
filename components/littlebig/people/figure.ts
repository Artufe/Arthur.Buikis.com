// People (B2): the figures. One chunky toy person (every hair style, accessory and the skirt are in
// it; the shader hides what a person doesn't wear) in three LODs, and one small dog, all built from
// a handful of low-poly primitives, origin at the feet, facing +z with their left on +x. Every
// vertex carries aPart (people/shader.ts poses and colours by part); fixed colours (eyes, shoes,
// blush, the umbrella pole, the phone) are vertex colours, everything else is white and tinted per
// person. Toy proportions: the head is a quarter of the height, legs short, limbs thick.

import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, Euler, Matrix4, OctahedronGeometry, Quaternion, SphereGeometry, TorusGeometry, Vector3 } from 'three';

/** Joint pivots (m, figure space) shared with the shader and the sim. */
export const J = {
  hipY: 0.68,
  kneeY: 0.36,
  legX: 0.1,
  shoulderY: 1.17,
  elbowY: 0.955,
  armX: 0.27,
  neckY: 1.25,
  waistY: 0.74,
  /** Hand centre below the elbow. */
  hand: 0.2,
  /** A sitter's hip pivot is this far above the seat. */
  thighR: 0.1,
  headY: 1.47,
};

/** Fixed arm poses (shoulder, elbow forward swing, rad), shared with the shader. */
export const POSE_UMBRELLA = [0.4, 1.35] as const;
export const POSE_PHONE = [0.3, 1.3] as const;
export const POSE_LEASH = [0.55, 0.35] as const;

export const P = {
  TORSO: 0, HIPS: 1, THIGH: 2, SHIN: 3, SHOE: 4, UPPER: 5, FORE: 6, HAND: 7,
  HEAD: 8, EYE: 9, BROW: 10, BLUSH: 11, CAP: 12, FRINGE: 13, BUN: 14, LONG: 15, HAT: 16, AFRO: 17, HAIRF: 18,
  SKIRT: 19, BAG: 20, BACKPACK: 21, UMB: 22, POLE: 23, PHONE: 24,
  DOG_BODY: 30, DOG_HEAD: 31, DOG_LEG: 32, DOG_TAIL: 33, DOG_EAR: 34, DOG_DARK: 35, DOG_COLLAR: 36, DOG_SNOUT: 37,
} as const;

/** Hand centre of an arm (side +1 left / −1 right) posed by forward swings at shoulder and elbow. */
export function posedHand(side: number, shoulder: number, elbow: number, out: Vector3 = new Vector3()): Vector3 {
  const ey = J.elbowY - J.shoulderY;
  const a2 = shoulder + elbow;
  return out.set(side * J.armX, J.shoulderY + ey * Math.cos(shoulder) - J.hand * Math.cos(a2), -ey * Math.sin(shoulder) + J.hand * Math.sin(a2));
}

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
const WHITE = new Color(1, 1, 1);
const INK = new Color(0x1b1530);

/** Segment scale of the build in progress (1 near, ~0.55 mid). */
let K = 1;
const sg = (n: number, min: number) => Math.max(min, Math.round(n * K));
const sph = (r: number, w: number, h: number) => new SphereGeometry(r, sg(w, 5), sg(h, 3));
const cyl = (r0: number, r1: number, hh: number, n: number, open: boolean) => new CylinderGeometry(r0, r1, hh, sg(n, 5), 1, open);

/**
 * A hair shell: a sphere cap of radius r whose hairline polar angle follows the azimuth (F at the
 * front, S at the sides, Bk at the back), so one clean shell gives a fringe-line in front, cover over
 * the ears and a nape behind. `drop` stretches the lower back down (long hair) and keeps it off the
 * shoulders.
 */
function shell(r: number, F: number, S: number, Bk: number, drop = 0, w = 16, h = 9): BufferGeometry {
  const g = new SphereGeometry(1, sg(w, 7), sg(h, 3), 0, Math.PI * 2, 0, 1);
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const m = (F + Bk) / 2;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const ph = Math.atan2(x, z);
    const t = Math.acos(Math.min(1, p.getY(i))) * ((m + S) / 2 + ((F - Bk) / 2) * Math.cos(ph) + ((m - S) / 2) * Math.cos(2 * ph));
    const l = Math.hypot(x, z) || 1;
    const s = Math.sin(t);
    const ny = Math.cos(t);
    n.setXYZ(i, (x / l) * s, ny, (z / l) * s);
    const back = Math.max(0, -Math.cos(ph)) * Math.max(0, -ny) * drop;
    p.setXYZ(i, (x / l) * s * r * (1 - back * 0.25), ny * r * (1 + back), (z / l) * s * r - back * 0.07);
  }
  return g;
}

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  part: number[] = [];
  idx: number[] = [];
  private readonly m = new Matrix4();
  private readonly nm = new Matrix4();
  private readonly v = new Vector3();

  add(g: BufferGeometry, part: number, m: Matrix4 = this.m.identity(), color: Color = WHITE, flip = false): void {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const base = this.pos.length / 3;
    this.nm.copy(m).invert().transpose();
    for (let i = 0; i < p.count; i++) {
      this.v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.v.fromBufferAttribute(n, i).transformDirection(this.nm);
      if (flip) this.v.negate();
      this.nor.push(this.v.x, this.v.y, this.v.z);
      this.col.push(color.r, color.g, color.b);
      this.part.push(part);
    }
    const ix = g.index;
    const cnt = ix ? ix.count : p.count;
    for (let i = 0; i < cnt; i += 3) {
      const a = ix ? ix.getX(i) : i;
      const b = ix ? ix.getX(i + 1) : i + 1;
      const c = ix ? ix.getX(i + 2) : i + 2;
      this.idx.push(base + a, base + (flip ? c : b), base + (flip ? b : c));
    }
    g.dispose();
  }

  /** Transform from position, euler rotation and scale. */
  xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): Matrix4 {
    return this.m.compose(V(x, y, z), new Quaternion().setFromEuler(new Euler(rx, ry, rz)), V(sx, sy, sz));
  }

  /** A cylinder from point a to point b (radius r0 at a, r1 at b). */
  rod(part: number, a: Vector3, b: Vector3, r0: number, r1: number, n: number, color?: Color, open = true): void {
    const d = b.clone().sub(a);
    const q = new Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize());
    this.add(cyl(r1, r0, d.length(), n, open), part, this.m.compose(a.clone().add(b).multiplyScalar(0.5), q, V(1, 1, 1)), color);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aPart', new BufferAttribute(new Float32Array(this.part), 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    K = 1;
    return g;
  }
}

/** The umbrella (pole + two-sided scalloped canopy) in the posed right hand. */
function umbrella(B: Builder): void {
  const hand = posedHand(-1, POSE_UMBRELLA[0], POSE_UMBRELLA[1]);
  const top = V(-0.06, 1.98, 0.06);
  B.rod(P.POLE, hand.clone().add(V(0, -0.08, 0)), top, 0.014, 0.014, 5, INK, false);
  const cm = new Matrix4().compose(top.clone().add(V(0, -0.1, 0)), new Quaternion().setFromUnitVectors(V(0, 1, 0), top.clone().sub(hand).normalize()), V(1, 1, 1));
  B.add(cyl(0, 0.64, 0.24, 11, true), P.UMB, cm);
  B.add(cyl(0, 0.64, 0.24, 11, true), P.UMB, cm, WHITE, true);
}

const HY = J.headY;

/**
 * The person. lod 0: full detail (near); 1: fewer segments, no ears or blush (mid); 2: a ~250-tri
 * stand-in of boxes and balls with the same parts and colours (far: legs, arms, torso, head, eyes,
 * hair, hat, skirt, umbrella).
 */
export function personGeometry(lod = 0): BufferGeometry {
  const B = new Builder();
  const shoe = new Color(0x3a3344);
  if (lod === 2) {
    K = 0.45;
    for (const s of [1, -1]) {
      B.add(new BoxGeometry(0.16, 0.1, 0.27), P.SHOE, B.xf(s * J.legX, 0.05, 0.05), shoe);
      B.add(new BoxGeometry(0.17, J.hipY - 0.05, 0.18), P.THIGH, B.xf(s * J.legX, (J.hipY + 0.13) / 2, 0));
      B.add(new BoxGeometry(0.15, J.shoulderY - 0.69, 0.15), P.UPPER, B.xf(s * J.armX, (J.shoulderY + 0.69) / 2 + 0.03, 0));
      B.add(new OctahedronGeometry(0.035), P.EYE, B.xf(s * 0.07, HY - 0.008, 0.18), INK);
    }
    B.add(cyl(0.21, 0.19, 0.56, 15, false), P.TORSO, B.xf(0, J.hipY + 0.27, 0, 0, 0, 0, 1, 1, 0.72));
    B.add(cyl(0.19, 0.31, 0.38, 15, true), P.SKIRT, B.xf(0, 0.6, 0, 0, 0, 0, 1, 1, 0.8));
    B.add(sph(0.2, 15, 11), P.HEAD, B.xf(0, HY, 0));
    B.add(shell(0.215, 1.35, 1.55, 2.2), P.HAIRF, B.xf(0, HY, 0));
    B.add(cyl(0.27, 0.27, 0.03, 15, false), P.HAT, B.xf(0, HY + 0.11, -0.01, -0.12));
    B.add(cyl(0.16, 0.17, 0.16, 15, false), P.HAT, B.xf(0, HY + 0.19, -0.02, -0.12));
    umbrella(B);
    return B.build();
  }
  K = lod ? 0.55 : 1;
  for (const s of [1, -1]) {
    const lx = s * J.legX;
    // chunky shoe: a squashed ball, toe forward
    B.add(sph(0.1, 10, 7), P.SHOE, B.xf(lx, 0.052, 0.045, 0, 0, 0, 0.86, 0.56, 1.36), shoe);
    // shin (its top tucked into the knee ball, so a bent knee never shows a gap), knee, thigh
    B.rod(P.SHIN, V(lx, 0.07, 0), V(lx, J.kneeY + 0.03, 0), 0.082, 0.087, 9);
    B.add(sph(0.095, 9, 7), P.THIGH, B.xf(lx, J.kneeY, 0));
    B.rod(P.THIGH, V(lx, J.kneeY, 0), V(lx, J.hipY + 0.04, 0), 0.093, 0.1, 9);
    // arm: shoulder ball, upper arm, elbow, forearm, mitten hand
    const ax = s * J.armX;
    B.add(sph(0.088, 9, 7), P.UPPER, B.xf(ax, J.shoulderY, 0));
    B.rod(P.UPPER, V(ax, J.shoulderY, 0), V(ax, J.elbowY, 0), 0.083, 0.078, 8);
    B.add(sph(0.078, 8, 6), P.FORE, B.xf(ax, J.elbowY, 0));
    B.rod(P.FORE, V(ax, J.elbowY, 0), V(ax, J.elbowY - J.hand + 0.05, 0), 0.075, 0.07, 8);
    B.add(sph(0.08, 9, 7), P.HAND, B.xf(ax - s * 0.006, J.elbowY - J.hand, 0.006, 0, 0, 0, 0.92, 1.12, 1.18));
    // face: eyes, brows (tilted per person in the shader), blush
    B.add(sph(0.032, 7, 5), P.EYE, B.xf(s * 0.072, HY - 0.008, 0.186, 0, 0, 0, 1, 1.35, 0.5), INK);
    B.add(new BoxGeometry(0.066, 0.016, 0.02), P.BROW, B.xf(s * 0.075, HY + 0.05, 0.188, -0.3, s * 0.35, 0));
    if (!lod) {
      B.add(sph(0.04, 7, 5), P.HEAD, B.xf(s * 0.196, HY - 0.01, -0.005, 0, 0, 0, 0.5, 1, 0.8)); // ears
      B.add(sph(0.034, 7, 4), P.BLUSH, B.xf(s * 0.118, HY - 0.058, 0.156, 0, s * 0.62, 0, 1, 0.6, 0.3), new Color(0xff8f8f));
    }
  }
  // pelvis and torso: an elliptical, slightly tapered barrel with rounded shoulders
  B.add(sph(1, 12, 7), P.HIPS, B.xf(0, J.hipY + 0.02, 0, 0, 0, 0, 0.2, 0.13, 0.148));
  B.add(cyl(0.212, 0.195, 0.38, 14, true), P.TORSO, B.xf(0, J.waistY + 0.18, 0, 0, 0, 0, 1, 1, 0.7));
  // phiStart π/2 puts the dome's vertex ring exactly on the cylinder's (no T-junction cracks to ink)
  const dome = new SphereGeometry(0.212, sg(14, 7), sg(5, 3), Math.PI / 2, Math.PI * 2, 0, Math.PI / 2);
  B.add(dome, P.TORSO, B.xf(0, J.waistY + 0.37, 0, 0, 0, 0, 1, 0.42, 0.7));
  // skirt (dresses): a closed cone, seam at the back
  B.add(cyl(0.2, 0.32, 0.4, 14, true), P.SKIRT, B.xf(0, 0.6, 0, 0, Math.PI, 0, 1, 1, 0.8));
  // neck, head, nose, smile
  B.rod(P.HEAD, V(0, J.neckY - 0.08, 0), V(0, HY - 0.12, 0), 0.07, 0.07, 8);
  B.add(sph(0.2, 18, 13), P.HEAD, B.xf(0, HY, 0, 0, 0, 0, 1, 1.04, 0.98));
  B.add(sph(0.034, 7, 5), P.HEAD, B.xf(0, HY - 0.05, 0.195, 0, 0, 0, 1, 0.9, 0.9));
  B.add(new TorusGeometry(0.046, 0.0105, 4, sg(10, 6), Math.PI), P.EYE, B.xf(0, HY - 0.086, 0.174, -0.5, 0, Math.PI), INK);
  // hair: short cap with a side-swept fringe, bun, long, hat over the cap, a big curly crown
  B.add(shell(0.216, 1.2, 1.45, 2.25), P.CAP, B.xf(0, HY, 0, 0, 0, 0, 1, 1.03, 1));
  B.add(sph(1, 10, 6), P.FRINGE, B.xf(0.05, HY + 0.12, 0.15, -0.8, 0.25, 0.32, 0.12, 0.05, 0.075));
  B.add(sph(0.095, 10, 7), P.BUN, B.xf(0, HY + 0.17, -0.12));
  B.add(shell(0.226, 1.18, 1.72, 2.62, 0.95), P.LONG, B.xf(0, HY, 0, 0, 0, 0, 1, 1.03, 1));
  B.add(cyl(0.27, 0.27, 0.025, 16, false), P.HAT, B.xf(0, HY + 0.11, -0.01, -0.12));
  B.add(cyl(0.16, 0.17, 0.16, 14, false), P.HAT, B.xf(0, HY + 0.19, -0.02, -0.12));
  B.add(shell(0.262, 1.22, 1.55, 2.0), P.AFRO, B.xf(0, HY + 0.03, -0.02, -0.1));
  // shoulder bag hanging low on the left hip, below and inside the swinging hand (the shader pushes
  // that arm out a little), strap across the chest to the right shoulder
  B.add(new BoxGeometry(0.075, 0.19, 0.23), P.BAG, B.xf(0.25, 0.63, -0.01));
  for (const z of [0.1, -0.12]) B.rod(P.BAG, V(0.25, 0.71, z), V(-0.15, J.shoulderY + 0.03, z * 0.9), 0.017, 0.017, 4);
  // backpack with two shoulder straps
  B.add(new BoxGeometry(0.3, 0.34, 0.17), P.BACKPACK, B.xf(0, 0.98, -0.22));
  B.add(new BoxGeometry(0.22, 0.14, 0.06), P.BACKPACK, B.xf(0, 0.9, -0.33)); // front pocket
  for (const s of [1, -1]) B.rod(P.BACKPACK, V(s * 0.115, 0.84, 0.14), V(s * 0.115, J.shoulderY + 0.04, 0.1), 0.019, 0.019, 4);
  umbrella(B);
  // phone in the right hand (posed), screen toward the face
  const ph = posedHand(-1, POSE_PHONE[0], POSE_PHONE[1]);
  B.add(new BoxGeometry(0.075, 0.012, 0.13), P.PHONE, B.xf(ph.x + 0.03, ph.y + 0.06, ph.z + 0.03, -0.7), INK);
  return B.build();
}

export function dogGeometry(): BufferGeometry {
  const B = new Builder();
  K = 0.75;
  B.add(sph(1, 12, 8), P.DOG_BODY, B.xf(0, 0.32, -0.02, 0, 0, 0, 0.15, 0.14, 0.29));
  B.add(sph(0.115, 10, 8), P.DOG_HEAD, B.xf(0, 0.47, 0.27));
  B.add(sph(0.068, 8, 6), P.DOG_SNOUT, B.xf(0, 0.44, 0.37, 0, 0, 0, 0.85, 0.75, 1.2));
  B.add(sph(0.03, 6, 5), P.DOG_DARK, B.xf(0, 0.455, 0.452), INK);
  for (const s of [1, -1]) {
    B.add(sph(0.019, 5, 4), P.DOG_DARK, B.xf(s * 0.05, 0.5, 0.365), INK);
    B.add(sph(1, 7, 5), P.DOG_EAR, B.xf(s * 0.095, 0.47, 0.25, 0, 0, s * 0.35, 0.032, 0.085, 0.055));
    for (const f of [1, -1]) {
      const x = s * 0.078;
      const z = f * 0.165 - 0.02;
      B.rod(P.DOG_LEG, V(x, 0.02, z), V(x, 0.3, z), 0.036, 0.04, 6);
      B.add(sph(0.04, 6, 4), P.DOG_LEG, B.xf(x, 0.025, z + 0.012, 0, 0, 0, 1, 0.7, 1.2));
    }
  }
  B.rod(P.DOG_TAIL, V(0, 0.37, -0.27), V(0, 0.5, -0.4), 0.026, 0.018, 5, WHITE, false);
  B.add(cyl(0.083, 0.083, 0.032, 10, true), P.DOG_COLLAR, B.xf(0, 0.415, 0.2, 0.7));
  return B.build();
}
