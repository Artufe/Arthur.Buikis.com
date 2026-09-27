// GPU side of the groundswell: the baked field as a float array texture, the set envelope, and
// TSL that mirrors swell.ts evalSwell()/trainAt() exactly (same arrays, same formulas).

import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataTexture,
  FloatType,
  LinearFilter,
  RGBAFormat,
  RedFormat,
  RepeatWrapping,
  Vector3,
} from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import {
  ENV_W,
  FIELD,
  GAMMA_BREAK,
  GAMMA_SURF,
  FOLD_LIMIT,
  HARMONIC2,
  N_TRAINS,
  ORBIT_SHOAL,
  T_REP,
  TRAIN_DEFS,
  type SwellField,
  type SwellRuntime,
} from './swell';

const { float, max, min, pow, select, smoothstep, sin, cos, tanh, texture, uniform, vec2, vec3, vec4, length, clamp } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

export interface SwellGPU {
  field: DataArrayTexture;
  envelope: DataTexture;
  /** Per-train phase ω·t (rad), set from SwellRuntime each frame. */
  uPhase: TSLNode;
  /** tMod (s), amplitude scale, skew. */
  uTime: TSLNode;
  /** The previous frame's phase and time (motion vectors). */
  uPhasePrev: TSLNode;
  uTimePrev: TSLNode;
  uScale: TSLNode;
  uSkew: TSLNode;
  /** Offshore amplitude per train (m) and edge group speed per train (m/s). */
  uAmp: TSLNode;
  uCgEdge: TSLNode;
  sync(rt: SwellRuntime): void;
  refreshField(): void;
  dispose(): void;
}

export function createSwellGPU(field: SwellField, env: Float32Array): SwellGPU {
  const tex = new DataArrayTexture(field.data, FIELD.nx, FIELD.nz, 2 * N_TRAINS);
  tex.format = RGBAFormat;
  tex.type = FloatType;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  const envTex = new DataTexture(env, ENV_W, N_TRAINS, RedFormat, FloatType);
  envTex.magFilter = LinearFilter;
  envTex.minFilter = LinearFilter;
  envTex.wrapS = RepeatWrapping;
  envTex.wrapT = ClampToEdgeWrapping;
  envTex.generateMipmaps = false;
  envTex.needsUpdate = true;

  const phase = new Vector3();
  const phasePrev = new Vector3();
  const amp = new Vector3(TRAIN_DEFS[0].amp, TRAIN_DEFS[1].amp, TRAIN_DEFS[2].amp);
  const cgE = new Vector3(field.cgEdge[0], field.cgEdge[1], field.cgEdge[2]);
  const g: SwellGPU = {
    field: tex,
    envelope: envTex,
    uPhase: uniform(phase),
    uTime: uniform(0),
    uPhasePrev: uniform(phasePrev),
    uTimePrev: uniform(0),
    uScale: uniform(1),
    uSkew: uniform(0.5),
    uAmp: uniform(amp),
    uCgEdge: uniform(cgE),
    sync(rt) {
      phasePrev.copy(phase);
      g.uTimePrev.value = g.uTime.value;
      phase.set(rt.phase[0], rt.phase[1], rt.phase[2]);
      g.uTime.value = rt.tMod;
      g.uScale.value = rt.scale;
      g.uSkew.value = rt.skew;
    },
    refreshField() {
      cgE.set(field.cgEdge[0], field.cgEdge[1], field.cgEdge[2]);
      tex.needsUpdate = true;
      envTex.needsUpdate = true;
    },
    dispose() {
      tex.dispose();
      envTex.dispose();
    },
  };
  return g;
}

const comp = (v: TSLNode, i: number) => (i === 0 ? v.x : i === 1 ? v.y : v.z);

export interface TrainNodes {
  /** Envelope value and shoaling factor K (debug). */
  env: TSLNode;
  K: TSLNode;
  theta: TSLNode;
  kx: TSLNode;
  kz: TSLNode;
  amp: TSLNode;
  /** Unbroken local amplitude (before breaking saturation). */
  ampU: TSLNode;
  broken: TSLNode;
  depth: TSLNode;
}

interface TrainFetch {
  a: TSLNode;
  b: TSLNode;
  S: TSLNode;
  tau: TSLNode;
}

