// The three per-frame compute kernels. Each is ONE dispatch over its field that (1) fetches the
// texel's previous state (drift shift + residual advection, or re-initialisation when the texel
// just scrolled into the window), (2) runs the simulation step, (3) gathers every brush binned
// into its tile, and (4) stores. Order per frame: far -> near water -> sand (the later two
// re-initialise scrolled-in texels from the far field written just before them).

import { Fn, If, Loop, abs, clamp, localId, workgroupId, dot, exp, exp2, float, fract, floor, log2, sin, globalId, int, ivec2, length, max, min, mix, mod, smoothstep, textureStore, uint, vec2, vec4, baseTex } from './tsl';
import type { TSLNode } from '../core/contracts';
import type { Field } from './field';
import type { SplatQueue } from './queue';
import type { StorageTexture } from 'three/webgpu';
import type { Noise } from './noise';
import type { Static } from './static';
import type { ActiveTiles } from './active';
import { catmullRom, rev, vnoise, type Tunables } from './shared';
import { TILE } from './queue';

export interface KernelDeps {
  far: Field;
  near: Field;
  /** Second texture set of the near-water field (wake), sharing near's window. */
  nearB: [StorageTexture, StorageTexture];
  sand: Field;
  queue: SplatQueue;
  tn: Tunables;
  st: Static;
  noise: Noise;
  active: ActiveTiles;
  /** Optional: (worldXZ, edge m) => 0-1, where the surf zone has water on the sand right now (wets it to a film). */
  wetSrc?: (xz: TSLNode, edge?: number) => TSLNode;
}

const WG = 8;

/**
 * Wetness after `dt` s of drying at base height `h` (m above still water), down to `floor`.
 * Three stages: the standing film (> 0.9, a mirror) drains off, the saturated surface
 * (0.5-0.9, a sheen) drains into the sand, then damp sand dries slowly. At the waterline the
 * water table is at the surface, so film and sheen hold there several times longer than high on
 * the beach face: after a run-up the shine retreats down the beach toward the water.
 */
function dryWet(wet: TSLNode, dt: TSLNode, h: TSLNode, floor: TSLNode, tn: Tunables) {
  const up = smoothstep(0.0, 0.9, h);
  const tFilm = tn.filmTime.mul(mix(float(2.4), float(0.45), up));
  const tSat = tn.satTime.mul(mix(float(2.5), float(0.5), up));
  const rate = wet.greaterThan(0.9).select(float(0.1).div(tFilm), wet.greaterThan(0.5).select(float(0.4).div(tSat), float(1).div(tn.dryTime)));
  return max(floor, wet.sub(dt.mul(rate)));
}

/** Common per-texel window bookkeeping. */
function texelFrame(f: Field) {
  const n = float(f.n);
  const s = ivec2(globalId.xy).toVar();
  const sf = vec2(s).toVar();
  const l = mod(sf.sub(f.uWin.zw).add(n), n).toVar();
  const W = f.uWin.xy.add(l).toVar();
  return { s, sf, W, n };
}

function inside(lp: TSLNode, n: number) {
  return lp.x.greaterThanEqual(0).and(lp.x.lessThan(n)).and(lp.y.greaterThanEqual(0)).and(lp.y.lessThan(n));
}

/** Storage texel of world texel Wq (clamped into the previous window). */
function prevStorage(f: Field, Wq: TSLNode) {
  const lp = clamp(Wq.sub(f.uPrev.xy), 0, f.n - 1);
  return ivec2(mod(lp.add(f.uPrev.zw), float(f.n)));
}

function tileHeader(q: SplatQueue, fieldIndex: number, s: TSLNode) {
  const bf = q.fields[fieldIndex];
  const idx = s.x.shiftRight(int(5)).add(s.y.shiftRight(int(5)).mul(int(bf.tps))).add(int(bf.base));
  return q.headers.element(uint(idx)).toVar();
}

