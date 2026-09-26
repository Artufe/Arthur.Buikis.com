// Board shading: glassed PU blank with a resin-tinted bottom lapped onto the deck, a cedar
// stringer under the glass, rubbed-in wax over the standing/paddling zone, and a water film
// on a clearcoat layer that breaks into beads as it dries. A charcoal EVA traction pad.
// Board frame inputs only (uv.x = metres from the tail, uv.y = girth from the stringer).

import { MeshSSSNodeMaterial, type Texture } from 'three/webgpu';
import {
  abs,
  attribute,
  bitangentView,
  clamp,
  color,
  cos,
  float,
  fwidth,
  max,
  mix,
  normalGeometry,
  normalWorldGeometry,
  normalView,
  positionGeometry,
  smoothstep,
  step,
  tangentView,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { TSLNode } from '../../core/contracts';
import { TILE } from '../tex';

export interface BoardLook {
  /** 0 = bone dry, 1 = just out of the water. Beads survive down to ~0.05. */
  wet: TSLNode;
  /** 0..1 continuous water sheet over the deck (fresh out of the water / water washing over). */
  film: TSLNode;
  /** Metres the surface water has flowed toward the tail (sheeting animation). */
  flow: TSLNode;
  /** Resin tint strength 0..1 (artist knob). */
  tint: TSLNode;
  /** Backlit rail glow strength. */
  glow: TSLNode;
  /** World direction toward the sun (atmosphere.sunDirNode). */
  sunDir: TSLNode;
}

export function createBoardLook(sunDir: TSLNode): BoardLook {
  return { wet: uniform(0), film: uniform(0), flow: uniform(0), tint: uniform(1), glow: uniform(1), sunDir };
}

/** View-space normal from a tangent-space perturbation (x along uv.x, y along uv.y). */
const tangentToView = (t: TSLNode) => (tangentView as TSLNode).mul(t.x).add((bitangentView as TSLNode).mul(t.y)).add((normalView as TSLNode).mul(t.z)).normalize();

/** Tangent-space normal from a height texture channel via two offset taps. */
const heightNormal = (tex: Texture, p: TSLNode, e: number, k: number) => {
  const h0 = texture(tex, p).r;
  const hx = texture(tex, p.add(vec2(e, 0))).r;
  const hy = texture(tex, p.add(vec2(0, e))).r;
  return vec3(h0.sub(hx).mul(k), h0.sub(hy).mul(k), 1).normalize();
};

export function createBoardMaterial(look: BoardLook, tex: { wax: Texture; beads: Texture; noise: Texture }) {
  const m = new MeshSSSNodeMaterial();
  const d = uv().x;
  const g = uv().y;
  const rail = attribute('railDist', 'float');
  const nG = normalGeometry;

  const broad = texture(tex.noise, vec2(d, g).mul(0.45));
  const fineN = texture(tex.noise, vec2(d, g).mul(3.1));

  // Resin tint lapped ~4.5 cm onto the deck, with a hand-cut edge.
  const lapEdge = float(0.046).add(broad.g.sub(0.5).mul(0.006));
  const lapAA = fwidth(rail).max(0.0004);
  const tinted = smoothstep(lapEdge.add(lapAA), lapEdge.sub(lapAA), rail).mul(look.tint);
  // A thin pinline just inside the lap on the deck.
  const pinC = lapEdge.add(0.012);
  const pin = smoothstep(float(0.0011).add(lapAA), float(0.0011), abs(rail.sub(pinC))).mul(step(0, nG.y));

  const blank = color(0.84, 0.82, 0.76).mul(mix(float(0.93), float(1.02), broad.r));
  const resin = color(0.3, 0.6, 0.52).mul(mix(float(0.9), float(1.04), broad.g));
  let base: TSLNode = mix(blank, resin, tinted);
  base = mix(base, color(0.11, 0.2, 0.26), pin.mul(0.85));

  // Stringer: 3 mm of cedar under the glass, deck and bottom.
  const sz = abs(positionGeometry.z);
  const sAA = fwidth(positionGeometry.z).max(0.0003);
  const stringer = smoothstep(float(0.0016).add(sAA), float(0.0016).sub(sAA.mul(0.5)), sz).mul(smoothstep(0.35, 0.8, abs(nG.y)));
  base = mix(base, color(0.36, 0.2, 0.1).mul(mix(float(0.8), float(1.1), fineN.r)), stringer.mul(0.9));

  // Wax: the chest-to-tail zone of the deck, ragged at its ends, off the rails.
  const waxUV = vec2(d, g).div(TILE.wax);
  const wax = texture(tex.wax, waxUV);
  const zoneEnds = smoothstep(0.34, 0.4, d).mul(smoothstep(float(1.44).add(broad.r.mul(0.06)), float(1.37), d));
  const zone = zoneEnds.mul(smoothstep(0.035, 0.075, rail)).mul(smoothstep(0.55, 0.85, nG.y));
  // A rubbed coat: solid inside the zone, a ragged, bumpy edge only where the zone fades.
  const coverage = zone.mul(wax.a.mul(0.25).add(0.75));
  const waxMask = smoothstep(0.35, 0.55, coverage.add(wax.b.sub(0.5).mul(0.25)));
  // Embedded sand and grime specks in the wax.
  const speck = smoothstep(0.78, 0.86, fineN.a).mul(waxMask);
  const waxCol = color(0.76, 0.74, 0.68).mul(mix(float(0.8), float(1.06), wax.b)).mul(mix(float(1), float(0.88), look.wet));
  base = mix(base, waxCol, waxMask.mul(0.92));
  base = mix(base, color(0.28, 0.24, 0.18), speck.mul(0.7));

  m.colorNode = base;
  // Hot-coat gloss with faint swirl scratches; wax is matte.
  const glassRough = mix(float(0.075), float(0.16), fineN.g);
  m.roughnessNode = mix(glassRough, mix(float(0.62), float(0.42), look.wet), waxMask);
  m.metalnessNode = float(0);

  const waxN = vec3(wax.r.mul(2).sub(1), wax.g.mul(2).sub(1), 1);
  // Normal-map horizon: where the deck itself faces away from the sun, bumps must not catch it.
  const facing = smoothstep(-0.05, 0.3, (normalWorldGeometry as TSLNode).dot(look.sunDir));
  const nTs = mix(vec3(0, 0, 1), waxN, waxMask.mul(0.9).mul(facing.mul(0.85).add(0.15))).normalize();
  m.normalNode = tangentToView(nTs);

  // Water: a continuous film right out of the water, flowing aft; beads as it dries.
  const beads = texture(tex.beads, vec2(d, g).div(TILE.beads));
  const alive = smoothstep(beads.a.sub(0.02), beads.a.add(0.02), look.wet.mul(1.08).sub(0.04));
  // Beads only where the sheet has broken up.
  const bead = beads.b.mul(alive).mul(smoothstep(0.0, 0.08, look.wet)).mul(float(1).sub(look.film));
  // A thin, slow sheet: long streaks down the board, no pebbly detail.
  const filmUV = vec2(d.mul(0.55).add(look.flow.mul(0.55)), g.mul(1.6));
  const filmN = heightNormal(tex.noise, filmUV, 0.006, 0.35);
  const beadN = vec3(beads.r.mul(2).sub(1).mul(0.7), beads.g.mul(2).sub(1).mul(0.7), 1).normalize();
  const film = look.film;
  const ccMask = max(film, bead);
  m.clearcoatNode = clamp(ccMask, 0, 1);
  m.clearcoatRoughnessNode = float(0.035);
  m.clearcoatNormalNode = tangentToView(mix(beadN, filmN, film).normalize());

  // Backlit rails and tips: sunlight through thin foam and glass warms the edge.
  const thin = smoothstep(0.03, 0.0, abs(rail)).add(smoothstep(0.12, 0.0, d)).add(smoothstep(2.0, 2.13, d)).min(1);
  m.thicknessColorNode = mix(color(0.9, 0.75, 0.5), color(0.45, 0.85, 0.7), tinted).mul(thin).mul(look.glow);
  m.thicknessDistortionNode = float(0.2);
  m.thicknessAmbientNode = float(0);
  m.thicknessAttenuationNode = float(0.6);
  m.thicknessPowerNode = float(6);
  m.thicknessScaleNode = float(1.4);
  return m;
}

export function createPadMaterial(look: BoardLook, tex: { noise: Texture }) {
  const m = new MeshSSSNodeMaterial();
  m.thicknessColorNode = null;
  const d = uv().x;
  const z = uv().y;
  const h = attribute('padH', 'float');
  // Parallel grooves along the pad, diagonal on the kick.
  const kickT = smoothstep(0.14, 0.1, d);
  const coord = mix(z, z.add(d).mul(0.7071), kickT);
  const period = 0.0068;
  const ph = coord.div(period).mul(Math.PI * 2);
  const wave = cos(ph);
  const aa = fwidth(coord).div(period).mul(2.5).clamp(0, 1);
  const ridge = mix(wave, float(0), aa);
  // Height = cos(ph): the slope across the grooves, faded out where they would alias.
  const slope = ph.sin().mul(float(1).sub(aa)).mul(0.55);
  const tDir = mix(vec2(0, 1), vec2(0.7071, 0.7071), kickT);
  const nTs = vec3(tDir.x.mul(slope), tDir.y.mul(slope), 1).normalize();
  m.normalNode = tangentToView(nTs);
  const n = texture(tex.noise, vec2(d, z).mul(6));
  // Worn ridges read a touch lighter; the pad edges are scuffed.
  const edge = smoothstep(0.004, 0.001, h);
  const wetK = mix(float(1), float(0.62), look.wet);
  const eva = color(0.028, 0.03, 0.032).mul(mix(float(0.85), float(1.2), n.r)).mul(ridge.mul(0.12).add(1));
  m.colorNode = mix(eva, color(0.07, 0.07, 0.068), edge.mul(0.5)).mul(wetK);
  m.roughnessNode = mix(float(0.86), float(0.5), look.wet);
  m.metalnessNode = float(0);
  return m;
}
