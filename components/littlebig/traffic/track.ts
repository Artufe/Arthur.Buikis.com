// Traffic (L1, v2): the capital's fleet as Trackables. Cards in the site's voice, the chase pose
// (body centre, heading, local up) and the live line, all from the sim alone (pure: no renderer,
// so specs drive it with a bare TrafficSim). traffic/index.ts registers them.
//
// Ids: 'car:<n>' (cars and compacts, counted in fleet order), 'truck:<n>', 'bus:<n>'. The fleet is
// seeded, so the ids name the same vehicles every visit. (V1's region vehicles continue each kind's
// numbering after these.)

import type { TrackKind } from '../core/contracts';
import { ROAD_H } from '../world/config';
import { planFrame, toSphere } from '../world/city/frame';
import type { CityPlan } from '../world/city/types';
import { v3 } from '../world/sphere';
import { busStops, FEM, KIDS, kmh, landmarks, MASC, nameAt, pickOf, roadNames } from './names';
import { KINDS, type TrafficSim } from './sim';

/** Colour names in mesh.ts bodyColours order, per kind. */
const COLOUR_NAMES: Record<string, string[]> = {
  bus: ['red', 'mustard', 'teal'],
  truck: ['red', 'teal', 'mustard', 'green', 'lilac'],
  car: ['red', 'mustard', 'teal', 'sky-blue', 'coral', 'lilac', 'cream', 'green', 'amber', 'slate', 'white'],
};
const ERRANDS = ['off to yoga', 'picking up a cake', 'just driving around', 'late for a haircut', 'singing along to the radio', 'looking for parking', 'on the school run', 'taking the scenic route', 'off to see grandma', 'fetching more coffee', 'lost, but it is fine', 'off to the beach'];
const LIVERIES = ['', 'petal & co. flowers', 'zippy parcels', 'wavelength water'];
const LIVERY_LINES = ['', 'flowers for the whole town', 'everything, delivered, eventually', 'fizzy water for the cafés'];
const BUS_LINES = ['ring line', 'the scenic route', 'plaza loop line', 'night owl line'];
const BUS_NUMBERS = [7, 12, 3, 21];

export interface VehicleCard {
  id: string;
  kind: TrackKind;
  label: string;
  sub: string;
}

/**
 * Cards for the whole fleet, in vehicle order (deterministic: the fleet's kinds and the colour and
 * variant slots are seeded). `vari` is traffic/index.ts's per-vehicle variant (cars: 1 taxi,
 * 2 police, 3 ice-cream van; trucks: their livery 1–3).
 */
export function vehicleCards(sim: TrafficSim, vari: ArrayLike<number>, seed: number): VehicleCard[] {
  const perKind = new Int32Array(KINDS.length);
  const perTrack: Record<string, number> = {};
  let taxi = 0;
  return Array.from({ length: sim.n }, (_, i) => {
    const k = sim.kind[i];
    const name = KINDS[k].name;
    const j = perKind[k]++;
    const kind: TrackKind = name === 'bus' ? 'bus' : name === 'truck' ? 'truck' : 'car';
    const n = (perTrack[kind] = (perTrack[kind] ?? -1) + 1);
    const cols = COLOUR_NAMES[name === 'compact' ? 'car' : name];
    const colour = cols[(j * 7 + k * 3) % cols.length];
    const v = vari[i];
    // every driver a different name, never a walker's: alternate the pools, counting down (nameAt)
    const who = nameAt(i & 1 ? MASC : FEM, seed, i >> 1, true);
    let label: string;
    let sub: string;
    if (kind === 'bus') {
      label = `bus ${BUS_NUMBERS[n % BUS_NUMBERS.length]}`;
      sub = `${BUS_LINES[n % BUS_LINES.length]} · driver ${who}`;
    } else if (kind === 'truck') {
      label = `${LIVERIES[v] || 'delivery'} truck`;
      sub = `${who}, ${LIVERY_LINES[v] || 'on a delivery'}`;
    } else if (v === 1) {
      label = `taxi ${11 + 17 * taxi++}`;
      sub = `${who}, looking for a fare`;
    } else if (v === 2) {
      label = 'police car';
      sub = `officer ${who}, on patrol (very relaxed)`;
    } else if (v === 3) {
      label = 'the ice-cream van';
      sub = `${pickOf(KIDS, i, seed, 42)}'s favourite van, jingle on`;
    } else {
      label = `${colour} ${name === 'compact' ? 'bubble car' : 'hatchback'}`;
      sub = `${who}, ${pickOf(ERRANDS, i, seed, 43)}`;
    }
    return { id: `${kind}:${n}`, kind, label, sub };
  });
}