function forEachSplat(q: SplatQueue, fieldIndex: number, s: TSLNode, body: (a: TSLNode, b: TSLNode) => void) {
  const hdr = tileHeader(q, fieldIndex, s);
  const start = hdr.shiftRight(uint(8)).toVar();
  const cnt = hdr.bitAnd(uint(255)).toVar();
  Loop({ start: uint(0), end: cnt, type: 'uint', condition: '<' }, ({ i }: { i: TSLNode }) => {
    const si = q.refs.element(start.add(i)).toVar();
    const a = q.splats.element(si.mul(uint(2))).toVar();
    const b = q.splats.element(si.mul(uint(2)).add(uint(1))).toVar();
    body(a, b);
  });
}

/**
 * Stochastic rounding to half precision: slow processes (drying, footprint refill, foam decay)
 * change a texel by less than half an f16 ulp per frame, which plain rounding would discard or
 * quantise into steps. Adding +-0.5 ulp of per-texel, per-frame noise makes every store unbiased.
 */
function dither4(v: TSLNode, sf: TSLNode, seed: TSLNode) {
  // Interleaved gradient noise with a per-frame offset: a few ALU ops, no sin().
  const q = sf.add(seed.xy);
  const h = fract(fract(dot(q, vec2(0.06711056, 0.00583715))).mul(52.9829189)).toVar();
  const sz = seed.z.mul(1 / 1024);
  const sw = seed.w.mul(1 / 1024);
  const r = vec4(h, fract(h.mul(7.13).add(sz)), fract(h.mul(13.37).add(sw)), fract(h.mul(31.7).add(sz.mul(0.37)))).sub(0.5);
  const ulp = exp2(floor(log2(max(abs(v), 6.1e-5))).sub(10));
  return v.add(r.mul(ulp));
}

// ── Brushes. a = (kind, x, z, radius), b = (strength, dirX, dirZ, side). ──

/** Soft foam blob with a ragged edge. Coverage combines like screen: c + a(1 - c). */
function foamBrush(P: TSLNode, a: TSLNode, b: TSLNode, texel: number, c: TSLNode, age: TSLNode, noise: Noise) {
  const r = max(a.w, texel * 0.75);
  // Fingered, fractal edge: domain-warp the brush (lobes and fingers), then rag and clotting, all
  // in brush-relative units and seeded by the splat position so no two splats match. Two taps of
  // the baked value noise (this runs per texel per overlapping splat, so it must be cheap).
  const dq = P.sub(a.yz).div(r).toVar();
  const sd = a.yz.mul(0.37);
  const n1 = noise.value4(dq.mul(1.6).add(sd)).toVar();
  const n2 = noise.value4(dq.mul(5.1).add(sd.add(vec2(7.1, 3.3)))).toVar();
  const e = length(dq.add(n1.xy.mul(0.42)));
  const rag = n1.z.mul(0.12).add(n2.x.mul(0.1)).add(n2.y.mul(0.05));
  const core = float(1).sub(smoothstep(0.35, 0.92, e.add(rag).add(e.mul(e).mul(0.12))));
  // Clotted texture near the rim, dense in the middle.
  const clot = mix(n2.z.mul(0.3).add(0.75), float(1), smoothstep(0.5, 0.95, core));
  const m = core.mul(clot);
  const area = min(float(1), a.w.mul(a.w).div(r.mul(r)));
  const add = clamp(b.x.mul(m).mul(area), 0, 1).toVar();
  const nc = c.add(add.mul(float(1).sub(c))).toVar();
  age.assign(age.mul(c).div(max(nc, 1e-4)));
  c.assign(nc);
}

/**
 * Wake: a moving pressure point (the wave equation turns it into rings and a V) plus a
 * chevron of water velocity and disturbance trailing behind along -dir.
 */
