import { ARENA_R } from '../engine/types';

/** Dunes start outside the rock ring; inside it the ground is just this gentle undulation. */
export const DUNE_START = ARENA_R + 3;
export const TERRAIN_HALF = 80;

const U = { a1: 0.18, fx1: 0.21, px1: 0.3, fz1: 0.17, a2: 0.1, fx2: 0.37, fz2: 0.53 };
const f = (n: number) => n.toFixed(4);

/** Ground height in world units. Exact for r ≤ DUNE_START (the arena and the rock ring). */
export function groundHeight(x: number, z: number): number {
  return U.a1 * Math.sin(U.fx1 * x + U.px1) * Math.cos(U.fz1 * z) + U.a2 * Math.sin(U.fx2 * x + U.fz2 * z);
}

export const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}
`;

export const TERRAIN_GLSL = /* glsl */ `
#define DUNE_START ${DUNE_START.toFixed(1)}
float arenaUndulation(vec2 p) {
  return ${f(U.a1)} * sin(${f(U.fx1)} * p.x + ${f(U.px1)}) * cos(${f(U.fz1)} * p.y)
       + ${f(U.a2)} * sin(${f(U.fx2)} * p.x + ${f(U.fz2)} * p.y);
}
float duneField(vec2 p) {
  float warp = fbm(p * 0.018);
  float phase = dot(p, vec2(0.82, 0.57)) * 0.085 + warp * 6.0;
  float crest = pow(1.0 - abs(sin(phase)), 1.6);
  return crest * 6.5 + fbm(p * 0.05) * 3.0;
}
float terrainHeight(vec2 p) {
  float r = length(p);
  float m = smoothstep(DUNE_START, DUNE_START + 13.0, r);
  float grow = 0.6 + 0.4 * smoothstep(30.0, 80.0, r);
  return mix(arenaUndulation(p), duneField(p) * grow, m);
}
`;