export interface Pose3 {
  pos: { x: number; y: number; z: number };
  fwd: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  speed: number;
}

const F = { up: v3(), ax: v3(), az: v3() };
const P = v3();

/**
 * Vehicle i's chase pose at render fraction a: the body centre (half its height above the road),
 * the body's heading (rear axle → front axle, interpolated like the drawn body) and the local up.
 */
export function vehiclePose(sim: TrafficSim, i: number, a: number, out: Pose3): void {
  const fx = sim.pfx[i] + (sim.fx[i] - sim.pfx[i]) * a;
  const fz = sim.pfz[i] + (sim.fz[i] - sim.pfz[i]) * a;
  const rx = sim.prx[i] + (sim.rx[i] - sim.prx[i]) * a;
  const rz = sim.prz[i] + (sim.rz[i] - sim.prz[i]) * a;
  let dx = fx - rx;
  let dz = fz - rz;
  const dl = Math.sqrt(dx * dx + dz * dz) || 1;
  dx /= dl;
  dz /= dl;
  const cx = (fx + rx) / 2;
  const cz = (fz + rz) / 2;
  planFrame(cx, cz, F);
  toSphere(cx, cz, ROAD_H + KINDS[sim.kind[i]].height / 2, P);
  out.pos.x = P.x;
  out.pos.y = P.y;
  out.pos.z = P.z;
  let wx = F.ax.x * dx + F.az.x * dz;
  let wy = F.ax.y * dx + F.az.y * dz;
  let wz = F.ax.z * dx + F.az.z * dz;
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
  wx /= wl;
  wy /= wl;
  wz /= wl;
  out.fwd.x = wx;
  out.fwd.y = wy;
  out.fwd.z = wz;
  out.up.x = F.up.x;
  out.up.y = F.up.y;
  out.up.z = F.up.z;
  out.speed = sim.v[i];
}

export interface LaneStop {
  lane: number;
  /** Arc length along the lane. */
  s: number;
  name: string;
  /** The stop's plan position. */
  x: number;
  z: number;
}

/** Bus stops by lane: every stop within 7 m of a lane, with its arc length along it. */
export function stopsByLane(plan: CityPlan): LaneStop[] {
  const { stops, stopNames } = busStops(plan);
  const out: LaneStop[] = [];
  stops.forEach((f, k) => {
    for (const l of plan.lanes) {
      const p = l.path.pts;
      let best = Infinity;
      let bs = 0;
      for (let j = 0; j < p.length >> 1; j++) {
        const d = (p[j * 2] - f.x) ** 2 + (p[j * 2 + 1] - f.z) ** 2;
        if (d < best) {
          best = d;
          bs = l.path.s[j];
        }
      }
      if (best < 7 * 7) out.push({ lane: l.id, s: bs, name: stopNames[k], x: f.x, z: f.z });
    }
  });
  return out;
}

/** Lowercase name without a leading 'the ' (bus stops are named so: 'ring road'). */
const bare = (n: string) => n.replace(/^the /, '');

/**
 * What a bus calls junction `node`: a landmark beside it ('clock tower', 'the plaza'), else a road
 * meeting there that is neither of `a`, `b` (the roads the bus is on and turning onto) — a bus
 * announces the cross street, never the street it is driving down. Null if there is none.
 */
function junctionName(plan: CityPlan, node: number, a: string, b: string): string | null {
  const nd = plan.nodes[node];
  if (nd.kind !== 'junction') return null;
  let best: string | null = null;
  let bd = Infinity;
  for (const m of landmarks(plan)) {
    const d = Math.hypot(m.x - nd.x, m.z - nd.z);
    if (d < Math.min(m.r, 36) && d < bd && bare(m.name) !== bare(a) && bare(m.name) !== bare(b)) {
      bd = d;
      best = m.name;
    }
  }
  if (best) return best;
  const roads = roadNames(plan);
  for (const id of nd.edges) {
    const r = roads[id];
    if (bare(r) !== bare(a) && bare(r) !== bare(b) && r !== 'a side street') return r;
  }
  return null;
}

