// Camera-local ground cover (A1): grass tufts, flowers and pebbles within ~26 m of the eye, so the
// ground at 1.7 m is never bare. Persistent like everything else: each terrain facet's tufts are
// hashed from the facet index, so walking away and back finds the same tuft in the same spot.
//
// Gathering is cheap and only runs when the eye has moved ~1.5 m: the icosphere's faces are
// ordered by subdivision, so the 4^k facets descending from each detail-3 face form a spatial
// bucket; buckets near the eye are scanned, facets within range spawn their cover. Cover shrinks
// into the ground between 14 and 24.5 m from the eye (no dither speckle), so the gather edge is
// never seen, and the meshes switch off above ~27 m. Nothing here casts shadows (it receives them).
// Each facet's instances are built once and cached (gathers copy cached blocks: ~0.3 ms).

import { Color, type InstancedMesh, Matrix4, Vector2, Vector3, type BufferGeometry } from 'three';
import type { LBContext } from '../core/contracts';
import { AREA_H, R } from '../world/config';
import { fromSphere } from '../world/city/frame';
import { icosphere } from '../world/icosphere';
import { Biome } from '../world/planet';
import { hash3 } from '../world/rng';
import { isFlowerField, vertexColors } from '../terrain/colors';
import { faceBiome, facePoint, faceMinHeight, faceSlope, type TerrainData } from '../terrain/data';
import type { SurfaceHit } from '../world/region/types';
import { nearForecourt } from '../roads/mask';
import { flowerGeometry, pebbleGeometry, tuftGeometry } from './geometry';
import { composeUp } from './frame';
import { createPathMask } from './paths';

export interface GroundCover {
  update(ctx: LBContext): void;
  /** Start the cover's reveal at this reveal-clock time. */
  reveal(start: number): void;
  dispose(): void;
}

/** Per-facet counts [tufts, flowers, pebbles] by biome (a facet is ~3.9 m²). */
const COVER: Partial<Record<number, [number, number, number]>> = {
  [Biome.Grass]: [11, 0.5, 0.15],
  [Biome.Meadow]: [9, 1.2, 0.2],
  [Biome.Forest]: [6, 0.15, 0.3],
  [Biome.Beach]: [0, 0, 1.3],
  [Biome.Rock]: [1.2, 0.05, 2.6],
  [Biome.City]: [9, 0.6, 0],
};
/** Extra tufts (× the base count) within DENSE m of the eye: a lush carpet underfoot. */
const DENSE = 12;
const DENSE_EXTRA = 0.5;
/** Flowers per facet inside a flower field (mask 1), on top of the base rate. */
const FIELD_FLOWERS = 5;

const GATHER = 26; // m
const FADE_FROM = 14; // m: cover shrinks into the ground between these distances
const FADE_TO = 24.5;
const MOVE = 1.5; // m of eye motion before a re-gather
const SHOW_ALT = 27; // m: above this the cover is fully faded anyway

// Saturated cottage-garden heads: white (golden centre), buttercup, pink, lilac, coral. Neighbouring
// facets pick from a slow field, so colours come in drifts, not confetti.
const FLOWERS = ['#FFFFFF', '#FFE066', '#F7A8C8', '#A99CDA', '#FF8A7A', '#FFFFFF', '#F7A8C8', '#FFE066'].map((h) => new Color(h));
const PEBBLE = ['#B9B0A6', '#A49C95', '#CFC6BA', '#9A938D'].map((h) => new Color(h));
const SHELL = ['#FFF4E6', '#FFD9CC', '#F7E3B5', '#E8E0D8'].map((h) => new Color(h));

