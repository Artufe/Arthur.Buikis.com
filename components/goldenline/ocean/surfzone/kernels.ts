// GPU kernels of the surf-zone simulation. momentum() and continuity() mirror scheme.ts line by
// line (tested there); read that file for the method. Per frame: n × (momentum, continuity), then
// foam, then pack (the filtered textures the renderer and the state read), then the readback
// window when the camera is near the domain.
//
// Textures (NX × NZ):
//   S0/S1  rgba32f  (h, u, v, b)       depth at the cell, x-face and z-face velocity, bed
//   F0/F1  rgba32f  (c, c·age, gen, 0) foam coverage (× age: filtering weights age by coverage)
//   R0     rgba16f  (η, h, c, age)     render: free surface, depth, foam
//   R1     rgba16f  (∂η/∂x, ∂η/∂z, uc, vc)  render: slope (wet-masked), cell-centred velocity

import { ClampToEdgeWrapping, FloatType, HalfFloatType, LinearFilter, NearestFilter, RGBAFormat, StorageTexture, Vector4 } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../../core/contracts';
import type { SwellGPU } from '../swell-gpu';
import { swellTrainDisplacementGPU } from '../swell-gpu';
import { N_TRAINS } from '../swell';
import { DEFAULT_GAIN, DX, DZ, H_DRY, MANNING, NX, NZ, RELAX_RATE, RELAX_X, SPONGE_Z, WIN, WIN_STEP, X0, X1, Z0, Z1 } from './grid';
import { BREAK_H0, BREAK_H1, BREAK_ONSET, EPS, G, INFILTRATION, NU_MAX, NU_STAB, UMAX } from './scheme';

const { Fn, If, abs, clamp, exp, float, floor, globalId, instancedArray, ivec2, max, min, mix, pow, select, smoothstep, sqrt, texture, textureStore, uniform, vec2, vec3, vec4 } =
  TSL as unknown as Record<string, any>;

const WG = 8;
const baseTex = (t: unknown) => texture(t, vec2(0, 0));

