// Debug fixture (water.testCrest, set at boot): one steep, thin crest line just seaward of the
// `water-crest` shot, standing in for A8's breakers so the SSS path can be judged against the
// sun before real lips exist. A surface hook adds it (with its slopes, so the normals follow) and
// an SSS provider reports its light path. Never registered unless the param is on at boot.

import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import type { SurfaceHook, SurfaceHookInput } from '../ocean/surface';
import { SWELL } from '../world/layout';
import type { SSSProvider } from './thickness';

const { abs, exp, float, log, max, select, smoothstep, sqrt, vec2, vec3, vec4, saturate } = TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

/** Crest line centre, height (m), front and back e-folding widths (m), half length (m). */
export const TEST_CREST = { x: -128, z: -97, h: 1.25, front: 0.95, back: 5.5, half: 30 };

export function createTestCrest(): { hook: SurfaceHook; provider: SSSProvider } {
  const dx = SWELL.dirX;
  const dz = SWELL.dirZ;
  const T = TEST_CREST;
  // `spacing` band-limits the front to the clipmap's vertex spacing (≥ 3 spacings), or the
  // coarser rings alias it into a sawtooth.
  const profile = (rest: TSLNode, spacing: TSLNode) => {
    const rel = rest.sub(vec2(T.x, T.z));
    const s = rel.x.mul(dx).add(rel.y.mul(dz)).toVar(); // + = shoreward (the front)
    const along = rel.y.mul(dx).sub(rel.x.mul(dz));
    const lat = float(1).sub(smoothstep(T.half * 0.75, T.half, abs(along))).toVar();
    const wdt = select(s.greaterThan(0), max(float(T.front), spacing.mul(3)), max(float(T.back), spacing.mul(3))).toVar();
    const q = s.div(wdt);
    const e = exp(q.mul(q).negate());
    const y = e.mul(T.h).mul(lat).toVar();
    // dy/ds (steep on the front, gentle behind)
    const dyds = q.mul(-2).div(wdt).mul(e).mul(T.h).mul(lat).toVar();
    return { s, y, dyds, lat };
  };
  const hook: SurfaceHook = ({ rest, spacing }: SurfaceHookInput) => {
    const p = profile(rest, spacing);
    return { d: vec3(0, p.y, 0), dd: vec4(p.dyds.mul(dx), p.dyds.mul(dz), 0, 0) };
  };
  const provider: SSSProvider = ({ rest, spacing }: SurfaceHookInput) => {
    const p = profile(rest, spacing);
    // Light enters over the crest line and leaves through the front face.
    const below = max(float(T.h).mul(p.lat).sub(p.y), 0);
    const front = select(p.s.greaterThan(0), float(1), float(0));
    const steep = saturate(p.dyds.negate().div(0.7)).mul(front).mul(p.lat);
    // Horizontal chord at this height: both flanks of the Gaussian profile.
    const r = max(float(T.h).mul(p.lat).div(max(p.y, 1e-3)), 1);
    const chord = select(p.lat.greaterThan(0.5), float(T.front + T.back).mul(sqrt(log(r))).add(0.03), float(1e3));
    return { path: select(front, below.div(0.45).add(0.03), float(20)), steep, chord };
  };
  return { hook, provider };
}
