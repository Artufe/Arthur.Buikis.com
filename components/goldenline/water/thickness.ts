// The in-water light path for subsurface scattering, per vertex.
//
// Inside the water the refracted low sun descends steeply (~43° below horizontal at an 11° sun,
// shallower where it enters a steep back face), so sunlight only crosses a crest toward the
// viewer where the front face is steeper than that ray: it enters over the crest line and leaves
// through the face. The path is then ≈ (height below the crest line) / sin(descent), capped by
// the crest's horizontal chord at that height (w = 2·acos(y/A)/k for y = A·cos θ).
//
// Base swell: that estimate, with the face steepness left to the fragment (it has the normals).
// Providers (A8's breakers, the debug test crest) supply their own path and steepness for the
// geometry they add; the thinnest path wins. Register them on `ocean.gpu.waterSSS` (see README).

import * as TSL from 'three/tsl';
import type { TSLNode } from '../core/contracts';
import type { SurfaceHook, SurfaceHookInput } from '../ocean/surface';
import { swellTrainGPU, type SwellGPU } from '../ocean/swell-gpu';

const { acos, abs, clamp, float, length, max, min, normalize, select, varyingProperty, vec2, vec3, vec4 } =
  TSL as unknown as Record<string, (...args: any[]) => TSLNode>;

/** What an SSS provider returns for a vertex (vertex-stage nodes). */
export interface SSSProviderOutput {
  /** In-water light path (m) toward the viewer through the geometry it adds. */
  path: TSLNode;
  /** 0-1: how steep that face is (1 = light certainly crosses it). */
  steep: TSLNode;
  /** Horizontal chord (m) through the geometry at this vertex's height (the view ray's path); ≥ 1e3 = not active here. */
  chord: TSLNode;
}

/** Called inside the ocean's vertex stage with the same input as a surface hook. */
export type SSSProvider = (p: SurfaceHookInput) => SSSProviderOutput;

export interface ThicknessVaryings {
  /** (path m, provider steepness 0-1 or −1 = "use the fragment's", wave direction x, z). */
  vThick: TSLNode;
  /** Horizontal chord through the crest at this height (m), for light seen through it. */
  vChord: TSLNode;
  hook: SurfaceHook;
}

export function createThicknessHook(swell: SwellGPU, sunDir: TSLNode, providers: SSSProvider[]): ThicknessVaryings {
  const vThick = varyingProperty('vec4', 'vWaterThick');
  const vChord = varyingProperty('float', 'vWaterChord');
  const hook: SurfaceHook = (inp: SurfaceHookInput) => {
    const { rest, disp } = inp;
    const t0 = swellTrainGPU(swell, 0, rest);
    const t1 = swellTrainGPU(swell, 1, rest);
    const t2 = swellTrainGPU(swell, 2, rest);
    const a0 = t0.amp.toVar();
    const a1 = t1.amp.toVar();
    const a2 = t2.amp.toVar();
    // the wind sea adds a few cm to the crest envelope
    const A = a0.add(a1).add(a2).add(0.04).toVar();
    const kv = vec2(t0.kx, t0.kz).mul(a0).add(vec2(t1.kx, t1.kz).mul(a1)).add(vec2(t2.kx, t2.kz).mul(a2)).div(max(a0.add(a1).add(a2), 1e-4)).toVar();
    const k = max(length(kv), 1e-3);
    const dir = kv.div(k).toVar();
    const c = clamp(disp.y.div(A), -1, 1).toVar();
    const chord = acos(c).mul(2).div(k);
    const Lh = normalize(vec2(sunDir.x, sunDir.z));
    const align = max(abs(Lh.x.mul(dir.x).add(Lh.y.mul(dir.y))), 0.35);
    const path = min(A.mul(float(1).sub(c)).div(0.45), chord.div(align)).add(0.05).toVar();
    const steep = float(-1).toVar();
    const vc = chord.add(0.05).toVar();
    // `disp` already includes the providers' own geometry, which fools the swell estimate, so an
    // active provider (chord < 1e3) owns the vertex outright.
    for (let i = 0; i < providers.length; i++) {
      const o = providers[i](inp);
      const on = o.chord.lessThan(999);
      steep.assign(select(on, o.steep, steep));
      path.assign(select(on, o.path, path));
      vc.assign(select(on, o.chord, vc));
    }
    vThick.assign(vec4(path, steep, dir.x, dir.y));
    vChord.assign(vc);
    return { d: vec3(0, 0, 0) };
  };
  return { vThick, vChord, hook };
}