/** The baked field for train `tr` at rest position `xz` (with off-grid extrapolation). */
function fetchTrainGPU(g: SwellGPU, tr: number, xz: TSLNode): TrainFetch {
  const size = vec2(FIELD.nx, FIELD.nz);
  const u = xz.sub(vec2(FIELD.x0, FIELD.z0)).div(FIELD.texel).sub(0.5).toVar();
  const uc = clamp(u, vec2(0, 0), size.sub(1));
  const off = u.sub(uc).mul(FIELD.texel).toVar();
  const uv = uc.add(0.5).div(size);
  const a = texture(g.field, uv).depth(2 * tr).toVar();
  const b = texture(g.field, uv).depth(2 * tr + 1).toVar();
  const kl = max(length(vec2(a.z, a.w)), 1e-6);
  const S = a.x.add(a.z.mul(off.x)).add(a.w.mul(off.y)).toVar();
  const tau = b.x.add(a.z.div(kl).mul(off.x).add(a.w.div(kl).mul(off.y)).div(comp(g.uCgEdge, tr))).toVar();
  return { a, b, S, tau };
}

/** Train state from a fetch at the given phase/time uniforms (current or previous frame). */
function trainStateGPU(g: SwellGPU, tr: number, f: TrainFetch, uPhase: TSLNode, uTime: TSLNode): TrainNodes {
  const { a, b } = f;
  const Q = b.y;
  const hCap = b.z;
  const h = b.w;
  let e: TSLNode = float(1);
  if (TRAIN_DEFS[tr].sets) e = texture(g.envelope, vec2(uTime.sub(f.tau).div(T_REP), (tr + 0.5) / N_TRAINS)).x;
  const aOff = comp(g.uAmp, tr).mul(g.uScale).mul(e).toVar();
  const au = aOff.mul(a.y).toVar();
  const r = aOff.mul(2).mul(Q).div(GAMMA_BREAK);
  const broken = smoothstep(0.85, 1.15, r).toVar();
  const hEff = hCap;
  const cap = float(GAMMA_BREAK)
    .add(float(GAMMA_SURF - GAMMA_BREAK).mul(broken))
    .mul(0.5)
    .mul(max(hEff, 0.02));
  const q1 = au.mul(au).mul(au).mul(au);
  const q2 = cap.mul(cap).mul(cap).mul(cap);
  const ampN = au.mul(pow(q2.div(q1.add(q2).add(1e-12)), 0.25));
  return { env: e, K: a.y, theta: f.S.sub(comp(uPhase, tr)), kx: a.z, kz: a.w, amp: ampN, ampU: au, broken, depth: h };
}

/** GPU mirror of swell.ts trainAt(). `xz` is the rest position. Must run inside an Fn. */
export function swellTrainGPU(g: SwellGPU, tr: number, xz: TSLNode): TrainNodes {
  return trainStateGPU(g, tr, fetchTrainGPU(g, tr, xz), g.uPhase, g.uTime);
}

export interface SwellSum {
  /** Displacement. */
  d: TSLNode;
  /** Displacement at the previous frame's time (only when requested), for motion vectors. */
  dPrev: TSLNode | null;
  /** (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z). */
  dd: TSLNode;
  /** ∂Dx/∂z. */
  dxz: TSLNode;
  broken: TSLNode;
  depth: TSLNode;
  /** Train 0 (envelope, K, amplitude, band-limit fade), for debug views. */
  debug: TSLNode;
}

/** Gerstner displacement (and derivatives) of one train state. Mirrors evalSwell(). */
function gerstnerGPU(g: SwellGPU, tp: TrainNodes, sEff: TSLNode) {
  const kl = max(length(vec2(tp.kx, tp.kz)), 1e-6).toVar();
  const ux = tp.kx.div(kl);
  const uz = tp.kz.div(kl);
  // Band-limit: fade trains shorter than ~5 vertex spacings.
  const fade = select(sEff.greaterThan(0), smoothstep(3, 6, float(2 * Math.PI).div(kl.mul(max(sEff, 1e-4)))), float(1)).toVar();
  const A = tp.amp.mul(fade).toVar();
  const kh = kl.mul(max(tp.depth, 0.25));
  const hf = min(float(1).div(tanh(kh)), 2.6);
  const rb = tp.ampU.div(max(tp.depth, 0.05).mul(0.5 * GAMMA_BREAK));
  const shoal = smoothstep(0.35, 1, rb).mul(float(1).sub(tp.broken)).add(tp.broken.mul(0.45)).toVar();
  const beta = g.uSkew.mul(shoal).toVar();
  const B = min(
    min(max(A.mul(hf), shoal.mul(ORBIT_SHOAL).div(kl).mul(fade)), A.mul(5)),
    float(FOLD_LIMIT).div(kl.mul(beta.add(1))).mul(fade),
  ).toVar();
  const th = tp.theta.toVar();
  const thw = th.add(beta.mul(float(1).sub(cos(th))));
  const dw = float(1).add(beta.mul(sin(th))).toVar();
  const s = sin(thw).toVar();
  const c = cos(thw).toVar();
  const a2 = A.mul(shoal).mul(HARMONIC2);
  // Height and its phase derivative, including the second harmonic.
  const y = A.mul(c).add(a2.mul(c.mul(c).sub(s.mul(s))));
  const ys = A.mul(s).add(a2.mul(4).mul(s).mul(c)).toVar();
  return { A, B, ux, uz, s, c, dw, fade, y, ys };
}

