// @vitest-environment node
//
// Riding a walker's eyes (L1, v2): what the lens actually shows. Independent rides against the live
// traffic, each started on a crowd that has been walking a while (as a click finds it) through
// PeopleSim.startRide (as people/index.ts does), measured from the first frame the camera is in the
// head: the distance from the eye to every figure and prop inside the view's frustum (walkers,
// people sitting or standing about, benches, lamp posts, trees, dogs, vehicles), faces looking into
// the lens, the longest run with a stranger's back close ahead, people coming at the eye turning
// back close in front of it, and how much of the ride is spent standing.

import { describe, expect, it } from 'vitest';
import { createTrafficSim, KINDS } from '../traffic/sim';
import { getCityIndex, getCityPlan } from '../world/city';
import { SEED } from '../world/config';
import { makeCrowd } from './crowd';
import { LookFlag, PeopleSim, RIDER_GLANCE_RATE, RIDER_KID_K } from './sim';
import { GazeAvert, headLook, kerbGlance, kerbWait, walkerEye, YawFollower, type PlanPose } from './track';

const DEG = Math.PI / 180;
/** The eyes ride (camera/rides/rig.ts): 60° vertical field of view at 16:10, pitched 6° down. */
const H_HALF = Math.atan(Math.tan(30 * DEG) * 1.6);
const V_LO = -36 * DEG;
const V_HI = 24 * DEG;
/** The ride camera springs the published heading again (rig.ts, ω 4.5). */
const RIG_W = 4.5;
/** The eyes ride's near plane (camera/director.ts EYES_NEAR, 0.5 m since D1's refine round 5). */
const NEAR = Number(process.env.LB_NEAR ?? 0.5);
const NW = 230;
const dt = 1 / 60;
const wrap = (a: number) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;

export interface RideStats {
  frames: number;
  /** Nearest in-frustum distance from the eye (m) per category, per ride. */
  near: Record<string, number[]>;
  /** Frames with something of that category inside the frustum closer than 1 m. */
  under1: Record<string, number>;
  /** A face within 1.8 m inside ±35° looking into the lens (> 0.7): frames, those in a ride's first 3 s, and the first 3 s' frames. */
  faces: number;
  facesEarly: number;
  earlyFrames: number;
  /** Such a face held over 0.5 s (events), and the longest (s). */
  faceOffs: number;
  faceRunMax: number;
  /** Per ride: the longest run (s) with a walker's back within 2.2 m inside the frustum. */
  backRuns: number[];
  /** Walkers coming at the eye that turned back within 3 m of it (events), and the nearest (m). */
  nearTurns: number;
  turnNear: number;
  /** Round 3's measure: the nearest body centre within ±45° of the view (m) and frames under 1 m. */
  cone: number;
  coneClose: number;
  /** The ridden walker's own U-turns (the view swings round onto whoever followed it). */
  riderTurns: number;
  stand: number;
  walked: number;
  /** Frames with a walker's head inside the frustum less than 1.15 m (× its scale) ahead of the eye: a third of the frame's height. Per ride the longest such run (s). */
  bigHead: number;
  headRuns: number[];
  /** A face within 2.2 m inside ±34° looking into the lens (> 0.7): frames. */
  faces22: number;
  /** Per ride: the longest run (s) with a stranger's back within 3.5 m inside ±25° of the view (tailing them). */
  tailRuns: number[];
  /** …and with a back within 6 m inside ±15° (the middle of the view: following someone, further off). */
  farRuns: number[];
  /** Frames standing still with a walker within 1.5 m inside the frustum (a kerb neighbour at arm's length). */
  standNear: number;
  /** Frames with a stranger's head cut by the eyes' near plane (camera/director.ts EYES_NEAR, 0.5 m): clipped open. */
  clip: number;
  /**
   * L1f refine round 1 (the critic r1's measures). A face within 2.5 m inside ±40° looking into the
   * lens (> 0.7): frames, and rides with any. A stranger facing the eye (> 0.5) whose head is a
   * quarter of the frame's height or more (head 0.22 × scale over depth × tan 30°, in view across):
   * frames, and per ride the longest run (s). Standoffs: the rider and a stranger facing it (> 0.6)
   * within 1.6 m in view, both standing (< 0.3 m/s): frames, per ride the longest run. Per ride: the
   * nearest walker in view under 1 m, a head of a third of the frame's height or more (any stranger),
   * the longest run of a head of a quarter of the frame, and rides with a face within 2.2 m.
   */
  faces25: number;
  faceRides25: number;
  faceRides22: number;
  faceHead: number;
  faceHeadRuns: number[];
  standoff: number;
  standoffRuns: number[];
  w1Rides: number;
  big33Rides: number;
  head25Runs: number[];
  /** The same in the lens report's way (people/lens-report.ts: a 0.2 × scale head, in the frame both ways). */
  big33LRides: number;
  head25LRuns: number[];
  /**
   * L1f refine round 2 (the critic r2's measures). Per ride the longest run (s) with a stranger's
   * back (facing away > 0.5) within 5 m inside ±30° of the view, with two or more such (a group),
   * and with one within 3 m; the longest run standing still. A face the lens can see: a stranger
   * within 2.5 m in view whose head — its facing plus the head turn people/index.ts gives it
   * (track.ts headLook) — points within ±70° of the eye: frames, rides, and frames within 1.5 m.
   */
  tail5Runs: number[];
  group5Runs: number[];
  back3Runs: number[];
  stillRuns: number[];
  faceVis: number;
  faceVisRides: number;
  faceVis15: number;
  /** Rides that began by turning round (PeopleSim.startDir). */
  startFlips: number;
}

/**
 * `rides` independent rides of `secs` s (every fourth a kid). Each crowd walks 3 s on its own,
 * then the ride starts: even rides fly in for 1.6 s before the eye counts (the berth is on
 * meanwhile, as in the game); odd ones are cuts (a settled ride: people step out of the view first).
 */
export const CAT: Record<'head' | 'tail' | 'face' | 'yl' | 'clip' | 'h33' | 'rturn', Record<string, number>> = { head: {}, tail: {}, face: {}, yl: {}, clip: {}, h33: {}, rturn: {} };

