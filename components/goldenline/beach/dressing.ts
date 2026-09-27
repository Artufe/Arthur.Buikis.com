// Beach dressing: the thin instances at the high-tide mark (a line of
// dried seaweed, shells, coral rubble). All instanced; the small props re-seat themselves on the
// rendered ground on the GPU (their CPU height comes from the analytic base, which differs from
// the B-spline surface by a few millimetres, enough to make a 3 cm shell float or vanish).

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  Mesh,
  Matrix4,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  attribute,
  float,
  mix,
  mx_noise_float,
  positionLocal,
  positionPrevious,
  positionWorld,
  sin,
  smoothstep,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { GLContext, TSLNode } from '../core/contracts';
import { WIND, shoreX } from '../world/layout';
import { ChunkedInstances, type PropInstance } from './chunks';
import type { Ground } from './ground';
import { rng, range, type Rand } from './rng';

type Geo = { pos: number[]; nor: number[]; uv: number[]; idx: number[] };
const newGeo = (): Geo => ({ pos: [], nor: [], uv: [], idx: [] });

function toBuffer(g: Geo, computeNormals: boolean) {
  const b = new BufferGeometry();
  b.setAttribute('position', new BufferAttribute(new Float32Array(g.pos), 3));
  b.setAttribute('normal', new BufferAttribute(new Float32Array(g.nor), 3));
  b.setAttribute('uv', new BufferAttribute(new Float32Array(g.uv), 2));
  b.setIndex(new BufferAttribute(new Uint16Array(g.idx), 1));
  if (computeNormals) b.computeVertexNormals();
  b.computeBoundingSphere();
  return b;
}

// ── Shells, rubble, seaweed ──

/** A cockle: a ribbed, domed valve lying convex side up. ~1 unit across (scaled per instance). */
function cockle() {
  const g = newGeo();
  const R = 16;
  const A = 8;
  for (let a = 0; a <= A; a++) {
    const t = a / A; // 0 umbo (top) … 1 rim
    for (let i = 0; i <= R; i++) {
      const ph = (i / R) * Math.PI * 2;
      const rib = 1 + 0.06 * Math.cos(ph * 9) * t;
      const rr = Math.sin(t * Math.PI * 0.5) * 0.5 * rib;
      const y = Math.cos(t * Math.PI * 0.5) * 0.28 * rib;
      g.pos.push(Math.cos(ph) * rr * 1.1, y, Math.sin(ph) * rr * 0.95);
      g.nor.push(0, 1, 0);
      g.uv.push(i / R, t);
    }
  }
  for (let a = 0; a < A; a++) {
    for (let i = 0; i < R; i++) {
      const p = a * (R + 1) + i;
      g.idx.push(p, p + R + 1, p + 1, p + 1, p + R + 1, p + R + 2);
    }
  }
  return toBuffer(g, true);
}

/** A turban/cone shell: a spiralled cone lying on its side. */
function cone() {
  const g = newGeo();
  const R = 10;
  const L = 14;
  for (let l = 0; l <= L; l++) {
    const t = l / L;
    const rad = 0.28 * Math.pow(t, 0.8) * (1 + 0.1 * Math.sin(t * 30));
    for (let i = 0; i <= R; i++) {
      const ph = (i / R) * Math.PI * 2;
      g.pos.push(t - 0.5, 0.25 + Math.sin(ph) * rad, Math.cos(ph) * rad);
      g.nor.push(0, 1, 0);
      g.uv.push(i / R, t);
    }
  }
  for (let l = 0; l < L; l++) {
    for (let i = 0; i < R; i++) {
      const p = l * (R + 1) + i;
      g.idx.push(p, p + 1, p + R + 1, p + 1, p + R + 2, p + R + 1);
    }
  }
  return toBuffer(g, true);
}

