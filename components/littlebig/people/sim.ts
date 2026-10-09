// People (B2): the pedestrian simulation. Pure (no three.js), deterministic, zero-alloc per step.
//
// Walkers are persistent agents on the plan's walk graph (sidewalks, corners, zebra crossings,
// plaza and park paths, the market lane). Each one integrates a 2D position in plan space and
// steers at a target LOOK metres ahead along its walk edge, offset to the right of travel (so the
// two directions pass each other), and:
//   - sidesteps every point obstacle on its path (lamps, trunks, benches, café tables, bus
//     shelters, people sitting or standing about) by choosing a lateral offset outside their discs
//     (a 1D interval problem per step);
//   - sidesteps oncoming and standing people the same way, follows slower people walking its way,
//     and yields to crossing traffic of other people by id;
//   - at a zebra crossing waits at the kerb (0.5 m back, in the right half, so people arriving
//     from the other side pass on its left, and stepping back to give them the landing) until the
//     crossing is open — CrossingState.blocked clear, plus a per-crossing walk cycle so people
//     cross in little groups — and flags it busy from the moment it commits until it is past the
//     far kerb. Someone committed but still on the kerb steps back if `blocked` comes up; nobody
//     ever commits while it is up, so busy never rises under a car. A crosser held up on the
//     crossing for JAM_S squeezes past standing people and idlers (a brief overlap beats a jam);
//   - is pushed out of buildings and obstacles as a last resort (push-outs are rate-limited, so
//     nobody jumps sideways in a crowd);
//   - turns back after a few seconds of being stuck, or after ~17 s of waiting at a kerb.
// At a node it picks its next edge at random (seeded per decision), biased toward its home radius
// so downtown stays busier than the outskirts. Dogs are followers of their owner (trotting ahead
// on the left, at heel while the owner waits). `on` thins the crowd at night: an inactive walker is
// frozen and drawn by nobody (the renderer only toggles it out of view).
//
// Zero-alloc: no Math.hypot (V8 allocates its argument list), scratch objects of private classes
// (their double fields never share a map with someone else's {x, z}), and CityIndex queries only
// where a walker is not well inside its edge's precomputed paving room.
//
// Time jumps (setTime / init): walkers are re-placed from a hash of t and settled for SETTLE_S of
// sim, so the same t always gives the same world.

import type { Building, CityIndex, CityPlan, Feature, PathSample, Polyline, WalkEdge } from '../world/city/types';
import { CURB_H, EYE_HEIGHT, ROAD_H } from '../world/config';
import { hash3, hashSeed, Rng } from '../world/rng';

/** Body radius for collisions (shoulders ~0.44 m wide). */
export const BODY_R = 0.22;
/** Centre-to-centre distance two people keep when they pass. */
const PASS_GAP = 0.56;
/** People never come closer than this, centre to centre (m). */
const SEP = 2 * BODY_R + 0.04;
/** Steering target distance along the path (m). */
const LOOK = 1.1;
/** Sideways speed limit of the lateral offset (m/s). */
const LAT_SPEED = 0.9;
/** How far ahead (m) obstacles shape the lateral choice. */
const OBS_AHEAD = 4.5;
/** Neighbour grid cell (m): the 3×3 block covers ±CELL around an agent. */
const CELL = 3;
/** Crossing walk cycle: open for CROSS_OPEN of every CROSS_CYCLE seconds (offset per crossing). */
const CROSS_CYCLE = 13;
const CROSS_OPEN = 4.5;
/** Kerb waiters stand this far back from the kerb line (m). */
const WAIT_BACK = 0.5;
/**
 * v2 (L1): the ridden walker (`rider`, the camera in its head) keeps this far from people, centre
 * to centre, both ways (it plans round them, they plan round it), stops this far short of someone
 * in its way (RIDER_STOP) and follows someone walking its way at RIDER_FOLLOW, so no face or back
 * ever fills the lens; at a kerb it waits RIDER_WAIT_BACK back (stepping back to it), clear of the
 * cars' swept paths.
 */
const RIDER_GAP = 1.0;
const RIDER_STOP = 1.25;
const RIDER_FOLLOW = 1.8;
const RIDER_WAIT_BACK = 1.25;
/**
 * …and the pass it prefers (a soft gap: taken whenever the paving has room, else RIDER_GAP), seen
 * RIDER_LOOK ahead, so an oncoming walker veers off early instead of walking up to the lens.
 */
const RIDER_SOFT = 1.2;
/**
 * …and brakes for anyone within RIDER_BRAKE whose line it would cross (closer than RIDER_GAP to
 * its line of travel; stopping RIDER_STOP − 0.2 short); anyone walking at the rider stops
 * RIDER_MEET short of it; with no way round at all within RIDER_TURN it meets the rider (below).
 */
const RIDER_BRAKE = 2.2;
const RIDER_MEET = 1.5;
const RIDER_TURN = 4;
/** The berth's last resort: closer than RIDER_SEP (RIDER_SEP_FRONT within ±55° of where the rider faces), the other is pushed off at RIDER_PUSH (m/s). */
const RIDER_SEP = 0.9;
const RIDER_SEP_FRONT = 1.3;
const RIDER_PUSH = 0.9;
/** On the carriageway the rider never slows below this for the berth (it follows, it does not stop on the road). */
const RIDER_ROAD_V = 0.5;
/** The rider gives up on a kerb after standing there this long (s): a car holding the zebra, people ahead on it. */
const RIDER_KERB_S = 2.8;
/** The rider's head turning round (rad/s), through the open side (riderOpenT). */
const RIDER_TURN_W = 2.2;
/**
 * Round 4: what the lens shows. The rider keeps RIDER_TAIL (× riderK, eye to body) from anyone
 * walking its way inside its view cone (cos RIDER_CONE about where it looks) unless it is already
 * RIDER_PASS to the side of them and quicker (overtaking, up to RIDER_V_MAX); people slower than
 * it in its way keep to one side for it. Someone coming at the eye who cannot pass that wide
 * within RIDER_TTC (or 3.2 m) meets it: steps aside and stands turned side-on until it is by, or
 * on paving too narrow for that turns back, and hurries off (HURRY_S, ×HURRY_K) another way.
 */
const RIDER_TAIL = 3.2;
/**
 * L1f round 5: a back kept RIDER_TAIL off for RIDER_TAIL_T s is tailing a stranger. Where the
 * pavement ahead has room the rider overtakes (they keep to their side and ease off), else it drops
 * back to RIDER_TAIL_FAR (a back at 3 m filled the middle of the frame for 5–15 s; at 5.5 m it was
 * still the middle of the view for 8 s).
 */
const RIDER_TAIL_T = 1.2;
const RIDER_TAIL_FAR = 7.5;
/**
 * L1f refine 2: strangers' backs in the middle of the view (inside ±30° of where the rider looks,
 * within RIDER_BACK_R × riderK; the critic r2 counted a back within 5 m inside ±30° for more than
 * 5 s as tailing, groups included). After RIDER_BACK_T s of them, unless the rider is passing them
 * wide: everyone walking away in the middle of its view within RIDER_BACK_HURRY steps out briskly
 * (a group walks on as one), the rider eases to RIDER_BACK_EASE of their pace (never under
 * RIDER_BACK_MIN), and if the nearest is standing about or barely getting on within RIDER_BACK_STOP
 * it goes another way: on at its join if that is close, else it turns round, its head through the
 * open side (a knot waiting at a corner otherwise stood a metre from a kid's eye).
 */
const RIDER_BACK_R = 5.2;
const RIDER_BACK_T = 0.6;
const RIDER_BACK_HURRY = 9;
const RIDER_BACK_EASE = 0.5;
const RIDER_BACK_MIN = 0.45;
const RIDER_BACK_STOP = 4;
/** …and after RIDER_BACK_CAP s of one not dropping away (the critic r2: cap following at about 3 s), it turns round. */
const RIDER_BACK_CAP = 3;
const RIDER_CONE = 0.62;
const RIDER_PASS = 1.0;
/**
 * L1f refine 1: two walking at each other (one of them the rider) plan a pass RIDER_SOFT_ONC wide
 * (eye to body centre, × riderK), weighed W_ONC per metre short of it (the props' and kerb's soft
 * gaps give way to it); someone coming at the eye who cannot pass RIDER_PASS_ONC wide meets the
 * rider (stands aside, or turns back while still a way off). At 1.0 m a passer-by's head was a third
 * to half of the frame's height at its edge, smiling into the lens (the critic r1's person:113, 2, 68).
 */
const RIDER_SOFT_ONC = 1.6;
const RIDER_PASS_ONC = 1.35;
const W_ONC = 7;
const RIDER_TTC = 2.4;
const RIDER_V_MAX = 1.6;
/** Crossing paths: how far short of the crossing point (eye to body centre, × riderK) whoever goes second waits. */
const RIDER_CROSS = 1.5;
const HURRY_S = 5;
const HURRY_K = 1.3;
/** The rider plans round people from this far ahead (soft, fading with distance); others see it from as far. */
const RIDER_LOOK = 7;
/**
 * The eye's clearance from props and people sitting or standing about (m from the body centre's
 * line to the disc's edge, × riderK): tall things (a lamp post, a trunk, a shelter, a head) more
 * than low ones (a bench back, a planter, a hydrant: under the frame within a metre of an adult eye).
 */
const RIDER_CLEAR_TALL = 0.95;
const RIDER_CLEAR_LOW = 0.6;
/** …and the clearance it gives up for a tall one only when there is no other way at all (a heavy soft interval, W_PROP_HARD: a wall here walled it in between two lamp posts). */
const RIDER_CLEAR_HARD = 0.62;
/**
 * The berth's scale (riderK) riding a kid's eyes: from its low eye a grown-up fills the frame from
 * further off (L1f refine 1: 1.3 → 1.45; the critic's landing ride, a kid, stood 3 s behind an
 * adult's back at 1.4 m with grown-ups' backs filling the frame).
 */
export const RIDER_KID_K = 1.45;
/** Seconds after a ride starts (the camera flying in) in which the view is cleared and people keep RIDER_SEP_FRESH. */
const RIDER_FRESH = 2.4;
const RIDER_SEP_FRESH = 1.7;
/**
 * The rider looks left and right at a kerb at least this long (s) before it steps off onto a free
 * zebra (its camera runs the kerb glance RIDER_GLANCE_RATE times as fast: left, right, go).
 */
const RIDER_KERB_LOOK = 1.8;
export const RIDER_GLANCE_RATE = 1.6;
/** Soft interval weights (lateral cost per metre inside): people, props, an overtake, a tall prop's near clearance, the kerb band. */
const W_PEOPLE = 3;
const W_PROP = 2;
const W_PASS = 1.2;
const W_PROP_HARD = 8;
/** …and a prop's body disc while it is still soft (more than 2.5 m on, or round the corner): heavy, so the line moves off it in time. */
const W_PROP_FAR = 14;
const W_KERB = 6;
/** The kerb-side band of a pavement the rider keeps out of (m): a turning bus sweeps the corner. */
const KERB_BAND = 0.85;
/** Interval scratch: the rider plans round everyone within RIDER_LOOK and its props' clearances (others keep v1's 48). */
const IV_MAX = 160;
/** Seconds held up on a crossing before squeezing past standing people and idlers. */
const JAM_S = 2.5;
/** Speed limit of push-outs (people, props) on top of a walker's own step (m/s). */
const PUSH_SPEED = 1.6;
/** A walker this close to its edge's end moves onto the next edge (m). */
const END_U = 0.03;
/** Seconds of sim run after a time-jump placement so people settle into their stride. */
const SETTLE_S = 1.5;
const SETTLE_DT = 1 / 30;
export const SETTLE_STEPS = Math.round(SETTLE_S / SETTLE_DT);
/** Seconds of unwanted standstill after which a walker turns back. */
const STUCK_S = 3.5;
/** How far ahead (m, plus its radius) a walker sees a filming camera (`step`'s `lens`). */
const LENS_REACH = 5;

export const enum Pose {
  Walk = 0,
  Sit = 1,
  Stand = 2,
  Cafe = 3,
  Lean = 4,
}

/** Below this altitude (m) a camera settling onto the street, or standing still, is a lens walkers make way for. */
const LENS_ALT = 6;
/** The berth (m) walkers give a lens: past it at this much, or (narrow pavements) they turn round before it. */
const LENS_R = 1.6;
/** Fixed steps between the speed samples (0.1 s at 60 Hz), the history ring, and the furthest look ahead (m). */
const LENS_LAG = 6;
const LENS_HIST = 16;
const LENS_RUN = 15;
/** A settling camera comes to rest at eye height over the pavement (m, ViewState.altTerrain). */
const LENS_EYE = EYE_HEIGHT + ROAD_H + CURB_H;

/**
 * How walkers see the camera, from its plan position and altitude each fixed step (`step`'s camOn,
 * camX/camZ, camR and lens). A walking player is avoided like a standing person (r 0.75, below
 * 3 m). A camera standing still, or settling down onto the pavement (the dive, scroll or fly-to: a
 * continuous descent, so no cut clears the lens), is a lens from LENS_ALT down: seen from further
 * ahead and given LENS_R, so nobody walks up to it, parks in front of it, or brushes past it at
 * arm's length. While it settles, the lens is where it will come to rest (x, z): its plan position
 * run on by its glide (horizontal / vertical speed × the height left to eye level, × 1.5 for the
 * flare: on the scripted dive it closes from 4.6 m short of the landing at 5.5 m up to within 0.1 m
 * from 2.4 m), or by its
 * stopping distance (v² / 2a) once it brakes, whichever is shorter. Walkers near the landing then
 * turn round before it touches down, not as the camera sweeps up to them.
 */
export class LensWatch {
  on = false;
  r = 0.75;
  lens = false;
  /** Where walkers see the camera (plan m). */
  x = 0;
  z = 0;
  /** Recent plan positions (a ring of fixed steps), for the speed and braking now and 0.1 s ago. */
  private readonly hx = new Float64Array(LENS_HIST);
  private readonly hz = new Float64Array(LENS_HIST);
  private readonly ha = new Float64Array(LENS_HIST);
  private n = 0;
  private alt = Infinity;
  private still = 0;
  private settle = 0;

  update(dt: number, x: number, z: number, alt: number, inCity: boolean): void {
    // a camera cut (> 4 m in one step): the speed history starts over
    if (this.n > 0) {
      const l = (this.n - 1) % LENS_HIST;
      if ((x - this.hx[l]) ** 2 + (z - this.hz[l]) ** 2 > 16) this.n = 0;
    }
    const k = this.n % LENS_HIST;
    this.hx[k] = x;
    this.hz[k] = z;
    this.ha[k] = alt;
    this.n++;
    const p1 = (this.n - 1 - LENS_LAG + LENS_HIST * 4) % LENS_HIST;
    const mx = x - this.hx[(this.n - 2 + LENS_HIST) % LENS_HIST];
    const mz = z - this.hz[(this.n - 2 + LENS_HIST) % LENS_HIST];
    this.still = this.n > 1 && mx * mx + mz * mz < (0.3 * dt) ** 2 ? Math.min(1, this.still + dt) : 0;
    // (a scripted 30 fps descent moves on every other 60 Hz step: the settle flag holds 0.6 s)
    this.settle = inCity && alt < LENS_ALT && alt < this.alt - 0.02 * dt ? 0.6 : Math.max(0, this.settle - dt);
    this.alt = alt;
    const still = this.still >= 0.5;
    this.lens = inCity && alt < LENS_ALT && (still || this.settle > 0);
    this.on = inCity && (alt < 3 || this.lens);
    this.r = this.lens ? LENS_R : 0.75;
    this.x = x;
    this.z = z;
    if (!this.lens || still || this.n <= 2 * LENS_LAG) return;
    // speed over the last LENS_LAG steps and the LENS_LAG before
    const p2 = (p1 - LENS_LAG + LENS_HIST * 4) % LENS_HIST;
    const w = LENS_LAG * dt;
    const vx = (x - this.hx[p1]) / w;
    const vz = (z - this.hz[p1]) / w;
    const v1x = (this.hx[p1] - this.hx[p2]) / w;
    const v1z = (this.hz[p1] - this.hz[p2]) / w;
    const v = Math.sqrt(vx * vx + vz * vz);
    if (v < 0.05) return;
    const brake = (Math.sqrt(v1x * v1x + v1z * v1z) - v) / w;
    const sink = (this.ha[p1] - alt) / w;
    let run = sink > 0.05 ? (1.5 * v * Math.max(0, alt - LENS_EYE)) / sink : LENS_RUN;
    if (brake > 0.5) run = Math.min(run, (v * v) / (2 * brake));
    run = Math.min(run, LENS_RUN);
    this.x = x + (vx / v) * run;
    this.z = z + (vz / v) * run;
  }
}

export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

/** A person who stays put: sitting on a bench or at a café table, or standing about. */
export interface Idler {
  x: number;
  z: number;
  /** Height of the feet / seat reference above the plateau (m): the seat top for sitters. */
  h: number;
  /** Facing as a plan direction (unit). */
  fx: number;
  fz: number;
  pose: Pose;
  /** Look id (index into the person table). */
  id: number;
}

/** Per-edge data the walkers need, precomputed once. */
interface EdgeInfo {
  e: WalkEdge;
  len: number;
  /** Lateral room for a body centre right (hiR) / left (hiL) of the centreline, a→b frame (m). */
  hiR: number;
  hiL: number;
  /** Obstacles near the edge: arc length (a→b, past the ends along the end tangent), lateral (right of a→b), clearance, obstacle index. */
  oS: Float64Array;
  oL: Float64Array;
  oR: Float64Array;
  oI: Int32Array;
  crossing: boolean;
  /** Walking surface height (m above the plateau); crossings: the kerb side. */
  hEdge: number;
  /** Crossings: the carriageway height. */
  hRoad: number;
  /** Crossings: arc length from the path's start / end to the kerb. */
  kerbA: number;
  kerbB: number;
  /** Crossings: the landing on the start / end side (up to 0.35 m short of the kerb, ± the strip) is all paving. */
  landA: boolean;
  landB: boolean;
  kindW: number;
  /** Pavements: +1 the carriageway is right of a→b, −1 left, 0 neither (the rider keeps to the far side). */
  roadSide: number;
}

const KIND_W: Record<string, number> = { sidewalk: 1, corner: 1, crossing: 0.75, plaza: 1.5, park: 1.15, footpath: 1.3 };
const DEFAULT_R: Record<string, number> = { streetlight: 0.2, lamp: 0.2, hydrant: 0.25, flag: 0.15, fountain: 1.6, planter: 0.5, statue: 0.8, tree: 0.4 };
/** Props that are several discs: local x offsets, lateral offset, radius. */
const MULTI: Record<string, [number[], number, number]> = { bench: [[-0.6, 0, 0.6], 0, 0.42], 'cafe-table': [[-0.64, 0, 0.64], 0, 0.42], 'bus-stop': [[-1.2, -0.6, 0, 0.6, 1.2], 0.05, 0.62] };

/**
 * How tall each prop stands (m above the paving, roughly its top): the rider keeps a tall one (a
 * lamp post, a tree, a shelter, a person) further from its eye than a low one (city/props.ts).
 */
const PROP_H: Record<string, number> = { streetlight: 4.5, lamp: 3.2, hydrant: 0.6, flag: 5, fountain: 1.4, planter: 0.75, statue: 2.6, tree: 5, bench: 0.9, 'cafe-table': 2.2, 'bus-stop': 2.5 };

/** Obstacle discs for walkers from the plan's features (bigger props as several discs); `heights` (optional) gets each disc's PROP_H. */
export function featureObstacles(features: readonly Feature[], heights?: number[]): Obstacle[] {
  const out: Obstacle[] = [];
  for (const f of features) {
    const c = Math.cos(f.angle);
    const s = Math.sin(f.angle);
    const at = (lx: number, lz: number, r: number) => {
      out.push({ x: f.x + lx * c - lz * s, z: f.z + lx * s + lz * c, r });
      heights?.push(f.kind === 'bus-stop' && r < 0.2 ? 2.4 : (PROP_H[f.kind] ?? 1));
    };
    const m = MULTI[f.kind];
    if (m) for (const lx of m[0]) at(lx, m[1], m[2]);
    if (f.kind === 'bus-stop') at(1.75, -0.4, 0.12);
    const r = m ? 0 : Math.max(f.r ?? 0, DEFAULT_R[f.kind] ?? 0);
    if (r > 0) at(0, 0, r);
  }
  return out;
}

/** A ride cut's spot for someone it moves (offset dx, dz from the eye looking fx, fz): out of the view first, then further off. */
function cutScore(dx: number, dz: number, fx: number, fz: number): number {
  return dx * dx + dz * dz - (dx * fx + dz * fz > 0 ? 100 : 0);
}

/**
 * L1f refine 2: the columns carrying the overhang at the front corners of the city's blocks — the
 * 0.4 m square posts city/buildings.ts block() puts at (±hw, −hd + 0.2) of its first tier, on every
 * building drawn by block() but the café (towers, offices, midrises; not houses, shops or landmarks).
 * They stand inside the footprint, so no walker's body meets them, but the rider walking the shop
 * side of the pavement passed them at 0.7–1.0 m, a grey pillar filling a third of the frame (the
 * critic r2's person:133, 186, 116, 213): the rider keeps its tall-prop clearance from them, and the
 * lens measures count them. `heights` (optional) gets each one's height.
 */
export function columnObstacles(buildings: readonly Building[], heights?: number[]): Obstacle[] {
  const out: Obstacle[] = [];
  for (const b of buildings) {
    if (b.landmark === 'clocktower' || b.landmark === 'stadium' || b.landmark === 'church') continue;
    if (b.style === 'house' || b.style === 'shop' || b.decor === 'cafe') continue;
    const t0 = b.tiers?.length ? b.tiers[0] : { h: b.h, inset: 0 };
    const hw = b.w / 2 - (t0.inset + 0.28);
    const hd = b.d / 2 - (t0.inset + 0.28);
    if (hw < 1.5 || hd < 1.5) continue;
    const c = Math.cos(b.angle);
    const s = Math.sin(b.angle);
    for (const sx of [-1, 1]) {
      const lx = sx * hw;
      const lz = -hd + 0.2;
      out.push({ x: b.x + lx * c - lz * s, z: b.z + lx * s + lz * c, r: 0.28 });
      heights?.push(Math.min(4.2, t0.h - 1.3));
    }
  }
  return out;
}

