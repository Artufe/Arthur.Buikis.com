// Ghost crabs on the damp sand between the swash and the wrack line: pale, sand-coloured, eyes on
// stalks, legs splayed. They sit still, then dart sideways in quick bursts, and bolt away from a
// walker who comes close. A tiny CPU sim (16 crabs, typed arrays, zero allocation) writes one
// instance buffer; the gait is animated in the vertex stage.

import { BoxGeometry, BufferAttribute, BufferGeometry, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshStandardNodeMaterial, Quaternion, SphereGeometry, Vector3 } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { GLContext, TSLNode } from '../core/contracts';
import { shoreX } from '../world/layout';

const { Fn, attribute, cos, float, max, mix, normalize, sin, smoothstep, vec3, vec4 } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { positionLocal, positionPrevious, normalLocal } = TSL as unknown as Record<string, TSLNode>;

export const CRAB_COUNT = 16;
/** Terrain heights (m) of the band they live in: above the swash, below the wrack line. */
const BAND_LO = 0.6;
const BAND_HI = 1.35;

/** Append a transformed box/sphere to the merged arrays with a leg id and a leg-segment weight. */
function merge(parts: Array<{ g: BufferGeometry; leg: number; seg: number; tone: number }>): BufferGeometry {
  let n = 0;
  let ni = 0;
  for (const p of parts) {
    n += p.g.getAttribute('position').count;
    ni += p.g.index!.count;
  }
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const leg = new Float32Array(n * 2);
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const P = p.g.getAttribute('position').array as Float32Array;
    const N = p.g.getAttribute('normal').array as Float32Array;
    const I = p.g.index!.array;
    const c = P.length / 3;
    pos.set(P, vo * 3);
    nrm.set(N, vo * 3);
    for (let i = 0; i < c; i++) {
      leg[(vo + i) * 2] = p.leg;
      leg[(vo + i) * 2 + 1] = p.seg + p.tone * 10;
    }
    for (let i = 0; i < I.length; i++) idx[io + i] = I[i] + vo;
    vo += c;
    io += I.length;
    p.g.dispose();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('legInfo', new BufferAttribute(leg, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

type V3 = [number, number, number];
const _q = new Quaternion();
const _d = new Vector3();
const _x = new Vector3(1, 0, 0);
/** A thin box from p0 to p1 (boot only). */
function segment(p0: V3, p1: V3, t: number): BufferGeometry {
  _d.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const len = _d.length();
  const g = new BoxGeometry(len, t, t);
  g.translate(len / 2, 0, 0);
  _q.setFromUnitVectors(_x, _d.normalize());
  g.applyQuaternion(_q);
  g.translate(p0[0], p0[1], p0[2]);
  return g;
}

/** Local frame: +X forward (eyes), +Z to the crab's left, +Y up; metres. Carapace ≈ 5 cm. */
function crabGeometry(): BufferGeometry {
  const parts: Array<{ g: BufferGeometry; leg: number; seg: number; tone: number }> = [];
  const body = new SphereGeometry(1, 10, 6);
  // squarish carapace, wider than long, flat-topped
  body.scale(0.019, 0.011, 0.026);
  body.translate(0, 0.017, 0);
  parts.push({ g: body, leg: 0, seg: 0, tone: 0 });
  // Legs: 4 per side, two segments each (femur up and out to the knee, then down to the sand).
  for (const side of [1, -1]) {
    for (let k = 0; k < 4; k++) {
      const legId = 1 + k + (side > 0 ? 0 : 4);
      const splay = (1.5 - k) * 0.38; // front legs reach forward, back legs back
      const ox = Math.sin(splay);
      const oz = side * Math.cos(splay);
      // short, stout and sharply bent: knees high beside the shell, feet tucked in close
      const hip: V3 = [0.009 - k * 0.0065, 0.014, side * 0.02];
      const knee: V3 = [hip[0] + ox * 0.017, 0.03, hip[2] + oz * 0.017];
      const foot: V3 = [knee[0] + ox * 0.013, 0.0, knee[2] + oz * 0.013];
      parts.push({ g: segment(hip, knee, 0.0058), leg: legId, seg: 0.45, tone: 0 });
      parts.push({ g: segment(knee, foot, 0.0042), leg: legId, seg: 1, tone: 0 });
    }
  }
  // Claws: one big, one small, folded in front.
  for (const [side, s] of [
    [1, 1.3],
    [-1, 0.8],
  ] as const) {
    const c = new BoxGeometry(0.014 * s, 0.008 * s, 0.006 * s);
    c.translate(0.028, 0.012, side * 0.012);
    parts.push({ g: c, leg: 0, seg: 0, tone: 0.2 });
  }
  // Eye stalks with dark tips.
  for (const side of [1, -1]) {
    const st = new BoxGeometry(0.0025, 0.014, 0.0025);
    st.translate(0.02, 0.028, side * 0.009);
    parts.push({ g: st, leg: 0, seg: 0, tone: 0 });
    const eye = new SphereGeometry(0.0028, 6, 4);
    eye.translate(0.02, 0.036, side * 0.009);
    parts.push({ g: eye, leg: 0, seg: 0, tone: 0.9 });
  }
  return merge(parts);
}

export interface Crabs {
  mesh: Mesh;
  update(ctx: GLContext): void;
  dispose(): void;
}

export function createCrabs(ctx: GLContext, time: TSLNode): Crabs {
  const base = crabGeometry();
  const geo = new InstancedBufferGeometry();
  for (const k in base.attributes) geo.setAttribute(k, base.attributes[k]);
  geo.setIndex(base.index);
  geo.instanceCount = CRAB_COUNT;
  // Per crab: (x, y, z, heading) and (gait phase, gait amount, size, 0).
  const iA = new Float32Array(CRAB_COUNT * 4);
  const iB = new Float32Array(CRAB_COUNT * 4);
  const aA = new InstancedBufferAttribute(iA, 4);
  const aB = new InstancedBufferAttribute(iB, 4);
  aA.setUsage(DynamicDrawUsage);
  aB.setUsage(DynamicDrawUsage);
  geo.setAttribute('iCrab', aA);
  geo.setAttribute('iCrabB', aB);

  // Sim state (doubles in typed arrays: no boxing).
  const S = new Float64Array(CRAB_COUNT * 11); // x, z, heading, mode, timer, dirX, dirZ, speed, gait, remaining, ground y
  const rng = new Uint32Array([2463534242]);
  const rnd = () => {
    let x = rng[0];
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    rng[0] = x;
    return (x >>> 0) / 4294967296;
  };
  const height = ctx.services.terrain.height;
  // Colonies along the beach (z), placed in the band.
  const COLONY_Z = [-34, -8, 6, 18, 30];
  for (let i = 0; i < CRAB_COUNT; i++) {
    const zc = COLONY_Z[i % COLONY_Z.length] + (rnd() - 0.5) * 14;
    let x = shoreX(zc) + 8;
    // walk up/down the beach face to the band
    for (let k = 0; k < 40; k++) {
      const h = height(x, zc);
      if (h < BAND_LO) x += 0.4;
      else if (h > BAND_HI) x -= 0.4;
      else break;
    }
    const o = i * 11;
    S[o] = x + (rnd() - 0.5) * 1.2;
    S[o + 1] = zc;
    S[o + 2] = rnd() * Math.PI * 2;
    S[o + 3] = 0;
    S[o + 4] = rnd() * 4;
    iB[i * 4 + 2] = 0.8 + rnd() * 0.45;
  }

  const P = (i: number) => i * 11;
  // Dev-only handle for review shots (crab positions).
  if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') (window as unknown as { __crabs?: Float64Array }).__crabs = S;
  const writeInstances = () => {
    for (let i = 0; i < CRAB_COUNT; i++) {
      const o = P(i);
      const x = S[o];
      const z = S[o + 1];
      iA[i * 4] = x;
      iA[i * 4 + 1] = S[o + 10] - 0.004;
      iA[i * 4 + 2] = z;
      iA[i * 4 + 3] = S[o + 2];
      iB[i * 4] = S[o + 8];
      iB[i * 4 + 1] = S[o + 3] > 0.5 ? Math.min(1, S[o + 7] / 2) : 0;
    }
    aA.needsUpdate = true;
    aB.needsUpdate = true;
  };
  for (let i = 0; i < CRAB_COUNT; i++) S[P(i) + 10] = height(S[P(i)], S[P(i) + 1]);
  writeInstances();

  const inBand = (x: number, z: number) => {
    const h = height(x, z);
    return h > BAND_LO && h < BAND_HI;
  };

  // Vertex stage: gait on the legs (they swing along the crab's sideways travel and lift).
  const mat = new MeshStandardNodeMaterial();
  mat.name = 'vfx.crabs';
  const info = attribute('legInfo', 'vec2');
  const place = (withNormal: boolean) => {
    const A = attribute('iCrab', 'vec4');
    const B = attribute('iCrabB', 'vec4');
    const legId = info.x;
    const seg = info.y.mod(10);
    const isLeg = legId.greaterThan(0.5);
    // alternate tetrapod-ish phases: odd/even legs and the two sides in antiphase
    const ph = B.x.add(legId.mul(1.9));
    const swing = sin(ph).mul(0.009).mul(B.y).mul(seg);
    const lift = max(cos(ph), 0).mul(0.006).mul(B.y).mul(seg);
    const lp = positionLocal.add(isLeg.select(vec3(0, lift, swing), vec3(0, 0, 0))).mul(B.z);
    // idle crabs breathe their eye stalks a little
    const ch = cos(A.w);
    const sh = sin(A.w);
    const world = vec3(A.x.add(lp.x.mul(ch)).sub(lp.z.mul(sh)), A.y.add(lp.y), A.z.add(lp.x.mul(sh)).add(lp.z.mul(ch)));
    if (withNormal) {
      const n = normalLocal;
      normalLocal.assign(normalize(vec3(n.x.mul(ch).sub(n.z.mul(sh)), n.y, n.x.mul(sh).add(n.z.mul(ch)))));
    }
    return world;
  };
  mat.positionNode = Fn(() => {
    const w = place(true);
    // Instances move a few cm per frame at most; the static-camera velocity is what TRAA needs.
    positionPrevious.assign(w);
    return w;
  })();
  void time;
  const tone = info.y.div(10).floor().div(10);
  const shell = vec3(0.66, 0.58, 0.46);
  const col = mix(mix(shell, vec3(0.78, 0.7, 0.56), smoothstep(0.1, 0.3, tone)), vec3(0.03, 0.028, 0.025), smoothstep(0.6, 0.85, tone));
  mat.colorNode = vec4(col, 1);
  mat.roughnessNode = float(0.45);

  const mesh = new Mesh(geo, mat);
  mesh.name = 'vfx.crabs';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;

  return {
    mesh,
    update(c: GLContext) {
      const dt = c.time.dt;
      if (dt <= 0) return;
      const cam = c.camera.position;
      for (let i = 0; i < CRAB_COUNT; i++) {
        const o = P(i);
        const dxc = S[o] - cam.x;
        const dzc = S[o + 1] - cam.z;
        const d2 = dxc * dxc + dzc * dzc;
        const threatened = d2 < 3.2 * 3.2 && cam.y - S[o + 10] < 2.5;
        if (S[o + 3] < 0.5) {
          // idle: wait, or bolt when a walker comes close
          S[o + 4] -= dt;
          if (threatened || S[o + 4] <= 0) {
            let dx = 0;
            let dz = 0;
            for (let k = 0; k < 4; k++) {
              const a = rnd() * Math.PI * 2;
              dx = Math.cos(a);
              dz = Math.sin(a);
              if (threatened) {
                const l = Math.sqrt(d2) + 1e-3;
                dx = dx * 0.4 + (dxc / l) * 0.9;
                dz = dz * 0.4 + (dzc / l) * 0.9;
                const l2 = Math.sqrt(dx * dx + dz * dz);
                dx /= l2;
                dz /= l2;
              }
              if (inBand(S[o] + dx * 1.5, S[o + 1] + dz * 1.5)) break;
            }
            S[o + 3] = 1;
            S[o + 5] = dx;
            S[o + 6] = dz;
            S[o + 7] = threatened ? 3 + rnd() * 1.2 : 1.4 + rnd() * 1.2;
            S[o + 9] = threatened ? 2.5 + rnd() * 2 : 0.4 + rnd() * 1.8;
            // They run sideways: face perpendicular to the run (either side).
            S[o + 2] = Math.atan2(dz, dx) + (rnd() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
          }
        } else {
          const step = Math.min(S[o + 7] * dt, S[o + 9]);
          const nx = S[o] + S[o + 5] * step;
          const nz = S[o + 1] + S[o + 6] * step;
          if (inBand(nx, nz)) {
            S[o] = nx;
            S[o + 1] = nz;
            S[o + 10] = height(nx, nz);
          } else {
            S[o + 9] = 0;
          }
          S[o + 9] -= step;
          S[o + 8] += dt * 38;
          if (S[o + 8] > 6283.18) S[o + 8] -= 6283.18;
          if (S[o + 9] <= 0) {
            S[o + 3] = 0;
            S[o + 4] = 1 + rnd() * 5;
          }
        }
      }
      writeInstances();
    },
    dispose() {
      base.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