/** Staghorn coral rubble: a short branching fragment of bleached tubes. */
function rubble(r: Rand) {
  const g = newGeo();
  const R = 6;
  const tube = (x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, len: number, r0: number) => {
    const base = g.pos.length / 3;
    const S = 5;
    const ax = new Vector3(dx, dy, dz).normalize();
    const t1 = new Vector3().crossVectors(ax, new Vector3(0, 1, 0.2)).normalize();
    const t2 = new Vector3().crossVectors(ax, t1).normalize();
    for (let s = 0; s <= S; s++) {
      const t = s / S;
      const rad = r0 * (1 - 0.45 * t) * (1 + 0.15 * Math.sin(s * 2.1));
      for (let i = 0; i <= R; i++) {
        const ph = (i / R) * Math.PI * 2;
        const nx = t1.x * Math.cos(ph) + t2.x * Math.sin(ph);
        const ny = t1.y * Math.cos(ph) + t2.y * Math.sin(ph);
        const nz = t1.z * Math.cos(ph) + t2.z * Math.sin(ph);
        g.pos.push(x0 + ax.x * len * t + nx * rad, y0 + ax.y * len * t + ny * rad, z0 + ax.z * len * t + nz * rad);
        g.nor.push(nx, ny, nz);
        g.uv.push(i / R, t);
      }
    }
    for (let s = 0; s < S; s++) {
      for (let i = 0; i < R; i++) {
        const p = base + s * (R + 1) + i;
        g.idx.push(p, p + R + 1, p + 1, p + 1, p + R + 1, p + R + 2);
      }
    }
  };
  tube(-0.5, 0.1, 0, 1, 0.05, range(r, -0.2, 0.2), 1, 0.12);
  tube(-0.1, 0.12, 0, 0.6, 0.1, 0.8, 0.5, 0.08);
  tube(0.2, 0.12, 0, 0.7, 0.05, -0.7, 0.4, 0.07);
  return toBuffer(g, false);
}

/**
 * Dried sargassum: a loose, springy tangle of thin wiry stems (triangular tubes) carrying small
 * lance-shaped leaves and air bladders. uv.x carries a per-strand tone for the material.
 */
function seaweed(r: Rand) {
  const g = newGeo();
  const tri = (a: number, b: number, c: number) => g.idx.push(a, b, c);
  const STRANDS = 13; // [polish] denser, tangled clumps (9 thin strands read as scribbles)
  const p = new Vector3();
  const d = new Vector3();
  const side = new Vector3();
  const up = new Vector3();
  for (let k = 0; k < STRANDS; k++) {
    const tone = r();
    p.set(range(r, -0.16, 0.16), 0.004, range(r, -0.1, 0.1));
    let yaw = r() * Math.PI * 2;
    let pitch = range(r, -0.1, 0.6);
    const len = range(r, 0.1, 0.3);
    const S = 5;
    const rad = range(r, 0.004, 0.007);
    const ring: number[] = [];
    for (let s = 0; s <= S; s++) {
      d.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
      side.set(-d.z, 0, d.x).normalize();
      up.crossVectors(side, d).normalize();
      const base = g.pos.length / 3;
      ring.push(base);
      for (let i = 0; i < 3; i++) {
        const ph = (i / 3) * Math.PI * 2;
        const nx = side.x * Math.cos(ph) + up.x * Math.sin(ph);
        const ny = side.y * Math.cos(ph) + up.y * Math.sin(ph);
        const nz = side.z * Math.cos(ph) + up.z * Math.sin(ph);
        g.pos.push(p.x + nx * rad, Math.max(0.001, p.y + ny * rad), p.z + nz * rad);
        g.nor.push(nx, ny, nz);
        g.uv.push(tone, 0);
      }
      // Leaves every other segment, bladders now and then.
      if (s > 0 && s % 2 === 0) {
        const lb = g.pos.length / 3;
        const ll = range(r, 0.03, 0.055);
        const lw = ll * 0.34;
        const la = yaw + (r() < 0.5 ? 1 : -1) * range(r, 0.6, 1.2);
        const lx = Math.cos(la);
        const lz = Math.sin(la);
        const ly = range(r, -0.2, 0.35);
        g.pos.push(p.x, p.y, p.z, p.x + lx * ll * 0.5 - lz * lw, p.y + ly * ll * 0.5, p.z + lz * ll * 0.5 + lx * lw, p.x + lx * ll, p.y + ly * ll, p.z + lz * ll, p.x + lx * ll * 0.5 + lz * lw, p.y + ly * ll * 0.5, p.z + lz * ll * 0.5 - lx * lw);
        for (let i = 0; i < 4; i++) {
          g.nor.push(0, 1, 0);
          g.uv.push(tone, 1);
        }
        tri(lb, lb + 1, lb + 2);
        tri(lb, lb + 2, lb + 3);
      }
      if (r() < 0.12) {
        const bb = g.pos.length / 3;
        const br = range(r, 0.0025, 0.0045);
        const n = 4;
        for (let y = 0; y <= n; y++) {
          const th = (y / n) * Math.PI;
          for (let i = 0; i <= n; i++) {
            const ph = (i / n) * Math.PI * 2;
            const nx = Math.sin(th) * Math.cos(ph);
            const ny = Math.cos(th);
            const nz = Math.sin(th) * Math.sin(ph);
            g.pos.push(p.x + side.x * 0.005 + nx * br, p.y + ny * br + br, p.z + side.z * 0.005 + nz * br);
            g.nor.push(nx, ny, nz);
            g.uv.push(tone, 2);
          }
        }
        for (let y = 0; y < n; y++) {
          for (let i = 0; i < n; i++) {
            const q = bb + y * (n + 1) + i;
            tri(q, q + n + 1, q + 1);
            tri(q + 1, q + n + 1, q + n + 2);
          }
        }
      }
      p.addScaledVector(d, len / S);
      p.y = Math.max(0.003, p.y);
      yaw += range(r, -0.9, 0.9);
      pitch = pitch * 0.5 + range(r, -0.5, 0.35);
    }
    for (let s = 0; s < S; s++) {
      const a0 = ring[s];
      const b0 = ring[s + 1];
      for (let i = 0; i < 3; i++) {
        const i1 = (i + 1) % 3;
        tri(a0 + i, b0 + i, a0 + i1);
        tri(a0 + i1, b0 + i, b0 + i1);
      }
    }
  }
  return toBuffer(g, false);
}

