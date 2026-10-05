// People (L1, v2): what makes a walker followable. Their card (a name and a line in the site's
// voice), the kerb glance (a waiter checks the traffic: left, right, left again), the eye pose from
// the walk cycle, and the forward the 'eyes' ride publishes, smoothed so a corner or a sidestep never
// snaps the view. Pure (no renderer): people/index.ts registers the trackables, specs drive it
// with a bare PeopleSim.

import { CITY_SURFACE_R } from '../world/config';
import { CITY_CHART as CC } from '../world/city/frame';
import type { CityPlan } from '../world/city/types';
import { hash3 } from '../world/rng';
import { FEM, KIDS, MASC, nameAt, pickOf, roadNames } from '../traffic/names';
import { J } from './figure';
import { LookFlag, type Look, type PeopleSim, type WalkerTraits } from './sim';

// ── The card ──

// (counted pools, like the names: walker i's dog and line depend only on walkers 0…i, every dog a
// different name, no line on more than ⌈n / FACTS⌉ walkers and never on two in a row)
const DOGS = [
  'biscuit', 'pickle', 'waffles', 'noodle', 'pepper', 'mochi', 'bean', 'rufus', 'tofu', 'bisou',
  'pretzel', 'olive', 'crumpet', 'pudding', 'nacho', 'sprout', 'gizmo', 'juniper', 'muffin', 'peanut',
  'ziggy', 'dumpling', 'scout', 'clementine', 'basil', 'marmalade', 'oscar', 'pip', 'sausage', 'turnip',
  'fudge', 'chickpea', 'radish', 'nugget', 'popcorn', 'beans', 'custard', 'lentil', 'meatball', 'sesame',
];
const FACTS = [
  'knows every pigeon by name',
  'humming something catchy',
  'thinking about lunch',
  'has never once been late',
  'collects bottle caps',
  'waves at every bus',
  'counting the paving stones',
  'loves this time of day',
  'practising a speech',
  'trying a new shortcut',
  'off to feed the ducks',
  'still thinking about that croissant',
  'on first-name terms with the baker',
  'pretending not to be lost',
  'saving the good bench for later',
  'has a pocket full of acorns',
  'owes someone a postcard',
  'whistling, badly',
  'rehearsing a joke for later',
  'has opinions about clouds',
  'nodding at strangers',
  'on the way to buy string',
  'secretly the best at hopscotch',
  'looking for a four-leaf clover',
  'composing a haiku',
  'two library books overdue',
  'just had a very good idea',
  'thinks the clock tower is fast',
  'counting down to the weekend',
  'keeps a snack for emergencies',
  'trying to remember a word',
  'never steps on the cracks',
];
const LINES = ['out for a stroll', 'on a coffee run', 'on the lunch break', 'off to the bakery', 'people-watching', 'running an errand', 'walking it off', 'off to meet a friend'];

const isKid = (look: Look) => (look.flags & LookFlag.Kid) !== 0;
const isFem = (look: Look) => !isKid(look) && ((look.flags & LookFlag.Dress) !== 0 || look.hairStyle === 2 || look.hairStyle === 3);

/**
 * Every walker's first name, in walker order: each pool (kids, women, men) is drawn from without
 * replacement (traffic/names.ts nameAt), so nobody in town shares a name, with a driver either.
 * Walker i's name depends only on walkers 0…i, so the low tier's walkers keep the high tier's names.
 */
export function walkerNames(looks: readonly Look[], n: number, seed: number): string[] {
  let kids = 0;
  let fems = 0;
  let mascs = 0;
  return Array.from({ length: n }, (_, i) => {
    const l = looks[i];
    return isKid(l) ? nameAt(KIDS, seed, kids++) : isFem(l) ? nameAt(FEM, seed, fems++) : nameAt(MASC, seed, mascs++);
  });
}

/**
 * Every walker's follow card ('maya, out with her dog' and a line under it), in walker order:
 * names as walkerNames, and the dogs and the lines under the card counted through their pools (a
 * dog walker's dog from DOGS, everyone else's line from FACTS, stepping 7 through 32: neighbours
 * never share a line, none is on more than ⌈n / 32⌉ walkers). Deterministic in (seed, looks), and
 * walker i's card depends only on walkers 0…i (the low tier keeps the high tier's cards).
 */
