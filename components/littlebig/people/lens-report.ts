// People (L1, v2): what the eyes ride's lens shows, measured on the real camera (shot mode only:
// review scripts call meshes[0].userData.peopleLens()). For every walker, dog, person sitting or
// standing about and prop near the camera: whether any of it is inside the view frustum and how
// far its nearest point is from the eye; plus faces looking into the lens and backs close ahead.
// Allocates (a review tool, never called by the game itself).
// L1f refine 2 (the critic: the measures were out of date): `face` is a face the lens can see —
// the head's yaw after the renderer's turn (track.ts headLook) — and `tail` the critic's tailing
// window, ±30° within 5 m, with `tailN` counting the backs in it (a group run).

import { Vector3 } from 'three';
import type { LBContext } from '../core/contracts';
import { toSphere } from '../world/city/frame';
import type { Look, PeopleSim } from './sim';
import { headLook } from './track';

export interface LensReport {
  /** Nearest in-frustum distance from the eye (m) per category (Infinity: none within 6 m). */
  walker: number;
  idler: number;
  prop: number;
  dog: number;
  owndog: number;
  /** A face in view within 2.5 m whose head (its body's facing turned by headLook, as drawn) points within ±70° of the eye: its walker, else −1. */
  face: number;
  /** A walker's back within 2.2 m inside the frustum (facing away > 0.5): its walker, else −1. */
  back: number;
  /** The biggest stranger's head in view: its height as a share of the frame's (0: none), and whose. */
  headFrac: number;
  headId: number;
  /** A stranger's back within 5 m inside ±30° of the view (tailing them): the nearest one's walker, else −1. */
  tail: number;
  /** How many backs are in that window (2 and more: tailing a group). */
  tailN: number;
  /** Who is nearest per category (walker index / obstacle index), for the report. */
  walkerId: number;
  propId: number;
  idlerId: number;
}

const P = new Vector3();
const Q = new Vector3();
const U = new Vector3();
const C = new Vector3();

/**
 * Lens report for the camera as it is now, the ridden walker `ri` (−1: none) left out. Plan-space
 * facings come from the sim; the eye's plan position is the camera's (ctx.view.cityX/Z).
 */