export function measureRides(rides: number, secs: number): RideStats {
  const plan = getCityPlan();
  const index = getCityIndex();
  const crowd = makeCrowd(plan, index, SEED, NW);
  const { looks, idlers, own } = crowd;
  const sim = new PeopleSim(plan, index, SEED, crowd.traits, idlers, own);
  const traffic = createTrafficSim(plan, SEED ^ 0x7aff1c, undefined, index);
  const busy = new Uint8Array(plan.walkEdges.length);
  const blocked = new Uint8Array(plan.walkEdges.length);
  for (let k = 0; k < 20 * 60; k++) traffic.step(dt, null, k === 20 * 60 - 1 ? blocked : null);
  const kids = looks.slice(0, NW).flatMap((l, i) => (l.flags & LookFlag.Kid ? [i] : []));
  const cats = ['walker', 'idler', 'prop', 'col', 'dog', 'owndog', 'car'];
  const st: RideStats = {
    frames: 0, near: {}, under1: {}, faces: 0, facesEarly: 0, earlyFrames: 0, faceOffs: 0, faceRunMax: 0, backRuns: [], nearTurns: 0, turnNear: Infinity, cone: Infinity, coneClose: 0, riderTurns: 0, stand: 0, walked: 0, bigHead: 0, headRuns: [], faces22: 0, tailRuns: [], farRuns: [], standNear: 0, clip: 0,
    faces25: 0, faceRides25: 0, faceRides22: 0, faceHead: 0, faceHeadRuns: [], standoff: 0, standoffRuns: [], w1Rides: 0, big33Rides: 0, head25Runs: [], big33LRides: 0, head25LRuns: [],
    tail5Runs: [], group5Runs: [], back3Runs: [], stillRuns: [], faceVis: 0, faceVisRides: 0, faceVis15: 0, startFlips: 0,
  };
  for (const c of cats) {
    st.near[c] = [];
    st.under1[c] = 0;
  }
  const e: PlanPose = { x: 0, z: 0, h: 0, fx: 0, fz: 0, speed: 0 };
  const prevDir = new Int8Array(NW);
  const prevEdge = new Int32Array(NW);
  const wasAt = new Uint8Array(NW);
  const nP = sim.nProps;
  const debug = !!process.env.LB_DEBUG;
  for (let n = 0; n < rides; n++) {
    // (LB_OFF shifts the set: other walkers, other hours — for judging a change on more than one set)
    const off = Number(process.env.LB_OFF ?? 0);
    const r = n % 4 === 3 ? kids[((n >> 2) + off * 5) % kids.length] : (n * 37 + 2 + off * 11) % NW;
    const kid = (looks[r].flags & LookFlag.Kid) !== 0;
    const live = n % 2 === 0;
    let t = 30 + r * 7.31 + off * 3.7;
    sim.endRide();
    sim.placeAt(t, busy, blocked);
    for (let k = 0; k < 180; k++, t += dt) {
      traffic.step(dt, busy, blocked);
      sim.step(dt, t, busy, blocked, 0, 0, false);
    }
    sim.on[r] = 1;
    sim.startRide(r, kid ? RIDER_KID_K : 1, !live);
    const fol = new YawFollower();
    const avert = new GazeAvert();
    let gw = 0;
    let cam = NaN;
    let camV = 0;
    let px = NaN;
    let pz = NaN;
    let backRun = 0;
    let backMax = 0;
    let faceRun = 0;
    let headRun = 0;
    let headMax = 0;
    let tailRun = 0;
    let tailMax = 0;
    let farRun = 0;
    let farMax = 0;
    let fhRun = 0;
    let fhMax = 0;
    let soRun = 0;
    let soMax = 0;
    let h25Run = 0;
    let h25Max = 0;
    let anyF25 = false;
    let anyF22 = false;
    let big33 = false;
    let big33L = false;
    let h25LRun = 0;
    let h25LMax = 0;
    let t5Run = 0;
    let t5Max = 0;
    let g5Run = 0;
    let g5Max = 0;
    let b3Run = 0;
    let b3Max = 0;
    let stillRun = 0;
    let stillMax = 0;
    let anyFV = false;
    const evH = { run: 0, j: -1, s: '', min: 0.5 };
    const evT = { run: 0, j: -1, s: '', min: 3 };
    const evF = { run: 0, j: -1, s: '', min: 0.3 };
    const evR = { run: 0, j: -1, s: '', min: 5 };
    const evT5 = { run: 0, j: -1, s: '', min: 3 };
    const evW1 = { run: 0, j: -1, s: '', min: 0.01 };
    const evFV = { run: 0, j: -1, s: '', min: 0.3 };
    let propSeen = false;
    let idlerSeen = false;
    const faces0 = st.faces;
    const big0 = st.bigHead;
    const stand0 = st.stand;
    const walked0 = st.walked;
    let riderDir = sim.dir[r];
    let riderEdge = sim.edge[r];
    const near: Record<string, number> = {};
    for (const c of cats) near[c] = Infinity;
    for (let j = 0; j < NW; j++) {
      prevDir[j] = sim.dir[j];
      prevEdge[j] = sim.edge[j];
    }
    const fly = live ? 96 : 0;
    const total = fly + Math.round(secs * 60);
    for (let k = 0; k < total; k++, t += dt) {
      traffic.step(dt, busy, blocked);
      sim.step(dt, t, busy, blocked, 0, 0, false);
      walkerEye(sim, looks[r], r, 1, false, e);
      gw += (kerbWait(sim, r) - gw) * Math.min(1, dt * 4);
      const yawF = Math.atan2(e.fz, e.fx);
      const glance = 0.6 * gw * kerbGlance(sim.riderLook * RIDER_GLANCE_RATE);
      const y = fol.step(yawF + (fol.on ? avert.step(sim, looks, r, e.x, e.z, yawF, glance, H_HALF, dt) : glance), dt);
      if (Number.isNaN(cam)) cam = y;
      else {
        camV += (-RIG_W * RIG_W * wrap(cam - y) - 2 * RIG_W * camV) * dt;
        cam += camV * dt;
      }
      const cy = Math.cos(cam);
      const sy = Math.sin(cam);
      // (as people/index.ts: the sim measures "in the lens" about the camera's heading)
      sim.riderVx = cy;
      sim.riderVz = sy;
      // people coming at the eye who turn back on the spot within 3 m of it
      for (let j = 0; j < NW; j++) {
        if (j === r || !sim.on[j]) continue;
        const dx = sim.x[j] - e.x;
        const dz = sim.z[j] - e.z;
        const d = Math.hypot(dx, dz);
        if (sim.dir[j] !== prevDir[j] && sim.edge[j] === prevEdge[j] && wasAt[j] && k >= fly) {
          st.turnNear = Math.min(st.turnNear, d);
          if (d < 3) st.nearTurns++;
          if (debug && d < 3) console.log(`  ride ${n} r${r} t+${((k - fly) / 60).toFixed(1)} TURN ${j} d ${d.toFixed(2)} why ${sim.turnWhy[j]} ${sim.info[sim.edge[j]].e.kind}`);
        }
        prevDir[j] = sim.dir[j];
        prevEdge[j] = sim.edge[j];
        wasAt[j] = d < 8 && dx * sim.hx[r] + dz * sim.hz[r] > 0 && -(sim.hx[j] * dx + sim.hz[j] * dz) > 0.5 * d ? 1 : 0;
      }
      if (k >= fly && sim.dir[r] !== riderDir && sim.edge[r] === riderEdge) {
        st.riderTurns++;
        if (debug) CAT.rturn[sim.turnWhy[r] === 9 ? `9.${sim.dbgWhy}` : sim.turnWhy[r]] = (CAT.rturn[sim.turnWhy[r] === 9 ? `9.${sim.dbgWhy}` : sim.turnWhy[r]] ?? 0) + 1;
        if (debug && sim.turnWhy[r] === 9) {
          const j = sim.dbgBack;
          const g = sim.info[sim.edge[j]];
          const gr = sim.info[sim.edge[r]];
          const S = sim as unknown as { yieldT: Float32Array };
          console.log(`  ride ${n} r${r} t+${((k - fly) / 60).toFixed(1)} BACKOFF ${j} ${g.e.kind}${g.crossing ? (sim.commit[j] ? '/c' : '/w') : ''} sp ${Math.hypot(sim.vx[j], sim.vz[j]).toFixed(2)} d ${Math.hypot(sim.x[j] - sim.x[r], sim.z[j] - sim.z[r]).toFixed(2)} ${sim.edge[j] === sim.edge[r] ? 'same' : sim.edge[j] === sim.next[r] ? 'next' : '-'} y ${S.yieldT[j].toFixed(1)} h ${sim.hurry[j].toFixed(1)} why ${sim.turnWhy[j]} dL ${sim.dbgBackL.toFixed(2)} k ${sim.riderK} sub ${sim.dbgWhy} bkV ${sim.dbgB[2].toFixed(2)} bkD ${sim.dbgB[1].toFixed(2)} n ${sim.dbgB[7]} vPref ${sim.vPref[j].toFixed(2)} rsp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)} | rider ${gr.e.kind} u ${sim.u[r].toFixed(1)}/${gr.len.toFixed(1)} w ${gr.e.width.toFixed(1)}`);
        }
      }
      riderDir = sim.dir[r];
      riderEdge = sim.edge[r];
      if (k < fly) continue;
      const early = k - fly < 180;
      st.frames++;
      if (early) st.earlyFrames++;
      if (!Number.isNaN(px)) st.walked += Math.hypot(sim.x[r] - px, sim.z[r] - pz);
      px = sim.x[r];
      pz = sim.z[r];
      if (Math.hypot(sim.vx[r], sim.vz[r]) < 0.15) st.stand++;
      const eh = e.h - sim.h[r];
      /** Nearest in-frustum distance of a vertical cylinder (centre offset dx, dz; radius rr; base..top above the eye's ground). */
      const lens = (dx: number, dz: number, rr: number, base: number, top: number): number => {
        const d = Math.hypot(dx, dz);
        const ang = Math.atan2(Math.abs(-dx * sy + dz * cy), dx * cy + dz * sy);
        const half = d > rr ? Math.asin(rr / d) : Math.PI / 2;
        if (ang - half > H_HALF) return Infinity;
        const dh = Math.max(0.02, d - rr);
        if (Math.atan2(top - eh, dh) < V_LO || Math.atan2(base - eh, dh) > V_HI) return Infinity;
        return Math.hypot(dh, Math.max(0, base - eh, eh - top));
      };
      const frame: Record<string, number> = {};
      for (const c of cats) frame[c] = Infinity;
      let back = false;
      let face = false;
      let big = false;
      let bigJ = -1;
      let bigA = Infinity;
      let tail = false;
      let far = false;
      let farJ = -1;
      let tailJ = -1;
      let faceJ = -1;
      let nearStand = false;
      let clipNow = false;
      let clipJ = -1;
      let f25 = false;
      let fHead = false;
      let so = false;
      let h25 = false;
      let h25L = false;
      let h33J = -1;
      let t5n = 0;
      let b3 = false;
      let fv = false;
      let fv15 = false;
      let fvJ = -1;
      let t5J = -1;
      let w1J = -1;
      let w1L = Infinity;
      const standing = Math.hypot(sim.vx[r], sim.vz[r]) < 0.15;
      const slowR = Math.hypot(sim.vx[r], sim.vz[r]) < 0.3;
      for (let j = 0; j < NW; j++) {
        if (j === r || !sim.on[j]) continue;
        const dx = sim.x[j] - e.x;
        const dz = sim.z[j] - e.z;
        const d = Math.hypot(dx, dz);
        if (d > 6) continue;
        if (dx * cy + dz * sy > d * Math.SQRT1_2) {
          st.cone = Math.min(st.cone, d);
          if (d < 1) st.coneClose++;
        }
        const sc = looks[j].scale;
        const L = lens(dx, dz, 0.22 * sc + 0.02, 0, 1.72 * sc);
        if (L < frame.walker) frame.walker = L;
        if (L === Infinity) continue;
        const ang = Math.atan2(Math.abs(-dx * sy + dz * cy), dx * cy + dz * sy);
        const away = (sim.hx[j] * dx + sim.hz[j] * dz) / (d || 1);
        const ahead = dx * cy + dz * sy;
        const hr = 0.2 * sc;
        if (ahead - hr < NEAR && ahead + hr > 0.05 && Math.abs(-dx * sy + dz * cy) - hr < NEAR * Math.tan(H_HALF)) {
          clipNow = true;
          clipJ = j;
        }
        if (ahead > 0.05 && ahead < 1.155 * sc && ang - Math.asin(Math.min(1, hr / Math.max(hr, d))) < H_HALF) {
          big = true;
          if (ahead < bigA) {
            bigA = ahead;
            bigJ = j;
          }
        }
        if (ang < 0.6 && d < 2.2 && away < -0.7) {
          st.faces22++;
          anyF22 = true;
        }
        if (ang < 40 * DEG && d < 2.5 && away < -0.7) f25 = true;
        // (the head's size in the frame, the critic's way: 0.22 × scale over its depth, in view across)
        const hf = ahead > 0.05 && ang - Math.asin(Math.min(1, (0.22 * sc) / Math.max(0.22 * sc, d))) < H_HALF ? (0.22 * sc) / (ahead * Math.tan(30 * DEG)) : 0;
        // (…and the lens report's way: the head sphere 0.2 × scale at 1.47 × scale up, in the frame both ways)
        const vh = Math.atan2(1.47 * sc - eh, Math.max(0.05, ahead));
        const vr = Math.asin(Math.min(1, (0.2 * sc) / Math.max(0.2 * sc, d)));
        const hfL = ahead > 0.05 && ang - vr < H_HALF && vh - vr < V_HI && vh + vr > V_LO ? (0.2 * sc) / (ahead * Math.tan(30 * DEG)) : 0;
        if (hfL >= 0.33) {
          big33L = true;
          h33J = j;
        }
        if (hfL >= 0.25) h25L = true;
        if (hf >= 0.25) h25 = true;
        if (hf >= 0.33) big33 = true;
        if (hf >= 0.25 && away < -0.5) fHead = true;
        if (slowR && d < 1.6 && away < -0.6 && Math.hypot(sim.vx[j], sim.vz[j]) < 0.3) so = true;
        if (ang < 15 * DEG && d < 6 && away > 0.5) {
          far = true;
          farJ = j;
        }
        if (ang < 25 * DEG && d < 3.5 && away > 0.5) {
          tail = true;
          tailJ = j;
        }
        if (standing && L < 1.5) nearStand = true;
        if (L < 1 && L < w1L) {
          w1L = L;
          w1J = j;
        }
        if (ang < 30 * DEG && d < 5 && away > 0.5 && ahead > 0.05) {
          if (t5n === 0 || j === t5J) t5J = j;
          t5n++;
          if (d < 3) b3 = true;
        }
        if (d < 2.5) {
          // (the head: its facing turned by headLook; + = to its left, as the shader's yaw)
          const toEye = Math.atan2(-dx * sim.hz[j] + dz * sim.hx[j], -dx * sim.hx[j] - dz * sim.hz[j]);
          if (Math.abs(wrap(toEye - headLook(toEye, d, looks[j].seed, true))) < 70 * DEG) {
            fv = true;
            fvJ = j;
            if (d < 1.5) fv15 = true;
          }
        }
        if (ang < 35 * DEG && d < 1.8 && away < -0.7) {
          st.faces++;
          if (early) st.facesEarly++;
          face = true;
          faceJ = j;
          if (Number(process.env.LB_TRACE) === n && (k & 7) === 0) {
            const g = sim.info[sim.edge[j]];
            const gr = sim.info[sim.edge[r]];
            console.log(`t+${((k - fly) / 60).toFixed(2)} FACE ${j} d ${d.toFixed(2)} sp ${Math.hypot(sim.vx[j], sim.vz[j]).toFixed(2)} ${g.e.kind}#${sim.edge[j]}${g.crossing ? (sim.commit[j] ? '/c' : '/w') : ''} u ${sim.u[j].toFixed(2)} dir ${sim.dir[j]} yield ${sim.yieldT[j].toFixed(1)} | rider ${gr.e.kind}#${sim.edge[r]}${gr.crossing ? (sim.commit[r] ? '/c' : '/w') : ''} u ${sim.u[r].toFixed(2)} dir ${sim.dir[r]} sp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)}`);
          }
        }
        if (d < 2.2 && away > 0.5) {
          back = true;
          if (Number(process.env.LB_TRACE) === n && backRun > 1 && (k & 15) === 0) {
            const g = sim.info[sim.edge[j]];
            const gr = sim.info[sim.edge[r]];
            console.log(`t+${((k - fly) / 60).toFixed(2)} back ${j} run ${backRun.toFixed(1)} d ${d.toFixed(2)} sp ${Math.hypot(sim.vx[j], sim.vz[j]).toFixed(2)} ${g.e.kind}${g.crossing ? (sim.commit[j] ? '/c' : '/w') : ''} same ${sim.edge[j] === sim.edge[r] ? (sim.dir[j] === sim.dir[r] ? 'y' : 'opp') : '-'} hurry ${sim.hurry[j].toFixed(1)} | rider sp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)} ${gr.e.kind}${gr.crossing ? (sim.commit[r] ? '/c' : '/w') : ''} lat ${sim.lat[r].toFixed(2)} look ${sim.riderLook.toFixed(1)} stuck ${sim.stuck[r].toFixed(1)}`);
          }
        }
      }
      for (let q = 0; q < own.length; q++) {
        const o = own[q];
        if (!sim.on[o]) continue;
        const L = lens(sim.dx[q] - e.x, sim.dz[q] - e.z, 0.2, 0, 0.5);
        const c = o === r ? 'owndog' : 'dog';
        if (L < frame[c]) frame[c] = L;
      }
      for (let q = 0; q < sim.obstacles.length; q++) {
        const o = sim.obstacles[q];
        const dx = o.x - e.x;
        const dz = o.z - e.z;
        if (dx * dx + dz * dz > 36) continue;
        const L = lens(dx, dz, Math.min(o.r, 0.45), 0, sim.obsH[q]);
        const c = q >= nP ? 'idler' : q >= sim.nFeat ? 'col' : 'prop';
        if (Number(process.env.LB_TRACE) === n && L < 0.5 && k % 6 === 0) console.log(`t+${((k - fly) / 60).toFixed(2)} NEARPROP q${q} r ${o.r.toFixed(2)} h ${sim.obsH[q].toFixed(1)} L ${L.toFixed(2)} plan d ${Math.hypot(dx, dz).toFixed(2)} rider ${sim.info[sim.edge[r]].e.kind}#${sim.edge[r]} u ${sim.u[r].toFixed(1)} lat ${sim.lat[r].toFixed(2)} sp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)}`);
        if (L < frame[c]) frame[c] = L;
      }
      for (let v = 0; v < traffic.n; v++) {
        const K = KINDS[traffic.kind[v]];
        const ax = traffic.fx[v] - traffic.rx[v];
        const az = traffic.fz[v] - traffic.rz[v];
        const al = Math.hypot(ax, az) || 1;
        const cx = (traffic.fx[v] + traffic.rx[v]) / 2 - e.x;
        const cz = (traffic.fz[v] + traffic.rz[v]) / 2 - e.z;
        if (cx * cx + cz * cz > 100) continue;
        // the body's nearest point to the eye, as a thin cylinder there
        const lo = Math.max(-K.len / 2, Math.min(K.len / 2, -(cx * ax + cz * az) / al));
        const la = Math.max(-K.width / 2, Math.min(K.width / 2, -(-cx * az + cz * ax) / al));
        const L = lens(cx + (ax / al) * lo - (az / al) * la, cz + (az / al) * lo + (ax / al) * la, 0.01, 0, K.height);
        if (L < frame.car) frame.car = L;
        if (Number(process.env.LB_TRACE) === n && L < 1 && k % 6 === 0) {
          const g = sim.info[sim.edge[r]];
          console.log(`t+${((k - fly) / 60).toFixed(2)} CAR ${v} kind ${traffic.kind[v]} L ${L.toFixed(2)} | rider ${g.e.kind}#${sim.edge[r]}${g.crossing ? (sim.commit[r] ? '/c' : '/w') : ''} u ${sim.u[r].toFixed(2)}/${g.len.toFixed(1)} kerbA ${g.kerbA.toFixed(2)} kerbB ${g.kerbB.toFixed(2)} dir ${sim.dir[r]} lat ${sim.lat[r].toFixed(2)} sp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)} road ${g.roadSide * sim.dir[r]}`);
        }
      }
      for (const c of cats) {
        if (frame[c] < near[c]) near[c] = frame[c];
        if (frame[c] < 1) st.under1[c]++;
      }
      if (debug) {
        const desc = (j: number) => {
          const g = sim.info[sim.edge[j]];
          const gr = sim.info[sim.edge[r]];
          const st2 = (q: number, gg: typeof g) => `${gg.e.kind}${gg.crossing ? (sim.commit[q] ? '/c' : '/w') : ''} sp ${Math.hypot(sim.vx[q], sim.vz[q]).toFixed(2)}`;
          return `[${st2(j, g)} d ${Math.hypot(sim.x[j] - e.x, sim.z[j] - e.z).toFixed(2)} ${sim.edge[j] === sim.edge[r] ? (sim.dir[j] === sim.dir[r] ? 'same' : 'opp') : sim.edge[j] === sim.next[r] ? 'next' : '-'} y${sim.yieldT[j] > 0 ? 1 : 0} h${sim.hurry[j] > 0 ? 1 : 0} face ${((sim.hx[j] * (e.x - sim.x[j]) + sim.hz[j] * (e.z - sim.z[j])) / Math.max(0.01, Math.hypot(sim.x[j] - e.x, sim.z[j] - e.z))).toFixed(1)} ang ${(Math.atan2(-(sim.x[j] - e.x) * sy + (sim.z[j] - e.z) * cy, (sim.x[j] - e.x) * cy + (sim.z[j] - e.z) * sy) / DEG).toFixed(0)} av ${(avert.a / DEG).toFixed(0)} | rider ${st2(r, gr)} look ${sim.riderLook.toFixed(1)} lat ${sim.lat[r].toFixed(2)}]`;
        };
        const track = (ev: { run: number; j: number; s: string; min: number }, on: boolean, j: number, label: string) => {
          if (!on && ev.run > ev.min) console.log(`  ride ${n} r${r} t+${((k - fly) / 60).toFixed(1)} ${label} ${ev.run.toFixed(1)}s by ${ev.j} ${ev.s}`);
          if (on && ev.run === 0) {
            ev.j = j;
            ev.s = desc(j);
          }
          ev.run = on ? ev.run + dt : 0;
        };
        track(evH, big, bigJ, 'HEAD');
        track(evT, tail, tailJ, 'TAIL');
        track(evF, face, faceJ, 'FACE');
        track(evR, far, farJ, 'FAR');
        track(evT5, t5n > 0, t5J, t5n > 1 ? 'T5G' : 'T5');
        track(evW1, w1J >= 0, w1J, `W1 ${w1L.toFixed(2)}`);
        track(evFV, fv, fvJ, 'FV');
        if (frame.prop < 0.6 && !propSeen) {
          propSeen = true;
          console.log(`  ride ${n} r${r} t+${((k - fly) / 60).toFixed(1)} PROP ${frame.prop.toFixed(2)} [rider ${sim.info[sim.edge[r]].e.kind} sp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)} lat ${sim.lat[r].toFixed(2)}]`);
        }
        if (frame.idler < 0.9 && !idlerSeen) {
          idlerSeen = true;
          console.log(`  ride ${n} r${r} t+${((k - fly) / 60).toFixed(1)} IDLER ${frame.idler.toFixed(2)} [rider ${sim.info[sim.edge[r]].e.kind} sp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)} lat ${sim.lat[r].toFixed(2)}]`);
        }
      }
      if (Number(process.env.LB_TRACE) === n && process.env.LB_IV && k % 6 === 0) {
        const tt = (k - fly) / 60;
        if (tt > Number(process.env.LB_IV.split(',')[0]) && tt < Number(process.env.LB_IV.split(',')[1])) console.log(`t+${tt.toFixed(2)} IV pref ${sim.dbgPlan[0].toFixed(2)} best ${sim.dbgPlan[1].toFixed(2)} lo ${sim.dbgPlan[2].toFixed(2)} hi ${sim.dbgPlan[3].toFixed(2)}${sim.dbgIv}`);
      }
      if (Number(process.env.LB_TRACE) === n && process.env.LB_IV) sim.dbgIv = 'x';
      if (Number(process.env.LB_TRACE) === n && k % 6 === 0 && process.env.LB_YTRACE) {
        for (let j = 0; j < NW; j++) {
          if (j === r || !sim.on[j] || sim.yieldT[j] <= 0) continue;
          const dx = sim.x[j] - sim.x[r];
          const dz = sim.z[j] - sim.z[r];
          if (dx * dx + dz * dz > 25) continue;
          const g = sim.info[sim.edge[j]];
          const tx = sim.hx[r];
          const tz = sim.hz[r];
          const S = sim as unknown as { yieldS: Int8Array };
          console.log(`t+${((k - fly) / 60).toFixed(2)} Y${j} ${g.e.kind}#${sim.edge[j]} dir ${sim.dir[j]} u ${sim.u[j].toFixed(1)}/${g.len.toFixed(1)} lat ${sim.lat[j].toFixed(2)} hiR ${g.hiR.toFixed(2)} hiL ${g.hiL.toFixed(2)} side ${S.yieldS[j]} sp ${Math.hypot(sim.vx[j], sim.vz[j]).toFixed(2)} T ${sim.yieldT[j].toFixed(1)} | ahead ${(dx * tx + dz * tz).toFixed(2)} lateral ${(-dx * tz + dz * tx).toFixed(2)} | rider #${sim.edge[r]} dir ${sim.dir[r]} lat ${sim.lat[r].toFixed(2)} sp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)} plan pref ${sim.dbgPlan[0].toFixed(2)} best ${sim.dbgPlan[1].toFixed(2)} lo ${sim.dbgPlan[2].toFixed(2)} hi ${sim.dbgPlan[3].toFixed(2)} n ${sim.dbgPlan[4]} road ${sim.info[sim.edge[r]].roadSide}`);
        }
      }
      if (Number(process.env.LB_TRACE) === n && k % 15 === 0) {
        const S = sim as unknown as Record<string, number>;
        const gr = sim.info[sim.edge[r]];
        const tj = tailJ >= 0 ? tailJ : bigJ >= 0 ? bigJ : S.riderPass >= 0 ? S.riderPass : sim.leadNow;
        const tq = tj >= 0 ? ` | j${tj} d ${Math.hypot(sim.x[tj] - e.x, sim.z[tj] - e.z).toFixed(2)} sp ${Math.hypot(sim.vx[tj], sim.vz[tj]).toFixed(2)} e${sim.edge[tj]} dir ${sim.dir[tj]} lat ${sim.lat[tj].toFixed(2)} y ${sim.yieldT[tj].toFixed(1)} h ${sim.hurry[tj].toFixed(1)} way ${(sim as unknown as { wayT: Float32Array }).wayT[tj].toFixed(1)}` : '';
        console.log(`t+${((k - fly) / 60).toFixed(2)} rider ${gr.e.kind}#${sim.edge[r]} u ${sim.u[r].toFixed(1)}/${gr.len.toFixed(1)} dir ${sim.dir[r]} sp ${Math.hypot(sim.vx[r], sim.vz[r]).toFixed(2)} lat ${sim.lat[r].toFixed(2)} fol ${S.riderFollowT.toFixed(1)} lead ${S.riderLead}/${sim.leadNow} pass ${S.riderPass} stuck ${sim.stuck[r].toFixed(1)} big ${big ? 1 : 0} tail ${tail ? 1 : 0}${tq}`);
      }
      if (debug) {
        const cls = (j: number) => {
          const g = sim.info[sim.edge[j]];
          const sp = Math.hypot(sim.vx[j], sim.vz[j]);
          const o = sim.yieldT[j] > 0 ? 'yield' : g.crossing && !sim.commit[j] && sp < 0.3 ? 'kerbwait' : g.crossing && sim.commit[j] ? 'crosser' : sp < 0.25 ? 'stand' : sim.hx[j] * sim.hx[r] + sim.hz[j] * sim.hz[r] > 0.5 ? 'same' : 'onc';
          const gr = sim.info[sim.edge[r]];
          const rs = Math.hypot(sim.vx[r], sim.vz[r]);
          const rr = gr.crossing && !sim.commit[r] ? 'Rwait' : gr.crossing ? 'Rcross' : rs < 0.25 ? 'Rstand' : 'Rwalk';
          return `${o}/${rr}`;
        };
        if (big) CAT.head[cls(bigJ)] = (CAT.head[cls(bigJ)] ?? 0) + 1;
        if (clipNow) CAT.clip[cls(clipJ)] = (CAT.clip[cls(clipJ)] ?? 0) + 1;
        if (h33J >= 0) CAT.h33[cls(h33J)] = (CAT.h33[cls(h33J)] ?? 0) + 1;
        if (big && sim.yieldT[bigJ] > 0) {
          const dx = sim.x[bigJ] - sim.x[r];
          const dz = sim.z[bigJ] - sim.z[r];
          const g = sim.info[sim.edge[bigJ]];
          const S = sim as unknown as { yieldS: Int8Array };
          const tgt = S.yieldS[bigJ] > 0 ? (sim.dir[bigJ] > 0 ? g.hiR : g.hiL) : -(sim.dir[bigJ] > 0 ? g.hiL : g.hiR);
          const key = `lat${(Math.round(Math.abs(-dx * sim.hz[r] + dz * sim.hx[r]) * 5) / 5).toFixed(1)} off${(Math.round(Math.abs(sim.lat[bigJ] - tgt) * 5) / 5).toFixed(1)}`;
          CAT.yl[key] = (CAT.yl[key] ?? 0) + 1;
        }
        if (tail) CAT.tail[cls(tailJ)] = (CAT.tail[cls(tailJ)] ?? 0) + 1;
        if (faceJ >= 0) CAT.face[cls(faceJ)] = (CAT.face[cls(faceJ)] ?? 0) + 1;
      }
      if (clipNow) st.clip++;
      if (fv) {
        st.faceVis++;
        anyFV = true;
        if (fv15) st.faceVis15++;
      }
      t5Run = t5n > 0 ? t5Run + dt : 0;
      t5Max = Math.max(t5Max, t5Run);
      g5Run = t5n > 1 ? g5Run + dt : 0;
      g5Max = Math.max(g5Max, g5Run);
      b3Run = b3 ? b3Run + dt : 0;
      b3Max = Math.max(b3Max, b3Run);
      stillRun = standing ? stillRun + dt : 0;
      stillMax = Math.max(stillMax, stillRun);
      if (f25) {
        st.faces25++;
        anyF25 = true;
      }
      if (fHead) st.faceHead++;
      if (so) st.standoff++;
      fhRun = fHead ? fhRun + dt : 0;
      fhMax = Math.max(fhMax, fhRun);
      soRun = so ? soRun + dt : 0;
      soMax = Math.max(soMax, soRun);
      h25Run = h25 ? h25Run + dt : 0;
      h25Max = Math.max(h25Max, h25Run);
      h25LRun = h25L ? h25LRun + dt : 0;
      h25LMax = Math.max(h25LMax, h25LRun);
      if (big) st.bigHead++;
      if (nearStand) st.standNear++;
      headRun = big ? headRun + dt : 0;
      headMax = Math.max(headMax, headRun);
      tailRun = tail ? tailRun + dt : 0;
      tailMax = Math.max(tailMax, tailRun);
      farRun = far ? farRun + dt : 0;
      farMax = Math.max(farMax, farRun);
      backRun = back ? backRun + dt : 0;
      backMax = Math.max(backMax, backRun);
      faceRun = face ? faceRun + dt : 0;
      st.faceRunMax = Math.max(st.faceRunMax, faceRun);
      if (faceRun > 0.5 && faceRun - dt <= 0.5) st.faceOffs++;
    }
    for (const c of cats) st.near[c].push(near[c]);
    st.backRuns.push(backMax);
    st.headRuns.push(headMax);
    st.tailRuns.push(tailMax);
    st.farRuns.push(farMax);
    st.faceHeadRuns.push(fhMax);
    st.standoffRuns.push(soMax);
    st.head25Runs.push(h25Max);
    if (anyF25) st.faceRides25++;
    if (anyF22) st.faceRides22++;
    if (near.walker < 1) st.w1Rides++;
    if (big33) st.big33Rides++;
    if (big33L) st.big33LRides++;
    st.head25LRuns.push(h25LMax);
    st.tail5Runs.push(t5Max);
    st.group5Runs.push(g5Max);
    st.back3Runs.push(b3Max);
    st.stillRuns.push(stillMax);
    if (anyFV) st.faceVisRides++;
    if (debug) console.log(JSON.stringify({ n, r, kid: +kid, live: +live, back: +backMax.toFixed(2), tail: +tailMax.toFixed(2), head: +headMax.toFixed(2), h25: +h25Max.toFixed(1), h25L: +h25LMax.toFixed(1), stand: +((st.stand - stand0) / 60).toFixed(1), walk: +(st.walked - walked0).toFixed(1), fh: +fhMax.toFixed(1), so: +soMax.toFixed(1), t5: +t5Max.toFixed(1), g5: +g5Max.toFixed(1), b3: +b3Max.toFixed(1), still: +stillMax.toFixed(1), fv: +anyFV, f25: +anyF25, big33: +big33, far: +farMax.toFixed(1), big: st.bigHead - big0, faces: st.faces - faces0, ...Object.fromEntries(cats.map((c) => [c, Number.isFinite(near[c]) ? +near[c].toFixed(2) : null])) }));
  }
  sim.endRide();
  st.startFlips = sim.dbgStartFlip;
  return st;
}

