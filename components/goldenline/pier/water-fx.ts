// Where the pier meets the water: every frame each wet piling samples the ocean, writes foam and
// wake into the surface state (the trailing foam wake), drives its foam collar (the slosh and
// wrap round the post, stretched downstream), and fires pooled spray when whitewater hits it.

import { DynamicDrawUsage, type BufferGeometry, BufferAttribute, BufferGeometry as BG, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn,
  positionPrevious,
  abs,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  length,
  max,
  mix as mix_,
  positionGeometry,
  positionLocal,
  smoothstep,
  texture as texture_,
  vec2 as vec2_,
  vec3 as vec3_,
  vec4,
} from 'three/tsl';
import { type GLContext, type OceanSample, SPLAT_FOAM, SPLAT_WAKE, type TSLNode } from '../core/contracts';
import type { NumberParam, ToggleParam } from '../core/params';
import type { PierPlan } from './plan';
import type { PierUniforms } from './shade';
import type { SprayPool } from './spray';
import type { PierTextures } from './textures';

// The TSL typings reject mixed node/number args that TSL itself accepts; loosen locally.
const mix = mix_ as unknown as (...a: unknown[]) => TSLNode;
const texture = texture_ as unknown as (...a: unknown[]) => TSLNode;
const vec2 = vec2_ as unknown as (...a: unknown[]) => TSLNode;
const vec3 = vec3_ as unknown as (...a: unknown[]) => TSLNode;

export interface WaterFxParams {
  enabled: ToggleParam;
  collars: ToggleParam;
  foamRate: NumberParam;
  wakeRate: NumberParam;
  sprayRate: NumberParam;
  current: NumberParam;
  surge: NumberParam;
  samples: NumberParam;
}

