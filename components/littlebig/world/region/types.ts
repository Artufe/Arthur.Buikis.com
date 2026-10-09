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
// A settlement stands on a PAD: a disc of radius padR, blended into the natural terrain over `blend`
// metres with a smoothstep (no cliff), like the capital's plateau. v2 (R2): a pad's surface is a
// PLANE (±0.05): Settlement.h at its centre, rising `grade` m per m toward compass `upHeading` (0 =
// flat: the farms, the capital). A harbour's town climbs gently back from its quay, an alpine
// village's up its slope; padHeight(s, x, z) (world/region/pad.ts) gives the surface at a plan
// point. A waterfront pad (harbour, metro, resort) is CUT on its seaward side by its quay (or
// promenade) line: the pad is the disc minus a bite (Settlement.cut), so the town meets the water
// along a straight quay (a harbour's sea wall: the terrain drops into the sea right at it) or the
// curve of a beach crescent (a resort's promenade, the beach below it).
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
  /** Pad radius (m, plan) and the blend ring beyond it. The capital: CITY_PLAN_RADIUS / plateau blend. */
  padR: number;
  blend: number;
  /**
   * v2 (R2): the pad's plane: it rises `grade` m per m (0 = flat) toward compass heading `upHeading`
   * (rad). Surface height at plan (x, z) (+x east, +z south): h + grade · (x · sin up − z · cos up);
   * padHeight(s, x, z) computes it. The capital: 0.
   */
  grade: number;
  upHeading: number;
  /**
   * v2 (R2): a waterfront pad's seaward side: the pad is the disc minus a bite, the disc of radius
   * `r` whose near edge crosses the town's main axis `f` m from the centre, toward `heading` (r =
   * Infinity: a straight quay line square to the axis; finite: a promenade curving round a beach
   * crescent). `wall`: the edge is a sea wall (the terrain drops into the water within ~1.5 m:
   * harbours, the metro's docks); otherwise a beach slopes down from it. Absent: a full disc.
   */
  cut?: { f: number; r: number; wall: boolean };
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
  /**
   * Waterfront styles: the quay (or promenade) edge along the water, plan (x, z) interleaved, on the
   * cut's line; its surface is padHeight there (v2 R2: a harbour's quay ≈ 1.1 m above the sea, the
   * water right below its edge, so boats moor alongside).
   */
  quay?: Float64Array;
  /**
   * v2 (R2 refine): a walled waterfront's sea wall (harbours, the metro's docks; absent on a beach),
   * for H1 to extrude as a dedicated mesh: the terrain under it is far coarser than the wall (its
   * cells ≈ 2.8 m), so the stone face is never left to the terrain's triangles.
   */
  wall?: QuayWall;
  /** Pier ids (Region.piers) and airport ids (Region.airports) that belong to it. */
  piers: number[];
  airports: number[];
  /**
   * v2 (R2 refine 2): what each of the town's dead ends is for (absent: none): its turning circle is a
   * paved yard, plan (x, z) at the end node and radius r (the turning circle and its sidewalk), that
   * T1 rings with buildings of its `kind` — a farm's barns and sheds round its farmyard, a boatyard's
   * sheds and slip, the chalets round their yard, the villas round their drive, the fish market, the
   * school's playground, a clifftop lookout's bench. N2 keeps it clear (it is 'pad' to Region.surface).
   */
  yards?: Yard[];
}

/** v2 (R2 refine 2): a dead end's purpose (Settlement.yards). */
export type YardKind = 'farm' | 'boat' | 'chalet' | 'villa' | 'market' | 'school' | 'lookout';

export interface Yard {
  /** The end node (RNode id, place 'end'). */
  node: number;
  kind: YardKind;
  /** Plan position (the node's) and radius (m), in the settlement's chart. */
  x: number;
  z: number;
  r: number;
}

/**
 * v2 (R2 refine): a sea wall along a walled quay (Settlement.wall). H1 extrudes it: a vertical stone face
 * on the seaward side of `line` from `foot` up to the deck (`top`), capped by a coping stone `coping` m
 * wide (inland from the face) standing `lip` m proud of the deck. Behind it the paved apron runs `apron`
 * m inland to the quay street's carriageway (Region.surface: 'plaza'; KEEP.plaza). The terrain is cut
 * to the water within SEA_WALL (≈ 1 m) outside the face and dressed as stone ±WALL_BAND m either side
 * (planet.ts biomeAt), so nothing green or sandy touches the wall.
 */
