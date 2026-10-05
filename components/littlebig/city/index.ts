// City system (A2): renders the plan (world/city) as merged toon geometry — one draw for every
// building and prop (casting shadows), one for the ground (receiving them), one for the paint (a
// polygon offset keeps it off the asphalt at any distance), plus the additive night lights (light
// pools on the pavement, pinpoint lamp heads). Built time-sliced after the first frame.
//
// Reveal: the ground rolls in as a wave rising out of the plateau from the centre; then the
// buildings spring up in a cascade by distance (staggered one after another), houses with the
// mid-rise, towers last and the tallest growing slowest.

import { BufferAttribute, type BufferGeometry, DoubleSide, Vector2 } from 'three';
import type { LBContext, System } from '../core/contracts';
import { CITY_PLAN_RADIUS } from '../world/config';
import { fromSphere } from '../world/city/frame';
import type { Building, CityIndex } from '../world/city/types';
import { v3 } from '../world/sphere';
import { CITY_DIR, nightFactor, sunDirection } from '../world/sun';
import { buildBuilding, type BuildCtx } from './buildings';
import { Geo } from './geo';
import { buildGround } from './ground';
import { buildPools, type CityLights } from './pools';
import { buildProps } from './props';
import { cityPatch } from './shader';

/** Reveal timeline (s, relative to the city's slot). */
const GROUND_SPREAD = 0.9;
const BUILD_START = 0.45;
const BUILD_SPREAD = 1.5;
const TOWER_LAG = 0.25;
const REVEAL_TOTAL = BUILD_START + BUILD_SPREAD + TOWER_LAG + 1.6;

/** Does face f (0 front −z, 1 right +x, 2 back +z, 3 left −x) of b look onto a street? */
function roadFacer(index: CityIndex) {
  return (b: Building, f: number): boolean => {
    const c = Math.cos(b.angle);
    const s = Math.sin(b.angle);
    // outward normal and the face's half length in local terms
    const nx = f === 1 ? 1 : f === 3 ? -1 : 0;
    const nz = f === 0 ? -1 : f === 2 ? 1 : 0;
    const half = f === 0 || f === 2 ? b.w / 2 : b.d / 2;
    const reach = (f === 0 || f === 2 ? b.d / 2 : b.w / 2) + 2.2;
    let hits = 0;
    for (const t of [-0.5, 0, 0.5]) {
      const lx = nx * reach + (nz !== 0 ? t * half : 0);
      const lz = nz * reach + (nx !== 0 ? t * half : 0);
      const x = b.x + lx * c - lz * s;
      const z = b.z + lx * s + lz * c;
      const k = index.classify(x, z);
      if (k === 'sidewalk' || k === 'road' || k === 'intersection' || k === 'plaza') hits++;
    }
    return hits >= 2;
  };
}

