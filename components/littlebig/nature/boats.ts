// Boats (A1): a few toy sailboats and a fishing boat on closed loops in the water off the city's
// coast and round the lighthouse. Each sails a seeded ellipse in its own tangent plane (closed form
// in sim time: deterministic, no spawning, never on land: every loop is checked against the seabed
// depth at build time), bobs and rocks with the ocean's own swell (ocean/swell.ts, the same waves
// the water draws) and trails a soft foam wake that hugs the curved sea. Hulls and sails use the
// nature program (masthead lamps and cabin windows glow at night through its aTint −1 flag); the
// wake is one small transparent instanced mesh, never inked.

import { BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedBufferAttribute, InstancedMesh, Matrix4, ShaderMaterial } from 'three';
import type { LBContext } from '../core/contracts';
import { LAYER_NO_INK } from '../core/contracts';
import { LB_COMMON_GLSL, type ToonMaterial } from '../render/toon';
import { R } from '../world/config';
import type { Planet } from '../world/planet';
import { mulberry32 } from '../world/rng';
import type { Vec3 } from '../world/sphere';
import { SWELL_GLSL, swellFade, swellW } from '../ocean/swell';
import { composeUp, yawAlong } from './frame';
import { blob, Builder, FRAME, GLASS, noSway, prism, ROOF_RED, SAIL, type V3, WHITE, WOOD } from './geometry';

export interface BoatLoop {
  kind: 'sail' | 'fish';
  /** Loop centre (unit) and the ellipse's axes in its tangent plane (unit, metres). */
  c: Vec3;
  e1: Vec3;
  e2: Vec3;
  a: number;
  b: number;
  /** Phase (rad), angular speed (rad/s, signed: the sense of travel). */
  phase: number;
  w: number;
}

/** Minimum water depth (m) along a loop, with a margin round it. */
const MIN_DEPTH = 0.9;

function frame(c: Vec3, rot: number) {
  let ex = c.z, ey = 0, ez = -c.x;
  const el = Math.hypot(ex, ez) || 1;
  ex /= el;
  ez /= el;
  const nx = c.y * ez - c.z * ey, ny = c.z * ex - c.x * ez, nz = c.x * ey - c.y * ex;
  const co = Math.cos(rot), si = Math.sin(rot);
  return {
    e1: { x: ex * co + nx * si, y: ey * co + ny * si, z: ez * co + nz * si },
    e2: { x: nx * co - ex * si, y: ny * co - ey * si, z: nz * co - ez * si },
  };
}

/** The unit direction of a loop at angle θ (out), tangent-plane point projected to the sphere. */
function loopDir(l: { c: Vec3; e1: Vec3; e2: Vec3; a: number; b: number }, th: number, out: Vec3, grow = 0): Vec3 {
  const ca = Math.cos(th) * (l.a + grow), sb = Math.sin(th) * (l.b + grow);
  const x = l.c.x * R + l.e1.x * ca + l.e2.x * sb;
  const y = l.c.y * R + l.e1.y * ca + l.e2.y * sb;
  const z = l.c.z * R + l.e1.z * ca + l.e2.z * sb;
  const m = Math.hypot(x, y, z);
  out.x = x / m;
  out.y = y / m;
  out.z = z / m;
  return out;
}

/**
 * Seeded loops: `count` near each anchor (unit direction), searched on rings at the given
 * distances (m), every loop in water ≥ MIN_DEPTH deep (2.5 m margin) and clear of the others.
 */
export function findBoatLoops(planet: Planet, anchors: Array<{ dir: Vec3; dists: number[]; count: number; fish?: boolean }>): BoatLoop[] {
  const rnd = mulberry32(0xb0a7);
  const out: BoatLoop[] = [];
  const d = { x: 0, y: 0, z: 0 };
  for (const an of anchors) {
    let got = 0;
    const f = frame(an.dir, 0);
    for (const dist of an.dists) {
      for (let k = 0; k < 18 && got < an.count; k++) {
        const br = (k / 18) * Math.PI * 2 + dist * 0.07;
        const ang = dist / R;
        const tx = f.e1.x * Math.cos(br) + f.e2.x * Math.sin(br);
        const ty = f.e1.y * Math.cos(br) + f.e2.y * Math.sin(br);
        const tz = f.e1.z * Math.cos(br) + f.e2.z * Math.sin(br);
        const c = { x: an.dir.x * Math.cos(ang) + tx * Math.sin(ang), y: an.dir.y * Math.cos(ang) + ty * Math.sin(ang), z: an.dir.z * Math.cos(ang) + tz * Math.sin(ang) };
        const a = 9 + rnd() * 5;
        const fish = !!an.fish && got === 0;
        const l = { c, ...frame(c, rnd() * Math.PI), a, b: a * (0.5 + rnd() * 0.15) };
        let ok = true;
        for (const o of out) {
          const sep = Math.acos(Math.min(1, o.c.x * c.x + o.c.y * c.y + o.c.z * c.z)) * R;
          if (sep < o.a + a + 6) ok = false;
        }
        for (let s = 0; ok && s < 16; s++) if (planet.heightAt(loopDir(l, (s / 16) * Math.PI * 2, d, 2.5)) > -MIN_DEPTH) ok = false;
        if (ok && planet.heightAt(c) > -MIN_DEPTH) ok = false;
        if (!ok) continue;
        const speed = fish ? 1.1 : 1.6 + rnd() * 0.8;
        out.push({ kind: fish ? 'fish' : 'sail', ...l, phase: rnd() * Math.PI * 2, w: ((rnd() < 0.5 ? -1 : 1) * speed) / ((l.a + l.b) / 2) });
        got++;
      }
    }
  }
  return out;
}

