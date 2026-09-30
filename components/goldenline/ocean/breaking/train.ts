// Zero-alloc evaluation of one swell train at a point: the same math as swell.ts trainAt()
// (which mirrors the GPU), but with the position and results in a typed array. V8 boxes a
// double passed to a call it doesn't inline, and trainAt's own helper is too big to inline, so
// calling trainAt from the breaker's big per-frame loops allocated; this never does.

import { ENV_DT, ENV_W, FIELD, GAMMA_BREAK, GAMMA_SURF, HARMONIC2, N_TRAINS, TRAIN_DEFS, type SwellField, type SwellRuntime } from '../swell';

const NX = FIELD.nx;
const NZ = FIELD.nz;
const NC = NX * NZ;

export interface TrainEval {
  /**
   * In: [0] x, [1] z. Out: [2] amp, [3] θ (crests at 0 mod 2π), [4] unbroken amp, [5] broken 0-1,
   * [6] the train's Gerstner height at this rest point (swell.ts evalSwell's y).
   */
  io: Float64Array;
  /** The frame's swell runtime and envelope (set once per frame). */
  set(env: Float32Array, rt: SwellRuntime): void;
  /** Evaluate train `tr` at (io[0], io[1]). */
  eval(tr: number): void;
}

export function createTrainEval(field: SwellField): TrainEval {
  const io = new Float64Array(8);
  const ch = new Float64Array(8);
  let envC: Float32Array | null = null;
  let rtC: SwellRuntime | null = null;
  const D = field.data;
  return {
    io,
    set(env, rt) {
      envC = env;
      rtC = rt;
    },
    eval(tr) {
      const env = envC;
      const rt = rtC;
      if (!env || !rt) return;
      const x = io[0];
      const z = io[1];
      const u = (x - FIELD.x0) / FIELD.texel - 0.5;
      const v = (z - FIELD.z0) / FIELD.texel - 0.5;
      const uc = u < 0 ? 0 : u > NX - 1 ? NX - 1 : u;
      const vc = v < 0 ? 0 : v > NZ - 1 ? NZ - 1 : v;
      let i = Math.floor(uc);
      let j = Math.floor(vc);
      if (i > NX - 2) i = NX - 2;
      if (j > NZ - 2) j = NZ - 2;
      const fu = uc - i;
      const fv = vc - j;
      const w00 = (1 - fu) * (1 - fv);
      const w10 = fu * (1 - fv);
      const w01 = (1 - fu) * fv;
      const w11 = fu * fv;
      const c = j * NX + i;
      for (let layer = 0; layer < 2; layer++) {
        const a = ((2 * tr + layer) * NC + c) * 4;
        const b = a + 4;
        const cc = a + NX * 4;
        const d = cc + 4;
        for (let q = 0; q < 4; q++) ch[layer * 4 + q] = D[a + q] * w00 + D[b + q] * w10 + D[cc + q] * w01 + D[d + q] * w11;
      }
      const ox = (u - uc) * FIELD.texel;
      const oz = (v - vc) * FIELD.texel;
      if (ox !== 0 || oz !== 0) {
        ch[0] += ch[2] * ox + ch[3] * oz;
        const kl0 = Math.sqrt(ch[2] * ch[2] + ch[3] * ch[3]);
        const kl = kl0 > 1e-9 ? kl0 : 1;
        ch[4] += ((ch[2] / kl) * ox + (ch[3] / kl) * oz) / field.cgEdge[tr];
      }
      // Envelope (swell.ts envelopeAt: the texture's linear filter, wrapped in time).
      let e = 1;
      if (TRAIN_DEFS[tr].sets) {
        let t = (rt.tMod - ch[4]) / ENV_DT - 0.5;
        t -= Math.floor(t / ENV_W) * ENV_W;
        const e0 = Math.floor(t);
        const ef = t - e0;
        const e1 = e0 + 1 >= ENV_W ? 0 : e0 + 1;
        const row = tr * ENV_W;
        e = env[row + e0] * (1 - ef) + env[row + e1] * ef;
      }
      const aOff = TRAIN_DEFS[tr].amp * rt.scale * e;
      const au = aOff * ch[1];
      let r = ((2 * aOff * ch[5]) / GAMMA_BREAK - 0.85) / 0.3;
      r = r < 0 ? 0 : r > 1 ? 1 : r;
      const broken = r * r * (3 - 2 * r);
      const hc = ch[6] > 0.02 ? ch[6] : 0.02;
      const cap = 0.5 * (GAMMA_BREAK + (GAMMA_SURF - GAMMA_BREAK) * broken) * hc;
      const q1 = au * au * au * au;
      const q2 = cap * cap * cap * cap;
      const A = au * Math.pow(q2 / (q1 + q2 + 1e-12), 0.25);
      const th = ch[0] - rt.phase[tr];
      io[2] = A;
      io[3] = th;
      io[4] = au;
      io[5] = broken;
      // Height with the depth-aware shaping (skewed face, second harmonic), as evalSwell().
      const h = ch[7];
      let rb = (au / (0.5 * GAMMA_BREAK * (h > 0.05 ? h : 0.05)) - 0.35) / 0.65;
      rb = rb < 0 ? 0 : rb > 1 ? 1 : rb;
      const shoal = rb * rb * (3 - 2 * rb) * (1 - broken) + 0.45 * broken;
      const beta = rt.skew * shoal;
      const thw = th + beta * (1 - Math.cos(th));
      const sn = Math.sin(thw);
      const cs = Math.cos(thw);
      io[6] = A * cs + HARMONIC2 * A * shoal * (cs * cs - sn * sn);
    },
  };
}

export const TRAINS = N_TRAINS;