/** Scratch shapes of their own (see the header: zero-alloc). */
class SL {
  s = 0;
  l = 0;
  d = 0;
  /** Inputs of nearestIn: the query point and the arc length to search up to. */
  x = 0;
  z = 0;
  sMax = 0;
}
class Sample implements PathSample {
  x = 0;
  z = 0;
  tx = 0;
  tz = 0;
  i = 0;
  /** Input of sampleIn: the arc length. */
  s = 0;
}
const SL0 = new SL();
const SM0 = new Sample();
class XZ {
  x = 0;
  z = 0;
}
/** The walker being stepped, for berthPair (in), and what the rider's berth makes of it (out). */
class Berth {
  xi = 0;
  zi = 0;
  tx = 0;
  tz = 0;
  nx = 0;
  nz = 0;
  latCur = 0;
  e = 0;
  d = 0;
  /** Flags (0 / 1): waiting at a kerb, out on a crossing, on its carriageway, squeezing past. */
  waiting = 0;
  out = 0;
  carriageway = 0;
  squeeze = 0;
  /** Out: the speed cap, held up by the rider (turns round sooner), giving the landing, the rider's hard interval and how far ahead it is. */
  cap = Infinity;
  block = 0;
  yieldTo = 0;
  riderQ = -1;
  rAlong = 0;
  /** Out: the walker the rider is following (−1: none). */
  lead = -1;
  /** Out (the rider): the nearest back inside its view cone: how far ahead, to the side (travel frame), its speed along and distance. */
  leadAlong = 0;
  leadSide = 0;
  leadV = 0;
  leadD = 0;
  /** Out (anyone else): coming at the rider's eye (1): time and distance of the closest approach, the rider's lateral on its path (NaN: not on it). */
  onc = 0;
  tc = 0;
  cpa = 0;
  rLat = 0;
  /** Out (anyone else, a ride's first seconds): in the rider's view, facing it, near: turn away. */
  clear = 0;
  /** Out (the rider): someone standing close in its way with their back to it. */
  backNear = 0;
  /** Out (the rider): someone walking its way abreast of it, close beside the eye (−1: none). */
  abreast = -1;
  /**
   * Out (the rider, L1f refine 2): strangers' backs in the middle of its view (inside ±30° of where
   * it looks, within RIDER_BACK_R × riderK): how many, the nearest (−1: none), its distance, how fast
   * it actually gets on, and where it is along and across the rider's path (centre-line frame).
   */
  /** Out: waiting its turn at a crossing point with the rider (no hold-up: it does not count toward turning back). */
  crossY = 0;
  bkN = 0;
  bkJ = -1;
  bkD = 0;
  bkV = 0;
  bkAlong = 0;
  bkL = 0;
  /** Out: a kerb waiter with the rider right behind it does not step back to give the landing; one the rider comes off the crossing at steps aside. */
  noBack = 0;
  aside = 0;
}

/** Facing (hx, hz) and travelling (tx, tz) toward a point at (rx, rz) from here (inside ±72° both). */
function towardRider(hx: number, hz: number, tx: number, tz: number, rx: number, rz: number): boolean {
  const d = Math.sqrt(rx * rx + rz * rz) || 1;
  return hx * rx + hz * rz > 0.3 * d && tx * rx + tz * rz > 0.3 * d;
}

/** Nearest point on a polyline from sample index lo while s ≤ sMax: arc length and signed lateral offset (right of a→b). */
export function nearestSL(pl: Polyline, x: number, z: number, out: { s: number; l: number; d: number }, lo = 0, sMax = Infinity): void {
  SL0.x = x;
  SL0.z = z;
  SL0.sMax = sMax;
  nearestIn(pl, SL0, lo);
  out.s = SL0.s;
  out.l = SL0.l;
  out.d = SL0.d;
}

/** nearestSL with its inputs in `out` (x, z, sMax): doubles never cross a call boundary in the hot loop. */
function nearestIn(pl: Polyline, out: SL, lo: number): void {
  const p = pl.pts;
  const S = pl.s;
  const x = out.x;
  const z = out.z;
  const sMax = out.sMax;
  let best = Infinity;
  for (let i = lo; i < (p.length >> 1) - 1 && S[i] <= sMax; i++) {
    const x0 = p[i * 2];
    const z0 = p[i * 2 + 1];
    const dx = p[i * 2 + 2] - x0;
    const dz = p[i * 2 + 3] - z0;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2));
    const qx = x - x0 - dx * t;
    const qz = z - z0 - dz * t;
    const d2 = qx * qx + qz * qz;
    if (d2 < best) {
      best = d2;
      out.s = S[i] + t * (S[i + 1] - S[i]);
      out.l = (qz * dx - qx * dz) / Math.sqrt(l2); // right of (dx, dz) is (−dz, dx)
    }
  }
  out.d = Math.sqrt(best);
}

/** Point and unit tangent at arc length s (clamped; loops wrap). The zero-alloc twin of world/city/path sampleAt. */
export function samplePath(pl: Polyline, s: number, out: PathSample): void {
  SM0.s = s;
  SM0.i = out.i;
  sampleIn(pl, SM0);
  out.x = SM0.x;
  out.z = SM0.z;
  out.tx = SM0.tx;
  out.tz = SM0.tz;
  out.i = SM0.i;
}

/** samplePath with its input in out.s. */
function sampleIn(pl: Polyline, out: Sample): void {
  const S = pl.s;
  const P = pl.pts;
  const n = P.length >> 1;
  const L = pl.length;
  let s = out.s;
  s = pl.closed && L > 0 ? ((s % L) + L) % L : s < 0 ? 0 : s > L ? L : s;
  let i = out.i | 0;
  if (i < 0 || i > n - 2) i = 0;
  if (S[i] > s || S[i + 1] < s) {
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
  }
  const t = (s - S[i]) / (S[i + 1] - S[i] || 1);
  const x0 = P[i * 2];
  const z0 = P[i * 2 + 1];
  const dx = P[i * 2 + 2] - x0;
  const dz = P[i * 2 + 3] - z0;
  const l = Math.sqrt(dx * dx + dz * dz) || 1;
  out.x = x0 + dx * t;
  out.z = z0 + dz * t;
  out.tx = dx / l;
  out.tz = dz / l;
  out.i = i;
}

export interface WalkerTraits {
  vPref: number;
  /** Preferred lateral position as a fraction of the room to the right of travel. */
  pref: number;
  /** Radius (m from the city centre) this walker gravitates to. */
  home: number;
}

const F = (n: number) => new Float64Array(n);

export class PeopleSim {
  readonly n: number;
  readonly plan: CityPlan;
  readonly index: CityIndex;
  readonly info: EdgeInfo[];
  readonly idlers: Idler[];
  readonly obstacles: Obstacle[];
  /** obstacles[k] for k ≥ nProps are idle people; [nFeat, nProps) the blocks' corner columns (the rider's alone: columnObstacles). */
  readonly nProps: number;
  readonly nFeat: number;
  /** v2 (L1): how tall each obstacle stands (m; idle people: a head's height, sitting or standing). */
  readonly obsH: Float32Array;
  // state
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vz: Float64Array;
  readonly hx: Float64Array;
  readonly hz: Float64Array;
  readonly phx: Float64Array;
  readonly phz: Float64Array;
  readonly h: Float64Array;
  readonly ph: Float64Array;
  readonly gait: Float64Array;
  readonly pgait: Float64Array;
  readonly edge: Int32Array;
  readonly dir: Int8Array;
  readonly u: Float64Array;
  readonly next: Int32Array;
  readonly lat: Float64Array;
  readonly commit: Uint8Array;
  readonly stuck: Float32Array;
  /** Seconds a committed crosser has been held up on its crossing; ≥ JAM_S: squeezing past. */
  readonly jam: Float32Array;
  readonly decisions: Int32Array;
  /** 1 = out and about; 0 = gone home for the night (frozen, not drawn). */
  readonly on: Uint8Array;
  /** v2 (L1): the walker whose eyes the camera rides (-1: none); see RIDER_GAP. */
  rider = -1;
  /**
   * v2 (L1): the rider's berth scale: a kid's eye is low, so a grown-up's back at an adult's
   * berth fills its view (people/index.ts sets 1.3 for a kid). Scales every distance in front.
   */
  riderK = 1;
  /** v2 (L1): a walker the camera does not hold up (the one just ridden, walking on out of the camera after the ride). */
  free = -1;
  /** The rider: the edge whose crossing it has looked ahead to, and how long it has stood at its kerb. */
  private riderSeen = -1;
  /** The rider: the edge at whose end it went another way than a zebra someone came to wait at. */
  private riderDodge = -1;
  private riderWait = 0;
  /** The rider: how long it has followed someone, and the edge at whose end it last went another way than them. */
  private riderFollowT = 0;
  private riderSplit = -1;
  /**
   * v2 (L1): where the rider's view looks (plan, unit): people/index.ts writes the ride camera's
   * smoothed heading each step (its facing until then). "In the lens" is measured about it.
   */
  riderVx = 1;
  riderVz = 0;
  /** Where the rider is heading (plan, unit): toward its path 2 m on, set each step. */
  private riderAx = 1;
  private riderAz = 0;
  /** v2 (L1): seconds the rider has stood looking at the traffic at its kerb (the camera's glance runs on it). */
  riderLook = 0;
  /** Seconds left of a ride's start (the camera flying in): the view is cleared, people keep further off. */
  private riderFresh = 0;
  /** The edge whose next edge the rider last looked down for people coming at it. */
  private riderPeek = -1;
  /** The edge the rider walked before its current one (a kerb given up: on along the pavement, not back). */
  private riderPrev = -1;
  /** The rider: the walker whose back it last kept its distance from, and for how long (s). */
  private riderLead = -1;
  private riderLeadT = 0;
  /** The lead the rider is overtaking (−1: none; decided once per lead, riderLead). */
  private riderPass = -1;
  /** The rider's lead this step (−1: none), for specs. */
  leadNow = -1;
  /** Seconds the rider has had someone walking abreast of it, close beside the eye. */
  private riderAbreastT = 0;
  /** Seconds the rider has stood held up off a crossing (L1f refine 1: the standoff breaker). */
  private riderHeldT = 0;
  /** Seconds the rider has had a stranger's back in the middle of its view (L1f refine 2: RIDER_BACK_R), and has stood held up short of one standing. */
  private riderBackT = 0;
  private riderStopT = 0;
  /** The nearest such back, its distance and how fast the gap to it opens (m/s, smoothed). */
  private riderGapJ = -1;
  private riderGapD = 0;
  private riderGapV = 0;
  /** Seconds the rider has waited its turn at a crossing point (it stops waiting after 4). */
  private riderCrossT = 0;
  private riderCrossCool = 0;
  /**
   * L1f refine 1: the rider turning round (a kerb given up, stuck, no way past) turns its head
   * through the open side — the street, the zebra it gave up on — for riderOpenT s, never across
   * the shop window a metre behind it (the critic r1's person:110 swept the view across a glass shop
   * front at a metre). (riderOpenX, riderOpenZ): the open side (plan, unit; 0: none, the shortest way).
   */
  private riderOpenT = 0;
  private riderOpenX = 0;
  private riderOpenZ = 0;
  /** The crossings' `blocked` flags of the step being run (riderPick reads them). */
  private blockedNow: Uint8Array | null = null;
  /** The rider's lateral plan this step (specs): preference, best line, its paving's lo / hi, intervals. */
  readonly dbgPlan = new Float64Array(5);
  /** Specs: the back the rider last turned round for (turnWhy 9), its offset from the rider's line, and why (1: RIDER_BACK_CAP, 2: standing within RIDER_BACK_STOP). */
  dbgBack = -1;
  dbgBackL = 0;
  dbgWhy = 0;
  /** Specs: rides that started by turning round (startDir). */
  dbgStartFlip = 0;
  /** startDir turned the rider round without a cut (it turns as the camera flies in; clearRide snaps it). */
  private startFlip = false;
  /** Review tools: the rider's back rule this step (back, distance, its pace, wide, standing, seconds, held, how many). */
  readonly dbgB = new Float64Array(8);
  /** Specs: set non-empty to get the rider's intervals written here each step. */
  dbgIv = '';
  /** Per walker: seconds left hurrying off after turning back for the rider; the edge it last re-planned its next on near the rider. */
  readonly hurry: Float32Array;
  private readonly rpick: Int32Array;
  /** Per walker: how fast it actually gets on (m/s, smoothed over ~¼ s), pushing or not. */
  private readonly progV: Float32Array;
  /** Per walker: seconds left keeping to one side for the rider to get by, and which way (plan, unit). */
  private readonly wayT: Float32Array;
  private readonly wayX: Float32Array;
  private readonly wayZ: Float32Array;
  /** Per walker: seconds left standing aside for the rider to pass, and to which side (+1 right, −1 left of travel). */
  readonly yieldT: Float32Array;
  private readonly yieldS: Int8Array;
  /** …and where the rider was from it then (plan, unit): it is by once it is on the other side. */
  private readonly yieldX: Float32Array;
  private readonly yieldZ: Float32Array;

  /** Why each walker last turned back (specs): 1 a filming camera, 2 coming at the rider's eye, 3 a ride's start, 4 no way round the rider, 5 a kerb given up, 6 stuck, 7 standing aside given up, 8 a standoff, 9 (the rider) strangers' backs standing in its way. */
  readonly turnWhy: Uint8Array;
  /**
   * Per walk edge: the eye's clearance margin from props and people sitting or standing about (m;
   * < 0: the rider's soft clearance cannot be kept somewhere along it). The rider avoids tight ones.
   */
  readonly riderRoom: Float32Array;
  // traits
  readonly vPref: Float32Array;
  readonly pref: Float32Array;
  readonly home: Float32Array;
  // dogs (followers): owner walker, position, heading, gait, speed — and the previous step's, for interpolation
  readonly dOwner: Int32Array;
  readonly dx: Float64Array;
  readonly dz: Float64Array;
  readonly dpx: Float64Array;
  readonly dpz: Float64Array;
  readonly dhx: Float64Array;
  readonly dhz: Float64Array;
  readonly dg: Float64Array;
  readonly dpg: Float64Array;
  readonly dsp: Float64Array;
  // scratch
  /** Per walker after its step: lateral offset (travel-right) and travel tangent, and whether it is well inside its paving room. */
  private readonly latW: Float64Array;
  private readonly tX: Float64Array;
  private readonly tZ: Float64Array;
  private readonly safe: Uint8Array;
  private readonly gridHead: Int32Array;
  private readonly gridNext: Int32Array;
  private readonly gridN: number;
  private readonly gridR: number;
  private readonly crossPhase: Float32Array;
  private readonly ivLo = F(IV_MAX);
  private readonly ivHi = F(IV_MAX);
  private readonly ivAlong = F(IV_MAX);
  /** 1: a soft interval (the rider's preferred pass): kept clear only when there is room. */
  private readonly ivSoft = new Uint8Array(IV_MAX);
  /** A soft interval's cost per metre inside it (the lateral choice weighs them; hard ones are walls). */
  private readonly ivW = F(IV_MAX);
  private nIv = 0;
  /** Interval capacity for the walker being stepped (IV_MAX for the rider, 48 for everyone else, as in v1). */
  private ivCap = 48;
  private readonly bc = new Berth();
  private readonly smp = new Sample();
  private readonly col = new XZ();
  /** The CityIndex's zero-allocation query inputs (CityIndex.q; classifyQ / collideQ). */
  private readonly iq: Float64Array;
  private readonly near = new SL();
  private readonly near2 = new SL();
  /** onPath's scratch and result (s: arc length ahead along the travel path, l: lateral right of travel, d: distance off it). */
  private readonly near3 = new SL();
  private readonly pth = new SL();
  private readonly seed: number;
  private readonly sb: Uint8Array;
  private readonly zero: Uint8Array;

  constructor(plan: CityPlan, index: CityIndex, seed: number, traits: WalkerTraits[], idlers: Idler[], dogOwners: number[] = []) {
    this.plan = plan;
    this.index = index;
    this.iq = index.q;
    this.seed = seed;
    this.idlers = idlers;
    const n = (this.n = traits.length);
    this.x = F(n);
    this.z = F(n);
    this.px = F(n);
    this.pz = F(n);
    this.vx = F(n);
    this.vz = F(n);
    this.hx = F(n);
    this.hz = F(n);
    this.phx = F(n);
    this.phz = F(n);
    this.h = F(n);
    this.ph = F(n);
    this.gait = F(n);
    this.pgait = F(n);
    this.u = F(n);
    this.lat = F(n);
    this.latW = F(n);
    this.tX = F(n);
    this.tZ = F(n);
    this.safe = new Uint8Array(n);
    this.edge = new Int32Array(n);
    this.next = new Int32Array(n);
    this.decisions = new Int32Array(n);
    this.dir = new Int8Array(n);
    this.commit = new Uint8Array(n);
    this.on = new Uint8Array(n).fill(1);
    this.stuck = new Float32Array(n);
    this.jam = new Float32Array(n);
    this.vPref = Float32Array.from(traits, (t) => t.vPref);
    this.pref = Float32Array.from(traits, (t) => t.pref);
    this.home = Float32Array.from(traits, (t) => t.home);
    const nd = dogOwners.length;
    this.dOwner = Int32Array.from(dogOwners);
    this.dx = F(nd);
    this.dz = F(nd);
    this.dpx = F(nd);
    this.dpz = F(nd);
    this.dhx = F(nd);
    this.dhz = F(nd);
    this.dg = F(nd);
    this.dpg = F(nd);
    this.dsp = F(nd);
    this.sb = new Uint8Array(plan.walkEdges.length);
    this.zero = new Uint8Array(plan.walkEdges.length);
    this.hurry = new Float32Array(n);
    this.progV = new Float32Array(n);
    this.wayT = new Float32Array(n);
    this.wayX = new Float32Array(n);
    this.wayZ = new Float32Array(n);
    this.yieldT = new Float32Array(n);
    this.yieldS = new Int8Array(n);
    this.yieldX = new Float32Array(n);
    this.yieldZ = new Float32Array(n);
    this.turnWhy = new Uint8Array(n);

    this.rpick = new Int32Array(n).fill(-1);

    // Obstacles: the plan's props plus every idle person (they stand where walkers must not).
    const hs: number[] = [];
    const obs = (this.obstacles = featureObstacles(plan.features, hs));
    this.nFeat = obs.length;
    for (const o of columnObstacles(plan.buildings, hs)) obs.push(o);
    this.nProps = obs.length;
    for (const p of idlers) {
      const k = p.pose === Pose.Stand ? 0 : p.pose === Pose.Lean ? -0.1 : 0.25;
      obs.push({ x: p.x + p.fx * k, z: p.z + p.fz * k, r: k ? 0.38 : 0.3 }); // sitters: knees and feet
      hs.push(p.pose === Pose.Stand ? 1.75 : p.pose === Pose.Lean ? 1.15 : 1.5);
    }
    this.obsH = Float32Array.from(hs);
    const near = this.near;
    const ps = this.smp;
    const bad = (l: number) => {
      const k = index.classify(ps.x - ps.tz * l, ps.z + ps.tx * l);
      return k === 'road' || k === 'intersection' || k === 'water' || k === 'building';
    };
    this.info = plan.walkEdges.map((e) => {
      const crossing = e.kind === 'crossing';
      const pl = e.path;
      const len = pl.length;
      // Lateral room, narrowed where the paving under the edge is narrower than its width (corner
      // edges run onto the intersection patch at their ends). Crossings: inside the painted strip.
      let hiR = crossing ? Math.max(0.05, e.width / 2 - 0.5) : e.width / 2 - BODY_R - 0.04;
      let hiL = hiR;
      for (let s = 0; !crossing && s <= len; s += 0.5) {
        samplePath(pl, s, ps);
        while (hiR > 0 && bad(hiR + BODY_R * 0.8)) hiR -= 0.05;
        while (hiL > 0 && bad(-hiL - BODY_R * 0.8)) hiL -= 0.05;
      }
      const oS: number[] = [];
      const oL: number[] = [];
      const oR: number[] = [];
      const oI: number[] = [];
      const np = pl.pts.length >> 1;
      obs.forEach((o, k) => {
        const dx = o.x - pl.pts[0];
        const dz = o.z - pl.pts[1];
        if (dx * dx + dz * dz > (len + e.width + 3) ** 2) return;
        nearestSL(pl, o.x, o.z, near);
        if (near.d < e.width / 2 + o.r + BODY_R + 0.4) {
          // past an end: along the end tangent, so a café table just beyond a node is not "at" it
          if (near.s < 1e-6 || near.s > len - 1e-6) {
            samplePath(pl, near.s < 1e-6 ? 0 : len, ps);
            const j = near.s < 1e-6 ? 0 : np - 1;
            const qx = o.x - pl.pts[j * 2];
            const qz = o.z - pl.pts[j * 2 + 1];
            near.s += qx * ps.tx + qz * ps.tz;
            near.l = qz * ps.tx - qx * ps.tz;
          }
          oS.push(near.s);
          oL.push(near.l);
          oR.push(o.r + BODY_R + 0.07);
          oI.push(k);
        }
      });
      let kerbA = len / 2;
      let kerbB = len / 2;
      const road = (s: number) => {
        samplePath(pl, s, ps);
        const k = index.classify(ps.x, ps.z);
        return k === 'road' || k === 'intersection';
      };
      for (let s = 0; crossing && s < len; s += 0.04) if (road(s)) { kerbA = s; break; }
      for (let s = len; crossing && s > 0; s -= 0.04) if (road(s)) { kerbB = len - s; break; }
      const land = (s0: number, s1: number) => {
        for (let s = s0; s <= s1; s += 0.1) {
          samplePath(pl, s, ps);
          for (let l = -hiR - BODY_R; l <= hiR + BODY_R + 1e-6; l += 0.1) if (bad(l)) return false;
        }
        return true;
      };
      const landA = crossing && land(0, kerbA - 0.3);
      const landB = crossing && land(len - kerbB + 0.3, len);
      // which side the carriageway is (v2, L1: the rider walks on the other side, clear of turning buses)
      let roadSide = 0;
      for (let s = len * 0.2; !crossing && (e.kind === 'sidewalk' || e.kind === 'corner') && s <= len * 0.81; s += len * 0.3) {
        samplePath(pl, s, ps);
        const k = index.classify(ps.x - ps.tz * (e.width / 2 + 0.6), ps.z + ps.tx * (e.width / 2 + 0.6));
        const kl = index.classify(ps.x + ps.tz * (e.width / 2 + 0.6), ps.z - ps.tx * (e.width / 2 + 0.6));
        roadSide += (k === 'road' || k === 'intersection' ? 1 : 0) - (kl === 'road' || kl === 'intersection' ? 1 : 0);
      }
      roadSide = Math.sign(roadSide);
      samplePath(pl, len / 2, ps);
      const hMid = index.groundH(ps.x, ps.z);
      return {
        e, len, crossing, kerbA, kerbB, landA, landB, roadSide,
        hiR: Math.max(0, hiR), hiL: Math.max(0, hiL),
        hEdge: crossing ? index.groundH(pl.pts[0], pl.pts[1]) : hMid, hRoad: hMid,
        oS: Float64Array.from(oS), oL: Float64Array.from(oL), oR: Float64Array.from(oR), oI: Int32Array.from(oI),
        kindW: KIND_W[e.kind] ?? 1,
      };
    });
    this.crossPhase = Float32Array.from(plan.walkEdges, (e) => hash3(e.id, seed, 7) * CROSS_CYCLE);
    this.riderRoom = Float32Array.from(this.info, (f) => this.roomOf(f));
    this.gridR = plan.radius + 4;
    this.gridN = Math.ceil((2 * this.gridR) / CELL);
    this.gridHead = new Int32Array(this.gridN * this.gridN);
    this.gridNext = new Int32Array(n);
  }

