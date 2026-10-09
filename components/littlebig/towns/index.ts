// The towns system (v2, T1): every settlement but the capital, and the two airports, as real places.
// towns/plan.ts lays out each site (pure, deterministic); towns/build.ts turns it into one merged mesh
// per site on the city's own toon program (so the windows light up at night like the capital's), the
// window sparks that carry the lit windows from orbit (the capital's point shader, fed our facades and
// a porch light per house), the moored boats bobbing on the swell and the chairlift's chairs (two
// instanced meshes), all built after the world is up in short slices and revealed like the capital:
// the buildings spring up in a cascade out from each town's middle.
// Per frame: sites below the horizon are hidden; boats near the camera ride the swell; the chairs run.

import { BufferAttribute, type BufferGeometry, Color, DoubleSide, type InstancedMesh, Matrix4, type Mesh, type Points, type ShaderMaterial, Vector2, Vector3 } from 'three';
import type { LBContext, NatureService, System } from '../core/contracts';
import { doorX } from '../city/buildings';
import { Geo } from '../city/geo';
import { buildPools } from '../city/pools';
import { cityPatch } from '../city/shader';
import { swellFade, swellW } from '../ocean/swell';
import type { Building, CityIndex, CityPlan } from '../world/city/types';
import { CITY_PLAN_RADIUS, R } from '../world/config';
import { CITY_CHART } from '../world/city/frame';
import { Biome } from '../world/planet';
import { chartToDir, dirToChart, v3, type Vec3 } from '../world/sphere';
import { nightFactor, sunDirection } from '../world/sun';
import { buildSite, cables, chair, frameAt, hull, liftLoop } from './build';
import { type Item, planSteps, type Site, T } from './plan';
import { townSolids } from './solids';

const SPREAD = 1.6;
/** Boat tints (pastels): the hull is mid grey in the geometry, so it comes out a deep shade of the tint, the cabin and the gunwale the pastel itself. */
const HULL = ['#9CC8FF', '#FF9C8C', '#FFE07A', '#8EE6C8', '#FFFFFF', '#C9B8FF', '#FFB86B'].map((h) => new Color(h));
const CHAIRS = ['#E2543F', '#3D78C8', '#F2A93B'].map((h) => new Color(h));
/** Floats per moored boat: fleet, instance, scale, waterline position, frame axes, its site's mesh. */
const B = 16;

