// Coconut palms leaning off the dune line. Real geometry throughout: a curved, tapering trunk
// with leaf-scar rings, a crown of pinnate fronds whose leaflets are V-folded strips (no alpha
// cards), and a coconut cluster. Three variants, instanced; wind sway in the vertex stage.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  fract,
  max,
  mix,
  mx_noise_float,
  normalLocal,
  normalViewGeometry,
  normalize,
  positionLocal,
  positionPrevious,
  positionView,
  positionWorld,
  pow,
  sin,
  smoothstep,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { GLContext, TSLNode } from '../core/contracts';
import { WIND, shoreX } from '../world/layout';
import { rng, range, type Rand } from './rng';

// ── Geometry builder ──

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uvs: number[] = [];
  sway: number[] = [];
  idx: number[] = [];
  vert(p: Vector3, n: Vector3, u: number, v: number, s0: number, s1: number, s2: number, s3: number) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
    this.sway.push(s0, s1, s2, s3);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  build(computeNormals: boolean) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    g.setAttribute('sway', new BufferAttribute(new Float32Array(this.sway), 4));
    const n = this.pos.length / 3;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    if (computeNormals) g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new Vector3(0, 1, 0);

interface PalmShape {
  height: number;
  lean: number; // horizontal offset / height at the top
  fronds: number;
  frondLen: number;
  seed: number;
}

/** Trunk centreline (local: base at origin, leaning toward -X). t in [0, 1]. */
function trunkPoint(s: PalmShape, t: number, out: Vector3) {
  const H = s.height;
  // Leans from the base, then curves back toward vertical near the crown (phototropism).
  const x = -H * s.lean * (t * 1.25 - 0.32 * t * t);
  const z = 0.18 * Math.sin(t * 2.7 + s.seed) * t;
  return out.set(x, H * t * (1 - 0.05 * t), z);
}

