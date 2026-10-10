// The roads system (v2, H1): the whole region network drawn at the capital's quality. Three merged
// meshes on the city's own programs (cityPatch: one compile shared with the capital) — the paved
// ground (asphalt, kerbs and sidewalks, plazas, squares, yards, quays, runways), its paint (polygon
// offset), and the structures (bridges, sea walls, piers, lamps, monuments) — each split by land
// mass so the far continent costs nothing from the near side; plus the night: a spark at every lamp
// head (from orbit the roads are strings of light between the towns' glow) and a warm pool on the
// ground under each streetlight. Built after the world is up, time-sliced; the ground rolls out from
// the capital along the network as the reveal.

import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, Points, ShaderMaterial, Vector2, type Material } from 'three';
import { LAYER_NO_INK, type LBContext, type System } from '../core/contracts';
import { Geo } from '../city/geo';
import { cityPatch } from '../city/shader';
import { LB_COMMON_GLSL } from '../render/toon';
import { terrainData } from '../terrain/data';
import { R } from '../world/config';
import { v3, type Vec3 } from '../world/sphere';
import { cross, offsetDir, tangentOf } from './geom';
import { ASPH, buildGround, groundOf, PAVE, QUAY_H, WALK } from './ground';
import { lampLayout, lampLight, RURAL_REACH, type Lamp } from './lamps';
import { meshHeight } from './mesh';
import { buildStructures } from './struct';

const REVEAL = 2.4;

const poolVert = /* glsl */ `
${LB_COMMON_GLSL}
attribute vec3 aPool;
varying vec3 vPool;
varying vec3 vWorld;
void main() {
  vPool = aPool;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const poolFrag = /* glsl */ `
