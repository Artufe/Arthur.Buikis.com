// GOLDENLINE pier: a slender, sun-bleached timber pier on paired pilings, from the dry sand past
// the break into the channel. Construction plan in plan.ts, walkability in service.ts, timber
// shading in wood.ts, rope in rope.ts, lanterns in lantern.ts, the water interaction (foam
// wakes, collars, spray) in water-fx.ts + spray.ts. See pier/README.md.

import { FAR_CASTER_LAYER } from '../atmosphere/shadows';
import { Color, Euler, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { GLContext, GLSystem, TSLNode } from '../core/contracts';
import { boardGeometry, poleGeometry, WOOD_V } from './geometry';
import { createLanterns, type Lanterns } from './lantern';
import { type Board, buildPlan, CAP, PLANK, POST, type PierPlan, RAIL, RIM, STAIR, STRINGER, sprayExposure } from './plan';
import { createRopeMaterial, whipGeometry, ropeInstanceData, ropeSpanGeometry } from './rope';
import { createPierService } from './service';
import { createPierUniforms, type PierUniforms } from './shade';
import { createSprayPool, type SprayPool } from './spray';
import { loadPierTextures, type PierTextures } from './textures';
import { createWaterFx } from './water-fx';
import { createWoodMaterial, type WoodKind } from './wood';

type Disposable = { dispose(): void };

export function createPierSystem(): GLSystem {
  let root: Group | null = null;
  let tex: PierTextures | null = null;
  let u: PierUniforms | null = null;
  let spray: SprayPool | null = null;
  let lanterns: Lanterns | null = null;
  let fx: ReturnType<typeof createWaterFx> | null = null;
  const owned: Disposable[] = [];
  const meshes: InstancedMesh[] = [];
  let p: Record<string, { value: number | boolean }> = {};
  const sunScratch = new Color();

  return {
    name: 'pier',
    async init(ctx: GLContext) {
      const plan: PierPlan = buildPlan(ctx.services.terrain.height);
      ctx.services.pier = createPierService(plan);
      tex = await loadPierTextures(ctx.renderer);
      u = createPierUniforms();
      const P = ctx.params;
      const g = 'pier';
      p = {
        visible: P.toggle('pier.visible', { label: 'pier', group: g, value: true }),
        bleach: P.number('pier.bleach', { label: 'sun bleach', group: g, min: 0, max: 1.5, value: 1 }),
        spray: P.number('pier.sprayDark', { label: 'spray darkening', group: g, min: 0, max: 2, value: 1 }),
        caustics: P.number('pier.caustics', { label: 'underside caustics', group: g, min: 0, max: 4, value: 1 }),
        bounce: P.number('pier.bounce', { label: 'water bounce', group: g, min: 0, max: 4, value: 1 }),
        aniso: P.number('pier.aniso', { label: 'grain anisotropy', group: g, min: 0, max: 1, value: 0.35 }),
        normalK: P.number('pier.normal', { label: 'grain relief', group: g, min: 0, max: 2, value: 1 }),
        growth: P.number('pier.growth', { label: 'marine growth', group: g, min: 0, max: 1.5, value: 1 }),
        barnacles: P.number('pier.barnacles', { label: 'barnacles', group: g, min: 0, max: 1.5, value: 1 }),
      };
      const fxParams = {
        enabled: P.toggle('pier.fx', { label: 'piling interaction', group: g, value: true }),
        collars: P.toggle('pier.collars', { label: 'piling foam collars', group: g, value: true }),
        foamRate: P.number('pier.foamRate', { label: 'piling foam rate', group: g, min: 0, max: 4, value: 0.6 }), // [polish] 1: a 5-8 m blanket downstream
        wakeRate: P.number('pier.wakeRate', { label: 'piling wake rate', group: g, min: 0, max: 4, value: 1 }),
        sprayRate: P.number('pier.sprayRate', { label: 'piling spray', group: g, min: 0, max: 3, value: 1 }),
        current: P.number('pier.current', { label: 'longshore current m/s', group: g, min: 0, max: 1, value: 0.2 }),
        surge: P.number('pier.surge', { label: 'debug: whitewater surge', group: g, min: 0, max: 1, value: 0 }),
        samples: P.number('pier.samples', { label: 'ocean samples / frame', group: g, min: 1, max: 72, step: 1, value: 6 }),
      };

      const atmos = ctx.services.atmosphere;
      const ocean = ctx.services.ocean;
      const hook = (ocean.gpu as { pierCaustics?: (p: TSLNode) => TSLNode }).pierCaustics ?? null;
      root = new Group();
      root.name = 'pier';

      const q = new Quaternion();
      const e = new Euler(0, 0, 0, 'YXZ');
      const pos = new Vector3();
      const scl = new Vector3();
      const mtx = new Matrix4();

      const boards = (kind: WoodKind, list: Board[], w: number, h: number, l: number, bevel: number) => {
        if (!list.length) return;
        const geo = boardGeometry(w, h, l, bevel);
        const seed = new InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
        const env = new InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
        const mat = createWoodMaterial({ kind, tex: tex!, u: u!, seed, env, sunDir: atmos.sunDirNode, causticsHook: hook });
        const mesh = new InstancedMesh(geo, mat, list.length);
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          e.set(b.rx, b.ry, b.rz, 'YXZ');
          q.setFromEuler(e);
          pos.set(b.x, b.y, b.z);
          scl.set(1, 1, b.lenScale);
          mesh.setMatrixAt(i, mtx.compose(pos, q, scl));
          seed.setXYZW(i, b.seed[0], b.seed[1], b.seed[2], b.seed[3]);
          env.setXYZW(i, b.env[0], b.env[1], b.env[2], b.env[3]);
        }
        add(mesh, geo, mat);
      };
      const add = (mesh: InstancedMesh, geo: Disposable, mat: Disposable) => {
        mesh.castShadow = true;
        mesh.layers.enable(FAR_CASTER_LAYER); // [polish] the long pier shadow reaches the far cascades
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        root!.add(mesh);
        meshes.push(mesh);
        owned.push(geo, mat, mesh);
      };

      boards('deck', plan.planks, PLANK.w, PLANK.t, 3.2, 0.006);
      boards('deck', plan.treads, (STAIR.tread - 0.02) / 2, PLANK.t, STAIR.halfW * 2, 0.006);
      boards('timber', plan.stringers, STRINGER.w, STRINGER.h, 5.985, 0.008);
      boards('timber', plan.caps, CAP.t, CAP.h, CAP.len, 0.01);
      boards('timber', plan.rims, RIM.t, RIM.h, 5.99, 0.008);
      boards('timber', plan.posts, POST.s, POST.s, 1.3, 0.012);
      boards('timber', plan.rails, RAIL.w, RAIL.h, 6, 0.014);
      boards('timber', plan.braces, 0.05, 0.2, 4, 0.008);

      // Pilings: one unit pole, scaled per instance; irregularity is added in the shader.
      {
        const list = plan.piles;
        const geo = poleGeometry();
        const seed = new InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
        const env = new InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
        const mat = createWoodMaterial({ kind: 'pile', tex, u, seed, env, sunDir: atmos.sunDirNode, causticsHook: hook });
        const mesh = new InstancedMesh(geo, mat, list.length);
        q.identity();
        for (let i = 0; i < list.length; i++) {
          const pl = list[i];
          const len = pl.top - pl.bottom;
          pos.set(pl.x, pl.bottom, pl.z);
          scl.set(pl.r, len, pl.r);
          mesh.setMatrixAt(i, mtx.compose(pos, q, scl));
          seed.setXYZW(i, pl.seed[0], pl.seed[1], 0.45 + pl.seed[2] * 0.4, len / WOOD_V);
          env.setXYZW(i, pl.ground, sprayExposure(pl.x), pl.seed[3], pl.r);
        }
        add(mesh, geo, mat);
      }

      // Rope spans (sag in the shader), threaded through the posts, and whippings on the rail.
      {
        const list = plan.ropes;
        const geo = ropeSpanGeometry();
        const inst = ropeInstanceData(list.length);
        const mat = createRopeMaterial(tex, u, inst, true);
        const mesh = new InstancedMesh(geo, mat, list.length);
        const dir = new Vector3();
        const xAxis = new Vector3(1, 0, 0);
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          dir.set(r.x1 - r.x0, r.y1 - r.y0, r.z1 - r.z0);
          const len = dir.length();
          q.setFromUnitVectors(xAxis, dir.normalize());
          pos.set(r.x0, r.y0, r.z0);
          scl.set(len, 1, 1);
          mesh.setMatrixAt(i, mtx.compose(pos, q, scl));
          inst.setXYZW(i, r.sag, len, (i * 0.618) % 1, 0);
        }
        add(mesh, geo, mat);
      }
      {
        const hs = plan.hitches;
        const count = hs.length / 4;
        const geo = whipGeometry(RAIL.w / 2, RAIL.h / 2);
        const inst = ropeInstanceData(count);
        const mat = createRopeMaterial(tex, u, inst, false);
        const mesh = new InstancedMesh(geo, mat, count);
        q.identity();
        scl.set(1, 1, 1);
        for (let i = 0; i < count; i++) {
          pos.set(hs[i * 4], hs[i * 4 + 1], hs[i * 4 + 2]);
          mesh.setMatrixAt(i, mtx.compose(pos, q, scl));
          inst.setXYZW(i, 0, 1, (i * 0.377) % 1, 0);
        }
        add(mesh, geo, mat);
        mesh.castShadow = false;
      }

      lanterns = createLanterns(plan, tex);
      root.add(lanterns.metal, lanterns.glass);

      // [polish] Share A8's spray pool (ocean.gpu.spray, same burst signature) so all spray has one
      // look and one pool; the pier's own pool is the fallback when the shared one is absent.
      const shared = (ocean.gpu as { spray?: { burst(x: number, y: number, z: number, vx: number, vy: number, vz: number, count: number, spread: number, radius: number, mist: number): void } }).spray;
      if (shared) {
        spray = {
          sprite: null as unknown as SprayPool['sprite'],
          burst: (x, y, z, vx, vy, vz, count, spread, radius, mist) => shared.burst(x, y, z, vx, vy, vz, count, spread, radius, mist),
          step() {},
          wind: { x: 0, z: 0 },
          dispose() {},
        };
      } else {
        spray = createSprayPool(atmos.sunDirNode, u.sunRadiance, u.bounceWater, tex.noise);
        root.add(spray.sprite);
      }
      const fftDisp = (ocean.gpu as { surface?: { fftDisplacement?: Parameters<typeof createWaterFx>[5] } }).surface?.fftDisplacement ?? null;
      fx = createWaterFx(plan, tex, u, spray, fxParams, fftDisp);
      root.add(fx.collars);

      ctx.scene.add(root);
    },

    async warmup(ctx: GLContext) {
      if (!root || !spray) return;
      // [polish] Render pipelines: the engine's warmPipelines() draws every pier mesh unculled
      // through the post chain and the shadow cascades.
      // Run the spray compute a few frames with a burst that dies at once (below the kill plane).
      for (let k = 0; k < 4; k++) {
        spray.burst(0, -50, 0, 0, 0, 0, 64, 1, 1, 0.5);
        spray.step(ctx.renderer, 1 / 60, k / 60);
      }
    },

    update(ctx: GLContext) {
      if (!root || !u || !spray || !fx) return;
      const vis = p.visible.value as boolean;
      root.visible = vis;
      if (!vis) return;
      const a = ctx.services.atmosphere;
      u.time.value = ctx.time.t;
      sunScratch.copy(a.sunLight.color).multiplyScalar(a.sunLight.intensity);
      (u.sunRadiance.value as Color).copy(sunScratch);
      u.bleach.value = p.bleach.value as number;
      u.spray.value = p.spray.value as number;
      u.caustics.value = p.caustics.value as number;
      u.bounce.value = p.bounce.value as number;
      u.aniso.value = p.aniso.value as number;
      u.normalK.value = p.normalK.value as number;
      u.growth.value = p.growth.value as number;
      u.barnacles.value = p.barnacles.value as number;
      fx.update(ctx);
      spray.wind.x = -3.2;
      spray.wind.z = -0.9;
      if (ctx.time.dt > 0) spray.step(ctx.renderer, ctx.time.dt, ctx.time.t);
    },

    dispose(ctx: GLContext) {
      if (root) ctx.scene.remove(root);
      for (const o of owned) o.dispose();
      owned.length = 0;
      meshes.length = 0;
      lanterns?.dispose();
      fx?.dispose();
      spray?.dispose();
      tex?.dispose();
      root = null;
      lanterns = null;
      fx = null;
      spray = null;
      tex = null;
    },
  };
}
