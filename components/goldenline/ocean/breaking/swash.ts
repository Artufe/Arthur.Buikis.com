// The swash: what's left of each wave after the shore break runs up the beach face as a thin,
// fast sheet, stalls, and drains back as backwash, leaving a bubble line, lace and a wet film.
//
// CPU (zero-alloc): a 1-D state along the shore (0.5 m samples). When a shore-break bore reaches
// the waterline on some ray (tracker slot, event 2) it launches an uprush there with speed
// u0 = 2.2·sqrt(g·h_bore) (bore-collapse theory, damped); the front then moves ballistically up
// the local slope, x = x0 + u0·τ − a·τ²/2 (gravity along the slope + friction), stalls, and the
// sheet drains back more slowly, thinning to a film. Neighbouring samples launch with slightly
// different speeds and times, so the front is lobed and fingered, never a straight line. Along
// the front the swash writes SPLAT_WET (the glossy film), SPLAT_SMOOTH (erases footprints) and
// SPLAT_FOAM (the bubble line) into the surface state.
//
// GPU: a camera-centred sheet mesh (world-snapped, so it never swims) draped on the sand: height
// = the rendered base terrain + the sheet thickness at this point, shaded with the water graph
// (A7): transparent over the sand, refraction, a thin shore fade, the foam front.

import { uploadFloatRGBA } from '../../core/upload';
import { BufferAttribute, BufferGeometry, ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, Mesh, RGBAFormat, Sphere, Vector3, type Material } from 'three/webgpu';
import * as TSL from 'three/tsl';
import { SPLAT_FOAM, SPLAT_SMOOTH, SPLAT_WET, type GLContext, type SurfaceStateService, type TSLNode } from '../../core/contracts';
import type { WaterApi } from '../../water';
import { bspline } from '../../beach/height';
import { TERRAIN_BOUNDS, TERRAIN_TEXEL, shoreX } from '../../world/layout';
import { stageTimes } from './profile';
import { DATA_W, GLOBAL_ROW, REEF_SLOTS, ROWS, SLOTS, type Tracker } from './tracker';

const { Fn, abs, clamp, float, max, mix, mx_noise_float, normalize, positionGeometry, positionPrevious, pow, select, sin, smoothstep, texture, uniformArray, varyingProperty, vec2, vec3, vec4 } =
  TSL as unknown as Record<string, any>;

/** Along-shore samples: z from Z0 in steps of DZ. */
const Z0 = -260;
const DZ = 0.5;
const NS = 880;
const G = 9.81;

/** Sheet mesh: along-shore span (m) around the camera and its spacing; cross-shore samples. */
const SPAN = 120;
const DA = 0.4;
const NA = Math.round(SPAN / DA) + 1;
const NC = 96;
/** Cross-shore extent (m) relative to the still-water line, and its warp (denser near the waterline). */
const S_MIN = -2;
const S_MAX = 14;

export interface SwashParams {
  runup: number;
  foam: number;
}

export interface Swash {
  mesh: Mesh;
  warmup(ctx: GLContext, water: WaterApi | undefined): void;
  update(ctx: GLContext, P: SwashParams): void;
  dispose(ctx: GLContext): void;
}

