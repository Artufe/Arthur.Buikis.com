// Debug views for the surface state (`state.debug`):
//   1 = channel overlay: false colour draped over the terrain / sea level across the near window
//       (foam white, wake height red/blue, disturbance magenta, wetness cyan, prints orange,
//       rims yellow)
//   2 = sand relief: a lit, displaced 14 m patch in front of the camera at the sand texel pitch,
//       with heightfield self-shadowing toward the sun (proves the data supports it).
// Debug-only meshes; both materials compile during warmup so toggling never stalls.

import { DoubleSide, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry, Vector2 } from 'three/webgpu';
import { Fn, varying, abs, clamp, float, max, mix, normalize, positionGeometry, smoothstep, transformNormalToView, uniform, vec2, vec3 } from './tsl';
import type { GLContext, SurfaceStateService, TSLNode } from '../core/contracts';
import { forwardX, forwardZ } from '../world/layout';

export interface DebugView {
  warmup(ctx: GLContext): Promise<void>;
  update(ctx: GLContext): void;
  dispose(ctx: GLContext): void;
}

const RELIEF = 14;
const RELIEF_SEG = 560;

export function createDebugView(
  ctx: GLContext,
  state: SurfaceStateService & { sandHeight(xz: TSLNode): TSLNode; sandTexel: number },
  terrainH: TSLNode,
): DebugView {
  const mode = ctx.params.number('state.debug', { label: 'debug view (1 channels, 2 relief)', group: 'state', min: 0, max: 2, step: 1, value: 0 });

  // ── Overlay ──
  const oCenter = uniform(new Vector2());
  const oGeo = new PlaneGeometry(state.size, state.size, 400, 400);
  oGeo.rotateX(-Math.PI / 2);
  const oMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: DoubleSide });
  // Vertex: the raw grid offset by the window centre. Fragment: the world position (after
  // positionNode, positionLocal is already offset, so it must not be offset again).
  const oXZ = positionGeometry.xz.add(oCenter);
  oMat.positionNode = vec3(oXZ.x, max(terrainH(oXZ), 0).add(0.06), oXZ.y);
  {
    const p = varying(oXZ).toVar();
    const oH = terrainH(p);
    const f = state.foam(p);
    const w = state.wake(p);
    const s = state.sand(p);
    const land = smoothstep(-0.05, 0.1, oH);
    const water = float(1).sub(land);
    const wakeCol = mix(vec3(0.1, 0.3, 1), vec3(1, 0.2, 0.1), smoothstep(-0.002, 0.002, w.x));
    const wakeA = clamp(abs(w.x).mul(40), 0, 1).mul(water);
    let col = vec3(0, 0.55, 0.95).mul(s.x);
    let a = s.x.mul(0.55).mul(land);
    col = mix(col, vec3(1, 0.45, 0.05), clamp(s.y.mul(90), 0, 1));
    a = max(a, clamp(s.y.mul(90), 0, 1).mul(land));
    col = mix(col, vec3(1, 0.95, 0.2), clamp(s.z.mul(160), 0, 1));
    a = max(a, clamp(s.z.mul(160), 0, 1).mul(land));
    col = mix(col, wakeCol, wakeA);
    a = max(a, wakeA);
    col = mix(col, vec3(1, 0.2, 1), w.w.mul(0.5).mul(water));
    a = max(a, w.w.mul(0.4).mul(water));
    col = mix(col, vec3(1, 1, 1), f.x);
    a = max(a, f.x);
    oMat.colorNode = col;
    oMat.opacityNode = clamp(a, 0, 0.92);
  }
  const overlay = new Mesh(oGeo, oMat);
  overlay.frustumCulled = false;
  overlay.renderOrder = 10;
  overlay.visible = false;
  ctx.scene.add(overlay);

  // ── Relief ──
  const rCenter = uniform(new Vector2());
  const rGeo = new PlaneGeometry(RELIEF, RELIEF, RELIEF_SEG, RELIEF_SEG);
  rGeo.rotateX(-Math.PI / 2);
  const rMat = new MeshStandardNodeMaterial({ side: DoubleSide });
  const dx = state.sandTexel;
  const hAt = (p: TSLNode) => terrainH(p).add(state.sandHeight(p));
  const rXZ = positionGeometry.xz.add(rCenter);
  rMat.positionNode = vec3(rXZ.x, hAt(rXZ).add(0.03), rXZ.y); // above the beach's ripples
  {
    const p = varying(rXZ).toVar();
    // Sand detail at the texel pitch; the 1 m base heightfield only through a wide baseline
    // (its bilinear facets would otherwise show as flat-shaded bands).
    const sh = (q: TSLNode) => state.sandHeight(q);
    const B = 0.6;
    const gx = sh(p.sub(vec2(dx, 0))).sub(sh(p.add(vec2(dx, 0)))).div(dx * 2).add(terrainH(p.sub(vec2(B, 0))).sub(terrainH(p.add(vec2(B, 0)))).div(B * 2));
    const gz = sh(p.sub(vec2(0, dx))).sub(sh(p.add(vec2(0, dx)))).div(dx * 2).add(terrainH(p.sub(vec2(0, B))).sub(terrainH(p.add(vec2(0, B)))).div(B * 2));
    rMat.normalNode = transformNormalToView(normalize(vec3(gx, 1, gz)));
    const s = state.sand(p);
    const wet = s.x;
    rMat.colorNode = mix(vec3(0.83, 0.74, 0.6), vec3(0.42, 0.36, 0.29), smoothstep(0.2, 0.9, wet));
    rMat.roughnessNode = mix(float(0.92), float(0.18), smoothstep(0.6, 0.98, wet));
    // Heightfield self-shadowing along the sun direction (12 steps over ~20 cm).
    const sun = ctx.services.atmosphere.sunDirNode;
    const sd = normalize(vec2(sun.x, sun.z));
    const slope = sun.y.div(max(vec2(sun.x, sun.z).length(), 1e-3));
    const h0 = hAt(p);
    let occ: TSLNode = float(0);
    for (let i = 1; i <= 12; i++) {
      const d = i * 0.016;
      const hs = hAt(p.add(sd.mul(d)));
      occ = max(occ, smoothstep(0.0, 0.0025, hs.sub(h0).sub(slope.mul(d))));
    }
    const lit = float(1).sub(occ).toVar();
    rMat.receivedShadowNode = Fn(([shadow]: [TSLNode]) => shadow.mul(lit));
  }
  const relief = new Mesh(rGeo, rMat);
  relief.frustumCulled = false;
  relief.receiveShadow = true;
  relief.visible = false;
  ctx.scene.add(relief);

  // Visible during the engine's warm frames too (behind the loading screen): the post chain renders
  // into MRT targets whose pipelines differ from compileAsync's canvas target.
  let warmFrames = 4;
  return {
    async warmup(c) {
      // [polish] The engine's warmPipelines() renders both (all objects visible) through the real
      // post chain; compileAsync's canvas-target builds were never used.
      void c;
    },
    update(c) {
      const m = Math.round(mode.value);
      const warming = warmFrames > 0;
      if (warming) warmFrames--;
      overlay.visible = warming || m === 1;
      relief.visible = warming || m === 2;
      if (m === 1) {
        oCenter.value.x = state.center.x;
        oCenter.value.y = state.center.y;
      }
      if (m === 2) {
        const cam = c.camera;
        // Centre the patch a few metres ahead of the camera, snapped to the vertex pitch.
        const yaw = cam.rotation.y;
        const step = RELIEF / RELIEF_SEG;
        const fx = cam.position.x + forwardX(yaw) * 5;
        const fz = cam.position.z + forwardZ(yaw) * 5;
        rCenter.value.x = Math.round(fx / step) * step;
        rCenter.value.y = Math.round(fz / step) * step;
      }
    },
    dispose(c) {
      c.scene.remove(overlay, relief);
      oGeo.dispose();
      oMat.dispose();
      rGeo.dispose();
      rMat.dispose();
    },
  };
}