export function createTownsSystem(): System {
  const meshes: Mesh[] = [];
  let pointMat: ShaderMaterial | null = null;
  let points: Points | null = null;
  let fleets: InstancedMesh[] = [];
  let boats = new Float32Array(0);
  let chairs: InstancedMesh | null = null;
  let loop: Float32Array | null = null;
  let loopS: Float32Array | null = null;
  const late = { value: 0 };
  let revealAt = 0;
  /** Param towns.show (A/B: --p towns.show=false). */
  let shown = true;
  let unsub: (() => void) | null = null;
  let restore: (() => void) | null = null;
  let wrapped: NatureService | null = null;
  const vp = new Vector2();
  const sd = v3();
  const m4 = new Matrix4();
  const p3 = new Vector3();
  const ax = new Vector3();
  const ay = new Vector3();
  const az = new Vector3();

  return {
    name: 'towns',
    stage: 2,
    async init(ctx: LBContext) {
      const planet = ctx.world.planet;
      const showP = ctx.params.toggle('towns.show', { label: 'towns: buildings, boats, the lift', value: true });
      shown = showP.value;
      unsub = ctx.params.onChange((p) => {
        if (p === showP) shown = showP.value;
      });
      // planned in slices (towns/plan.ts yields between its passes)
      const job = planSteps(ctx.world.region, (d) => planet.heightAt(d), (d) => planet.biomeAt(d) === Biome.Beach);
      let step = job.next();
      while (!step.done) {
        await ctx.yield();
        step = job.next();
      }
      const sites = step.value;
      const opts = { vertexColors: true, reveal: 'instance', revealDuration: 0.8, rim: 0.32, patch: cityPatch(false, late) } as const;
      const mat = ctx.toon.material({ name: 'towns', ...opts });
      mat.shadowSide = DoubleSide;
      const facades: number[] = [];
      const porch: number[] = [];
      const far: number[] = [];
      const moored: Array<[Site, Item]> = [];
      for (const site of sites) {
        const g = new Geo(1 << 15);
        g.facades = facades;
        // the cascade: out from the site's middle, buildings first, the trees and props after them
        const job = buildSite(g, site, (it) => (Math.hypot(it.x, it.z) / site.r) * SPREAD + (it.t >= T.tree ? 0.35 : 0));
        let r = job.next();
        while (!r.done) {
          await ctx.yield();
          r = job.next();
        }
        let top = 0;
        for (const it of site.items) {
          top = Math.max(top, it.y + it.h + 2);
          if (it.t === T.boat) moored.push([site, it]);
          // a porch light at every house door (as the capital has), and a lit window at its back that only
          // shows from afar: from orbit each town is a warm cluster, a small one too
          if (it.t <= T.mid || it.t === T.townhouse || it.t === T.chalet || it.t === T.hotel || it.t === T.villa) {
            const dx = it.t === T.house ? doorX({ seed: it.s, w: it.w } as Building) : 0;
            const { o, ex, ey, ez } = frameAt(site, it.x, it.z, it.a, it.y);
            const k = it.d / 2 + 0.2, y = it.h * 0.55;
            porch.push(o.x + ex.x * dx + ey.x * 2.35 - ez.x * k, o.y + ex.y * dx + ey.y * 2.35 - ez.y * k, o.z + ex.z * dx + ey.z * 2.35 - ez.z * k);
            far.push(o.x + ey.x * y + ez.x * k, o.y + ey.y * y + ez.y * k, o.z + ey.z * y + ez.z * k);
          }
        }
        const lp = liftLoop(site);
        if (lp) {
          loop = lp;
          Object.assign(g.pivot, { x: lp[0], y: lp[1], z: lp[2] });
          g.delay = SPREAD;
          cables(g, lp);
        }
        const mesh = ctx.toon.mesh(ctx.track(g.toGeometry()), mat, { cast: true, receive: true });
        mesh.name = `towns:${site.id}`;
        mesh.renderOrder = -3;
        mesh.matrixAutoUpdate = false;
        mesh.userData = { site, top };
        ctx.scene.add(mesh);
        meshes.push(mesh);
        await ctx.yield();
      }

      // window sparks: the capital's point shader on our facades (no street lamps: H1 owns those)
      const lights = await buildPools(ctx, { features: [], buildings: [] } as unknown as CityPlan, null as unknown as CityIndex, facades, late);
      lights.poolMat.dispose();
      addLamps(lights.points.geometry, porch, 26);
      addLamps(lights.points.geometry, far, 70);
      points = lights.points;
      pointMat = lights.pointMat;
      points.name = 'towns:windows';
      ctx.scene.add(points);

      // the moored boats: two fleets (fishing boats with a wheelhouse, rowing boats), tinted per boat
      const instMat = ctx.toon.material({ name: 'towns:afloat', ...opts });
      const one = (fill: (g: Geo) => void) => {
        const g = new Geo(4096);
        g.pivot.y = 1e-3;
        fill(g);
        return ctx.track(g.toGeometry());
      };
      const local = { o: v3(), ex: v3(1, 0, 0), ey: v3(0, 1, 0), ez: v3(0, 0, 1) };
      const grey = new Color(0.42, 0.42, 0.44);
      const counts = [0, 0];
      for (const b of moored) counts[b[1].c]++;
      fleets = [4.4, 2.9].map((L, k) => {
        const m = ctx.toon.instanced(one((g) => hull(local, L, grey, g)), instMat, Math.max(1, counts[k]), { cast: true, receive: true });
        m.name = `towns:boats${k}`;
        m.count = counts[k];
        m.frustumCulled = false;
        ctx.scene.add(m);
        return m;
      });
      boats = new Float32Array(moored.length * B);
      const used = [0, 0];
      moored.forEach(([site, it], i) => {
        const k = it.c;
        const { o, ex, ey, ez } = frameAt(site, it.x, it.z, it.a, k ? -0.1 : -0.3);
        boats.set([k, used[k], it.d / (k ? 2.9 : 4.4), o.x, o.y, o.z, ex.x, ex.y, ex.z, ey.x, ey.y, ey.z, ez.x, ez.y, ez.z, sites.indexOf(site)], i * B);
        fleets[k].setColorAt(used[k]++, HULL[it.s % HULL.length]);
      });
      poseBoats(0, null);

      // the chairlift's chairs, evenly round the loop (about 7 m apart)
      if (loop) {
        loopS = new Float32Array(loop.length / 3);
        for (let i = 1; i < loopS.length; i++) loopS[i] = loopS[i - 1] + Math.hypot(loop[i * 3] - loop[i * 3 - 3], loop[i * 3 + 1] - loop[i * 3 - 2], loop[i * 3 + 2] - loop[i * 3 - 1]);
        const n = Math.max(2, Math.floor(loopS[loopS.length - 1] / 7));
        chairs = ctx.toon.instanced(one(chair), instMat, n, { cast: true, receive: true });
        chairs.name = 'towns:chairs';
        chairs.frustumCulled = false;
        for (let i = 0; i < n; i++) chairs.setColorAt(i, CHAIRS[i % 3]);
        ctx.scene.add(chairs);
        runChairs(0);
      }
      const inst = chairs ? [...fleets, chairs] : fleets;
      for (const f of inst) if (f.instanceColor) f.instanceColor.needsUpdate = true;

      await ctx.compile();
      const start = ctx.reveal.slot(SPREAD + 2.2);
      for (const o of [...meshes, ...inst]) {
        const a = o.geometry.getAttribute('aReveal') as BufferAttribute;
        const arr = a.array as Float32Array;
        const off = start + (o.userData.site ? 0 : SPREAD);
        for (let i = 0; i < arr.length; i++) arr[i] += off;
        a.needsUpdate = true;
      }
      pointMat.uniforms.uReveal.value = ctx.reveal.instant ? 1 : 0;
      revealAt = start + SPREAD * 0.6;
      // the buildings are walls to the walker: the countryside's collider (nature's trunks and boulders)
      // is wrapped so a body is pushed out of their footprints too (DECISIONS [v2-T1])
      const inner = ctx.services.nature, hit = walls(sites);
      wrapped = { collide: (dir, r, out) => (inner?.collide(dir, r, out) ? hit(out, r, out) || true : hit(dir, r, out)) };
      ctx.services.nature = wrapped;
      // and walls and roofs to the bird, by their heights (v2-BF)
      const solids = townSolids(sites, ctx.world.region);
      ctx.services.towns = solids;
      restore = () => {
        if (ctx.services.nature === wrapped) ctx.services.nature = inner;
        if (ctx.services.towns === solids) ctx.services.towns = undefined;
      };
    },
    update(ctx: LBContext) {
      if (!pointMat || !points) return;
      const show = shown;
      const t = ctx.time.render;
      // how late in the night it is where the camera looks (the share of lit windows drops; half as fast
      // as the capital's: a small town keeps more of its windows lit through the night)
      const f = ctx.view.focus;
      late.value = 0.5 * nightFactor(f, sunDirection(ctx.time.t - 60, sd)) * nightFactor(f, sunDirection(ctx.time.t + 40, sd));
      if (pointMat.uniforms.uReveal.value < 1) pointMat.uniforms.uReveal.value = ctx.reveal.progress(revealAt, 1.2);
      ctx.renderer.getDrawingBufferSize(vp);
      (pointMat.uniforms.uViewport.value as Vector2).copy(vp);
      // sites below the horizon are not drawn (from orbit every bounding sphere is in the frustum), nor,
      // from down in the streets, those more than 140 m away (behind the terrain), or any from the capital's
      // streets (behind its blocks); the window sparks only while a site is
      const eye = ctx.view.eye;
      const el = eye.length();
      const hz = Math.acos(Math.min(1, R / el));
      const o = CITY_CHART.origin;
      const street = ctx.view.altTerrain < 40, inCity = street && Math.acos(Math.min(1, (eye.x * o.x + eye.y * o.y + eye.z * o.z) / el)) * R < CITY_PLAN_RADIUS - 22;
      let any = false;
      let lift = false;
      for (const m of meshes) {
        const s = m.userData.site as Site;
        const arc = Math.acos(Math.max(-1, Math.min(1, (eye.x * s.dir.x + eye.y * s.dir.y + eye.z * s.dir.z) / el)));
        m.visible = show && !inCity && arc - s.r / R < hz + Math.acos(R / (R + m.userData.top)) && !(street && arc * R - s.r > 140);
        any ||= m.visible;
        lift ||= m.visible && s.lift !== null;
      }
      points.visible = any;
      // the boats and the chairs only near the camera (within the swell's reach)
      const low = show && ctx.view.altTerrain < 150;
      const near = low ? poseBoats(t, eye) : 0;
      fleets[0].visible = (near & 1) > 0;
      fleets[1].visible = (near & 2) > 0;
      if (chairs && loop) chairs.visible = low && lift && Math.hypot(loop[0] - eye.x, loop[1] - eye.y, loop[2] - eye.z) < 160 && runChairs(t);
    },
    dispose() {
      restore?.();
      restore = null;
      unsub?.();
      unsub = null;
      meshes.length = 0;
      points = pointMat = chairs = loop = loopS = null;
      fleets = [];
    },
  };

  /** Pose the fleet on the swell (a little roll and pitch); returns which fleets have a boat near the eye (bits). */
  function poseBoats(t: number, eye: Vector3 | null): number {
    let near = 0;
    for (let o = 0; o < boats.length; o += B) {
      const k = boats[o], s = boats[o + 2], px = boats[o + 3], py = boats[o + 4], pz = boats[o + 5];
      let heave = 0;
      if (eye) {
        // (only round a town that is drawn)
        if (!meshes[boats[o + 15]].visible) continue;
        const fade = swellFade(Math.hypot(px - eye.x, py - eye.y, pz - eye.z));
        if (fade <= 0) continue;
        heave = 0.06 * fade * swellW(px, py, pz, t);
      }
      near |= 1 << k;
      const ph = boats[o + 1] * 1.7 + k * 4.1, roll = 0.045 * Math.sin(t * 1.35 + ph * 1.3), pitch = 0.025 * Math.sin(t * 1.1 + ph);
      ax.fromArray(boats, o + 6);
      ay.fromArray(boats, o + 9);
      az.fromArray(boats, o + 12);
      // (small angles: the axes nudged toward each other stay square to within a thousandth)
      p3.copy(ay).addScaledVector(ax, roll).addScaledVector(az, pitch).multiplyScalar(s);
      ax.addScaledVector(ay, -roll).multiplyScalar(s);
      az.addScaledVector(ay, -pitch).multiplyScalar(s);
      m4.makeBasis(ax, p3, az).setPosition(px + ay.x * heave, py + ay.y * heave, pz + ay.z * heave);
      fleets[k].setMatrixAt(boats[o + 1], m4);
    }
    for (const f of fleets) f.instanceMatrix.needsUpdate = true;
    return near;
  }

  /** The chairs round the cable loop (1.6 m/s), each facing the way it goes (local −z). */
  function runChairs(t: number): boolean {
    if (!chairs || !loop || !loopS) return false;
    const L = loopS[loopS.length - 1], n = chairs.count;
    for (let i = 0; i < n; i++) {
      const sv = (((t * 1.6 + (i * L) / n) % L) + L) % L;
      let lo = 0, hi = loopS.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (loopS[mid] <= sv) lo = mid;
        else hi = mid;
      }
      p3.fromArray(loop, lo * 3).lerp(ay.fromArray(loop, hi * 3), (sv - loopS[lo]) / Math.max(1e-6, loopS[hi] - loopS[lo]));
      az.fromArray(loop, lo * 3).sub(ay);
      ay.copy(p3).normalize();
      az.addScaledVector(ay, -az.dot(ay)).normalize();
      ax.crossVectors(ay, az);
      chairs.setMatrixAt(i, m4.makeBasis(ax, ay, az).setPosition(p3));
    }
    chairs.instanceMatrix.needsUpdate = true;
    return true;
  }
}

