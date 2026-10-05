// LITTLEBIG v2 region contract (R1): the world outside the capital's plateau. Pure data types, no
// three.js. Built once, deterministically, from the world seed by world/region/build.ts; read it
// through ctx.world.region (or getRegion()). Additive changes only; note them in DECISIONS.md.
//
// Consumers: T1 (towns' buildings, in each settlement's chart), H1 (renders every road, junction,
// roundabout, bridge, gate plaza, pier, runway), V1 (vehicles on the lanes and connectors; the
// ferry; the train), A2 (airports and flights), N2 (keeps scatter off roads, pads and runways via
// Region.surface()), the terrain (heightAt includes the pads and road beds, world/planet.ts).
//
// ── Space ──
// Everything is WORLD space: unit directions from the planet centre plus heights in metres above
// sea level (R, world/config.ts); a point is dir · (R + h). Headings are compass radians (0 = north,
// clockwise, world/sphere.ts). There is no region-wide 2D chart (the exponential map squeezes
// circumferential distance by sin θ/θ, −22 % at 1.2 rad from its origin); each settlement has its
// OWN chart (createChart round its centre, radius R + its pad height, +x east / +z south like the
// capital's CITY_CHART), so T1 plans lots in 2D exactly as A2 did, and small things (junctions,
// connectors) are built in a chart round their node.
//
// ── Heights ──
// A settlement stands on a PAD: a flat disc (Settlement.h, ±0.05) of radius padR, blended into the
// natural terrain over `blend` metres with a smoothstep (no cliff), like the capital's plateau.
// Roads are graded (≤ ~12 %) and carved: the terrain eases to the road bed (path h − ROAD_H) across
// the carriageway, sidewalks and shoulders, then blends back to nature on the verges. Bridges are
// NOT carved (the terrain under a bridge is the natural seabed / ground). Path heights (`WPath.h`)
// are the top of the asphalt: bed + ROAD_H, so a road in a town is pad h + ROAD_H, the same offset
// the capital's carriageways have above the plateau (2.0 + ROAD_H at the gate plazas: paved
// continuously with the city's own turnaround).
//
// ── Handedness, lanes ──
// Right-hand traffic, as in the capital. Seen from above (from outside the planet) the right of a
// travel tangent `fwd` at unit position `up` is fwd × up. A two-way edge has one lane per direction,
// lane centres ±width/4 from the centreline; a ONE-WAY edge (roundabout rings) has one lane on its
// centreline (lanesBA empty). Roundabouts circulate counter-clockwise seen from above.
//
// ── Graph ──
// The road network is one graph of nodes and edges, like the capital's (world/city/types.ts) but in
// world space: an edge's centreline runs from node a's patch edge to node b's; lanes and turn
// connectors join exactly (a connector's first sample is its fromLane's last, its last the toLane's
// first). The network falls apart into one COMPONENT per land mass (Region.components: the capital's
// continent, the far continent); each component is strongly connected over lanes + connectors, so a
// vehicle can roam its component forever. Ferries join components; they are their own graph.
// The capital's v1 traffic never enters this graph: its gate avenues end in their own turning
// circles, the region's gate roundabouts sit right outside them (GatePlaza).

import type { Chart, Vec3 } from '../sphere';

/**
 * A sampled curve in world space. Consecutive samples are ≤ 1 m apart (true 3D distance at their
 * heights). `s` is the cumulative true arc length in metres, so movers advance by distance.
 * Build with world/region/path.ts (wpath, woffset, wtrim…); sample with wsample (zero-alloc).
 */
export interface WPath {
  /** Unit directions, xyz interleaved (3 per sample). */
  dir: Float64Array;
  /** Height above sea level (m) per sample (roads: the top of the asphalt). */
  h: Float64Array;
  /** Cumulative arc length (m): s[0] = 0, s[n − 1] = length. */
  s: Float64Array;
  length: number;
  /** True if the last sample equals the first (a loop). */
  closed: boolean;
}

// ── Settlements ──

export type SettlementStyle = 'capital' | 'harbour' | 'alpine' | 'farm' | 'resort' | 'metro';
export type SettlementKind = 'capital' | 'city' | 'town' | 'village';

