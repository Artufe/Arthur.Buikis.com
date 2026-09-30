// Pooled GPU spray: a fixed ring of particles simulated by one compute pass per frame and drawn
// as instanced, backlit sprites. Bursts are queued on the CPU into a fixed uniform array and
// claim a contiguous range of the ring, so emitting never allocates and never reads back.
//
// Two populations share the pool: droplets (small, fast, ballistic) and mist puffs (large,
// soft, dragged downwind). Both scatter the low sun forward, so spray glows when backlit.
// The API mirrors what vfx/spray will offer so the pier can switch to the shared system later.

import { Sprite, SpriteNodeMaterial, type Texture, type WebGPURenderer } from 'three/webgpu';
import {
  Fn,
  attributeArray,
  cameraProjectionMatrix,
  cameraViewMatrix,
  mrt,
  texture,
  vec2,
  If,
  cameraPosition,
  exp,
  float,
  hash,
  instanceIndex,
  instancedArray,
  max,
  mix,
  normalize,
  pow,
  smoothstep,
  uint,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { TSLNode } from '../core/contracts';

const CAP = 4096;
const MAX_BURSTS = 24;

export interface SprayPool {
  sprite: Sprite;
  /**
   * Queue a burst this frame. (x, y, z) origin, (vx, vy, vz) mean velocity, `spread` m/s of
   * random velocity, `radius` m of origin jitter, `mist` 0..1 share of mist puffs.
   */
  burst(x: number, y: number, z: number, vx: number, vy: number, vz: number, count: number, spread: number, radius: number, mist: number): void;
  /** Run the simulation step (call once per frame, after queueing bursts). */
  step(renderer: WebGPURenderer, dt: number, time: number): void;
  wind: { x: number; z: number };
  dispose(): void;
}

export function createSprayPool(sunDir: TSLNode, sunRadiance: TSLNode, sky: TSLNode, noise: Texture): SprayPool {
  const pos = instancedArray(CAP, 'vec4'); // xyz, age
  const vel = instancedArray(CAP, 'vec4'); // xyz, life (<= 0: dead)
  // Burst queue as a small storage buffer: uniform arrays only refresh at render time, but the
  // simulation may step several times per render (debug stepping), so upload on write instead.
  const bursts = attributeArray(MAX_BURSTS * 3, 'vec4');
  const burstAttr = bursts.value as unknown as { array: Float32Array; needsUpdate: boolean };
  const bArr = burstAttr.array;
  const burstCount = uniform(0, 'int');
  const dtU = uniform(0);
  const timeU = uniform(0);
  const windX = uniform(-3);
  const windZ = uniform(-1);

  const rand = (k: number) => hash(instanceIndex.add(uint(k * 7919)).add(uint(timeU.mul(977).toUint())));
  // Fixed population per slot (the renderer must agree): 15% mist, 40% foam chunks, 45% droplets.
  const popOf = (id: TSLNode) => hash(id.add(uint(1234567)));
  const MIST = 0.15;
  const CHUNK = 0.55;

  const simulate = Fn(() => {
    const p = pos.element(instanceIndex);
    const v = vel.element(instanceIndex);
    const pop = popOf(instanceIndex);
    const isMist = pop.lessThan(MIST);
    const isChunk = pop.lessThan(CHUNK).and(isMist.not());
    // Spawn: is this particle inside a burst's claimed range?
    for (let b = 0; b < MAX_BURSTS; b++) {
      If(burstCount.greaterThan(b), () => {
        const a: TSLNode = bursts.element(b * 3);
        const c: TSLNode = bursts.element(b * 3 + 1);
        const d: TSLNode = bursts.element(b * 3 + 2);
        const start = a.w.toInt();
        const rel = instanceIndex.toInt().sub(start).add(CAP).mod(CAP);
        If(rel.lessThan(c.w.toInt()), () => {
          const r1 = rand(1);
          const r2 = rand(2);
          const r3 = rand(3);
          const r4 = rand(4);
          const r5 = rand(5);
          const r6 = rand(6);
          const ang = r1.mul(6.28318);
          const rad = d.x.mul(r2.sqrt());
          p.assign(vec4(a.x.add(ang.cos().mul(rad)), a.y.add(r5.mul(0.2)), a.z.add(ang.sin().mul(rad)), 0));
          const spread = d.y;
          const jitter = vec3(r3.sub(0.5), r4.mul(0.9).add(0.1), r6.sub(0.5)).mul(spread).mul(vec3(2, 1, 2));
          // Chunks are the heavy core of the burst (slower, lower); mist lags and lingers.
          const k = isMist.select(float(0.45), isChunk.select(r4.mul(0.35).add(0.55), float(1)));
          const life = isMist.select(float(1.4).add(r2.mul(1.2)), isChunk.select(float(0.55).add(r4.mul(0.5)), float(0.7).add(r4.mul(0.9))));
          v.assign(vec4(vec3(c.x, c.y, c.z).add(jitter).mul(k), life));
        });
      });
    }
    If(v.w.greaterThan(0), () => {
      const drag = isMist.select(float(1.8), isChunk.select(float(0.7), float(0.25)));
      const grav = isMist.select(float(-0.8), float(-9.81));
      const wind = vec3(windX, 0.35, windZ);
      const nv = v.xyz.add(wind.sub(v.xyz).mul(float(1).sub(exp(drag.negate().mul(dtU))))).add(vec3(0, grav.mul(dtU), 0));
      const np = p.xyz.add(nv.mul(dtU));
      const age = p.w.add(dtU);
      const dead = age.greaterThan(v.w).or(np.y.lessThan(-2.5));
      p.assign(vec4(np, age));
      v.assign(vec4(nv, dead.select(float(0), v.w)));
    });
  });
  const computeNode = simulate().compute(CAP);

  // ── Render: instanced sprites, forward-scattering the sun. ──
  const mat = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const pa = pos.toAttribute();
  const va = vel.toAttribute();
  const id = instanceIndex;
  const pop = popOf(id);
  const isMistR = pop.lessThan(MIST);
  const isChunkR = pop.lessThan(CHUNK).and(isMistR.not());
  const life = va.w;
  const tAge = pa.w.div(max(life, 0.001)).clamp(0, 1);
  const alive = life.greaterThan(0);
  const h1 = hash(id.add(uint(77)));
  const base = isMistR.select(h1.mul(0.3).add(0.22), isChunkR.select(h1.mul(0.16).add(0.06), h1.mul(0.025).add(0.01)));
  const grow = isMistR.select(tAge.mul(1.6).add(1), isChunkR.select(tAge.mul(0.9).add(0.8), float(1)));
  // Keep droplets at least ~1.5 px so they never shimmer in and out; conserve their energy.
  const dist = pa.xyz.sub(cameraPosition).length();
  const px = dist.mul(0.0014);
  const size0 = base.mul(grow);
  const size = alive.select(max(size0, px), float(0));
  const cover = size0.div(max(size0, px)).pow(2);
  mat.positionNode = pa.xyz;
  // Sprites have no usable positionPrevious; write the particle's own screen motion instead
  // (and discard empty quad corners) so TRAA / motion blur don't smear the burst.
  const vp = cameraProjectionMatrix.mul(cameraViewMatrix);
  const cur = vp.mul(vec4(pa.xyz, 1));
  const prev = vp.mul(vec4(pa.xyz.sub(va.xyz.mul(1 / 60)), 1));
  mat.mrtNode = mrt({ velocity: cur.xy.div(cur.w).sub(prev.xy.div(prev.w)) });
  mat.alphaTest = 0.004;
  mat.scaleNode = size;
  const view = normalize(pa.xyz.sub(cameraPosition));
  const cosT = view.dot(sunDir);
  const g = 0.72;
  const hg = float((1 - g * g) / (4 * Math.PI)).div(pow(float(1 + g * g).sub(cosT.mul(2 * g)), 1.5));
  // Droplets and mist are single-scattering (strongly forward); foam chunks are multiple-
  // scattering (a broad, whiter lobe plus some forward glow).
  const scatter = isChunkR.select(hg.mul(0.9).add(0.12), hg.mul(2.0).add(0.04));
  const light = vec3(sunRadiance).mul(scatter).add(vec3(sky).mul(isChunkR.select(float(0.8), float(0.35))));
  const q = uv().sub(0.5).mul(2);
  const r2 = q.dot(q);
  // Foam chunks: a ragged, torn blob (noise-eroded disc), different for every particle.
  const nUV = uv().mul(0.42).add(vec2(h1.mul(3.1), hash(id.add(uint(55))).mul(7.7)));
  const rag = texture(noise, nUV).b.mul(0.6).add(texture(noise, nUV.mul(2.3)).a.mul(0.4));
  const chunkDisc = smoothstep(r2.mul(0.55).add(0.2), r2.mul(0.55).add(0.42), rag).mul(smoothstep(1, 0.6, r2));
  const disc = isMistR.select(exp(r2.mul(-3.5)), isChunkR.select(chunkDisc, smoothstep(1, 0.3, r2)));
  const fade = smoothstep(0, 0.06, tAge).mul(smoothstep(1, isChunkR.select(float(0.35), float(0.6)), tAge));
  const alpha = disc.mul(fade).mul(isMistR.select(float(0.07), isChunkR.select(float(0.55), float(0.8).mul(cover))));
  mat.colorNode = vec4(light, 1);
  mat.opacityNode = alpha;
  void mix;

  const sprite = new Sprite(mat);
  sprite.count = CAP;
  sprite.frustumCulled = false;
  sprite.renderOrder = 5;
  sprite.userData.pierSpray = { pos: pos.value, vel: vel.value };

  // [cursor, queued] and [seconds since the last burst] in typed arrays (no re-boxing on write).
  // Once every particle has died (max life < 3 s) the pass idles.
  const iv = new Int32Array(2);
  const fv = new Float64Array([1e9]);
  const wind = { x: -3, z: -1 };

  return {
    sprite,
    wind,
    burst(x, y, z, vx, vy, vz, count, spread, radius, mist) {
      if (iv[1] >= MAX_BURSTS) return;
      const n = Math.min(CAP >> 2, Math.max(1, Math.round(count)));
      const o = iv[1] * 12;
      bArr[o] = x;
      bArr[o + 1] = y;
      bArr[o + 2] = z;
      bArr[o + 3] = iv[0];
      bArr[o + 4] = vx;
      bArr[o + 5] = vy;
      bArr[o + 6] = vz;
      bArr[o + 7] = n;
      bArr[o + 8] = radius;
      bArr[o + 9] = spread;
      bArr[o + 10] = mist;
      iv[0] = (iv[0] + n) % CAP;
      iv[1]++;
    },
    step(renderer, dt, time) {
      fv[0] = iv[1] > 0 ? 0 : fv[0] + dt;
      sprite.visible = fv[0] <= 3.2;
      if (!sprite.visible) return;
      burstCount.value = iv[1];
      if (iv[1] > 0) burstAttr.needsUpdate = true;
      dtU.value = dt;
      timeU.value = time;
      windX.value = wind.x;
      windZ.value = wind.z;
      renderer.compute(computeNode);
      iv[1] = 0;
    },
    dispose() {
      mat.dispose();
      computeNode.dispose();
      (pos.value as unknown as { dispose?: () => void }).dispose?.();
      (vel.value as unknown as { dispose?: () => void }).dispose?.();
    },
  };
}
