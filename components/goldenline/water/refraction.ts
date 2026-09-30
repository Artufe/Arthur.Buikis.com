// Screen-space refraction of the seabed. The water draws after every opaque (it sits in the
// transparent list), so one framebuffer copy of colour + depth holds the lit seabed, reef and
// pilings without water. For each water pixel the view ray is refracted by Snell's law through
// the shading normal, marched to the (smoothed) seabed depth, projected back to the screen and
// validated against the depth copy: a sample in front of the surface (a piling, the board) or
// above the water falls back to the straight-through pixel. The distance through water and the
// depth of the hit then drive the Beer–Lambert absorption in material.ts. Dispersion: the red and
// blue channels refract with their own index (1.331 / 1.340 vs 1.333), scaled by a param.

import { DepthTexture, FramebufferTexture, LinearFilter, Node, NodeUpdateType, Vector2, Vector4, type NodeFrame, type Texture, type WebGPURenderer } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';

const {
  float, floor, int, ivec2, max, min, nodeObject, select, texture, textureSize, vec2, vec3, vec4, refract, textureLoad, getViewPosition, getScreenPosition, mix, clamp,
} = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { cameraViewMatrix, cameraWorldMatrix, cameraProjectionMatrix, cameraProjectionMatrixInverse, positionView, screenUV } = TSL as unknown as Record<string, TSLNode>;

export interface Refraction {
  sceneTexture: FramebufferTexture;
  /** Scene colour behind the water at uv (explicit LOD, branch-safe). */
  color(uv: TSLNode): TSLNode;
  /** Scene depth [0,1] at uv (textureLoad). */
  depth(uv: TSLNode): TSLNode;
  worldAt(uv: TSLNode, d: TSLNode): TSLNode;
  toScreen(p: TSLNode): TSLNode;
  dispose(): void;
}

/** Debug counters: which copy path ran (read via ocean.gpu.waterCopyStats). */
export const copyStats = { merged: 0, fallback: 0 };

const _rect = new Vector4();
const _size = new Vector2();
const _optsC: { renderTarget: unknown } = { renderTarget: null };
const _optsD: { renderTarget: unknown } = { renderTarget: null };

type Internals = {
  _currentRenderContext: { renderTarget: unknown; textures: unknown[]; depthTexture: unknown; depth: boolean; stencil: boolean; viewport: boolean; scissor: boolean } | null;
  _textures: { updateTexture(t: unknown, o: unknown): void };
  backend: {
    get(o: unknown): { texture?: GPUTexture; currentPass?: GPURenderPassEncoder | null; encoder?: GPUCommandEncoder; descriptor?: GPURenderPassDescriptor };
    _isRenderCameraDepthArray?(rc: unknown): boolean;
    _copyFramebufferToTexture?(enc: GPUCommandEncoder, t: unknown, src: GPUTexture, dst: GPUTexture, rect: Vector4): void;
    _resetRenderContextData?(d: unknown): void;
    updateViewport(rc: unknown): void;
    updateScissor(rc: unknown): void;
  };
};

function copyFallback(renderer: WebGPURenderer, color: FramebufferTexture, depth: DepthTexture) {
  copyStats.fallback++;
  renderer.copyFramebufferToTexture(color);
  renderer.copyFramebufferToTexture(depth as unknown as FramebufferTexture);
}

function syncSize(t: { image: { width: number; height: number }; needsUpdate: boolean }) {
  if (t.image.width !== _size.x || t.image.height !== _size.y) {
    t.image.width = _size.x;
    t.image.height = _size.y;
    t.needsUpdate = true;
  }
}

/**
 * Copies the scene colour and depth under ONE render-pass break. three's viewport texture nodes
 * each end and restart the pass for their own copy; on a tile-based GPU every break stores and
 * reloads all MRT attachments (≈ 1.3 ms at 1440p on the M3), so two copies cost two breaks.
 * Falls back to three's public copies if the backend internals don't look as expected.
 */