function buildTrunk(s: PalmShape, r: Rand) {
  const b = new Builder();
  const RS = 14;
  const LS = 40;
  const p = new Vector3();
  const p2 = new Vector3();
  const T = new Vector3();
  const Nn = new Vector3();
  const Bn = new Vector3();
  const q = new Vector3();
  const nrm = new Vector3();
  let arc = 0;
  let prev = trunkPoint(s, 0, new Vector3());
  for (let j = 0; j <= LS; j++) {
    const t = j / LS;
    trunkPoint(s, t, p);
    trunkPoint(s, Math.min(1, t + 0.01), p2);
    T.copy(p2).sub(p);
    if (T.lengthSq() < 1e-8) T.set(0, 1, 0);
    T.normalize();
    Nn.crossVectors(T, new Vector3(0, 0, 1)).normalize();
    Bn.crossVectors(Nn, T).normalize();
    arc += p.distanceTo(prev);
    prev = prev.copy(p);
    // Radius: flared root bole, slow taper, slight swelling under the crown.
    const rad = 0.16 + 0.12 * Math.exp(-t * 16) - 0.035 * t + 0.03 * Math.exp(-(((t - 0.97) / 0.04) ** 2));
    for (let i = 0; i <= RS; i++) {
      const a = (i / RS) * Math.PI * 2;
      nrm.copy(Nn).multiplyScalar(Math.cos(a)).addScaledVector(Bn, Math.sin(a));
      const wobble = 1 + 0.03 * Math.sin(a * 3 + t * 20 + s.seed);
      q.copy(p).addScaledVector(nrm, rad * wobble);
      b.vert(q, nrm, i / RS, arc, 0, 0, s.seed, t);
    }
  }
  for (let j = 0; j < LS; j++) {
    for (let i = 0; i < RS; i++) {
      const a = j * (RS + 1) + i;
      const c = a + RS + 1;
      b.tri(a, c, a + 1);
      b.tri(a + 1, c, c + 1);
    }
  }
  // Coconuts clustered under the crown.
  const top = trunkPoint(s, 1, new Vector3());
  const nuts = 5 + Math.floor(r() * 5);
  for (let k = 0; k < nuts; k++) {
    const az = r() * Math.PI * 2;
    const c = new Vector3(Math.cos(az) * 0.2, -0.28 - r() * 0.2, Math.sin(az) * 0.2).add(top);
    const R = 0.1 + r() * 0.03;
    const base = b.pos.length / 3;
    const SEG = 8;
    for (let y = 0; y <= SEG; y++) {
      const th = (y / SEG) * Math.PI;
      for (let x = 0; x <= SEG; x++) {
        const ph = (x / SEG) * Math.PI * 2;
        nrm.set(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
        q.copy(c).addScaledVector(nrm, R).add(new Vector3(0, nrm.y * R * 0.15, 0));
        b.vert(q, nrm, x / SEG, -1, 0, 0, s.seed, 1);
      }
    }
    for (let y = 0; y < SEG; y++) {
      for (let x = 0; x < SEG; x++) {
        const a = base + y * (SEG + 1) + x;
        const d = a + SEG + 1;
        b.tri(a, d, a + 1);
        b.tri(a + 1, d, d + 1);
      }
    }
  }
  return b.build(false);
}

function buildFronds(s: PalmShape, r: Rand) {
  const b = new Builder();
  const top = trunkPoint(s, 1, new Vector3());
  const dir = new Vector3();
  const pt = new Vector3();
  const T = new Vector3();
  const S = new Vector3();
  const L = new Vector3();
  const W = new Vector3();
  const n = new Vector3();
  const q = new Vector3();
  const spine: Vector3[] = [];
  const tang: Vector3[] = [];
  const SPINE = 16;
  for (let i = 0; i <= SPINE; i++) {
    spine.push(new Vector3());
    tang.push(new Vector3());
  }
  for (let f = 0; f < s.fronds; f++) {
    const age = f / (s.fronds - 1); // 0 = young (upright) … 1 = old (drooping)
    const az = f * 2.39996 + r() * 0.35;
    const elev = (0.95 - 1.25 * age + range(r, -0.12, 0.12));
    const len = s.frondLen * (0.8 + 0.3 * age) * range(r, 0.9, 1.08);
    const droop = 0.5 + 1.5 * age;
    const phase = r() * 6.283;
    // Rachis: start direction from azimuth/elevation, bending down along its length.
    let th = elev;
    pt.copy(top);
    for (let i = 0; i <= SPINE; i++) {
      const s01 = i / SPINE;
      dir.set(Math.cos(az) * Math.cos(th), Math.sin(th), Math.sin(az) * Math.cos(th));
      spine[i].copy(pt);
      tang[i].copy(dir);
      pt.addScaledVector(dir, len / SPINE);
      th -= (droop / SPINE) * (0.4 + s01);
    }
    // Rachis itself: a thin 4-sided tube.
    const rBase = b.pos.length / 3;
    for (let i = 0; i <= SPINE; i++) {
      T.copy(tang[i]);
      S.crossVectors(T, UP).normalize();
      W.crossVectors(S, T).normalize();
      const rr = 0.035 * (1 - (i / SPINE) * 0.8);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        n.copy(S).multiplyScalar(Math.cos(a)).addScaledVector(W, Math.sin(a));
        q.copy(spine[i]).addScaledVector(n, rr);
        b.vert(q, n, 0, i / SPINE, i / SPINE, 0, phase, age);
      }
    }
    for (let i = 0; i < SPINE; i++) {
      for (let k = 0; k < 4; k++) {
        const a = rBase + i * 4 + k;
        const c = rBase + i * 4 + ((k + 1) % 4);
        b.tri(a, a + 4, c);
        b.tri(c, a + 4, c + 4);
      }
    }
    // Leaflets on both sides.
    const PER = 27;
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < PER; k++) {
        const s01 = 0.1 + 0.88 * (k / (PER - 1)) + range(r, -0.008, 0.008);
        const fi = s01 * SPINE;
        const i0 = Math.min(SPINE - 1, Math.floor(fi));
        const fr = fi - i0;
        pt.lerpVectors(spine[i0], spine[i0 + 1], fr);
        T.lerpVectors(tang[i0], tang[i0 + 1], fr).normalize();
        S.crossVectors(T, UP).normalize().multiplyScalar(side);
        // Leaflet direction: out from the rachis, swept toward the tip, hanging down.
        const hang = 0.35 + 0.55 * age + 0.35 * s01 + range(r, -0.1, 0.1);
        L.copy(S).multiplyScalar(0.75).addScaledVector(T, 0.62).addScaledVector(UP, -hang).normalize();
        const ll = len * 0.24 * Math.pow(Math.sin(Math.PI * (0.08 + 0.92 * s01)), 0.6) * range(r, 0.85, 1.1);
        const wid = 0.045 * (1 - 0.5 * s01) * range(r, 0.8, 1.15);
        // Width axis: across the leaflet, roughly along the rachis.
        W.crossVectors(L, S).normalize();
        if (W.dot(T) < 0) W.negate();
        n.crossVectors(W, L).normalize();
        if (n.y < 0) n.negate();
        const leafRand = r();
        const SEGS = 3;
        const base = b.pos.length / 3;
        for (let j = 0; j <= SEGS; j++) {
          const u01 = j / SEGS;
          const w = wid * Math.sin(Math.PI * Math.min(1, 0.12 + u01 * 0.95)) * (1 - 0.8 * u01 * u01);
          q.copy(pt).addScaledVector(L, ll * u01).addScaledVector(UP, -ll * 0.28 * u01 * u01);
          const fold = w * 0.35; // V fold: the midrib sits lower than the edges
          for (let e = -1; e <= 1; e++) {
            const v = q.clone().addScaledVector(W, e * w).addScaledVector(n, e === 0 ? -fold : 0);
            b.vert(v, n, (e + 1) / 2, leafRand, s01, u01, phase + s01 * 2, age);
          }
        }
        for (let j = 0; j < SEGS; j++) {
          const a = base + j * 3;
          b.tri(a, a + 3, a + 1);
          b.tri(a + 1, a + 3, a + 4);
          b.tri(a + 1, a + 4, a + 2);
          b.tri(a + 2, a + 4, a + 5);
        }
      }
    }
  }
  return b.build(true);
}