function wakeBrush(P: TSLNode, a: TSLNode, b: TSLNode, dt: TSLNode, h: TSLNode, ht: TSLNode, v: TSLNode, dist: TSLNode) {
  const r = max(a.w, 0.12);
  const d = P.sub(a.yz).toVar();
  const spd = length(b.yz).toVar();
  const dir = b.yz.div(max(spd, 1e-4)).toVar();
  const u = dot(d, dir).div(r);
  const w = abs(dot(d, vec2(dir.y.negate(), dir.x))).div(r);
  // Zero-mean "Mexican hat" pressure (a Gaussian's Laplacian): no water is removed, so the wake
  // leaves ripples, not a trough.
  const ka = float(3).div(r.mul(r));
  const rr = dot(d, d).toVar();
  const blob = exp(rr.mul(ka).negate()).toVar();
  const hat = blob.mul(float(1).sub(rr.mul(ka)));
  const moving = spd.greaterThan(0.05);
  // A splash displaces the surface once (rings); a moving source pushes dh/dt continuously.
  h.assign(h.sub(moving.select(0, b.x.mul(hat))));
  ht.assign(ht.sub(moving.select(b.x.mul(hat).mul(spd.div(r)).mul(dt).mul(9), 0)));
  // Chevron arms at ~20 degrees behind the source, fading over 2.4 radii.
  const behind = rev(0.3, -0.2, u).mul(smoothstep(-2.4, -1.2, u));
  const arm = exp(w.add(u.mul(0.36)).div(0.28).pow(2).negate()).mul(behind).mul(moving.select(1, 0));
  const vm = max(blob, arm.mul(0.8)).toVar();
  v.assign(mix(v, b.yz.mul(min(float(1), float(8).div(max(spd, 1e-4)))), vm.mul(0.5)));
  dist.assign(max(dist, vm.mul(clamp(b.x.mul(25).add(spd.mul(0.15)), 0, 1))));
}

function wetBrush(P: TSLNode, a: TSLNode, b: TSLNode, texel: number, wet: TSLNode) {
  const r = max(a.w, texel);
  const e = length(P.sub(a.yz)).div(r);
  const m = float(1).sub(smoothstep(0.55, 1.0, e));
  wet.assign(max(wet, clamp(b.x, 0, 1).mul(m)));
}

function smoothBrush(P: TSLNode, a: TSLNode, b: TSLNode, texel: number, dep: TSLNode | null, mass: TSLNode | null, sm: TSLNode) {
  const r = max(a.w, texel);
  const e = length(P.sub(a.yz)).div(r);
  const m = float(1).sub(smoothstep(0.5, 1.0, e)).toVar();
  const k = clamp(b.x, 0, 1).mul(m);
  if (dep) dep.assign(dep.mul(float(1).sub(k)));
  if (mass) mass.assign(mass.mul(float(1).sub(k)));
  sm.assign(max(sm, m.mul(clamp(b.x.mul(12), 0, 1))));
}

/** Soft ellipse mask: 1 inside, falling to 0 at the outline (e = 1). */
const ell = (u: TSLNode, v: TSLNode, cu: number, cv: number, ru: number, rv: number) => {
  const du = u.sub(cu).div(ru);
  const dv = v.sub(cv).div(rv);
  return length(vec2(du, dv));
};

/**
 * Footprint: heel, ball, lateral arch band and a toe row (v > 0 is the medial side, toward the
 * other foot), pressed to `strength` metres. Displaced sand forms a rim, strongest ahead of the
 * toes (push-off) and weaker in wet, firm sand.
 */