export function lensReport(ctx: LBContext, sim: PeopleSim, looks: readonly Look[], ri: number): LensReport {
  const cam = ctx.camera;
  cam.updateMatrixWorld();
  const eye = cam.position;
  const out: LensReport = { walker: Infinity, idler: Infinity, prop: Infinity, dog: Infinity, owndog: Infinity, face: -1, back: -1, headFrac: 0, headId: -1, tail: -1, tailN: 0, walkerId: -1, propId: -1, idlerId: -1 };
  const tanV = Math.tan((cam.fov * Math.PI) / 360);
  const tanH = tanV * cam.aspect;
  const ex = ctx.view.cityX;
  const ez = ctx.view.cityZ;
  const fwd = new Vector3();
  cam.getWorldDirection(fwd);
  const a = ctx.time.alpha;
  let faceD = Infinity;
  let tailD = Infinity;
  /** Nearest distance of a vertical cylinder (plan x, z; base height h above the plateau; height top; radius r) if any of it is in view. */
  const probe = (x: number, z: number, h: number, top: number, r: number): number => {
    toSphere(x, z, h, P);
    U.copy(P).normalize();
    // the nearest point of the axis to the eye, then off the axis toward the eye by r
    const t = Math.max(0, Math.min(top, Q.subVectors(eye, P).dot(U)));
    C.copy(P).addScaledVector(U, t);
    const toEye = Q.subVectors(eye, C);
    const axisD = toEye.length();
    const dist = Math.max(0.02, axisD - r);
    if (dist > 6) return Infinity;
    // in view: any of five points up the axis, each pushed by r toward the eye and toward the
    // frustum's nearest side plane (the critic r1: pushed only toward the eye, a body overlapping
    // the frame's edge read as out of view; across the view axis is what brings the disc in)
    for (let k = 0; k <= 4; k++) {
      Q.copy(P).addScaledVector(U, (top * k) / 4);
      const side = C.copy(eye).sub(Q);
      side.addScaledVector(U, -side.dot(U));
      const sl = side.length();
      if (sl > 1e-6) Q.addScaledVector(side, Math.min(r, sl) / sl);
      // (in the frustum's cone whatever the near plane: the eyes ride's steps out to 0.75 m, and a
      // head inside it is clipped open, which is worse than seen whole)
      Q.applyMatrix4(cam.matrixWorldInverse);
      if (Q.z < -0.02 && Math.abs(Q.x) <= -Q.z * tanH && Math.abs(Q.y) <= -Q.z * tanV) return dist;
      // (the disc against the frustum's nearer side plane: its centre within r of it, the camera
      // level enough that the cross-section lies in its x–z plane)
      Q.copy(P).addScaledVector(U, (top * k) / 4).applyMatrix4(cam.matrixWorldInverse);
      if (Q.z < r && Math.abs(Q.x) + Q.z * tanH <= r * Math.sqrt(1 + tanH * tanH) && Math.abs(Q.y) <= Math.max(0, -Q.z) * tanV + 0.02) return dist;
    }
    return Infinity;
  };
  for (let j = 0; j < sim.n; j++) {
    if (j === ri || !sim.on[j]) continue;
    const x = sim.px[j] + (sim.x[j] - sim.px[j]) * a;
    const z = sim.pz[j] + (sim.z[j] - sim.pz[j]) * a;
    const dx = x - ex;
    const dz = z - ez;
    const pd = Math.hypot(dx, dz);
    if (pd > 6.5) continue;
    const h = sim.ph[j] + (sim.h[j] - sim.ph[j]) * a;
    const sc = looks[j].scale;
    const d = probe(x, z, h, 1.72 * sc, 0.24 * sc);
    if (d < out.walker) {
      out.walker = d;
      out.walkerId = j;
    }
    if (d !== Infinity) {
      const away = (sim.hx[j] * dx + sim.hz[j] * dz) / (pd || 1);
      // the angle off the view axis, from the body's middle
      toSphere(x, z, h + 0.9 * sc, P);
      const off = Q.subVectors(P, eye).normalize().dot(fwd);
      if (pd < 2.2 && away > 0.5) out.back = j;
      if (pd < 5 && away > 0.5 && off > Math.cos((30 * Math.PI) / 180)) {
        out.tailN++;
        if (pd < tailD) {
          tailD = pd;
          out.tail = j;
        }
      }
      if (pd < 2.5 && pd < faceD) {
        // the eye's bearing off its facing (+ = to its left, the shader's yaw), less the head's turn
        const toEye = Math.atan2(-dx * sim.hz[j] + dz * sim.hx[j], -dx * sim.hx[j] - dz * sim.hz[j]);
        let yaw = toEye - headLook(toEye, pd, looks[j].seed, ri >= 0);
        yaw -= Math.round(yaw / (2 * Math.PI)) * 2 * Math.PI;
        if (Math.abs(yaw) < (70 * Math.PI) / 180) {
          faceD = pd;
          out.face = j;
        }
      }
    }
    // the head (r 0.2 at 1.47, × scale): any of it in the frame, and its size there — tested on its
    // own, whatever the body's probe said (the critic r1: a face at the frame's edge went uncounted
    // whenever the body probe missed)
    toSphere(x, z, h + 1.47 * sc, P);
    const depth = Q.subVectors(P, eye).dot(fwd);
    if (depth > 0.05) {
      const hr = 0.2 * sc;
      Q.copy(P).applyMatrix4(cam.matrixWorldInverse);
      const ry = hr / (depth * tanV);
      const rx = ry / cam.aspect;
      const nx = Q.x / (-Q.z * tanH);
      const ny = Q.y / (-Q.z * tanV);
      if (Q.z < 0 && Math.abs(nx) <= 1 + rx && Math.abs(ny) <= 1 + ry && ry > out.headFrac) {
        out.headFrac = ry;
        out.headId = j;
      }
    }
  }
  for (let k = 0; k < sim.dOwner.length; k++) {
    const o = sim.dOwner[k];
    if (!sim.on[o]) continue;
    const x = sim.dpx[k] + (sim.dx[k] - sim.dpx[k]) * a;
    const z = sim.dpz[k] + (sim.dz[k] - sim.dpz[k]) * a;
    if (Math.hypot(x - ex, z - ez) > 6.5) continue;
    const d = probe(x, z, sim.ph[o] + (sim.h[o] - sim.ph[o]) * a, 0.55, 0.22);
    if (o === ri) out.owndog = Math.min(out.owndog, d);
    else out.dog = Math.min(out.dog, d);
  }
  for (let q = 0; q < sim.obstacles.length; q++) {
    const o = sim.obstacles[q];
    if (Math.hypot(o.x - ex, o.z - ez) > 6.5) continue;
    const g = ctx.world.cityIndex.groundH(o.x, o.z);
    const d = probe(o.x, o.z, g, sim.obsH[q], Math.min(o.r, 0.45));
    if (q >= sim.nProps) {
      if (d < out.idler) {
        out.idler = d;
        out.idlerId = q;
      }
    } else if (d < out.prop) {
      out.prop = d;
      out.propId = q;
    }
  }
  return out;
}