const RIDES = Number(process.env.LB_RIDES ?? 48);

describe('riding a walker’s eyes', () => {
  it('shows a calm walk: no faces in the lens, no standoffs, no long tailing, nothing at arm’s length, no turn-backs in front, still walking', { timeout: Math.max(180000, RIDES * 2500) }, () => {
    const N = RIDES;
    const secs = 25;
    const s = measureRides(N, secs);
    const per = (x: number) => x / s.frames;
    const rate = (xs: number[], f: (x: number) => boolean) => xs.filter(f).length / xs.length;
    const runs = s.backRuns.slice().sort((a, b) => a - b);
    const p95 = runs[Math.min(runs.length - 1, Math.floor(runs.length * 0.95))];
    const q95 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
    if (process.env.LB_DEBUG) {
      console.log({
        faces: per(s.faces), facesEarly: s.facesEarly / s.earlyFrames, faceOffs: s.faceOffs, faceRunMax: s.faceRunMax,
        backP95: p95, backMax: runs[runs.length - 1], nearTurns: s.nearTurns, turnNear: s.turnNear, riderTurns: s.riderTurns,
        cone: s.cone, coneClose: per(s.coneClose), stand: per(s.stand), walked: s.walked / N,
        walkerMin: Math.min(...s.near.walker), idlerMin: Math.min(...s.near.idler), propMin: Math.min(...s.near.prop), carMin: Math.min(...s.near.car), ownDogMin: Math.min(...s.near.owndog),
        propUnder06: rate(s.near.prop, (x) => x < 0.6), propUnder08: rate(s.near.prop, (x) => x < 0.8), propUnder1: rate(s.near.prop, (x) => x < 1), idlerUnder09: rate(s.near.idler, (x) => x < 0.9), walkerUnder08: rate(s.near.walker, (x) => x < 0.8),
        under1: Object.fromEntries(Object.entries(s.under1).map(([k, v]) => [k, per(v)])),
        bigHead: per(s.bigHead), headP95: q95(s.headRuns), headMax: Math.max(...s.headRuns), headOver05: rate(s.headRuns, (x) => x > 0.5), faces22: per(s.faces22),
        cat: JSON.stringify(Object.fromEntries(Object.entries(CAT).map(([k, v]) => [k, Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 14)]))),
        clip: per(s.clip),
        farP95: q95(s.farRuns), farMax: Math.max(...s.farRuns), farOver5: rate(s.farRuns, (x) => x > 5),
        tailP95: q95(s.tailRuns), tailMax: Math.max(...s.tailRuns), tailOver4: rate(s.tailRuns, (x) => x > 4), standNear: per(s.standNear),
      });
      console.log({
        faces25: per(s.faces25), faceRides25: s.faceRides25 / N, faceRides22: s.faceRides22 / N, faceHead: per(s.faceHead), faceHeadRide05: rate(s.faceHeadRuns, (x) => x > 0.5), faceHeadMax: Math.max(...s.faceHeadRuns),
        standoff: per(s.standoff), standoffRides: rate(s.standoffRuns, (x) => x > 0.3), standoffMax: Math.max(...s.standoffRuns),
        w1Rides: s.w1Rides / N, big33Rides: s.big33Rides / N, head25Max: Math.max(...s.head25Runs), head25Over15: rate(s.head25Runs, (x) => x > 1.5), head25Over1: rate(s.head25Runs, (x) => x > 1),
        big33LRides: s.big33LRides / N, head25LOver1: rate(s.head25LRuns, (x) => x > 1), head25LMax: Math.max(...s.head25LRuns),
      });
      console.log({
        tail5Over3: rate(s.tail5Runs, (x) => x > 3), tail5Over5: rate(s.tail5Runs, (x) => x > 5), tail5P95: q95(s.tail5Runs), tail5Max: Math.max(...s.tail5Runs),
        group5Over3: rate(s.group5Runs, (x) => x > 3), group5Max: Math.max(...s.group5Runs), back3Over3: rate(s.back3Runs, (x) => x > 3), back3Max: Math.max(...s.back3Runs),
        stillOver25: rate(s.stillRuns, (x) => x > 2.5), stillMax: Math.max(...s.stillRuns), startFlips: s.startFlips / N,
        faceVis: per(s.faceVis), faceVisRides: s.faceVisRides / N, faceVis15: per(s.faceVis15),
        propUnder1: rate(s.near.prop, (x) => x < 1), propUnder08: rate(s.near.prop, (x) => x < 0.8),
        colMin: Math.min(...s.near.col), colUnder1: rate(s.near.col, (x) => x < 1), colUnder08: rate(s.near.col, (x) => x < 0.8), colUnder12: rate(s.near.col, (x) => x < 1.2),
      });
    }
    // Round 3's sim on these same rides (192 of them, 25 s each): faces 0.9 % of frames, 20 faces
    // held over 0.5 s, a back within 2.2 m for over 3 s in 19 % of rides (longest 9 s), 224 turn-backs
    // within 3 m of the eye (in 57 % of rides), a prop within 0.8 m in 14 % of rides.
    expect(per(s.faces)).toBeLessThan(0.006); // a face looking into the lens within 1.8 m (~0.25 % over 192 rides)
    expect(s.facesEarly / s.earlyFrames).toBeLessThan(0.006); // …nor in a ride's first 3 s
    expect(s.faceOffs).toBeLessThanOrEqual(Math.ceil(N / 12)); // held over half a second: rare (5 in 192 rides)
    expect(p95).toBeLessThan(3.5); // a stranger's back within 2.2 m (95th percentile 2.65 s over 192 rides)
    expect(runs[runs.length - 1]).toBeLessThan(6);
    expect(s.nearTurns).toBeLessThanOrEqual(Math.ceil(N / 3)); // turning back within 3 m of the eye (36 in 192 rides)
    expect(Math.min(...s.near.idler)).toBeGreaterThan(0.45); // people sitting or standing about
    expect(rate(s.near.prop, (x) => x < 0.6)).toBeLessThan(0.1); // a lamp post, a trunk, a bench within 0.6 m
    expect(Math.min(...s.near.owndog)).toBe(Infinity); // its own dog never in the frame (at heel behind)
    expect(Math.min(...s.near.car)).toBeGreaterThan(0.7); // a vehicle body in the lens
    expect(s.cone).toBeGreaterThan(0.45); // round 3's measure: a body centre within ±45°
    expect(per(s.coneClose)).toBeLessThan(0.003);
    expect(per(s.stand)).toBeLessThan(0.15); // still walking
    expect(s.walked / N).toBeGreaterThan(0.85 * secs);
    // L1f round 5 (the phase-1 critic's head, tail and kerb-neighbour measures; round 4's sim over
    // 96 rides → round 5 over 384: a head within 1.15 m in view 2.1 % → 1.1 % of frames, a run of it
    // over 0.5 s in 22 % → 10 % of rides; a back within 3.5 m inside ±25° for over 4 s in 15 % → 2 %
    // of rides, 95th percentile 7.0 → 3.2 s; standing beside someone within 1.5 m 1.1 % → 0.6 %)
    expect(per(s.bigHead)).toBeLessThan(0.02);
    expect(rate(s.headRuns, (x) => x > 0.5)).toBeLessThan(0.2);
    expect(Math.max(...s.headRuns)).toBeLessThan(5);
    expect(per(s.faces22)).toBeLessThan(0.009); // a face looking into the lens within 2.2 m
    expect(per(s.clip)).toBeLessThan(0.007); // a head cut open by the eyes' near plane (0.5 m)
    expect(q95(s.tailRuns)).toBeLessThan(4.5); // tailing someone within 3.5 m
    expect(Math.max(...s.tailRuns)).toBeLessThan(7);
    expect(per(s.standNear)).toBeLessThan(0.012); // a kerb neighbour at arm's length
    expect(s.nearTurns).toBeLessThanOrEqual(Math.ceil(N / 4));
    // L1f refine 1 (the critic r1's measures; round 5's sim → refine 1 over 192 rides: a face within
    // 2.5 m inside ±40° 0.79 % → 0.33 % of frames, in 46 % → 22 % of rides, within 2.2 m in 29 % →
    // 12 %; a stranger facing the eye with a head of a quarter of the frame or more 0.65 % → 0.25 %;
    // a walker in view under 1 m in 15 % → 7 % of rides; a head of a third of the frame (the lens
    // report's way) in 25 % → 15 %; a back within 6 m inside ±15° for over 5 s in 20 % → 6 % of rides;
    // standoffs — the rider and a stranger facing it within 1.6 m, both standing — none over 0.2 s)
    expect(per(s.faces25)).toBeLessThan(0.006);
    expect(per(s.faceHead)).toBeLessThan(0.005);
    expect(Math.max(...s.faceHeadRuns)).toBeLessThan(1.6);
    expect(rate(s.faceHeadRuns, (x) => x > 0.5)).toBeLessThan(0.1);
    expect(Math.max(...s.standoffRuns)).toBeLessThan(0.5);
    expect(per(s.standoff)).toBeLessThan(0.0005);
    expect(Math.max(...s.head25LRuns)).toBeLessThan(3); // a head of a quarter of the frame, the lens report's way
    expect(rate(s.head25LRuns, (x) => x > 1)).toBeLessThan(0.06);
    expect(rate(s.farRuns, (x) => x > 5)).toBeLessThan(0.1); // following a back in the middle of the view
    // L1f refine 2 (the critic r2's measures; refine 1's sim → refine 2 over 768 rides, the sets
    // LB_OFF=1 and 2 of 384): a stranger's back within 5 m inside ±30° of the view for over 5 s in
    // 7.7 % → 1.4 % of rides (95th percentile 5.7 → 4.3 s), two or more of them for over 3 s in
    // 3.8 % → 0.65 %; a walker in view under 1 m in 9.5 % → 4.3 % of rides; a stranger's head a
    // third of the frame's height (the lens report's way) in 19.5 % → 13.5 % of rides; a face the
    // lens can see (its head, turned as the renderer turns it, within ±70° of the eye) 0.66 % →
    // 0.54 % of frames, within 1.5 m 0.11 % → 0.06 %; a face within 2.2 m in 7.2 % → 5.1 % of rides;
    // the rider standing still over 2.5 s in 15.6 % → 7.9 % of rides; its own U-turns 140 → 131.
    // Over 1536 rides (sets 1–4): tailing over 5 s in 2.1 % of rides, longest 7.0 s; the longest
    // head of a quarter of the frame 3.9 s (someone standing at the kerb the rider crosses from).
    // On these 48 rides a rate's bar allows a ride or two (the bars are guards; the many-ride
    // numbers are the measure).
    expect(rate(s.tail5Runs, (x) => x > 5)).toBeLessThan(0.07);
    expect(Math.max(...s.tail5Runs)).toBeLessThan(8);
    expect(rate(s.group5Runs, (x) => x > 3)).toBeLessThan(0.05);
    expect(s.w1Rides / N).toBeLessThan(0.07); // (the critic r2 asked under 5 %: 4.3 % over 768 rides)
    expect(s.big33LRides / N).toBeLessThan(0.16);
    expect(per(s.faceVis15)).toBeLessThan(0.002);
    expect(per(s.faceVis)).toBeLessThan(0.009);
    expect(rate(s.stillRuns, (x) => x > 2.5)).toBeLessThan(0.2);
    expect(s.riderTurns / N).toBeLessThan(0.4);
  });
});