function footprintBrush(P: TSLNode, a: TSLNode, b: TSLNode, wet: TSLNode, hgt: TSLNode, dep: TSLNode, mass: TSLNode) {
  const r = max(a.w, 0.06);
  // Per-step variation, hashed from the print's position: heading jitter, depth, heel/ball
  // weighting and how much sand the push-off throws.
  const hs = fract(sin(dot(a.yz, vec2(12.9898, 78.233))).mul(43758.5453)).toVar();
  const h2 = fract(hs.mul(17.31)).toVar();
  const h3 = fract(hs.mul(53.17)).toVar();
  const jit = hs.sub(0.5).mul(0.2);
  const cj = float(1).sub(jit.mul(jit).mul(0.5)); // cos(jit), small angle
  const dir = vec2(b.y.mul(cj).sub(b.z.mul(jit)), b.y.mul(jit).add(b.z.mul(cj))).toVar();
  const d = P.sub(a.yz).toVar();
  const u = dot(d, dir).div(r).toVar();
  const v = dot(d, vec2(dir.y.negate(), dir.x)).mul(b.w).div(r).toVar();
  // Crumbling walls: the outline wanders by a few millimetres.
  const wob = vnoise(P.mul(19).add(a.yz)).mul(0.07).add(vnoise(P.mul(41).add(a.zy)).mul(0.035));
  const heelW = mix(0.85, 1.12, h2);
  const eHeel = ell(u, v, -0.6, 0.0, 0.34, 0.3).add(wob).toVar();
  const eBall = ell(u, v, 0.3, 0.06, 0.32, 0.37).add(wob).toVar();
  // Lateral edge of the midfoot: a capsule between heel and ball on the outer side.
  const t = clamp(u.add(0.6).div(0.9), 0, 1);
  const eArch = length(vec2(u.sub(mix(-0.6, 0.3, t)).div(0.5), v.add(0.13).sub(t.mul(0.04)).div(0.17))).add(wob).toVar();
  // Toes: big toe on the medial side, four smaller ones fanning back laterally.
  const eT1 = ell(u, v, 0.83, 0.2, 0.14, 0.12);
  const eT2 = ell(u, v, 0.79, 0.0, 0.1, 0.075);
  const eT3 = ell(u, v, 0.74, -0.13, 0.09, 0.07);
  const eT4 = ell(u, v, 0.67, -0.24, 0.085, 0.065);
  const eT5 = ell(u, v, 0.58, -0.32, 0.08, 0.06);
  const eToe = min(min(eT1, eT2), min(min(eT3, eT4), eT5)).toVar();
  const inner = (e: TSLNode) => float(1).sub(smoothstep(0.55, 1.0, e));
  // Bowl-shaped floors: deepest under the centre of heel and ball, where the weight goes.
  const bowl = (e: TSLNode) => inner(e).mul(float(1).sub(e.mul(e).mul(0.28)));
  const mHeel = bowl(eHeel);
  const mBall = bowl(eBall);
  const mArch = inner(eArch);
  const mToe = inner(eToe);
  const D = max(max(mHeel.mul(heelW), mBall.mul(mix(0.95, 0.78, h2))), max(mArch.mul(0.48), mToe.mul(0.7))).toVar();
  const outline = max(max(inner(eHeel), inner(eBall)), max(mArch, mToe)).toVar();
  // Rim: a ring just outside the outline, plus the mound pushed up ahead of the toes, broken
  // into clumps of kicked sand.
  const eMin = min(min(eHeel, eBall), min(eArch.mul(1.15), eToe.mul(0.95))).toVar();
  const ring = smoothstep(0.88, 1.04, eMin).mul(float(1).sub(smoothstep(1.1, 1.55, eMin)));
  const push = smoothstep(-0.2, 0.95, u).mul(0.9).add(0.45);
  const ahead = smoothstep(0.85, 1.05, u).mul(float(1).sub(smoothstep(1.2, 1.75, u))).mul(float(1).sub(smoothstep(0.25, 0.55, abs(v.sub(0.02)))));
  const clumps = smoothstep(0.0, 0.6, vnoise(P.mul(28).add(a.yz.mul(3.1)))).mul(mix(0.4, 1.3, h3));
  const firm = clamp(wet, 0, 1);
  const under = rev(0.05, -0.1, hgt);
  const depth = b.x.mul(mix(0.82, 1.15, h3)).mul(mix(1, 0.62, firm)).mul(mix(1, 0.45, under)).toVar();
  const rimK = mix(0.42, 0.16, firm).mul(mix(1, 0.3, under));
  const kick = ahead.mul(clumps).mul(mix(0.25, 0.05, firm));
  dep.assign(max(dep, depth.mul(D)));
  mass.assign(min(mass.mul(float(1).sub(outline)).add(depth.mul(rimK.mul(ring).mul(push).add(kick))), 0.03));
  // Dilatancy: pressing wet sand opens its pores and drains a pale halo around the foot, which
  // soaks back within a couple of seconds (the sand kernel lets wetness recover to its floor).
  const halo = smoothstep(0.7, 1.0, eMin).mul(float(1).sub(smoothstep(1.2, 1.9, eMin))).mul(smoothstep(0.55, 0.85, wet));
  wet.assign(wet.sub(halo.mul(0.3)));
}

