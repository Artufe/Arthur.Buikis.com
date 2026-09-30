// The breaker ribbon: real geometry for every breaking crest, swept along it.
//
// One grid per tracker slot (NI along the crest × NJ profile points). Each vertex reads its slot's
// crest data at a column (ray) chosen by a log warp that puts the densest sampling where the
// camera is, then places profile point j (profile.ts) in the crest frame. Near the ribbon's edges
// the swell's own train-0 displacement takes over (the blend weight W), and trains 1-2 and the
// FFT sea are added everywhere, so the ribbon meets the ocean surface exactly (the ocean is pushed
// out of the way underneath by hook.ts). It is shaded with the water graph (A7), with the lip's
// light path and chord as varyings (the backlit lip glows), and the stage's whitewater as foam.

import { BufferAttribute, BufferGeometry, Mesh, Sphere, Vector3, type Material } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { TSLNode } from '../../core/contracts';
import type { OceanSurface } from '../surface';
import { swellTrainDisplacementGPU, type SwellGPU } from '../swell-gpu';
import { globals, profA, profB, profC, profileUVW, slotCam, slotHeader, slotRow, slotTexel, type BreakGPU } from './gpu';
import { J_FACE0, J_FRONT0, J_LIP0, NJ } from './profile';
import { SLOTS } from './tracker';

const {
  Fn, If, abs, clamp, cross, dot, exp, float, floor, int, length, log, max, min, mix, mx_noise_float, normalize, select, smoothstep, varyingProperty, vec2, vec3, vec4,
} = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;
const { positionGeometry, positionPrevious, cameraPosition } = TSL as unknown as Record<string, TSLNode>;

/** Vertices along the crest per slot. */
export const NI = 288;

export interface RibbonVaryings {
  vRest: TSLNode;
  vN: TSLNode;
  vThick: TSLNode;
  vChord: TSLNode;
  /** (foam coverage, foam age, gain on the state's foam (0 inside the tube), φ). */
  vFoam: TSLNode;
  vSwD: TSLNode;
  vSwX: TSLNode;
  /** Unit surface tangent that rest-space +wave-direction maps to (water material frame). */
  vT: TSLNode;
  /** Shell: (billow value -1..1, crevices low; foam density). Water surface: (W total, tube 0-1). */
  vBillow: TSLNode;
}

export interface RibbonPart {
  mesh: Mesh;
  positionNode: TSLNode;
  v: RibbonVaryings;
}

export interface Ribbon extends RibbonPart {
  /** The whitewater shell: the same ribbon, only where it's foam, pushed out and churning. */
  shell: RibbonPart;
  dispose(): void;
}

