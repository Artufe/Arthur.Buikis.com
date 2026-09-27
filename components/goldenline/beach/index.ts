// GOLDENLINE beach: CDLOD terrain over land and seabed, the sand / seabed / reef material,
// the far field (headland, island) and beach dressing. See docs/goldenline/TASKS.md § A3 and
// components/goldenline/beach/README.md.

import type { Mesh } from 'three/webgpu';
import { Mesh as ThreeMesh } from 'three/webgpu';
import { vec2 } from 'three/tsl';
import { SPLAT_FOOTPRINT, type GLContext, type GLSystem, type SurfaceStateService, type TSLNode } from '../core/contracts';
import type { NumberParam, ToggleParam } from '../core/params';
import { heightGradTexture } from './bake';
import { createReefBake } from './reef-bake';
import { bake, yieldTask } from '../core/bakes';
import { CdlodSelector, RANGE_K, createPatchGeometry } from './cdlod';
import { createDebugSand } from './debug-sand';
import { createDressing } from './dressing';
import { createFarField } from './far';
import { makeGround, type Ground } from './ground';
import { onHooksChanged } from './hooks';
import { createPalms } from './palms';
import { createSandMaterial, makeSandUniforms, type SandParams, type SandSource, type SandTextures } from './sand';
import { createVegetation } from './vegetation';

interface Group {
  toggle: ToggleParam;
  meshes: Mesh[];
}

