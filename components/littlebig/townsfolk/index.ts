// LITTLEBIG v2 townsfolk (T2): people in every town but the capital, by its character. Far haven's
// office workers and shoppers, the harbours' fishermen and net-menders, coral cove's sunbathers and bar
// regulars, the farmhands, snowberry's skiers in their winter colours by the lift.
//
// Each town's walk network and places (townsfolk/net.ts) are built in short slices after the world is
// up (urgently when the camera comes for a town), its people (townsfolk/folk.ts) simulated only while
// the camera is within range of it (townsfolk/sim.ts), placed for the hour when it comes into range
// (out of view: people are drawn only below POP_HI m, far inside that range).
// Rendering is the capital's people: the same figures (people/figure.ts), the same toon program
// (people/shader.ts patch 'people', so no new shader compiles), three LODs and the dogs, packed every
// frame with only what is near and in front of the camera, popping in by altitude and dithered at the
// eye like the capital's, warm under the lamps at night. Every walker is a Trackable 'person:<5000 + k>'
// with the 'eyes' view (people/track.ts's yaw and height followers and kerb glance); the anchored ones
// (keepers, sunbathers) are not. The townsfolk are bodies the walking player bumps into
// (TownsfolkService, in world space: camera/ walk calls it after the capital's people).

import { BufferAttribute, BufferGeometry, Color, DataTexture, DynamicDrawUsage, InstancedBufferAttribute, type InstancedMesh, LineBasicMaterial, LineSegments, NearestFilter, RGBAFormat, UnsignedByteType, Vector3 } from 'three';
import { LAYER_NO_INK, type LBContext, type System, type TownsfolkService, type TrackPose } from '../core/contracts';
import { dogGeometry, J, personGeometry, POSE_LEASH, posedHand } from '../people/figure';
import { peoplePatch } from '../people/shader';
import { LookFlag, Pose, type Look } from '../people/sim';
import { headLook, HeightFollower, kerbGlance, YawFollower } from '../people/track';
import { PALETTE } from '../render/palette';
import { groundOf, PAVE, QUAY_H, WALK } from '../roads/ground';
import { lampLayout, lampLight } from '../roads/lamps';
import { meshHeight } from '../roads/mesh';
import { terrainData } from '../terrain/data';
import { townSites } from '../towns';
import { planSteps, type Site } from '../towns/plan';
import { kmh } from '../traffic/names';
import { R } from '../world/config';
import { Biome } from '../world/planet';
import type { Settlement } from '../world/region/types';
import { hash3 } from '../world/rng';
import { chartToDir, dirToChart, v3, type Chart, type Vec3 } from '../world/sphere';
import { nightFactor, sunDirection } from '../world/sun';
import { anchoredLooks, folkFor, townsfolk, walkers, type Townsfolk } from './folk';
import { BODY, E, type Net, netSteps, PK, POSE, type Place } from './net';
import { S, TownSim } from './sim';

/** Trackable ids start here ('person:5000'), clear of the capital's. */
export const FIRST_ID = 5000;
/** The capital's people bands: everyone in below POP_LO, nobody above POP_HI; shadows below SHADOW_ALT. */
const POP_LO = 27;
const POP_HI = 58;
const SHADOW_ALT = 36;
const NEAR_R = 10;
const FAR_R = 21;
/** Anchored people per town at most (their look rows). */
const AMAX = 56;
const TEX_W = 5;
/** Share of the ride's view the kerb glance turns (as the capital's). */
const GLANCE_CAM = 0.6;
const EYE_Y = J.headY - 0.01;
const SIT_DROP = J.hipY - J.thighR;
const LIE = 0.26;
const DOG_FUR = [0xc98b4f, 0xf2e6d0, 0x3a3030, 0xe0b46a, 0x8a5a3a, 0xffffff, 0x9a8f87];
const COLLAR = [0xd9483b, 0x3d9ca8, 0xffb84d, 0x7fb04a];

interface Town {
  s: Settlement;
  site: Site;
  tf: Townsfolk;
  /** Walker 0's global index, walkers, dogs; texture rows from `row`: walkers 4 each, AMAX anchored, the dogs. */
  first: number;
  n: number;
  dogs: number;
  row: number;
  net: Net | null;
  sim: TownSim | null;
  job: Generator<void, Net, void> | null;
  /** Anchored places and looks; whether each is out now. */
  anch: Place[];
  aLooks: Look[];
  aOn: Uint8Array;
  active: boolean;
  /** How late in the night it is there (fixed steps). */
  late: number;
  /** Per walker then anchored: pop-in altitude; per walker: drawn slot (mesh · 1e5 + index) or −1. */
  popAt: Float32Array;
  slot: Int32Array;
  featured: number;
  cos: number;
}

const srgb = (hex: number, out: Uint8Array, o: number, a: number) => {
  out[o] = (hex >> 16) & 255;
  out[o + 1] = (hex >> 8) & 255;
  out[o + 2] = hex & 255;
  out[o + 3] = a;
};
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function upload(attr: { clearUpdateRanges(): void; addUpdateRange(o: number, c: number): void; needsUpdate: boolean }, count: number): void {
  attr.clearUpdateRanges();
  if (count > 0) attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}