function copyColorAndDepth(renderer: WebGPURenderer, color: FramebufferTexture, depth: DepthTexture) {
  const r = renderer as unknown as Internals;
  const rc = r._currentRenderContext;
  const b = r.backend;
  if (!rc || !rc.renderTarget || !rc.depthTexture || !b._copyFramebufferToTexture || !b._resetRenderContextData || b._isRenderCameraDepthArray?.(rc)) return copyFallback(renderer, color, depth);
  const data = b.get(rc);
  if (!data.currentPass || !data.encoder || !data.descriptor) return copyFallback(renderer, color, depth);
  // One options object per texture (updateTexture writes size/format fields into it).
  _optsC.renderTarget = rc.renderTarget;
  _optsD.renderTarget = rc.renderTarget;
  r._textures.updateTexture(color, _optsC);
  r._textures.updateTexture(depth, _optsD);
  const srcC = b.get(rc.textures[0]).texture;
  const srcD = b.get(rc.depthTexture).texture;
  const dstC = b.get(color).texture;
  const dstD = b.get(depth).texture;
  if (!srcC || !srcD || !dstC || !dstD || srcC.format !== dstC.format || srcD.format !== dstD.format) return copyFallback(renderer, color, depth);
  _rect.set(0, 0, color.image.width, color.image.height);
  data.currentPass.end();
  const enc = data.encoder;
  b._copyFramebufferToTexture(enc, color, srcC, dstC, _rect);
  b._copyFramebufferToTexture(enc, depth, srcD, dstD, _rect);
  const desc = data.descriptor;
  const atts = desc.colorAttachments as GPURenderPassColorAttachment[];
  for (let i = 0; i < atts.length; i++) atts[i].loadOp = 'load';
  if (rc.depth && desc.depthStencilAttachment) desc.depthStencilAttachment.depthLoadOp = 'load';
  if (rc.stencil && desc.depthStencilAttachment) desc.depthStencilAttachment.stencilLoadOp = 'load';
  data.currentPass = enc.beginRenderPass(desc);
  copyStats.merged++;
  b._resetRenderContextData(data);
  if (rc.viewport) b.updateViewport(rc);
  if (rc.scissor) b.updateScissor(rc);
}

/** A zero-valued node whose only job is the per-render copy (updateBefore), before the water draws. */
class SceneCopyNode extends Node {
  static get type() {
    return 'WaterSceneCopyNode';
  }
  constructor(private readonly color: FramebufferTexture, private readonly depthTex: DepthTexture) {
    super('float');
    this.updateBeforeType = NodeUpdateType.RENDER;
  }
  updateBefore(frame: NodeFrame): boolean | undefined {
    const renderer = (frame as unknown as { renderer: WebGPURenderer }).renderer;
    const rt = renderer.getRenderTarget() as { width: number; height: number } | null;
    if (rt) _size.set(rt.width, rt.height);
    else renderer.getDrawingBufferSize(_size);
    syncSize(this.color as never);
    syncSize(this.depthTex as never);
    copyColorAndDepth(renderer, this.color, this.depthTex);
    return undefined;
  }
  setup() {
    return float(0);
  }
}

export function createRefraction(): Refraction {
  const fb = new FramebufferTexture(1, 1);
  fb.name = 'water.sceneCopy';
  fb.minFilter = LinearFilter;
  fb.magFilter = LinearFilter;
  fb.generateMipmaps = false;
  const dt = new DepthTexture(1, 1);
  dt.name = 'water.depthCopy';
  const copy = nodeObject(new SceneCopyNode(fb, dt));
  const colorT = texture(fb);
  const depthT = texture(dt);
  return {
    sceneTexture: fb,
    // `copy` (0) rides in every lookup so the node is in the graph and its updateBefore runs.
    color: (uv) => colorT.sample(uv.add(copy)).level(0),
    depth: (uv) => textureLoad(dt, ivec2(clamp(uv, 0, 0.9999).mul(textureSize(depthT, 0)))).x.add(copy),
    worldAt: (uv, d) => cameraWorldMatrix.mul(vec4(getViewPosition(uv, d, cameraProjectionMatrixInverse), 1)).xyz,
    toScreen: (p) => getScreenPosition(cameraViewMatrix.mul(vec4(p, 1)).xyz, cameraProjectionMatrix),
    dispose() {
      fb.dispose();
      dt.dispose();
    },
  };
}

