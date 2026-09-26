// Skin (and board-short fabric) for the first-person limbs. Subsurface transmission through thin
// parts (fingers glow when backlit by the low sun), sun-warmed albedo with lighter palms, knuckle
// wrinkles, nails, faint salt-dried patches, and a wet film on a clearcoat that sheds droplets.
// Micro-relief is projected in the bind pose (positionGeometry) so it sticks to the skin.

import { MeshSSSNodeMaterial, type Texture } from 'three/webgpu';
import {
  modelViewMatrix,
  vec4,
  sin,
  transformNormalToView,
  abs,
  attribute,
  color,
  cos,
  dFdx,
  dFdy,
  exp,
  float,
  max,
  mix,
  normalGeometry,
  normalView,
  positionGeometry,
  positionView,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { TSLNode } from '../../core/contracts';
import { TILE } from '../tex';

export interface SkinLook {
  /** 0 = dry, 1 = soaked. */
  wet: TSLNode;
  /** Running-water sheen: animates the film normal (seconds-ish phase). */
  flow: TSLNode;
  /** Salt-dried patches strength (grows as the skin dries). */
  salt: TSLNode;
  /** Subsurface strength (artist knob). */
  sss: TSLNode;
  /** Albedo tone multiplier (artist knob). */
  tone: TSLNode;
  /** Micro-relief strength (artist knob). */
  relief: TSLNode;
}

export function createSkinLook(): SkinLook {
  return { wet: uniform(0), flow: uniform(0), salt: uniform(0.4), sss: uniform(1), tone: uniform(1), relief: uniform(1) };
}

/** Triplanar sample of one texture over bind-pose position p with blend from normal n. */
function triplanar(tex: Texture, p: TSLNode, n: TSLNode, scale: number) {
  const w0 = abs(n).pow(vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const sx = texture(tex, p.yz.mul(scale));
  const sy = texture(tex, p.zx.mul(scale));
  const sz = texture(tex, p.xy.mul(scale));
  return sx.mul(w.x).add(sy.mul(w.y)).add(sz.mul(w.z));
}

/**
 * Bump mapping with physical height (metres): Mikkelsen's surface-gradient method with the
 * unnormalised screen derivatives, so the tilt is height / footprint at every distance.
 */
export function perturbNormal(dHx: TSLNode, dHy: TSLNode) {
  const sx = dFdx(positionView);
  const sy = dFdy(positionView);
  const n = normalView;
  const r1 = sy.cross(n);
  const r2 = n.cross(sx);
  const det = sx.dot(r1);
  const grad = det.sign().mul(r1.mul(dHx).add(r2.mul(dHy)));
  return det.abs().mul(n).sub(grad).normalize();
}

export function createSkinMaterial(look: SkinLook, tex: { skin: Texture; beads: Texture; noise: Texture }) {
  const m = new MeshSSSNodeMaterial();
  const aux = attribute('aux', 'vec4');
  const aux2 = attribute('aux2', 'vec2');
  const thin = aux.x;
  const nail = aux.y;
  const crease = aux.z;
  const axial = aux.w;
  const fabric = aux2.x;
  const volar = aux2.y;
  const p = positionGeometry;
  const nB = normalGeometry;
  const sc = 1 / TILE.skin;

  const nb = nB.normalize();
  const w0 = abs(nb).pow(vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const sX = texture(tex.skin, p.yz.mul(sc));
  const sY = texture(tex.skin, p.zx.mul(sc));
  const sZ = texture(tex.skin, p.xy.mul(sc));
  // Mottling and salt patches at body scale (cm to dm), from the broad noise.
  const mott = triplanar(tex.noise, p, nb, 1 / 0.14).r;
  const saltN = triplanar(tex.noise, p, nb, 1 / 0.35).g.mul(0.7).add(triplanar(tex.noise, p, nb, 1 / 0.09).a.mul(0.3));

  // Relief as a bind-space tangent perturbation (whiteout-style triplanar), plus knuckle
  // wrinkles across the finger axis (fingers run along bind +X), no screen derivatives.
  const tX = sX.xy.mul(2).sub(1);
  const tY = sY.xy.mul(2).sub(1);
  const tZ = sZ.xy.mul(2).sub(1);
  const relief = float(1).sub(nail).mul(float(1).sub(fabric.mul(0.6)));
  let dB: TSLNode = vec3(0, tX.x, tX.y).mul(w.x).add(vec3(tY.y, 0, tY.x).mul(w.y)).add(vec3(tZ.x, tZ.y, 0).mul(w.z)).mul(relief.mul(0.3).mul(look.relief));
  const wr = sin(axial.mul((Math.PI * 2) / 0.0016)).mul(crease).mul(0.1);
  dB = dB.add(vec3(wr, 0, 0));
  // Board shorts: soft folds (the relief map at ~12x scale) and a fine weave.
  const fold = texture(tex.skin, vec2(p.x.add(p.z).mul(4.2), p.y.mul(2.6))).xy.mul(2).sub(1);
  const weave = sin(p.y.add(p.x).mul(2600)).mul(sin(p.y.sub(p.z).mul(2600))).mul(0.06);
  dB = dB.add(vec3(fold.x.mul(0.55).add(weave), 0, fold.y.mul(0.55).sub(weave)).mul(fabric));
  dB = dB.sub(nb.mul(nb.dot(dB)));
  // Carry the bind-space perturbation onto the skinned view-space normal (rotation nb → nv).
  const nv = (normalView as TSLNode).normalize();
  const nbV = transformNormalToView(nb).normalize();
  const cr = nbV.cross(nv);
  const c = nbV.dot(nv);
  // Unnormalised: these are small tangent offsets, not normals (the mesh's model matrix is identity).
  const toView = (v: TSLNode) => modelViewMatrix.mul(vec4(v, 0)).xyz;
  const dV0 = toView(dB);
  const dV = dV0.add(cr.cross(dV0)).add(cr.cross(cr.cross(dV0)).div(c.add(1).max(0.05)));
  m.normalNode = nv.add(dV).normalize();

  // Albedo: sun-tanned dorsum, lighter volar skin, warmer knuckles, nails.
  const tan = color(0.43, 0.245, 0.155).mul(look.tone);
  const palm = color(0.56, 0.36, 0.27).mul(look.tone);
  let col: TSLNode = mix(tan, palm, volar.mul(0.85));
  col = col.mul(mott.sub(0.5).mul(0.16).add(1));
  col = mix(col, col.mul(vec3(1.08, 0.86, 0.82)), crease.mul(0.6));
  const nailCol = color(0.66, 0.47, 0.42);
  col = mix(col, nailCol, nail);
  // Salt: a pale, matte bloom in patches once the skin has dried a little.
  const saltMask = smoothstep(0.56, 0.74, saltN).mul(look.salt).mul(float(1).sub(look.wet)).mul(float(1).sub(nail));
  col = mix(col, col.mul(1.18).add(vec3(0.05, 0.05, 0.05)), saltMask.mul(0.55));
  // Board shorts: faded navy with a hint of teal, darker when soaked.
  const cloth = color(0.018, 0.04, 0.07).mul(mott.sub(0.5).mul(0.25).add(1)).mul(mix(float(1), float(0.55), look.wet));
  col = mix(col.mul(mix(float(1), float(0.86), look.wet)), cloth, fabric);
  m.colorNode = col;

  const dryRough = mix(float(0.52), float(0.36), crease.mul(0.3)).add(saltMask.mul(0.25));
  const skinRough = mix(dryRough, float(0.3), look.wet);
  const r = mix(skinRough, float(0.24), nail);
  m.roughnessNode = mix(r, mix(float(0.86), float(0.62), look.wet), fabric);
  m.metalnessNode = float(0);
  m.sheenNode = vec3(0.12, 0.13, 0.16).mul(fabric);
  m.sheenRoughnessNode = float(0.6);

  // Water film: clearcoat with droplet relief; slides slowly (flow) so the sheen lives.
  const beads = triplanar(tex.beads, p.add(vec3(0, look.flow.mul(-0.01), 0)), nB, 1 / (TILE.beads * 0.8));
  const film = look.wet.mul(float(1).sub(fabric.mul(0.8)));
  m.clearcoatNode = film.mul(mix(float(0.55), float(1), beads.b));
  m.clearcoatRoughnessNode = mix(float(0.12), float(0.04), beads.b);
  const bT = beads.xy.mul(2).sub(1).mul(beads.b).mul(0.18);
  const bB = vec3(bT.x, bT.y, bT.x.mul(-0.5)).sub(nb.mul(nb.dot(vec3(bT.x, bT.y, bT.x.mul(-0.5)))));
  const bV0 = toView(bB);
  m.clearcoatNormalNode = nv.add(bV0.add(cr.cross(bV0))).normalize();

  // Transmission through thin skin: fingers and the rims of the hand glow red-orange.
  const sssCol = mix(color(0.95, 0.4, 0.22), color(0.9, 0.55, 0.42), nail);
  m.thicknessColorNode = sssCol.mul(thin.mul(float(1).sub(fabric))).mul(look.sss);
  m.thicknessDistortionNode = float(0.25);
  m.thicknessAmbientNode = float(0.02);
  m.thicknessAttenuationNode = float(0.9);
  m.thicknessPowerNode = float(3.5);
  m.thicknessScaleNode = float(1.5);
  void max;
  void exp;
  void vec2;
  return m;
}