// ── meshes ──

/** A toy hull, length `L` (bow +Z), deck at y = 0.42, keel 0.12 under the waterline (y = 0). */
function hull(b: Builder, L: number, W: number) {
  const N = 14;
  const ring = (y: number, sx: number, sz: number): V3[] => {
    const pts: V3[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const c = Math.cos(a);
      const x = Math.sin(a) * W * 0.5 * (1 - 0.55 * Math.max(0, c) ** 1.6);
      const z = Math.max(-0.75, c) * L * 0.5; // a flat transom at the stern
      pts.push([x * sx, y, z * sz]);
    }
    return pts;
  };
  const keel = ring(-0.12, 0.45, 0.82);
  const deck = ring(0.42, 1, 1);
  const rail = ring(0.52, 1.02, 1.01);
  const railIn = ring(0.52, 0.94, 0.95);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    b.tri(keel[i], deck[j], deck[i], WHITE, 1, noSway);
    b.tri(keel[i], keel[j], deck[j], WHITE, 1, noSway);
    b.tri(deck[i], rail[j], rail[i], FRAME, 0, noSway);
    b.tri(deck[i], deck[j], rail[j], FRAME, 0, noSway);
    b.tri(railIn[i], railIn[j], deck[j], FRAME, 0, noSway);
    b.tri(railIn[i], deck[j], deck[i], FRAME, 0, noSway);
    b.tri(rail[i], rail[j], railIn[j], FRAME, 0, noSway);
    b.tri(rail[i], railIn[j], railIn[i], FRAME, 0, noSway);
    b.tri([0, 0.42, 0], deck[i], deck[j], WOOD, 0, noSway);
  }
}

/** A double-sided triangle (the back face 2 cm behind, against self-shadow acne). */
function sail(b: Builder, p: V3, q: V3, r: V3, c: Color, tint = 0) {
  b.tri(p, q, r, c, tint, noSway);
  b.tri([r[0] - 0.02, r[1], r[2]], [q[0] - 0.02, q[1], q[2]], [p[0] - 0.02, p[1], p[2]], c, tint, noSway);
}

function sailboatGeometry(): BufferGeometry {
  const b = new Builder();
  hull(b, 3.2, 1.25);
  prism(b, 5, 0.045, 0.035, 0.42, 3.1, FRAME, 0, noSway, 0, 0.3);
  blob(b, 0, 3.15, 0.3, 0.07, 0.07, 0.07, WHITE, -1, noSway, 7, 0, 0); // masthead lamp (glows at night)
  sail(b, [0.03, 0.78, 0.22], [0.03, 2.95, 0.24], [0.03, 0.72, -1.25], SAIL);
  sail(b, [0.03, 0.62, 1.5], [0.03, 2.55, 0.36], [0.03, 0.76, 0.42], SAIL);
  // A pennant at the top in the hull's colour.
  sail(b, [0.03, 3.05, 0.27], [0.03, 2.9, 0.27], [0.03, 2.97, -0.15], WHITE, 1);
  return b.build();
}

function fishingBoatGeometry(): BufferGeometry {
  const b = new Builder();
  hull(b, 3.8, 1.5);
  // Wheelhouse: white walls, a window band that glows at night, a red roof.
  const P4 = Math.PI / 4;
  prism(b, 4, 0.58, 0.55, 0.42, 0.85, FRAME, 0, noSway, 0, -0.35, P4);
  prism(b, 4, 0.555, 0.54, 0.85, 1.08, GLASS, -1, noSway, 0, -0.35, P4, false);
  prism(b, 4, 0.54, 0.54, 1.08, 1.14, FRAME, 0, noSway, 0, -0.35, P4, false);
  prism(b, 4, 0.68, 0.64, 1.14, 1.24, ROOF_RED, 0, noSway, 0, -0.35, P4);
  // A short mast with a lamp, and a boom with a little net reel at the stern.
  prism(b, 5, 0.04, 0.03, 0.42, 2.3, WOOD, 0, noSway, 0, 0.75);
  blob(b, 0, 2.34, 0.75, 0.07, 0.07, 0.07, WHITE, -1, noSway, 9, 0, 0);
  prism(b, 6, 0.16, 0.16, 0.42, 0.62, WOOD, 0, noSway, 0, -1.25);
  return b.build();
}

