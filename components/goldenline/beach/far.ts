// Far field: the low volcanic headland closing the -Z end of the bay and a distant island on
// the horizon. Real meshes (not cards) from analytic heightfields, so their silhouettes hold
// against the low sun and the atmosphere's aerial perspective does the rest.

import { BufferAttribute, BufferGeometry, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  cameraViewMatrix,
  float,
  fract,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  normalWorldGeometry,
  normalize,
  positionWorld,
  smoothstep,
  vec3,
  vec4,
} from 'three/tsl';
import { fbm, vnoise } from '../world/noise';

type HeightFn = (x: number, z: number) => number;

const sm = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Ridged fBm in [0, 1]: sharp crests, the erosion signature of old volcanic flanks. */
function ridged(x: number, z: number, oct: number) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(x * f + i * 13.1, z * f - i * 7.7));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return sum / norm;
}

// ── Headland: a ridge from inland (+X) out to a cliffed tip in the sea (-X), at the -Z end. ──

const HA = { x: 360, z: -700 }; // inland end of the ridge axis
const HB = { x: -430, z: -565 }; // seaward tip
const hax = HB.x - HA.x;
const haz = HB.z - HA.z;
const hlen = Math.hypot(hax, haz);

export const headlandHeight: HeightFn = (x, z) => {
  const px = x - HA.x;
  const pz = z - HA.z;
  const s = (px * hax + pz * haz) / (hlen * hlen); // 0 inland .. 1 tip
  const r = (px * -haz + pz * hax) / hlen; // signed cross distance (m)
  const sc = Math.min(1.08, Math.max(-0.1, s));
  // Crest height along the ridge: a worn cone remnant, a saddle, then the lower seaward block.
  const crest =
    58 +
    42 * Math.exp(-(((sc - 0.36) / 0.13) ** 2)) +
    16 * Math.exp(-(((sc - 0.72) / 0.1) ** 2)) -
    30 * sm(0.86, 1.02, sc) +
    9 * fbm(sc * 6, 3.3, 3);
  const halfW = (175 - 70 * sc) * (1 + 0.18 * fbm(x * 0.006, z * 0.006, 3));
  const q = Math.abs(r) / halfW;
  // End caps: the tip plunges, the inland end rolls down into the hinterland.
  const cap = sm(1.06, 0.93, s) * sm(-0.12, 0.05, s);
  const dome = crest * Math.max(0, 1 - q * q) ** 0.85 * cap;
  // Gullies cut the flanks; fine rubble relief everywhere.
  const g = ridged(x * 0.012, z * 0.012, 4);
  let h = dome * (0.8 + 0.28 * g) + 5 * fbm(x * 0.03, z * 0.03, 4) * Math.min(1, dome / 10);
  // Sea cliffs: where the flank reaches the water it stands up as a wall instead of feathering.
  const seaward = sm(0.45, 0.8, s) + sm(40, 110, -r) * sm(0.2, 0.5, s);
  const wall = 14 + 12 * fbm(x * 0.02, z * 0.02, 3);
  h = h + (Math.max(h, wall * sm(1, 9, h)) - h) * Math.min(1, seaward) * sm(0.5, 3, h);
  // Below the waterline it keeps going down so the base never shows as an edge.
  return h - 6 * (1 - Math.min(1, dome / 6)) - 4;
};

// ── Island: a long, low volcanic silhouette ~5 km out, right of the sun. ──

const IC = { x: -4870, z: -1020 };
export const islandHeight: HeightFn = (x, z) => {
  const u = (x - IC.x) / 1100;
  const v = (z - IC.z) / 420;
  // Long axis runs roughly along Z so it spans the horizon.
  const a = (v * 0.35 + u * 0.94) / 0.42;
  const b = (u * 0.35 - v * 0.94) / 1.05;
  const d = Math.sqrt(a * a + b * b);
  const peak = 175 * Math.exp(-((b + 0.25) ** 2) / 0.12) + 90 * Math.exp(-((b - 0.45) ** 2) / 0.08);
  const body = Math.max(0, 1 - d * d) ** 1.2;
  const g = ridged(x * 0.004, z * 0.004, 4);
  return body * (40 + peak) * (0.8 + 0.3 * g) + 8 * fbm(x * 0.01, z * 0.01, 3) * body - 12;
};