export interface Settlement {
  /** Stable id, lowercase-dashed: 'bigtown', 'port-pebble'. Index = position in Region.settlements. */
  id: string;
  index: number;
  /** Lowercase site voice: 'port pebble'. */
  name: string;
  kind: SettlementKind;
  style: SettlementStyle;
  /** One line for the label's second row: 'harbour · ferry to far haven'. */
  blurb: string;
  population: number;
  /** Unit direction of the pad centre. */
  dir: Vec3;
  /** Pad surface height above sea level (m). The capital: PLATEAU_HEIGHT. */
  h: number;
  /**
   * The settlement's plan space: plan (x, z) metres, +x east / +z south at its centre, on a sphere
   * of radius R + h (createChart). Town streets, the square and the quay are given in it too.
   * The capital's is CITY_CHART.
   */
  chart: Chart;
  /** Flat pad radius (m, plan) and the blend ring beyond it. The capital: CITY_PLAN_RADIUS / plateau blend. */
  padR: number;
  blend: number;
  /** Compass heading (rad) of the town's main axis: from its gate in along the main street. */
  heading: number;
  /** Land mass (index into Region.components). */
  component: number;
  /** Network node ids that belong to the town (its junctions, ends, square loop) and its street edge ids. */
  nodes: number[];
  streets: number[];
  /** Where the network enters: the bend nodes on the pad edge (gate plazas for the capital: GatePlaza ids). */
  gates: number[];
  /** The town's open square / green (plan x, z, radius), if its style has one: T1 keeps it free. */
  square?: { x: number; z: number; r: number };
  /** Harbour styles: the quay line along the water (plan x, z interleaved) at pad height. */
  quay?: Float64Array;
  /** Pier ids (Region.piers) and airport ids (Region.airports) that belong to it. */
  piers: number[];
  airports: number[];
}

/**
 * Where the capital meets the region. The capital's gate avenue (a v1 cul-de-sac run out to the rim,
 * world/city/layout.ts) ends in the city's own turning circle, whose outer sidewalk edge touches the
 * plateau rim at `touch`; the gate plaza is a paved disc (radius r, flat at PLATEAU_HEIGHT) on the
 * other side of that point, carrying a one-lane roundabout (ring centreline radius `ring`) round a
 * central island (radius `island`): H1 paves the plaza continuously with the turnaround and dresses
 * the island (a gate monument). City traffic U-turns on its circle; region traffic circles the
 * roundabout. They never share a lane.
 */
export interface GatePlaza {
  id: number;
  /** The capital's gate avenue edge id and its end node id in CityPlan (edges / nodes). */
  cityEdge: number;
  cityNode: number;
  /** Plan (capital chart) position of the city's turning circle centre and of the rim touch point. */
  cityX: number;
  cityZ: number;
  touchX: number;
  touchZ: number;
  /** Unit direction of the plaza centre, and of the touch point. */
  dir: Vec3;
  touch: Vec3;
  /** Plaza surface (the pad) height above sea level: PLATEAU_HEIGHT. */
  h: number;
  /** Paved plaza radius, roundabout ring centreline radius, central island radius (m). */
  r: number;
  ring: number;
  island: number;
  /** Network node ids on the roundabout ring (arms and a bend opposite a lone arm). */
  nodes: number[];
  /** Settlement ids the gate's roads lead to (for signs). */
  leadsTo: string[];
}

// ── The road network ──

/**
 * 'highway' and 'road' run between settlements (a highway is a wider, faster road); 'street' and
 * 'lane' are town streets; 'ring' is a roundabout ring (one-way); 'access' leads to a pier, an
 * airport or a viewpoint; 'bridge' is never a kind: bridges are spans on an edge (Bridge).
 */
export type RegionRoadKind = 'highway' | 'road' | 'street' | 'lane' | 'ring' | 'access';

/** What a node is for, besides being a junction: H1 dresses each accordingly. */
export type NodePlace = 'gate' | 'roundabout' | 'town-gate' | 'square' | 'end' | 'pier' | 'airport' | 'junction' | 'bend' | 'viewpoint';

