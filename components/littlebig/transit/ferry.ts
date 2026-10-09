// V1 (v2): the ferries on R1's routes (world/region/types.ts FerryRoute: a closed loop out from berth
// a to berth b and back on the other side). Pure apart from the mesh: a closed-form timetable (dock,
// ease out, cruise, ease in, dock at the far side, back), so any time jump lands every boat exactly,
// and a code-built double-ended car ferry (the capital's VehicleBuilder: rounded boxes, the same
// attributes, so it draws through the vehicle patch, traffic/index.ts, with no program of its own).
//
// Double-ended: the hull, the cabin and the lights are the same at both ends, so at a berth the boat
// simply reverses out the way it came in (the loop's cusp) instead of turning round. Its wake (variant 5,
// shown while it is under way) trails whichever end is aft.

import { BufferGeometry, Color } from 'three';
import { GLASS, VehicleBuilder } from '../traffic/mesh';
import { wsample, wsampleOut } from '../world/region/path';
import { hash3 } from '../world/rng';
import type { FerryRoute } from '../world/region/types';
import { v3, type Vec3 } from '../world/sphere';

/** Hull length, beam and height to the wheelhouse roof (m). */
export const FERRY_LEN = 13;
export const FERRY_BEAM = 4.8;
export const FERRY_HEIGHT = 3.8;
/** Seconds at each berth, cruise speed (m/s) and the easing in and out of the berths (m/s²). */
export const FERRY_DWELL = 16;
const V_CRUISE = 5.2;
const A_EASE = 0.32;
/** The wake's variant (traffic/index.ts PATCH_VERT: parts with aHub.w = 3 + v show when aVar = v). */
export const WAKE = 5;

const hex = (h: string) => new Color(h);
const PAINT = hex('#ffffff');
const WHITE = hex('#f6f3ec');
const HULL = hex('#9c3a3a');
const DARK = hex('#3c3a4f');
const DECK = hex('#5d5b6e');
const FUNNEL = hex('#ffb84d');
const ORANGE = hex('#ff8a3d');
const HEAD = hex('#fff4cc');
const TAIL = hex('#e8384a');
const FOAM = hex('#eef6fb');

/** The ferry (`lo`: the far LOD). Local frame as the vehicles': +z ahead, +y up, +x left, origin on the waterline. */
export function buildFerry(lo = false): BufferGeometry {
  const b = new VehicleBuilder(lo);
  const L = FERRY_LEN;
  const W = FERRY_BEAM;
  const lit = { lamp: [0.55, 0, 0] as const };
  b.box(0, -0.38, 0, W - 0.5, 0.9, L - 0.8, 0.4, HULL) // below the waterline: antifouling red
    .box(0, 0.5, 0, W, 0.92, L, 0.38, PAINT, { tint: 1 }) // the hull's band (the boat's colour)
    .box(0, 0.08, 0, W + 0.08, 0.14, L - 0.5, 0.05, DARK) // rubbing strake
    .box(0, 0.99, 0, W - 0.5, 0.06, L - 0.9, 0, DECK) // the car deck
    .box(0, 2.2, 0, W - 0.7, 1.36, 4.2, 0.24, WHITE) // the saloon over it
    .box(0, 2.98, 0, W - 0.3, 0.12, 4.8, 0.05, PAINT, { tint: 1 }) // its roof, the boat's colour
    .box(0, 3.4, 0, 2.3, 0.72, 2.1, 0.16, WHITE) // the wheelhouse
    .box(0, 3.46, 0, 2.36, 0.34, 2.16, 0, GLASS, { lamp: [0.4, 0, 0] }) // its windows all round
    .lathe(0, 0.95, [0.4, 3.0, 0.4, 3.9, 0.46, 4.0], 10, FUNNEL)
    .box(0, 4.18, -0.95, 0.07, 1.1, 0.07, 0, WHITE) // mast …
    .box(0, 4.78, -0.95, 0.2, 0.2, 0.2, 0.05, HEAD, { lamp: [1, 0, 0] }); // … and its masthead light
  for (const sx of [1, -1]) {
    b.box(sx * (W / 2 - 0.12), 1.32, 0, 0.12, 0.6, L - 1.8, 0.04, WHITE) // bulwarks
      .box(sx * ((W - 0.7) / 2 + 0.01), 2.3, 0, 0.05, 0.56, 3.6, 0, GLASS, lit) // saloon windows (lit at night)
      .box(sx * 1.55, 3.12, 1.25, 0.46, 0.34, 1.25, 0.14, ORANGE); // lifeboats
    for (const sz of [1, -1]) {
      b.box(0, 2.3, sz * 2.11, W - 1.4, 0.56, 0.05, 0, GLASS, lit)
        .box(0, 1.02, sz * (L / 2 - 0.25), W - 1.3, 0.08, 0.8, 0, DARK, { rx: sz * 0.14 }) // the ramps
        .box(sx * (W / 2 - 0.3), 1.78, sz * (L / 2 - 0.7), 0.16, 0.16, 0.16, 0.04, TAIL, { lamp: [0, 1, 0] }); // the corner lights
    }
  }
  // the wake: a fan of foam astern and a wash along both sides, only while under way
  b.variant(WAKE, (v) => {
    v.box(0, 0.03, -L / 2 - 3.4, 3.4, 0.03, 6.4, 0, FOAM, { taper: 0 }).box(0, 0.03, -L / 2 - 8.6, 2.0, 0.03, 4, 0, FOAM);
    for (const sx of [1, -1]) v.box(sx * (W / 2 + 0.3), 0.03, -0.8, 0.5, 0.03, L - 2.4, 0, FOAM);
  });
  return b.geometry();
}