/**
 * Exact (1 m bake, bilinear) seabed height at world XZ from terrain.heightTexture, via four
 * textureLoads (R32F may not be filterable). Outside the bake, `fallback`.
 */
export function seabedHeight(tex: Texture, bounds: [number, number, number, number], texel: number, xz: TSLNode, fallback: TSLNode) {
  const [minX, minZ, maxX, maxZ] = bounds;
  const w = Math.round((maxX - minX) / texel);
  const h = Math.round((maxZ - minZ) / texel);
  const q = vec2(xz.x.sub(minX).div(texel).sub(0.5), xz.y.sub(minZ).div(texel).sub(0.5)).toVar();
  const i0 = clamp(floor(q), vec2(0, 0), vec2(w - 2, h - 2)).toVar();
  const f = clamp(q.sub(i0), 0, 1).toVar();
  const i = ivec2(int(i0.x), int(i0.y)).toVar();
  const h00 = textureLoad(tex, i).x;
  const h10 = textureLoad(tex, i.add(ivec2(1, 0))).x;
  const h01 = textureLoad(tex, i.add(ivec2(0, 1))).x;
  const h11 = textureLoad(tex, i.add(ivec2(1, 1))).x;
  const hb = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  const inside = xz.x.greaterThan(minX + 1).and(xz.x.lessThan(maxX - 1)).and(xz.y.greaterThan(minZ + 1)).and(xz.y.lessThan(maxZ - 1));
  return select(inside, hb, fallback);
}

export interface RefractInput {
  P: TSLNode;
  V: TSLNode;
  /** Normal used for refraction. */
  N: TSLNode;
  /** Water column under P (m, exact seabed). */
  depthEst: TSLNode;
  /** Water column under an arbitrary XZ (m): for the far end of the refracted path. */
  depthAt: (xz: TSLNode) => TSLNode;
  dispersion: TSLNode;
  /** Scale on the normal-driven image distortion (1 = the physical displacement). */
  strength: TSLNode;
}

export interface RefractResult {
  color: TSLNode;
  /** Distance travelled through water along the refracted view ray to the seabed (m). */
  path: TSLNode;
  /** Depth of the seabed at the ray's end (m): the sun's leg down to it. */
  hitDepth: TSLNode;
  /** 1 where there is geometry behind the water (not the sky/far plane). */
  hit: TSLNode;
  /** Vertical water depth straight behind the pixel (m): → 0 at the waterline. */
  thin: TSLNode;
  /** Fraction of the distortion used (1, 0.5 or 0 when an occluder sits there). */
  scale: TSLNode;
  /** 1 where the pixel is a crest seen against the sky or land: the view ray leaves through its back. */
  through: TSLNode;
  dbg: TSLNode;
}

const ETA = 1 / 1.333;
const ETA_R = 1 / 1.331;
const ETA_B = 1 / 1.34;

/**
 * Must run inside an Fn. The image is the straight-through pixel displaced by the screen motion
 * the wave normal causes relative to a flat surface (so the seabed swims with the waves at the
 * physical scale for its depth); the absorption path is the refracted ray's, from the exact
 * seabed under both of its ends. Occluders (pilings, the board) in front of a displaced sample
 * shrink the displacement instead of leaking through.
 */