/**
 * A bus's next stop, until V1's routes bring real ones (the plan has only a couple of shelters):
 * a shelter ahead on its lane; else the junction it is coming to, by its cross street or landmark;
 * else a shelter or the junction past its next turn; else the nearest landmark in front of it.
 * Never the road it is on, nor the one it is turning onto.
 */
function nextStop(sim: TrafficSim, plan: CityPlan, i: number, stops: readonly LaneStop[]): string | null {
  const roads = roadNames(plan);
  const nL = sim.nLanes;
  const g = sim.seg[i];
  const onLane = g < nL;
  const lane = onLane ? g : plan.connectors[g - nL].toLane;
  const here = roads[plan.lanes[lane].edge];
  // the lane after the next junction (on a connector: the lane it is turning onto)
  const after = onLane ? plan.connectors[sim.next[i]].toLane : lane;
  const to = roads[plan.lanes[after].edge];
  const ok = (n: string) => bare(n) !== bare(here) && bare(n) !== bare(to);
  if (onLane) {
    let best: LaneStop | null = null;
    for (const st of stops) if (st.lane === lane && st.s > sim.s[i] + 3 && ok(st.name) && (!best || st.s < best.s)) best = st;
    if (best) return best.name;
    const j1 = junctionName(plan, plan.lanes[lane].to, here, to);
    if (j1) return j1;
  }
  let best: LaneStop | null = null;
  for (const st of stops) if (st.lane === after && (onLane || st.s > sim.s[i] + 3) && ok(st.name) && (!best || st.s < best.s)) best = st;
  if (best) return best.name;
  const j2 = junctionName(plan, plan.lanes[after].to, here, to);
  if (j2) return j2;
  const cx = (sim.fx[i] + sim.rx[i]) / 2;
  const cz = (sim.fz[i] + sim.rz[i]) / 2;
  const hx = sim.fx[i] - sim.rx[i];
  const hz = sim.fz[i] - sim.rz[i];
  let name: string | null = null;
  let bd = Infinity;
  for (const m of landmarks(plan)) {
    const dx = m.x - cx;
    const dz = m.z - cz;
    // (behind the bus: as good as twice as far)
    const d = Math.hypot(dx, dz) * (dx * hx + dz * hz < 0 ? 2 : 1);
    if (d < bd && ok(m.name)) {
      bd = d;
      name = m.name;
    }
  }
  return name;
}

/** The live line: '32 km/h · on maple avenue · turning left onto the ring road'; a bus adds its next stop. */
export function vehicleDetail(sim: TrafficSim, plan: CityPlan, i: number, stops: readonly LaneStop[]): string {
  const roads = roadNames(plan);
  const nL = sim.nLanes;
  const g = sim.seg[i];
  const onLane = g < nL;
  const lane = onLane ? plan.lanes[g] : plan.lanes[plan.connectors[g - nL].toLane];
  const here = roads[lane.edge];
  const v = sim.v[i];
  const parts: string[] = [v < 0.3 ? 'stopped' : kmh(v), `on ${here}`];
  // the turn at the next junction
  const c = onLane ? plan.connectors[sim.next[i]] : plan.connectors[g - nL];
  const to = roads[plan.lanes[c.toLane].edge];
  const left = onLane ? lane.path.length - sim.s[i] : 0;
  if (c.turn === 'uturn') parts.push('turning round');
  else if (c.turn !== 'straight' && left < 40) parts.push(to === here ? `turning ${c.turn}` : `turning ${c.turn} onto ${to}`);
  else if (to !== here && left < 40) parts.push(`then ${to}`);
  if (sim.kind[i] === 3) {
    // a bus: its next stop, always, in three parts (a turn about to happen replaces 'on <road>')
    const st = nextStop(sim, plan, i, stops);
    if (st) {
      if (parts.length > 2) {
        const turn = parts.pop()!;
        if (left < 15 && turn.startsWith('turning')) parts[1] = turn;
      }
      parts.push(`next stop: ${st}`);
    }
  }
  return parts.join(' · ');
}
