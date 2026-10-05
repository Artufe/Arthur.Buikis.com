// People and street life (B2). The "zoom in really close" reward: chunky toy pedestrians walking
// the sidewalks, the plaza loop, the park path and the market lane with a lively vertex-shader gait,
// waiting at zebra crossings (ctx.services.crossings), a few walking dogs, people on benches, at
// café tables and on the fountain rim, waiting at bus stops and chatting in little groups. They
// glance at you when you walk past, and stand in the warm light of the street lamps at night.
//
// Rendering: one toon program (people/shader.ts) shared by four instanced meshes (people in three
// LODs, dogs) plus leash lines. Every frame the instances near the camera and in front of it are
// packed into the first slots (matrix + aAnim), so the cost follows what is on screen. On the way
// down the crowd builds up: each person pops in (a springy scale from the feet, like the world's
// reveal) at their own altitude between POP_HI and POP_LO m (ViewState.altTerrain), and out at the
// edge of the draw radius, which reaches past the planet's horizon (nobody pops in view). Under
// reduced motion both are a dither fade instead. Someone at the player's eye dithers out over a
// short, coarse band and is skipped below it (no dot screen in the frame).
//
// v2 (L1): every walker is a Trackable ('person:<i>', view 'eyes'; people/track.ts). The one being
// ridden (ctx.view.ride) is simulated and drawn at any altitude, never dithered at the eye, never
// sent home at night; while the camera is inside it (setRidden) its head is hidden in the colour
// pass only (its shadow keeps its head), and its dog trots on. The sim keeps everyone a camera's
// berth from it (people/sim.ts `rider`, wider round a kid's low eye), holds it on zebras, keeps it
// on the far side of the pavement from the cars and well back from a kerb, and has it skip long
// kerb waits, so no face, back or turning car fills the lens. Walkers waiting at a kerb glance at
// the traffic (left, right, left), and so does the eyes ride, at 60 %. Outside 'explore' the camera
// is no pedestrian: walkers neither dodge it nor clear its lens; after a ride the walker just
// ridden walks on out of the camera (PeopleSim.free).

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  type InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from 'three';
import { LAYER_NO_INK, type LBContext, type System, type TrackPose } from '../core/contracts';
import { PALETTE } from '../render/palette';
import { CITY_SURFACE_R, SEED } from '../world/config';
import { CITY_CHART as CC, planFrame, planHeadingToWorld, toSphere } from '../world/city/frame';
import { hash3, Rng } from '../world/rng';
import { v3 } from '../world/sphere';
import { CITY_DIR, nightFactor, sunDirection } from '../world/sun';
import { dogGeometry, J, personGeometry, POSE_LEASH, posedHand } from './figure';
import { makeIdlers } from './idlers';
import { peoplePatch } from './shader';
import { LensWatch, LookFlag, makeLooks, makeTraits, PeopleSim, Pose, SETTLE_STEPS, type Look, type WalkerTraits } from './sim';
import { eyeToWorld, HeightFollower, kerbGlance, kerbWait, walkerCards, walkerEye, walkPlace, YawFollower, type PlanPose } from './track';
import { compass, kmh } from '../traffic/names';

/** Altitude band (m, ViewState.altTerrain): everyone is in below POP_LO, nobody above POP_HI. */
const POP_LO = 27;
const POP_HI = 58;
/** Above this altitude people cast no shadow (a few pixels each from up there). */
const SHADOW_ALT = 36;
/** Sea-level radius of the city ground (m) and a person's height, for the horizon distance. */
const GROUND_R = 162;
const WALKERS = 230;
const DOG_SHARE = 0.11;
const TEX_W = 5;
/** LOD distances (m at a 70° field of view; scaled with the view's FOV so they follow screen size). */
const NEAR_R = 10;
const FAR_R = 21;
/** Share of walkers / idlers gone home at full night. */
const THIN_WALK = 0.4;
const THIN_IDLE = 0.55;
/** pickFeatured: distances (m) past this all count the same. */
const FEAT_FAR = 40;
/** Share of the kerb glance the eyes ride turns the view by. */
const GLANCE_CAM = 0.6;
/** The berth's scale riding a kid's eyes (people/sim.ts riderK). */
const KID_BERTH = 1.3;
/** Seconds after a ride in which the camera does not hold up the walker just ridden. */
const FREE_S = 4;

const DOG_FUR = [0xc98b4f, 0xf2e6d0, 0x3a3030, 0xe0b46a, 0x8a5a3a, 0xffffff, 0x9a8f87];
const DOG_PATCH = [0xffffff, 0x8a5a3a, 0x3a3030, 0xf2e6d0, 0xc98b4f];
const COLLAR = [0xd9483b, 0x3d9ca8, 0xffb84d, 0x7fb04a];

