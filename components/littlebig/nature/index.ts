// Nature (A1): every tree on the planet (A2's city 'tree' features plus the terrain scatter),
// bushes, palms and rocks as instanced low-poly toon meshes, and the camera-local ground cover
// (grass tufts, flowers, pebbles) that fades in below ~20 m.
//
// One toon program for all of them (patch 'nature'; materials differ only in uniforms): per-instance
// crown colour on the tinted parts only (trunks keep their brown), a gentle wind sway that grows
// toward the tops (shadows sway with them), a warm bounce floor so trunks and crown undersides never
// go black, and two dither fades by camera altitude:
//   - LOD: round trees cross-fade between the near mesh and a lighter far mesh over LOD_FROM-LOD_TO
//     (complementary dither, so every pixel belongs to exactly one of them; shadows cross-fade too);
//     outside the band only one of the two draws.
//   - small casters (bushes, rocks) fade their shadows out over SMALL_SHADOW_* before they stop
//     casting.
// Instances are sorted into spatial chunks (nature/chunks.ts): chunks below the horizon or outside
// the inflated view frustum are dropped (the far side of the planet no longer draws at street level).
// Trees pop in as a wave spreading out from the city (aReveal from the scatter's `wave`).

import { Color, FrontSide, Frustum, InstancedBufferAttribute, type InstancedMesh, Matrix4, Sphere, Vector2, Vector3, type BufferGeometry } from 'three';
import type { LBContext, System } from '../core/contracts';
import { R } from '../world/config';
import { terrainData } from '../terrain/data';
import { extendToon, grazingShadowsWithOptOut, LOW_LIGHT_GRADE } from '../terrain/shader-ext';
import type { ToonMaterial, ToonPatch } from '../render/toon';
import { blobTreeGeometry, bushGeometry, coniferGeometry, lighthouseGeometry, palmGeometry, rockGeometry, WINDMILL_HUB, windmillGeometry } from './geometry';
import { createBeam, type Beam } from './beam';
import { createBoats, findBoatLoops, type Boats } from './boats';
import { findLandmarks } from './landmarks';
import { composeUp } from './frame';
import { createGroundCover, type GroundCover } from './ground-cover';
import { createNatureCollider } from './collide';
import { chunkAboveHorizon, chunkBounds, ChunkedKind, chunkOfFace, CHUNKS, type ChunkBounds } from './chunks';
import { NATURE_KINDS, NatureFlag, NatureKind, scatterNatureSteps, type NatureScatter } from './scatter';
import { hyp3 } from '../world/hyp';

/** Round trees: near mesh fully visible below LOD_FROM, far mesh fully visible above LOD_TO (altTerrain, m). */
const LOD_FROM = 110;
const LOD_TO = 170;
/** Bush and rock shadows dither out over this altitude band, then stop casting. */
const SMALL_SHADOW_FROM = 60;
const SMALL_SHADOW_TO = 110;

