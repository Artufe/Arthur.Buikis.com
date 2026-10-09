// The bird (D1): a chunky cartoon bluebird built in code (zero assets). Lofted ellipsoid sections
// with smooth normals, so the toon ramp draws soft rounded bands and the ink pass outlines it:
// a round blue body with a warm breast and a cream belly, a big head with cartoon eyes, an amber
// beak, a fanned tail and long rounded wings with dark tips and a pale bar.
//
// Local frame: +Z forward (the beak), +Y up, +X the bird's LEFT (up × forward), origin at the body's
// centre. Attribute aWing is the signed span fraction of wing vertices (+ left, − right; 0 for the
// body): the vertex shader (BIRD_PATCH) flaps, bends and tucks the wings from it.

import { BufferAttribute, BufferGeometry, Color, Sphere, Vector3 } from 'three';
import type { ToonPatch } from '../../render/toon';
import { PALETTE } from '../../render/palette';

type Sec = readonly [t: number, a: number, b: number, cu?: number, cv?: number];

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
};

class Builder {
  pos: number[] = [];
  col: number[] = [];
  wing: number[] = [];
  idx: number[] = [];

  /**
   * A loft along `axis` (0 = x, 2 = z) through elliptical sections [t, a, b, cu, cv]: a is the
   * half-axis across (the other horizontal axis), b the vertical half-axis, (cu, cv) the centre
   * offset. A zero section is a pole. `color(t, phi)` paints it; `wing(t)` its span attribute.
   */
  loft(axis: 0 | 2, secs: readonly Sec[], seg: number, color: (t: number, y: number, phi: number) => Color, wing: (t: number) => number = () => 0) {
    const rings: number[][] = [];
    for (const [t, a, b, cu = 0, cv = 0] of secs) {
      const ring: number[] = [];
      if (a <= 0 && b <= 0) {
        const i = this.vert(axis, t, cu, cv, color(t, cv, 0), wing(t));
        for (let j = 0; j < seg; j++) ring.push(i);
      } else {
        for (let j = 0; j < seg; j++) {
          const phi = (j / seg) * Math.PI * 2;
          const u = cu + a * Math.cos(phi);
          const v = cv + b * Math.sin(phi);
          ring.push(this.vert(axis, t, u, v, color(t, v, phi), wing(t)));
        }
      }
      rings.push(ring);
    }
    // Outward winding: (a, b, d) for a loft running toward +z (u = x, v = y); the x-axis frame
    // (u = z) is mirrored, and so is a loft whose t runs backwards.
    const flip = (axis === 0) !== secs[secs.length - 1][0] < secs[0][0];
    for (let k = 0; k < rings.length - 1; k++) {
      const r0 = rings[k];
      const r1 = rings[k + 1];
      for (let j = 0; j < seg; j++) {
        const j1 = (j + 1) % seg;
        const a = r0[j], b = r0[j1], c = r1[j], d = r1[j1];
        if (!flip) {
          if (a !== b) this.idx.push(a, b, d);
          if (c !== d) this.idx.push(a, d, c);
        } else {
          if (a !== b) this.idx.push(a, d, b);
          if (c !== d) this.idx.push(a, c, d);
        }
      }
    }
  }