  // ── Placement (time jumps) ──

  /** Re-place every walker for sim time t (deterministic in t), then settle. `thin`: share gone home. */
  placeAt(t: number, busy: Uint8Array | null, blocked: Uint8Array | null, thin = 0): void {
    this.scatter(t, thin);
    this.settle(t, 0, SETTLE_STEPS, busy, blocked);
  }

  /** Placement half of placeAt: scatter walkers over the walk graph from a hash of t. */
  scatter(t: number, thin = 0): void {
    const rng = new Rng(hashSeed(this.seed, `people@${Math.round(t * 60)}`));
    const info = this.info;
    const smp = this.smp;
    let total = 0;
    for (const f of info) if (!f.crossing) total += f.len * f.kindW;
    for (let i = 0; i < this.n; i++) {
      this.on[i] = hash3(i, 91, this.seed) >= thin ? 1 : 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        let r = rng.float() * total;
        let k = 0;
        for (; k < info.length - 1; k++) if (!info[k].crossing && (r -= info[k].len * info[k].kindW) <= 0) break;
        const f = info[k];
        const s = rng.range(0.2, Math.max(0.21, f.len - 0.2));
        samplePath(f.e.path, s, smp);
        // home bias (rejection)
        const dh = (Math.sqrt(smp.x * smp.x + smp.z * smp.z) - this.home[i]) / 26;
        if (f.crossing || (attempt < 40 && rng.float() > Math.exp(-dh * dh) + 0.08)) continue;
        const d: 1 | -1 = rng.float() < 0.5 ? 1 : -1;
        const lat = this.pref[i] * (d > 0 ? f.hiR : f.hiL);
        const x = smp.x - smp.tz * d * lat;
        const z = smp.z + smp.tx * d * lat;
        if (attempt < 59) {
          // clear of props and of everyone placed so far (the last attempt takes what it gets)
          if (!this.clear(f, s, d * lat)) continue;
          let crowd = false;
          for (let j = 0; j < i && !crowd; j++) crowd = (this.x[j] - x) ** 2 + (this.z[j] - z) ** 2 < 0.81;
          if (crowd) continue;
        }
        this.edge[i] = k;
        this.dir[i] = d;
        this.u[i] = d > 0 ? s : f.len - s;
        this.x[i] = x;
        this.z[i] = z;
        this.lat[i] = lat;
        const v = this.vPref[i];
        this.vx[i] = smp.tx * d * v;
        this.vz[i] = smp.tz * d * v;
        this.hx[i] = smp.tx * d;
        this.hz[i] = smp.tz * d;
        this.h[i] = f.hEdge;
        this.gait[i] = rng.range(0, 10);
        this.commit[i] = 0;
        this.stuck[i] = 0;
        this.jam[i] = 0;
        this.safe[i] = 0;
        this.decisions[i] = Math.floor(t * 3) & 0xffff;
        this.next[i] = this.chooseNext(i);
        break;
      }
    }
    this.placeDogs();
  }

  /**
   * Settle half of placeAt: run settle steps [from, to) of SETTLE_STEPS (callers may split them
   * across frames). The last one snaps the interpolation state.
   */
  settle(t: number, from: number, to: number, busy: Uint8Array | null, blocked: Uint8Array | null): void {
    for (let k = from; k < to; k++) this.step(SETTLE_DT, t - SETTLE_S + k * SETTLE_DT, busy ?? this.sb, blocked ?? this.zero, 0, 0, false);
    if (to >= SETTLE_STEPS) this.snap();
  }

  /**
   * A camera cut to street level at plan (cx, cz) looking along plan (fx, fz) (unit): walkers in a
   * 1.6 m disc round the eye or a corridor ahead of it step along their own path out of it
   * (invisible: the whole view just changed), so a shot never opens on a face in the lens.
   */
  clearAround(cx: number, cz: number, fx: number, fz: number): void {
    for (let i = 0; i < this.n; i++) {
      // (the nearest free spot along its own edge, ahead first)
      if (this.on[i] && !this.info[this.edge[i]].crossing && i !== this.rider && this.inCut(i, cx, cz, fx, fz)) this.stepOut(i, cx, cz, fx, fz, false);
    }
    this.placeDogs();
    this.snap();
  }

  /**
   * v2 (L1): the camera starts riding walker r's eyes (berth scale k). For RIDER_FRESH s (the camera
   * flying in) people in its view cone facing it turn away and everyone keeps RIDER_SEP_FRESH from
   * it; `cut` (the camera is there at once): everyone close in its view, or at arm's length, steps
   * along their own path out of it first (invisible: the whole view just changed).
   */
  startRide(r: number, k: number, cut: boolean): void {
    this.rider = r;
    this.riderK = k;
    this.riderFresh = RIDER_FRESH;
    this.riderLead = -1;
    this.riderLeadT = 0;
    this.riderPass = -1;
    this.riderAbreastT = 0;
    this.riderHeldT = 0;
    // (strangers' backs in the middle of the view at the start step out at once: RIDER_BACK_T)
    this.riderBackT = RIDER_BACK_T + 0.01;
    this.riderStopT = 0;
    this.riderGapJ = -1;
    this.riderGapV = 0;
    this.riderCrossT = 0;
    this.riderCrossCool = 0;
    this.riderOpenT = 0;
    this.riderFollowT = 0;
    this.riderLook = 0;
    this.riderWait = 0;
    this.riderPeek = -1;
    this.riderSplit = -1;
    this.riderSeen = -1;
    this.riderDodge = -1;
    this.riderVx = this.hx[r];
    this.riderVz = this.hz[r];
    this.hurry[r] = 0;
    this.yieldT[r] = 0;
    this.startDir(r, cut);
    if (cut) this.clearRide();
  }

  /**
   * L1f refine 2: a ride starts walking whichever way along its pavement shows the calmer view: a
   * knot of strangers' backs a few metres ahead (the landing shot's three nearest walkers all
   * tailed the same one for 7–14 s, the critic r2) weighs more than people coming the other way
   * (they pass wide or turn off for the rider). Turning round, the walker turns as the camera flies
   * in (a cut: at once, the view has just changed anyway). Not on a crossing.
   */
  private startDir(r: number, cut: boolean): void {
    this.startFlip = false;
    const f = this.info[this.edge[r]];
    // (waiting at a kerb right behind or beside someone waiting there too — a back or a shoulder a
    // metre from the eye through the whole wait —: it goes another way; out on the road, never)
    const kerbBehind = f.crossing && !this.commit[r] && this.u[r] < (this.dir[r] > 0 ? f.kerbA : f.kerbB) && this.aheadOn(r, this.edge[r], this.dir[r], this.u[r] - 0.6, 1.6 + 1.6 * this.riderK);
    if (f.crossing && !kerbBehind) return;
    const smp = this.smp;
    smp.s = this.u[r];
    this.sampleTravel(r);
    const tx = smp.tx;
    const tz = smp.tz;
    let fwd = 0;
    let rev = 0;
    const k = this.riderK;
    for (let j = 0; j < this.n; j++) {
      if (j === r || !this.on[j]) continue;
      const dx = this.x[j] - this.x[r];
      const dz = this.z[j] - this.z[r];
      const d2 = dx * dx + dz * dz;
      if (d2 > 81) continue;
      const d = Math.sqrt(d2) || 1;
      const al = dx * tx + dz * tz;
      const lt = Math.abs(dx * tz - dz * tx);
      // (anyone close behind: turning round would put the eye in their face — one walking up behind
      // the rider was 0.3 m in front of the lens, then turned back for it, facing it for 0.8 s)
      if (al < 0.4 && al > -2.5 * k && lt < 1.2 * k) return;
      if (Math.abs(al) < 0.4 || lt > Math.abs(al) * 0.75 + 0.5) continue;
      const sp = this.progV[j];
      const away = (this.hx[j] * dx + this.hz[j] * dz) / d;
      // (a back that way: standing, or walking that way; a face: walking toward the rider)
      const w = sp < 0.3 ? (d < 6 ? 2.5 : 1) : away > 0.5 ? (d < 6 ? 3 : 1.5) : away < -0.5 ? 1.2 : 0.5;
      if (al > 0) fwd += w;
      else rev += w;
    }
    if (!kerbBehind && !(rev + 1.5 < fwd)) return;
    // (turning as the camera flies in: through the open side — the street beside its pavement —,
    // never across the shop window behind it, as when it turns round later: a ride landed on a
    // view of the glass a few centimetres off)
    if (!cut && f.roadSide !== 0) {
      this.riderOpenT = 3;
      this.riderOpenX = -tz * f.roadSide * this.dir[r];
      this.riderOpenZ = tx * f.roadSide * this.dir[r];
    }
    this.dir[r] = -this.dir[r] as 1 | -1;
    this.u[r] = f.len - this.u[r];
    this.lat[r] = -this.lat[r];
    this.next[r] = this.chooseNext(r, true);
    this.vx[r] = this.vz[r] = 0;
    if (cut) {
      this.hx[r] = -tx;
      this.hz[r] = -tz;
      this.riderVx = -tx;
      this.riderVz = -tz;
    }
    this.dbgStartFlip++;
    this.startFlip = !cut;
  }

  /** v2 (L1): the ride's cut (startRide's `cut`, or later, once the owner knows the camera is there at once). */
  clearRide(): void {
    const r = this.rider;
    if (r < 0) return;
    // (the rider itself stays where it is: the camera has already been put in its head, and a
    // cut that moved it would show its own body for a frame; it steps back from a kerb, or
    // round a lamp post, by itself within a second)
    const fr = this.info[this.edge[r]];
    // (…except off a kerb's edge: at a kerb it is put back on its wait line at once — the camera
    // is behind its old spot, so its body never shows — or a settled ride could open on a bus
    // passing 0.7 m from a kid's low eye; L1f refine 1)
    if (fr.crossing && !this.commit[r]) {
      const dr = this.dir[r];
      const kIn = dr > 0 ? fr.kerbA : fr.kerbB;
      const w = Math.max(0.05, kIn - RIDER_WAIT_BACK * this.riderK);
      if (this.u[r] > w && this.u[r] < kIn + 0.3) {
        samplePath(fr.e.path, dr > 0 ? w : fr.len - w, this.smp);
        this.x[r] = this.smp.x - this.smp.tz * dr * this.lat[r];
        this.z[r] = this.smp.z + this.smp.tx * dr * this.lat[r];
        this.u[r] = w;
        this.vx[r] = this.vz[r] = 0;
        this.h[r] = fr.hEdge;
      }
    }
    if (this.startFlip) {
      // (turned round at the start, and the camera is there at once after all: facing the new way now)
      this.startFlip = false;
      this.riderOpenT = 0;
      this.smp.s = this.u[r];
      this.sampleTravel(r);
      this.hx[r] = this.riderVx = this.smp.tx;
      this.hz[r] = this.riderVz = this.smp.tz;
    }
    const fx = this.hx[r];
    const fz = this.hz[r];
    const ex = this.x[r] + fx * 0.11;
    const ez = this.z[r] + fz * 0.11;
    for (let i = 0; i < this.n; i++) {
      if (i === r || !this.on[i] || !this.inRideCut(i, ex, ez, fx, fz)) continue;
      const f = this.info[this.edge[i]];
      if (!f.crossing) this.stepOut(i, ex, ez, fx, fz, true);
      else if (this.edge[i] !== this.edge[r] || this.dir[i] !== this.dir[r] || this.u[i] > this.u[r] || !this.commit[i] || !this.commit[r]) {
        // (waiting at the rider's kerb in front of it, or ahead of it on the zebra, or at the kerb
        // of a zebra beside it at the corner — round 5 opened a settled ride on a waiter's face at
        // 0.4 m: already across; coming over the rider's own zebra at it: not yet set off, waiting
        // at its own kerb over the road)
        void fr;
        // (setting off behind the rider waiting at its kerb: across too — one walked past the
        // waiting eye at half a metre; L1f refine 2)
        const d = this.dir[i];
        const back = this.edge[i] === this.edge[r] && this.dir[i] !== this.dir[r];
        const uBack = Math.max(0.2, (d > 0 ? f.kerbA : f.kerbB) - WAIT_BACK);
        let u = back ? uBack : Math.min(f.len - 0.15, f.len - (d > 0 ? f.kerbB : f.kerbA) + 0.45 + 0.5 * (i % 3));
        // (a zebra beside the rider's corner: its far landing can be that corner — one put there
        // walked off it 0.4 m from the eye —: whichever end is out of the view, else further off)
        if (!back && this.edge[i] !== this.edge[r]) {
          samplePath(f.e.path, d > 0 ? u : f.len - u, this.smp);
          const sFar = cutScore(this.smp.x - ex, this.smp.z - ez, fx, fz);
          samplePath(f.e.path, d > 0 ? uBack : f.len - uBack, this.smp);
          if (cutScore(this.smp.x - ex, this.smp.z - ez, fx, fz) > sFar) u = uBack;
        }
        samplePath(f.e.path, d > 0 ? u : f.len - u, this.smp);
        this.x[i] = this.smp.x - this.smp.tz * d * this.lat[i];
        this.z[i] = this.smp.z + this.smp.tx * d * this.lat[i];
        this.u[i] = u;
        this.commit[i] = 0;
        this.h[i] = f.hEdge;
        this.safe[i] = 0;
      }
    }
    this.placeDogs();
    this.snap();
  }

  /** v2 (L1): the ride is over. */
  endRide(): void {
    this.rider = -1;
    this.riderK = 1;
    this.riderFresh = 0;
  }

  /** Inside a ride cut's clear zone: at arm's length, a face coming at the eye, or a back close ahead in the view. */
  private inRideCut(i: number, ex: number, ez: number, fx: number, fz: number): boolean {
    const k = this.riderK;
    const dx = this.x[i] - ex;
    const dz = this.z[i] - ez;
    const d2 = dx * dx + dz * dz;
    if (d2 < 4 * k * k) return true;
    const along = dx * fx + dz * fz;
    const lat = Math.abs(dx * fz - dz * fx);
    const at = this.hx[i] * dx + this.hz[i] * dz < -0.3 * Math.sqrt(d2);
    // (a back: out to RIDER_BACK_R inside ±35°, the middle of the view the tailing measure watches)
    return along > 0 && (at ? along < 9 * k && lat < 2.4 * k : along < (RIDER_BACK_R + 0.5) * k && lat < along * 0.9 + 0.8);
  }

  /** Walker i steps along its own edge to the nearest spot (ahead first) out of the cut's zone and clear of others. */
  private stepOut(i: number, cx: number, cz: number, fx: number, fz: number, ride: boolean): void {
    const smp = this.smp;
    const f = this.info[this.edge[i]];
    const u0 = this.u[i];
    const d = this.dir[i];
    const l = Math.max(-(d > 0 ? f.hiL : f.hiR), Math.min(d > 0 ? f.hiR : f.hiL, this.lat[i]));
    // (the best spot if none is clear: out of the view first, then furthest from the eye)
    let bestU = u0;
    let bestS = cutScore(this.x[i] - cx, this.z[i] - cz, fx, fz);
    for (let k = 1; k <= 48; k++) {
      const u = u0 + (k & 1 ? 1 : -1) * 0.5 * ((k + 1) >> 1);
      if (u < 0.2 || u > f.len - 0.2) continue;
      samplePath(f.e.path, d > 0 ? u : f.len - u, smp);
      this.x[i] = smp.x - smp.tz * d * l;
      this.z[i] = smp.z + smp.tx * d * l;
      this.u[i] = u;
      if (!(ride ? this.inRideCut(i, cx, cz, fx, fz) : this.inCut(i, cx, cz, fx, fz)) && !this.crowded(i)) {
        this.lat[i] = l;
        this.safe[i] = 0;
        return;
      }
      const sc = this.crowded(i) ? -Infinity : cutScore(this.x[i] - cx, this.z[i] - cz, fx, fz);
      if (sc > bestS) {
        bestS = sc;
        bestU = u;
      }
    }
    this.lat[i] = l;
    this.safe[i] = 0;
    // (v1's cuts: as they were)
    if (!ride) return;
    this.u[i] = bestU;
    // (no spot along its own edge — a short one round a corner —: on along its next one, a ride's
    // cut only; L1f refine 2: a settled ride opened on a walker a metre from the eye)
    // (its next a zebra: already across it, on its far landing — one about to step onto the
    // rider's zebra from a short corner pavement passed the waiting eye at half a metre)
    const g = this.next[i];
    const fg = this.info[g];
    if (g !== this.edge[i]) {
      const dn: 1 | -1 = fg.e.a === this.endNode(i) ? 1 : -1;
      const lg = Math.max(-(dn > 0 ? fg.hiL : fg.hiR), Math.min(dn > 0 ? fg.hiR : fg.hiL, l));
      const u0g = fg.crossing ? Math.min(fg.len - 0.15, fg.len - (dn > 0 ? fg.kerbB : fg.kerbA) + 0.45) : 0.5;
      for (let u = u0g; u < fg.len - 0.1; u += 0.5) {
        samplePath(fg.e.path, dn > 0 ? u : fg.len - u, smp);
        this.x[i] = smp.x - smp.tz * dn * lg;
        this.z[i] = smp.z + smp.tx * dn * lg;
        if (this.inRideCut(i, cx, cz, fx, fz) || this.crowded(i)) continue;
        this.edge[i] = g;
        this.dir[i] = dn;
        this.u[i] = u;
        this.lat[i] = lg;
        this.hx[i] = smp.tx * dn;
        this.hz[i] = smp.tz * dn;
        this.commit[i] = 0;
        this.h[i] = fg.hEdge;
        this.next[i] = this.chooseNext(i);
        return;
      }
    }
    // (nowhere: the best spot its own edge offers — was wherever the search ended, once 0.3 m in
    // front of the lens of a ride that had just turned round; L1f refine 2)
    samplePath(f.e.path, d > 0 ? this.u[i] : f.len - this.u[i], smp);
    this.x[i] = smp.x - smp.tz * d * l;
    this.z[i] = smp.z + smp.tx * d * l;
  }

  /** Is walker i within 0.8 m of another walker or a prop / idle person? */
  private crowded(i: number): boolean {
    const x = this.x[i];
    const z = this.z[i];
    for (let j = 0; j < this.n; j++) if (j !== i && this.on[j] && (this.x[j] - x) ** 2 + (this.z[j] - z) ** 2 < 0.64) return true;
    const f = this.info[this.edge[i]];
    for (let q = 0; q < f.oI.length; q++) {
      if (this.isCol(f.oI[q])) continue;
      const o = this.obstacles[f.oI[q]];
      if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.r + BODY_R + 0.1) ** 2) return true;
    }
    return false;
  }

  /** Inside the cut's clear zone: the disc, or the corridor ahead (wider and longer for someone walking at the lens). */
  private inCut(i: number, cx: number, cz: number, fx: number, fz: number): boolean {
    const dx = this.x[i] - cx;
    const dz = this.z[i] - cz;
    const along = dx * fx + dz * fz;
    const at = dx * this.hx[i] + dz * this.hz[i] < 0;
    return dx * dx + dz * dz < 1.6 * 1.6 || (along > 0 && along < (at ? 8 : 5.5) && Math.abs(dx * fz - dz * fx) < (at ? 1.7 : 1.0));
  }

  private clear(f: EdgeInfo, s: number, latAB: number): boolean {
    for (let k = 0; k < f.oS.length; k++) if (!this.isCol(f.oI[k]) && (f.oS[k] - s) ** 2 + (f.oL[k] - latAB) ** 2 < (f.oR[k] + 0.05) ** 2) return false;
    return true;
  }

  /** Obstacle k is a block's corner column (the rider's alone: columnObstacles). */
  private isCol(k: number): boolean {
    return k >= this.nFeat && k < this.nProps;
  }

  /** Copy the state into the previous-step state (interpolation). */
  private snap(): void {
    this.px.set(this.x);
    this.pz.set(this.z);
    this.phx.set(this.hx);
    this.phz.set(this.hz);
    this.ph.set(this.h);
    this.pgait.set(this.gait);
    this.dpx.set(this.dx);
    this.dpz.set(this.dz);
    this.dpg.set(this.dg);
  }

  private placeDogs(): void {
    for (let k = 0; k < this.dOwner.length; k++) {
      const i = this.dOwner[k];
      this.dhx[k] = this.hx[i];
      this.dhz[k] = this.hz[i];
      this.dogTarget(k, i, false);
      this.dx[k] = this.col.x;
      this.dz[k] = this.col.z;
    }
  }

  /**
   * Where dog k wants to be (into col): a little ahead on the owner's left, or at heel. The ridden
   * walker's dog trots at heel just behind (v2, L1): ahead of the eye it was a blob cut off by the
   * bottom of the frame; there it is out of view until the camera looks down or round.
   */
  private dogTarget(k: number, i: number, heel: boolean): void {
    const ridden = i === this.rider;
    const a = ridden ? (heel ? -0.5 : -0.55) : heel ? -0.32 : 0.75;
    const b = 0.42 + 0.06 * (k & 1);
    this.col.x = this.x[i] + this.hx[i] * a + this.hz[i] * b; // left of (hx, hz) is (hz, −hx)
    this.col.z = this.z[i] + this.hz[i] * a - this.hx[i] * b;
  }

  /** The node walker i is heading for on its current edge. */
  private endNode(i: number): number {
    const e = this.info[this.edge[i]].e;
    return this.dir[i] > 0 ? e.b : e.a;
  }

  /** Move walker i onto its chosen next edge (progress 0) and choose the one after. */
  private enterNext(i: number): void {
    const nextE = this.next[i];
    this.turnWhy[i] = 0;
    if (i === this.rider) this.riderPrev = this.edge[i];
    this.dir[i] = (nextE === this.edge[i] ? -this.dir[i] : this.info[nextE].e.a === this.endNode(i) ? 1 : -1) as 1 | -1;
    this.edge[i] = nextE;
    this.u[i] = 0;
    this.commit[i] = 0;
    this.jam[i] = 0;
    this.next[i] = this.chooseNext(i);
  }

  /**
   * L1f refine 2: the rider's way on from the end of its edge, picked by what each way would put in
   * front of its eye (instead of v1's weighted dice): strangers' backs to walk behind (anyone going
   * that way in its first 10 m, or about to turn into it just ahead of the rider), people coming down
   * it (doubly on a narrow pavement, where they pass at arm's length), a zebra with someone already
   * waiting at its kerb or a car committed to it, a path that squeezes past a lamp post or a column;
   * plus a seeded die (up to 1.5) so a quiet town still wanders. `avoid`: that edge costs 5 more.
   * (The critic r2: the rider followed knots of strangers 3–5 m ahead for 7–14 s, often into the
   * corner where they stopped to wait.)
   */
  private riderPick(i: number, avoid = -1): number {
    const cur = this.edge[i];
    const node = this.endNode(i);
    const nd = this.plan.walkNodes[node];
    const k = this.riderK;
    let best = -1;
    let bestC = Infinity;
    for (const g of nd.edges) {
      if (g === cur) continue;
      const fg = this.info[g];
      const dn = fg.e.a === node ? 1 : -1;
      const L = fg.len;
      let backs = 0;
      let onc = 0;
      for (let j = 0; j < this.n; j++) {
        if (j === i || !this.on[j]) continue;
        if (this.edge[j] === g) {
          // (position along g from this node)
          const pos = this.dir[j] === dn ? this.u[j] : L - this.u[j];
          if (pos > 12) continue;
          if (this.dir[j] === dn) backs += pos < 2 ? 1.5 : 1;
          else onc++;
        } else if (this.next[j] === g && this.endNode(j) === node && this.info[this.edge[j]].len - this.u[j] < (this.edge[j] === cur ? 12 : 5)) backs++;
      }
      const narrow = !fg.crossing && fg.e.width - 2 * (BODY_R + 0.04) < (RIDER_PASS_ONC + 0.35) * k;
      let c = 3 * backs + (narrow ? 4 : 2) * onc + 1.5 * hash3(i, this.decisions[i]++, this.seed);
      if (fg.crossing) {
        const kIn = dn > 0 ? fg.kerbA : fg.kerbB;
        // (a landing shorter than its wait line is back: it would wait at the corner, cars passing
        // under a metre from the eye)
        c += kIn < RIDER_WAIT_BACK * k ? 6 : 0.3;
        if (this.aheadOn(i, g, dn, 0, kIn + 0.2)) c += 5;
        if (this.blockedNow && this.blockedNow[g]) c += 4;
        if (kIn < RIDER_WAIT_BACK + 0.3 && this.comingOn(i, g, dn, L) > 0) c += 3;
      }
      if (this.riderRoom[g] < -0.2) c += 3;
      // (the way it means to go another way than: dear, but better than a zebra a car holds)
      if (g === avoid) c += 5;
      if (c < bestC) {
        bestC = c;
        best = g;
      }
    }
    return best >= 0 ? best : avoid >= 0 ? this.next[i] : this.chooseNext(i);
  }

  /**
   * Pick the next edge at the end of i's current edge (seeded per decision). `dry` (the rider):
   * anything but a crossing, if there is another way on; `avoid`: anything but that edge, if there
   * is another (else the edge it had chosen).
   */
  private chooseNext(i: number, dry = false, avoid = -1): number {
    const cur = this.edge[i];
    const node = this.plan.walkNodes[this.endNode(i)];
    let total = 0;
    for (const id of node.edges) if (id !== cur && id !== avoid && !(dry && this.info[id].crossing)) total += this.edgeWeight(id, node.id, i);
    if ((dry || avoid >= 0) && !(total > 0)) return avoid >= 0 ? this.next[i] : this.chooseNext(i);
    let r = hash3(i, this.decisions[i]++, this.seed) * total;
    for (const id of node.edges) if (id !== cur && id !== avoid && !(dry && this.info[id].crossing) && (r -= this.edgeWeight(id, node.id, i)) <= 0) return id;
    return cur; // dead end: turn back on the same edge
  }

  /**
   * The rider's berth between walker i (being stepped, its frame in this.bc) and walker j, one of
   * them the rider: written into bc (speed cap, held up, giving the landing, the lead, coming at the
   * eye) and the interval scratch. Integer arguments only (see the header).
   *   - Brakes: the rider for anyone its line of travel would pass closer than RIDER_GAP, stopping
   *     RIDER_STOP short; anyone for a rider across its own line, stopping RIDER_MEET short. The
   *     line is the velocity (or, standing, the path), so a pass at the berth never brakes.
   *   - Follows: never closer than RIDER_FOLLOW in line; the rider also notes the nearest back in
   *     its view cone (its lead: kept RIDER_TAIL off after the lateral plan, unless it passes wide),
   *     and plans a wide soft pass round a slower one. Anyone else RIDER_FOLLOW behind the rider.
   *   - Passes: oncoming, crossing or standing, from RIDER_LOOK ahead at RIDER_SOFT (soft, weighed
   *     more the nearer), at RIDER_GAP (hard) within 3 m. Someone coming at the eye notes how wide
   *     it can pass: under RIDER_PASS it turns back (step), early.
   *   - On a carriageway nobody stops for it: the usual gap, and the rider follows at
   *     RIDER_ROAD_V or more (it waited at the kerb for its berth on the zebra: zebraClear).
   * In front of the rider every distance scales with riderK (a kid's eye).
   */
  private berthPair(i: number, j: number): void {
    const b = this.bc;
    const me = i === this.rider;
    const k = me ? this.riderK : 1;
    const kj = this.riderK;
    /** The berth's lateral gap (wider round a kid's eye, both ways). */
    const gap = RIDER_GAP * kj;
    const rx = this.px[j] - b.xi;
    const rz = this.pz[j] - b.zi;
    const d2 = rx * rx + rz * rz;
    if (d2 > 100) return;
    const dd = Math.sqrt(d2);
    // where j is along i's path and to the side of it (round a bend too: onPath), relative to i
    const jl = Math.hypot(this.vx[j], this.vz[j]);
    this.onPath(i, this.px[j], this.pz[j], jl > 0.3 && this.vx[j] * rx + this.vz[j] * rz > 0.5 * jl * dd);
    const along = this.pth.s;
    const side = this.pth.l - b.latCur;
    const fj = this.info[this.edge[j]];
    const jOut = fj.crossing && this.commit[j] > 0 && this.u[j] > (this.dir[j] > 0 ? fj.kerbA : fj.kerbB) - 0.3;
    // someone out on the carriageway: the usual gaps, nobody stops for the berth (but the rider on
    // its pavement keeps its full berth from someone coming off a zebra at it: round 4 met a crosser
    // face to face at 0.7 m on a landing)
    const road = b.out > 0 || (jOut && !me);
    // (out on a crossing only the rider brakes, for someone squarely in its way, and not below
    // RIDER_ROAD_V on the carriageway itself)
    // (come off the zebra the rider waits at, onto its landing: it walks on past the rider a
    // little closer than the berth — the rider has stepped aside — rather than stand braked in
    // front of it, a face at 1.3 m, each waiting for the other; L1f round 5)
    const passOff = !me && fj.crossing && this.edge[j] === b.e && this.dir[j] !== b.d && !this.commit[j] && this.u[i] + this.u[j] > fj.len - 3;
    if ((!b.out || me) && !passOff && dd < RIDER_BRAKE * (me ? k : kj)) {
      const sp2 = this.vx[i] * this.vx[i] + this.vz[i] * this.vz[i];
      let fx = sp2 > 0.09 ? this.vx[i] : b.tx;
      let fz = sp2 > 0.09 ? this.vz[i] : b.tz;
      const fl = Math.sqrt(fx * fx + fz * fz) || 1;
      fx /= fl;
      fz /= fl;
      // (the rider's line against the same gap its lateral plan keeps: past someone standing a
      // little closer than the berth; round 4 braked at the berth for a pass the plan had found,
      // and crept along behind someone standing aside for it)
      const still = this.vx[j] * this.vx[j] + this.vz[j] * this.vz[j] < 0.0625;
      const g = me && still ? 0.8 * kj : gap * 0.9;
      if (rx * fx + rz * fz > 0 && Math.abs(rx * fz - rz * fx) < (b.out ? 0.5 : g)) {
        // (the rider stops a little further short of someone standing: a kerb waiter may step back)
        let cap = Math.max(0, (dd - (me ? RIDER_STOP * k - (still ? 0 : 0.2) : RIDER_MEET * kj)) * 1.8);
        if (b.carriageway) cap = Math.max(cap, RIDER_ROAD_V);
        if (cap < b.cap) b.cap = cap;
        if (cap < 0.3) b.block = 1;
      }
    }
    if (!me && b.waiting && along < 0 && dd < 2.5) b.noBack = 1;
    // Crossing paths (L1f refine 2): the rider and someone whose way crosses its own at an angle
    // (30° to 150°; head-on and same-way are the passes' and the follows' business) — a crosser,
    // someone cutting over a zebra's landing, a diagonal oncomer — take turns at the crossing point:
    // whoever gets there first goes, the other stops RIDER_CROSS (× riderK) short of it until the
    // first is most of that past. Both work it out from the same two courses (a slow one's: its way
    // at a walk), so they agree, and the one waiting stays second. (The critic r2's person:90: a
    // woman crossing the rider's landing smiled into the lens at 1.2 m and passed at 0.7 m.)
    if (dd < 7 * kj && !(me ? b.carriageway : b.out) && !b.squeeze) {
      const ir = me ? i : j;
      const io = me ? j : i;
      let vrx = this.vx[ir];
      let vrz = this.vz[ir];
      let vox = this.vx[io];
      let voz = this.vz[io];
      let vr = Math.sqrt(vrx * vrx + vrz * vrz);
      let vo = Math.sqrt(vox * vox + voz * voz);
      /** (only someone really on the move goes first: a standing one is gone round) */
      const vrA = vr;
      const voA = vo;
      if (vr < 0.3) {
        vrx = (me ? b.tx : this.tX[ir]) * 0.3;
        vrz = (me ? b.tz : this.tZ[ir]) * 0.3;
        vr = 0.3;
      }
      if (vo < 0.3) {
        vox = (me ? this.tX[io] : b.tx) * 0.3;
        voz = (me ? this.tZ[io] : b.tz) * 0.3;
        vo = 0.3;
      }
      const den = (vrx * voz - vrz * vox) / (vr * vo);
      if (den > 0.5 || den < -0.5) {
        // (from the rider to the other; each one's distance to the crossing point along its course)
        const qx = me ? rx : -rx;
        const qz = me ? rz : -rz;
        const aR = (qx * voz - qz * vox) / vo / den;
        const aO = (qx * vrz - qz * vrx) / vr / den;
        const need = RIDER_CROSS * kj;
        // (the first not yet most of the clearance past it, the second short of it and coming)
        if (aR > -0.7 * need && aO > -0.7 * need && aR < 3.5 * vr + need && aO < 3.5 * vo + need) {
          // (the other goes first only while the rider will still be the clearance short of the
          // point as it gets there and on past: the rider slowing for someone else made a waiter at
          // the landing's edge "first", and it crossed a metre in front of the eye)
          const tO = aO / vo;
          const otherFirst = tO + 0.25 < aR / vr && aR - vr * (tO + need / vo) >= 0.8 * need;
          if (otherFirst ? me && voA > 0.3 && this.progV[io] > 0.3 && aO > -0.7 * need && aR > 0 && this.riderCrossCool <= 0 : !me && vrA > 0.3 && this.progV[ir] > 0.3 && aR > -0.7 * need && aO > 0) {
            const cap = Math.max(0, ((otherFirst ? aR : aO) - need) * 1.5);
            if (cap < b.cap) b.cap = cap;
            b.crossY = 1;
          }
        }
      }
    }
    // (a ride's first seconds: anyone close in the rider's view and facing it turns away)
    if (!me && this.riderFresh > 0 && dd < 3.5 * kj && !(b.out && b.carriageway)) {
      const cv = -(rx * this.riderVx + rz * this.riderVz) / (dd || 1);
      if (cv > 0.45 && rx * b.tx + rz * b.tz > 0.35 * dd) b.clear = 1;
    }

    // Someone walking at the rider's eye: in front of it (inside ±70° of its view), heading for
    // it, and on a straight course would pass closer than RIDER_PASS within RIDER_TTC (closest
    // approach of the two velocities; the lateral plan below may still find a wider pass)
    // Someone walking at the rider's eye, or standing (or held up, shuffling) facing it within
    // 3 m: in front of it (inside ±70° of where its view looks, or of where it is heading, round a
    // corner). Walking, on a straight course it would pass closer than RIDER_PASS within RIDER_TTC
    // (the closest approach of the two velocities; the lateral plan below may still find a wider
    // pass); standing, the rider is that close to its line of sight.
    if (!me && !b.out && dd < RIDER_LOOK * kj) {
      const sp = Math.sqrt(this.vx[i] * this.vx[i] + this.vz[i] * this.vz[i]);
      const cv = -Math.min(rx * this.riderVx + rz * this.riderVz, rx * this.riderAx + rz * this.riderAz) / (dd || 1);
      const moving = sp > 0.3 && this.vx[i] * rx + this.vz[i] * rz > 0.5 * sp * dd;
      if (cv > 0.34 && moving) {
        const wx = this.vx[j] - this.vx[i];
        const wz = this.vz[j] - this.vz[i];
        const w2 = wx * wx + wz * wz;
        const tc = w2 > 0.01 ? -(rx * wx + rz * wz) / w2 : Infinity;
        // (within 3.2 m whatever the time: a slow one otherwise walked up to 1.6 m before it counted)
        if (tc > 0 && (tc < RIDER_TTC || dd < 3.2 * kj)) {
          const cx = rx + wx * tc;
          const cz = rz + wz * tc;
          b.onc = 1;
          b.tc = tc;
          b.cpa = Math.sqrt(cx * cx + cz * cz);
          b.rLat = NaN;
        }
      } else if (cv > 0.34 && dd < 3 * kj && this.hx[i] * rx + this.hz[i] * rz > 0.5 * dd) {
        // (standing within 2.2 m it turns aside whatever the offset: a face that close fills the lens)
        b.onc = 2;
        b.tc = 0;
        b.cpa = dd < 2.2 * kj ? 0 : Math.abs(this.hx[i] * rz - this.hz[i] * rx);
        b.rLat = NaN;
      }
    }
    // (a stranger's back in the middle of the rider's view: the critic r2's tailing measure)
    // (ahead on its way too: turning round, its head still swinging past them, it is walking away)
    // (a kid's low eye: a little further — a back there is a grown-up's legs and back, not a head)
    if (me && along > 0.3 && dd < RIDER_BACK_R * (1 + (k - 1) * 0.35) && this.hx[j] * rx + this.hz[j] * rz > 0.5 * dd && rx * this.riderVx + rz * this.riderVz > 0.866 * dd) {
      b.bkN++;
      if (b.bkJ < 0 || dd < b.bkD) {
        b.bkJ = j;
        b.bkD = dd;
        b.bkV = this.progV[j];
        b.bkAlong = along;
        b.bkL = this.pth.l;
      }
    }
    const see = RIDER_LOOK * (me ? k : kj);
    if (along < -0.25 || along > see || Math.abs(side) > 2.8) return;
    const vxj = this.vx[j];
    const vzj = this.vz[j];
    // (the rider reads how fast someone actually gets on, not how hard they push: one walking in
    // place against a wall held it up behind them for seconds as if following a walker)
    const vk = me ? Math.min(1, this.progV[j] / Math.max(0.05, Math.sqrt(vxj * vxj + vzj * vzj))) : 1;
    const vj = Math.sqrt(vxj * vxj + vzj * vzj) * vk;
    const vjAlong = (vxj * b.tx + vzj * b.tz) * vk;
    // On a zebra's landing whoever comes off the crossing has the way. The rider, not yet stepped
    // off, steps aside to its right edge and waits there (a step back is toward the corner the
    // other makes for; round 3 had them meet face to face at a metre). A kerb waiter steps aside,
    // away from the rider, as it comes across toward them (from 7 m) or off the crossing at them.
    if (this.edge[j] === b.e && this.dir[j] !== b.d && this.info[b.e].crossing) {
      if (me) {
        if (!b.out && along > 0 && d2 < 16 * k * k && (this.commit[j] > 0 || this.u[j] > (this.dir[j] > 0 ? fj.kerbA : fj.kerbB))) b.aside = 1;
      } else if (b.waiting && d2 < (this.commit[j] ? 49 : 6.25) * kj * kj) b.aside = side < 0 ? 1 : -1;
    }
    const ivLo = this.ivLo;
    const ivHi = this.ivHi;
    const cap0 = this.ivCap;
    /** Soft intervals weigh most within 2.5 m, a quarter of that at the edge of sight. */
    const near = along < 2.5 ? 1 : 1 - (0.75 * (along - 2.5)) / Math.max(0.5, see - 2.5);
    if (vj > 0.25 && vjAlong > 0.6 * vj) {
      // walking our way: follow (never through them)
      if (along > 0 && Math.abs(side) < (me || !road ? gap : PASS_GAP) - 0.04) {
        let c = Math.max(0, vjAlong + (along - (me ? RIDER_FOLLOW * k : road ? 0.62 : RIDER_FOLLOW)) * 1.6);
        if (me && road) c = Math.max(c, Math.min(RIDER_ROAD_V, Math.max(0, vjAlong + (along - 0.62) * 1.6)));
        if (c < b.cap) b.cap = c;
      }
      if (me && along > 0 && along < 3 * k && Math.abs(side) < 1.2 * k && !road && vjAlong < this.vPref[i] - 0.15) this.makeWay(j, side, b);
      if (me && along < 1.4 * k && Math.abs(side) < 1.8 * k && !road) b.abreast = j;
      if (me && along > 0) {
        // a back in the rider's view: the nearest is its lead (kept RIDER_TAIL off unless it passes
        // wide, after the lateral plan)
        const cv = (rx * this.riderVx + rz * this.riderVz) / (dd || 1);
        // (…and from 6.5 m in the middle of its view: a back 5–6 m ahead walking at its pace was
        // never a lead and stayed the middle of the view for 5–12 s; L1f refine 1)
        if ((cv > RIDER_CONE || along > Math.abs(side) * 1.2) && dd < (this.riderFollowT > RIDER_TAIL_T ? RIDER_TAIL_FAR + 1 : cv > 0.93 ? 6.5 : RIDER_TAIL + 2) * k && (b.lead < 0 || dd < b.leadD)) {
          b.lead = j;
          b.leadAlong = along;
          b.leadSide = side;
          b.leadV = vjAlong;
          b.leadD = dd;
        }
        // the rider overtakes someone slower where there is room, wide (not one hurrying off)
        const passing = j === this.riderPass;
        if (!road && along < 5 && (passing || (vjAlong < Math.min(this.vPref[i], RIDER_V_MAX - 0.35) - 0.12 && this.hurry[j] <= 0.5)) && this.nIv < cap0) {
          const q = this.nIv++;
          // (overtaking as wide as a pass with someone coming: at 1.2 m a back and a shoulder filled
          // the side of the frame going by; L1f refine 1)
          const w = (RIDER_PASS_ONC + 0.15) * k;
          ivLo[q] = b.latCur + side - w;
          ivHi[q] = b.latCur + side + w;
          this.ivSoft[q] = 1;
          this.ivW[q] = (passing ? 3 * W_PASS : W_PASS) * near;
          this.ivAlong[q] = along;
        }
      }
    } else if (!b.squeeze) {
      // (standing in its way, back to it: keeps to the side for it, as one walking its way does;
      // close, it is a back filling the lens the rider gives up on sooner)
      if (me && vj < 0.25 && along > 0 && along < 3 * k && Math.abs(side) < 1.2 * k && !road && !jOut) {
        this.makeWay(j, side, b);
        if (along < 2.2 * k && this.hx[j] * rx + this.hz[j] * rz > 0.5 * dd) b.backNear = 1;
      }
      // oncoming, crossing our path, or standing: step round them, early and wide if there is room
      // (on a carriageway the zebra's strip is 1.4 m of room: the berth there is soft and no wider)
      // (two walking at each other: wider and weighed more, so neither takes a line through the
      // pass for a lamp post further on; L1f refine 1)
      const oncoming = !road && vj > 0.25 && vjAlong < -0.4 * vj;
      // (coming over a zebra at the rider waiting at its kerb: across the strip from it, as wide as
      // two walking at each other — passing the kerb at 1.2 m a face filled the side of the frame;
      // L1f refine 2)
      const atKerb = !me && road && this.edge[j] === b.e && this.dir[j] !== b.d && !this.commit[j];
      const soft = atKerb ? RIDER_SOFT_ONC * kj : road ? RIDER_GAP : (oncoming ? RIDER_SOFT_ONC : RIDER_SOFT) * (me ? k : kj);
      if (along > 0 && this.nIv < cap0) {
        const q = this.nIv++;
        ivLo[q] = b.latCur + side - soft;
        ivHi[q] = b.latCur + side + soft;
        // Two coming at each other pass on a fixed side, or they mirror each other's dodge (each
        // planning round where the other is now, both stepped the same way and met at 0.3 m):
        // the side they are already on if well apart, else keeping right (the other on the left).
        // Both work it out from the same offset, so they agree. The soft gap then counts all the
        // way across to the wrong side.
        if (vj > 0.25 && vjAlong < -0.4 * vj) {
          if (side > 0.6) ivHi[q] = 9;
          else ivLo[q] = -9;
        } else if (atKerb) {
          if (side > 0) ivHi[q] = 9;
          else ivLo[q] = -9;
        }
        this.ivSoft[q] = 1;
        this.ivW[q] = (oncoming || atKerb ? W_ONC : W_PEOPLE) * near;
        this.ivAlong[q] = along;
      }
      if (along > 0 && along < 3 * (me ? k : kj) && this.nIv < cap0) {
        const q = this.nIv++;
        // (the rider squeezes past someone standing about, a kerb waiter, a little closer: they
        // look away, and a hard berth round a knot of waiters at a corner would hold it there)
        const g = road ? PASS_GAP : me && vj < 0.25 ? 0.8 * kj : passOff ? 0.75 : gap;
        ivLo[q] = b.latCur + side - g;
        ivHi[q] = b.latCur + side + g;
        this.ivSoft[q] = 0;
        // (no way round: the rider stops RIDER_STOP short, the other RIDER_MEET short, or turns back)
        this.ivAlong[q] = road ? along : along + 0.75 - (me ? RIDER_STOP * k : RIDER_MEET * kj);
        if (!me && !road) {
          b.riderQ = q;
          b.rAlong = along;
        }
      }
      // (coming at the eye with the rider ahead on its path: its lateral there, for the pass the plan finds)
      if (b.onc === 1 && along > 0.3) b.rLat = b.latCur + side;
      if (vj > 0.25 && vjAlong > -0.5 * vj && j < i && along < 1.3 && Math.abs(side) < 0.7) b.cap = Math.min(b.cap, Math.max(0, (along - 0.55) * 1.8));
    }
    if (!b.squeeze && along > 0 && Math.abs(side) < 0.3 && d2 < 0.49) b.cap = Math.min(b.cap, Math.max(0, (dd - 0.5) * 2.5));
  }

  /**
   * Walker j, in the rider's way and slower than it (or standing), keeps to the side it is on
   * (relative to the rider's line; `side` right of the rider's travel, its frame in b) for a
   * moment: people step aside for someone wanting by, so the rider overtakes instead of stopping
   * behind them, a back in the lens, and turning round.
   */
  private makeWay(j: number, side: number, b: Berth): void {
    const s = side >= 0 ? 1 : -1;
    this.wayT[j] = 1.2;
    this.wayX[j] = b.nx * s;
    this.wayZ[j] = b.nz * s;
  }

  /** Seconds from sim time t until crossing e's walk window opens (0: open now). */
  private toOpen(e: number, t: number): number {
    const p = (t + this.crossPhase[e]) % CROSS_CYCLE;
    return p < CROSS_OPEN ? 0 : CROSS_CYCLE - p;
  }

  /**
   * The rider may step onto zebra e (it waits at the kerb otherwise): nobody on it going its way
   * is within the rider's follow distance ahead, so the berth holds across the carriageway, where
   * nobody stops for it.
   */
  private zebraClear(i: number, e: number): boolean {
    return !this.aheadOn(i, e, this.dir[i], this.u[i], RIDER_FOLLOW * this.riderK + 0.3);
  }

  /**
   * Is anyone coming the other way over the rider's zebra e at it: out on the crossing, or come off
   * it onto the rider's landing (within `reach` of the rider)? The rider waits for them to come off
   * and go by before it steps off (L1f round 5: it stepped off into one coming off, and the two
   * stood face to face at 0.4 m on the landing for four seconds).
   */
  private comingOff(i: number, e: number, reach: number): boolean {
    const f = this.info[e];
    for (let j = 0; j < this.n; j++) {
      if (j === i || !this.on[j] || this.edge[j] !== e || this.dir[j] === this.dir[i]) continue;
      // (only those near: waiting for every crosser of the walk window from the far side held it
      // at the kerb through the whole window, then the cars came)
      const gap = f.len - this.u[j] - this.u[i];
      if (gap > -0.5 && gap < reach && (this.commit[j] || this.vx[j] * this.vx[j] + this.vz[j] * this.vz[j] > 0.01)) return true;
    }
    return false;
  }

  /** Zebra e, next from walker i's corner: is anyone waiting at its kerb there, or about to? */
  private kerbTaken(i: number, e: number): boolean {
    const g = this.info[e];
    if (!g.crossing) return false;
    const dn = g.e.a === this.endNode(i) ? 1 : -1;
    return this.aheadOn(i, e, dn, 0, (dn > 0 ? g.kerbA : g.kerbB) + 0.2) || this.boundFor(i, e, 2.5);
  }

  /** Is anyone but i within `reach` of the end of its edge where i's ends, bound onto walk edge e next? */
  private boundFor(i: number, e: number, reach: number): boolean {
    const node = this.endNode(i);
    for (let j = 0; j < this.n; j++) {
      if (j === i || !this.on[j] || this.next[j] !== e || this.edge[j] === e || this.endNode(j) !== node) continue;
      if (this.info[this.edge[j]].len - this.u[j] < reach) return true;
    }
    return false;
  }

  /** Is anyone on walk edge e going way d within `reach` ahead of progress u (or beside it)? */
  private aheadOn(i: number, e: number, d: number, u: number, reach: number): boolean {
    for (let j = 0; j < this.n; j++) {
      if (j === i || !this.on[j] || this.edge[j] !== e || this.dir[j] !== d) continue;
      const ahead = this.u[j] - u;
      if (ahead > -0.2 && ahead < reach) return true;
    }
    return false;
  }

  /**
   * With walker i standing aside at lateral `at` (its travel frame, on [lo, hi]), is there a line
   * past it for the rider: RIDER_PASS (× riderK) from it and clear of the props from 1.5 m behind
   * it to 3 m in front of it along its edge (the tall ones by RIDER_CLEAR_HARD)?
   */
  private passBy(i: number, at: number, lo: number, hi: number): boolean {
    const f = this.info[this.edge[i]];
    const d = this.dir[i];
    const k = this.riderK;
    for (let v = lo; v <= hi + 1e-6; v += 0.05) {
      if (Math.abs(v - at) < RIDER_PASS_ONC * k) continue;
      let ok = true;
      for (let q = 0; q < f.oS.length && ok; q++) {
        // (and those up to 3 m in front of it, where the rider comes from: a trunk there on the
        // other side made a chicane the rider's one line could not take; it squeezed by at 0.6 m)
        const along = (d > 0 ? f.oS[q] : f.len - f.oS[q]) - this.u[i];
        if (along < -1.5 || along > 3) continue;
        const oi = f.oI[q];
        const tall = oi >= this.nProps || this.obsH[oi] > 1.15;
        ok = Math.abs(v - f.oL[q] * d) >= (tall ? Math.max(f.oR[q], this.obstacles[oi].r + RIDER_CLEAR_HARD * k) : f.oR[q]);
      }
      if (ok) return true;
    }
    return false;
  }

  /**
   * Can walker i step across to lateral `to` (its travel frame) where it stands: no prop or person
   * sitting or standing about within 1.2 m of it along its edge in the way? (L1f round 5: one meant
   * to stand aside at the kerb found a lamp post there and stood mid-pavement as the rider squeezed
   * by at half a metre.)
   */
  private canReach(i: number, to: number): boolean {
    const f = this.info[this.edge[i]];
    const d = this.dir[i];
    const from = this.lat[i];
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let q = 0; q < f.oS.length; q++) {
      const along = (d > 0 ? f.oS[q] : f.len - f.oS[q]) - this.u[i];
      if (along < -1.2 || along > 1.2) continue;
      const l = f.oL[q] * d;
      if (l + f.oR[q] > lo && l - f.oR[q] < hi) return false;
    }
    return true;
  }

  /** How many on walk edge e are coming toward the end way `dn` enters it by (within `reach` of it), or standing in its first 4 m. */
  private comingOn(i: number, e: number, dn: number, reach: number): number {
    const L = this.info[e].len;
    let n = 0;
    for (let j = 0; j < this.n; j++) {
      if (j === i || !this.on[j] || this.edge[j] !== e) continue;
      const s = this.dir[j] === dn ? this.u[j] : L - this.u[j];
      if ((this.dir[j] !== dn && s < reach) || (s < 4 && this.vx[j] * this.vx[j] + this.vz[j] * this.vz[j] < 0.04)) n++;
    }
    return n;
  }

  private edgeWeight(id: number, from: number, i: number): number {
    const f = this.info[id];
    const far = this.plan.walkNodes[f.e.a === from ? f.e.b : f.e.a];
    const dh = (Math.sqrt(far.x * far.x + far.z * far.z) - this.home[i]) / 22;
    // (the rider keeps off paths that squeeze past a lamp post, a tree or a bench with someone on it)
    return f.kindW * (Math.exp(-dh * dh) + 0.12) * (i === this.rider && this.riderRoom[id] < -0.2 ? 0.08 : 1);
  }

  /**
   * An edge's room for the rider's eye (riderRoom): along it, the best lateral spot's clearance
   * margin past each prop or idle person (and those within 0.9 m of it along the edge), worst case.
   */
  private roomOf(f: EdgeInfo): number {
    if (f.crossing) return 1;
    let worst = 1;
    for (let q = 0; q < f.oS.length; q++) {
      const s0 = f.oS[q];
      if (s0 < -0.3 || s0 > f.len + 0.3) continue;
      let best = -Infinity;
      for (let v = -f.hiL; v <= f.hiR + 1e-6; v += 0.05) {
        let m = Infinity;
        for (let p = 0; p < f.oS.length; p++) {
          if (Math.abs(f.oS[p] - s0) > 0.9) continue;
          const oi = f.oI[p];
          const c = oi >= this.nProps || this.obsH[oi] > 1.15 ? RIDER_CLEAR_TALL : RIDER_CLEAR_LOW;
          m = Math.min(m, Math.abs(v - f.oL[p]) - this.obstacles[oi].r - c);
        }
        if (m > best) best = m;
      }
      if (best < worst) worst = best;
    }
    return Math.max(-2, worst);
  }

  /** Sample walker i's travel path at progress smp.s (may run onto the next edge) into smp, tangent along travel. */
  private sampleTravel(i: number): void {
    const smp = this.smp;
    let f = this.info[this.edge[i]];
    let d = this.dir[i];
    let uAhead = smp.s;
    if (uAhead > f.len && this.next[i] !== this.edge[i]) {
      const node = this.endNode(i);
      uAhead = Math.min(uAhead - f.len, (f = this.info[this.next[i]]).len);
      d = f.e.a === node ? 1 : -1;
    }
    uAhead = Math.min(uAhead, f.len);
    smp.s = d > 0 ? uAhead : f.len - uAhead;
    sampleIn(f.e.path, smp);
    smp.tx *= d;
    smp.tz *= d;
  }

  /** Update u[i] by projecting the position onto the current edge near the old progress; near.l × dir is the lateral (right of travel). */
  private project(i: number): void {
    const f = this.info[this.edge[i]];
    const S = f.e.path.s;
    const d = this.dir[i];
    const s0 = d > 0 ? this.u[i] : f.len - this.u[i];
    let lo = 0;
    let hi = S.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (S[mid + 1] < s0 - 2) lo = mid + 1;
      else hi = mid;
    }
    const near = this.near;
    near.x = this.x[i];
    near.z = this.z[i];
    near.sMax = s0 + 2;
    nearestIn(f.e.path, near, lo);
    const uNew = d > 0 ? near.s : f.len - near.s;
    if (uNew > this.u[i] - 0.5) this.u[i] = uNew; // never backwards by projection noise at sharp joints
  }

  /**
   * v2 (L1): plan point (qx, qz) in walker i's travel path coordinates, into this.pth: arc length
   * ahead of it along its edge (then its next one, past the end) and lateral offset right of
   * travel, both from the path's centre line. Round a bend this is where someone really is relative
   * to the way i is going; the straight tangent put an oncomer beyond a bend on the wrong side.
   * `away`: the point is someone walking away from i (past the end of the edge, see below).
   */
  private onPath(i: number, qx: number, qz: number, away = false): void {
    const f = this.info[this.edge[i]];
    const d = this.dir[i];
    const u0 = this.u[i];
    const L = f.len;
    const S = f.e.path.s;
    const n = this.near3;
    const o = this.pth;
    // the current edge, from 1.5 m behind to 10 m ahead (travel direction; the berth looks no further)
    const s0 = d > 0 ? u0 - 1.5 : L - u0 - 10;
    const s1 = d > 0 ? u0 + 10 : L - u0 + 1.5;
    let lo = 0;
    let hi = S.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (S[mid + 1] < s0) lo = mid + 1;
      else hi = mid;
    }
    n.x = qx;
    n.z = qz;
    n.sMax = s1;
    nearestIn(f.e.path, n, lo);
    o.s = (d > 0 ? n.s : L - n.s) - u0;
    o.l = n.l * d;
    o.d = n.d;
    // (beyond the end its nearest point is the end itself: someone further on straight ahead had a
    // lateral of nought there and stood "in the rider's way" a metre and a half off — the rider,
    // about to turn the corner, stopped dead behind someone walking away down the other street;
    // L1f refine 2. Someone walking `away` is off the path by their distance from the end, unless
    // the next edge is nearer. Not everyone: someone standing or coming round that corner kept
    // the old lateral, which steered round them — off the path, they passed at 1.2 m)
    if (away && o.s >= L - u0 - 1e-3 && o.d > Math.abs(o.l)) o.l = o.l >= 0 ? o.d : -o.d;
    const nE = this.next[i];
    if (nE === this.edge[i] || o.s < L - u0 - 0.3) return;
    // past the end: the next edge, if that is nearer (its first metres, or its last, coming in at b)
    const g = this.info[nE];
    const dn = g.e.a === this.endNode(i) ? 1 : -1;
    const reach = Math.max(0.5, 10 - (L - u0));
    const G = g.e.path.s;
    let glo = 0;
    if (dn < 0) {
      let a = 0;
      let z = G.length - 2;
      while (a < z) {
        const mid = (a + z) >> 1;
        if (G[mid + 1] < g.len - reach) a = mid + 1;
        else z = mid;
      }
      glo = a;
    }
    n.sMax = dn > 0 ? reach : Infinity;
    nearestIn(g.e.path, n, glo);
    if (n.d >= o.d) return;
    o.s = L - u0 + (dn > 0 ? n.s : g.len - n.s);
    o.l = n.l * dn;
    o.d = n.d;
  }

  /**
   * Near the end of its edge, is walker i already on the next one (closer to it, and past its
   * start)? At a sharp joint a walker offset to the outside reaches its steering target (on the
   * next edge) before its progress on the current edge reaches the end.
   */
  private onNext(i: number): boolean {
    const f = this.info[this.edge[i]];
    const nE = this.next[i];
    if (nE === this.edge[i] || f.len - this.u[i] > LOOK) return false;
    const dCur = this.near.d;
    const g = this.info[nE];
    const n2 = this.near2;
    n2.x = this.x[i];
    n2.z = this.z[i];
    n2.sMax = Infinity;
    nearestIn(g.e.path, n2, 0);
    const uN = g.e.a === this.endNode(i) ? n2.s : g.len - n2.s;
    return uN > 0.05 && n2.d < dCur;
  }

  private buildGrid(): void {
    const N = this.gridN;
    this.gridHead.fill(-1);
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      const R = this.gridR;
      const c = Math.min(N - 1, Math.max(0, Math.floor((this.z[i] + R) / CELL))) * N + Math.min(N - 1, Math.max(0, Math.floor((this.x[i] + R) / CELL)));
      this.gridNext[i] = this.gridHead[c];
      this.gridHead[c] = i;
    }
  }

  /**
   * Obstacle intervals for walker i: of its own edge (`next` false), up to its end when it turns
   * there (past it the next edge's own list takes over), or of its next edge (`next`), continuing
   * its progress. `props`: idle people left out. (Integer and object arguments only: see header.)
   */
  private obstacleIvs(i: number, next: boolean, props: boolean): void {
    const cur = this.info[this.edge[i]];
    const turns = this.next[i] !== this.edge[i];
    const f = next ? this.info[this.next[i]] : cur;
    const d = next ? (f.e.a === this.endNode(i) ? 1 : -1) : this.dir[i];
    const u0 = next ? this.u[i] - cur.len : this.u[i];
    const ahead = OBS_AHEAD + (i === this.rider ? 2 : 0);
    const upTo = next || !turns ? ahead : Math.min(ahead, cur.len - u0 + 0.05);
    let k = this.nIv;
    const me = i === this.rider;
    for (let q = 0; q < f.oS.length && k < this.ivCap; q++) {
      if ((props && f.oI[q] >= this.nProps) || (!me && this.isCol(f.oI[q]))) continue;
      const along = (d > 0 ? f.oS[q] : f.len - f.oS[q]) - u0;
      if (along <= -0.7 || along >= upTo) continue;
      this.ivLo[k] = f.oL[q] * d - f.oR[q];
      this.ivHi[k] = f.oL[q] * d + f.oR[q];
      // (the rider: a prop more than 2.5 m on is a heavy soft gap, not yet a wall — a lamp post
      // 6 m on walled off its side of a corner pavement and it took the middle, into the pass of
      // someone coming at it; L1f refine 1)
      // (…and so is one on its next edge until it is round the corner: in that edge's own
      // lateral frame, a café terrace round a corner walled off the whole pavement 1.5 m short of
      // it and it stood there 3 s; L1f refine 1)
      const farSoft = me && (along > 2.5 || next);
      // (a block's corner column stands inside its footprint, which keeps the body off it anyway:
      // only its clearances count, or near a corner it walled off the whole pavement and the rider
      // stood 1.3 m short of it until it turned round; L1f refine 2)
      this.ivSoft[k] = farSoft || this.isCol(f.oI[q]) ? 1 : 0;
      this.ivW[k] = W_PROP_FAR * Math.max(0.1, 1 - (along - 1.5) / 3.5);
      this.ivAlong[k++] = Math.max(0, along);
      // (the rider keeps its eye clear of props and of people sitting or standing about where the
      // paving has room: tall ones further than low ones under the frame; a lamp post or a bench
      // with someone on it a hand's breadth from the lens fills the frame)
      if (me && k < this.ivCap - 1) {
        const oi = f.oI[q];
        const tall = oi >= this.nProps || this.obsH[oi] > (this.riderK > 1 ? 0.7 : 1.15);
        const r = this.obstacles[oi].r;
        const w = r + (tall ? RIDER_CLEAR_TALL : RIDER_CLEAR_LOW) * this.riderK;
        const near = along < 1.5 ? 1 : Math.max(0.1, 1 - (along - 1.5) / 3.5);
        this.ivLo[k] = f.oL[q] * d - w;
        this.ivHi[k] = f.oL[q] * d + w;
        this.ivSoft[k] = 1;
        this.ivW[k] = W_PROP * near;
        this.ivAlong[k] = this.ivAlong[k - 1];
        k++;
        // (and never within ~0.6 m of a tall one if there is any way at all: a heavy soft gap, not
        // a wall — between two lamp posts a wall left it no way on, either way)
        if (tall && along > 0.3) {
          const h = r + RIDER_CLEAR_HARD * this.riderK;
          this.ivLo[k] = f.oL[q] * d - h;
          this.ivHi[k] = f.oL[q] * d + h;
          this.ivSoft[k] = 1;
          this.ivW[k] = W_PROP_HARD * near;
          this.ivAlong[k] = this.ivAlong[k - 1];
          k++;
        }
      }
    }
    this.nIv = k;
  }

  /**
   * One fixed step. `busy` is written (cleared first), `blocked` read. (camX, camZ) is the player's
   * plan position, avoided like a standing person of radius camR while camOn. `lens`: the camera is
   * filming (standing still, or settling down onto the pavement): it is seen from further ahead, and
   * a walker it leaves no room to pass turns back there and then instead of walking up to it and
   * standing in the lens.
   */
  step(dt: number, t: number, busy: Uint8Array, blocked: Uint8Array, camX: number, camZ: number, camOn: boolean, camR = 0.75, lens = false): void {
    this.snap();
    busy.fill(0);
    this.buildGrid();
    this.blockedNow = blocked;
    const { x, z, px, pz, vx, vz, hx, hz, u, lat, edge, dir, commit, stuck, jam, info, gridHead, gridNext, gridR, smp, ivLo, ivHi, ivAlong, near, iq } = this;
    const N = this.gridN;
    const maxPush = PUSH_SPEED * dt;
    const rider = this.rider >= 0 && this.rider < this.n && this.on[this.rider] ? this.rider : -1;
    this.riderFresh = rider >= 0 ? Math.max(0, this.riderFresh - dt) : 0;
    if (rider >= 0) {
      // where the rider is heading: its path 2 m on (round a corner, where its view will be in a moment)
      smp.s = u[rider] + 2;
      this.sampleTravel(rider);
      const ax = smp.x - smp.tz * lat[rider] - x[rider];
      const az = smp.z + smp.tx * lat[rider] - z[rider];
      const al = Math.sqrt(ax * ax + az * az) || 1;
      this.riderAx = ax / al;
      this.riderAz = az / al;
    }
    for (let i = 0; i < this.n; i++) {
      if (!this.on[i]) continue;
      const me = i === rider;
      this.project(i);
      let f = info[edge[i]];
      // Edge transitions (possibly several on very short edges).
      for (let guard = 0; guard < 3 && (u[i] >= f.len - END_U || this.onNext(i)); guard++) {
        this.enterNext(i);
        f = info[edge[i]];
        this.project(i);
      }
      const e = edge[i];
      const d = dir[i];
      const latCur = near.l * d;
      const ui = u[i];
      const xi = x[i];
      const zi = z[i];
      let vDes = this.vPref[i];
      let waiting = false;
      let queue = false;
      let kerbOut = 0;
      let waitU = 0;
      /** Committed and off its near kerb: keeps the usual gap from the rider and gets off the road. */
      let crossingOut = false;
      const squeeze = commit[i] > 0 && jam[i] >= JAM_S;
      /** The rider gives up on its kerb (turns back, below). */
      let giveUp = false;
      this.ivCap = me ? IV_MAX : 48;

      // The rider picks its way on 4.5 m before its join (riderPick: by what each way puts in front
      // of its eye), and once more up to its corner if someone has since come to wait at the zebra
      // it picked, or is about to (walking up to it with the rider and there first, a back or a
      // shoulder a metre from the eye through the whole wait — the critic's person:4 ride, L1f r5).
      const nE = this.next[i];
      if (me && this.riderSeen === e && this.riderDodge !== e && nE !== e && f.len - ui > 0.2 && this.kerbTaken(i, nE)) {
        this.riderDodge = e;
        this.next[i] = this.riderPick(i, nE);
      }
      if (me && this.riderSeen !== e && f.len - ui < 4.5) {
        this.riderSeen = e;
        this.next[i] = this.riderPick(i);
      }

      // Zebra crossings: wait at the kerb, commit when open, flag busy until past the far kerb.
      if (f.crossing) {
        const kerbIn = d > 0 ? f.kerbA : f.kerbB;
        kerbOut = f.len - (d > 0 ? f.kerbB : f.kerbA);
        // (with the rider passing within 4 m and not crossing here, a waiter stands right at the
        // kerb: the knot at a corner otherwise blocked its way round the corner, a back in the lens)
        const shuffle = rider >= 0 && !me && edge[rider] !== e && (x[rider] - xi) ** 2 + (z[rider] - zi) ** 2 < 16;
        waitU = Math.max(0, kerbIn - (me ? RIDER_WAIT_BACK * this.riderK : shuffle ? 0.15 : WAIT_BACK));
        // (coming up behind the rider waiting at its kerb: waiting behind it, out of its view,
        // not at the kerb a metre in front of its eye; L1f round 5)
        if (!me && rider >= 0 && edge[rider] === e && dir[rider] === d && !commit[rider] && u[rider] > ui + 0.3) waitU = Math.min(waitU, Math.max(0, u[rider] - 1.1));
        // committed but still on the kerb, and a car will not stop: step back (past the far kerb
        // it is over: commit ends 0.15 m on and restarts only 0.2 m before it, so no flicker)
        // (and still on the kerb when the walk window closes: wait for the next one)
        // (with the rider passing close by, waiters go as soon as no car is committed — drivers stop
        // for them as for the rider — rather than stand in a knot at the corner it walks round, their
        // backs the middle of its view for 5–6 s; L1f refine 2)
        const early = rider >= 0 && !me && !((edge[rider] === e || this.next[rider] === e) && (edge[rider] !== e || dir[rider] !== d)) && (x[rider] - xi) ** 2 + (z[rider] - zi) ** 2 < 36 * this.riderK * this.riderK;
        const open = !blocked[e] && (early || (t + this.crossPhase[e]) % CROSS_CYCLE < CROSS_OPEN);
        // (the rider looks left and right at the kerb, RIDER_KERB_LOOK, then steps onto a zebra no
        // car is committed to, walk window or not: drivers stop for it; with the window open a
        // shorter look will do. It also waits for its berth on the zebra, zebraClear. Only a car
        // stops it once it has stepped off: the walk window closing does not.)
        if (me) this.riderLook = !commit[i] && ui > waitU - 0.4 && ui < kerbIn && vx[i] * vx[i] + vz[i] * vz[i] < 0.09 ? this.riderLook + dt : 0;
        const riderGo = me && !blocked[e] && (this.riderLook >= RIDER_KERB_LOOK || (open && this.riderLook >= 0.9 && this.toOpen(e, t + 1.5) === 0)) && this.zebraClear(i, e) && !this.comingOff(i, e, 5);
        if ((commit[i] && ui < kerbIn - 0.05 && (me ? blocked[e] > 0 : !open)) || ui > kerbOut + 0.15) commit[i] = 0;
        if (!commit[i] && ui < kerbOut - 0.2) {
          // (the first: out on the road after a placement; not within 0.5 m of the far kerb, where
          // someone who turned back at the kerb stands)
          if ((ui > kerbIn + 0.3 && ui < kerbOut - 0.5) || (ui >= waitU - 0.15 && (me ? riderGo : open))) commit[i] = 1;
          else {
            vDes = Math.min(vDes, Math.max(0, (waitU - ui) * 2.2));
            waiting = ui > waitU - 1.2;
            queue = ui > waitU - 1.6;
          }
        }
        if (commit[i]) {
          vDes *= 1.25;
          busy[e] = 1;
          crossingOut = ui > kerbIn - 0.3;
        }
        // (the rider coming off onto the far landing, where people wait at the corner it must get
        // to: the usual gaps until it is off the crossing; they give it the landing, berthPair)
        if (me && ui > kerbIn + 0.3) crossingOut = true;
        if (me) {
          // standing at the kerb too long (a car holding the zebra, a crowd ahead on it): unless the
          // window is about to open, it turns back and goes another way
          const standing = waiting && !commit[i] && vx[i] * vx[i] + vz[i] * vz[i] < 0.04;
          this.riderWait = standing ? this.riderWait + dt : 0;
          if (this.riderWait > RIDER_KERB_S) giveUp = true;
          // (someone waiting right in front of it on a short landing: a back in the lens for the
          // whole wait; it goes another way, unless the window is open)
          if (this.riderWait > 1 && !open && kerbIn < RIDER_WAIT_BACK + 0.6 && this.aheadOn(i, e, d, ui, RIDER_SEP_FRONT * this.riderK)) giveUp = true;
        }
      } else if (me) this.riderWait = this.riderLook = 0;

      // Travel frame at the agent.
      smp.s = ui;
      this.sampleTravel(i);
      const tx = smp.tx;
      const tz = smp.tz;
      const nx = -tz; // right of travel
      const nz = tx;

      // Lateral planning: intervals the body centre must avoid, in the travel-right frame.
      this.nIv = 0;
      const turns = this.next[i] !== e;
      this.obstacleIvs(i, false, squeeze);
      // (the rider looks further round the corner: a trunk there turned up too late to step round)
      if (turns && f.len - ui < OBS_AHEAD + (me ? 2 : 0)) this.obstacleIvs(i, true, squeeze);
      let nIv = this.nIv;
      /** Intervals below this index are props' and idle people's (obstacleIvs). */
      const nObsIv = nIv;
      let followCap = Infinity;
      let yieldTo = false;
      /** Held up by the rider's berth: gives up and turns round sooner (no long face-off in the lens). */
      let riderBlock = false;
      const cx = Math.min(N - 1, Math.max(0, Math.floor((xi + gridR) / CELL)));
      const cz = Math.min(N - 1, Math.max(0, Math.floor((zi + gridR) / CELL)));
      // (the rider's own neighbours, and everyone's relation to the rider: berthPair, below)
      for (let gz = Math.max(0, cz - 1); gz <= Math.min(N - 1, cz + 1) && !me; gz++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(N - 1, cx + 1); gx++) {
          for (let j = gridHead[gz * N + gx]; j >= 0; j = gridNext[j]) {
            const rx = px[j] - xi;
            const rz = pz[j] - zi;
            const d2 = rx * rx + rz * rz;
            const along = rx * tx + rz * tz;
            const side = rx * nx + rz * nz;
            if (j === i || j === rider || d2 > 9 || along < -0.25 || Math.abs(side) > 1.4) continue;
            const vj = Math.sqrt(vx[j] * vx[j] + vz[j] * vz[j]);
            const vjAlong = vx[j] * tx + vz[j] * tz;
            // a kerb waiter gives the landing to someone coming off the crossing at it
            if (waiting && edge[j] === e && dir[j] !== d && commit[j] && d2 < 4) yieldTo = true;
            if (vj > 0.25 && vjAlong > 0.6 * vj) {
              // walking our way: follow (never overtake through them)
              if (Math.abs(side) < PASS_GAP - 0.04 && along > 0) followCap = Math.min(followCap, Math.max(0, vjAlong + (along - 0.62) * 1.6));
            } else if (!squeeze) {
              // oncoming, crossing our path, or standing: step round them; yield to crossers by id
              if (along > 0 && along < 3 && nIv < 48) {
                ivLo[nIv] = latCur + side - PASS_GAP;
                ivHi[nIv] = latCur + side + PASS_GAP;
                this.ivSoft[nIv] = 0;
                ivAlong[nIv++] = along;
              }
              if (vj > 0.25 && vjAlong > -0.5 * vj && j < i && along < 1.3 && Math.abs(side) < 0.7) followCap = Math.min(followCap, Math.max(0, (along - 0.55) * 1.8));
            }
            if (!squeeze && along > 0 && Math.abs(side) < 0.3 && d2 < 0.49) followCap = Math.min(followCap, Math.max(0, (Math.sqrt(d2) - 0.5) * 2.5));
          }
        }
      }
      let riderQ = -1;
      let riderAlong = 0;
      let noBack = false;
      /** Braked by the berth (the rider, or someone in its way): it may still sidestep. */
      let berthHeld = false;
      /** ±1: step aside to the right / left edge (away from the rider coming off the crossing). */
      let aside = 0;
      /** The speed cap with the rider's berth in it (a step back to give the landing keeps it too). */
      let riderCap = Infinity;
      /** Coming at the rider's eye (bc.onc, rLat, rAhead, closing), or close in its view at a ride's start (bc.clear). */
      let onc = false;
      let clear = false;
      /** The rider: the nearest back in its view (bc.lead…), −1: none. */
      let lead = -1;
      const b = this.bc;
      if (rider >= 0) {
        // the camera's personal space (people/sim.ts RIDER_GAP)
        b.xi = xi;
        b.zi = zi;
        b.tx = tx;
        b.tz = tz;
        b.nx = nx;
        b.nz = nz;
        b.latCur = latCur;
        b.e = e;
        b.d = d;
        b.waiting = waiting ? 1 : 0;
        b.out = crossingOut ? 1 : 0;
        b.carriageway = f.crossing && ui > (d > 0 ? f.kerbA : f.kerbB) && ui < kerbOut ? 1 : 0;
        b.squeeze = squeeze ? 1 : 0;
        b.cap = followCap;
        b.block = 0;
        b.yieldTo = yieldTo ? 1 : 0;
        b.riderQ = -1;
        b.noBack = 0;
        b.aside = 0;
        b.lead = -1;
        b.onc = 0;
        b.clear = 0;
        b.backNear = 0;
        b.abreast = -1;
        b.bkN = 0;
        b.bkJ = -1;
        b.crossY = 0;
        this.nIv = nIv;
        if (me) {
          for (let j = 0; j < this.n; j++) if (j !== i && this.on[j]) this.berthPair(i, j);
        } else this.berthPair(i, rider);
        nIv = this.nIv;
        followCap = b.cap;
        riderBlock = b.block > 0 && !me;
        berthHeld = b.block > 0;
        yieldTo = b.yieldTo > 0;
        riderQ = b.riderQ;
        riderAlong = b.rAlong;
        noBack = b.noBack > 0;
        aside = b.aside;
        riderCap = b.cap;
        onc = b.onc > 0;
        clear = b.clear > 0;
        if (me) {
          // (waiting its turn at a crossing point: never for long — after 3 s it goes, for 3 s)
          if (this.riderCrossCool > 0) this.riderCrossCool -= dt;
          this.riderCrossT = b.crossY ? this.riderCrossT + dt : Math.max(0, this.riderCrossT - dt);
          if (this.riderCrossT > 3) {
            this.riderCrossT = 0;
            this.riderCrossCool = 3;
          }
          // keeping its distance from the same back for long: at the next join it goes another way
          // than they do (and they walk on a little faster)
          lead = this.leadNow = b.lead;
          this.riderFollowT = lead >= 0 ? this.riderFollowT + dt : Math.max(0, this.riderFollowT - 2 * dt);
          if (lead >= 0 && this.riderFollowT > RIDER_TAIL_T && this.riderLead !== lead) {
            // tailing someone: overtake where this pavement has room for a wide pass and length
            // left to do it in, they walk it our way and are not hurrying off; else drop back
            this.riderLead = lead;
            const k = this.riderK;
            this.riderPass = !f.crossing && edge[lead] === e && dir[lead] === d && f.len - ui > Math.max(10, 3.5 * b.leadD + 2) && f.hiR + f.hiL >= (RIDER_PASS_ONC + 0.15) * k && this.hurry[lead] <= 0.5 && this.vPref[lead] < RIDER_V_MAX - 0.3 ? lead : -1;
          }
          // (the pass is off once they are not ahead on this pavement, or step back into its line
          // ahead of it — round a corner — and it drops back instead)
          if (this.riderPass >= 0 && (lead !== this.riderPass || edge[lead] !== e || (b.leadAlong > 0.5 && Math.abs(b.leadSide) < 0.8 * RIDER_PASS * this.riderK && this.riderLeadT > 1.5))) this.riderPass = -1;
          this.riderLeadT = this.riderPass >= 0 ? this.riderLeadT + dt : 0;
          // (they keep to the kerb side: the rider keeps off it, clear of turning buses)
          if (this.riderPass >= 0) this.makeWay(lead, f.roadSide !== 0 ? f.roadSide * d : b.leadSide, b);
          else if (lead >= 0 && this.riderFollowT > RIDER_TAIL_T && b.leadD < RIDER_TAIL_FAR * this.riderK) this.hurry[lead] = Math.max(this.hurry[lead], 0.5);
          // (from 4.5 m before the join, after RIDER_TAIL_T of following, and over a zebra too if
          // that is the other way: L1f round 5's far tails were one back down a whole block)
          if (lead >= 0 && this.riderFollowT > RIDER_TAIL_T && this.riderSplit !== e && f.len - ui < 4.5) {
            this.riderSplit = e;
            const theirs = edge[lead] === e ? this.next[lead] : edge[lead];
            if (this.next[i] === theirs && theirs !== e) this.next[i] = this.riderPick(i, theirs);
          }
        } else if (this.rpick[i] !== e && turns && f.len - ui < 3 && (px[rider] - xi) ** 2 + (pz[rider] - zi) ** 2 < 400) {
          // near its join with the rider about (once per edge): not head-on into the rider's narrow
          // pavement, nor ahead of the rider down the way it is about to take (a back to follow)
          this.rpick[i] = e;
          const nxt = this.next[i];
          const rE = edge[rider];
          const rN = this.next[rider];
          const rNode = this.endNode(rider);
          const myNode = this.endNode(i);
          const rLeft = info[rE].len - u[rider];
          // (every pavement but a plaza: 2.2 m of paving leaves a pass of 1.5 m at most, a head at
          // the frame's edge going by; L1f round 5 counted only the 1.6 m ones)
          // (…and a plaza's paths too, unless they leave a pass of RIDER_PASS_ONC and more: L1f
          // refine 1, the critic's person:223 met a dog walker head-on at a plaza junction)
          const narrow = (g: EdgeInfo) => !g.crossing && (g.e.kind !== 'plaza' || g.e.width - 2 * (BODY_R + 0.04) < (RIDER_PASS_ONC + 0.6) * this.riderK);
          const gN = info[rN];
          const farN = gN.e.a === rNode ? gN.e.b : gN.e.a;
          let avoid = -1;
          if (nxt === rE && myNode === rNode && rLeft < 20 && narrow(info[rE])) avoid = nxt;
          else if (nxt === rN && rN !== rE && myNode === farN && rLeft < 10 && narrow(gN)) avoid = nxt;
          else if (nxt === rN && myNode === rNode && f.len - ui < rLeft) avoid = nxt;
          if (avoid >= 0) this.next[i] = this.chooseNext(i, false, avoid);
        }
      }
      let camQ = -1;
      let lensBack = false;
      if (camOn && i !== this.free && !me) {
        const rx = camX - xi;
        const rz = camZ - zi;
        const along = rx * tx + rz * tz;
        const side = rx * nx + rz * nz;
        // stop short a body length early: nobody walks up to the lens
        if (along > -0.25 && along < (lens ? LENS_REACH : 3.5) + camR && Math.abs(side) < camR + 0.85 && nIv < this.ivCap) {
          camQ = nIv;
          // heading at a filming camera, inside its berth: turn round now (below), not at its feet
          lensBack = lens && along > 0 && Math.abs(side) < camR && !(commit[i] && f.crossing);
          ivLo[nIv] = latCur + side - camR;
          ivHi[nIv] = latCur + side + camR;
          this.ivSoft[nIv] = 0;
          ivAlong[nIv++] = Math.max(0, along - 0.8);
        }
      }

      // Standing aside for the rider (below): until it is past, or gone. If the rider stands held
      // up within 3 m of it for a second all the same (no way past after all), it walks off the
      // other way instead.
      let yielding = false;
      let yieldOff = false;
      if (this.yieldT[i] > 0) {
        this.yieldT[i] -= dt;
        const rdx = rider >= 0 ? px[rider] - xi : 0;
        const rdz = rider >= 0 ? pz[rider] - zi : 0;
        // (past: the rider on the other side of it from where it was when it stepped aside — not
        // behind it along its way: one ahead going the rider's way, turned to it, stepped aside and
        // straight back again every step, facing the lens)
        if (rider < 0 || me || (f.crossing && (commit[i] || ui < kerbOut)) || rdx * this.yieldX[i] + rdz * this.yieldZ[i] < -0.3 || rdx * rdx + rdz * rdz > 64) this.yieldT[i] = 0;
        else if (this.yieldT[i] < 7 && rdx * rdx + rdz * rdz < 9 && vx[rider] * vx[rider] + vz[rider] * vz[rider] < 0.0225 && !f.crossing) {
          this.yieldT[i] = 0;
          yieldOff = true;
        } else if (this.yieldT[i] < 7.2 && !f.crossing && Math.abs(lat[i] - (this.yieldS[i] > 0 ? (d > 0 ? f.hiR : f.hiL) : -(d > 0 ? f.hiL : f.hiR))) > 0.3) {
          // (still short of its edge after 0.8 s — someone in the way there — it walks off the way
          // it came instead of standing mid-pavement as the rider squeezes by, or out beside a bus)
          this.yieldT[i] = 0;
          yieldOff = true;
        } else yielding = true;
      }

      // Lateral offset: nearest to the preference (with hysteresis) outside every interval. Waiting
      // at a kerb: the right half, so people coming off the crossing pass on the left. The rider's
      // berth adds soft intervals (its preferred, wider passes and its eye's clearance from props):
      // each costs its weight per metre inside it, so the plan keeps the ones that matter most when
      // the paving has no room for all; hard ones are walls.
      const room = squeeze ? 0.6 : 0;
      // (the rider a hand's breadth in from the paving's edge: hugging it, its steering target round
      // a corner fell off the paving and it stood pushing at the kerb until it turned round)
      const inset = me && !f.crossing ? Math.min(0.12, ((d > 0 ? f.hiR : f.hiL) + (d > 0 ? f.hiL : f.hiR)) * 0.1) : 0;
      const hi = (d > 0 ? f.hiR : f.hiL) + room - inset;
      const lo = -(d > 0 ? f.hiL : f.hiR) - room + inset;
      // (the rider on a pavement: the side away from the carriageway, clear of turning buses — but
      // halfway between the kerb band and the shop fronts, up to 0.6 m off them: a hand's breadth
      // from them, a glass front filled the side of the frame for the length of the block; L1f
      // refine 2)
      // (keeping to one side for the rider: makeWay)
      const way = !me && rider >= 0 && this.wayT[i] > 0 && !(f.crossing && (commit[i] || waiting));
      if (this.wayT[i] > 0) this.wayT[i] -= dt;
      const prefLat = yielding ? (this.yieldS[i] > 0 ? hi : lo) : way ? (this.wayX[i] * nx + this.wayZ[i] * nz > 0 ? hi : lo) : aside ? (aside > 0 ? hi : lo) : me && f.roadSide !== 0 ? (f.roadSide * d > 0 ? lo - inset + Math.min(0.6, Math.max(0.15, (hi - KERB_BAND - lo) / 2)) : hi + inset - Math.min(0.6, Math.max(0.15, (hi - KERB_BAND - lo) / 2))) : (queue ? Math.max(this.pref[i], 0.8) : this.pref[i]) * (hi - room);
      const ivSoft = this.ivSoft;
      const ivW = this.ivW;
      if (me && f.roadSide !== 0 && !f.crossing && nIv < this.ivCap) {
        // (the rider keeps off the kerb side of the pavement whatever else it plans round: a bus
        // turning the corner swept within 0.6 m of the eye of a rider kept right for someone coming)
        const q = nIv++;
        const roadRight = f.roadSide * d > 0;
        ivLo[q] = roadRight ? hi - KERB_BAND : lo - 1;
        ivHi[q] = roadRight ? hi + 1 : lo + KERB_BAND;
        ivSoft[q] = 1;
        ivW[q] = W_KERB;
        ivAlong[q] = 0;
      }
      let bestLat = NaN;
      let bestCost = Infinity;
      for (let c = -4; c < 2 * nIv; c++) {
        const v = c === -4 ? prefLat : c === -3 ? lat[i] : c === -2 ? hi : c === -1 ? lo : c & 1 ? ivHi[c >> 1] + 0.01 : ivLo[c >> 1] - 0.01;
        if (v < lo - 1e-6 || v > hi + 1e-6) continue;
        let cost = Math.abs(v - prefLat) + 0.6 * Math.abs(v - lat[i]);
        let free = cost < bestCost;
        // (costs only grow: a candidate already dearer than the best is done)
        for (let q = 0; q < nIv && free; q++) {
          if (!(v > ivLo[q] && v < ivHi[q])) continue;
          if (ivSoft[q]) free = (cost += ivW[q] * Math.min(v - ivLo[q], ivHi[q] - v)) < bestCost;
          else free = false;
        }
        if (free && cost < bestCost) {
          bestCost = cost;
          bestLat = v;
        }
      }
      const okLat = !Number.isNaN(bestLat);
      if (me && this.dbgIv) {
        let str = '';
        for (let q = 0; q < nIv; q++) str += ` [${ivLo[q].toFixed(2)},${ivHi[q].toFixed(2)}]${ivSoft[q] ? 's' + ivW[q].toFixed(1) : 'H'}@${ivAlong[q].toFixed(1)}`;
        this.dbgIv = str || ' -';
      }
      if (me) {
        this.dbgPlan[0] = prefLat;
        this.dbgPlan[1] = bestLat;
        this.dbgPlan[2] = lo;
        this.dbgPlan[3] = hi;
        this.dbgPlan[4] = nIv;
      }
      // (no way round everything: the rider still picks its line by what is close — hard walls
      // within 1.2 m, everything further a heavy cost — so it stops short of the far conflict
      // without brushing the lamp post beside it on the way; round 4 held a line 0.4 m off a pole)
      let fallLat = NaN;
      if (!okLat && me) {
        let fc = Infinity;
        for (let c = -4; c < 2 * nIv; c++) {
          const v = c === -4 ? prefLat : c === -3 ? lat[i] : c === -2 ? hi : c === -1 ? lo : c & 1 ? ivHi[c >> 1] + 0.01 : ivLo[c >> 1] - 0.01;
          if (v < lo - 1e-6 || v > hi + 1e-6) continue;
          let cost = Math.abs(v - prefLat) + 0.6 * Math.abs(v - lat[i]);
          let free = cost < fc;
          for (let q = 0; q < nIv && free; q++) {
            if (!(v > ivLo[q] && v < ivHi[q])) continue;
            const pen = Math.min(v - ivLo[q], ivHi[q] - v);
            if (ivSoft[q]) free = (cost += ivW[q] * pen) < fc;
            else if (ivAlong[q] > 1.2) free = (cost += 20 * pen) < fc;
            else free = false;
          }
          if (free && cost < fc) {
            fc = cost;
            fallLat = v;
          }
        }
      }
      // the nearest conflict on our current line (along), if any (a soft one the plan accepts is none)
      const li = lat[i];
      let a = Infinity;
      let aProp = Infinity;
      for (let q = 0; q < nIv; q++) {
        if (ivSoft[q] && (!okLat || (bestLat > ivLo[q] && bestLat < ivHi[q]))) continue;
        if (li > ivLo[q] && li < ivHi[q] && ivAlong[q] < a) a = ivAlong[q];
        if (q < nObsIv && li > ivLo[q] && li < ivHi[q] && ivAlong[q] < aProp) aProp = ivAlong[q];
      }
      // (or no way round its berth)
      if (lens && camQ >= 0 && !okLat && li > ivLo[camQ] && li < ivHi[camQ] && !(commit[i] && f.crossing)) lensBack = true;
      // Someone coming at the rider's eye who cannot pass it RIDER_PASS wide (the pass the lateral
      // plan makes with the rider on its path, else the closest approach of the two courses), or
      // standing facing it close by, or with no way round it at all within RIDER_TURN, meets it:
      // where the paving leaves a pass at its edge it steps aside there and stands, turned to the
      // side, until the rider is by (a turn-back close in front of the lens read as walking up to
      // it and leading off in front); on narrow paving it turns back, still RIDER_TTC away. Off
      // the far kerb of a zebra it only ever steps aside (never back onto the road). A turn back
      // only ever goes from facing the rider and going its way along the path to facing away:
      // turning back round a corner from it walked one straight back at the eye.
      const kj = this.riderK;
      // (two straight courses miss more widely than two that bend round a corner: the closest
      // approach of the velocities must clear the pass by a margin)
      // (the rider on another edge — round a corner, where the path frame is a guess —: the closer of
      // the plan's pass and the courses' closest approach; one coming round a corner at a rider
      // standing by it planned a pass the courses never made and turned back at a metre, its face
      // filling the frame for a second; L1f refine 2)
      const passW = !onc ? Infinity : Number.isNaN(b.rLat) ? b.cpa - 0.15 * kj : okLat ? (edge[rider] !== edge[i] ? Math.min(Math.abs(bestLat - b.rLat), b.cpa - 0.15 * kj) : Math.abs(bestLat - b.rLat)) : 0;
      // (off a zebra onto a landing where the rider stands waiting it walks on by — the rider steps
      // aside, berthPair — rather than stand aside beside it: one stood a metre from a waiting
      // rider's eye for eight seconds, a head filling the side of the frame)
      const farLanding = f.crossing && !commit[i] && ui > kerbOut + 0.1 && rider >= 0 && vx[rider] * vx[rider] + vz[rider] * vz[rider] > 0.09;
      const facingIt = !me && (!f.crossing || farLanding) && !yielding && this.hurry[i] < HURRY_S - 1.5 && rider >= 0 && (b.onc === 2 || towardRider(hx[i], hz[i], tx, tz, px[rider] - xi, pz[rider] - zi));
      const noWay = riderQ >= 0 && !okLat && li > ivLo[riderQ] && li < ivHi[riderQ] && riderAlong < RIDER_TURN * kj;
      const meet = facingIt && ((onc && passW < RIDER_PASS_ONC * kj) || noWay);
      // (stepping aside only where the rider then gets by RIDER_PASS wide, and never across the
      // rider's line to get there — to the kerb side from the far one it stood in the middle as
      // the rider squeezed by — else back the way it came)
      let roomy = meet && (farLanding || (hi - lo >= 0.85 && ((this.passBy(i, hi, lo, hi) && this.canReach(i, hi)) || (this.passBy(i, lo, lo, hi) && this.canReach(i, lo)))));
      if (roomy && !farLanding && f.roadSide !== 0 && !f.crossing) {
        const rs0 = Number.isNaN(b.rLat) ? (px[rider] - xi) * nx + (pz[rider] - zi) * nz : b.rLat - latCur;
        const kerb = f.roadSide * d > 0 ? 1 : -1;
        if (rs0 * kerb > 0 && Math.abs(rs0) < 2.5) roomy = false;
      }
      if (roomy) {
        // (to the side away from the rider, unless that leaves it no way past a lamp post or a
        // trunk on the other side, or no way to get there past one beside it: it stands aside,
        // turned side-on, until the rider is by, or 8 s. Walking on past along its edge instead
        // showed the lens a face coming at it for twice as long)
        // (on a pavement by the road, to the kerb side: the rider keeps to the side away from the
        // cars; round 4's yielder on the far side pushed it out beside a truck)
        const rs = Number.isNaN(b.rLat) ? (px[rider] - xi) * nx + (pz[rider] - zi) * nz : b.rLat - latCur;
        // (L1f round 5: to the kerb side only if that is away from the rider's line — a yielder
        // stepping across the rider's line to the kerb was stopped by its berth on the rider's
        // side of the paving and the rider squeezed by at half a metre)
        const kerbS: 1 | -1 = f.roadSide * d > 0 ? 1 : -1;
        const s0: 1 | -1 = f.roadSide !== 0 && !f.crossing && rs * kerbS < -0.1 ? kerbS : rs > 0 ? -1 : 1;
        const ok = (sd: number) => this.passBy(i, sd > 0 ? hi : lo, lo, hi) && (f.crossing || this.canReach(i, sd > 0 ? hi : lo));
        this.yieldT[i] = 8;
        this.yieldS[i] = ok(s0) || !ok(-s0) ? s0 : (-s0 as 1 | -1);
        const rl = Math.sqrt((px[rider] - xi) ** 2 + (pz[rider] - zi) ** 2) || 1;
        this.yieldX[i] = (px[rider] - xi) / rl;
        this.yieldZ[i] = (pz[rider] - zi) / rl;
      }
      const riderBack = facingIt && !farLanding && towardRider(hx[i], hz[i], tx, tz, px[rider] - xi, pz[rider] - zi) && ((meet && !roomy) || clear);
      // held by the berth with a way round it: sidestep there (braked, it has no walk to carry the shift)
      // (on a zebra's landings too: two meeting there froze face to face at a metre)
      const slide = berthHeld && !(f.crossing && commit[i]) && okLat && Math.abs(bestLat - latCur) > 0.08;
      if (!okLat) {
        // no room: hold the line (the rider: its best line by what is close) and stop short of the
        // nearest conflict
        bestLat = Number.isNaN(fallLat) ? li : fallLat;
        if (a < Infinity) followCap = Math.min(followCap, Math.max(0, (a - 0.75) * 1.8));
        // (the rider stops further short of a prop: a café table, someone abreast on the other
        // side, it walked on to 0.25 m from the table's edge; L1f refine 1)
        if (me && aProp < Infinity) followCap = Math.min(followCap, Math.max(0, (aProp - 1.3) * 1.8));
      }
      // a long sidestep before a close obstacle: slow down so it is done in time
      const shift = Math.abs(bestLat - li);
      if (shift > 0.05 && a < Infinity) followCap = Math.min(followCap, Math.max(0.15, ((a - 0.25) * LAT_SPEED) / shift));
      lat[i] += Math.max(-LAT_SPEED * dt, Math.min(LAT_SPEED * dt, bestLat - lat[i]));
      if (lead >= 0) {
        // The rider's lead (a back in its view): passed wide (an overtake, or abreast on a wide
        // path) — only once it IS that far to the side and quick enough to get by, briskly —
        // otherwise kept RIDER_TAIL off, eye to back, easing down to a third of its pace rather
        // than stopping while still clear of it. (Round 4 first went by the plan: chasing someone
        // hurrying off, it sat a metre behind their back for five seconds, "overtaking".)
        const k = this.riderK;
        const passing = lead === this.riderPass;
        // (overtaking someone merely slower only with this pavement's length to do it in: on short
        // edges round corners it sped up, failed at the corner and closed in again, a back at 2 m)
        const room = edge[lead] === e && f.len - ui > Math.max(6, 3 * b.leadD + 2);
        const quick = passing ? b.leadV < RIDER_V_MAX - 0.3 : room && b.leadV < Math.min(vDes, RIDER_V_MAX - 0.35) - 0.12;
        if (quick && Math.abs(b.leadSide) >= (RIDER_PASS_ONC - 0.05) * k) {
          vDes = Math.min(RIDER_V_MAX, Math.max(vDes, b.leadV + (passing ? 0.65 : 0.45)));
        } else {
          // (tailing and not overtaking: dropping back, easing to half their pace as they hurry on)
          // (not over a zebra: crawling across it and onto its landing at a third of a walk, it
          // held someone waiting there facing it for 3 s; L1f refine 1)
          const far = this.riderFollowT > RIDER_TAIL_T && !passing && !f.crossing;
          // (inside RIDER_TAIL, at a third of their pace: at 0.6 of it a kid's eye sat 2–3 m behind
          // grown-ups' backs, filling its frame, for seven seconds; L1f round 5)
          // (dropping back, at 0.45 of their pace: at 0.6 a back 4–6 m ahead stayed the middle of
          // the view for 5–10 s; L1f refine 1)
          // (…but at a slow walk while still RIDER_TAIL off from one with little pace along its way
          // — turning away round a corner 4–6 m on: it stood watching them go — though never at a
          // floor as fast as a slow one ahead, behind whom it then hovered 3 m back for 6 s)
          const c = Math.max(b.leadD > 1.6 * k ? (far && b.leadD > RIDER_TAIL * k ? (b.leadV < 0.5 ? 0.55 : 0.45 * b.leadV) : 0.3 * Math.max(0, b.leadV)) : 0, b.leadV + (b.leadD - (far ? RIDER_TAIL_FAR : RIDER_TAIL) * k) * 0.7);
          if (c < followCap) followCap = c;
        }
      }
      // Strangers' backs in the middle of the rider's view (RIDER_BACK_R, L1f refine 2): after
      // RIDER_BACK_T, unless it is passing the nearest wide, they step out briskly (all of them: a
      // knot walks on as one) and the rider eases off; standing or barely getting on close in its
      // way, it stops short and goes another way.
      let backOff = false;
      if (me) {
        const k = this.riderK;
        const bj = b.bkJ;
        this.riderBackT = bj >= 0 ? this.riderBackT + dt : Math.max(0, this.riderBackT - 1.5 * dt);
        // (how fast the gap to the nearest back opens, smoothed; a new one starts at nought)
        this.riderGapV = bj >= 0 && bj === this.riderGapJ ? this.riderGapV + ((b.bkD - this.riderGapD) / dt - this.riderGapV) * Math.min(1, dt * 2) : 0.3;
        this.riderGapJ = bj;
        this.riderGapD = b.bkD;
        if (bj >= 0 && this.riderBackT > RIDER_BACK_T && !f.crossing && this.riderOpenT <= 0) {
          // (passing it: the line the rider has planned clears it by RIDER_PASS_ONC − 0.35 standing,
          // − 0.25 walking, and the rider overtaking walks quicker than it)
          // (barely getting on — standing about, held up, a slow stroller — counts as standing: at a
          // third of a slow one's pace the rider hung 4 m behind it for 9 s)
          const still = b.bkV < 0.7;
          const wide = okLat && Math.abs(bestLat - b.bkL) >= (RIDER_PASS_ONC - (still ? 0.35 : 0.25)) * k;
          const D = this.dbgB;
          D[0] = bj;
          D[1] = b.bkD;
          D[2] = b.bkV;
          D[3] = wide ? 1 : 0;
          D[4] = still ? 1 : 0;
          D[5] = this.riderBackT;
          D[6] = this.riderStopT;
          D[7] = b.bkN;
          if (!(wide && (still || bj === this.riderPass || this.vPref[i] > b.bkV + 0.25))) {
            const R2 = RIDER_BACK_HURRY * RIDER_BACK_HURRY * k * k;
            for (let j = 0; j < this.n; j++) {
              if (j === i || !this.on[j]) continue;
              const qx = x[j] - xi;
              const qz = z[j] - zi;
              const q2 = qx * qx + qz * qz;
              if (q2 > R2) continue;
              const ql = Math.sqrt(q2) || 1;
              if (hx[j] * qx + hz[j] * qz > 0.5 * ql && qx * this.riderVx + qz * this.riderVz > 0.82 * ql && this.progV[j] > 0.2) this.hurry[j] = Math.max(this.hurry[j], 0.6);
            }
            // (…unless its join is a few metres on and they are not taking its way there: riderPick parts them)
            const parting = f.len - ui < 4 && edge[bj] !== this.next[i] && this.next[bj] !== this.next[i];
            if (this.riderBackT > RIDER_BACK_CAP && this.riderGapV < 0.25 && !parting) {
              // (a back in the middle of the view this long, not dropping away: it goes another way)
              backOff = true;
              this.dbgWhy = 1;
              this.dbgBack = bj;
              this.dbgBackL = b.bkL - bestLat;
            } else if (still && b.bkD < RIDER_BACK_STOP * k) {
              // (standing in its way: it stops 3 m short — anyone standing about there keeps to the
              // side for it, makeWay — and, still no way past a moment on, goes another way)
              followCap = Math.min(followCap, Math.max(0, (b.bkD - 3 * k) * 1.5));
              if (b.bkAlong < 3.5 * k) this.makeWay(bj, b.bkL - latCur, b);
              this.riderStopT = this.progV[i] < 0.3 ? this.riderStopT + dt : 0;
              if (this.riderStopT > 0.8) {
                backOff = true;
                this.dbgWhy = 2;
                this.dbgBack = bj;
                this.dbgBackL = b.bkL - bestLat;
              }
            } else {
              // (close behind them, at a stroll: the gap opens at a walk's pace, not a crawl's)
              const close = b.bkD < 3 * k;
              followCap = Math.min(followCap, Math.max(close ? 0.3 : RIDER_BACK_MIN, (close ? 0.3 : RIDER_BACK_EASE) * b.bkV));
            }
          }
        }
        if (!backOff && (bj < 0 || b.bkV >= 0.7)) this.riderStopT = 0;
      }
      // (walking abreast of the rider a metre from its eye, a head at the frame's side for
      // seconds: the other goes on ahead, briskly, and the rider eases off, so they part; L1f r5)
      if (me) {
        this.riderAbreastT = b.abreast >= 0 ? this.riderAbreastT + dt : 0;
        if (this.riderAbreastT > 0.6) {
          this.hurry[b.abreast] = Math.max(this.hurry[b.abreast], 0.5);
          vDes = Math.min(vDes, 0.75 * this.vPref[i]);
        }
      }
      // (being overtaken by the rider: easing off a little)
      if (i === this.riderPass && rider >= 0) vDes *= 0.75;
      // (turned back for the rider, or walking ahead of it: a little faster, for a while)
      if (this.hurry[i] > 0) {
        this.hurry[i] -= dt;
        if (vDes < RIDER_V_MAX) vDes = Math.min(RIDER_V_MAX, vDes * HURRY_K);
      }

      // (standing aside is no hold-up: it does not count toward turning back)
      const wanted = yielding ? 0 : vDes;
      vDes = Math.min(vDes, followCap);

      // Steer at the target ahead (a waiter giving way: at a spot 0.6 m back from its wait line;
      // the rider at a kerb: back to its wait line, still facing the road).
      // (at the very start of its crossing — a landing so short the wait line is the corner — a
      // step back is no step at all: it steps aside for the rider coming off instead; round 5 had
      // two such waiters stand in its way at 1.2 m for four seconds)
      const back = yieldTo && !noBack && ui > waitU - 0.7 && !(aside !== 0 && ui < 0.3);
      const backR = me && waiting && !back && ui > waitU + 0.08;
      // (a waiter the rider comes off the crossing at sidesteps to the edge of the landing, where
      // it stands: standing, it has no walk to carry a lateral shift)
      // (the rider stepping aside at its kerb also steps back to its wait line: round 4 waited
      // a quarter metre short of it, beside the kerb a turning truck clips)
      const sideBack = me && aside !== 0 && waiting && backR;
      const side = !sideBack && ((aside !== 0 && (waiting || me) && !back) || (slide && !waiting && !back) || yielding);
      smp.s = back ? Math.max(0, waitU - 0.7) : backR ? waitU : ui + LOOK;
      this.sampleTravel(i);
      // (round a hairpin of a winding park path — the way on turned more than ~100° within a
      // step's look — the offset line folds back on itself: aim nearer the centre line; one on the
      // inside of one stepped to and fro on the spot, facing a rider's lens at 1.6 m for 3 s)
      const fold = rider >= 0 && !side ? Math.min(1, Math.max(0, (smp.tx * tx + smp.tz * tz + 0.2) / 0.5)) : 1;
      let dx = side ? nx * (bestLat - latCur) : smp.x - smp.tz * (sideBack ? bestLat : lat[i] * fold) - xi;
      let dz = side ? nz * (bestLat - latCur) : smp.z + smp.tx * (sideBack ? bestLat : lat[i] * fold) - zi;
      if ((me || rider >= 0) && !back && !backR && !side && dx * dx + dz * dz < 0.09) {
        // (an inside corner where this edge's offset line meets the next one's: the target lands
        // on the rider, which then circles it on the spot; aim further on — anyone, with a ride on:
        // one circling on a hairpin of a park path faced a rider's lens at 1.6 m for 3 s)
        smp.s = ui + LOOK + 0.8;
        this.sampleTravel(i);
        dx = smp.x - smp.tz * lat[i] - xi;
        dz = smp.z + smp.tx * lat[i] - zi;
        // (still on it — inside a park path's hairpin the offset line folds back on itself —: at
        // the path's centre line on ahead)
        if (dx * dx + dz * dz < 0.09) {
          dx = smp.x - xi;
          dz = smp.z - zi;
        }
      }
      const dl = Math.sqrt(dx * dx + dz * dz) || 1;
      // (a step back toward the rider keeps its berth; away from it, it is how the landing frees up)
      if (back) vDes = Math.min(0.7, dl * 2, rider >= 0 && (px[rider] - xi) * dx + (pz[rider] - zi) * dz > 0 ? riderCap : Infinity);
      // (briskly in a ride's first seconds: a settled ride can open on a waiter a hand's breadth
      // from the kerb, a car passing at 0.6 m from the eye)
      else if (backR) vDes = Math.min(this.riderFresh > 0 ? 1 : 0.45, dl * 1.5);
      else if (side) vDes = dl > 0.04 ? Math.min(0.6, dl * 2) : 0;
      dx /= dl;
      dz /= dl;
      const k = Math.min(1, dt * 5);
      vx[i] += (dx * vDes - vx[i]) * k;
      vz[i] += (dz * vDes - vz[i]) * k;
      let nxp = xi + vx[i] * dt;
      let nzp = zi + vz[i] * dt;
      // Well inside the edge's paving room (precomputed clear of road, water and buildings): no
      // CityIndex queries needed.
      // (crossings: an uncommitted walker on a landing checked clear at init, short of the kerb)
      const latNew = latCur + vx[i] * dt * nx + vz[i] * dt * nz;
      const inRoom = f.crossing
        ? !commit[i] && ui > 0.05 && ui + 0.1 < (d > 0 ? f.kerbA : f.kerbB) - 0.35 && (d > 0 ? f.landA : f.landB) && Math.abs(latNew) < hi
        : ui > 0.2 && ui < f.len - 0.2 && latNew < hi - room + 0.02 && latNew > lo + room - 0.02;
      // (and nothing to bump into out on the carriageway)
      const onCarriageway = f.crossing && ui > (d > 0 ? f.kerbA : f.kerbB) + 0.3 && ui < kerbOut - 0.3;
      if (!inRoom && !onCarriageway && ((iq[0] = nxp), (iq[1] = nzp), (iq[2] = BODY_R), this.index.collideQ(this.col))) {
        nxp = this.col.x;
        nzp = this.col.z;
      }
      const sx = nxp;
      const sz = nzp;
      // People are solid: slide round anyone closer than SEP (their previous positions, so the
      // result does not depend on update order), leaning right when meeting head on. Squeezing
      // past: only round people on the move.
      for (let gz = Math.max(0, cz - 1); gz <= Math.min(N - 1, cz + 1); gz++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(N - 1, cx + 1); gx++) {
          for (let j = gridHead[gz * N + gx]; j >= 0; j = gridNext[j]) {
            let ox = nxp - px[j];
            let oz = nzp - pz[j];
            const d2 = ox * ox + oz * oz;
            if (j === i || d2 >= SEP * SEP || (squeeze && vx[j] * vx[j] + vz[j] * vz[j] < 0.0625)) continue;
            const dd = Math.sqrt(d2);
            if (dd < 1e-6) {
              ox = nx;
              oz = nz;
            } else {
              ox /= dd;
              oz /= dd;
              if (ox * tx + oz * tz < -0.85) {
                ox += nx * 0.35;
                oz += nz * 0.35;
              }
            }
            const l = Math.sqrt(ox * ox + oz * oz);
            nxp = px[j] + (ox / l) * SEP;
            nzp = pz[j] + (oz / l) * SEP;
          }
        }
      }
      // The rider's berth, whatever the paths did (someone stepping into a kerb queue in front of
      // it, a corner, the rider coming off a crossing into the people waiting at its far kerb): the
      // other is pushed off to RIDER_SEP. Never the rider itself (a shove of the camera), nor a
      // committed crosser out on the road (it gets off it).
      if (rider >= 0 && !me && !crossingOut && !squeeze) {
        this.col.x = nxp;
        this.col.z = nzp;
        // (further in front of the rider's face: someone stopping there fills the lens)
        const ox = px[rider];
        const oz = pz[rider];
        const ax = nxp - ox;
        const az = nzp - oz;
        const ad = Math.sqrt(ax * ax + az * az);
        const front = ax * hx[rider] + az * hz[rider] > 0.57 * ad;
        // (a ride's first seconds: further all round, clear of the camera coming down to the head)
        this.pushOff(ox, oz, RIDER_PUSH * dt, Math.max(front ? RIDER_SEP_FRONT * this.riderK : RIDER_SEP, this.riderFresh > 0 ? RIDER_SEP_FRESH * this.riderK : 0));
        nxp = this.col.x;
        nzp = this.col.z;
      }
      // Last resort: never inside a prop or an idle person (their discs, current edge).
      for (let q = 0; q < f.oI.length; q++) {
        const oi = f.oI[q];
        if ((squeeze && oi >= this.nProps) || (!me && this.isCol(oi))) continue;
        const o = this.obstacles[oi];
        const ox = nxp - o.x;
        const oz = nzp - o.z;
        const rr = o.r + BODY_R;
        const d2 = ox * ox + oz * oz;
        if (d2 < rr * rr && d2 > 1e-8) {
          const dd = Math.sqrt(d2);
          nxp = o.x + (ox / dd) * rr;
          nzp = o.z + (oz / dd) * rr;
        }
      }
      // Push-outs are rate-limited: never further from the last position than our own step plus
      // PUSH_SPEED (the rest carries over to the next steps), so nobody jumps sideways in a crowd.
      let ex = nxp - xi;
      let ez = nzp - zi;
      const lim = Math.sqrt((sx - xi) * (sx - xi) + (sz - zi) * (sz - zi)) + maxPush;
      const el = ex * ex + ez * ez;
      if (el > lim * lim) {
        const q = lim / Math.sqrt(el);
        nxp = xi + ex * q;
        nzp = zi + ez * q;
      }
      // Never off the kerb except when committed to a crossing: if a shove would push us off, keep
      // our own step, else stand.
      if (!inRoom && (!f.crossing || (!commit[i] && !((iq[0] = xi), (iq[1] = zi), this.offPavingQ()))) && ((iq[0] = nxp), (iq[1] = nzp), this.offPavingQ())) {
        const own = !((iq[0] = sx), (iq[1] = sz), this.offPavingQ());
        nxp = own ? sx : xi;
        nzp = own ? sz : zi;
      }
      // An uncommitted walker at a crossing never advances past its kerb line. The paving check
      // above can let crowd shoves carry it a little way off a rounded corner, and once past
      // kerb + 0.3 it would count as already on the road and commit while a car holds the zebra.
      // This only stops forward motion; it never pulls anyone back.
      if (f.crossing && !commit[i]) {
        const line = (d > 0 ? f.kerbA : f.kerbB) + 0.1;
        const du = (nxp - xi) * tx + (nzp - zi) * tz;
        if (ui <= line + 0.2 && du > 0 && ui + du > line) {
          const over = Math.min(du, ui + du - line);
          nxp -= tx * over;
          nzp -= tz * over;
        }
      }
      ex = nxp - xi;
      ez = nzp - zi;
      const moved = Math.sqrt(ex * ex + ez * ez);
      this.progV[i] += (moved / dt - this.progV[i]) * Math.min(1, dt * 4);
      x[i] = nxp;
      z[i] = nzp;
      this.gait[i] += moved;
      this.latW[i] = latCur + ex * nx + ez * nz;
      this.tX[i] = tx;
      this.tZ[i] = tz;
      this.safe[i] = !f.crossing && ui > 1.1 && ui < f.len - 1.1 ? 1 : 0;

      // Facing: along the velocity when walking; across the road while waiting at a kerb.
      const sp = Math.sqrt(vx[i] * vx[i] + vz[i] * vz[i]);
      let fx = hx[i];
      let fz = hz[i];
      if (waiting && aside !== 0 && rider >= 0 && (px[rider] - xi) ** 2 + (pz[rider] - zi) ** 2 < 12.25) {
        // (a waiter stepping aside for the rider coming off the zebra turns along the kerb, out of its way)
        fx = nx * aside;
        fz = nz * aside;
      } else if (waiting) {
        fx = tx;
        fz = tz;
      } else if (yielding) {
        // (standing aside: turned side-on to the rider, toward the edge it stepped to — a shop
        // window or the road — never into the lens; round a corner its edge's normal can point
        // straight at a rider coming from the side street)
        let qx = -this.yieldZ[i];
        let qz = this.yieldX[i];
        if (qx * nx * this.yieldS[i] + qz * nz * this.yieldS[i] < 0) {
          qx = -qx;
          qz = -qz;
        }
        fx = qx;
        fz = qz;
      } else if (sp <= 0.02 && !me && rider >= 0 && this.turnWhy[i] > 0) {
        // (standing after turning back near the rider: facing its new way, not the lens it left;
        // one stood facing the rider at 1.25 m for 3 s, its facing frozen when it stopped)
        fx = tx;
        fz = tz;
      } else if (sp > 0.02) {
        fx = vx[i] / sp;
        fz = vz[i] / sp;
        if (me && sp < 0.9) {
          // the rider shuffling or sidestepping slowly keeps looking the way it is going
          const w = Math.max(0, (sp - 0.4) / 0.5);
          fx = tx + (fx - tx) * w;
          fz = tz + (fz - tz) * w;
        }
      }
      // The standoff breaker (L1f refine 1): the rider held up standing off a crossing for a moment
      // with this one close in its view, barely moving and not walking away from it — two stopped
      // a metre apart, face to face or shuffling, each waiting for the other (the critic r1's
      // person:161 and 223) — this one turns off, briskly, whatever it was doing.
      // (crawling counts, and on a zebra's landing too — coming off one at someone waiting to go on
      // it, the two inched at each other face to face at 1.8 m for 2 s — but not waiting at its kerb)
      if (me) this.riderHeldT = sp < 0.45 && !waiting ? this.riderHeldT + dt : 0;
      let standoff = false;
      // (a kerb waiter too, at the kerb the rider is coming off its zebra at: one stood 1.2 m from
      // its eye on the landing for 4 s, the rider edging round it)
      if (!me && rider >= 0 && this.riderHeldT > 0.35 && sp < 0.5 && this.hurry[i] < HURRY_S - 1 && !(f.crossing && (commit[i] || (waiting && !(edge[rider] === e && dir[rider] !== d))))) {
        const rdx = px[rider] - xi;
        const rdz = pz[rider] - zi;
        const rd = Math.sqrt(rdx * rdx + rdz * rdz) || 1;
        // (its way on leads at the rider: one ahead going the rider's way, standing for someone else,
        // turned back into the rider's face and then back again, over and over)
        // (in front of the rider's body, not of its view: the view may be looking past it)
        standoff = rd < 2.2 * kj && -(rdx * hx[rider] + rdz * hz[rider]) > 0.42 * rd && hx[i] * rdx + hz[i] * rdz > -0.3 * rd && tx * rdx + tz * rdz > 0;
      }
      // (turning away from the rider, briskly: a slow turn showed it a face, close, for half a second)
      if (me && this.riderOpenT > 0) {
        // (the rider turning round: at a steady RIDER_TURN_W, through the open side)
        this.riderOpenT -= dt;
        let ang = Math.atan2(hx[i] * fz - hz[i] * fx, hx[i] * fx + hz[i] * fz);
        if (Math.abs(ang) > 1.2 && (this.riderOpenX !== 0 || this.riderOpenZ !== 0)) {
          // the other way round, if its middle faces the open side and this way's does not
          const mid = Math.atan2(hz[i], hx[i]) + ang / 2;
          const alt = mid + Math.PI;
          if (Math.cos(alt) * this.riderOpenX + Math.sin(alt) * this.riderOpenZ > Math.cos(mid) * this.riderOpenX + Math.sin(mid) * this.riderOpenZ) ang -= Math.sign(ang) * 2 * Math.PI;
        }
        const st = Math.max(-RIDER_TURN_W * dt, Math.min(RIDER_TURN_W * dt, ang));
        const c = Math.cos(st);
        const sn = Math.sin(st);
        const hxr = hx[i] * c - hz[i] * sn;
        hz[i] = hx[i] * sn + hz[i] * c;
        hx[i] = hxr;
        if (Math.abs(ang) < 0.02) this.riderOpenT = 0;
      } else {
        const hk = Math.min(1, dt * (this.hurry[i] > HURRY_S - 0.5 ? 10 : sp > 0.2 ? 7 : 3));
        const hxn = hx[i] + (fx - hx[i]) * hk;
        const hzn = hz[i] + (fz - hz[i]) * hk;
        const hl = Math.sqrt(hxn * hxn + hzn * hzn) || 1;
        hx[i] = hxn / hl;
        hz[i] = hzn / hl;
      }
      this.h[i] += ((f.crossing && this.onRoad(i) ? f.hRoad : f.hEdge) - this.h[i]) * Math.min(1, dt * 16);

      // Stuck (held back by people / no room) → turn back after a while. Queueing at a kerb counts
      // slowly (people give up on a crossing after ~17 s). A committed crosser never turns back on
      // the carriageway's last 1.5 m; held up on the crossing it squeezes past after JAM_S.
      // (held: no headway along the path; shuffling sideways does not count)
      const held = wanted > 0.3 && ex * tx + ez * tz < 0.12 * wanted * dt && !(rider >= 0 && b.crossY);
      if (commit[i]) jam[i] = held ? jam[i] + dt : Math.max(0, jam[i] - dt * 0.5);
      if (queue) stuck[i] += dt * 0.2;
      // (the rider past a near kerb never turns back: back onto the road it would cross again)
      // (the rider held up behind someone standing with their back to it turns round in about a
      // second: it stood five behind a kerb waiter at a corner, a back filling the lens)
      // (…creeping up to its stop behind them counts too: a kid's eye crept the last metre and a
      // half up to grown-ups' backs filling its frame, then stood there; L1f round 5)
      else if ((held || (me && b.backNear && sp < 0.4 && !f.crossing)) && !(commit[i] && ui > kerbOut - 1.5) && !(me && f.crossing && ui > waitU + 0.3)) stuck[i] += riderBlock ? dt * 2.5 : me ? (b.backNear ? dt * 4 : dt * 2) : dt;
      else stuck[i] = Math.max(0, stuck[i] - dt * 2);
      // (waiting at the corner itself — no landing to step back or aside on — with the rider
      // coming off the zebra at it within 2.5 m: it goes off along the pavement and comes back)
      // (from 5 m: at 2.5 m it walked off across the rider's landing as the rider came off, a back
      // filling the side of the frame at 1.2 m; L1f refine 1)
      if (!me && waiting && aside !== 0 && ui < 0.3 && rider >= 0 && commit[rider] && (px[rider] - xi) ** 2 + (pz[rider] - zi) ** 2 < 25 * kj * kj) yieldOff = true;
      if (lensBack || riderBack || yieldOff || standoff || giveUp || backOff || stuck[i] > STUCK_S + (i % 7) * 0.3) {
        stuck[i] = 0;
        this.turnWhy[i] = lensBack ? 1 : riderBack ? (clear ? 3 : onc ? 2 : 4) : yieldOff ? 7 : standoff ? 8 : giveUp ? 5 : backOff ? 9 : 6;
        if (me) this.riderBackT = 0;
        // (turned back for the rider: off at a brisker pace)
        if (riderBack || yieldOff || standoff) {
          this.hurry[i] = HURRY_S;
          this.yieldT[i] = 0;
        }
        // (and its next join re-planned round the rider, whatever turned it: one turned back
        // stuck at a corner walked straight into the rider's short corner pavement head-on)
        this.rpick[i] = -1;
        if (me) {
          // (the open side to turn the head through: the zebra it gave up on, else the street beside
          // its pavement, else none — the shortest way)
          this.riderOpenT = 3;
          const kerb = giveUp && f.crossing;
          this.riderOpenX = kerb ? hx[i] : f.roadSide !== 0 ? nx * f.roadSide * d : 0;
          this.riderOpenZ = kerb ? hz[i] : f.roadSide !== 0 ? nz * f.roadSide * d : 0;
        }
        dir[i] = -d as 1 | -1;
        u[i] = f.len - ui;
        // keeps a commitment it had (still out on the road); a waiter turning back never gains one
        commit[i] = f.crossing && commit[i] && this.onRoad(i) ? 1 : 0;
        jam[i] = 0;
        // (the rider giving up on a kerb goes on along the pavement, not to the next kerb)
        this.next[i] = this.chooseNext(i, me);
        lat[i] = -lat[i];
        if (me) this.riderWait = 0;
        if (me && giveUp && f.crossing && !commit[i]) {
          // …from its landing straight onto the pavement it was not walking (round the corner, a
          // quarter turn of the view rather than a half turn back the way it came)
          this.next[i] = this.chooseNext(i, true, this.riderPrev);
          if (this.next[i] !== edge[i]) {
            this.enterNext(i);
            this.project(i);
          }
        }
      }
    }
    this.stepDogs(dt);
  }

  /** Move (col.x, col.z) up to `step` m away from (ox, oz) while closer than `sep`. */
  private pushOff(ox: number, oz: number, step: number, sep: number): void {
    const dx = this.col.x - ox;
    const dz = this.col.z - oz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= sep * sep || d2 < 1e-10) return;
    const d = Math.sqrt(d2);
    const k = Math.min(step, sep - d) / d;
    this.col.x += dx * k;
    this.col.z += dz * k;
  }

  private stepDogs(dt: number): void {
    const { dx, dz, dhx, dhz, col, iq } = this;
    for (let k = 0; k < this.dOwner.length; k++) {
      const i = this.dOwner[k];
      if (!this.on[i]) continue;
      const f = this.info[this.edge[i]];
      // at heel while the owner stands or waits to cross; trotting ahead on the left otherwise
      this.dogTarget(k, i, this.vx[i] * this.vx[i] + this.vz[i] * this.vz[i] < 0.1225 || (f.crossing && !this.commit[i]));
      let ex = col.x - dx[k];
      let ez = col.z - dz[k];
      const d = Math.sqrt(ex * ex + ez * ez) || 1e-4;
      const sp = Math.min(2.4, d * 3.2);
      ex /= d;
      ez /= d;
      let nx = dx[k] + ex * sp * dt;
      let nz = dz[k] + ez * sp * dt;
      // inside the owner's paving room (owner's lateral frame): no CityIndex queries
      let safe = false;
      if (this.safe[i]) {
        const rx = nx - this.x[i];
        const rz = nz - this.z[i];
        const l = this.latW[i] - rx * this.tZ[i] + rz * this.tX[i];
        const di = this.dir[i];
        safe = l < (di > 0 ? f.hiR : f.hiL) && l > -(di > 0 ? f.hiL : f.hiR) && Math.abs(rx * this.tX[i] + rz * this.tZ[i]) < 1;
      }
      if (!safe) {
        if (((iq[0] = nx), (iq[1] = nz), (iq[2] = 0.17), this.index.collideQ(col))) {
          nx = col.x;
          nz = col.z;
        }
        // never onto the carriageway unless the owner is crossing (and always free to get off it)
        if (((iq[0] = nx), (iq[1] = nz), this.offPavingQ()) && !((iq[0] = dx[k]), (iq[1] = dz[k]), this.offPavingQ()) && !(f.crossing && this.commit[i])) {
          nx = dx[k];
          nz = dz[k];
        }
      }
      ex = nx - dx[k];
      ez = nz - dz[k];
      const moved = Math.sqrt(ex * ex + ez * ez);
      // face the way it moves, or the owner's way when standing
      const fx = moved > 0.004 ? ex / moved : this.hx[i];
      const fz = moved > 0.004 ? ez / moved : this.hz[i];
      dx[k] = nx;
      dz[k] = nz;
      this.dg[k] += moved;
      this.dsp[k] += (moved / dt - this.dsp[k]) * Math.min(1, dt * 8);
      const hk = Math.min(1, dt * 6);
      const a = dhx[k] + (fx - dhx[k]) * hk;
      const b = dhz[k] + (fz - dhz[k]) * hk;
      const l = Math.sqrt(a * a + b * b) || 1;
      dhx[k] = a / l;
      dhz[k] = b / l;
    }
  }

  offPaving(x: number, z: number): boolean {
    this.iq[0] = x;
    this.iq[1] = z;
    return this.offPavingQ();
  }

  /** offPaving at (iq[0], iq[1]): no doubles cross the call (see CityIndex.q). */
  private offPavingQ(): boolean {
    const k = this.index.classifyQ();
    return k === 'road' || k === 'intersection' || k === 'building' || k === 'water';
  }

  /** Is walker i currently on the carriageway part of a crossing? */
  onRoad(i: number): boolean {
    const f = this.info[this.edge[i]];
    const d = this.dir[i];
    return f.crossing && this.u[i] > (d > 0 ? f.kerbA : f.kerbB) && this.u[i] < f.len - (d > 0 ? f.kerbB : f.kerbA);
  }
}

