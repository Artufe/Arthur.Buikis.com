// Camera-centred geometry clipmap for the ocean surface, in one draw call.
//
// Level 0 is a (2n)² quad grid with spacing s0; level i ≥ 1 is the ring between ±n/2 and ±n
// quads at spacing s0·2^i. Every level is snapped to twice its own spacing, so vertices only ever
// sit on that level's world lattice (no swimming). The ring's inner edge is shifted by the
// finer level's snap offset (0 or 1 quad) so the two meet exactly, and each level geomorphs its
// odd vertices onto the coarser lattice before its outer edge (CDLOD), which makes the seams
// watertight with no T-junctions and no pops. Displacement is band-limited per vertex spacing.

import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import type { OceanFFT } from './fft';
import { CASCADES, FFT_DEPTH_FADE, FFT_N, N_CASCADES } from './spectrum';
import { swellSumGPU, type SwellGPU } from './swell-gpu';

const {
  Fn, abs, exp2, float, floor, log2, max, round, saturate, smoothstep, texture, uniform, varyingProperty, vec2, vec3, vec4, positionGeometry, positionPrevious, select, normalize,
} = TSL as unknown as Record<string, (...args: any[]) => TSLNode> & { positionGeometry: TSLNode; positionPrevious: TSLNode };

export const CLIP = { n: 64, levels: 13, s0: 0.06 };
const EARTH_R = 6.371e6;


export function buildClipmapGeometry(n = CLIP.n, levels = CLIP.levels) {
  const h = n / 2;
  const side = 2 * n + 1;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let l = 0; l < levels; l++) {
    const base = pos.length / 3;
    const map = new Int32Array(side * side).fill(-1);
    for (let iz = -n; iz <= n; iz++) {
      for (let ix = -n; ix <= n; ix++) {
        if (l > 0 && Math.abs(ix) < h && Math.abs(iz) < h) continue;
        map[(iz + n) * side + (ix + n)] = pos.length / 3 - base;
        pos.push(ix, l, iz);
      }
    }
    for (let iz = -n; iz < n; iz++) {
      for (let ix = -n; ix < n; ix++) {
        if (l > 0 && ix >= -h && ix + 1 <= h && iz >= -h && iz + 1 <= h) continue;
        const a = map[(iz + n) * side + (ix + n)];
        const b = map[(iz + n) * side + (ix + 1 + n)];
        const c = map[(iz + 1 + n) * side + (ix + n)];
        const d = map[(iz + 1 + n) * side + (ix + 1 + n)];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        // Counter-clockwise seen from above (+Y normal).
        idx.push(base + a, base + d, base + b, base + a, base + c, base + d);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1));
  g.boundingSphere = new Sphere(new Vector3(), 1e6);
  return g;
}

/** Inputs a displacement hook receives (vertex stage, inside the ocean's positionNode Fn). */
export interface SurfaceHookInput {
  /** Rest (undisplaced) XZ of the vertex. */
  rest: TSLNode;
  /** Swell + FFT displacement so far (vec3). */
  disp: TSLNode;
  /** Swell-only displacement at the previous frame (vec3), for motion vectors. */
  dispPrev: TSLNode;
  /** Effective vertex spacing (m): band-limit anything you add to ≥ ~4× this. */
  spacing: TSLNode;
  /** Still-water depth (m) and swell brokenness (0-1) at the vertex. */
  depth: TSLNode;
  broken: TSLNode;
  /**
   * [surfzone] The swell's own part of the above: displacement now and at the previous frame, and
   * its slope terms, so a hook can replace the swell instead of adding to it.
   */
  swell: { d: TSLNode; dPrev: TSLNode; dd: TSLNode; dxz: TSLNode };
}

/** What a hook adds. `dd` = (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z) and `dxz` feed the normals. */
export interface SurfaceHookOutput {
  d: TSLNode;
  dPrev?: TSLNode;
  dd?: TSLNode;
  dxz?: TSLNode;
}

export type SurfaceHook = (p: SurfaceHookInput) => SurfaceHookOutput;