export function createSwash(ctx: GLContext, tracker: Tracker): Swash {
  const rays = tracker.shore;
  const terrain = ctx.services.terrain;
  // Per sample: still-water line offset (m, from shoreX) and local beach slope (dh/dd).
  const shoreD = new Float32Array(NS);
  const slope = new Float32Array(NS);
  for (let k = 0; k < NS; k++) {
    const z = Z0 + k * DZ;
    const x0 = shoreX(z);
    let lo = -15;
    let hi = 15;
    for (let it = 0; it < 30; it++) {
      const mid = 0.5 * (lo + hi);
      if (terrain.height(x0 + mid, z) < 0) lo = mid;
      else hi = mid;
    }
    shoreD[k] = 0.5 * (lo + hi);
    slope[k] = Math.max(0.03, (terrain.height(x0 + shoreD[k] + 4, z) - terrain.height(x0 + shoreD[k] - 1, z)) / 5);
  }
  // Swash state per sample: launch time, launch position (m up-slope), speed, sheet depth, then
  // derived front, depth, foam and drain written to the texture each frame.
  const t0 = new Float64Array(NS).fill(-1e9);
  const x0s = new Float32Array(NS);
  const u0s = new Float32Array(NS);
  const h0s = new Float32Array(NS);
  const xf = new Float32Array(NS).fill(-3);
  const lastN = new Int32Array(rays.nr).fill(-99999);
  const splatAcc = new Float32Array(NS);
  // GPU texture: row 0 dynamic (front x, sheet depth, foam, drain), row 1 static (shoreD, slope).
  const data = new Float32Array(NS * 2 * 4);
  for (let k = 0; k < NS; k++) {
    const o = (NS + k) * 4;
    data[o] = shoreD[k];
    data[o + 1] = slope[k];
    data[k * 4] = -3;
  }
  const tex = new DataTexture(data, NS, 2, RGBAFormat, FloatType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  // Camera window origin (snapped to the sheet's spacing) and time, unboxed.
  const gv = [0.5, 0.5, 0.5, 0.5];
  const gu = uniformArray(gv, 'float');
  const uZc = gu.element(0);
  const uTime = gu.element(1);

  const rng = new Uint32Array([0x2545f491]);
  const tPl = stageTimes(0.75);

  // ── geometry: NA along × NC across, (a index, c index) in position.xy ──
  const pos = new Float32Array(NA * NC * 3);
  for (let a = 0; a < NA; a++)
    for (let c = 0; c < NC; c++) {
      const q = (a * NC + c) * 3;
      pos[q] = a;
      pos[q + 1] = c;
    }
  const idx = new Uint32Array((NA - 1) * (NC - 1) * 6);
  let n = 0;
  for (let a = 0; a < NA - 1; a++)
    for (let c = 0; c < NC - 1; c++) {
      const i0 = a * NC + c;
      const i1 = i0 + NC;
      idx[n++] = i0;
      idx[n++] = i1;
      idx[n++] = i0 + 1;
      idx[n++] = i0 + 1;
      idx[n++] = i1;
      idx[n++] = i1 + 1;
    }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  const nrm = new Float32Array(NA * NC * 3);
  for (let i = 0; i < NA * NC; i++) nrm[i * 3 + 1] = 1;
  geo.setAttribute('normal', new BufferAttribute(nrm, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  geo.boundingSphere = new Sphere(new Vector3(), 1e6);

  // Terrain height (C2 B-spline of the 1 m bake, so the thin sheet never creases).
  const [bx0, bz0, bx1, bz1] = TERRAIN_BOUNDS;
  const tw = Math.round((bx1 - bx0) / TERRAIN_TEXEL);
  const th = Math.round((bz1 - bz0) / TERRAIN_TEXEL);
  const hAt = (xz: TSLNode) => bspline(terrain.heightTexture, xz.sub(vec2(bx0, bz0)).div(vec2(bx1 - bx0, bz1 - bz0)), tw, th).x;
  const shoreXGPU = (z: TSLNode) => sin(z.div(85)).mul(4).add(sin(z.div(31).add(1.3)).mul(2));

  const vRest = varyingProperty('vec2', 'vSwRest');
  const vDepth = varyingProperty('float', 'vSwDepth');
  const vN = varyingProperty('vec3', 'vSwN');
  const vFoam = varyingProperty('vec2', 'vSwFoam');
  const positionNode = Fn(() => {
    const P = positionGeometry;
    const z = uZc.add(P.x.mul(DA)).sub(SPAN / 2).toVar();
    const k = z.sub(Z0).div(DZ);
    const tu = k.add(0.5).div(NS);
    const dyn = texture(tex, vec2(tu, 0.25)).level(0).toVar();
    const st = texture(tex, vec2(tu, 0.75)).level(0).toVar();
    // Cross-shore: denser near the waterline and the front zone.
    const c = P.y.div(NC - 1);
    const s = mix(float(S_MIN), float(S_MAX), pow(c, 1.35)).toVar();
    const x = shoreXGPU(z).add(st.x).add(s).toVar();
    const xz = vec2(x, z);
    // The front is lobed and fingered along the shore, more so as it slows.
    const lob = mx_noise_float(vec3(z.div(2.6), uTime.mul(0.08), 1.7)).mul(0.45).add(mx_noise_float(vec3(z.div(0.9), uTime.mul(0.15), 4.1)).mul(0.18));
    const front = dyn.x.add(lob.mul(smoothstep(0.5, 3, dyn.x))).toVar();
    // Sheet depth: thickest at the bore behind the front, a thin rounded edge at the front.
    const rel = clamp(s.div(max(front, 0.1)), -1, 2);
    const wedge = pow(clamp(float(1).sub(rel), 0, 1), 0.55);
    const rim = smoothstep(0, 0.25, front.sub(s)).mul(0.012);
    const depth = select(s.lessThan(front), dyn.y.mul(wedge).add(rim).add(0.002), float(-0.03)).toVar();
    // Streaks along the flow: thickness varies where the sheet thins.
    const streak = mx_noise_float(vec3(z.div(0.55), s.div(3.5), uTime.mul(0.05))).mul(0.25).add(1);
    const dep = max(depth.mul(streak), -0.03).toVar();
    const hb = hAt(xz).toVar();
    // Below the still-water line the sheet tucks under the ocean surface.
    const y = hb.add(dep).sub(float(1).sub(smoothstep(-1.5, 0, s)).mul(0.25)).toVar();
    const e = float(0.35);
    const hx = hAt(xz.add(vec2(e, 0)));
    const hz = hAt(xz.add(vec2(0, e)));
    // A water film is flatter than the sand under it: level the normal a little.
    const n0 = normalize(vec3(hb.sub(hx).div(e).mul(0.7), 1, hb.sub(hz).div(e).mul(0.7)));
    vN.assign(n0);
    vRest.assign(xz);
    vDepth.assign(max(dep, 0.001));
    // Bubble line just behind the front edge (fresh, dense), fine lace behind it (older, thin),
    // a scatter of specks over the whole sheet; the backwash ages it all toward filaments.
    const behind = front.sub(s);
    const line = float(1).sub(smoothstep(0.1, 0.45, abs(behind.sub(0.2))));
    const lace = float(1).sub(smoothstep(0.4, 4, behind));
    const cov = dyn.z.mul(line.mul(0.9).add(lace.mul(0.38)).add(0.1)).mul(smoothstep(-0.05, 0.05, behind));
    const age = float(0.12).add(smoothstep(0.15, 2.5, behind).mul(0.55)).add(dyn.w.mul(0.3));
    vFoam.assign(vec2(clamp(cov, 0, 1), clamp(age, 0, 1)));
    const p = vec3(x, y, z);
    positionPrevious.assign(p);
    return p;
  })();

  const mesh = new Mesh(geo);
  mesh.name = 'ocean.swash';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  // Scratch for doubles crossing calls: [z of the trigger, bore height, time, run-up ×, random].
  const TF = new Float64Array(5);
  /** Launch an uprush around along-shore z = TF[0] for a bore of height TF[1] at time TF[2]. */
  const triggerAt = () => {
    const zc = TF[0];
    const t = TF[2];
    const runup = TF[3];
    const kc = Math.round((zc - Z0) / DZ);
    // The bore's depth at the waterline and its run-up speed.
    const hb0 = 0.45 * TF[1];
    const hb = hb0 > 0.08 ? hb0 : 0.08;
    for (let dk = -3; dk <= 3; dk++) {
      const k = kc + dk;
      if (k < 0 || k >= NS) continue;
      rng[0] = Math.imul(rng[0] ^ (rng[0] >>> 15), 0x2c1b3c6d) + 0x6d2b79f5;
      const r1 = (rng[0] >>> 8) / 16777216;
      rng[0] = Math.imul(rng[0] ^ (rng[0] >>> 15), 0x2c1b3c6d) + 0x6d2b79f5;
      const r2 = (rng[0] >>> 8) / 16777216;
      const u0 = runup * 2.2 * Math.sqrt(G * hb) * (0.88 + 0.24 * r1) * (1 - Math.abs(dk) * 0.03);
      // Only if it would overtake the current swash at this point.
      const tau = t - t0[k];
      const aNow = G * slope[k] * 1.1;
      const cur = x0s[k] + u0s[k] * tau - 0.5 * aNow * tau * tau;
      if (tau < 1.2 && cur > 0.5) continue;
      t0[k] = t - r2 * 0.08;
      const xa = xf[k] < 1 ? xf[k] : 1;
      x0s[k] = xa > -0.5 ? xa : -0.5;
      u0s[k] = u0;
      const h0 = 0.08 + 0.18 * hb;
      h0s[k] = h0 < 0.22 ? h0 : 0.22;
    }
  };

  return {
    mesh,
    warmup(_c, water) {
      if (!water) return;
      const mat = water.createMaterial({
        rest: vRest,
        depth: vDepth,
        broken: float(1),
        thickness: vec4(vDepth.add(0.05), float(0), 1, 0),
        chord: float(1e3),
        baseNormal: vN,
        foam: vFoam,
        // Swash lace is centimetres across, not the open water's metres.
        foamScale: float(3.4),
      });
      mat.positionNode = positionNode;
      mesh.material = mat;
      mesh.renderOrder = water.renderOrder;
    },
    update(c, P) {
      const t = c.time.t;
      const dt = c.time.dt;
      gv[0] = Math.round((c.camera.position.z) / DA) * DA;
      gv[1] = t;
      // Launch uprushes where a shore-break bore reaches the waterline.
      const d = tracker.data;
      for (let s = REEF_SLOTS; s < SLOTS; s++) {
        const gh = (GLOBAL_ROW * DATA_W + s) * 4;
        if (d[gh + 3] < 0.5) continue;
        const nC = d[gh + 2] | 0;
        const r0 = d[gh] | 0;
        const r1 = d[gh + 1] | 0;
        for (let r = r0; r <= r1; r++) {
          const o0 = ((s * ROWS) * DATA_W + r) * 4;
          const o1 = ((s * ROWS + 1) * DATA_W + r) * 4;
          const o2 = ((s * ROWS + 2) * DATA_W + r) * 4;
          if (d[o0 + 2] < 0.05 || d[o1 + 2] < tPl.imp + 1) continue;
          if (lastN[r] === nC) continue;
          // At the ray's end (the beach face)?
          const oe = r * rays.nm + rays.mEnd[r];
          const ex = rays.px[oe] - d[o0];
          const ez = rays.pz[oe] - d[o0 + 1];
          if (ex * ex + ez * ez > 3.5 * 3.5) continue;
          lastN[r] = nC;
          TF[0] = rays.pz[oe];
          TF[1] = d[o0 + 3];
          TF[2] = t;
          TF[3] = P.runup;
          triggerAt();
        }
      }
      // Advance the fronts and write the texture; splat along the fronts.
      const state = c.services.state;
      const sd = state.splatData;
      for (let k = 0; k < NS; k++) {
        const tau = t - t0[k];
        const a = G * slope[k] * 1.1;
        const tUp = u0s[k] / Math.max(a, 1e-3);
        let x: number;
        let depth: number;
        let foam: number;
        let drain: number;
        if (tau < 0 || u0s[k] <= 0) {
          x = -3;
          depth = 0;
          foam = 0;
          drain = 1;
        } else if (tau <= tUp) {
          x = x0s[k] + u0s[k] * tau - 0.5 * a * tau * tau;
          depth = h0s[k] * Math.exp(-tau / 2.2);
          foam = 1 - 0.35 * (tau / tUp);
          drain = 0;
        } else {
          // Backwash: drains more slowly than it came up (friction, infiltration), thinning.
          const xm = x0s[k] + 0.5 * u0s[k] * tUp;
          const tb = tau - tUp;
          x = xm - 0.5 * a * 0.4 * tb * tb;
          depth = h0s[k] * Math.exp(-tau / 2.2) * Math.exp(-tb / 1.4) + 0.004 * Math.exp(-tb / 5);
          foam = 0.65 * Math.exp(-tb / 2.5);
          drain = Math.min(1, tb / 3);
          if (x < -2.5) {
            x = -2.5;
            u0s[k] = 0;
          }
        }
        xf[k] = x;
        const o = k * 4;
        data[o] = x;
        data[o + 1] = depth;
        data[o + 2] = foam * P.foam;
        data[o + 3] = drain;
        // State: wet film + smoothing over the reach of the uprush, foam on the front.
        if (dt > 0 && drain < 1 && x > 0 && (k & 3) === 0 && ((k >> 2) & 3) === (c.time.frame & 3)) {
          splatAcc[k] += dt * 4;
          const off = state.reserve ? state.reserve(3) : -1;
          if (off >= 0 && sd) {
            const z = Z0 + k * DZ;
            const xw = 4 * Math.sin(z / 85) + 2 * Math.sin(z / 31 + 1.3) + shoreD[k] + x;
            const acc = splatAcc[k];
            splatAcc[k] = 0;
            sd[off] = SPLAT_WET;
            sd[off + 1] = xw - 0.4;
            sd[off + 2] = z;
            sd[off + 3] = 1.1;
            sd[off + 4] = drain < 0.3 ? 1 : 0.9;
            sd[off + 5] = 1;
            sd[off + 6] = 0;
            sd[off + 7] = 1;
            sd[off + 8] = SPLAT_SMOOTH;
            sd[off + 9] = xw - 0.3;
            sd[off + 10] = z;
            sd[off + 11] = 1.0;
            sd[off + 12] = 1 - Math.exp(-6 * acc);
            sd[off + 13] = 1;
            sd[off + 14] = 0;
            sd[off + 15] = 1;
            sd[off + 16] = SPLAT_FOAM;
            sd[off + 17] = xw;
            sd[off + 18] = z;
            sd[off + 19] = 0.45;
            sd[off + 20] = 0.3 * (1 - Math.exp(-2 * acc)) * foam * P.foam;
            sd[off + 21] = 1;
            sd[off + 22] = 0;
            sd[off + 23] = 1;
          }
        }
      }
      uploadFloatRGBA(c.renderer, tex); // [polish] no version bump (core/upload.ts)
      mesh.visible = Math.abs(c.camera.position.x) < 260;
    },
    dispose(c) {
      c.scene.remove(mesh);
      geo.dispose();
      (mesh.material as Material).dispose?.();
      tex.dispose();
    },
  };
}