/** Shared vertex patch: per-instance tint on aTint parts, and wind sway by aSway. */
export const NATURE_PATCH_VERTEX_PARS = /* glsl */ `
attribute float aTint;
attribute float aSway;
attribute vec3 aSmoothN;
varying float vLbNoShadow;
varying float vLbGlow;`;
export const NATURE_PATCH_VERTEX = /* glsl */ `
vLbNoShadow = aSway < -0.5 ? 1.0 : 0.0;
vLbGlow = aTint < -0.5 ? 1.0 : 0.0;
#ifdef USE_INSTANCING
  {
    vec3 lbIp = instanceMatrix[3].xyz;
    float lbPh = dot(lbIp, vec3(0.21, 0.17, 0.23));
    if (aSway < -0.5) {
      // Windmill sails: spin about the hub (in the reveal's scaled space).
      #if defined(LB_REVEAL_INSTANCE) && !defined(LB_REVEAL_FADE)
        float lbK = lbSpring(vLbReveal);
      #else
        float lbK = 1.0;
      #endif
      vec2 lbHub = vec2(${WINDMILL_HUB[0].toFixed(3)}, ${WINDMILL_HUB[1].toFixed(3)}) * lbK;
      float lbA = lbTime * (0.62 + 0.3 * fract(lbPh * 3.7)) + lbPh * 7.0;
      vec2 lbD = transformed.xy - lbHub;
      transformed.xy = lbHub + vec2(lbD.x * cos(lbA) - lbD.y * sin(lbA), lbD.x * sin(lbA) + lbD.y * cos(lbA));
    } else {
      float lbS = aSway * aSway * vLbReveal;
      transformed.x += (sin(lbTime * 1.4 + lbPh) * 0.6 + sin(lbTime * 2.3 + lbPh * 1.7) * 0.4) * lbS * 0.024;
      transformed.z += cos(lbTime * 1.1 + lbPh * 1.3) * lbS * 0.017;
    }
    #ifdef LB_NATURE_COLOR
      float lbSm = 0.92 * (1.0 - smoothstep(35.0, 70.0, distance(lbIp, lbCamPos)));
      if (lbSm > 0.0) {
        mat3 lbIm = mat3(instanceMatrix);
        vec3 lbSn = aSmoothN / vec3(dot(lbIm[0], lbIm[0]), dot(lbIm[1], lbIm[1]), dot(lbIm[2], lbIm[2]));
        vNormal = normalize(mix(vNormal, normalize(normalMatrix * (lbIm * lbSn)), lbSm));
      }
    #endif
  }
#endif
#if defined(USE_COLOR) && defined(USE_INSTANCING_COLOR)
  vColor.rgb = color * mix(vec3(1.0), instanceColor.rgb, max(aTint, 0.0));
#endif`;

const NATURE_FRAGMENT_PARS = /* glsl */ `
varying float vLbNoShadow;
varying float vLbGlow;
uniform vec3 uLod;
uniform vec2 uShFade;
// LOD cross-fade (uLod: from, to, mode 1 = near mesh, 2 = far mesh): complementary dither, so a
// pixel is drawn by exactly one of the two meshes at any altitude.
bool lbLodCull() {
  if (uLod.z < 0.5) return false;
  float s = lbSmooth01((lbCamAlt - uLod.x) / (uLod.y - uLod.x));
  float b = lbBayer4(gl_FragCoord.xy);
  return uLod.z < 1.5 ? (1.0 - s) < b : (1.0 - s) >= b;
}`;
const NATURE_FRAGMENT = /* glsl */ `
  if (lbLodCull()) discard;
  {
    // Warm bounce from the SUNLIT ground: lifts shaded trunks and crown undersides (cozy, never
    // near-black) without flattening the toon bands on the lit side. Only while the sun is well up
    // over the fragment: at dusk and at night nature gets exactly the toon kit's fill, like the city.
    vec3 lbNw = inverseTransformDirection(normal, viewMatrix);
    vec3 lbUpN = normalize(vLbWorld);
    float lbDown = clamp(-dot(lbNw, lbUpN) * 0.7 + 0.3, 0.0, 1.0);
    outgoingLight += diffuseColor.rgb * lbGroundFill * (0.55 * lbDown) * smoothstep(0.05, 0.3, dot(lbUpN, lbSunDir));
  }
  ${LOW_LIGHT_GRADE}
  outgoingLight += vLbGlow * vec3(1.0, 0.66, 0.32) * 1.4 * smoothstep(0.35, 0.8, lbNightAt(vLbWorld));`;
const NATURE_DEPTH = /* glsl */ `
  if (lbLodCull()) discard;
  if (uShFade.y > uShFade.x && 1.0 - lbSmooth01((lbCamAlt - uShFade.x) / (uShFade.y - uShFade.x)) < lbBayer4(gl_FragCoord.xy)) discard;`;

function naturePatch(lod: Vector3, shadowFade: Vector2): ToonPatch {
  return {
    key: 'nature',
    vertexPars: NATURE_PATCH_VERTEX_PARS,
    vertex: NATURE_PATCH_VERTEX,
    fragmentPars: NATURE_FRAGMENT_PARS,
    fragment: NATURE_FRAGMENT,
    depthFragment: NATURE_DEPTH,
    uniforms: { uLod: { value: lod }, uShFade: { value: shadowFade } },
  };
}