export function walkerCards(looks: readonly Look[], traits: readonly WalkerTraits[], n: number, seed: number): Array<{ label: string; sub: string }> {
  const names = walkerNames(looks, n, seed);
  const o = Math.floor(hash3(seed, 36, FACTS.length) * FACTS.length);
  let dogs = 0;
  let facts = 0;
  return names.map((name, i) => {
    const dog = (looks[i].flags & LookFlag.Leash) !== 0;
    const sub = dog ? `and ${nameAt(DOGS, seed, dogs++)}, who is in charge` : FACTS[(o + 7 * facts++) % FACTS.length];
    return walkerCard(looks[i], traits[i], i, seed, name, sub);
  });
}

/** A walker's follow card: 'maya, out with her dog' over `sub`. Deterministic in (seed, i). */
export function walkerCard(look: Look, traits: WalkerTraits, i: number, seed: number, name: string, sub: string): { label: string; sub: string } {
  const f = look.flags;
  const kid = isKid(look);
  const fem = isFem(look);
  const her = fem ? 'her' : 'his';
  const slow = look.bounce < 0.25;
  let line: string;
  if (f & LookFlag.Leash) line = `out with ${her} dog`;
  else if (kid) line = hash3(i, seed, 34) < 0.5 ? 'on the way home from school' : 'racing nobody in particular';
  else if (f & LookFlag.Phone) line = `glued to ${her} phone`;
  else if (f & LookFlag.Umbrella) line = 'ready for rain, just in case';
  else if (slow) line = 'taking the long way round';
  else if (f & LookFlag.Backpack) line = 'off to class';
  else if (f & LookFlag.Bag) line = 'back from the market';
  else if (traits.vPref > 1.35) line = 'late for something';
  else line = pickOf(LINES, i, seed, 35);
  return { label: `${name}, ${line}`, sub };
}

/** Where a walk edge is, for the card's live line: 'maple avenue', 'the park', 'the market lane'. */
export function walkPlace(plan: CityPlan, edge: number, cache: Map<number, string>): string {
  let s = cache.get(edge);
  if (s !== undefined) return s;
  const e = plan.walkEdges[edge];
  const roads = roadNames(plan);
  if (e.kind === 'park') s = 'the park';
  else if (e.kind === 'plaza') s = 'the plaza';
  else if (e.kind === 'footpath') s = 'the market lane';
  else if (e.road !== undefined && e.road >= 0) s = roads[e.road];
  else {
    // the road this pavement runs along
    const p = e.path.pts;
    const k = (p.length >> 2) << 1;
    const x = p[k];
    const z = p[k + 1];
    let best = -1;
    let bd = Infinity;
    for (const r of plan.edges) {
      const q = r.centre.pts;
      for (let j = 0; j < q.length; j += 2) {
        const d = (q[j] - x) ** 2 + (q[j + 1] - z) ** 2;
        if (d < bd) {
          bd = d;
          best = r.id;
        }
      }
    }
    s = best >= 0 && bd < 14 * 14 ? roads[best] : 'a quiet corner';
  }
  cache.set(edge, s);
  return s;
}

// ── The kerb glance ──

/** Glance keyframes (s, yaw rad; + = toward the walker's right). Near-lane traffic comes from the left (right-hand traffic). */
const GLANCE = [0, 0, 0.6, -0.9, 1.7, -0.9, 2.5, 0.75, 3.4, 0.75, 3.9, -0.4, 4.5, -0.4, 5.1, 0, 6.2, 0];
const GLANCE_T = 6.2;

/** Head yaw (rad, + = right) of someone waiting at a kerb, `t` seconds into their wait cycle. Smooth (C1). */
export function kerbGlance(t: number): number {
  const p = ((t % GLANCE_T) + GLANCE_T) % GLANCE_T;
  for (let k = 0; k < GLANCE.length - 2; k += 2) {
    if (p > GLANCE[k + 2]) continue;
    const u = (p - GLANCE[k]) / (GLANCE[k + 2] - GLANCE[k]);
    return GLANCE[k + 1] + (GLANCE[k + 3] - GLANCE[k + 1]) * u * u * (3 - 2 * u);
  }
  return 0;
}

/** 0..1: how much walker i is standing at a kerb waiting to cross (smooth in its speed). */
export function kerbWait(sim: PeopleSim, i: number): number {
  const f = sim.info[sim.edge[i]];
  if (!f.crossing || sim.commit[i]) return 0;
  const sp = Math.sqrt(sim.vx[i] * sim.vx[i] + sim.vz[i] * sim.vz[i]);
  const t = Math.min(1, Math.max(0, (sp - 0.12) / 0.33));
  return 1 - t * t * (3 - 2 * t);
}