export interface OceanSurface {
  /**
   * Add a vertex-stage displacement (e.g. the breaking-wave system blending its breaker into
   * the surface). Hooks run when the material's shader is built, so register them in init();
   * after the first compile call `mesh.material.needsUpdate = true`.
   */
  addHook(hook: SurfaceHook): void;
  /** Vertex world position (material.positionNode; the mesh has an identity transform). */
  positionNode: TSLNode;
  /** Varyings written by positionNode, readable in any fragment node of the same material. */
  vRest: TSLNode;
  vSwellD: TSLNode;
  vSwellX: TSLNode;
  /** Camera centre uniform (clipmap snapping), updated at render time. */
  uCenter: TSLNode;
  /** 0-1 gain on the whole FFT sea (the ocean.fft toggle). */
  uFftGain: TSLNode;
  /** World-space surface normal (fragment), from the swell varyings + all FFT cascades. */
  normal(): TSLNode;
  /** Surface derivatives (fragment): vec4(∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z) and ∂Dx/∂z. */
  derivatives(): { dd: TSLNode; dxz: TSLNode };
  /** Jacobian det of the horizontal displacement (fragment): < 1 compressed, < 0 folded. */
  jacobian(): TSLNode;
  /** Debug: cascade c's derivative texture at an explicit mip level, at this fragment. */
  debugMip(c: number, level: number): TSLNode;
  /** Displacement of all cascades at a rest position (vertex-style, explicit LOD spacing). */
  fftDisplacement(xz: TSLNode, sEff: TSLNode, depth: TSLNode, cascades?: number): TSLNode;
}