export interface RNode {
  id: number;
  dir: Vec3;
  /** Road surface height at the node (m above sea level): pad h + ROAD_H in towns. */
  h: number;
  /** Incident edge ids sorted by increasing plan angle of their departure in the node's own chart
   *  (+x east, +z south: clockwise seen from above), as in the capital. */
  edges: number[];
  /** Distance (m) from the node centre at which incident centrelines begin (the patch radius). */
  radius: number;
  /** 'junction' (≥ 3 edges), 'bend' (2), 'end' (1: a turning circle, vehicles U-turn round it). */
  kind: 'junction' | 'bend' | 'end';
  /** Who yields: 'roundabout' nodes sit on a ring (entries yield to the ring); 'yield' = give way to the major road. */
  control: 'none' | 'yield' | 'roundabout';
  place: NodePlace;
  /** Settlement index it belongs to, or −1 (open country). */
  settlement: number;
  /** GatePlaza id for the capital's gate roundabouts, else −1. */
  gate: number;
  /** For 'end' nodes: the turning circle's carriageway radius (m), centred on the node. */
  turnR: number;
}

export interface Bridge {
  id: number;
  edge: number;
  /** Arc length range of the span on the edge's centreline (abutment to abutment). */
  s0: number;
  s1: number;
  /** Lowest deck height over water (m above sea level) and the clearance under it at the lowest point over water. */
  deckMin: number;
  clearance: number;
}

export interface REdge {
  id: number;
  a: number;
  b: number;
  kind: RegionRoadKind;
  /** Centreline from node a's patch edge to node b's (true metres). */
  centre: WPath;
  /** Carriageway width curb to curb (m); sidewalk width per side (0 for none: country roads have verges). */
  width: number;
  sidewalk: number;
  /** One-way a → b (roundabout rings): one lane on the centreline, lanesBA empty. */
  oneWay: boolean;
  /** Lane ids a → b and b → a. */
  lanesAB: number[];
  lanesBA: number[];
  /** Speed limit (m/s). */
  speed: number;
  /** Settlement index for town streets (and rings in towns), else −1. */
  settlement: number;
  /** Bridge ids on this edge (spans in centreline arc length). */
  bridges: number[];
  /** A name for signs and cards: 'mill road', 'cove bridge'. */
  name: string;
}

export interface RLane {
  id: number;
  edge: number;
  /** +1 runs a → b along the centreline, −1 b → a. */
  dir: 1 | -1;
  from: number;
  to: number;
  /** Lateral offset of the lane centre from the centreline, to the right of a → b (m). */
  offset: number;
  /** Lane centre in travel direction, from the `from` patch edge to the `to` patch edge. */
  path: WPath;
  /** Arc length a waiting vehicle's front must not pass (the lane end: there are no zebras out here). */
  stopS: number;
  /** Connector ids leaving its end / arriving at its start. Never empty. */
  next: number[];
  prev: number[];
  speed: number;
}

export type RTurn = 'straight' | 'left' | 'right' | 'uturn';

export interface RConnector {
  id: number;
  node: number;
  fromLane: number;
  toLane: number;
  turn: RTurn;
  path: WPath;
  /** Connector ids at the same node whose paths cross, merge or pass closer than VEHICLE_CLEARANCE (lazy). */
  conflicts: number[];
  /** Higher goes first: a roundabout's circulating traffic, then major-road straights, then turns. */
  priority: number;
}

// ── Sea, air, rail ──

/**
 * A pier: a deck from the quay (root, at pad height) out over the water to a berth in deep water.
 * H1 builds it (piles, deck, bollards); the ferry docks at its berth.
 */
export interface Pier {
  id: number;
  settlement: number;
  /** Unit direction of the root (on the quay) and of the berth (the deck's far end). */
  root: Vec3;
  berth: Vec3;
  /** Deck height above sea level (m), deck width, length (root → berth, m). */
  h: number;
  width: number;
  length: number;
  /** Compass heading (rad) root → berth. */
  heading: number;
  /** Network node at the root (an 'end' turnaround on the quay), or −1. */
  node: number;
}

/**
 * A ferry crossing between two piers: one closed sea lane, h = 0 (the sea surface), ≥ FERRY_DEPTH
 * deep and ≥ FERRY_SHORE from any shore all the way except the last metres into each berth. It runs
 * berth a → berth b on the outbound side and back on the other (right-hand: the two legs pass
 * port to port, FERRY_SEPARATION apart).
 */
