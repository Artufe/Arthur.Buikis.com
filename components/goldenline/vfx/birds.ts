// Seabirds gliding along the break: a few gulls on long, lazy loops over the reef, banking into
// their turns, with the odd burst of wing beats. Real geometry (a spindle body, M-shaped gull
// wings with a dihedral, a tail), one instanced draw, animated entirely in the vertex stage from
// the simulation clock, so the CPU cost is one uniform write per frame.

import { BufferAttribute, BufferGeometry, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { AtmosphereService, TSLNode } from '../core/contracts';
import { REEF } from '../world/layout';

const { Fn, attribute, cos, float, max, mix, normalize, pow, sin, smoothstep, vec3, vec4, atan, abs, sign, clamp, dot, length } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { cameraPosition, positionLocal, positionPrevious, normalLocal, positionWorld } = TSL as unknown as Record<string, TSLNode>;

export const BIRD_COUNT = 9;

/** Gull, local frame: +X forward, +Y up, ±Z the wings. Metres, span ≈ 1.25 m. */
function gullGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const span: number[] = []; // signed span coordinate (m) for the flap
  const tone: number[] = []; // 0 belly/underwing white, 0.5 back grey, 1 black tip
  const idx: number[] = [];
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, t: number) => {
    pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.push(nx / l, ny / l, nz / l);
    span.push(Math.abs(z) < 0.045 ? 0 : z);
    tone.push(t);
    return pos.length / 3 - 1;
  };
  // Body: a spindle along X, 10 rings × 8 sides.
  const RINGS = 10;
  const SIDES = 8;
  const L0 = -0.26;
  const L1 = 0.2;
  const ring0 = pos.length / 3;
  for (let r = 0; r < RINGS; r++) {
    const u = r / (RINGS - 1);
    const x = L0 + (L1 - L0) * u;
    // plump chest forward of centre, a small head, tapering tail
    const rad = 0.052 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.08)), 0.7) * (u > 0.82 ? 0.75 : 1) + 0.004;
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      const cy = Math.cos(a);
      const cz = Math.sin(a);
      vert(x, cy * rad * 0.9, cz * rad, 0, cy, cz, cy > 0.2 ? 0.5 : 0);
    }
  }
  for (let r = 0; r < RINGS - 1; r++)
    for (let s = 0; s < SIDES; s++) {
      const a = ring0 + r * SIDES + s;
      const b = ring0 + r * SIDES + ((s + 1) % SIDES);
      const c = a + SIDES;
      const d = b + SIDES;
      idx.push(a, c, b, b, c, d);
    }
  // Wings: leading/trailing edge polylines from root to tip, strip between them.
  // (span z, leading x, trailing x, height y) — raised inner wing, drooped swept outer (gull "M").
  const W: Array<[number, number, number, number]> = [
    [0.03, 0.06, -0.12, 0.012],
    [0.16, 0.075, -0.13, 0.05],
    [0.3, 0.07, -0.1, 0.075],
    [0.42, 0.02, -0.09, 0.06],
    [0.54, -0.05, -0.12, 0.03],
    [0.63, -0.12, -0.15, 0.005],
  ];
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i < W.length; i++) {
      const [z, xl, xt, y] = W[i];
      const t = i >= W.length - 2 ? 1 : 0.5;
      vert(xl, y + 0.004, z * side, 0, 1, 0, t);
      vert(xt, y, z * side, 0, 1, 0, t);
    }
    for (let i = 0; i < W.length - 1; i++) {
      const a = base + i * 2;
      if (side > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  // Tail: a short fan.
  const tb = pos.length / 3;
  vert(-0.2, 0.01, 0.035, 0, 1, 0, 0.5);
  vert(-0.2, 0.01, -0.035, 0, 1, 0, 0.5);
  vert(-0.33, 0.0, 0.06, 0, 1, 0, 0.5);
  vert(-0.33, 0.0, -0.06, 0, 1, 0, 0.5);
  idx.push(tb, tb + 2, tb + 1, tb + 1, tb + 2, tb + 3);

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('span', new BufferAttribute(new Float32Array(span), 1));
  g.setAttribute('tone', new BufferAttribute(new Float32Array(tone), 1));
  g.setIndex(idx);
  return g;
}

export interface Birds {
  mesh: Mesh;
  dispose(): void;
}

/** `time` = the simulation clock (float node). */
export function createBirds(atmos: AtmosphereService, time: TSLNode, seed = 7): Birds {
  const base = gullGeometry();
  const geo = new InstancedBufferGeometry();
  for (const k in base.attributes) geo.setAttribute(k, base.attributes[k]);
  geo.setIndex(base.index);
  geo.instanceCount = BIRD_COUNT;
  // Per bird: (phase, angular speed rad/s, loop half-length m, loop half-width m) and
  // (height m, seaward offset m, wingbeat seed, size).
  const a0 = new Float32Array(BIRD_COUNT * 4);
  const a1 = new Float32Array(BIRD_COUNT * 4);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < BIRD_COUNT; i++) {
    // Two loose groups on the same loops, and a couple of loners going the other way.
    const group = i < 4 ? 0 : i < 7 ? 1 : 2;
    const dir = group === 2 ? -1 : 1;
    a0[i * 4] = (group === 0 ? 0.2 : group === 1 ? 2.6 : 4.4) + (rnd() - 0.5) * 0.22;
    a0[i * 4 + 1] = dir * (0.1 + rnd() * 0.025);
    a0[i * 4 + 2] = 70 + rnd() * 30;
    a0[i * 4 + 3] = 14 + rnd() * 12;
    a1[i * 4] = 5 + rnd() * 9;
    a1[i * 4 + 1] = -8 + rnd() * 22;
    a1[i * 4 + 2] = rnd() * 100;
    a1[i * 4 + 3] = 0.85 + rnd() * 0.3;
  }
  geo.setAttribute('iBirdA', new InstancedBufferAttribute(a0, 4));
  geo.setAttribute('iBirdB', new InstancedBufferAttribute(a1, 4));

  // Loop frame: along the reef edge (u) and across it (v, shoreward).
  const ux = REEF.b.x - REEF.a.x;
  const uz = REEF.b.z - REEF.a.z;
  const ul = Math.hypot(ux, uz);
  const U = [ux / ul, uz / ul];
  const Vv = [U[1], -U[0]];
  const C = [(REEF.a.x + REEF.b.x) / 2 - 6, (REEF.a.z + REEF.b.z) / 2];

  /** World position, heading (unit xz) and bank of bird at time t. */
  const flight = (t: TSLNode) => {
    const A = attribute('iBirdA', 'vec4');
    const B = attribute('iBirdB', 'vec4');
    const th = A.x.add(A.y.mul(t));
    const ca = cos(th);
    const sa = sin(th);
    // a slow meander on top of the ellipse keeps the loops from looking mechanical
    const wob = sin(th.mul(3).add(B.z)).mul(0.12);
    const lx = A.z.mul(ca);
    const ly = A.w.mul(sa.add(wob)).add(B.y);
    const x = float(C[0]).add(float(U[0]).mul(lx)).add(float(Vv[0]).mul(ly));
    const z = float(C[1]).add(float(U[1]).mul(lx)).add(float(Vv[1]).mul(ly));
    const y = B.x.add(sin(t.mul(0.23).add(B.z)).mul(1.6));
    // velocity along the loop
    const dlx = A.z.mul(sa).negate().mul(A.y);
    const dly = A.w.mul(ca).mul(A.y);
    const vx = float(U[0]).mul(dlx).add(float(Vv[0]).mul(dly));
    const vz = float(U[1]).mul(dlx).add(float(Vv[1]).mul(dly));
    const speed = max(length(vec3(vx, 0, vz)), 0.1);
    // lateral acceleration → coordinated-turn bank
    const ddlx = A.z.mul(ca).negate().mul(A.y.mul(A.y));
    const ddly = A.w.mul(sa).negate().mul(A.y.mul(A.y));
    const cross = dlx.mul(ddly).sub(dly.mul(ddlx)).div(speed);
    const bank = atan(cross.div(9.81)).mul(1.3);
    return { p: vec3(x, y, z), hx: vx.div(speed), hz: vz.div(speed), bank, B };
  };

  const place = (t: TSLNode, local: TSLNode, span: TSLNode, withNormal: boolean) => {
    const f = flight(t);
    // Wing beats in bursts; gliding otherwise (wings held slightly up).
    const burst = smoothstep(0.55, 0.85, sin(t.mul(0.31).add(f.B.z)));
    const beat = sin(t.mul(8.5).add(f.B.z.mul(3))).mul(0.55).mul(burst).add(sin(t.mul(0.9).add(f.B.z)).mul(0.04));
    const sAbs = abs(span);
    const ang = beat.mul(smoothstep(0.03, 0.3, sAbs));
    const cs = cos(ang);
    const sn = sin(ang);
    // rotate (|z|, y) about the body axis
    const zz = sAbs.mul(cs).sub(local.y.mul(sn));
    const yy = sAbs.mul(sn).add(local.y.mul(cs));
    const wing = sAbs.greaterThan(0.001);
    const lz = wing.select(sign(span).mul(zz), local.z);
    const ly = wing.select(yy, local.y);
    const lp = vec3(local.x, ly, lz).mul(f.B.w);
    // bank about the forward axis, then yaw to the heading
    const cb = cos(f.bank);
    const sb = sin(f.bank);
    const by = lp.y.mul(cb).sub(lp.z.mul(sb));
    const bz = lp.y.mul(sb).add(lp.z.mul(cb));
    // forward (hx, hz); right-hand side = (-hz, hx) mapped to local +Z
    const wx = lp.x.mul(f.hx).sub(bz.mul(f.hz));
    const wz = lp.x.mul(f.hz).add(bz.mul(f.hx));
    const world = f.p.add(vec3(wx, by, wz));
    if (!withNormal) return world;
    const n = normalLocal;
    const nby = n.y.mul(cb).sub(n.z.mul(sb));
    const nbz = n.y.mul(sb).add(n.z.mul(cb));
    normalLocal.assign(normalize(vec3(n.x.mul(f.hx).sub(nbz.mul(f.hz)), nby, n.x.mul(f.hz).add(nbz.mul(f.hx)))));
    return world;
  };

  const mat = new MeshStandardNodeMaterial({ side: DoubleSide });
  mat.name = 'vfx.birds';
  const span = attribute('span', 'float');
  mat.positionNode = Fn(() => {
    const local = positionLocal.toVar();
    positionPrevious.assign(place(time.sub(1 / 60), local, span, false));
    return place(time, local, span, true);
  })();
  const tone = attribute('tone', 'float');
  const col = mix(mix(vec3(0.82, 0.81, 0.78), vec3(0.42, 0.44, 0.47), smoothstep(0.2, 0.6, tone)), vec3(0.05, 0.05, 0.055), smoothstep(0.75, 0.95, tone));
  mat.colorNode = vec4(col, 1);
  mat.roughnessNode = float(0.7);
  // Backlit feathers glow at the edges: thin wings pass the low sun through.
  const V = normalize(positionWorld.sub(cameraPosition));
  const fwd = pow(max(dot(V, atmos.sunDirNode), 0), 6);
  mat.emissiveNode = vec3(atmos.sunColorNode).mul(col.add(0.15)).mul(fwd).mul(clamp(float(1).sub(tone), 0.1, 1)).mul(0.22);
  const mesh = new Mesh(geo, mat);
  mesh.name = 'vfx.birds';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return {
    mesh,
    dispose() {
      base.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