/** Polar grid in metres around a piling (y = 0), dense near the post. */
function collarGeometry(): BufferGeometry {
  const radial = 40;
  const rings = 10;
  const rIn = 0.1;
  const rOut = 1.7;
  const ring = radial + 1;
  const pos = new Float32Array((rings + 1) * ring * 3);
  const nrm = new Float32Array((rings + 1) * ring * 3);
  const uv = new Float32Array((rings + 1) * ring * 2);
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const r = rIn + (rOut - rIn) * t * t;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const k = i * ring + j;
      pos[k * 3] = Math.cos(a) * r;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = Math.sin(a) * r;
      nrm[k * 3 + 1] = 1;
      uv[k * 2] = j / radial;
      uv[k * 2 + 1] = t;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * ring + j;
      const b = a + ring;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new BG();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const FOAM_EVERY = 4;

/** The ocean's GPU FFT displacement, when the ocean exposes it (ocean/surface.ts). */
type FftDisplacement = (xz: TSLNode, sEff: TSLNode, depth: TSLNode, cascades?: number) => TSLNode;

export function createWaterFx(plan: PierPlan, tex: PierTextures, u: PierUniforms, spray: SprayPool, p: WaterFxParams, fftDisp: FftDisplacement | null) {
  // Only pilings standing in water take part.
  const wet: number[] = [];
  for (let i = 0; i < plan.piles.length; i++) if (plan.piles[i].ground < 0.3) wet.push(i);
  const n = wet.length;
  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  const pr = new Float32Array(n);
  const cool = new Float32Array(n);
  const foamDt = new Float32Array(n);
  // ocean.sample() costs ~35 µs, so each frame only a few pilings are re-sampled (round robin)
  // and the rest extrapolate their surface height with the sampled vertical velocity.
  const sH = new Float32Array(n);
  const sVx = new Float32Array(n);
  const sVy = new Float32Array(n);
  const sVz = new Float32Array(n);
  const sB = new Float32Array(n);
  const sT = new Float32Array(n);
  // Mutable scalars live in typed arrays: a double stored in a closure slot is re-boxed (a heap
  // allocation) on every write. [round-robin cursor, rng state], [last time].
  const iv = new Uint32Array([0, 12345]);
  const fv = new Float64Array([-1e9]);
  for (let k = 0; k < n; k++) {
    const pile = plan.piles[wet[k]];
    px[k] = pile.x;
    pz[k] = pile.z;
    pr[k] = pile.r;
    cool[k] = (k * 0.137) % 0.5;
  }

  // Collar instance data: (water height, flow dir x, flow dir z, speed), (intensity, breaking, radius, depth).
  const flowA = new InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const fxA = new InstancedBufferAttribute(new Float32Array(n * 4), 4);
  flowA.setUsage(DynamicDrawUsage);
  fxA.setUsage(DynamicDrawUsage);
  const flow: TSLNode = instancedBufferAttribute(flowA, 'vec4');
  const fx: TSLNode = instancedBufferAttribute(fxA, 'vec4');

  const mat = new MeshStandardNodeMaterial({ transparent: true, depthWrite: false });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  const g = positionGeometry;
  const dir = vec2(flow.y, flow.z);
  const perp = vec2(dir.y.negate(), dir.x);
  const along = dot(g.xz, dir);
  const across = dot(g.xz, perp);
  const speed = flow.w;
  const alongS = along.mul(along.greaterThan(0).select(speed.mul(1.1).add(1), float(1)));
  const rho = length(g.xz);
  const bow = speed.mul(speed).div(19.6).mul(exp(rho.sub(fx.z).negate().div(0.22))).mul(along.lessThan(0).select(float(1), float(0.25)));
  const centre = positionLocal.sub(g);
  const off = dir.mul(alongS).add(perp.mul(across));
  // The CPU sample carries the swell; the FFT chop only exists on the GPU, so add it here or
  // the collar sinks under every wavelet.
  mat.positionNode = Fn(() => {
    const wx = centre.x.add(off.x);
    const wz = centre.z.add(off.y);
    const chop = fftDisp ? fftDisp(vec2(wx, wz), float(0.08), fx.w, 3).y : float(0);
    const p = vec3(wx, flow.x.add(chop).add(0.02).add(bow.min(0.5)), wz);
    positionPrevious.assign(p);
    return p;
  })();
  mat.alphaTest = 0.004;
  const vAlong = alongS.toVarying('vCollarAlong');
  const vAcross = across.toVarying('vCollarAcross');
  const vRho = rho.toVarying('vCollarRho');
  const t = u.time;
  const n1 = texture(tex.noise, vec2(vAlong.sub(t.mul(speed).mul(0.8)), vAcross.add(fx.w.mul(1.37))).mul(0.9)).a;
  const n2 = texture(tex.noise, vec2(vAlong.sub(t.mul(speed).mul(0.55)).add(3.1), vAcross.mul(1.3)).mul(1.7)).b;
  const n3 = texture(tex.noise, vec2(vAlong, vAcross).mul(0.35).add(t.mul(0.02))).g;
  const foamN = n1.mul(0.5).add(n2.mul(0.35)).add(n3.mul(0.15));
  const ringM = exp(vRho.sub(fx.z).negate().div(speed.mul(0.12).add(0.14)));
  const tail = vAlong.greaterThan(0).select(float(1), float(0))
    .mul(exp(abs(vAcross).negate().div(vAlong.mul(0.32).add(0.1))))
    .mul(exp(vAlong.negate().div(speed.mul(1.4).add(0.35))));
  const m = max(ringM, tail.mul(0.9)).mul(fx.x);
  // Lace (thin filaments where the noise crosses its midline) everywhere the mask reaches, and
  // solid bubbly patches only where the flow is strong.
  const lace = smoothstep(0.075, 0.0, abs(n1.sub(0.5))).mul(0.75).add(smoothstep(0.06, 0.0, abs(n2.sub(0.5))).mul(0.5));
  const th = float(0.8).sub(m.mul(0.45));
  const fill = smoothstep(th, th.add(0.18), foamN);
  const alpha = max(lace.mul(m.clamp(0, 1)).mul(0.8), fill.mul(m.clamp(0, 1)))
    .mul(smoothstep(1.7, 1.1, vRho))
    .mul(smoothstep(fx.z, fx.z.add(0.04), vRho));
  mat.colorNode = vec4(mix(vec3(0.72, 0.76, 0.76), vec3(0.94, 0.94, 0.91), foamN), 1);
  mat.roughnessNode = float(0.55);
  mat.opacityNode = alpha.mul(0.92);
  const collars = new InstancedMesh(collarGeometry(), mat, n);
  const mm = new Matrix4();
  for (let k = 0; k < n; k++) {
    collars.setMatrixAt(k, mm.makeTranslation(px[k], 0, pz[k]));
    fxA.array[k * 4 + 2] = pr[k];
    fxA.array[k * 4 + 3] = Math.max(0.1, -plan.piles[wet[k]].ground);
  }
  collars.frustumCulled = false;
  collars.receiveShadow = true;
  collars.renderOrder = 4;

  const s: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, breaking: 0, depth: 0 };
  const rnd = () => {
    iv[1] = Math.imul(iv[1], 1664525) + 1013904223;
    return iv[1] / 4294967296;
  };

  return {
    collars,
    count: n,
    update(ctx: GLContext) {
      const dt = ctx.time.dt;
      const tt = ctx.time.t;
      const on = p.enabled.value;
      collars.visible = on && p.collars.value;
      if (!on) return;
      const ocean = ctx.services.ocean;
      const state = ctx.services.state;
      const fa = flowA.array as Float32Array;
      const fb = fxA.array as Float32Array;
      // Debug: a whitewater bore marching shoreward along the pier (tests spray and foam).
      const surge = p.surge.value;
      const boreX = -170 + ((tt * 6) % 190);
      const cur = p.current.value;
      // Re-sample everything after a time jump (shots, teleports); otherwise a few per frame.
      const all = Math.abs(tt - fv[0]) > 0.5;
      fv[0] = tt;
      const budget = all ? n : Math.min(n, Math.max(1, p.samples.value | 0));
      for (let q = 0; q < budget; q++) {
        const k = iv[0];
        iv[0] = (k + 1) % n;
        ocean.sample(px[k], pz[k], s);
        sH[k] = s.height;
        sVx[k] = s.vx;
        sVy[k] = s.vy;
        sVz[k] = s.vz;
        sB[k] = s.breaking;
        sT[k] = tt;
      }
      for (let k = 0; k < n; k++) {
        const age = Math.min(0.5, tt - sT[k]);
        const height = sH[k] + sVy[k] * age;
        let vx = sVx[k] + cur * 0.24;
        let vz = sVz[k] + cur * 0.97;
        let b = sB[k];
        if (surge > 0) {
          const d = (px[k] - boreX) / 5;
          const bb = surge * Math.exp(-d * d);
          b = Math.max(b, bb);
          vx += bb * 3.2;
        }
        const sp = Math.sqrt(vx * vx + vz * vz);
        const inv = sp > 1e-4 ? 1 / sp : 0;
        const dx = sp > 1e-4 ? vx * inv : 1;
        const dz = sp > 1e-4 ? vz * inv : 0;
        fa[k * 4] = height;
        fa[k * 4 + 1] = dx;
        fa[k * 4 + 2] = dz;
        fa[k * 4 + 3] = sp;
        fb[k * 4] = Math.min(1.4, 0.5 + sp * 0.45 + b * 1.2);
        fb[k * 4 + 1] = b;
        if (dt > 0) {
          // Trailing foam wake and disturbance, in proportion to the flow past the post.
          // (state/README.md: FOAM strength is coverage per splat → 1 - e^(-rate·dt); WAKE is a
          // depression depth in m with the water velocity in m/s as dir.)
          // Each piling splats foam every FOAM_EVERY frames with the accumulated time (the brush is
          // persistent, so 15 Hz is indistinguishable): every splat() call boxes its six double
          // arguments, and 64 pilings × 60 Hz of that was the pier's only per-frame garbage.
          foamDt[k] += dt;
          if (((k + ctx.time.frame) & (FOAM_EVERY - 1)) === 0) {
            const rate = p.foamRate.value * (0.25 + sp * 1.1 + b * 4);
            if (rate > 0) state.splat(SPLAT_FOAM, px[k] + dx * 0.8, pz[k] + dz * 0.8, 0.5 + sp * 0.3, 1 - Math.exp(-rate * foamDt[k]), dx, dz);
            foamDt[k] = 0;
          }
          // Only real flow (whitewater, rips) raises a wake; swell orbital motion at a post just
          // sloshes (the collar), it doesn't draw a Kelvin chevron across the sea.
          if (p.wakeRate.value > 0 && sp > 0.7) {
            state.splat(SPLAT_WAKE, px[k], pz[k], pr[k] + 0.12, Math.min(0.03, (sp - 0.7) * 0.012) * p.wakeRate.value, vx, vz);
          }
          // Spray when whitewater slams the post; a light slosh when the flow is quick.
          cool[k] -= dt;
          const sprayRate = p.sprayRate.value;
          if (sprayRate > 0 && cool[k] <= 0 && (b > 0.25 || sp > 1.4)) {
            const hit = Math.max(b, (sp - 1.4) * 0.3);
            const up = 1.5 + 4.2 * hit * (0.7 + 0.6 * rnd());
            spray.burst(
              px[k] - dx * pr[k],
              height + 0.05,
              pz[k] - dz * pr[k],
              vx * 0.35 - dx * 0.6,
              up,
              vz * 0.35 - dz * 0.6,
              (20 + 140 * hit) * sprayRate,
              0.6 + hit * 1.6,
              pr[k] + 0.1,
              0.35,
            );
            cool[k] = 0.18 + rnd() * 0.45 / (0.3 + hit);
          }
        }
      }
      flowA.needsUpdate = true;
      fxA.needsUpdate = true;
    },
    dispose() {
      collars.geometry.dispose();
      collars.dispose();
      mat.dispose();
    },
  };
}