// ── The eye pose ──

/** Where the camera sits in the figure (figure metres, origin at the feet, +z forward): the head's centre, a little forward. */
const EYE_Y = J.headY - 0.01;
const EYE_FWD = 0.11;

export interface PlanPose {
  /** Plan position and height above the plateau of the eye. */
  x: number;
  z: number;
  h: number;
  /** Raw facing (plan, unit). */
  fx: number;
  fz: number;
  speed: number;
}

/**
 * Walker i's eye at render fraction a: the feet interpolated between fixed steps, the head's height
 * from the figure (a kid's head is 1.22× about the neck), and — unless `still` (reduced motion) — the
 * walk cycle's vertical bob and forward lean, exactly as people/shader.ts poses the body.
 */
export function walkerEye(sim: PeopleSim, look: Look, i: number, a: number, still: boolean, out: PlanPose): PlanPose {
  const x = sim.px[i] + (sim.x[i] - sim.px[i]) * a;
  const z = sim.pz[i] + (sim.z[i] - sim.pz[i]) * a;
  const h = sim.ph[i] + (sim.h[i] - sim.ph[i]) * a;
  let fx = sim.phx[i] + (sim.hx[i] - sim.phx[i]) * a;
  let fz = sim.phz[i] + (sim.hz[i] - sim.phz[i]) * a;
  const fl = Math.sqrt(fx * fx + fz * fz) || 1;
  fx /= fl;
  fz /= fl;
  const sc = look.scale;
  const sp = Math.sqrt(sim.vx[i] * sim.vx[i] + sim.vz[i] * sim.vz[i]);
  let eye = (look.flags & LookFlag.Kid) !== 0 ? J.neckY + (EYE_Y - J.neckY) * 1.22 : EYE_Y;
  let fwd = EYE_FWD;
  if (!still) {
    const amp = Math.min(1, Math.max(0, (sp - 0.05) / 1.05));
    const g = sim.pgait[i] + (sim.gait[i] - sim.pgait[i]) * a;
    const ph = ((g / (1.15 * sc)) % 1) * Math.PI * 2;
    // people/shader.ts: bob = amp · 0.034 · (0.55 + bounce) · cos 2φ; lean = amp · 0.06 about the waist
    eye += amp * 0.034 * (0.55 + look.bounce) * Math.cos(2 * ph);
    fwd += (eye - J.waistY) * Math.sin(amp * 0.06);
  }
  out.x = x + fx * fwd * sc;
  out.z = z + fz * fwd * sc;
  out.h = h + eye * sc;
  out.fx = fx;
  out.fz = fz;
  out.speed = sp;
  return out;
}

/** A pose shaped like TrackPose (three's Vector3 fits). */
export interface PoseOut {
  pos: { x: number; y: number; z: number };
  fwd: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  speed: number;
}

/**
 * World pose from a plan eye and a plan facing (fx, fz): the city chart's exponential map, inline
 * (zero-alloc: doubles never cross a call boundary in V8's eyes when they live on objects), the
 * facing carried to the eye's tangent plane by the chart's frame there.
 */
export function eyeToWorld(e: PlanPose, fx: number, fz: number, out: PoseOut): void {
  const x = e.x;
  const z = e.z;
  const d = Math.sqrt(x * x + z * z);
  const th = d / CC.radius;
  const sn = d > 1e-9 ? Math.sin(th) / d : 1 / CC.radius;
  const co = Math.cos(th);
  const ux = CC.origin.x * co + (CC.east.x * x + CC.south.x * z) * sn;
  const uy = CC.origin.y * co + (CC.east.y * x + CC.south.y * z) * sn;
  const uz = CC.origin.z * co + (CC.east.z * x + CC.south.z * z) * sn;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const r = CITY_SURFACE_R + e.h;
  out.pos.x = (ux / ul) * r;
  out.pos.y = (uy / ul) * r;
  out.pos.z = (uz / ul) * r;
  out.up.x = ux / ul;
  out.up.y = uy / ul;
  out.up.z = uz / ul;
  // the plan direction (fx, fz) at the eye: a small step along it through the chart, made tangent
  const k = 0.05;
  const x2 = x + fx * k;
  const z2 = z + fz * k;
  const d2 = Math.sqrt(x2 * x2 + z2 * z2);
  const th2 = d2 / CC.radius;
  const sn2 = d2 > 1e-9 ? Math.sin(th2) / d2 : 1 / CC.radius;
  const co2 = Math.cos(th2);
  let wx = CC.origin.x * co2 + (CC.east.x * x2 + CC.south.x * z2) * sn2 - ux;
  let wy = CC.origin.y * co2 + (CC.east.y * x2 + CC.south.y * z2) * sn2 - uy;
  let wz = CC.origin.z * co2 + (CC.east.z * x2 + CC.south.z * z2) * sn2 - uz;
  const wu = (wx * ux + wy * uy + wz * uz) / (ul * ul);
  wx -= ux * wu;
  wy -= uy * wu;
  wz -= uz * wu;
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
  out.fwd.x = wx / wl;
  out.fwd.y = wy / wl;
  out.fwd.z = wz / wl;
}