export function createBeachSystem(): GLSystem {
  let terrain: Mesh | null = null;
  let selector: CdlodSelector | null = null;
  let tex: SandTextures | null = null;
  let sp: SandParams | null = null;
  let ground: Ground | null = null;
  let veg: ReturnType<typeof createVegetation> | null = null;
  let dressing: ReturnType<typeof createDressing> | null = null;
  let terrainToggle: ToggleParam | null = null;
  let terrainShadow: ToggleParam | null = null;
  let lodK: NumberParam | null = null;
  let lastK = 0;
  let stamp: ((n: number) => void) | null = null;
  let pendingPrints = 0;
  const groups: Group[] = [];
  const disposables: Array<{ dispose(): void }> = [];
  const unsub: Array<() => void> = [];

  return {
    name: 'beach',
    async init(ctx: GLContext) {
      const t0 = performance.now();
      const p = ctx.params;
      // [polish] Baked in the boot workers (core/bakes.ts), started before the GPU device.
      const [dryRipple, waveRipple, swash, grain, macro, farHeight, aux] = await Promise.all([
        bake('beach.dryRipples'),
        bake('beach.waveRipples'),
        bake('beach.swash'),
        bake('beach.grain'),
        bake('beach.macro'),
        bake('beach.far'),
        bake('beach.aux'),
      ]);
      // [polish] reef: GPU-baked coral field, when the device allows a 17th fragment texture
      const texLimit = (ctx.renderer.backend as unknown as { device?: GPUDevice }).device?.limits.maxSampledTexturesPerShaderStage ?? 16;
      tex = { dryRipple, waveRipple, swash, grain, macro, far: farHeight, aux, reef: texLimit > 16 ? createReefBake() : undefined };
      if (tex.reef) disposables.push(tex.reef);
      disposables.push(tex.dryRipple.texture, tex.waveRipple.texture, tex.swash.texture, tex.grain.texture, tex.macro.texture, tex.far, tex.aux);
      const tBake = performance.now();

      const probe = ctx.services.state.sand(vec2(0, 0));
      const stateIsStub = probe?.isConstNode === true;
      sp = makeSandUniforms(ctx, stateIsStub);

      // Until the surface-state system exists, a local footprint field stands in for sand().
      const debugSand = stateIsStub ? createDebugSand() : null;
      if (debugSand) disposables.push(debugSand);
      const live = ctx.services.state as SurfaceStateService & { sandHeight?(xz: TSLNode): TSLNode; sandTexel?: number };
      const sandSource: SandSource = debugSand
        ? debugSand
        : {
            sand: (xz) => live.sand(xz),
            height: live.sandHeight
              ? (xz) => (live.sandHeight as (q: TSLNode) => TSLNode)(xz)
              : (xz) => {
                  const s = live.sand(xz);
                  return s.z.sub(s.y);
                },
            texel: live.sandTexel ?? 0.025,
          };

      // Terrain.
      const hT = ctx.services.terrain.heightTexture.image as { data: Float32Array; width: number; height: number };
      const nearHG = heightGradTexture(hT.data, hT.width, hT.height, ctx.services.terrain.texel);
      disposables.push(nearHG);
      ground = makeGround(ctx, nearHG, tex.far, tex.macro);
      const { geo, inst } = createPatchGeometry();
      disposables.push(geo);
      const material = createSandMaterial(ctx, tex, sp.u, ground, sandSource);
      terrain = new ThreeMesh(geo, material);
      terrain.name = 'goldenline.terrain';
      terrain.frustumCulled = false;
      terrain.castShadow = false;
      terrain.receiveShadow = true;
      terrain.matrixAutoUpdate = false;
      terrain.updateMatrix();
      ctx.scene.add(terrain);
      selector = new CdlodSelector(inst, geo);
      lodK = p.number('beach.lodRange', { label: 'terrain LOD range (×node)', group: 'beach', min: 2.1, max: 4, step: 0.05, value: RANGE_K });
      terrainToggle = p.toggle('beach.terrain', { label: 'terrain', group: 'beach', value: true });
      // At an 11° sun the terrain almost never shades itself (the dunes face the sun and their
      // backslopes stay grazing-lit; footprints have contact shadows), so it only receives.
      terrainShadow = p.toggle('beach.terrainShadow', { label: 'terrain casts shadows', group: 'beach', value: false });

      // Far field, palms, props, near vegetation.
      const tFar = performance.now();
      const far = createFarField();
      await yieldTask(); // [polish] keep boot tasks short so the loading screen keeps painting
      const tPalm = performance.now();
      const palms = createPalms(ctx, sp.u.time);
      dressing = createDressing(ctx, ground);
      await yieldTask();
      veg = createVegetation(ctx, ground, sp.u.time);
      const tEnd = performance.now();
      disposables.push(far, palms, dressing, veg);
      const add = (key: string, label: string, meshes: Mesh[]) => {
        for (const m of meshes) ctx.scene.add(m);
        groups.push({ toggle: p.toggle(key, { label, group: 'beach', value: true }), meshes });
      };
      add('beach.farField', 'headland + island', far.meshes);
      add('beach.palms', 'palms', palms.meshes);
      add('beach.props', 'wrack line, shells, rubble', dressing.meshes);
      add('beach.plants', 'dune grass + creepers', veg.meshes);

      // A caustics hook set after init rebuilds the material.
      unsub.push(
        onHooksChanged(() => {
          if (!terrain || !tex || !sp || !ground) return;
          const old = terrain.material as { dispose(): void };
          terrain.material = createSandMaterial(ctx, tex, sp.u, ground, sandSource);
          old.dispose();
        }),
      );

      // Debug: press a trail of footprints ahead of the camera (tests the state → sand path).
      // Deferred to update(): shot params are applied before the shot moves the camera.
      const prints = p.number('beach.debugPrints', { label: 'debug: stamp N footprints', group: 'beach', min: 0, max: 40, step: 1, value: 0 });
      stamp = (n: number) => {
        const c = ctx.camera;
        const fx = -Math.sin(c.rotation.y);
        const fz = -Math.cos(c.rotation.y);
        if (debugSand) debugSand.clear(c.position.x + fx * 4, c.position.z + fz * 4);
        for (let i = 0; i < n; i++) {
          const side = i & 1 ? 1 : -1;
          const d = 1.2 + i * 0.36;
          const x = c.position.x + fx * d - fz * side * 0.09;
          const z = c.position.z + fz * d + fx * side * 0.09;
          ctx.services.state.splat(SPLAT_FOOTPRINT, x, z, 0.13, 0.02, fx, fz);
          debugSand?.footprint(x, z, fx, fz, side);
        }
      };
      unsub.push(
        p.onChange((q) => {
          if (q === prints && prints.value > 0) pendingPrints = prints.value;
        }),
      );
      if (prints.value > 0) pendingPrints = prints.value;

      console.info(
        `[goldenline] beach: bakes ${(tBake - t0).toFixed(0)} ms, far field ${(tPalm - tFar).toFixed(0)} ms, ` +
          `palms+props ${(tEnd - tPalm).toFixed(0)} ms, total ${(performance.now() - t0).toFixed(0)} ms (state ${stateIsStub ? 'stub' : 'live'})`,
      );
    },

    warmup(ctx: GLContext) {
      // [polish] The engine's warmPipelines() renders every mesh through the post chain and the
      // shadow cascades (all visible, unculled); here only the LOD selection needs priming.
      if (!terrain || !selector) return;
      const cam = ctx.camera.position;
      selector.update(ctx.camera, ctx.services.terrain.height(cam.x, cam.z), false);
    },

    update(ctx: GLContext) {
      if (!selector || !sp || !terrain || !terrainToggle) return;
      sp.sync();
      if (pendingPrints > 0 && stamp) {
        stamp(pendingPrints);
        pendingPrints = 0;
      }
      const cam = ctx.camera.position;
      if (lodK && lodK.value !== lastK) {
        lastK = Math.max(2.05, lodK.value);
        selector.setRangeK(lastK);
        sp.u.rangeK.value = lastK;
      }
      terrain.visible = terrainToggle.value;
      terrain.castShadow = terrainShadow ? terrainShadow.value : false;
      if (terrain.visible) selector.update(ctx.camera, ctx.services.terrain.height(cam.x, cam.z), true);
      (sp.u.lodCenter.value as { copy(v: unknown): void }).copy(cam);
      sp.u.lodCamH.value = selector.camH;
      sp.u.time.value = ctx.time.t;
      // Far field and palms: plain toggles. Props and plants: chunk draw distance + toggle.
      for (let i = 0; i < 2; i++) {
        const g = groups[i];
        for (let j = 0; j < g.meshes.length; j++) g.meshes[j].visible = g.toggle.value;
      }
      dressing?.update(cam.x, cam.z, groups[2].toggle.value);
      veg?.update(cam.x, cam.z, groups[3].toggle.value);
    },

    dispose(ctx: GLContext) {
      for (let i = 0; i < unsub.length; i++) unsub[i]();
      unsub.length = 0;
      if (terrain) {
        ctx.scene.remove(terrain);
        (terrain.material as { dispose(): void }).dispose();
      }
      for (const g of groups) for (const m of g.meshes) ctx.scene.remove(m);
      groups.length = 0;
      for (let i = 0; i < disposables.length; i++) disposables[i].dispose();
      disposables.length = 0;
      terrain = null;
      selector = null;
      veg = null;
      dressing = null;
    },
  };
}