  /** A UV sphere (smooth), e.g. the head and the eyes. */
  sphere(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: (y: number, z: number) => Color, seg = 14) {
    const secs: Sec[] = [];
    const n = Math.max(6, Math.round(seg * 0.6));
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * Math.PI;
      const s = Math.sin(th);
      secs.push([cz - rz * Math.cos(th), rx * s, ry * s, cx, cy]);
    }
    this.loft(2, secs, seg, (_t, y, _p) => color(y, _t));
  }

  private vert(axis: 0 | 2, t: number, u: number, v: number, c: Color, w: number): number {
    if (axis === 2) this.pos.push(u, v, t);
    else this.pos.push(t, v, u);
    this.col.push(c.r, c.g, c.b);
    this.wing.push(w);
    return this.pos.length / 3 - 1;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aWing', new BufferAttribute(new Float32Array(this.wing), 1));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Shoulder (|x|) and wing tip (|x|) of the bird, m. */
export const SHOULDER = 0.13;
export const WING_TIP = 0.92;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix = (out: Color, a: Color, b: Color, t: number) => out.copy(a).lerp(b, Math.min(1, Math.max(0, t)));
const tmp = new Color();

export function buildBirdGeometry(): BufferGeometry {
  const B = new Builder();

  // Body: a plump teardrop along z, tail end narrow. Blue back, warm breast, cream belly.
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
  B.loft(2, body, 16, (z, y) => {
    const fr = smooth(-0.1, 0.25, z); // toward the chest
    const under = smooth(0.02, -0.1, y); // underside
    mix(tmp, C.back, C.breast, under * fr * 1.2);
    return under > 0.5 && fr < 0.6 ? mix(tmp, tmp, C.belly, (under - 0.5) * 2 * (1 - fr)) : tmp;
  });

  // Head: a big round head, forward and up; the blue cap fades to a warm face below the eyes.
  B.sphere(0, 0.1, 0.36, 0.155, 0.15, 0.16, (y) => mix(tmp, C.breast, C.back, smooth(0.04, 0.12, y)), 18);
  // Cheeks (a pink blush) and the eyes: whites with ink pupils and a glint-free cartoon dot.
  // (On the face, inside the head's outline from behind and above: no "ears".)
  for (const s of [1, -1]) {
    B.sphere(s * 0.1, 0.05, 0.445, 0.034, 0.026, 0.03, () => C.cheek, 10);
    B.sphere(s * 0.062, 0.118, 0.478, 0.05, 0.058, 0.034, () => C.white, 14);
    B.sphere(s * 0.07, 0.124, 0.503, 0.027, 0.032, 0.018, () => C.ink, 10);
  }
  // A cartoon crest: two little swept tufts on the crown — the head reads from behind.
  for (const [dx, lean] of [[0.025, 0.02], [-0.03, -0.015]] as const) {
    B.loft(2, [
      [0.37, 0.034, 0.03, dx, 0.225],
      [0.31, 0.022, 0.02, dx + lean, 0.275],
      [0.25, 0, 0, dx + lean * 1.6, 0.31],
    ], 8, () => C.backDark);
  }
  // Beak: a short cone.
  B.loft(2, [
    [0.47, 0.055, 0.045, 0, 0.075],
    [0.56, 0.035, 0.028, 0, 0.065],
    [0.63, 0, 0, 0, 0.055],
  ], 10, () => C.beak);

  // Tail: a fan, flat and wide at the end, with a notch-free rounded tip.
  B.loft(2, [
    [-0.33, 0.07, 0.04, 0, 0.02],
    [-0.45, 0.11, 0.025, 0, 0.035],
    [-0.6, 0.17, 0.02, 0, 0.05],
    [-0.66, 0.14, 0.015, 0, 0.055],
    [-0.68, 0, 0, 0, 0.055],
  ], 12, (z) => (z < -0.585 ? C.tip : mix(tmp, C.back, C.navy, smooth(-0.4, -0.56, z))));

  // Wings: long, rounded, slightly swept, thin at the tip; a pale bar mid-span, dark tips.
  for (const s of [1, -1]) {
    const secs: Sec[] = [];
    const M = 30;
    for (let i = 0; i <= M; i++) {
      const u = i / M; // 0 shoulder … 1 tip
      const x = s * (SHOULDER + u * (WING_TIP - SHOULDER));
      let a = 0.2 * (1 - u * 0.45) * Math.sqrt(Math.max(0, 1 - Math.pow(u, 3)));
      const th = 0.045 * (1 - u * 0.65);
      let zc = 0.02 - u * u * 0.16; // swept back toward the tip
      const yc = 0.03 + u * 0.05; // a touch of dihedral
      // Primary feathers: the trailing edge scalloped toward the tip (the leading edge stays put).
      const sc = 0.035 * Math.pow(Math.max(0, Math.sin((u - 0.5) * Math.PI * 7)), 0.6) * smooth(0.5, 0.7, u) * (1 - smooth(0.93, 1, u));
      a += sc;
      zc -= sc;
      secs.push([x, i === M ? 0 : a, i === M ? 0 : th, zc, yc]);
    }
    if (s < 0) secs.reverse();
    // A bold warm bar across the wing and pale tips, so the bird reads from behind and above
    // against grass, sea and sky (a plain blue wing vanished over the water).
    B.loft(0, secs, 12, (x) => {
      const u = (Math.abs(x) - SHOULDER) / (WING_TIP - SHOULDER);
      mix(tmp, C.back, C.navy, smooth(0.58, 0.8, u));
      if (u > 0.3 && u < 0.46) return C.bar;
      if (u > 0.88) return C.tip;
      return tmp;
    }, (x) => s * Math.min(1, Math.max(0, (Math.abs(x) - SHOULDER) / (WING_TIP - SHOULDER))));
  }

  const g = B.build();
  // The wings sweep ±0.5 m up and down: a generous bound so it is never culled mid-flap.
  g.boundingSphere = new Sphere(new Vector3(0, 0.05, 0), 1.15);
  return g;
}

/**
 * The flap, in the vertex shader: each wing turns about its shoulder (x = ±SHOULDER, along the
 * body's z axis) by a travelling wave — the outer half lags and swings further, so it reads as an
 * elbow and a wrist — and folds back and in for the dive (uBird.z). The body bobs against the beat.
 * uBird = (phase rad, amplitude 0…1, tuck 0…1). Colour pass only: the normals follow (LB_BIRD_COLOR).
 */
export function birdPatch(uBird: { value: Vector3 }): ToonPatch {
  const vertexPars = /* glsl */ `
attribute float aWing;
uniform vec3 uBird;
vec3 bdRz(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
vec3 bdRy(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
`;
  const vertex = /* glsl */ `
{
  #ifdef LB_BIRD_COLOR
  vec3 bdN = objectNormal;
  #else
  vec3 bdN = vec3(0.0, 1.0, 0.0);
  #endif
  float bdAmp = uBird.y;
  float bdPh = uBird.x;
  float bdTuck = uBird.z;
  if (aWing != 0.0) {
    float sd = sign(aWing);
    float sp = abs(aWing);
    vec3 sh = vec3(sd * ${SHOULDER.toFixed(3)}, 0.0, 0.0);
    vec3 q = transformed - sh;
    // (The dive is a stoop: the wings swept back half-open into an arrowhead, raised a little —
    // folded flat and short they read as a blue saucer from the chase camera above.)
    q.x *= 1.0 - 0.2 * bdTuck * sp;
    float sweep = sd * bdTuck * 0.78 * smoothstep(0.0, 0.6, sp);
    q = bdRy(q, sweep);
    bdN = bdRy(bdN, sweep);
    float a1 = bdAmp * (0.62 * sin(bdPh) + 0.1) + 0.16 * bdTuck;
    float a2 = bdAmp * 0.55 * sin(bdPh - 1.1) * smoothstep(0.25, 0.75, sp);
    float ang = sd * (a1 + a2);
    q = bdRz(q, ang);
    bdN = bdRz(bdN, ang);
    transformed = sh + q;
  }
  transformed.y -= bdAmp * 0.035 * sin(bdPh);
  #ifdef LB_BIRD_COLOR
  vNormal = normalize(normalMatrix * bdN);
  #endif
}
`;
  return { key: 'bird', vertexPars, vertex, uniforms: { uBird } };
}