// ── Population ──

/** Per-person look, packed for the shader (people/shader.ts reads it from a texture). */
export interface Look {
  skin: number;
  shirt: number;
  legs: number;
  hair: number;
  acc: number;
  /** 0 bald, 1 short, 2 bun, 3 long, 4 hat, 5 curly/afro. */
  hairStyle: number;
  flags: number;
  /** Gait bounce 0..1. */
  bounce: number;
  pose: Pose;
  /** Height scale (kids ~0.66). */
  scale: number;
  seed: number;
}

export const enum LookFlag {
  Bag = 1,
  Backpack = 2,
  Umbrella = 4,
  Dress = 8,
  ShortSleeve = 16,
  Shorts = 32,
  Kid = 64,
  Leash = 128,
  Phone = 256,
  Blush = 512,
}

// sRGB hex colours. Saturated and harmonious with BRIEF §3's walls and roofs.
const SKIN = [0xf8d9bd, 0xf1c6a0, 0xe2a97f, 0xc98b5e, 0xa66c45, 0x7d4e33, 0x5c3a28];
const SHIRT = [0xe2543f, 0xff8a7a, 0xf2cc5b, 0x3d9ca8, 0x5aa9e6, 0xa99cda, 0x7fb04a, 0xf7f3ea, 0x2e3a6b, 0xf49ac2, 0xf28c38, 0x47b39d, 0xffb84d, 0x8e5bb5, 0xd9483b];
const LEGS = [0x3b5b92, 0x2b2f4a, 0xc8a86b, 0x3a3540, 0x7a7f8c, 0x6b4a33, 0x4f6d8f, 0x2f5a52, 0xe9dcc3];
const HAIR = [0x2b2522, 0x2b2522, 0x4a3022, 0x6e4128, 0x9a5a2e, 0xe5c06a, 0xd9a55a, 0xb8b4ae, 0xecebe6, 0x3b2a20];
const ACC = [0xd9483b, 0xffb84d, 0x3d9ca8, 0x5b6b8c, 0xf49ac2, 0x7fb04a, 0x2e3a6b, 0xf2cc5b, 0x8e5bb5, 0xa0643a];

