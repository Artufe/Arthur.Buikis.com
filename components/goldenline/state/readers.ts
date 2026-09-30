// The TSL accessors other systems call: foam(), wake(), sand() (+ sandHeight()). Each blends the
// high-resolution near field into the wide far field with a soft edge fade, so a reader never
// sees the window boundary. Base texture nodes are shared; the system swaps their `.value`
// between the ping-pong pair each frame (three caches both bind groups, so this is free).

import { abs, clamp, float, max, mix, smoothstep, vec2, vec4, baseTex } from './tsl';
import type { StorageTexture } from 'three/webgpu';
import type { TSLNode } from '../core/contracts';
import type { Field } from './field';

export interface Readers {
  foam(xz: TSLNode): TSLNode;
  wake(xz: TSLNode): TSLNode;
  sand(xz: TSLNode): TSLNode;
  sandHeight(xz: TSLNode): TSLNode;
  /** Point every reader at the latest written texture of each pair. */
  select(parity: number): void;
}

/** 1 inside the window, fading to 0 over the outer 8% of each half-width. */
function fade(xz: TSLNode, f: Field, inner = 0.4, outer = 0.48) {
  const d = abs(xz.sub(f.uCenter)).mul(f.uView.w);
  return float(1).sub(smoothstep(inner, outer, max(d.x, d.y)));
}

/** `wetSrc`: where the surf zone has water on the sand right now (kernels.ts KernelDeps). */
export function createReaders(far: Field, near: Field, nearB: [StorageTexture, StorageTexture], sand: Field, wetSrc?: (xz: TSLNode) => TSLNode): Readers {
  const farT = baseTex(far.tex[0]);
  const nearT = baseTex(near.tex[0]);
  const nearBT = baseTex(nearB[0]);
  const sandT = baseTex(sand.tex[0]);

  const farFoam = (xz: TSLNode) => farT.sample(xz.sub(far.uDf).mul(far.uView.w)).level(0);
  const farStatic = (xz: TSLNode) => farT.sample(xz.mul(far.uView.w)).level(0);
  const nearUV = (xz: TSLNode) => xz.sub(near.uDf).mul(near.uView.w);

  return {
    foam(xz) {
      const p = vec2(xz).toVar();
      // Stored as (coverage, coverage * age): filtering then weights age by coverage.
      const f = farFoam(p).xy.mul(fade(p, far, 0.42, 0.49));
      const nr = nearT.sample(nearUV(p)).level(0).xy;
      const m = mix(f, nr, fade(p, near)).toVar();
      return vec2(m.x, clamp(m.y.div(max(m.x, 1e-3)), 0, 1));
    },
    wake(xz) {
      const p = vec2(xz).toVar();
      const uv = nearUV(p).toVar();
      const b = nearBT.sample(uv).level(0);
      const a = nearT.sample(uv).level(0);
      return vec4(b.x, b.z, b.w, a.z).mul(fade(p, near));
    },
    sand(xz) {
      const p = vec2(xz).toVar();
      const f = farStatic(p).zw.mul(fade(p, far, 0.42, 0.49));
      const s = sandT.sample(p.mul(sand.uView.w)).level(0);
      const w = fade(p, sand).toVar();
      // The sand field takes up the surf zone's water only on its tiles' update frames (1/8 of
      // them a frame, active.ts): read alone, the wet edge under a run-up advanced in 0.8 m
      // strips at 7.5-15 Hz. The water on the sand right now comes from the simulation, per pixel;
      // the field carries what it leaves behind as it dries.
      const wet = wetSrc ? max(mix(f.x, s.x, w), wetSrc(p)) : mix(f.x, s.x, w);
      return vec4(wet, s.y.mul(w), s.z.mul(w), mix(f.y, s.w, w));
    },
    sandHeight(xz) {
      const p = vec2(xz).toVar();
      const s = sandT.sample(p.mul(sand.uView.w)).level(0);
      return s.z.sub(s.y).mul(fade(p, sand));
    },
    select(parity) {
      farT.value = far.tex[parity];
      nearT.value = near.tex[parity];
      nearBT.value = nearB[parity];
      sandT.value = sand.tex[parity];
    },
  };
}