const pal = (...hex: string[]) => hex.map((h) => new Color(h));
const CROWN = pal('#5DBB4C', '#4FAE4A', '#76C952', '#43A148', '#8BCF57', '#68C350');
const CROWN_CITY = pal('#6BC650', '#58B74C', '#84D158', '#4DAA4A');
const AUTUMN = pal('#F2A23C', '#EE8A3C', '#F2CC5B', '#E9B44C');
const CONIFER = pal('#2F8F4E', '#3B9A55', '#2A8550', '#45A35A');
const CONIFER_DARK = pal('#24704A', '#2A7A4C', '#1F6645');
const SNOWY = pal('#A9D3C0', '#BFE0D2', '#93C6B0');
const PALM = pal('#4CB04A', '#5EC24E', '#6BCB57');
const BUSH = pal('#4FAE4A', '#62BD4E', '#3E9E48', '#77C552');
const BLOOM = pal('#F7A8C8', '#FFD9E6', '#FFE7A0');
const HEDGE = pal('#3E9443', '#4A9E46', '#358C40', '#52A94B');
const ROCK = pal('#A39A92', '#948E8B', '#B3AAA1', '#8A8480');
/** Windmill caps (the palette's roofs) and heights relative to 9 m. */
const MILL_ROOF = pal('#D9483B', '#5B6B8C', '#5BA35B');
const MILL_SCALE = [1, 0.86, 1.14];

function pick(list: Color[], t: number): Color {
  return list[Math.min(list.length - 1, Math.floor(t * list.length))];
}

function upload(attr: InstancedBufferAttribute, n: number) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n * attr.itemSize);
  attr.needsUpdate = true;
}

const _m = new Matrix4();

const _c = new Color();
const _pm = new Matrix4();
const _frustum = new Frustum();
const _sphere = new Sphere();

/** One kind's live meshes (near, and for round trees the far LOD) and its chunked instance data. */
interface KindSet {
  meshes: InstancedMesh[];
  chunked: ChunkedKind;
  masterM: Float32Array;
  masterC: Float32Array;
  masterR: Float32Array;
  reveal: InstancedBufferAttribute;
  count: number;
}