/** Where a ferry is: arc length on its loop, speed (m/s), the berth it is at (−1: under way), and the
 * berth it is heading for (or leaves for next) with the seconds left until it docks / leaves. */
export interface FerryState {
  s: number;
  v: number;
  docked: number;
  toward: number;
  left: number;
}

/** Seconds to cover a leg of length L from rest to rest, and the arc and speed τ s into it (τ < 0: just the time). */
function leg(L: number, tau: number, out: FerryState): number {
  let vp = V_CRUISE;
  let ta = vp / A_EASE;
  let da = (vp * vp) / (2 * A_EASE);
  if (2 * da > L) {
    vp = Math.sqrt(A_EASE * L);
    ta = vp / A_EASE;
    da = L / 2;
  }
  const tc = (L - 2 * da) / vp;
  const T = 2 * ta + tc;
  if (tau < 0) return T;
  if (tau < ta) {
    out.v = A_EASE * tau;
    out.s = 0.5 * A_EASE * tau * tau;
  } else if (tau < ta + tc) {
    out.v = vp;
    out.s = da + vp * (tau - ta);
  } else {
    const r = Math.max(0, T - tau);
    out.v = A_EASE * r;
    out.s = L - 0.5 * A_EASE * r * r;
  }
  return T;
}

/** It docks end-on: its centre this far (m) short of the berth (the pier's tip), its ramp on the deck. */
const OFF = FERRY_LEN / 2 + 0.4;
/** Over this much of each leg's ends (m) it eases onto the berth's line (the loop's two legs meet there 0.8 m apart). */
const EASE = 16;

export interface FerryTrack {
  route: FerryRoute;
  /** Seconds for a whole round (both crossings and both stays). */
  period: number;
  /** When in its round (s) it docks at berth b. */
  dockAt(b: number): number;
  /** The state at time t (s), shifted `phase` s along the round. Zero-alloc (writes out). */
  at(t: number, phase: number, out: FerryState): FerryState;
  /** World position (on the sea surface) and unit heading of state st. Zero-alloc. */
  pose(st: FerryState, pos: Vec3, fwd: Vec3): void;
}

/**
 * A ferry's timetable and pose on route f. `minPeriod`: its round lengthened to at least this by a
 * longer stay at berth a (ferries sharing a pier keep one timetable, index.ts, so they take turns).
 */