// ── Materials ──

/** Re-seat an instance on the rendered ground: shift by (ground(origin) - origin.y). */
function seated(ground: Ground) {
  return Fn(() => {
    const o = attribute('iOrigin', 'vec3');
    const p = positionLocal.add(vec3(0, ground.height(o.xz).sub(o.y), 0));
    positionPrevious.assign(p);
    return p;
  })();
}

function shellMaterial(ground: Ground) {
  const m = new MeshPhysicalNodeMaterial();
  m.name = 'goldenline.shell';
  const tint = attribute('iTint', 'vec3');
  const band = sin(uv().y.mul(22)).mul(0.5).add(0.5);
  m.colorNode = vec4(tint.mul(mix(float(0.82), float(1.05), band)), 1);
  m.roughnessNode = float(0.45);
  m.positionNode = seated(ground);
  return m;
}

function rubbleMaterial(ground: Ground) {
  const m = new MeshStandardNodeMaterial();
  m.name = 'goldenline.rubble';
  const pores = mx_noise_float(positionWorld.mul(90)).mul(0.5).add(0.5);
  const tint = attribute('iTint', 'vec3');
  m.colorNode = vec4(tint.mul(mix(float(0.7), float(1), pores)), 1);
  m.roughnessNode = float(0.9);
  m.positionNode = seated(ground);
  return m;
}

function seaweedMaterial(ground: Ground) {
  const m = new MeshPhysicalNodeMaterial({ side: DoubleSide });
  m.name = 'goldenline.seaweed';
  const tint = attribute('iTint', 'vec3');
  // Per-strand tone: from near-black fresh weed to sun-bleached golden brown.
  const tone = uv().x;
  // [polish] mostly sun-dried: tan to umber, the odd fresh dark strand (all-dark read as ink scribbles)
  const col = mix(vec3(0.13, 0.09, 0.045), vec3(0.44, 0.32, 0.16), smoothstep(0.15, 0.9, tone));
  m.colorNode = vec4(col.mul(tint), 1);
  m.roughnessNode = float(0.72);
  m.specularIntensityNode = float(0.6);
  m.positionNode = seated(ground);
  return m;
}