function srgb(hex: number, out: Uint8Array, o: number, a: number): void {
  out[o] = (hex >> 16) & 255;
  out[o + 1] = (hex >> 8) & 255;
  out[o + 2] = hex & 255;
  out[o + 3] = a;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function upload(attr: { clearUpdateRanges(): void; addUpdateRange(o: number, c: number): void; needsUpdate: boolean }, count: number): void {
  attr.clearUpdateRanges();
  if (count > 0) attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}

/**
 * How late in the night it is over the city at sim time t (0..1): night both a while ago and still
 * a while ahead, so evenings stay lively and the crowd thins only from ~2.5 h after dusk to ~1.5 h
 * before dawn (DAY_LENGTH 480 s: 20 s ≈ 1 h).
 */
const night = (t: number) => nightFactor(CITY_DIR, sunDirection(t));
const nightAt = (t: number) => night(t - 60) * night(t + 40);

export function createPeopleSystem(): System {
  let sim: PeopleSim | null = null;
  let meshes: InstancedMesh[] = [];
  let leash: LineSegments | null = null;
  let looks: Look[] = [];
  /** Per idler: 1 = there. */
  let idleOn = new Uint8Array(0);
  /** Per person: the altitude below which they pop in. */
  let popAt = new Float32Array(0);
  /** Lamps: x, z, radius of their pool. */
  let lamps = new Float64Array(0);
  let slot = new Int32Array(0);
  let arr: Float32Array[] = [];
  let anim: Float32Array[] = [];
  const kk = new Int32Array(4);
  let gs = new Float32Array(0);
  /** Per walker: its fade (reduced motion) for its dog. */
  let gv = new Float32Array(0);
  let ready = false;
  const lastEye = new Vector3(1e9, 0, 0);
  const lens = new LensWatch();
  // v2 (L1): trackables and the ride
  let traits: WalkerTraits[] = [];
  const untrack: Array<() => void> = [];
  /** Per walker: how much it is waiting at a kerb (smoothed), its glance phase. */
  let gw = new Float32Array(0);
  let gph = new Float32Array(0);
  /** The walker the camera rides (-1: none), parsed from ctx.view.ride once per change. */
  let rid = -1;
  let rideStr: string | null = null;
  /** setRidden: the camera is inside walker `inside`'s head (-1: none). */
  let inside = -1;
  /**
   * The walker nearest the view's focus (with hysteresis): rideable even while the crowd is not
   * drawn (pose() true), so the dock's people mode works from orbit, flying down into their eyes.
   * Only one, so a click on the city from up there never lands on someone invisible elsewhere.
   */
  let featured = -1;
  /** Per walker: walkers within 8 m (pickFeatured), and when that was counted. */
  let crowd = new Uint8Array(0);
  /** Per walker: a face in front of it (pickFeatured), counted with the crowd. */
  let facing = new Uint8Array(0);
  let crowdT = -Infinity;
  const uRide = { value: -1 };
  const follow = new YawFollower();
  const lift = new HeightFollower();
  let followFor = -1;
  let followFrame = -1;
  /** The walker last ridden, and how long it still walks through the camera after the ride. */
  let lastRid = -1;
  let freeT = 0;
  const pe: PlanPose = { x: 0, z: 0, h: 0, fx: 0, fz: 0, speed: 0 };
  const placeCache = new Map<number, string>();

  // scratch
  const fr = { up: v3(), ax: v3(), az: v3() };
  const pos = v3();
  const tmp = new Vector3();
  const hand = posedHand(1, POSE_LEASH[0], POSE_LEASH[1]);
  const collar = new Vector3(0, 0.42, 0.21);

  /**
   * Write instance k's matrix: feet at the world point pos (toSphere of the plan point), facing
   * plan (W[0], W[1]), scale W[2] (arguments through W: doubles crossing a call box, i.e.
   * allocate). The plan axes there are the city centre's carried over to pos's tangent plane:
   * exact along the plan axes, a degree or two off on the diagonals at the plateau's edge (a
   * person's facing), and no chart evaluation per person.
   */
  const W = new Float64Array(3);
  const AX0 = v3();
  function writeMatrix(arr: Float32Array, k: number): void {
    const fx = W[0];
    const fz = W[1];
    const s = W[2];
    const pl = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
    const u = fr.up;
    u.x = pos.x / pl;
    u.y = pos.y / pl;
    u.z = pos.z / pl;
    // ax = AX0 projected onto the tangent plane; az = ax × up
    const pa = AX0.x * u.x + AX0.y * u.y + AX0.z * u.z;
    let ax = AX0.x - u.x * pa;
    let ay = AX0.y - u.y * pa;
    let az = AX0.z - u.z * pa;
    const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    const bx = ay * u.z - az * u.y;
    const by = az * u.x - ax * u.z;
    const bz = ax * u.y - ay * u.x;
    let wx = ax * fx + bx * fz;
    let wy = ay * fx + by * fz;
    let wz = az * fx + bz * fz;
    const l = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
    wx /= l;
    wy /= l;
    wz /= l;
    // columns: left = up × forward, up, forward
    const o = k * 16;
    arr[o] = (u.y * wz - u.z * wy) * s;
    arr[o + 1] = (u.z * wx - u.x * wz) * s;
    arr[o + 2] = (u.x * wy - u.y * wx) * s;
    arr[o + 3] = 0;
    arr[o + 4] = u.x * s;
    arr[o + 5] = u.y * s;
    arr[o + 6] = u.z * s;
    arr[o + 7] = 0;
    arr[o + 8] = wx * s;
    arr[o + 9] = wy * s;
    arr[o + 10] = wz * s;
    arr[o + 11] = 0;
    arr[o + 12] = pos.x;
    arr[o + 13] = pos.y;
    arr[o + 14] = pos.z;
    arr[o + 15] = 1;
  }

  /** World point of a figure-space point under instance k's matrix. */
  function apply(arr: Float32Array, k: number, p: Vector3, out: Vector3): Vector3 {
    const o = k * 16;
    return out.set(
      arr[o] * p.x + arr[o + 4] * p.y + arr[o + 8] * p.z + arr[o + 12],
      arr[o + 1] * p.x + arr[o + 5] * p.y + arr[o + 9] * p.z + arr[o + 13],
      arr[o + 2] * p.x + arr[o + 6] * p.y + arr[o + 10] * p.z + arr[o + 14],
    );
  }

  /** Warm light (0..1) from the nearest street lamps at plan (x, z). */
  function lampLight(x: number, z: number): number {
    let best = 0;
    for (let k = 0; k < lamps.length; k += 3) {
      const q = 1 - ((lamps[k] - x) ** 2 + (lamps[k + 1] - z) ** 2) / lamps[k + 2];
      if (q > best) best = q;
    }
    return best * best;
  }

  /** Who is out at this hour (time jumps: everyone at once; live: only people out of view change). */
  function thinAll(night: number): void {
    if (!sim) return;
    for (let i = 0; i < sim.n; i++) sim.on[i] = hash3(i, 91, SEED) >= night * THIN_WALK ? 1 : 0;
    for (let k = 0; k < idleOn.length; k++) idleOn[k] = hash3(k, 92, SEED) >= night * THIN_IDLE ? 1 : 0;
  }

  /** A cut to street level: nobody in the lens (sim.clearAround, in the camera's plan frame). */
  function clearView(ctx: LBContext): void {
    const v = ctx.view;
    if (!sim || v.mode !== 'explore' || v.altTerrain > 3 || v.cityDist > ctx.world.city.radius) return;
    planFrame(v.cityX, v.cityZ, fr);
    const fx = v.forward.x * fr.ax.x + v.forward.y * fr.ax.y + v.forward.z * fr.ax.z;
    const fz = v.forward.x * fr.az.x + v.forward.y * fr.az.y + v.forward.z * fr.az.z;
    const l = Math.sqrt(fx * fx + fz * fz) || 1;
    sim.clearAround(v.cityX, v.cityZ, fx / l, fz / l);
  }

  /** ctx.view.ride → the ridden walker's index (-1 if none or not a person). */
  function rideOf(ctx: LBContext): number {
    const r = ctx.view.ride;
    if (r !== rideStr) {
      rideStr = r;
      rid = r !== null && r.startsWith('person:') ? Number(r.slice(7)) : -1;
      if (!(rid >= 0 && rid < (sim?.n ?? 0))) rid = -1;
    }
    return rid;
  }

  /** The 'eyes' pose of walker i at render time (people/track.ts); the ridden one looks along its smoothed yaw. */
  function walkerPose(ctx: LBContext, i: number, out: TrackPose): boolean {
    if (!sim || !ready) return false;
    const ridden = rideOf(ctx) === i;
    if (!ridden && (!sim.on[i] || (slot[i] < 0 && i !== featured))) return false;
    walkerEye(sim, looks[i], i, ctx.time.alpha, ctx.reducedMotion, pe);
    let fx = pe.fx;
    let fz = pe.fz;
    if (ridden) {
      // (the camera takes 60 % of the head's kerb glance: the look round without the whip pan)
      const target = Math.atan2(fz, fx) + GLANCE_CAM * gw[i] * kerbGlance(ctx.time.render + gph[i]);
      // the ground under the feet (kerbs), eased; the eye's own height and bob stay on top
      const ground = sim.ph[i] + (sim.h[i] - sim.ph[i]) * ctx.time.alpha;
      if (followFor !== i) {
        follow.reset(target);
        lift.reset(ground);
        followFor = i;
        followFrame = ctx.time.frame;
      } else if (followFrame !== ctx.time.frame) {
        follow.step(target, ctx.time.dt);
        lift.step(ground, ctx.time.dt);
        followFrame = ctx.time.frame;
      }
      fx = Math.cos(follow.yaw);
      fz = Math.sin(follow.yaw);
      pe.h += lift.h - ground;
    }
    eyeToWorld(pe, fx, fz, out);
    out.speed = pe.speed;
    return true;
  }

  /**
   * `featured`: a walker worth landing in, near plan (fx, fz). Distance counts up to FEAT_FAR (from
   * orbit, or off the city's edge, everyone is equally far and liveliness decides); liveliness is
   * walking briskly rather than standing about, company within 8 m (refreshed twice a second) and
   * the plaza or the park; someone walking at them within 4 m (a ride would open on a face) counts
   * against. 5 points of hysteresis, so it rarely changes under a hovering camera.
   */
  function pickFeatured(fx: number, fz: number, now: number): void {
    if (!sim) return;
    const s = sim;
    if (now - crowdT > 0.5 || now < crowdT) {
      crowdT = now;
      crowd.fill(0);
      facing.fill(0);
      for (let i = 0; i < s.n; i++) {
        if (!s.on[i]) continue;
        for (let j = i + 1; j < s.n; j++) {
          if (!s.on[j]) continue;
          const dx = s.x[i] - s.x[j];
          const dz = s.z[i] - s.z[j];
          const d2 = dx * dx + dz * dz;
          if (d2 < 64) {
            if (crowd[i] < 255) crowd[i]++;
            if (crowd[j] < 255) crowd[j]++;
          }
          if (d2 < 16) {
            // someone in front within 4 m walking at them, or right in front: a ride landing in
            // their eyes would open on a face
            const d = Math.sqrt(d2) || 1e-6;
            const ij = -(s.hx[i] * dx + s.hz[i] * dz) / d; // j in front of i
            const ji = (s.hx[j] * dx + s.hz[j] * dz) / d; // i in front of j
            if (ij > 0.7 && (ji > 0.6 || d < 1.8)) facing[i] = 1;
            if (ji > 0.7 && (ij > 0.6 || d < 1.8)) facing[j] = 1;
          }
        }
      }
    }
    let best = -1;
    let bs = Infinity;
    let cur = Infinity;
    for (let i = 0; i < s.n; i++) {
      const f = s.info[s.edge[i]];
      if (!s.on[i] || f.crossing) continue;
      const d = Math.sqrt((s.x[i] - fx) * (s.x[i] - fx) + (s.z[i] - fz) * (s.z[i] - fz));
      const sp = Math.sqrt(s.vx[i] * s.vx[i] + s.vz[i] * s.vz[i]);
      const k = f.e.kind;
      const score = Math.min(d, FEAT_FAR) - 3.5 * Math.min(crowd[i], 6) - (sp > 1 ? 8 : sp > 0.6 ? 3 : 0) - (k === 'plaza' || k === 'park' ? 6 : 0) + 12 * facing[i];
      if (i === featured) cur = score;
      if (score < bs) {
        bs = score;
        best = i;
      }
    }
    if (best >= 0 && (featured < 0 || !(cur < Infinity) || cur > bs + 5)) featured = best;
  }

  /** The card's live line: speed, where, and what they are up to. */
  function walkerDetail(ctx: LBContext, i: number): string {
    if (!sim) return '';
    const plan = ctx.world.city;
    const f = sim.info[sim.edge[i]];
    const here = walkPlace(plan, sim.edge[i], placeCache);
    const sp = Math.hypot(sim.vx[i], sim.vz[i]);
    if (f.crossing && !sim.commit[i] && sp < 0.3) return `waiting to cross ${here}`;
    if (f.crossing && sim.commit[i]) return `${kmh(sp)} · crossing ${here}`;
    const at = `${here === 'the park' ? 'in' : 'on'} ${here}`;
    if (sp < 0.15) return `standing about ${at}`;
    const r = Math.hypot(sim.x[i], sim.z[i]);
    const home = traits[i].home;
    const heading = planHeadingToWorld(sim.x[i], sim.z[i], Math.atan2(sim.hx[i], -sim.hz[i]));
    const goal = r > home + 12 ? 'heading in toward the plaza' : r < home - 12 ? 'heading out to the houses' : `strolling ${compass(heading)}`;
    return `${kmh(sp)} · ${at} · ${goal}`;
  }

  function registerWalkers(ctx: LBContext, nW: number): void {
    const cards = walkerCards(looks, traits, nW, SEED);
    for (let i = 0; i < nW; i++) {
      const card = cards[i];
      const id = `person:${i}`;
      untrack.push(
        ctx.services.track.register({
          id,
          kind: 'person',
          label: card.label,
          sub: card.sub,
          view: 'eyes',
          radius: Math.round(85 * looks[i].scale) / 100,
          pose: (c, out) => walkerPose(c, i, out),
          detail: (c) => walkerDetail(c, i),
          setRidden(on) {
            if (on) inside = i;
            else if (inside === i) inside = -1;
          },
        }),
      );
    }
  }

  return {
    name: 'people',
    stage: 2,
    async init(ctx: LBContext) {
      const plan = ctx.world.city;
      const index = ctx.world.cityIndex;
      const nW = Math.round(WALKERS * Math.max(0.65, Math.min(1, ctx.q.density)));
      const idlers = makeIdlers(plan, index, SEED, nW);
      looks = makeLooks(SEED, nW + idlers.length);
      for (const p of idlers) {
        const l = looks[p.id];
        l.pose = p.pose;
        l.flags &= ~(LookFlag.Umbrella | LookFlag.Phone | (p.pose === Pose.Stand ? 0 : LookFlag.Backpack | LookFlag.Bag));
        if (p.pose === Pose.Lean) {
          // the one leaning over the fountain rim is a kid
          l.flags = (l.flags & ~LookFlag.Dress) | LookFlag.Kid | LookFlag.Shorts;
          l.scale = 0.66;
        }
      }
      // dog walkers: grown-ups with a free left hand
      const rng = Rng.for(SEED, 'people-dogs');
      const own: number[] = [];
      for (let i = 0; i < nW; i++) {
        const l = looks[i];
        if (!(l.flags & (LookFlag.Kid | LookFlag.Bag)) && rng.float() < DOG_SHARE) {
          l.flags |= LookFlag.Leash;
          own.push(i);
        }
      }
      await ctx.yield();
      traits = makeTraits(SEED, looks, nW);
      sim = new PeopleSim(plan, index, SEED, traits, idlers, own);
      idleOn = new Uint8Array(idlers.length).fill(1);
      planFrame(0, 0, fr);
      AX0.x = fr.ax.x;
      AX0.y = fr.ax.y;
      AX0.z = fr.ax.z;
      const nP = looks.length;
      const nD = own.length;
      // pop altitudes skewed low: the crowd thickens as the streets get readable
      popAt = Float32Array.from({ length: nP + nD }, (_, i) => POP_LO + (POP_HI - POP_LO) * Math.pow(hash3(i, 93, SEED), 1.4));
      slot = new Int32Array(nW).fill(-1);
      gw = new Float32Array(nW);
      crowd = new Uint8Array(nW);
      facing = new Uint8Array(nW);
      gph = Float32Array.from({ length: nW }, (_, i) => hash3(i, 95, SEED) * 6.2);
      gs = new Float32Array(nW);
      gv = new Float32Array(nW);
      const lp: number[] = [];
      for (const f of plan.features) {
        const r = f.kind === 'streetlight' ? 1.25 : f.kind === 'lamp' ? 0 : -1;
        if (r >= 0) lp.push(f.x + Math.cos(f.angle) * r, f.z + Math.sin(f.angle) * r, r ? 4.8 ** 2 : 3 ** 2);
      }
      lamps = Float64Array.from(lp);
      await ctx.yield();

      // Look texture: people rows, then dog rows.
      const data = new Uint8Array(TEX_W * 4 * (nP + nD));
      looks.forEach((l, r) => {
        const o = r * TEX_W * 4;
        srgb(l.skin, data, o, l.hairStyle);
        srgb(l.shirt, data, o + 4, l.flags & 255);
        srgb(l.legs, data, o + 8, l.flags >> 8);
        srgb(l.hair, data, o + 12, l.pose);
        srgb(l.acc, data, o + 16, Math.round(l.bounce * 255));
      });
      own.forEach((_, k) => {
        const o = (nP + k) * TEX_W * 4;
        const fur = DOG_FUR[Math.floor(hash3(k, 1, SEED) * DOG_FUR.length)];
        const patch = DOG_PATCH[Math.floor(hash3(k, 2, SEED) * DOG_PATCH.length)];
        srgb(fur, data, o, 0);
        srgb(patch === fur ? 0x3a3030 : patch, data, o + 4, 0);
        srgb(COLLAR[k % 4], data, o + 8, 0);
      });
      const tex = ctx.track(new DataTexture(data, TEX_W, nP + nD, RGBAFormat, UnsignedByteType));
      tex.minFilter = tex.magFilter = NearestFilter;
      tex.needsUpdate = true;

      const mat = ctx.toon.material({ name: 'people', vertexColors: true, reveal: 'object', revealDuration: 0.6, rim: 0.45, patch: peoplePatch(tex, uRide) });
      mat.defines = { ...mat.defines, PP_COLOR: '' };
      const geos = [personGeometry(0), personGeometry(1), personGeometry(2), dogGeometry()];
      meshes = geos.map((g, m) => {
        ctx.track(g);
        const cnt = Math.max(1, m < 3 ? nP : nD);
        g.setAttribute('aAnim', new InstancedBufferAttribute(new Float32Array(cnt * 4), 4).setUsage(DynamicDrawUsage));
        const mesh = ctx.toon.instanced(g, mat, cnt);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.name = ['people', 'people:mid', 'people:far', 'people:dogs'][m];
        return mesh;
      });
      arr = meshes.map((m) => m.instanceMatrix.array as Float32Array);
      anim = meshes.map((m) => (m.geometry.getAttribute('aAnim') as InstancedBufferAttribute).array as Float32Array);
      const lg = ctx.track(new BufferGeometry());
      lg.setAttribute('position', new BufferAttribute(new Float32Array(Math.max(1, nD) * 12), 3).setUsage(DynamicDrawUsage));
      const lm = ctx.track(new LineBasicMaterial({ color: new Color().copy(PALETTE.ink).lerp(new Color('#6b4a33'), 0.35) }));
      leash = new LineSegments(lg, lm);
      leash.frustumCulled = false;
      leash.layers.set(LAYER_NO_INK);
      leash.visible = false;
      leash.name = 'people:leash';

      // Establish the crowd for the current time, the settle split across frames.
      const t = ctx.time.t;
      thinAll(nightAt(t));
      sim.scatter(t, nightAt(t) * THIN_WALK);
      for (let k = 0; k < SETTLE_STEPS; k += 9) {
        await ctx.yield();
        sim.settle(t, k, Math.min(SETTLE_STEPS, k + 9), null, null);
      }

      ctx.scene.add(...meshes, leash);
      // review scripts (shot mode only) read the crowd through the scene graph
      if (ctx.shotMode) meshes[0].userData.peopleSim = sim;
      for (const m of meshes) m.count = 1; // warm the program with something drawn
      await ctx.compile();
      for (const m of meshes) m.count = 0;
      mat.userData.lbUniforms.lbRevealDelay.value = ctx.reveal.slot(0.6);
      ready = true;
      registerWalkers(ctx, nW);
    },

    fixedUpdate(ctx) {
      if (!sim || !ready) return;
      const v = ctx.view;
      const cr = ctx.services.crossings;
      // the camera is a pedestrian only while exploring (riding someone's eyes, it IS that walker)
      lens.update(ctx.time.fixedDt, v.cityX, v.cityZ, v.altTerrain, v.mode === 'explore' && v.cityDist < ctx.world.city.radius);
      const r = rideOf(ctx);
      if (r >= 0) sim.on[r] = 1;
      // the ridden walker keeps a camera's berth from everyone (people/sim.ts RIDER_GAP), wider
      // in front of a kid's low eye
      sim.rider = r;
      sim.riderK = r >= 0 && looks[r].flags & LookFlag.Kid ? KID_BERTH : 1;
      // the walker just ridden walks on out of the camera, which is no obstacle to it a while
      if (r >= 0) {
        lastRid = r;
        freeT = FREE_S;
      } else if (freeT > 0) freeT -= ctx.time.fixedDt;
      sim.free = freeT > 0 ? lastRid : -1;
      sim.step(ctx.time.fixedDt, ctx.time.t, cr.busy, cr.blocked, lens.x, lens.z, lens.on, lens.r, lens.lens);
    },

    onTimeJump(ctx) {
      if (!sim || !ready) return;
      const late = nightAt(ctx.time.t);
      thinAll(late);
      sim.placeAt(ctx.time.t, ctx.services.crossings.busy, ctx.services.crossings.blocked, late * THIN_WALK);
      const r = rideOf(ctx);
      if (r >= 0) sim.on[r] = 1;
      followFor = -1; // the walker was re-placed: the ride's yaw starts over
      clearView(ctx);
    },

    update(ctx) {
      if (!sim || !leash || !ready) return;
      const v = ctx.view;
      const alt = v.altTerrain;
      const eye = v.eye;
      // a camera cut (shot, fly-to landing): step people out of the lens first
      const jx = eye.x - lastEye.x;
      const jy = eye.y - lastEye.y;
      const jz = eye.z - lastEye.z;
      lastEye.copy(eye);
      if (jx * jx + jy * jy + jz * jz > 16) clearView(ctx);
      // the ridden walker (and its dog) is drawn at any altitude, the crowd only near the city
      const ri = rideOf(ctx);
      if (followFor >= 0 && ri !== followFor) followFor = -1;
      const crowd = alt < POP_HI && v.cityDist < ctx.world.city.radius + 60 + alt;
      const show = crowd || ri >= 0;
      for (const m of meshes) m.visible = show;
      meshes[2].castShadow = meshes[3].castShadow = alt < SHADOW_ALT;
      leash.visible = show && (alt < POP_LO + 0.5 || ri >= 0);
      const nightNow = ctx.uniforms.lbNight.value;
      const nightT = nightAt(ctx.time.t);
      const dtS = ctx.time.dt;
      const kG = Math.min(1, dtS * 4);
      if (!crowd) thinAll(nightT); // nobody is in view: the crowd follows the hour at once
      if (ri >= 0) sim.on[ri] = 1;
      pickFeatured(v.cityX, v.cityZ, ctx.time.render);
      uRide.value = -1;
      if (!show) {
        // nobody drawn: nobody rideable but the featured walker (pose() reads slot)
        slot.fill(-1);
        for (let i = 0; i < sim.n; i++) gw[i] = kerbWait(sim, i);
        return;
      }
      const a = ctx.time.alpha;
      const fwd = v.forward;
      const rm = ctx.reducedMotion;
      // draw radius: out to where a person's head drops below the horizon (planet and plateau curve)
      const visR = Math.sqrt(2 * GROUND_R * (Math.max(0, alt) + 0.3)) + 30;
      const street = alt < 2.6;
      // LOD distances follow the screen size: a narrower FOV draws people bigger
      const lodK = Math.tan((v.fov * Math.PI) / 360) / Math.tan((35 * Math.PI) / 180);
      // near-eye fade: a short band ending at nearR (further when looking down: a head poking up
      // into the bottom of the frame)
      // (riding someone's eyes, the sim keeps everyone a berth away, people/sim.ts RIDER_GAP: the
      // band moves in so nobody standing at that berth is dithered)
      const riding = inside >= 0 || ri >= 0;
      const nearR = (riding ? 0.62 : 1.0) + (riding ? 0.25 : 0.5) * smooth(-0.15, -0.35, v.pitch);
      // plan-space pre-cull (no world mapping for people far off or well behind the camera): the
      // camera's plan position and level forward
      const pcx = v.cityX;
      const pcz = v.cityZ;
      planFrame(pcx, pcz, fr);
      let pfx = fwd.x * fr.ax.x + fwd.y * fr.ax.y + fwd.z * fr.ax.z;
      let pfz = fwd.x * fr.az.x + fwd.y * fr.az.y + fwd.z * fr.az.z;
      const pfl = Math.sqrt(pfx * pfx + pfz * pfz);
      const cone = v.pitch > -0.6 && pfl > 0.5;
      pfx /= pfl || 1;
      pfz /= pfl || 1;
      const preR2 = (visR + alt + 8) * (visR + alt + 8);
      kk.fill(0);
      const s = sim;
      const n = s.n;
      for (let i = 0; i < looks.length; i++) {
        const walker = i < n;
        const p = walker ? null : s.idlers[i - n];
        const l = looks[i];
        let x: number;
        let z: number;
        let h: number;
        let fx: number;
        let fz: number;
        let phase = 0;
        let amp = 0;
        const ridden = i === ri;
        if (!crowd && !ridden) {
          if (walker) slot[i] = -1;
          continue;
        }
        if (walker) {
          slot[i] = -1;
          gw[i] += (kerbWait(s, i) - gw[i]) * kG;
          x = s.px[i] + (s.x[i] - s.px[i]) * a;
          z = s.pz[i] + (s.z[i] - s.pz[i]) * a;
          h = s.ph[i] + (s.h[i] - s.ph[i]) * a;
          fx = s.phx[i] + (s.hx[i] - s.phx[i]) * a;
          fz = s.phz[i] + (s.hz[i] - s.phz[i]) * a;
          const g = s.pgait[i] + (s.gait[i] - s.pgait[i]) * a;
          phase = ((g / (1.15 * l.scale)) % 1) * Math.PI * 2;
          amp = Math.min(1, Math.max(0, (Math.sqrt(s.vx[i] * s.vx[i] + s.vz[i] * s.vz[i]) - 0.05) / 1.05));
        } else {
          x = p!.x;
          z = p!.z;
          fx = p!.fx;
          fz = p!.fz;
          h = p!.pose === Pose.Sit || p!.pose === Pose.Cafe ? p!.h - (J.hipY - J.thighR) * l.scale : p!.h;
        }
        const want = hash3(walker ? i : i - n, walker ? 91 : 92, SEED) >= nightT * (walker ? THIN_WALK : THIN_IDLE) ? 1 : 0;
        const onArr = walker ? s.on : idleOn;
        const oi = walker ? i : i - n;
        const qx0 = x - pcx;
        const qz0 = z - pcz;
        const dp2 = qx0 * qx0 + qz0 * qz0;
        if (!ridden && (dp2 > preR2 || (cone && qx0 * pfx + qz0 * pfz < 0.3 * Math.sqrt(dp2) - 6))) {
          if (onArr[oi] !== want) onArr[oi] = want; // out of view: the crowd follows the hour
          continue;
        }
        // toSphere(x, z, h), inline (world/sphere chartToDir: the city chart's exponential map)
        {
          const dd = Math.sqrt(x * x + z * z) || 1e-9;
          const th = dd / CC.radius;
          const sn = Math.sin(th) / dd;
          const co = Math.cos(th);
          const wx = CC.origin.x * co + (CC.east.x * x + CC.south.x * z) * sn;
          const wy = CC.origin.y * co + (CC.east.y * x + CC.south.y * z) * sn;
          const wz = CC.origin.z * co + (CC.east.z * x + CC.south.z * z) * sn;
          const r = (CITY_SURFACE_R + h) / Math.sqrt(wx * wx + wy * wy + wz * wz);
          pos.x = wx * r;
          pos.y = wy * r;
          pos.z = wz * r;
        }
        const ex = pos.x - eye.x;
        const ey = pos.y - eye.y;
        const ez = pos.z - eye.z;
        const d2 = ex * ex + ey * ey + ez * ez;
        const dist = Math.sqrt(d2);
        const along = ex * fwd.x + ey * fwd.y + ez * fwd.z;
        // in view: inside the draw radius and a generous cone (room for bodies and shadows at its edges)
        const inView = ridden || (dist < visR && along > 0.3 * dist - 2.5);
        // the crowd follows the hour, but only where nobody is looking
        if (onArr[oi] !== want && !inView) onArr[oi] = want;
        if (!inView || !onArr[oi]) continue;
        // in by altitude (each at their own) and out at the edge of the draw radius
        const fade = ridden ? 1 : Math.min(1, Math.max(0, popAt[i] - alt)) * Math.min(1, Math.max(0, (visR - dist) / 6));
        const grow = rm ? 1 : ctx.reveal.spring(fade);
        if (grow < 0.01 || fade <= 0) continue;
        const sc = l.scale * grow;
        // Personal space: someone right at a street-level eye dithers out over a 0.2 m band and
        // is skipped below it; measured to the nearest point of the body (feet to head top).
        const pl = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
        const up = Math.min(1.7 * sc, Math.max(0, -(ex * pos.x + ey * pos.y + ez * pos.z) / pl));
        const qx = ex + (pos.x / pl) * up;
        const qy = ey + (pos.y / pl) * up;
        const qz = ez + (pos.z / pl) * up;
        // (the ridden walker never: the camera is in its head, which the shader hides below)
        const ps = ridden ? 1 : Math.min(1, Math.max(0, (Math.sqrt(qx * qx + qy * qy + qz * qz) - nearR + 0.2) / 0.2));
        if (ps < 0.15) continue;
        if (ridden) {
          // the camera at (or flying into) the head: hide it from the colour pass (setRidden, or
          // the eye already inside it)
          const hx = ex + (pos.x / pl) * 1.47 * sc;
          const hy = ey + (pos.y / pl) * 1.47 * sc;
          const hz = ez + (pos.z / pl) * 1.47 * sc;
          const hd2 = hx * hx + hy * hy + hz * hz;
          if ((inside === i && hd2 < 1.2 * 1.2) || hd2 < 0.35 * 0.35) uRide.value = i;
        }
        // the first visible step is a coarse one (a 1/16 dot screen never lingers)
        const vis = (ps < 1 ? 0.35 + (0.65 * (ps - 0.15)) / 0.85 : 1) * (rm ? fade : 1);
        if (vis < 0.03) continue;
        const dEff = dist * lodK;
        const m = dEff < NEAR_R ? 0 : dEff < FAR_R ? 1 : 2;
        const k = kk[m]++;
        W[0] = fx;
        W[1] = fz;
        W[2] = sc;
        writeMatrix(arr[m], k);
        // glance at a nearby player: continuous in distance and angle, so it never snaps
        let look = 0;
        if (street && d2 < 64 && (l.seed & 3) !== 0) {
          const o = k * 16;
          const A = arr[m];
          const ang = Math.atan2(-(A[o] * ex + A[o + 1] * ey + A[o + 2] * ez), -(A[o + 8] * ex + A[o + 9] * ey + A[o + 10] * ez));
          // (riding someone's eyes, passers-by close to the lens look where they are going: a
          // stare into the camera at arm's length is a face filling the frame)
          look = Math.max(-1.1, Math.min(1.1, ang)) * smooth(7.5, 3.5, dist) * smooth(2.0, 1.3, Math.abs(ang)) * (riding ? smooth(1.8, 3, dist) : 1);
        }
        // a walker waiting at a kerb checks the traffic (shader yaw: + = turn left)
        if (walker && gw[i] > 0.01) look = Math.max(-1.1, Math.min(1.1, look - gw[i] * kerbGlance(ctx.time.render + gph[i])));
        const lit = nightNow > 0.02 ? Math.round(31 * nightNow * lampLight(x, z)) : 0;
        const A4 = anim[m];
        A4[k * 4] = i + 0.9 * (1 - vis);
        A4[k * 4 + 1] = phase;
        A4[k * 4 + 2] = amp + 2 * lit;
        A4[k * 4 + 3] = look;
        if (walker) {
          slot[i] = m * 100000 + k;
          gs[i] = grow;
          gv[i] = rm ? fade : 1;
        }
      }

      // dogs and leashes
      const dArr = arr[3];
      const la = leash.geometry.getAttribute('position') as BufferAttribute;
      const L = la.array as Float32Array;
      let q = 0;
      for (let d = 0; d < s.dOwner.length; d++) {
        const own = s.dOwner[d];
        if (slot[own] < 0) continue;
        const x = s.dpx[d] + (s.dx[d] - s.dpx[d]) * a;
        const z = s.dpz[d] + (s.dz[d] - s.dpz[d]) * a;
        const sc = (0.8 + hash3(d, 3, SEED) * 0.45) * gs[own];
        // on the owner's walking surface (no ground query per frame)
        toSphere(x, z, s.ph[own] + (s.h[own] - s.ph[own]) * a, pos);
        W[0] = s.dhx[d];
        W[1] = s.dhz[d];
        W[2] = sc;
        writeMatrix(dArr, q);
        const ex = pos.x - eye.x;
        const ey = pos.y - eye.y;
        const ez = pos.z - eye.z;
        const ps = Math.min(1, Math.max(0, (Math.sqrt(ex * ex + ey * ey + ez * ez) - 0.55) / 0.3));
        if (ps < 0.15) continue;
        const vis = (ps < 1 ? 0.35 + (0.65 * (ps - 0.15)) / 0.85 : 1) * gv[own];
        const g = s.dpg[d] + (s.dg[d] - s.dpg[d]) * a;
        const D4 = anim[3];
        D4[q * 4] = looks.length + d + 0.9 * (1 - vis);
        D4[q * 4 + 1] = ((g / (0.62 * sc)) % 1) * Math.PI * 2;
        D4[q * 4 + 2] = Math.min(1, s.dsp[d]);
        D4[q * 4 + 3] = 0;
        // leash: owner's left hand → collar, with a little sag
        const om = (slot[own] / 100000) | 0;
        apply(arr[om], slot[own] - om * 100000, hand, tmp);
        const o = q * 12;
        L[o] = tmp.x;
        L[o + 1] = tmp.y;
        L[o + 2] = tmp.z;
        apply(dArr, q, collar, tmp);
        L[o + 9] = tmp.x;
        L[o + 10] = tmp.y;
        L[o + 11] = tmp.z;
        const mx = (L[o] + tmp.x) / 2;
        const my = (L[o + 1] + tmp.y) / 2;
        const mz = (L[o + 2] + tmp.z) / 2;
        const sag = 1 - 0.12 / Math.sqrt(mx * mx + my * my + mz * mz);
        L[o + 3] = L[o + 6] = mx * sag;
        L[o + 4] = L[o + 7] = my * sag;
        L[o + 5] = L[o + 8] = mz * sag;
        q++;
      }
      kk[3] = q;
      for (let m = 0; m < 4; m++) {
        const mesh = meshes[m];
        mesh.count = kk[m];
        upload(mesh.instanceMatrix, kk[m] * 16);
        upload(mesh.geometry.getAttribute('aAnim') as InstancedBufferAttribute, kk[m] * 4);
      }
      leash.geometry.setDrawRange(0, q * 4);
      upload(la, q * 12);
    },

    dispose() {
      for (const off of untrack) off();
      untrack.length = 0;
      for (const m of meshes) {
        m.geometry.dispose();
        m.dispose();
      }
      leash?.geometry.dispose();
      (leash?.material as LineBasicMaterial | undefined)?.dispose();
      meshes = [];
      leash = null;
      sim = null;
      ready = false;
    },
  };
}