export function createCitySystem(): System {
  const geos: BufferGeometry[] = [];
  let lights: CityLights | null = null;
  let revealStart = 0;
  const vp = new Vector2();
  // How late in the night it is over the city (night both 60 s ago and 40 s ahead, as the people
  // thin out): dims the share of lit windows on every city material and the window sparks.
  const late = { value: 0 };
  const sd = v3();
  const nightAt = (t: number) => nightFactor(CITY_DIR, sunDirection(t, sd));
  return {
    name: 'city',
    stage: 2,
    async init(ctx: LBContext) {
      const plan = ctx.world.city;
      const index = ctx.world.cityIndex;
      const buildMat = ctx.toon.material({ name: 'city', vertexColors: true, reveal: 'instance', revealDuration: 0.8, rim: 0.32, patch: cityPatch(false, late) });
      const groundMat = ctx.toon.material({ name: 'city:ground', vertexColors: true, reveal: 'instance', revealDuration: 0.55, rim: 0.0, patch: cityPatch(true, late) });
      const paintMat = ctx.toon.material({ name: 'city:paint', vertexColors: true, reveal: 'instance', revealDuration: 0.55, rim: 0.0, patch: cityPatch(true, late) });
      // Both faces into the shadow map: with back faces only (three's default for a front-sided
      // material) light leaked through the seams of stacked segments and rows (thin lit lines across
      // a shadow at floor levels); the front faces close them. Bias and normalBias keep lit faces
      // free of acne.
      buildMat.shadowSide = DoubleSide;
      paintMat.polygonOffset = true;
      paintMat.polygonOffsetFactor = -1;
      paintMat.polygonOffsetUnits = -4;
      const R = CITY_PLAN_RADIUS;

      // Building cascade: sorted by distance from the centre, one after another; towers after the
      // rest has started, taller = slower.
      const order = plan.buildings.map((b, i) => ({ i, r: Math.hypot(b.x, b.z) })).sort((a, b) => a.r - b.r);
      const rank = new Float32Array(plan.buildings.length);
      order.forEach((o, k) => (rank[o.i] = k / Math.max(1, order.length - 1)));
      let tallest = -1;
      for (const b of plan.buildings) if (b.style === 'tower' && (tallest < 0 || b.h > plan.buildings[tallest].h)) tallest = b.id;
      const ctxB: BuildCtx = { roadFace: roadFacer(index), tallest };
      const delayOf = (b: Building) => BUILD_START + rank[b.id] * BUILD_SPREAD + (b.style === 'tower' ? TOWER_LAG + (b.h / 34) * 0.15 : 0);

      const B = new Geo(1 << 16);
      const facades: number[] = [];
      B.facades = facades;
      let n = 0;
      for (const b of plan.buildings) {
        B.growK = b.style === 'tower' || b.landmark ? 1 + b.h / 22 : 1 + b.h / 40;
        buildBuilding(B, b, delayOf(b), ctxB);
        if (++n % 6 === 0) await ctx.yield();
      }
      B.growK = 1;
      B.facades = null;
      buildProps(B, plan, index, (x, z) => BUILD_START + (Math.hypot(x, z) / R) * BUILD_SPREAD + 0.3);
      await ctx.yield();
      const G = new Geo(1 << 16);
      const P = new Geo(1 << 14);
      await buildGround(G, P, plan, index, () => ctx.yield());

      const buildGeo = ctx.track(B.toGeometry());
      const groundGeo = ctx.track(G.toGeometry());
      const paintGeo = ctx.track(P.toGeometry());
      geos.push(buildGeo, groundGeo, paintGeo);
      // Ground and paint: every vertex on its own delay by distance (a smooth wave).
      const q = { x: 0, z: 0 };
      for (const g of [groundGeo, paintGeo]) {
        const pos = g.getAttribute('position') as BufferAttribute;
        const rev = g.getAttribute('aReveal') as BufferAttribute;
        const p = { x: 0, y: 0, z: 0 };
        for (let i = 0; i < pos.count; i++) {
          p.x = pos.getX(i);
          p.y = pos.getY(i);
          p.z = pos.getZ(i);
          fromSphere(p, q);
          rev.setX(i, (Math.hypot(q.x, q.z) / R) * GROUND_SPREAD + (g === paintGeo ? 0.12 : 0));
        }
      }
      const buildMesh = ctx.toon.mesh(buildGeo, buildMat, { cast: true, receive: true });
      const groundMesh = ctx.toon.mesh(groundGeo, groundMat, { cast: false, receive: true });
      const paintMesh = ctx.toon.mesh(paintGeo, paintMat, { cast: false, receive: true });
      buildMesh.name = 'city:buildings';
      groundMesh.name = 'city:ground';
      paintMesh.name = 'city:paint';
      // Draw before the terrain (all LITTLEBIG meshes sit at the origin, so three's depth sort ties):
      // the city first lets early-z reject the terrain under it.
      buildMesh.renderOrder = -3;
      groundMesh.renderOrder = -2;
      paintMesh.renderOrder = -1;
      ctx.scene.add(groundMesh, paintMesh, buildMesh);
      lights = await buildPools(ctx, plan, index, facades, late);
      ctx.scene.add(lights.pools, lights.points);
      await ctx.yield();

      await ctx.compile();
      const start = ctx.reveal.slot(REVEAL_TOTAL);
      for (const g of [buildGeo, groundGeo, paintGeo]) {
        const a = g.getAttribute('aReveal') as BufferAttribute;
        const arr = a.array as Float32Array;
        for (let i = 0; i < arr.length; i++) arr[i] += start;
        a.needsUpdate = true;
      }
      const r0 = ctx.reveal.instant ? 1 : 0;
      lights.poolMat.uniforms.uReveal.value = r0;
      lights.pointMat.uniforms.uReveal.value = r0;
      revealStart = start;
    },
    update(ctx) {
      if (!lights) return;
      late.value = nightAt(ctx.time.t - 60) * nightAt(ctx.time.t + 40);
      if (lights.poolMat.uniforms.uReveal.value < 1) {
        const v = ctx.reveal.progress(revealStart + BUILD_START + BUILD_SPREAD * 0.5, 1.2);
        lights.poolMat.uniforms.uReveal.value = v;
        lights.pointMat.uniforms.uReveal.value = v;
      }
      ctx.renderer.getDrawingBufferSize(vp);
      (lights.pointMat.uniforms.uViewport.value as Vector2).copy(vp);
    },
    dispose() {
      for (const g of geos) g.dispose();
      geos.length = 0;
      lights?.poolMat.dispose();
      lights?.pointMat.dispose();
      lights = null;
    },
  };
}
