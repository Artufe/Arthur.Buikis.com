// GOLDENLINE shared spray: one pooled GPU particle system for everything wet that flies.
// Owner: A8. Used by the breaking waves (lip spray, impact explosions, whitewater smoke, mist,
// offshore spray veils), and designed for B1 (rail spray fans, tube droplets) and A4 (piling
// bursts, same `burst()` signature as pier/spray.ts). See ocean/breaking/README.md.
//
// A fixed ring of CAP particles in storage buffers, simulated by one compute dispatch per frame.
// Emitters are queued on the CPU into a small storage buffer (zero allocations: typed arrays) and
// claim consecutive ranges of the ring; each particle in this frame's claimed range finds its
// emitter by binary search and spawns. Rendered as one instanced sprite draw: velocity-stretched
// soft billboards lit by the low sun with a per-kind scattering phase, so spray glows when
// backlit. Sprites write their own screen velocity (TRAA / motion blur).

import { CustomBlending, OneFactor, OneMinusSrcAlphaFactor, Sprite, SpriteNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { AtmosphereService, TSLNode } from '../../core/contracts';
import { bakeSprayAtlas, SPRAY_ATLAS } from './texture';

const {
  Fn, If, attributeArray, atan, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, clamp, exp, float, hash, instanceIndex, instancedArray, int, length, max,
  min, mix, mrt, normalize, pow, select, smoothstep, sqrt, texture, uint, uniform, uniformArray, uv, vec2, vec3, vec4, sin, cos, floor,
} = TSL as unknown as Record<string, any>;

/** Particle kinds. */
export const SPRAY_DROPLET = 0;
export const SPRAY_MIST = 1;
/** Aerated whitewater clumps: the explosion and the smoke over a rolling bore. */
export const SPRAY_FOAM = 2;
/** Wind-blown lip spray: thin streaks peeling off a crest downwind. */
export const SPRAY_VEIL = 3;
export type SprayKind = 0 | 1 | 2 | 3;

export const SPRAY_CAP = 32768;
const MAX_EMIT = 256;
/** Floats per queued emitter (4 × vec4). */
const EMIT_STRIDE = 16;

export interface SprayService {
  /**
   * Queue particles this frame. (x, y, z) origin, (vx, vy, vz) mean velocity (m/s), `spread`
   * (m/s) random velocity, `radius` (m) origin jitter, `size` (m) particle radius at birth (0 =
   * the kind's default), `life` (s, 0 = default), `waterY` the water height below (particles that
   * fall back through it die). Zero-alloc; drops the emitter when the queue is full.
   */
  emit(kind: SprayKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, count: number, spread: number, radius: number, size: number, life: number, waterY: number): void;
  /**
   * Bulk path for heavy emitters (zero-alloc regardless of inlining: V8 boxes double arguments
   * at call sites it doesn't inline). Reserve an emitter of `count` particles of `kind` (both
   * integers); returns the float offset `o` into `emitData`, or -1 when the queue is full. Then
   * write: [o] x, [o+1] y, [o+2] z, [o+4] vx, [o+5] vy, [o+6] vz, [o+8] spread, [o+9] radius,
   * [o+11] size (preset to the kind's default), [o+12] life (default), [o+13] water y.
   */
  reserve(kind: SprayKind, count: number): number;
  emitData: Float32Array;
  /** A4-compatible burst: a mix of droplets, foam clumps and (`mist` share) mist. */
  burst(x: number, y: number, z: number, vx: number, vy: number, vz: number, count: number, spread: number, radius: number, mist: number): void;
  /** Wind the mist and veils drift with (m/s, world XZ). Write the fields; no allocation. */
  wind: { x: number; z: number };
  /** Simulate one step (the owner, ocean/breaking, calls it once per frame; others just emit). */
  step(renderer: WebGPURenderer, clock: { dt: number }): void;
  sprite: Sprite;
  /** Debug counters: [particles spawned, emitters] since boot. */
  stats: Float64Array;
  dispose(): void;
}

function hg(cosT: TSLNode, g: TSLNode) {
  const g2 = g.mul(g);
  return float(1).sub(g2).div(float(4 * Math.PI).mul(pow(max(float(1).add(g2).sub(cosT.mul(g).mul(2)), 1e-4), 1.5)));
}

export function createSpray(atmos: AtmosphereService): SprayService {
  const pos = instancedArray(SPRAY_CAP, 'vec4'); // xyz, age
  const vel = instancedArray(SPRAY_CAP, 'vec4'); // xyz, life (≤ 0: dead)
  const meta = instancedArray(SPRAY_CAP, 'vec4'); // kind, size at birth, water y, seed
  const queue = attributeArray(MAX_EMIT * 4, 'vec4');
  const qAttr = queue.value as unknown as { array: Float32Array; needsUpdate: boolean };
  const Q = qAttr.array;
  // [ring cursor at the start of this frame's claims, claimed count, emitter count, frame]
  const iv = new Int32Array(4);
  const uCursor = uniform(0, 'int');
  const uClaimed = uniform(0, 'int');
  const uEmit = uniform(0, 'int');
  const uFrame = uniform(0, 'int');
  // dt, wind x, wind z: a double-elements JS array behind a uniform array, so per-frame writes
  // store unboxed (a number uniform's .value would allocate a HeapNumber every frame).
  const fv = [0.5, 0.5, 0.5, 0.5];
  const fu = uniformArray(fv, 'float');
  const uDt = fu.element(0);
  const uWindX = fu.element(1);
  const uWindZ = fu.element(2);
  const wind = { x: -4.3, z: -1.3 };
  const stats = new Float64Array(2);

  const rnd = (k: number) => hash(instanceIndex.add(uint(k * 7919)).add(uint(uFrame).mul(uint(104729))));

  const simulate = Fn(() => {
    const p = pos.element(instanceIndex);
    const v = vel.element(instanceIndex);
    const m = meta.element(instanceIndex);
    const rel = int(instanceIndex).sub(uCursor).add(SPRAY_CAP).mod(SPRAY_CAP).toVar();
    If(rel.lessThan(uClaimed), () => {
      // Binary search for the emitter whose range holds `rel` (starts are ascending).
      const lo = int(0).toVar();
      const hi = uEmit.toVar();
      for (let it = 0; it < 9; it++) {
        const mid = lo.add(hi).div(2);
        const st = queue.element(mid.mul(4)).w;
        If(hi.sub(lo).greaterThan(1), () => {
          If(st.lessThanEqual(float(rel)), () => {
            lo.assign(mid);
          }).Else(() => {
            hi.assign(mid);
          });
        });
      }
      const a = queue.element(lo.mul(4));
      const b = queue.element(lo.mul(4).add(1));
      const c = queue.element(lo.mul(4).add(2));
      const d = queue.element(lo.mul(4).add(3));
      const kind = c.z;
      const r1 = rnd(1);
      const r2 = rnd(2);
      const r3 = rnd(3);
      const r4 = rnd(4);
      const r5 = rnd(5);
      const r6 = rnd(6);
      // Origin: uniform in a ball of radius c.y (flattened a little).
      const th = r1.mul(6.28318);
      const cz = r2.mul(2).sub(1);
      const sz = sqrt(max(float(1).sub(cz.mul(cz)), 0));
      const rad = c.y.mul(pow(r3, 0.333));
      const off = vec3(cos(th).mul(sz), cz.mul(0.55), sin(th).mul(sz)).mul(rad);
      p.assign(vec4(a.xyz.add(off), 0));
      // Velocity: mean + isotropic spread (droplets get a heavier tail).
      const th2 = r4.mul(6.28318);
      const cz2 = r5.mul(2).sub(1);
      const sz2 = sqrt(max(float(1).sub(cz2.mul(cz2)), 0));
      const mag = c.x.mul(select(kind.lessThan(0.5), pow(r6, 0.6), r6.mul(0.7).add(0.3)));
      const jit = vec3(cos(th2).mul(sz2), cz2, sin(th2).mul(sz2)).mul(mag);
      // Per-particle speed variation along the mean (fans, clumps at different ranges).
      const k = rnd(7).mul(0.6).add(0.7);
      const life0 = d.x.mul(rnd(8).mul(0.6).add(0.7));
      v.assign(vec4(b.xyz.mul(k).add(jit), life0));
      const size0 = c.w.mul(rnd(9).mul(0.8).add(0.6));
      m.assign(vec4(kind, size0, d.y, rnd(10)));
    });
    If(v.w.greaterThan(0), () => {
      const kind = m.x;
      const isDrop = kind.lessThan(0.5);
      const isMist = kind.greaterThan(0.5).and(kind.lessThan(1.5));
      const isFoam = kind.greaterThan(1.5).and(kind.lessThan(2.5));
      // Drag toward the wind (air speed), gravity (mist is slightly buoyant, veils lofted).
      const drag = select(isDrop, float(0.35), select(isMist, float(1.6), select(isFoam, float(1.1), float(2.2))));
      const grav = select(isDrop, float(-9.81), select(isMist, float(0.25), select(isFoam, float(-7.5), float(-1.2))));
      const air = vec3(uWindX, select(isMist, float(0.25), float(0)), uWindZ);
      const nv = v.xyz.add(air.sub(v.xyz).mul(float(1).sub(exp(drag.negate().mul(uDt))))).add(vec3(0, grav.mul(uDt), 0)).toVar();
      const np = p.xyz.add(nv.mul(uDt));
      const age = p.w.add(uDt);
      // Falling back through the water kills droplets and clumps; mist and veils just fade.
      const sank = np.y.lessThan(m.z.sub(0.15)).and(nv.y.lessThan(0)).and(isDrop.or(isFoam));
      const dead = age.greaterThan(v.w).or(sank).or(np.y.lessThan(m.z.sub(3)));
      p.assign(vec4(np, age));
      v.assign(vec4(nv, select(dead, float(0), v.w)));
    });
  });
  const computeNode = simulate().compute(SPRAY_CAP);

  // ── render: one instanced sprite draw ──
  const atlas = bakeSprayAtlas();
  const mat = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  mat.name = 'spray';
  const pa = pos.toAttribute();
  const va = vel.toAttribute();
  const ma = meta.toAttribute();
  const kind = ma.x;
  const isDrop = kind.lessThan(0.5);
  const isMist = kind.greaterThan(0.5).and(kind.lessThan(1.5));
  const isFoam = kind.greaterThan(1.5).and(kind.lessThan(2.5));
  const isVeil = kind.greaterThan(2.5);
  const life = va.w;
  const alive = life.greaterThan(0);
  const tAge = clamp(pa.w.div(max(life, 1e-3)), 0, 1);
  // Mist and clumps grow as they spread; veils stretch.
  const grow = select(isMist, tAge.mul(2.2).add(1), select(isFoam, tAge.mul(1.1).add(0.75), select(isVeil, tAge.mul(1.5).add(1), float(1))));
  const dist = length(pa.xyz.sub(cameraPosition));
  // Keep tiny droplets ≥ ~1.4 px (they'd shimmer in and out), conserving their energy.
  const px = dist.mul(0.0012);
  // Far away, clumps and mist merge into one glowing mass instead of a row of dots: they grow
  // with distance and thin out to keep the same coverage.
  const farK = select(isFoam.or(isMist), float(1).add(dist.div(70)), float(1));
  const r0 = ma.y.mul(grow).mul(farK);
  const r = select(isDrop, max(r0, px), r0);
  const cover = select(isDrop, pow(r0.div(max(r0, px)), 2), float(1));
  // Velocity-stretched along the screen-projected motion (droplets and veils streak).
  const vView = cameraViewMatrix.mul(vec4(va.xyz, 0)).xyz;
  const vs = vec2(vView.x, vView.y);
  const speed = length(vs);
  // Streak length = screen speed × an effective exposure (droplets short, veils long and wispy).
  const streak = speed.mul(select(isVeil, float(0.35), float(0.028)));
  const stretch = select(isDrop.or(isVeil), clamp(streak.div(max(r.mul(2), 1e-3)).add(1), 1, 7), float(1));
  mat.positionNode = pa.xyz;
  // Streaks follow their screen motion; puffs keep a near-upright random tilt (their baked
  // self-shading is lit from above).
  const seed = ma.w;
  mat.rotationNode = select(isDrop.or(isVeil), atan(vs.y, vs.x.add(1e-5)), seed.sub(0.5).mul(select(isFoam, float(0.8), float(6.28))));
  mat.scaleNode = select(alive, vec2(r.mul(2).mul(stretch), r.mul(2)), vec2(0, 0));
  mat.sizeAttenuation = true;
  // Screen motion for TRAA / motion blur (sprites have no usable positionPrevious).
  const vp = cameraProjectionMatrix.mul(cameraViewMatrix);
  const cur = vp.mul(vec4(pa.xyz, 1));
  const prv = vp.mul(vec4(pa.xyz.sub(va.xyz.mul(1 / 60)), 1));
  mat.mrtNode = mrt({ velocity: cur.xy.div(cur.w).sub(prv.xy.div(prv.w)) });
  mat.alphaTest = 0.003;

  // Puff atlas: density, self-shading from above, thin edges.
  const vIdx = floor(seed.mul(SPRAY_ATLAS * SPRAY_ATLAS * 0.999));
  const cell = vec2(vIdx.mod(SPRAY_ATLAS), floor(vIdx.div(SPRAY_ATLAS)));
  const tuv = cell.add(vec2(uv().x, float(1).sub(uv().y))).div(SPRAY_ATLAS);
  const puff = texture(atlas, tuv);
  // Lighting: the low sun scattered by each kind (droplets and mist forward-peaked, clumps a
  // multiple-scattering white mass with bright tops and glowing thin edges), plus the sky.
  const V = normalize(pa.xyz.sub(cameraPosition));
  const cosT = V.dot(atmos.sunDirNode);
  const sun = vec3(atmos.sunColorNode);
  const skyUp = vec3(atmos.skyRadiance(vec3(0, 1, 0)));
  const skyH = vec3(atmos.skyRadiance(normalize(vec3(atmos.sunDirNode.x, 0.25, atmos.sunDirNode.z))));
  const sky = skyUp.add(skyH).mul(0.5);
  const single = sun.mul(hg(cosT, select(isDrop, float(0.8), float(0.84))).mul(1.6)).add(sky.mul(0.35));
  const shade = puff.g;
  const clump = sun
    .mul(shade.mul(0.3).add(0.06))
    .add(sun.mul(hg(cosT, float(0.62))).mul(puff.b.mul(1.3).add(0.22)))
    .add(sky.mul(shade.mul(0.7).add(0.85))) // [look] sky fill: clumps are white, not tan cut-outs
    .mul(0.92);
  const light = select(isFoam, clump, single);
  const q = uv().sub(0.5).mul(2);
  const r2 = q.dot(q);
  // [look] Mist fades well inside its quad (its big sprites showed their rim as a disc).
  const disc = select(isMist, puff.r.mul(exp(r2.mul(-2.6))), select(isFoam, puff.r, select(isVeil, exp(r2.mul(-2.4)), float(1).sub(smoothstep(0.25, 1, r2)))));
  const fadeIn = smoothstep(0, select(isMist, float(0.18), float(0.05)), tAge);
  const fadeOut = float(1).sub(smoothstep(select(isFoam, float(0.45), float(0.55)), 1, tAge));
  // Hide the hard line where a big soft sprite meets the water it came from.
  const waterFade = select(isMist.or(isVeil).or(isFoam), smoothstep(0, r.mul(0.8), pa.y.sub(ma.z)), float(1));
  // Particles right at the lens would be white sticks or dark blobs clipped by the near plane:
  // fade them within a couple of their own radii.
  // [look] …and always gone within ~1 m of the lens (B1: fans and tube drips pass close to it).
  const nearFade = smoothstep(r.mul(1.5).add(0.15), r.mul(4).add(0.6), dist).mul(smoothstep(0.45, 1.2, dist));
  const opacity = select(isDrop, float(0.55).mul(cover), select(isMist, float(0.09), select(isFoam, float(0.24), float(0.11)))).div(pow(farK, 1.6));
  // Premultiplied by hand with a separate extinction: mist and veils scatter most of what they
  // intercept forward, so they barely dim what's behind them (a mist puff in front of the bright
  // aureole must never read as a dark disc); droplets and clumps occlude.
  const a = disc.mul(fadeIn).mul(fadeOut).mul(waterFade).mul(opacity).mul(nearFade).mul(select(alive, float(1), float(0))).toVar();
  const ext = select(isMist, float(0.3), select(isVeil, float(0.4), select(isFoam, float(0.85), float(0.9))));
  mat.colorNode = vec4(light.mul(a), 1);
  mat.opacityNode = a.mul(ext);
  mat.blending = CustomBlending;
  mat.blendSrc = OneFactor;
  mat.blendDst = OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = OneFactor;
  mat.blendDstAlpha = OneMinusSrcAlphaFactor;
  void min;
  void mix;

  const sprite = new Sprite(mat);
  sprite.count = SPRAY_CAP;
  sprite.frustumCulled = false;
  sprite.renderOrder = 6;
  sprite.name = 'vfx.spray';

  // Idle detection: once nothing has been emitted for longer than any life, skip the dispatch.
  const idle = new Float64Array([1e9]);

  const svc: SprayService = {
    sprite,
    wind,
    stats,
    emit(kind, x, y, z, vx, vy, vz, count, spread, radius, size, life, waterY) {
      const e = iv[2];
      if (e >= MAX_EMIT || !(count >= 1)) return;
      const n = Math.min(4096, Math.floor(count));
      if (iv[1] + n > SPRAY_CAP) return;
      const o = e * EMIT_STRIDE;
      Q[o] = x;
      Q[o + 1] = y;
      Q[o + 2] = z;
      Q[o + 3] = iv[1];
      Q[o + 4] = vx;
      Q[o + 5] = vy;
      Q[o + 6] = vz;
      Q[o + 7] = n;
      Q[o + 8] = spread;
      Q[o + 9] = radius;
      Q[o + 10] = kind;
      Q[o + 11] = size > 0 ? size : kind === SPRAY_DROPLET ? 0.012 : kind === SPRAY_MIST ? 0.55 : kind === SPRAY_FOAM ? 0.35 : 0.45;
      Q[o + 12] = life > 0 ? life : kind === SPRAY_DROPLET ? 1.1 : kind === SPRAY_MIST ? 3.2 : kind === SPRAY_FOAM ? 1.3 : 2.4;
      Q[o + 13] = waterY;
      iv[1] += n;
      iv[2] = e + 1;
    },
    emitData: Q,
    reserve(kind, count) {
      const e = iv[2];
      if (e >= MAX_EMIT || count < 1) return -1;
      const n = count > 4096 ? 4096 : count | 0;
      if (iv[1] + n > SPRAY_CAP) return -1;
      const o = e * EMIT_STRIDE;
      Q[o + 3] = iv[1];
      Q[o + 7] = n;
      Q[o + 10] = kind;
      Q[o + 11] = kind === SPRAY_DROPLET ? 0.012 : kind === SPRAY_MIST ? 0.55 : kind === SPRAY_FOAM ? 0.35 : 0.45;
      Q[o + 12] = kind === SPRAY_DROPLET ? 1.1 : kind === SPRAY_MIST ? 3.2 : kind === SPRAY_FOAM ? 1.3 : 2.4;
      Q[o + 8] = 0;
      Q[o + 9] = 0;
      Q[o + 13] = -1e3;
      iv[1] += n;
      iv[2] = e + 1;
      return o;
    },
    burst(x, y, z, vx, vy, vz, count, spread, radius, mist) {
      const m = Math.min(1, Math.max(0, mist));
      svc.emit(SPRAY_DROPLET, x, y, z, vx, vy, vz, count * 0.5 * (1 - m * 0.5), spread, radius, 0, 0, y - 0.1);
      svc.emit(SPRAY_FOAM, x, y, z, vx * 0.7, vy * 0.7, vz * 0.7, count * 0.12, spread * 0.6, radius, 0.18, 0.9, y - 0.1);
      svc.emit(SPRAY_MIST, x, y, z, vx * 0.4, vy * 0.4, vz * 0.4, 2 + count * 0.06 * m, spread * 0.3, radius, 0, 0, y - 0.1);
    },
    step(renderer, clock) {
      const dt = clock.dt;
      idle[0] = iv[2] > 0 ? 0 : idle[0] + dt;
      sprite.visible = idle[0] < 5;
      if (!sprite.visible) {
        iv[1] = 0;
        iv[2] = 0;
        return;
      }
      fv[0] = dt;
      fv[1] = wind.x;
      fv[2] = wind.z;
      uCursor.value = iv[0];
      uClaimed.value = iv[1];
      uEmit.value = iv[2];
      uFrame.value = iv[3];
      if (iv[2] > 0) qAttr.needsUpdate = true;
      renderer.compute(computeNode);
      stats[0] += iv[1];
      stats[1] += iv[2];
      iv[0] = (iv[0] + iv[1]) % SPRAY_CAP;
      iv[1] = 0;
      iv[2] = 0;
      iv[3] = (iv[3] + 1) & 0x3fffffff;
    },
    dispose() {
      mat.dispose();
      atlas.dispose();
      computeNode.dispose();
      for (const b of [pos, vel, meta, queue]) (b.value as unknown as { dispose?: () => void }).dispose?.();
    },
  };
  return svc;
}