export interface QuayWall {
  /** The face's top edge, plan (x, z) interleaved in the settlement's chart: the quay line (Settlement.quay). */
  line: Float64Array;
  /** The same vertices as unit directions (x, y, z interleaved). */
  dir: Float32Array;
  /** Deck height above sea level at each vertex (m): the pad's surface on the quay line. */
  top: Float32Array;
  /** The face's foot (m above sea level: below the water, so the face meets the dredged basin). */
  foot: number;
  /** Coping stone: width (m inland from the face) and height above the deck (m). */
  coping: number;
  lip: number;
  /** The paved apron behind the face: from it to the quay street's carriageway edge (m). */
  apron: number;
  /**
   * v2 (R2 refine 2): the wall is a solid block this deep (m inland from the face, ≥ the apron): its
   * deck is the pad's surface (`top` at the face), its face drops to `foot`. Under it the terrain ramps
   * down from the deck at its back to WALL_LOW at the face (so no terrain facet stands proud of the
   * face, at either terrain detail): a renderer caps the block, it is not the ground.
   */
  depth: number;
  /** Unit plan normal (x, z) of the face, pointing out to sea (the cut's axis). */
  nx: number;
  nz: number;
}

/** v2 (R2 refine): the sea wall's foot (m above sea level: R2 refine 2, under the 2.2 m basin) and its coping (m). */
export const WALL_FOOT = -2.3;
export const WALL_COPING = 0.6;
export const WALL_LIP = 0.22;
/** Paved quay apron: the quay line to the quay street's carriageway (QUAY_SET 5.2 − its 2.5 m half width + 0.3). */
export const QUAY_APRON = 3.0;
/** biomeAt dresses the ground ±WALL_BAND m either side of a sea wall as stone (≥ 1.5 terrain cells; inland, to the block's back). */
export const WALL_BAND = 4.5;
/** v2 (R2 refine 2): the sea wall's block depth (QuayWall.depth, m) and the terrain's height at its face under it (m). */
export const WALL_DEPTH = 3.5;
export const WALL_LOW = -0.8;

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
  /** v2 (R2 refine): its two abutments, at s0 and at s1 (H1 clads them: BridgeAbutment). */
  abutments: [BridgeAbutment, BridgeAbutment];
}

/**
 * v2 (R2 refine): a bridge end. The approach's fill stops at the span's abutment plane and the ground
 * falls away under the deck's first metres (to the water, or a beach), the fill's end fanning out to
 * either side: that drop is a built face, not terrain — H1 clads the box as a stone abutment (its face
 * across the road, wing walls flaring out and back along both sides of the approach's fill): `half` m
 * either side of the centreline, from `back` m behind the face (on the approach) to `depth` m into the
 * span, from `foot` up to the deck. Every bank near a bridge end steeper than the carve's rule lies
 * inside one (spec'd).
 */
export interface BridgeAbutment {
  /** Arc length of the face on the edge's centreline (the span's s0 or s1). */
  s: number;
  /** Unit direction of the face's centre on the centreline, and the unit tangent pointing into the span. */
  dir: Vec3;
  into: Vec3;
  /** Half-width of the box across the road, its depth into the span and its reach back along the approach (m). */
  half: number;
  depth: number;
  back: number;
  /** Deck height at the face, and the lowest ground in the box (m above sea level). */
  top: number;
  foot: number;
}

/** v2 (R2 refine): an abutment box reaches this far either side beyond the road's verge, this far into the span and this far back along the approach (m). */
export const ABUT_WING = 10;
export const ABUT_DEPTH = 3.5;
export const ABUT_BACK = 9;

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

/** v2 (R2): what Region.keepOut tests (bit flags; KEEP_ALL by default). */
export const KEEP = { road: 1, pad: 2, plaza: 4, runway: 8, pier: 16 } as const;
export const KEEP_ALL = 31;
/** v2 (R2 refine): the largest margin Region.keepOut honours (m; larger ones are clamped): a big tree's crown, the camera's radius. */
export const KEEP_MARGIN_MAX = 8;

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
  /** Classify a surface point (zero-alloc: writes and returns `out`). v2 (R2 refine): a walled quay's apron (QUAY_APRON m inland of the wall) is 'plaza'. */
  surface(dir: Vec3, out: SurfaceHit): SurfaceHit;
  /**
   * v2 (R2): the fast keep-out test for scatter (a tree, a rock, a field) and the camera: true if unit
   * `dir` lies within `margin` m of a carriageway or its verge, a town pad (its quay included), a
   * plaza or turnaround (a walled quay's paved apron too), a runway strip or apron, or a pier deck. `mask` picks which (KEEP flags,
   * default all). `margin` is clamped to KEEP_MARGIN_MAX. One grid-cell lookup (its own buckets, built on
   * the first call) and a few primitives; zero-alloc, ≤ 1 µs: fine per tree and per frame.
   */
  keepOut(dir: Vec3, margin?: number, mask?: number): boolean;
  /** Build time (ms), for the boot log and the budget spec. */
  readonly buildMs: number;
}