// ── The smoothed forward of a ridden walker ──

/**
 * Natural frequency (rad/s) of the critically damped yaw follower (a 90° corner settles in ~1.4 s),
 * and its top turning speed (rad/s): a walker who turns right round (stuck, giving up on a kerb)
 * swings the view at ≤ 77°/s, the pace of a person looking round, never a whip pan (first person
 * is where turn speed makes people queasy). The ride camera (camera/rides/rig.ts) springs the
 * heading again, which only lowers the peak; this keeps the published forward itself free of
 * kinks (a sidestep, a path join, the end of a kerb glance).
 */
const YAW_W = 4.2;
export const YAW_VMAX = 1.35;
/** …and its top angular acceleration (rad/s²): no jolt as a turn begins or ends. */
export const YAW_AMAX = 5;
const YAW_H = 1 / 60;

/**
 * The yaw (plan angle) an 'eyes' ride looks along: a critically damped, speed- and acceleration-limited follower of
 * the walker's facing plus its kerb glance. Sub-stepped at ≤ 1/60 s, so a debug step(0.5, 1) is
 * as smooth as the live loop.
 */
export class YawFollower {
  yaw = 0;
  vel = 0;
  on = false;

  reset(target: number): void {
    this.yaw = target;
    this.vel = 0;
    this.on = true;
  }

  step(target: number, dt: number): number {
    if (!this.on) this.reset(target);
    if (!(dt > 0)) return this.yaw;
    const n = Math.min(120, Math.ceil(dt / YAW_H - 1e-9));
    const h = dt / n;
    const w = YAW_W;
    for (let k = 0; k < n; k++) {
      // the shortest way round
      let e = this.yaw - target;
      e -= Math.round(e / (Math.PI * 2)) * Math.PI * 2;
      const acc = Math.max(-YAW_AMAX, Math.min(YAW_AMAX, -w * w * e - 2 * w * this.vel));
      this.vel += acc * h;
      if (this.vel > YAW_VMAX) this.vel = YAW_VMAX;
      else if (this.vel < -YAW_VMAX) this.vel = -YAW_VMAX;
      this.yaw += this.vel * h;
    }
    // keep the angle small (the direction is what matters)
    if (this.yaw > Math.PI * 4 || this.yaw < -Math.PI * 4) this.yaw -= Math.round(this.yaw / (Math.PI * 2)) * Math.PI * 2;
    return this.yaw;
  }
}

/**
 * The ridden walker's ground height (kerb steps, the zebra's dip) through a critically damped
 * follower: the sim settles a 15 cm kerb at up to ~2.4 m/s, which on the camera reads as a drop;
 * through this it peaks near 0.5 m/s, still a step. The walk's bob rides on top, unfiltered.
 */
export class HeightFollower {
  h = 0;
  v = 0;
  on = false;

  reset(target: number): void {
    this.h = target;
    this.v = 0;
    this.on = true;
  }

  step(target: number, dt: number): number {
    if (!this.on) this.reset(target);
    if (!(dt > 0)) return this.h;
    const n = Math.min(120, Math.ceil(dt / YAW_H - 1e-9));
    const k = dt / n;
    const w = 9;
    for (let i = 0; i < n; i++) {
      this.v += (-w * w * (this.h - target) - 2 * w * this.v) * k;
      this.h += this.v * k;
    }
    return this.h;
  }
}
