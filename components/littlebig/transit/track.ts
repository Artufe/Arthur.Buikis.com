// V1 (v2): the region's fleet and ferries as Trackables: cards in the site's voice and the live line,
// from the sim alone (pure: specs drive it with a bare TransitSim). transit/index.ts registers them.
//
// Ids continue each kind's numbering past the capital's (traffic/track.ts) from 200: 'car:200' …
// (cars and compacts), 'truck:200' …, 'bus:200' …; the ferries 'ferry:0' … (the region's only boats
// of that kind). Drivers' names continue the capital's countdown (nameAt), so no two drivers share one.

import type { TrackKind } from '../core/contracts';
import { compass, FEM, KIDS, kmh, MASC, nameAt, pickOf } from '../traffic/names';
import { KINDS } from '../traffic/sim';
import type { Region } from '../world/region/types';
import type { Vec3 } from '../world/sphere';
import type { FerryState } from './ferry';
import type { TransitSim } from './sim';

/** First region index per kind, and the capital's drivers per name pool (traffic/track.ts counts i >> 1). */
export const ID_BASE = 200;
const CAPITAL_DRIVERS = 18;

const COLOUR_NAMES: Record<string, string[]> = {
  bus: ['red', 'mustard', 'teal'],
  truck: ['red', 'teal', 'mustard', 'green', 'lilac'],
  car: ['red', 'mustard', 'teal', 'sky-blue', 'coral', 'lilac', 'cream', 'green', 'amber', 'slate', 'white'],
};
const ERRANDS = ['off to the harbour', 'visiting an aunt', 'just driving around', 'late for the ferry', 'singing along to the radio', 'taking the coast road', 'fetching fish for supper', 'off to see grandma', 'on the way home', 'chasing the sunset', 'lost, but it is fine', 'off to the beach'];
const LIVERIES = ['', 'petal & co. flowers', 'zippy parcels', 'wavelength water'];
const BOATS = ['the puffin', 'the sea pea', 'little gull'];

export interface Card {
  id: string;
  kind: TrackKind;
  label: string;
  sub: string;
}

/** Body colour slot per vehicle (bodyColours order), the same rule as the capital's. */
export const colourSlot = (sim: TransitSim, i: number, j: number) => {
  const k = sim.kind[i];
  return (j * 7 + k * 3) % COLOUR_NAMES[k === 3 ? 'bus' : k === 2 ? 'truck' : 'car'].length;
};

/** Cards for the fleet in vehicle order. `vari`: per vehicle 1 taxi, 3 ice-cream van; trucks their livery. */
export function fleetCards(sim: TransitSim, vari: ArrayLike<number>, seed: number): Card[] {
  const region = sim.net.region;
  const per = new Int32Array(KINDS.length);
  const perTrack: Record<string, number> = {};
  return Array.from({ length: sim.n }, (_, i) => {
    const k = sim.kind[i];
    const name = KINDS[k].name;
    const j = per[k]++;
    const kind: TrackKind = k === 3 ? 'bus' : k === 2 ? 'truck' : 'car';
    const n = (perTrack[kind] = (perTrack[kind] ?? ID_BASE - 1) + 1);
    const colour = COLOUR_NAMES[k === 3 ? 'bus' : k === 2 ? 'truck' : 'car'][colourSlot(sim, i, j)];
    const who = nameAt(i & 1 ? MASC : FEM, seed, CAPITAL_DRIVERS + (i >> 1), true);
    const home = region.settlements[sim.routes.home[i]]?.name ?? 'the hills';
    let label: string;
    let sub: string;
    if (kind === 'bus') {
      const ln = sim.routes.lines[sim.routes.line[i]];
      label = `bus ${ln.no}`;
      sub = busSub(sim, i);
    } else if (kind === 'truck') {
      label = `${LIVERIES[vari[i]] || 'delivery'} truck`;
      sub = `${who}, out of ${home}`;
    } else if (vari[i] === 1) {
      label = `${home} taxi`;
      sub = `${who}, looking for a fare`;
    } else if (vari[i] === 3) {
      label = 'the seaside ice-cream van';
      sub = `${pickOf(KIDS, i, seed, 44)}'s favourite van, jingle on`;
    } else {
      label = `${colour} ${name === 'compact' ? 'bubble car' : 'hatchback'}`;
      sub = `${who} from ${home}, ${pickOf(ERRANDS, i, seed, 45)}`;
    }
    return { id: `${kind}:${n}`, kind, label, sub };
  });
}