/**
 * GPU mirror of evalSwell(). `sEff` (vertex spacing, m) fades trains whose wavelength the grid
 * can't carry; pass float(0) to disable. With `withPrev`, also the previous frame's displacement
 * (same texture fetches, previous phases) for velocity. Must run inside an Fn.
 */
export function swellSumGPU(g: SwellGPU, xz: TSLNode, sEff: TSLNode, withPrev = false): SwellSum {
  const d = vec3(0, 0, 0).toVar();
  const dPrev = withPrev ? vec3(0, 0, 0).toVar() : null;
  const dd = vec4(0, 0, 0, 0).toVar();
  const dxz = float(0).toVar();
  const broken = float(0).toVar();
  const debug = vec4(0, 0, 0, 0).toVar();
  let depth: TSLNode = float(0);
  for (let tr = 0; tr < N_TRAINS; tr++) {
    const f = fetchTrainGPU(g, tr, xz);
    const tp = trainStateGPU(g, tr, f, g.uPhase, g.uTime);
    const { A, B, ux, uz, s, c, dw, fade, y, ys } = gerstnerGPU(g, tp, sEff);
    if (tr === 0) debug.assign(vec4(tp.env, tp.K, A, fade));
    d.addAssign(vec3(B.mul(ux).mul(s).negate(), y, B.mul(uz).mul(s).negate()));
    dd.addAssign(
      vec4(
        ys.mul(dw).mul(tp.kx).negate(),
        ys.mul(dw).mul(tp.kz).negate(),
        B.mul(ux).mul(c).mul(dw).mul(tp.kx).negate(),
        B.mul(uz).mul(c).mul(dw).mul(tp.kz).negate(),
      ),
    );
    dxz.subAssign(B.mul(ux).mul(c).mul(dw).mul(tp.kz));
    broken.assign(max(broken, tp.broken));
    depth = tp.depth;
    if (dPrev) {
      const pp = gerstnerGPU(g, trainStateGPU(g, tr, f, g.uPhasePrev, g.uTimePrev), sEff);
      dPrev.addAssign(vec3(pp.B.mul(pp.ux).mul(pp.s).negate(), pp.y, pp.B.mul(pp.uz).mul(pp.s).negate()));
    }
  }
  return { d, dPrev, dd, dxz, broken, depth, debug };
}

export interface TrainDisplacement {
  /** Train state (theta, k, amplitudes, depth). */
  tp: TrainNodes;
  /** This train's displacement now and at the previous frame's phase (motion vectors). */
  d: TSLNode;
  dPrev: TSLNode;
  /** (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z) and ∂Dx/∂z of this train alone. */
  dd: TSLNode;
  dxz: TSLNode;
}

/**
 * [breaking] One train's Gerstner displacement and derivatives, same formulas as swellSumGPU():
 * the breaker replaces train 0 near its breaking crests and keeps the others on top. Must run
 * inside an Fn.
 */
export function swellTrainDisplacementGPU(g: SwellGPU, tr: number, xz: TSLNode, sEff: TSLNode): TrainDisplacement {
  const f = fetchTrainGPU(g, tr, xz);
  const tp = trainStateGPU(g, tr, f, g.uPhase, g.uTime);
  const { B, ux, uz, s, c, dw, y, ys } = gerstnerGPU(g, tp, sEff);
  const pp = gerstnerGPU(g, trainStateGPU(g, tr, f, g.uPhasePrev, g.uTimePrev), sEff);
  return {
    tp,
    d: vec3(B.mul(ux).mul(s).negate(), y, B.mul(uz).mul(s).negate()),
    dPrev: vec3(pp.B.mul(pp.ux).mul(pp.s).negate(), pp.y, pp.B.mul(pp.uz).mul(pp.s).negate()),
    dd: vec4(
      ys.mul(dw).mul(tp.kx).negate(),
      ys.mul(dw).mul(tp.kz).negate(),
      B.mul(ux).mul(c).mul(dw).mul(tp.kx).negate(),
      B.mul(uz).mul(c).mul(dw).mul(tp.kz).negate(),
    ),
    dxz: B.mul(ux).mul(c).mul(dw).mul(tp.kz).negate(),
  };
}