export function createNatureSystem(): System {
  const geos: BufferGeometry[] = [];
  const meshes: InstancedMesh[] = [];
  const kinds: KindSet[] = [];
  /** Bushes and rocks: their shadows fade out with altitude. */
  const smallCasters: InstancedMesh[] = [];
  let bounds: ChunkBounds | null = null;
  const vis = new Uint8Array(CHUNKS);
  const visNext = new Uint8Array(CHUNKS);
  let compacted = false;
  /** The camera (world matrix + projection) the chunk culling last ran for: unchanged ⇒ skip it. */
  const lastCam = new Float64Array(18);
  let cover: GroundCover | null = null;
  let beam: Beam | null = null;
  let boats: Boats | null = null;

  function compactAll() {
    for (const k of kinds) {
      const m0 = k.meshes[0];
      const n = k.chunked.compact(vis, k.masterM, m0.instanceMatrix.array as Float32Array, 16);
      k.chunked.compact(vis, k.masterC, m0.instanceColor!.array as Float32Array, 3);
      k.chunked.compact(vis, k.masterR, k.reveal.array as Float32Array, 1);
      k.count = n;
      upload(m0.instanceMatrix, n);
      upload(m0.instanceColor!, n);
      upload(k.reveal, n);
      for (let i = 0; i < k.meshes.length; i++) k.meshes[i].count = n;
    }
  }

  return {
    name: 'nature',
    stage: 2,
    async init(ctx: LBContext) {
      const t = terrainData(ctx.world.planet, ctx.q.terrainDetail);
      const marks = findLandmarks(ctx.world.planet, t);
      const lh = marks.find((m) => m.kind === 'lighthouse');
      const boatLoops = findBoatLoops(ctx.world.planet, [
        { dir: ctx.world.planet.cityDir, dists: [96, 104, 112, 122, 134, 148], count: 3 },
        ...(lh ? [{ dir: lh.dir, dists: [16, 22, 30, 40, 52], count: 2, fish: true }] : []),
      ]);
      await ctx.yield();
      const avoid = marks.map((m) => ({ x: m.dir.x * (R + m.h), y: m.dir.y * (R + m.h), z: m.dir.z * (R + m.h), r: m.kind === 'windmill' ? 11 : 5 }));
      const steps = scatterNatureSteps({ terrain: t, city: ctx.world.city, cityIndex: ctx.world.cityIndex, cityDir: ctx.world.planet.cityDir, density: ctx.q.density, avoid });
      let s: NatureScatter;
      for (;;) {
        const r = steps.next();
        if (r.done) {
          s = r.value;
          break;
        }
        await ctx.yield();
      }

      // One program, four uniform sets: plain, near LOD, far LOD, small casters.
      const mk = (name: string, lod: Vector3, sh: Vector2): ToonMaterial => {
        const m = ctx.toon.material({ name, vertexColors: true, reveal: 'instance', revealDuration: 0.65, rim: 0.3, patch: naturePatch(lod, sh) });
        extendToon(m, grazingShadowsWithOptOut);
        // Colour pass only (the shadow depth twin has no vNormal): the smooth-normal blend.
        m.defines = { ...m.defines, LB_NATURE_COLOR: '' };
        return m;
      };
      const matBase = mk('nature', new Vector3(0, 1, 0), new Vector2(0, 0));
      const matNear = mk('nature:near', new Vector3(LOD_FROM, LOD_TO, 1), new Vector2(0, 0));
      const matFar = mk('nature:far', new Vector3(LOD_FROM, LOD_TO, 2), new Vector2(0, 0));
      const matSmall = mk('nature:small', new Vector3(0, 1, 0), new Vector2(SMALL_SHADOW_FROM, SMALL_SHADOW_TO));
      // Bushes and rocks sit ON the ground: three's default shadow side (back faces) put their
      // undersides, level with the ground, into the map, so the ground under the middle stayed lit
      // and the shadow was a hollow ring. Their sun-facing tops cast instead (normalBias and the
      // grazing fade keep the lit side clean).
      matSmall.shadowSide = FrontSide;

      const kindGeo: BufferGeometry[] = [];
      kindGeo[NatureKind.Blob0] = blobTreeGeometry(0);
      kindGeo[NatureKind.Blob1] = blobTreeGeometry(1);
      kindGeo[NatureKind.Conifer] = coniferGeometry();
      kindGeo[NatureKind.Palm] = palmGeometry();
      kindGeo[NatureKind.Bush] = bushGeometry();
      kindGeo[NatureKind.Rock] = rockGeometry(7);
      for (const g of kindGeo) geos.push(ctx.track(g));
      // Far LOD for the round trees (most of the planet's triangles), cross-faded in by altitude.
      const farGeo: BufferGeometry[] = [];
      farGeo[NatureKind.Blob0] = ctx.track(blobTreeGeometry(0, 1));
      farGeo[NatureKind.Blob1] = ctx.track(blobTreeGeometry(1, 1));
      geos.push(farGeo[NatureKind.Blob0], farGeo[NatureKind.Blob1]);

      // Per-instance chunk ids and heights (for the chunk bounds).
      const chunkOf = new Int32Array(s.count);
      for (let i = 0; i < s.count; i++) chunkOf[i] = chunkOfFace(s.face[i], t.detail);
      const chunkB = chunkBounds(s.pos, chunkOf, s.h, s.count, R);

      const counts = new Array<number>(NATURE_KINDS).fill(0);
      for (let i = 0; i < s.count; i++) counts[s.kind[i]]++;
      const byKind: Array<KindSet | undefined> = [];
      const local = new Array<number>(s.count);
      const kindChunks: Int32Array[] = [];
      const fill = new Array<number>(NATURE_KINDS).fill(0);
      for (let k = 0; k < NATURE_KINDS; k++) kindChunks[k] = new Int32Array(counts[k]);
      for (let i = 0; i < s.count; i++) {
        const k = s.kind[i];
        local[i] = fill[k]++;
        kindChunks[k][local[i]] = chunkOf[i];
      }
      for (let k = 0; k < NATURE_KINDS; k++) {
        const n = counts[k];
        if (!n) continue;
        const lod = !!farGeo[k];
        const small = k === NatureKind.Bush || k === NatureKind.Rock;
        const near = ctx.toon.instanced(kindGeo[k], lod ? matNear : small ? matSmall : matBase, n, { cast: true, receive: true });
        near.name = `nature:${k}`;
        near.setColorAt(0, _c.setRGB(1, 1, 1));
        const reveal = new InstancedBufferAttribute(new Float32Array(n).fill(1e6), 1);
        kindGeo[k].setAttribute('aReveal', reveal);
        const set: KindSet = {
          meshes: [near],
          chunked: new ChunkedKind(kindChunks[k], n),
          masterM: new Float32Array(n * 16),
          masterC: new Float32Array(n * 3),
          masterR: new Float32Array(n).fill(1e6),
          reveal,
          count: n,
        };
        if (lod) {
          const far = ctx.toon.instanced(farGeo[k], matFar, n, { cast: true, receive: true });
          far.name = `nature:${k}:far`;
          far.instanceMatrix = near.instanceMatrix;
          far.instanceColor = near.instanceColor;
          farGeo[k].setAttribute('aReveal', reveal);
          set.meshes.push(far);
        }
        if (small) smallCasters.push(near);
        for (const m of set.meshes) {
          m.frustumCulled = false; // culled per chunk here
          meshes.push(m);
        }
        byKind[k] = set;
        kinds.push(set);
      }

      // Master arrays in chunk order: slot of instance i = position of local[i] in its kind's order.
      const slot = new Array<number>(s.count);
      for (let k = 0; k < NATURE_KINDS; k++) {
        const set = byKind[k];
        if (!set) continue;
        const inv = new Int32Array(counts[k]);
        for (let j = 0; j < set.chunked.order.length; j++) inv[set.chunked.order[j]] = j;
        for (let i = 0; i < s.count; i++) if (s.kind[i] === k) slot[i] = inv[local[i]];
      }
      const I = t.ico.indices;
      const N = t.normal;
      for (let i = 0; i < s.count; i++) {
        const k = s.kind[i];
        const set = byKind[k]!;
        const j = slot[i];
        const x = s.pos[i * 3], y = s.pos[i * 3 + 1], z = s.pos[i * 3 + 2];
        const len = hyp3(x, y, z);
        let ux = x / len, uy = y / len, uz = z / len;
        // Sunk into the facet so nothing hovers over a slope (bushes: their lowest lumps' rims).
        let sink = k === NatureKind.Bush ? 0.08 + 0.1 * s.h[i] : 0.06;
        if (k === NatureKind.Rock && s.face[i] >= 0) {
          // Rocks lean into the slope they lie on and sit partly buried.
          const f = s.face[i];
          let nx = 0, ny = 0, nz = 0;
          for (let c = 0; c < 3; c++) {
            const vi = I[f * 3 + c];
            nx += N[vi * 3];
            ny += N[vi * 3 + 1];
            nz += N[vi * 3 + 2];
          }
          const nl = hyp3(nx, ny, nz) || 1;
          ux = ux * 0.35 + (nx / nl) * 0.65;
          uy = uy * 0.35 + (ny / nl) * 0.65;
          uz = uz * 0.35 + (nz / nl) * 0.65;
          const ul = hyp3(ux, uy, uz);
          ux /= ul;
          uy /= ul;
          uz /= ul;
          sink = 0.18 * s.h[i];
        } else if (k !== NatureKind.Bush && s.face[i] >= 0) {
          sink = 0.25; // trunks on slopes: no floating downhill edge
        }
        // Hedge segments: long along the row, narrower across it (stretch = length / width).
        const st = s.stretch[i];
        composeUp(_m, x - ux * sink, y - uy * sink, z - uz * sink, ux, uy, uz, s.yaw[i], s.w[i] * Math.sqrt(st), k === NatureKind.Rock ? s.h[i] * 0.8 : s.h[i], s.w[i] / Math.sqrt(st));
        _m.toArray(set.masterM, j * 16);
        colorFor(k, s.tone[i], s.flags[i], i).toArray(set.masterC, j * 3);
        set.masterR[j] = s.wave[i]; // reveal order for now; turned into clock times after compile
      }
      const waves = kinds.map((k) => k.masterR.slice());
      for (const k of kinds) k.masterR.fill(1e6);
      vis.fill(1);
      compactAll();
      for (const k of kinds) for (const m of k.meshes) ctx.scene.add(m);

      // Landmarks: windmills (sails spin in the nature shader) and the lighthouse with its beam.
      const markMeshes: Array<{ mesh: InstancedMesh; wave: number[] }> = [];
      const windmills = marks.filter((m) => m.kind === 'windmill');
      const lighthouse = marks.find((m) => m.kind === 'lighthouse');
      const addMarks = (geo: BufferGeometry, list: typeof marks, height: number) => {
        if (!list.length) return;
        geos.push(ctx.track(geo));
        const mesh = ctx.toon.instanced(geo, matBase, list.length, { cast: true, receive: true });
        mesh.name = `nature:${list[0].kind}`;
        const wave: number[] = [];
        list.forEach((m, j) => {
          const r = R + m.h - 0.15;
          // Windmills are siblings, not clones: ±15 % in height, each its own roof colour.
          const hj = m.kind === 'windmill' ? height * MILL_SCALE[j % 3] : height;
          composeUp(_m, m.dir.x * r, m.dir.y * r, m.dir.z * r, m.dir.x, m.dir.y, m.dir.z, m.yaw, hj, hj);
          mesh.setMatrixAt(j, _m);
          mesh.setColorAt(j, m.kind === 'windmill' ? MILL_ROOF[j % 3] : _c.setRGB(1, 1, 1));
          wave.push(0.1 + 0.05 * j);
        });
        mesh.geometry.setAttribute('aReveal', new InstancedBufferAttribute(new Float32Array(list.length).fill(1e6), 1));
        mesh.computeBoundingSphere();
        ctx.scene.add(mesh);
        meshes.push(mesh);
        markMeshes.push({ mesh, wave });
      };
      addMarks(windmillGeometry(), windmills, 9);
      if (lighthouse) {
        addMarks(lighthouseGeometry(), [lighthouse], 11);
        const r = R + lighthouse.h + 11 * 0.8;
        beam = createBeam(ctx, lighthouse.dir.x * r, lighthouse.dir.y * r, lighthouse.dir.z * r, lighthouse.dir);
      }
      // Boats: three sailboats off the city's coast, a sailboat and a fishing boat by the lighthouse
      // (loops found before anything entered the scene: no frame may draw it before ctx.compile()).
      boats = createBoats(ctx, matBase, boatLoops);

      // Trunk and boulder discs of the countryside scatter for FPV collision (city trees are
      // CityIndex obstacles already).
      const cdirs = new Float32Array(s.count * 3);
      const crad = new Float32Array(s.count);
      let nc = 0;
      for (let i = 0; i < s.count; i++) {
        if (s.face[i] < 0) continue;
        const k = s.kind[i];
        let r = 0;
        if (k === NatureKind.Blob0 || k === NatureKind.Blob1) r = Math.max(0.35, 0.09 * s.w[i]);
        else if (k === NatureKind.Conifer) r = 0.35;
        else if (k === NatureKind.Palm) r = 0.3;
        else if (k === NatureKind.Rock && s.h[i] > 1.1) r = 0.4 * s.w[i];
        if (!r) continue;
        const x = s.pos[i * 3], y = s.pos[i * 3 + 1], z = s.pos[i * 3 + 2];
        const l = hyp3(x, y, z);
        cdirs[nc * 3] = x / l;
        cdirs[nc * 3 + 1] = y / l;
        cdirs[nc * 3 + 2] = z / l;
        crad[nc++] = r;
      }
      const collider = createNatureCollider(cdirs, crad, nc, R + 2);

      cover = createGroundCover(ctx, t);
      await ctx.compile();
      const dur = 1.7;
      const start = ctx.reveal.slot(dur);
      kinds.forEach((k, ki) => {
        const w = waves[ki];
        for (let j = 0; j < w.length; j++) k.masterR[j] = start + w[j] * (dur - 0.65);
      });
      compacted = false; // recompact (with the reveal times) on the next update
      bounds = chunkB;
      for (const { mesh, wave } of markMeshes) {
        const attr = mesh.geometry.getAttribute('aReveal') as InstancedBufferAttribute;
        const arr = attr.array as Float32Array;
        for (let j = 0; j < wave.length; j++) arr[j] = start + wave[j] * dur;
        attr.needsUpdate = true;
      }
      beam?.reveal(start + 0.5);
      boats?.reveal(start + 0.6);
      cover?.reveal(start + 0.4);
      ctx.services.nature = collider;
    },
    update(ctx: LBContext) {
      const alt = ctx.view.altTerrain;
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      if (bounds && (!compacted || camMoved(lastCam, cam.matrixWorld.elements, cam.projectionMatrix.elements))) {
        // Chunk culling: the horizon (with the chunk's tallest top) and the view frustum, inflated
        // so shadows cast into view from just outside it stay; hysteresis against flicker. Skipped
        // while the camera holds still (nothing to re-test).
        const eye = ctx.view.eye;
        const de = eye.length();
        const ex = eye.x / de, ey = eye.y / de, ez = eye.z / de;
        const hor = Math.acos(Math.min(1, R / de));
        _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
        let changed = !compacted;
        const B = bounds;
        for (let c = 0; c < CHUNKS; c++) {
          let v = 0;
          if (B.used[c]) {
            const was = vis[c] === 1;
            if (chunkAboveHorizon(B, c, ex, ey, ez, hor, was ? 0.05 : 0.02)) {
              _sphere.center.set(B.sphere[c * 4], B.sphere[c * 4 + 1], B.sphere[c * 4 + 2]);
              _sphere.radius = B.sphere[c * 4 + 3] + (was ? 40 : 32);
              v = _frustum.intersectsSphere(_sphere) ? 1 : 0;
            }
          }
          visNext[c] = v;
          if (v !== vis[c]) changed = true;
        }
        if (changed) {
          vis.set(visNext);
          compactAll();
          compacted = true;
        }
      }
      // LOD band: outside it only one of the near / far meshes draws. Empty meshes never draw.
      const showNear = alt < LOD_TO;
      const showFar = alt > LOD_FROM;
      for (let i = 0; i < kinds.length; i++) {
        const k = kinds[i];
        const on = k.count > 0;
        if (k.meshes.length === 1) k.meshes[0].visible = on;
        else {
          k.meshes[0].visible = on && showNear;
          k.meshes[1].visible = on && showFar;
        }
      }
      const cast = alt < SMALL_SHADOW_TO;
      for (let i = 0; i < smallCasters.length; i++) smallCasters[i].castShadow = cast;
      cover?.update(ctx);
      boats?.update(ctx);
    },
    dispose(ctx: LBContext) {
      if (ctx.services.nature) ctx.services.nature = undefined;
      for (const g of geos) g.dispose();
      for (const m of meshes) {
        m.removeFromParent();
        m.dispose();
      }
      geos.length = 0;
      meshes.length = 0;
      kinds.length = 0;
      smallCasters.length = 0;
      bounds = null;
      cover?.dispose();
      cover = null;
      beam?.dispose();
      beam = null;
      boats?.dispose();
      boats = null;
    },
  };
}