/** A bus's subtitle: the town it last served → the next ('far haven → clover'); a loop's: round its stop's street ('round park row · far haven'). */
export function busSub(sim: TransitSim, i: number): string {
  const ln = sim.routes.lines[sim.routes.line[i]];
  const S = sim.net.region.settlements;
  const q = sim.stop[i];
  if (ln.stops.length === 1) {
    const st = ln.stops[0];
    return `round ${sim.net.region.edges[sim.net.region.lanes[st.lane].edge].name} · ${S[st.town].name}`;
  }
  const prev = ln.stops[(q + ln.stops.length - 1) % ln.stops.length];
  return `${S[prev.town].name} → ${S[ln.stops[q].town].name}`;
}

/** Compass word of travel direction f at unit position u (0 = north, clockwise). */
function heading(u: Vec3, fx: number, fy: number, fz: number): string {
  // north: the pole (+y) projected onto the tangent plane; east = north × up
  let nx = -u.x * u.y;
  let ny = 1 - u.y * u.y;
  let nz = -u.z * u.y;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const ex = ny * u.z - nz * u.y;
  const ey = nz * u.x - nx * u.z;
  const ez = nx * u.y - ny * u.x;
  return compass(Math.atan2(fx * ex + fy * ey + fz * ez, fx * nx + fy * ny + fz * nz));
}

const U = { x: 0, y: 0, z: 0 };

/** The live line: '32 km/h · on church lane · heading north · for clover'; a bus its next stop. */
export function fleetDetail(sim: TransitSim, i: number): string {
  const region: Region = sim.net.region;
  const nL = sim.net.nL;
  const g = sim.seg[i];
  const lane = region.lanes[g < nL ? g : sim.net.to[g - nL]];
  const road = region.edges[lane.edge].name;
  const v = sim.v[i];
  const C = sim.C;
  const l = Math.hypot(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]) || 1;
  U.x = C[i * 3] / l;
  U.y = C[i * 3 + 1] / l;
  U.z = C[i * 3 + 2] / l;
  const parts = [v < 0.3 ? 'stopped' : kmh(v), `on ${road}`, `heading ${heading(U, sim.F[i * 3] - sim.Rr[i * 3], sim.F[i * 3 + 1] - sim.Rr[i * 3 + 1], sim.F[i * 3 + 2] - sim.Rr[i * 3 + 2])}`];
  const S = region.settlements;
  if (sim.kind[i] === 3) {
    const ln = sim.routes.lines[sim.routes.line[i]];
    const st = ln.stops[sim.stop[i]];
    parts.push(sim.door[i] ? 'at the stop, doors open' : `next stop: ${S[st.town].name}, ${region.edges[region.lanes[st.lane].edge].name}`);
  } else if (sim.dest[i] >= 0) {
    const here = lane.edge >= 0 ? region.edges[lane.edge].settlement : -1;
    parts.push(here === sim.dest[i] ? `about ${S[sim.dest[i]].name}` : `for ${S[sim.dest[i]].name}`);
  }
  return parts.join(' · ');
}

/** A ferry's card. */
export function ferryCard(region: Region, k: number): Card {
  const f = region.ferries[k];
  return { id: `ferry:${k}`, kind: 'ferry', label: BOATS[k % BOATS.length], sub: `the ferry, ${f.name}` };
}

/** A ferry's live line: 'docked at far haven · leaves in 9 s' or '19 km/h · to far haven · heading east'. */
export function ferryDetail(region: Region, k: number, st: FerryState, u: Vec3, fwd: Vec3): string {
  const f = region.ferries[k];
  const S = region.settlements;
  const pier = (b: number) => S[region.piers[b === 0 ? f.a : f.b].settlement].name;
  if (st.docked >= 0) return `docked at ${pier(st.docked)} · leaves in ${Math.ceil(st.left)} s`;
  return `${kmh(st.v)} · to ${pier(st.toward)} · heading ${heading(u, fwd.x, fwd.y, fwd.z)}`;
}