// ── Materials ──

/** View-space normal bumped by a procedural height (Mikkelsen's surface-gradient bump). */
function bump(h: TSLNode, scale: number): TSLNode {
  const N = normalViewGeometry;
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(N);
  const r2 = N.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(h.dFdx().mul(scale).mul(r1).add(h.dFdy().mul(scale).mul(r2)));
  return det.abs().mul(N).sub(grad).normalize();
}

function trunkMaterial(time: TSLNode) {
  const m = new MeshStandardNodeMaterial();
  m.name = 'goldenline.palmTrunk';
  const sway = attribute('sway', 'vec4');
  const t = sway.w;
  const v = uv().y; // arc length (m); -1 on coconuts
  const nut = smoothstep(-0.5, -0.9, v);
  // Leaf-scar rings: close together and crisp near the crown, worn smooth toward the base.
  const ringF = mix(float(9), float(14), t);
  const ring = fract(v.mul(ringF).add(mx_noise_float(vec3(uv().x.mul(6), v.mul(0.5), 1)).mul(0.25)));
  const groove = smoothstep(0.0, 0.12, ring).mul(smoothstep(1.0, 0.8, ring));
  const fibre = mx_noise_float(vec3(uv().x.mul(40), v.mul(3), 2.2)).mul(0.5).add(0.5);
  const height = groove.mul(mix(float(0.4), float(1), t)).add(fibre.mul(0.25));
  m.normalNode = bump(height.mul(float(1).sub(nut)), 0.012);
  const barkLight = vec3(0.34, 0.3, 0.26);
  const barkDark = vec3(0.16, 0.13, 0.1);
  let col: TSLNode = mix(barkDark, barkLight, groove.mul(0.7).add(fibre.mul(0.3)));
  col = mix(col, vec3(0.2, 0.19, 0.12), smoothstep(0.15, 0.0, t).mul(0.6)); // damp, algae-dark base
  col = mix(col, vec3(0.3, 0.24, 0.1), smoothstep(0.9, 1.0, t).mul(0.5)); // fibrous crown shaft
  col = mix(col, vec3(0.18, 0.22, 0.06).mul(fibre.mul(0.4).add(0.8)), nut);
  m.colorNode = vec4(col, 1);
  m.roughnessNode = mix(float(0.9), float(0.45), nut);
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const ph = sway.z;
    const w = vec3(WIND.dirX, 0, WIND.dirZ);
    const bend = pow(t, 2).mul(sin(time.mul(0.55).add(ph)).mul(0.5).add(0.6)).mul(0.14);
    const out = p.add(w.mul(bend));
    positionPrevious.assign(out);
    return out;
  })();
  return m;
}