export interface FerryRoute {
  id: number;
  name: string;
  a: number;
  b: number;
  /** The loop, starting at berth a. */
  lane: WPath;
  /** Arc length of berth a (0) and berth b on the loop. */
  berthS: [number, number];
}

/**
 * A runway on a flat carved strip (Airport.h ± 0.05 over its length and width plus shoulders). Its
 * LANDING end (`landEnd`) has the extended centreline clear of terrain under a 1:12 glide slope (with
 * 1.5 m to spare) for `approach` ≥ 200 m: planes land over it and take off toward the other end
 * (`clear` gives both ends' clear distance, up to 240 m). Further out, a flight may descend steeper
 * or curve in (A2's call: 1:12 from the cloud layer would take half the planet).
 */
export interface Airport {
  id: number;
  /** Three-letter code in the site voice: 'lbx'. */
  code: string;
  name: string;
  settlement: number;
  /** Runway centre and both thresholds (unit directions), heading end0 → end1 at the centre. */
  centre: Vec3;
  ends: [Vec3, Vec3];
  heading: number;
  /** Runway surface height (m above sea level), length and width (m). */
  h: number;
  length: number;
  width: number;
  /** Apron / terminal site beside the runway's middle (unit direction, radius m), flat at h. */
  apron: Vec3;
  apronR: number;
  /** Clear approach distance beyond the landing threshold (m, ≥ 200 under the 1:12 glide). */
  approach: number;
  /** Clear distance (m) under the 1:12 glide beyond ends[0] and ends[1] (checked to 240 m). */
  clear: [number, number];
  /** The end planes land over (its approach is the clear one); they take off toward the other end. */
  landEnd: 0 | 1;
  /** Network node at the terminal (the access road's turnaround), or −1. */
  node: number;
}

/** A viewpoint's car park at the end of its road (a turnaround on a hilltop), for labels and H1. */
export interface Lookout {
  name: string;
  /** Unit direction and road surface height (m above sea level) of the car park's centre. */
  dir: Vec3;
  h: number;
  /** Its network node (an 'end' with place 'viewpoint'). */
  node: number;
}

export interface RailStation {
  name: string;
  settlement: number;
  /** Arc length along the line's track. */
  s: number;
}

/** A rail line (its own graph): one track, graded ≤ 4 %, tunnels where it meets hills. */
export interface RailLine {
  id: number;
  name: string;
  track: WPath;
  stations: RailStation[];
  /** Arc length ranges of tunnels and bridges along the track. */
  tunnels: Array<[number, number]>;
  bridges: Array<[number, number]>;
}

// ── Queries ──

/** What lies at a surface point, for N2's scatter and anyone placing things outside the capital. */
export type RegionClass = 'road' | 'verge' | 'pad' | 'plaza' | 'runway' | 'free';

/** Output of Region.surface(): class, distance to the nearest road centreline (m), its edge id (−1 if none within reach). */
export interface SurfaceHit {
  cls: RegionClass;
  roadDist: number;
  edge: number;
  /** Settlement index whose pad core the point is in, else −1. */
  settlement: number;
}

export interface Region {
  seed: number;
  settlements: Settlement[];
  gates: GatePlaza[];
  nodes: RNode[];
  edges: REdge[];
  /** Built on first read (off the terrain's first-frame path); so are `ferries` and edges' lane ids. */
  lanes: RLane[];
  connectors: RConnector[];
  bridges: Bridge[];
  piers: Pier[];
  ferries: FerryRoute[];
  airports: Airport[];
  /** Viewpoints' car parks (the far continent's lookout). */
  lookouts: Lookout[];
  rail: RailLine[];
  /** Node ids per land mass; each is strongly connected over lanes + connectors. */
  components: number[][];
  /**
   * The carve: the final terrain height at unit `dir` given its natural (base) height there. The
   * planet's heightAt() calls it; nobody else needs to. Zero-alloc.
   */
  carve(dir: Vec3, base: number): number;
  /** Classify a surface point (zero-alloc: writes and returns `out`). */
  surface(dir: Vec3, out: SurfaceHit): SurfaceHit;
  /** Build time (ms), for the boot log and the budget spec. */
  readonly buildMs: number;
}