/** Foam wake: two arms spreading back from the stern and a churned centre line. */
function wakeGeometry(): BufferGeometry {
  const pos: number[] = [];
  const sv: number[] = [];
  const ev: number[] = [];
  const S = 12;
  const strip = (x0: number, dx: number, z0: number, len: number, w0: number, w1: number) => {
    for (let i = 0; i < S; i++) {
      const s0 = i / S, s1 = (i + 1) / S;
      const p = (s: number, e: number) => {
        const w = w0 + (w1 - w0) * s;
        pos.push(x0 + dx * s + e * w * 0.5, 0, z0 - len * s);
        sv.push(s);
        ev.push(e);
      };
      p(s0, -1); p(s1, -1); p(s1, 1);
      p(s0, -1); p(s1, 1); p(s0, 1);
    }
  };
  strip(-0.45, -2.6, -1.0, 9, 0.35, 0.9);
  strip(0.45, 2.6, -1.0, 9, 0.35, 0.9);
  strip(0, 0, -1.2, 5.5, 0.7, 1.1);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aS', new BufferAttribute(new Float32Array(sv), 1));
  g.setAttribute('aE', new BufferAttribute(new Float32Array(ev), 1));
  return g;
}

const HULLS = [new Color('#D9483B'), new Color('#3D9CA8'), new Color('#F2CC5B'), new Color('#5B6B8C'), new Color('#E07A5F')];

export interface Boats {
  readonly meshes: InstancedMesh[];
  reveal(start: number): void;
  update(ctx: LBContext): void;
  dispose(): void;
}

const _m = new Matrix4();
const _d = { x: 0, y: 0, z: 0 };
const _d2 = { x: 0, y: 0, z: 0 };