function frondMaterial(time: TSLNode, sunDir: TSLNode, sunColor: TSLNode) {
  const m = new MeshPhysicalNodeMaterial({ side: DoubleSide });
  m.name = 'goldenline.palmFrond';
  const sway = attribute('sway', 'vec4');
  const along = sway.x; // 0 crown … 1 frond tip
  const tip = sway.y; // 0 rachis … 1 leaflet tip
  const age = sway.w;
  const leafRand = uv().y;
  const across = uv().x;
  const fresh = vec3(0.06, 0.1, 0.022);
  const mature = vec3(0.1, 0.12, 0.03);
  const old = vec3(0.2, 0.15, 0.05);
  let col: TSLNode = mix(fresh, mature, smoothstep(0.2, 0.7, age.add(leafRand.mul(0.3))));
  col = mix(col, old, smoothstep(0.75, 1.0, age.add(leafRand.mul(0.15))));
  // Dry, frayed brown tips and a pale midrib.
  col = mix(col, vec3(0.22, 0.16, 0.07), smoothstep(0.78, 1.0, tip).mul(0.7));
  col = mix(col, vec3(0.2, 0.2, 0.08), smoothstep(0.12, 0.0, max(across.sub(0.5).abs(), 0)).mul(0.5));
  m.colorNode = vec4(col.mul(leafRand.mul(0.3).add(0.85)), 1);
  m.roughnessNode = float(0.5);
  m.specularIntensityNode = float(0.6);
  // Transmission when looking toward the sun through the leaf (thin lamina glows gold-green).
  const view = normalize(positionWorld.sub(cameraPosition));
  const back = pow(max(view.dot(sunDir), 0), 6);
  const trans = vec3(0.3, 0.42, 0.06).mul(float(1).sub(age.mul(0.5)));
  m.emissiveNode = sunColor.mul(trans).mul(back).mul(0.045);
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const ph = sway.z;
    const w = vec3(WIND.dirX, 0.15, WIND.dirZ);
    const gust = sin(time.mul(1.3).add(ph)).mul(0.5).add(0.5).mul(sin(time.mul(0.37).add(ph.mul(0.5))).mul(0.3).add(0.7));
    const bend = pow(along, 1.6).mul(gust).mul(0.32);
    const flutter = sin(time.mul(9).add(ph.mul(7)).add(along.mul(11))).mul(tip).mul(0.035);
    const out = p.add(w.mul(bend)).add(normalLocal.mul(flutter));
    positionPrevious.assign(out);
    return out;
  })();
  return m;
}

// ── Placement ──

/** Palm sites: on the foredune toe, leaning seaward. (d = distance shoreward of the water line.) */
const SITES: Array<[number, number, number]> = [
  // z, d, variant
  [-168, 57, 0],
  [-121, 55, 1],
  [-97, 60, 2],
  [-58, 54, 0],
  [-36, 58, 1],
  [-8, 55, 2],
  [12, 61, 0],
  [63, 56, 1],
  [79, 59, 2],
  [118, 55, 0],
  [171, 58, 1],
  [214, 56, 2],
];

export function createPalms(ctx: GLContext, time: TSLNode) {
  const r = rng(90210);
  const shapes: PalmShape[] = [
    { height: 9.5, lean: 0.34, fronds: 18, frondLen: 4.4, seed: 1.1 },
    { height: 7.8, lean: 0.5, fronds: 16, frondLen: 4.0, seed: 2.7 },
    { height: 11.2, lean: 0.22, fronds: 19, frondLen: 4.6, seed: 4.2 },
  ];
  const atmos = ctx.services.atmosphere;
  const tMat = trunkMaterial(time);
  const fMat = frondMaterial(time, atmos.sunDirNode, atmos.sunColorNode);
  const meshes: InstancedMesh[] = [];
  const geos: BufferGeometry[] = [];
  const m4 = new Matrix4();
  const qn = new Quaternion();
  const sc = new Vector3();
  const pos = new Vector3();
  for (let v = 0; v < shapes.length; v++) {
    const sites = SITES.filter((s) => s[2] === v);
    const tg = buildTrunk(shapes[v], r);
    const fg = buildFronds(shapes[v], r);
    geos.push(tg, fg);
    const tm = new InstancedMesh(tg, tMat, sites.length);
    const fm = new InstancedMesh(fg, fMat, sites.length);
    for (let i = 0; i < sites.length; i++) {
      const [z, d] = sites[i];
      const x = shoreX(z) + d;
      pos.set(x, ctx.services.terrain.height(x, z) - 0.25, z);
      // Lean seaward (-X) with some spread; rotation about Y only.
      qn.setFromAxisAngle(UP, range(r, -0.55, 0.55));
      const k = range(r, 0.9, 1.1);
      sc.set(k, k, k);
      m4.compose(pos, qn, sc);
      tm.setMatrixAt(i, m4);
      fm.setMatrixAt(i, m4);
    }
    for (const m of [tm, fm]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      m.matrixAutoUpdate = false;
      m.updateMatrix();
    }
    tm.name = 'goldenline.palmTrunks';
    fm.name = 'goldenline.palmFronds';
    meshes.push(tm, fm);
  }
  return {
    meshes,
    dispose() {
      for (const g of geos) g.dispose();
      tMat.dispose();
      fMat.dispose();
      for (const m of meshes) m.dispose();
    },
  };
}