function buildGeometry() {
  const nv = NI * NJ * SLOTS;
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  let q = 0;
  for (let s = 0; s < SLOTS; s++)
    for (let i = 0; i < NI; i++)
      for (let j = 0; j < NJ; j++) {
        pos[q * 3] = i / (NI - 1);
        pos[q * 3 + 1] = j;
        pos[q * 3 + 2] = s;
        nrm[q * 3 + 1] = 1;
        q++;
      }
  const idx = new Uint32Array(SLOTS * (NI - 1) * (NJ - 1) * 6);
  let k = 0;
  for (let s = 0; s < SLOTS; s++) {
    const b = s * NI * NJ;
    for (let i = 0; i < NI - 1; i++)
      for (let j = 0; j < NJ - 1; j++) {
        const a = b + i * NJ + j;
        const c = a + NJ;
        idx[k++] = a;
        idx[k++] = a + 1;
        idx[k++] = c;
        idx[k++] = c;
        idx[k++] = a + 1;
        idx[k++] = c + 1;
      }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.boundingSphere = new Sphere(new Vector3(), 1e6);
  return g;
}

/** Surface normal from (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z) and ∂Dx/∂z (same as ocean/surface.ts). */
function normalFrom(dd: TSLNode, dxz: TSLNode) {
  const jx = dd.z.add(1);
  const jz = dd.w.add(1);
  const J = jx.mul(jz).sub(dxz.mul(dxz));
  return normalize(vec3(dd.y.mul(dxz).sub(jz.mul(dd.x)), max(J, 0.05), dxz.mul(dd.x).sub(dd.y.mul(jx))));
}

export interface RibbonUniforms {
  /** Metres the ribbon's outermost edge sits under the swell (so the ocean wins there). */
  edgeDrop: TSLNode;
  /** 0/1: show the ribbon. */
  enabled: TSLNode;
  /** Along-crest warp: finest spacing near the camera (columns). */
  warp: TSLNode;
  /** SSS gain on the lip (the tube ceiling's glow). */
  lipGlow: TSLNode;
  /** Strength of the flow streaks on the lip and face. */
  streaks: TSLNode;
  /** 0-2: chop facets modulating the backlit glow (water material). */
  faceTexture: TSLNode;
  /** Extra isotropic SSS on the lip. */
  lipDiffuse: TSLNode;
}

export function createRibbon(g: BreakGPU, swell: SwellGPU, surface: OceanSurface, u: RibbonUniforms): Ribbon {
  const geometry = buildGeometry();
  const make = (shell: boolean): RibbonPart => {
    const v = buildVaryings(shell ? 'vWw' : 'vBrk');
    const positionNode = buildPosition(g, swell, surface, u, v, shell);
    const mesh = new Mesh(geometry);
    mesh.name = shell ? 'ocean.whitewater' : 'ocean.breakers';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return { mesh, positionNode, v };
  };
  const water = make(false);
  const shell = make(true);
  return {
    ...water,
    shell,
    dispose() {
      geometry.dispose();
      (water.mesh.material as Material).dispose();
      (shell.mesh.material as Material).dispose();
    },
  };
}

function buildVaryings(p: string): RibbonVaryings {
  return {
    vRest: varyingProperty('vec2', p + 'Rest'),
    vN: varyingProperty('vec3', p + 'N'),
    vThick: varyingProperty('vec4', p + 'Thick'),
    vChord: varyingProperty('float', p + 'Chord'),
    vFoam: varyingProperty('vec4', p + 'Foam'),
    vSwD: varyingProperty('vec4', p + 'SwD'),
    vSwX: varyingProperty('vec4', p + 'SwX'),
    vT: varyingProperty('vec3', p + 'T'),
    vBillow: varyingProperty('vec2', p + 'Billow'),
  };
}

function buildPosition(g: BreakGPU, swell: SwellGPU, surface: OceanSurface, u: RibbonUniforms, v: RibbonVaryings, shell: boolean) {
  return Fn(() => {
    const P = positionGeometry;
    const slot = int(P.z).toVar();
    const hdr = slotHeader(g, slot).toVar();
    const glob = globals(g).toVar();
    const pos = vec3(0, -60, 0).toVar();
    const prev = vec3(0, -60, 0).toVar();
    // (Each variant writes only the varyings its material reads: 16 vertex outputs is the limit.)
    v.vRest.assign(vec2(0, 0));
    v.vN.assign(vec3(0, 1, 0));
    v.vBillow.assign(vec2(0, 0));
    if (!shell) {
      v.vThick.assign(vec4(20, -1, 1, 0));
      v.vChord.assign(float(1e3));
      v.vFoam.assign(vec4(0, 0.5, 1, -4));
      v.vSwD.assign(vec4(0));
      v.vSwX.assign(vec4(0, 0, 3, 1));
      v.vT.assign(vec3(1, 0, 0));
    }
    If(hdr.w.greaterThan(0.5).and(u.enabled.greaterThan(0.5)), () => {
      const r0 = hdr.x;
      const r1 = hdr.y;
      // Along-crest log warp around the camera's ray.
      const cam = slotCam(g, slot).toVar();
      const cc = clamp(cam.x, r0, r1).toVar();
      const E = u.warp;
      const lL = log(float(1).add(max(cc.sub(r0), 1e-3).div(E))).toVar();
      const lR = log(float(1).add(max(r1.sub(cc), 1e-3).div(E))).toVar();
      const tc = lL.div(lL.add(lR)).toVar();
      const t = P.x;
      const left = cc.sub(E.mul(exp(lL.mul(tc.sub(t)).div(max(tc, 1e-4))).sub(1)));
      const right = cc.add(E.mul(exp(lR.mul(t.sub(tc)).div(max(float(1).sub(tc), 1e-4))).sub(1)));
      const col = clamp(select(t.lessThan(tc), left, right), r0, r1).toVar();

      const R0 = slotRow(g, slot, 0, col).toVar();
      const R1 = slotRow(g, slot, 1, col).toVar();
      const R2 = slotRow(g, slot, 2, col).toVar();
      const R3 = slotRow(g, slot, 3, col).toVar();
      const ci = int(floor(clamp(col, 0, max(r1.sub(1), r0))));
      const ca = slotTexel(g, slot, 0, ci);
      const cb = slotTexel(g, slot, 0, ci.add(1));
      const dcdcol = vec2(cb.x.sub(ca.x), cb.y.sub(ca.y)).toVar();

      const H = max(R0.w, 0.05).toVar();
      const W = R0.z.toVar();
      const d2 = normalize(vec2(R1.x, R1.y)).toVar();
      const d3 = vec3(d2.x, 0, d2.y);
      const phi = R1.z.toVar();
      const kap = R1.w.toVar();
      const j = P.y;
      const uvw = profileUVW(j, phi, kap);
      const A = profA(g, uvw).toVar();
      const B = profB(g, uvw).toVar();
      const Am = profA(g, profileUVW(max(j.sub(1), 0), phi, kap));
      const Ap = profA(g, profileUVW(min(j.add(1), NJ - 1), phi, kap));
      const Aph = profA(g, profileUVW(j, phi.add(0.25), kap));

      const Cc = profC(g, uvw);
      const Wt = W.mul(B.z).toVar();
      // The shell only exists where there is whitewater (everything else collapses to a point).
      If(shell ? B.x.mul(Wt).mul(float(1).sub(B.w.mul(Wt))).greaterThan(0.03) : float(1).greaterThan(0), () => {
      const crest = vec2(R0.x, R0.y);
      const rest = crest.add(d2.mul(B.y.mul(H))).toVar();
      // The water's detail is sampled at arc length through the lip and face (texture σ).
      const restTex = crest.add(d2.mul(Cc.x.mul(H))).toVar();
      // Emulate the clipmap's vertex spacing at this distance, so the ribbon band-limits the
      // swell and the FFT sea exactly as the ocean surface around it does.
      const rel = rest.sub(vec2(cameraPosition.x, cameraPosition.z));
      const cheb = max(abs(rel.x), abs(rel.y));
      const sEff = max(float(0.06), cheb.div(32)).toVar();
      const depth = R2.y;
      const t0 = swellTrainDisplacementGPU(swell, 0, rest, sEff);
      const t1 = swellTrainDisplacementGPU(swell, 1, rest, sEff);
      const t2 = swellTrainDisplacementGPU(swell, 2, rest, sEff);
      const F = surface.fftDisplacement(rest, sEff, depth).toVar();
      const rest3 = vec3(rest.x, 0, rest.y);
      // The trough ahead of a big breaker can't drain the reef dry: keep it above the (smoothed)
      // seabed ahead, softly (lip tip and curtain follow it down to the same floor).
      const floorY = max(R3.z.sub(1.0), 0.3).negate();
      const yRaw = A.y.mul(H);
      const soft = float(0.35);
      const yCl = select(j.greaterThanEqual(J_LIP0), floorY.add(soft.mul(log(float(1).add(exp(yRaw.sub(floorY).div(soft)))))), yRaw);
      const prof = vec3(crest.x, 0, crest.y).add(d3.mul(A.x.mul(H))).add(vec3(0, yCl, 0)).toVar();
      const drop = vec3(0, u.edgeDrop.mul(float(1).sub(Wt)), 0);
      // The breaker replaces the whole swell near its crest (trains 1-2 are folded into its H by
      // the tracker); the swell comes back through the blend zones. The FFT sea rides on top.
      const swellD = t0.d.add(t1.d).add(t2.d);
      pos.assign(mix(rest3.add(swellD), prof, Wt).add(F).sub(drop));
      const dt = glob.y;
      const profPrev = prof.sub(d3.mul(R2.z.mul(dt)));
      prev.assign(mix(rest3.add(t0.dPrev).add(t1.dPrev).add(t2.dPrev), profPrev, Wt).add(F).sub(drop));

      // Normal: profile tangent × along-crest tangent (crest spacing + how the profile changes
      // along the crest), blended toward train 0's own normal at the edges.
      const Tp = d3.mul(Ap.x.sub(Am.x).mul(H)).add(vec3(0, Ap.y.sub(Am.y).mul(H), 0)).toVar();
      const dAdphi = Aph.sub(A).div(0.25);
      const dphi = R3.x.mul(cam.w);
      const dH = R3.y.mul(cam.w);
      // Along-crest spacing: where neighbouring columns share a stand-in crest position the
      // difference vanishes, so fall back to the crest line's own direction (never a zero cross).
      const e3a = vec3(d2.y.negate(), 0, d2.x);
      const dc3 = select(length(dcdcol).lessThan(cam.w.mul(0.25)), e3a.mul(cam.w), vec3(dcdcol.x, 0, dcdcol.y));
      const Ta = dc3
        .add(d3.mul(dAdphi.x.mul(H).mul(dphi).add(A.x.mul(dH))))
        .add(vec3(0, dAdphi.y.mul(H).mul(dphi).add(A.y.mul(dH)), 0))
        .toVar();
      const cr = cross(Ta, Tp);
      const Np = select(length(cr).greaterThan(1e-6), normalize(cr), vec3(0, 1, 0)).toVar();
      const N0 = normalFrom(t0.dd.add(t1.dd).add(t2.dd), t0.dxz.add(t1.dxz).add(t2.dxz));
      const Ng = normalize(mix(N0, Np, Wt)).toVar();

      // Flow streaks on the glassy lip and face: water running along the jet and up the face
      // leaves long ridges across the crest (seen best from inside the tube). Vertex-level, so
      // only metre-scale structure; the FFT sea adds the fine chop in the fragment.
      if (!shell) {
        If(Wt.greaterThan(0.3).and(j.greaterThanEqual(J_LIP0)).and(j.lessThan(J_FRONT0)), () => {
          const tm = glob.x;
          const am2 = col.mul(cam.w);
          const qs = vec3(Cc.x.mul(H).div(2.6).sub(tm.mul(0.9)), am2.div(0.42), tm.mul(0.25));
          const es = float(0.25);
          const g1 = mx_noise_float(qs.add(vec3(0, es, 0))).sub(mx_noise_float(qs.sub(vec3(0, es, 0))));
          const g2 = mx_noise_float(qs.mul(2.1).add(vec3(3.3, es, 1.1))).sub(mx_noise_float(qs.mul(2.1).add(vec3(3.3, es.negate(), 1.1))));
          // (faded where the ribbon's vertices are too sparse to carry 0.4 m streaks: no rings)
          const k2 = u.streaks.mul(Wt).mul(float(1).sub(smoothstep(0.1, 0.5, B.x))).mul(float(1).sub(smoothstep(0.07, 0.16, sEff)));
          const e3s = vec3(d2.y.negate(), 0, d2.x);
          Ng.assign(normalize(Ng.add(e3s.mul(g1.add(g2.mul(0.5)).mul(k2)))));
        });
      }

      // Whitewater billows: the foam-covered roller and curtain churn, rolling forward over the
      // top and down the front (noise advected along the profile in the crest frame).
      // (the shell never covers the open tube's inner side: from inside you'd see its dark back)
      const foam = (shell ? B.x.mul(Wt).mul(float(1).sub(B.w.mul(Wt))) : B.x.mul(Wt)).toVar();
      If(foam.greaterThan(0.05), () => {
        const time = glob.x;
        // Crest-frame coordinates (m): across the wave, up, along the crest. The pattern rolls
        // forward over the top and down the front, and drifts slowly along the crest.
        const relx = pos.x.sub(crest.x);
        const relz = pos.z.sub(crest.y);
        const um = relx.mul(d2.x).add(relz.mul(d2.y));
        const am = col.mul(cam.w);
        const q = vec3(um.div(0.85).add(time.mul(0.6)), pos.y.div(0.85).sub(time.mul(0.9)), am.div(1.05).add(time.mul(0.2))).toVar();
        const amp = H.mul(0.12).mul(smoothstep(0.05, 0.6, foam)).toVar();
        // Cauliflower: billow noise (|n|: rounded lumps, sharp creases between them), two octaves.
        const bil = (p: TSLNode) => abs(mx_noise_float(p)).add(abs(mx_noise_float(p.mul(2.3).add(7.1))).mul(0.5));
        const e = float(0.22);
        const b0 = bil(q).toVar();
        const gx = bil(q.add(vec3(e, 0, 0))).sub(b0);
        const gy = bil(q.add(vec3(0, e, 0))).sub(b0);
        const gz = bil(q.add(vec3(0, 0, e))).sub(b0);
        // Mostly outward (a turbulent mass bulges). The shell sits proud of the water surface by
        // its own thickness and churns harder.
        const lift = shell ? H.mul(0.05).add(0.04).mul(smoothstep(0.03, 0.4, foam)) : float(0);
        const k = shell ? 1.9 : 1.1;
        const b = b0.mul(k).sub(0.15).mul(amp).add(lift);
        pos.addAssign(Ng.mul(b));
        prev.addAssign(Ng.mul(b));
        if (shell) v.vBillow.assign(vec2(clamp(b0.mul(1.6), 0, 1), foam));
        // World gradient of the billow height; its tangential part tilts the normal.
        const e3 = vec3(d2.y.negate(), 0, d2.x);
        const G = d3.mul(gx.div(0.85)).add(vec3(0, gy.div(0.85), 0)).add(e3.mul(gz.div(1.05))).mul(amp.mul(k).div(e));
        const Gt = G.sub(Ng.mul(dot(G, Ng)));
        Ng.assign(normalize(Ng.sub(Gt)));
      });
      v.vN.assign(Ng);
      v.vRest.assign(restTex);
      if (!shell) {
        v.vT.assign(normalize(mix(d3, normalize(Tp), Wt)));
        const lip = j.greaterThanEqual(J_LIP0).and(j.lessThan(J_FACE0));
        // The thin lip transmits the low sun (steepness 1 = light certainly crosses it), and more:
        // A7's single-scatter SSS is forward-peaked, so seen from inside the tube (sideways to the
        // sun) the ceiling would stay dull. The extra gain stands in for multiple scattering in
        // the aerated, thin jet. Elsewhere the fragment decides from its normal (−1).
        v.vThick.assign(vec4(max(A.z.mul(H).mul(select(lip, float(1.6), float(1))), 0.03), select(lip.and(Wt.greaterThan(0.5)), u.lipGlow, float(-1)), d2.x, d2.y));
        // Seen through the lip the view ray runs along the curved sheet, far longer than its
        // thickness: a green glow, not a window onto the sky.
        v.vChord.assign(select(Wt.greaterThan(0.3), A.w.mul(H).mul(select(lip, float(5), float(1))).add(0.02), float(1e3)));
        v.vFoam.assign(vec4(foam, 0.03, float(1).sub(B.w.mul(Wt).mul(0.97)), phi));
        // The whole swell is in the geometric normal (vN), so the material adds only the FFT sea.
        v.vSwD.assign(vec4(0));
        // "Broken" to the water material: breaking-zone water is never a wind slick (A7 damps the
        // capillaries in slicks unless broken), so the face keeps its chop.
        // Steep walls (the tube's back wall, the face near vertical) don't show the seabed: the
        // screen-space refraction would look through them at the sky above the horizon and the reef
        // below it (a hard seam at eye level). Report deep water there (A7 culls the seabed).
        const steepWall = float(1).sub(smoothstep(0.12, 0.35, Ng.y)).mul(Wt);
        v.vSwX.assign(vec4(0, max(smoothstep(-0.5, 2, phi), Wt.mul(0.9)), mix(depth, float(40), steepWall), sEff));
        v.vBillow.assign(vec2(Wt, B.w.mul(Wt)));
      }
      void dot;
      });
    });
    positionPrevious.assign(prev);
    return pos;
  })();
}