export function createGroundCover(ctx: LBContext, t: TerrainData): GroundCover {
  const density = ctx.q.density;
  const capT = Math.round(16000 * density);
  const capF = Math.round(3600 * density);
  const capP = Math.round(1400 * density);
  const geoT = ctx.track(tuftGeometry());
  const geoF = ctx.track(flowerGeometry());
  const geoP = ctx.track(pebbleGeometry());
  const mat = ctx.toon.material({
    name: 'groundcover',
    vertexColors: true,
    reveal: 'object',
    revealDuration: 0.6,
    revealDelay: 1e6,
    rim: 0.18,
    patch: {
      key: 'groundcover',
      uniforms: { uCoverFade: { value: new Vector2(FADE_FROM, FADE_TO) } },
      vertexPars: /* glsl */ `
attribute float aTint;
attribute float aSway;
uniform vec2 uCoverFade;`,
      vertex: /* glsl */ `
#ifdef USE_INSTANCING
  {
    vec3 lbIp = instanceMatrix[3].xyz;
    // Distance fade by shrinking into the ground (no dither speckle at the gather edge).
    transformed *= 1.0 - smoothstep(uCoverFade.x, uCoverFade.y, distance(lbIp, lbCamPos));
    // A breeze rolling across the meadow: tips lean along local x with a travelling wave.
    float lbW = sin(dot(lbIp, vec3(0.31, 0.27, 0.22)) - lbTime * 1.9) * 0.5 + 0.5;
    float lbS = aSway * aSway;
    transformed.x += lbS * (0.08 + 0.16 * lbW);
    transformed.z += lbS * 0.05 * sin(lbTime * 2.7 + lbIp.x * 3.1);
  }
#endif
#if defined(USE_COLOR) && defined(USE_INSTANCING_COLOR)
  vColor.rgb = color * mix(vec3(1.0), instanceColor.rgb, aTint);
#endif`,
    },
  });
  const mk = (g: BufferGeometry, cap: number): InstancedMesh => {
    const m = ctx.toon.instanced(g, mat, Math.max(1, cap), { cast: false, receive: true });
    m.castShadow = false;
    m.setColorAt(0, new Color(1, 1, 1));
    m.count = 0;
    m.frustumCulled = false; // bounds change with every gather
    m.visible = false;
    ctx.scene.add(m);
    return m;
  };
  const tufts = mk(geoT, capT);
  const flowers = mk(geoF, capF);
  const pebbles = mk(geoP, capP);
  tufts.name = 'groundcover:tufts';
  flowers.name = 'groundcover:flowers';
  pebbles.name = 'groundcover:pebbles';

  // Spatial buckets: detail-3 faces and the 4^k facets under each.
  const bucketDetail = Math.min(3, t.detail);
  const ico3 = icosphere(bucketDetail);
  const per = 4 ** (t.detail - bucketDetail);
  const nb = ico3.triangleCount;
  const bc = new Float32Array(nb * 3);
  let bucketRad = 0;
  for (let b = 0; b < nb; b++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) {
      const vi = ico3.indices[b * 3 + k];
      x += ico3.positions[vi * 3];
      y += ico3.positions[vi * 3 + 1];
      z += ico3.positions[vi * 3 + 2];
    }
    const l = Math.hypot(x, y, z);
    bc[b * 3] = x / l;
    bc[b * 3 + 1] = y / l;
    bc[b * 3 + 2] = z / l;
    for (let k = 0; k < 3; k++) {
      const vi = ico3.indices[b * 3 + k];
      const d = (ico3.positions[vi * 3] * x + ico3.positions[vi * 3 + 1] * y + ico3.positions[vi * 3 + 2] * z) / l;
      bucketRad = Math.max(bucketRad, Math.acos(Math.min(1, d)));
    }
  }
  const cosGather = Math.cos(bucketRad + (GATHER + 2) / R);

  const vcol = vertexColors(t);
  const I = t.ico.indices;
  const lastEye = new Vector3(1e9, 0, 0);
  const m4 = new Matrix4();
  const col = new Color();
  const p = { x: 0, y: 0, z: 0 };
  const q = { x: 0, z: 0 };
  const planR = ctx.world.city.radius;
  const index = ctx.world.cityIndex;
  const paths = createPathMask(ctx.world.city, index);
  let revealed = false;
  // v2 (H1): the region's built ground (Region.keepOut / surface): no flower or pebble on a road, a
  // verge, a town pad, a plaza, a runway; grass tufts only on open ground and on a verge's outer edge
  const region = ctx.world.region;
  const hit: SurfaceHit = { cls: 'free', roadDist: 0, edge: -1, settlement: -1 };
  const ud = { x: 0, y: 0, z: 0 };
  const unit = (v: { x: number; y: number; z: number }) => {
    const l = Math.hypot(v.x, v.y, v.z);
    ud.x = v.x / l;
    ud.y = v.y / l;
    ud.z = v.z / l;
    return ud;
  };
  const builtOn = (kind: number) => {
    region.surface(unit(p), hit);
    if (hit.cls === 'free') return false;
    return !(kind === 0 && hit.cls === 'verge' && hit.edge >= 0 && hit.roadDist > region.edges[hit.edge].width / 2 + 0.55);
  };

  /**
   * One facet's cover, built once and cached (deterministic per facet): instance matrices and
   * colours per kind. Tufts are [base…, extra…]: the extra ones only show within DENSE m.
   */
  interface FacetCover {
    tM: Float32Array;
    tC: Float32Array;
    tBase: number;
    tAll: number;
    fM: Float32Array;
    fC: Float32Array;
    nf: number;
    pM: Float32Array;
    pC: Float32Array;
    np: number;
  }
  const cache = new Map<number, FacetCover | null>();
  const CACHE_MAX = 2500;
  const BUILD_MAX = 160;
  let incomplete = false;
  const EMPTY = new Float32Array(0);
  const tmpM = new Float32Array(64 * 16);
  const tmpC = new Float32Array(64 * 3);

  function buildFacet(f: number): FacetCover | null {
    const biome = faceBiome(t, f);
    const rates = COVER[biome];
    if (!rates || faceMinHeight(t, f) < 0.06) return null;
    const slope = faceSlope(t, f);
    const steep = slope > 0.25 ? 0.35 : 1;
    // Ground colour of the facet, linear, for tufts that grow out of it.
    const a = I[f * 3];
    const gr = Math.pow(vcol[a * 3] / 255, 2.2), gg = Math.pow(vcol[a * 3 + 1] / 255, 2.2), gb = Math.pow(vcol[a * 3 + 2] / 255, 2.2);
    const inCityFace = t.plateau[a] >= 1;
    const field = (t.flower[a] + t.flower[I[f * 3 + 1]] + t.flower[I[f * 3 + 2]]) / 3;
    // A farmland flower field (yellow from the air): thick with buttercup and white heads.
    const bloomField = isFlowerField(t.field[a]);
    facePoint(t, f, 1 / 3, 1 / 3, p);
    const nearBuilt = region.keepOut(unit(p), 3) || nearForecourt(region, unit(p), 3);
    const out: FacetCover = { tM: EMPTY, tC: EMPTY, tBase: 0, tAll: 0, fM: EMPTY, fC: EMPTY, nf: 0, pM: EMPTY, pC: EMPTY, np: 0 };
    let any = false;
    for (let kind = 0; kind < 3; kind++) {
      const base = rates[kind] * density * (kind === 0 ? steep : 1);
      let rate = base;
      if (kind === 0) rate *= 1 + DENSE_EXTRA;
      if (kind === 1 && (biome === Biome.Meadow || biome === Biome.Grass)) rate += FIELD_FLOWERS * (bloomField ? 1 : field * field) * density;
      const whole = Math.floor(rate);
      const n = Math.min(64, whole + (hash3(f, kind, 0x401) < rate - whole ? 1 : 0));
      let k = 0;
      let kBase = 0;
      for (let s = 0; s < n; s++) {
        let u = hash3(f, s, 0x410 + kind);
        let v = hash3(f, s, 0x420 + kind);
        if (u + v > 1) {
          u = 1 - u;
          v = 1 - v;
        }
        facePoint(t, f, u, v, p);
        if (nearBuilt && (builtOn(kind) || nearForecourt(region, unit(p), 0.3))) continue;
        if (inCityFace) {
          fromSphere(p, q);
          if (Math.hypot(q.x, q.z) < planR) {
            const cls = index.classify(q.x, q.z);
            if (cls !== 'park' && cls !== 'garden' && cls !== 'free') continue;
            // Never on the park / garden paths the city draws over the lawns.
            if (cls !== 'free' && paths.onPath(q.x, q.z)) continue;
            // Bare plateau only well clear of paving (A2 may pave slivers next to buildings).
            if (cls === 'free' && (kind === 1 || index.groundH(q.x, q.z) > AREA_H + 0.01 || !index.isClear(q.x, q.z, 1.0))) continue;
          }
        }
        const r1 = hash3(f, s, 0x430 + kind);
        const yaw = hash3(f, s, 0x440 + kind) * Math.PI * 2;
        const pl = Math.hypot(p.x, p.y, p.z);
        const ux = p.x / pl, uy = p.y / pl, uz = p.z / pl;
        if (kind === 0) {
          const h = 0.2 + 0.24 * r1;
          composeUp(m4, p.x - ux * 0.02, p.y - uy * 0.02, p.z - uz * 0.02, ux, uy, uz, yaw, h * 1.15, h);
          const kk = 0.86 + 0.3 * hash3(f, s, 0x450);
          col.setRGB(gr * kk, gg * kk * 1.04, gb * kk * 0.92);
        } else if (kind === 1) {
          const h = 0.16 + 0.14 * r1;
          composeUp(m4, p.x, p.y, p.z, ux, uy, uz, yaw, h * 1.2, h);
          // A drift colour from the slow tone field, with a few strays.
          const drift = (t.tone[a] * 5.3 + t.jit[a] * 0.6 + 4) % 1;
          const pickC = hash3(f, s, 0x460) < 0.8 ? drift : hash3(f, s, 0x461);
          if (bloomField) col.copy(hash3(f, s, 0x462) < 0.75 ? FLOWERS[1] : FLOWERS[0]);
          else col.copy(FLOWERS[Math.min(FLOWERS.length - 1, Math.floor(pickC * FLOWERS.length))]);
        } else {
          const beach = biome === Biome.Beach;
          const h = beach ? 0.07 + 0.08 * r1 : 0.08 + 0.22 * r1 * r1;
          composeUp(m4, p.x - ux * h * 0.2, p.y - uy * h * 0.2, p.z - uz * h * 0.2, ux, uy, uz, yaw, h, h);
          const list = beach ? SHELL : PEBBLE;
          col.copy(list[Math.floor(hash3(f, s, 0x470) * list.length)]);
        }
        m4.toArray(tmpM, k * 16);
        col.toArray(tmpC, k * 3);
        k++;
        if (s < base) kBase = k;
      }
      if (!k) continue;
      any = true;
      const M = tmpM.slice(0, k * 16);
      const Cc = tmpC.slice(0, k * 3);
      if (kind === 0) {
        out.tM = M;
        out.tC = Cc;
        out.tAll = k;
        out.tBase = kBase;
      } else if (kind === 1) {
        out.fM = M;
        out.fC = Cc;
        out.nf = k;
      } else {
        out.pM = M;
        out.pC = Cc;
        out.np = k;
      }
    }
    return any ? out : null;
  }

  function gather(eye: Vector3) {
    const el = eye.length();
    const ex = eye.x / el, ey = eye.y / el, ez = eye.z / el;
    let nt = 0, nf = 0, np = 0;
    let built = 0;
    incomplete = false;
    const TM = tufts.instanceMatrix.array as Float32Array;
    const TC = tufts.instanceColor!.array as Float32Array;
    const FM = flowers.instanceMatrix.array as Float32Array;
    const FC = flowers.instanceColor!.array as Float32Array;
    const PM = pebbles.instanceMatrix.array as Float32Array;
    const PC = pebbles.instanceColor!.array as Float32Array;
    if (cache.size > CACHE_MAX) {
      // Forget facets well behind us (never a full rebuild of what is in range).
      for (const f of cache.keys()) {
        facePoint(t, f, 1 / 3, 1 / 3, p);
        if ((p.x - eye.x) ** 2 + (p.y - eye.y) ** 2 + (p.z - eye.z) ** 2 > 50 * 50) cache.delete(f);
      }
    }
    const far2 = (GATHER + 1.5) * (GATHER + 1.5);
    const dense2 = (DENSE + 1.5) * (DENSE + 1.5);
    for (let b = 0; b < nb; b++) {
      if (bc[b * 3] * ex + bc[b * 3 + 1] * ey + bc[b * 3 + 2] * ez < cosGather) continue;
      const f0 = b * per;
      for (let f = f0; f < f0 + per; f++) {
        facePoint(t, f, 1 / 3, 1 / 3, p);
        const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > far2) continue;
        let fc = cache.get(f);
        if (fc === undefined) {
          // Build at most BUILD_MAX new facets per gather (bounded frame cost); the rest next frame.
          if (built >= BUILD_MAX) {
            incomplete = true;
            continue;
          }
          cache.set(f, (fc = buildFacet(f)));
          built++;
        }
        if (!fc) continue;
        // Whole facets (the shader shrinks cover into the ground from FADE_FROM to FADE_TO m).
        const tn = Math.min(d2 < dense2 ? fc.tAll : fc.tBase, capT - nt);
        // Plain copy loops: subarray() views would allocate per facet per gather.
        if (tn > 0) {
          copy(fc.tM, TM, nt * 16, tn * 16);
          copy(fc.tC, TC, nt * 3, tn * 3);
          nt += tn;
        }
        const fn = Math.min(fc.nf, capF - nf);
        if (fn > 0) {
          copy(fc.fM, FM, nf * 16, fn * 16);
          copy(fc.fC, FC, nf * 3, fn * 3);
          nf += fn;
        }
        const pn = Math.min(fc.np, capP - np);
        if (pn > 0) {
          copy(fc.pM, PM, np * 16, pn * 16);
          copy(fc.pC, PC, np * 3, pn * 3);
          np += pn;
        }
      }
    }
    commit(tufts, nt);
    commit(flowers, nf);
    commit(pebbles, np);
  }

  function commit(mesh: InstancedMesh, n: number) {
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, n * 3);
    }
  }

  return {
    reveal(start: number) {
      mat.userData.lbUniforms.lbRevealDelay.value = start;
      revealed = true;
    },
    update(ctx: LBContext) {
      const show = revealed && ctx.view.altTerrain < SHOW_ALT;
      tufts.visible = flowers.visible = pebbles.visible = show;
      if (!show) return;
      const eye = ctx.view.eye;
      if (!incomplete && eye.distanceToSquared(lastEye) < MOVE * MOVE) return;
      lastEye.copy(eye);
      gather(eye);
    },
    dispose() {
      for (const m of [tufts, flowers, pebbles]) {
        m.removeFromParent();
        m.dispose();
      }
      geoT.dispose();
      geoF.dispose();
      geoP.dispose();
    },
  };
}

/** Copy the first n floats of src into dst at offset o (zero-alloc). */
function copy(src: Float32Array, dst: Float32Array, o: number, n: number) {
  for (let i = 0; i < n; i++) dst[o + i] = src[i];
}