function gridGeometry(h: HeightFn, x0: number, z0: number, x1: number, z1: number, step: number) {
  const nx = Math.round((x1 - x0) / step) + 1;
  const nz = Math.round((z1 - z0) / step) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const nor = new Float32Array(nx * nz * 3);
  const e = step * 0.75;
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * step;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * step;
      const o = (j * nx + i) * 3;
      pos[o] = x;
      pos[o + 1] = h(x, z);
      pos[o + 2] = z;
      // Analytic (finite-difference) normals: smooth across the whole mesh, no faceting.
      const dx = h(x + e, z) - h(x - e, z);
      const dz = h(x, z + e) - h(x, z - e);
      const l = Math.hypot(dx, 2 * e, dz);
      nor[o] = -dx / l;
      nor[o + 1] = (2 * e) / l;
      nor[o + 2] = -dz / l;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let k = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nor, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/**
 * Volcanic rock + tropical scrub: vegetation on the gentle slopes (dark canopy clumps, dry
 * grass patches), basalt and banded tuff on the cliffs, a dark wet wave-cut notch at the sea.
 */
function landmassMaterial(scale: number) {
  const mat = new MeshStandardNodeMaterial();
  mat.name = 'goldenline.farland';
  const p = positionWorld;
  const ng = normalWorldGeometry;
  const slope = float(1).sub(ng.y); // 0 flat .. 1 vertical
  const n1 = mx_noise_float(p.mul(0.045 / scale));
  const n2 = mx_noise_float(p.mul(0.19 / scale).add(7.3));
  const n3 = mx_noise_float(p.mul(0.8 / scale).add(2.1));

  const cliff = smoothstep(0.28, 0.5, slope.add(n2.mul(0.08)));
  const veg = float(1).sub(cliff).mul(smoothstep(3, 10, p.y));
  // Forest in the gullies and on the lower flanks, dry grass on the exposed ridges and high
  // slopes (leeward tropical islands are brown-gold on top), broken by n1 at the 20 m scale.
  const ridge = smoothstep(0.35, 0.75, n1.mul(0.5).add(0.5).add(smoothstep(40, 120, p.y).mul(0.35)).sub(slope.mul(0.3)));
  const clump = smoothstep(-0.2, 0.35, n2.add(n3.mul(0.5)));
  const canopy = mix(vec3(0.03, 0.045, 0.02), vec3(0.06, 0.075, 0.03), clump);
  const grass = mix(vec3(0.19, 0.15, 0.07), vec3(0.13, 0.12, 0.055), n3.mul(0.5).add(0.5));
  const vegCol = mix(canopy, grass, ridge);
  // Rock: basalt with weathered reddish tuff bands following the lava layering.
  const band = abs(fract(p.y.mul(0.09 / scale).add(n1.mul(0.6))).sub(0.5));
  const tuff = vec3(0.23, 0.15, 0.1);
  const basalt = vec3(0.07, 0.065, 0.06).mul(n3.mul(0.35).add(1));
  const rockCol = mix(basalt, tuff, smoothstep(0.32, 0.46, band).mul(0.8));
  let col = mix(rockCol, vegCol, veg);
  // Wet, dark wave-cut notch and a pale salt line above it.
  col = mix(col, vec3(0.03, 0.03, 0.028), float(1).sub(smoothstep(0.5, 3.5, p.y)));
  col = mix(col, vec3(0.3, 0.28, 0.24), smoothstep(3.2, 4.0, p.y).mul(float(1).sub(smoothstep(4.0, 5.5, p.y))).mul(cliff).mul(0.5));
  mat.colorNode = vec4(col, 1);
  // Break up the lighting at the scale the mesh can't carry: canopy lumps and rock fractures.
  const bump = mx_noise_vec3(p.mul(0.35 / scale)).mul(mix(float(0.35), float(0.55), cliff));
  const N = normalize(ng.add(bump));
  mat.normalNode = cameraViewMatrix.mul(vec4(N, 0)).xyz;
  mat.roughnessNode = mix(float(0.92), float(0.8), cliff);
  mat.metalnessNode = float(0);
  return mat;
}

export function createFarField() {
  const headGeo = gridGeometry(headlandHeight, -560, -930, 420, -360, 3.5);
  const islandGeo = gridGeometry(islandHeight, IC.x - 1500, IC.z - 1300, IC.x + 1500, IC.z + 1300, 12);
  const headMat = landmassMaterial(1);
  const islandMat = landmassMaterial(3);
  const headland = new Mesh(headGeo, headMat);
  headland.name = 'goldenline.headland';
  headland.castShadow = true;
  headland.receiveShadow = true;
  const island = new Mesh(islandGeo, islandMat);
  island.name = 'goldenline.island';
  for (const m of [headland, island]) {
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }
  return {
    meshes: [headland, island],
    dispose() {
      headGeo.dispose();
      islandGeo.dispose();
      headMat.dispose();
      islandMat.dispose();
    },
  };
}
