// The bird (D1, v2-BA): a chunky cartoon bluebird built in code (zero assets). Lofted ellipsoid
// sections with smooth normals, so the toon ramp draws soft rounded bands and the ink pass outlines
// it: a round blue body with a warm breast and a cream belly, a big head with cartoon eyes, an amber
// beak, a tail of five feathers that fans, and wings with a skeleton: an arm (shoulder, elbow), a
// wrist, and a hand of five separate primaries ("fingers") that spread and close.
//
// Local frame: +Z forward (the beak), +Y up, +X the bird's LEFT (up × forward), origin at the body's
// centre. Modelled at 1.84 m span (camera/bird/shared.ts BIRD_SIZE scales it down). One attribute
// drives the skinning (birdPatch): aBd = (signed span fraction of a wing vertex: + left, − right,
// 0 off the wings; the fan slot −1 … 1 of a primary or tail feather; region: 0 body, (0, 1] head
// weight, −1 tail feather, ≥ 2 the crash daze's item 2 + k). The pose itself (joint angles, fan,
// head counter-rotation, the daze's frame) is solved on the CPU (pose.ts) into one uniform array.

import { BufferAttribute, BufferGeometry, Color, Sphere, Vector3 } from 'three';
import type { ToonPatch } from '../../render/toon';
import { PALETTE } from '../../render/palette';

type Sec = readonly [t: number, a: number, b: number, cu?: number, cv?: number];
type V3 = readonly [number, number, number];
/** Colour of a loft vertex: section parameter t, position, and where round the section (sin φ: −1 under … 1 over; cos φ: −1 the −u edge … 1 the +u edge). */
type Paint = (t: number, x: number, y: number, z: number, up: number, edge: number) => Color;

const C = {
  back: new Color('#2E7FE8'),
  backDark: new Color('#1F56B8'),
  breast: new Color('#FF8F5A'),
  belly: PALETTE.walls[0].clone(),
  beak: PALETTE.accent.clone(),
  white: new Color('#FFFFFF'),
  ink: PALETTE.ink.clone(),
  bar: new Color('#FFB23D'),
  tip: new Color('#FFF7E8'),
  navy: new Color('#173C8C'),
  cheek: new Color('#FF9DB0'),
  under: new Color('#7E9BD0'),
  star: new Color('#FFD84A'),
};

/** Skeleton (left wing; x mirrors). The arm's bones run along the leading edge, so do the pivots. */
export const WING_Y = 0.07;
export const SHOULDER: V3 = [0.12, WING_Y, 0.1];
export const ELBOW: V3 = [0.25, WING_Y, 0.14];
export const WRIST: V3 = [0.52, WING_Y, 0.15];
/** Where the primaries fan from (the hand). */
export const HAND: V3 = [0.56, WING_Y, 0.08];
export const TAIL_PIVOT: V3 = [0, 0.03, -0.3];
export const NECK: V3 = [0, 0.08, 0.24];
/** The head's centre (the daze's stars circle it). */
export const HEAD: V3 = [0, 0.1, 0.36];
/** Span fraction: |x| from the wing root (SPAN0) to the tip (WING_TIP). */
export const SPAN0 = 0.13;
export const WING_TIP = 0.92;
/** Soft-skin bands (span fraction) of the elbow and the wrist. */
export const ELBOW_BAND: readonly [number, number] = [0.02, 0.3];
export const WRIST_BAND: readonly [number, number] = [0.42, 0.56];
/** Rest fan: angle between the outermost and the innermost slot (rad), primaries and tail. */
export const PRIMARY_REST = (55 * Math.PI) / 180;
export const TAIL_REST = (36 * Math.PI) / 180;
/** Legs (left; x mirrors): hip, ankle, foot. The rest pose is standing, the feet on the floor FEET below the centre. */
export const HIP: V3 = [0.07, -0.1, -0.06];
export const ANKLE: V3 = [0.07, -0.215, -0.005];
export const FOOT: V3 = [0.07, -0.345, -0.045];
/** Standing: the floor is this far below the body's centre (model units; flight.ts BIRD.belly is 0.36 × BIRD_SIZE). */
export const FEET = 0.36;
/** The daze: stars 0 … STARS − 1, then feathers. */
export const STARS = 3;
export const PUFFS = 5;
/** Bounding radius (model units) of every flight pose, flapping and bobbing included. */
export const BIRD_RADIUS = 1.1;