/** A look row for the texture: a pose and what it carries in it. */
function row(data: Uint8Array, r: number, l: Look, pose: number): void {
  const o = r * TEX_W * 4;
  const f = l.flags & ~(pose === Pose.Walk ? 0 : LookFlag.Umbrella | LookFlag.Phone | (pose === Pose.Stand || pose === Pose.Lean ? 0 : LookFlag.Backpack | LookFlag.Bag));
  srgb(l.skin, data, o, l.hairStyle);
  srgb(l.shirt, data, o + 4, f & 255);
  srgb(l.legs, data, o + 8, f >> 8);
  srgb(l.hair, data, o + 12, pose);
  srgb(l.acc, data, o + 16, Math.round(l.bounce * 255));
}

export function createTownsfolkSystem(): System {
  const towns: Town[] = [];
  let meshes: InstancedMesh[] = [];
  let arr: Float32Array[] = [];
  let anim: Float32Array[] = [];
  let leash: LineSegments | null = null;
  let tex: DataTexture | null = null;
  let data = new Uint8Array(0);
  let ground: ((q: Vec3) => number) | null = null;
  let lamps: Array<{ q: Vec3; light: Vec3 }> = [];
  let ready = false;
  const untrack: Array<() => void> = [];
  let restore: (() => void) | null = null;
  /** Param townsfolk.show (A/B: --p townsfolk.show=false). */
  let shown = true;
  // townsfolk.popLift: raises the pop-in band (trailer descents: scripts/play-media/littlebig-cine.mjs)
  let popLift = { value: 0 };
  let unsub: (() => void) | null = null;
  const uRide = { value: -1 };
  const kk = new Int32Array(4);
  // the ride
  let rideStr: string | null = null;
  let rideG = -1;
  let inside = -1;
  const follow = new YawFollower();
  const lift = new HeightFollower();
  let followFor = -1;
  let followFrame = -1;
  let featT = -Infinity;
  // scratch
  const sd = v3();
  const W = new Float64Array(9);
  const pos = new Vector3();
  const tmp = new Vector3();
  const qd = v3();
  const qe = v3();
  const pq = { x: 0, z: 0 };
  const pc = { x: 0, z: 0 };
  // this frame's draw state (update sets it, emit reads it)
  let fCtx: LBContext | null = null;
  let fAlt = 0, fVisR = 0, fStreet = false, fLodK = 1, fRiding = false, fNearR = 1, fNight = 0;
  const hand = posedHand(1, POSE_LEASH[0], POSE_LEASH[1]);
  const collar = new Vector3(0, 0.42, 0.21);

  /** How late in the night it is at a town (as the capital's: night both a while ago and a while ahead). */
  const lateAt = (s: Settlement, t: number) => nightFactor(s.dir, sunDirection(t - 60, sd)) * nightFactor(s.dir, sunDirection(t + 40, sd));

  /** The town and local index of global walker g. */
  function townOf(g: number): Town | null {
    for (const T of towns) if (g >= T.first && g < T.first + T.n) return T;
    return null;
  }

  /** ctx.view.ride → the ridden townsperson (global index), or −1. */
  function rideOf(ctx: LBContext): number {
    const r = ctx.view.ride;
    if (r !== rideStr) {
      rideStr = r;
      rideG = r !== null && r.startsWith('person:') ? Number(r.slice(7)) - FIRST_ID : -1;
      if (!townOf(rideG)) rideG = -1;
    }
    return rideG;
  }

  /**
   * World point (into pos, and its unit up into qd) of plan (x, z) at height h in a chart, and the world
   * tangent (into qe) of the plan direction (fx, fz) there. Zero-alloc.
   */
  function world(c: Chart, x: number, z: number, h: number, fx: number, fz: number): void {
    chartToDir(c, x, z, qd);
    pos.set(qd.x * (R + h), qd.y * (R + h), qd.z * (R + h));
    chartToDir(c, x + fx * 0.05, z + fz * 0.05, qe);
    const k = (qe.x - qd.x) * qd.x + (qe.y - qd.y) * qd.y + (qe.z - qd.z) * qd.z;
    let wx = qe.x - qd.x - qd.x * k, wy = qe.y - qd.y - qd.y * k, wz = qe.z - qd.z - qd.z * k;
    const l = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
    qe.x = wx / l;
    qe.y = wy / l;
    qe.z = wz / l;
  }

  /** Instance k of `a`: at pos, figure up U, forward F (unit, orthogonal), scale s. Columns: left = U × F, U, F. */
  function matrix(a: Float32Array, k: number, ux: number, uy: number, uz: number, fx: number, fy: number, fz: number, s: number): void {
    const o = k * 16;
    a[o] = (uy * fz - uz * fy) * s;
    a[o + 1] = (uz * fx - ux * fz) * s;
    a[o + 2] = (ux * fy - uy * fx) * s;
    a[o + 3] = 0;
    a[o + 4] = ux * s;
    a[o + 5] = uy * s;
    a[o + 6] = uz * s;
    a[o + 7] = 0;
    a[o + 8] = fx * s;
    a[o + 9] = fy * s;
    a[o + 10] = fz * s;
    a[o + 11] = 0;
    a[o + 12] = pos.x;
    a[o + 13] = pos.y;
    a[o + 14] = pos.z;
    a[o + 15] = 1;
  }

  /** Walker i of town T at render fraction a: plan feet (W 0, 1), height (2), facing (3, 4), speed (5), gait (6), how seated (7), visible (8). */
  function poseOf(T: Town, i: number, a: number): void {
    const s = T.sim!, sc = T.tf.looks[i].scale;
    W[0] = s.px[i] + (s.x[i] - s.px[i]) * a;
    W[1] = s.pz[i] + (s.z[i] - s.pz[i]) * a;
    let fx = s.phx[i] + (s.hx[i] - s.phx[i]) * a, fz = s.phz[i] + (s.hz[i] - s.phz[i]) * a;
    const fl = Math.sqrt(fx * fx + fz * fz) || 1;
    fx /= fl;
    fz /= fl;
    let h = s.ph[i] + (s.h[i] - s.ph[i]) * a, sat = 0;
    if (s.st[i] === S.rest) {
      const p = T.net!.places[s.pl[i]];
      if (p.pose === POSE.sit || p.pose === POSE.cafe) {
        sat = smooth(0.25, 0.75, s.bl[i]);
        h += (p.h - SIT_DROP * sc - h) * sat;
      }
    }
    W[2] = h;
    W[3] = fx;
    W[4] = fz;
    W[5] = s.v[i];
    W[6] = s.pg[i] + (s.g[i] - s.pg[i]) * a;
    W[7] = sat;
    W[8] = s.vis[i];
  }

  /** The 'eyes' pose of global walker g at render time (the ridden one looks along its smoothed yaw). */
  function eyesOf(ctx: LBContext, g: number, out: TrackPose): boolean {
    const T = townOf(g);
    if (!T || !T.sim || !T.active || !ready) return false;
    const i = g - T.first, s = T.sim, ridden = rideOf(ctx) === g;
    if (!ridden && (s.st[i] === S.home || (T.slot[i] < 0 && i !== T.featured))) return false;
    const l = T.tf.looks[i], sc = l.scale;
    poseOf(T, i, ctx.time.alpha);
    let eye = l.flags & LookFlag.Kid ? J.neckY + (EYE_Y - J.neckY) * 1.22 : EYE_Y, fwd = 0.11;
    const amp = Math.min(1, Math.max(0, (W[5] - 0.05) / 1.05));
    if (!ctx.reducedMotion) {
      const ph = ((W[6] / (1.15 * sc)) % 1) * Math.PI * 2;
      eye += amp * 0.034 * (0.55 + l.bounce) * Math.cos(2 * ph);
      fwd += (eye - J.waistY) * Math.sin(amp * 0.06);
    }
    let fx = W[3], fz = W[4], h = W[2];
    if (ridden) {
      // (the camera takes 60 % of the kerb glance; its yaw and the ground under the feet eased)
      const face = Math.atan2(fz, fx);
      const target = face + (s.st[i] === S.wait ? GLANCE_CAM * kerbGlance(ctx.time.render * 1.6) : 0);
      if (followFor !== g) {
        follow.reset(target);
        lift.reset(h);
        followFor = g;
        followFrame = ctx.time.frame;
      } else if (followFrame !== ctx.time.frame) {
        follow.step(target, ctx.time.dt);
        lift.step(h, ctx.time.dt);
        followFrame = ctx.time.frame;
      }
      fx = Math.cos(follow.yaw);
      fz = Math.sin(follow.yaw);
      h = lift.h;
    }
    world(T.s.chart, W[0] + W[3] * fwd * sc, W[1] + W[4] * fwd * sc, h + eye * sc, fx, fz);
    out.pos.copy(pos);
    out.up.set(qd.x, qd.y, qd.z);
    out.fwd.set(qe.x, qe.y, qe.z);
    out.speed = W[5];
    return true;
  }

  /** The card's live line: speed, where and what. */
  function detailOf(ctx: LBContext, g: number): string {
    const T = townOf(g);
    if (!T?.sim || !T.net) return T?.s.name ?? '';
    const i = g - T.first, s = T.sim, N = T.net, k = N.kind[s.e[i]];
    if (s.st[i] === S.home) return `indoors · ${T.s.name}`;
    if (s.st[i] === S.rest) {
      const p = N.places[s.pl[i]];
      return p.pose === POSE.cafe ? 'at a café table' : p.k === PK.seat ? 'sitting down a while' : 'standing about';
    }
    if (s.st[i] === S.wait) return 'waiting to cross';
    const where = k === E.cross ? 'crossing the street' : k === E.square ? 'on the square' : k === E.quay ? 'on the quay' : k === E.pier ? 'out on the pier' : k === E.stub ? 'at a doorstep' : N.road[s.e[i]] >= 0 ? `on ${ctx.world.region.edges[N.road[s.e[i]]].name}` : T.s.name;
    return `${kmh(s.v[i])} · ${where}`;
  }

  /** Town T's net is done: its sim, its anchored people, their look rows. */
  function built(T: Town, net: Net, seed: number): void {
    T.net = net;
    T.job = null;
    T.sim = new TownSim(net, folkFor(net, T.tf, seed), seed ^ T.s.index);
    T.anch = net.places.filter((p) => p.anch).slice(0, AMAX);
    T.aLooks = anchoredLooks(T.s, T.anch.map((p) => p.pose), seed);
    T.aOn = new Uint8Array(T.anch.length).fill(1);
    T.popAt = Float32Array.from({ length: T.n + T.anch.length }, (_, k) => POP_LO + (POP_HI - POP_LO) * Math.pow(hash3(k, 93, seed ^ T.s.index), 1.4));
    T.aLooks.forEach((l, k) => {
      const p = T.anch[k].pose;
      row(data, T.row + 4 * T.n + k, l, p === POSE.lean ? Pose.Lean : p === POSE.chat ? Pose.Stand : p === POSE.sit ? Pose.Sit : Pose.Walk);
    });
    if (tex) tex.needsUpdate = true;
  }

  /** Run town T's net job for up to `ms` (all of it: Infinity). */
  function drive(T: Town, ms: number, seed: number): void {
    if (!T.job || !ground) return;
    const end = performance.now() + ms;
    for (;;) {
      const r = T.job.next();
      if (r.done) return built(T, r.value, seed);
      if (performance.now() > end) return;
    }
  }

  /** Emit one figure at pos (W[] set by the caller): its look row, gait, light and head; returns the mesh slot code or −1. */
  function emit(T: Town, k: number, rowI: number, sc0: number, ux: number, uy: number, uz: number, fx: number, fy: number, fz: number, phase: number, amp: number, lx: number, lz: number, look0: number, ridden: boolean, vis0: number, seedL: number): number {
    const ctx = fCtx!, eye = ctx.view.eye, fwd = ctx.view.forward, rm = ctx.reducedMotion, alt = fAlt, visR = fVisR;
    const ex = pos.x - eye.x, ey = pos.y - eye.y, ez = pos.z - eye.z;
    const d2 = ex * ex + ey * ey + ez * ez, dist = Math.sqrt(d2);
    if (!ridden && (dist > visR || ex * fwd.x + ey * fwd.y + ez * fwd.z < 0.3 * dist - 2.5)) return -1;
    const fade = ridden ? 1 : Math.min(1, Math.max(0, T.popAt[k] - alt)) * Math.min(1, Math.max(0, (visR - dist) / 6));
    const grow = rm ? 1 : ctx.reveal.spring(fade);
    if (grow < 0.01 || fade <= 0) return -1;
    const sc = sc0 * grow;
    // personal space: someone right at a street-level eye dithers out (the ridden one never)
    const pl = pos.length();
    const up = Math.min(1.7 * sc, Math.max(0, -(ex * pos.x + ey * pos.y + ez * pos.z) / pl));
    const qx = ex + (pos.x / pl) * up, qy = ey + (pos.y / pl) * up, qz = ez + (pos.z / pl) * up;
    const ps = ridden ? 1 : Math.min(1, Math.max(0, (Math.sqrt(qx * qx + qy * qy + qz * qz) - fNearR + 0.2) / 0.2));
    if (ps < 0.15) return -1;
    if (ridden) {
      const hx = ex + (pos.x / pl) * 1.47 * sc, hy = ey + (pos.y / pl) * 1.47 * sc, hz = ez + (pos.z / pl) * 1.47 * sc, hd2 = hx * hx + hy * hy + hz * hz;
      if ((inside >= 0 && hd2 < 1.44) || hd2 < 0.1225) uRide.value = rowI;
    }
    const vis = (ps < 1 ? 0.35 + (0.65 * (ps - 0.15)) / 0.85 : 1) * (rm ? fade : 1) * vis0;
    if (vis < 0.03) return -1;
    const m = dist * fLodK < NEAR_R ? 0 : dist * fLodK < FAR_R ? 1 : 2, j = kk[m]++;
    matrix(arr[m], j, ux, uy, uz, fx, fy, fz, sc);
    let look = look0;
    if (fStreet && d2 < 64 && !ridden) {
      const o = j * 16, A = arr[m];
      look += headLook(Math.atan2(-(A[o] * ex + A[o + 1] * ey + A[o + 2] * ez), -(A[o + 8] * ex + A[o + 9] * ey + A[o + 10] * ez)), dist, seedL, fRiding);
    }
    let lit = 0;
    if (fNight > 0.02) {
      const L = T.net!.lights;
      let best = 0;
      for (let q = 0; q < L.length; q += 3) best = Math.max(best, 1 - ((L[q] - lx) ** 2 + (L[q + 1] - lz) ** 2) / L[q + 2]);
      lit = Math.round(31 * fNight * best * best);
    }
    const A4 = anim[m];
    A4[j * 4] = rowI + 0.9 * (1 - vis);
    A4[j * 4 + 1] = phase;
    A4[j * 4 + 2] = amp + 2 * lit;
    A4[j * 4 + 3] = Math.max(-1.1, Math.min(1.1, look));
    return m * 100000 + j;
  }

  /** Push a body of radius r at unit dir out of every townsperson standing near it (an active town's), into out. */
  function pushOut(dir: Vec3, r: number, out: Vec3): boolean {
    for (const T of towns) {
      const s = T.sim;
      if (!T.active || !s || dir.x * T.s.dir.x + dir.y * T.s.dir.y + dir.z * T.s.dir.z < T.cos) continue;
      dirToChart(T.s.chart, dir, pq);
      let moved = false;
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < s.n + T.anch.length; k++) {
          const w = k < s.n;
          if (w ? s.st[k] === S.home : !T.aOn[k - s.n] || T.anch[k - s.n].pose === POSE.lie) continue;
          const bx = w ? s.x[k] : T.anch[k - s.n].x, bz = w ? s.z[k] : T.anch[k - s.n].z;
          const dx = pq.x - bx, dz = pq.z - bz, d = Math.sqrt(dx * dx + dz * dz), m = BODY + r;
          if (d >= m || d < 1e-6) continue;
          pq.x = bx + (dx / d) * m;
          pq.z = bz + (dz / d) * m;
          moved = true;
        }
      }
      if (moved) chartToDir(T.s.chart, pq.x, pq.z, out);
      return moved;
    }
    return false;
  }

  return {
    name: 'townsfolk',
    stage: 2,
    async init(ctx: LBContext) {
      const region = ctx.world.region, planet = ctx.world.planet, seed = region.seed;
      const showP = ctx.params.toggle('townsfolk.show', { label: "townsfolk: the towns' people", value: true });
      shown = showP.value;
      popLift = ctx.params.number('townsfolk.popLift', { label: 'townsfolk: lift the pop-in band (m, trailer descents)', min: 0, max: 300, value: 0 });
      unsub = ctx.params.onChange((p) => {
        if (p === showP) shown = showP.value;
      });
      // the towns' plans (T1's, planned once per world; planned here if the towns system is off)
      let sites = townSites.get(region);
      if (!sites) {
        const job = planSteps(region, (d) => planet.heightAt(d), (d) => planet.biomeAt(d) === Biome.Beach);
        let r = job.next();
        while (!r.done) {
          await ctx.yield();
          r = job.next();
        }
        sites = r.value;
      }
      ground = groundOf(region, meshHeight(terrainData(planet, ctx.q.terrainDetail)));
      await ctx.yield();
      // the lamps (H1's layout: their poles are obstacles, their pools light people at night)
      lamps = lampLayout(region, WALK, PAVE, QUAY_H).map((l) => {
        const o = v3();
        lampLight(l, 0, o);
        return { q: l.q, light: o };
      });
      await ctx.yield();
      const crossings = ctx.services.transit?.crossings ?? [];
      let first = 0, rows = 0;
      for (const s of region.settlements) {
        const site = sites.find((x) => x.id === s.id);
        if (s.style === 'capital' || !site) continue;
        const tf = townsfolk(s, walkers(s, site), seed), n = tf.looks.length, dogs = tf.dog.filter((x) => x).length;
        towns.push({
          s, site, tf, first, n, dogs, row: rows, net: null, sim: null, job: netSteps(region, s, site, ground, crossings, lamps), anch: [], aLooks: [], aOn: new Uint8Array(0), active: false, late: 0,
          popAt: new Float32Array(0), slot: new Int32Array(n).fill(-1), featured: -1, cos: Math.cos((Math.max(site.r, s.padR) + 12) / R),
        });
        first += n;
        rows += 4 * n + AMAX + dogs;
      }
      // the look texture: walkers' four rows (walking, sitting, chatting, at a café), the anchored ones', the dogs'
      data = new Uint8Array(TEX_W * 4 * Math.max(1, rows));
      for (const T of towns) {
        T.tf.looks.forEach((l, i) => [Pose.Walk, Pose.Sit, Pose.Stand, Pose.Cafe].forEach((p, k) => row(data, T.row + 4 * i + k, l, p)));
        for (let d = 0; d < T.dogs; d++) {
          const o = (T.row + 4 * T.n + AMAX + d) * TEX_W * 4, fur = DOG_FUR[Math.floor(hash3(d, 1, seed ^ T.s.index) * DOG_FUR.length)];
          srgb(fur, data, o, 0);
          srgb(fur === 0xffffff ? 0x8a5a3a : 0xffffff, data, o + 4, 0);
          srgb(COLLAR[d % 4], data, o + 8, 0);
        }
      }
      tex = ctx.track(new DataTexture(data, TEX_W, Math.max(1, rows), RGBAFormat, UnsignedByteType));
      tex.minFilter = tex.magFilter = NearestFilter;
      tex.needsUpdate = true;
      await ctx.yield();
      // the capital's people program (the same patch key: no new compile), our own looks
      const mat = ctx.toon.material({ name: 'townsfolk', vertexColors: true, reveal: 'object', revealDuration: 0.6, rim: 0.45, patch: peoplePatch(tex, uRide) });
      mat.defines = { ...mat.defines, PP_COLOR: '' };
      const total = first + towns.length * AMAX;
      const dogs = Math.max(1, towns.reduce((a, T) => a + T.dogs, 0));
      meshes = [personGeometry(0), personGeometry(1), personGeometry(2), dogGeometry()].map((g, m) => {
        ctx.track(g);
        const cnt = Math.max(1, m < 3 ? total : dogs);
        g.setAttribute('aAnim', new InstancedBufferAttribute(new Float32Array(cnt * 4), 4).setUsage(DynamicDrawUsage));
        const mesh = ctx.toon.instanced(g, mat, cnt);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.name = ['townsfolk', 'townsfolk:mid', 'townsfolk:far', 'townsfolk:dogs'][m];
        return mesh;
      });
      arr = meshes.map((m) => m.instanceMatrix.array as Float32Array);
      anim = meshes.map((m) => (m.geometry.getAttribute('aAnim') as InstancedBufferAttribute).array as Float32Array);
      const lg = ctx.track(new BufferGeometry());
      lg.setAttribute('position', new BufferAttribute(new Float32Array(dogs * 12), 3).setUsage(DynamicDrawUsage));
      const lm = ctx.track(new LineBasicMaterial({ color: new Color().copy(PALETTE.ink).lerp(new Color('#6b4a33'), 0.35) }));
      leash = new LineSegments(lg, lm);
      leash.frustumCulled = false;
      leash.layers.set(LAYER_NO_INK);
      leash.visible = false;
      leash.name = 'townsfolk:leash';
      ctx.scene.add(...meshes, leash);
      for (const m of meshes) m.count = 1;
      await ctx.compile();
      for (const m of meshes) m.count = 0;
      mat.userData.lbUniforms.lbRevealDelay.value = ctx.reveal.slot(0.6);
      // every walker followable
      for (const T of towns)
        for (let i = 0; i < T.n; i++) {
          const g = T.first + i;
          untrack.push(
            ctx.services.track.register({
              id: `person:${FIRST_ID + g}`,
              kind: 'person',
              label: T.tf.cards[i].label,
              sub: T.tf.cards[i].sub,
              view: 'eyes',
              radius: Math.round(85 * T.tf.looks[i].scale) / 100,
              pose: (c, out) => eyesOf(c, g, out),
              detail: (c) => detailOf(c, g),
              setRidden(on) {
                if (on) inside = g;
                else if (inside === g) inside = -1;
              },
            }),
          );
        }
      // bodies to the walking player (camera/ walk: world space, so it holds anywhere on the planet)
      const svc: TownsfolkService = { pushOut };
      ctx.services.townsfolk = svc;
      restore = () => {
        if (ctx.services.townsfolk === svc) ctx.services.townsfolk = undefined;
      };
      if (ctx.shotMode) meshes[0].userData.townsfolk = towns;
      ready = true;
    },

    fixedUpdate(ctx) {
      if (!ready) return;
      const tr = ctx.services.transit, dt = ctx.time.fixedDt, v = ctx.view, rg = rideOf(ctx);
      // (we write busy: cleared, then set by every town stepped)
      tr?.busy.fill(0);
      for (const T of towns) {
        const s = T.sim;
        if (!T.active || !s) continue;
        T.late = lateAt(T.s, ctx.time.t);
        s.rider = rg >= T.first && rg < T.first + T.n ? rg - T.first : -1;
        // the walking player is someone to walk round
        s.camX = s.camZ = NaN;
        if (v.mode === 'explore' && v.street && v.focus.x * T.s.dir.x + v.focus.y * T.s.dir.y + v.focus.z * T.s.dir.z > T.cos) {
          dirToChart(T.s.chart, v.focus, pq);
          s.camX = pq.x;
          s.camZ = pq.z;
        }
        s.step(dt, tr ? tr.busy : null, tr ? tr.blocked : null, T.late);
      }
    },

    onTimeJump(ctx) {
      for (const T of towns) if (T.active && T.sim) T.sim.placeAt(ctx.time.t, (T.late = lateAt(T.s, ctx.time.t)));
      followFor = -1;
    },

    update(ctx) {
      if (!ready || !leash) return;
      const v = ctx.view, alt = v.altTerrain, f = v.focus, seed = ctx.world.region.seed, rg = rideOf(ctx);
      // which towns are in range (people drawn below POP_HI; the camera's town, the ridden one's; from
      // high up the one under the view, for a ride from orbit), their nets built first
      let nearT: Town | null = null, nearD = Infinity;
      for (const T of towns) {
        const arc = Math.acos(Math.max(-1, Math.min(1, f.x * T.s.dir.x + f.y * T.s.dir.y + f.z * T.s.dir.z))) * R - T.site.r;
        if (arc < nearD) {
          nearD = arc;
          nearT = T;
        }
      }
      let busy = false;
      for (const T of towns) {
        const arc = Math.acos(Math.max(-1, Math.min(1, f.x * T.s.dir.x + f.y * T.s.dir.y + f.z * T.s.dir.z))) * R - T.site.r;
        const ridden = rg >= T.first && rg < T.first + T.n;
        const want = ridden || (T === nearT && arc < 260) || (alt < 140 && arc < (T.active ? 150 : 110) + alt);
        if (want && !T.net) {
          drive(T, ctx.shotMode ? Infinity : 8, seed);
          busy = true;
        }
        if (want && T.sim && !T.active) {
          T.active = true;
          T.sim.placeAt(ctx.time.t, (T.late = lateAt(T.s, ctx.time.t)));
        } else if (!want && T.active) T.active = false;
      }
      // the rest built in the background, a slice a frame
      if (!busy) for (const T of towns) if (T.job) {
        drive(T, 2, seed);
        break;
      }
      // the featured walker (rideable while not drawn): in the town under the view, walking, nearest its focus
      if (ctx.time.render - featT > 0.5 || ctx.time.render < featT) {
        featT = ctx.time.render;
        for (const T of towns) {
          T.featured = -1;
          if (!T.active || !T.sim || T !== nearT) continue;
          dirToChart(T.s.chart, f, pq);
          let bd = Infinity;
          for (let i = 0; i < T.n; i++) {
            const s = T.sim;
            if (s.st[i] !== S.walk || s.v[i] < 0.6 || T.net!.kind[s.e[i]] === E.stub || T.net!.kind[s.e[i]] === E.cross) continue;
            const d = Math.hypot(s.x[i] - pq.x, s.z[i] - pq.z);
            if (d < bd) {
              bd = d;
              T.featured = i;
            }
          }
        }
      }
      if (followFor >= 0 && rg !== followFor) followFor = -1;
      // ── draw: what is near and in front, packed ──
      kk.fill(0);
      uRide.value = -1;
      let any = false;
      for (const T of towns) any ||= T.active;
      const pa = alt - popLift.value;
      const show = shown && any && (pa < POP_HI || rg >= 0);
      for (const m of meshes) m.visible = show;
      leash.visible = show && (pa < POP_LO + 0.5 || rg >= 0);
      if (!show) {
        for (const T of towns) T.slot.fill(-1);
        for (const m of meshes) m.count = 0;
        return;
      }
      meshes[2].castShadow = meshes[3].castShadow = pa < SHADOW_ALT;
      const a = ctx.time.alpha;
      const visR = Math.sqrt(2 * 162 * (Math.max(0, alt) + 0.3)) + 30;
      fCtx = ctx;
      fAlt = pa;
      fVisR = visR;
      fNight = ctx.uniforms.lbNight.value;
      fStreet = alt < 2.6;
      fLodK = Math.tan((v.fov * Math.PI) / 360) / Math.tan((35 * Math.PI) / 180);
      fRiding = inside >= 0 || rg >= 0;
      fNearR = (fRiding ? 0.62 : 1.0) + (fRiding ? 0.25 : 0.5) * smooth(-0.15, -0.35, v.pitch);
      for (const T of towns) {
        T.slot.fill(-1);
        const s = T.sim, N = T.net;
        if (!T.active || !s || !N) continue;
        const C = T.s.chart, late = T.late;
        // plan pre-cull: the camera's plan point in this town's chart
        dirToChart(C, f, pc);
        const preR = visR + alt + 8;
        for (let i = 0; i < T.n; i++) {
          const ridden = T.first + i === rg;
          if (s.st[i] === S.home && s.vis[i] <= 0) continue;
          if (!ridden && (s.x[i] - pc.x) ** 2 + (s.z[i] - pc.z) ** 2 > preR * preR) continue;
          poseOf(T, i, a);
          world(C, W[0], W[1], W[2], W[3], W[4]);
          const l = T.tf.looks[i], st = s.st[i];
          const p = st === S.rest ? N.places[s.pl[i]] : null;
          const off = p && s.bl[i] > 0.3 ? (p.pose === POSE.sit ? 1 : p.pose === POSE.cafe ? 3 : p.pose === POSE.chat ? 2 : 0) : 0;
          const amp = Math.min(1, Math.max(0, (W[5] - 0.05) / 1.05));
          const phase = ((W[6] / (1.15 * l.scale)) % 1) * Math.PI * 2;
          const glance = st === S.wait ? -kerbGlance(ctx.time.render + i * 1.7) : 0;
          T.slot[i] = emit(T, i, T.row + 4 * i + off, l.scale, qd.x, qd.y, qd.z, qe.x, qe.y, qe.z, phase, amp, W[0], W[1], glance, ridden, W[8], l.seed);
        }
        // the ones who stay put (the hour sends sunbathers home and thins the rest, out of view only)
        for (let k = 0; k < T.anch.length; k++) {
          const p = T.anch[k], want = p.pose === POSE.lie ? +(late < 0.25) : +(hash3(k, 92, seed) >= late * 0.6);
          if ((p.x - pc.x) ** 2 + (p.z - pc.z) ** 2 > preR * preR) {
            T.aOn[k] = want;
            continue;
          }
          const l = T.aLooks[k];
          if (p.pose === POSE.lie) {
            // lying on a lounger: feet at the place, the body up its raised back toward the head, face up
            world(C, p.x, p.z, p.h, p.fx, p.fz);
            const c = Math.cos(LIE), sn = Math.sin(LIE);
            pos.x += qd.x * 0.12;
            pos.y += qd.y * 0.12;
            pos.z += qd.z * 0.12;
            const ux = qe.x * c + qd.x * sn, uy = qe.y * c + qd.y * sn, uz = qe.z * c + qd.z * sn;
            const sl = emit(T, T.n + k, T.row + 4 * T.n + k, l.scale, ux, uy, uz, qd.x * c - qe.x * sn, qd.y * c - qe.y * sn, qd.z * c - qe.z * sn, 0, 0, p.x, p.z, 0, false, 1, l.seed);
            if (sl < 0) T.aOn[k] = want;
            else if (!T.aOn[k]) kk[(sl / 100000) | 0]--;
            continue;
          }
          const sit = p.pose === POSE.sit;
          world(C, p.x, p.z, sit ? p.h - SIT_DROP * l.scale : p.h, p.fx, p.fz);
          const sl = emit(T, T.n + k, T.row + 4 * T.n + k, l.scale, qd.x, qd.y, qd.z, qe.x, qe.y, qe.z, 0, 0, p.x, p.z, 0, false, 1, l.seed);
          // (out of view it follows the hour; in view it stays as it is)
          if (sl < 0) T.aOn[k] = want;
          else if (!T.aOn[k]) kk[(sl / 100000) | 0]--;
        }
      }
      // dogs and leashes
      const la = leash.geometry.getAttribute('position') as BufferAttribute, L = la.array as Float32Array;
      let q = 0;
      for (const T of towns) {
        const s = T.sim;
        if (!T.active || !s) continue;
        for (let d = 0; d < s.dOwner.length && d < T.dogs; d++) {
          const o = s.dOwner[d], so = T.slot[o];
          if (so < 0 || s.st[o] === S.home) continue;
          const x = s.dpx[d] + (s.dx[d] - s.dpx[d]) * a, z = s.dpz[d] + (s.dz[d] - s.dpz[d]) * a;
          world(T.s.chart, x, z, s.ph[o] + (s.h[o] - s.ph[o]) * a, s.dhx[d], s.dhz[d]);
          const sc = 0.8 + hash3(d, 3, seed) * 0.45;
          matrix(arr[3], q, qd.x, qd.y, qd.z, qe.x, qe.y, qe.z, sc);
          const g = s.dpg[d] + (s.dg[d] - s.dpg[d]) * a;
          const D4 = anim[3];
          D4[q * 4] = T.row + 4 * T.n + AMAX + d;
          D4[q * 4 + 1] = ((g / (0.62 * sc)) % 1) * Math.PI * 2;
          D4[q * 4 + 2] = Math.min(1, Math.hypot(s.dx[d] - s.dpx[d], s.dz[d] - s.dpz[d]) / ctx.time.fixedDt / 1.3);
          D4[q * 4 + 3] = 0;
          // the leash: the owner's left hand → the collar, sagging a little
          const om = (so / 100000) | 0, oj = so - om * 100000, A = arr[om], B = arr[3], O = oj * 16, P = q * 16;
          tmp.set(A[O] * hand.x + A[O + 4] * hand.y + A[O + 8] * hand.z + A[O + 12], A[O + 1] * hand.x + A[O + 5] * hand.y + A[O + 9] * hand.z + A[O + 13], A[O + 2] * hand.x + A[O + 6] * hand.y + A[O + 10] * hand.z + A[O + 14]);
          const e = q * 12;
          L[e] = tmp.x;
          L[e + 1] = tmp.y;
          L[e + 2] = tmp.z;
          tmp.set(B[P] * collar.x + B[P + 4] * collar.y + B[P + 8] * collar.z + B[P + 12], B[P + 1] * collar.x + B[P + 5] * collar.y + B[P + 9] * collar.z + B[P + 13], B[P + 2] * collar.x + B[P + 6] * collar.y + B[P + 10] * collar.z + B[P + 14]);
          L[e + 9] = tmp.x;
          L[e + 10] = tmp.y;
          L[e + 11] = tmp.z;
          const mx = (L[e] + tmp.x) / 2, my = (L[e + 1] + tmp.y) / 2, mz = (L[e + 2] + tmp.z) / 2, sag = 1 - 0.12 / Math.sqrt(mx * mx + my * my + mz * mz);
          L[e + 3] = L[e + 6] = mx * sag;
          L[e + 4] = L[e + 7] = my * sag;
          L[e + 5] = L[e + 8] = mz * sag;
          q++;
        }
      }
      kk[3] = q;
      for (let m = 0; m < 4; m++) {
        meshes[m].count = kk[m];
        upload(meshes[m].instanceMatrix, kk[m] * 16);
        upload(meshes[m].geometry.getAttribute('aAnim') as InstancedBufferAttribute, kk[m] * 4);
      }
      leash.geometry.setDrawRange(0, q * 4);
      upload(la, q * 12);
    },

    dispose() {
      for (const off of untrack) off();
      untrack.length = 0;
      restore?.();
      restore = null;
      unsub?.();
      unsub = null;
      for (const m of meshes) m.dispose();
      meshes = [];
      leash = null;
      tex = null;
      towns.length = 0;
      ready = false;
    },
  };
}