// ── Kernels ──

export function createKernels(k: KernelDeps) {
  const { far, near, sand, queue, tn, st } = k;
  const out = { lists: [[], []] as TSLNode[][] };
  const decay = (x: TSLNode, tau: TSLNode) => x.mul(exp(tn.dt.negate().div(tau)));

  /** Foam decay with lace break-up. c, age, dist are vars; P the material position. */
  const foamSim = (c: TSLNode, age: TSLNode, P0: TSLNode, fl: TSLNode, scale: number, coarseLace = false) => {
    // Material coordinates: undo the drift, and the residual flow over this foam's lifetime so
    // far (for smooth currents that is where it came from), so filaments move with the foam.
    // (Capped at 10 s: over longer times the current's shear would squash the pattern into stripes.)
    const Pm = P0.sub(fl.mul(min(age.mul(tn.foamLife), 60))).toVar();
    const lc = (coarseLace ? k.noise.laceFar(Pm.mul(scale)) : k.noise.lace(Pm.mul(scale))).toVar();
    const edge = lc.x;
    const fine = lc.y;
    const band = mix(0.42, 0.17, age).toVar();
    // Coarse cell edges are the persistent filaments; late in life the fine pattern breaks them up.
    const coarse = smoothstep(band.mul(0.5), band.mul(1.1), edge);
    const fineInt = smoothstep(band.mul(0.4), band.mul(1.2), fine).mul(smoothstep(0.35, 0.75, age));
    const interior = max(coarse, fineInt).toVar();
    // Decay rate per unit of age (age runs 0..1 over foamLife). Young foam holds; after ~4 s the
    // cell interiors clear within ~10 s (holes open into lace); the filaments hold until late
    // in life, then accelerate away, so a patch is gone by ~1.2 x foamLife.
    const life = tn.foamLife;
    const a = age;
    const fEdge = float(0.22).add(a.mul(a).mul(a).mul(a).mul(6.5));
    const fInt = float(0.4).add(smoothstep(0.06, 0.28, a).mul(16));
    const f = mix(fEdge, fInt, interior.mul(tn.lace));
    c.assign(c.mul(exp(f.mul(tn.dt).div(life).negate())));
    c.assign(c.lessThan(0.003).select(0, c));
    age.assign(min(float(1), age.add(tn.dt.div(life))));
  };

  for (let p = 0; p < 2; p++) {
    const q = 1 - p;
    // ── Far: foam (drifting) + wet/smooth (static) over the whole break and shore. ──
    const farSrc = baseTex(far.tex[p]);
    const farKernel = Fn(() => {
      const { s, W } = texelFrame(far);
      const t = far.texel;
      const Pw = W.add(0.5).mul(t).toVar();
      const Pf = Pw.add(far.uDf).toVar();
      const sA = st.sampleA(Pw).toVar();
      const hS = sA.x;
      const WsF = W.sub(far.uDrift.xy).toVar();
      const validF = inside(WsF.sub(far.uPrev.xy), far.n).and(far.uReset.lessThan(0.5));
      const validS = inside(W.sub(far.uPrev.xy), far.n).and(far.uReset.lessThan(0.5));
      const fl = st.flow(Pw, st.sampleB(Pw)).toVar();
      const lo = far.uPrev.xy.add(0.5);
      const qf = clamp(WsF.add(0.5).sub(fl.mul(tn.dt).div(t)), lo, lo.add(far.n - 1));
      // Most of the sea carries no foam: a single bilinear tap decides whether the 13-tap
      // advection fetch and the lace simulation are needed at all.
      const c = float(0).toVar();
      const age = float(0).toVar();
      If(validF.and(farSrc.sample(qf.mul(1 / far.n)).level(0).x.greaterThan(0.0015)), () => {
        const fsrc = vec4(0).toVar();
        If(abs(fl.x).add(abs(fl.y)).lessThan(0.004), () => {
          fsrc.assign(farSrc.load(prevStorage(far, WsF)));
        }).Else(() => {
          fsrc.assign(catmullRom(farSrc, qf, far.n));
        });
        c.assign(clamp(fsrc.x, 0, 1));
        age.assign(clamp(fsrc.y.div(max(fsrc.x, 1e-3)), 0, 1));
      });
      const prevS = farSrc.load(s);
      const wet = validS.select(prevS.z, st.wetInit(sA)).toVar();
      const sm = validS.select(prevS.w, 0).toVar();

      If(c.greaterThan(0), () => {
        foamSim(c, age, Pf.sub(tn.laceOrigin), fl, 0.24, true);
      });
      wet.assign(dryWet(wet, tn.dt, hS, st.wetFloor(sA), tn));
      // Under the surf zone's water (the beach face only: most of the window is sea or dune).
      const wetSrc = k.wetSrc;
      if (wetSrc) If(hS.greaterThan(-1).and(hS.lessThan(2.5)), () => {
        wet.assign(max(wet, wetSrc(Pw, t)));
      });
      sm.assign(decay(sm, float(18)));

      forEachSplat(queue, 0, s, (a, b) => {
        If(a.x.lessThan(0.5), () => {
          foamBrush(Pf, a, b, t, c, age, k.noise);
        })
          .ElseIf(a.x.lessThan(2.5), () => {
            wetBrush(Pw, a, b, t, wet);
          })
          .ElseIf(a.x.greaterThan(3.5), () => {
            smoothBrush(Pw, a, b, t, null, null, sm);
          });
      });
      // No foam on dry land well above the swash.
      c.assign(c.mul(float(1).sub(smoothstep(1.6, 2.4, hS))));
      textureStore(far.tex[q], s, dither4(vec4(c, c.mul(age), wet, sm), vec2(s), tn.seed)).toWriteOnly();
    })().compute([far.n / WG, far.n / WG, 1], [WG, WG, 1]).setName(`gl.state.far${p}`);

    // ── Near water: foam, age, disturbance (A) + wake height, dh/dt, flow velocity (B). ──
    const nA = baseTex(near.tex[p]);
    const nB = baseTex(k.nearB[p]);
    const farNew = baseTex(far.tex[q]);
    const nearKernel = Fn(() => {
      const { s, W } = texelFrame(near);
      const t = near.texel;
      const P = W.add(0.5).mul(t).add(near.uDf).toVar();
      const hgt = st.sampleA(P).x.toVar();
      const Ws = W.sub(near.uDrift.xy).toVar();
      const valid = inside(Ws.sub(near.uPrev.xy), near.n).and(near.uReset.lessThan(0.5)).toVar();
      const fl = st.flow(P, st.sampleB(P)).toVar();
      const lo = near.uPrev.xy.add(0.5);
      const qa = clamp(Ws.add(0.5).sub(fl.mul(tn.dt).div(t)), lo, lo.add(near.n - 1));
      const quick = nA.sample(qa.mul(1 / near.n)).level(0).toVar();
      const farS = farNew.sample(P.sub(far.uDf).mul(far.uView.w)).level(0);
      const c = valid.select(0, farS.x).toVar();
      const age = valid.select(0, clamp(farS.y.div(max(farS.x, 1e-3)), 0, 1)).toVar();
      const dist = valid.select(clamp(quick.z, 0, 1), 0).toVar();
      If(valid.and(quick.x.greaterThan(0.0015)), () => {
        // Where the residual current is negligible the fetch is an exact texel (the drift shift
        // is whole texels); only surf-zone and rip texels need the 13-tap Catmull-Rom.
        const aSrc = vec4(0).toVar();
        If(abs(fl.x).add(abs(fl.y)).lessThan(0.004), () => {
          aSrc.assign(nA.load(prevStorage(near, Ws)));
        }).Else(() => {
          aSrc.assign(catmullRom(nA, qa, near.n));
        });
        c.assign(clamp(aSrc.x, 0, 1));
        age.assign(clamp(aSrc.y.div(max(aSrc.x, 1e-3)), 0, 1));
      });

      // Wake: symplectic Euler on the 2D wave equation, sponge at the window edge, dry on land.
      const sp = prevStorage(near, Ws);
      const bc = nB.load(sp).toVar();
      const hAt = (ox: number, oz: number) => nB.load(prevStorage(near, Ws.add(vec2(ox, oz)))).x;
      const bl = hAt(-1, 0);
      const br = hAt(1, 0);
      const bd = hAt(0, -1);
      const bu = hAt(0, 1);
      const h = valid.select(bc.x, 0).toVar();
      const ht = valid.select(bc.y, 0).toVar();
      const vel = valid.select(bc.zw, vec2(0, 0)).toVar();
      const cross4 = bl.add(br).add(bd).add(bu).toVar();
      const lap = cross4.sub(h.mul(4)).div(t * t);
      // Dispersion: h_tt = c^2 lap(h) + beta lap^2(h) makes short ripples travel slower than long
      // ones (like gravity waves), so a moving source leaves a trailing train, not one sharp V.
      // Quiet water (no wake energy here or next door) skips the 8 extra dispersion taps.
      const bih = float(0).toVar();
      If(abs(h).add(abs(ht)).add(abs(cross4)).greaterThan(2e-6), () => {
        const diag = hAt(-1, -1).add(hAt(1, -1)).add(hAt(-1, 1)).add(hAt(1, 1));
        const far2 = hAt(-2, 0).add(hAt(2, 0)).add(hAt(0, -2)).add(hAt(0, 2));
        bih.assign(h.mul(20).sub(cross4.mul(8)).add(diag.mul(2)).add(far2).div(t * t * t * t));
      });
      const beta = tn.wakeSpeed.mul(tn.wakeSpeed).mul(tn.wakeDispersion).mul((t * t) / 8);
      const edgeD = min(min(Ws.x.sub(near.uWin.x), near.uWin.x.add(near.n - 1).sub(Ws.x)), min(Ws.y.sub(near.uWin.y), near.uWin.y.add(near.n - 1).sub(Ws.y)));
      const sponge = float(1).sub(smoothstep(0, 40, edgeD)).mul(6);
      const c2 = tn.wakeSpeed.mul(tn.wakeSpeed);
      ht.assign(ht.add(c2.mul(lap).add(beta.mul(bih)).sub(ht.mul(tn.wakeDamping.add(sponge))).mul(tn.dt)));
      h.assign(h.add(ht.mul(tn.dt)));
      const wetMask = rev(0.15, -0.05, hgt);
      h.assign(clamp(h.mul(wetMask), -0.5, 0.5));
      ht.assign(clamp(ht.mul(wetMask), -4, 4));
      vel.assign(decay(vel, float(1.8)));
      dist.assign(decay(dist, float(4.5)));

      If(c.greaterThan(0), () => {
        foamSim(c, age, P.sub(tn.laceOrigin), fl, 0.95);
      });

      forEachSplat(queue, 1, s, (a, b) => {
        If(a.x.lessThan(0.5), () => {
          foamBrush(P, a, b, t, c, age, k.noise);
        }).Else(() => {
          wakeBrush(P, a, b, tn.dt, h, ht, vel, dist);
        });
      });
      c.assign(c.mul(float(1).sub(smoothstep(1.6, 2.4, hgt))));
      textureStore(near.tex[q], s, dither4(vec4(c, c.mul(age), dist, 0), vec2(s), tn.seed)).toWriteOnly();
      textureStore(k.nearB[q], s, dither4(vec4(h, ht, vel), vec2(s), tn.seed.wzyx)).toWriteOnly();
    })().compute([near.n / WG, near.n / WG, 1], [WG, WG, 1]).setName(`gl.state.near${p}`);

    // ── Sand: wetness, depression, displaced mass, freshly smoothed. ──
    const sSrc = baseTex(sand.tex[p]);
    const act = k.active;
    const sandKernel = Fn(() => {
      // Scheduled tiles only (active.ts): workgroup x = list entry, y = 8x8 block in the tile.
      const entry = act.list.element(workgroupId.x).toVar();
      const tile = int(entry.x).toVar();
      const dtS = entry.y.toVar();
      const blk = int(workgroupId.y);
      const tps = int(act.tps);
      const s = ivec2(
        mod(tile, tps).mul(TILE).add(mod(blk, int(4)).mul(WG)).add(int(localId.x)),
        tile.div(tps).mul(TILE).add(blk.div(int(4)).mul(WG)).add(int(localId.y)),
      ).toVar();
      const n = float(sand.n);
      const l = mod(vec2(s).sub(sand.uWin.zw).add(n), n);
      const W = sand.uWin.xy.add(l).toVar();
      const t = sand.texel;
      const P = W.add(0.5).mul(t).toVar();
      const sA = st.sampleA(P).toVar();
      const hgt = sA.x;
      const valid = inside(W.sub(sand.uPrev.xy), sand.n).and(sand.uReset.lessThan(0.5));
      const prev = sSrc.load(s);
      const farS = farNew.sample(P.mul(far.uView.w)).level(0);
      const wet = valid.select(prev.x, farS.z).toVar();
      const dep = valid.select(prev.y, 0).toVar();
      const mass = valid.select(prev.z, 0).toVar();
      const sm = valid.select(prev.w, farS.w).toVar();

      // Above the floor it dries (fast while a standing film drains, then slowly); below it (a
      // pressed halo) it soaks back up to the floor in ~1.5 s.
      const floorS = st.wetFloor(sA).toVar();
      const dried = dryWet(wet, dtS, hgt, floorS, tn);
      const soaked = mix(floorS, wet, exp(dtS.negate().div(1.5)));
      wet.assign(wet.lessThan(floorS).select(soaked, dried));
      // Under the surf zone's water. Not in the dt = 0 sync pass: the water has moved since the update
      // pass, and re-wetting would leave the two ping-pong textures different.
      const wetSrc = k.wetSrc;
      if (wetSrc) If(dtS.greaterThan(0).and(hgt.greaterThan(-1)).and(hgt.lessThan(2.5)), () => {
        wet.assign(max(wet, wetSrc(P, 0.04)));
      });
      sm.assign(sm.mul(exp(dtS.negate().div(18))));
      // Refill: dry footprints stay put; damp sand slumps slowly; under water they wash out fast.
      const under = rev(0.0, -0.15, hgt);
      const tau = mix(mix(float(5400), tn.refillWet, smoothstep(0.35, 0.8, wet)), float(5), under);
      dep.assign(dep.mul(exp(dtS.negate().div(tau))));
      mass.assign(mass.mul(exp(dtS.negate().div(tau.mul(0.8)))));

      forEachSplat(queue, 2, s, (a, b) => {
        If(a.x.lessThan(2.5), () => {
          wetBrush(P, a, b, t, wet);
        })
          .ElseIf(a.x.lessThan(3.5), () => {
            footprintBrush(P, a, b, wet, hgt, dep, mass);
          })
          .Else(() => {
            smoothBrush(P, a, b, t, dep, mass, sm);
          });
      });
      // Water seeps into prints pressed into damp sand, leaving a glint in the hollow.
      const seep = smoothstep(0.45, 0.75, wet).mul(smoothstep(0.0015, 0.006, dep));
      wet.assign(max(wet, seep.mul(0.99)));
      // The water in the hollow is a smooth film (the beach shader keys its gloss off this).
      sm.assign(max(sm, seep.mul(0.9)));
      textureStore(sand.tex[q], s, dither4(vec4(clamp(wet, 0, 1), max(dep, 0), max(mass, 0), clamp(sm, 0, 1)), vec2(s), tn.seed)).toWriteOnly();
    })().compute(act.dispatch, [WG, WG, 1]).setName(`gl.state.sand${p}`);

    out.lists[p] = [farKernel, nearKernel, sandKernel];
  }
  return out;
}