class Builder {
  pos: number[] = [];
  col: number[] = [];
  bd: number[] = [];
  idx: number[] = [];

  /**
   * A loft from `o` along the unit `d`, through elliptical sections [t, a, b, cu, cv]: a is the
   * half-axis along `u`, b along `v`, (cu, cv) the centre offset. A zero section is a pole.
   * `shape(j)` scales ring vertex j's radius (a star's points); `foil` thins the −u edge (an
   * airfoil: 0 an ellipse, 1 a knife edge) and `camber` arches the section along +v (a fraction of
   * a: the underside goes concave). `bd(x, y, z)` writes aBd.
   */
  loft(o: V3, u: V3, v: V3, d: V3, secs: readonly Sec[], seg: number, paint: Paint, bd: (x: number, y: number, z: number) => V3, shape?: (j: number) => number, foil = 0, camber = 0) {
    const rings: number[][] = [];
    for (const [t, a, b, cu = 0, cv = 0] of secs) {
      const ring: number[] = [];
      const pole = a <= 0 && b <= 0;
      for (let j = 0; j < seg; j++) {
        const phi = (j / seg) * Math.PI * 2;
        const k = shape ? shape(j) : 1;
        const pu = cu + (pole ? 0 : a * k * Math.cos(phi));
        const pv = cv + (pole ? 0 : b * k * Math.sin(phi) * (1 - (foil * (1 - Math.cos(phi))) / 2) + camber * a * Math.sin(phi) ** 2);
        const x = o[0] + d[0] * t + u[0] * pu + v[0] * pv;
        const y = o[1] + d[1] * t + u[1] * pu + v[1] * pv;
        const z = o[2] + d[2] * t + u[2] * pu + v[2] * pv;
        if (pole && j > 0) {
          ring.push(ring[0]);
          continue;
        }
        const c = paint(t, x, y, z, Math.sin(phi), Math.cos(phi));
        this.pos.push(x, y, z);
        this.col.push(c.r, c.g, c.b);
        this.bd.push(...bd(x, y, z));
        ring.push(this.pos.length / 3 - 1);
      }
      rings.push(ring);
    }
    // Outward winding for a right-handed (u, v, d) frame and t running forward; mirrored otherwise.
    const hand = (u[1] * v[2] - u[2] * v[1]) * d[0] + (u[2] * v[0] - u[0] * v[2]) * d[1] + (u[0] * v[1] - u[1] * v[0]) * d[2];
    const flip = hand < 0 !== secs[secs.length - 1][0] < secs[0][0];
    for (let k = 0; k < rings.length - 1; k++) {
      const r0 = rings[k];
      const r1 = rings[k + 1];
      for (let j = 0; j < seg; j++) {
        const j1 = (j + 1) % seg;
        const a = r0[j], b = r0[j1], c = r1[j], e = r1[j1];
        if (!flip) {
          if (a !== b) this.idx.push(a, b, e);
          if (c !== e) this.idx.push(a, e, c);
        } else {
          if (a !== b) this.idx.push(a, e, b);
          if (c !== e) this.idx.push(a, c, e);
        }
      }
    }
  }

  /** A loft along +z (u = x, v = y). */
  z(secs: readonly Sec[], seg: number, paint: Paint, bd: (x: number, y: number, z: number) => V3) {
    this.loft([0, 0, 0], X, Y, Z, secs, seg, paint, bd);
  }