export function createOceanSurface(fft: OceanFFT, swell: SwellGPU): OceanSurface {
  const center = new Vector3();
  const uCenter = uniform(center).onRenderUpdate(({ camera }: { camera: { matrixWorld: { elements: number[] } } }) => {
    const e = camera.matrixWorld.elements;
    return center.set(e[12], e[13], e[14]);
  });
  const uS0 = float(CLIP.s0);
  const hooks: SurfaceHook[] = [];
  const uFftGain = uniform(1);
  const n = CLIP.n;
  const vRest = varyingProperty('vec2', 'vOceanRest');
  const vSwellD = varyingProperty('vec4', 'vOceanSwellD');
  // (∂Dx/∂z of the swell, brokenness, still-water depth, vertex spacing)
  const vSwellX = varyingProperty('vec4', 'vOceanSwellX');

  const rotFwd = (v: TSLNode, c: number) => {
    const cr = Math.cos(CASCADES[c].rot);
    const sr = Math.sin(CASCADES[c].rot);
    // world → cascade frame: R(−rot)
    return vec2(v.x.mul(cr).add(v.y.mul(sr)), v.y.mul(cr).sub(v.x.mul(sr)));
  };
  const cascadeUV = (xz: TSLNode, c: number) => rotFwd(xz, c).div(CASCADES[c].L).add(0.5 / FFT_N);
  const depthFade = (depth: TSLNode, c: number) => smoothstep(FFT_DEPTH_FADE[c][0], FFT_DEPTH_FADE[c][1], depth);

  const fftDisplacement = (xz: TSLNode, sEff: TSLNode, depth: TSLNode, cascades = 3) => {
    const d = vec3(0, 0, 0).toVar();
    for (let c = 0; c < cascades; c++) {
      const texel = CASCADES[c].L / FFT_N;
      const lod = max(log2(max(sEff, 1e-5).div(texel)), 0);
      const t = texture(fft.disp, cascadeUV(xz, c)).level(lod).depth(c).toVar();
      const cr = Math.cos(CASCADES[c].rot);
      const sr = Math.sin(CASCADES[c].rot);
      const f = depthFade(depth, c).mul(uFftGain);
      d.addAssign(vec3(t.x.mul(cr).sub(t.z.mul(sr)), t.y, t.x.mul(sr).add(t.z.mul(cr))).mul(f));
    }
    return d;
  };

  const positionNode = Fn(() => {
    const g = positionGeometry;
    const level = g.y;
    const s = uS0.mul(exp2(level)).toVar();
    const cxz = vec2(uCenter.x, uCenter.z);
    const C = floor(cxz.div(s.mul(2))).mul(s.mul(2));
    const Cf = floor(cxz.div(s)).mul(s);
    const o = round(Cf.sub(C).div(s));
    const local = vec2(g.x, g.z).toVar();
    // Ring levels: move the inner edge onto the finer level's actual footprint.
    const inner = level.greaterThan(0.5).and(max(abs(g.x), abs(g.z)).lessThan(n / 2 + 0.5));
    local.addAssign(select(inner, o, vec2(0, 0)));
    const p = C.add(local.mul(s)).toVar();
    // Geomorph odd vertices onto the coarser lattice before the level's outer edge.
    const dc = max(abs(p.x.sub(cxz.x)), abs(p.y.sub(cxz.y)));
    const m = saturate(dc.div(s).sub(n * 0.62).div(n * 0.33)).toVar();
    const gi = round(p.div(s));
    const odd = gi.sub(floor(gi.mul(0.5)).mul(2));
    const x0 = p.sub(odd.mul(s).mul(m)).toVar();
    const sEff = s.mul(m.add(1)).toVar();

    const sw = swellSumGPU(swell, x0, sEff, true);
    const swOnly = { d: sw.d, dPrev: sw.dPrev!, dd: sw.dd, dxz: sw.dxz };
    const fftD = fftDisplacement(x0, sEff, sw.depth).toVar();
    const disp = sw.d.add(fftD).toVar();
    // Motion vectors for TRAA / motion blur: the swell's true previous position; the FFT sea is
    // treated as static for one frame (its textures only exist for the current time).
    const prev = sw.dPrev.add(fftD).toVar();
    const dd = sw.dd.toVar();
    const dxz = sw.dxz.toVar();
    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i]({ rest: x0, disp, dispPrev: prev, spacing: sEff, depth: sw.depth, broken: sw.broken, swell: swOnly });
      disp.addAssign(h.d);
      prev.addAssign(h.dPrev ?? h.d);
      if (h.dd) dd.addAssign(h.dd);
      if (h.dxz) dxz.addAssign(h.dxz);
    }
    vRest.assign(x0);
    vSwellD.assign(dd);
    vSwellX.assign(vec4(dxz, sw.broken, sw.depth, sEff));
    const rel = x0.sub(cxz);
    const drop = rel.dot(rel).div(2 * EARTH_R);
    positionPrevious.assign(vec3(x0.x.add(prev.x), prev.y.sub(drop), x0.y.add(prev.z)));
    return vec3(x0.x.add(disp.x), disp.y.sub(drop), x0.y.add(disp.z));
  })();

  const derivatives = () => {
    const dd = vSwellD.toVar();
    const dxz = vSwellX.x.toVar();
    const depth = vSwellX.z;
    for (let c = 0; c < N_CASCADES; c++) {
      const uv = cascadeUV(vRest, c);
      const t = texture(fft.deriv, uv).depth(c).toVar();
      const dx = texture(fft.disp, uv).depth(c).w;
      const cr = Math.cos(CASCADES[c].rot);
      const sr = Math.sin(CASCADES[c].rot);
      const f = depthFade(depth, c).mul(uFftGain).toVar();
      // Rotate the slope vector and the horizontal Jacobian tensor back to world.
      const sx = t.x.mul(cr).sub(t.y.mul(sr));
      const sz = t.x.mul(sr).add(t.y.mul(cr));
      const a = t.z;
      const dd2 = t.w;
      const cs = cr * sr;
      const jxx = a.mul(cr * cr).sub(dx.mul(2 * cs)).add(dd2.mul(sr * sr));
      const jzz = a.mul(sr * sr).add(dx.mul(2 * cs)).add(dd2.mul(cr * cr));
      const jxz = a.mul(cs).add(dx.mul(cr * cr - sr * sr)).sub(dd2.mul(cs));
      dd.addAssign(vec4(sx, sz, jxx, jzz).mul(f));
      dxz.addAssign(jxz.mul(f));
    }
    return { dd, dxz };
  };

  const normalFrom = (dd: TSLNode, dxz: TSLNode) => {
    const jx = dd.z.add(1);
    const jz = dd.w.add(1);
    const J = jx.mul(jz).sub(dxz.mul(dxz));
    return normalize(vec3(dd.y.mul(dxz).sub(jz.mul(dd.x)), max(J, 0.05), dxz.mul(dd.x).sub(dd.y.mul(jx))));
  };

  return {
    addHook: (h: SurfaceHook) => {
      hooks.push(h);
    },
    positionNode,
    vRest,
    vSwellD,
    vSwellX,
    uCenter,
    uFftGain,
    normal() {
      const { dd, dxz } = derivatives();
      return normalFrom(dd, dxz);
    },
    derivatives,
    jacobian() {
      const { dd, dxz } = derivatives();
      return dd.z.add(1).mul(dd.w.add(1)).sub(dxz.mul(dxz));
    },
    fftDisplacement,
    debugMip: (c: number, level: number) => texture(fft.deriv, cascadeUV(vRest, c)).level(level).depth(c),
  };
}