// ── Placement ──

const UP = new Vector3(0, 1, 0);

export function createDressing(ctx: GLContext, ground: Ground) {
  const r = rng(4242);
  const height = ctx.services.terrain.height;
  const tilt = new Vector3();
  const qt = new Quaternion();

  // Wrack line and shells, on the main stretch of beach either side of the pier.
  const Z0 = -170;
  const Z1 = 190;
  const items = (count: number, pick: () => { d: number; size: number; tint: [number, number, number]; flat: boolean }) => {
    const out: PropInstance[] = [];
    for (let i = 0; i < count; i++) {
      const z = range(r, Z0, Z1);
      const o = pick();
      const x = shoreX(z) + o.d;
      const q = new Quaternion().setFromAxisAngle(UP, r() * Math.PI * 2);
      // Resting tilt: rubble and weed lie at random angles; shells mostly flat.
      tilt.set(range(r, -1, 1), 0, range(r, -1, 1)).normalize();
      qt.setFromAxisAngle(tilt, o.flat ? range(r, -0.15, 0.15) : range(r, -0.5, 0.5));
      q.premultiply(qt);
      out.push({ x, y: height(x, z) - o.size * 0.06, z, q, scale: o.size, tint: o.tint });
    }
    return out;
  };

  // The wrack line sits on the high-tide contour (~1.45 m), which on the 1:9 face is d ≈ 12-13.
  const wrackD = () => 12.6 + range(r, -0.5, 0.5) * range(r, 0.3, 1.6) + (r() < 0.12 ? range(r, -2.5, 2.5) : 0);
  const shellD = () => (r() < 0.6 ? wrackD() + range(r, -1.5, 1.5) : range(r, 3, 30));
  const shellTint = (): [number, number, number] => {
    const k = r();
    if (k < 0.45) return [0.72, 0.66, 0.58];
    if (k < 0.7) return [0.7, 0.52, 0.42];
    if (k < 0.85) return [0.62, 0.42, 0.26];
    return [0.5, 0.46, 0.44];
  };

  const weedGeo = seaweed(r);
  const cockleGeo = cockle();
  const coneGeo = cone();
  const rubbleGeo = rubble(r);
  const sMat = shellMaterial(ground);
  const rMat = rubbleMaterial(ground);
  const wMat = seaweedMaterial(ground);
  const sets = [
    new ChunkedInstances('goldenline.seaweed', weedGeo, wMat, items(1300, () => ({ d: wrackD(), size: range(r, 0.7, 1.4), tint: [range(r, 0.8, 1.2), range(r, 0.85, 1.1), range(r, 0.8, 1.1)], flat: false })), 24, 50, false),
    new ChunkedInstances('goldenline.shells', cockleGeo, sMat, items(900, () => ({ d: shellD(), size: range(r, 0.025, 0.06), tint: shellTint(), flat: true })), 24, 45, true),
    new ChunkedInstances('goldenline.cones', coneGeo, sMat, items(350, () => ({ d: shellD(), size: range(r, 0.03, 0.065), tint: shellTint(), flat: true })), 24, 45, true),
    new ChunkedInstances('goldenline.rubble', rubbleGeo, rMat, items(500, () => ({ d: shellD(), size: range(r, 0.04, 0.12), tint: r() < 0.8 ? [0.74, 0.7, 0.62] : [0.6, 0.52, 0.45], flat: false })), 24, 55, true),
  ];
  const meshes: Mesh[] = [];
  for (const c of sets) meshes.push(...c.meshes);

  return {
    meshes,
    update(camX: number, camZ: number, enabled: boolean) {
      for (let i = 0; i < sets.length; i++) sets[i].update(camX, camZ, enabled);
    },
    dispose() {
      for (const c of sets) c.dispose();
      for (const g of [weedGeo, cockleGeo, coneGeo, rubbleGeo]) g.dispose();
      sMat.dispose();
      rMat.dispose();
      wMat.dispose();
    },
  };
}