function camMoved(_lastCam: Float64Array, w: ArrayLike<number>, p: ArrayLike<number>): boolean {
  let moved = false;
  for (let i = 0; i < 16; i++) {
    if (_lastCam[i] !== w[i]) {
      _lastCam[i] = w[i];
      moved = true;
    }
  }
  if (_lastCam[16] !== p[0] || _lastCam[17] !== p[5]) {
    _lastCam[16] = p[0];
    _lastCam[17] = p[5];
    moved = true;
  }
  return moved;
}

function colorFor(kind: number, tone: number, flags: number, i: number): Color {
  const t2 = ((i * 0.6180339) % 1 + tone * 0.37) % 1;
  switch (kind) {
    case NatureKind.Blob0:
    case NatureKind.Blob1:
      if (flags & NatureFlag.Autumn) return _c.copy(pick(AUTUMN, t2));
      return _c.copy(pick(flags & NatureFlag.City ? CROWN_CITY : CROWN, t2));
    case NatureKind.Conifer:
      if (flags & NatureFlag.Snowy) return _c.copy(pick(SNOWY, t2));
      return _c.copy(pick(flags & NatureFlag.Dark ? CONIFER_DARK : CONIFER, t2));
    case NatureKind.Palm:
      return _c.copy(pick(PALM, t2));
    case NatureKind.Bush:
      if (flags & NatureFlag.Hedge) return _c.copy(pick(HEDGE, t2));
      return flags & NatureFlag.Bloom ? _c.copy(pick(BLOOM, t2)) : _c.copy(pick(BUSH, t2));
    default:
      return _c.copy(pick(ROCK, t2));
  }
}