/** Deterministic looks for `n` people (walkers first, then idlers). */
export function makeLooks(seed: number, n: number): Look[] {
  const rng = Rng.for(seed, 'people-looks');
  const out: Look[] = [];
  for (let i = 0; i < n; i++) {
    const kid = rng.float() < 0.1;
    const old = !kid && rng.float() < 0.14;
    const dress = !kid && rng.float() < 0.17;
    let flags = (dress ? LookFlag.Dress : 0) | (kid ? LookFlag.Kid : 0);
    if (rng.float() < (kid ? 0.5 : 0.55)) flags |= LookFlag.ShortSleeve;
    if (!dress && rng.float() < (kid ? 0.45 : 0.14)) flags |= LookFlag.Shorts;
    const accRoll = rng.float();
    if (accRoll < (kid ? 0.45 : 0.28)) flags |= !kid && accRoll < 0.16 ? LookFlag.Bag : LookFlag.Backpack;
    const hand = rng.float();
    if (!kid && hand < 0.05) flags |= LookFlag.Umbrella;
    else if (!kid && !old && hand < 0.13) flags |= LookFlag.Phone;
    const hs = rng.float();
    const hairStyle = old ? (hs < 0.3 ? 0 : hs < 0.5 ? 4 : 1) : dress ? (hs < 0.4 ? 3 : hs < 0.7 ? 2 : hs < 0.85 ? 5 : 1) : hs < 0.42 ? 1 : hs < 0.56 ? 3 : hs < 0.68 ? 2 : hs < 0.8 ? 5 : hs < 0.9 ? 4 : 1;
    const hair = old ? HAIR[rng.int(7, 8)] : rng.float() < 0.03 ? rng.pick([0xf49ac2, 0x47b39d, 0x8e5bb5]) : HAIR[rng.int(0, 6)];
    out.push({
      skin: SKIN[rng.int(0, SKIN.length - 1)],
      shirt: SHIRT[rng.int(0, SHIRT.length - 1)],
      legs: LEGS[rng.int(0, LEGS.length - 1)],
      hair,
      acc: ACC[rng.int(0, ACC.length - 1)],
      hairStyle,
      flags: flags | (rng.float() < (kid ? 0.8 : 0.35) ? LookFlag.Blush : 0),
      bounce: kid ? rng.range(0.7, 1) : old ? rng.range(0, 0.25) : rng.range(0.15, 0.85),
      pose: Pose.Walk,
      scale: kid ? rng.range(0.6, 0.7) : rng.range(0.93, 1.07),
      seed: rng.int(0, 255),
    });
  }
  return out;
}

/** Walker traits (speed, lateral preference, home radius) for walker i. */
export function makeTraits(seed: number, looks: readonly Look[], n: number): WalkerTraits[] {
  const rng = Rng.for(seed, 'people-traits');
  const out: WalkerTraits[] = [];
  for (let i = 0; i < n; i++) {
    const l = looks[i];
    const kid = (l.flags & LookFlag.Kid) !== 0;
    const slow = l.bounce < 0.25 || (l.flags & (LookFlag.Phone | LookFlag.Leash)) !== 0;
    out.push({
      vPref: kid ? rng.range(1.0, 1.35) : slow ? rng.range(0.8, 1.05) : rng.range(1.05, 1.45),
      pref: rng.range(0.3, 0.9),
      home: 8 + 78 * Math.pow(rng.float(), 1.5),
    });
  }
  return out;
}