export function createBoats(ctx: LBContext, mat: ToonMaterial, loops: BoatLoop[]): Boats | null {
  if (!loops.length) return null;
  const sailLoops = loops.filter((l) => l.kind === 'sail');
  const fishLoops = loops.filter((l) => l.kind === 'fish');
  const geos: BufferGeometry[] = [];
  const meshes: InstancedMesh[] = [];
  const sets: Array<{ mesh: InstancedMesh; loops: BoatLoop[] }> = [];
  const add = (geo: BufferGeometry, list: BoatLoop[], name: string) => {
    if (!list.length) return;
    geos.push(geo);
    const mesh = ctx.toon.instanced(geo, mat, list.length, { cast: true, receive: true });
    mesh.name = name;
    mesh.frustumCulled = false;
    list.forEach((_, i) => mesh.setColorAt(i, HULLS[(i * 2 + (name === 'nature:fishing' ? 1 : 0)) % HULLS.length]));
    geo.setAttribute('aReveal', new InstancedBufferAttribute(new Float32Array(list.length).fill(1e6), 1));
    ctx.scene.add(mesh);
    meshes.push(mesh);
    sets.push({ mesh, loops: list });
  };
  add(sailboatGeometry(), sailLoops, 'nature:sailboats');
  add(fishingBoatGeometry(), fishLoops, 'nature:fishing');

  const swell = ctx.params.number('ocean.swell', { label: 'ocean swell amplitude (m)', min: 0, max: 0.6, value: 0.22 });
  const uStart = { value: 1e6 };
  const uSwell = { value: swell.value };
  const wakeGeo = wakeGeometry();
  geos.push(wakeGeo);
  const wakeMat = new ShaderMaterial({
    name: 'boat wake',
    uniforms: { ...ctx.uniforms, uStart, uSwell },
    vertexShader: /* glsl */ `
${LB_COMMON_GLSL}
${SWELL_GLSL}
uniform float uSwell;
attribute float aS;
attribute float aE;
varying float vS;
varying float vE;
varying vec3 vW;
void main() {
  vS = aS;
  vE = aE;
  vec3 w = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
  float sw = uSwell * (1.0 - smoothstep(50.0, 160.0, distance(w, lbCamPos))) * 0.46 * lbSwellW(w, lbTime);
  w = normalize(w) * (${R.toFixed(1)} + sw + 0.05);
  vW = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`,
    fragmentShader: /* glsl */ `
${LB_COMMON_GLSL}
uniform float uStart;
varying float vS;
varying float vE;
varying vec3 vW;
void main() {
  float on = clamp((lbRevealClock - uStart) / 1.2, 0.0, 1.0) * (1.0 - smoothstep(50.0, 110.0, distance(vW, lbCamPos)));
  float edge = 1.0 - smoothstep(0.35, 1.0, abs(vE));
  float foam = 0.55 + 0.45 * sin(vS * 26.0 - lbTime * 3.0 + vE * 2.0);
  float a = pow(1.0 - vS, 1.4) * edge * foam * 0.75 * on;
  if (a < 0.004) discard;
  vec3 c = mix(vec3(0.97, 0.98, 1.0), vec3(0.13, 0.16, 0.3), lbNightAt(vW));
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
  });
  const wake = new InstancedMesh(wakeGeo, wakeMat, loops.length);
  wake.name = 'nature:wakes';
  wake.layers.set(LAYER_NO_INK);
  wake.frustumCulled = false;
  wake.renderOrder = 2;
  ctx.scene.add(wake);

  let lastT = NaN;
  let lastCam = NaN;
  return {
    meshes,
    reveal(start: number) {
      uStart.value = start + 0.3;
      for (const { mesh, loops: list } of sets) {
        const attr = mesh.geometry.getAttribute('aReveal') as InstancedBufferAttribute;
        for (let i = 0; i < list.length; i++) attr.setX(i, start + 0.25 + 0.12 * i);
        attr.needsUpdate = true;
      }
    },
    update(ctx: LBContext) {
      const t = ctx.time.render;
      const eye = ctx.view.eye;
      const camKey = eye.x * 1.3 + eye.y * 2.1 + eye.z;
      if (t === lastT && camKey === lastCam) return;
      lastT = t;
      lastCam = camKey;
      uSwell.value = swell.value;
      let wi = 0;
      for (let si = 0; si < sets.length; si++) {
        const mesh = sets[si].mesh, list = sets[si].loops;
        for (let i = 0; i < list.length; i++) {
          const l = list[i];
          const th = l.phase + l.w * t;
          const up = loopDir(l, th, _d);
          // Heading: the loop's tangent (sense of travel), from a point a little further on.
          const ahead = loopDir(l, th + Math.sign(l.w) * 0.05, _d2);
          let hx = ahead.x - up.x, hy = ahead.y - up.y, hz = ahead.z - up.z;
          const hu = hx * up.x + hy * up.y + hz * up.z;
          hx -= up.x * hu;
          hy -= up.y * hu;
          hz -= up.z * hu;
          const hl = Math.hypot(hx, hy, hz) || 1;
          hx /= hl;
          hy /= hl;
          hz /= hl;
          // right = up × heading (composeUp's local +X, so its local +Z, the bow, is the heading).
          const rx = up.y * hz - up.z * hy, ry = up.z * hx - up.x * hz, rz = up.x * hy - up.y * hx;
          const px = up.x * R, py = up.y * R, pz = up.z * R;
          const fade = swellFade(Math.hypot(px - eye.x, py - eye.y, pz - eye.z));
          const amp = swell.value * fade * 0.46;
          const h = amp * swellW(px, py, pz, t);
          // Pitch and roll from the swell's slope along and across the hull (finite differences).
          const pitch = amp * (swellW(px + hx * 1.4, py + hy * 1.4, pz + hz * 1.4, t) - swellW(px - hx * 1.4, py - hy * 1.4, pz - hz * 1.4, t)) / 2.8;
          const roll = amp * (swellW(px + rx, py + ry, pz + rz, t) - swellW(px - rx, py - ry, pz - rz, t)) / 2 + 0.03 * Math.sin(t * 1.3 + i);
          let ux = up.x - hx * pitch - rx * roll, uy = up.y - hy * pitch - ry * roll, uz = up.z - hz * pitch - rz * roll;
          const ul = Math.hypot(ux, uy, uz);
          ux /= ul;
          uy /= ul;
          uz /= ul;
          const r = R + h;
          // Local +X along right (with the tilted up), so the bow (+Z) points along the heading.
          composeUp(_m, up.x * r, up.y * r, up.z * r, ux, uy, uz, yawAlong(ux, uy, uz, rx, ry, rz), 1, 1);
          mesh.setMatrixAt(i, _m);
          // The wake lies flat on the sea (its shader drapes it over the swell).
          composeUp(_m, px, py, pz, up.x, up.y, up.z, yawAlong(up.x, up.y, up.z, rx, ry, rz), 1, 1);
          wake.setMatrixAt(wi++, _m);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
      wake.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      for (const m of meshes) {
        m.removeFromParent();
        m.dispose();
      }
      wake.removeFromParent();
      wake.dispose();
      wakeMat.dispose();
      for (const g of geos) g.dispose();
    },
  };
}