export function ferryTrack(f: FerryRoute, minPeriod = 0): FerryTrack {
  const L = f.lane.length;
  const L0 = f.berthS[1];
  const l0 = L0 - 2 * OFF;
  const l1 = L - L0 - 2 * OFF;
  const tmp: FerryState = { s: 0, v: 0, docked: 0, toward: 0, left: 0 };
  const T0 = leg(l0, -1, tmp);
  const T1 = leg(l1, -1, tmp);
  const DA = FERRY_DWELL + Math.max(0, minPeriod - (2 * FERRY_DWELL + T0 + T1));
  const period = DA + FERRY_DWELL + T0 + T1;
  const q = wsampleOut();
  const at = (s: number, o: Vec3) => {
    q.i = 0;
    wsample(f.lane, s, q);
    o.x = q.x;
    o.y = q.y;
    o.z = q.z;
    return o;
  };
  // each berth's dock point: halfway between the two legs' ends there
  const A1 = at(OFF, v3());
  const A2 = at(L - OFF, v3());
  const B1 = at(L0 - OFF, v3());
  const B2 = at(L0 + OFF, v3());
  const Ma = v3((A1.x + A2.x) / 2, (A1.y + A2.y) / 2, (A1.z + A2.z) / 2);
  const Mb = v3((B1.x + B2.x) / 2, (B1.y + B2.y) / 2, (B1.z + B2.z) / 2);
  const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  return {
    route: f,
    period,
    dockAt: (b) => (b ? DA + T0 : 0),
    at(t, phase, out) {
      let u = (((t + phase) % period) + period) % period;
      out.docked = -1;
      if (u < DA) {
        out.s = OFF;
        out.v = 0;
        out.docked = 0;
        out.toward = 1;
        out.left = DA - u;
        return out;
      }
      u -= DA;
      if (u < T0) {
        leg(l0, u, out);
        out.s += OFF;
        out.toward = 1;
        out.left = T0 - u;
        return out;
      }
      u -= T0;
      if (u < FERRY_DWELL) {
        out.s = L0 - OFF;
        out.v = 0;
        out.docked = 1;
        out.toward = 0;
        out.left = FERRY_DWELL - u;
        return out;
      }
      u -= FERRY_DWELL;
      leg(l1, u, out);
      out.s += L0 + OFF;
      out.toward = 0;
      out.left = T1 - u;
      return out;
    },
    pose(st, pos, fwd) {
      const s = st.s;
      q.i = 0;
      wsample(f.lane, s, q);
      const x = q.x;
      const y = q.y;
      const z = q.z;
      fwd.x = q.tx;
      fwd.y = q.ty;
      fwd.z = q.tz;
      // onto the dock point near either berth: the gap from the leg's own end point there, weighted
      const out = s < L0;
      const wa = out ? 1 - smooth((s - OFF) / EASE) : smooth((s - (L - OFF - EASE)) / EASE);
      const wb = out ? smooth((s - (L0 - OFF - EASE)) / EASE) : 1 - smooth((s - (L0 + OFF)) / EASE);
      const ea = out ? A1 : A2;
      const eb = out ? B1 : B2;
      pos.x = x + (Ma.x - ea.x) * wa + (Mb.x - eb.x) * wb;
      pos.y = y + (Ma.y - ea.y) * wa + (Mb.y - eb.y) * wb;
      pos.z = z + (Ma.z - ea.z) * wa + (Mb.z - eb.z) * wb;
    },
  };
}

/**
 * Every ferry's timetable and its phase (s) in its round, seeded. Boats sharing a pier keep one round's
 * length (the longest of theirs: a longer stay at their other end) and dock at it in turn, a whole
 * round shared out evenly between them, so two never meet at a berth.
 */
export function ferryFleet(ferries: readonly FerryRoute[], seed: number): { tracks: FerryTrack[]; phase: number[] } {
  const pierOf = (k: number, b: number) => (b ? ferries[k].b : ferries[k].a);
  const shares = (j: number, k: number) => [0, 1].some((b) => [0, 1].some((c) => pierOf(j, c) === pierOf(k, b)));
  const own = ferries.map((f) => ferryTrack(f).period);
  const tracks: FerryTrack[] = [];
  const phase: number[] = [];
  ferries.forEach((f, k) => {
    const mates = ferries.map((_, j) => j).filter((j) => shares(j, k));
    const tr = ferryTrack(f, Math.max(...mates.map((j) => own[j])));
    tracks.push(tr);
    const lead = mates[0];
    const ph0 = hash3(seed, lead, 11) * tr.period;
    if (lead === k) {
      phase.push(ph0);
      return;
    }
    // the pier they share: this boat's berth b, the lead's berth c there
    const b = [0, 1].find((x) => [0, 1].some((c) => pierOf(lead, c) === pierOf(k, x)))!;
    const c = [0, 1].find((x) => pierOf(lead, x) === pierOf(k, b))!;
    const lt = ferryTrack(ferries[lead], tr.period);
    // the lead docks there when (t + ph0) ≡ lt.dockAt(c); this one m / n of a round after it
    phase.push(tr.dockAt(b) - lt.dockAt(c) + ph0 - (tr.period * mates.indexOf(k)) / mates.length);
  });
  return { tracks, phase };
}