  /** A UV ellipsoid (smooth), e.g. the head and the eyes. */
  sphere(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, paint: Paint, bd: (x: number, y: number, z: number) => V3, seg = 14) {
    const secs: Sec[] = [];
    const n = Math.max(6, Math.round(seg * 0.6));
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * Math.PI;
      const s = Math.sin(th);
      secs.push([cz - rz * Math.cos(th), rx * s, ry * s, cx, cy]);
    }
    this.z(secs, seg, paint, bd);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aBd', new BufferAttribute(new Float32Array(this.bd), 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix = (out: Color, a: Color, b: Color, t: number) => out.copy(a).lerp(b, Math.min(1, Math.max(0, t)));
const tmp = new Color();
const BODY: V3 = [0, 0, 0];
const HEADW: V3 = [0, 0, 1];
const span = (x: number) => Math.min(1, Math.max(0, (Math.abs(x) - SPAN0) / (WING_TIP - SPAN0)));
/** A feather: a thin loft from `o` along the in-plane direction (cos a, 0, −sin a) · s (s mirrors x). */
function feather(B: Builder, o: V3, ang: number, sx: number, len: number, w: (f: number) => number, th: number, paint: Paint, bd: (x: number, y: number, z: number) => V3, n = 9) {
  const d: V3 = [sx * Math.cos(ang), 0, -Math.sin(ang)];
  const u: V3 = [Math.sin(ang) * sx, 0, Math.cos(ang)];
  const secs: Sec[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    secs.push([len * f, i === n ? 0 : w(f), i === n ? 0 : th * (1 - 0.5 * f)]);
  }
  B.loft(o, u, Y, d, secs, 8, paint, bd);
}

/** A tapered round limb from `a` to `b` (radius r0 → r1, capped), one colour, region `r`. */
function limb(B: Builder, a: V3, b: V3, r0: number, r1: number, col: Color, r: number) {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const n: V3 = [d[0] / len, d[1] / len, d[2] / len];
  // A side axis: across the limb, horizontal unless it hangs straight down.
  const w = Math.hypot(n[2], n[0]) > 0.3 ? [n[2], 0, -n[0]] : [1, 0, 0];
  const k = Math.hypot(w[0], w[1], w[2]);
  const u: V3 = [w[0] / k, w[1] / k, w[2] / k];
  const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  B.loft(a, u, v, n, [[-r0 * 0.6, 0, 0], [0, r0, r0], [len, r1, r1], [len + r1 * 0.8, 0, 0]], 7, () => col, (): V3 => [0, 0, r]);
}

export function buildBirdGeometry(): BufferGeometry {
  const B = new Builder();
  // Body: a plump teardrop along z, tail end narrow. Blue back, warm breast, cream belly. The neck
  // follows the head (aBd.z) so the head can hold level without tearing off.
  const body: Sec[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const u = i / N; // 0 tail … 1 neck
    const z = -0.42 + u * 0.78;
    const r = Math.sin(Math.PI * Math.pow(u, 0.85)) ** 0.75;
    const a = i === 0 || i === N ? 0 : 0.185 * r;
    const b = i === 0 || i === N ? 0 : 0.175 * r;
    body.push([z, a, b, 0, (u - 0.6) * 0.06]);
  }
  const neck = (_x: number, _y: number, z: number): V3 => [0, 0, 0.6 * smooth(0.12, 0.36, z)];
  B.z(body, 16, (z, _x, y) => {
    const fr = smooth(-0.1, 0.25, z); // toward the chest
    const under = smooth(0.02, -0.1, y); // underside
    mix(tmp, C.back, C.breast, under * fr * 1.2);
    return under > 0.5 && fr < 0.6 ? mix(tmp, tmp, C.belly, (under - 0.5) * 2 * (1 - fr)) : tmp;
  }, neck);

  // Head: a big round head, forward and up; the blue cap fades to a warm face below the eyes.
  const hd = () => HEADW;
  B.sphere(HEAD[0], HEAD[1], HEAD[2], 0.155, 0.15, 0.16, (_t, _x, y) => mix(tmp, C.breast, C.back, smooth(0.04, 0.12, y)), hd, 18);
  // Cheeks (a pink blush) and the eyes: whites with ink pupils (on the face, inside the head's
  // outline from behind and above: no "ears").
  for (const s of [1, -1]) {
    B.sphere(s * 0.1, 0.05, 0.445, 0.034, 0.026, 0.03, () => C.cheek, hd, 10);
    B.sphere(s * 0.062, 0.118, 0.478, 0.05, 0.058, 0.034, () => C.white, hd, 14);
    B.sphere(s * 0.07, 0.124, 0.503, 0.027, 0.032, 0.018, () => C.ink, hd, 10);
  }
  // A cartoon crest: two little swept tufts on the crown (the head reads from behind).
  for (const [dx, lean] of [[0.025, 0.02], [-0.03, -0.015]] as const) {
    B.z([
      [0.37, 0.034, 0.03, dx, 0.225],
      [0.31, 0.022, 0.02, dx + lean, 0.275],
      [0.25, 0, 0, dx + lean * 1.6, 0.31],
    ], 8, () => C.backDark, hd);
  }
  // Beak: a short cone.
  B.z([
    [0.47, 0.055, 0.045, 0, 0.075],
    [0.56, 0.035, 0.028, 0, 0.065],
    [0.63, 0, 0, 0, 0.055],
  ], 10, () => C.beak, hd);

  // Tail: five spatulate feathers fanned from the rump (centre on top), cream-tipped.
  for (let i = 0; i < 5; i++) {
    const c = (i - 2) / 2;
    const len = 0.33 - 0.025 * Math.abs(c);
    const o: V3 = [TAIL_PIVOT[0], TAIL_PIVOT[1] + 0.008 * (1 - Math.abs(c)), TAIL_PIVOT[2]];
    feather(B, o, Math.PI / 2 + c * TAIL_REST / 2, 1, len,
      (f) => (0.014 + 0.032 * smooth(0, 0.75, f)) * (f > 0.82 ? Math.sqrt(Math.max(0, 1 - ((f - 0.82) / 0.18) ** 2)) : 1),
      0.011, (t, _x, _y, _z, up) => (t > len * 0.84 ? C.tip : up < -0.3 ? C.under : mix(tmp, C.back, C.navy, smooth(0.05, 0.25, t))),
      (): V3 => [0, c, -1]);
  }

  // Wings: the arm and the hand's coverts are one loft (shoulder → wrist → palm): a leading edge that
  // bulges forward to the wrist, the secondaries' tips scalloped along the trailing edge, a cambered
  // airfoil (the underside concave, so it shades round from any angle instead of a flat plank).
  // Over: a warm bar along the coverts, navy secondaries. Under: blue-grey, the bar showing through
  // faintly, darker between the feathers and along both edges (the outline the depth ink can't draw
  // across a wing seen flat on). Five primaries splay from the hand.
  const SP_END = 0.62;
  const zLE = (sp: number) => (sp < 0.45 ? 0.13 + 0.06 * Math.sin((sp / 0.45) * Math.PI * 0.5) : 0.19 - 2.6 * (sp - 0.45) ** 2);
  /** The secondaries' tips: 1 at a tip … 0 between two feathers. */
  const tips = (sp: number) => (sp > 0.06 && sp < 0.5 ? Math.pow(Math.max(0, Math.sin((sp - 0.06) * Math.PI * 11.4)), 0.5) : 1);
  const zTE = (sp: number) => (sp < 0.5 ? -0.27 + (0.1 * sp) / 0.5 : -0.17 + 0.9 * (sp - 0.5) ** 2) + 0.04 * (1 - tips(sp)) * smooth(0.04, 0.1, sp);
  for (const s of [1, -1]) {
    const secs: Sec[] = [];
    const M = 34;
    for (let i = 0; i <= M; i++) {
      const sp = (i / M) * SP_END;
      // Round the palm off over its last 0.06 of span (the primaries cover its end).
      const end = sp > SP_END - 0.06 ? Math.sqrt(Math.max(0, 1 - ((sp - (SP_END - 0.06)) / 0.06) ** 2)) : 1;
      const le = zLE(sp);
      const te = zTE(sp);
      const th = 0.04 - 0.028 * smooth(0, 0.6, sp);
      secs.push([s * (SPAN0 + sp * (WING_TIP - SPAN0)), i === M ? 0 : ((le - te) / 2) * end, i === M ? 0 : th * Math.max(0.3, end), (le + te) / 2, WING_Y]);
    }
    if (s < 0) secs.reverse();
    // (x-axis loft: u = z, v = y.)
    B.loft([0, 0, 0], Z, Y, X, secs, 12, (_t, x, _y, z, up, edge) => {
      const sp = span(x);
      const le = zLE(sp);
      const f = (le - z) / Math.max(1e-3, le - zTE(sp)); // 0 leading … 1 trailing edge
      const bar = f > 0.36 && f < 0.52 && sp > 0.06 && sp < 0.6;
      if (up < -0.25) {
        mix(tmp, C.under, C.bar, bar ? 0.35 : 0);
        return mix(tmp, tmp, C.navy, Math.max(Math.abs(edge) > 0.8 ? 0.45 : 0, 0.4 * (1 - tips(sp)) * smooth(0.4, 0.8, f)));
      }
      if (bar) return C.bar;
      return mix(tmp, C.back, C.navy, Math.max(smooth(0.5, 0.66, sp), smooth(0.55, 0.85, f)));
    }, (x): V3 => [s * span(x), 0, 0], undefined, 0.7, 0.16);
    // Primaries: outermost (slot −1, nearly straight out) to innermost (slot 1, swept back),
    // stacked a little in height so overlapping vanes never z-fight.
    for (let i = 0; i < 5; i++) {
      const c = (i - 2) / 2;
      const len = [0.36, 0.37, 0.36, 0.33, 0.3][i];
      const o: V3 = [s * HAND[0], HAND[1] + 0.004 * c, HAND[2]];
      feather(B, o, PRIMARY_REST / 2 + (c * PRIMARY_REST) / 2, s, len,
        (f) => (0.014 + 0.017 * smooth(0, 0.3, f)) * (f > 0.65 ? Math.sqrt(Math.max(0, 1 - ((f - 0.65) / 0.35) ** 2)) : 1),
        0.009, (t, _x, _y, _z, up) => (up < -0.3 ? C.under : mix(tmp, C.navy, C.backDark, smooth(len * 0.5, len, t))),
        (x): V3 => [s * Math.max(0.56, span(x)), c, 0]);
    }
  }

  // Legs: a feathered thigh (aBd.z −2) into the belly, an amber shank (−3) and toes (−4) below the
  // ankle; modelled standing, tucked or lowered by the shader (the toes flat on the floor or curled).
  for (const s of [1, -1]) {
    const m = (p: V3): V3 => [s * p[0], p[1], p[2]];
    limb(B, m(HIP), m(ANKLE), 0.04, 0.02, C.belly, -2);
    limb(B, m(ANKLE), m(FOOT), 0.013, 0.011, C.beak, -3);
    for (const [ang, len] of [[0.45, 0.07], [0, 0.08], [-0.45, 0.07], [Math.PI, 0.045]]) {
      limb(B, m(FOOT), [s * FOOT[0] + Math.sin(ang) * len, FOOT[1] - 0.004, FOOT[2] + Math.cos(ang) * len], 0.011, 0.005, C.beak, -4);
    }
  }

  // The crash daze (drawn collapsed to a point unless dazed): puffy stars and loose feathers, each
  // modelled round its own origin, facing +z; the shader turns them to face the camera and places
  // them (index.ts writes the frame and the clock).
  for (let k = 0; k < STARS; k++) {
    B.loft([0, 0, 0], X, Y, Z, [[-0.022, 0, 0], [-0.016, 0.075, 0.075], [0.016, 0.075, 0.075], [0.022, 0, 0]], 10, () => C.star, (): V3 => [0, 0, 2 + k], (j) => (j % 2 ? 0.45 : 1));
  }
  for (let k = 0; k < PUFFS; k++) {
    feather(B, [-0.1, 0, 0], 0, 1, 0.2, (f) => 0.016 + 0.026 * Math.sin(Math.PI * Math.min(1, f * 1.1)), 0.006,
      (t) => (t > 0.16 ? C.tip : k % 2 ? C.back : C.under), (): V3 => [0, 0, 2 + STARS + k], 6);
  }

  const g = B.build();
  g.boundingSphere = new Sphere(new Vector3(), BIRD_RADIUS);
  return g;
}

/** GLSL vec3 of a point; `side` puts the wing's sign (sd) on x. */
const f3 = (v: V3, side = false) => `vec3(${side ? 'sd * ' : ''}${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)})`;

/**
 * The skinning, in the vertex shader. uBd (13 vec4; pose.ts writes the pose, index.ts the daze):
 *   [0 … 2] left shoulder, elbow, wrist: (twist, sweep back, elevation, fold scale / — / primary fan) rad,
 *   [3 … 5] the right wing, mirrored signs already applied;
 *   [6] tail (pitch up, yaw, roll, fan) · [7] head (pitch down, yaw, roll) about the neck, the toes' angle;
 *   [8] (body bob, daze clock s, star scale, feather scale);
 *   [9 … 11] the daze frame: columns xyz (world-level axes in model space), w the impact (model space);
 *     the daze's items face the camera (turned by the inverse model-view rotation);
 *   [12] head offset xyz (holds it still while the body bobs; forward in a flare);
 *   [13] (hip, ankle) rad of the legs, the body's tilt about the hip (rad, nose up −), its crouch.
 * The folded wing (standing) also shrinks about the shoulder by the fold scale and moves out and
 * down onto the flank in step (the shoulder is inside the body: no turn alone lays it there); all but the
 * legs and the daze tilts about the hip, and everything but the daze crouches (the feet stay put).
 * A joint turns about its pivot: twist (x) first, then sweep (y) and elevation (z): the shoulder
 * elevates after sweeping, the elbow and the wrist sweep after elevating (a raised hand stays raised
 * as it folds back). Distal joints first, each about its rest pivot: forward kinematics. Soft bands
 * scale the elbow's and wrist's angles across the joint, so the wing bends instead of creasing.
 * Colour pass only: the normals follow (LB_BIRD_COLOR); stars glow flat (vBdG).
 */
export function birdPatch(uBd: { value: Float32Array }): ToonPatch {
  const vertexPars = /* glsl */ `
attribute vec3 aBd;
uniform vec4 uBd[14];
#ifdef LB_BIRD_COLOR
varying float vBdG;
#endif
vec3 bdX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
vec3 bdY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x); }
vec3 bdZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
void bdJ(inout vec3 p, inout vec3 n, vec3 o, vec3 a, bool d) {
  p = bdX(p - o, a.x);
  n = bdX(n, a.x);
  if (d) { p = bdY(bdZ(p, a.z), a.y); n = bdY(bdZ(n, a.z), a.y); }
  else { p = bdZ(bdY(p, a.y), a.z); n = bdZ(bdY(n, a.y), a.z); }
  p += o;
}
`;
  const vertex = /* glsl */ `
{
  #ifdef LB_BIRD_COLOR
  vec3 bdN = objectNormal;
  vBdG = 0.0;
  #else
  vec3 bdN = vec3(0.0, 1.0, 0.0);
  #endif
  vec3 bdP = transformed;
  float bdR = aBd.z;
  if (aBd.x != 0.0) {
    float sp = abs(aBd.x);
    bool bdL = aBd.x > 0.0;
    float sd = bdL ? 1.0 : -1.0;
    vec4 bdW = bdL ? uBd[2] : uBd[5];
    if (aBd.y != 0.0) bdJ(bdP, bdN, ${f3(HAND, true)}, vec3(0.0, aBd.y * bdW.w, 0.0), false);
    bdJ(bdP, bdN, ${f3(WRIST, true)}, bdW.xyz * smoothstep(${WRIST_BAND[0].toFixed(3)}, ${WRIST_BAND[1].toFixed(3)}, sp), true);
    bdJ(bdP, bdN, ${f3(ELBOW, true)}, (bdL ? uBd[1] : uBd[4]).xyz * smoothstep(${ELBOW_BAND[0].toFixed(3)}, ${ELBOW_BAND[1].toFixed(3)}, sp), true);
    vec4 bdS = bdL ? uBd[0] : uBd[3];
    bdJ(bdP, bdN, ${f3(SHOULDER, true)}, bdS.xyz, false);
    bdP = ${f3(SHOULDER, true)} + (bdP - ${f3(SHOULDER, true)}) * bdS.w + vec3(sd * 0.155, -0.22, 0.0) * (1.0 - bdS.w);
  } else if (bdR < -1.5) {
    if (bdR < -3.5) bdJ(bdP, bdN, ${f3([0, FOOT[1], FOOT[2]])}, vec3(uBd[7].w, 0.0, 0.0), false);
    if (bdR < -2.5) bdJ(bdP, bdN, ${f3([0, ANKLE[1], ANKLE[2]])}, vec3(uBd[13].y, 0.0, 0.0), false);
    bdJ(bdP, bdN, ${f3([0, HIP[1], HIP[2]])}, vec3(uBd[13].x, 0.0, 0.0), false);
  } else if (bdR < 0.0) {
    bdJ(bdP, bdN, ${f3(TAIL_PIVOT)}, vec3(0.0, aBd.y * uBd[6].w, 0.0), false);
    bdJ(bdP, bdN, ${f3(TAIL_PIVOT)}, uBd[6].xyz, false);
  } else if (bdR >= 2.0) {
    float k = bdR - 2.0;
    float t = uBd[8].y;
    mat3 bdM = mat3(uBd[9].xyz, uBd[10].xyz, uBd[11].xyz);
    vec3 c;
    float sc;
    if (k < ${STARS}.0 - 0.5) {
      float an = t * 5.5 + k * 2.0944;
      bdP = bdZ(bdP, an * 0.7);
      bdN = bdZ(bdN, an * 0.7);
      c = ${f3(HEAD)} + bdM * vec3(0.27 * cos(an), 0.21 + 0.035 * sin(3.0 * an), 0.27 * sin(an));
      sc = uBd[8].z;
      #ifdef LB_BIRD_COLOR
      vBdG = 1.0;
      #endif
    } else {
      float j = k - ${STARS}.0;
      float a = j * 2.4 + 0.6;
      vec3 v = vec3(cos(a), 0.5 + 0.35 * sin(j * 1.7), sin(a)) * (0.95 + 0.3 * fract(j * 0.618));
      vec3 w = v * 0.5 * (1.0 - exp(-6.0 * t)) + vec3(0.1 * sin(t * 3.6 + j * 2.0), -0.45 * max(0.0, t - 0.25), 0.1 * cos(t * 2.9 + j));
      float fl = 1.3 + 0.6 * sin(t * 5.0 + j * 1.3);
      bdP = bdZ(bdX(bdP, fl), t * 1.5 + a);
      bdN = bdZ(bdX(bdN, fl), t * 1.5 + a);
      c = vec3(uBd[9].w, uBd[10].w, uBd[11].w) + bdM * w;
      sc = uBd[8].w;
    }
    mat3 bdV = transpose(mat3(modelViewMatrix));
    bdP = c + bdV * bdP * (sc / length(modelViewMatrix[0].xyz));
    bdN = bdV * bdN;
  } else if (bdR > 0.0) {
    bdJ(bdP, bdN, ${f3(NECK)}, uBd[7].xyz * bdR, false);
    bdP += uBd[12].xyz * bdR;
  }
  if (bdR < 2.0) {
    if (bdR > -1.5) {
      bdP = ${f3([0, HIP[1], HIP[2]])} + bdX(bdP - ${f3([0, HIP[1], HIP[2]])}, uBd[13].z);
      bdN = bdX(bdN, uBd[13].z);
    }
    bdP.y += uBd[8].x - uBd[13].w;
  }
  transformed = bdP;
  #ifdef LB_BIRD_COLOR
  vNormal = normalize(normalMatrix * bdN);
  #endif
}
`;
  const fragmentPars = /* glsl */ `
#ifdef LB_BIRD_COLOR
varying float vBdG;
#endif
`;
  const fragment = /* glsl */ `
#ifdef LB_BIRD_COLOR
outgoingLight = mix(outgoingLight, diffuseColor.rgb * 1.15, vBdG * 0.8);
#endif
`;
  return { key: 'bird', vertexPars, vertex, fragmentPars, fragment, uniforms: { uBd } };
}
