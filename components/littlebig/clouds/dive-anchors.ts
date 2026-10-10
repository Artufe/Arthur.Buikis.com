// Where the scripted dive (camera/dive.ts) crosses the cloud layer, precomputed: the clouds anchor
// the cloudlet the camera punches through on these points. Computing them at boot meant building
// the whole dive path (camera/dive.ts + core/shots.ts, review tooling) on the production path.
// dive-anchors.spec.ts recomputes them from the live dive and fails when the plan or the dive
// changes; paste the table it prints (it writes the fresh values in its failure message).

import { planToDir } from '../world/city/frame';
import { latLonFromDir, type Vec3 } from '../world/sphere';

/** Sea-level altitude (m) → [crossing direction xyz, travel direction xyz] (unit vectors). */
export const DIVE_CROSSINGS: Record<string, readonly number[]> = {
  '41.9': [-0.24506756657133008, 0.5106321445605844, 0.8241339094808957, 0.7613075470279435, -0.4249762358971393, 0.48969992624156544],
  '42': [-0.24556125561534997, 0.5109076524810049, 0.8238161447659067, 0.7611484500986061, -0.424644979685609, 0.4902343094279492],
  '42.8': [-0.2494928118832147, 0.5130949121709094, 0.8212715433539224, 0.7600355495753606, -0.4217911694945914, 0.49440688983676623],
  '43': [-0.2504707576678707, 0.5136371004059958, 0.8206347108426525, 0.7598822394862045, -0.42092076011372614, 0.49538338266307796],
  '43.3': [-0.251933917859937, 0.5144468917557913, 0.8196790204674923, 0.7593983930487536, -0.4199306523355984, 0.49696310513353964],
  '44.4': [-0.2572690875986395, 0.517386024880983, 0.8161643938717361, 0.7579503023513863, -0.4158755122937479, 0.5025523827819889],
};

/**
 * Sim time (s) at which the /play clip (sim from DIVE_T0, core/shots.ts) crosses 43 m: the cloudlet
 * is placed where the DRIFTING clouds will be then (the drift turns the layer about the city's axis,
 * and 26° off it ~4° of drift moved the cloudlet 6 m off the track, so the clip flew past it).
 * Checked by dive-anchors.spec.ts.
 */
export const DIVE_CROSS_T = 15.471;

/** The dive's crossing of `altSea` (one of the table's altitudes), or null. */
export function diveCrossing(altSea: number): { at: Vec3; travel: Vec3 } | null {
  const c = DIVE_CROSSINGS[String(altSea)];
  return c ? { at: { x: c[0], y: c[1], z: c[2] }, travel: { x: c[3], y: c[4], z: c[5] } } : null;
}

/** The `clouds` review shot's camera (core/shots.ts builds the same view; the spec checks it). */
export function cloudsShotView() {
  const ll = latLonFromDir(planToDir(0, 70));
  return { lat: ll.lat, lon: ll.lon, alt: 44, heading: 0, pitch: -35 };
}