${LB_COMMON_GLSL}
uniform float uReveal;
varying vec3 vPool;
varying vec3 vWorld;
void main() {
  float r2 = dot(vPool.xy, vPool.xy);
  if (r2 >= 1.0) discard;
  float w = (1.0 - r2) * (1.0 - r2);
  float k = w / (1.0 + 7.0 * r2);
  vec3 col = mix(vec3(1.0, 0.479, 0.074), vec3(1.0, 0.693, 0.352), smoothstep(0.35, 1.0, k));
  gl_FragColor = vec4(col * k * vPool.z * lbNightAt(vWorld) * 0.75 * uReveal * (1.0 - smoothstep(120.0, 200.0, lbCamAlt)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
const pointVert = /* glsl */ `
${LB_COMMON_GLSL}
uniform vec2 uViewport;
attribute vec4 aTint;
varying vec4 vTint;
varying float vCore;
varying float vHalo;
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vec3 toCam = lbCamPos - w.xyz;
  float d = length(toCam);
  w.xyz += toCam / max(d, 1e-3) * min(0.35, d * 0.0025);
  vec4 mv = viewMatrix * w;
  gl_Position = projectionMatrix * mv;
  float pxPerM = projectionMatrix[1][1] * uViewport.y * 0.5 / max(-mv.z, 0.1);
  float orb = smoothstep(150.0, 320.0, lbCamAlt);
  float px = mix(clamp(aTint.w * pxPerM * 3.0, 4.0, 9.0), 12.0, orb);
  vCore = mix(2.4, 4.0, orb) / px;
  vHalo = mix(0.45, 0.8, orb);
  vTint = vec4(aTint.rgb, smoothstep(20.0, 44.0, d));
  gl_PointSize = px;
  if (vTint.w <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const pointFrag = /* glsl */ `
${LB_COMMON_GLSL}
uniform float uReveal;
varying vec4 vTint;
varying float vCore;
varying float vHalo;
varying vec3 vWorld;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(vCore * 0.7, vCore, r);
  float halo = (1.0 - r) * (1.0 - r);
  vec3 c = (vTint.rgb * core * 2.2 + vTint.rgb * vec3(1.0, 0.62, 0.22) * halo * vHalo) * lbNightAt(vWorld) * vTint.w * uReveal;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A slice of a merged Geo: the triangles of one land mass, with its cap for horizon culling. */
interface Part {
  mesh: Mesh;
  dir: Vec3;
  rad: number;
  top: number;
}

export function createRoadsSystem(): System {
  const disposables: Array<{ dispose(): void }> = [];
  const parts: Part[] = [];
  let poolMat: ShaderMaterial | null = null;
  let pointMat: ShaderMaterial | null = null;
  let revealStart = 0;
  let show = true;
  let unsub: (() => void) | null = null;
  let night: Array<Points | Mesh> = [];
  const vp = new Vector2();
  return {
    name: 'roads',
    stage: 2,
    async init(ctx: LBContext) {
      const region = ctx.world.region;
      // (review: --p roads.show=false hides the whole system, for A/B perf and before / after shots)
      show = ctx.params.toggle('roads.show', { label: 'roads: show', value: true }).value;
      unsub = ctx.params.onChange((p) => {
        if (p.key !== 'roads.show') return;
        show = !!p.value;
        for (const o of night) o.visible = show;
      });
      const ground = groundOf(region, meshHeight(terrainData(ctx.world.planet, ctx.q.terrainDetail)));
      const tick = () => ctx.yield();
      const G = new Geo(1 << 16);
      const P = new Geo(1 << 14);
      const S = new Geo(1 << 15);
      const lights: number[] = [];
      await buildGround({ region, ground, G, P, lights, tick });
      const lamps = lampLayout(region, WALK, PAVE, QUAY_H);
      await tick();
      await buildStructures({ region, ground, S, lamps, tick });

      // reveal: the network rolls out from the capital (per vertex; structures by their pivots)
      const cd = ctx.world.planet.cityDir;
      const wave = (a: Float32Array, i: number) => {
        const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
        const ang = Math.acos(Math.min(1, (x * cd.x + y * cd.y + z * cd.z) / (Math.hypot(x, y, z) || 1)));
        return 0.15 + Math.min(1.6, Math.max(0, ang * R - 80) / 220);
      };
      for (const g of [G, P]) for (let i = 0; i < g.n; i++) g.rev[i] = wave(g.pos, i) + (g === P ? 0.12 : 0);
      for (let i = 0; i < S.n; i++) S.rev[i] = wave(S.base, i) + 0.25;
      await tick();

      const late = { value: 0 };
      const groundMat = ctx.toon.material({ name: 'roads:ground', vertexColors: true, reveal: 'instance', revealDuration: 0.55, rim: 0, patch: cityPatch(true, late) });
      const paintMat = ctx.toon.material({ name: 'roads:paint', vertexColors: true, reveal: 'instance', revealDuration: 0.55, rim: 0, patch: cityPatch(true, late) });
      const buildMat = ctx.toon.material({ name: 'roads:build', vertexColors: true, reveal: 'instance', revealDuration: 0.8, rim: 0.32, patch: cityPatch(false, late) });
      paintMat.polygonOffset = true;
      paintMat.polygonOffsetFactor = -1;
      paintMat.polygonOffsetUnits = -4;
      buildMat.shadowSide = DoubleSide;
      const centres = componentCentres(region);
      for (const [g, mat, cast, order] of [
        [G, groundMat, false, -2],
        [P, paintMat, false, -1],
        [S, buildMat, true, -3],
      ] as const) {
        for (const part of split(ctx, g, centres.length, (x, y, z) => nearest(centres, x, y, z))) {
          const mesh = ctx.toon.mesh(part.geo, mat, { cast, receive: true });
          mesh.name = mat.name;
          mesh.renderOrder = order;
          mesh.matrixAutoUpdate = false;
          ctx.scene.add(mesh);
          parts.push({ mesh, dir: part.dir, rad: part.rad, top: part.top });
        }
      }

      // ── night: lamp sparks and pools ──
      const pts: number[] = [];
      const tint: number[] = [];
      const poolPos: number[] = [];
      const poolAttr: number[] = [];
      const idx: number[] = [];
      const q = v3();
      for (let li = 0; li < lamps.length; li++) {
        const l = lamps[li];
        const base = Number.isNaN(l.base) ? ground(l.q) + l.layer : l.base;
        const hh = lampLight(l, base, q);
        pts.push(q.x * (R + hh), q.y * (R + hh), q.z * (R + hh));
        tint.push(1, 0.78, 0.45, l.kind === 1 ? 0.7 : 0.8);
        if (!Number.isNaN(l.base)) continue; // (no pool on a bridge or a pier: it would hang over the water)
        // (a streetlight's centred just off its pole, as the capital's; a country lamp's out over the road)
        const pr = l.kind === 1 ? 2.6 : l.kind ? 4.6 : 4.8;
        const c = v3(q.x, q.y, q.z);
        if (l.kind !== 1) offsetDir(l.q, l.arm, l.kind ? RURAL_REACH + 0.5 : 0.3, base, c);
        const gain = 0.75 + 0.5 * ((li * 0.618) % 1);
        poolGrid(c, pr, gain, (pq) => poolHeight(ground, pq, l));
      }
      function poolGrid(c: Vec3, r: number, gain: number, h: (q: Vec3) => number) {
        const N = 8;
        const first = poolPos.length / 3;
        const n = tangentOf(c), e = cross(n, c);
        for (let j = 0; j <= N; j++) {
          for (let i = 0; i <= N; i++) {
            const u = (i / N) * 2 - 1, w = (j / N) * 2 - 1;
            const pq = offsetDir(offsetDir(c, e, u * r, 0, v3()), n, w * r, 0, v3());
            const y = h(pq) + 0.025;
            poolPos.push(pq.x * (R + y), pq.y * (R + y), pq.z * (R + y));
            poolAttr.push(u, w, gain);
          }
        }
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            const a = first + j * (N + 1) + i;
            // (u runs east, w north: counter-clockwise from above)
            idx.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
          }
        }
      }
      // the airfields' lights (ground.ts: runway edges, thresholds, the taxiway)
      for (let i = 0; i < lights.length; i += 7) pts.push(lights[i], lights[i + 1], lights[i + 2]), tint.push(lights[i + 3], lights[i + 4], lights[i + 5], lights[i + 6]);
      const pg = ctx.track(new BufferGeometry());
      pg.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
      pg.setAttribute('aTint', new BufferAttribute(new Float32Array(tint), 4));
      pg.computeBoundingSphere();
      pointMat = ctx.track(
        new ShaderMaterial({ name: 'roads:lamp-points', vertexShader: pointVert, fragmentShader: pointFrag, uniforms: { ...ctx.uniforms, uReveal: { value: 1 }, uViewport: { value: new Vector2(1280, 800) } }, transparent: true, depthWrite: false, blending: AdditiveBlending }),
      );
      const points = new Points(pg, pointMat);
      points.name = 'roads:lamp-points';
      points.layers.set(LAYER_NO_INK);
      points.renderOrder = 3;
      points.frustumCulled = false;
      const lg = ctx.track(new BufferGeometry());
      lg.setAttribute('position', new BufferAttribute(new Float32Array(poolPos), 3));
      lg.setAttribute('aPool', new BufferAttribute(new Float32Array(poolAttr), 3));
      lg.setIndex(idx);
      lg.computeBoundingSphere();
      poolMat = ctx.track(new ShaderMaterial({ name: 'roads:pools', vertexShader: poolVert, fragmentShader: poolFrag, uniforms: { ...ctx.uniforms, uReveal: { value: 1 } }, transparent: true, depthWrite: false, blending: AdditiveBlending }));
      const pools = new Mesh(lg, poolMat);
      pools.name = 'roads:pools';
      pools.layers.set(LAYER_NO_INK);
      pools.renderOrder = 2;
      pools.frustumCulled = false;
      ctx.scene.add(points, pools);
      night = [points, pools];
      for (const o of night) o.visible = show;
      disposables.push(points.geometry, pools.geometry);

      await ctx.compile();
      const start = ctx.reveal.slot(REVEAL);
      const done = new Set<BufferAttribute>();
      for (const p of parts) {
        const a = p.mesh.geometry.getAttribute('aReveal') as BufferAttribute;
        if (done.has(a)) continue;
        done.add(a);
        const arr = a.array as Float32Array;
        for (let i = 0; i < arr.length; i++) arr[i] += start;
        a.needsUpdate = true;
      }
      const r0 = ctx.reveal.instant ? 1 : 0;
      poolMat.uniforms.uReveal.value = r0;
      pointMat.uniforms.uReveal.value = r0;
      revealStart = start;
    },
    update(ctx) {
      // horizon culling per land mass
      const e = ctx.view.eye;
      const el = e.length();
      const eh = Math.acos(Math.min(1, R / el));
      for (const p of parts) {
        const reach = eh + Math.acos(R / (R + p.top)) + p.rad + 0.05;
        p.mesh.visible = show && (reach >= Math.PI || (e.x * p.dir.x + e.y * p.dir.y + e.z * p.dir.z) / el > Math.cos(reach));
      }
      if (pointMat && poolMat) {
        if (pointMat.uniforms.uReveal.value < 1) {
          const v = ctx.reveal.progress(revealStart + 1.2, 1.2);
          pointMat.uniforms.uReveal.value = v;
          poolMat.uniforms.uReveal.value = v;
        }
        ctx.renderer.getDrawingBufferSize(vp);
        (pointMat.uniforms.uViewport.value as Vector2).copy(vp);
      }
    },
    dispose(ctx) {
      for (const p of parts) {
        ctx.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
      }
      parts.length = 0;
      for (const d of disposables.splice(0)) d.dispose();
      for (const m of [poolMat, pointMat] as Array<Material | null>) m?.dispose();
      poolMat = pointMat = null;
      night = [];
      unsub?.();
      unsub = null;
    },
  };
}

/** Each land mass's mean direction (Region.components: its nodes); a point belongs to the nearest. */
function componentCentres(region: LBContext['world']['region']): Vec3[] {
  return region.components.map((ids) => {
    const c = v3();
    for (const id of ids) {
      const d = region.nodes[id].dir;
      c.x += d.x;
      c.y += d.y;
      c.z += d.z;
    }
    const l = Math.hypot(c.x, c.y, c.z) || 1;
    return v3(c.x / l, c.y / l, c.z / l);
  });
}

/**
 * Split a merged Geo into one geometry per group (by the group of each triangle's first vertex),
 * sharing the vertex buffers; with each part's cap (centre, angular radius, top) for horizon culling.
 */
function split(ctx: LBContext, g: Geo, groups: number, groupOf: (x: number, y: number, z: number) => number) {
  const base = g.toGeometry();
  ctx.track(base);
  const pos = g.pos;
  // group per vertex is costly to evaluate per triangle: cache by vertex
  const vg = new Int8Array(g.n).fill(-1);
  const tris: number[][] = Array.from({ length: groups }, () => []);
  for (let t = 0; t < g.ni; t += 3) {
    const v = g.idx[t];
    if (vg[v] < 0) vg[v] = groupOf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    tris[vg[v]].push(g.idx[t], g.idx[t + 1], g.idx[t + 2]);
  }
  const out: Array<{ geo: BufferGeometry; dir: Vec3; rad: number; top: number }> = [];
  for (const list of tris) {
    if (!list.length) continue;
    const geo = new BufferGeometry();
    for (const [k, a] of Object.entries(base.attributes)) geo.setAttribute(k, a);
    geo.setIndex(new BufferAttribute(Uint32Array.from(list), 1));
    // cap: mean direction, widest angle, highest point
    const d = v3();
    let top = 0;
    for (const v of list) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const l = Math.hypot(x, y, z);
      d.x += x / l;
      d.y += y / l;
      d.z += z / l;
      top = Math.max(top, l - R);
    }
    const dl = Math.hypot(d.x, d.y, d.z) || 1;
    d.x /= dl;
    d.y /= dl;
    d.z /= dl;
    let rad = 0;
    for (const v of list) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      rad = Math.max(rad, Math.acos(Math.min(1, (x * d.x + y * d.y + z * d.z) / Math.hypot(x, y, z))));
    }
    geo.boundingSphere = null;
    geo.computeBoundingSphere();
    out.push({ geo: ctx.track(geo), dir: d, rad, top });
  }
  return out;
}

/** A pool vertex's height: the ground plus the carriageway (a town streetlight's: the pavement). */
function poolHeight(ground: (q: Vec3) => number, q: Vec3, l: Lamp): number {
  return ground(q) + (!l.kind && l.layer >= WALK ? WALK : ASPH);
}

function nearest(cs: Vec3[], x: number, y: number, z: number): number {
  let best = 0;
  let bd = -Infinity;
  for (let k = 0; k < cs.length; k++) {
    const d = cs[k].x * x + cs[k].y * y + cs[k].z * z;
    if (d > bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}