function makeTex(name: string, half: boolean) {
  const t = new StorageTexture(NX, NZ);
  t.type = half ? HalfFloatType : FloatType;
  t.format = RGBAFormat;
  t.magFilter = half ? LinearFilter : NearestFilter;
  t.minFilter = half ? LinearFilter : NearestFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  (t as unknown as { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
  t.name = `goldenline.surfzone.${name}`;
  return t;
}

/** smoothstep falling from 1 at x ≤ b to 0 at x ≥ a (a > b): reversed edges are undefined on Metal. */
const rev = (a: number, b: number, x: TSLNode) => float(1).sub(smoothstep(b, a, x));

export interface SurfZoneKernels {
  S: [StorageTexture, StorageTexture];
  F: [StorageTexture, StorageTexture];
  R0: StorageTexture;
  R1: StorageTexture;
  /** Readback window: WIN² × (η, h, uc, vc) then WIN² × (c, age, 0, 0). */
  win: { value: unknown; array: Float32Array };
  bake: TSLNode;
  /** [momentum, continuity] for one substep (S0 → S1 → S0). */
  step: TSLNode[];
  /** Foam + pack, by foam parity (0: F0 → F1, 1: F1 → F0). */
  post: [TSLNode[], TSLNode[]];
  readWin: TSLNode;
  /** (substep dt, frame dt, window x0, window z0). */
  uStep: TSLNode;
  /** (swell gain, Manning n, infiltration m/s, breaking viscosity ×). */
  uMisc: TSLNode;
  dispose(): void;
}

/**
 * `bedAt(xz)` = the rendered base terrain height (so the water sits exactly on the sand drawn),
 * `omega` = the swell trains' angular frequencies.
 */
export function createKernels(swell: SwellGPU, bedAt: (xz: TSLNode) => TSLNode, omega: ArrayLike<number>): SurfZoneKernels {
  const S: [StorageTexture, StorageTexture] = [makeTex('S0', false), makeTex('S1', false)];
  const F: [StorageTexture, StorageTexture] = [makeTex('F0', false), makeTex('F1', false)];
  const R0 = makeTex('R0', true);
  const R1 = makeTex('R1', true);
  const uStep = uniform(new Vector4(1 / 120, 1 / 60, 0, 0));
  const dt = uStep.x;
  const dtF = uStep.y;
  /** (swell gain at and inside the seaward edge, Manning n, infiltration m/s, breaking viscosity ×). */
  const uMisc = uniform(new Vector4(DEFAULT_GAIN, MANNING, INFILTRATION, 1));

  const cellXZ = (c: TSLNode) => vec2(float(X0).add(float(c.x).add(0.5).mul(DX)), float(Z0).add(float(c.y).add(0.5).mul(DZ)));
  const clampC = (c: TSLNode) => clamp(c, ivec2(0, 0), ivec2(NX - 1, NZ - 1));

  /** Relaxation weight (grid.ts relaxWeight). */
  const relaxW = (p: TSLNode) => {
    const ax = max(float(1).sub(p.x.sub(X0).div(RELAX_X)), 0);
    const az = max(max(float(1).sub(p.y.sub(Z0).div(SPONGE_Z)), float(1).sub(float(Z1).sub(p.y).div(SPONGE_Z))), 0);
    const w = max(ax, az);
    return w.mul(w);
  };

  /**
   * The incident swell at world p (Eulerian: the Gerstner surface is evaluated one fixed-point
   * step back along its horizontal displacement), scaled by the lagoon gain: vec3(η, U, V),
   * U/V = depth-averaged velocity. The volume flux of a progressive shallow-water wave is
   * (h + η)·u = c·η, which averages to zero: dividing by the still depth instead pumped the
   * wave's Stokes transport into the domain every cycle, with nowhere to return, and flooded the
   * beach.
   */
  const incident = (p: TSLNode, hStill: TSLNode) => {
    const eta = float(0).toVar();
    const flux = vec2(0, 0).toVar();
    for (let tr = 0; tr < N_TRAINS; tr++) {
      const t0 = swellTrainDisplacementGPU(swell, tr, p, float(0));
      const t1 = swellTrainDisplacementGPU(swell, tr, p.sub(vec2(t0.d.x, t0.d.z)), float(0));
      const kx = t1.tp.kx;
      const kz = t1.tp.kz;
      const kl = max(sqrt(kx.mul(kx).add(kz.mul(kz))), 1e-4);
      const e = t1.d.y;
      eta.addAssign(e);
      flux.addAssign(vec2(kx, kz).mul(e.mul(float(omega[tr]).div(kl)).div(kl)));
    }
    const gain = uMisc.x;
    const U = flux.mul(gain).div(max(hStill.add(eta.mul(gain)), 0.3));
    return vec3(eta.mul(gain), U.x, U.y);
  };

  // ── Bake: bed from the terrain, still water at sea level. ──
  const bake = Fn(() => {
    const c = ivec2(globalId.xy);
    const p = cellXZ(c);
    const b = bedAt(p).toVar();
    const s = vec4(max(b.negate(), 0), 0, 0, b);
    textureStore(S[0], c, s).toWriteOnly();
    textureStore(S[1], c, s).toWriteOnly();
    textureStore(F[0], c, vec4(0)).toWriteOnly();
    textureStore(F[1], c, vec4(0)).toWriteOnly();
  })().compute([NX / WG, NZ / WG, 1], [WG, WG, 1]).setName('gl.surfzone.bake');

  /** Upwind face depth between cells a and b (vec4 h, u, v, b) for velocity vel. */
  const faceDepth = (a: TSLNode, b: TSLNode, vel: TSLNode) => {
    const ea = a.x.add(a.w);
    const eb = b.x.add(b.w);
    const e = select(vel.greaterThan(0), ea, select(vel.lessThan(0), eb, max(ea, eb)));
    return max(e.sub(max(a.w, b.w)), 0);
  };

  // ── Momentum (scheme.ts stepMomentum): S0 → S1 ──
  const momentum = Fn(() => {
    const src = baseTex(S[0]);
    const c = ivec2(globalId.xy).toVar();
    const i = c.x;
    const j = c.y;
    const L = (di: number, dj: number) => src.load(clampC(c.add(ivec2(di, dj))));
    const C0 = L(0, 0).toVar();
    const XP = L(1, 0).toVar();
    const XM = L(-1, 0).toVar();
    const XP2 = L(2, 0).toVar();
    const ZP = L(0, 1).toVar();
    const ZM = L(0, -1).toVar();
    const ZP2 = L(0, 2).toVar();
    const XPZM = L(1, -1).toVar();
    const XMZP = L(-1, 1).toVar();
    const hasXM = i.greaterThan(0);
    const hasXF = i.lessThan(NX - 1); // this cell's x-face exists
    const hasXPF = i.lessThan(NX - 2); // the next cell's x-face exists
    const hasZM = j.greaterThan(0);
    const hasZF = j.lessThan(NZ - 1);
    const hasZPF = j.lessThan(NZ - 2);
    const n2g = uMisc.y.mul(uMisc.y).mul(G);
    // scheme.ts nuCap: the explicit-diffusion limit of this substep.
    const nuCap = min(float(NU_MAX), float(NU_STAB).div(dt.mul(1 / (DX * DX) + 1 / (DZ * DZ))));

    // x-face (i + ½, j)
    const uN = float(0).toVar();
    If(hasXF, () => {
      const eL = C0.x.add(C0.w);
      const eR = XP.x.add(XP.w);
      const hf = max(eL, eR).sub(max(C0.w, XP.w)).toVar();
      If(hf.greaterThan(EPS), () => {
        const u0 = C0.y;
        const hbar = max(C0.x.add(XP.x).mul(0.5), EPS);
        const qM = select(hasXM, faceDepth(XM, C0, XM.y).mul(XM.y), float(0));
        const q0 = faceDepth(C0, XP, u0).mul(u0);
        const qP = select(hasXPF, faceDepth(XP, XP2, XP.y).mul(XP.y), float(0));
        const qc0 = qM.add(q0).mul(0.5);
        const qc1 = q0.add(qP).mul(0.5);
        const uM = select(hasXM, XM.y, float(0));
        const uP = select(hasXPF, XP.y, float(0));
        const us0 = select(qc0.greaterThanEqual(0), uM, u0);
        const us1 = select(qc1.greaterThanEqual(0), u0, uP);
        const adv = qc1.mul(us1).sub(qc0.mul(us0)).sub(u0.mul(qc1.sub(qc0))).div(hbar.mul(DX));
        const vb = select(hasZF, C0.z.add(XP.z), float(0)).add(select(hasZM, ZM.z.add(XPZM.z), float(0))).mul(0.25);
        const dudz = select(vb.greaterThan(0), select(hasZM, u0.sub(ZM.y), float(0)), select(hasZF, ZP.y.sub(u0), float(0)));
        const un = u0.sub(dt.mul(float(G).mul(eR.sub(eL)).div(DX).add(adv).add(vb.mul(dudz).div(DZ)))).toVar();
        // Breaking (scheme.ts breakNu): an eddy viscosity where the surface rises fast.
        const etT = max(q0.sub(qM).negate(), qP.sub(q0).negate()).div(DX);
        const thr = sqrt(hbar.mul(G)).mul(BREAK_ONSET);
        const nu = min(smoothstep(thr, thr.mul(2), etT).mul(smoothstep(BREAK_H0, BREAK_H1, hbar)).mul(hbar).mul(etT).mul(1.44).mul(uMisc.w), nuCap);
        // Momentum-conservative along the flow (scheme.ts): (1/h)·∂x(ν·h·∂x u).
        const lap = XP.x.mul(uP.sub(u0)).sub(C0.x.mul(u0.sub(uM))).div(hbar.mul(DX * DX)).add(select(hasZF, ZP.y, u0).add(select(hasZM, ZM.y, u0)).sub(u0.mul(2)).div(DZ * DZ));
        un.addAssign(dt.mul(nu).mul(lap));
        un.assign(un.div(float(1).add(dt.mul(n2g).mul(abs(un)).div(pow(hf, 4 / 3)))));
        uN.assign(clamp(un, -UMAX, UMAX));
      });
    });

    // z-face (i, j + ½)
    const vN = float(0).toVar();
    If(hasZF, () => {
      const eL = C0.x.add(C0.w);
      const eR = ZP.x.add(ZP.w);
      const hf = max(eL, eR).sub(max(C0.w, ZP.w)).toVar();
      If(hf.greaterThan(EPS), () => {
        const v0 = C0.z;
        const hbar = max(C0.x.add(ZP.x).mul(0.5), EPS);
        const qM = select(hasZM, faceDepth(ZM, C0, ZM.z).mul(ZM.z), float(0));
        const q0 = faceDepth(C0, ZP, v0).mul(v0);
        const qP = select(hasZPF, faceDepth(ZP, ZP2, ZP.z).mul(ZP.z), float(0));
        const qc0 = qM.add(q0).mul(0.5);
        const qc1 = q0.add(qP).mul(0.5);
        const vM = select(hasZM, ZM.z, float(0));
        const vP = select(hasZPF, ZP.z, float(0));
        const vs0 = select(qc0.greaterThanEqual(0), vM, v0);
        const vs1 = select(qc1.greaterThanEqual(0), v0, vP);
        const adv = qc1.mul(vs1).sub(qc0.mul(vs0)).sub(v0.mul(qc1.sub(qc0))).div(hbar.mul(DZ));
        const ub = select(hasXF, C0.y.add(ZP.y), float(0)).add(select(hasXM, XM.y.add(XMZP.y), float(0))).mul(0.25);
        const dvdx = select(ub.greaterThan(0), select(hasXM, v0.sub(XM.z), float(0)), select(hasXF, XP.z.sub(v0), float(0)));
        const vn = v0.sub(dt.mul(float(G).mul(eR.sub(eL)).div(DZ).add(adv).add(ub.mul(dvdx).div(DX)))).toVar();
        const etT = max(q0.sub(qM).negate(), qP.sub(q0).negate()).div(DZ);
        const thr = sqrt(hbar.mul(G)).mul(BREAK_ONSET);
        const nu = min(smoothstep(thr, thr.mul(2), etT).mul(smoothstep(BREAK_H0, BREAK_H1, hbar)).mul(hbar).mul(etT).mul(1.44).mul(uMisc.w), nuCap);
        const lap = ZP.x.mul(vP.sub(v0)).sub(C0.x.mul(v0.sub(vM))).div(hbar.mul(DZ * DZ)).add(select(hasXF, XP.z, v0).add(select(hasXM, XM.z, v0)).sub(v0.mul(2)).div(DX * DX));
        vn.addAssign(dt.mul(nu).mul(lap));
        vn.assign(vn.div(float(1).add(dt.mul(n2g).mul(abs(vn)).div(pow(hf, 4 / 3)))));
        vN.assign(clamp(vn, -UMAX, UMAX));
      });
    });
    textureStore(S[1], c, vec4(C0.x, uN, vN, C0.w)).toWriteOnly();
  })().compute([NX / WG, NZ / WG, 1], [WG, WG, 1]).setName('gl.surfzone.momentum');

  // ── Continuity (scheme.ts stepContinuity) + relaxation toward the incident swell: S1 → S0 ──
  const continuity = Fn(() => {
    const src = baseTex(S[1]);
    const c = ivec2(globalId.xy).toVar();
    const i = c.x;
    const j = c.y;
    const L = (di: number, dj: number) => src.load(clampC(c.add(ivec2(di, dj))));
    const C0 = L(0, 0).toVar();
    const XP = L(1, 0);
    const XM = L(-1, 0);
    const ZP = L(0, 1);
    const ZM = L(0, -1);
    const fx1 = select(i.lessThan(NX - 1), faceDepth(C0, XP, C0.y).mul(C0.y), float(0));
    const fx0 = select(i.greaterThan(0), faceDepth(XM, C0, XM.y).mul(XM.y), float(0));
    const fz1 = select(j.lessThan(NZ - 1), faceDepth(C0, ZP, C0.z).mul(C0.z), float(0));
    const fz0 = select(j.greaterThan(0), faceDepth(ZM, C0, ZM.z).mul(ZM.z), float(0));
    // + infiltration into the sand above sea level (scheme.ts infiltrationAt).
    const soak = smoothstep(0.05, 0.5, C0.w).mul(uMisc.z);
    const hn = max(C0.x.sub(dt.mul(fx1.sub(fx0).div(DX).add(fz1.sub(fz0).div(DZ)).add(soak))), 0).toVar();
    const un = C0.y.toVar();
    const vn = C0.z.toVar();
    const p = cellXZ(c).toVar();
    const w = relaxW(p).toVar();
    If(w.greaterThan(0), () => {
      const inc = incident(p, max(C0.w.negate(), 0)).toVar();
      const a = float(1).sub(exp(dt.mul(RELAX_RATE).mul(w).negate()));
      hn.assign(mix(hn, max(inc.x.sub(C0.w), 0), a));
      un.assign(mix(un, inc.y, a));
      vn.assign(mix(vn, inc.z, a));
    });
    textureStore(S[0], c, vec4(hn, un, vn, C0.w)).toWriteOnly();
  })().compute([NX / WG, NZ / WG, 1], [WG, WG, 1]).setName('gl.surfzone.continuity');

  /** Wet-masked central slope of η at cell C0 (a dry neighbour counts as level with C0). */
  const slope = (C0: TSLNode, XP: TSLNode, XM: TSLNode, ZP: TSLNode, ZM: TSLNode) => {
    const e0 = C0.x.add(C0.w);
    const ew = (n: TSLNode) => select(n.x.greaterThan(H_DRY), n.x.add(n.w), e0);
    return vec2(ew(XP).sub(ew(XM)).div(2 * DX), ew(ZP).sub(ew(ZM)).div(2 * DZ));
  };

  // ── Foam: generated at breaking fronts and the run-up tip, carried by the flow, aged. ──
  const foamKernel = (fi: number) =>
    Fn(() => {
      const st = baseTex(S[0]);
      const fsrc = baseTex(F[fi]);
      const c = ivec2(globalId.xy).toVar();
      const L = (di: number, dj: number) => st.load(clampC(c.add(ivec2(di, dj))));
      const C0 = L(0, 0).toVar();
      const XM = L(-1, 0).toVar();
      const ZM = L(0, -1).toVar();
      const XP = L(1, 0).toVar();
      const g = slope(C0, XP, XM, L(0, 1), ZM).toVar();
      const uc = C0.y.add(select(c.x.greaterThan(0), XM.y, C0.y)).mul(0.5).toVar();
      const vc = C0.z.add(select(c.y.greaterThan(0), ZM.z, C0.z)).mul(0.5).toVar();
      const spd = sqrt(uc.mul(uc).add(vc.mul(vc))).toVar();
      const h = C0.x;
      // A bore: the surface falls steeply ahead in the direction the water moves.
      const front = g.x.mul(uc).add(g.y.mul(vc)).negate().div(max(spd, 0.25));
      const bore = smoothstep(0.15, 0.38, front).mul(smoothstep(0.5, 1.6, spd)).mul(smoothstep(0.02, 0.12, h));
      // The run-up tip: the thin leading edge of an uprush (a dry cell ahead of it, moving up
      // the beach). Draining films don't foam.
      const dryAhead = select(XP.x.lessThan(H_DRY), float(1), float(0));
      const tip = rev(0.1, 0.02, h).mul(smoothstep(H_DRY, 0.01, h)).mul(smoothstep(0.4, 1.6, uc)).mul(dryAhead);
      const gen = max(bore, tip.mul(0.6)).toVar();
      // Semi-Lagrangian fetch at the departure point (manual bilinear: rgba32f isn't filterable).
      const q = vec2(c).sub(vec2(uc.mul(dtF).div(DX), vc.mul(dtF).div(DZ))).toVar();
      const q0 = floor(q).toVar();
      const f = q.sub(q0).toVar();
      const i0 = ivec2(q0);
      const FL = (o: TSLNode) => fsrc.load(clampC(i0.add(o)));
      const prev = mix(mix(FL(ivec2(0, 0)), FL(ivec2(1, 0)), f.x), mix(FL(ivec2(0, 1)), FL(ivec2(1, 1)), f.x), f.y).toVar();
      const cov = clamp(prev.x, 0, 1).toVar();
      const age = clamp(prev.y.div(max(prev.x, 1e-4)), 0, 1).toVar();
      // Foam lasts ~6 s on the water (tearing into lace as it ages); on sand the bubbles pop in a
      // couple of seconds.
      const tau = mix(float(2.2), float(6), smoothstep(H_DRY, 0.02, h));
      const kept = cov.mul(exp(dtF.div(tau).negate())).toVar();
      const nc = clamp(kept.add(gen.mul(dtF).mul(5).mul(float(1).sub(kept))), 0, 1).toVar();
      const na = min(age.mul(kept).div(max(nc, 1e-4)).add(dtF.div(12)), 1);
      const outC = select(nc.lessThan(0.002), float(0), nc);
      textureStore(F[1 - fi], c, vec4(outC, outC.mul(na), gen, 0)).toWriteOnly();
    })().compute([NX / WG, NZ / WG, 1], [WG, WG, 1]).setName(`gl.surfzone.foam${fi}`);

  // ── Pack: the filtered textures the renderer and the state read. ──
  const packKernel = (fi: number) =>
    Fn(() => {
      const st = baseTex(S[0]);
      const fs = baseTex(F[fi]);
      const c = ivec2(globalId.xy).toVar();
      const L = (di: number, dj: number) => st.load(clampC(c.add(ivec2(di, dj))));
      const C0 = L(0, 0).toVar();
      const XM = L(-1, 0).toVar();
      const ZM = L(0, -1).toVar();
      const g = slope(C0, L(1, 0), XM, L(0, 1), ZM);
      const uc = C0.y.add(select(c.x.greaterThan(0), XM.y, C0.y)).mul(0.5);
      const vc = C0.z.add(select(c.y.greaterThan(0), ZM.z, C0.z)).mul(0.5);
      const fo = fs.load(c);
      const cov = clamp(fo.x, 0, 1);
      textureStore(R0, c, vec4(C0.x.add(C0.w), C0.x, cov, clamp(fo.y.div(max(fo.x, 1e-4)), 0, 1))).toWriteOnly();
      textureStore(R1, c, vec4(g.x, g.y, uc, vc)).toWriteOnly();
    })().compute([NX / WG, NZ / WG, 1], [WG, WG, 1]).setName(`gl.surfzone.pack${fi}`);

  // ── Readback window: WIN² samples at WIN_STEP around the camera, into a storage buffer. ──
  const winBuf = instancedArray(WIN * WIN * 2, 'vec4');
  const r0 = baseTex(R0);
  const r1 = baseTex(R1);
  const readWin = Fn(() => {
    const c = ivec2(globalId.xy);
    const p = vec2(uStep.z.add(float(c.x).mul(WIN_STEP)), uStep.w.add(float(c.y).mul(WIN_STEP)));
    const uv = p.sub(vec2(X0, Z0)).div(vec2(X1 - X0, Z1 - Z0));
    const a = r0.sample(uv).level(0);
    const b = r1.sample(uv).level(0);
    const k = c.y.mul(WIN).add(c.x);
    winBuf.element(k).assign(vec4(a.x, a.y, b.z, b.w));
    winBuf.element(k.add(WIN * WIN)).assign(vec4(a.z, a.w, 0, 0));
  })().compute([WIN / WG, WIN / WG, 1], [WG, WG, 1]).setName('gl.surfzone.readWin');

  const foam = [foamKernel(0), foamKernel(1)];
  const pack = [packKernel(1), packKernel(0)];
  return {
    S,
    F,
    R0,
    R1,
    win: winBuf as unknown as { value: unknown; array: Float32Array },
    bake,
    step: [momentum, continuity],
    post: [
      [foam[0], pack[0]],
      [foam[1], pack[1]],
    ],
    readWin,
    uStep,
    uMisc,
    dispose() {
      for (const t of [...S, ...F, R0, R1]) t.dispose();
      for (const k of [bake, momentum, continuity, ...foam, ...pack, readWin]) k.dispose();
    },
  };
}