/** Append lamp-head sparks (the point shader's lamp branch: ~0.5 m, shown past `near` m) to the window points. */
function addLamps(g: BufferGeometry, pos: number[], near: number): void {
  const n = pos.length / 3;
  for (const [name, k, v] of [['position', 3, 0], ['aSize', 1, 0.5], ['aNear', 1, near], ['aNormal', 3, 0], ['aCell', 2, 0], ['aTint', 4, 0]] as const) {
    const old = g.getAttribute(name).array as Float32Array;
    const a = new Float32Array(old.length + n * k).fill(v, old.length);
    a.set(old);
    if (name === 'position') a.set(pos, old.length);
    g.setAttribute(name, new BufferAttribute(a, k));
  }
  g.computeBoundingSphere();
}

/**
 * The towns' buildings as walls: push a body of radius r at unit `dir` out of every footprint it overlaps
 * (sliding along it), writing the resolved direction into out; true if it moved. Zero-alloc.
 */
export function walls(sites: Site[]): (dir: Vec3, r: number, out: Vec3) => boolean {
  // per site its footprints in its chart: centre x, z, the axis' cos and sin, half sizes; and its reach
  const solid = sites.map((s) => s.items.filter((i) => i.t < T.tree));
  const F = solid.map((b) => Float32Array.from(b.flatMap((i) => [i.x, i.z, Math.cos(i.a), Math.sin(i.a), i.w / 2, i.d / 2])));
  const cos = solid.map((b) => Math.cos((Math.max(0, ...b.map((i) => Math.hypot(i.x, i.z) + i.w + i.d)) + 4) / R));
  const q = { x: 0, z: 0 };
  return (dir, r, out) => {
    for (let k = 0; k < sites.length; k++) {
      const s = sites[k], f = F[k];
      if (dir.x * s.dir.x + dir.y * s.dir.y + dir.z * s.dir.z < cos[k]) continue;
      dirToChart(s.chart, dir, q);
      let moved = false;
      // (a few passes: pushed out of one wall into a neighbour's, it is pushed on)
      for (let pass = 0, any = true; pass < 4 && any; pass++) {
        any = false;
        for (let i = 0; i < f.length; i += 6) {
          const dx = q.x - f[i], dz = q.z - f[i + 1], u = dx * f[i + 2] + dz * f[i + 3], v = dz * f[i + 2] - dx * f[i + 3];
          let eu = u - Math.max(-f[i + 4], Math.min(f[i + 4], u)), ev = v - Math.max(-f[i + 5], Math.min(f[i + 5], v)), d = Math.hypot(eu, ev);
          if (d >= r) continue;
          if (d > 1e-6) {
            eu /= d;
            ev /= d;
          } else {
            // (inside: out through its front, onto the street it faces: a terrace's sides are its neighbours)
            eu = 0;
            ev = -1;
            d = -v - f[i + 5];
          }
          const pu = u + eu * (r - d), pv = v + ev * (r - d);
          q.x = f[i] + pu * f[i + 2] - pv * f[i + 3];
          q.z = f[i + 1] + pu * f[i + 3] + pv * f[i + 2];
          moved = any = true;
        }
      }
      if (moved) {
        chartToDir(s.chart, q.x, q.z, out);
        return true;
      }
    }
    return false;
  };
}