export function refractScene(r: Refraction, i: RefractInput, noDepth = false): RefractResult {
  const { P, V, N } = i;
  const uv0 = screenUV;
  const selfZ = positionView.z;
  const d0 = (noDepth ? float(0.5) : r.depth(uv0)).toVar();
  const S0 = r.worldAt(uv0, d0).toVar();
  const up = vec3(0, 1, 0);
  // The straight-through background is above the water surface: a crest silhouette.
  const through = S0.y.greaterThan(P.y.add(0.02)).toVar();
  const D0 = max(i.depthEst, 0.02).toVar();
  const T = refract(V.negate(), N, ETA).toVar();
  const Tf = refract(V.negate(), up, ETA);
  const L0 = min(D0.div(max(Tf.y.negate(), 0.25)), 22).toVar();
  const uvF = r.toScreen(P.add(Tf.mul(L0))).toVar();
  const off = r.toScreen(P.add(T.mul(L0))).sub(uvF).mul(i.strength).toVar();
  const accept = (uv: TSLNode) => {
    const on = uv.x.greaterThan(0.001).and(uv.x.lessThan(0.999)).and(uv.y.greaterThan(0.001)).and(uv.y.lessThan(0.999));
    const S = noDepth ? P.sub(vec3(0, 1, 0)) : r.worldAt(uv, r.depth(clamp(uv, 0.001, 0.999)));
    const z = cameraViewMatrix.mul(vec4(S, 1)).z;
    // Behind the surface, and below the water — unless the pixel itself is a crest seen against
    // the sky/land, where the ray exits the back of the crest into the air.
    return select(on.and(z.lessThan(selfZ.sub(0.02))).and(S.y.lessThan(P.y.add(0.05)).or(through)), float(1), float(0));
  };
  const k1 = accept(uv0.add(off)).toVar();
  const k2 = accept(uv0.add(off.mul(0.5))).mul(k1.oneMinus()).toVar();
  const scale = k1.add(k2.mul(0.5)).toVar();
  const uvS = clamp(uv0.add(off.mul(scale)), 0.001, 0.999).toVar();
  // Dispersion: red and blue refract with their own index (their extra displacement, same scale).
  const k = i.dispersion.mul(scale).mul(i.strength);
  const uvT = r.toScreen(P.add(T.mul(L0)));
  const offR = r.toScreen(P.add(refract(V.negate(), N, ETA_R).mul(L0))).sub(uvT).mul(k);
  const offB = r.toScreen(P.add(refract(V.negate(), N, ETA_B).mul(L0))).sub(uvT).mul(k);
  const cg = r.color(uvS).rgb;
  const cr = r.color(clamp(uvS.add(offR), 0.001, 0.999)).r;
  const cb = r.color(clamp(uvS.add(offB), 0.001, 0.999)).b;
  // Path: refracted ray to the seabed, using the depth at both ends (sloping reef, bommies).
  const Tdn = max(T.y.negate(), 0.25);
  const end = P.add(T.mul(min(D0.div(Tdn), 22)));
  const D1 = max(i.depthAt(end.xz), 0.02);
  const Dm = D0.add(D1).mul(0.5).toVar();
  const path = min(Dm.div(Tdn), 40);
  const known = i.depthEst.lessThan(80);
  const hitGeo = select(d0.lessThan(0.999999), float(1), float(0));
  const hit = select(known, float(1), hitGeo);
  return {
    color: vec3(cr, cg.y, cb),
    path: mix(float(200), path, hit),
    hitDepth: mix(float(60), Dm, hit),
    hit,
    // [polish] never thinner than the seabed bake says (less a bake-error margin): what is behind a
    // water pixel can be a piling or the board just below the surface, which made the water there
    // "thin shore water" (cyan streaks down every piling).
    thin: select(d0.lessThan(0.999999), max(max(P.y.sub(S0.y), i.depthEst.sub(0.15)), 0), float(100)),
    scale,
    through: select(through, float(1), float(0)),
    dbg: vec3(select(d0.lessThan(0.999999), float(1), float(0)), select(through, float(1), float(0)), clamp(S0.y.sub(P.y).div(50).add(0.5), 0, 1)),
  };
}
