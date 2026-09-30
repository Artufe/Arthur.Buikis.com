// Dune vegetation near the camera: grass clumps and creeping-vine leaf mats, placed where the
// baked vegetation cover (the same function the terrain shader paints green) says plants grow.

import { BufferAttribute, BufferGeometry, DoubleSide, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { Fn, abs, attribute, cameraPosition, float, length, max, mix, mx_noise_float, normalize, positionLocal, positionPrevious, positionWorld, pow, sin, smoothstep, step, uv, vec3, vec4 } from 'three/tsl';
import type { GLContext, TSLNode } from '../core/contracts';
import { WIND, shoreX } from '../world/layout';
import { vegetationCover } from './bake';
import { ChunkedInstances, type PropInstance } from './chunks';
import type { Ground } from './ground';
import { rng, range, type Rand } from './rng';

const UP = new Vector3(0, 1, 0);

type Geo = { pos: number[]; nor: number[]; uv: number[]; idx: number[] };

function toGeometry(g: Geo) {
  const b = new BufferGeometry();
  b.setAttribute('position', new BufferAttribute(new Float32Array(g.pos), 3));
  b.setAttribute('normal', new BufferAttribute(new Float32Array(g.nor), 3));
  b.setAttribute('uv', new BufferAttribute(new Float32Array(g.uv), 2));
  b.setIndex(new BufferAttribute(new Uint16Array(g.idx), 1));
  return b;
}

/** Spinifex-like clump: stiff, arching, tapering blades from one crown. */
function grassClump(r: Rand): Geo {
  const g: Geo = { pos: [], nor: [], uv: [], idx: [] };
  const BL = 18;
  for (let k = 0; k < BL; k++) {
    const az = r() * Math.PI * 2;
    const lean = range(r, 0.1, 0.9);
    const len = range(r, 0.22, 0.62);
    const w0 = range(r, 0.0035, 0.0065);
    const ox = Math.cos(az) * range(r, 0, 0.06);
    const oz = Math.sin(az) * range(r, 0, 0.06);
    const dx = Math.cos(az);
    const dz = Math.sin(az);
    const base = g.pos.length / 3;
    const SEG = 4;
    for (let j = 0; j <= SEG; j++) {
      const t = j / SEG;
      const h = len * (t - 0.55 * lean * t * t);
      const out = len * (lean * t * t * 0.9 + 0.12 * t);
      const w = w0 * (1 - t * 0.92);
      // Three vertices across: the midrib sits proud of the edges (a V-folded blade), and the
      // edge normals roll outward so each blade shades as a rounded surface, not a strip.
      for (let e = -1; e <= 1; e++) {
        const fold = e === 0 ? w * 0.6 : 0;
        g.pos.push(ox + dx * out - dz * w * e, h + fold, oz + dz * out + dx * w * e);
        const nx = dx * 0.3 - dz * 0.55 * e;
        const nz = dz * 0.3 + dx * 0.55 * e;
        const l = Math.hypot(nx, 0.85, nz);
        g.nor.push(nx / l, 0.85 / l, nz / l);
        g.uv.push((e + 1) / 2, t);
      }
    }
    for (let j = 0; j < SEG; j++) {
      const a = base + j * 3;
      g.idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
    }
  }
  return g;
}

/** One cupped, notched leaf (14-vertex fan, normals rolling outward from the midrib). */
function leaf(g: Geo, cx: number, cy: number, cz: number, size: number, heading: number, tx: number, tz: number) {
  const nlen = Math.hypot(tx, 1, tz);
  const nx = tx / nlen;
  const ny = 1 / nlen;
  const nz = tz / nlen;
  let ux = 1;
  let uy = -nx / ny;
  let uz = 0;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  const cr = Math.cos(heading);
  const sr = Math.sin(heading);
  const base = g.pos.length / 3;
  g.pos.push(cx - nx * size * 0.12, cy - ny * size * 0.12, cz - nz * size * 0.12);
  g.nor.push(nx, ny, nz);
  g.uv.push(0.5, 0.5);
  const RIM = 15;
  for (let i = 0; i < RIM; i++) {
    const ph = (i / RIM) * Math.PI * 2;
    // Rounded outline, notched at the tip (+x), tapering to the stalk (-x).
    const notch = 1 - 0.28 * Math.exp(-((ph / 0.35) ** 2)) - 0.28 * Math.exp(-(((ph - Math.PI * 2) / 0.35) ** 2));
    const taper = 1 - 0.3 * Math.exp(-(((ph - Math.PI) / 0.5) ** 2));
    const lx = (Math.cos(ph) + 0.9) * size * 0.55 * notch * taper; // stalk end at the origin
    const lz = Math.sin(ph) * size * 0.9 * notch;
    const px = lx * cr - lz * sr;
    const pz = lx * sr + lz * cr;
    const lift = size * 0.18;
    g.pos.push(cx + ux * px + vx * pz + nx * lift, cy + uy * px + vy * pz + ny * lift, cz + uz * px + vz * pz + nz * lift);
    const ox = (ux * px + vx * pz) / size;
    const oy = (uy * px + vy * pz) / size;
    const oz = (uz * px + vz * pz) / size;
    const mx = nx - ox * 0.4;
    const my = ny - oy * 0.4;
    const mz = nz - oz * 0.4;
    const ml = Math.hypot(mx, my, mz);
    g.nor.push(mx / ml, my / ml, mz / ml);
    g.uv.push(0.5 + 0.5 * Math.sin(ph), 0.5 + 0.5 * Math.cos(ph));
  }
  for (let i = 0; i < RIM; i++) g.idx.push(base, base + 1 + i, base + 1 + ((i + 1) % RIM));
}

/**
 * Creeper mat (beach morning glory): runners snaking out over the sand from a crown, with leaves
 * on short stalks alternating along them. Runners have uv.y < 0 (the material colours them as
 * stems).
 */
function creeperClump(r: Rand): Geo {
  const g: Geo = { pos: [], nor: [], uv: [], idx: [] };
  const RUNNERS = 4;
  for (let k = 0; k < RUNNERS; k++) {
    let a = r() * Math.PI * 2;
    let x = 0;
    let z = 0;
    const S = 12;
    const step = range(r, 0.03, 0.045);
    let turn = range(r, -0.25, 0.25);
    const w = 0.0028;
    const pairs: number[] = [];
    for (let s = 0; s <= S; s++) {
      pairs.push(g.pos.length / 3);
      const px = -Math.sin(a) * w;
      const pz = Math.cos(a) * w;
      const y = 0.004 + 0.006 * Math.sin((s / S) * Math.PI);
      g.pos.push(x + px, y, z + pz, x - px, y, z - pz);
      g.nor.push(0, 1, 0, 0, 1, 0);
      g.uv.push(0, -1, 1, -1);
      if (s > 0 && s % 2 === 0) {
        const side = (s >> 1) & 1 ? 1 : -1;
        const h = a + side * range(r, 0.7, 1.3);
        const size = range(r, 0.028, 0.048) * (1 - 0.3 * (s / S));
        leaf(g, x, y + range(r, 0.004, 0.03), z, size, h, range(r, -0.35, 0.35), range(r, -0.35, 0.35));
      }
      x += Math.cos(a) * step;
      z += Math.sin(a) * step;
      // Smoothly curving runner: the turn rate itself wanders.
      turn = turn * 0.7 + range(r, -0.12, 0.12);
      a += turn;
    }
    for (let s = 0; s < S; s++) {
      const p0 = pairs[s];
      const p1 = pairs[s + 1];
      g.idx.push(p0, p1, p0 + 1, p0 + 1, p1, p1 + 1);
    }
  }
  return g;
}

/**
 * Dune grass and creeper mats: CPU-placed where the baked cover says so (jittered grids), binned
 * into 32 m chunks drawn within 45 m of the camera; each instance re-seats on the rendered
 * ground on the GPU. Beyond the draw distance the terrain shading carries the vegetation.
 */
export function createVegetation(ctx: GLContext, ground: Ground, time: TSLNode) {
  const r = rng(777);
  const height = ctx.services.terrain.height;
  const sunDir = ctx.services.atmosphere.sunDirNode;
  const sunColor = ctx.services.atmosphere.sunColorNode;
  const sample = (spacing: number, minCover: number, size: [number, number]) => {
    const out: PropInstance[] = [];
    for (let z = -300; z < 300; z += spacing) {
      for (let dd = 44; dd < 135; dd += spacing) {
        const zz = z + r() * spacing;
        const x = shoreX(zz) + dd + r() * spacing;
        const c = vegetationCover(x, zz);
        if (c <= 0 || r() * (1 - minCover) + minCover > c) continue;
        const q = new Quaternion().setFromAxisAngle(UP, r() * Math.PI * 2);
        const k = range(r, size[0], size[1]) * (0.6 + 0.7 * Math.min(1, c * 1.3));
        out.push({ x, y: height(x, zz), z: zz, q, scale: k, sy: range(r, 0.8, 1.2), tint: [r(), 0, 0] });
      }
    }
    return out;
  };

  // Grass.
  const gGeo = toGeometry(grassClump(r));
  const gMat = new MeshStandardNodeMaterial({ side: DoubleSide });
  gMat.name = 'goldenline.dunegrass';
  gMat.positionNode = Fn(() => {
    const o = attribute('iOrigin', 'vec3');
    const ph = attribute('iTint', 'vec3').x.mul(6.2832);
    const t = uv().y;
    const gust = sin(time.mul(1.6).add(ph).add(o.x.mul(0.2))).mul(0.5).add(0.6);
    const sway = vec3(WIND.dirX, -0.3, WIND.dirZ).mul(t.mul(t).mul(gust).mul(0.08));
    const p = positionLocal.add(vec3(0, ground.height(o.xz).sub(o.y).sub(0.02), 0)).add(sway);
    positionPrevious.assign(p);
    return p;
  })();
  {
    const t = uv().y;
    const tone = mx_noise_float(positionWorld.mul(0.35)).mul(0.5).add(0.5);
    const base = mix(vec3(0.09, 0.12, 0.045), vec3(0.16, 0.17, 0.07), tone);
    const tip = vec3(0.42, 0.36, 0.19);
    const col = mix(base, tip, smoothstep(0.35, 1, t).mul(tone.mul(0.6).add(0.4)));
    gMat.colorNode = vec4(col, 1);
    gMat.roughnessNode = float(0.55);
    // Thin blades glow when the sun is behind them.
    const view = normalize(positionWorld.sub(cameraPosition));
    gMat.emissiveNode = sunColor.mul(col).mul(pow(max(view.dot(sunDir), 0), 5)).mul(0.08);
  }

  // Creeper mats.
  const cGeo = toGeometry(creeperClump(r));
  const cMat = new MeshPhysicalNodeMaterial({ side: DoubleSide });
  cMat.name = 'goldenline.creeper';
  cMat.positionNode = Fn(() => {
    const o = attribute('iOrigin', 'vec3');
    const ph = attribute('iTint', 'vec3').x.mul(6.2832);
    const flutter = sin(time.mul(3.1).add(ph).add(positionLocal.x.mul(20))).mul(0.004);
    const p = positionLocal.add(vec3(0, ground.height(o.xz).sub(o.y).sub(0.01).add(flutter), 0));
    positionPrevious.assign(p);
    return p;
  })();
  {
    const tone = mx_noise_float(positionWorld.mul(1.1)).mul(0.5).add(0.5);
    const rim = length(uv().sub(0.5)).mul(2);
    // Midrib and paired veins lighter; margins slightly darker.
    const mid = float(1).sub(smoothstep(0.0, 0.06, abs(uv().x.sub(0.5))));
    const leafC = mix(vec3(0.05, 0.1, 0.03), vec3(0.1, 0.14, 0.035), tone);
    const stem = step(uv().y, -0.5);
    const col = mix(mix(leafC.mul(mix(float(1.1), float(0.75), rim)), vec3(0.2, 0.22, 0.09), mid.mul(0.5)), vec3(0.22, 0.15, 0.1), stem);
    cMat.colorNode = vec4(col, 1);
    cMat.roughnessNode = float(0.38);
    cMat.specularIntensityNode = float(0.7);
    const view = normalize(positionWorld.sub(cameraPosition));
    cMat.emissiveNode = sunColor.mul(col).mul(pow(max(view.dot(sunDir), 0), 5)).mul(0.06);
  }

  const grass = new ChunkedInstances('goldenline.dunegrass', gGeo, gMat, sample(0.75, 0.15, [0.7, 1.35]), 16, 36, true);
  const creeper = new ChunkedInstances('goldenline.creeper', cGeo, cMat, sample(0.45, 0.05, [0.8, 1.3]), 16, 26, false);

  return {
    meshes: [...grass.meshes, ...creeper.meshes],
    count: grass.meshes.length + creeper.meshes.length,
    update(camX: number, camZ: number, enabled: boolean) {
      grass.update(camX, camZ, enabled);
      creeper.update(camX, camZ, enabled);
    },
    dispose() {
      grass.dispose();
      creeper.dispose();
      gGeo.dispose();
      cGeo.dispose();
      gMat.dispose();
      cMat.dispose();
    },
  };
}
